use crate::native_models::{ModelToolCall, ModelToolDefinition};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fs;
use std::io::Write;
use std::path::Path;
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;

const MAX_FILE_BYTES: u64 = 16 * 1024 * 1024;
const MAX_ENTRIES: usize = 10_000;
const MAX_CONTENT_CHARS: usize = 16_000;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeEntry {
    id: String,
    category: String,
    content: String,
    #[serde(default)]
    tags: Vec<String>,
    created_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    confidence: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    updated_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    reinforcement_count: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    last_reinforced_at: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    source_session_ids: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    use_count: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    last_used_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    fingerprint: Option<String>,
}

pub fn definitions() -> Vec<ModelToolDefinition> {
    vec![
        ModelToolDefinition {
            name: "knowledge_search".into(),
            description: "Search the local personal knowledge base using the native Rust store."
                .into(),
            parameters: json!({"type":"object","properties":{
                "query":{"type":"string","maxLength":1000},
                "category":{"type":"string","maxLength":100},
                "limit":{"type":"integer","minimum":1,"maximum":50}
            },"required":["query"],"additionalProperties":false}),
        },
        ModelToolDefinition {
            name: "knowledge_add".into(),
            description: "Add a fact to the local personal knowledge base. Requires confirmation."
                .into(),
            parameters: json!({"type":"object","properties":{
                "content":{"type":"string","maxLength":16000},
                "category":{"type":"string","maxLength":100},
                "tags":{"type":"array","items":{"type":"string","maxLength":100},"maxItems":20}
            },"required":["content"],"additionalProperties":false}),
        },
        ModelToolDefinition {
            name: "knowledge_remove".into(),
            description:
                "Remove one item from the local personal knowledge base. Requires confirmation."
                    .into(),
            parameters: json!({"type":"object","properties":{
                "id":{"type":"string","maxLength":160}
            },"required":["id"],"additionalProperties":false}),
        },
    ]
}

pub fn summaries() -> Vec<Value> {
    definitions()
        .into_iter()
        .map(|tool| {
            json!({
                "name": tool.name,
                "displayName": tool.name,
                "description": tool.description
            })
        })
        .collect()
}

pub fn contains(name: &str) -> bool {
    matches!(
        name,
        "knowledge_search" | "knowledge_add" | "knowledge_remove"
    )
}

pub fn is_write(name: &str) -> bool {
    matches!(name, "knowledge_add" | "knowledge_remove")
}

fn clean_text(value: &str, field: &str, max: usize) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty() || value.chars().count() > max {
        return Err(format!("{field} 不能为空或超过 {max} 字符"));
    }
    Ok(value.to_string())
}

fn read(path: &Path) -> Result<Vec<KnowledgeEntry>, String> {
    let backup = path.with_extension("jsonl.bak");
    let source = if path.exists() || !backup.exists() {
        path
    } else {
        &backup
    };
    let metadata = match fs::metadata(source) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(format!("无法读取知识库元数据: {error}")),
    };
    if metadata.len() > MAX_FILE_BYTES {
        return Err("知识库文件超过 16 MiB 安全上限".into());
    }
    let raw = fs::read_to_string(source).map_err(|error| format!("无法读取知识库: {error}"))?;
    let mut entries = Vec::new();
    for line in raw.lines().map(str::trim).filter(|line| !line.is_empty()) {
        if entries.len() >= MAX_ENTRIES {
            return Err("知识库条目超过 10000 条安全上限".into());
        }
        if let Ok(entry) = serde_json::from_str::<KnowledgeEntry>(line) {
            if !entry.id.is_empty() && !entry.category.is_empty() && !entry.content.is_empty() {
                entries.push(entry);
            }
        }
    }
    Ok(entries)
}

