use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

struct NativeSession {
    summary: Value,
    messages: Vec<Value>,
}

#[derive(Default)]
pub struct NativeRuntime {
    sessions: Mutex<HashMap<String, NativeSession>>,
}

fn request_id(frame: &Value) -> Value {
    frame
        .get("payload")
        .and_then(|p| p.get("requestId"))
        .cloned()
        .unwrap_or(Value::Null)
}

fn response(kind: &str, request: Value, payload: Value) -> Value {
    let mut payload = payload;
    if let Value::Object(ref mut object) = payload {
        if !request.is_null() {
            object.insert("requestId".into(), request);
        }
    }
    json!({ "type": kind, "payload": payload })
}

fn timestamp_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default()
}

fn session_summary(id: &str, title: &str) -> Value {
    let now = timestamp_ms();
    json!({
        "sessionId": id,
        "source": "local",
        "title": title,
        "status": "idle",
        "model": "clawmaster-local",
        "createdAt": now,
        "updatedAt": now,
        "messageCount": 0
    })
}

fn text_content(content: &Value) -> String {
    content
        .as_array()
        .map(|parts| {
            parts
                .iter()
                .filter_map(|part| {
                    (part.get("type").and_then(Value::as_str) == Some("text"))
                        .then(|| part.get("value").and_then(Value::as_str))
                        .flatten()
                })
                .collect::<Vec<_>>()
                .join("\n")
        })
        .or_else(|| content.as_str().map(ToOwned::to_owned))
        .unwrap_or_default()
}

fn sessions_list(sessions: &HashMap<String, NativeSession>, request: Value) -> Value {
    let mut items: Vec<Value> = sessions
        .values()
        .map(|session| session.summary.clone())
        .collect();
    items.sort_by(|left, right| right["updatedAt"].as_u64().cmp(&left["updatedAt"].as_u64()));
    response("sessions_list", request, json!({ "sessions": items }))
}

