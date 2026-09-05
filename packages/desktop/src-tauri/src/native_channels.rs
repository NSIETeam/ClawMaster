use crate::native_models::{system_credential_store, CredentialStore};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

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

fn secret_id(provider: &str) -> String {
    format!("native-channel-{provider}-app-secret")
}

fn parse_token(provider: &str, body: &Value) -> Result<(), String> {
    let token = match provider {
        "feishu" | "lark" => body.get("tenant_access_token"),
        "wecom" => body.get("access_token"),
        "dingtalk" => body.get("accessToken"),
        _ => None,
    }
    .and_then(Value::as_str)
    .unwrap_or("");
    if !token.is_empty() {
        return Ok(());
    }
    let detail = body
        .get("msg")
        .or_else(|| body.get("errmsg"))
        .or_else(|| body.get("message"))
        .and_then(Value::as_str)
        .unwrap_or("平台未返回 access token");
    Err(format!("凭据验证失败：{detail}"))
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
        })
    }

    fn persist(&self, configs: &HashMap<String, ChannelConfig>) -> Result<(), String> {
        let bytes = serde_json::to_vec_pretty(configs).map_err(|error| error.to_string())?;
        let temporary = self.path.with_extension("json.tmp");
        fs::write(&temporary, bytes).map_err(|error| format!("无法写入消息配置: {error}"))?;
        fs::rename(&temporary, &self.path).map_err(|error| format!("无法提交消息配置: {error}"))
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
pub async fn channel_config_save(
    input: SaveRequest,
    state: tauri::State<'_, NativeChannelState>,
) -> Result<ChannelConfig, String> {
    let provider = validate_provider(&input.provider)?.to_string();
    let app_id = clean(&input.app_id, "App ID / Corp ID")?;
    let app_secret = clean(&input.app_secret, "App Secret")?;
    let agent_id = input.agent_id.as_deref().map(|value| clean(value, "Agent ID")).transpose()?;
    if provider == "wecom" && agent_id.is_none() {
        return Err("企业微信需要 Agent ID".into());
    }
    let response = match provider.as_str() {
        "feishu" | "lark" => {
            let host = if provider == "lark" { "https://open.larksuite.com" } else { "https://open.feishu.cn" };
            state.http.post(format!("{host}/open-apis/auth/v3/tenant_access_token/internal"))
                .json(&json!({"app_id":app_id,"app_secret":app_secret})).send().await
        }
        "wecom" => {
            let mut endpoint = url::Url::parse("https://qyapi.weixin.qq.com/cgi-bin/gettoken")
                .map_err(|error| format!("企业微信鉴权地址无效: {error}"))?;
            endpoint.query_pairs_mut().append_pair("corpid", &app_id)
                .append_pair("corpsecret", &app_secret);
            state.http.get(endpoint).send().await
        },
        "dingtalk" => state.http.post("https://api.dingtalk.com/v1.0/oauth2/accessToken")
            .json(&json!({"appKey":app_id,"appSecret":app_secret})).send().await,
        _ => unreachable!(),
    }.map_err(|error| format!("连接平台失败: {error}"))?;
    let status = response.status();
    let body: Value = response.json().await.map_err(|error| format!("平台响应无效: {error}"))?;
    if !status.is_success() { return Err(format!("平台返回 HTTP {status}")); }
    parse_token(&provider, &body)?;
    state.credentials.set(&secret_id(&provider), &app_secret)?;
    let config = ChannelConfig { provider: provider.clone(), app_id, agent_id, verified_at: chrono::Utc::now().to_rfc3339() };
    let mut configs = state.configs.lock().map_err(|_| "企业消息配置锁不可用".to_string())?;
    configs.insert(provider, config.clone());
    state.persist(&configs)?;
    Ok(config)
}

#[tauri::command]
pub fn channel_config_clear(
    provider: String,
    state: tauri::State<'_, NativeChannelState>,
) -> Result<(), String> {
    let provider = validate_provider(&provider)?.to_string();
    state.credentials.delete(&secret_id(&provider))?;
    let mut configs = state.configs.lock().map_err(|_| "企业消息配置锁不可用".to_string())?;
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
    }
}
