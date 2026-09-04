use crate::native_models::{
    stream_complete, system_credential_store, CredentialStore, ModelCompletion, ModelMessage,
    ModelStreamEvent, ModelToolCall, NativeModel, StreamCompletion,
};
use crate::{native_agent_tools, native_memory, native_projects};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter};
use tokio::sync::watch;

const STATE_FILE_NAME: &str = "native-runtime.json";
const DEFAULT_TITLE: &str = "新会话";
const MAX_TITLE_CHARS: usize = 120;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Session {
    session_id: String,
    source: String,
    title: String,
    status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    workspace_path: Option<String>,
    created_at: u64,
    updated_at: u64,
    last_message_preview: String,
    message_count: usize,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct StoredMessage {
    id: String,
    session_id: String,
    role: String,
    content: Value,
    timestamp: u64,
    source: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
struct Settings {
    agent_style: String,
    healthy_use: bool,
    background_model_tasks_enabled: bool,
    preferred_language: String,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            agent_style: "concise".into(),
            healthy_use: true,
            background_model_tasks_enabled: false,
            preferred_language: "zh-CN".into(),
        }
    }
}

#[derive(Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
struct PersistedState {
    sessions: Vec<Session>,
    messages: HashMap<String, Vec<StoredMessage>>,
    settings: Settings,
    current_model: Option<String>,
    authorization_mode: String,
    models: Vec<NativeModel>,
}

pub struct NativeRuntime {
    state_path: PathBuf,
    audit_path: PathBuf,
    state: Mutex<PersistedState>,
    credentials: Arc<dyn CredentialStore>,
    http: Client,
    active_turns: Mutex<HashMap<String, ActiveTurn>>,
    pending_confirmations: Mutex<HashMap<String, watch::Sender<Option<String>>>>,
}

struct ActiveTurn {
    turn_id: String,
    cancel: watch::Sender<bool>,
}

struct ToolLoopContext<'a> {
    app: &'a AppHandle,
    session_id: &'a str,
    message_id: &'a str,
    model: &'a NativeModel,
    api_key: &'a str,
    workspace: &'a Path,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn next_id(prefix: &str) -> String {
    let mut bytes = [0_u8; 8];
    let _ = getrandom::getrandom(&mut bytes);
    let random = u64::from_le_bytes(bytes);
    format!("{prefix}-{:x}-{random:x}", now_ms())
}

fn bounded_title(value: Option<&str>) -> String {
    let trimmed = value.unwrap_or(DEFAULT_TITLE).trim();
    let fallback = if trimmed.is_empty() {
        DEFAULT_TITLE
    } else {
        trimmed
    };
    fallback.chars().take(MAX_TITLE_CHARS).collect()
}

fn frame(frame_type: &str, payload: Value) -> Value {
    json!({ "type": frame_type, "payload": payload })
}

fn error_frame(session_id: Option<&str>, code: &str, message: &str) -> Value {
    frame(
        "error",
        json!({ "sessionId": session_id, "code": code, "message": message }),
    )
}

impl NativeRuntime {
    fn workspace_for_session(state: &PersistedState, session_id: Option<&str>) -> PathBuf {
        session_id
            .and_then(|id| {
                state
                    .sessions
                    .iter()
                    .find(|session| session.session_id == id)
            })
            .and_then(|session| session.workspace_path.as_deref())
            .map(PathBuf::from)
            .or_else(|| {
                std::env::var_os("HOME")
                    .or_else(|| std::env::var_os("USERPROFILE"))
                    .map(PathBuf::from)
            })
            .unwrap_or_else(|| PathBuf::from("/"))
    }

    pub fn load(app_data_dir: &Path) -> Result<Self, String> {
        Self::load_with_credentials(app_data_dir, system_credential_store())
    }

    fn load_with_credentials(
        app_data_dir: &Path,
        credentials: Arc<dyn CredentialStore>,
    ) -> Result<Self, String> {
        fs::create_dir_all(app_data_dir)
            .map_err(|error| format!("无法创建 Rust 运行时目录: {error}"))?;
        let state_path = app_data_dir.join(STATE_FILE_NAME);
        let audit_path = app_data_dir.join("native-audit.jsonl");
        let state = match fs::read(&state_path) {
            Ok(bytes) => serde_json::from_slice(&bytes)
                .map_err(|error| format!("Rust 运行时状态损坏: {error}"))?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => PersistedState {
                authorization_mode: "manual".into(),
                ..PersistedState::default()
            },
            Err(error) => return Err(format!("无法读取 Rust 运行时状态: {error}")),
        };
        Ok(Self {
            state_path,
            audit_path,
            state: Mutex::new(state),
            credentials,
            http: Client::builder()
                .https_only(true)
                .timeout(std::time::Duration::from_secs(120))
                .build()
                .map_err(|error| format!("无法初始化 Rust 模型客户端: {error}"))?,
            active_turns: Mutex::new(HashMap::new()),
            pending_confirmations: Mutex::new(HashMap::new()),
        })
    }

    fn persist(&self, state: &PersistedState) -> Result<(), String> {
        let bytes = serde_json::to_vec_pretty(state)
            .map_err(|error| format!("无法编码 Rust 运行时状态: {error}"))?;
        let temporary = self.state_path.with_extension("json.tmp");
        fs::write(&temporary, bytes)
            .map_err(|error| format!("无法写入 Rust 运行时状态: {error}"))?;
        fs::rename(&temporary, &self.state_path)
            .map_err(|error| format!("无法提交 Rust 运行时状态: {error}"))
    }