fn write(path: &Path, entries: &[KnowledgeEntry]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "知识库路径缺少父目录".to_string())?;
    fs::create_dir_all(parent).map_err(|error| format!("无法创建知识库目录: {error}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(parent, fs::Permissions::from_mode(0o700))
            .map_err(|error| format!("无法保护知识库目录: {error}"))?;
    }
    let temporary = path.with_extension("jsonl.tmp");
    let mut file =
        fs::File::create(&temporary).map_err(|error| format!("无法创建知识库临时文件: {error}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&temporary, fs::Permissions::from_mode(0o600))
            .map_err(|error| format!("无法保护知识库临时文件: {error}"))?;
    }
    for entry in entries {
        serde_json::to_writer(&mut file, entry)
            .map_err(|error| format!("无法编码知识条目: {error}"))?;
        file.write_all(b"\n")
            .map_err(|error| format!("无法写入知识库: {error}"))?;
    }
    file.sync_all()
        .map_err(|error| format!("无法同步知识库: {error}"))?;
    let backup = path.with_extension("jsonl.bak");
    if path.exists() {
        let _ = fs::remove_file(&backup);
        fs::rename(path, &backup).map_err(|error| format!("无法备份知识库: {error}"))?;
    }
    match fs::rename(&temporary, path) {
        Ok(()) => {
            let _ = fs::remove_file(backup);
            Ok(())
        }
        Err(error) => {
            if backup.exists() {
                let _ = fs::rename(&backup, path);
            }
            let _ = fs::remove_file(temporary);
            Err(format!("无法提交知识库: {error}"))
        }
    }
}

fn now() -> String {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .unwrap_or_else(|_| "1970-01-01T00:00:00Z".into())
}

fn next_id() -> String {
    let mut bytes = [0_u8; 4];
    let _ = getrandom::getrandom(&mut bytes);
    format!(
        "kb_{:x}_{:08x}",
        OffsetDateTime::now_utc().unix_timestamp_nanos(),
        u32::from_le_bytes(bytes)
    )
}

pub fn list(path: &Path, limit: usize) -> Result<Vec<KnowledgeEntry>, String> {
    let mut entries = read(path)?;
    entries.sort_by(|left, right| right.created_at.cmp(&left.created_at));
    entries.truncate(limit.clamp(1, 100));
    Ok(entries)
}

pub fn search(
    path: &Path,
    query: &str,
    category: Option<&str>,
    limit: usize,
) -> Result<Vec<KnowledgeEntry>, String> {
    let query = clean_text(query, "知识检索词", 1000)?.to_lowercase();
    let category = category
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_lowercase);
    let mut scored = read(path)?
        .into_iter()
        .filter(|entry| {
            category
                .as_ref()
                .is_none_or(|expected| entry.category.to_lowercase() == *expected)
        })
        .filter_map(|entry| {
            let content = entry.content.to_lowercase();
            let tags = entry
                .tags
                .iter()
                .map(|tag| tag.to_lowercase())
                .collect::<Vec<_>>();
            let entry_category = entry.category.to_lowercase();
            let mut score = usize::from(content.contains(&query)) * 5
                + usize::from(tags.iter().any(|tag| tag.contains(&query))) * 3
                + usize::from(entry_category.contains(&query)) * 2;
            for token in query
                .split(|character: char| {
                    character.is_whitespace() || ",，、;；".contains(character)
                })
                .filter(|token| !token.is_empty() && *token != query)
            {
                score += usize::from(content.contains(token)) * 2;
                score += usize::from(tags.iter().any(|tag| tag.contains(token))) * 2;
                score += usize::from(entry_category.contains(token));
            }
            (score > 0).then_some((score, entry))
        })
        .collect::<Vec<_>>();
    scored.sort_by(|(left_score, left), (right_score, right)| {
        right_score
            .cmp(left_score)
            .then_with(|| right.created_at.cmp(&left.created_at))
    });
    Ok(scored
        .into_iter()
        .take(limit.clamp(1, 50))
        .map(|(_, entry)| entry)
        .collect())
}

