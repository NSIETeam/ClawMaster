use crate::native_models::{ModelToolCall, ModelToolDefinition};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::fs;
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

const MAX_CHECKPOINT_FILE_BYTES: u64 = 32 * 1024 * 1024;
const MAX_VISIBLE_CHECKPOINTS: usize = 100;
const MAX_STORED_CHECKPOINTS: usize = 200;
const MAX_STORED_BYTES: u64 = 256 * 1024 * 1024;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct FileCheckpoint {
    version: u8,
    id: String,
    session_id: String,
    workspace_digest: String,
    relative_path: String,
    tool_name: String,
    created_at: u64,
    before_existed: bool,
    before_bytes: u64,
    before_sha256: Option<String>,
    after_sha256: Option<String>,
}

pub fn definitions() -> Vec<ModelToolDefinition> {
    vec![
        ModelToolDefinition {
            name: "list_file_checkpoints".into(),
            description: "List recoverable Rust-native file checkpoints for the current workspace. Checkpoints are created before direct file-writing tools.".into(),
            parameters: json!({"type":"object","properties":{},"additionalProperties":false}),
        },
        ModelToolDefinition {
            name: "restore_file_checkpoint".into(),
            description: "Restore one file to a Rust-native checkpoint. Refuses to overwrite later user edits and requires confirmation.".into(),
            parameters: json!({"type":"object","properties":{
                "checkpointId":{"type":"string","minLength":1,"maxLength":120}
            },"required":["checkpointId"],"additionalProperties":false}),
        },
    ]
}

pub fn summaries() -> Vec<Value> {
    definitions()
        .into_iter()
        .map(|tool| {
            json!({
                "name":tool.name,
                "displayName":tool.name,
                "description":tool.description
            })
        })
        .collect()
}

pub fn contains(name: &str) -> bool {
    matches!(name, "list_file_checkpoints" | "restore_file_checkpoint")
}