    fn audit_tool(
        &self,
        session_id: &str,
        call: &ModelToolCall,
        state: &str,
        detail: Option<&str>,
    ) -> Result<(), String> {
        let mut digest = Sha256::new();
        digest.update(call.arguments.to_string());
        let record = json!({
            "timestamp":now_ms(),"sessionId":session_id,"callId":call.id,
            "tool":call.name,"state":state,"argumentDigest":format!("{:x}", digest.finalize()),
            "detail":detail.map(|value| value.chars().take(240).collect::<String>())
        });
        let mut file = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.audit_path)
            .map_err(|error| format!("无法打开 Rust 审计日志: {error}"))?;
        writeln!(file, "{record}").map_err(|error| format!("无法写入 Rust 审计日志: {error}"))
    }

    pub fn handle(&self, request: &Value) -> Result<Vec<Value>, String> {
        let request_type = request
            .get("type")
            .and_then(Value::as_str)
            .ok_or_else(|| "Rust 运行时请求缺少 type".to_string())?;
        let payload = request.get("payload").cloned().unwrap_or_else(|| json!({}));
        let mut state = self
            .state
            .lock()
            .map_err(|_| "Rust 运行时状态锁已损坏".to_string())?;
        let mut dirty = false;
        let responses = match request_type {
            "hello" => vec![frame(
                "welcome",
                json!({ "protocolVersion": "1", "serverVersion": "rust-native-0.1" }),
            )],
            "list_sessions" => vec![frame(
                "sessions_list",
                json!({ "sessions": state.sessions }),
            )],
            "create_session" => {
                let timestamp = now_ms();
                let session = Session {
                    session_id: next_id("session"),
                    source: "local".into(),
                    title: bounded_title(payload.get("title").and_then(Value::as_str)),
                    status: "idle".into(),
                    model: payload
                        .get("model")
                        .and_then(Value::as_str)
                        .map(str::to_owned)
                        .or_else(|| state.current_model.clone()),
                    workspace_path: None,
                    created_at: timestamp,
                    updated_at: timestamp,
                    last_message_preview: String::new(),
                    message_count: 0,
                };
                state.sessions.insert(0, session.clone());
                dirty = true;
                vec![frame(
                    "session_created",
                    json!({
                        "session": session,
                        "clientRequestId": payload.get("clientRequestId").and_then(Value::as_str).unwrap_or("")
                    }),
                )]
            }
            "get_history" => {
                let session_id = payload
                    .get("sessionId")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                let messages = state.messages.get(session_id).cloned().unwrap_or_default();
                vec![frame(
                    "history",
                    json!({ "sessionId": session_id, "messages": messages }),
                )]
            }
            "rename_session" => {
                let session_id = payload
                    .get("sessionId")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                let title = bounded_title(payload.get("title").and_then(Value::as_str));
                if let Some(session) = state
                    .sessions
                    .iter_mut()
                    .find(|item| item.session_id == session_id)
                {
                    session.title = title;
                    session.updated_at = now_ms();
                    dirty = true;
                    vec![frame(
                        "sessions_list",
                        json!({ "sessions": state.sessions }),
                    )]
                } else {
                    vec![error_frame(
                        Some(session_id),
                        "session_not_found",
                        "会话不存在",
                    )]
                }
            }
            "delete_session" => {
                let session_id = payload
                    .get("sessionId")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                let old_len = state.sessions.len();
                state.sessions.retain(|item| item.session_id != session_id);
                state.messages.remove(session_id);
                dirty = state.sessions.len() != old_len;
                vec![frame(
                    "sessions_list",
                    json!({ "sessions": state.sessions }),
                )]
            }
            "set_session_workspace" => {
                let session_id = payload
                    .get("sessionId")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                let workspace = payload
                    .get("workspacePath")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                if workspace.is_empty() || !Path::new(workspace).is_absolute() {
                    vec![error_frame(
                        Some(session_id),
                        "bad_workspace",
                        "工作目录必须是绝对路径",
                    )]
                } else if let Some(session) = state
                    .sessions
                    .iter_mut()
                    .find(|item| item.session_id == session_id)
                {
                    session.workspace_path = Some(workspace.into());
                    session.updated_at = now_ms();
                    let updated = session.clone();
                    dirty = true;
                    vec![frame("session_upsert", json!({ "session": updated }))]
                } else {
                    vec![error_frame(
                        Some(session_id),
                        "session_not_found",
                        "会话不存在",
                    )]
                }
            }
            "set_model" => {
                let session_id = payload
                    .get("sessionId")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                let model = payload.get("model").and_then(Value::as_str).unwrap_or("");
                if model.is_empty()
                    || !state
                        .models
                        .iter()
                        .any(|item| item.id == model && item.enabled)
                {
                    vec![error_frame(
                        Some(session_id),
                        "unknown_model",
                        "模型不能为空",
                    )]
                } else {
                    state.current_model = Some(model.into());
                    if let Some(session) = state
                        .sessions
                        .iter_mut()
                        .find(|item| item.session_id == session_id)
                    {
                        session.model = Some(model.into());
                        session.updated_at = now_ms();
                    }
                    dirty = true;
                    let models = state
                        .models
                        .iter()
                        .map(NativeModel::public_value)
                        .collect::<Vec<_>>();
                    vec![frame(
                        "models_list",
                        json!({ "models": models, "current": model }),
                    )]
                }
            }
            "get_models" | "list_models" => {
                let models = state
                    .models
                    .iter()
                    .map(NativeModel::public_value)
                    .collect::<Vec<_>>();
                vec![frame(
                    "models_list",
                    json!({ "models": models, "current": state.current_model }),
                )]
            }
            "save_custom_model" => {
                let provider = payload
                    .get("provider")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .trim();
                let base_url = payload
                    .get("baseUrl")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .trim();
                let api_key = payload
                    .get("apiKey")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .trim();
                let replace_id = payload.get("replaceId").and_then(Value::as_str);
                let ids = payload
                    .get("modelIds")
                    .and_then(Value::as_array)
                    .map(|items| {
                        items
                            .iter()
                            .filter_map(Value::as_str)
                            .map(str::to_owned)
                            .collect::<Vec<_>>()
                    })
                    .filter(|items| !items.is_empty())
                    .unwrap_or_else(|| {
                        payload
                            .get("modelId")
                            .and_then(Value::as_str)
                            .map(|item| vec![item.to_owned()])
                            .unwrap_or_default()
                    });
                if !matches!(
                    provider,
                    "openai" | "openai-responses" | "anthropic" | "gemini"
                ) || !base_url.starts_with("https://")
                    || ids.iter().any(|id| id.trim().is_empty())
                {
                    vec![error_frame(
                        None,
                        "bad_model_config",
                        "模型协议、HTTPS 地址或模型 ID 无效",
                    )]
                } else {
                    let mut saved_ids = Vec::new();
                    for (index, model_id) in ids.iter().enumerate() {
                        let mut digest = Sha256::new();
                        digest.update(format!("{provider}\0{base_url}\0{model_id}"));
                        let short_hash = format!("{:x}", digest.finalize())[..16].to_string();
                        let id = if index == 0 {
                            replace_id
                                .map(str::to_owned)
                                .unwrap_or_else(|| format!("custom:{short_hash}"))
                        } else {
                            format!("custom:{short_hash}")
                        };
                        let existing_credential = state
                            .models
                            .iter()
                            .find(|item| item.id == id)
                            .map(|item| item.credential_id.clone());
                        let credential_id =
                            existing_credential.unwrap_or_else(|| format!("model-{short_hash}"));
                        if !api_key.is_empty() {
                            self.credentials.set(&credential_id, api_key)?;
                        } else if self.credentials.get(&credential_id).is_err() {
                            return Ok(vec![error_frame(
                                None,
                                "missing_api_key",
                                "新模型必须提供 API key",
                            )]);
                        }
                        let model = NativeModel {
                            id: id.clone(),
                            display_name: if ids.len() == 1 {
                                payload
                                    .get("displayName")
                                    .and_then(Value::as_str)
                                    .unwrap_or(model_id)
                                    .into()
                            } else {
                                model_id.clone()
                            },
                            provider: provider.into(),
                            base_url: base_url.into(),
                            model_id: model_id.clone(),
                            max_tokens: payload
                                .get("maxTokens")
                                .and_then(Value::as_u64)
                                .and_then(|value| u32::try_from(value).ok()),
                            enabled: payload
                                .get("enabled")
                                .and_then(Value::as_bool)
                                .unwrap_or(true),
                            credential_id,
                        };
                        state.models.retain(|item| item.id != id);
                        state.models.push(model);
                        saved_ids.push(id);
                    }
                    if payload
                        .get("makeActive")
                        .and_then(Value::as_bool)
                        .unwrap_or(false)
                    {
                        state.current_model = saved_ids.first().cloned();
                    }
                    dirty = true;
                    let models = state
                        .models
                        .iter()
                        .map(NativeModel::public_value)
                        .collect::<Vec<_>>();
                    vec![frame(
                        "models_list",
                        json!({ "models": models, "current": state.current_model }),
                    )]
                }
            }
            "delete_custom_model" => {
                let id = payload.get("id").and_then(Value::as_str).unwrap_or("");
                if let Some(index) = state.models.iter().position(|item| item.id == id) {
                    let removed = state.models.remove(index);
                    self.credentials.delete(&removed.credential_id)?;
                    if state.current_model.as_deref() == Some(id) {
                        state.current_model = state
                            .models
                            .iter()
                            .find(|item| item.enabled)
                            .map(|item| item.id.clone());
                    }
                    dirty = true;
                }
                let models = state
                    .models
                    .iter()
                    .map(NativeModel::public_value)
                    .collect::<Vec<_>>();
                vec![frame(
                    "models_list",
                    json!({ "models": models, "current": state.current_model }),
                )]
            }
            "get_settings" => vec![frame("settings", json!(state.settings))],
            "get_product_workspace" => vec![frame(
                "product_workspace",
                json!({
                    "schemaVersion": 1,
                    "context": {
                        "edition": "personal",
                        "role": "personal",
                        "userId": "local-user",
                        "displayName": "ClawMaster User",
                        "capabilities": ["agent:base", "model:byok", "skill:built-in", "skill:auto-create", "schedule:write"]
                    },
                    "members": [],
                    "friends": [],
                    "credits": { "balance": 0, "frozen": 0, "status": "design-preview" }
                }),
            )],
            "get_schedules" => vec![frame(
                "schedules_list",
                json!({ "schedules": [], "date": payload.get("date") }),
            )],
            "get_memory" => {
                let workspace = Self::workspace_for_session(
                    &state,
                    payload.get("sessionId").and_then(Value::as_str),
                );
                match native_memory::snapshot(&workspace) {
                    Ok(payload) => vec![frame("memory_snapshot", payload)],
                    Err(message) => vec![error_frame(None, "get_memory_failed", &message)],
                }
            }
            "add_memory" => {
                let workspace = Self::workspace_for_session(
                    &state,
                    payload.get("sessionId").and_then(Value::as_str),
                );
                let fact = payload.get("fact").and_then(Value::as_str).unwrap_or("");
                match native_memory::add_project_fact(&workspace, fact) {
                    Ok(payload) => vec![frame("memory_snapshot", payload)],
                    Err(message) => vec![error_frame(None, "add_memory_failed", &message)],
                }
            }
            "get_tools" => {
                let session_id = payload
                    .get("sessionId")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                vec![frame(
                    "tools_list",
                    json!({"sessionId":session_id,"tools":native_agent_tools::summaries()}),
                )]
            }
            "get_pending_auto_skills" | "scan_pending_auto_skills" => {
                vec![frame("pending_auto_skills", json!({ "candidates": [] }))]
            }
            "list_slash_commands" => vec![frame(
                "slash_commands_list",
                json!({ "commands": [
                    {"name":"new","description":"新建会话"},
                    {"name":"model","description":"切换模型"},
                    {"name":"doctor","description":"检查原生运行时"},
                    {"name":"memory","description":"查看项目记忆"},
                    {"name":"skills","description":"查看技能"}
                ]}),
            )],
            "set_setting" => {
                let key = payload.get("key").and_then(Value::as_str).unwrap_or("");
                let value = payload.get("value").cloned().unwrap_or(Value::Null);
                let accepted = match key {
                    "agentStyle" => value
                        .as_str()
                        .map(|item| state.settings.agent_style = item.into())
                        .is_some(),
                    "healthyUse" => value
                        .as_bool()
                        .map(|item| state.settings.healthy_use = item)
                        .is_some(),
                    "backgroundModelTasksEnabled" => value
                        .as_bool()
                        .map(|item| state.settings.background_model_tasks_enabled = item)
                        .is_some(),
                    "preferredLanguage" => value
                        .as_str()
                        .map(|item| state.settings.preferred_language = item.into())
                        .is_some(),
                    _ => false,
                };
                if accepted {
                    dirty = true;
                    vec![frame("settings", json!(state.settings))]
                } else {
                    vec![error_frame(None, "bad_setting", "设置项或值无效")]
                }
            }
            "set_authorization_mode" => {
                let mode = payload.get("mode").and_then(Value::as_str).unwrap_or("");
                if matches!(mode, "manual" | "auto") {
                    state.authorization_mode = mode.into();
                    dirty = true;
                    Vec::new()
                } else {
                    vec![error_frame(None, "bad_authorization_mode", "授权模式无效")]
                }
            }
            "subscribe" | "unsubscribe" => Vec::new(),
            "cancel" => {
                let session_id = payload
                    .get("sessionId")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                if let Some(active) = self
                    .active_turns
                    .lock()
                    .map_err(|_| "Rust 运行时取消状态锁已损坏".to_string())?
                    .get(session_id)
                {
                    let _ = active.cancel.send(true);
                }
                vec![frame("queue_drained", json!({"sessionId":session_id}))]
            }
            "tool_confirmation_response" => {
                let call_id = payload.get("callId").and_then(Value::as_str).unwrap_or("");
                let outcome = payload.get("outcome").and_then(Value::as_str).unwrap_or("");
                if let Some(sender) = self
                    .pending_confirmations
                    .lock()
                    .map_err(|_| "Rust 工具确认状态锁已损坏".to_string())?
                    .get(call_id)
                {
                    sender.send_replace(Some(outcome.to_string()));
                }
                Vec::new()
            }
            _ => vec![error_frame(
                payload.get("sessionId").and_then(Value::as_str),
                "native_migration_incomplete",
                &format!("请求 {request_type} 尚未迁移到 Rust，已拒绝回退 Node"),
            )],
        };
        if dirty {
            self.persist(&state)?;
        }
        Ok(responses)
    }

    async fn await_tool_confirmation(
        &self,
        app: &AppHandle,
        session_id: &str,
        message_id: &str,
        call: &ModelToolCall,
        mut cancel: watch::Receiver<bool>,
    ) -> Result<bool, String> {
        let (sender, mut decision) = watch::channel(None::<String>);
        self.pending_confirmations
            .lock()
            .map_err(|_| "Rust 工具确认状态锁已损坏".to_string())?
            .insert(call.id.clone(), sender);
        let card = json!({
            "id":call.id,"toolName":call.name,"parameters":call.arguments,
            "status":"awaiting_approval","startTime":now_ms(),
            "confirmationDetails":{
                "type":"edit","title":"确认 Rust 原生工具操作","message":format!("允许 {} 修改当前项目？", call.name),
                "requiresConfirmation":true,"riskLevel":"high","reversible":false,
                "filePath":call.arguments.get("path")
            }
        });
        emit(
            app,
            frame(
                "tool_calls_update",
                json!({"sessionId":session_id,"messageId":message_id,"toolCalls":[card.clone()]}),
            ),
        )?;
        emit(
            app,
            frame(
                "tool_confirmation_request",
                json!({"sessionId":session_id,"callId":call.id,"toolCall":card}),
            ),
        )?;
        loop {
            tokio::select! {
                changed = cancel.changed() => {
                    if changed.is_ok() && *cancel.borrow() {
                        self.pending_confirmations.lock().ok().and_then(|mut values| values.remove(&call.id));
                        return Ok(false);
                    }
                }
                changed = decision.changed() => {
                    if changed.is_err() {
                        return Ok(false);
                    }
                    if let Some(outcome) = decision.borrow().clone() {
                        self.pending_confirmations.lock().ok().and_then(|mut values| values.remove(&call.id));
                        return Ok(matches!(outcome.as_str(), "approved" | "always_approve"));
                    }
                }
            }
        }
    }

    async fn run_model_tool_loop(
        &self,
        context: ToolLoopContext<'_>,
        mut messages: Vec<ModelMessage>,
        cancel: watch::Receiver<bool>,
    ) -> Result<StreamCompletion, String> {
        let tools = native_agent_tools::definitions();
        let mut full_text = String::new();
        let mut total_input = 0;
        let mut total_output = 0;
        for step in 0..8 {
            let streamed = stream_complete(
                &self.http,
                context.model,
                context.api_key,
                &messages,
                &tools,
                cancel.clone(),
                |event| match event {
                    ModelStreamEvent::Text(delta) => emit(
                        context.app,
                        frame(
                            "chat_chunk",
                            json!({"sessionId":context.session_id,"messageId":context.message_id,"delta":delta}),
                        ),
                    ),
                    ModelStreamEvent::Reasoning(delta) => emit(
                        context.app,
                        frame(
                            "chat_reasoning",
                            json!({"sessionId":context.session_id,"messageId":context.message_id,"delta":delta}),
                        ),
                    ),
                },
            )
            .await?;
            let mut completion = match streamed {
                StreamCompletion::Cancelled(mut completion) => {
                    completion.text = full_text + &completion.text;
                    return Ok(StreamCompletion::Cancelled(completion));
                }
                StreamCompletion::Completed(completion) => completion,
            };
            full_text.push_str(&completion.text);
            total_input += completion.input_tokens;
            total_output += completion.output_tokens;
            if completion.tool_calls.is_empty() {
                completion.text = full_text;
                completion.input_tokens = total_input;
                completion.output_tokens = total_output;
                return Ok(StreamCompletion::Completed(completion));
            }
            if step == 7 {
                return Err("原生工具循环超过 8 轮，已停止以防止失控".into());
            }

            let calls = completion.tool_calls.clone();
            let mut cards = calls
                .iter()
                .map(|call| {
                    json!({
                        "id":call.id,"toolName":call.name,"parameters":call.arguments,
                        "status":"executing","startTime":now_ms()
                    })
                })
                .collect::<Vec<_>>();
            emit(
                context.app,
                frame(
                    "tool_calls_update",
                    json!({"sessionId":context.session_id,"messageId":context.message_id,"toolCalls":cards}),
                ),
            )?;
            let call_summary = calls
                .iter()
                .map(|call| format!("{} {}", call.name, call.arguments))
                .collect::<Vec<_>>()
                .join("\n");
            messages.push(ModelMessage {
                role: "assistant".into(),
                text: format!(
                    "{}\n[Requested Rust tools]\n{call_summary}",
                    completion.text
                ),
            });
            let mut results = Vec::new();
            for (index, call) in calls.iter().enumerate() {
                self.audit_tool(context.session_id, call, "requested", None)?;
                if *cancel.borrow() {
                    return Ok(StreamCompletion::Cancelled(ModelCompletion {
                        text: full_text,
                        input_tokens: total_input,
                        output_tokens: total_output,
                        finish_reason: Some("cancelled".into()),
                        tool_calls: Vec::new(),
                    }));
                }
                let risk = native_agent_tools::risk(&call.name);
                let approved = if risk == Some(native_agent_tools::ToolRisk::Write) {
                    self.await_tool_confirmation(
                        context.app,
                        context.session_id,
                        context.message_id,
                        call,
                        cancel.clone(),
                    )
                    .await?
                } else {
                    risk.is_some()
                };
                if *cancel.borrow() {
                    return Ok(StreamCompletion::Cancelled(ModelCompletion {
                        text: full_text,
                        input_tokens: total_input,
                        output_tokens: total_output,
                        finish_reason: Some("cancelled".into()),
                        tool_calls: Vec::new(),
                    }));
                }
                let started = now_ms();
                let result = if approved {
                    native_agent_tools::execute(call, context.workspace)
                } else {
                    Err("用户拒绝或取消了工具操作".into())
                };
                self.audit_tool(
                    context.session_id,
                    call,
                    if result.is_ok() {
                        "completed"
                    } else if approved {
                        "failed"
                    } else {
                        "rejected"
                    },
                    result.as_ref().err().map(String::as_str),
                )?;
                cards[index] = match &result {
                    Ok(value) => json!({
                        "id":call.id,"toolName":call.name,"parameters":call.arguments,"status":"success",
                        "startTime":started,"endTime":now_ms(),"result":{"success":true,"data":value,"executionTime":now_ms().saturating_sub(started),"toolName":call.name}
                    }),
                    Err(message) => json!({
                        "id":call.id,"toolName":call.name,"parameters":call.arguments,"status":if approved {"error"} else {"cancelled"},
                        "startTime":started,"endTime":now_ms(),"result":{"success":false,"error":message,"executionTime":now_ms().saturating_sub(started),"toolName":call.name}
                    }),
                };
                results.push(json!({
                    "callId":call.id,"tool":call.name,
                    "result":result.unwrap_or_else(|message| json!({"error":message}))
                }));
                emit(
                    context.app,
                    frame(
                        "tool_calls_update",
                        json!({"sessionId":context.session_id,"messageId":context.message_id,"toolCalls":cards}),
                    ),
                )?;
            }
            messages.push(ModelMessage {
                role: "user".into(),
                text: format!("[Rust tool results]\n{}", Value::Array(results)),
            });
        }
        unreachable!()
    }

    pub async fn run_turn(&self, app: &AppHandle, request: &Value) -> Result<(), String> {
        let payload = request
            .get("payload")
            .ok_or_else(|| "消息请求缺少 payload".to_string())?;
        let session_id = payload
            .get("sessionId")
            .and_then(Value::as_str)
            .ok_or_else(|| "消息请求缺少 sessionId".to_string())?
            .to_string();
        let source = payload
            .get("source")
            .and_then(Value::as_str)
            .unwrap_or("local")
            .to_string();
        let content = payload.get("content").cloned().unwrap_or_else(|| json!([]));
        let prompt = text_content(&content);
        if prompt.trim().is_empty() {
            return Err("消息内容不能为空".into());
        }
        let user_message_id = payload
            .get("clientMessageId")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .unwrap_or_else(|| next_id("user"));
        let assistant_message_id = next_id("assistant");
        let (model, api_key, model_messages, workspace, inferred_session) = {
            let mut state = self
                .state
                .lock()
                .map_err(|_| "Rust 运行时状态锁已损坏".to_string())?;
            let session_index = state
                .sessions
                .iter()
                .position(|item| item.session_id == session_id)
                .ok_or_else(|| "会话不存在".to_string())?;
            let model_id = state.sessions[session_index]
                .model
                .clone()
                .or_else(|| state.current_model.clone())
                .ok_or_else(|| "请先配置并选择模型".to_string())?;
            let model = state
                .models
                .iter()
                .find(|item| item.id == model_id && item.enabled)
                .cloned()
                .ok_or_else(|| "当前模型不可用，请重新选择".to_string())?;
            let api_key = self.credentials.get(&model.credential_id)?;
            let timestamp = now_ms();
            let inferred_session = if state.sessions[session_index].workspace_path.is_none() {
                native_projects::infer_from_content(&content).map(|workspace| {
                    state.sessions[session_index].workspace_path =
                        Some(workspace.to_string_lossy().into_owned());
                    state.sessions[session_index].clone()
                })
            } else {
                None
            };
            state
                .messages
                .entry(session_id.clone())
                .or_default()
                .push(StoredMessage {
                    id: user_message_id,
                    session_id: session_id.clone(),
                    role: "user".into(),
                    content,
                    timestamp,
                    source,
                });
            let session = &mut state.sessions[session_index];
            session.status = "thinking".into();
            session.updated_at = timestamp;
            session.message_count += 1;
            session.last_message_preview = prompt.chars().take(120).collect();
            let history = state
                .messages
                .get(&session_id)
                .into_iter()
                .flatten()
                .filter(|message| matches!(message.role.as_str(), "user" | "assistant"))
                .map(|message| ModelMessage {
                    role: message.role.clone(),
                    text: text_content(&message.content),
                })
                .filter(|message| !message.text.is_empty())
                .collect::<Vec<_>>();
            self.persist(&state)?;
            let workspace = Self::workspace_for_session(&state, Some(&session_id));
            (model, api_key, history, workspace, inferred_session)
        };

        if let Some(session) = inferred_session {
            emit(app, frame("session_upsert", json!({"session":session})))?;
        }

        emit(
            app,
            frame(
                "session_status",
                json!({"sessionId":session_id,"status":"thinking"}),
            ),
        )?;
        emit(
            app,
            frame(
                "runtime_activity",
                json!({
                    "contractVersion":1,"sessionId":session_id,"kind":"turn","state":"started","timestamp":now_ms()
                }),
            ),
        )?;
        emit(
            app,
            frame(
                "message_start",
                json!({"message":{
                    "id":assistant_message_id,"sessionId":session_id,"role":"assistant",
                    "content":[],"timestamp":now_ms(),"source":"local","isStreaming":true
                }}),
            ),
        )?;
        emit(
            app,
            frame(
                "session_status",
                json!({"sessionId":session_id,"status":"streaming"}),
            ),
        )?;

        let turn_id = next_id("turn");
        let (cancel_sender, cancel_receiver) = watch::channel(false);
        let previous = self
            .active_turns
            .lock()
            .map_err(|_| "Rust 运行时取消状态锁已损坏".to_string())?
            .insert(
                session_id.clone(),
                ActiveTurn {
                    turn_id: turn_id.clone(),
                    cancel: cancel_sender,
                },
            );
        if let Some(previous) = previous {
            let _ = previous.cancel.send(true);
        }
        let streamed = self
            .run_model_tool_loop(
                ToolLoopContext {
                    app,
                    session_id: &session_id,
                    message_id: &assistant_message_id,
                    model: &model,
                    api_key: &api_key,
                    workspace: &workspace,
                },
                model_messages,
                cancel_receiver,
            )
            .await;
        if let Ok(mut active_turns) = self.active_turns.lock() {
            if active_turns
                .get(&session_id)
                .is_some_and(|active| active.turn_id == turn_id)
            {
                active_turns.remove(&session_id);
            }
        }

        match streamed {
            Ok(StreamCompletion::Completed(completion)) => {
                let message = StoredMessage {
                    id: assistant_message_id.clone(),
                    session_id: session_id.clone(),
                    role: "assistant".into(),
                    content: json!([{"type":"text","value":completion.text}]),
                    timestamp: now_ms(),
                    source: "local".into(),
                };
                {
                    let mut state = self
                        .state
                        .lock()
                        .map_err(|_| "Rust 运行时状态锁已损坏".to_string())?;
                    state
                        .messages
                        .entry(session_id.clone())
                        .or_default()
                        .push(message);
                    if let Some(session) = state
                        .sessions
                        .iter_mut()
                        .find(|item| item.session_id == session_id)
                    {
                        session.status = "idle".into();
                        session.updated_at = now_ms();
                        session.message_count += 1;
                    }
                    self.persist(&state)?;
                }
                emit(
                    app,
                    frame(
                        "chat_complete",
                        json!({
                            "sessionId":session_id,"messageId":assistant_message_id,"text":completion.text,
                            "finishReason":completion.finish_reason.unwrap_or_else(|| "stop".into()),
                            "tokenUsage":{"inputTokens":completion.input_tokens,"outputTokens":completion.output_tokens,
                            "totalTokens":completion.input_tokens + completion.output_tokens,"model":model.id}
                        }),
                    ),
                )?;
                emit(
                    app,
                    frame(
                        "session_status",
                        json!({"sessionId":session_id,"status":"idle"}),
                    ),
                )?;
                emit(
                    app,
                    frame(
                        "runtime_activity",
                        json!({
                            "contractVersion":1,"sessionId":session_id,"kind":"turn","state":"completed","timestamp":now_ms()
                        }),
                    ),
                )
            }
            Ok(StreamCompletion::Cancelled(completion)) => {
                if let Ok(mut state) = self.state.lock() {
                    if !completion.text.is_empty() {
                        state
                            .messages
                            .entry(session_id.clone())
                            .or_default()
                            .push(StoredMessage {
                                id: assistant_message_id.clone(),
                                session_id: session_id.clone(),
                                role: "assistant".into(),
                                content: json!([{"type":"text","value":completion.text}]),
                                timestamp: now_ms(),
                                source: "local".into(),
                            });
                    }
                    if let Some(session) = state
                        .sessions
                        .iter_mut()
                        .find(|item| item.session_id == session_id)
                    {
                        session.status = "idle".into();
                        session.updated_at = now_ms();
                        if !completion.text.is_empty() {
                            session.message_count += 1;
                        }
                    }
                    let _ = self.persist(&state);
                }
                emit(
                    app,
                    frame(
                        "chat_complete",
                        json!({
                            "sessionId":session_id,"messageId":assistant_message_id,
                            "text":completion.text,"finishReason":"cancelled"
                        }),
                    ),
                )?;
                emit(
                    app,
                    frame(
                        "session_status",
                        json!({"sessionId":session_id,"status":"idle"}),
                    ),
                )?;
                emit(
                    app,
                    frame(
                        "runtime_activity",
                        json!({
                            "contractVersion":1,"sessionId":session_id,"kind":"turn","state":"cancelled","timestamp":now_ms()
                        }),
                    ),
                )
            }
            Err(message) => {
                if let Ok(mut state) = self.state.lock() {
                    if let Some(session) = state
                        .sessions
                        .iter_mut()
                        .find(|item| item.session_id == session_id)
                    {
                        session.status = "error".into();
                        session.updated_at = now_ms();
                    }
                    let _ = self.persist(&state);
                }
                emit(
                    app,
                    error_frame(Some(&session_id), "model_request_failed", &message),
                )?;
                emit(
                    app,
                    frame(
                        "session_status",
                        json!({"sessionId":session_id,"status":"error"}),
                    ),
                )?;
                emit(
                    app,
                    frame(
                        "runtime_activity",
                        json!({
                            "contractVersion":1,"sessionId":session_id,"kind":"turn","state":"failed","detail":message,"timestamp":now_ms()
                        }),
                    ),
                )
            }
        }
    }
}

