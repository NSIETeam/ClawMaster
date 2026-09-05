use serde_json::Value;
use std::path::{Path, PathBuf};

fn project_marker(path: &Path) -> bool {
    path.join(".git").exists()
        || path.join("Cargo.toml").is_file()
        || path.join("package.json").is_file()
        || path.join(".agents").is_dir()
}

fn root_for_path(path: &Path) -> Option<PathBuf> {
    let path = path.canonicalize().ok()?;
    let start = if path.is_file() {
        path.parent()?
    } else {
        &path
    };
    start
        .ancestors()
        .find(|ancestor| project_marker(ancestor))
        .map(Path::to_path_buf)
}

fn text_paths(text: &str) -> impl Iterator<Item = PathBuf> + '_ {
    text.split(|character: char| {
        character.is_whitespace()
            || matches!(
                character,
                '"' | '\'' | '`' | '<' | '>' | '(' | ')' | '[' | ']'
            )
    })
    .map(|token| token.trim_matches(|character| matches!(character, ',' | ';' | ':' | '。' | '，')))
    .filter(|token| Path::new(token).is_absolute())
    .map(PathBuf::from)
}

pub fn infer_from_content(content: &Value) -> Option<PathBuf> {
    let parts = content.as_array()?;
    for part in parts {
        let direct = match part.get("type").and_then(Value::as_str) {
            Some("file_reference") | Some("folder_reference") | Some("code_reference") => part
                .pointer("/value/filePath")
                .or_else(|| part.pointer("/value/folderPath"))
                .and_then(Value::as_str)
                .and_then(|value| root_for_path(Path::new(value))),
            _ => None,
        };
        if direct.is_some() {
            return direct;
        }
        if let Some(text) = part.get("value").and_then(Value::as_str) {
            if let Some(root) = text_paths(text).find_map(|path| root_for_path(&path)) {
                return Some(root);
            }
        }
    }
    None
}

fn content_text(content: &Value) -> String {
    content
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|part| part.get("value").and_then(Value::as_str))
        .collect::<Vec<_>>()
        .join(" ")
        .to_lowercase()
}

/// Resolve an unassigned session only when one previously used, real project
/// has a uniquely mentioned directory name. Ambiguous names fail closed.
pub fn infer_from_known_projects(content: &Value, known_projects: &[PathBuf]) -> Option<PathBuf> {
    if let Some(project) = infer_from_content(content) {
        return Some(project);
    }
    let text = content_text(content);
    let mut matches = known_projects
        .iter()
        .filter_map(|project| {
            let canonical = project.canonicalize().ok()?;
            if !project_marker(&canonical) {
                return None;
            }
            let name = canonical.file_name()?.to_string_lossy().to_lowercase();
            let minimum = if name.is_ascii() { 4 } else { 2 };
            (name.chars().count() >= minimum && text.contains(name.as_str())).then_some(canonical)
        })
        .collect::<Vec<_>>();
    matches.sort();
    matches.dedup();
    (matches.len() == 1).then(|| matches.remove(0))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::fs;

    #[test]
    fn infers_project_from_reference_and_absolute_text_path() {
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("Cargo.toml"), "[package]").unwrap();
        fs::create_dir(root.path().join("src")).unwrap();
        fs::write(root.path().join("src/main.rs"), "fn main() {}").unwrap();
        let reference = json!([{"type":"file_reference","value":{
            "filePath":root.path().join("src/main.rs"),"fileName":"main.rs"
        }}]);
        let expected = root.path().canonicalize().unwrap();
        assert_eq!(infer_from_content(&reference).unwrap(), expected);
        let text = json!([{"type":"text","value":format!("检查 `{}`", root.path().join("src/main.rs").display())}]);
        assert_eq!(infer_from_content(&text).unwrap(), expected);
    }

    #[test]
    fn refuses_to_invent_a_project_without_a_real_marker() {
        let root = tempfile::tempdir().unwrap();
        let content = json!([{"type":"text","value":root.path().display().to_string()}]);
        assert!(infer_from_content(&content).is_none());
    }

    #[test]
    fn infers_a_unique_known_project_from_its_directory_name() {
        let root = tempfile::tempdir().unwrap();
        let alpha = root.path().join("clawmaster-sales");
        let beta = root.path().join("clawmaster-support");
        fs::create_dir_all(&alpha).unwrap();
        fs::create_dir_all(&beta).unwrap();
        fs::write(alpha.join("Cargo.toml"), "[package]").unwrap();
        fs::write(beta.join("package.json"), "{}").unwrap();

        let content = json!([{"type":"text","value":"继续处理 clawmaster-sales 的发布"}]);
        assert_eq!(
            infer_from_known_projects(&content, &[alpha.clone(), beta]),
            alpha.canonicalize().ok(),
        );
    }

    #[test]
    fn refuses_an_ambiguous_or_unmarked_known_project_name() {
        let root = tempfile::tempdir().unwrap();
        let first = root.path().join("sales");
        let second = root.path().join("nested/sales");
        let unmarked = root.path().join("support");
        fs::create_dir_all(&first).unwrap();
        fs::create_dir_all(&second).unwrap();
        fs::create_dir_all(&unmarked).unwrap();
        fs::write(first.join("Cargo.toml"), "[package]").unwrap();
        fs::write(second.join("package.json"), "{}").unwrap();

        let sales = json!([{"type":"text","value":"继续 sales 项目"}]);
        assert!(infer_from_known_projects(&sales, &[first, second]).is_none());
        let support = json!([{"type":"text","value":"继续 support 项目"}]);
        assert!(infer_from_known_projects(&support, &[unmarked]).is_none());
    }
}
