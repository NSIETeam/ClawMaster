use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::Arc;
use tokio::sync::watch;
use url::Url;

const KEYRING_SERVICE: &str = "com.nsieteam.clawmaster.models";

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeModel {
    pub id: String,
    pub display_name: String,
    pub provider: String,
    pub base_url: String,
    pub model_id: String,
    pub max_tokens: Option<u32>,
    pub enabled: bool,
    pub credential_id: String,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ModelMessage {
    pub role: String,
    pub text: String,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ModelCompletion {
    pub text: String,
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub finish_reason: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub enum ModelStreamEvent {
    Text(String),
    Reasoning(String),
}

#[derive(Clone, Debug, PartialEq)]
pub enum StreamCompletion {
    Completed(ModelCompletion),
    Cancelled(ModelCompletion),
}

#[derive(Default)]
struct StreamState {
    text: String,
    input_tokens: u64,
    output_tokens: u64,
    finish_reason: Option<String>,
}

fn push_text(events: &mut Vec<ModelStreamEvent>, state: &mut StreamState, value: Option<&str>) {
    if let Some(delta) = value.filter(|delta| !delta.is_empty()) {
        state.text.push_str(delta);
        events.push(ModelStreamEvent::Text(delta.to_string()));
    }
}

fn push_reasoning(events: &mut Vec<ModelStreamEvent>, value: Option<&str>) {
    if let Some(delta) = value.filter(|delta| !delta.is_empty()) {
        events.push(ModelStreamEvent::Reasoning(delta.to_string()));
    }
}

impl NativeModel {
    pub fn public_value(&self) -> Value {
        json!({
            "id": self.id,
            "displayName": self.display_name,
            "provider": self.provider,
            "baseUrl": self.base_url,
            "modelId": self.model_id,
            "maxTokens": self.max_tokens,
            "enabled": self.enabled,
            "source": "byok",
            "managed": false,
        })
    }
}

pub trait CredentialStore: Send + Sync {
    fn set(&self, credential_id: &str, api_key: &str) -> Result<(), String>;
    fn get(&self, credential_id: &str) -> Result<String, String>;
    fn delete(&self, credential_id: &str) -> Result<(), String>;
}

pub struct KeyringCredentialStore;

impl CredentialStore for KeyringCredentialStore {
    fn set(&self, credential_id: &str, api_key: &str) -> Result<(), String> {
        if api_key.trim().is_empty() {
            return Err("API key 不能为空".into());
        }
        keyring::Entry::new(KEYRING_SERVICE, credential_id)
            .map_err(|error| format!("无法访问系统凭据库: {error}"))?
            .set_password(api_key)
            .map_err(|error| format!("无法保存模型凭据: {error}"))
    }

    fn get(&self, credential_id: &str) -> Result<String, String> {
        keyring::Entry::new(KEYRING_SERVICE, credential_id)
            .map_err(|error| format!("无法访问系统凭据库: {error}"))?
            .get_password()
            .map_err(|_| "模型凭据不存在，请重新配置 API key".to_string())
    }

    fn delete(&self, credential_id: &str) -> Result<(), String> {
        let entry = keyring::Entry::new(KEYRING_SERVICE, credential_id)
            .map_err(|error| format!("无法访问系统凭据库: {error}"))?;
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(error) => Err(format!("无法删除模型凭据: {error}")),
        }
    }
}

pub fn system_credential_store() -> Arc<dyn CredentialStore> {
    Arc::new(KeyringCredentialStore)
}

fn endpoint(base_url: &str, suffix: &str) -> Result<Url, String> {
    let mut base = Url::parse(base_url).map_err(|_| "模型 API 地址无效".to_string())?;
    if base.scheme() != "https" || !base.username().is_empty() || base.password().is_some() {
        return Err("模型 API 必须使用不含内嵌凭据的 HTTPS 地址".into());
    }
    if base.path().ends_with(suffix) {
        return Ok(base);
    }
    let path = format!(
        "{}/{}",
        base.path().trim_end_matches('/'),
        suffix.trim_start_matches('/')
    );
    base.set_path(&path);
    Ok(base)
}

async fn checked_json(response: reqwest::Response) -> Result<Value, String> {
    let status = response.status();
    let value = response
        .json::<Value>()
        .await
        .map_err(|error| format!("无法解析模型响应: {error}"))?;
    if status.is_success() {
        return Ok(value);
    }
    let message = value
        .pointer("/error/message")
        .and_then(Value::as_str)
        .unwrap_or("模型服务请求失败");
    Err(format!("模型服务返回 {}: {message}", status.as_u16()))
}

fn parse_stream_data(
    provider: &str,
    data: &str,
    state: &mut StreamState,
) -> Result<Vec<ModelStreamEvent>, String> {
    if data == "[DONE]" {
        return Ok(Vec::new());
    }
    let value: Value =
        serde_json::from_str(data).map_err(|error| format!("无法解析模型流式响应: {error}"))?;
    let mut events = Vec::new();
    match provider {
        "openai" => {
            push_text(
                &mut events,
                state,
                value
                    .pointer("/choices/0/delta/content")
                    .and_then(Value::as_str),
            );
            push_reasoning(
                &mut events,
                value
                    .pointer("/choices/0/delta/reasoning_content")
                    .and_then(Value::as_str),
            );
            state.finish_reason = value
                .pointer("/choices/0/finish_reason")
                .and_then(Value::as_str)
                .map(str::to_owned)
                .or_else(|| state.finish_reason.take());
            state.input_tokens = value
                .pointer("/usage/prompt_tokens")
                .and_then(Value::as_u64)
                .unwrap_or(state.input_tokens);
            state.output_tokens = value
                .pointer("/usage/completion_tokens")
                .and_then(Value::as_u64)
                .unwrap_or(state.output_tokens);
        }
        "openai-responses" => match value.get("type").and_then(Value::as_str) {
            Some("response.output_text.delta") => push_text(
                &mut events,
                state,
                value.get("delta").and_then(Value::as_str),
            ),
            Some("response.reasoning_text.delta") => {
                push_reasoning(&mut events, value.get("delta").and_then(Value::as_str))
            }
            Some("response.completed") => {
                state.input_tokens = value
                    .pointer("/response/usage/input_tokens")
                    .and_then(Value::as_u64)
                    .unwrap_or(state.input_tokens);
                state.output_tokens = value
                    .pointer("/response/usage/output_tokens")
                    .and_then(Value::as_u64)
                    .unwrap_or(state.output_tokens);
                state.finish_reason = Some("stop".into());
            }
            _ => {}
        },
        "anthropic" => match value.get("type").and_then(Value::as_str) {
            Some("content_block_delta") => {
                match value.pointer("/delta/type").and_then(Value::as_str) {
                    Some("text_delta") => push_text(
                        &mut events,
                        state,
                        value.pointer("/delta/text").and_then(Value::as_str),
                    ),
                    Some("thinking_delta") => push_reasoning(
                        &mut events,
                        value.pointer("/delta/thinking").and_then(Value::as_str),
                    ),
                    _ => {}
                }
            }
            Some("message_start") => {
                state.input_tokens = value
                    .pointer("/message/usage/input_tokens")
                    .and_then(Value::as_u64)
                    .unwrap_or(state.input_tokens);
            }
            Some("message_delta") => {
                state.output_tokens = value
                    .pointer("/usage/output_tokens")
                    .and_then(Value::as_u64)
                    .unwrap_or(state.output_tokens);
                state.finish_reason = value
                    .pointer("/delta/stop_reason")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
                    .or_else(|| state.finish_reason.take());
            }
            _ => {}
        },
        "gemini" => {
            if let Some(parts) = value
                .pointer("/candidates/0/content/parts")
                .and_then(Value::as_array)
            {
                for part in parts {
                    push_text(&mut events, state, part.get("text").and_then(Value::as_str));
                }
            }
            state.input_tokens = value
                .pointer("/usageMetadata/promptTokenCount")
                .and_then(Value::as_u64)
                .unwrap_or(state.input_tokens);
            state.output_tokens = value
                .pointer("/usageMetadata/candidatesTokenCount")
                .and_then(Value::as_u64)
                .unwrap_or(state.output_tokens);
            state.finish_reason = value
                .pointer("/candidates/0/finishReason")
                .and_then(Value::as_str)
                .map(str::to_owned)
                .or_else(|| state.finish_reason.take());
        }
        _ => return Err(format!("不支持的原生模型协议: {provider}")),
    }
    Ok(events)
}

fn consume_sse_buffer<F>(
    provider: &str,
    buffer: &mut String,
    state: &mut StreamState,
    on_event: &mut F,
) -> Result<(), String>
where
    F: FnMut(ModelStreamEvent) -> Result<(), String>,
{
    while let Some(boundary) = buffer.find("\n\n") {
        let block = buffer[..boundary].to_string();
        buffer.drain(..boundary + 2);
        let data = block
            .lines()
            .filter_map(|line| line.strip_prefix("data:"))
            .map(str::trim_start)
            .collect::<Vec<_>>()
            .join("\n");
        if data.is_empty() {
            continue;
        }
        for event in parse_stream_data(provider, &data, state)? {
            on_event(event)?;
        }
    }
    Ok(())
}

fn consume_sse_bytes<F>(
    provider: &str,
    buffer: &mut Vec<u8>,
    state: &mut StreamState,
    on_event: &mut F,
) -> Result<(), String>
where
    F: FnMut(ModelStreamEvent) -> Result<(), String>,
{
    loop {
        let boundary = buffer
            .windows(4)
            .position(|window| window == b"\r\n\r\n")
            .map(|index| (index, 4))
            .or_else(|| {
                buffer
                    .windows(2)
                    .position(|window| window == b"\n\n")
                    .map(|index| (index, 2))
            });
        let Some((index, separator_len)) = boundary else {
            return Ok(());
        };
        let block = String::from_utf8(buffer[..index].to_vec())
            .map_err(|_| "模型流式响应不是有效 UTF-8".to_string())?;
        buffer.drain(..index + separator_len);
        let mut normalized = block.replace("\r\n", "\n");
        normalized.push_str("\n\n");
        consume_sse_buffer(provider, &mut normalized, state, on_event)?;
    }
}

pub async fn stream_complete<F>(
    client: &Client,
    model: &NativeModel,
    api_key: &str,
    messages: &[ModelMessage],
    mut cancel: watch::Receiver<bool>,
    mut on_event: F,
) -> Result<StreamCompletion, String>
where
    F: FnMut(ModelStreamEvent) -> Result<(), String>,
{
    let response = match model.provider.as_str() {
        "openai" => client
            .post(endpoint(&model.base_url, "chat/completions")?)
            .bearer_auth(api_key)
            .json(&json!({
                "model":model.model_id,"messages":messages.iter().map(|item| json!({"role":item.role,"content":item.text})).collect::<Vec<_>>(),
                "stream":true,"stream_options":{"include_usage":true}
            }))
            .send(),
        "openai-responses" => client
            .post(endpoint(&model.base_url, "responses")?)
            .bearer_auth(api_key)
            .json(&json!({
                "model":model.model_id,"input":messages.iter().map(|item| json!({"role":item.role,"content":item.text})).collect::<Vec<_>>(),"stream":true
            }))
            .send(),
        "anthropic" => client
            .post(endpoint(&model.base_url, "v1/messages")?)
            .header("x-api-key", api_key)
            .header("anthropic-version", "2023-06-01")
            .json(&json!({
                "model":model.model_id,"max_tokens":model.max_tokens.unwrap_or(4096).min(32_768),
                "messages":messages.iter().filter(|item| item.role != "system").map(|item| json!({"role":item.role,"content":item.text})).collect::<Vec<_>>(),"stream":true
            }))
            .send(),
        "gemini" => {
            let suffix = format!("v1beta/models/{}:streamGenerateContent", model.model_id);
            let mut url = endpoint(&model.base_url, &suffix)?;
            url.query_pairs_mut().append_pair("alt", "sse");
            client
                .post(url)
                .header("x-goog-api-key", api_key)
                .json(&json!({"contents":messages.iter().map(|item| json!({
                    "role":if item.role == "assistant" { "model" } else { "user" },"parts":[{"text":item.text}]
                })).collect::<Vec<_>>() }))
                .send()
        }
        _ => return Err(format!("不支持的原生模型协议: {}", model.provider)),
    }
    .await
    .map_err(|error| format!("无法连接模型服务: {error}"))?;

    if !response.status().is_success() {
        return Err(checked_json(response)
            .await
            .err()
            .unwrap_or_else(|| "模型服务请求失败".into()));
    }
    let mut response = response;
    let mut buffer = Vec::new();
    let mut state = StreamState::default();
    loop {
        tokio::select! {
            changed = cancel.changed() => {
                if changed.is_ok() && *cancel.borrow() {
                    return Ok(StreamCompletion::Cancelled(ModelCompletion {
                        text: state.text,
                        input_tokens: state.input_tokens,
                        output_tokens: state.output_tokens,
                        finish_reason: Some("cancelled".into()),
                    }));
                }
            }
            chunk = response.chunk() => {
                match chunk.map_err(|error| format!("读取模型流式响应失败: {error}"))? {
                    Some(bytes) => {
                        buffer.extend_from_slice(&bytes);
                        consume_sse_bytes(&model.provider, &mut buffer, &mut state, &mut on_event)?;
                    }
                    None => break,
                }
            }
        }
    }
    if !buffer.is_empty() {
        buffer.extend_from_slice(b"\n\n");
        consume_sse_bytes(&model.provider, &mut buffer, &mut state, &mut on_event)?;
    }
    if state.text.is_empty() {
        return Err("模型流式响应缺少文本内容".into());
    }
    Ok(StreamCompletion::Completed(ModelCompletion {
        text: state.text,
        input_tokens: state.input_tokens,
        output_tokens: state.output_tokens,
        finish_reason: state.finish_reason,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_secure_credential_free_model_urls() {
        assert_eq!(
            endpoint("https://api.deepseek.com", "chat/completions")
                .unwrap()
                .as_str(),
            "https://api.deepseek.com/chat/completions"
        );
        assert!(endpoint("http://api.example.com", "chat/completions").is_err());
        assert!(endpoint("https://user:key@example.com", "chat/completions").is_err());
    }

    #[test]
    fn parses_all_supported_stream_shapes() {
        let cases = [
            (
                "openai",
                r#"{"choices":[{"delta":{"content":"完成","reasoning_content":"分析"},"finish_reason":"stop"}],"usage":{"prompt_tokens":4,"completion_tokens":2}}"#,
                "完成",
            ),
            (
                "openai-responses",
                r#"{"type":"response.output_text.delta","delta":"完成"}"#,
                "完成",
            ),
            (
                "anthropic",
                r#"{"type":"content_block_delta","delta":{"type":"text_delta","text":"完成"}}"#,
                "完成",
            ),
            (
                "gemini",
                r#"{"candidates":[{"content":{"parts":[{"text":"完成"}]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":3,"candidatesTokenCount":1}}"#,
                "完成",
            ),
        ];
        for (provider, data, expected) in cases {
            let mut state = StreamState::default();
            let events = parse_stream_data(provider, data, &mut state).unwrap();
            assert_eq!(state.text, expected);
            assert!(events.contains(&ModelStreamEvent::Text(expected.into())));
        }
    }

    #[test]
    fn preserves_utf8_split_across_network_chunks_and_crlf_frames() {
        let payload =
            b"data: {\"choices\":[{\"delta\":{\"content\":\"\xe5\xae\x8c\xe6\x88\x90\"}}]}\r\n\r\n";
        let split = payload.iter().position(|byte| *byte == 0xe6).unwrap() + 1;
        let mut buffer = payload[..split].to_vec();
        let mut state = StreamState::default();
        let mut events = Vec::new();
        consume_sse_bytes("openai", &mut buffer, &mut state, &mut |event| {
            events.push(event);
            Ok(())
        })
        .unwrap();
        assert!(events.is_empty());
        buffer.extend_from_slice(&payload[split..]);
        consume_sse_bytes("openai", &mut buffer, &mut state, &mut |event| {
            events.push(event);
            Ok(())
        })
        .unwrap();
        assert_eq!(state.text, "完成");
        assert_eq!(events, vec![ModelStreamEvent::Text("完成".into())]);
    }
}
