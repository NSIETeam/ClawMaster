use crate::native_models::{ModelToolCall, ModelToolDefinition};
use serde::Deserialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

const MIN_OCCURRENCES: usize = 3;
const MAX_AUDIT_BYTES: u64 = 4 * 1024 * 1024;
const MAX_SKILL_BYTES: u64 = 1024 * 1024;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AuditRecord {
    session_id: String,
    tool: String,
    state: String,
}

#[derive(Clone, Debug)]
pub struct AutoSkillCandidate {
    pub id: String,
    pub name: String,
    pub description: String,
    pub pattern: String,
    pub occurrence_count: usize,
    pub workspace: PathBuf,
    tools: Vec<String>,
}

impl AutoSkillCandidate {
    pub fn public_value(&self) -> Value {
        json!({
            "id": self.id,
            "name": self.name,
            "description": self.description,
            "detectedPattern": self.pattern,
            "occurrenceCount": self.occurrence_count,
            "reason": format!("ClawMaster 在当前项目中发现该 Rust 工具路径已成功执行 {} 次", self.occurrence_count),
            "qualityScore": 72,
            "confidence": confidence(self.occurrence_count),
            "evidence": [format!("仅使用脱敏审计中的工具名和成功状态：{}", self.pattern)],
            "failureLessons": [],
            "knowledgeEvidenceCount": 0,
            "recommendation": "create"
        })
    }
}

fn confidence(count: usize) -> f64 {
    (0.55 + (count.saturating_sub(MIN_OCCURRENCES).min(5) as f64 * 0.06)).min(0.85)
}

fn read_audit_tail(path: &Path) -> Result<String, String> {
    let mut file = match fs::File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(String::new()),
        Err(error) => return Err(format!("无法读取 Rust 审计日志: {error}")),
    };
    let length = file
        .metadata()
        .map_err(|error| format!("无法检查 Rust 审计日志: {error}"))?
        .len();
    let offset = length.saturating_sub(MAX_AUDIT_BYTES);
    file.seek(SeekFrom::Start(offset))
        .map_err(|error| format!("无法定位 Rust 审计日志: {error}"))?;
    let mut bytes = Vec::new();
    file.read_to_end(&mut bytes)
        .map_err(|error| format!("无法解析 Rust 审计日志: {error}"))?;
    let mut text = String::from_utf8_lossy(&bytes).into_owned();
    if offset > 0 {
        if let Some(newline) = text.find('\n') {
            text.drain(..=newline);
        } else {
            text.clear();
        }
    }
    Ok(text)
}

fn safe_slug(value: &str) -> String {
    let slug = value
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() {
                character.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect::<String>()
        .split('-')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("-");
    format!("auto-{}", slug.chars().take(120).collect::<String>())
}

fn candidate_id(workspace: &Path, pattern: &str) -> String {
    let mut digest = Sha256::new();
    digest.update(workspace.to_string_lossy().as_bytes());
    digest.update(b"\0");
    digest.update(pattern.as_bytes());
    format!("rust_auto_{:x}", digest.finalize())[..26].to_string()
}

pub fn scan(
    audit_path: &Path,
    session_workspaces: &HashMap<String, PathBuf>,
    handled: &HashSet<String>,
) -> Result<Vec<AutoSkillCandidate>, String> {
    let text = read_audit_tail(audit_path)?;
    let mut successful_by_session: HashMap<String, Vec<String>> = HashMap::new();
    for line in text.lines() {
        let Ok(record) = serde_json::from_str::<AuditRecord>(line) else {
            continue;
        };
        if record.state == "completed" && session_workspaces.contains_key(&record.session_id) {
            successful_by_session
                .entry(record.session_id)
                .or_default()
                .push(record.tool);
        }
    }

    let mut counts: HashMap<(PathBuf, String), (usize, Vec<String>)> = HashMap::new();
    for (session_id, tools) in successful_by_session {
        let Some(workspace) = session_workspaces.get(&session_id) else {
            continue;
        };
        for window in tools.windows(2) {
            let pattern = window.join(" -> ");
            let entry = counts
                .entry((workspace.clone(), pattern))
                .or_insert_with(|| (0, window.to_vec()));
            entry.0 += 1;
        }
        for tool in tools {
            let entry = counts
                .entry((workspace.clone(), tool.clone()))
                .or_insert_with(|| (0, vec![tool]));
            entry.0 += 1;
        }
    }

    let mut candidates = counts
        .into_iter()
        .filter_map(|((workspace, pattern), (occurrence_count, tools))| {
            if occurrence_count < MIN_OCCURRENCES {
                return None;
            }
            let id = candidate_id(&workspace, &pattern);
            if handled.contains(&id) {
                return None;
            }
            let name = safe_slug(&tools.join("-then-"));
            Some(AutoSkillCandidate {
                id,
                description: format!("在项目中复用 Rust 原生工具路径：{pattern}"),
                name,
                pattern,
                occurrence_count,
                workspace,
                tools,
            })
        })
        .collect::<Vec<_>>();
    candidates.sort_by(|left, right| {
        right
            .tools
            .len()
            .cmp(&left.tools.len())
            .then_with(|| right.occurrence_count.cmp(&left.occurrence_count))
            .then_with(|| left.id.cmp(&right.id))
    });
    Ok(candidates)
}

fn atomic_write(path: &Path, content: &str) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "自动 Skill 路径缺少父目录".to_string())?;
    fs::create_dir_all(parent).map_err(|error| format!("无法创建自动 Skill 目录: {error}"))?;
    let temporary = path.with_extension("md.tmp");
    fs::write(&temporary, content).map_err(|error| format!("无法写入自动 Skill: {error}"))?;
    fs::rename(&temporary, path).map_err(|error| format!("无法提交自动 Skill: {error}"))
}

