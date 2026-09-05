use crate::native_models::{ModelToolCall, ModelToolDefinition};
use crate::native_state_store::{
    ArtifactRef, NativeStateStore, TREE_ARTIFACTS, TREE_ARTIFACT_METADATA, TREE_CHECKPOINTS,
    TREE_INDEX,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::fs;
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

const MAX_FILE_BYTES: u64 = 32 * 1024 * 1024;
const MAX_VISIBLE: usize = 100;
const MAX_STORED: usize = 200;
const MAX_STORED_BYTES: u64 = 256 * 1024 * 1024;
const IMPORT_MARKER: &str = "checkpoint-import-v1";

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Checkpoint {
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
    #[serde(default)]
    artifact: Option<ArtifactRef>,
}

pub fn definitions() -> Vec<ModelToolDefinition> {
    vec![
        ModelToolDefinition {
            name: "list_file_checkpoints".into(),
            description: "List encrypted file checkpoints for the current workspace.".into(),
            parameters: json!({"type":"object","properties":{},"additionalProperties":false}),
        },
        ModelToolDefinition {
            name: "restore_file_checkpoint".into(),
            description: "Restore an encrypted checkpoint without overwriting later user edits."
                .into(),
            parameters: json!({"type":"object","properties":{
                "checkpointId":{"type":"string","minLength":1,"maxLength":120}
            },"required":["checkpointId"],"additionalProperties":false}),
        },
    ]
}

pub fn summaries() -> Vec<Value> {
    definitions()
        .into_iter()
        .map(
            |tool| json!({"name":tool.name,"displayName":tool.name,"description":tool.description}),
        )
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
        Err("文件恢复点 ID 无效".into())
    } else {
        Ok(value)
    }
}

fn target(workspace: &Path, value: &str) -> Result<(PathBuf, String), String> {
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
    let root = workspace
        .canonicalize()
        .map_err(|error| format!("无法解析恢复工作目录: {error}"))?;
    let candidate = root.join(&normalized);
    let mut parent = candidate
        .parent()
        .ok_or_else(|| "恢复点路径缺少父目录".to_string())?;
    while !parent.exists() {
        parent = parent
            .parent()
            .ok_or_else(|| "恢复点路径缺少可验证的父目录".to_string())?;
    }
    if !parent
        .canonicalize()
        .map_err(|error| format!("无法解析恢复点目标目录: {error}"))?
        .starts_with(&root)
    {
        return Err("恢复点拒绝访问工作目录以外的路径".into());
    }
    if fs::symlink_metadata(&candidate).is_ok_and(|value| value.file_type().is_symlink()) {
        return Err("恢复点拒绝跟随符号链接".into());
    }
    Ok((candidate, normalized))
}

fn read_target(path: &Path) -> Result<Option<Vec<u8>>, String> {
    let metadata = match fs::metadata(path) {
        Ok(value) => value,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("无法读取恢复目标信息: {error}")),
    };
    if !metadata.is_file() || metadata.len() > MAX_FILE_BYTES {
        return Err("文件恢复仅支持不超过 32 MiB 的普通文件".into());
    }
    fs::read(path)
        .map(Some)
        .map_err(|error| format!("无法读取恢复目标: {error}"))
}

fn legacy_metadata(root: &Path, id: &str) -> PathBuf {
    root.join(format!("{id}.json"))
}

fn legacy_payload(root: &Path, id: &str) -> PathBuf {
    root.join(format!("{id}.bin"))
}

