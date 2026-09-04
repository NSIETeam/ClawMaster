use crate::native_models::{CredentialStore, ModelToolCall, ModelToolDefinition};
use crate::native_process;
use reqwest::header::{HeaderName, HeaderValue};
use rmcp::model::{CallToolRequestParams, Tool};
use rmcp::transport::{
    streamable_http_client::StreamableHttpClientTransportConfig, StreamableHttpClientTransport,
    TokioChildProcess,
};
use rmcp::{model::JsonObject, ServiceExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;
use tokio::process::Command;
use tokio::sync::watch;
use tokio::time::timeout;
use url::Url;

const MAX_SERVERS: usize = 20;
const MAX_TOOLS_PER_SERVER: usize = 100;
const MAX_RESULT_BYTES: usize = 1_048_576;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct McpServerConfig {
    pub name: String,
    pub command: Option<String>,
    pub args: Vec<String>,
    pub cwd: Option<String>,
    pub url: Option<String>,
    pub http_url: Option<String>,
    pub timeout: u64,
    pub trust: bool,
    pub description: Option<String>,
    pub credential_id: Option<String>,
}

impl Default for McpServerConfig {
    fn default() -> Self {
        Self {
            name: String::new(),
            command: None,
            args: Vec::new(),
            cwd: None,
            url: None,
            http_url: None,
            timeout: 30,
            trust: false,
            description: None,
            credential_id: None,
        }
    }
}

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(default)]
pub struct McpSecrets {
    env: BTreeMap<String, String>,
    headers: BTreeMap<String, String>,
}

#[derive(Clone)]
struct McpToolRoute {
    server: McpServerConfig,
    original_name: String,
}

#[derive(Default)]
pub struct McpCatalog {
    pub definitions: Vec<ModelToolDefinition>,
    pub notices: Vec<String>,
    connected_servers: HashSet<String>,
    routes: HashMap<String, McpToolRoute>,
}

fn bounded_string(value: Option<&str>, max: usize) -> Option<String> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.chars().take(max).collect())
}

fn safe_name(value: &str, max: usize) -> String {
    let mut result = value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() || character == '_' || character == '-' {
                character.to_ascii_lowercase()
            } else {
                '_'
            }
        })
        .take(max)
        .collect::<String>();
    if result.is_empty() {
        result.push_str("tool");
    }
    result
}

fn exposed_tool_name(server: &str, tool: &str) -> String {
    let mut digest = Sha256::new();
    digest.update(server.as_bytes());
    digest.update([0]);
    digest.update(tool.as_bytes());
    let suffix = format!("{:x}", digest.finalize());
    format!(
        "mcp__{}__{}__{}",
        safe_name(server, 16),
        safe_name(tool, 24),
        &suffix[..8]
    )
}

fn endpoint(config: &McpServerConfig) -> Option<&str> {
    config.http_url.as_deref().or(config.url.as_deref())
}

fn validate_url(value: &str) -> Result<String, String> {
    let parsed = Url::parse(value).map_err(|_| "MCP 地址无效".to_string())?;
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("MCP 地址不能包含内嵌凭据".into());
    }
    let loopback = parsed
        .host_str()
        .map(|host| {
            host.eq_ignore_ascii_case("localhost")
                || host
                    .parse::<std::net::IpAddr>()
                    .is_ok_and(|ip| ip.is_loopback())
        })
        .unwrap_or(false);
    if parsed.scheme() != "https" && !(parsed.scheme() == "http" && loopback) {
        return Err("远程 MCP 必须使用 HTTPS；HTTP 仅允许回环地址".into());
    }
    Ok(parsed.to_string())
}

fn validate_env_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || character == '_')
}

