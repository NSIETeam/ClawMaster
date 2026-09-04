use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};

const MEMORY_FILE: &str = "CLAWMASTER.md";
const LEGACY_MEMORY_FILE: &str = "OTTO.md";
const MAX_FACT_CHARS: usize = 2_000;

fn global_memory_paths() -> Result<(PathBuf, PathBuf), String> {
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .ok_or_else(|| "无法定位用户目录".to_string())?;
    Ok((
        home.join(".clawmaster-user")
            .join("memory")
            .join(MEMORY_FILE),
        home.join(".otto-user")
            .join("memory")
            .join(LEGACY_MEMORY_FILE),
    ))
}

fn migrate_if_missing(current: &Path, legacy: &Path) -> Result<(), String> {
    if current.exists() || !legacy.is_file() {
        return Ok(());
    }
    if let Some(parent) = current.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("无法创建记忆目录: {error}"))?;
    }
    fs::copy(legacy, current).map_err(|error| format!("无法迁移旧版记忆: {error}"))?;
    Ok(())
}

fn file_info(scope: &str, path: PathBuf) -> Value {
    match fs::read_to_string(&path) {
        Ok(content) => json!({
            "scope":scope,"path":path,"exists":true,"content":content
        }),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => json!({
            "scope":scope,"path":path,"exists":false,"content":""
        }),
        Err(error) => json!({
            "scope":scope,"path":path,"exists":false,"content":"",
            "readError":format!("读取记忆失败: {error}")
        }),
    }
}

pub fn snapshot(workspace: &Path) -> Result<Value, String> {
    if !workspace.is_absolute() {
        return Err("记忆工作目录必须是绝对路径".into());
    }
    let project = workspace.join(MEMORY_FILE);
    migrate_if_missing(&project, &workspace.join(LEGACY_MEMORY_FILE))?;
    let (global, legacy_global) = global_memory_paths()?;
    #[cfg(not(test))]
    migrate_if_missing(&global, &legacy_global)?;
    #[cfg(test)]
    let _ = legacy_global;
    Ok(json!({"files":[
        file_info("project", project),
        file_info("global", global)
    ]}))
}

pub fn add_project_fact(workspace: &Path, fact: &str) -> Result<Value, String> {
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
    fs::create_dir_all(workspace).map_err(|error| format!("无法创建项目目录: {error}"))?;
    let path = workspace.join(MEMORY_FILE);
    let current = fs::read_to_string(&path).unwrap_or_default();
    let mut next = if current.trim().is_empty() {
        "# Project Memory\n\n".to_string()
    } else {
        current.trim_end().to_string() + "\n\n"
    };
    next.push_str("- ");
    next.push_str(&fact.replace('\n', " "));
    next.push('\n');
    let temporary = workspace.join(".CLAWMASTER.md.tmp");
    fs::write(&temporary, next).map_err(|error| format!("无法写入项目记忆: {error}"))?;
    fs::rename(&temporary, &path).map_err(|error| format!("无法提交项目记忆: {error}"))?;
    snapshot(workspace)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn appends_project_memory_atomically_and_returns_snapshot() {
        let root = tempfile::tempdir().unwrap();
        let result = add_project_fact(root.path(), "使用 Rust 原生运行时").unwrap();
        assert_eq!(result["files"][0]["exists"], true);
        assert!(result["files"][0]["content"]
            .as_str()
            .unwrap()
            .contains("- 使用 Rust 原生运行时"));
        assert!(!root.path().join(".CLAWMASTER.md.tmp").exists());
    }

    #[test]
    fn migrates_legacy_project_memory_without_deleting_it() {
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join(LEGACY_MEMORY_FILE), "# Legacy\n").unwrap();
        let result = snapshot(root.path()).unwrap();
        assert_eq!(
            result["files"][0]["path"].as_str(),
            root.path().join(MEMORY_FILE).to_str()
        );
        assert_eq!(result["files"][0]["content"], "# Legacy\n");
        assert!(root.path().join(LEGACY_MEMORY_FILE).exists());
    }

    #[test]
    fn rejects_unbounded_or_relative_memory_writes() {
        assert!(add_project_fact(Path::new("relative"), "fact").is_err());
        let root = tempfile::tempdir().unwrap();
        assert!(add_project_fact(root.path(), &"x".repeat(MAX_FACT_CHARS + 1)).is_err());
    }
}
