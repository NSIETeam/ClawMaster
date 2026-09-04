use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::plugin::PermissionState;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_notification::NotificationExt;

mod agent_state_pool;
mod runtime_contracts;
mod community_skills;
mod system_commands;
mod task_runtime_guard;
mod native_runtime;

const FRAME_EVENT: &str = "desktop://server-frame";
const CONNECTION_EVENT: &str = "desktop://connection-change";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
#[derive(Default)]
struct DesktopConnection {
    connected: AtomicBool,
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

fn runtime_diagnostic_payload(
    sidecar_running: bool,
    transport_connected: bool,
) -> DesktopRuntimeDiagnostic {
    let server = if sidecar_running {
        RuntimeServerDiagnostic {
            status: "ready",
            ownership: Some("detached"),
            message: if transport_connected {
                "本地运行时已就绪，桌面连接正常"
            } else {
                "本地运行时已就绪，桌面正在连接"
            },
        }
    } else if transport_connected {
        RuntimeServerDiagnostic {
            status: "ready",
            ownership: Some("discovered"),
            message: "已连接到现有本地 Agent 服务",
        }
    } else {
        RuntimeServerDiagnostic {
            status: "unavailable",
            ownership: None,
            message: "本地运行时未运行",
        }
    };
    DesktopRuntimeDiagnostic {
        contract_version: 1,
        server,
        native_core: RuntimeNativeCoreDiagnostic {
            mode: "native-local",
            status: "ready",
            message: "桌面使用进程内 native-local 运行时",
        },
    }
}

#[tauri::command]
fn runtime_contract_version() -> runtime_contracts::RuntimeContractVersion {
    runtime_contracts::RuntimeContractVersion::CURRENT
}

#[tauri::command]
fn runtime_diagnostic(
    state: State<'_, Arc<DesktopConnection>>,
) -> DesktopRuntimeDiagnostic {
    runtime_diagnostic_payload(true, state.connected.load(Ordering::Acquire))
}

fn emit_connection(app: &AppHandle, connected: bool) {
    let _ = app.emit(CONNECTION_EVENT, connected);
}

#[tauri::command]
async fn desktop_connect(
    app: AppHandle,
    state: State<'_, Arc<DesktopConnection>>,
) -> Result<bool, String> {
    state.connected.store(true, Ordering::Release);
    emit_connection(&app, true);
    Ok(true)
}

#[tauri::command]
async fn desktop_disconnect(
    app: AppHandle,
    state: State<'_, Arc<DesktopConnection>>,
) -> Result<(), String> {
    state.connected.store(false, Ordering::Release);
    emit_connection(&app, false);
    Ok(())
}

#[tauri::command]
async fn desktop_send(
    app: AppHandle,
    frame: Value,
    state: State<'_, Arc<DesktopConnection>>,
    runtime: State<'_, native_runtime::NativeRuntime>,
) -> Result<(), String> {
    if !state.connected.load(Ordering::Acquire) { return Err("native runtime is not connected".into()); }
    for response in runtime.handle(frame)? { let _ = app.emit(FRAME_EVENT, response); }
    Ok(())
}

#[tauri::command]
fn desktop_is_connected(state: State<'_, Arc<DesktopConnection>>) -> bool {
    state.connected.load(Ordering::Acquire)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        // Keep this first: a second launch must focus the existing window
        // before it can initialize another Agent sidecar.
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
        .setup(|_| Ok(()))
        .manage(Arc::new(DesktopConnection::default()))
        .manage(native_runtime::NativeRuntime::default())
        .manage(agent_state_pool::AgentStatePool::default())
        .manage(system_commands::DesktopFileState::default())
        .manage(system_commands::ThemePreference::default())
        .manage(task_runtime_guard::TaskRuntimeGuard::default())
        .invoke_handler(tauri::generate_handler![
            desktop_connect,
            desktop_disconnect,
            desktop_send,
            desktop_is_connected,
            agent_state_pool::agent_state_replace,
            agent_state_pool::agent_state_bytes,
            agent_state_pool::agent_state_remove,
            runtime_diagnostic,
            runtime_contract_version,
            notification_show,
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
            system_commands::theme_get,
            system_commands::theme_set,
            system_commands::write_clipboard,
            community_skills::community_skill_install,
            community_skills::community_skill_list,
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
    fn runtime_diagnostic_reports_the_real_tauri_sidecar_state() {
        let ready = runtime_diagnostic_payload(true, true);
        assert_eq!(ready.server.status, "ready");
        assert_eq!(ready.server.ownership, Some("detached"));
        assert_eq!(ready.native_core.mode, "native-local");
        assert_eq!(ready.native_core.status, "ready");
        let serialized = serde_json::to_value(&ready).unwrap();
        assert_eq!(serialized["contractVersion"], 1);
        assert_eq!(serialized["nativeCore"]["status"], "ready");

        let contract = runtime_contract_version();
        assert_eq!(contract.protocol.major, 1);
        assert_eq!(contract.protocol.minor, 0);
        assert_eq!(contract.protocol.patch, 0);
        assert_eq!(contract.event_schema, 1);

        let unavailable = runtime_diagnostic_payload(false, false);
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
}