pub fn parse_config(
    payload: &Value,
    old: Option<&McpServerConfig>,
) -> Result<(McpServerConfig, Option<McpSecrets>), String> {
    let raw_name = payload
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    if raw_name.is_empty() || raw_name.chars().count() > 80 {
        return Err("MCP 名称不能为空或超过 80 字符".into());
    }
    let name = raw_name.to_string();
    let command = bounded_string(payload.get("command").and_then(Value::as_str), 1024);
    let url = bounded_string(payload.get("url").and_then(Value::as_str), 2048)
        .map(|value| validate_url(&value))
        .transpose()?;
    let http_url = bounded_string(payload.get("httpUrl").and_then(Value::as_str), 2048)
        .map(|value| validate_url(&value))
        .transpose()?;
    if usize::from(command.is_some()) + usize::from(url.is_some()) + usize::from(http_url.is_some())
        != 1
    {
        return Err("MCP 必须且只能配置 command、url、httpUrl 之一".into());
    }
    if let Some(value) = &command {
        let path = Path::new(value);
        if value.contains(['\n', '\r', '\0'])
            || (!path.is_absolute() && path.components().count() != 1)
        {
            return Err("MCP command 必须是绝对路径或 PATH 中的单个可执行文件名".into());
        }
    }
    let args = payload
        .get("args")
        .and_then(Value::as_array)
        .map(|values| {
            values
                .iter()
                .map(|value| {
                    value
                        .as_str()
                        .map(str::to_owned)
                        .ok_or_else(|| "MCP 参数必须是字符串".to_string())
                })
                .collect::<Result<Vec<_>, _>>()
        })
        .transpose()?
        .unwrap_or_default();
    if args.len() > 100 || args.iter().map(String::len).sum::<usize>() > 32_768 {
        return Err("MCP 参数数量或总长度超过限制".into());
    }
    let cwd = bounded_string(payload.get("cwd").and_then(Value::as_str), 2048);
    if cwd
        .as_ref()
        .is_some_and(|value| !Path::new(value).is_absolute())
    {
        return Err("MCP cwd 必须是绝对路径".into());
    }
    let timeout = payload
        .get("timeout")
        .and_then(Value::as_u64)
        .unwrap_or(30)
        .clamp(1, 300);
    let env = payload
        .get("env")
        .and_then(Value::as_object)
        .map(|values| {
            values
                .iter()
                .map(|(key, value)| -> Result<(String, String), String> {
                    if !validate_env_name(key) {
                        return Err("MCP 环境变量名无效".to_string());
                    }
                    let value = value
                        .as_str()
                        .ok_or_else(|| "MCP 环境变量值必须是字符串".to_string())?;
                    Ok((key.clone(), value.to_string()))
                })
                .collect::<Result<BTreeMap<_, _>, _>>()
        })
        .transpose()?;
    let headers = payload
        .get("headers")
        .and_then(Value::as_object)
        .map(|values| {
            values
                .iter()
                .map(|(key, value)| -> Result<(String, String), String> {
                    HeaderName::from_bytes(key.as_bytes())
                        .map_err(|_| "MCP 请求头名称无效".to_string())?;
                    let value = value
                        .as_str()
                        .ok_or_else(|| "MCP 请求头值必须是字符串".to_string())?;
                    HeaderValue::from_str(value).map_err(|_| "MCP 请求头值无效".to_string())?;
                    Ok((key.clone(), value.to_string()))
                })
                .collect::<Result<BTreeMap<_, _>, _>>()
        })
        .transpose()?;
    let secret_size = env
        .as_ref()
        .into_iter()
        .flat_map(|values| values.iter())
        .chain(
            headers
                .as_ref()
                .into_iter()
                .flat_map(|values| values.iter()),
        )
        .map(|(key, value)| key.len() + value.len())
        .sum::<usize>();
    if env.as_ref().is_some_and(|values| values.len() > 100)
        || headers.as_ref().is_some_and(|values| values.len() > 100)
        || secret_size > 65_536
    {
        return Err("MCP 安全配置数量或总长度超过限制".into());
    }
    let secrets = if env.is_some() || headers.is_some() {
        Some(McpSecrets {
            env: env.unwrap_or_default(),
            headers: headers.unwrap_or_default(),
        })
    } else {
        None
    };
    Ok((
        McpServerConfig {
            name,
            command,
            args,
            cwd,
            url,
            http_url,
            timeout,
            trust: payload
                .get("trust")
                .and_then(Value::as_bool)
                .unwrap_or(false),
            description: bounded_string(payload.get("description").and_then(Value::as_str), 500),
            credential_id: old.and_then(|value| value.credential_id.clone()),
        },
        secrets,
    ))
}

