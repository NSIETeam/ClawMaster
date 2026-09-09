//! Optional same-user workspace transport. No TCP listener, credentials export, or new runtime.
//! Enabled only by --workspace-bridge; existing runtime confirmation policy is preserved.
use serde_json::{json, Value};
use std::os::unix::fs::{FileTypeExt, MetadataExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Emitter, Listener, Manager};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::mpsc;

use crate::{native_runtime::NativeRuntime, FRAME_EVENT};

const MAX_FRAME: usize = 1024 * 1024;
static OWNED_SOCKET: OnceLock<Mutex<Option<PathBuf>>> = OnceLock::new();

fn owned_socket() -> &'static Mutex<Option<PathBuf>> {
    OWNED_SOCKET.get_or_init(|| Mutex::new(None))
}

fn message_text(payload: &Value) -> Option<&str> {
    let content = payload.get("content")?;
    content.get("text").and_then(Value::as_str).or_else(|| {
        content.as_array()?.iter().find_map(|part| {
            (part.get("type").and_then(Value::as_str) == Some("text"))
                .then(|| part.get("value").and_then(Value::as_str))
                .flatten()
        })
    })
}

fn normalize_frame(frame: &mut Value) {
    if frame.get("type").and_then(Value::as_str) != Some("send_user_message") {
        return;
    }
    let Some(payload) = frame.get_mut("payload") else {
        return;
    };
    let Some(text) = message_text(payload).map(str::to_owned) else {
        return;
    };
    if payload.get("content").is_some_and(Value::is_object) {
        payload["content"] = json!([{"type":"text","value":text}]);
    }
}

fn legacy_content(content: &Value) -> Value {
    let text = content
        .get("text")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .unwrap_or_else(|| {
            content
                .as_array()
                .into_iter()
                .flatten()
                .filter(|part| part.get("type").and_then(Value::as_str) == Some("text"))
                .filter_map(|part| part.get("value").and_then(Value::as_str))
                .collect::<String>()
        });
    json!({"text": text})
}

fn adapt_message(message: &mut Value) {
    if let Some(content) = message.get("content").cloned() {
        message["content"] = legacy_content(&content);
    }
}

fn adapt_outbound_frame(frame: &Value) -> Option<Value> {
    match frame.get("type").and_then(Value::as_str)? {
        "runtime_event" => {
            let event = frame.pointer("/payload/event")?;
            let payload = event.get("payload")?;
            let session_id = event.get("sessionId")?.clone();
            let message_id = event.get("stepId")?.clone();
            match payload.get("type").and_then(Value::as_str)? {
                "contentDelta" => Some(json!({
                    "type":"chat_chunk",
                    "payload":{
                        "sessionId":session_id,
                        "messageId":message_id,
                        "delta":payload.get("delta").cloned().unwrap_or(Value::String(String::new()))
                    }
                })),
                "finished" => Some(json!({
                    "type":"chat_complete",
                    "payload":{
                        "sessionId":session_id,
                        "messageId":message_id,
                        "finishReason":payload.get("reason").cloned().unwrap_or(Value::String("complete".into()))
                    }
                })),
                "error" => Some(json!({
                    "type":"error",
                    "payload":{
                        "sessionId":session_id,
                        "code":payload.pointer("/error/code").cloned().unwrap_or(Value::String("runtime_error".into())),
                        "message":payload.pointer("/error/message").cloned().unwrap_or(Value::String("ClawMaster runtime error".into())),
                        "retryable":payload.pointer("/error/retryable").cloned().unwrap_or(Value::Bool(false))
                    }
                })),
                _ => None,
            }
        }
        "message_start" => {
            let mut adapted = frame.clone();
            adapt_message(&mut adapted["payload"]["message"]);
            Some(adapted)
        }
        "history" => {
            let mut adapted = frame.clone();
            if let Some(messages) = adapted["payload"]["messages"].as_array_mut() {
                for message in messages {
                    adapt_message(message);
                }
            }
            Some(adapted)
        }
        "chat_chunk"
        | "chat_complete"
        | "tool_confirmation_request"
        | "session_status"
        | "error"
        | "runtime_activity" => Some(frame.clone()),
        _ => None,
    }
}

fn frame_session(frame: &Value) -> Option<&str> {
    frame
        .pointer("/payload/sessionId")
        .and_then(Value::as_str)
        .or_else(|| {
            frame
                .pointer("/payload/message/sessionId")
                .and_then(Value::as_str)
        })
}

