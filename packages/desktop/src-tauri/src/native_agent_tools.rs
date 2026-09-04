use crate::native_models::{ModelToolCall, ModelToolDefinition};
use crate::native_tools;
use serde_json::{json, Value};
use std::fs;
use std::path::{Component, Path, PathBuf};

const MAX_FILE_BYTES: u64 = 1_048_576;
const MAX_DIRECTORY_ENTRIES: usize = 200;
const MAX_SEARCH_FILES: usize = 2_000;
const MAX_SEARCH_MATCHES: usize = 100;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ToolRisk {
    ReadOnly,
    Write,
}

pub fn definitions() -> Vec<ModelToolDefinition> {
    vec![
        ModelToolDefinition {
            name: "read_file".into(),
            description: "Read a UTF-8 text file inside the current workspace with optional line pagination.".into(),
            parameters: json!({"type":"object","properties":{
                "path":{"type":"string"},"offset":{"type":"integer","minimum":0},
                "limit":{"type":"integer","minimum":1,"maximum":2000}
            },"required":["path"],"additionalProperties":false}),
        },
        ModelToolDefinition {
            name: "list_directory".into(),
            description: "List files and directories at one location inside the current workspace.".into(),
            parameters: json!({"type":"object","properties":{
                "path":{"type":"string"}
            },"required":["path"],"additionalProperties":false}),
        },
        ModelToolDefinition {
            name: "search_text".into(),
            description: "Search UTF-8 workspace files recursively for a literal text query.".into(),
            parameters: json!({"type":"object","properties":{
                "query":{"type":"string"},"path":{"type":"string"}
            },"required":["query"],"additionalProperties":false}),
        },
        ModelToolDefinition {
            name: "write_file".into(),
            description: "Replace or create a UTF-8 text file inside the workspace. Requires user confirmation.".into(),
            parameters: json!({"type":"object","properties":{
                "path":{"type":"string"},"content":{"type":"string","maxLength":1048576}
            },"required":["path","content"],"additionalProperties":false}),
        },
        ModelToolDefinition {
            name: "native_capabilities".into(),
            description: "List built-in capability providers and the external dependencies they replace. Prefer providers whose name starts with rust:.".into(),
            parameters: json!({"type":"object","properties":{},"additionalProperties":false}),
        },
        ModelToolDefinition {
            name: "generate_docx".into(),
            description: "Create an editable DOCX inside the workspace using Rust. No Python, python-docx, pandoc, or typst is required.".into(),
            parameters: json!({"type":"object","properties":{
                "outputPath":{"type":"string"},"title":{"type":"string","maxLength":500},
                "author":{"type":"string","maxLength":200},"department":{"type":"string","maxLength":200},
                "format":{"type":"string","maxLength":100},"content":{"type":"string","maxLength":1048576}
            },"required":["outputPath","title","content"],"additionalProperties":false}),
        },
        ModelToolDefinition {
            name: "merge_pdfs".into(),
            description: "Merge workspace PDFs using Rust. No pdfunite is required.".into(),
            parameters: json!({"type":"object","properties":{
                "outputPath":{"type":"string"},"inputPaths":{"type":"array","items":{"type":"string"},"minItems":2,"maxItems":20}
            },"required":["outputPath","inputPaths"],"additionalProperties":false}),
        },
        ModelToolDefinition {
            name: "optimize_pdf".into(),
            description: "Optimize a workspace PDF using Rust. No Ghostscript is required for lossless cleanup and compression.".into(),
            parameters: json!({"type":"object","properties":{
                "outputPath":{"type":"string"},"inputPath":{"type":"string"}
            },"required":["outputPath","inputPath"],"additionalProperties":false}),
        },
        ModelToolDefinition {
            name: "desktop_automation".into(),
            description: "Control native mouse and keyboard input through Rust. Always requires user confirmation.".into(),
            parameters: json!({"type":"object","properties":{
                "action":{"type":"string","enum":["type","click","drag","scroll","hotkey"]},
                "text":{"type":"string","maxLength":10000},"hotkey":{"type":"string","maxLength":100},
                "x":{"type":"integer"},"y":{"type":"integer"},"toX":{"type":"integer"},"toY":{"type":"integer"},
                "amount":{"type":"integer"},"button":{"type":"string","enum":["left","right","middle"]},
                "doubleClick":{"type":"boolean"}
            },"required":["action"],"additionalProperties":false}),
        },
    ]
}

