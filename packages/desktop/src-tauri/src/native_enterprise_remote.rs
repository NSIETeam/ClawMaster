use crate::native_models::{credential_store_for_service, CredentialStore};
use reqwest::{Client, Method, StatusCode};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;
use url::Url;

const SESSION_CREDENTIAL_ID: &str = "native-enterprise-remote-session-v1";
const ENTERPRISE_KEYRING_SERVICE: &str = "com.nsieteam.clawmaster.enterprise";
const MAX_RESPONSE_BYTES: usize = 2 * 1024 * 1024;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct StoredSession {
    server_url: String,
    token: String,
    account: Value,
}

#[derive(Debug, Deserialize)]
struct LoginResponse {
    account: Value,
    token: String,
    #[serde(rename = "expiresAt")]
    expires_at: String,
}

#[derive(Debug, Deserialize)]
struct BriefResponse {
    brief: Value,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HealthResponse {
    status: String,
    api_version: u64,
    capabilities: Vec<String>,
}

pub struct NativeEnterpriseRemote {
    http: Client,
    credentials: Arc<dyn CredentialStore>,
    auth_generation: AtomicU64,
}

impl NativeEnterpriseRemote {
    pub fn system() -> Result<Self, String> {
        let http = Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(10))
            .build()
            .map_err(|error| format!("无法初始化企业网络客户端: {error}"))?;
        Ok(Self {
            http,
            credentials: credential_store_for_service(ENTERPRISE_KEYRING_SERVICE),
            auth_generation: AtomicU64::new(0),
        })
    }

    #[cfg(test)]
    fn with_credentials(credentials: Arc<dyn CredentialStore>) -> Self {
        Self {
            http: Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .unwrap(),
            credentials,
            auth_generation: AtomicU64::new(0),
        }
    }

    fn load_session(&self) -> Result<StoredSession, String> {
        let encoded = self
            .credentials
            .get(SESSION_CREDENTIAL_ID)
            .map_err(|_| "登录已失效，请重新登录".to_string())?;
        let session: StoredSession = serde_json::from_str(&encoded)
            .map_err(|_| "企业登录凭据损坏，请重新登录".to_string())?;
        validate_session(&session)?;
        Ok(session)
    }

    fn save_session(&self, session: &StoredSession) -> Result<(), String> {
        validate_session(session)?;
        let encoded = serde_json::to_string(session)
            .map_err(|error| format!("无法序列化企业会话: {error}"))?;
        self.credentials.set(SESSION_CREDENTIAL_ID, &encoded)
    }

    fn begin_auth(&self) -> u64 {
        self.auth_generation.fetch_add(1, Ordering::AcqRel) + 1
    }

    fn auth_is_current(&self, generation: u64) -> bool {
        self.auth_generation.load(Ordering::Acquire) == generation
    }

    async fn request_json(
        &self,
        method: Method,
        server_url: &str,
        path: &str,
        token: Option<&str>,
        body: Option<Value>,
    ) -> Result<(StatusCode, Value), String> {
        let endpoint = endpoint(server_url, path)?;
        let mut request = self
            .http
            .request(method, endpoint)
            .header(reqwest::header::ACCEPT, "application/json");
        if let Some(token) = token {
            request = request.bearer_auth(token);
        }
        if let Some(body) = body {
            request = request.json(&body);
        }
        let response = request
            .send()
            .await
            .map_err(|error| format!("无法连接企业服务器: {error}"))?;
        let status = response.status();
        let bytes = response
            .bytes()
            .await
            .map_err(|error| format!("无法读取企业服务器响应: {error}"))?;
        if bytes.len() > MAX_RESPONSE_BYTES {
            return Err("企业服务器响应超过 2 MiB 安全上限".into());
        }
        let value = serde_json::from_slice::<Value>(&bytes)
            .map_err(|_| "企业服务器返回了无效 JSON".to_string())?;
        Ok((status, value))
    }