fn is_live_frame(frame: &Value) -> bool {
    matches!(
        frame.get("type").and_then(Value::as_str),
        Some(
            "runtime_event"
                | "message_start"
                | "chat_chunk"
                | "chat_complete"
                | "tool_confirmation_request"
                | "session_status"
                | "error"
                | "runtime_activity"
        )
    )
}

fn allowed(frame: &Value) -> bool {
    let kind = frame.get("type").and_then(Value::as_str).unwrap_or("");
    let Some(payload) = frame.get("payload").filter(|payload| payload.is_object()) else {
        return false;
    };
    match kind {
        "list_sessions" | "create_session" | "get_models" | "list_models" => true,
        "get_history"
        | "set_session_workspace"
        | "send_user_message"
        | "tool_confirmation_response"
        | "cancel" => {
            if !payload
                .get("sessionId")
                .and_then(Value::as_str)
                .is_some_and(|id| !id.is_empty() && id.len() < 256)
            {
                return false;
            }
            match kind {
                "set_session_workspace" => payload
                    .get("workspacePath")
                    .and_then(Value::as_str)
                    .is_some_and(|path| Path::new(path).is_absolute()),
                "send_user_message" => {
                    message_text(payload).is_some_and(|text| !text.trim().is_empty())
                }
                "tool_confirmation_response" => {
                    payload
                        .get("callId")
                        .and_then(Value::as_str)
                        .is_some_and(|id| !id.is_empty())
                        && matches!(
                            payload.get("outcome").and_then(Value::as_str),
                            Some("approved" | "rejected")
                        )
                }
                _ => true,
            }
        }
        _ => false,
    }
}

pub fn start(app: &AppHandle) -> Result<(), String> {
    // Serialize repeated single-instance callbacks so only one listener can own the path.
    let mut owned = owned_socket()
        .lock()
        .map_err(|_| "Workspace bridge state is unavailable".to_string())?;
    if owned.is_some() {
        return Ok(());
    }

    let directory = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?
        .join("workspace-bridge");
    std::fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
    std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o700))
        .map_err(|error| error.to_string())?;
    let path = directory.join("native.sock");
    if path.exists() {
        if std::os::unix::net::UnixStream::connect(&path).is_ok() {
            return Ok(());
        }
        if !std::fs::symlink_metadata(&path)
            .map_err(|error| error.to_string())?
            .file_type()
            .is_socket()
        {
            return Err("Workspace socket path is occupied".into());
        }
        std::fs::remove_file(&path).map_err(|e| e.to_string())?;
    }
    let listener = std::os::unix::net::UnixListener::bind(&path).map_err(|e| e.to_string())?;
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600))
        .map_err(|error| error.to_string())?;
    listener
        .set_nonblocking(true)
        .map_err(|error| error.to_string())?;
    let owner = std::fs::metadata(&directory)
        .map_err(|e| e.to_string())?
        .uid();
    *owned = Some(path.clone());
    drop(owned);

    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let listener = match UnixListener::from_std(listener) {
            Ok(listener) => listener,
            Err(_) => {
                let _ = release_owned_socket(&path);
                return;
            }
        };
        while let Ok((stream, _)) = listener.accept().await {
            if !stream
                .peer_cred()
                .is_ok_and(|credentials| credentials.uid() == owner)
            {
                continue;
            }
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                let _ = serve(app, stream).await;
            });
        }
        let _ = release_owned_socket(&path);
    });
    Ok(())
}

fn remove_owned_socket(path: &Path) -> Result<(), String> {
    let metadata = match std::fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.to_string()),
    };
    if !metadata.file_type().is_socket() {
        return Err("Workspace socket path is no longer a socket".into());
    }
    std::fs::remove_file(path).map_err(|error| error.to_string())
}

fn release_owned_socket(path: &Path) -> Result<(), String> {
    let mut owned = owned_socket()
        .lock()
        .map_err(|_| "Workspace bridge state is unavailable".to_string())?;
    if owned.as_deref() != Some(path) {
        return Ok(());
    }
    let path = owned.take();
    drop(owned);
    match path {
        Some(path) => remove_owned_socket(path.as_path()),
        None => Ok(()),
    }
}

pub fn shutdown() -> Result<(), String> {
    let path = owned_socket()
        .lock()
        .map_err(|_| "Workspace bridge state is unavailable".to_string())?
        .clone();
    match path {
        Some(path) => release_owned_socket(&path),
        None => Ok(()),
    }
}