fn import(store: &NativeStateStore, legacy_root: &Path) -> Result<(), String> {
    if store
        .get::<bool>(TREE_INDEX, IMPORT_MARKER)
        .map_err(|error| error.to_string())?
        .is_some()
    {
        return Ok(());
    }
    if let Ok(entries) = fs::read_dir(legacy_root) {
        for entry in entries.filter_map(Result::ok) {
            if entry.path().extension().and_then(|value| value.to_str()) != Some("json") {
                continue;
            }
            let Ok(bytes) = fs::read(entry.path()) else {
                continue;
            };
            let Ok(mut checkpoint) = serde_json::from_slice::<Checkpoint>(&bytes) else {
                continue;
            };
            if safe_id(&checkpoint.id).is_err() {
                continue;
            }
            if checkpoint.before_existed {
                let Ok(payload) = fs::read(legacy_payload(legacy_root, &checkpoint.id)) else {
                    continue;
                };
                if payload.len() as u64 != checkpoint.before_bytes
                    || checkpoint.before_sha256.as_deref() != Some(digest(&payload).as_str())
                {
                    continue;
                }
                checkpoint.artifact = Some(
                    store
                        .put_artifact("legacy-checkpoint", &payload)
                        .map_err(|error| error.to_string())?,
                );
            }
            checkpoint.version = 2;
            let id = checkpoint.id.clone();
            store
                .put_latest(TREE_CHECKPOINTS, &id, "legacy-checkpoint", checkpoint)
                .map_err(|error| error.to_string())?;
        }
    }
    store
        .put_latest(TREE_INDEX, IMPORT_MARKER, "native-checkpoint", true)
        .map_err(|error| error.to_string())?;
    store.flush().map_err(|error| error.to_string())
}

fn all(store: &NativeStateStore, legacy_root: &Path) -> Result<Vec<Checkpoint>, String> {
    import(store, legacy_root)?;
    Ok(store
        .scan::<Checkpoint>(TREE_CHECKPOINTS)
        .map_err(|error| error.to_string())?
        .records
        .into_iter()
        .map(|record| record.payload)
        .collect())
}

fn load(store: &NativeStateStore, legacy_root: &Path, id: &str) -> Result<Checkpoint, String> {
    let id = safe_id(id)?;
    import(store, legacy_root)?;
    let checkpoint = store
        .get::<Checkpoint>(TREE_CHECKPOINTS, id)
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "文件恢复点不存在".to_string())?
        .payload;
    if checkpoint.version != 2 || checkpoint.id != id {
        Err("文件恢复点版本或身份无效".into())
    } else {
        Ok(checkpoint)
    }
}

pub fn discard(store: &NativeStateStore, id: &str) {
    let artifact = store
        .get::<Checkpoint>(TREE_CHECKPOINTS, id)
        .ok()
        .flatten()
        .and_then(|record| record.payload.artifact);
    let _ = store.delete(TREE_CHECKPOINTS, id);
    if let Some(reference) = artifact {
        let referenced = store
            .scan::<Checkpoint>(TREE_CHECKPOINTS)
            .map(|result| {
                result.records.iter().any(|record| {
                    record
                        .payload
                        .artifact
                        .as_ref()
                        .is_some_and(|value| value.sha256 == reference.sha256)
                })
            })
            .unwrap_or(true);
        if !referenced {
            let _ = store.delete(TREE_ARTIFACTS, &reference.sha256);
            let _ = store.delete(TREE_ARTIFACT_METADATA, &reference.sha256);
        }
    }
    let _ = store.flush();
}

fn prune(store: &NativeStateStore, legacy_root: &Path, preserve: &str) -> Result<(), String> {
    let mut checkpoints = all(store, legacy_root)?;
    checkpoints.sort_by_key(|value| value.created_at);
    let mut bytes = checkpoints
        .iter()
        .map(|value| value.before_bytes)
        .sum::<u64>();
    while checkpoints.len() > MAX_STORED || bytes > MAX_STORED_BYTES {
        let Some(index) = checkpoints.iter().position(|value| value.id != preserve) else {
            break;
        };
        let checkpoint = checkpoints.remove(index);
        bytes = bytes.saturating_sub(checkpoint.before_bytes);
        discard(store, &checkpoint.id);
    }
    Ok(())
}