pub fn is_write(name: &str) -> bool {
    name == "restore_file_checkpoint"
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn workspace_digest(workspace: &Path) -> Result<String, String> {
    let root = workspace
        .canonicalize()
        .map_err(|error| format!("无法解析恢复工作目录: {error}"))?;
    Ok(digest(root.to_string_lossy().as_bytes()))
}

fn safe_id(value: &str) -> Result<&str, String> {
    if value.is_empty()
        || value.len() > 120
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    {
        return Err("文件恢复点 ID 无效".into());
    }
    Ok(value)
}

fn safe_target(workspace: &Path, value: &str) -> Result<(PathBuf, String), String> {
    let relative = Path::new(value);
    if relative.as_os_str().is_empty()
        || relative.is_absolute()
        || relative.components().any(|part| {
            matches!(
                part,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
    {
        return Err("恢复点路径必须位于当前工作目录".into());
    }
    let normalized = relative
        .components()
        .filter_map(|part| match part {
            Component::Normal(value) => value.to_str(),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("/");
    if normalized.is_empty() {
        return Err("恢复点路径无效".into());
    }
    let root = workspace
        .canonicalize()
        .map_err(|error| format!("无法解析恢复工作目录: {error}"))?;
    let candidate = root.join(&normalized);
    let parent = candidate
        .parent()
        .ok_or_else(|| "恢复点路径缺少父目录".to_string())?;
    let mut existing_parent = parent;
    while !existing_parent.exists() {
        existing_parent = existing_parent
            .parent()
            .ok_or_else(|| "恢复点路径缺少可验证的父目录".to_string())?;
    }
    let verified_parent = existing_parent
        .canonicalize()
        .map_err(|error| format!("无法解析恢复点目标目录: {error}"))?;
    if !verified_parent.starts_with(&root) {
        return Err("恢复点拒绝访问工作目录以外的路径".into());
    }
    let target = candidate;
    if fs::symlink_metadata(&target).is_ok_and(|metadata| metadata.file_type().is_symlink()) {
        return Err("恢复点拒绝跟随符号链接".into());
    }
    Ok((target, normalized))
}

fn metadata_path(root: &Path, id: &str) -> PathBuf {
    root.join(format!("{id}.json"))
}

fn payload_path(root: &Path, id: &str) -> PathBuf {
    root.join(format!("{id}.bin"))
}

fn unique_sibling(path: &Path, label: &str) -> Result<PathBuf, String> {
    let mut random = [0_u8; 8];
    getrandom::getrandom(&mut random).map_err(|error| format!("无法创建临时文件名: {error}"))?;
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "恢复目标文件名无效".to_string())?;
    Ok(path.with_file_name(format!(
        ".{file_name}.clawmaster-{label}-{:x}",
        u64::from_le_bytes(random)
    )))
}

fn commit_replace(path: &Path, temporary: &Path) -> Result<(), String> {
    let backup = unique_sibling(path, "backup")?;
    let existed = path.exists();
    if existed {
        fs::rename(path, &backup).map_err(|error| format!("无法暂存恢复目标: {error}"))?;
    }
    if let Err(error) = fs::rename(temporary, path) {
        if existed {
            let _ = fs::rename(&backup, path);
        }
        let _ = fs::remove_file(temporary);
        return Err(format!("无法提交恢复点: {error}"));
    }
    if existed {
        let _ = fs::remove_file(backup);
    }
    Ok(())
}

fn private_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let temporary = unique_sibling(path, "checkpoint-tmp")?;
    let mut file =
        fs::File::create(&temporary).map_err(|error| format!("无法创建恢复点临时文件: {error}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Err(error) = fs::set_permissions(&temporary, fs::Permissions::from_mode(0o600)) {
            drop(file);
            let _ = fs::remove_file(&temporary);
            return Err(format!("无法保护恢复点权限: {error}"));
        }
    }
    if let Err(error) = file.write_all(bytes).and_then(|_| file.sync_all()) {
        drop(file);
        let _ = fs::remove_file(&temporary);
        return Err(format!("无法写入恢复点: {error}"));
    }
    drop(file);
    commit_replace(path, &temporary)
}

fn restore_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let temporary = unique_sibling(path, "restore-tmp")?;
    let permissions = fs::metadata(path)
        .ok()
        .map(|metadata| metadata.permissions());
    let mut file =
        fs::File::create(&temporary).map_err(|error| format!("无法创建恢复临时文件: {error}"))?;
    if let Some(permissions) = permissions {
        if let Err(error) = fs::set_permissions(&temporary, permissions) {
            drop(file);
            let _ = fs::remove_file(&temporary);
            return Err(format!("无法保留恢复目标权限: {error}"));
        }
    }
    if let Err(error) = file.write_all(bytes).and_then(|_| file.sync_all()) {
        drop(file);
        let _ = fs::remove_file(&temporary);
        return Err(format!("无法写入恢复内容: {error}"));
    }
    drop(file);
    commit_replace(path, &temporary)
}

fn save(root: &Path, checkpoint: &FileCheckpoint) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(checkpoint)
        .map_err(|error| format!("无法编码恢复点: {error}"))?;
    private_write(&metadata_path(root, &checkpoint.id), &bytes)
}

fn load(root: &Path, id: &str) -> Result<FileCheckpoint, String> {
    let id = safe_id(id)?;
    let bytes = fs::read(metadata_path(root, id))
        .map_err(|error| format!("无法读取文件恢复点: {error}"))?;
    let checkpoint: FileCheckpoint =
        serde_json::from_slice(&bytes).map_err(|error| format!("文件恢复点已损坏: {error}"))?;
    if checkpoint.version != 1 || checkpoint.id != id {
        return Err("文件恢复点版本或身份无效".into());
    }
    Ok(checkpoint)
}

fn prune(root: &Path, preserve_id: &str) {
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    let mut checkpoints = entries
        .filter_map(Result::ok)
        .filter(|entry| entry.path().extension().and_then(|value| value.to_str()) == Some("json"))
        .filter_map(|entry| {
            let checkpoint = fs::read(entry.path())
                .ok()
                .and_then(|bytes| serde_json::from_slice::<FileCheckpoint>(&bytes).ok())?;
            Some(checkpoint)
        })
        .collect::<Vec<_>>();
    checkpoints.sort_by_key(|checkpoint| checkpoint.created_at);
    let mut total_bytes = checkpoints
        .iter()
        .map(|checkpoint| {
            fs::metadata(payload_path(root, &checkpoint.id))
                .map(|metadata| metadata.len())
                .unwrap_or(0)
        })
        .sum::<u64>();
    while checkpoints.len() > MAX_STORED_CHECKPOINTS || total_bytes > MAX_STORED_BYTES {
        let Some(index) = checkpoints
            .iter()
            .position(|checkpoint| checkpoint.id != preserve_id)
        else {
            break;
        };
        let checkpoint = checkpoints.remove(index);
        total_bytes = total_bytes.saturating_sub(
            fs::metadata(payload_path(root, &checkpoint.id))
                .map(|metadata| metadata.len())
                .unwrap_or(0),
        );
        discard(root, &checkpoint.id);
    }
}

fn read_target(path: &Path) -> Result<Option<Vec<u8>>, String> {
    let metadata = match fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("无法读取恢复目标信息: {error}")),
    };
    if !metadata.is_file() || metadata.len() > MAX_CHECKPOINT_FILE_BYTES {
        return Err("文件恢复仅支持不超过 32 MiB 的普通文件".into());
    }
    fs::read(path)
        .map(Some)
        .map_err(|error| format!("无法读取恢复目标: {error}"))
}