pub fn public_servers(configs: &[McpServerConfig]) -> Value {
    public_servers_with_status(configs, &HashSet::new())
}

pub fn public_servers_with_status(
    configs: &[McpServerConfig],
    connected: &HashSet<String>,
) -> Value {
    Value::Array(
        configs
            .iter()
            .map(|config| {
                json!({
                    "name": config.name,
                    "status": if connected.contains(&config.name) { "connected" } else { "disconnected" },
                    "command": config.command,
                    "url": config.url,
                    "httpUrl": config.http_url,
                    "description": config.description,
                })
            })
            .collect(),
    )
}

fn read_secrets(
    config: &McpServerConfig,
    credentials: &dyn CredentialStore,
) -> Result<McpSecrets, String> {
    let Some(id) = &config.credential_id else {
        return Ok(McpSecrets::default());
    };
    let raw = credentials
        .get(id)
        .map_err(|_| format!("MCP {} 的安全凭据不可用，请重新保存配置", config.name))?;
    serde_json::from_str(&raw).map_err(|_| format!("MCP {} 的安全凭据损坏", config.name))
}

fn command_for(config: &McpServerConfig, secrets: &McpSecrets) -> Result<Command, String> {
    let value = config
        .command
        .as_deref()
        .ok_or_else(|| "MCP command 缺失".to_string())?;
    let executable = if Path::new(value).is_absolute() {
        let path = PathBuf::from(value);
        if !path.is_file() {
            return Err("MCP 可执行文件不存在".into());
        }
        path
    } else {
        native_process::resolve_executable(value)?
    };
    let mut command = Command::new(executable);
    command.args(&config.args).kill_on_drop(true).env_clear();
    if let Some(cwd) = &config.cwd {
        let path = Path::new(cwd);
        if !path.is_dir() {
            return Err("MCP cwd 不存在或不是目录".into());
        }
        command.current_dir(path);
    }
    for name in [
        "PATH",
        "HOME",
        "USERPROFILE",
        "TMPDIR",
        "TEMP",
        "LANG",
        "LC_ALL",
        "SystemRoot",
        "COMSPEC",
        "PATHEXT",
    ] {
        if let Some(value) = std::env::var_os(name) {
            command.env(name, value);
        }
    }
    command.envs(&secrets.env);
    Ok(command)
}

fn http_transport(
    config: &McpServerConfig,
    secrets: &McpSecrets,
) -> Result<StreamableHttpClientTransport<reqwest::Client>, String> {
    let mut transport = StreamableHttpClientTransportConfig::with_uri(
        endpoint(config)
            .ok_or_else(|| "MCP HTTP 地址缺失".to_string())?
            .to_string(),
    );
    transport.max_sse_event_size = MAX_RESULT_BYTES;
    transport.max_concurrent_requests = 2;
    for (name, value) in &secrets.headers {
        transport.custom_headers.insert(
            HeaderName::from_bytes(name.as_bytes())
                .map_err(|_| "MCP 请求头名称无效".to_string())?,
            HeaderValue::from_str(value).map_err(|_| "MCP 请求头值无效".to_string())?,
        );
    }
    Ok(StreamableHttpClientTransport::from_config(transport))
}

async fn list_stdio(config: &McpServerConfig, secrets: &McpSecrets) -> Result<Vec<Tool>, String> {
    let (transport, _) = TokioChildProcess::builder(command_for(config, secrets)?)
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| format!("无法启动 MCP {}: {error}", config.name))?;
    let client = ()
        .serve(transport)
        .await
        .map_err(|error| format!("MCP {} 初始化失败: {error}", config.name))?;
    let result = client
        .list_all_tools()
        .await
        .map_err(|error| format!("MCP {} 工具发现失败: {error}", config.name));
    let _ = client.cancel().await;
    result
}