pub fn capture(
    store: &NativeStateStore,
    legacy_root: &Path,
    workspace: &Path,
    session_id: &str,
    tool_name: &str,
    relative_path: &str,
) -> Result<String, String> {
    import(store, legacy_root)?;
    let (path, relative_path) = target(workspace, relative_path)?;
    let before = read_target(&path)?;
    let mut random = [0_u8; 8];
    getrandom::getrandom(&mut random).map_err(|error| format!("无法创建恢复点 ID: {error}"))?;
    let id = format!("cp-{:x}-{:x}", now_ms(), u64::from_le_bytes(random));
    let artifact = before
        .as_ref()
        .map(|bytes| store.put_artifact("native-checkpoint", bytes))
        .transpose()
        .map_err(|error| error.to_string())?;
    let checkpoint = Checkpoint {
        version: 2,
        id: id.clone(),
        session_id: session_id.chars().take(160).collect(),
        workspace_digest: workspace_digest(workspace)?,
        relative_path,
        tool_name: tool_name.chars().take(120).collect(),
        created_at: now_ms(),
        before_existed: before.is_some(),
        before_bytes: before.as_ref().map_or(0, |value| value.len() as u64),
        before_sha256: before.as_ref().map(|value| digest(value)),
        after_sha256: None,
        artifact,
    };
    store
        .commit_checkpoint_event(
            &id,
            &format!("checkpoint:{id}:captured"),
            session_id,
            &serde_json::to_value(&checkpoint).map_err(|error| error.to_string())?,
            &json!({"type":"checkpointCaptured","checkpointId":id,"timestamp":now_ms()}),
        )
        .map_err(|error| error.to_string())?;
    store.flush().map_err(|error| error.to_string())?;
    prune(store, legacy_root, &id)?;
    Ok(id)
}

pub fn finalize(
    store: &NativeStateStore,
    legacy_root: &Path,
    workspace: &Path,
    id: &str,
) -> Result<(), String> {
    let mut checkpoint = load(store, legacy_root, id)?;
    if checkpoint.workspace_digest != workspace_digest(workspace)? {
        return Err("恢复点不属于当前工作目录".into());
    }
    let (path, normalized) = target(workspace, &checkpoint.relative_path)?;
    if normalized != checkpoint.relative_path {
        return Err("恢复点路径身份不一致".into());
    }
    checkpoint.after_sha256 = read_target(&path)?.as_ref().map(|value| digest(value));
    let session_id = checkpoint.session_id.clone();
    store
        .put_latest(TREE_CHECKPOINTS, id, &session_id, checkpoint)
        .map_err(|error| error.to_string())?;
    store.flush().map_err(|error| error.to_string())
}

fn public(checkpoint: &Checkpoint) -> Value {
    json!({"id":checkpoint.id,"sessionId":checkpoint.session_id,
        "path":checkpoint.relative_path,"toolName":checkpoint.tool_name,
        "createdAt":checkpoint.created_at,"beforeExisted":checkpoint.before_existed,
        "beforeBytes":checkpoint.before_bytes,"ready":checkpoint.after_sha256.is_some()})
}

pub fn list(
    store: &NativeStateStore,
    legacy_root: &Path,
    workspace: &Path,
) -> Result<Vec<Value>, String> {
    let workspace = workspace_digest(workspace)?;
    let mut values = all(store, legacy_root)?
        .into_iter()
        .filter(|value| value.workspace_digest == workspace)
        .collect::<Vec<_>>();
    values.sort_by(|left, right| right.created_at.cmp(&left.created_at));
    values.truncate(MAX_VISIBLE);
    Ok(values.iter().map(public).collect())
}

pub fn describe(
    store: &NativeStateStore,
    legacy_root: &Path,
    workspace: &Path,
    id: &str,
) -> Result<Value, String> {
    let checkpoint = load(store, legacy_root, id)?;
    if checkpoint.workspace_digest != workspace_digest(workspace)? {
        return Err("恢复点不属于当前工作目录".into());
    }
    Ok(public(&checkpoint))
}

