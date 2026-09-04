use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::plugin::PermissionState;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_notification::NotificationExt;
use tokio::sync::{mpsc, Mutex};
use tokio::time::{sleep, Duration};
use tokio_tungstenite::tungstenite::Message;

mod agent_sidecar;
mod agent_state_pool;
mod community_skills;
mod platform_webview;
pub mod native_tools;
mod runtime_contracts;
mod system_commands;
mod task_runtime_guard;

const FRAME_EVENT: &str = "desktop://server-frame";
const CONNECTION_EVENT: &str = "desktop://connection-change";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ServerEndpoint {
    host: String,
    port: u16,
    protocol_version: String,
    client_token: String,
}

#[derive(Default)]
struct DesktopConnection {
    connect_lock: Mutex<()>,
    sender: Mutex<Option<mpsc::UnboundedSender<Message>>>,
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
            mode: "hybrid",
            status: "ready",
            message: "Rust 原生输入与 PDF 工具已启用；Agent 调度仍由本地 Sidecar 承担",
        },
    }
}

#[tauri::command]
fn runtime_contract_version() -> runtime_contracts::RuntimeContractVersion {
    runtime_contracts::RuntimeContractVersion::CURRENT
}

#[tauri::command]
fn runtime_diagnostic(
    app: AppHandle,
    state: State<'_, Arc<DesktopConnection>>,
) -> DesktopRuntimeDiagnostic {
    let sidecar_running = app
        .try_state::<agent_sidecar::AgentSidecar>()
        .is_some_and(|sidecar| sidecar.is_running());
    runtime_diagnostic_payload(sidecar_running, state.connected.load(Ordering::Acquire))
}

fn endpoint_file_path() -> Result<PathBuf, String> {
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .ok_or_else(|| "desktop server endpoint: user home is unavailable".to_string())?;
    Ok(PathBuf::from(home).join(".clawmaster-user/server-endpoint.json"))
}

fn read_endpoint(path: &Path) -> Result<ServerEndpoint, String> {
    let raw = std::fs::read_to_string(path).map_err(|_| {
        "desktop server endpoint is unavailable; start ClawMaster server first".to_string()
    })?;
    let endpoint: ServerEndpoint =
        serde_json::from_str(&raw).map_err(|_| "desktop server endpoint is invalid".to_string())?;
    if !matches!(endpoint.host.as_str(), "127.0.0.1" | "localhost" | "::1") {
        return Err("desktop server endpoint must use a loopback host".to_string());
    }
    if endpoint.port == 0
        || endpoint.protocol_version.trim().is_empty()
        || endpoint.client_token.trim().is_empty()
    {
        return Err("desktop server endpoint is incomplete".to_string());
    }
    Ok(endpoint)
}

fn percent_encode_query(value: &str) -> String {
    value
        .bytes()
        .flat_map(|byte| match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                vec![byte as char]
            }
            _ => format!("%{byte:02X}").chars().collect(),
        })
        .collect()
}

fn websocket_url(endpoint: &ServerEndpoint) -> String {
    format!(
        "ws://{}:{}/ws?clientToken={}",
        endpoint.host,
        endpoint.port,
        percent_encode_query(&endpoint.client_token)
    )
}

fn emit_connection(app: &AppHandle, connected: bool) {
    let _ = app.emit(CONNECTION_EVENT, connected);
}

