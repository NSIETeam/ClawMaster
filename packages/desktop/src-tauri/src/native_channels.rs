use crate::native_models::{system_credential_store, CredentialStore};
use lark_channel::lark_openapi::{
    TokioTungsteniteWebSocketTransport, WebSocketClientConfig, WebSocketConnection,
    WebSocketEndpoint, WebSocketEventAck,
};
use lark_channel::{Error as LarkError, EventLoop, EventLoopOptions, EventStreamConnector};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tokio::task::JoinHandle;

const MAX_ID_CHARS: usize = 200;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelConfig {
    provider: String,
    app_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    agent_id: Option<String>,
    verified_at: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveRequest {
    provider: String,
    app_id: String,
    app_secret: String,
    agent_id: Option<String>,
}

pub struct NativeChannelState {
    path: PathBuf,
    configs: Mutex<HashMap<String, ChannelConfig>>,
    credentials: Arc<dyn CredentialStore>,
    http: Client,
    statuses: Arc<Mutex<HashMap<String, ChannelStatus>>>,
    tasks: Mutex<HashMap<String, JoinHandle<()>>>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelStatus {
    provider: String,
    state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    last_error: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    last_event_at: Option<String>,
}

impl ChannelStatus {
    fn new(provider: &str, state: &str) -> Self {
        Self {
            provider: provider.to_string(),
            state: state.to_string(),
            last_error: None,
            last_event_at: None,
        }
    }
}

struct FeishuConnector {
    http: Client,
    provider: String,
    app_id: String,
    app_secret: String,
    statuses: Arc<Mutex<HashMap<String, ChannelStatus>>>,
    client_config: Option<WebSocketClientConfig>,
}

fn set_channel_status(
    statuses: &Arc<Mutex<HashMap<String, ChannelStatus>>>,
    status: ChannelStatus,
) {
    if let Ok(mut values) = statuses.lock() {
        values.insert(status.provider.clone(), status);
    }
}

impl EventStreamConnector for FeishuConnector {
    type Connection = WebSocketConnection;

    async fn connect_event_stream(&mut self) -> lark_channel::Result<Self::Connection> {
        set_channel_status(
            &self.statuses,
            ChannelStatus::new(&self.provider, "connecting"),
        );
        let endpoint =
            feishu_websocket_endpoint(&self.http, &self.provider, &self.app_id, &self.app_secret)
                .await
                .map_err(LarkError::Transport)?;
        self.client_config = endpoint.client_config().copied();
        let connection = TokioTungsteniteWebSocketTransport::new()
            .connect(&endpoint)
            .await?;
        set_channel_status(
            &self.statuses,
            ChannelStatus::new(&self.provider, "connected"),
        );
        Ok(connection)
    }

    fn websocket_client_config(&self) -> Option<WebSocketClientConfig> {
        self.client_config
    }
}

fn validate_provider(value: &str) -> Result<&str, String> {
    match value.trim() {
        "feishu" | "lark" | "wecom" | "dingtalk" => Ok(value.trim()),
        _ => Err("不支持的企业消息平台".into()),
    }
}

fn clean(value: &str, field: &str) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty()
        || value.chars().count() > MAX_ID_CHARS
        || value.chars().any(char::is_control)
    {
        Err(format!("{field}为空、过长或包含控制字符"))
    } else {
        Ok(value.to_string())
    }
}

fn clean_message(value: &str) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty() || value.chars().count() > 4000 || value.chars().any(|c| c == '\0') {
        Err("消息内容为空、超过 4000 字符或包含空字符".into())
    } else {
        Ok(value.to_string())
    }
}

fn secret_id(provider: &str) -> String {
    format!("native-channel-{provider}-app-secret")
}

fn parse_token(provider: &str, body: &Value) -> Result<String, String> {
    let token = match provider {
        "feishu" | "lark" => body.get("tenant_access_token"),
        "wecom" => body.get("access_token"),
        "dingtalk" => body.get("accessToken"),
        _ => None,
    }
    .and_then(Value::as_str)
    .unwrap_or("");
    if !token.is_empty() {
        return Ok(token.to_string());
    }
    let detail = body
        .get("msg")
        .or_else(|| body.get("errmsg"))
        .or_else(|| body.get("message"))
        .and_then(Value::as_str)
        .unwrap_or("平台未返回 access token");
    Err(format!("凭据验证失败：{detail}"))
}

