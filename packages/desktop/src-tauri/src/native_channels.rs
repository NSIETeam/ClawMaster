use crate::native_models::{system_credential_store, CredentialStore};
use crate::native_runtime::NativeRuntime;
use futures_util::{SinkExt, StreamExt};
use lark_channel::lark_openapi::{
    TokioTungsteniteWebSocketTransport, WebSocketClientConfig, WebSocketConnection,
    WebSocketEndpoint, WebSocketEventAck,
};
use lark_channel::{
    ChannelEvent, Error as LarkError, EventLoop, EventLoopOptions, EventStreamConnector,
    MessageChatType, MessageSenderType,
};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager};
use tokio::sync::{mpsc, watch};
use tokio::task::JoinHandle;
use tokio_tungstenite::{connect_async, tungstenite::Message};

const MAX_ID_CHARS: usize = 200;
const INBOUND_QUEUE_CAPACITY: usize = 32;
const SEEN_MESSAGE_CAPACITY: usize = 1024;
const DINGTALK_CALLBACK_TOPIC: &str = "/v1.0/im/bot/messages/get";
const DINGTALK_STREAM_ENDPOINT: &str = "https://api.dingtalk.com/v1.0/gateway/connections/open";
const DINGTALK_KEEPALIVE_IDLE_SECONDS: u64 = 120;
const DINGTALK_PONG_TIMEOUT_SECONDS: u64 = 5;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelConfig {
    provider: String,
    app_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    bot_open_id: Option<String>,
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
    tasks: Mutex<HashMap<String, ChannelTasks>>,
}

struct ChannelTasks {
    event: JoinHandle<()>,
    _worker: JoinHandle<()>,
    shutdown: watch::Sender<bool>,
}

#[derive(Debug)]
struct InboundMessage {
    provider: String,
    chat_id: String,
    message_id: String,
    text: String,
    reply_webhook: Option<url::Url>,
}

#[derive(Debug)]
struct DingTalkEndpoint {
    endpoint: url::Url,
    ticket: String,
}

impl DingTalkEndpoint {
    fn websocket_url(&self) -> Result<url::Url, String> {
        let mut endpoint = self.endpoint.clone();
        endpoint
            .query_pairs_mut()
            .append_pair("ticket", &self.ticket);
        Ok(endpoint)
    }
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
    bot_open_id: Arc<Mutex<Option<String>>>,
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
        let needs_bot_identity = self
            .bot_open_id
            .lock()
            .map(|value| value.is_none())
            .unwrap_or(false);
        if needs_bot_identity {
            let token = access_token(&self.http, &self.provider, &self.app_id, &self.app_secret)
                .await
                .map_err(LarkError::Transport)?;
            let open_id = feishu_bot_open_id(&self.http, &self.provider, &token)
                .await
                .map_err(LarkError::Transport)?;
            if let Ok(mut value) = self.bot_open_id.lock() {
                *value = Some(open_id);
            }
        }
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

fn bounded_reply(value: &str) -> String {
    if value.chars().count() <= 4000 {
        return value.to_string();
    }
    let mut result = value.chars().take(3988).collect::<String>();
    result.push_str("\n\n[回复已截断]");
    result
}

fn inbound_message(
    provider: &str,
    bot_open_id: Option<&str>,
    event: &ChannelEvent,
) -> Result<Option<InboundMessage>, String> {
    let ChannelEvent::Message(message) = event else {
        return Ok(None);
    };
    if message.sender.sender_type == MessageSenderType::Bot {
        return Ok(None);
    }
    if message.chat_type == MessageChatType::Group
        && !bot_open_id.is_some_and(|open_id| message.mentions_bot(open_id))
    {
        return Ok(None);
    }
    if message.message_type != "text" {
        return Ok(None);
    }
    Ok(Some(InboundMessage {
        provider: provider.to_string(),
        chat_id: clean(&message.chat_id, "飞书 Chat ID")?,
        message_id: clean(&message.message_id, "飞书 Message ID")?,
        text: clean_message(&message.text)?,
        reply_webhook: None,
    }))
}

fn is_dingtalk_host(host: Option<&str>) -> bool {
    host.is_some_and(|host| host == "dingtalk.com" || host.ends_with(".dingtalk.com"))
}

fn dingtalk_connection_request(app_id: &str, app_secret: &str) -> Value {
    json!({
        "clientId": app_id,
        "clientSecret": app_secret,
        "subscriptions": [{"type": "CALLBACK", "topic": DINGTALK_CALLBACK_TOPIC}],
        "ua": format!("ClawMaster/{}", env!("CARGO_PKG_VERSION"))
    })
}

fn parse_dingtalk_endpoint(body: &Value) -> Result<DingTalkEndpoint, String> {
    let endpoint = body
        .get("endpoint")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "钉钉长连接响应缺少 endpoint".to_string())?;
    let ticket = body
        .get("ticket")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    if ticket.is_empty() || ticket.len() > 4096 || ticket.chars().any(char::is_control) {
        return Err("钉钉长连接 Ticket 为空、过长或包含控制字符".into());
    }
    let endpoint =
        url::Url::parse(endpoint).map_err(|error| format!("钉钉长连接 endpoint 无效: {error}"))?;
    if endpoint.scheme() != "wss"
        || !is_dingtalk_host(endpoint.host_str())
        || !endpoint.username().is_empty()
        || endpoint.password().is_some()
    {
        return Err("钉钉长连接 endpoint 必须是官方 WSS 地址".into());
    }
    Ok(DingTalkEndpoint {
        endpoint,
        ticket: ticket.to_string(),
    })
}

