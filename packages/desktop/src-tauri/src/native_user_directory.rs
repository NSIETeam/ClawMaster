use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

const MAX_CONTROL_BYTES: u64 = 256 * 1024;
const CONTROL_FILES: &[(&str, &str)] = &[
    ("core.md", "core"),
    ("soul.md", "soul"),
    ("project.md", "project"),
    ("memory.md", "memory"),
];
const CONNECTOR_FILES: &[(&str, &str)] = &[
    ("connectors/feishu.toml", "feishu"),
    ("connectors/wecom.toml", "wecom"),
    ("connectors/platforms.toml", "platforms"),
];
const DIRECTORIES: &[&str] = &[
    "projects",
    "memory",
    "skills",
    "connectors",
    "capabilities",
    "audit",
    ".history",
    ".state/last-known-good",
];

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UserDirectoryError {
    pub path: String,
    pub line: usize,
    pub column: usize,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub diff: Option<String>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UserDirectoryDocument {
    pub path: String,
    pub kind: String,
    pub revision: String,
    pub content: String,
    pub from_last_known_good: bool,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UserDirectorySnapshot {
    pub root: String,
    pub documents: Vec<UserDirectoryDocument>,
    pub errors: Vec<UserDirectoryError>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct UserDirectoryWritePreview {
    pub request_id: String,
    pub path: String,
    pub previous_revision: String,
    pub next_revision: String,
    pub diff: String,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct CoreOverrides {
    pub model: Option<String>,
    pub max_output_tokens: Option<u32>,
    pub enabled_capabilities: Option<Vec<String>>,
    pub policy_default: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct JournalEntry {
    request_id: String,
    relative_path: String,
    previous_revision: String,
    next_revision: String,
    source_id: String,
    state: String,
    timestamp: u64,
}

#[derive(Clone, Debug)]
pub struct UserDirectory {
    root: PathBuf,
}

impl UserDirectory {
    pub fn initialize(home: &Path) -> Result<Self, String> {
        let root = home.join("ClawMaster");
        fs::create_dir_all(&root).map_err(io_error("无法创建 ClawMaster 用户目录"))?;
        for directory in DIRECTORIES {
            fs::create_dir_all(root.join(directory)).map_err(io_error("无法创建用户子目录"))?;
        }
        for (name, kind) in CONTROL_FILES {
            create_once(&root.join(name), &markdown_template(kind))?;
        }
        for (name, provider) in CONNECTOR_FILES {
            create_once(&root.join(name), &connector_template(provider))?;
        }

        let directory = Self {
            root: root.canonicalize().map_err(io_error("无法解析用户目录"))?,
        };
        directory.seed_last_known_good_fallbacks()?;
        // Invalid user edits are reported at the next turn boundary. They must never
        // make the desktop fail to start when a safe fallback is available.
        let _ = directory.snapshot_at_turn_boundary();
        Ok(directory)
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn background_task_count(&self) -> usize {
        0
    }

    pub fn snapshot_at_turn_boundary(&self) -> UserDirectorySnapshot {
        let mut documents = Vec::new();
        let mut errors = Vec::new();
        for (name, kind) in CONTROL_FILES {
            match self.read_valid_document(name, kind, DocumentFormat::Markdown) {
                Ok(document) => documents.push(document),
                Err(mut error) => {
                    self.attach_recovery_diff(&mut error, name, kind);
                    errors.push(error);
                    if let Ok(document) = self.read_last_known_good(name, kind) {
                        documents.push(document);
                    }
                }
            }
        }
        for (name, provider) in CONNECTOR_FILES {
            match self.read_valid_document(name, provider, DocumentFormat::Connector) {
                Ok(document) => documents.push(document),
                Err(mut error) => {
                    self.attach_recovery_diff(&mut error, name, provider);
                    errors.push(error);
                    if let Ok(document) = self.read_last_known_good(name, provider) {
                        documents.push(document);
                    }
                }
            }
        }
        UserDirectorySnapshot {
            root: self.root.to_string_lossy().into_owned(),
            documents,
            errors,
        }
    }

    pub fn prompt_context(snapshot: &UserDirectorySnapshot) -> String {
        snapshot
            .documents
            .iter()
            .filter(|document| matches!(document.kind.as_str(), "core" | "soul" | "project"))
            .map(|document| {
                format!(
                    "## ClawMaster {}\n{}",
                    document.kind,
                    body(&document.content)
                )
            })
            .collect::<Vec<_>>()
            .join("\n\n")
    }

    pub fn core_overrides(snapshot: &UserDirectorySnapshot) -> CoreOverrides {
        let Some(document) = snapshot
            .documents
            .iter()
            .find(|document| document.kind == "core")
        else {
            return CoreOverrides::default();
        };
        let Ok(table) = markdown_frontmatter(&document.content) else {
            return CoreOverrides::default();
        };
        CoreOverrides {
            model: table
                .get("model")
                .and_then(toml::Value::as_str)
                .map(str::to_owned),
            max_output_tokens: table
                .get("max_output_tokens")
                .and_then(toml::Value::as_integer)
                .and_then(|value| u32::try_from(value).ok()),
            enabled_capabilities: table.get("enabled_capabilities").and_then(|value| {
                value.as_array().map(|values| {
                    values
                        .iter()
                        .filter_map(toml::Value::as_str)
                        .map(str::to_owned)
                        .collect()
                })
            }),
            policy_default: table
                .get("policy_default")
                .and_then(toml::Value::as_str)
                .map(str::to_owned),
        }
    }

    pub fn preview_agent_write(
        &self,
        request_id: &str,
        relative_path: &str,
        content: &str,
    ) -> Result<UserDirectoryWritePreview, String> {
        validate_identifier(request_id, "requestId")?;
        let path = self.control_path(relative_path)?;
        let kind = CONTROL_FILES
            .iter()
            .find_map(|(name, kind)| (*name == relative_path).then_some(*kind))
            .ok_or_else(|| "Agent 只能修改受控 Markdown 文件".to_string())?;
        validate_document(relative_path, kind, content).map_err(|error| error.message)?;
        let previous = fs::read_to_string(&path).map_err(io_error("无法读取控制文件"))?;
        Ok(UserDirectoryWritePreview {
            request_id: request_id.to_string(),
            path: relative_path.to_string(),
            previous_revision: digest(previous.as_bytes()),
            next_revision: digest(content.as_bytes()),
            diff: line_diff(&previous, content),
        })
    }

    pub fn apply_agent_write(
        &self,
        preview: &UserDirectoryWritePreview,
        content: &str,
        source_id: &str,
        approved: bool,
    ) -> Result<UserDirectoryDocument, String> {
        validate_identifier(source_id, "sourceId")?;
        let refreshed = self.preview_agent_write(&preview.request_id, &preview.path, content)?;
        if refreshed.previous_revision != preview.previous_revision
            || refreshed.next_revision != preview.next_revision
            || refreshed.diff != preview.diff
        {
            return Err("审批后文件或参数已变化，必须重新预览并授权".into());
        }
        if !approved {
            self.append_journal(preview, source_id, "rejected")?;
            return Err("用户已拒绝修改 ClawMaster 控制文件".into());
        }

        let path = self.control_path(&preview.path)?;
        let history = self.root.join(".history").join(format!(
            "{}-{}-{}.md",
            now_ms(),
            preview.path.trim_end_matches(".md"),
            &preview.previous_revision[..12]
        ));
        fs::copy(&path, &history).map_err(io_error("无法保存控制文件历史"))?;
        atomic_write(&path, content.as_bytes())?;
        self.append_journal(preview, source_id, "completed")?;
        let kind = CONTROL_FILES
            .iter()
            .find_map(|(name, kind)| (*name == preview.path).then_some(*kind))
            .ok_or_else(|| "未知控制文件".to_string())?;
        self.read_valid_document(&preview.path, kind, DocumentFormat::Markdown)
            .map_err(|error| error.message)
    }

    pub fn rollback_to_last_known_good(
        &self,
        request_id: &str,
        relative_path: &str,
        source_id: &str,
        approved: bool,
    ) -> Result<UserDirectoryDocument, String> {
        let kind = CONTROL_FILES
            .iter()
            .find_map(|(name, kind)| (*name == relative_path).then_some(*kind))
            .ok_or_else(|| "只能回退受控 Markdown 文件".to_string())?;
        let fallback = self.read_last_known_good(relative_path, kind)?;
        let preview = self.preview_agent_write(request_id, relative_path, &fallback.content)?;
        self.apply_agent_write(&preview, &fallback.content, source_id, approved)
    }

    fn read_valid_document(
        &self,
        relative_path: &str,
        kind: &str,
        format: DocumentFormat,
    ) -> Result<UserDirectoryDocument, UserDirectoryError> {
        let path = self
            .control_path(relative_path)
            .map_err(|message| user_error(relative_path, 1, 1, message))?;
        let metadata = fs::metadata(&path)
            .map_err(|error| user_error(relative_path, 1, 1, error.to_string()))?;
        if metadata.len() > MAX_CONTROL_BYTES {
            return Err(user_error(relative_path, 1, 1, "控制文件超过 256 KiB"));
        }
        let content = fs::read_to_string(&path)
            .map_err(|error| user_error(relative_path, 1, 1, error.to_string()))?;
        match format {
            DocumentFormat::Markdown => validate_document(relative_path, kind, &content)?,
            DocumentFormat::Connector => validate_connector(relative_path, kind, &content)?,
        }
        let revision = digest(content.as_bytes());
        let lkg = self.root.join(".state/last-known-good").join(relative_path);
        if fs::read(&lkg).ok().as_deref() != Some(content.as_bytes()) {
            atomic_write(&lkg, content.as_bytes())
                .map_err(|message| user_error(relative_path, 1, 1, message))?;
        }
        Ok(UserDirectoryDocument {
            path: relative_path.to_string(),
            kind: kind.to_string(),
            revision,
            content,
            from_last_known_good: false,
        })
    }

    fn seed_last_known_good_fallbacks(&self) -> Result<(), String> {
        for (name, kind) in CONTROL_FILES {
            let fallback = self.root.join(".state/last-known-good").join(name);
            if !fallback.exists() {
                atomic_write(&fallback, markdown_template(kind).as_bytes())?;
            }
        }
        for (name, provider) in CONNECTOR_FILES {
            let fallback = self.root.join(".state/last-known-good").join(name);
            if let Some(parent) = fallback.parent() {
                fs::create_dir_all(parent).map_err(io_error("无法创建 connector 回退目录"))?;
            }
            if !fallback.exists() {
                atomic_write(&fallback, connector_template(provider).as_bytes())?;
            }
        }
        Ok(())
    }

    fn attach_recovery_diff(
        &self,
        error: &mut UserDirectoryError,
        relative_path: &str,
        kind: &str,
    ) {
        let Ok(path) = self.control_path(relative_path) else {
            return;
        };
        if !matches!(fs::metadata(&path), Ok(metadata) if metadata.len() <= MAX_CONTROL_BYTES) {
            return;
        }
        let Ok(current) = fs::read_to_string(path) else {
            return;
        };
        let Ok(fallback) = self.read_last_known_good(relative_path, kind) else {
            return;
        };
        error.diff = Some(redacted_line_diff(&current, &fallback.content));
    }

    fn read_last_known_good(
        &self,
        relative_path: &str,
        kind: &str,
    ) -> Result<UserDirectoryDocument, String> {
        let content =
            fs::read_to_string(self.root.join(".state/last-known-good").join(relative_path))
                .map_err(io_error("无法读取 last-known-good"))?;
        Ok(UserDirectoryDocument {
            path: relative_path.to_string(),
            kind: kind.to_string(),
            revision: digest(content.as_bytes()),
            content,
            from_last_known_good: true,
        })
    }

    fn control_path(&self, relative_path: &str) -> Result<PathBuf, String> {
        let relative = Path::new(relative_path);
        if relative.is_absolute()
            || relative
                .components()
                .any(|component| !matches!(component, Component::Normal(_)))
        {
            return Err("用户目录路径必须是无跳转的相对路径".into());
        }
        let candidate = self.root.join(relative);
        if fs::symlink_metadata(&candidate).is_ok_and(|metadata| metadata.file_type().is_symlink())
        {
            return Err("用户目录控制文件不得是符号链接或 junction".into());
        }
        let parent = candidate
            .parent()
            .ok_or_else(|| "用户目录路径无父目录".to_string())?;
        let canonical_parent = parent
            .canonicalize()
            .map_err(io_error("无法解析用户目录父路径"))?;
        if !path_is_within(&canonical_parent, &self.root) {
            return Err("用户目录路径逃逸已被拒绝".into());
        }
        if candidate.exists() {
            let canonical_candidate = candidate
                .canonicalize()
                .map_err(io_error("无法解析用户目录文件"))?;
            if !path_is_within(&canonical_candidate, &self.root) {
                return Err("用户目录符号链接或 junction 逃逸已被拒绝".into());
            }
        }
        Ok(candidate)
    }

    fn append_journal(
        &self,
        preview: &UserDirectoryWritePreview,
        source_id: &str,
        state: &str,
    ) -> Result<(), String> {
        let record = JournalEntry {
            request_id: preview.request_id.clone(),
            relative_path: preview.path.clone(),
            previous_revision: preview.previous_revision.clone(),
            next_revision: preview.next_revision.clone(),
            source_id: source_id.to_string(),
            state: state.to_string(),
            timestamp: now_ms(),
        };
        let path = self.root.join("audit/user-directory.jsonl");
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .map_err(io_error("无法打开用户目录审计"))?;
        serde_json::to_writer(&mut file, &record).map_err(|error| error.to_string())?;
        file.write_all(b"\n")
            .map_err(io_error("无法写入用户目录审计"))?;
        file.sync_all().map_err(io_error("无法同步用户目录审计"))
    }
}

#[derive(Clone, Copy)]
enum DocumentFormat {
    Markdown,
    Connector,
}

fn markdown_template(kind: &str) -> String {
    let options = if kind == "core" {
        "# model = \"configured-model-id\"\n# max_output_tokens = 4096\n# enabled_capabilities = [\"read_file\", \"search_text\"]\n# policy_default = \"cautious\"\n"
    } else {
        ""
    };
    format!(
        "+++\nschema_version = 1\nkind = \"{kind}\"\n{options}+++\n\n# {}\n\n",
        kind.to_ascii_uppercase()
    )
}

fn connector_template(provider: &str) -> String {
    format!("schema_version = 1\nprovider = \"{provider}\"\nenabled = false\n")
}

fn create_once(path: &Path, content: &str) -> Result<(), String> {
    match OpenOptions::new().write(true).create_new(true).open(path) {
        Ok(mut file) => {
            file.write_all(content.as_bytes())
                .map_err(io_error("无法写入初始模板"))?;
            file.sync_all().map_err(io_error("无法同步初始模板"))
        }
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => Ok(()),
        Err(error) => Err(format!("无法创建初始模板: {error}")),
    }
}

fn validate_document(
    path: &str,
    expected_kind: &str,
    content: &str,
) -> Result<(), UserDirectoryError> {
    if contains_secret(content) {
        return Err(user_error(
            path,
            1,
            1,
            "控制文件不得包含 secret、token、password 或 API key",
        ));
    }
    let mut lines = content.lines();
    if lines.next() != Some("+++") {
        return Err(user_error(
            path,
            1,
            1,
            "缺少 TOML front matter 起始标记 +++",
        ));
    }
    let mut frontmatter = String::new();
    let mut end_line = None;
    for (index, line) in lines.enumerate() {
        if line == "+++" {
            end_line = Some(index + 2);
            break;
        }
        frontmatter.push_str(line);
        frontmatter.push('\n');
    }
    if end_line.is_none() {
        return Err(user_error(
            path,
            content.lines().count().max(1),
            1,
            "缺少 TOML front matter 结束标记 +++",
        ));
    }
    let parsed = frontmatter.parse::<toml::Table>().map_err(|error| {
        let span = error.span().unwrap_or(0..0);
        let before = &frontmatter[..span.start.min(frontmatter.len())];
        let line = before.bytes().filter(|byte| *byte == b'\n').count() + 2;
        let column = before
            .rsplit('\n')
            .next()
            .map_or(1, |value| value.chars().count() + 1);
        user_error(
            path,
            line,
            column,
            format!("TOML front matter 无效: {error}"),
        )
    })?;
    if parsed
        .get("schema_version")
        .and_then(toml::Value::as_integer)
        != Some(1)
    {
        return Err(user_error(path, 2, 1, "schema_version 必须为 1"));
    }
    if parsed.get("kind").and_then(toml::Value::as_str) != Some(expected_kind) {
        return Err(user_error(
            path,
            3,
            1,
            format!("kind 必须为 {expected_kind}"),
        ));
    }
    let forbidden = [
        "disable_approval",
        "disable_audit",
        "disable_path_isolation",
        "allow_unrestricted_shell",
    ];
    for key in forbidden {
        if parsed.contains_key(key) {
            return Err(user_error(path, 2, 1, format!("硬安全项 {key} 不可覆盖")));
        }
    }
    if expected_kind == "core" {
        validate_optional_string(path, &parsed, "model", 160)?;
        if let Some(value) = parsed.get("max_output_tokens") {
            let Some(value) = value.as_integer() else {
                return Err(user_error(path, 2, 1, "max_output_tokens 必须为整数"));
            };
            if !(1..=32_768).contains(&value) {
                return Err(user_error(
                    path,
                    2,
                    1,
                    "max_output_tokens 必须在 1 到 32768 之间",
                ));
            }
        }
        if let Some(value) = parsed.get("enabled_capabilities") {
            let Some(values) = value.as_array() else {
                return Err(user_error(
                    path,
                    2,
                    1,
                    "enabled_capabilities 必须为字符串数组",
                ));
            };
            if values.len() > 64
                || values.iter().any(|item| {
                    item.as_str()
                        .is_none_or(|name| name.is_empty() || name.len() > 128)
                })
            {
                return Err(user_error(
                    path,
                    2,
                    1,
                    "enabled_capabilities 包含无效能力名称",
                ));
            }
        }
        if let Some(value) = parsed.get("policy_default") {
            if !matches!(value.as_str(), Some("cautious" | "balanced" | "direct")) {
                return Err(user_error(
                    path,
                    2,
                    1,
                    "policy_default 必须为 cautious、balanced 或 direct",
                ));
            }
        }
    }
    Ok(())
}

fn validate_optional_string(
    path: &str,
    table: &toml::Table,
    key: &str,
    max_len: usize,
) -> Result<(), UserDirectoryError> {
    let Some(value) = table.get(key) else {
        return Ok(());
    };
    if value
        .as_str()
        .is_none_or(|value| value.is_empty() || value.len() > max_len)
    {
        return Err(user_error(path, 2, 1, format!("{key} 必须为有效字符串")));
    }
    Ok(())
}

fn markdown_frontmatter(content: &str) -> Result<toml::Table, String> {
    let frontmatter = content
        .strip_prefix("+++\n")
        .and_then(|content| content.split_once("\n+++"))
        .map(|(frontmatter, _)| frontmatter)
        .ok_or_else(|| "无效 Markdown front matter".to_string())?;
    frontmatter
        .parse::<toml::Table>()
        .map_err(|error| error.to_string())
}

fn validate_connector(
    path: &str,
    expected_provider: &str,
    content: &str,
) -> Result<(), UserDirectoryError> {
    if contains_secret(content) {
        return Err(user_error(
            path,
            1,
            1,
            "connector 配置不得包含 secret、token、password 或 API key",
        ));
    }
    let parsed = content.parse::<toml::Table>().map_err(|error| {
        let span = error.span().unwrap_or(0..0);
        let before = &content[..span.start.min(content.len())];
        let line = before.bytes().filter(|byte| *byte == b'\n').count() + 1;
        let column = before
            .rsplit('\n')
            .next()
            .map_or(1, |value| value.chars().count() + 1);
        user_error(path, line, column, format!("connector TOML 无效: {error}"))
    })?;
    if parsed
        .get("schema_version")
        .and_then(toml::Value::as_integer)
        != Some(1)
    {
        return Err(user_error(path, 1, 1, "schema_version 必须为 1"));
    }
    if parsed.get("provider").and_then(toml::Value::as_str) != Some(expected_provider) {
        return Err(user_error(
            path,
            2,
            1,
            format!("provider 必须为 {expected_provider}"),
        ));
    }
    if !matches!(parsed.get("enabled"), Some(toml::Value::Boolean(_))) {
        return Err(user_error(path, 3, 1, "enabled 必须为布尔值"));
    }
    Ok(())
}

fn contains_secret(content: &str) -> bool {
    let lower = content.to_ascii_lowercase();
    if lower.contains("sk-") {
        return true;
    }
    for line in lower.lines() {
        if line.trim_start().starts_with('#') {
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let credential_key = key.contains("secret")
            || key.contains("password")
            || key.contains("api_key")
            || key.contains("apikey")
            || (key.contains("token") && !key.contains("max_output_token"));
        if credential_key && !value.trim().trim_matches(['\'', '"']).is_empty() {
            return true;
        }
    }
    false
}

fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "原子写入缺少父目录".to_string())?;
    let temporary = parent.join(format!(".clawmaster-{}.tmp", now_ms()));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)
        .map_err(io_error("无法创建原子写入临时文件"))?;
    file.write_all(bytes)
        .map_err(io_error("无法写入临时文件"))?;
    file.sync_all().map_err(io_error("无法同步临时文件"))?;
    if let Err(error) = atomic_replace(&temporary, path) {
        let _ = fs::remove_file(&temporary);
        return Err(error);
    }
    if let Ok(directory) = OpenOptions::new().read(true).open(parent) {
        let _ = directory.sync_all();
    }
    Ok(())
}

#[cfg(not(windows))]
fn atomic_replace(source: &Path, destination: &Path) -> Result<(), String> {
    fs::rename(source, destination).map_err(io_error("无法原子替换控制文件"))
}

#[cfg(windows)]
fn atomic_replace(source: &Path, destination: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };

    let source = source
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let destination = destination
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    // Both paths are validated local files. MoveFileExW supplies the replace
    // semantics that std::fs::rename intentionally does not guarantee on Windows.
    let moved = unsafe {
        MoveFileExW(
            source.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if moved == 0 {
        Err(format!(
            "无法原子替换控制文件: {}",
            std::io::Error::last_os_error()
        ))
    } else {
        Ok(())
    }
}

fn line_diff(previous: &str, next: &str) -> String {
    if previous == next {
        return String::new();
    }
    let mut output = String::from("--- current\n+++ proposed\n");
    for line in previous.lines() {
        output.push_str(&format!("-{line}\n"));
    }
    for line in next.lines() {
        output.push_str(&format!("+{line}\n"));
    }
    output
}

fn redacted_line_diff(previous: &str, next: &str) -> String {
    let redact = |line: &str| {
        if contains_secret(line) {
            "[REDACTED]".to_string()
        } else {
            line.to_string()
        }
    };
    if previous == next {
        return String::new();
    }
    let mut output = String::from("--- invalid\n+++ last-known-good\n");
    for line in previous.lines() {
        output.push_str(&format!("-{}\n", redact(line)));
    }
    for line in next.lines() {
        output.push_str(&format!("+{}\n", redact(line)));
    }
    output
}

fn body(content: &str) -> &str {
    content.splitn(3, "+++").nth(2).unwrap_or(content).trim()
}

fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}
fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
fn validate_identifier(value: &str, label: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 160
        || !value.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | ':')
        })
    {
        return Err(format!("{label} 无效"));
    }
    Ok(())
}
fn path_is_within(path: &Path, root: &Path) -> bool {
    if cfg!(windows) {
        let path_components = path
            .components()
            .map(|component| component.as_os_str().to_string_lossy().to_ascii_lowercase())
            .collect::<Vec<_>>();
        let root_components = root
            .components()
            .map(|component| component.as_os_str().to_string_lossy().to_ascii_lowercase())
            .collect::<Vec<_>>();
        path_components.starts_with(&root_components)
    } else {
        path.starts_with(root)
    }
}
fn user_error(
    path: &str,
    line: usize,
    column: usize,
    message: impl Into<String>,
) -> UserDirectoryError {
    UserDirectoryError {
        path: path.to_string(),
        line,
        column,
        message: message.into(),
        diff: None,
    }
}
fn io_error(prefix: &'static str) -> impl FnOnce(std::io::Error) -> String {
    move |error| format!("{prefix}: {error}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn initializes_complete_layout_without_overwriting_user_edits_or_beta_data() {
        let home = tempfile::tempdir().unwrap();
        let beta = home.path().join(".otto-user");
        fs::write(&beta, b"beta-byte-sentinel").unwrap();
        let directory = UserDirectory::initialize(home.path()).unwrap();
        for path in [
            "core.md",
            "soul.md",
            "project.md",
            "memory.md",
            "projects",
            "memory",
            "skills",
            "connectors/feishu.toml",
            "connectors/wecom.toml",
            "connectors/platforms.toml",
            "capabilities",
            "audit",
            ".history",
            ".state",
        ] {
            assert!(directory.root().join(path).exists(), "{path}");
        }
        let edited = markdown_template("soul") + "用户编辑\n";
        fs::write(directory.root().join("soul.md"), &edited).unwrap();
        UserDirectory::initialize(home.path()).unwrap();
        assert_eq!(
            fs::read_to_string(directory.root().join("soul.md")).unwrap(),
            edited
        );
        assert_eq!(fs::read(&beta).unwrap(), b"beta-byte-sentinel");
        assert_eq!(directory.background_task_count(), 0);
    }

    #[test]
    fn activates_edits_only_on_the_next_turn_boundary_and_uses_last_known_good() {
        let home = tempfile::tempdir().unwrap();
        let directory = UserDirectory::initialize(home.path()).unwrap();
        let first = directory.snapshot_at_turn_boundary();
        fs::write(
            directory.root().join("core.md"),
            markdown_template("core") + "new budget\n",
        )
        .unwrap();
        assert!(!UserDirectory::prompt_context(&first).contains("new budget"));
        let second = directory.snapshot_at_turn_boundary();
        assert!(UserDirectory::prompt_context(&second).contains("new budget"));
        fs::write(
            directory.root().join("core.md"),
            "+++\nschema_version = [\n+++\nbroken",
        )
        .unwrap();
        let third = directory.snapshot_at_turn_boundary();
        assert_eq!(third.errors.len(), 1);
        assert!(third.errors[0].line >= 2);
        assert!(
            third
                .documents
                .iter()
                .find(|document| document.kind == "core")
                .unwrap()
                .from_last_known_good
        );
        assert!(UserDirectory::prompt_context(&third).contains("new budget"));
        assert!(third.errors[0]
            .diff
            .as_deref()
            .unwrap()
            .contains("last-known-good"));
    }

    #[test]
    fn parses_bounded_core_overrides_without_weakening_hard_safety() {
        let home = tempfile::tempdir().unwrap();
        let directory = UserDirectory::initialize(home.path()).unwrap();
        let configured = "+++\nschema_version = 1\nkind = \"core\"\nmodel = \"model-1\"\nmax_output_tokens = 2048\nenabled_capabilities = [\"read_file\", \"search_text\"]\npolicy_default = \"cautious\"\n+++\n\nKeep answers concise.\n";
        fs::write(directory.root().join("core.md"), configured).unwrap();
        let snapshot = directory.snapshot_at_turn_boundary();
        let overrides = UserDirectory::core_overrides(&snapshot);
        assert_eq!(overrides.model.as_deref(), Some("model-1"));
        assert_eq!(overrides.max_output_tokens, Some(2048));
        assert_eq!(
            overrides.enabled_capabilities.unwrap(),
            ["read_file", "search_text"]
        );
        assert_eq!(overrides.policy_default.as_deref(), Some("cautious"));

        let unsafe_control =
            configured.replace("policy_default = \"cautious\"", "disable_approval = true");
        fs::write(directory.root().join("core.md"), unsafe_control).unwrap();
        let fallback = directory.snapshot_at_turn_boundary();
        assert_eq!(fallback.errors.len(), 1);
        assert!(fallback
            .documents
            .iter()
            .any(|document| document.kind == "core" && document.from_last_known_good));
    }

    #[test]
    fn restarts_with_invalid_user_edits_and_reports_connector_locations() {
        let home = tempfile::tempdir().unwrap();
        let directory = UserDirectory::initialize(home.path()).unwrap();
        fs::write(
            directory.root().join("core.md"),
            "+++\nschema_version = [\n+++\nbroken",
        )
        .unwrap();
        fs::write(
            directory.root().join("connectors/feishu.toml"),
            "schema_version = 1\nprovider = \"feishu\"\nenabled = [",
        )
        .unwrap();

        let restarted = UserDirectory::initialize(home.path()).unwrap();
        let snapshot = restarted.snapshot_at_turn_boundary();
        assert_eq!(snapshot.errors.len(), 2);
        assert!(snapshot
            .errors
            .iter()
            .all(|error| error.line > 0 && error.column > 0));
        assert!(snapshot
            .documents
            .iter()
            .filter(|document| matches!(
                document.path.as_str(),
                "core.md" | "connectors/feishu.toml"
            ))
            .all(|document| document.from_last_known_good));
    }

    #[test]
    fn requires_unchanged_diff_and_approval_then_writes_history_and_audit() {
        let home = tempfile::tempdir().unwrap();
        let directory = UserDirectory::initialize(home.path()).unwrap();
        let content = markdown_template("core") + "temperature = 0\n";
        let preview = directory
            .preview_agent_write("request-1", "core.md", &content)
            .unwrap();
        assert!(preview.diff.contains("+temperature = 0"));
        assert!(directory
            .apply_agent_write(&preview, &content, "agent-1", false)
            .is_err());
        let result = directory
            .apply_agent_write(&preview, &content, "agent-1", true)
            .unwrap();
        assert_eq!(result.revision, preview.next_revision);
        assert!(fs::read_dir(directory.root().join(".history"))
            .unwrap()
            .next()
            .is_some());
        let audit =
            fs::read_to_string(directory.root().join("audit/user-directory.jsonl")).unwrap();
        assert!(audit.contains("request-1"));
        assert!(audit.contains("rejected"));
        assert!(audit.contains("completed"));
    }

    #[test]
    fn rollback_restores_last_known_good_only_after_explicit_approval() {
        let home = tempfile::tempdir().unwrap();
        let directory = UserDirectory::initialize(home.path()).unwrap();
        let valid = markdown_template("project") + "stable rules\n";
        fs::write(directory.root().join("project.md"), &valid).unwrap();
        directory.snapshot_at_turn_boundary();
        fs::write(directory.root().join("project.md"), "broken").unwrap();

        assert!(directory
            .rollback_to_last_known_good("rollback-1", "project.md", "desktop-settings", false)
            .is_err());
        assert_eq!(
            fs::read_to_string(directory.root().join("project.md")).unwrap(),
            "broken"
        );
        let restored = directory
            .rollback_to_last_known_good("rollback-2", "project.md", "desktop-settings", true)
            .unwrap();
        assert_eq!(restored.content, valid);
        assert!(
            fs::read_to_string(directory.root().join("audit/user-directory.jsonl"))
                .unwrap()
                .contains("rollback-2")
        );
    }

    #[test]
    fn rejects_traversal_symlink_escape_and_secret_bearing_controls() {
        let home = tempfile::tempdir().unwrap();
        let directory = UserDirectory::initialize(home.path()).unwrap();
        assert!(directory
            .preview_agent_write("request-1", "../core.md", &markdown_template("core"))
            .is_err());
        assert!(directory
            .preview_agent_write(
                "request-1",
                "core.md",
                &(markdown_template("core") + "api_key = \"sk-secret\"\n")
            )
            .is_err());
        fs::write(
            directory.root().join("core.md"),
            markdown_template("core") + "api_key = \"sk-secret\"\n",
        )
        .unwrap();
        let snapshot = directory.snapshot_at_turn_boundary();
        let diff = snapshot.errors[0].diff.as_deref().unwrap();
        assert!(diff.contains("[REDACTED]"));
        assert!(!diff.contains("sk-secret"));
        #[cfg(unix)]
        {
            let outside = home.path().join("outside.md");
            fs::write(&outside, markdown_template("core")).unwrap();
            fs::remove_file(directory.root().join("core.md")).unwrap();
            std::os::unix::fs::symlink(&outside, directory.root().join("core.md")).unwrap();
            assert!(directory
                .preview_agent_write("request-2", "core.md", &markdown_template("core"))
                .is_err());
        }
    }
}