async fn access_token(
    http: &Client,
    provider: &str,
    app_id: &str,
    app_secret: &str,
) -> Result<String, String> {
    let response = match provider {
        "feishu" | "lark" => {
            let host = if provider == "lark" {
                "https://open.larksuite.com"
            } else {
                "https://open.feishu.cn"
            };
            http.post(format!(
                "{host}/open-apis/auth/v3/tenant_access_token/internal"
            ))
            .json(&json!({"app_id":app_id,"app_secret":app_secret}))
            .send()
            .await
        }
        "wecom" => {
            let mut endpoint = url::Url::parse("https://qyapi.weixin.qq.com/cgi-bin/gettoken")
                .map_err(|error| format!("企业微信鉴权地址无效: {error}"))?;
            endpoint
                .query_pairs_mut()
                .append_pair("corpid", app_id)
                .append_pair("corpsecret", app_secret);
            http.get(endpoint).send().await
        }
        "dingtalk" => {
            http.post("https://api.dingtalk.com/v1.0/oauth2/accessToken")
                .json(&json!({"appKey":app_id,"appSecret":app_secret}))
                .send()
                .await
        }
        _ => return Err("不支持的企业消息平台".into()),
    }
    .map_err(|error| format!("连接平台失败: {error}"))?;
    let status = response.status();
    let body: Value = response
        .json()
        .await
        .map_err(|error| format!("平台响应无效: {error}"))?;
    if !status.is_success() {
        return Err(format!("平台返回 HTTP {status}"));
    }
    parse_token(provider, &body)
}

fn platform_result(body: &Value) -> Result<(), String> {
    let failed_code = body
        .get("code")
        .or_else(|| body.get("errcode"))
        .and_then(Value::as_i64)
        .is_some_and(|code| code != 0);
    if !failed_code {
        return Ok(());
    }
    let message = body
        .get("msg")
        .or_else(|| body.get("errmsg"))
        .or_else(|| body.get("message"))
        .and_then(Value::as_str)
        .unwrap_or("平台拒绝发送消息");
    Err(format!("消息发送失败：{message}"))
}

fn parse_feishu_endpoint(body: &Value) -> Result<WebSocketEndpoint, String> {
    let code = body.get("code").and_then(Value::as_i64).unwrap_or(-1);
    if code != 0 {
        let message = body
            .get("msg")
            .and_then(Value::as_str)
            .unwrap_or("平台未返回错误说明");
        return Err(format!("飞书长连接端点获取失败：{message}"));
    }
    let url = body
        .pointer("/data/URL")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "飞书长连接端点响应缺少 URL".to_string())?;
    let client_config = body
        .pointer("/data/ClientConfig")
        .cloned()
        .map(serde_json::from_value::<WebSocketClientConfig>)
        .transpose()
        .map_err(|error| format!("飞书长连接配置无效: {error}"))?;
    let url = url::Url::parse(url).map_err(|error| format!("飞书长连接端点无效: {error}"))?;
    WebSocketEndpoint::new(url, client_config)
        .map_err(|error| format!("飞书长连接端点无效: {error}"))
}

async fn feishu_websocket_endpoint(
    http: &Client,
    provider: &str,
    app_id: &str,
    app_secret: &str,
) -> Result<WebSocketEndpoint, String> {
    let host = if provider == "lark" {
        "https://open.larksuite.com"
    } else {
        "https://open.feishu.cn"
    };
    let response = http
        .post(format!("{host}/callback/ws/endpoint"))
        .header("locale", "zh")
        .json(&json!({"AppID": app_id, "AppSecret": app_secret}))
        .send()
        .await
        .map_err(|error| format!("连接飞书长连接服务失败: {error}"))?;
    let status = response.status();
    let body: Value = response
        .json()
        .await
        .map_err(|error| format!("飞书长连接端点响应无效: {error}"))?;
    if !status.is_success() {
        return Err(format!("飞书长连接服务返回 HTTP {status}"));
    }
    parse_feishu_endpoint(&body)
}