fn dingtalk_inbound_message(
    frame: &Value,
    now_millis: i64,
) -> Result<Option<InboundMessage>, String> {
    if frame.get("type").and_then(Value::as_str) != Some("CALLBACK")
        || frame.pointer("/headers/topic").and_then(Value::as_str) != Some(DINGTALK_CALLBACK_TOPIC)
    {
        return Ok(None);
    }
    let data = frame
        .get("data")
        .and_then(Value::as_str)
        .ok_or_else(|| "钉钉回调缺少 data".to_string())?;
    let callback: Value =
        serde_json::from_str(data).map_err(|error| format!("钉钉机器人回调无效: {error}"))?;
    if callback.get("msgtype").and_then(Value::as_str) != Some("text") {
        return Ok(None);
    }
    let conversation_type = callback
        .get("conversationType")
        .and_then(Value::as_str)
        .unwrap_or("");
    if conversation_type == "2"
        && !callback
            .get("isInAtList")
            .and_then(Value::as_bool)
            .unwrap_or(false)
    {
        return Ok(None);
    }
    if !matches!(conversation_type, "1" | "2") {
        return Ok(None);
    }
    let expires_at = callback
        .get("sessionWebhookExpiredTime")
        .and_then(Value::as_i64)
        .unwrap_or(0);
    if expires_at <= now_millis {
        return Err("钉钉会话回复地址已过期".into());
    }
    let reply_webhook = url::Url::parse(
        callback
            .get("sessionWebhook")
            .and_then(Value::as_str)
            .unwrap_or(""),
    )
    .map_err(|error| format!("钉钉会话回复地址无效: {error}"))?;
    if reply_webhook.scheme() != "https"
        || !is_dingtalk_host(reply_webhook.host_str())
        || !reply_webhook.username().is_empty()
        || reply_webhook.password().is_some()
        || reply_webhook.port().is_some_and(|port| port != 443)
    {
        return Err("钉钉会话回复地址不是官方 HTTPS 地址".into());
    }
    Ok(Some(InboundMessage {
        provider: "dingtalk".into(),
        chat_id: clean(
            callback
                .get("conversationId")
                .and_then(Value::as_str)
                .unwrap_or(""),
            "钉钉 Conversation ID",
        )?,
        message_id: clean(
            callback.get("msgId").and_then(Value::as_str).unwrap_or(""),
            "钉钉 Message ID",
        )?,
        text: clean_message(
            callback
                .pointer("/text/content")
                .and_then(Value::as_str)
                .unwrap_or(""),
        )?,
        reply_webhook: Some(reply_webhook),
    }))
}

fn dingtalk_ack(frame: &Value, code: u16, message: &str, data: &str) -> Result<Value, String> {
    let message_id = clean(
        frame
            .pointer("/headers/messageId")
            .and_then(Value::as_str)
            .unwrap_or(""),
        "钉钉 Stream Message ID",
    )?;
    Ok(json!({
        "code": code,
        "headers": {"messageId": message_id, "contentType": "application/json"},
        "message": message,
        "data": data
    }))
}

fn mark_message_seen(seen: &Arc<Mutex<VecDeque<String>>>, message_id: &str) -> bool {
    let Ok(mut values) = seen.lock() else {
        return false;
    };
    if values.iter().any(|value| value == message_id) {
        return false;
    }
    values.push_back(message_id.to_string());
    if values.len() > SEEN_MESSAGE_CAPACITY {
        values.pop_front();
    }
    true
}