async fn list_http(config: &McpServerConfig, secrets: &McpSecrets) -> Result<Vec<Tool>, String> {
    let client = ()
        .serve(http_transport(config, secrets)?)
        .await
        .map_err(|error| format!("MCP {} 初始化失败: {error}", config.name))?;
    let result = client
        .list_all_tools()
        .await
        .map_err(|error| format!("MCP {} 工具发现失败: {error}", config.name));
    let _ = client.cancel().await;
    result
}

async fn discover_server(
    config: &McpServerConfig,
    secrets: &McpSecrets,
) -> Result<Vec<Tool>, String> {
    let operation = async {
        if config.command.is_some() {
            list_stdio(config, secrets).await
        } else {
            list_http(config, secrets).await
        }
    };
    timeout(Duration::from_secs(config.timeout), operation)
        .await
        .map_err(|_| format!("MCP {} 工具发现超时", config.name))?
}

pub async fn discover(
    configs: &[McpServerConfig],
    credentials: &dyn CredentialStore,
) -> McpCatalog {
    let mut catalog = McpCatalog::default();
    let mut tasks = tokio::task::JoinSet::new();
    for config in configs.iter().take(MAX_SERVERS) {
        match read_secrets(config, credentials) {
            Ok(secrets) => {
                let config = config.clone();
                tasks.spawn(async move {
                    let result = discover_server(&config, &secrets).await;
                    (config, result)
                });
            }
            Err(message) => catalog.notices.push(message),
        }
    }
    while let Some(task) = tasks.join_next().await {
        let (config, tools) = match task {
            Ok((config, Ok(tools))) => (config, tools),
            Ok((_config, Err(message))) => {
                catalog.notices.push(message);
                continue;
            }
            Err(error) => {
                catalog
                    .notices
                    .push(format!("MCP 工具发现任务失败: {error}"));
                continue;
            }
        };
        catalog.connected_servers.insert(config.name.clone());
        for tool in tools.into_iter().take(MAX_TOOLS_PER_SERVER) {
            let name = exposed_tool_name(&config.name, &tool.name);
            let description = format!(
                "MCP server {}: {}",
                config.name,
                tool.description.as_deref().unwrap_or("External MCP tool")
            )
            .chars()
            .take(600)
            .collect();
            catalog.definitions.push(ModelToolDefinition {
                name: name.clone(),
                description,
                parameters: Value::Object((*tool.input_schema).clone()),
            });
            catalog.routes.insert(
                name,
                McpToolRoute {
                    server: config.clone(),
                    original_name: tool.name.into_owned(),
                },
            );
        }
    }
    catalog
        .definitions
        .sort_by(|left, right| left.name.cmp(&right.name));
    catalog.notices.sort();
    catalog
}

async fn call_stdio(
    config: &McpServerConfig,
    secrets: &McpSecrets,
    params: CallToolRequestParams,
) -> Result<Value, String> {
    let (transport, _) = TokioChildProcess::builder(command_for(config, secrets)?)
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| format!("无法启动 MCP {}: {error}", config.name))?;
    let client = ()
        .serve(transport)
        .await
        .map_err(|error| format!("MCP {} 初始化失败: {error}", config.name))?;
    let result = client
        .call_tool(params)
        .await
        .map_err(|error| format!("MCP {} 调用失败: {error}", config.name));
    let _ = client.cancel().await;
    result.and_then(bound_result)
}

async fn call_http(
    config: &McpServerConfig,
    secrets: &McpSecrets,
    params: CallToolRequestParams,
) -> Result<Value, String> {
    let client = ()
        .serve(http_transport(config, secrets)?)
        .await
        .map_err(|error| format!("MCP {} 初始化失败: {error}", config.name))?;
    let result = client
        .call_tool(params)
        .await
        .map_err(|error| format!("MCP {} 调用失败: {error}", config.name));
    let _ = client.cancel().await;
    result.and_then(bound_result)
}

