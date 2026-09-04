use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::Arc;
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

fn parse_openai_response(value: &Value) -> Result<ModelCompletion, String> {
    let text = value
        .pointer("/choices/0/message/content")
        .and_then(Value::as_str)
        .ok_or_else(|| "模型响应缺少文本内容".to_string())?;
    Ok(ModelCompletion {
        text: text.into(),
        input_tokens: value
            .pointer("/usage/prompt_tokens")
            .and_then(Value::as_u64)
            .unwrap_or(0),
        output_tokens: value
            .pointer("/usage/completion_tokens")
            .and_then(Value::as_u64)
            .unwrap_or(0),
        finish_reason: value
            .pointer("/choices/0/finish_reason")
            .and_then(Value::as_str)
            .map(str::to_owned),
    })
}

fn parse_anthropic_response(value: &Value) -> Result<ModelCompletion, String> {
    let text = value
        .get("content")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|part| part.get("text").and_then(Value::as_str))
        .collect::<String>();
    if text.is_empty() {
        return Err("模型响应缺少文本内容".into());
    }
    Ok(ModelCompletion {
        text,
        input_tokens: value
            .pointer("/usage/input_tokens")
            .and_then(Value::as_u64)
            .unwrap_or(0),
        output_tokens: value
            .pointer("/usage/output_tokens")
            .and_then(Value::as_u64)
            .unwrap_or(0),
        finish_reason: value
            .get("stop_reason")
            .and_then(Value::as_str)
            .map(str::to_owned),
    })
}

fn parse_gemini_response(value: &Value) -> Result<ModelCompletion, String> {
    let text = value
        .pointer("/candidates/0/content/parts")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|part| part.get("text").and_then(Value::as_str))
        .collect::<String>();
    if text.is_empty() {
        return Err("模型响应缺少文本内容".into());
    }
    Ok(ModelCompletion {
        text,
        input_tokens: value
            .pointer("/usageMetadata/promptTokenCount")
            .and_then(Value::as_u64)
            .unwrap_or(0),
        output_tokens: value
            .pointer("/usageMetadata/candidatesTokenCount")
            .and_then(Value::as_u64)
            .unwrap_or(0),
        finish_reason: value
            .pointer("/candidates/0/finishReason")
            .and_then(Value::as_str)
            .map(str::to_owned),
    })
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

pub async fn complete(
    client: &Client,
    model: &NativeModel,
    api_key: &str,
    messages: &[ModelMessage],
) -> Result<ModelCompletion, String> {
    let response = match model.provider.as_str() {
        "openai" => {
            let url = endpoint(&model.base_url, "chat/completions")?;
            client
                .post(url)
                .bearer_auth(api_key)
                .json(&json!({
                    "model": model.model_id,
                    "messages": messages.iter().map(|item| json!({"role":item.role,"content":item.text})).collect::<Vec<_>>(),
                    "stream": false,
                }))
                .send()
                .await
        }
        "openai-responses" => {
            let url = endpoint(&model.base_url, "responses")?;
            client
                .post(url)
                .bearer_auth(api_key)
                .json(&json!({
                    "model": model.model_id,
                    "input": messages.iter().map(|item| json!({"role":item.role,"content":item.text})).collect::<Vec<_>>(),
                }))
                .send()
                .await
        }
        "anthropic" => {
            let url = endpoint(&model.base_url, "v1/messages")?;
            client
                .post(url)
                .header("x-api-key", api_key)
                .header("anthropic-version", "2023-06-01")
                .json(&json!({
                    "model": model.model_id,
                    "max_tokens": model.max_tokens.unwrap_or(4096).min(32_768),
                    "messages": messages.iter().filter(|item| item.role != "system").map(|item| json!({"role":item.role,"content":item.text})).collect::<Vec<_>>(),
                }))
                .send()
                .await
        }
        "gemini" => {
            let suffix = format!("v1beta/models/{}:generateContent", model.model_id);
            let mut url = endpoint(&model.base_url, &suffix)?;
            url.query_pairs_mut().append_pair("key", api_key);
            client
                .post(url)
                .json(&json!({
                    "contents": messages.iter().map(|item| json!({
                        "role": if item.role == "assistant" { "model" } else { "user" },
                        "parts": [{"text":item.text}]
                    })).collect::<Vec<_>>()
                }))
                .send()
                .await
        }
        _ => return Err(format!("不支持的原生模型协议: {}", model.provider)),
    }
    .map_err(|error| format!("无法连接模型服务: {error}"))?;
    let value = checked_json(response).await?;
    match model.provider.as_str() {
        "openai" => parse_openai_response(&value),
        "openai-responses" => {
            let text = value
                .get("output_text")
                .and_then(Value::as_str)
                .ok_or_else(|| "模型响应缺少 output_text".to_string())?;
            Ok(ModelCompletion {
                text: text.into(),
                input_tokens: value
                    .pointer("/usage/input_tokens")
                    .and_then(Value::as_u64)
                    .unwrap_or(0),
                output_tokens: value
                    .pointer("/usage/output_tokens")
                    .and_then(Value::as_u64)
                    .unwrap_or(0),
                finish_reason: Some("stop".into()),
            })
        }
        "anthropic" => parse_anthropic_response(&value),
        "gemini" => parse_gemini_response(&value),
        _ => unreachable!(),
    }
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
    fn parses_supported_provider_responses_without_exposing_credentials() {
        let openai = parse_openai_response(&json!({
            "choices":[{"message":{"content":"完成"},"finish_reason":"stop"}],
            "usage":{"prompt_tokens":4,"completion_tokens":2}
        }))
        .unwrap();
        assert_eq!(openai.text, "完成");
        assert_eq!(openai.input_tokens, 4);
        let anthropic = parse_anthropic_response(&json!({
            "content":[{"type":"text","text":"已完成"}],
            "usage":{"input_tokens":3,"output_tokens":1}
        }))
        .unwrap();
        assert_eq!(anthropic.text, "已完成");
        let gemini = parse_gemini_response(&json!({
            "candidates":[{"content":{"parts":[{"text":"好了"}]}}]
        }))
        .unwrap();
        assert_eq!(gemini.text, "好了");
    }
}