fn forget_message(seen: &Arc<Mutex<VecDeque<String>>>, message_id: &str) {
    if let Ok(mut values) = seen.lock() {
        values.retain(|value| value != message_id);
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

async fn feishu_bot_open_id(http: &Client, provider: &str, token: &str) -> Result<String, String> {
    let host = if provider == "lark" {
        "https://open.larksuite.com"
    } else {
        "https://open.feishu.cn"
    };
    let response = http
        .get(format!("{host}/open-apis/bot/v3/info/"))
        .bearer_auth(token)
        .send()
        .await
        .map_err(|error| format!("获取飞书机器人身份失败: {error}"))?;
    let status = response.status();
    let body: Value = response
        .json()
        .await
        .map_err(|error| format!("飞书机器人身份响应无效: {error}"))?;
    if !status.is_success() {
        return Err(format!("飞书机器人身份服务返回 HTTP {status}"));
    }
    parse_feishu_bot_open_id(&body)
}

fn parse_feishu_bot_open_id(body: &Value) -> Result<String, String> {
    platform_result(body)?;
    let open_id = body
        .pointer("/bot/open_id")
        .and_then(Value::as_str)
        .unwrap_or("");
    clean(open_id, "飞书机器人 Open ID")
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

async fn send_feishu_text(
    http: &Client,
    config: &ChannelConfig,
    app_secret: &str,
    receive_id_type: &str,
    target: &str,
    text: &str,
) -> Result<(), String> {
    let token = access_token(http, &config.provider, &config.app_id, app_secret).await?;
    let host = if config.provider == "lark" {
        "https://open.larksuite.com"
    } else {
        "https://open.feishu.cn"
    };
    let response = http
        .post(format!(
            "{host}/open-apis/im/v1/messages?receive_id_type={receive_id_type}"
        ))
        .bearer_auth(token)
        .json(&json!({
            "receive_id":target,
            "msg_type":"text",
            "content":serde_json::to_string(&json!({"text":text}))
                .map_err(|error| error.to_string())?
        }))
        .send()
        .await
        .map_err(|error| format!("飞书消息发送请求失败: {error}"))?;
    let status = response.status();
    let body: Value = response.json().await.unwrap_or_else(|_| json!({}));
    if !status.is_success() {
        return Err(format!("飞书平台返回 HTTP {status}"));
    }
    platform_result(&body)
}

async fn send_dingtalk_session_text(
    http: &Client,
    webhook: &url::Url,
    text: &str,
) -> Result<(), String> {
    let response = http
        .post(webhook.clone())
        .json(&json!({"msgtype": "text", "text": {"content": text}}))
        .send()
        .await
        .map_err(|error| format!("钉钉会话回复请求失败: {error}"))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("钉钉会话回复返回 HTTP {status}"));
    }
    Ok(())
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

async fn dingtalk_websocket_endpoint(
    http: &Client,
    app_id: &str,
    app_secret: &str,
) -> Result<DingTalkEndpoint, String> {
    let response = http
        .post(DINGTALK_STREAM_ENDPOINT)
        .json(&dingtalk_connection_request(app_id, app_secret))
        .send()
        .await
        .map_err(|error| format!("连接钉钉 Stream 服务失败: {error}"))?;
    let status = response.status();
    let body: Value = response
        .json()
        .await
        .map_err(|error| format!("钉钉 Stream 接入点响应无效: {error}"))?;
    if !status.is_success() {
        let message = body
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("平台未返回错误说明");
        return Err(format!("钉钉 Stream 服务返回 HTTP {status}: {message}"));
    }
    parse_dingtalk_endpoint(&body)
}

fn record_channel_error(
    statuses: &Arc<Mutex<HashMap<String, ChannelStatus>>>,
    provider: &str,
    error: String,
) {
    if let Ok(mut values) = statuses.lock() {
        let status = values
            .entry(provider.to_string())
            .or_insert_with(|| ChannelStatus::new(provider, "connected"));
        status.last_error = Some(error);
    }
}

async fn run_inbound_worker(
    app: AppHandle,
    http: Client,
    config: ChannelConfig,
    app_secret: String,
    statuses: Arc<Mutex<HashMap<String, ChannelStatus>>>,
    mut receiver: mpsc::Receiver<InboundMessage>,
    mut shutdown: watch::Receiver<bool>,
) {
    loop {
        let message = tokio::select! {
            changed = shutdown.changed() => {
                if changed.is_err() || *shutdown.borrow() {
                    break;
                }
                continue;
            }
            message = receiver.recv() => {
                let Some(message) = message else { break; };
                message
            }
        };
        let result = async {
            let runtime = app.state::<NativeRuntime>();
            let reply = runtime
                .run_channel_turn(
                    &app,
                    &message.provider,
                    &message.chat_id,
                    &message.message_id,
                    &message.text,
                )
                .await?;
            let reply = bounded_reply(&reply);
            if let Some(webhook) = message.reply_webhook.as_ref() {
                send_dingtalk_session_text(&http, webhook, &reply).await
            } else {
                send_feishu_text(
                    &http,
                    &config,
                    &app_secret,
                    "chat_id",
                    &message.chat_id,
                    &reply,
                )
                .await
            }
        }
        .await;
        if let Err(error) = result {
            record_channel_error(&statuses, &message.provider, error);
        }
    }
}

async fn wait_for_reconnect(shutdown: &mut watch::Receiver<bool>, delay_seconds: u64) -> bool {
    tokio::select! {
        changed = shutdown.changed() => changed.is_err() || *shutdown.borrow(),
        _ = tokio::time::sleep(std::time::Duration::from_secs(delay_seconds)) => false,
    }
}

async fn run_dingtalk_stream(
    app: AppHandle,
    http: Client,
    config: ChannelConfig,
    app_secret: String,
    statuses: Arc<Mutex<HashMap<String, ChannelStatus>>>,
    sender: mpsc::Sender<InboundMessage>,
    mut shutdown: watch::Receiver<bool>,
) {
    let provider = config.provider.clone();
    let seen = Arc::new(Mutex::new(VecDeque::new()));
    let mut retry_seconds = 3_u64;
    loop {
        if *shutdown.borrow() {
            return;
        }
        set_channel_status(&statuses, ChannelStatus::new(&provider, "connecting"));
        let connection = async {
            let endpoint = dingtalk_websocket_endpoint(&http, &config.app_id, &app_secret).await?;
            let websocket_url = endpoint.websocket_url()?;
            connect_async(websocket_url.as_str())
                .await
                .map(|(socket, _)| socket)
                .map_err(|error| format!("钉钉 WebSocket 连接失败: {error}"))
        }
        .await;
        let mut socket = match connection {
            Ok(socket) => socket,
            Err(error) => {
                let mut status = ChannelStatus::new(&provider, "failed");
                status.last_error = Some(error);
                set_channel_status(&statuses, status);
                if wait_for_reconnect(&mut shutdown, retry_seconds).await {
                    return;
                }
                retry_seconds = (retry_seconds * 2).min(60);
                continue;
            }
        };
        retry_seconds = 3;
        set_channel_status(&statuses, ChannelStatus::new(&provider, "connected"));
        let disconnect_reason = loop {
            let incoming = tokio::select! {
                changed = shutdown.changed() => {
                    if changed.is_err() || *shutdown.borrow() {
                        let _ = socket.close(None).await;
                        return;
                    }
                    continue;
                }
                incoming = socket.next() => incoming,
                _ = tokio::time::sleep(std::time::Duration::from_secs(DINGTALK_KEEPALIVE_IDLE_SECONDS)) => {
                    if let Err(error) = socket.send(Message::Ping(Vec::new().into())).await {
                        break format!("钉钉 WebSocket 心跳发送失败: {error}");
                    }
                    tokio::select! {
                        changed = shutdown.changed() => {
                            if changed.is_err() || *shutdown.borrow() {
                                let _ = socket.close(None).await;
                                return;
                            }
                            continue;
                        }
                        result = tokio::time::timeout(
                            std::time::Duration::from_secs(DINGTALK_PONG_TIMEOUT_SECONDS),
                            socket.next(),
                        ) => match result {
                            Ok(incoming) => incoming,
                            Err(_) => break "钉钉 WebSocket 心跳超时".into(),
                        },
                    }
                },
            };
            let frame = match incoming {
                Some(Ok(Message::Text(text))) => serde_json::from_str::<Value>(text.as_str()),
                Some(Ok(Message::Binary(bytes))) => serde_json::from_slice::<Value>(&bytes),
                Some(Ok(Message::Ping(data))) => {
                    if let Err(error) = socket.send(Message::Pong(data)).await {
                        break format!("钉钉 WebSocket 心跳回复失败: {error}");
                    }
                    continue;
                }
                Some(Ok(Message::Close(_))) | None => break "钉钉 WebSocket 已关闭".into(),
                Some(Ok(_)) => continue,
                Some(Err(error)) => break format!("钉钉 WebSocket 读取失败: {error}"),
            };
            let frame = match frame {
                Ok(frame) => frame,
                Err(error) => {
                    record_channel_error(
                        &statuses,
                        &provider,
                        format!("钉钉 Stream 帧无效: {error}"),
                    );
                    continue;
                }
            };
            let is_disconnect = frame.get("type").and_then(Value::as_str) == Some("SYSTEM")
                && frame.pointer("/headers/topic").and_then(Value::as_str) == Some("disconnect");
            let now_millis = chrono::Utc::now().timestamp_millis();
            let result = dingtalk_inbound_message(&frame, now_millis);
            let ack = match result {
                Ok(Some(message))
                    if !app
                        .state::<NativeRuntime>()
                        .has_channel_message(&provider, &message.message_id)
                        .unwrap_or(false)
                        && mark_message_seen(&seen, &message.message_id) =>
                {
                    let message_id = message.message_id.clone();
                    match sender.try_send(message) {
                        Ok(()) => dingtalk_ack(&frame, 200, "ok", ""),
                        Err(mpsc::error::TrySendError::Full(_))
                        | Err(mpsc::error::TrySendError::Closed(_)) => {
                            forget_message(&seen, &message_id);
                            dingtalk_ack(&frame, 500, "ClawMaster inbound queue unavailable", "")
                        }
                    }
                }
                Ok(Some(_)) | Ok(None) => dingtalk_ack(&frame, 200, "ok", ""),
                Err(error) => {
                    record_channel_error(&statuses, &provider, error.clone());
                    dingtalk_ack(&frame, 500, &error, "")
                }
            };
            let ack = match ack
                .and_then(|value| serde_json::to_string(&value).map_err(|error| error.to_string()))
            {
                Ok(ack) => ack,
                Err(error) => {
                    record_channel_error(&statuses, &provider, error);
                    continue;
                }
            };
            if let Err(error) = socket.send(Message::Text(ack.into())).await {
                break format!("钉钉 Stream ACK 发送失败: {error}");
            }
            let mut status = ChannelStatus::new(&provider, "connected");
            status.last_event_at = Some(chrono::Utc::now().to_rfc3339());
            set_channel_status(&statuses, status);
            if is_disconnect {
                break "钉钉 Stream 服务要求重新连接".into();
            }
        };
        let mut status = ChannelStatus::new(&provider, "connecting");
        status.last_error = Some(disconnect_reason);
        set_channel_status(&statuses, status);
        if wait_for_reconnect(&mut shutdown, retry_seconds).await {
            return;
        }
        retry_seconds = (retry_seconds * 2).min(60);
    }
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
                .redirect(reqwest::redirect::Policy::none())
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
        app: AppHandle,
    ) -> Result<(), String> {
        let provider = config.provider.clone();
        let mut tasks = self
            .tasks
            .lock()
            .map_err(|_| "企业消息任务锁不可用".to_string())?;
        if let Some(tasks) = tasks.remove(&provider) {
            let _ = app.state::<NativeRuntime>().cancel_channel_turns(&provider);
            let _ = tasks.shutdown.send(true);
            tasks.event.abort();
        }
        let statuses = Arc::clone(&self.statuses);
        let task_statuses = Arc::clone(&statuses);
        let task_provider = provider.clone();
        let bot_open_id = Arc::new(Mutex::new(config.bot_open_id.clone()));
        let worker_config = config.clone();
        let worker_secret = app_secret.clone();
        let connector = FeishuConnector {
            http: self.http.clone(),
            provider: provider.clone(),
            app_id: config.app_id,
            app_secret,
            bot_open_id: Arc::clone(&bot_open_id),
            statuses: Arc::clone(&statuses),
            client_config: None,
        };
        set_channel_status(&statuses, ChannelStatus::new(&provider, "connecting"));
        let (sender, receiver) = mpsc::channel(INBOUND_QUEUE_CAPACITY);
        let (shutdown, shutdown_receiver) = watch::channel(false);
        let event_app = app.clone();
        let worker = tokio::spawn(run_inbound_worker(
            app,
            self.http.clone(),
            worker_config,
            worker_secret,
            Arc::clone(&statuses),
            receiver,
            shutdown_receiver,
        ));
        let event = tokio::spawn(async move {
            let mut event_loop = EventLoop::with_options(
                connector,
                EventLoopOptions::new()
                    .with_unlimited_reconnects()
                    .with_server_reconnect_config(true),
            );
            let event_statuses = Arc::clone(&task_statuses);
            let event_provider = task_provider.clone();
            let seen = Arc::new(Mutex::new(VecDeque::new()));
            let result = event_loop
                .run(move |event| {
                    let mut status = ChannelStatus::new(&event_provider, "connected");
                    status.last_event_at = Some(chrono::Utc::now().to_rfc3339());
                    set_channel_status(&event_statuses, status);
                    let current_bot_open_id =
                        bot_open_id.lock().ok().and_then(|value| value.clone());
                    let ack = match inbound_message(
                        &event_provider,
                        current_bot_open_id.as_deref(),
                        &event.event,
                    ) {
                        Ok(Some(message))
                            if !event_app
                                .state::<NativeRuntime>()
                                .has_channel_message(&event_provider, &message.message_id)
                                .unwrap_or(false)
                                && mark_message_seen(&seen, &message.message_id) =>
                        {
                            let message_id = message.message_id.clone();
                            match sender.try_send(message) {
                                Ok(()) => WebSocketEventAck::ok(),
                                Err(mpsc::error::TrySendError::Full(_)) => {
                                    forget_message(&seen, &message_id);
                                    WebSocketEventAck::internal_server_error()
                                }
                                Err(mpsc::error::TrySendError::Closed(_)) => {
                                    forget_message(&seen, &message_id);
                                    WebSocketEventAck::internal_server_error()
                                }
                            }
                        }
                        Ok(Some(_)) | Ok(None) => WebSocketEventAck::ok(),
                        Err(error) => {
                            record_channel_error(&event_statuses, &event_provider, error);
                            WebSocketEventAck::internal_server_error()
                        }
                    };
                    async move { Ok(ack) }
                })
                .await;
            let mut status = ChannelStatus::new(&task_provider, "failed");
            status.last_error = Some(match result {
                Ok(exit) => format!("飞书长连接已停止: {exit:?}"),
                Err(error) => error.to_string(),
            });
            set_channel_status(&task_statuses, status);
        });
        tasks.insert(
            provider,
            ChannelTasks {
                event,
                _worker: worker,
                shutdown,
            },
        );
        Ok(())
    }

    fn start_dingtalk_connector(
        &self,
        config: ChannelConfig,
        app_secret: String,
        app: AppHandle,
    ) -> Result<(), String> {
        let provider = config.provider.clone();
        let mut tasks = self
            .tasks
            .lock()
            .map_err(|_| "企业消息任务锁不可用".to_string())?;
        if let Some(tasks) = tasks.remove(&provider) {
            let _ = app.state::<NativeRuntime>().cancel_channel_turns(&provider);
            let _ = tasks.shutdown.send(true);
            tasks.event.abort();
        }
        let statuses = Arc::clone(&self.statuses);
        set_channel_status(&statuses, ChannelStatus::new(&provider, "connecting"));
        let (sender, receiver) = mpsc::channel(INBOUND_QUEUE_CAPACITY);
        let (shutdown, shutdown_receiver) = watch::channel(false);
        let worker = tokio::spawn(run_inbound_worker(
            app.clone(),
            self.http.clone(),
            config.clone(),
            app_secret.clone(),
            Arc::clone(&statuses),
            receiver,
            shutdown_receiver.clone(),
        ));
        let event = tokio::spawn(run_dingtalk_stream(
            app,
            self.http.clone(),
            config,
            app_secret,
            statuses,
            sender,
            shutdown_receiver,
        ));
        tasks.insert(
            provider,
            ChannelTasks {
                event,
                _worker: worker,
                shutdown,
            },
        );
        Ok(())
    }

    pub fn start_configured(&self, app: AppHandle) {
        let configs = self
            .configs
            .lock()
            .map(|values| values.values().cloned().collect::<Vec<_>>())
            .unwrap_or_default();
        for config in configs {
            if !matches!(config.provider.as_str(), "feishu" | "lark" | "dingtalk") {
                continue;
            }
            let provider = config.provider.clone();
            match self.credentials.get(&secret_id(&provider)) {
                Ok(secret) => {
                    let result = if config.provider == "dingtalk" {
                        self.start_dingtalk_connector(config, secret, app.clone())
                    } else {
                        self.start_feishu_connector(config, secret, app.clone())
                    };
                    if let Err(error) = result {
                        let mut status = ChannelStatus::new(&provider, "failed");
                        status.last_error = Some(error);
                        set_channel_status(&self.statuses, status);
                    }
                }
                Err(error) => {
                    let mut status = ChannelStatus::new(&config.provider, "failed");
                    status.last_error = Some(error);
                    set_channel_status(&self.statuses, status);
                }
            }
        }
    }

    fn stop_connector(&self, provider: &str, app: &AppHandle) -> Result<(), String> {
        if let Some(tasks) = self
            .tasks
            .lock()
            .map_err(|_| "企业消息任务锁不可用".to_string())?
            .remove(provider)
        {
            let cancel_result = app.state::<NativeRuntime>().cancel_channel_turns(provider);
            let _ = tasks.shutdown.send(true);
            tasks.event.abort();
            cancel_result?;
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
    app: AppHandle,
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
    let token = access_token(&state.http, &provider, &app_id, &app_secret).await?;
    let bot_open_id = match provider.as_str() {
        "feishu" | "lark" => {
            feishu_websocket_endpoint(&state.http, &provider, &app_id, &app_secret).await?;
            Some(feishu_bot_open_id(&state.http, &provider, &token).await?)
        }
        "dingtalk" => {
            dingtalk_websocket_endpoint(&state.http, &app_id, &app_secret).await?;
            None
        }
        _ => None,
    };
    state.credentials.set(&secret_id(&provider), &app_secret)?;
    let config = ChannelConfig {
        provider: provider.clone(),
        app_id,
        bot_open_id,
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
    match config.provider.as_str() {
        "feishu" | "lark" => {
            state.start_feishu_connector(config.clone(), app_secret, app)?;
        }
        "dingtalk" => {
            state.start_dingtalk_connector(config.clone(), app_secret, app)?;
        }
        _ => {}
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
    app: AppHandle,
    state: tauri::State<'_, NativeChannelState>,
) -> Result<(), String> {
    let provider = validate_provider(&provider)?.to_string();
    state.stop_connector(&provider, &app)?;
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

    fn message_event(chat_type: &str, sender_type: &str, mentions: Value) -> ChannelEvent {
        lark_channel::parse_lark_event_payload(
            &serde_json::to_vec(&json!({
                "schema":"2.0",
                "header":{
                    "event_id":"event-1",
                    "event_type":"im.message.receive_v1",
                    "create_time":"1",
                    "tenant_key":"tenant"
                },
                "event":{
                    "sender":{
                        "sender_id":{"open_id":"ou_sender"},
                        "sender_type":sender_type,
                        "tenant_key":"tenant"
                    },
                    "message":{
                        "message_id":"om_message_1",
                        "chat_id":"oc_chat_1",
                        "chat_type":chat_type,
                        "message_type":"text",
                        "content":"{\"text\":\"hello\"}",
                        "mentions":mentions
                    }
                }
            }))
            .expect("message payload"),
        )
        .expect("message event")
    }

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
        assert_eq!(
            parse_feishu_bot_open_id(&json!({"code":0,"bot":{"open_id":"ou_bot"}}))
                .expect("bot identity"),
            "ou_bot"
        );
        assert!(parse_feishu_bot_open_id(&json!({"code":0,"bot":{}})).is_err());
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

    #[test]
    fn queues_only_user_text_from_private_or_mentioned_group_chats() {
        assert!(inbound_message(
            "feishu",
            Some("ou_bot"),
            &message_event("p2p", "user", json!([]))
        )
        .expect("private message")
        .is_some());
        assert!(inbound_message(
            "feishu",
            Some("ou_bot"),
            &message_event("group", "user", json!([]))
        )
        .expect("unmentioned group")
        .is_none());
        assert!(inbound_message(
            "feishu",
            Some("ou_bot"),
            &message_event(
                "group",
                "user",
                json!([{"key":"@_user_1","id":{"open_id":"ou_bot"}}])
            )
        )
        .expect("mentioned group")
        .is_some());
        assert!(inbound_message(
            "feishu",
            Some("ou_bot"),
            &message_event(
                "group",
                "user",
                json!([{"key":"@_user_1","id":{"open_id":"ou_someone_else"}}])
            )
        )
        .expect("other mention")
        .is_none());
        assert!(inbound_message(
            "feishu",
            Some("ou_bot"),
            &message_event("p2p", "bot", json!([]))
        )
        .expect("bot message")
        .is_none());
    }

    #[test]
    fn bounds_the_in_memory_message_deduplication_window() {
        let seen = Arc::new(Mutex::new(VecDeque::new()));
        assert!(mark_message_seen(&seen, "message-1"));
        assert!(!mark_message_seen(&seen, "message-1"));
        forget_message(&seen, "message-1");
        assert!(mark_message_seen(&seen, "message-1"));
        for index in 0..=SEEN_MESSAGE_CAPACITY {
            assert!(mark_message_seen(&seen, &format!("message-{index}-next")));
        }
        assert_eq!(seen.lock().unwrap().len(), SEEN_MESSAGE_CAPACITY);
    }

    #[test]
    fn bounds_outbound_model_replies_for_feishu_text_messages() {
        assert_eq!(bounded_reply("short"), "short");
        let bounded = bounded_reply(&"字".repeat(5000));
        assert!(bounded.ends_with("[回复已截断]"));
        assert!(bounded.chars().count() <= 4000);
    }

    fn dingtalk_callback_frame(conversation_type: &str, mentioned: bool) -> Value {
        json!({
            "specVersion": "1.0",
            "type": "CALLBACK",
            "headers": {
                "messageId": "stream-message-1",
                "topic": "/v1.0/im/bot/messages/get"
            },
            "data": serde_json::to_string(&json!({
                "conversationId": "cid-example",
                "conversationType": conversation_type,
                "msgId": "chat-message-1",
                "msgtype": "text",
                "senderStaffId": "user-1",
                "isInAtList": mentioned,
                "sessionWebhook": "https://oapi.dingtalk.com/robot/sendBySession?session=opaque",
                "sessionWebhookExpiredTime": 4_102_444_800_000_i64,
                "text": {"content": "  hello ClawMaster  "}
            })).expect("callback data")
        })
    }

    #[test]
    fn validates_dingtalk_stream_endpoint_and_subscription_request() {
        let endpoint = parse_dingtalk_endpoint(&json!({
            "endpoint": "wss://wss-open-connection.dingtalk.com/connect",
            "ticket": "ticket-1"
        }))
        .expect("valid endpoint");
        assert_eq!(
            endpoint.websocket_url().expect("websocket url").as_str(),
            "wss://wss-open-connection.dingtalk.com/connect?ticket=ticket-1"
        );
        assert!(parse_dingtalk_endpoint(&json!({
            "endpoint": "https://example.com/not-websocket",
            "ticket": "ticket-1"
        }))
        .is_err());
        assert!(parse_dingtalk_endpoint(&json!({"endpoint": "wss://example.com"})).is_err());

        let request = dingtalk_connection_request("app-key", "app-secret");
        assert_eq!(request["clientId"], "app-key");
        assert_eq!(request["clientSecret"], "app-secret");
        assert_eq!(request["subscriptions"][0]["type"], "CALLBACK");
        assert_eq!(
            request["subscriptions"][0]["topic"],
            "/v1.0/im/bot/messages/get"
        );
    }

    #[test]
    fn parses_private_and_mentioned_dingtalk_text_messages() {
        let private = dingtalk_inbound_message(&dingtalk_callback_frame("1", false), 0)
            .expect("private callback")
            .expect("private message");
        assert_eq!(private.provider, "dingtalk");
        assert_eq!(private.chat_id, "cid-example");
        assert_eq!(private.message_id, "chat-message-1");
        assert_eq!(private.text, "hello ClawMaster");
        assert_eq!(
            private.reply_webhook.expect("reply webhook").host_str(),
            Some("oapi.dingtalk.com")
        );

        assert!(
            dingtalk_inbound_message(&dingtalk_callback_frame("2", false), 0)
                .expect("unmentioned group")
                .is_none()
        );
        assert!(
            dingtalk_inbound_message(&dingtalk_callback_frame("2", true), 0)
                .expect("mentioned group")
                .is_some()
        );
    }

    #[test]
    fn rejects_unsafe_or_expired_dingtalk_reply_webhooks() {
        let mut unsafe_frame = dingtalk_callback_frame("1", false);
        let mut data: Value = serde_json::from_str(unsafe_frame["data"].as_str().unwrap()).unwrap();
        data["sessionWebhook"] = json!("https://attacker.example/steal");
        unsafe_frame["data"] = json!(serde_json::to_string(&data).unwrap());
        assert!(dingtalk_inbound_message(&unsafe_frame, 0).is_err());

        assert!(dingtalk_inbound_message(
            &dingtalk_callback_frame("1", false),
            4_102_444_800_001_i64
        )
        .is_err());
    }

    #[test]
    fn acknowledges_dingtalk_frames_with_the_source_message_id() {
        let frame = dingtalk_callback_frame("1", true);
        let ack = dingtalk_ack(&frame, 200, "ok", "").expect("acknowledgement");
        assert_eq!(ack["code"], 200);
        assert_eq!(ack["headers"]["messageId"], "stream-message-1");
        assert_eq!(ack["headers"]["contentType"], "application/json");
        assert_eq!(ack["message"], "ok");
        assert_eq!(ack["data"], "");
    }
}