    pub async fn login(
        &self,
        server_url: String,
        identifier: String,
        password: String,
    ) -> Result<Value, String> {
        let generation = self.begin_auth();
        let server_url = normalize_server_url(&server_url)?;
        if identifier.trim().is_empty() || password.is_empty() {
            return Err("请输入企业账号和密码".into());
        }
        let (health_status, health_value) = self
            .request_json(Method::GET, &server_url, "/enterprise/health", None, None)
            .await?;
        if !health_status.is_success() {
            return Err(response_error(health_status, &health_value));
        }
        let health: HealthResponse = serde_json::from_value(health_value)
            .map_err(|_| "企业服务器健康响应结构无效".to_string())?;
        if health.status != "ok"
            || health.api_version < 2
            || !health
                .capabilities
                .iter()
                .any(|item| item == "password_auth")
        {
            return Err("企业服务器版本过旧或功能不完整，请联系管理员升级后重试".into());
        }
        let (status, value) = self
            .request_json(
                Method::POST,
                &server_url,
                "/enterprise/auth/login",
                None,
                Some(json!({ "identifier": identifier.trim(), "password": password })),
            )
            .await?;
        if !status.is_success() {
            return Err(response_error(status, &value));
        }
        let response: LoginResponse =
            serde_json::from_value(value).map_err(|_| "企业登录响应缺少必要字段".to_string())?;
        let session = StoredSession {
            server_url: server_url.clone(),
            token: response.token,
            account: response.account.clone(),
        };
        if !self.auth_is_current(generation) {
            return Err("认证操作已被新的请求替代，请重试".into());
        }
        self.save_session(&session)?;
        Ok(json!({
            "serverUrl": server_url,
            "account": response.account,
            "expiresAt": response.expires_at,
        }))
    }

    pub fn session(&self) -> Value {
        match self.load_session() {
            Ok(session) => json!({ "serverUrl": session.server_url, "account": session.account }),
            Err(_) => json!({ "serverUrl": "", "account": null }),
        }
    }

    pub async fn brief(&self) -> Result<Value, String> {
        let session = self.load_session()?;
        let (status, value) = self
            .request_json(
                Method::GET,
                &session.server_url,
                "/enterprise/companyos/brief",
                Some(&session.token),
                None,
            )
            .await?;
        if status == StatusCode::UNAUTHORIZED {
            let _ = self.credentials.delete(SESSION_CREDENTIAL_ID);
            return Err("登录已失效，请重新登录".into());
        }
        if !status.is_success() {
            return Err(response_error(status, &value));
        }
        let response: BriefResponse =
            serde_json::from_value(value).map_err(|_| "企业经营简报响应缺少 brief".to_string())?;
        validate_brief(&response.brief)?;
        Ok(response.brief)
    }

    pub async fn logout(&self) -> Result<(), String> {
        self.begin_auth();
        if let Ok(session) = self.load_session() {
            let _ = self
                .request_json(
                    Method::POST,
                    &session.server_url,
                    "/enterprise/auth/logout",
                    Some(&session.token),
                    Some(json!({})),
                )
                .await;
        }
        self.credentials.delete(SESSION_CREDENTIAL_ID)
    }
}

fn normalize_server_url(input: &str) -> Result<String, String> {
    let mut url = Url::parse(input.trim()).map_err(|_| "服务器地址格式不正确".to_string())?;
    if !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("服务器地址不能包含账号、密码、查询参数或片段".into());
    }
    let loopback = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "::1"));
    if url.scheme() != "https" && !(url.scheme() == "http" && loopback) {
        return Err("公网企业服务器必须使用 HTTPS".into());
    }
    let path = url.path().trim_end_matches('/').to_string();
    url.set_path(&path);
    Ok(url.to_string().trim_end_matches('/').to_string())
}

fn endpoint(server_url: &str, suffix: &str) -> Result<Url, String> {
    let normalized = normalize_server_url(server_url)?;
    Url::parse(&format!("{normalized}/{}", suffix.trim_start_matches('/')))
        .map_err(|_| "企业接口地址无效".to_string())
}

fn validate_session(session: &StoredSession) -> Result<(), String> {
    normalize_server_url(&session.server_url)?;
    if session.token.trim().is_empty() || !session.account.is_object() {
        return Err("企业登录凭据损坏，请重新登录".into());
    }
    Ok(())
}

