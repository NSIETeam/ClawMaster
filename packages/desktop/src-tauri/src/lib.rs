use base64::Engine as _;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::atomic::{AtomicBool, Ordering};
use tauri::plugin::PermissionState;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_notification::NotificationExt;

mod agent_state_pool;
mod community_skills;
mod native_agent_tools;
mod native_capability_host;
mod native_channels;
mod native_chart;
mod native_context;
mod native_diagnostics;
mod native_encrypted_checkpoints;
mod native_encrypted_memory;
mod native_enterprise;
mod native_enterprise_remote;
mod native_knowledge;
mod native_mcp;
mod native_memory_engine;
mod native_model_gateway;
mod native_models;
mod native_pptx;
mod native_process;
mod native_projects;
mod native_rpa;
mod native_runtime;
mod native_schedule;
mod native_self_modification;
mod native_skills;
mod native_state_capsule;
mod native_state_store;
mod native_todos;
pub mod native_tools;
mod native_update;
mod native_user_directory;
mod native_workflows;
mod native_worklog;
mod office_document;
mod platform_webview;
mod runtime_contracts;
mod system_commands;
mod task_runtime_guard;

const FRAME_EVENT: &str = "desktop://server-frame";
const CONNECTION_EVENT: &str = "desktop://connection-change";

#[derive(Default)]
struct DesktopConnection {
    connected: AtomicBool,
}

struct StartupFailure {
    message: &'static str,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopRuntimeDiagnostic {
    contract_version: u8,
    server: RuntimeServerDiagnostic,
    native_core: RuntimeNativeCoreDiagnostic,
}

#[derive(Debug, Serialize)]
struct RuntimeServerDiagnostic {
    status: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    ownership: Option<&'static str>,
    message: &'static str,
}

#[derive(Debug, Serialize)]
struct RuntimeNativeCoreDiagnostic {
    mode: &'static str,
    status: &'static str,
    message: &'static str,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NotificationRequest {
    session_id: String,
    source: String,
    sender: Option<String>,
    title: Option<String>,
    preview: String,
}

fn compact_notification_text(value: &str, max_chars: usize) -> String {
    let compact = value
        .chars()
        .map(|character| {
            if character.is_control() || character.is_whitespace() {
                ' '
            } else {
                character
            }
        })
        .collect::<String>()
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    let characters = compact.chars().collect::<Vec<_>>();
    if characters.len() <= max_chars {
        return compact;
    }
    characters
        .into_iter()
        .take(max_chars.saturating_sub(1))
        .chain(std::iter::once('…'))
        .collect()
}

fn notification_title(source: &str, sender: Option<&str>, title: Option<&str>) -> String {
    let explicit = compact_notification_text(title.unwrap_or_default(), 80);
    if !explicit.is_empty() {
        return explicit;
    }
    let label = match source {
        "feishu" => "飞书消息",
        "atoa" => "企业内部协作",
        "enterprise" => "企业通知",
        "park" => "园区服务",
        _ => "新消息",
    };
    let sender = compact_notification_text(sender.unwrap_or_default(), 40);
    if sender.is_empty() {
        label.to_string()
    } else {
        format!("{label} · {sender}")
    }
}

#[tauri::command]
fn notification_show(app: AppHandle, payload: NotificationRequest) -> Result<(), String> {
    if compact_notification_text(&payload.session_id, 160).is_empty() {
        return Err("notification sessionId is required".to_string());
    }
    let source = compact_notification_text(&payload.source, 40);
    let title = notification_title(
        if source.is_empty() {
            "unknown"
        } else {
            &source
        },
        payload.sender.as_deref(),
        payload.title.as_deref(),
    );
    let preview = compact_notification_text(&payload.preview, 180);
    let body = if preview.is_empty() {
        "你收到了一条新消息。".to_string()
    } else {
        preview
    };
    let notification = app.notification();
    let mut permission = notification
        .permission_state()
        .map_err(|error| format!("无法读取系统通知权限：{error}"))?;
    if permission != PermissionState::Granted {
        permission = notification
            .request_permission()
            .map_err(|error| format!("无法请求系统通知权限：{error}"))?;
    }
    if permission != PermissionState::Granted {
        return Err("系统通知权限未授权".to_string());
    }
    notification
        .builder()
        .title(title)
        .body(body)
        .show()
        .map_err(|error| format!("系统通知发送失败：{error}"))
}