fn text_content(content: &Value) -> String {
    content
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|part| match part.get("type").and_then(Value::as_str) {
            Some("text") => part.get("value").and_then(Value::as_str).map(str::to_owned),
            Some("text_file_content") => part
                .pointer("/value/content")
                .and_then(Value::as_str)
                .map(str::to_owned),
            Some("code_reference") => part.get("value").and_then(|value| {
                Some(format!(
                    "[Code from {}]\n{}",
                    value.get("filePath")?.as_str()?,
                    value.get("code")?.as_str()?
                ))
            }),
            Some("file_reference") => part
                .pointer("/value/filePath")
                .and_then(Value::as_str)
                .map(|path| format!("[Attached file: {path}]")),
            Some("folder_reference") => part
                .pointer("/value/folderPath")
                .and_then(Value::as_str)
                .map(|path| format!("[Attached folder: {path}]")),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn emit(app: &AppHandle, value: Value) -> Result<(), String> {
    app.emit("desktop://server-frame", value)
        .map_err(|error| format!("无法发送 Rust 运行时事件: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex as TestMutex;

    #[derive(Default)]
    struct MemoryCredentials(TestMutex<HashMap<String, String>>);

    impl CredentialStore for MemoryCredentials {
        fn set(&self, id: &str, key: &str) -> Result<(), String> {
            self.0.lock().unwrap().insert(id.into(), key.into());
            Ok(())
        }
        fn get(&self, id: &str) -> Result<String, String> {
            self.0
                .lock()
                .unwrap()
                .get(id)
                .cloned()
                .ok_or_else(|| "missing".into())
        }
        fn delete(&self, id: &str) -> Result<(), String> {
            self.0.lock().unwrap().remove(id);
            Ok(())
        }
    }

    fn runtime() -> (tempfile::TempDir, NativeRuntime) {
        let root = tempfile::tempdir().expect("tempdir");
        let runtime = NativeRuntime::load_with_credentials(
            root.path(),
            Arc::new(MemoryCredentials::default()),
        )
        .expect("runtime");
        (root, runtime)
    }

    #[test]
    fn creates_persists_and_restores_a_session() {
        let (root, runtime) = runtime();
        let response = runtime
            .handle(&json!({"type":"create_session","payload":{"title":"  原生会话  ","clientRequestId":"req-1"}}))
            .expect("create");
        assert_eq!(response[0]["type"], "session_created");
        assert_eq!(response[0]["payload"]["session"]["title"], "原生会话");
        drop(runtime);
        let restored = NativeRuntime::load_with_credentials(
            root.path(),
            Arc::new(MemoryCredentials::default()),
        )
        .expect("restore");
        let sessions = restored
            .handle(&json!({"type":"list_sessions","payload":{}}))
            .expect("list");
        assert_eq!(
            sessions[0]["payload"]["sessions"].as_array().unwrap().len(),
            1
        );
    }

    #[test]
    fn rejects_relative_workspaces_and_unknown_frames_without_node_fallback() {
        let (_root, runtime) = runtime();
        let invalid = runtime
            .handle(&json!({"type":"set_session_workspace","payload":{"sessionId":"missing","workspacePath":"relative"}}))
            .expect("workspace response");
        assert_eq!(invalid[0]["payload"]["code"], "bad_workspace");
        let unknown = runtime
            .handle(&json!({"type":"not_real","payload":{}}))
            .expect("unknown response");
        assert_eq!(unknown[0]["payload"]["code"], "native_migration_incomplete");
    }

    #[test]
    fn caps_titles_and_never_serializes_a_secret_field() {
        let (_root, runtime) = runtime();
        let long = "会".repeat(MAX_TITLE_CHARS + 20);
        let response = runtime
            .handle(&json!({"type":"create_session","payload":{"title":long,"apiKey":"must-not-persist"}}))
            .expect("create");
        assert_eq!(
            response[0]["payload"]["session"]["title"]
                .as_str()
                .unwrap()
                .chars()
                .count(),
            MAX_TITLE_CHARS
        );
        let persisted = fs::read_to_string(&runtime.state_path).expect("state file");
        assert!(!persisted.contains("must-not-persist"));
        assert!(!persisted.contains("apiKey"));
    }

    #[test]
    fn stores_model_secrets_outside_the_state_file() {
        let (root, runtime) = runtime();
        let response = runtime
            .handle(&json!({"type":"save_custom_model","payload":{
                "provider":"openai","baseUrl":"https://api.deepseek.com","apiKey":"secret-value",
                "modelId":"deepseek-chat","displayName":"DeepSeek","makeActive":true
            }}))
            .expect("save model");
        assert_eq!(response[0]["type"], "models_list");
        assert_eq!(
            response[0]["payload"]["models"][0]["displayName"],
            "DeepSeek"
        );
        let persisted = fs::read_to_string(root.path().join(STATE_FILE_NAME)).unwrap();
        assert!(!persisted.contains("secret-value"));
        assert!(!persisted.contains("apiKey"));
    }

    #[test]
    fn cancel_signals_only_the_active_session_turn() {
        let (_root, runtime) = runtime();
        let (sender, mut receiver) = watch::channel(false);
        runtime.active_turns.lock().unwrap().insert(
            "session-1".into(),
            ActiveTurn {
                turn_id: "turn-1".into(),
                cancel: sender,
            },
        );
        let response = runtime
            .handle(&json!({"type":"cancel","payload":{"sessionId":"session-1"}}))
            .unwrap();
        assert_eq!(response[0]["type"], "queue_drained");
        assert!(receiver.has_changed().unwrap());
        assert!(*receiver.borrow_and_update());
    }

    #[test]
    fn memory_and_tool_frames_use_the_session_workspace() {
        let (root, runtime) = runtime();
        let created = runtime
            .handle(&json!({"type":"create_session","payload":{}}))
            .unwrap();
        let session_id = created[0]["payload"]["session"]["sessionId"]
            .as_str()
            .unwrap();
        runtime
            .handle(&json!({"type":"set_session_workspace","payload":{
                "sessionId":session_id,"workspacePath":root.path()
            }}))
            .unwrap();
        let memory = runtime
            .handle(&json!({"type":"add_memory","payload":{
                "sessionId":session_id,"fact":"保持 Rust 单一路径"
            }}))
            .unwrap();
        assert_eq!(memory[0]["type"], "memory_snapshot");
        assert!(fs::read_to_string(root.path().join("OTTO.md"))
            .unwrap()
            .contains("保持 Rust 单一路径"));
        let tools = runtime
            .handle(&json!({"type":"get_tools","payload":{"sessionId":session_id}}))
            .unwrap();
        assert_eq!(tools[0]["type"], "tools_list");
        assert!(!tools[0]["payload"]["tools"].as_array().unwrap().is_empty());
    }

    #[test]
    fn confirmation_response_resolves_the_matching_rust_tool_call() {
        let (_root, runtime) = runtime();
        let (sender, mut receiver) = watch::channel(None::<String>);
        runtime
            .pending_confirmations
            .lock()
            .unwrap()
            .insert("call-1".into(), sender);
        let response = runtime
            .handle(&json!({"type":"tool_confirmation_response","payload":{
                "sessionId":"session-1","callId":"call-1","outcome":"approved"
            }}))
            .unwrap();
        assert!(response.is_empty());
        assert!(receiver.has_changed().unwrap());
        assert_eq!(receiver.borrow_and_update().as_deref(), Some("approved"));
    }

    #[test]
    fn tool_audit_records_digests_without_raw_arguments() {
        let (_root, runtime) = runtime();
        let call = ModelToolCall {
            id: "call-1".into(),
            name: "write_file".into(),
            arguments: json!({"path":"a.txt","content":"must-not-leak"}),
        };
        runtime
            .audit_tool("session-1", &call, "requested", None)
            .unwrap();
        let audit = fs::read_to_string(&runtime.audit_path).unwrap();
        assert!(audit.contains("argumentDigest"));
        assert!(audit.contains("write_file"));
        assert!(!audit.contains("must-not-leak"));
    }
}
