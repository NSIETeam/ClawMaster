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

pub fn truncate_tokens(text: &str, max_tokens: usize) -> String {
    text.chars().take(max_tokens.saturating_mul(4)).collect()
}

pub fn runtime_system_prompt(
    workspace: &Path,
    preferred_language: &str,
    agent_style: &str,
    user_controls: &str,
    state_capsule: &str,
    relevant_memory: &str,
    skills: &[Value],
) -> String {
    let mut sections = vec![format!(
        "[Safety and current task]\nYou are ClawMaster's Rust-native AI coworker. Work only inside {}. Use native tools rather than claiming actions. Read-only tools may run directly. Every write, command, browser/RPA action, schedule, knowledge change, todo, and MCP call must pass central policy, approval, and audit. Continue the observe-plan-act-verify loop until the requested outcome has evidence or cannot safely proceed. After a failed tool, inspect its result and either make a corrected safe tool call or clearly report the task incomplete. Never claim success from model text alone. Never request or reveal secrets. Never replay an external action with unknown outcome. Report unavailable capabilities truthfully. Preferred language: {}. Response style: {}.",
        workspace.display(), preferred_language, agent_style
    )];
    if !state_capsule.trim().is_empty() {
        sections.push(format!(
            "[StateCapsule]\n{}",
            truncate_tokens(state_capsule, 320)
        ));
    }
    if !user_controls.trim().is_empty() {
        sections.push(format!(
            "[User controls]\n{}",
            truncate_tokens(user_controls, 800)
        ));
    }
    if !relevant_memory.trim().is_empty() {
        sections.push(format!(
            "[Relevant memory]\n{}",
            truncate_tokens(relevant_memory, 512)
        ));
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
            "[Installed Skills]\n{}\nUse use_skill to load full instructions.",
            truncate_tokens(&catalog, 500)
        ));
    }
    truncate_tokens(&sections.join("\n\n"), 2_200)
}