fn runtime_diagnostic_payload(transport_connected: bool) -> DesktopRuntimeDiagnostic {
    let server = if transport_connected {
        RuntimeServerDiagnostic {
            status: "ready",
            ownership: Some("embedded"),
            message: "Rust 原生运行时已就绪，桌面进程内连接正常",
        }
    } else {
        RuntimeServerDiagnostic {
            status: "unavailable",
            ownership: None,
            message: "本地运行时未运行",
        }
    };
    DesktopRuntimeDiagnostic {
        contract_version: 2,
        server,
        native_core: RuntimeNativeCoreDiagnostic {
            mode: "required",
            status: "ready",
            message: "会话、模型网关与原生工具由 Rust 运行时承担",
        },
    }
}

#[tauri::command]
fn runtime_contract_version() -> runtime_contracts::RuntimeContractStatus {
    runtime_contracts::RuntimeContractStatus::current()
}

#[tauri::command]
fn runtime_diagnostic(state: State<'_, DesktopConnection>) -> DesktopRuntimeDiagnostic {
    runtime_diagnostic_payload(state.connected.load(Ordering::Acquire))
}

fn emit_connection(app: &AppHandle, connected: bool) {
    let _ = app.emit(CONNECTION_EVENT, connected);
}

fn startup_failure_message(error: &str) -> &'static str {
    let error = error.to_ascii_lowercase();
    if error.contains("keychain") || error.contains("secure storage") || error.contains("系统密钥")
    {
        "系统钥匙串当前不可用，ClawMaster 无法解锁本地加密数据。\n\n应用已安全停止，未写入未加密数据。请先修复或解锁系统钥匙串，然后重新打开 ClawMaster。"
    } else {
        "ClawMaster 无法初始化安全运行时。\n\n应用已安全停止，未降低加密或权限保护。请确认应用数据目录可写，然后重新打开 ClawMaster。"
    }
}

fn startup_failure_script(message: &str) -> String {
    let message = serde_json::to_string(message).expect("startup message must serialize");
    format!(
        r#"document.title = 'ClawMaster - 安全启动失败';
document.documentElement.style.colorScheme = 'light';
document.body.innerHTML = `<main style="min-height:100vh;box-sizing:border-box;display:grid;place-items:center;margin:0;padding:32px;background:radial-gradient(circle at 20% 15%,#fff3c4 0,transparent 38%),linear-gradient(145deg,#f7f4eb,#e8eee8);font-family:'Songti SC','STSong',serif;color:#17231b"><section style="width:min(620px,100%);box-sizing:border-box;padding:42px;border:1px solid #bac5b9;border-radius:28px;background:rgba(255,255,255,.86);box-shadow:0 28px 80px rgba(24,44,31,.14)"><div style="width:46px;height:6px;border-radius:999px;background:#d59626;margin-bottom:28px"></div><h1 style="margin:0 0 16px;font-size:30px;line-height:1.2">安全运行时未能启动</h1><p id="startup-failure-message" style="margin:0;white-space:pre-line;font-family:'PingFang SC','Hiragino Sans GB',sans-serif;font-size:16px;line-height:1.8;color:#455249"></p><p style="margin:28px 0 0;font-family:'PingFang SC','Hiragino Sans GB',sans-serif;font-size:13px;color:#778078">关闭此窗口，完成修复后重新打开即可。ClawMaster 没有降低加密保护。</p></section></main>`;
document.getElementById('startup-failure-message').textContent = {message};"#
    )
}

#[tauri::command]
async fn desktop_connect(
    app: AppHandle,
    state: State<'_, DesktopConnection>,
) -> Result<bool, String> {
    state.connected.store(true, Ordering::Release);
    emit_connection(&app, true);
    Ok(true)
}

#[tauri::command]
async fn desktop_disconnect(
    app: AppHandle,
    state: State<'_, DesktopConnection>,
) -> Result<(), String> {
    state.connected.store(false, Ordering::Release);
    emit_connection(&app, false);
    Ok(())
}

#[tauri::command]
async fn desktop_send(
    app: AppHandle,
    frame: Value,
    state: State<'_, DesktopConnection>,
    runtime: State<'_, native_runtime::NativeRuntime>,
) -> Result<(), String> {
    if !state.connected.load(Ordering::Acquire) {
        return Err("Rust 原生运行时尚未连接".into());
    }
    if frame.get("type").and_then(Value::as_str) == Some("send_user_message") {
        return runtime.run_turn(&app, &frame).await;
    }
    if frame.get("type").and_then(Value::as_str) == Some("run_slash_command") {
        return runtime.run_slash_command(&app, &frame).await;
    }
    let responses = runtime.handle_async(&frame).await?;
    for response in &responses {
        app.emit(FRAME_EVENT, response)
            .map_err(|error| format!("无法发送 Rust 运行时事件: {error}"))?;
    }
    runtime
        .run_confirmed_module_refinement(&app, &responses)
        .await
}