pub fn summaries() -> Value {
    Value::Array(
        definitions()
            .into_iter()
            .map(|tool| {
                json!({
                    "name":tool.name,
                    "displayName":tool.name,
                    "description":tool.description
                })
            })
            .collect(),
    )
}

pub fn risk(name: &str) -> Option<ToolRisk> {
    match name {
        "read_file" | "list_directory" | "search_text" | "native_capabilities" => {
            Some(ToolRisk::ReadOnly)
        }
        "write_file" | "generate_docx" | "merge_pdfs" | "optimize_pdf" | "desktop_automation" => {
            Some(ToolRisk::Write)
        }
        _ => None,
    }
}

fn clean_relative(value: &str) -> Result<PathBuf, String> {
    let path = Path::new(value);
    if path.as_os_str().is_empty()
        || path
            .components()
            .any(|part| matches!(part, Component::ParentDir | Component::Prefix(_)))
    {
        return Err("工具路径为空或包含越界片段".into());
    }
    Ok(path.to_path_buf())
}

fn existing_path(workspace: &Path, value: &str) -> Result<PathBuf, String> {
    let root = workspace
        .canonicalize()
        .map_err(|error| format!("无法解析工作目录: {error}"))?;
    let candidate = if Path::new(value).is_absolute() {
        PathBuf::from(value)
    } else {
        root.join(clean_relative(value)?)
    };
    let resolved = candidate
        .canonicalize()
        .map_err(|error| format!("无法解析工具路径: {error}"))?;
    if !resolved.starts_with(&root) {
        return Err("工具拒绝访问工作目录以外的路径".into());
    }
    Ok(resolved)
}

fn writable_path(workspace: &Path, value: &str) -> Result<PathBuf, String> {
    let root = workspace
        .canonicalize()
        .map_err(|error| format!("无法解析工作目录: {error}"))?;
    let relative = clean_relative(value)?;
    if relative.is_absolute() {
        return Err("写入路径必须相对当前工作目录".into());
    }
    let candidate = root.join(relative);
    let parent = candidate
        .parent()
        .ok_or_else(|| "写入路径缺少父目录".to_string())?;
    fs::create_dir_all(parent).map_err(|error| format!("无法创建父目录: {error}"))?;
    let parent = parent
        .canonicalize()
        .map_err(|error| format!("无法解析写入目录: {error}"))?;
    if !parent.starts_with(&root) {
        return Err("工具拒绝写入工作目录以外的路径".into());
    }
    Ok(parent.join(
        candidate
            .file_name()
            .ok_or_else(|| "写入文件名无效".to_string())?,
    ))
}

fn bounded_text(path: &Path) -> Result<String, String> {
    let metadata = fs::metadata(path).map_err(|error| format!("无法读取文件信息: {error}"))?;
    if !metadata.is_file() || metadata.len() > MAX_FILE_BYTES {
        return Err("仅支持不超过 1 MiB 的普通文本文件".into());
    }
    fs::read_to_string(path).map_err(|error| format!("无法读取 UTF-8 文本: {error}"))
}

fn required_string<'a>(arguments: &'a Value, name: &str) -> Result<&'a str, String> {
    arguments
        .get(name)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("工具参数 {name} 不能为空"))
}

fn require_extension(path: &Path, extension: &str) -> Result<(), String> {
    if path
        .extension()
        .and_then(|value| value.to_str())
        .is_some_and(|value| value.eq_ignore_ascii_case(extension))
    {
        Ok(())
    } else {
        Err(format!("文件扩展名必须是 .{extension}"))
    }
}