#[tauri::command]
async fn desktop_connect(
    app: AppHandle,
    state: State<'_, Arc<DesktopConnection>>,
) -> Result<bool, String> {
    let _connect_guard = state.connect_lock.lock().await;
    if state.connected.load(Ordering::Acquire) {
        return Ok(true);
    }
    let endpoint_path = endpoint_file_path()?;
    let mut last_error = "desktop Agent service did not become ready".to_string();
    let (socket, endpoint) = {
        let mut connected = None;
        for _ in 0..240 {
            match read_endpoint(&endpoint_path) {
                Ok(endpoint) => match tokio_tungstenite::connect_async(websocket_url(&endpoint))
                    .await
                {
                    Ok((socket, _)) => {
                        connected = Some((socket, endpoint));
                        break;
                    }
                    Err(error) => last_error = format!("desktop server connection failed: {error}"),
                },
                Err(error) => last_error = error,
            }
            sleep(Duration::from_millis(250)).await;
        }
        connected.ok_or(last_error)?
    };
    let (mut writer, mut reader) = socket.split();
    let (sender, mut outbound) = mpsc::unbounded_channel::<Message>();
    *state.sender.lock().await = Some(sender.clone());
    state.connected.store(true, Ordering::Release);
    let hello = serde_json::json!({"type":"hello","payload":{"protocolVersion":endpoint.protocol_version,"clientKind":"desktop"}});
    sender
        .send(Message::Text(hello.to_string().into()))
        .map_err(|_| "desktop server connection closed during handshake".to_string())?;
    emit_connection(&app, true);

    let writer_app = app.clone();
    let writer_state = state.inner().clone();
    tauri::async_runtime::spawn(async move {
        while let Some(message) = outbound.recv().await {
            if writer.send(message).await.is_err() {
                break;
            }
        }
        writer_state.connected.store(false, Ordering::Release);
        *writer_state.sender.lock().await = None;
        emit_connection(&writer_app, false);
    });
    let reader_app = app.clone();
    let reader_state = state.inner().clone();
    tauri::async_runtime::spawn(async move {
        while let Some(message) = reader.next().await {
            match message {
                Ok(Message::Text(text)) => {
                    if let Ok(frame) = serde_json::from_str::<Value>(&text) {
                        let _ = reader_app.emit(FRAME_EVENT, frame);
                    }
                }
                Ok(Message::Close(_)) | Err(_) => break,
                _ => {}
            }
        }
        reader_state.connected.store(false, Ordering::Release);
        *reader_state.sender.lock().await = None;
        emit_connection(&reader_app, false);
    });
    Ok(true)
}

#[tauri::command]
async fn desktop_disconnect(
    app: AppHandle,
    state: State<'_, Arc<DesktopConnection>>,
) -> Result<(), String> {
    if let Some(sender) = state.sender.lock().await.take() {
        let _ = sender.send(Message::Close(None));
    }
    state.connected.store(false, Ordering::Release);
    emit_connection(&app, false);
    Ok(())
}

#[tauri::command]
async fn desktop_send(
    frame: Value,
    state: State<'_, Arc<DesktopConnection>>,
) -> Result<(), String> {
    let sender = state
        .sender
        .lock()
        .await
        .clone()
        .ok_or_else(|| "desktop server is not connected; message was not sent".to_string())?;
    sender
        .send(Message::Text(frame.to_string().into()))
        .map_err(|_| "desktop server connection closed; message was not sent".to_string())
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
        .setup(agent_sidecar::spawn)
        .manage(Arc::new(DesktopConnection::default()))
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
            agent_sidecar::stop(app_handle);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_endpoint() -> PathBuf {
        std::env::temp_dir().join(format!("clawmaster-endpoint-{}.json", std::process::id()))
    }

    #[test]
    fn desktop_transport_reads_the_clawmaster_local_runtime_endpoint() {
        let home = std::env::var_os("HOME").expect("test requires HOME");
        assert_eq!(
            endpoint_file_path().unwrap(),
            PathBuf::from(home).join(".clawmaster-user/server-endpoint.json")
        );
    }

    #[test]
    fn endpoint_requires_loopback_and_complete_auth_contract() {
        let path = temp_endpoint();
        std::fs::write(
            &path,
            r#"{"host":"example.com","port":7637,"protocolVersion":"1","clientToken":"secret"}"#,
        )
        .unwrap();
        assert!(read_endpoint(&path).unwrap_err().contains("loopback"));
        std::fs::write(
            &path,
            r#"{"host":"127.0.0.1","port":7637,"protocolVersion":"1","clientToken":""}"#,
        )
        .unwrap();
        assert!(read_endpoint(&path).unwrap_err().contains("incomplete"));
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn websocket_url_encodes_client_token() {
        let endpoint = ServerEndpoint {
            host: "127.0.0.1".into(),
            port: 7637,
            protocol_version: "1".into(),
            client_token: "a token/+".into(),
        };
        assert_eq!(
            websocket_url(&endpoint),
            "ws://127.0.0.1:7637/ws?clientToken=a%20token%2F%2B"
        );
    }

    #[test]
    fn runtime_diagnostic_reports_the_real_tauri_sidecar_state() {
        let ready = runtime_diagnostic_payload(true, true);
        assert_eq!(ready.server.status, "ready");
        assert_eq!(ready.server.ownership, Some("detached"));
        assert_eq!(ready.native_core.mode, "hybrid");
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
