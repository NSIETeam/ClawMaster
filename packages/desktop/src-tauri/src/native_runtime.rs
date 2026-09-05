use crate::native_models::{
    stream_complete, system_credential_store, CredentialStore, ModelCompletion, ModelMessage,
    ModelStreamEvent, ModelToolCall, NativeModel, StreamCompletion,
};
use crate::{
    native_agent_tools, native_checkpoints, native_context, native_diagnostics, native_enterprise,
    native_knowledge, native_mcp, native_memory, native_projects, native_schedule, native_skills,
    native_todos, native_workflows, native_worklog, platform_webview,
};
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
const COMPRESSION_THRESHOLD_CHARS: usize = 16_000;
const MAX_COMPRESSION_INPUT_CHARS: usize = 2_000_000;
const SEARCH_CREDENTIAL_ID: &str = "native-search-api-key";

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
pub(crate) struct StoredMessage {
    pub(crate) id: String,
    pub(crate) session_id: String,
    pub(crate) role: String,
    pub(crate) content: Value,
    pub(crate) timestamp: u64,
    pub(crate) source: String,
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

#[derive(Clone, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
struct SearchConfig {
    provider: String,
    api_url: String,
    model: String,
    cost_per_request_cny: Option<f64>,
    monthly_request_quota: Option<u64>,
    monthly_budget_cny: Option<f64>,
}

impl Default for SearchConfig {
    fn default() -> Self {
        Self {
            provider: "bing".into(),
            api_url: "https://api.bing.microsoft.com/v7.0/search".into(),
            model: String::new(),
            cost_per_request_cny: None,
            monthly_request_quota: None,
            monthly_budget_cny: None,
        }
    }
}

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
struct ModelUsage {
    requests: u64,
    input_tokens: u64,
    output_tokens: u64,
}

#[derive(Default, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
struct PersistedState {
    sessions: Vec<Session>,
    messages: HashMap<String, Vec<StoredMessage>>,
    settings: Settings,
    search_config: SearchConfig,
    current_model: Option<String>,
    authorization_mode: String,
    models: Vec<NativeModel>,
    handled_auto_skills: Vec<String>,
    mcp_servers: Vec<native_mcp::McpServerConfig>,
    todos: Vec<native_todos::TodoItem>,
    model_usage: HashMap<String, ModelUsage>,
    enterprise: native_enterprise::EnterpriseState,
    workflows: Vec<Value>,
}

pub struct NativeRuntime {
    state_path: PathBuf,
    audit_path: PathBuf,
    knowledge_path: PathBuf,
    schedule_path: PathBuf,
    checkpoint_root: PathBuf,
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

    fn auto_skill_candidates(
        &self,
        state: &PersistedState,
    ) -> Result<Vec<native_skills::AutoSkillCandidate>, String> {
        let workspaces = state
            .sessions
            .iter()
            .filter_map(|session| {
                session
                    .workspace_path
                    .as_ref()
                    .map(|workspace| (session.session_id.clone(), PathBuf::from(workspace)))
            })
            .collect::<HashMap<_, _>>();
        let handled = state
            .handled_auto_skills
            .iter()
            .cloned()
            .collect::<std::collections::HashSet<_>>();
        native_skills::scan(&self.audit_path, &workspaces, &handled)
    }

    fn channel_session(&self, provider: &str, chat_id: &str) -> Result<String, String> {
        let source = format!("channel:{provider}:{chat_id}");
        let mut state = self
            .state
            .lock()
            .map_err(|_| "Rust 运行时状态锁已损坏".to_string())?;
        if let Some(session) = state
            .sessions
            .iter()
            .find(|session| session.source == source)
        {
            return Ok(session.session_id.clone());
        }
        let timestamp = now_ms();
        let session = Session {
            session_id: next_id("session"),
            source,
            title: bounded_title(Some(&format!("{provider} {chat_id}"))),
            status: "idle".into(),
            model: state.current_model.clone(),
            workspace_path: None,
            created_at: timestamp,
            updated_at: timestamp,
            last_message_preview: String::new(),
            message_count: 0,
        };
        let session_id = session.session_id.clone();
        state.sessions.insert(0, session);
        self.persist(&state)?;
        Ok(session_id)
    }

    pub async fn run_channel_turn(
        &self,
        app: &AppHandle,
        provider: &str,
        chat_id: &str,
        message_id: &str,
        text: &str,
    ) -> Result<String, String> {
        let session_id = self.channel_session(provider, chat_id)?;
        let session = {
            let state = self
                .state
                .lock()
                .map_err(|_| "Rust 运行时状态锁已损坏".to_string())?;
            state
                .sessions
                .iter()
                .find(|session| session.session_id == session_id)
                .cloned()
                .ok_or_else(|| "通道会话不存在".to_string())?
        };
        emit(app, frame("session_upsert", json!({"session":session})))?;
        self.run_turn_result(
            app,
            &json!({
                "type":"send_user_message",
                "payload":{
                    "sessionId":session_id,
                    "source":provider,
                    "clientMessageId":message_id,
                    "content":[{"type":"text","value":text}]
                }
            }),
        )
        .await?
        .filter(|reply| !reply.trim().is_empty())
        .ok_or_else(|| "模型本轮未产生可回发文本".to_string())
    }

    pub fn cancel_channel_turns(&self, provider: &str) -> Result<(), String> {
        let prefix = format!("channel:{provider}:");
        let session_ids = self
            .state
            .lock()
            .map_err(|_| "Rust 运行时状态锁已损坏".to_string())?
            .sessions
            .iter()
            .filter(|session| session.source.starts_with(&prefix))
            .map(|session| session.session_id.clone())
            .collect::<Vec<_>>();
        let active_turns = self
            .active_turns
            .lock()
            .map_err(|_| "Rust 运行时取消状态锁已损坏".to_string())?;
        for session_id in session_ids {
            if let Some(active) = active_turns.get(&session_id) {
                let _ = active.cancel.send(true);
            }
        }
        Ok(())
    }

    pub fn has_channel_message(&self, provider: &str, message_id: &str) -> Result<bool, String> {
        Ok(self
            .state
            .lock()
            .map_err(|_| "Rust 运行时状态锁已损坏".to_string())?
            .messages
            .values()
            .flatten()
            .any(|message| message.source == provider && message.id == message_id))
    }

    pub fn load(app_data_dir: &Path) -> Result<Self, String> {
        let user_dir = std::env::var_os("CLAWMASTER_USER_DIR")
            .map(PathBuf::from)
            .or_else(|| {
                std::env::var_os("HOME")
                    .or_else(|| std::env::var_os("USERPROFILE"))
                    .map(|home| PathBuf::from(home).join(".otto-user"))
            })
            .unwrap_or_else(|| app_data_dir.to_path_buf());
        Self::load_with_paths(
            app_data_dir,
            user_dir.join("knowledge/entries.jsonl"),
            user_dir.join("schedules.json"),
            system_credential_store(),
        )
    }

    #[cfg(test)]
    fn load_with_credentials(
        app_data_dir: &Path,
        credentials: Arc<dyn CredentialStore>,
    ) -> Result<Self, String> {
        Self::load_with_paths(
            app_data_dir,
            app_data_dir.join("knowledge/entries.jsonl"),
            app_data_dir.join("schedules.json"),
            credentials,
        )
    }