fn commit_generated<F>(path: &Path, generate: F) -> Result<(), String>
where
    F: FnOnce(&Path) -> Result<(), String>,
{
    let mut random = [0_u8; 8];
    getrandom::getrandom(&mut random)
        .map_err(|error| format!("无法创建安全临时文件名: {error}"))?;
    let suffix = u64::from_le_bytes(random);
    let temporary = path.with_extension(format!("clawmaster-{suffix:x}.tmp"));
    let backup = path.with_extension(format!("clawmaster-{suffix:x}.backup"));
    if let Err(error) = generate(&temporary) {
        let _ = fs::remove_file(&temporary);
        return Err(error);
    }
    if path.exists() {
        fs::rename(path, &backup).map_err(|error| format!("无法暂存原文件: {error}"))?;
    }
    if let Err(error) = fs::rename(&temporary, path) {
        if backup.exists() {
            let _ = fs::rename(&backup, path);
        }
        let _ = fs::remove_file(&temporary);
        return Err(format!("无法提交生成文件: {error}"));
    }
    if backup.exists() {
        let _ = fs::remove_file(&backup);
    }
    Ok(())
}

fn search_directory(root: &Path, query: &str) -> Result<Value, String> {
    let mut pending = vec![root.to_path_buf()];
    let mut scanned = 0;
    let mut matches = Vec::new();
    while let Some(directory) = pending.pop() {
        for entry in fs::read_dir(&directory).map_err(|error| format!("无法搜索目录: {error}"))?
        {
            let entry = entry.map_err(|error| format!("无法读取目录项: {error}"))?;
            let file_type = entry.file_type().map_err(|error| error.to_string())?;
            if file_type.is_symlink() {
                continue;
            }
            let path = entry.path();
            if file_type.is_dir() {
                pending.push(path);
                continue;
            }
            scanned += 1;
            if scanned > MAX_SEARCH_FILES {
                return Ok(json!({"matches":matches,"truncated":true,"scannedFiles":scanned - 1}));
            }
            let Ok(content) = bounded_text(&path) else {
                continue;
            };
            for (index, line) in content.lines().enumerate() {
                if line.contains(query) {
                    matches.push(json!({"path":path,"line":index + 1,"text":line.chars().take(500).collect::<String>()}));
                    if matches.len() >= MAX_SEARCH_MATCHES {
                        return Ok(
                            json!({"matches":matches,"truncated":true,"scannedFiles":scanned}),
                        );
                    }
                }
            }
        }
    }
    Ok(json!({"matches":matches,"truncated":false,"scannedFiles":scanned}))
}