pub fn install(candidate: &AutoSkillCandidate) -> Result<PathBuf, String> {
    let workspace = candidate
        .workspace
        .canonicalize()
        .map_err(|error| format!("自动 Skill 项目目录不可用: {error}"))?;
    let skills_root = workspace.join(".otto/skills");
    let path = skills_root.join(&candidate.name).join("SKILL.md");
    if !path.starts_with(&skills_root) {
        return Err("自动 Skill 只能写入当前项目的 .otto/skills 目录".into());
    }
    if path.exists() {
        return Err("同名 Skill 已存在，已停止以避免覆盖项目内容".into());
    }
    let steps = candidate
        .tools
        .iter()
        .enumerate()
        .map(|(index, tool)| format!("{}. 调用 `{tool}`，确认结果成功后再继续。", index + 1))
        .collect::<Vec<_>>()
        .join("\n");
    let content = format!(
        "---\nname: {}\ndescription: {}\n---\n\n# {}\n\n当任务符合 `{}` 时使用。\n\n## 执行步骤\n\n{}\n\n## 安全要求\n\n- 写操作继续经过 ClawMaster 确认与审计门禁。\n- 不复用历史参数、文件内容或密钥；每次从当前任务重新取得输入。\n- 任一步失败时停止并向用户说明，不隐藏失败。\n",
        candidate.name, candidate.description, candidate.name, candidate.pattern, steps
    );
    atomic_write(&path, &content)?;
    Ok(path)
}

fn frontmatter_value(content: &str, key: &str) -> Option<String> {
    let mut lines = content.lines();
    if lines.next() != Some("---") {
        return None;
    }
    lines
        .take_while(|line| *line != "---")
        .find_map(|line| line.strip_prefix(&format!("{key}: ")).map(str::to_owned))
}

pub fn list(workspace: &Path) -> Result<Vec<Value>, String> {
    let mut roots = vec![(workspace.join(".otto/skills"), "user-project")];
    if let Some(home) = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")) {
        roots.push((PathBuf::from(home).join(".otto-user/skills"), "user-global"));
    }
    let mut skills = Vec::new();
    for (root, marketplace) in roots {
        let entries = match fs::read_dir(&root) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(format!("无法读取技能目录 {}: {error}", root.display())),
        };
        for entry in entries.flatten() {
            let path = entry.path().join("SKILL.md");
            let Ok(canonical_path) = path.canonicalize() else {
                continue;
            };
            if !canonical_path.is_file() {
                continue;
            }
            let Ok(metadata) = canonical_path.metadata() else {
                continue;
            };
            if metadata.len() > 1024 * 1024 {
                continue;
            }
            let content = match fs::read_to_string(&canonical_path) {
                Ok(content) => content,
                _ => continue,
            };
            let fallback = entry.file_name().to_string_lossy().into_owned();
            let name = frontmatter_value(&content, "name").unwrap_or_else(|| fallback.clone());
            let description = frontmatter_value(&content, "description").unwrap_or_default();
            skills.push(json!({
                "id": format!("{}:{}", marketplace, fallback),
                "name": name,
                "description": description,
                "marketplaceId": marketplace,
                "pluginId": fallback,
                "enabled": true
            }));
        }
    }
    skills.sort_by(|left, right| left["id"].as_str().cmp(&right["id"].as_str()));
    Ok(skills)
}

pub fn definitions() -> Vec<ModelToolDefinition> {
    vec![ModelToolDefinition {
        name: "use_skill".into(),
        description: "Load the full instructions for one installed project or global Skill by the exact id returned by get_skills. Read the Skill before following its workflow.".into(),
        parameters: json!({
            "type":"object",
            "properties":{"id":{"type":"string","maxLength":300}},
            "required":["id"],
            "additionalProperties":false
        }),
    }]
}

pub fn summaries() -> Vec<Value> {
    definitions()
        .into_iter()
        .map(|tool| {
            json!({
                "name":tool.name,"displayName":tool.name,"description":tool.description
            })
        })
        .collect()
}

pub fn contains(name: &str) -> bool {
    name == "use_skill"
}

