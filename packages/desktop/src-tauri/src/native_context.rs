use crate::native_models::{ModelMessage, ModelToolDefinition, NativeModel};
use serde_json::{json, Value};
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

const MAX_CONTEXT_FILE_BYTES: u64 = 1_048_576;
const MAX_EXTENSION_CONFIG_BYTES: u64 = 262_144;

fn home_dir() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
}

fn read_bounded(path: &Path, max_bytes: u64) -> String {
    let Ok(metadata) = path.metadata() else {
        return String::new();
    };
    if !metadata.is_file() || metadata.len() > max_bytes {
        return String::new();
    }
    fs::read_to_string(path).unwrap_or_default()
}

pub fn system_prompt(
    workspace: &Path,
    preferred_language: &str,
    agent_style: &str,
    skills: &[Value],
) -> String {
    let mut sections = vec![format!(
        "You are ClawMaster's Rust-native AI coworker. Work inside {}. Use the provided native tools rather than claiming actions were performed. Read-only tools may run directly; writes, commands, desktop automation, browser opens, schedules, knowledge changes, todos, and MCP tools require the runtime's confirmation gate. Never request or reveal secrets. Report failures truthfully. Preferred language: {}. Response style: {}.",
        workspace.display(), preferred_language, agent_style
    )];
    let project_memory = workspace.join("CLAWMASTER.md");
    let legacy_memory = workspace.join("OTTO.md");
    for (label, path) in [
        (
            "Project memory",
            if project_memory.is_file() {
                project_memory
            } else {
                legacy_memory
            },
        ),
        ("Project instructions", workspace.join("AGENTS.md")),
    ] {
        let content = read_bounded(&path, MAX_CONTEXT_FILE_BYTES);
        if !content.trim().is_empty() {
            sections.push(format!("[{label}: {}]\n{content}", path.display()));
        }
    }
    if let Some(home) = home_dir() {
        let current = home.join(".clawmaster-user/memory/CLAWMASTER.md");
        let path = if current.is_file() {
            current
        } else {
            home.join(".otto-user/memory/OTTO.md")
        };
        let content = read_bounded(&path, MAX_CONTEXT_FILE_BYTES);
        if !content.trim().is_empty() {
            sections.push(format!("[Global memory: {}]\n{content}", path.display()));
        }
    }
    if !skills.is_empty() {
        let catalog = skills
            .iter()
            .filter_map(|skill| {
                Some(format!(
                    "- {}: {} - {}",
                    skill.get("id")?.as_str()?,
                    skill.get("name")?.as_str()?,
                    skill
                        .get("description")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                ))
            })
            .collect::<Vec<_>>()
            .join("\n");
        sections.push(format!(
            "[Installed Skills]\n{catalog}\nUse the use_skill tool to load the full instructions before following a Skill."
        ));
    }
    sections.join("\n\n")
}

pub fn prepend_system_message(messages: &mut Vec<ModelMessage>, prompt: String) {
    messages.insert(
        0,
        ModelMessage {
            role: "system".into(),
            text: prompt,
        },
    );
}

pub fn breakdown(
    session_id: &str,
    model: Option<&NativeModel>,
    messages: &[ModelMessage],
    system_prompt: &str,
    tools: &[ModelToolDefinition],
    workspace: &Path,
) -> Value {
    let estimate = |text: &str| text.chars().count().div_ceil(4) as u64;
    let system_prompt_tokens = estimate(system_prompt);
    let system_tools_tokens = tools
        .iter()
        .map(|tool| estimate(&tool.description) + estimate(&tool.parameters.to_string()) + 4)
        .sum::<u64>();
    let messages_tokens = messages
        .iter()
        .filter(|message| message.role != "system")
        .map(|message| estimate(&message.text) + 4)
        .sum::<u64>();
    let memory_files_tokens = ["CLAWMASTER.md", "AGENTS.md", "OTTO.md"]
        .iter()
        .map(|name| estimate(&read_bounded(&workspace.join(name), MAX_CONTEXT_FILE_BYTES)))
        .sum::<u64>();
    let total_input_tokens = system_prompt_tokens + system_tools_tokens + messages_tokens;
    let max_tokens = model.and_then(|item| item.max_tokens).unwrap_or(128_000) as u64;
    json!({
        "sessionId":session_id,
        "modelDisplayName":model.map(|item| item.display_name.as_str()).unwrap_or("未选择模型"),
        "maxTokens":max_tokens,
        "systemPromptTokens":system_prompt_tokens.saturating_sub(memory_files_tokens),
        "systemToolsTokens":system_tools_tokens,
        "memoryFilesTokens":memory_files_tokens,
        "messagesTokens":messages_tokens,
        "totalInputTokens":total_input_tokens,
        "freeSpaceTokens":max_tokens.saturating_sub(total_input_tokens)
    })
}