pub fn add(
    path: &Path,
    content: &str,
    category: Option<&str>,
    tags: &[String],
) -> Result<KnowledgeEntry, String> {
    let mut entries = read(path)?;
    if entries.len() >= MAX_ENTRIES {
        return Err("知识库条目已达到 10000 条上限".into());
    }
    let content = clean_text(content, "知识内容", MAX_CONTENT_CHARS)?;
    let category = clean_text(category.unwrap_or("general"), "知识分类", 100)?;
    if tags.len() > 20 {
        return Err("知识标签不能超过 20 个".into());
    }
    let mut clean_tags = Vec::new();
    for tag in tags {
        let tag = clean_text(tag, "知识标签", 100)?;
        if !clean_tags.contains(&tag) {
            clean_tags.push(tag);
        }
    }
    let timestamp = now();
    let entry = KnowledgeEntry {
        id: next_id(),
        category,
        content,
        tags: clean_tags,
        created_at: timestamp.clone(),
        confidence: None,
        updated_at: Some(timestamp.clone()),
        reinforcement_count: Some(1),
        last_reinforced_at: Some(timestamp),
        source_session_ids: Vec::new(),
        use_count: Some(0),
        last_used_at: None,
        fingerprint: None,
    };
    entries.push(entry.clone());
    write(path, &entries)?;
    Ok(entry)
}

pub fn remove(path: &Path, id: &str) -> Result<bool, String> {
    let id = clean_text(id, "知识 ID", 160)?;
    let mut entries = read(path)?;
    let before = entries.len();
    entries.retain(|entry| entry.id != id);
    if entries.len() == before {
        return Ok(false);
    }
    write(path, &entries)?;
    Ok(true)
}

pub fn execute(path: &Path, call: &ModelToolCall) -> Result<Value, String> {
    match call.name.as_str() {
        "knowledge_search" => Ok(json!({"entries": search(
            path,
            call.arguments.get("query").and_then(Value::as_str).unwrap_or(""),
            call.arguments.get("category").and_then(Value::as_str),
            call.arguments.get("limit").and_then(Value::as_u64).unwrap_or(20) as usize,
        )?})),
        "knowledge_add" => {
            let tags = match call.arguments.get("tags") {
                None => Vec::new(),
                Some(Value::Array(values)) => values
                    .iter()
                    .map(|value| {
                        value
                            .as_str()
                            .map(str::to_owned)
                            .ok_or_else(|| "知识标签必须是字符串".to_string())
                    })
                    .collect::<Result<Vec<_>, _>>()?,
                Some(_) => return Err("知识标签必须是数组".into()),
            };
            Ok(json!({"entry": add(
                path,
                call.arguments.get("content").and_then(Value::as_str).unwrap_or(""),
                call.arguments.get("category").and_then(Value::as_str),
                &tags,
            )?}))
        }
        "knowledge_remove" => Ok(json!({"removed": remove(
            path,
            call.arguments.get("id").and_then(Value::as_str).unwrap_or(""),
        )?})),
        _ => Err("未知 Rust 知识库工具".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preserves_jsonl_compatibility_and_supports_search_and_remove() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("knowledge/entries.jsonl");
        let entry = add(&path, "Rust 原生知识库", Some("runtime"), &["rust".into()]).unwrap();
        fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap()
            .write_all(b"broken line\n")
            .unwrap();
        assert_eq!(search(&path, "Rust", None, 20).unwrap()[0].id, entry.id);
        assert!(remove(&path, &entry.id).unwrap());
        assert!(list(&path, 20).unwrap().is_empty());
    }

    #[test]
    fn bounds_user_controlled_knowledge_fields() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("entries.jsonl");
        assert!(add(&path, "", None, &[]).is_err());
        assert!(add(&path, "fact", None, &vec!["tag".into(); 21]).is_err());
    }

    #[test]
    fn recovers_the_last_complete_file_when_commit_was_interrupted() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("entries.jsonl");
        let entry = add(&path, "recoverable", None, &[]).unwrap();
        fs::rename(&path, path.with_extension("jsonl.bak")).unwrap();
        assert_eq!(list(&path, 20).unwrap()[0].id, entry.id);
    }
}