pub fn execute(workspace: &Path, call: &ModelToolCall) -> Result<Value, String> {
    if !contains(&call.name) {
        return Err("未知 Skill 工具".into());
    }
    let id = call
        .arguments
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| "use_skill 缺少 id".to_string())?;
    let (scope, plugin) = id
        .split_once(':')
        .ok_or_else(|| "Skill id 格式无效".to_string())?;
    if plugin.is_empty()
        || plugin.len() > 200
        || plugin.contains('/')
        || plugin.contains('\\')
        || plugin == "."
        || plugin == ".."
    {
        return Err("Skill id 包含非法路径".into());
    }
    let root = match scope {
        "user-project" => workspace.join(".otto/skills"),
        "user-global" => std::env::var_os("HOME")
            .or_else(|| std::env::var_os("USERPROFILE"))
            .map(PathBuf::from)
            .ok_or_else(|| "无法定位用户目录".to_string())?
            .join(".otto-user/skills"),
        _ => return Err("Skill scope 不受支持".into()),
    };
    let canonical_root = root
        .canonicalize()
        .map_err(|error| format!("Skill 根目录不可用: {error}"))?;
    let path = root
        .join(plugin)
        .join("SKILL.md")
        .canonicalize()
        .map_err(|error| format!("Skill 不存在: {error}"))?;
    if !path.starts_with(&canonical_root) {
        return Err("拒绝读取 Skill 根目录以外的文件".into());
    }
    let metadata = path
        .metadata()
        .map_err(|error| format!("无法检查 Skill: {error}"))?;
    if !metadata.is_file() || metadata.len() > MAX_SKILL_BYTES {
        return Err("Skill 不是普通文件或超过 1 MiB".into());
    }
    let instructions =
        fs::read_to_string(&path).map_err(|error| format!("无法读取 Skill 指令: {error}"))?;
    Ok(json!({"id":id,"path":path,"instructions":instructions}))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn loads_only_an_installed_skill_by_exact_id() {
        let root = tempfile::tempdir().unwrap();
        let directory = root.path().join(".otto/skills/demo");
        fs::create_dir_all(&directory).unwrap();
        fs::write(directory.join("SKILL.md"), "# Safe instructions").unwrap();
        let value = execute(
            root.path(),
            &ModelToolCall {
                id: "call-1".into(),
                name: "use_skill".into(),
                arguments: json!({"id":"user-project:demo"}),
            },
        )
        .unwrap();
        assert_eq!(value["instructions"], "# Safe instructions");
        assert!(execute(
            root.path(),
            &ModelToolCall {
                id: "call-2".into(),
                name: "use_skill".into(),
                arguments: json!({"id":"user-project:../demo"}),
            }
        )
        .is_err());
    }

    fn write_audit(path: &Path, tools: &[&str]) {
        let content = tools
            .iter()
            .enumerate()
            .map(|(index, tool)| {
                json!({"timestamp":index,"sessionId":"session-1","callId":format!("call-{index}"),"tool":tool,"state":"completed","argumentDigest":"digest"}).to_string()
            })
            .collect::<Vec<_>>()
            .join("\n");
        fs::write(path, format!("{content}\n")).unwrap();
    }

    #[test]
    fn stages_only_repeated_successful_rust_tool_paths() {
        let root = tempfile::tempdir().unwrap();
        let audit = root.path().join("audit.jsonl");
        write_audit(
            &audit,
            &[
                "read_file",
                "write_file",
                "read_file",
                "write_file",
                "read_file",
                "write_file",
            ],
        );
        let workspaces = HashMap::from([("session-1".into(), root.path().to_path_buf())]);
        let candidates = scan(&audit, &workspaces, &HashSet::new()).unwrap();
        let pair = candidates
            .iter()
            .find(|candidate| candidate.pattern == "read_file -> write_file")
            .unwrap();
        assert_eq!(pair.occurrence_count, 3);
        assert!(!pair.public_value().to_string().contains("argumentDigest"));
    }

    #[test]
    fn handled_candidates_stay_suppressed() {
        let root = tempfile::tempdir().unwrap();
        let audit = root.path().join("audit.jsonl");
        write_audit(&audit, &["search_text", "search_text", "search_text"]);
        let workspaces = HashMap::from([("session-1".into(), root.path().to_path_buf())]);
        let first = scan(&audit, &workspaces, &HashSet::new()).unwrap();
        let handled = HashSet::from([first[0].id.clone()]);
        assert!(scan(&audit, &workspaces, &handled).unwrap().is_empty());
    }

    #[test]
    fn confirmation_writes_a_discoverable_project_skill() {
        let root = tempfile::tempdir().unwrap();
        let candidate = AutoSkillCandidate {
            id: "candidate".into(),
            name: "auto-read-then-write".into(),
            description: "安全读写".into(),
            pattern: "read_file -> write_file".into(),
            occurrence_count: 3,
            workspace: root.path().to_path_buf(),
            tools: vec!["read_file".into(), "write_file".into()],
        };
        let saved = install(&candidate).unwrap();
        assert!(saved.starts_with(root.path().canonicalize().unwrap().join(".otto/skills")));
        let skills = list(root.path()).unwrap();
        assert!(skills.iter().any(|skill| skill["name"] == candidate.name));
        assert!(!fs::read_to_string(saved).unwrap().contains("secret"));
    }
}
