use crate::native_models::{
    stream_complete, CredentialStore, ModelCompletion, ModelMessage, ModelStreamEvent,
    ModelToolDefinition, NativeModel, StreamCompletion,
};
use reqwest::Client;
use serde::Serialize;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tokio::sync::watch;
use url::Url;

const DEFAULT_DEADLINE: Duration = Duration::from_secs(120);
const RETRY_DELAY: Duration = Duration::from_millis(150);
const MAX_PRE_DELTA_RETRIES: u8 = 1;
const MODEL_PROXY_ENV: &str = "CLAWMASTER_HTTPS_PROXY";
static INVOCATION_SEQUENCE: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
#[allow(dead_code)]
pub enum InvocationPurpose {
    Agent,
    Title,
    Compression,
    SubAgent,
    Workflow,
    Rerank,
}

#[derive(Clone, Debug)]
pub struct InvocationContext {
    pub session_id: String,
    pub turn_id: String,
    pub purpose: InvocationPurpose,
    pub deadline: Duration,
}

impl InvocationContext {
    pub fn new(session_id: &str, turn_id: &str, purpose: InvocationPurpose) -> Self {
        Self {
            session_id: session_id.to_string(),
            turn_id: turn_id.to_string(),
            purpose,
            deadline: DEFAULT_DEADLINE,
        }
    }
}

pub struct InvocationRequest<'a> {
    pub model: &'a NativeModel,
    pub messages: &'a [ModelMessage],
    pub tools: &'a [ModelToolDefinition],
    pub context: InvocationContext,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GatewayErrorKind {
    CredentialMissing,
    InvalidConfiguration,
    RateLimited,
    ProviderRejected,
    ProviderUnavailable,
    Timeout,
    Transport,
    InvalidResponse,
    StreamInterrupted,
    LedgerFailure,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GatewayError {
    pub kind: GatewayErrorKind,
    pub message: String,
    pub retryable: bool,
    pub uncertain: bool,
}

impl GatewayError {
    pub fn code(&self) -> &'static str {
        match self.kind {
            GatewayErrorKind::CredentialMissing => "model_credential_missing",
            GatewayErrorKind::InvalidConfiguration => "model_configuration_invalid",
            GatewayErrorKind::RateLimited => "model_rate_limited",
            GatewayErrorKind::ProviderRejected => "model_provider_rejected",
            GatewayErrorKind::ProviderUnavailable => "model_provider_unavailable",
            GatewayErrorKind::Timeout => "model_timeout",
            GatewayErrorKind::Transport => "model_transport_failed",
            GatewayErrorKind::InvalidResponse => "model_response_invalid",
            GatewayErrorKind::StreamInterrupted => "model_stream_interrupted",
            GatewayErrorKind::LedgerFailure => "model_usage_ledger_failed",
        }
    }
}

impl std::fmt::Display for GatewayError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for GatewayError {}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct UsageRecord<'a> {
    invocation_id: &'a str,
    phase: &'a str,
    provider: &'a str,
    model: &'a str,
    purpose: InvocationPurpose,
    session_id: &'a str,
    turn_id: &'a str,
    input_tokens: u64,
    output_tokens: u64,
    cache_tokens: u64,
    first_token_ms: Option<u64>,
    duration_ms: u64,
    retry_count: u8,
    outcome: &'a str,
    error_code: Option<&'a str>,
    retryable: bool,
    uncertain: bool,
    timestamp_ms: u64,
}

pub trait UsageLedger: Send + Sync {
    fn append(&self, value: &serde_json::Value) -> Result<(), String>;
}

struct JsonlUsageLedger {
    path: PathBuf,
    write_lock: Mutex<()>,
}

impl JsonlUsageLedger {
    fn new(path: PathBuf) -> Result<Self, String> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| format!("无法创建模型用量账本目录: {error}"))?;
        }
        Ok(Self {
            path,
            write_lock: Mutex::new(()),
        })
    }
}

impl UsageLedger for JsonlUsageLedger {
    fn append(&self, value: &serde_json::Value) -> Result<(), String> {
        let _guard = self
            .write_lock
            .lock()
            .map_err(|_| "模型用量账本锁已损坏".to_string())?;
        let mut output = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)
            .map_err(|error| format!("无法打开模型用量账本: {error}"))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&self.path, fs::Permissions::from_mode(0o600))
                .map_err(|error| format!("无法保护模型用量账本: {error}"))?;
        }
        serde_json::to_writer(&mut output, value)
            .map_err(|error| format!("无法编码模型用量账本: {error}"))?;
        output
            .write_all(b"\n")
            .and_then(|_| output.flush())
            .map_err(|error| format!("无法写入模型用量账本: {error}"))
    }
}