fn validate_brief(brief: &Value) -> Result<(), String> {
    let object = brief
        .as_object()
        .ok_or_else(|| "企业经营简报不是对象".to_string())?;
    let valid_status = matches!(
        object.get("status").and_then(Value::as_str),
        Some("known" | "partial" | "unknown")
    );
    let valid_array = |key: &str| object.get(key).is_some_and(Value::is_array);
    let Some(metrics) = object.get("metrics").and_then(Value::as_object) else {
        return Err("企业经营简报响应结构无效".into());
    };
    let valid_metric = |key: &str| {
        metrics
            .get(key)
            .and_then(Value::as_object)
            .is_some_and(|metric| {
                matches!(
                    metric.get("status").and_then(Value::as_str),
                    Some("known" | "partial" | "unknown")
                ) && metric.get("stale").is_some_and(Value::is_boolean)
                    && metric.get("evidenceRefs").is_some_and(Value::is_array)
                    && metric.get("sources").is_some_and(Value::is_array)
            })
    };
    if !valid_status
        || object
            .get("organizationId")
            .and_then(Value::as_str)
            .is_none()
        || object.get("generatedAt").and_then(Value::as_str).is_none()
        || !["revenue", "margin", "inventory", "cash", "growth"]
            .into_iter()
            .all(valid_metric)
        || ![
            "missing",
            "risks",
            "opportunities",
            "evidenceRefs",
            "invalidEvidenceRefs",
            "recommendedActions",
            "executedActions",
            "decisionsRequired",
        ]
        .into_iter()
        .all(valid_array)
    {
        return Err("企业经营简报响应结构无效".into());
    }
    Ok(())
}

fn response_error(status: StatusCode, value: &Value) -> String {
    value
        .get("error")
        .and_then(Value::as_str)
        .filter(|message| !message.trim().is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| format!("企业服务器返回 {status}"))
}

#[tauri::command]
pub fn enterprise_remote_session(state: tauri::State<'_, NativeEnterpriseRemote>) -> Value {
    state.session()
}

#[tauri::command]
pub async fn enterprise_remote_password_login(
    server_url: String,
    identifier: String,
    password: String,
    state: tauri::State<'_, NativeEnterpriseRemote>,
) -> Result<Value, String> {
    state.login(server_url, identifier, password).await
}

#[tauri::command]
pub async fn enterprise_remote_companyos_brief(
    state: tauri::State<'_, NativeEnterpriseRemote>,
) -> Result<Value, String> {
    state.brief().await
}

