use crate::native_state_store::{NativeStateStore, StateStoreError, TREE_MEMORY};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::fs;
use std::path::Path;
#[cfg(not(test))]
use std::path::PathBuf;

const CURRENT_FILE: &str = "CLAWMASTER.md";
const LEGACY_FILE: &str = "OTTO.md";
const GLOBAL_ID: &str = "project-memory:global";
const MAX_FACT_CHARS: usize = 2_000;
const MAX_DOCUMENT_CHARS: usize = 1_000_000;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct MemoryDocument {
    scope: String,
    display_path: String,
    content: String,
}

#[cfg(not(test))]
fn global_paths() -> Result<(PathBuf, PathBuf), String> {
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .ok_or_else(|| "无法定位用户目录".to_string())?;
    Ok((
        home.join(".clawmaster-user")
            .join("memory")
            .join(CURRENT_FILE),
        home.join(".otto-user").join("memory").join(LEGACY_FILE),
    ))
}

fn project_id(workspace: &Path) -> Result<String, String> {
    let root = workspace
        .canonicalize()
        .map_err(|error| format!("无法解析记忆工作目录: {error}"))?;
    Ok(format!(
        "project-memory:{:x}",
        Sha256::digest(root.to_string_lossy().as_bytes())
    ))
}

fn legacy_content(current: &Path, legacy: &Path) -> Result<String, String> {
    for path in [current, legacy] {
        match fs::read_to_string(path) {
            Ok(content) => {
                if content.chars().count() > MAX_DOCUMENT_CHARS {
                    return Err("记忆文件超过 1000000 字符安全上限".into());
                }
                return Ok(content);
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(format!("无法读取旧版记忆: {error}")),
        }
    }
    Ok(String::new())
}

fn load_or_import(
    store: &NativeStateStore,
    id: &str,
    scope: &str,
    current: &Path,
    legacy: &Path,
) -> Result<MemoryDocument, String> {
    match store.get::<MemoryDocument>(TREE_MEMORY, id) {
        Ok(Some(record)) => return Ok(record.payload),
        Ok(None) | Err(StateStoreError::CorruptRecord { .. }) => {}
        Err(error) => return Err(error.to_string()),
    }
    let document = MemoryDocument {
        scope: scope.into(),
        display_path: current.to_string_lossy().into_owned(),
        content: legacy_content(current, legacy)?,
    };
    store
        .put_latest(TREE_MEMORY, id, "legacy-memory", document.clone())
        .map_err(|error| error.to_string())?;
    store.flush().map_err(|error| error.to_string())?;
    Ok(document)
}

fn public(document: MemoryDocument) -> Value {
    json!({
        "scope":document.scope,
        "path":document.display_path,
        "exists":!document.content.is_empty(),
        "content":document.content
    })
}

pub fn snapshot(store: &NativeStateStore, workspace: &Path) -> Result<Value, String> {
    if !workspace.is_absolute() {
        return Err("记忆工作目录必须是绝对路径".into());
    }
    let project_current = workspace.join(CURRENT_FILE);
    let project_legacy = workspace.join(LEGACY_FILE);
    #[cfg(not(test))]
    let (global_current, global_legacy) = global_paths()?;
    #[cfg(test)]
    let (global_current, global_legacy) = (
        workspace.join(".test-global-clawmaster.md"),
        workspace.join(".test-global-otto.md"),
    );
    Ok(json!({"files":[
        public(load_or_import(
            store,
            &project_id(workspace)?,
            "project",
            &project_current,
            &project_legacy,
        )?),
        public(load_or_import(
            store,
            GLOBAL_ID,
            "global",
            &global_current,
            &global_legacy,
        )?)
    ]}))
}

pub fn add_project_fact(
    store: &NativeStateStore,
    workspace: &Path,
    fact: &str,
) -> Result<Value, String> {
    if !workspace.is_absolute() {
        return Err("记忆工作目录必须是绝对路径".into());
    }
    let fact = fact.trim();
    if fact.is_empty()
        || fact.chars().count() > MAX_FACT_CHARS
        || fact
            .chars()
            .any(|character| character.is_control() && character != '\n' && character != '\t')
    {
        return Err("记忆事实为空、过长或包含非法控制字符".into());
    }
    let id = project_id(workspace)?;
    let mut document = load_or_import(
        store,
        &id,
        "project",
        &workspace.join(CURRENT_FILE),
        &workspace.join(LEGACY_FILE),
    )?;
    let prefix = if document.content.trim().is_empty() {
        "# Project Memory\n\n".to_string()
    } else {
        document.content.trim_end().to_string() + "\n\n"
    };
    document.content = format!("{prefix}- {}\n", fact.replace('\n', " "));
    if document.content.chars().count() > MAX_DOCUMENT_CHARS {
        return Err("项目记忆已达到 1000000 字符上限".into());
    }
    store
        .put_latest(TREE_MEMORY, &id, "native-memory", document)
        .map_err(|error| error.to_string())?;
    store.flush().map_err(|error| error.to_string())?;
    snapshot(store, workspace)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn imports_without_modifying_files_and_then_writes_only_encrypted_state() {
        let root = tempfile::tempdir().unwrap();
        let data = tempfile::tempdir().unwrap();
        fs::write(root.path().join(LEGACY_FILE), "# Legacy\n").unwrap();
        let store = NativeStateStore::open_for_test(data.path(), [51; 32]).unwrap();
        let first = snapshot(&store, root.path()).unwrap();
        assert_eq!(first["files"][0]["content"], "# Legacy\n");
        let next = add_project_fact(&store, root.path(), "使用 Rust 原生运行时").unwrap();
        assert!(next["files"][0]["content"]
            .as_str()
            .unwrap()
            .contains("使用 Rust 原生运行时"));
        assert_eq!(
            fs::read_to_string(root.path().join(LEGACY_FILE)).unwrap(),
            "# Legacy\n"
        );
        assert!(!root.path().join(CURRENT_FILE).exists());
    }

    #[test]
    fn isolates_project_scopes_and_bounds_writes() {
        let first = tempfile::tempdir().unwrap();
        let second = tempfile::tempdir().unwrap();
        let data = tempfile::tempdir().unwrap();
        let store = NativeStateStore::open_for_test(data.path(), [52; 32]).unwrap();
        add_project_fact(&store, first.path(), "first-only").unwrap();
        assert!(
            snapshot(&store, second.path()).unwrap()["files"][0]["content"]
                .as_str()
                .unwrap()
                .is_empty()
        );
        assert!(add_project_fact(&store, second.path(), &"x".repeat(MAX_FACT_CHARS + 1)).is_err());
    }
}