    fn load_with_paths(
        app_data_dir: &Path,
        knowledge_path: PathBuf,
        schedule_path: PathBuf,
        credentials: Arc<dyn CredentialStore>,
    ) -> Result<Self, String> {
        fs::create_dir_all(app_data_dir)
            .map_err(|error| format!("无法创建 Rust 运行时目录: {error}"))?;
        let state_path = app_data_dir.join(STATE_FILE_NAME);
        let state_backup = state_path.with_extension("json.bak");
        let audit_path = app_data_dir.join("native-audit.jsonl");
        let checkpoint_root = app_data_dir.join("file-checkpoints");
        let state_source = if state_path.exists() || !state_backup.exists() {
            &state_path
        } else {
            &state_backup
        };
        let mut state = match fs::read(state_source) {
            Ok(bytes) => serde_json::from_slice(&bytes)
                .map_err(|error| format!("Rust 运行时状态损坏: {error}"))?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => PersistedState {
                authorization_mode: "manual".into(),
                ..PersistedState::default()
            },
            Err(error) => return Err(format!("无法读取 Rust 运行时状态: {error}")),
        };
        native_workflows::recover_interrupted(&mut state.workflows, now_ms());
        Ok(Self {
            state_path,
            audit_path,
            knowledge_path,
            schedule_path,
            checkpoint_root,
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
        let mut output = fs::File::create(&temporary)
            .map_err(|error| format!("无法创建 Rust 运行时临时状态: {error}"))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&temporary, fs::Permissions::from_mode(0o600))
                .map_err(|error| format!("无法保护 Rust 运行时状态: {error}"))?;
        }
        output
            .write_all(&bytes)
            .and_then(|_| output.sync_all())
            .map_err(|error| format!("无法写入 Rust 运行时状态: {error}"))?;
        let backup = self.state_path.with_extension("json.bak");
        if self.state_path.exists() {
            let _ = fs::remove_file(&backup);
            fs::rename(&self.state_path, &backup)
                .map_err(|error| format!("无法备份 Rust 运行时状态: {error}"))?;
        }
        match fs::rename(&temporary, &self.state_path) {
            Ok(()) => {
                let _ = fs::remove_file(backup);
                Ok(())
            }
            Err(error) => {
                if backup.exists() {
                    let _ = fs::rename(&backup, &self.state_path);
                }
                let _ = fs::remove_file(temporary);
                Err(format!("无法提交 Rust 运行时状态: {error}"))
            }
        }
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

    fn stats_snapshot(&self, state: &PersistedState) -> Value {
        let models = state
            .model_usage
            .iter()
            .map(|(name, usage)| {
                (
                    name.clone(),
                    json!({
                        "requests":usage.requests,"inputTokens":usage.input_tokens,
                        "outputTokens":usage.output_tokens,
                        "totalTokens":usage.input_tokens + usage.output_tokens
                    }),
                )
            })
            .collect::<serde_json::Map<_, _>>();
        let mut by_name = serde_json::Map::new();
        let mut total_calls = 0_u64;
        let mut total_success = 0_u64;
        let mut total_fail = 0_u64;
        if fs::metadata(&self.audit_path).is_ok_and(|metadata| metadata.len() <= 16 * 1024 * 1024) {
            if let Ok(raw) = fs::read_to_string(&self.audit_path) {
                for value in raw
                    .lines()
                    .filter_map(|line| serde_json::from_str::<Value>(line).ok())
                {
                    let status = value.get("state").and_then(Value::as_str).unwrap_or("");
                    if !matches!(status, "completed" | "failed" | "rejected") {
                        continue;
                    }
                    let name = value
                        .get("tool")
                        .and_then(Value::as_str)
                        .unwrap_or("unknown");
                    total_calls += 1;
                    let success = u64::from(status == "completed");
                    let fail = u64::from(status != "completed");
                    total_success += success;
                    total_fail += fail;
                    let entry = by_name
                        .entry(name.to_string())
                        .or_insert_with(|| json!({"count":0,"success":0,"fail":0}));
                    entry["count"] = json!(entry["count"].as_u64().unwrap_or(0) + 1);
                    entry["success"] = json!(entry["success"].as_u64().unwrap_or(0) + success);
                    entry["fail"] = json!(entry["fail"].as_u64().unwrap_or(0) + fail);
                }
            }
        }
        let active = state
            .sessions
            .iter()
            .filter(|session| matches!(session.status.as_str(), "thinking" | "streaming"))
            .count();
        json!({
            "models":models,
            "tools":{"totalCalls":total_calls,"totalSuccess":total_success,"totalFail":total_fail,"byName":by_name},
            "sessions":{"total":state.sessions.len(),"active":active,"idle":state.sessions.len().saturating_sub(active),"archived":0,"frozen":0}
        })
    }

    fn search_config_snapshot(&self, config: &SearchConfig) -> Value {
        let has_api_key = self.credentials.get(SEARCH_CREDENTIAL_ID).is_ok();
        json!({
            "provider":config.provider,"apiUrl":config.api_url,"model":config.model,
            "hasApiKey":has_api_key,
            "configuredProviders":if has_api_key { vec![config.provider.clone()] } else { Vec::<String>::new() },
            "costPerRequestCny":config.cost_per_request_cny,
            "monthlyRequestQuota":config.monthly_request_quota,
            "monthlyBudgetCny":config.monthly_budget_cny,
            "diagnostics":{
                "tenantId":"local","cacheEntries":0,"cacheHits":0,"totalAttempts":0,
                "totalSuccesses":0,"estimatedCostCny":0,"updatedAt":0,"providers":[]
            }
        })
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
            "get_search_config" => vec![frame(
                "search_config",
                self.search_config_snapshot(&state.search_config),
            )],
            "save_search_config" => {
                let provider = payload
                    .get("provider")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                let api_url = payload
                    .get("apiUrl")
                    .and_then(Value::as_str)
                    .unwrap_or(&state.search_config.api_url)
                    .to_string();
                let valid_url = url::Url::parse(&api_url).is_ok_and(|url| {
                    url.scheme() == "https" && url.username().is_empty() && url.password().is_none()
                });
                let valid_numbers =
                    ["costPerRequestCny", "monthlyBudgetCny"].iter().all(|key| {
                        payload.get(key).is_none_or(|value| {
                            value
                                .as_f64()
                                .is_some_and(|number| number.is_finite() && number >= 0.0)
                        })
                    }) && payload.get("monthlyRequestQuota").is_none_or(Value::is_u64);
                if !matches!(provider, "bing" | "bocha" | "gemini" | "volcengine")
                    || !valid_url
                    || !valid_numbers
                {
                    vec![error_frame(
                        None,
                        "save_search_config_failed",
                        "搜索配置无效；provider 必须受支持且 API 地址必须为无内嵌凭据的 HTTPS",
                    )]
                } else {
                    let credential_result = if payload
                        .get("clearApiKey")
                        .and_then(Value::as_bool)
                        .unwrap_or(false)
                    {
                        self.credentials.delete(SEARCH_CREDENTIAL_ID)
                    } else if let Some(api_key) = payload.get("apiKey").and_then(Value::as_str) {
                        if api_key.trim().is_empty() {
                            Ok(())
                        } else {
                            self.credentials.set(SEARCH_CREDENTIAL_ID, api_key.trim())
                        }
                    } else {
                        Ok(())
                    };
                    match credential_result {
                        Err(message) => {
                            vec![error_frame(None, "save_search_config_failed", &message)]
                        }
                        Ok(()) => {
                            state.search_config.provider = provider.into();
                            state.search_config.api_url = api_url;
                            if let Some(model) = payload.get("model").and_then(Value::as_str) {
                                state.search_config.model = model.chars().take(200).collect();
                            }
                            if payload.get("costPerRequestCny").is_some() {
                                state.search_config.cost_per_request_cny =
                                    payload.get("costPerRequestCny").and_then(Value::as_f64);
                            }
                            if payload.get("monthlyRequestQuota").is_some() {
                                state.search_config.monthly_request_quota =
                                    payload.get("monthlyRequestQuota").and_then(Value::as_u64);
                            }
                            if payload.get("monthlyBudgetCny").is_some() {
                                state.search_config.monthly_budget_cny =
                                    payload.get("monthlyBudgetCny").and_then(Value::as_f64);
                            }
                            dirty = true;
                            vec![frame(
                                "search_config",
                                self.search_config_snapshot(&state.search_config),
                            )]
                        }
                    }
                }
            }
            "run_doctor" => vec![frame("doctor_report", native_diagnostics::doctor_report())],
            "get_stats" => vec![frame("stats_snapshot", self.stats_snapshot(&state))],
            "get_todos" => vec![frame("todos_list", json!({"todos":state.todos}))],
            "work_log_today" => vec![frame(
                "work_log_today_result",
                json!({"requestId":payload.get("requestId"),"summary":native_worklog::today(&self.audit_path)}),
            )],
            "work_log_recent" => vec![frame(
                "work_log_recent_result",
                json!({
                    "requestId":payload.get("requestId"),
                    "days":native_worklog::recent(&self.audit_path, payload.get("days").and_then(Value::as_u64).unwrap_or(31))
                }),
            )],
            "work_log_report" => match native_worklog::report(&self.audit_path) {
                Ok(report) => vec![frame(
                    "work_log_report_result",
                    json!({"requestId":payload.get("requestId"),"report":report}),
                )],
                Err(message) => vec![error_frame(None, "work_log_failed", &message)],
            },
            "get_workflows" => vec![frame(
                "workflows_list",
                json!({"workflows":state.workflows}),
            )],
            "export_conversation" => {
                let session_id = payload
                    .get("sessionId")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                if let Some(session) = state
                    .sessions
                    .iter()
                    .find(|item| item.session_id == session_id)
                {
                    let messages = state
                        .messages
                        .get(session_id)
                        .map(Vec::as_slice)
                        .unwrap_or_default();
                    let (suggested_file_name, markdown) =
                        native_context::export_markdown(&session.title, messages);
                    vec![frame(
                        "export_result",
                        json!({
                            "sessionId":session_id,"suggestedFileName":suggested_file_name,"markdown":markdown
                        }),
                    )]
                } else {
                    vec![error_frame(Some(session_id), "no_session", "会话不存在")]
                }
            }
            "get_extensions" => {
                let workspace = Self::workspace_for_session(
                    &state,
                    payload.get("sessionId").and_then(Value::as_str),
                );
                match native_context::extensions(&workspace) {
                    Ok(extensions) => {
                        vec![frame("extensions_list", json!({"extensions":extensions}))]
                    }
                    Err(message) => vec![error_frame(None, "get_extensions_failed", &message)],
                }
            }
            "get_ide_status" => vec![frame(
                "ide_status",
                json!({
                    "status":"not_applicable",
                    "details":"IDE 伴生状态仅适用于终端内 CLI；Rust 原生桌面端不适用。"
                }),
            )],
            "mcp_list" => vec![frame(
                "mcp_servers",
                json!({ "servers": native_mcp::public_servers(&state.mcp_servers) }),
            )],
            "mcp_add" => {
                let name = payload
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .trim();
                let existing_index = state
                    .mcp_servers
                    .iter()
                    .position(|server| server.name == name);
                if existing_index.is_none() && state.mcp_servers.len() >= 20 {
                    vec![error_frame(
                        None,
                        "mcp_add_failed",
                        "MCP 服务器数量已达到 20 个上限",
                    )]
                } else {
                    let existing = existing_index.map(|index| &state.mcp_servers[index]);
                    match native_mcp::parse_config(&payload, existing) {
                        Ok((mut config, secrets)) => {
                            let store_result = if let Some(secrets) = secrets {
                                let credential_id = config
                                    .credential_id
                                    .clone()
                                    .unwrap_or_else(|| next_id("mcp-credential"));
                                match serde_json::to_string(&secrets) {
                                    Ok(secret) => self.credentials.set(&credential_id, &secret),
                                    Err(error) => Err(format!("无法编码 MCP 安全凭据: {error}")),
                                }
                                .map(|_| config.credential_id = Some(credential_id))
                            } else {
                                Ok(())
                            };
                            match store_result {
                                Ok(()) => {
                                    if let Some(index) = existing_index {
                                        state.mcp_servers[index] = config;
                                    } else {
                                        state.mcp_servers.push(config);
                                    }
                                    dirty = true;
                                    vec![frame(
                                        "mcp_servers",
                                        json!({ "servers": native_mcp::public_servers(&state.mcp_servers) }),
                                    )]
                                }
                                Err(message) => vec![error_frame(None, "mcp_add_failed", &message)],
                            }
                        }
                        Err(message) => vec![error_frame(None, "mcp_add_failed", &message)],
                    }
                }
            }
            "mcp_remove" => {
                let name = payload.get("name").and_then(Value::as_str).unwrap_or("");
                if let Some(index) = state
                    .mcp_servers
                    .iter()
                    .position(|server| server.name == name)
                {
                    let credential_id = state.mcp_servers[index].credential_id.clone();
                    let deletion = credential_id
                        .as_deref()
                        .map(|id| self.credentials.delete(id))
                        .unwrap_or(Ok(()));
                    match deletion {
                        Ok(()) => {
                            state.mcp_servers.remove(index);
                            dirty = true;
                            vec![frame(
                                "mcp_servers",
                                json!({ "servers": native_mcp::public_servers(&state.mcp_servers) }),
                            )]
                        }
                        Err(message) => vec![error_frame(None, "mcp_remove_failed", &message)],
                    }
                } else {
                    vec![error_frame(None, "mcp_remove_failed", "MCP 服务器不存在")]
                }
            }
            "get_product_workspace" => vec![frame(
                "product_workspace",
                native_enterprise::snapshot(&state.enterprise),
            )],
            "configure_enterprise" => {
                match native_enterprise::configure(&mut state.enterprise, &payload) {
                    Ok(workspace) => {
                        dirty = true;
                        vec![frame("product_workspace", workspace)]
                    }
                    Err(message) => vec![error_frame(None, "workspace_failed", &message)],
                }
            }
            "switch_to_personal" => {
                let workspace = native_enterprise::switch_personal(&mut state.enterprise);
                dirty = true;
                vec![frame("product_workspace", workspace)]
            }
            "join_enterprise" => match native_enterprise::join(&mut state.enterprise, &payload) {
                Ok(workspace) => {
                    dirty = true;
                    vec![frame("product_workspace", workspace)]
                }
                Err(message) => vec![error_frame(None, "workspace_failed", &message)],
            },
            "create_enterprise_invite" => match native_enterprise::issue(
                &state.enterprise,
                &payload,
                self.credentials.as_ref(),
            ) {
                Ok(invite) => vec![frame("enterprise_invite_created", invite)],
                Err(message) => vec![error_frame(None, "workspace_failed", &message)],
            },
            "add_friend" => match native_enterprise::add_friend(&mut state.enterprise, &payload) {
                Ok(workspace) => {
                    dirty = true;
                    vec![frame("product_workspace", workspace)]
                }
                Err(message) => vec![error_frame(None, "workspace_failed", &message)],
            },
            "accept_company_link" => {
                match native_enterprise::accept_company_link(&mut state.enterprise, &payload) {
                    Ok(workspace) => {
                        dirty = true;
                        vec![frame("product_workspace", workspace)]
                    }
                    Err(message) => vec![error_frame(None, "workspace_failed", &message)],
                }
            }
            "get_schedules" => match native_schedule::list(
                &self.schedule_path,
                payload.get("date").and_then(Value::as_str),
                payload.get("timezone").and_then(Value::as_str),
            ) {
                Ok(schedules) => vec![frame(
                    "schedules_list",
                    json!({"schedules":schedules,"date":payload.get("date"),"timezone":payload.get("timezone")}),
                )],
                Err(message) => vec![error_frame(None, "schedule_failed", &message)],
            },
            "create_schedule" => {
                match native_schedule::create(&self.schedule_path, &payload, "user") {
                    Ok(_) => match native_schedule::list(&self.schedule_path, None, None) {
                        Ok(schedules) => {
                            vec![frame("schedules_list", json!({"schedules":schedules}))]
                        }
                        Err(message) => vec![error_frame(None, "schedule_failed", &message)],
                    },
                    Err(message) => vec![error_frame(None, "schedule_failed", &message)],
                }
            }
            "update_schedule" => match native_schedule::update(&self.schedule_path, &payload) {
                Ok(_) => match native_schedule::list(&self.schedule_path, None, None) {
                    Ok(schedules) => vec![frame("schedules_list", json!({"schedules":schedules}))],
                    Err(message) => vec![error_frame(None, "schedule_failed", &message)],
                },
                Err(message) => vec![error_frame(None, "schedule_failed", &message)],
            },
            "delete_schedule" => {
                let id = payload.get("id").and_then(Value::as_str).unwrap_or("");
                match native_schedule::remove(&self.schedule_path, id) {
                    Ok(true) => match native_schedule::list(&self.schedule_path, None, None) {
                        Ok(schedules) => {
                            vec![frame("schedules_list", json!({"schedules":schedules}))]
                        }
                        Err(message) => vec![error_frame(None, "schedule_failed", &message)],
                    },
                    Ok(false) => vec![error_frame(None, "schedule_failed", "未找到要删除的日程")],
                    Err(message) => vec![error_frame(None, "schedule_failed", &message)],
                }
            }
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
            "get_file_checkpoints" => {
                let session_id = payload
                    .get("sessionId")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                if !state
                    .sessions
                    .iter()
                    .any(|session| session.session_id == session_id)
                {
                    vec![error_frame(Some(session_id), "no_session", "会话不存在")]
                } else {
                    let workspace = Self::workspace_for_session(&state, Some(session_id));
                    match native_checkpoints::list(&self.checkpoint_root, &workspace) {
                        Ok(checkpoints) => vec![frame(
                            "file_checkpoints",
                            json!({"sessionId":session_id,"checkpoints":checkpoints}),
                        )],
                        Err(message) => vec![error_frame(
                            Some(session_id),
                            "file_checkpoints_failed",
                            &message,
                        )],
                    }
                }
            }
            "get_knowledge" => {
                let limit = payload
                    .get("limit")
                    .and_then(Value::as_u64)
                    .unwrap_or(50)
                    .clamp(1, 100) as usize;
                match native_knowledge::list(&self.knowledge_path, limit) {
                    Ok(entries) => vec![frame(
                        "knowledge_data",
                        json!({"entries":entries,"action":"list"}),
                    )],
                    Err(message) => vec![error_frame(None, "knowledge_error", &message)],
                }
            }
            "search_knowledge" => {
                let query = payload.get("query").and_then(Value::as_str).unwrap_or("");
                let category = payload.get("category").and_then(Value::as_str);
                match native_knowledge::search(&self.knowledge_path, query, category, 20) {
                    Ok(entries) => vec![frame(
                        "knowledge_data",
                        json!({"entries":entries,"action":"search","query":query}),
                    )],
                    Err(message) => vec![error_frame(None, "knowledge_error", &message)],
                }
            }
            "add_knowledge" => {
                let content = payload.get("content").and_then(Value::as_str).unwrap_or("");
                let category = payload.get("category").and_then(Value::as_str);
                let tags = match payload.get("tags") {
                    None => Ok(Vec::new()),
                    Some(Value::Array(values)) => values
                        .iter()
                        .map(|value| {
                            value
                                .as_str()
                                .map(str::to_owned)
                                .ok_or_else(|| "知识标签必须是字符串".to_string())
                        })
                        .collect::<Result<Vec<_>, _>>(),
                    Some(_) => Err("知识标签必须是数组".into()),
                };
                match tags.and_then(|tags| {
                    native_knowledge::add(&self.knowledge_path, content, category, &tags)
                }) {
                    Ok(entry) => vec![frame("knowledge_added", json!({"entry":entry}))],
                    Err(message) => vec![error_frame(None, "knowledge_error", &message)],
                }
            }
            "remove_knowledge" => {
                let id = payload.get("id").and_then(Value::as_str).unwrap_or("");
                match native_knowledge::remove(&self.knowledge_path, id) {
                    Ok(true) => vec![frame("knowledge_removed", json!({"id":id}))],
                    Ok(false) => vec![error_frame(None, "knowledge_error", "知识条目不存在")],
                    Err(message) => vec![error_frame(None, "knowledge_error", &message)],
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
                let mut tools = native_agent_tools::summaries()
                    .as_array()
                    .cloned()
                    .unwrap_or_default();
                tools.extend(native_checkpoints::summaries());
                tools.extend(native_knowledge::summaries());
                tools.extend(native_schedule::summaries());
                tools.extend(native_todos::summaries());
                tools.extend(native_skills::summaries());
                tools.extend(native_workflows::summaries());
                vec![frame(
                    "tools_list",
                    json!({"sessionId":session_id,"tools":tools}),
                )]
            }
            "get_skills" => {
                let workspace = Self::workspace_for_session(
                    &state,
                    payload.get("sessionId").and_then(Value::as_str),
                );
                match native_skills::list(&workspace) {
                    Ok(skills) => vec![frame("skills_list", json!({ "skills": skills }))],
                    Err(message) => vec![error_frame(None, "get_skills_failed", &message)],
                }
            }
            "get_pending_auto_skills" | "scan_pending_auto_skills" => {
                match self.auto_skill_candidates(&state) {
                    Ok(candidates) => vec![frame(
                        "pending_auto_skills",
                        json!({ "candidates": candidates.iter().map(native_skills::AutoSkillCandidate::public_value).collect::<Vec<_>>() }),
                    )],
                    Err(message) => vec![error_frame(None, "auto_skill_failed", &message)],
                }
            }
            "confirm_pending_auto_skill" => {
                let candidate_id = payload
                    .get("candidateId")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                match self
                    .auto_skill_candidates(&state)
                    .and_then(|candidates| {
                        candidates
                            .into_iter()
                            .find(|candidate| candidate.id == candidate_id)
                            .ok_or_else(|| "自动 Skill 候选不存在或已处理".to_string())
                    })
                    .and_then(|candidate| {
                        let saved_path = native_skills::install(&candidate)?;
                        state.handled_auto_skills.push(candidate.id.clone());
                        dirty = true;
                        let remaining = self.auto_skill_candidates(&state)?;
                        let skills = native_skills::list(&candidate.workspace)?;
                        Ok((saved_path, remaining, skills))
                    }) {
                    Ok((saved_path, candidates, skills)) => vec![
                        frame(
                            "pending_auto_skills",
                            json!({
                                "candidates": candidates.iter().map(native_skills::AutoSkillCandidate::public_value).collect::<Vec<_>>(),
                                "lastAction": { "kind": "confirmed", "candidateId": candidate_id, "savedPath": saved_path }
                            }),
                        ),
                        frame("skills_list", json!({ "skills": skills })),
                    ],
                    Err(message) => vec![error_frame(None, "auto_skill_failed", &message)],
                }
            }
            "reject_pending_auto_skill" => {
                let candidate_id = payload
                    .get("candidateId")
                    .and_then(Value::as_str)
                    .unwrap_or("");
                match self.auto_skill_candidates(&state).and_then(|candidates| {
                    if !candidates
                        .iter()
                        .any(|candidate| candidate.id == candidate_id)
                    {
                        return Err("自动 Skill 候选不存在或已处理".to_string());
                    }
                    state.handled_auto_skills.push(candidate_id.to_string());
                    dirty = true;
                    self.auto_skill_candidates(&state)
                }) {
                    Ok(candidates) => vec![frame(
                        "pending_auto_skills",
                        json!({
                            "candidates": candidates.iter().map(native_skills::AutoSkillCandidate::public_value).collect::<Vec<_>>(),
                            "lastAction": { "kind": "rejected", "candidateId": candidate_id }
                        }),
                    )],
                    Err(message) => vec![error_frame(None, "auto_skill_failed", &message)],
                }
            }
            "list_slash_commands" => vec![frame(
                "slash_commands_list",
                json!({ "commands": [
                    {"name":"about","description":"版本与运行环境信息"},
                    {"name":"context","description":"当前会话的上下文 token 用量分解"},
                    {"name":"tools","description":"列出当前会话可用的原生与 MCP 工具"},
                    {"name":"mcp","description":"MCP 服务器清单与连接状态"},
                    {"name":"extensions","description":"列出已安装扩展"},
                    {"name":"memory","description":"查看项目与全局记忆"},
                    {"name":"skills","description":"查看已安装 Skill"},
                    {"name":"doctor","description":"检查原生运行时"},
                    {"name":"restore","description":"查看或确认恢复 Rust 原生文件恢复点"},
                    {"name":"compress","description":"使用当前模型压缩会话上下文"},
                    {"name":"init","description":"分析当前目录并生成项目记忆"}
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

    pub async fn handle_async(&self, request: &Value) -> Result<Vec<Value>, String> {
        let request_type = request.get("type").and_then(Value::as_str).unwrap_or("");
        if !matches!(
            request_type,
            "mcp_list" | "get_tools" | "get_context_breakdown" | "compress_context"
        ) {
            return self.handle(request);
        }
        let payload = request.get("payload").cloned().unwrap_or_else(|| json!({}));
        if request_type == "compress_context" {
            return self.compress_context(&payload).await;
        }
        let configs = self
            .state
            .lock()
            .map_err(|_| "Rust 运行时状态锁已损坏".to_string())?
            .mcp_servers
            .clone();
        let catalog = native_mcp::discover(&configs, self.credentials.as_ref()).await;
        if request_type == "mcp_list" {
            return Ok(vec![frame(
                "mcp_servers",
                json!({ "servers": catalog.public_servers(&configs) }),
            )]);
        }
        let session_id = payload
            .get("sessionId")
            .and_then(Value::as_str)
            .unwrap_or("");
        if request_type == "get_context_breakdown" {
            let state = self
                .state
                .lock()
                .map_err(|_| "Rust 运行时状态锁已损坏".to_string())?;
            let Some(session) = state
                .sessions
                .iter()
                .find(|item| item.session_id == session_id)
            else {
                return Ok(vec![error_frame(
                    Some(session_id),
                    "no_session",
                    "会话不存在",
                )]);
            };
            let workspace = Self::workspace_for_session(&state, Some(session_id));
            let prompt = native_context::system_prompt(
                &workspace,
                &state.settings.preferred_language,
                &state.settings.agent_style,
                &native_skills::list(&workspace).unwrap_or_default(),
            );
            let messages = state
                .messages
                .get(session_id)
                .into_iter()
                .flatten()
                .map(|message| ModelMessage {
                    role: message.role.clone(),
                    text: text_content(&message.content),
                })
                .collect::<Vec<_>>();
            let model = session
                .model
                .as_deref()
                .or(state.current_model.as_deref())
                .and_then(|id| state.models.iter().find(|item| item.id == id));
            let mut definitions = native_agent_tools::definitions();
            definitions.extend(native_checkpoints::definitions());
            definitions.extend(native_knowledge::definitions());
            definitions.extend(native_schedule::definitions());
            definitions.extend(native_todos::definitions());
            definitions.extend(native_skills::definitions());
            definitions.extend(native_workflows::definitions());
            definitions.extend(catalog.definitions.clone());
            return Ok(vec![frame(
                "context_breakdown",
                native_context::breakdown(
                    session_id,
                    model,
                    &messages,
                    &prompt,
                    &definitions,
                    &workspace,
                ),
            )]);
        }
        let mut tools = native_agent_tools::summaries()
            .as_array()
            .cloned()
            .unwrap_or_default();
        tools.extend(native_checkpoints::summaries());
        tools.extend(native_knowledge::summaries());
        tools.extend(native_schedule::summaries());
        tools.extend(native_todos::summaries());
        tools.extend(native_skills::summaries());
        tools.extend(native_workflows::summaries());
        tools.extend(catalog.tool_summaries());
        Ok(vec![frame(
            "tools_list",
            json!({"sessionId":session_id,"tools":tools}),
        )])
    }

    async fn compress_context(&self, payload: &Value) -> Result<Vec<Value>, String> {
        let session_id = payload
            .get("sessionId")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        if self
            .active_turns
            .lock()
            .map_err(|_| "Rust 运行时取消状态锁已损坏".to_string())?
            .contains_key(&session_id)
        {
            return Ok(vec![frame(
                "compress_result",
                json!({"sessionId":session_id,"compressed":false,"message":"会话正在生成回复，请结束当前回复后再压缩。"}),
            )]);
        }
        let (model, api_key, transcript, original_tokens) = {
            let state = self
                .state
                .lock()
                .map_err(|_| "Rust 运行时状态锁已损坏".to_string())?;
            let Some(session) = state
                .sessions
                .iter()
                .find(|item| item.session_id == session_id)
            else {
                return Ok(vec![error_frame(
                    Some(&session_id),
                    "no_session",
                    "会话不存在",
                )]);
            };
            let model_id = session
                .model
                .as_deref()
                .or(state.current_model.as_deref())
                .ok_or_else(|| "请先配置并选择模型".to_string())?;
            let model = state
                .models
                .iter()
                .find(|item| item.id == model_id && item.enabled)
                .cloned()
                .ok_or_else(|| "当前模型不可用，请重新选择".to_string())?;
            let transcript = state
                .messages
                .get(&session_id)
                .into_iter()
                .flatten()
                .filter_map(|message| {
                    let text = text_content(&message.content);
                    (!text.trim().is_empty()).then(|| format!("{}: {}", message.role, text))
                })
                .collect::<Vec<_>>()
                .join("\n\n");
            let chars = transcript.chars().count();
            if chars < COMPRESSION_THRESHOLD_CHARS {
                return Ok(vec![frame(
                    "compress_result",
                    json!({"sessionId":session_id,"compressed":false,"message":"当前上下文较小，无需压缩。"}),
                )]);
            }
            if chars > MAX_COMPRESSION_INPUT_CHARS {
                return Ok(vec![error_frame(
                    Some(&session_id),
                    "compression_input_too_large",
                    "上下文超过 Rust 压缩安全上限，原历史已保留",
                )]);
            }
            let key = self.credentials.get(&model.credential_id)?;
            (model, key, transcript, chars.div_ceil(4) as u64)
        };
        let (_, cancel) = watch::channel(false);
        let messages = vec![
            ModelMessage {
                role: "system".into(),
                text: "Compress the conversation into a faithful continuation summary. Preserve decisions, requirements, paths, commands, errors, evidence, unresolved work, and safety constraints. Do not invent facts. Return only the summary.".into(),
            },
            ModelMessage { role: "user".into(), text: transcript },
        ];
        let completion = match stream_complete(
            &self.http,
            &model,
            &api_key,
            &messages,
            &[],
            cancel,
            |_| Ok(()),
        )
        .await
        {
            Ok(StreamCompletion::Completed(value)) if !value.text.trim().is_empty() => value,
            Ok(StreamCompletion::Completed(_)) => {
                return Ok(vec![error_frame(
                    Some(&session_id),
                    "compression_empty",
                    "模型返回空摘要，原历史已保留",
                )])
            }
            Ok(StreamCompletion::Cancelled(_)) => {
                return Ok(vec![frame(
                    "compress_result",
                    json!({"sessionId":session_id,"compressed":false,"message":"压缩已取消，原历史已保留。"}),
                )])
            }
            Err(message) => {
                return Ok(vec![error_frame(
                    Some(&session_id),
                    "compression_failed",
                    &format!("压缩失败，原历史已保留：{message}"),
                )])
            }
        };
        let new_tokens = completion
            .output_tokens
            .max(completion.text.chars().count().div_ceil(4) as u64);
        let timestamp = now_ms();
        {
            let mut state = self
                .state
                .lock()
                .map_err(|_| "Rust 运行时状态锁已损坏".to_string())?;
            if !state
                .sessions
                .iter()
                .any(|item| item.session_id == session_id)
            {
                return Ok(vec![error_frame(
                    Some(&session_id),
                    "no_session",
                    "压缩完成前会话已被删除，未写入摘要",
                )]);
            }
            state.messages.insert(session_id.clone(), vec![StoredMessage {
                id: next_id("summary"),
                session_id: session_id.clone(),
                role: "user".into(),
                content: json!([{"type":"text","value":format!("[此前会话的模型压缩摘要]\n{}", completion.text.trim())}]),
                timestamp,
                source: "local".into(),
            }]);
            if let Some(session) = state
                .sessions
                .iter_mut()
                .find(|item| item.session_id == session_id)
            {
                session.message_count = 1;
                session.updated_at = timestamp;
                session.last_message_preview = "上下文已压缩".into();
            }
            let usage = state.model_usage.entry(model.id.clone()).or_default();
            usage.requests += 1;
            usage.input_tokens += completion.input_tokens;
            usage.output_tokens += completion.output_tokens;
            self.persist(&state)?;
        }
        Ok(vec![frame(
            "compress_result",
            json!({
                "sessionId":session_id,"compressed":true,
                "originalTokenCount":original_tokens,"newTokenCount":new_tokens,
                "message":format!("已压缩：{original_tokens} → {new_tokens} tokens")
            }),
        )])
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

    async fn execute_workflow(
        &self,
        context: &ToolLoopContext<'_>,
        call: &ModelToolCall,
        cancel: watch::Receiver<bool>,
    ) -> Result<Value, String> {
        let (description, tasks) = native_workflows::parse(call)?;
        let workflow_id = next_id("workflow");
        let mut workflow = native_workflows::started(&workflow_id, &description, &tasks, now_ms());
        workflow["sessionId"] = json!(context.session_id);
        {
            let mut state = self
                .state
                .lock()
                .map_err(|_| "Rust 运行时状态锁已损坏".to_string())?;
            state.workflows.insert(0, workflow);
            state.workflows.truncate(20);
            self.persist(&state)?;
            emit(
                context.app,
                frame("workflows_list", json!({"workflows":state.workflows})),
            )?;
        }
        let system = native_context::system_prompt(context.workspace, "zh-CN", "concise", &[]);
        let mut join_set = tokio::task::JoinSet::new();
        for task in &tasks {
            let client = self.http.clone();
            let model = context.model.clone();
            let api_key = context.api_key.to_string();
            let agent_id = task.agent_id.clone();
            let prompt = task.prompt.clone();
            let system = format!("{system}\n\nYou are a read-only delegated analyst. Do not claim to run tools or modify files. Return concise evidence and recommendations to the parent agent.");
            let cancel = cancel.clone();
            join_set.spawn(async move {
                let messages = vec![
                    ModelMessage {
                        role: "system".into(),
                        text: system,
                    },
                    ModelMessage {
                        role: "user".into(),
                        text: prompt,
                    },
                ];
                let result =
                    match stream_complete(&client, &model, &api_key, &messages, &[], cancel, |_| {
                        Ok(())
                    })
                    .await
                    {
                        Ok(StreamCompletion::Completed(value)) => Ok((
                            value.text.chars().take(20_000).collect(),
                            value.input_tokens,
                            value.output_tokens,
                        )),
                        Ok(StreamCompletion::Cancelled(_)) => Err("子 Agent 已取消".into()),
                        Err(message) => Err(message),
                    };
                (agent_id, result)
            });
        }
        let mut results = Vec::new();
        while let Some(joined) = join_set.join_next().await {
            results.push(joined.map_err(|error| format!("子 Agent 任务异常结束: {error}"))?);
        }
        let finished = {
            let mut state = self
                .state
                .lock()
                .map_err(|_| "Rust 运行时状态锁已损坏".to_string())?;
            let workflow = state
                .workflows
                .iter_mut()
                .find(|value| value["id"] == workflow_id)
                .ok_or_else(|| "Workflow 状态丢失".to_string())?;
            native_workflows::finish(workflow, &results, now_ms());
            let finished = workflow.clone();
            let usage = state
                .model_usage
                .entry(context.model.id.clone())
                .or_default();
            usage.requests += results.len() as u64;
            for (_, result) in &results {
                if let Ok((_, input, output)) = result {
                    usage.input_tokens += input;
                    usage.output_tokens += output;
                }
            }
            self.persist(&state)?;
            emit(
                context.app,
                frame("workflows_list", json!({"workflows":state.workflows})),
            )?;
            finished
        };
        Ok(
            json!({"workflowId":workflow_id,"workflow":finished,"results":results.iter().map(|(id,result)| match result {
            Ok((text,_,_))=>json!({"agentId":id,"ok":true,"text":text}),Err(message)=>json!({"agentId":id,"ok":false,"error":message})
        }).collect::<Vec<_>>() }),
        )
    }

    async fn run_model_tool_loop(
        &self,
        context: ToolLoopContext<'_>,
        mut messages: Vec<ModelMessage>,
        cancel: watch::Receiver<bool>,
    ) -> Result<StreamCompletion, String> {
        let mcp_configs = self
            .state
            .lock()
            .map_err(|_| "Rust 运行时状态锁已损坏".to_string())?
            .mcp_servers
            .clone();
        let mcp_catalog = native_mcp::discover(&mcp_configs, self.credentials.as_ref()).await;
        emit(
            context.app,
            frame(
                "mcp_servers",
                json!({ "servers": mcp_catalog.public_servers(&mcp_configs) }),
            ),
        )?;
        let mut tools = native_agent_tools::definitions();
        tools.extend(native_checkpoints::definitions());
        tools.extend(native_knowledge::definitions());
        tools.extend(native_schedule::definitions());
        tools.extend(native_todos::definitions());
        tools.extend(native_skills::definitions());
        tools.extend(native_workflows::definitions());
        tools.extend(mcp_catalog.definitions.clone());
        if !mcp_catalog.notices.is_empty() {
            messages.push(ModelMessage {
                role: "system".into(),
                text: format!("[Native MCP status]\n{}", mcp_catalog.notices.join("\n")),
            });
        }
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
                let is_mcp = mcp_catalog.contains(&call.name);
                let is_checkpoint = native_checkpoints::contains(&call.name);
                let is_knowledge = native_knowledge::contains(&call.name);
                let is_schedule = call.name == "local_schedule";
                let is_todo = call.name == "todo_write";
                let is_skill = native_skills::contains(&call.name);
                let is_workflow = native_workflows::contains(&call.name);
                let approved = if risk == Some(native_agent_tools::ToolRisk::Write)
                    || is_mcp
                    || native_checkpoints::is_write(&call.name)
                    || native_knowledge::is_write(&call.name)
                    || native_schedule::is_write(call)
                    || is_todo
                    || is_workflow
                {
                    let mut confirmation_call = call.clone();
                    if call.name == "restore_file_checkpoint" {
                        if let Some(checkpoint_id) = call
                            .arguments
                            .get("checkpointId")
                            .and_then(Value::as_str)
                        {
                            if let Ok(checkpoint) = native_checkpoints::describe(
                                &self.checkpoint_root,
                                context.workspace,
                                checkpoint_id,
                            ) {
                                confirmation_call.arguments["path"] =
                                    checkpoint.get("path").cloned().unwrap_or(Value::Null);
                            }
                        }
                    }
                    self.await_tool_confirmation(
                        context.app,
                        context.session_id,
                        context.message_id,
                        &confirmation_call,
                        cancel.clone(),
                    )
                    .await?
                } else {
                    risk.is_some()
                        || is_checkpoint
                        || is_knowledge
                        || is_schedule
                        || is_todo
                        || is_skill
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
                let mut checkpoint_id = None;
                let checkpoint_error = if approved {
                    native_agent_tools::mutation_target(call).and_then(|relative_path| {
                        match native_checkpoints::capture(
                            &self.checkpoint_root,
                            context.workspace,
                            context.session_id,
                            &call.name,
                            relative_path,
                        ) {
                            Ok(id) => {
                                checkpoint_id = Some(id);
                                None
                            }
                            Err(error) => {
                                Some(format!("无法在写入前创建安全恢复点，操作已停止: {error}"))
                            }
                        }
                    })
                } else {
                    None
                };
                let mut result = if let Some(error) = checkpoint_error {
                    Err(error)
                } else if approved && is_mcp {
                    mcp_catalog
                        .execute(call, self.credentials.as_ref(), cancel.clone())
                        .await
                } else if approved && is_checkpoint {
                    native_checkpoints::execute(
                        &self.checkpoint_root,
                        context.workspace,
                        context.session_id,
                        call,
                    )
                } else if approved && is_knowledge {
                    native_knowledge::execute(&self.knowledge_path, call)
                } else if approved && is_schedule {
                    native_schedule::execute(&self.schedule_path, call)
                } else if approved && is_todo {
                    native_todos::parse(call).and_then(|todos| {
                        let mut state = self
                            .state
                            .lock()
                            .map_err(|_| "Rust 运行时状态锁已损坏".to_string())?;
                        state.todos = todos;
                        self.persist(&state)?;
                        Ok(json!({"todos":state.todos}))
                    })
                } else if approved && is_skill {
                    native_skills::execute(context.workspace, call)
                } else if approved && is_workflow {
                    self.execute_workflow(&context, call, cancel.clone()).await
                } else if approved && call.name == "browser_snapshot" {
                    platform_webview::platform_webview_snapshot(context.app).await
                } else if approved && call.name == "browser_action" {
                    let action = call
                        .arguments
                        .get("action")
                        .and_then(Value::as_str)
                        .unwrap_or("");
                    let index = call
                        .arguments
                        .get("index")
                        .and_then(Value::as_u64)
                        .and_then(|value| usize::try_from(value).ok())
                        .unwrap_or(usize::MAX);
                    platform_webview::platform_webview_action(context.app, action, index).await
                } else if approved {
                    native_agent_tools::execute_model(call, context.workspace, cancel.clone()).await
                } else {
                    Err("用户拒绝或取消了工具操作".into())
                };
                if call.name == "open_browser" {
                    if let Ok(payload) = &result {
                        if let Err(error) = context.app.emit("desktop://open-platform", payload) {
                            result = Err(format!("无法打开右侧浏览器: {error}"));
                        }
                    }
                }
                if let Some(id) = checkpoint_id.as_deref() {
                    if result.is_ok() {
                        match native_checkpoints::finalize(
                            &self.checkpoint_root,
                            context.workspace,
                            id,
                        ) {
                            Ok(()) => {
                                if let Ok(Value::Object(payload)) = &mut result {
                                    payload.insert("checkpointId".into(), Value::String(id.into()));
                                    payload.insert("recoveryAvailable".into(), Value::Bool(true));
                                }
                            }
                            Err(error) => {
                                native_checkpoints::discard(&self.checkpoint_root, id);
                                if let Ok(Value::Object(payload)) = &mut result {
                                    payload.insert("recoveryAvailable".into(), Value::Bool(false));
                                    payload.insert(
                                        "checkpointWarning".into(),
                                        Value::String(error.chars().take(240).collect()),
                                    );
                                }
                            }
                        }
                    } else {
                        native_checkpoints::discard(&self.checkpoint_root, id);
                    }
                }
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

    pub async fn run_slash_command(&self, app: &AppHandle, request: &Value) -> Result<(), String> {
        let payload = request
            .get("payload")
            .ok_or_else(|| "斜杠命令缺少 payload".to_string())?;
        let session_id = payload
            .get("sessionId")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        let name = payload
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_ascii_lowercase();
        let args = payload
            .get("args")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string();
        if !self
            .state
            .lock()
            .map_err(|_| "Rust 运行时状态锁已损坏".to_string())?
            .sessions
            .iter()
            .any(|session| session.session_id == session_id)
        {
            return emit(
                app,
                error_frame(Some(&session_id), "no_session", "会话不存在"),
            );
        }
        let response = match name.as_str() {
            "about" => {
                let state = self
                    .state
                    .lock()
                    .map_err(|_| "Rust 运行时状态锁已损坏".to_string())?;
                (true, format!(
                    "### 关于 ClawMaster\n\n- 本地引擎：Rust native\n- 协议版本：1\n- 会话数：{}\n- Node sidecar：未启用",
                    state.sessions.len()
                ))
            }
            "doctor" => (
                true,
                format!(
                    "```json\n{}\n```",
                    serde_json::to_string_pretty(&native_diagnostics::doctor_report())
                        .unwrap_or_default()
                ),
            ),
            "memory" => {
                let workspace = {
                    let state = self
                        .state
                        .lock()
                        .map_err(|_| "Rust 运行时状态锁已损坏".to_string())?;
                    Self::workspace_for_session(&state, Some(&session_id))
                };
                match native_memory::snapshot(&workspace) {
                    Ok(value) => (
                        true,
                        format!(
                            "```json\n{}\n```",
                            serde_json::to_string_pretty(&value).unwrap_or_default()
                        ),
                    ),
                    Err(message) => (false, message),
                }
            }
            "skills" => {
                let workspace = {
                    let state = self
                        .state
                        .lock()
                        .map_err(|_| "Rust 运行时状态锁已损坏".to_string())?;
                    Self::workspace_for_session(&state, Some(&session_id))
                };
                match native_skills::list(&workspace) {
                    Ok(values) if values.is_empty() => (true, "未安装 Skill。".into()),
                    Ok(values) => (
                        true,
                        values
                            .iter()
                            .filter_map(|value| {
                                Some(format!(
                                    "- `{}` - {}",
                                    value.get("id")?.as_str()?,
                                    value.get("description")?.as_str()?
                                ))
                            })
                            .collect::<Vec<_>>()
                            .join("\n"),
                    ),
                    Err(message) => (false, message),
                }
            }
            "extensions" => {
                let workspace = {
                    let state = self
                        .state
                        .lock()
                        .map_err(|_| "Rust 运行时状态锁已损坏".to_string())?;
                    Self::workspace_for_session(&state, Some(&session_id))
                };
                match native_context::extensions(&workspace) {
                    Ok(values) if values.is_empty() => (true, "未安装扩展。".into()),
                    Ok(values) => (
                        true,
                        values
                            .iter()
                            .filter_map(|value| {
                                Some(format!(
                                    "- **{}** v{} - `{}`",
                                    value.get("name")?.as_str()?,
                                    value.get("version")?.as_str()?,
                                    value.get("path")?.as_str()?
                                ))
                            })
                            .collect::<Vec<_>>()
                            .join("\n"),
                    ),
                    Err(message) => (false, message),
                }
            }
            "context" | "tools" | "mcp" => {
                let request_type = match name.as_str() {
                    "context" => "get_context_breakdown",
                    "tools" => "get_tools",
                    _ => "mcp_list",
                };
                let values = self
                    .handle_async(&json!({"type":request_type,"payload":{"sessionId":session_id}}))
                    .await?;
                let value = values.first().cloned().unwrap_or(Value::Null);
                if value.get("type").and_then(Value::as_str) == Some("error") {
                    (
                        false,
                        value
                            .pointer("/payload/message")
                            .and_then(Value::as_str)
                            .unwrap_or("命令失败")
                            .into(),
                    )
                } else {
                    (
                        true,
                        format!(
                            "```json\n{}\n```",
                            serde_json::to_string_pretty(&value["payload"]).unwrap_or_default()
                        ),
                    )
                }
            }
            "compress" => {
                let values = self
                    .compress_context(&json!({"sessionId":session_id}))
                    .await?;
                let value = values.first().cloned().unwrap_or(Value::Null);
                let ok = value.get("type").and_then(Value::as_str) != Some("error");
                let markdown = value
                    .pointer("/payload/message")
                    .and_then(Value::as_str)
                    .unwrap_or("压缩未返回结果")
                    .to_string();
                (ok, markdown)
            }
            "restore" => {
                let workspace = {
                    let state = self
                        .state
                        .lock()
                        .map_err(|_| "Rust 运行时状态锁已损坏".to_string())?;
                    Self::workspace_for_session(&state, Some(&session_id))
                };
                if args.trim().is_empty() {
                    match native_checkpoints::list(&self.checkpoint_root, &workspace) {
                        Ok(values) if values.is_empty() => {
                            (true, "当前项目还没有可用的文件恢复点。".into())
                        }
                        Ok(values) => {
                            let markdown = values
                                .iter()
                                .filter(|value| {
                                    value.get("ready").and_then(Value::as_bool) == Some(true)
                                })
                                .filter_map(|value| {
                                    Some(format!(
                                        "- `{}` · `{}` · {}",
                                        value.get("id")?.as_str()?,
                                        value.get("path")?.as_str()?,
                                        value.get("toolName")?.as_str()?
                                    ))
                                })
                                .collect::<Vec<_>>()
                                .join("\n");
                            if markdown.is_empty() {
                                (true, "当前项目还没有已完成的文件恢复点。".into())
                            } else {
                                (
                                    true,
                                    format!(
                                        "### 文件恢复点\n\n{markdown}\n\n输入 `/restore <恢复点ID>` 后仍需在确认卡片中批准。"
                                    ),
                                )
                            }
                        }
                        Err(message) => (false, message),
                    }
                } else {
                    let checkpoint_id = args.trim();
                    let checkpoint = match native_checkpoints::describe(
                        &self.checkpoint_root,
                        &workspace,
                        checkpoint_id,
                    ) {
                        Ok(checkpoint) => checkpoint,
                        Err(message) => {
                            emit(
                                app,
                                frame(
                                    "slash_command_result",
                                    json!({
                                        "sessionId":session_id,"name":name,"args":args,
                                        "ok":false,"markdown":message
                                    }),
                                ),
                            )?;
                            return Ok(());
                        }
                    };
                    let call = ModelToolCall {
                        id: next_id("restore"),
                        name: "restore_file_checkpoint".into(),
                        arguments: json!({
                            "checkpointId":checkpoint_id,
                            "path":checkpoint.get("path").cloned().unwrap_or(Value::Null)
                        }),
                    };
                    let message_id = next_id("restore-message");
                    let (_cancel_tx, cancel) = watch::channel(false);
                    self.audit_tool(&session_id, &call, "requested", None)?;
                    let approved = self
                        .await_tool_confirmation(app, &session_id, &message_id, &call, cancel)
                        .await?;
                    let result = if approved {
                        native_checkpoints::execute(
                            &self.checkpoint_root,
                            &workspace,
                            &session_id,
                            &call,
                        )
                    } else {
                        Err("用户拒绝或取消了文件恢复".into())
                    };
                    self.audit_tool(
                        &session_id,
                        &call,
                        if result.is_ok() {
                            "completed"
                        } else if approved {
                            "failed"
                        } else {
                            "rejected"
                        },
                        result.as_ref().err().map(String::as_str),
                    )?;
                    match result {
                        Ok(value) => {
                            let checkpoints = native_checkpoints::list(
                                &self.checkpoint_root,
                                &workspace,
                            )?;
                            emit(
                                app,
                                frame(
                                    "file_checkpoints",
                                    json!({"sessionId":session_id,"checkpoints":checkpoints}),
                                ),
                            )?;
                            let path = value
                                .get("path")
                                .and_then(Value::as_str)
                                .unwrap_or("文件");
                            if let Some(warning) = value.get("warning").and_then(Value::as_str) {
                                (true, format!("已恢复 `{path}`。\n\n**警告：** {warning}"))
                            } else {
                                (
                                    true,
                                    format!(
                                        "已恢复 `{path}`，并创建撤销恢复点 `{}`。",
                                        value
                                            .get("safetyCheckpointId")
                                            .and_then(Value::as_str)
                                            .unwrap_or("unknown")
                                    ),
                                )
                            }
                        }
                        Err(message) => (false, message),
                    }
                }
            }
            "init" => {
                let workspace = {
                    let state = self
                        .state
                        .lock()
                        .map_err(|_| "Rust 运行时状态锁已损坏".to_string())?;
                    Self::workspace_for_session(&state, Some(&session_id))
                };
                if workspace.join("CLAWMASTER.md").exists() || workspace.join("OTTO.md").exists() {
                    (true, "项目记忆文件已存在，未覆盖。".into())
                } else {
                    let markdown = format!(
                        "已提交项目分析任务，将在 `{}` 生成 CLAWMASTER.md。",
                        workspace.display()
                    );
                    emit(
                        app,
                        frame(
                            "slash_command_result",
                            json!({
                                "sessionId":session_id,"name":name,"args":args,"ok":true,"markdown":markdown
                            }),
                        ),
                    )?;
                    return self.run_turn(app, &json!({
                        "type":"send_user_message","payload":{"sessionId":session_id,"source":"local","content":[{
                            "type":"text","value":"分析当前项目结构、构建、测试和关键约束，并使用 write_file 在工作区根目录创建 CLAWMASTER.md。内容必须简洁、可验证，不得复制密钥或隐私数据。"
                        }]}
                    })).await;
                }
            }
            _ => (
                false,
                format!("未知命令 `/{name}`。输入 `/` 查看 Rust 原生可用命令。"),
            ),
        };
        emit(
            app,
            frame(
                "slash_command_result",
                json!({
                    "sessionId":session_id,"name":name,"args":args,"ok":response.0,"markdown":response.1
                }),
            ),
        )
    }

    pub async fn run_turn(&self, app: &AppHandle, request: &Value) -> Result<(), String> {
        self.run_turn_result(app, request).await.map(drop)
    }

    async fn run_turn_result(
        &self,
        app: &AppHandle,
        request: &Value,
    ) -> Result<Option<String>, String> {
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
            state
                .model_usage
                .entry(model.id.clone())
                .or_default()
                .requests += 1;
            let timestamp = now_ms();
            let inferred_session = if state.sessions[session_index].workspace_path.is_none() {
                let known_projects = state
                    .sessions
                    .iter()
                    .filter_map(|session| session.workspace_path.as_ref().map(PathBuf::from))
                    .collect::<Vec<_>>();
                native_projects::infer_from_known_projects(&content, &known_projects).map(|workspace| {
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
            let mut history = state
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
            native_context::prepend_system_message(
                &mut history,
                native_context::system_prompt(
                    &Self::workspace_for_session(&state, Some(&session_id)),
                    &state.settings.preferred_language,
                    &state.settings.agent_style,
                    &native_skills::list(&Self::workspace_for_session(&state, Some(&session_id)))
                        .unwrap_or_default(),
                ),
            );
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
                let reply = completion.text.clone();
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
                    let usage = state.model_usage.entry(model.id.clone()).or_default();
                    usage.input_tokens += completion.input_tokens;
                    usage.output_tokens += completion.output_tokens;
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
                )?;
                Ok(Some(reply))
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
                    let usage = state.model_usage.entry(model.id.clone()).or_default();
                    usage.input_tokens += completion.input_tokens;
                    usage.output_tokens += completion.output_tokens;
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
                )?;
                Ok(None)
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
                )?;
                Ok(None)
            }
        }
    }
}

pub(crate) fn text_content(content: &Value) -> String {
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
    fn reuses_a_persisted_session_for_each_channel_chat() {
        let (_root, runtime) = runtime();
        let first = runtime
            .channel_session("feishu", "oc_chat_1")
            .expect("first channel session");
        let repeated = runtime
            .channel_session("feishu", "oc_chat_1")
            .expect("repeated channel session");
        let other = runtime
            .channel_session("feishu", "oc_chat_2")
            .expect("other channel session");

        assert_eq!(first, repeated);
        assert_ne!(first, other);
        let sessions = runtime
            .handle(&json!({"type":"list_sessions","payload":{}}))
            .expect("list sessions");
        assert_eq!(
            sessions[0]["payload"]["sessions"].as_array().unwrap().len(),
            2
        );
        runtime
            .state
            .lock()
            .unwrap()
            .messages
            .entry(first)
            .or_default()
            .push(StoredMessage {
                id: "om_persisted".into(),
                session_id: repeated,
                role: "user".into(),
                content: json!([{"type":"text","value":"hello"}]),
                timestamp: 1,
                source: "feishu".into(),
            });
        assert!(runtime
            .has_channel_message("feishu", "om_persisted")
            .unwrap());
        assert!(!runtime.has_channel_message("lark", "om_persisted").unwrap());
    }

    #[test]
    fn cancellation_targets_only_the_requested_channel_provider() {
        let (_root, runtime) = runtime();
        let feishu = runtime.channel_session("feishu", "chat-1").unwrap();
        let lark = runtime.channel_session("lark", "chat-2").unwrap();
        let (feishu_tx, feishu_rx) = watch::channel(false);
        let (lark_tx, lark_rx) = watch::channel(false);
        runtime.active_turns.lock().unwrap().insert(
            feishu,
            ActiveTurn {
                turn_id: "turn-feishu".into(),
                cancel: feishu_tx,
            },
        );
        runtime.active_turns.lock().unwrap().insert(
            lark,
            ActiveTurn {
                turn_id: "turn-lark".into(),
                cancel: lark_tx,
            },
        );

        runtime
            .cancel_channel_turns("feishu")
            .expect("cancel Feishu");

        assert!(*feishu_rx.borrow());
        assert!(!*lark_rx.borrow());
    }

    #[tokio::test]
    async fn compression_keeps_small_histories_without_contacting_the_model() {
        let (_root, runtime) = runtime();
        runtime
            .handle(&json!({"type":"save_custom_model","payload":{
                "provider":"openai","baseUrl":"https://example.invalid/v1",
                "modelId":"test","apiKey":"secret","makeActive":true
            }}))
            .unwrap();
        let created = runtime
            .handle(&json!({"type":"create_session","payload":{"title":"small"}}))
            .unwrap();
        let session_id = created[0]["payload"]["session"]["sessionId"]
            .as_str()
            .unwrap();
        let result = runtime
            .compress_context(&json!({"sessionId":session_id}))
            .await
            .unwrap();
        assert_eq!(result[0]["type"], "compress_result");
        assert_eq!(result[0]["payload"]["compressed"], false);
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
    fn stores_mcp_secrets_outside_state_and_supports_removal() {
        let (_root, runtime) = runtime();
        let added = runtime
            .handle(&json!({"type":"mcp_add","payload":{
                "name":"workspace-files", "command":"mcp-files",
                "args":["--safe"], "env":{"MCP_TOKEN":"secret-value"},
                "headers":{"Authorization":"Bearer secret-value"}
            }}))
            .expect("add mcp");
        assert_eq!(added[0]["type"], "mcp_servers");
        assert_eq!(added[0]["payload"]["servers"][0]["status"], "disconnected");
        let persisted = fs::read_to_string(&runtime.state_path).expect("state file");
        assert!(!persisted.contains("secret-value"));
        assert!(!persisted.contains("MCP_TOKEN"));
        assert!(persisted.contains("mcp-credential"));

        let removed = runtime
            .handle(&json!({"type":"mcp_remove","payload":{"name":"workspace-files"}}))
            .expect("remove mcp");
        assert_eq!(removed[0]["payload"]["servers"], json!([]));
    }

    #[test]
    fn knowledge_frames_share_the_native_jsonl_store() {
        let (_root, runtime) = runtime();
        let added = runtime
            .handle(&json!({"type":"add_knowledge","payload":{
                "content":"Rust knowledge", "category":"runtime", "tags":["native"]
            }}))
            .expect("add knowledge");
        let id = added[0]["payload"]["entry"]["id"]
            .as_str()
            .unwrap()
            .to_string();
        let found = runtime
            .handle(&json!({"type":"search_knowledge","payload":{"query":"Rust"}}))
            .expect("search knowledge");
        assert_eq!(found[0]["payload"]["entries"][0]["id"], id);
        let removed = runtime
            .handle(&json!({"type":"remove_knowledge","payload":{"id":id}}))
            .expect("remove knowledge");
        assert_eq!(removed[0]["type"], "knowledge_removed");
    }

    #[test]
    fn schedule_frames_share_the_native_schedule_store() {
        let (_root, runtime) = runtime();
        let created = runtime
            .handle(&json!({"type":"create_schedule","payload":{
                "title":"Rust review", "startAt":"2026-09-05T01:00:00Z"
            }}))
            .expect("create schedule");
        let id = created[0]["payload"]["schedules"][0]["id"]
            .as_str()
            .unwrap()
            .to_string();
        let updated = runtime
            .handle(&json!({"type":"update_schedule","payload":{
                "id":id, "notes":"native"
            }}))
            .expect("update schedule");
        assert_eq!(updated[0]["payload"]["schedules"][0]["notes"], "native");
        let removed = runtime
            .handle(&json!({"type":"delete_schedule","payload":{"id":id}}))
            .expect("delete schedule");
        assert_eq!(removed[0]["payload"]["schedules"], json!([]));
    }

    #[test]
    fn todo_and_stats_frames_use_native_persisted_state_and_audit() {
        let (_root, runtime) = runtime();
        let todos = native_todos::parse(&ModelToolCall {
            id: "todo-call".into(),
            name: "todo_write".into(),
            arguments: json!({"todos":[{
                "id":"migration","content":"Finish Rust migration",
                "status":"in_progress","priority":"high"
            }]}),
        })
        .unwrap();
        {
            let mut state = runtime.state.lock().unwrap();
            state.todos = todos;
            runtime.persist(&state).unwrap();
        }
        let call = ModelToolCall {
            id: "read-call".into(),
            name: "read_file".into(),
            arguments: json!({"path":"README.md"}),
        };
        runtime
            .audit_tool("session", &call, "completed", None)
            .unwrap();
        let todo_frame = runtime
            .handle(&json!({"type":"get_todos","payload":{}}))
            .unwrap();
        assert_eq!(todo_frame[0]["payload"]["todos"][0]["id"], "migration");
        let stats = runtime
            .handle(&json!({"type":"get_stats","payload":{}}))
            .unwrap();
        assert_eq!(stats[0]["payload"]["tools"]["totalCalls"], 1);
        assert_eq!(stats[0]["payload"]["tools"]["totalSuccess"], 1);
    }

    #[test]
    fn restores_runtime_state_from_an_interrupted_commit_backup() {
        let (root, runtime) = runtime();
        runtime
            .handle(&json!({"type":"create_session","payload":{"title":"recover"}}))
            .unwrap();
        let state_path = runtime.state_path.clone();
        drop(runtime);
        fs::rename(&state_path, state_path.with_extension("json.bak")).unwrap();
        let restored = NativeRuntime::load_with_credentials(
            root.path(),
            Arc::new(MemoryCredentials::default()),
        )
        .unwrap();
        let sessions = restored
            .handle(&json!({"type":"list_sessions","payload":{}}))
            .unwrap();
        assert_eq!(sessions[0]["payload"]["sessions"][0]["title"], "recover");
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
        assert!(fs::read_to_string(root.path().join("CLAWMASTER.md"))
            .unwrap()
            .contains("保持 Rust 单一路径"));
        let tools = runtime
            .handle(&json!({"type":"get_tools","payload":{"sessionId":session_id}}))
            .unwrap();
        assert_eq!(tools[0]["type"], "tools_list");
        assert!(!tools[0]["payload"]["tools"].as_array().unwrap().is_empty());
    }

    #[test]
    fn exposes_rust_file_recovery_in_tools_and_slash_commands() {
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
        let tools = runtime
            .handle(&json!({"type":"get_tools","payload":{"sessionId":session_id}}))
            .unwrap();
        let names = tools[0]["payload"]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|tool| tool.get("name").and_then(Value::as_str))
            .collect::<Vec<_>>();
        assert!(names.contains(&"list_file_checkpoints"));
        assert!(names.contains(&"restore_file_checkpoint"));

        let commands = runtime
            .handle(&json!({"type":"list_slash_commands","payload":{}}))
            .unwrap();
        assert!(commands[0]["payload"]["commands"]
            .as_array()
            .unwrap()
            .iter()
            .any(|command| command.get("name").and_then(Value::as_str) == Some("restore")));

        fs::write(root.path().join("recover.txt"), "before").unwrap();
        let checkpoint_id = native_checkpoints::capture(
            &runtime.checkpoint_root,
            root.path(),
            session_id,
            "write_file",
            "recover.txt",
        )
        .unwrap();
        fs::write(root.path().join("recover.txt"), "after").unwrap();
        native_checkpoints::finalize(&runtime.checkpoint_root, root.path(), &checkpoint_id)
            .unwrap();
        let checkpoints = runtime
            .handle(&json!({"type":"get_file_checkpoints","payload":{"sessionId":session_id}}))
            .unwrap();
        assert_eq!(checkpoints[0]["type"], "file_checkpoints");
        assert_eq!(checkpoints[0]["payload"]["checkpoints"][0]["path"], "recover.txt");
        let missing = runtime
            .handle(&json!({"type":"get_file_checkpoints","payload":{"sessionId":"missing"}}))
            .unwrap();
        assert_eq!(missing[0]["payload"]["code"], "no_session");
    }

    #[test]
    fn confirms_and_persists_a_native_auto_skill() {
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
        for index in 0..3 {
            runtime
                .audit_tool(
                    session_id,
                    &ModelToolCall {
                        id: format!("call-{index}"),
                        name: "search_text".into(),
                        arguments: json!({"query":format!("private-{index}")}),
                    },
                    "completed",
                    None,
                )
                .unwrap();
        }
        let pending = runtime
            .handle(&json!({"type":"scan_pending_auto_skills","payload":{}}))
            .unwrap();
        let candidate_id = pending[0]["payload"]["candidates"][0]["id"]
            .as_str()
            .unwrap();
        let confirmed = runtime
            .handle(&json!({"type":"confirm_pending_auto_skill","payload":{
                "candidateId":candidate_id,"sessionId":session_id
            }}))
            .unwrap();
        assert_eq!(confirmed[0]["payload"]["lastAction"]["kind"], "confirmed");
        assert_eq!(confirmed[1]["type"], "skills_list");
        assert!(root
            .path()
            .join(".clawmaster/skills/auto-search-text/SKILL.md")
            .is_file());
        let persisted = fs::read_to_string(&runtime.state_path).unwrap();
        assert!(persisted.contains(candidate_id));
        assert!(!persisted.contains("private-"));
    }

    #[test]
    fn rejected_native_auto_skill_stays_suppressed_after_restart() {
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
        for index in 0..3 {
            runtime
                .audit_tool(
                    session_id,
                    &ModelToolCall {
                        id: format!("call-{index}"),
                        name: "list_directory".into(),
                        arguments: json!({"path":"."}),
                    },
                    "completed",
                    None,
                )
                .unwrap();
        }
        let pending = runtime
            .handle(&json!({"type":"get_pending_auto_skills","payload":{}}))
            .unwrap();
        let candidate_id = pending[0]["payload"]["candidates"][0]["id"]
            .as_str()
            .unwrap()
            .to_string();
        runtime
            .handle(&json!({"type":"reject_pending_auto_skill","payload":{
                "candidateId":candidate_id
            }}))
            .unwrap();
        drop(runtime);

        let restored = NativeRuntime::load_with_credentials(
            root.path(),
            Arc::new(MemoryCredentials::default()),
        )
        .unwrap();
        let pending = restored
            .handle(&json!({"type":"get_pending_auto_skills","payload":{}}))
            .unwrap();
        assert!(pending[0]["payload"]["candidates"]
            .as_array()
            .unwrap()
            .is_empty());
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