#[tauri::command]
pub async fn enterprise_remote_logout(
    state: tauri::State<'_, NativeEnterpriseRemote>,
) -> Result<(), String> {
    state.logout().await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::sync::Mutex;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::{TcpListener, TcpStream};

    #[derive(Default)]
    struct MemoryCredentials(Mutex<HashMap<String, String>>);

    impl CredentialStore for MemoryCredentials {
        fn set(&self, id: &str, value: &str) -> Result<(), String> {
            self.0.lock().unwrap().insert(id.into(), value.into());
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

    async fn read_request(stream: &mut TcpStream) -> String {
        let mut request = Vec::new();
        loop {
            let mut chunk = [0_u8; 2048];
            let read = stream.read(&mut chunk).await.unwrap();
            if read == 0 {
                break;
            }
            request.extend_from_slice(&chunk[..read]);
            let Some(header_end) = request.windows(4).position(|part| part == b"\r\n\r\n") else {
                continue;
            };
            let headers = String::from_utf8_lossy(&request[..header_end]);
            let content_length = headers
                .lines()
                .find_map(|line| {
                    line.to_ascii_lowercase()
                        .strip_prefix("content-length:")
                        .and_then(|value| value.trim().parse::<usize>().ok())
                })
                .unwrap_or(0);
            if request.len() >= header_end + 4 + content_length {
                break;
            }
        }
        String::from_utf8(request).unwrap()
    }

    async fn respond(stream: &mut TcpStream, body: &Value) {
        let body = body.to_string();
        let response = format!(
            "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
            body.len()
        );
        stream.write_all(response.as_bytes()).await.unwrap();
    }

    #[test]
    fn only_https_or_loopback_http_servers_are_accepted() {
        assert_eq!(
            normalize_server_url("https://company.test/api/").unwrap(),
            "https://company.test/api"
        );
        assert_eq!(
            normalize_server_url("http://127.0.0.1:8787").unwrap(),
            "http://127.0.0.1:8787"
        );
        assert!(normalize_server_url("http://company.test").is_err());
        assert!(normalize_server_url("https://user:secret@company.test").is_err());
        assert!(normalize_server_url("https://company.test?token=secret").is_err());
    }

    #[test]
    fn session_summary_never_exposes_the_bearer_token() {
        let credentials = Arc::new(MemoryCredentials::default());
        let remote = NativeEnterpriseRemote::with_credentials(credentials.clone());
        remote
            .save_session(&StoredSession {
                server_url: "https://company.test".into(),
                token: "top-secret-token".into(),
                account: json!({ "id": "account-1", "accountType": "member" }),
            })
            .unwrap();
        let public = remote.session();
        assert_eq!(public["account"]["id"], "account-1");
        assert!(!public.to_string().contains("top-secret-token"));
        assert!(credentials
            .get(SESSION_CREDENTIAL_ID)
            .unwrap()
            .contains("top-secret-token"));
    }

    #[test]
    fn a_new_auth_operation_invalidates_older_responses() {
        let remote =
            NativeEnterpriseRemote::with_credentials(Arc::new(MemoryCredentials::default()));
        let first = remote.begin_auth();
        assert!(remote.auth_is_current(first));
        let second = remote.begin_auth();
        assert!(!remote.auth_is_current(first));
        assert!(remote.auth_is_current(second));
    }

    #[test]
    fn invalid_or_missing_brief_is_rejected() {
        assert!(validate_brief(&json!({})).is_err());
        let evidence = json!({
            "status": "unknown", "stale": false, "evidenceRefs": [], "sources": []
        });
        assert!(validate_brief(&json!({
            "organizationId": "org-1",
            "generatedAt": "2026-09-06T00:00:00Z",
            "status": "unknown",
            "metrics": {
                "revenue": evidence, "margin": evidence, "inventory": evidence,
                "cash": evidence, "growth": evidence
            },
            "missing": [], "risks": [], "opportunities": [], "evidenceRefs": [],
            "invalidEvidenceRefs": [], "recommendedActions": [], "executedActions": [],
            "decisionsRequired": [],
        }))
        .is_ok());
        assert!(validate_brief(&json!({
            "organizationId": "org-1", "generatedAt": "now", "status": "unknown",
            "metrics": {}, "missing": [], "risks": [], "opportunities": [],
            "evidenceRefs": [], "invalidEvidenceRefs": [], "recommendedActions": [],
            "executedActions": [], "decisionsRequired": []
        }))
        .is_err());
    }

    #[tokio::test]
    async fn password_login_and_brief_use_the_native_bearer_session() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let evidence = json!({
            "status": "unknown", "stale": false, "evidenceRefs": [], "sources": []
        });
        let brief = json!({
            "organizationId": "org-1", "generatedAt": "2026-09-06T00:00:00Z",
            "status": "unknown",
            "metrics": {
                "revenue": evidence, "margin": evidence, "inventory": evidence,
                "cash": evidence, "growth": evidence
            },
            "missing": [], "risks": [], "opportunities": [], "evidenceRefs": [],
            "invalidEvidenceRefs": [], "recommendedActions": [], "executedActions": [],
            "decisionsRequired": []
        });
        let expected_brief = brief.clone();
        let server = tokio::spawn(async move {
            let (mut health, _) = listener.accept().await.unwrap();
            let request = read_request(&mut health).await;
            assert!(request.starts_with("GET /enterprise/health HTTP/1.1"));
            respond(
                &mut health,
                &json!({
                    "status": "ok", "apiVersion": 4,
                    "capabilities": ["password_auth"]
                }),
            )
            .await;

            let (mut login, _) = listener.accept().await.unwrap();
            let request = read_request(&mut login).await;
            assert!(request.starts_with("POST /enterprise/auth/login HTTP/1.1"));
            assert!(request.contains("\"identifier\":\"owner\""));
            respond(
                &mut login,
                &json!({
                    "account": { "id": "account-1", "accountType": "member" },
                    "token": "native-bearer", "expiresAt": "2026-09-07T00:00:00Z"
                }),
            )
            .await;

            let (mut companyos, _) = listener.accept().await.unwrap();
            let request = read_request(&mut companyos).await;
            assert!(request.starts_with("GET /enterprise/companyos/brief HTTP/1.1"));
            assert!(request
                .to_ascii_lowercase()
                .contains("authorization: bearer native-bearer"));
            respond(&mut companyos, &json!({ "brief": expected_brief })).await;
        });

        let remote =
            NativeEnterpriseRemote::with_credentials(Arc::new(MemoryCredentials::default()));
        let login = remote
            .login(
                format!("http://{address}"),
                "owner".into(),
                "password".into(),
            )
            .await
            .unwrap();
        assert_eq!(login["account"]["id"], "account-1");
        assert_eq!(remote.brief().await.unwrap(), brief);
        server.await.unwrap();
    }
}