fn extensions_from(root: &Path) -> Result<Vec<Value>, String> {
    let directory = root.join(".otto-user/extensions");
    let entries = match fs::read_dir(&directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(format!("无法读取扩展目录 {}: {error}", directory.display())),
    };
    let mut extensions = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        let config = path.join("gemini-extension.json");
        let raw = read_bounded(&config, MAX_EXTENSION_CONFIG_BYTES);
        let Ok(value) = serde_json::from_str::<Value>(&raw) else {
            continue;
        };
        let Some(name) = value.get("name").and_then(Value::as_str) else {
            continue;
        };
        if name.trim().is_empty() {
            continue;
        }
        extensions.push(json!({
            "name":name,
            "version":value.get("version").and_then(Value::as_str).unwrap_or("0.0.0"),
            "path":path
        }));
    }
    Ok(extensions)
}

pub fn extensions(workspace: &Path) -> Result<Vec<Value>, String> {
    let mut values = extensions_from(workspace)?;
    if let Some(home) = home_dir() {
        values.extend(extensions_from(&home)?);
    }
    let mut names = HashSet::new();
    values.retain(|value| {
        value["name"]
            .as_str()
            .is_some_and(|name| names.insert(name.to_string()))
    });
    values.sort_by(|left, right| left["name"].as_str().cmp(&right["name"].as_str()));
    Ok(values)
}

pub fn export_markdown(
    title: &str,
    messages: &[super::native_runtime::StoredMessage],
) -> (String, String) {
    let mut lines = vec![format!("# {}", title), String::new()];
    for message in messages {
        let text = super::native_runtime::text_content(&message.content);
        if text.trim().is_empty() {
            continue;
        }
        let speaker = if message.role == "user" {
            "用户"
        } else {
            "ClawMaster"
        };
        lines.extend([
            format!("## {speaker}"),
            String::new(),
            text.trim().to_string(),
            String::new(),
        ]);
    }
    let safe = title
        .chars()
        .map(|character| {
            if "\\/:*?\"<>|".contains(character) {
                '_'
            } else {
                character
            }
        })
        .take(120)
        .collect::<String>();
    (
        format!(
            "{}.md",
            if safe.trim().is_empty() {
                "conversation"
            } else {
                &safe
            }
        ),
        lines.join("\n"),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn discovers_project_extensions_before_global_duplicates() {
        let root = tempfile::tempdir().unwrap();
        let directory = root.path().join(".otto-user/extensions/demo");
        fs::create_dir_all(&directory).unwrap();
        fs::write(
            directory.join("gemini-extension.json"),
            r#"{"name":"demo","version":"1.2.3"}"#,
        )
        .unwrap();
        let values = extensions(root.path()).unwrap();
        assert!(values
            .iter()
            .any(|value| value["name"] == "demo" && value["version"] == "1.2.3"));
    }

    #[test]
    fn builds_a_bounded_safe_export_name() {
        let (name, markdown) = export_markdown("a/b", &[]);
        assert_eq!(name, "a_b.md");
        assert!(markdown.starts_with("# a/b"));
    }
}