pub fn capture(
    root: &Path,
    workspace: &Path,
    session_id: &str,
    tool_name: &str,
    relative_path: &str,
) -> Result<String, String> {
    fs::create_dir_all(root).map_err(|error| format!("无法创建文件恢复目录: {error}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(root, fs::Permissions::from_mode(0o700))
            .map_err(|error| format!("无法保护文件恢复目录: {error}"))?;
    }
    let (target, normalized) = safe_target(workspace, relative_path)?;
    let before = read_target(&target)?;
    let mut random = [0_u8; 8];
    getrandom::getrandom(&mut random).map_err(|error| format!("无法创建恢复点 ID: {error}"))?;
    let id = format!("cp-{:x}-{:x}", now_ms(), u64::from_le_bytes(random));
    if let Some(bytes) = before.as_ref() {
        private_write(&payload_path(root, &id), bytes)?;
    }
    let checkpoint = FileCheckpoint {
        version: 1,
        id: id.clone(),
        session_id: session_id.chars().take(160).collect(),
        workspace_digest: workspace_digest(workspace)?,
        relative_path: normalized,
        tool_name: tool_name.chars().take(120).collect(),
        created_at: now_ms(),
        before_existed: before.is_some(),
        before_bytes: before.as_ref().map_or(0, |bytes| bytes.len() as u64),
        before_sha256: before.as_ref().map(|bytes| digest(bytes)),
        after_sha256: None,
    };
    if let Err(error) = save(root, &checkpoint) {
        let _ = fs::remove_file(payload_path(root, &id));
        return Err(error);
    }
    prune(root, &id);
    Ok(id)
}

pub fn finalize(root: &Path, workspace: &Path, id: &str) -> Result<(), String> {
    let mut checkpoint = load(root, id)?;
    if checkpoint.workspace_digest != workspace_digest(workspace)? {
        return Err("恢复点不属于当前工作目录".into());
    }
    let (target, normalized) = safe_target(workspace, &checkpoint.relative_path)?;
    if normalized != checkpoint.relative_path {
        return Err("恢复点路径身份不一致".into());
    }
    checkpoint.after_sha256 = read_target(&target)?.as_ref().map(|bytes| digest(bytes));
    save(root, &checkpoint)
}

pub fn discard(root: &Path, id: &str) {
    if safe_id(id).is_ok() {
        let _ = fs::remove_file(metadata_path(root, id));
        let _ = fs::remove_file(payload_path(root, id));
    }
}

fn public_value(checkpoint: &FileCheckpoint) -> Value {
    json!({
        "id":checkpoint.id,
        "sessionId":checkpoint.session_id,
        "path":checkpoint.relative_path,
        "toolName":checkpoint.tool_name,
        "createdAt":checkpoint.created_at,
        "beforeExisted":checkpoint.before_existed,
        "beforeBytes":checkpoint.before_bytes,
        "ready":checkpoint.after_sha256.is_some()
    })
}

pub fn list(root: &Path, workspace: &Path) -> Result<Vec<Value>, String> {
    let expected_workspace = workspace_digest(workspace)?;
    let entries = match fs::read_dir(root) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(format!("无法读取文件恢复目录: {error}")),
    };
    let mut checkpoints = entries
        .filter_map(Result::ok)
        .filter(|entry| entry.path().extension().and_then(|value| value.to_str()) == Some("json"))
        .filter_map(|entry| fs::read(entry.path()).ok())
        .filter_map(|bytes| serde_json::from_slice::<FileCheckpoint>(&bytes).ok())
        .filter(|checkpoint| {
            checkpoint.version == 1 && checkpoint.workspace_digest == expected_workspace
        })
        .collect::<Vec<_>>();
    checkpoints.sort_by(|left, right| right.created_at.cmp(&left.created_at));
    checkpoints.truncate(MAX_VISIBLE_CHECKPOINTS);
    Ok(checkpoints.iter().map(public_value).collect())
}