#[tauri::command]
async fn desktop_request(
    frame: Value,
    runtime: State<'_, native_runtime::NativeRuntime>,
) -> Result<Vec<Value>, String> {
    match frame.get("type").and_then(Value::as_str) {
        Some("send_user_message" | "run_slash_command" | "confirm_pending_auto_skill") => {
            Err("流式任务必须通过 desktop_send 执行".into())
        }
        _ => runtime.handle_async(&frame).await,
    }
}

#[tauri::command]
fn capability_list(
    runtime: State<'_, native_runtime::NativeRuntime>,
) -> Result<Vec<native_capability_host::InstalledCapability>, String> {
    runtime.capability_list()
}

#[tauri::command]
fn capability_resources(
    runtime: State<'_, native_runtime::NativeRuntime>,
) -> Result<native_capability_host::ResourceSnapshot, String> {
    runtime.capability_resources()
}

#[tauri::command]
fn capability_plan_install(
    manifest: native_capability_host::CapabilityManifest,
    source: String,
    runtime: State<'_, native_runtime::NativeRuntime>,
) -> Result<native_capability_host::CapabilityInstallPlan, String> {
    runtime.capability_plan_install(&manifest, &source)
}

#[tauri::command]
fn capability_install(
    manifest: native_capability_host::CapabilityManifest,
    payload_base64: String,
    approved: bool,
    runtime: State<'_, native_runtime::NativeRuntime>,
) -> Result<native_capability_host::InstalledCapability, String> {
    let payload = base64::engine::general_purpose::STANDARD
        .decode(payload_base64)
        .map_err(|_| "能力包不是有效 Base64".to_string())?;
    runtime.capability_install(manifest, &payload, approved)
}

#[tauri::command]
fn capability_rollback(
    id: String,
    runtime: State<'_, native_runtime::NativeRuntime>,
) -> Result<native_capability_host::InstalledCapability, String> {
    runtime.capability_rollback(&id)
}

#[tauri::command]
fn capability_uninstall(
    id: String,
    approved: bool,
    runtime: State<'_, native_runtime::NativeRuntime>,
) -> Result<(), String> {
    runtime.capability_uninstall(&id, approved)
}

#[tauri::command]
fn capability_invoke(
    id: String,
    input: Value,
    runtime: State<'_, native_runtime::NativeRuntime>,
) -> Result<Value, String> {
    let input = serde_json::to_vec(&input).map_err(|error| format!("能力输入无效: {error}"))?;
    let output = runtime.capability_invoke(&id, &input)?;
    serde_json::from_slice(&output).map_err(|error| format!("能力输出不是有效 JSON: {error}"))
}