impl NativeChannelState {
    pub fn load(app_data_dir: &Path) -> Result<Self, String> {
        let path = app_data_dir.join("channels.json");
        let configs = match fs::read(&path) {
            Ok(bytes) => serde_json::from_slice(&bytes)
                .map_err(|error| format!("企业消息配置损坏: {error}"))?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => HashMap::new(),
            Err(error) => return Err(format!("无法读取企业消息配置: {error}")),
        };
        Ok(Self {
            path,
            configs: Mutex::new(configs),
            credentials: system_credential_store(),
            http: Client::builder()
                .https_only(true)
                .timeout(std::time::Duration::from_secs(15))
                .build()
                .map_err(|error| format!("无法初始化消息平台 HTTPS 客户端: {error}"))?,
            statuses: Arc::new(Mutex::new(HashMap::new())),
            tasks: Mutex::new(HashMap::new()),
        })
    }

    fn persist(&self, configs: &HashMap<String, ChannelConfig>) -> Result<(), String> {
        let bytes = serde_json::to_vec_pretty(configs).map_err(|error| error.to_string())?;
        let temporary = self.path.with_extension("json.tmp");
        fs::write(&temporary, bytes).map_err(|error| format!("无法写入消息配置: {error}"))?;
        fs::rename(&temporary, &self.path).map_err(|error| format!("无法提交消息配置: {error}"))
    }

    fn start_feishu_connector(
        &self,
        config: ChannelConfig,
        app_secret: String,
    ) -> Result<(), String> {
        let provider = config.provider.clone();
        let mut tasks = self
            .tasks
            .lock()
            .map_err(|_| "企业消息任务锁不可用".to_string())?;
        if let Some(task) = tasks.remove(&provider) {
            task.abort();
        }
        let statuses = Arc::clone(&self.statuses);
        let task_statuses = Arc::clone(&statuses);
        let task_provider = provider.clone();
        let connector = FeishuConnector {
            http: self.http.clone(),
            provider: provider.clone(),
            app_id: config.app_id,
            app_secret,
            statuses: Arc::clone(&statuses),
            client_config: None,
        };
        set_channel_status(&statuses, ChannelStatus::new(&provider, "connecting"));
        let task = tokio::spawn(async move {
            let mut event_loop = EventLoop::with_options(
                connector,
                EventLoopOptions::new()
                    .with_unlimited_reconnects()
                    .with_server_reconnect_config(true),
            );
            let event_statuses = Arc::clone(&task_statuses);
            let event_provider = task_provider.clone();
            let result = event_loop
                .run(move |_event| {
                    let mut status = ChannelStatus::new(&event_provider, "connected");
                    status.last_event_at = Some(chrono::Utc::now().to_rfc3339());
                    set_channel_status(&event_statuses, status);
                    async { Ok(WebSocketEventAck::ok()) }
                })
                .await;
            let mut status = ChannelStatus::new(&task_provider, "failed");
            status.last_error = Some(match result {
                Ok(exit) => format!("飞书长连接已停止: {exit:?}"),
                Err(error) => error.to_string(),
            });
            set_channel_status(&task_statuses, status);
        });
        tasks.insert(provider, task);
        Ok(())
    }

    pub fn start_configured(&self) {
        let configs = self
            .configs
            .lock()
            .map(|values| values.values().cloned().collect::<Vec<_>>())
            .unwrap_or_default();
        for config in configs {
            if !matches!(config.provider.as_str(), "feishu" | "lark") {
                continue;
            }
            match self.credentials.get(&secret_id(&config.provider)) {
                Ok(secret) => {
                    let _ = self.start_feishu_connector(config, secret);
                }
                Err(error) => {
                    let mut status = ChannelStatus::new(&config.provider, "failed");
                    status.last_error = Some(error);
                    set_channel_status(&self.statuses, status);
                }
            }
        }
    }