pub fn describe(root: &Path, workspace: &Path, id: &str) -> Result<Value, String> {
    let checkpoint = load(root, id)?;
    if checkpoint.workspace_digest != workspace_digest(workspace)? {
        return Err("恢复点不属于当前工作目录".into());
    }
    Ok(public_value(&checkpoint))
}

pub fn restore(root: &Path, workspace: &Path, session_id: &str, id: &str) -> Result<Value, String> {
    let checkpoint = load(root, id)?;
    if checkpoint.workspace_digest != workspace_digest(workspace)? {
        return Err("恢复点不属于当前工作目录".into());
    }
    let expected_current = checkpoint
        .after_sha256
        .as_deref()
        .ok_or_else(|| "恢复点尚未完成，不能使用".to_string())?;
    let (target, normalized) = safe_target(workspace, &checkpoint.relative_path)?;
    if normalized != checkpoint.relative_path {
        return Err("恢复点路径身份不一致".into());
    }
    let current = read_target(&target)?;
    if current.as_ref().map(|bytes| digest(bytes)).as_deref() != Some(expected_current) {
        return Err("文件在恢复点之后又被修改，已拒绝覆盖用户的新改动".into());
    }
    let safety_id = capture(
        root,
        workspace,
        session_id,
        "restore_file_checkpoint",
        &checkpoint.relative_path,
    )?;
    let applied = if checkpoint.before_existed {
        let payload = fs::read(payload_path(root, &checkpoint.id))
            .map_err(|error| format!("无法读取恢复点内容: {error}"))?;
        let payload_digest = digest(&payload);
        if payload.len() as u64 != checkpoint.before_bytes
            || checkpoint.before_sha256.as_deref() != Some(payload_digest.as_str())
        {
            discard(root, &safety_id);
            return Err("恢复点内容摘要不一致，已拒绝恢复".into());
        }
        if let Err(error) = restore_write(&target, &payload) {
            discard(root, &safety_id);
            return Err(error);
        }
        "restored"
    } else {
        if target.exists() {
            if let Err(error) = fs::remove_file(&target) {
                discard(root, &safety_id);
                return Err(format!("无法移除恢复点后创建的文件: {error}"));
            }
        }
        "removed"
    };
    if let Err(error) = finalize(root, workspace, &safety_id) {
        discard(root, &safety_id);
        return Ok(json!({
            "restored":true,"checkpointId":checkpoint.id,"safetyCheckpointId":Value::Null,
            "path":checkpoint.relative_path,"action":applied,
            "warning":format!("文件已恢复，但撤销恢复点创建失败: {error}")
        }));
    }
    Ok(json!({
        "restored":true,"checkpointId":checkpoint.id,"safetyCheckpointId":safety_id,
        "path":checkpoint.relative_path,"action":applied
    }))
}

