use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{AppHandle, Emitter, State};
use tokio::sync::{mpsc, Mutex};
use tokio::time::{sleep, Duration};
use tokio_tungstenite::tungstenite::Message;

mod agent_sidecar;
mod system_commands;

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
    sender: Mutex<Option<mpsc::UnboundedSender<Message>>>,
    connected: AtomicBool,
}

fn endpoint_file_path() -> Result<PathBuf, String> {
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .ok_or_else(|| "desktop server endpoint: user home is unavailable".to_string())?;
    Ok(PathBuf::from(home).join(".otto-user/server-endpoint.json"))
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
    if state.connected.load(Ordering::Acquire) {
        return Ok(true);
    }
    let endpoint_path = endpoint_file_path()?;
    let mut last_error = "desktop Agent service did not become ready".to_string();
    let (socket, endpoint) = {
        let mut connected = None;
        for _ in 0..80 {
            match read_endpoint(&endpoint_path) {
                Ok(endpoint) => {
                    match tokio_tungstenite::connect_async(websocket_url(&endpoint)).await {
                        Ok((socket, _)) => {
                            connected = Some((socket, endpoint));
                            break;
                        }
                        Err(error) => {
                            last_error = format!("desktop server connection failed: {error}");
                        }
                    }
                }
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
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(agent_sidecar::spawn)
        .manage(Arc::new(DesktopConnection::default()))
        .manage(system_commands::ThemePreference::default())
        .invoke_handler(tauri::generate_handler![
            desktop_connect,
            desktop_disconnect,
            desktop_send,
            desktop_is_connected,
            system_commands::open_external,
            system_commands::open_path,
            system_commands::select_files,
            system_commands::select_folders,
            system_commands::get_workspace_directories,
            system_commands::theme_get,
            system_commands::theme_set,
            system_commands::write_clipboard
        ])
        .build(tauri::generate_context!())
        .expect("failed to build ClawMaster desktop shell");
    app.run(|app_handle, event| {
        if matches!(
            event,
            tauri::RunEvent::Exit | tauri::RunEvent::ExitRequested { .. }
        ) {
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
}