#[tauri::command]
fn desktop_is_connected(state: State<'_, DesktopConnection>) -> bool {
    state.connected.load(Ordering::Acquire)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        // Keep this first so a second launch focuses the existing native runtime.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .on_page_load(|window, _| {
            if let Some(failure) = window.try_state::<StartupFailure>() {
                let _ = window.eval(startup_failure_script(failure.message));
            }
        })
        .setup(|app| {
            let initialization = (|| -> Result<(), String> {
                let directory = app
                    .path()
                    .app_data_dir()
                    .map_err(|error| error.to_string())?;
                let runtime = native_runtime::NativeRuntime::load(&directory)?;
                let channels = native_channels::NativeChannelState::load(&directory)?;
                let self_modification =
                    native_self_modification::NativeSelfModification::open(&directory)?;
                let enterprise_remote = native_enterprise_remote::NativeEnterpriseRemote::system()?;
                app.manage(runtime);
                app.manage(channels);
                app.manage(self_modification);
                app.manage(enterprise_remote);
                app.state::<native_channels::NativeChannelState>()
                    .start_configured(app.handle().clone());
                Ok(())
            })();

            if let Err(error) = initialization {
                app.manage(StartupFailure {
                    message: startup_failure_message(&error),
                });
            }
            Ok(())
        })
        .manage(DesktopConnection::default())
        .manage(agent_state_pool::AgentStatePool::default())
        .manage(system_commands::DesktopFileState::default())
        .manage(system_commands::ThemePreference::default())
        .manage(native_update::NativeUpdateState::default())
        .manage(task_runtime_guard::TaskRuntimeGuard::default())
        .invoke_handler(tauri::generate_handler![
            desktop_connect,
            desktop_disconnect,
            desktop_send,
            desktop_request,
            desktop_is_connected,
            capability_list,
            capability_resources,
            capability_plan_install,
            capability_install,
            capability_rollback,
            capability_uninstall,
            capability_invoke,
            agent_state_pool::agent_state_replace,
            agent_state_pool::agent_state_bytes,
            agent_state_pool::agent_state_remove,
            runtime_diagnostic,
            runtime_contract_version,
            notification_show,
            native_enterprise_remote::enterprise_remote_session,
            native_enterprise_remote::enterprise_remote_password_login,
            native_enterprise_remote::enterprise_remote_companyos_brief,
            native_enterprise_remote::enterprise_remote_logout,
            native_channels::channel_config_get,
            native_channels::channel_status_get,
            native_channels::channel_connection_set,
            native_channels::channel_config_save,
            native_channels::channel_config_clear,
            native_channels::channel_send_test,
            platform_webview::platform_webview_open,
            platform_webview::platform_webview_set_bounds,
            platform_webview::platform_webview_reload,
            platform_webview::platform_webview_close,
            system_commands::open_external,
            system_commands::open_path,
            system_commands::select_files,
            system_commands::select_folders,
            system_commands::get_workspace_directories,
            system_commands::read_file_path,
            system_commands::extract_editable_document,
            system_commands::export_edited_document,
            system_commands::inspect_local_path,
            system_commands::activate_local_path,
            system_commands::save_text_file,
            system_commands::app_version,
            native_update::update_check,
            native_update::update_download,
            native_update::update_cancel,
            native_update::update_install,
            system_commands::theme_get,
            system_commands::theme_set,
            system_commands::write_clipboard,
            community_skills::community_skill_install,
            community_skills::community_skill_list,
            native_self_modification::self_modification_list,
            native_self_modification::self_modification_create,
            native_self_modification::self_modification_approve,
            native_self_modification::self_modification_reject,
            native_self_modification::self_modification_cancel,
            task_runtime_guard::task_runtime_set_active
        ])
        .build(tauri::generate_context!())
        .expect("failed to build ClawMaster desktop shell");
    app.run(|app_handle, event| {
        if matches!(
            event,
            tauri::RunEvent::Exit | tauri::RunEvent::ExitRequested { .. }
        ) {
            if let Some(state) = app_handle.try_state::<task_runtime_guard::TaskRuntimeGuard>() {
                task_runtime_guard::stop(state.inner());
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runtime_diagnostic_reports_the_embedded_rust_runtime() {
        let ready = runtime_diagnostic_payload(true);
        assert_eq!(ready.server.status, "ready");
        assert_eq!(ready.server.ownership, Some("embedded"));
        assert_eq!(ready.native_core.mode, "required");
        assert_eq!(ready.native_core.status, "ready");
        let serialized = serde_json::to_value(&ready).unwrap();
        assert_eq!(serialized["contractVersion"], 2);
        assert_eq!(serialized["nativeCore"]["status"], "ready");

        let contract = runtime_contract_version();
        assert_eq!(contract.protocol.major, 2);
        assert_eq!(contract.protocol.minor, 0);
        assert_eq!(contract.protocol.patch, 0);
        assert_eq!(contract.schema_version, "2.0.0");
        assert_eq!(
            contract.v1_adapter_uses,
            runtime_contracts::v1_adapter_uses()
        );

        let unavailable = runtime_diagnostic_payload(false);
        assert_eq!(unavailable.server.status, "unavailable");
        assert_eq!(unavailable.server.ownership, None);
    }

    #[test]
    fn notification_text_is_bounded_and_uses_product_source_labels() {
        assert_eq!(
            compact_notification_text("  园区\n服务\u{0000}台  ", 40),
            "园区 服务 台"
        );
        assert_eq!(
            notification_title("park", Some("园区服务台"), None),
            "园区服务 · 园区服务台"
        );
        assert_eq!(
            notification_title("local", None, Some("  后台任务完成  ")),
            "后台任务完成"
        );
        assert!(compact_notification_text(&"长".repeat(200), 80).ends_with('…'));
    }

    #[test]
    fn startup_failure_message_keeps_secure_storage_fail_closed() {
        let keychain = startup_failure_message(
            "NativeStateStore 系统密钥错误: Platform secure storage failure: keychain missing",
        );
        assert!(keychain.contains("系统钥匙串当前不可用"));
        assert!(keychain.contains("未写入未加密数据"));
        assert!(!keychain.contains("NativeStateStore"));

        let generic = startup_failure_message("permission denied: /private/example");
        assert!(generic.contains("无法初始化安全运行时"));
        assert!(generic.contains("未降低加密或权限保护"));
        assert!(!generic.contains("/private/example"));

        let script = startup_failure_script(keychain);
        assert!(script.contains("startup-failure-message"));
        assert!(script.contains("系统钥匙串当前不可用"));
        assert!(!script.contains("NativeStateStore"));
    }
}