    fn stop_connector(&self, provider: &str) -> Result<(), String> {
        if let Some(task) = self
            .tasks
            .lock()
            .map_err(|_| "企业消息任务锁不可用".to_string())?
            .remove(provider)
        {
            task.abort();
        }
        set_channel_status(&self.statuses, ChannelStatus::new(provider, "idle"));
        Ok(())
    }
}

#[tauri::command]
pub fn channel_config_get(
    provider: String,
    state: tauri::State<'_, NativeChannelState>,
) -> Result<Option<ChannelConfig>, String> {
    let provider = validate_provider(&provider)?;
    if state.credentials.get(&secret_id(provider)).is_err() {
        return Ok(None);
    }
    Ok(state
        .configs
        .lock()
        .map_err(|_| "企业消息配置锁不可用".to_string())?
        .get(provider)
        .cloned())
}

#[tauri::command]
pub fn channel_status_get(
    provider: String,
    state: tauri::State<'_, NativeChannelState>,
) -> Result<ChannelStatus, String> {
    let provider = validate_provider(&provider)?;
    Ok(state
        .statuses
        .lock()
        .map_err(|_| "企业消息状态锁不可用".to_string())?
        .get(provider)
        .cloned()
        .unwrap_or_else(|| ChannelStatus::new(provider, "idle")))
}

