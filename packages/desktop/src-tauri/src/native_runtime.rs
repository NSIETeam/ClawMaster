use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Mutex;

#[derive(Default)]
pub struct NativeRuntime {
    sessions: Mutex<HashMap<String, Vec<Value>>>,
}

fn request_id(frame: &Value) -> Value {
    frame.get("payload").and_then(|p| p.get("requestId")).cloned().unwrap_or(Value::Null)
}

fn response(kind: &str, request: Value, payload: Value) -> Value {
    let mut payload = payload;
    if let Value::Object(ref mut object) = payload {
        if !request.is_null() { object.insert("requestId".into(), request); }
    }
    json!({ "type": kind, "payload": payload })
}

impl NativeRuntime {
    pub fn handle(&self, frame: Value) -> Result<Vec<Value>, String> {
        let kind = frame.get("type").and_then(Value::as_str).ok_or("desktop frame type is required")?;
        let request = request_id(&frame);
        let payload = frame.get("payload").cloned().unwrap_or_else(|| json!({}));
        match kind {
            "list_sessions" => {
                let sessions = self.sessions.lock().map_err(|_| "native runtime lock poisoned")?;
                let items: Vec<Value> = sessions.keys().map(|id| json!({ "id": id, "title": "本地会话", "status": "idle" })).collect();
                Ok(vec![response("sessions_list", request, json!({ "sessions": items }))])
            }
            "get_models" => Ok(vec![response("models_list", request, json!({ "models": [{ "id": "clawmaster-local", "name": "ClawMaster Local", "provider": "local" }] }))]),
            "create_session" => {
                let id = format!("local-{}", uuid_like());
                self.sessions.lock().map_err(|_| "native runtime lock poisoned")?.insert(id.clone(), Vec::new());
                Ok(vec![response("session_created", request, json!({ "session": { "id": id, "title": "新会话", "status": "idle" } }))])
            }
            "get_history" => {
                let id = payload.get("sessionId").and_then(Value::as_str).unwrap_or_default();
                let sessions = self.sessions.lock().map_err(|_| "native runtime lock poisoned")?;
                Ok(vec![response("history", request, json!({ "sessionId": id, "messages": sessions.get(id).cloned().unwrap_or_default() }))])
            }
            "send_user_message" => {
                let id = payload.get("sessionId").and_then(Value::as_str).unwrap_or_default().to_string();
                let content = payload.get("content").and_then(Value::as_str).unwrap_or_default().to_string();
                let text = format!("本地 Agent 已接收：{content}");
                let mut sessions = self.sessions.lock().map_err(|_| "native runtime lock poisoned")?;
                let history = sessions.entry(id.clone()).or_default();
                history.push(json!({ "role": "user", "content": content }));
                history.push(json!({ "role": "assistant", "content": text }));
                Ok(vec![
                    response("message_queued", request.clone(), json!({ "sessionId": id })),
                    json!({ "type": "chat_chunk", "payload": { "sessionId": id, "content": text, "done": false } }),
                    json!({ "type": "chat_complete", "payload": { "sessionId": id, "content": text } }),
                ])
            }
            "get_schedules" => Ok(vec![response("schedules_list", request, json!({ "schedules": [] }))]),
            _ => Ok(vec![response("error", request, json!({ "code": "native_unsupported", "message": format!("本地运行时暂不支持 {kind}，未执行外部操作") }))]),
        }
    }
}

fn uuid_like() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| format!("{}-{}", d.as_secs(), d.subsec_nanos())).unwrap_or_else(|_| "0".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn local_runtime_round_trips_session_and_message() {
        let runtime = NativeRuntime::default();
        let created = runtime.handle(json!({ "type": "create_session", "payload": { "requestId": "1" } })).unwrap();
        let id = created[0]["payload"]["session"]["id"].as_str().unwrap().to_string();
        let frames = runtime.handle(json!({ "type": "send_user_message", "payload": { "requestId": "2", "sessionId": id, "content": "hello" } })).unwrap();
        assert_eq!(frames[2]["type"], "chat_complete");
    }
}