fn replace(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let mut random = [0_u8; 8];
    getrandom::getrandom(&mut random).map_err(|error| format!("无法创建临时文件名: {error}"))?;
    let temporary = path.with_extension(format!("clawmaster-{:x}.tmp", u64::from_le_bytes(random)));
    let permissions = fs::metadata(path).ok().map(|value| value.permissions());
    let mut file =
        fs::File::create(&temporary).map_err(|error| format!("无法创建恢复临时文件: {error}"))?;
    if let Some(value) = permissions {
        fs::set_permissions(&temporary, value)
            .map_err(|error| format!("无法保留恢复目标权限: {error}"))?;
    }
    file.write_all(bytes)
        .and_then(|_| file.sync_all())
        .map_err(|error| format!("无法写入恢复内容: {error}"))?;
    drop(file);
    let backup = path.with_extension("clawmaster-restore-backup");
    if path.exists() {
        fs::rename(path, &backup).map_err(|error| format!("无法暂存恢复目标: {error}"))?;
    }
    if let Err(error) = fs::rename(&temporary, path) {
        if backup.exists() {
            let _ = fs::rename(&backup, path);
        }
        return Err(format!("无法提交恢复点: {error}"));
    }
    let _ = fs::remove_file(backup);
    Ok(())
}

pub fn restore(
    store: &NativeStateStore,
    legacy_root: &Path,
    workspace: &Path,
    session_id: &str,
    id: &str,
) -> Result<Value, String> {
    let checkpoint = load(store, legacy_root, id)?;
    if checkpoint.workspace_digest != workspace_digest(workspace)? {
        return Err("恢复点不属于当前工作目录".into());
    }
    let expected = checkpoint
        .after_sha256
        .as_deref()
        .ok_or_else(|| "恢复点尚未完成，不能使用".to_string())?;
    let (path, normalized) = target(workspace, &checkpoint.relative_path)?;
    if normalized != checkpoint.relative_path
        || read_target(&path)?
            .as_ref()
            .map(|value| digest(value))
            .as_deref()
            != Some(expected)
    {
        return Err("文件在恢复点之后又被修改，已拒绝覆盖用户的新改动".into());
    }
    let payload = checkpoint
        .artifact
        .as_ref()
        .map(|value| store.read_artifact(value))
        .transpose()
        .map_err(|error| error.to_string())?;
    if checkpoint.before_existed && payload.is_none() {
        return Err("恢复点缺少加密内容引用".into());
    }
    let undo = capture(
        store,
        legacy_root,
        workspace,
        session_id,
        "restore_file_checkpoint",
        &checkpoint.relative_path,
    )?;
    let action = if let Some(bytes) = payload {
        if bytes.len() as u64 != checkpoint.before_bytes
            || checkpoint.before_sha256.as_deref() != Some(digest(&bytes).as_str())
        {
            discard(store, &undo);
            return Err("恢复点内容摘要不一致，已拒绝恢复".into());
        }
        replace(&path, &bytes)?;
        "restored"
    } else {
        if path.exists() {
            fs::remove_file(&path)
                .map_err(|error| format!("无法移除恢复点后创建的文件: {error}"))?;
        }
        "removed"
    };
    finalize(store, legacy_root, workspace, &undo)?;
    Ok(json!({"restored":true,"checkpointId":checkpoint.id,
        "safetyCheckpointId":undo,"path":checkpoint.relative_path,"action":action}))
}