#[tauri::command]
pub async fn channel_config_save(
    input: SaveRequest,
    state: tauri::State<'_, NativeChannelState>,
) -> Result<ChannelConfig, String> {
    let provider = validate_provider(&input.provider)?.to_string();
    let app_id = clean(&input.app_id, "App ID / Corp ID")?;
    let app_secret = clean(&input.app_secret, "App Secret")?;
    let agent_id = input
        .agent_id
        .as_deref()
        .map(|value| clean(value, "Agent ID"))
        .transpose()?;
    if provider == "wecom" && agent_id.is_none() {
        return Err("企业微信需要 Agent ID".into());
    }
    access_token(&state.http, &provider, &app_id, &app_secret).await?;
    if matches!(provider.as_str(), "feishu" | "lark") {
        feishu_websocket_endpoint(&state.http, &provider, &app_id, &app_secret).await?;
    }
    state.credentials.set(&secret_id(&provider), &app_secret)?;
    let config = ChannelConfig {
        provider: provider.clone(),
        app_id,
        agent_id,
        verified_at: chrono::Utc::now().to_rfc3339(),
    };
    let mut configs = state
        .configs
        .lock()
        .map_err(|_| "企业消息配置锁不可用".to_string())?;
    configs.insert(provider, config.clone());
    state.persist(&configs)?;
    drop(configs);
    if matches!(config.provider.as_str(), "feishu" | "lark") {
        state.start_feishu_connector(config.clone(), app_secret)?;
    }
    Ok(config)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SendRequest {
    provider: String,
    target_id: String,
    text: String,
}

#[tauri::command]
pub async fn channel_send_test(
    input: SendRequest,
    state: tauri::State<'_, NativeChannelState>,
) -> Result<Value, String> {
    let provider = validate_provider(&input.provider)?.to_string();
    let target = clean(&input.target_id, "接收方 ID")?;
    let text = clean_message(&input.text)?;
    let config = state
        .configs
        .lock()
        .map_err(|_| "企业消息配置锁不可用".to_string())?
        .get(&provider)
        .cloned()
        .ok_or_else(|| "请先保存并验证平台凭据".to_string())?;
    let secret = state.credentials.get(&secret_id(&provider))?;
    let token = access_token(&state.http, &provider, &config.app_id, &secret).await?;
    let response = match provider.as_str() {
        "feishu" | "lark" => {
            let host = if provider == "lark" { "https://open.larksuite.com" } else { "https://open.feishu.cn" };
            state.http.post(format!("{host}/open-apis/im/v1/messages?receive_id_type=open_id"))
                .bearer_auth(&token)
                .json(&json!({"receive_id":target,"msg_type":"text","content":serde_json::to_string(&json!({"text":text})).map_err(|error| error.to_string())?}))
                .send().await
        }
        "wecom" => {
            let mut endpoint = url::Url::parse("https://qyapi.weixin.qq.com/cgi-bin/message/send")
                .map_err(|error| error.to_string())?;
            endpoint.query_pairs_mut().append_pair("access_token", &token);
            let agent = config.agent_id.as_deref().ok_or_else(|| "企业微信缺少 Agent ID".to_string())?
                .parse::<u64>().map_err(|_| "企业微信 Agent ID 必须是数字".to_string())?;
            state.http.post(endpoint).json(&json!({"touser":target,"msgtype":"text","agentid":agent,"text":{"content":text},"safe":0})).send().await
        }
        "dingtalk" => state.http.post("https://api.dingtalk.com/v1.0/robot/oToMessages/batchSend")
            .header("x-acs-dingtalk-access-token", &token)
            .json(&json!({"robotCode":config.app_id,"userIds":[target],"msgKey":"sampleText","msgParam":serde_json::to_string(&json!({"content":text})).map_err(|error| error.to_string())?}))
            .send().await,
        _ => unreachable!(),
    }.map_err(|error| format!("消息发送请求失败: {error}"))?;
    let status = response.status();
    let body: Value = response.json().await.unwrap_or_else(|_| json!({}));
    if !status.is_success() {
        return Err(format!("平台返回 HTTP {status}"));
    }
    platform_result(&body)?;
    Ok(json!({"ok":true,"provider":provider,"targetId":target}))
}

#[tauri::command]
pub fn channel_config_clear(
    provider: String,
    state: tauri::State<'_, NativeChannelState>,
) -> Result<(), String> {
    let provider = validate_provider(&provider)?.to_string();
    state.stop_connector(&provider)?;
    state.credentials.delete(&secret_id(&provider))?;
    let mut configs = state
        .configs
        .lock()
        .map_err(|_| "企业消息配置锁不可用".to_string())?;
    configs.remove(&provider);
    state.persist(&configs)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_supported_providers_and_real_tokens() {
        assert!(validate_provider("dingtalk").is_ok());
        assert!(validate_provider("unknown").is_err());
        assert!(parse_token("feishu", &json!({"tenant_access_token":"token"})).is_ok());
        assert!(parse_token("wecom", &json!({"access_token":"token"})).is_ok());
        assert!(parse_token("dingtalk", &json!({"accessToken":"token"})).is_ok());
        assert!(parse_token("wecom", &json!({"errcode":40013,"errmsg":"invalid corpid"})).is_err());
        assert!(platform_result(&json!({"errcode": 0})).is_ok());
        assert!(platform_result(&json!({"errcode": 40013, "errmsg": "invalid"})).is_err());
    }

    #[test]
    fn accepts_only_successful_valid_feishu_websocket_endpoints() {
        let valid = json!({
            "code": 0,
            "msg": "success",
            "data": {
                "URL": "wss://example.com/ws?device_id=test&service_id=42",
                "ClientConfig": {"PingInterval": 30, "ReconnectCount": 3}
            }
        });
        let endpoint = parse_feishu_endpoint(&valid).expect("valid endpoint");
        assert_eq!(endpoint.device_id(), "test");
        assert_eq!(endpoint.service_id(), 42);
        assert_eq!(
            endpoint
                .client_config()
                .and_then(|config| config.ping_interval),
            Some(30)
        );

        let rejected = parse_feishu_endpoint(&json!({"code": 1000040343, "msg": "invalid app"}))
            .expect_err("a rejected endpoint must fail");
        assert!(rejected.contains("invalid app"));

        assert!(parse_feishu_endpoint(&json!({"code": 0, "data": {}})).is_err());
        assert!(parse_feishu_endpoint(&json!({
            "code": 0,
            "data": {"URL": "wss://example.com/ws?device_id=test"}
        }))
        .is_err());
        assert!(parse_feishu_endpoint(&json!({
            "code": 0,
            "data": {"URL": "https://example.com/not-a-websocket"}
        }))
        .is_err());
    }
}