async fn serve(app: AppHandle, stream: UnixStream) -> Result<(), String> {
    let (read, mut write) = stream.into_split();
    let (tx, mut rx) = mpsc::channel::<String>(256);
    let watched = std::sync::Arc::new(std::sync::Mutex::new(String::new()));
    let event_tx = tx.clone();
    let event_watched = watched.clone();
    let event_id = app.listen(FRAME_EVENT, move |event| {
        let Ok(frame) = serde_json::from_str::<Value>(event.payload()) else {
            return;
        };
        if !is_live_frame(&frame) {
            return;
        }
        let Some(frame) = adapt_outbound_frame(&frame) else {
            return;
        };
        let session = frame_session(&frame);
        let Ok(selected) = event_watched.lock() else {
            return;
        };
        if session == Some(selected.as_str()) && !selected.is_empty() {
            let _ = event_tx.try_send(frame.to_string());
        }
    });
    let _ = tx
        .send(
            json!({"type":"workspace_connected","payload":{"version":1,"runtime":"ClawMaster native"}})
                .to_string(),
        )
        .await;
    let writer = tauri::async_runtime::spawn(async move {
        while let Some(frame) = rx.recv().await {
            if write.write_all(frame.as_bytes()).await.is_err()
                || write.write_all(b"\n").await.is_err()
            {
                break;
            }
        }
    });
    struct Cleanup {
        app: AppHandle,
        event: tauri::EventId,
        writer: tauri::async_runtime::JoinHandle<()>,
    }
    impl Drop for Cleanup {
        fn drop(&mut self) {
            self.app.unlisten(self.event);
            self.writer.abort();
        }
    }
    let _cleanup = Cleanup {
        app: app.clone(),
        event: event_id,
        writer,
    };
    let mut reader = BufReader::new(read);
    loop {
        // fill_buf/consume bounds memory even when a peer never sends a newline.
        let mut data = Vec::new();
        let mut done = false;
        while !done {
            let bytes = reader.fill_buf().await.map_err(|e| e.to_string())?;
            if bytes.is_empty() {
                break;
            }
            let count = bytes
                .iter()
                .position(|byte| *byte == b'\n')
                .map(|index| {
                    done = true;
                    index + 1
                })
                .unwrap_or(bytes.len());
            if data.len() + count > MAX_FRAME {
                return Err("Workspace frame exceeds limit".into());
            }
            data.extend_from_slice(&bytes[..count]);
            reader.consume(count);
        }
        if data.is_empty() {
            break;
        }
        let mut frame: Value = match serde_json::from_slice(&data) {
            Ok(frame) => frame,
            Err(_) => {
                let _ = tx
                    .send(
                        json!({"type":"error","payload":{"message":"Invalid workspace request"}})
                            .to_string(),
                    )
                    .await;
                continue;
            }
        };
        if !allowed(&frame) {
            let _ = tx
                .send(
                    json!({"type":"error","payload":{"message":"Unsupported workspace operation"}})
                        .to_string(),
                )
                .await;
            continue;
        }
        normalize_frame(&mut frame);
        if let Some(id) = frame["payload"]["sessionId"].as_str() {
            let mut selected = watched
                .lock()
                .map_err(|_| "Workspace session state is unavailable".to_string())?;
            *selected = id.to_string();
        }
        let app = app.clone();
        let tx = tx.clone();
        // Turns run separately so cancel and approval replies remain responsive.
        tauri::async_runtime::spawn(async move {
            let runtime = app.state::<NativeRuntime>();
            let result = if frame["type"] == "send_user_message" {
                runtime.run_turn(&app, &frame).await
            } else {
                match runtime.handle_async(&frame).await {
                    Ok(responses) => {
                        for response in &responses {
                            let outbound =
                                adapt_outbound_frame(response).unwrap_or_else(|| response.clone());
                            let _ = tx.send(outbound.to_string()).await;
                            if response["type"] != "error" {
                                let _ = app.emit(FRAME_EVENT, response);
                            }
                        }
                        Ok(())
                    }
                    Err(error) => Err(error),
                }
            };
            if let Err(error) = result {
                let _ = tx
                    .send(
                        json!({"type":"error","payload":{"sessionId":frame["payload"]["sessionId"],"message":error}})
                            .to_string(),
                    )
                    .await;
            }
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn workspace_transport_keeps_narrow_command_surface() {
        for name in ["list_sessions", "create_session", "get_models"] {
            assert!(allowed(&json!({"type":name,"payload":{}})));
        }
        for name in ["get_history", "cancel"] {
            assert!(allowed(&json!({"type":name,"payload":{"sessionId":"s"}})));
            assert!(!allowed(&json!({"type":name,"payload":{}})));
        }
        assert!(allowed(
            &json!({"type":"send_user_message","payload":{"sessionId":"s","content":{"text":"hello"}}})
        ));
        assert!(allowed(
            &json!({"type":"send_user_message","payload":{"sessionId":"s","content":[{"type":"text","value":"hello"}]}})
        ));
        assert!(!allowed(
            &json!({"type":"send_user_message","payload":{"sessionId":"s","content":{"text":" "}}})
        ));
        assert!(!allowed(
            &json!({"type":"set_session_workspace","payload":{"sessionId":"s","workspacePath":"relative"}})
        ));
        for name in [
            "save_custom_model",
            "delete_session",
            "run_slash_command",
            "channel_send_test",
            "capability_install",
        ] {
            assert!(!allowed(&json!({"type":name,"payload":{}})));
        }
        assert!(!allowed(&json!({"type":"list_sessions"})));
        assert!(!allowed(
            &json!({"type":"tool_confirmation_response","payload":{"outcome":"always_approve"}})
        ));
        assert!(allowed(
            &json!({"type":"tool_confirmation_response","payload":{"sessionId":"s","callId":"c","outcome":"rejected"}})
        ));
    }

    #[test]
    fn legacy_workspace_text_is_normalized_to_the_runtime_contract() {
        let mut frame = json!({
            "type":"send_user_message",
            "payload":{"sessionId":"s","content":{"text":"hello"}}
        });
        normalize_frame(&mut frame);
        assert_eq!(
            frame["payload"]["content"],
            json!([{"type":"text","value":"hello"}])
        );

        let mut canonical = json!({
            "type":"send_user_message",
            "payload":{"sessionId":"s","content":[{"type":"text","value":"canonical"}]}
        });
        normalize_frame(&mut canonical);
        assert_eq!(
            canonical["payload"]["content"],
            json!([{"type":"text","value":"canonical"}])
        );
    }

    #[test]
    fn runtime_events_are_adapted_for_workspace_clients() {
        let chunk = adapt_outbound_frame(&json!({
            "type":"runtime_event",
            "payload":{"event":{
                "sessionId":"s","stepId":"m","payload":{"type":"contentDelta","delta":"hello"}
            }}
        }))
        .unwrap();
        assert_eq!(
            chunk,
            json!({"type":"chat_chunk","payload":{"sessionId":"s","messageId":"m","delta":"hello"}})
        );

        let complete = adapt_outbound_frame(&json!({
            "type":"runtime_event",
            "payload":{"event":{
                "sessionId":"s","stepId":"m","payload":{"type":"finished","reason":"complete"}
            }}
        }))
        .unwrap();
        assert_eq!(
            complete,
            json!({"type":"chat_complete","payload":{"sessionId":"s","messageId":"m","finishReason":"complete"}})
        );
    }

    #[test]
    fn message_frames_use_the_workspace_text_shape() {
        let history = adapt_outbound_frame(&json!({
            "type":"history",
            "payload":{"sessionId":"s","messages":[
                {"id":"u","content":[{"type":"text","value":"one"},{"type":"text","value":" two"}]}
            ]}
        }))
        .unwrap();
        assert_eq!(
            history["payload"]["messages"][0]["content"],
            json!({"text":"one two"})
        );

        let start = adapt_outbound_frame(&json!({
            "type":"message_start",
            "payload":{"message":{"id":"a","sessionId":"s","content":[]}}
        }))
        .unwrap();
        assert_eq!(start["payload"]["message"]["content"], json!({"text":""}));
        assert!(!is_live_frame(&history));
        assert!(is_live_frame(&start));
    }

    #[test]
    fn cleanup_removes_only_a_socket() {
        let directory = tempfile::tempdir().unwrap();
        let socket = directory.path().join("native.sock");
        let listener = std::os::unix::net::UnixListener::bind(&socket).unwrap();
        remove_owned_socket(&socket).unwrap();
        assert!(!socket.exists());
        drop(listener);

        std::fs::write(&socket, "preserve me").unwrap();
        assert!(remove_owned_socket(&socket).is_err());
        assert_eq!(std::fs::read_to_string(&socket).unwrap(), "preserve me");
    }
}