pub fn execute(call: &ModelToolCall, workspace: &Path) -> Result<Value, String> {
    match call.name.as_str() {
        "read_file" => {
            let path = call
                .arguments
                .get("path")
                .and_then(Value::as_str)
                .unwrap_or("");
            let content = bounded_text(&existing_path(workspace, path)?)?;
            let offset = call
                .arguments
                .get("offset")
                .and_then(Value::as_u64)
                .unwrap_or(0) as usize;
            let limit = call
                .arguments
                .get("limit")
                .and_then(Value::as_u64)
                .unwrap_or(2_000)
                .min(2_000) as usize;
            let lines = content.lines().skip(offset).take(limit).collect::<Vec<_>>();
            Ok(
                json!({"path":path,"offset":offset,"content":lines.join("\n"),"truncated":content.lines().count() > offset + lines.len()}),
            )
        }
        "list_directory" => {
            let value = call
                .arguments
                .get("path")
                .and_then(Value::as_str)
                .unwrap_or(".");
            let path = existing_path(workspace, value)?;
            let mut entries = fs::read_dir(&path)
                .map_err(|error| format!("无法读取目录: {error}"))?
                .take(MAX_DIRECTORY_ENTRIES + 1)
                .map(|entry| {
                    let entry = entry.map_err(|error| error.to_string())?;
                    let kind = entry.file_type().map_err(|error| error.to_string())?;
                    Ok(json!({"name":entry.file_name(),"directory":kind.is_dir(),"symlink":kind.is_symlink()}))
                })
                .collect::<Result<Vec<_>, String>>()?;
            let truncated = entries.len() > MAX_DIRECTORY_ENTRIES;
            entries.truncate(MAX_DIRECTORY_ENTRIES);
            Ok(json!({"path":value,"entries":entries,"truncated":truncated}))
        }
        "search_text" => {
            let query = call
                .arguments
                .get("query")
                .and_then(Value::as_str)
                .unwrap_or("");
            if query.is_empty() || query.chars().count() > 500 {
                return Err("搜索文本为空或超过 500 字符".into());
            }
            let value = call
                .arguments
                .get("path")
                .and_then(Value::as_str)
                .unwrap_or(".");
            search_directory(&existing_path(workspace, value)?, query)
        }
        "write_file" => {
            let value = call
                .arguments
                .get("path")
                .and_then(Value::as_str)
                .unwrap_or("");
            let content = call
                .arguments
                .get("content")
                .and_then(Value::as_str)
                .unwrap_or("");
            if content.len() as u64 > MAX_FILE_BYTES {
                return Err("写入内容超过 1 MiB".into());
            }
            let path = writable_path(workspace, value)?;
            let temporary = path.with_extension("clawmaster.tmp");
            fs::write(&temporary, content).map_err(|error| format!("无法写入临时文件: {error}"))?;
            fs::rename(&temporary, &path).map_err(|error| format!("无法提交文件: {error}"))?;
            Ok(json!({"path":value,"bytes":content.len(),"written":true}))
        }
        "native_capabilities" => Ok(native_tools::capability_manifest()),
        "generate_docx" => {
            let output_value = required_string(&call.arguments, "outputPath")?;
            let output = writable_path(workspace, output_value)?;
            require_extension(&output, "docx")?;
            let title = required_string(&call.arguments, "title")?;
            let content = required_string(&call.arguments, "content")?;
            if title.chars().count() > 500 || content.len() as u64 > MAX_FILE_BYTES {
                return Err("DOCX 标题或正文超过大小限制".into());
            }
            let author = call
                .arguments
                .get("author")
                .and_then(Value::as_str)
                .unwrap_or("");
            let department = call
                .arguments
                .get("department")
                .and_then(Value::as_str)
                .unwrap_or("");
            let format = call
                .arguments
                .get("format")
                .and_then(Value::as_str)
                .unwrap_or("document");
            if author.chars().count() > 200
                || department.chars().count() > 200
                || format.chars().count() > 100
            {
                return Err("DOCX 作者、部门或格式字段超过大小限制".into());
            }
            commit_generated(&output, |temporary| {
                native_tools::write_docx_content(
                    temporary, title, author, department, format, content,
                )
            })?;
            Ok(json!({"outputPath":output_value,"created":true,"provider":"rust:zip+xml"}))
        }
        "merge_pdfs" => {
            let output_value = required_string(&call.arguments, "outputPath")?;
            let output = writable_path(workspace, output_value)?;
            require_extension(&output, "pdf")?;
            let values = call
                .arguments
                .get("inputPaths")
                .and_then(Value::as_array)
                .ok_or_else(|| "inputPaths 必须是 PDF 路径数组".to_string())?;
            if !(2..=20).contains(&values.len()) {
                return Err("PDF 合并需要 2 至 20 个输入文件".into());
            }
            let inputs = values
                .iter()
                .map(|value| {
                    let value = value
                        .as_str()
                        .ok_or_else(|| "PDF 输入路径必须是字符串".to_string())?;
                    let path = existing_path(workspace, value)?;
                    require_extension(&path, "pdf")?;
                    if path == output {
                        return Err("PDF 输出不能覆盖任一输入文件".into());
                    }
                    Ok(path.to_string_lossy().into_owned())
                })
                .collect::<Result<Vec<_>, String>>()?;
            commit_generated(&output, |temporary| {
                native_tools::merge_pdfs(temporary, &inputs)
            })?;
            Ok(
                json!({"outputPath":output_value,"inputCount":inputs.len(),"created":true,"provider":"rust:lopdf"}),
            )
        }
        "optimize_pdf" => {
            let output_value = required_string(&call.arguments, "outputPath")?;
            let input_value = required_string(&call.arguments, "inputPath")?;
            let output = writable_path(workspace, output_value)?;
            let input = existing_path(workspace, input_value)?;
            require_extension(&output, "pdf")?;
            require_extension(&input, "pdf")?;
            if input == output {
                return Err("PDF 优化输出不能覆盖输入文件".into());
            }
            commit_generated(&output, |temporary| {
                native_tools::optimize_pdf(temporary, &input)
            })?;
            Ok(json!({"outputPath":output_value,"created":true,"provider":"rust:lopdf"}))
        }
        "desktop_automation" => {
            let action = required_string(&call.arguments, "action")?;
            let integer = |name: &str| {
                call.arguments
                    .get(name)
                    .and_then(Value::as_i64)
                    .map(|value| value.to_string())
                    .ok_or_else(|| format!("桌面操作缺少整数参数 {name}"))
            };
            let args = match action {
                "type" => vec![
                    action.into(),
                    required_string(&call.arguments, "text")?.to_string(),
                ],
                "hotkey" => vec![
                    action.into(),
                    required_string(&call.arguments, "hotkey")?.to_string(),
                ],
                "scroll" => vec![action.into(), integer("amount")?],
                "click" => vec![
                    action.into(),
                    integer("x")?,
                    integer("y")?,
                    call.arguments
                        .get("button")
                        .and_then(Value::as_str)
                        .unwrap_or("left")
                        .to_string(),
                    if call.arguments.get("doubleClick").and_then(Value::as_bool) == Some(true) {
                        "double".into()
                    } else {
                        "single".into()
                    },
                ],
                "drag" => vec![
                    action.into(),
                    integer("x")?,
                    integer("y")?,
                    integer("toX")?,
                    integer("toY")?,
                ],
                _ => return Err("不支持的桌面自动化动作".into()),
            };
            native_tools::input_tool(&args)?;
            Ok(json!({"action":action,"completed":true,"provider":"rust:enigo"}))
        }
        _ => Err(format!("未知 Rust 原生工具: {}", call.name)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn call(name: &str, arguments: Value) -> ModelToolCall {
        ModelToolCall {
            id: "call-1".into(),
            name: name.into(),
            arguments,
        }
    }

    #[test]
    fn reads_searches_and_writes_only_inside_workspace() {
        let root = tempfile::tempdir().unwrap();
        fs::write(root.path().join("a.txt"), "alpha\nbeta\n").unwrap();
        let read = execute(
            &call("read_file", json!({"path":"a.txt","offset":1})),
            root.path(),
        )
        .unwrap();
        assert_eq!(read["content"], "beta");
        let search = execute(&call("search_text", json!({"query":"alpha"})), root.path()).unwrap();
        assert_eq!(search["matches"].as_array().unwrap().len(), 1);
        execute(
            &call("write_file", json!({"path":"sub/new.txt","content":"done"})),
            root.path(),
        )
        .unwrap();
        assert_eq!(
            fs::read_to_string(root.path().join("sub/new.txt")).unwrap(),
            "done"
        );
        assert!(execute(
            &call("read_file", json!({"path":"../outside"})),
            root.path()
        )
        .is_err());
    }

    #[test]
    fn definitions_and_risks_keep_writes_confirmation_gated() {
        assert_eq!(definitions().len(), 9);
        assert_eq!(summaries().as_array().unwrap().len(), definitions().len());
        assert_eq!(risk("read_file"), Some(ToolRisk::ReadOnly));
        assert_eq!(risk("write_file"), Some(ToolRisk::Write));
        assert_eq!(risk("native_capabilities"), Some(ToolRisk::ReadOnly));
        assert_eq!(risk("generate_docx"), Some(ToolRisk::Write));
        assert_eq!(risk("desktop_automation"), Some(ToolRisk::Write));
        assert_eq!(risk("unknown"), None);
    }

    #[test]
    fn exposes_native_dependency_replacements_and_generates_docx() {
        let root = tempfile::tempdir().unwrap();
        let capabilities = execute(&call("native_capabilities", json!({})), root.path()).unwrap();
        assert!(capabilities.to_string().contains("python-docx"));
        let result = execute(
            &call(
                "generate_docx",
                json!({"outputPath":"out/report.docx","title":"周报","content":"# 完成\n\n- Rust 原生生成"}),
            ),
            root.path(),
        )
        .unwrap();
        assert_eq!(result["provider"], "rust:zip+xml");
        assert!(root.path().join("out/report.docx").is_file());
        execute(
            &call(
                "generate_docx",
                json!({"outputPath":"out/report.docx","title":"周报二","content":"已替换"}),
            ),
            root.path(),
        )
        .unwrap();
        assert_eq!(fs::read_dir(root.path().join("out")).unwrap().count(), 1);
        assert!(execute(
            &call(
                "generate_docx",
                json!({"outputPath":"../outside.docx","title":"越界","content":"拒绝"}),
            ),
            root.path(),
        )
        .is_err());
    }
}