impl NativeRuntime {
    pub fn handle(&self, frame: Value) -> Result<Vec<Value>, String> {
        let kind = frame
            .get("type")
            .and_then(Value::as_str)
            .ok_or("desktop frame type is required")?;
        let request = request_id(&frame);
        let payload = frame.get("payload").cloned().unwrap_or_else(|| json!({}));
        match kind {
            "hello" => Ok(vec![response(
                "welcome",
                request,
                json!({ "protocolVersion": "4", "serverVersion": env!("CARGO_PKG_VERSION") }),
            )]),
            "subscribe" | "unsubscribe" => Ok(Vec::new()),
            "list_slash_commands" => Ok(vec![response(
                "slash_commands_list",
                request,
                json!({ "commands": [] }),
            )]),
            "list_sessions" => {
                let sessions = self
                    .sessions
                    .lock()
                    .map_err(|_| "native runtime lock poisoned")?;
                Ok(vec![sessions_list(&sessions, request)])
            }
            "get_models" => Ok(vec![response(
                "models_list",
                request,
                json!({
                    "models": [{
                        "id": "clawmaster-local",
                        "displayName": "ClawMaster Local",
                        "provider": "local",
                        "modelId": "clawmaster-local",
                        "enabled": true
                    }],
                    "current": "clawmaster-local"
                }),
            )]),
            "create_session" => {
                let id = format!("local-{}", uuid_like());
                let title = payload
                    .get("title")
                    .and_then(Value::as_str)
                    .filter(|title| !title.trim().is_empty())
                    .unwrap_or("新会话");
                let summary = session_summary(&id, title);
                self.sessions
                    .lock()
                    .map_err(|_| "native runtime lock poisoned")?
                    .insert(
                        id,
                        NativeSession {
                            summary: summary.clone(),
                            messages: Vec::new(),
                        },
                    );
                Ok(vec![response(
                    "session_created",
                    request,
                    json!({
                        "session": summary,
                        "clientRequestId": payload.get("clientRequestId").cloned().unwrap_or(Value::Null)
                    }),
                )])
            }
            "get_history" => {
                let id = payload
                    .get("sessionId")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let sessions = self
                    .sessions
                    .lock()
                    .map_err(|_| "native runtime lock poisoned")?;
                let messages = sessions
                    .get(id)
                    .map(|session| session.messages.clone())
                    .unwrap_or_default();
                Ok(vec![response(
                    "history",
                    request,
                    json!({ "sessionId": id, "messages": messages }),
                )])
            }
            "send_user_message" => {
                let id = payload
                    .get("sessionId")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string();
                let content = payload.get("content").cloned().unwrap_or_else(|| json!([]));
                let input_text = text_content(&content);
                let text = format!("本地 Agent 已接收：{input_text}");
                let user_message_id = payload
                    .get("clientMessageId")
                    .and_then(Value::as_str)
                    .map(ToOwned::to_owned)
                    .unwrap_or_else(|| format!("user-{}", uuid_like()));
                let assistant_message_id = format!("assistant-{}", uuid_like());
                let now = timestamp_ms();
                let user_message = json!({
                    "id": user_message_id,
                    "sessionId": id,
                    "role": "user",
                    "content": content,
                    "timestamp": now,
                    "source": "local"
                });
                let assistant_message = json!({
                    "id": assistant_message_id,
                    "sessionId": id,
                    "role": "assistant",
                    "content": [],
                    "timestamp": now,
                    "source": "local",
                    "isStreaming": true
                });
                let mut sessions = self
                    .sessions
                    .lock()
                    .map_err(|_| "native runtime lock poisoned")?;
                let session = sessions.get_mut(&id).ok_or("native session not found")?;
                session.messages.push(user_message.clone());
                let mut completed = assistant_message.clone();
                completed["content"] = json!([{ "type": "text", "value": text }]);
                completed["isStreaming"] = Value::Bool(false);
                session.messages.push(completed);
                session.summary["updatedAt"] = json!(now);
                session.summary["messageCount"] = json!(session.messages.len());
                session.summary["lastMessagePreview"] = json!(input_text);
                Ok(vec![
                    response(
                        "message_start",
                        request.clone(),
                        json!({ "message": user_message }),
                    ),
                    response(
                        "message_start",
                        request.clone(),
                        json!({ "message": assistant_message }),
                    ),
                    response(
                        "chat_chunk",
                        request.clone(),
                        json!({
                            "sessionId": id,
                            "messageId": assistant_message_id,
                            "delta": text
                        }),
                    ),
                    response(
                        "chat_complete",
                        request,
                        json!({
                            "sessionId": id,
                            "messageId": assistant_message_id,
                            "text": text,
                            "finishReason": "stop"
                        }),
                    ),
                ])
            }
            "set_model" => Ok(vec![response(
                "models_list",
                request,
                json!({
                    "models": [{
                        "id": "clawmaster-local",
                        "displayName": "ClawMaster Local",
                        "provider": "local",
                        "modelId": "clawmaster-local",
                        "enabled": true
                    }],
                    "current": "clawmaster-local"
                }),
            )]),
            "set_authorization_mode" => Ok(Vec::new()),
            "get_settings" => Ok(vec![response(
                "settings",
                request,
                json!({
                    "agentStyle": "concise",
                    "healthyUse": true,
                    "backgroundModelTasksEnabled": false,
                    "preferredLanguage": "zh-CN"
                }),
            )]),
            "get_search_config" => Ok(vec![response(
                "search_config",
                request,
                json!({
                    "provider": "bing",
                    "apiUrl": "",
                    "model": "",
                    "hasApiKey": false,
                    "configuredProviders": [],
                    "diagnostics": {
                        "tenantId": "local",
                        "cacheEntries": 0,
                        "cacheHits": 0,
                        "totalAttempts": 0,
                        "totalSuccesses": 0,
                        "estimatedCostCny": 0,
                        "updatedAt": timestamp_ms(),
                        "providers": []
                    }
                }),
            )]),
            "mcp_list" => Ok(vec![response(
                "mcp_servers",
                request,
                json!({ "servers": [] }),
            )]),
            "get_context_breakdown" => Ok(vec![response(
                "context_breakdown",
                request,
                json!({
                    "sessionId": payload.get("sessionId").and_then(Value::as_str).unwrap_or_default(),
                    "modelDisplayName": "ClawMaster Local",
                    "maxTokens": 0,
                    "systemPromptTokens": 0,
                    "systemToolsTokens": 0,
                    "memoryFilesTokens": 0,
                    "messagesTokens": 0,
                    "totalInputTokens": 0,
                    "freeSpaceTokens": 0
                }),
            )]),
            "get_workflows" => Ok(vec![response(
                "workflows_list",
                request,
                json!({ "workflows": [] }),
            )]),
            "get_extensions" => Ok(vec![response(
                "extensions_list",
                request,
                json!({ "extensions": [] }),
            )]),
            "get_todos" => Ok(vec![response(
                "todos_list",
                request,
                json!({ "todos": [] }),
            )]),
            "get_memory" => Ok(vec![response(
                "memory_snapshot",
                request,
                json!({ "files": [] }),
            )]),
            "get_skills" => Ok(vec![response(
                "skills_list",
                request,
                json!({ "skills": [] }),
            )]),
            "get_tools" => Ok(vec![response(
                "tools_list",
                request,
                json!({
                    "sessionId": payload.get("sessionId").and_then(Value::as_str).unwrap_or_default(),
                    "tools": []
                }),
            )]),
            "get_ide_status" => Ok(vec![response(
                "ide_status",
                request,
                json!({
                    "status": "not_applicable",
                    "details": "原生桌面模式无需 IDE 伴生连接"
                }),
            )]),
            "run_doctor" => Ok(vec![response(
                "doctor_report",
                request,
                json!({
                    "platform": std::env::consts::OS,
                    "checks": [{
                        "name": "外部依赖体检",
                        "category": "native-local",
                        "present": false,
                        "installHint": "原生轻量运行时尚未接入外部依赖探测器"
                    }],
                    "presentCount": 0,
                    "missingCount": 1,
                    "affectedCapabilities": ["文档、媒体与浏览器外部依赖状态未知"]
                }),
            )]),
            "rename_session" => {
                let id = payload
                    .get("sessionId")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let title = payload
                    .get("title")
                    .and_then(Value::as_str)
                    .unwrap_or("新会话");
                let mut sessions = self
                    .sessions
                    .lock()
                    .map_err(|_| "native runtime lock poisoned")?;
                if let Some(session) = sessions.get_mut(id) {
                    session.summary["title"] = json!(title);
                    session.summary["updatedAt"] = json!(timestamp_ms());
                }
                Ok(vec![sessions_list(&sessions, request)])
            }
            "delete_session" => {
                let id = payload
                    .get("sessionId")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let mut sessions = self
                    .sessions
                    .lock()
                    .map_err(|_| "native runtime lock poisoned")?;
                sessions.remove(id);
                Ok(vec![sessions_list(&sessions, request)])
            }
            "get_schedules" => Ok(vec![response(
                "schedules_list",
                request,
                json!({ "schedules": [] }),
            )]),
            "get_product_workspace" => Ok(vec![response(
                "product_workspace",
                request,
                json!({
                    "schemaVersion": 1,
                    "context": {
                        "edition": "personal",
                        "role": "personal",
                        "userId": "local-user",
                        "displayName": "ClawMaster User",
                        "capabilities": [
                            "agent:base",
                            "model:byok",
                            "skill:built-in",
                            "skill:auto-create",
                            "schedule:write"
                        ]
                    },
                    "members": [],
                    "friends": [],
                    "credits": { "balance": 0, "frozen": 0, "status": "design-preview" }
                }),
            )]),
            "get_pending_auto_skills" | "scan_pending_auto_skills" => Ok(vec![response(
                "pending_auto_skills",
                request,
                json!({ "candidates": [] }),
            )]),
            "work_log_today" => Ok(vec![response(
                "work_log_today_result",
                request,
                json!({
                    "summary": {
                        "summary": "今天还没有工作记录。",
                        "date": "",
                        "totalActions": 0,
                        "workResults": 0
                    }
                }),
            )]),
            "work_log_recent" => Ok(vec![response(
                "work_log_recent_result",
                request,
                json!({ "days": [] }),
            )]),
            _ => Ok(vec![response(
                "error",
                request,
                json!({ "code": "native_unsupported", "message": format!("本地运行时暂不支持 {kind}，未执行外部操作") }),
            )]),
        }
    }
}