#[derive(Clone)]
pub struct ModelInvocationGateway {
    client: Client,
    credentials: Arc<dyn CredentialStore>,
    ledger: Arc<dyn UsageLedger>,
}

impl ModelInvocationGateway {
    pub fn new(credentials: Arc<dyn CredentialStore>, ledger_path: &Path) -> Result<Self, String> {
        let mut builder = Client::builder()
            .https_only(true)
            .connect_timeout(Duration::from_secs(15))
            .pool_max_idle_per_host(4)
            .pool_idle_timeout(Duration::from_secs(60))
            .no_proxy();
        if let Some(proxy_url) = std::env::var_os(MODEL_PROXY_ENV) {
            let proxy_url = proxy_url
                .to_str()
                .ok_or_else(|| "模型代理地址不是有效 UTF-8".to_string())?;
            let proxy = validated_proxy_url(proxy_url)?;
            builder = builder.proxy(
                reqwest::Proxy::https(proxy.as_str())
                    .map_err(|error| format!("模型代理地址无效: {error}"))?,
            );
        }
        let client = builder
            .build()
            .map_err(|error| format!("无法初始化模型调用网关: {error}"))?;
        Ok(Self {
            client,
            credentials,
            ledger: Arc::new(JsonlUsageLedger::new(ledger_path.to_path_buf())?),
        })
    }

    #[cfg(test)]
    fn with_ledger(credentials: Arc<dyn CredentialStore>, ledger: Arc<dyn UsageLedger>) -> Self {
        Self {
            client: Client::new(),
            credentials,
            ledger,
        }
    }

    pub async fn invoke<F>(
        &self,
        request: InvocationRequest<'_>,
        cancel: watch::Receiver<bool>,
        mut on_event: F,
    ) -> Result<StreamCompletion, GatewayError>
    where
        F: FnMut(ModelStreamEvent) -> Result<(), String>,
    {
        let invocation_id = next_invocation_id();
        let started = Instant::now();
        self.record(
            &invocation_id,
            "started",
            &request,
            None,
            None,
            None,
            0,
            started,
        )?;

        if *cancel.borrow() {
            let completion = cancelled_completion();
            self.record(
                &invocation_id,
                "finished",
                &request,
                None,
                None,
                Some(&completion),
                0,
                started,
            )?;
            return Ok(StreamCompletion::Cancelled(completion));
        }

        let api_key = self
            .credentials
            .get(&request.model.credential_id)
            .map_err(|_| {
                gateway_error(
                    GatewayErrorKind::CredentialMissing,
                    "模型凭据不存在，请在模型设置中重新配置 API key",
                    false,
                    false,
                )
            });
        let api_key = match api_key {
            Ok(value) => value,
            Err(error) => {
                self.record(
                    &invocation_id,
                    "finished",
                    &request,
                    None,
                    Some(&error),
                    None,
                    0,
                    started,
                )?;
                return Err(error);
            }
        };

        let mut retry_count = 0;
        let mut first_token_ms = None;
        loop {
            let remaining = request
                .context
                .deadline
                .checked_sub(started.elapsed())
                .unwrap_or_default();
            if remaining.is_zero() {
                let error = gateway_error(
                    GatewayErrorKind::Timeout,
                    "模型调用超过时间预算",
                    false,
                    false,
                );
                self.record(
                    &invocation_id,
                    "finished",
                    &request,
                    first_token_ms,
                    Some(&error),
                    None,
                    retry_count,
                    started,
                )?;
                return Err(error);
            }

            let mut saw_delta = false;
            let result = tokio::time::timeout(
                remaining,
                stream_complete(
                    &self.client,
                    request.model,
                    &api_key,
                    request.messages,
                    request.tools,
                    cancel.clone(),
                    |event| {
                        if !saw_delta {
                            saw_delta = true;
                            first_token_ms = Some(elapsed_ms(started));
                        }
                        on_event(event)
                    },
                ),
            )
            .await;

            match result {
                Ok(Ok(completion)) => {
                    self.record(
                        &invocation_id,
                        "finished",
                        &request,
                        first_token_ms,
                        None,
                        Some(match &completion {
                            StreamCompletion::Completed(value)
                            | StreamCompletion::Cancelled(value) => value,
                        }),
                        retry_count,
                        started,
                    )?;
                    return Ok(completion);
                }
                Ok(Err(message)) => {
                    let error = classify_error(&redact_secret(&message, &api_key), saw_delta);
                    if should_retry(&error, saw_delta, retry_count) {
                        retry_count += 1;
                        if wait_for_retry(cancel.clone()).await {
                            let completion = cancelled_completion();
                            self.record(
                                &invocation_id,
                                "finished",
                                &request,
                                first_token_ms,
                                None,
                                Some(&completion),
                                retry_count,
                                started,
                            )?;
                            return Ok(StreamCompletion::Cancelled(completion));
                        }
                        continue;
                    }
                    self.record(
                        &invocation_id,
                        "finished",
                        &request,
                        first_token_ms,
                        Some(&error),
                        None,
                        retry_count,
                        started,
                    )?;
                    return Err(error);
                }
                Err(_) => {
                    let error = if saw_delta {
                        gateway_error(
                            GatewayErrorKind::StreamInterrupted,
                            "模型流在输出后超时；为避免重复计费，本次不会自动重试",
                            false,
                            true,
                        )
                    } else {
                        gateway_error(
                            GatewayErrorKind::Timeout,
                            "模型调用超过时间预算",
                            false,
                            false,
                        )
                    };
                    self.record(
                        &invocation_id,
                        "finished",
                        &request,
                        first_token_ms,
                        Some(&error),
                        None,
                        retry_count,
                        started,
                    )?;
                    return Err(error);
                }
            }
        }
    }