fn bound_result(result: rmcp::model::CallToolResult) -> Result<Value, String> {
    let value =
        serde_json::to_value(result).map_err(|error| format!("无法编码 MCP 响应: {error}"))?;
    if serde_json::to_vec(&value)
        .map_err(|error| format!("无法检查 MCP 响应: {error}"))?
        .len()
        > MAX_RESULT_BYTES
    {
        return Err("MCP 响应超过 1 MiB 安全上限".into());
    }
    Ok(value)
}

async fn cancelled(mut cancel: watch::Receiver<bool>) {
    if *cancel.borrow() {
        return;
    }
    while cancel.changed().await.is_ok() {
        if *cancel.borrow() {
            return;
        }
    }
}

impl McpCatalog {
    pub fn contains(&self, name: &str) -> bool {
        self.routes.contains_key(name)
    }

    pub fn public_servers(&self, configs: &[McpServerConfig]) -> Value {
        public_servers_with_status(configs, &self.connected_servers)
    }

    pub fn tool_summaries(&self) -> Vec<Value> {
        self.definitions
            .iter()
            .map(|tool| {
                json!({
                    "name": tool.name,
                    "displayName": tool.name,
                    "description": tool.description,
                    "source": "mcp"
                })
            })
            .collect()
    }

    pub async fn execute(
        &self,
        call: &ModelToolCall,
        credentials: &dyn CredentialStore,
        cancel: watch::Receiver<bool>,
    ) -> Result<Value, String> {
        let route = self
            .routes
            .get(&call.name)
            .ok_or_else(|| "MCP 工具路由不存在".to_string())?;
        let secrets = read_secrets(&route.server, credentials)?;
        let arguments = call
            .arguments
            .as_object()
            .cloned()
            .ok_or_else(|| "MCP 工具参数必须是对象".to_string())?;
        let params = CallToolRequestParams::new(route.original_name.clone())
            .with_arguments(arguments as JsonObject);
        let operation = async {
            if route.server.command.is_some() {
                call_stdio(&route.server, &secrets, params).await
            } else {
                call_http(&route.server, &secrets, params).await
            }
        };
        tokio::select! {
            result = timeout(Duration::from_secs(route.server.timeout), operation) => result.map_err(|_| format!("MCP {} 调用超时", route.server.name))?,
            _ = cancelled(cancel) => Err("MCP 调用已取消".into()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_ambiguous_or_insecure_transports() {
        assert!(parse_config(
            &json!({"name":"x","command":"echo","httpUrl":"https://example.com/mcp"}),
            None
        )
        .is_err());
        assert!(parse_config(
            &json!({"name":"x","httpUrl":"http://example.com/mcp"}),
            None
        )
        .is_err());
        assert!(parse_config(
            &json!({"name":"x","httpUrl":"http://127.0.0.1:3000/mcp"}),
            None
        )
        .is_ok());
    }

    #[test]
    fn secrets_are_separated_from_persisted_config() {
        let (config, secrets) = parse_config(
            &json!({
                "name":"files", "command":"mcp-files", "env":{"TOKEN":"secret"},
                "headers":{"Authorization":"Bearer secret"}
            }),
            None,
        )
        .unwrap();
        let serialized = serde_json::to_string(&config).unwrap();
        assert!(!serialized.contains("secret"));
        let secrets = secrets.unwrap();
        assert_eq!(secrets.env["TOKEN"], "secret");
    }

    #[test]
    fn model_tool_names_are_stable_bounded_and_namespaced() {
        let name = exposed_tool_name("My Server", "read/a very long tool name");
        assert!(name.starts_with("mcp__my_server__read_a_very_long_tool_na__"));
        assert!(name.len() <= 64);
        assert_eq!(
            name,
            exposed_tool_name("My Server", "read/a very long tool name")
        );
    }
}