pub fn bounded_recent_history(messages: Vec<ModelMessage>, max_tokens: usize) -> Vec<ModelMessage> {
    let mut remaining = max_tokens.saturating_mul(4);
    let mut selected = Vec::new();
    for message in messages.into_iter().rev() {
        if remaining == 0 {
            break;
        }
        let text = message.text.chars().take(remaining).collect::<String>();
        remaining = remaining.saturating_sub(text.chars().count());
        selected.push(ModelMessage {
            role: message.role,
            text,
        });
    }
    selected.reverse();
    selected
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

pub fn append_retrieved_context(
    messages: &mut [ModelMessage],
    relevant_memory: &str,
    skills: &[Value],
) {
    let Some(current) = messages
        .iter_mut()
        .rev()
        .find(|message| message.role == "user")
    else {
        return;
    };
    if !relevant_memory.trim().is_empty() {
        current.text.push_str(&format!(
            "\n\n[Relevant memory]\n{}",
            truncate_tokens(relevant_memory, 512)
        ));
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
        current.text.push_str(&format!(
            "\n\n[Installed Skills]\n{}\nUse use_skill to load full instructions.",
            truncate_tokens(&catalog, 500)
        ));
    }
}

pub fn select_tools_for_context(
    tools: &[ModelToolDefinition],
    messages: &[ModelMessage],
    max_tokens: usize,
) -> Vec<ModelToolDefinition> {
    let context = messages
        .iter()
        .rev()
        .filter(|message| message.role != "system")
        .take(6)
        .map(|message| message.text.to_lowercase())
        .collect::<Vec<_>>()
        .join(" ");
    let mut ranked = tools
        .iter()
        .map(|tool| {
            let mut score = if tool.name == "native_capabilities" {
                10_000
            } else {
                0
            };
            for term in tool
                .name
                .split('_')
                .chain(
                    tool.description
                        .split(|character: char| !character.is_alphanumeric()),
                )
                .filter(|term| term.len() >= 3)
            {
                if context.contains(&term.to_lowercase()) {
                    score += 10;
                }
            }
            for alias in tool_aliases(&tool.name) {
                if context.contains(alias) {
                    score += 25;
                }
            }
            (score, tool)
        })
        .collect::<Vec<_>>();
    ranked.sort_by(|left, right| {
        right
            .0
            .cmp(&left.0)
            .then_with(|| left.1.name.cmp(&right.1.name))
    });
    let mut selected = Vec::new();
    let mut used = 0;
    for (_, tool) in ranked {
        let tokens = serde_json::to_string(tool)
            .map(|value| value.chars().count().div_ceil(4) + 4)
            .unwrap_or(max_tokens + 1);
        if used + tokens <= max_tokens {
            selected.push(tool.clone());
            used += tokens;
        }
    }
    selected
}

fn tool_aliases(name: &str) -> &'static [&'static str] {
    match name {
        "read_file" => &["读取", "查看文件", "read file"],
        "list_directory" => &["目录", "文件列表", "list files"],
        "search_text" => &["搜索", "查找", "search"],
        "write_file" => &["写文件", "修改代码", "编辑文件", "write"],
        "run_command" => &["命令", "测试", "构建", "运行", "command"],
        "open_browser" | "browser_snapshot" | "browser_action" => &["浏览器", "网页", "browser"],
        "desktop_snapshot" => &["桌面", "鼠标", "点击", "rpa"],
        "generate_docx" => &["word", "docx", "文档"],
        "generate_pptx" => &["ppt", "pptx", "演示"],
        "generate_chart" => &["图表", "chart"],
        "merge_pdfs" | "optimize_pdf" => &["pdf"],
        _ => &[],
    }
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
    let max_tokens = model.and_then(|item| item.max_tokens).unwrap_or(16_000) as u64;
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

    #[test]
    fn native_context_is_bounded_and_unknown_models_are_conservative() {
        let root = tempfile::tempdir().unwrap();
        let prompt = runtime_system_prompt(
            root.path(),
            "zh-CN",
            "concise",
            &"control ".repeat(10_000),
            &"capsule ".repeat(10_000),
            &"memory ".repeat(10_000),
            &[json!({"id":"skill","name":"x".repeat(20_000),"description":"large"})],
        );
        assert!(prompt.contains("central policy, approval, and audit"));
        assert!(prompt.contains("observe-plan-act-verify loop"));
        assert!(prompt.contains("Never claim success from model text alone"));
        assert!(prompt.chars().count() <= 2_200 * 4);
        assert_eq!(
            breakdown("s1", None, &[], &prompt, &[], root.path())["maxTokens"],
            16_000
        );
        let history = bounded_recent_history(
            vec![
                ModelMessage {
                    role: "user".into(),
                    text: "old".repeat(10_000),
                },
                ModelMessage {
                    role: "user".into(),
                    text: "latest".into(),
                },
            ],
            16,
        );
        assert_eq!(history.last().unwrap().text, "latest");
        assert!(
            history
                .iter()
                .map(|message| message.text.chars().count())
                .sum::<usize>()
                <= 64
        );

        let mut ordered = vec![ModelMessage {
            role: "user".into(),
            text: "current task".into(),
        }];
        append_retrieved_context(&mut ordered, "recalled fact", &[]);
        assert!(
            ordered[0].text.find("current task").unwrap()
                < ordered[0].text.find("recalled fact").unwrap()
        );

        let selected = select_tools_for_context(
            &crate::native_agent_tools::definitions(),
            &[ModelMessage {
                role: "user".into(),
                text: "请打开浏览器并点击网页按钮".into(),
            }],
            1_200,
        );
        assert!(selected
            .iter()
            .any(|tool| tool.name == "native_capabilities"));
        assert!(selected.iter().any(|tool| tool.name == "browser_action"));
        let tool_tokens = selected
            .iter()
            .map(|tool| {
                serde_json::to_string(tool)
                    .unwrap()
                    .chars()
                    .count()
                    .div_ceil(4)
                    + 4
            })
            .sum::<usize>();
        assert!(tool_tokens <= 1_200);
    }
}