    fn record(
        &self,
        invocation_id: &str,
        phase: &str,
        request: &InvocationRequest<'_>,
        first_token_ms: Option<u64>,
        error: Option<&GatewayError>,
        completion: Option<&ModelCompletion>,
        retry_count: u8,
        started: Instant,
    ) -> Result<(), GatewayError> {
        let record = UsageRecord {
            invocation_id,
            phase,
            provider: &request.model.provider,
            model: &request.model.model_id,
            purpose: request.context.purpose,
            session_id: &request.context.session_id,
            turn_id: &request.context.turn_id,
            input_tokens: completion.map_or(0, |value| value.input_tokens),
            output_tokens: completion.map_or(0, |value| value.output_tokens),
            cache_tokens: completion.map_or(0, |value| value.cache_tokens),
            first_token_ms,
            duration_ms: elapsed_ms(started),
            retry_count,
            outcome: if phase == "started" {
                "started"
            } else if completion.and_then(|value| value.finish_reason.as_deref())
                == Some("cancelled")
            {
                "cancelled"
            } else {
                error.map_or("success", |value| value.code())
            },
            error_code: error.map(GatewayError::code),
            retryable: error.is_some_and(|value| value.retryable),
            uncertain: error.is_some_and(|value| value.uncertain),
            timestamp_ms: now_ms(),
        };
        let value = serde_json::to_value(record).map_err(|error| {
            gateway_error(
                GatewayErrorKind::LedgerFailure,
                &format!("无法编码模型用量账本: {error}"),
                false,
                false,
            )
        })?;
        self.ledger.append(&value).map_err(|message| {
            gateway_error(GatewayErrorKind::LedgerFailure, &message, false, false)
        })
    }
}

fn gateway_error(
    kind: GatewayErrorKind,
    message: &str,
    retryable: bool,
    uncertain: bool,
) -> GatewayError {
    GatewayError {
        kind,
        message: message.to_string(),
        retryable,
        uncertain,
    }
}

fn cancelled_completion() -> ModelCompletion {
    ModelCompletion {
        text: String::new(),
        input_tokens: 0,
        output_tokens: 0,
        cache_tokens: 0,
        finish_reason: Some("cancelled".into()),
        tool_calls: Vec::new(),
    }
}

fn classify_error(message: &str, saw_delta: bool) -> GatewayError {
    if saw_delta {
        return gateway_error(
            GatewayErrorKind::StreamInterrupted,
            "模型流在输出后中断；为避免重复计费，本次不会自动重试",
            false,
            true,
        );
    }
    if message.contains(" 429:") {
        return gateway_error(GatewayErrorKind::RateLimited, message, true, false);
    }
    if (500..=599).any(|status| message.contains(&format!(" {status}:"))) {
        return gateway_error(GatewayErrorKind::ProviderUnavailable, message, true, false);
    }
    if message.contains("无法连接模型服务") || message.contains("读取模型流式响应失败")
    {
        return gateway_error(GatewayErrorKind::Transport, message, true, false);
    }
    if message.contains("无效") || message.contains("不支持的原生模型协议") {
        return gateway_error(
            GatewayErrorKind::InvalidConfiguration,
            message,
            false,
            false,
        );
    }
    if message.contains("无法解析") || message.contains("缺少文本内容") {
        return gateway_error(GatewayErrorKind::InvalidResponse, message, false, false);
    }
    gateway_error(GatewayErrorKind::ProviderRejected, message, false, false)
}