fn uuid_like() -> String {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| format!("{}-{}", d.as_secs(), d.subsec_nanos()))
        .unwrap_or_else(|_| "0".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn local_runtime_round_trips_session_and_message() {
        let runtime = NativeRuntime::default();
        let created = runtime
            .handle(json!({ "type": "create_session", "payload": { "clientRequestId": "1" } }))
            .unwrap();
        let session = &created[0]["payload"]["session"];
        let id = session["sessionId"].as_str().unwrap().to_string();
        assert_eq!(session["source"], "local");
        assert_eq!(session["status"], "idle");
        assert_eq!(session["model"], "clawmaster-local");
        assert_eq!(session["messageCount"], 0);
        assert!(session["createdAt"].as_u64().is_some());
        assert_eq!(created[0]["payload"]["clientRequestId"], "1");

        let listed = runtime
            .handle(json!({ "type": "list_sessions", "payload": {} }))
            .unwrap();
        assert_eq!(listed[0]["payload"]["sessions"][0]["sessionId"], id);

        let frames = runtime
            .handle(json!({
                "type": "send_user_message",
                "payload": {
                    "requestId": "2",
                    "sessionId": id,
                    "clientMessageId": "client-1",
                    "content": [{ "type": "text", "value": "hello" }]
                }
            }))
            .unwrap();
        assert_eq!(frames[0]["type"], "message_start");
        assert_eq!(frames[0]["payload"]["message"]["id"], "client-1");
        assert_eq!(frames[1]["type"], "message_start");
        assert_eq!(frames[2]["type"], "chat_chunk");
        assert!(frames[2]["payload"]["messageId"].as_str().is_some());
        assert!(frames[2]["payload"]["delta"].as_str().is_some());
        assert_eq!(frames[3]["type"], "chat_complete");
        assert_eq!(frames[3]["payload"]["text"], "本地 Agent 已接收：hello");
    }

    #[test]
    fn local_runtime_models_follow_renderer_protocol() {
        let runtime = NativeRuntime::default();
        let frames = runtime
            .handle(json!({ "type": "get_models", "payload": {} }))
            .unwrap();
        assert_eq!(frames[0]["payload"]["models"][0]["id"], "clawmaster-local");
        assert_eq!(
            frames[0]["payload"]["models"][0]["displayName"],
            "ClawMaster Local"
        );
        assert_eq!(frames[0]["payload"]["current"], "clawmaster-local");
    }

    #[test]
    fn local_runtime_returns_honest_empty_snapshots_for_desktop_pages() {
        let runtime = NativeRuntime::default();
        let cases = [
            ("get_settings", "settings", None),
            ("get_search_config", "search_config", None),
            ("mcp_list", "mcp_servers", Some("servers")),
            ("get_workflows", "workflows_list", Some("workflows")),
            ("get_extensions", "extensions_list", Some("extensions")),
            ("get_todos", "todos_list", Some("todos")),
            ("get_memory", "memory_snapshot", Some("files")),
            ("get_skills", "skills_list", Some("skills")),
            ("get_tools", "tools_list", Some("tools")),
            ("get_ide_status", "ide_status", None),
            (
                "list_slash_commands",
                "slash_commands_list",
                Some("commands"),
            ),
            (
                "get_pending_auto_skills",
                "pending_auto_skills",
                Some("candidates"),
            ),
        ];

        for (request_type, response_type, list_key) in cases {
            let frames = runtime
                .handle(json!({ "type": request_type, "payload": { "sessionId": "session-1" } }))
                .unwrap();
            assert_eq!(frames[0]["type"], response_type);
            if let Some(key) = list_key {
                assert_eq!(frames[0]["payload"][key], json!([]));
            }
        }

        let doctor = runtime
            .handle(json!({ "type": "run_doctor", "payload": {} }))
            .unwrap();
        assert_eq!(doctor[0]["type"], "doctor_report");
        assert_eq!(doctor[0]["payload"]["missingCount"], 1);
        assert_eq!(doctor[0]["payload"]["checks"][0]["present"], false);

        let authorization = runtime
            .handle(json!({
                "type": "set_authorization_mode",
                "payload": { "sessionId": "session-1", "mode": "manual", "scope": "session" }
            }))
            .unwrap();
        assert!(authorization.is_empty());

        let workspace = runtime
            .handle(json!({ "type": "get_product_workspace", "payload": {} }))
            .unwrap();
        assert_eq!(workspace[0]["type"], "product_workspace");
        assert_eq!(workspace[0]["payload"]["context"]["edition"], "personal");
    }
}