pub fn execute(
    store: &NativeStateStore,
    legacy_root: &Path,
    workspace: &Path,
    session_id: &str,
    call: &ModelToolCall,
) -> Result<Value, String> {
    match call.name.as_str() {
        "list_file_checkpoints" => Ok(json!({"checkpoints":list(store, legacy_root, workspace)?})),
        "restore_file_checkpoint" => restore(
            store,
            legacy_root,
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

    fn store_contains(root: &Path, needle: &[u8]) -> bool {
        fn visit(path: &Path, needle: &[u8]) -> bool {
            if path.is_dir() {
                return fs::read_dir(path)
                    .into_iter()
                    .flatten()
                    .flatten()
                    .any(|entry| visit(&entry.path(), needle));
            }
            fs::read(path)
                .map(|bytes| bytes.windows(needle.len()).any(|value| value == needle))
                .unwrap_or(false)
        }
        visit(&root.join("runtime-store-v1"), needle)
    }

    #[test]
    fn encrypted_capture_restore_and_undo_are_complete() {
        let workspace = tempfile::tempdir().unwrap();
        let data = tempfile::tempdir().unwrap();
        let store = NativeStateStore::open_for_test(data.path(), [41; 32]).unwrap();
        fs::write(workspace.path().join("note.txt"), b"before").unwrap();
        let id = capture(
            &store,
            data.path(),
            workspace.path(),
            "s1",
            "write_file",
            "note.txt",
        )
        .unwrap();
        store.flush().unwrap();
        assert!(!store_contains(data.path(), b"before"));
        fs::write(workspace.path().join("note.txt"), b"after").unwrap();
        finalize(&store, data.path(), workspace.path(), &id).unwrap();
        let result = restore(&store, data.path(), workspace.path(), "s1", &id).unwrap();
        assert_eq!(
            fs::read(workspace.path().join("note.txt")).unwrap(),
            b"before"
        );
        assert!(result["safetyCheckpointId"]
            .as_str()
            .unwrap()
            .starts_with("cp-"));
        assert_eq!(store.count(TREE_CHECKPOINTS).unwrap(), 2);
    }

    #[test]
    fn rejects_later_edits_and_path_escape() {
        let workspace = tempfile::tempdir().unwrap();
        let data = tempfile::tempdir().unwrap();
        let store = NativeStateStore::open_for_test(data.path(), [42; 32]).unwrap();
        fs::write(workspace.path().join("note.txt"), b"before").unwrap();
        let id = capture(
            &store,
            data.path(),
            workspace.path(),
            "s1",
            "write_file",
            "note.txt",
        )
        .unwrap();
        fs::write(workspace.path().join("note.txt"), b"agent").unwrap();
        finalize(&store, data.path(), workspace.path(), &id).unwrap();
        fs::write(workspace.path().join("note.txt"), b"user").unwrap();
        assert!(restore(&store, data.path(), workspace.path(), "s1", &id).is_err());
        assert!(capture(
            &store,
            data.path(),
            workspace.path(),
            "s1",
            "write_file",
            "../x"
        )
        .is_err());
    }

    #[test]
    fn imports_legacy_bytes_without_modification() {
        let workspace = tempfile::tempdir().unwrap();
        let data = tempfile::tempdir().unwrap();
        let legacy = data.path().join("legacy");
        fs::create_dir_all(&legacy).unwrap();
        let payload = b"legacy";
        let checkpoint = Checkpoint {
            version: 1,
            id: "cp-legacy".into(),
            session_id: "s1".into(),
            workspace_digest: workspace_digest(workspace.path()).unwrap(),
            relative_path: "note.txt".into(),
            tool_name: "write_file".into(),
            created_at: now_ms(),
            before_existed: true,
            before_bytes: payload.len() as u64,
            before_sha256: Some(digest(payload)),
            after_sha256: Some(digest(b"after")),
            artifact: None,
        };
        let metadata = serde_json::to_vec_pretty(&checkpoint).unwrap();
        fs::write(legacy_metadata(&legacy, &checkpoint.id), &metadata).unwrap();
        fs::write(legacy_payload(&legacy, &checkpoint.id), payload).unwrap();
        let store = NativeStateStore::open_for_test(data.path(), [43; 32]).unwrap();
        assert_eq!(list(&store, &legacy, workspace.path()).unwrap().len(), 1);
        assert_eq!(
            fs::read(legacy_metadata(&legacy, &checkpoint.id)).unwrap(),
            metadata
        );
        assert_eq!(
            fs::read(legacy_payload(&legacy, &checkpoint.id)).unwrap(),
            payload
        );
    }

    #[test]
    fn bounds_checkpoint_count_and_deduplicates_artifacts() {
        let workspace = tempfile::tempdir().unwrap();
        let data = tempfile::tempdir().unwrap();
        let store = NativeStateStore::open_for_test(data.path(), [44; 32]).unwrap();
        for index in 0..=MAX_STORED {
            let name = format!("file-{index}.txt");
            fs::write(workspace.path().join(&name), b"same-before").unwrap();
            capture(
                &store,
                data.path(),
                workspace.path(),
                "s1",
                "write_file",
                &name,
            )
            .unwrap();
        }
        assert_eq!(store.count(TREE_CHECKPOINTS).unwrap(), MAX_STORED);
        assert_eq!(store.count(TREE_ARTIFACTS).unwrap(), 1);
        assert_eq!(store.count(TREE_ARTIFACT_METADATA).unwrap(), 1);
    }
}