fn redact_secret(message: &str, secret: &str) -> String {
    if secret.is_empty() {
        message.to_string()
    } else {
        message.replace(secret, "[REDACTED]")
    }
}

fn validated_proxy_url(value: &str) -> Result<Url, String> {
    let url = Url::parse(value).map_err(|_| "模型代理地址无效".to_string())?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("模型代理只支持 HTTP 或 HTTPS".into());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("模型代理地址不得包含凭据".into());
    }
    if url.host_str().is_none() {
        return Err("模型代理地址缺少主机".into());
    }
    Ok(url)
}

fn should_retry(error: &GatewayError, saw_delta: bool, retry_count: u8) -> bool {
    !saw_delta && error.retryable && retry_count < MAX_PRE_DELTA_RETRIES
}

async fn wait_for_retry(mut cancel: watch::Receiver<bool>) -> bool {
    if *cancel.borrow() {
        return true;
    }
    if cancel.has_changed().is_err() {
        tokio::time::sleep(RETRY_DELAY).await;
        return false;
    }
    tokio::select! {
        _ = tokio::time::sleep(RETRY_DELAY) => false,
        changed = cancel.changed() => changed.is_ok() && *cancel.borrow(),
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn elapsed_ms(started: Instant) -> u64 {
    started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64
}

fn next_invocation_id() -> String {
    format!(
        "invocation-{timestamp:x}-{sequence:x}",
        timestamp = now_ms(),
        sequence = INVOCATION_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    #[derive(Default)]
    struct MemoryCredentials(Mutex<HashMap<String, String>>);

    impl CredentialStore for MemoryCredentials {
        fn set(&self, credential_id: &str, api_key: &str) -> Result<(), String> {
            self.0
                .lock()
                .unwrap()
                .insert(credential_id.to_string(), api_key.to_string());
            Ok(())
        }

        fn get(&self, credential_id: &str) -> Result<String, String> {
            self.0
                .lock()
                .unwrap()
                .get(credential_id)
                .cloned()
                .ok_or_else(|| "missing".to_string())
        }

        fn delete(&self, credential_id: &str) -> Result<(), String> {
            self.0.lock().unwrap().remove(credential_id);
            Ok(())
        }
    }

    #[derive(Default)]
    struct MemoryLedger(Mutex<Vec<serde_json::Value>>);

    impl UsageLedger for MemoryLedger {
        fn append(&self, value: &serde_json::Value) -> Result<(), String> {
            self.0.lock().unwrap().push(value.clone());
            Ok(())
        }
    }

    fn test_model() -> NativeModel {
        NativeModel {
            id: "test".into(),
            display_name: "Test".into(),
            provider: "openai".into(),
            base_url: "https://unreachable.invalid".into(),
            model_id: "test".into(),
            max_tokens: None,
            enabled: true,
            credential_id: "credential-test".into(),
        }
    }

    #[tokio::test]
    async fn missing_credentials_are_typed_and_audited_without_secret_fields() {
        let ledger = Arc::new(MemoryLedger::default());
        let gateway = ModelInvocationGateway::with_ledger(
            Arc::new(MemoryCredentials::default()),
            ledger.clone(),
        );
        let (_, cancel) = watch::channel(false);
        let model = test_model();
        let error = gateway
            .invoke(
                InvocationRequest {
                    model: &model,
                    messages: &[],
                    tools: &[],
                    context: InvocationContext::new(
                        "session-1",
                        "turn-1",
                        InvocationPurpose::Agent,
                    ),
                },
                cancel,
                |_| Ok(()),
            )
            .await
            .unwrap_err();
        assert_eq!(error.kind, GatewayErrorKind::CredentialMissing);
        assert_eq!(error.code(), "model_credential_missing");
        let records = ledger.0.lock().unwrap();
        assert_eq!(records.len(), 2);
        let serialized = serde_json::to_string(&*records).unwrap();
        assert!(!serialized.contains("apiKey"));
        assert!(!serialized.contains("credential-test"));
    }

    #[tokio::test]
    async fn cancellation_before_dispatch_is_a_terminal_non_error_outcome() {
        let ledger = Arc::new(MemoryLedger::default());
        let gateway = ModelInvocationGateway::with_ledger(
            Arc::new(MemoryCredentials::default()),
            ledger.clone(),
        );
        let (sender, cancel) = watch::channel(false);
        sender.send_replace(true);
        let model = test_model();
        let result = gateway
            .invoke(
                InvocationRequest {
                    model: &model,
                    messages: &[],
                    tools: &[],
                    context: InvocationContext::new(
                        "session-1",
                        "turn-1",
                        InvocationPurpose::Agent,
                    ),
                },
                cancel,
                |_| Ok(()),
            )
            .await
            .unwrap();
        assert!(matches!(result, StreamCompletion::Cancelled(_)));
        let records = ledger.0.lock().unwrap();
        assert_eq!(records.len(), 2);
        assert_eq!(records[1]["outcome"], "cancelled");
    }

    #[tokio::test]
    async fn closed_cancellation_channel_keeps_the_retry_backoff() {
        let (sender, cancel) = watch::channel(false);
        drop(sender);
        let started = Instant::now();
        assert!(!wait_for_retry(cancel).await);
        assert!(started.elapsed() >= RETRY_DELAY);
    }

    #[test]
    fn retries_only_before_the_first_user_visible_delta() {
        let retryable = gateway_error(GatewayErrorKind::Transport, "offline", true, false);
        assert!(should_retry(&retryable, false, 0));
        assert!(!should_retry(&retryable, true, 0));
        assert!(!should_retry(&retryable, false, MAX_PRE_DELTA_RETRIES));
        let interrupted = classify_error("socket closed", true);
        assert_eq!(interrupted.kind, GatewayErrorKind::StreamInterrupted);
        assert!(interrupted.uncertain);
        assert!(!interrupted.retryable);
        assert_eq!(
            redact_secret("provider echoed secret-value", "secret-value"),
            "provider echoed [REDACTED]"
        );
    }

    #[test]
    fn proxy_configuration_is_explicit_and_credential_free() {
        assert_eq!(
            validated_proxy_url("http://127.0.0.1:7890")
                .unwrap()
                .as_str(),
            "http://127.0.0.1:7890/"
        );
        assert!(validated_proxy_url("socks5://127.0.0.1:7890").is_err());
        assert!(validated_proxy_url("https://user:secret@proxy.example.com").is_err());
    }

    #[tokio::test]
    #[ignore = "requires explicit opt-in, public provider access, and a system-keyring credential"]
    async fn completes_real_provider_smoke_from_the_system_keyring() {
        assert_eq!(
            std::env::var("CLAWMASTER_REAL_MODEL_SMOKE").as_deref(),
            Ok("1"),
            "set CLAWMASTER_REAL_MODEL_SMOKE=1 only when a real provider call is intended"
        );
        let config_path = std::env::var_os("CLAWMASTER_REAL_MODEL_SMOKE_CONFIG")
            .map(PathBuf::from)
            .expect(
                "set CLAWMASTER_REAL_MODEL_SMOKE_CONFIG to a secret-free NativeModel JSON file",
            );
        let model: NativeModel = serde_json::from_slice(
            &fs::read(config_path).expect("read secret-free real model smoke config"),
        )
        .expect("parse real model smoke config");
        assert!(model.enabled, "real model smoke route must be enabled");

        let temp = tempfile::tempdir().expect("create smoke ledger directory");
        let gateway = ModelInvocationGateway::new(
            crate::native_models::system_credential_store(),
            &temp.path().join("model-usage.jsonl"),
        )
        .expect("create real model gateway");
        let messages = vec![ModelMessage {
            role: "user".into(),
            text: "Reply with exactly: ClawMaster provider smoke passed".into(),
        }];
        let (_, cancel) = watch::channel(false);
        let mut text_delta_count = 0usize;
        let completion = gateway
            .invoke(
                InvocationRequest {
                    model: &model,
                    messages: &messages,
                    tools: &[],
                    context: InvocationContext::new(
                        "provider-smoke-session",
                        "provider-smoke-turn",
                        InvocationPurpose::Agent,
                    ),
                },
                cancel,
                |event| {
                    if matches!(event, ModelStreamEvent::Text(_)) {
                        text_delta_count += 1;
                    }
                    Ok(())
                },
            )
            .await
            .expect("real provider invocation failed");
        let StreamCompletion::Completed(completion) = completion else {
            panic!("real provider invocation was cancelled");
        };
        assert!(text_delta_count > 0, "provider produced no text delta");
        assert!(
            !completion.text.trim().is_empty(),
            "provider produced no complete reply"
        );
        let ledger = fs::read_to_string(temp.path().join("model-usage.jsonl"))
            .expect("read real provider usage ledger");
        assert!(ledger.contains("\"phase\":\"finished\""));
        assert!(ledger.contains("\"outcome\":\"success\""));
    }
}