pub fn execute(
    root: &Path,
    workspace: &Path,
    session_id: &str,
    call: &ModelToolCall,
) -> Result<Value, String> {
    match call.name.as_str() {
        "list_file_checkpoints" => Ok(json!({"checkpoints":list(root, workspace)?})),
        "restore_file_checkpoint" => restore(
            root,
            workspace,
            session_id,
            call.arguments
                .get("checkpointId")
                .and_then(Value::as_str)
                .unwrap_or(""),
        ),
        _ => Err("未知文件恢复工具".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn restores_a_file_and_keeps_an_undo_checkpoint() {
        let workspace = tempfile::tempdir().unwrap();
        let store = tempfile::tempdir().unwrap();
        fs::write(workspace.path().join("note.txt"), b"before").unwrap();
        fs::write(
            workspace.path().join("note.clawmaster-checkpoint-backup"),
            b"user-owned",
        )
        .unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(
                workspace.path().join("note.txt"),
                fs::Permissions::from_mode(0o640),
            )
            .unwrap();
        }
        let id = capture(
            store.path(),
            workspace.path(),
            "s1",
            "write_file",
            "note.txt",
        )
        .unwrap();
        fs::write(workspace.path().join("note.txt"), b"after").unwrap();
        finalize(store.path(), workspace.path(), &id).unwrap();
        let result = restore(store.path(), workspace.path(), "s1", &id).unwrap();
        assert_eq!(
            fs::read(workspace.path().join("note.txt")).unwrap(),
            b"before"
        );
        assert_eq!(
            fs::read(workspace.path().join("note.clawmaster-checkpoint-backup")).unwrap(),
            b"user-owned"
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(store.path()).unwrap().permissions().mode() & 0o777,
                0o700
            );
            assert_eq!(
                fs::metadata(workspace.path().join("note.txt"))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o640
            );
        }
        assert!(result["safetyCheckpointId"]
            .as_str()
            .unwrap()
            .starts_with("cp-"));
        assert_eq!(list(store.path(), workspace.path()).unwrap().len(), 2);
    }

    #[test]
    fn removes_a_file_created_after_the_checkpoint() {
        let workspace = tempfile::tempdir().unwrap();
        let store = tempfile::tempdir().unwrap();
        let id = capture(
            store.path(),
            workspace.path(),
            "s1",
            "write_file",
            "new.txt",
        )
        .unwrap();
        fs::write(workspace.path().join("new.txt"), b"created").unwrap();
        finalize(store.path(), workspace.path(), &id).unwrap();
        restore(store.path(), workspace.path(), "s1", &id).unwrap();
        assert!(!workspace.path().join("new.txt").exists());
    }

    #[test]
    fn refuses_to_overwrite_later_user_edits_or_escape_the_workspace() {
        let workspace = tempfile::tempdir().unwrap();
        let store = tempfile::tempdir().unwrap();
        fs::write(workspace.path().join("note.txt"), b"before").unwrap();
        let id = capture(
            store.path(),
            workspace.path(),
            "s1",
            "write_file",
            "note.txt",
        )
        .unwrap();
        fs::write(workspace.path().join("note.txt"), b"agent edit").unwrap();
        finalize(store.path(), workspace.path(), &id).unwrap();
        fs::write(workspace.path().join("note.txt"), b"user edit").unwrap();
        assert!(restore(store.path(), workspace.path(), "s1", &id)
            .unwrap_err()
            .contains("拒绝覆盖"));
        assert!(capture(
            store.path(),
            workspace.path(),
            "s1",
            "write_file",
            "../outside.txt"
        )
        .is_err());
        let nested = capture(
            store.path(),
            workspace.path(),
            "s1",
            "write_file",
            "not-created/deep/file.txt",
        )
        .unwrap();
        assert!(!workspace.path().join("not-created").exists());
        discard(store.path(), &nested);
    }

    #[test]
    fn bounds_checkpoint_retention() {
        let workspace = tempfile::tempdir().unwrap();
        let store = tempfile::tempdir().unwrap();
        let mut latest_id = String::new();
        for index in 0..=MAX_STORED_CHECKPOINTS {
            let path = format!("file-{index}.txt");
            fs::write(workspace.path().join(&path), b"before").unwrap();
            latest_id = capture(store.path(), workspace.path(), "s1", "write_file", &path).unwrap();
        }
        let metadata_count = fs::read_dir(store.path())
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| {
                entry.path().extension().and_then(|value| value.to_str()) == Some("json")
            })
            .count();
        assert_eq!(metadata_count, MAX_STORED_CHECKPOINTS);
        assert!(metadata_path(store.path(), &latest_id).exists());
    }
}
