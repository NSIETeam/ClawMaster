use enigo::{Axis, Button, Coordinate, Direction, Enigo, Key, Keyboard, Mouse, Settings};
use lopdf::{Dictionary, Document, Object, ObjectId};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use zip::write::SimpleFileOptions;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeCapability {
    id: &'static str,
    provider: &'static str,
    status: &'static str,
    description: &'static str,
    tool: &'static str,
    usage: &'static str,
    replaces: &'static [&'static str],
}

pub fn capability_manifest() -> serde_json::Value {
    serde_json::json!({
        "schemaVersion": 1,
        "runtime": "clawmaster-rust",
        "capabilities": [
            NativeCapability {
                id: "desktop.input",
                provider: "rust:enigo",
                status: "ready",
                description: "原生键盘、鼠标、拖拽和滚动，无需 cliclick",
                tool: "desktop_automation",
                usage: "action=type_text|hotkey|mouse|drag|scroll",
                replaces: &["cliclick"],
            },
            NativeCapability {
                id: "pdf.merge",
                provider: "rust:lopdf",
                status: "ready",
                description: "原生无损 PDF 合并，无需 pdfunite",
                tool: "convert_document",
                usage: "output_format=\"pdf\", merge=true",
                replaces: &["pdfunite"],
            },
            NativeCapability {
                id: "pdf.optimize",
                provider: "rust:lopdf",
                status: "ready",
                description: "原生 PDF 对象清理和流压缩；需要图片降采样时再使用 Ghostscript",
                tool: "convert_document",
                usage: "output_format=\"pdf\", compress=3",
                replaces: &["ghostscript（无损优化场景）"],
            },
            NativeCapability {
                id: "chart.svg",
                provider: "core:svg",
                status: "ready",
                description: "CSV/JSON 柱状图、折线图、散点图、饼图和直方图，无需 gnuplot",
                tool: "analyze_data",
                usage: "op=chart",
                replaces: &["gnuplot（内置图表场景）"],
            },
            NativeCapability {
                id: "slides.pptx",
                provider: "core:pptxgenjs",
                status: "ready",
                description: "可编辑 PPTX 生成，无需 marp",
                tool: "generate_document",
                usage: "output_format=\"pptx\"",
                replaces: &["marp（PPTX 场景）"],
            },
            NativeCapability {
                id: "document.docx",
                provider: "rust:zip+xml",
                status: "ready",
                description: "原生 DOCX 公文生成和 Markdown 基础结构解析，无需 Python、pandoc 或 typst",
                tool: "generate_document",
                usage: "output_format=\"docx\"",
                replaces: &["python3", "python-docx", "jinja2", "markdown"],
            },
        ]
    })
}

pub fn write_capability_manifest(user_directory: &Path) -> Result<PathBuf, String> {
    let path = user_directory.join("native-capabilities.json");
    let pending = user_directory.join(".native-capabilities.json.tmp");
    let bytes = serde_json::to_vec_pretty(&capability_manifest())
        .map_err(|error| format!("serialize native capabilities: {error}"))?;
    std::fs::write(&pending, bytes)
        .map_err(|error| format!("write native capabilities: {error}"))?;
    std::fs::rename(&pending, &path)
        .map_err(|error| format!("publish native capabilities: {error}"))?;
    Ok(path)
}

fn input_tool(args: &[String]) -> Result<(), String> {
    let action = args
        .first()
        .map(String::as_str)
        .ok_or("native input action is required")?;
    let mut enigo = Enigo::new(&Settings::default())
        .map_err(|error| format!("initialize native input: {error}"))?;
    match action {
        "type" => enigo
            .text(args.get(1).ok_or("native input text is required")?)
            .map_err(|error| error.to_string()),
        "click" => {
            let x = parse_i32(args.get(1), "x")?;
            let y = parse_i32(args.get(2), "y")?;
            let button = match args.get(3).map(String::as_str).unwrap_or("left") {
                "right" => Button::Right,
                "middle" => Button::Middle,
                _ => Button::Left,
            };
            let count = if args.get(4).map(String::as_str) == Some("double") {
                2
            } else {
                1
            };
            enigo
                .move_mouse(x, y, Coordinate::Abs)
                .map_err(|error| error.to_string())?;
            for _ in 0..count {
                enigo
                    .button(button, Direction::Click)
                    .map_err(|error| error.to_string())?;
            }
            Ok(())
        }
        "drag" => {
            let x = parse_i32(args.get(1), "x")?;
            let y = parse_i32(args.get(2), "y")?;
            let to_x = parse_i32(args.get(3), "to_x")?;
            let to_y = parse_i32(args.get(4), "to_y")?;
            enigo
                .move_mouse(x, y, Coordinate::Abs)
                .map_err(|error| error.to_string())?;
            enigo
                .button(Button::Left, Direction::Press)
                .map_err(|error| error.to_string())?;
            enigo
                .move_mouse(to_x, to_y, Coordinate::Abs)
                .map_err(|error| error.to_string())?;
            enigo
                .button(Button::Left, Direction::Release)
                .map_err(|error| error.to_string())
        }
        "scroll" => enigo
            .scroll(parse_i32(args.get(1), "amount")?, Axis::Vertical)
            .map_err(|error| error.to_string()),
        "hotkey" => hotkey(&mut enigo, args.get(1).ok_or("hotkey is required")?),
        _ => Err(format!("unsupported native input action: {action}")),
    }
}

fn parse_i32(value: Option<&String>, label: &str) -> Result<i32, String> {
    value
        .ok_or_else(|| format!("{label} is required"))?
        .parse::<i32>()
        .map_err(|_| format!("{label} must be an integer"))
}

fn hotkey(enigo: &mut Enigo, value: &str) -> Result<(), String> {
    let mut parts = value
        .split('+')
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>();
    let key = parts.pop().ok_or("hotkey key is required")?;
    let modifiers = parts
        .iter()
        .map(|part| match part.to_ascii_lowercase().as_str() {
            "cmd" | "command" | "meta" | "win" => Ok(Key::Meta),
            "ctrl" | "control" => Ok(Key::Control),
            "alt" | "option" => Ok(Key::Alt),
            "shift" => Ok(Key::Shift),
            other => Err(format!("unsupported hotkey modifier: {other}")),
        })
        .collect::<Result<Vec<_>, _>>()?;
    let key = match key.to_ascii_lowercase().as_str() {
        "enter" | "return" => Key::Return,
        "tab" => Key::Tab,
        "escape" | "esc" => Key::Escape,
        "space" => Key::Space,
        value if value.chars().count() == 1 => Key::Unicode(value.chars().next().unwrap()),
        other => return Err(format!("unsupported hotkey key: {other}")),
    };
    for modifier in &modifiers {
        enigo
            .key(*modifier, Direction::Press)
            .map_err(|error| error.to_string())?;
    }
    enigo
        .key(key, Direction::Click)
        .map_err(|error| error.to_string())?;
    for modifier in modifiers.iter().rev() {
        enigo
            .key(*modifier, Direction::Release)
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn merge_pdfs(output: &Path, inputs: &[String]) -> Result<(), String> {
    if inputs.len() < 2 {
        return Err("pdf merge requires at least two inputs".to_string());
    }
    let mut max_id = 1;
    let mut page_number = 1;
    let mut pages: BTreeMap<u32, ObjectId> = BTreeMap::new();
    let mut objects = BTreeMap::new();
    for input in inputs {
        let mut document =
            Document::load(input).map_err(|error| format!("load {input}: {error}"))?;
        document.renumber_objects_with(max_id);
        max_id = document.max_id + 1;
        for (_, object_id) in document.get_pages() {
            pages.insert(page_number, object_id);
            page_number += 1;
        }
        objects.extend(document.objects);
    }

    let mut document = Document::with_version("1.5");
    let mut catalog = None;
    let mut pages_root = None;
    for (object_id, object) in objects {
        match object.type_name().unwrap_or_default() {
            "Catalog" => {
                catalog = Some((object_id, object));
            }
            "Pages" => {
                if pages_root.is_none() {
                    pages_root = Some((object_id, object));
                }
            }
            "Page" | "Outlines" | "Outline" => {
                document.objects.insert(object_id, object);
            }
            _ => {
                document.objects.insert(object_id, object);
            }
        }
    }
    let (pages_id, mut pages_object) = pages_root.ok_or("PDF pages root is missing")?;
    let (catalog_id, mut catalog_object) = catalog.ok_or("PDF catalog is missing")?;
    for page_id in pages.values() {
        let page = document
            .get_object_mut(*page_id)
            .and_then(Object::as_dict_mut)
            .map_err(|error| format!("read PDF page: {error}"))?;
        page.set("Parent", pages_id);
    }
    let pages_dictionary: &mut Dictionary = pages_object
        .as_dict_mut()
        .map_err(|error| format!("read PDF pages root: {error}"))?;
    pages_dictionary.set("Count", pages.len() as i64);
    pages_dictionary.set(
        "Kids",
        pages
            .values()
            .copied()
            .map(Object::Reference)
            .collect::<Vec<_>>(),
    );
    catalog_object
        .as_dict_mut()
        .map_err(|error| format!("read PDF catalog: {error}"))?
        .set("Pages", pages_id);
    document.objects.insert(pages_id, pages_object);
    document.objects.insert(catalog_id, catalog_object);
    document.trailer.set("Root", catalog_id);
    document.max_id = document.objects.keys().map(|id| id.0).max().unwrap_or(0);
    document.renumber_objects();
    document.compress();
    document
        .save(output)
        .map_err(|error| format!("save merged PDF: {error}"))?;
    Ok(())
}

fn optimize_pdf(output: &Path, input: &Path) -> Result<(), String> {
    let mut document =
        Document::load(input).map_err(|error| format!("load {}: {error}", input.display()))?;
    document.prune_objects();
    document.compress();
    document
        .save(output)
        .map_err(|error| format!("save optimized PDF: {error}"))?;
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DocxRequest {
    title: String,
    author: String,
    department: String,
    format: String,
    content: String,
}

fn xml_escape(value: &str) -> String {
    value
        .chars()
        .filter(|character| {
            matches!(*character, '\u{9}' | '\u{A}' | '\u{D}') || *character >= '\u{20}'
        })
        .collect::<String>()
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

fn docx_paragraph(text: &str, style: Option<&str>) -> String {
    let properties = style
        .map(|name| format!("<w:pPr><w:pStyle w:val=\"{}\"/></w:pPr>", xml_escape(name)))
        .unwrap_or_default();
    format!(
        "<w:p>{properties}<w:r><w:t xml:space=\"preserve\">{}</w:t></w:r></w:p>",
        xml_escape(text)
    )
}

fn markdown_docx_body(content: &str) -> String {
    content
        .lines()
        .map(|line| {
            let trimmed = line.trim();
            if let Some(text) = trimmed.strip_prefix("### ") {
                docx_paragraph(text, Some("Heading3"))
            } else if let Some(text) = trimmed.strip_prefix("## ") {
                docx_paragraph(text, Some("Heading2"))
            } else if let Some(text) = trimmed.strip_prefix("# ") {
                docx_paragraph(text, Some("Heading1"))
            } else if let Some(text) = trimmed
                .strip_prefix("- ")
                .or_else(|| trimmed.strip_prefix("* "))
            {
                docx_paragraph(&format!("• {text}"), Some("ListParagraph"))
            } else {
                docx_paragraph(line, None)
            }
        })
        .collect::<Vec<_>>()
        .join("")
}

fn write_docx(output: &Path, request_path: &Path) -> Result<(), String> {
    let request: DocxRequest = serde_json::from_slice(
        &std::fs::read(request_path).map_err(|error| format!("read DOCX request: {error}"))?,
    )
    .map_err(|error| format!("parse DOCX request: {error}"))?;
    let file = std::fs::File::create(output)
        .map_err(|error| format!("create {}: {error}", output.display()))?;
    let mut archive = zip::ZipWriter::new(file);
    let options = SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    let entries = [
        ("[Content_Types].xml", include_str!("docx/[Content_Types].xml").to_string()),
        ("_rels/.rels", include_str!("docx/root.rels").to_string()),
        ("word/_rels/document.xml.rels", include_str!("docx/document.rels").to_string()),
        ("word/styles.xml", include_str!("docx/styles.xml").to_string()),
        ("docProps/core.xml", format!(
            "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><cp:coreProperties xmlns:cp=\"http://schemas.openxmlformats.org/package/2006/metadata/core-properties\" xmlns:dc=\"http://purl.org/dc/elements/1.1/\"><dc:title>{}</dc:title><dc:creator>{}</dc:creator><dc:subject>{}</dc:subject></cp:coreProperties>",
            xml_escape(&request.title), xml_escape(&request.author), xml_escape(&request.format)
        )),
        ("word/document.xml", format!(
            "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?><w:document xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\"><w:body>{}{}{}<w:sectPr><w:pgSz w:w=\"11906\" w:h=\"16838\"/><w:pgMar w:top=\"1440\" w:right=\"1440\" w:bottom=\"1440\" w:left=\"1440\"/></w:sectPr></w:body></w:document>",
            docx_paragraph(&request.title, Some("Title")),
            if request.author.is_empty() && request.department.is_empty() { String::new() } else { docx_paragraph(&format!("{}{}{}", request.department, if request.department.is_empty() || request.author.is_empty() { "" } else { " · " }, request.author), Some("Subtitle")) },
            markdown_docx_body(&request.content)
        )),
    ];
    for (name, body) in entries {
        archive
            .start_file(name, options)
            .map_err(|error| error.to_string())?;
        archive
            .write_all(body.as_bytes())
            .map_err(|error| error.to_string())?;
    }
    archive.finish().map_err(|error| error.to_string())?;
    Ok(())
}

pub fn dispatch_from_args(args: &[String]) -> Option<Result<(), String>> {
    if args.first().map(String::as_str) != Some("--native-tool") {
        return None;
    }
    let result = match args.get(1).map(String::as_str) {
        Some("capabilities") => serde_json::to_string(&capability_manifest())
            .map_err(|error| error.to_string())
            .map(|json| println!("{json}")),
        Some("input") => input_tool(&args[2..]),
        Some("pdf-merge") => {
            let output = args
                .get(2)
                .map(PathBuf::from)
                .ok_or_else(|| "pdf merge output is required".to_string());
            output.and_then(|output| merge_pdfs(&output, &args[3..]))
        }
        Some("pdf-optimize") => match (args.get(2), args.get(3)) {
            (Some(output), Some(input)) => optimize_pdf(Path::new(output), Path::new(input)),
            _ => Err("pdf optimize output and input are required".to_string()),
        },
        Some("docx-write") => match (args.get(2), args.get(3)) {
            (Some(output), Some(request)) => write_docx(Path::new(output), Path::new(request)),
            _ => Err("docx write output and request are required".to_string()),
        },
        Some(other) => Err(format!("unsupported native tool: {other}")),
        None => Err("native tool name is required".to_string()),
    };
    Some(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;
    use lopdf::{
        content::{Content, Operation},
        dictionary, Stream,
    };

    #[test]
    fn manifest_declares_real_native_replacements() {
        let value = capability_manifest();
        let ids = value["capabilities"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|capability| capability["id"].as_str())
            .collect::<Vec<_>>();
        assert!(ids.contains(&"desktop.input"));
        assert!(ids.contains(&"pdf.merge"));
        assert!(ids.contains(&"pdf.optimize"));
        assert!(ids.contains(&"chart.svg"));
        assert!(ids.contains(&"document.docx"));
    }

    fn write_test_pdf(path: &Path, text: &str) {
        let mut document = Document::with_version("1.5");
        let pages_id = document.new_object_id();
        let font_id = document.add_object(dictionary! {
            "Type" => "Font",
            "Subtype" => "Type1",
            "BaseFont" => "Helvetica",
        });
        let resources_id = document.add_object(dictionary! {
            "Font" => dictionary! { "F1" => font_id },
        });
        let content = Content {
            operations: vec![
                Operation::new("BT", vec![]),
                Operation::new("Tf", vec![Object::Name(b"F1".to_vec()), 18.into()]),
                Operation::new("Td", vec![20.into(), 100.into()]),
                Operation::new("Tj", vec![Object::string_literal(text)]),
                Operation::new("ET", vec![]),
            ],
        };
        let content_id =
            document.add_object(Stream::new(dictionary! {}, content.encode().unwrap()));
        let page_id = document.add_object(dictionary! {
            "Type" => "Page",
            "Parent" => pages_id,
            "MediaBox" => vec![0.into(), 0.into(), 200.into(), 200.into()],
            "Contents" => content_id,
            "Resources" => resources_id,
        });
        document.objects.insert(
            pages_id,
            Object::Dictionary(dictionary! {
                "Type" => "Pages",
                "Kids" => vec![page_id.into()],
                "Count" => 1,
            }),
        );
        let catalog_id =
            document.add_object(dictionary! { "Type" => "Catalog", "Pages" => pages_id });
        document.trailer.set("Root", catalog_id);
        document.compress();
        document.save(path).unwrap();
    }

    #[test]
    fn rust_pdf_provider_merges_real_pages() {
        let directory =
            std::env::temp_dir().join(format!("clawmaster-lopdf-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&directory);
        std::fs::create_dir_all(&directory).unwrap();
        let first = directory.join("first.pdf");
        let second = directory.join("second.pdf");
        let output = directory.join("merged.pdf");
        write_test_pdf(&first, "first");
        write_test_pdf(&second, "second");
        merge_pdfs(
            &output,
            &[
                first.to_string_lossy().into_owned(),
                second.to_string_lossy().into_owned(),
            ],
        )
        .unwrap();
        assert_eq!(Document::load(&output).unwrap().get_pages().len(), 2);
        let _ = std::fs::remove_dir_all(&directory);
    }

    #[test]
    fn rust_pdf_provider_optimizes_to_a_readable_pdf() {
        let directory =
            std::env::temp_dir().join(format!("clawmaster-pdf-optimize-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&directory);
        std::fs::create_dir_all(&directory).unwrap();
        let input = directory.join("input.pdf");
        let output = directory.join("optimized.pdf");
        write_test_pdf(&input, "optimized");
        optimize_pdf(&output, &input).unwrap();
        assert_eq!(Document::load(&output).unwrap().get_pages().len(), 1);
        let _ = std::fs::remove_dir_all(&directory);
    }

    #[test]
    fn rust_docx_provider_writes_openxml_package() {
        let directory =
            std::env::temp_dir().join(format!("clawmaster-docx-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&directory);
        std::fs::create_dir_all(&directory).unwrap();
        let request = directory.join("request.json");
        let output = directory.join("report.docx");
        std::fs::write(
            &request,
            serde_json::to_vec(&serde_json::json!({
                "title": "周报",
                "author": "林一",
                "department": "研发部",
                "format": "report",
                "content": "# 进展\n\n- <原生&能力>\u{1}",
            }))
            .unwrap(),
        )
        .unwrap();
        write_docx(&output, &request).unwrap();
        let mut archive = zip::ZipArchive::new(std::fs::File::open(&output).unwrap()).unwrap();
        let mut document_xml = String::new();
        archive
            .by_name("word/document.xml")
            .unwrap()
            .read_to_string(&mut document_xml)
            .unwrap();
        assert!(document_xml.contains("&lt;原生&amp;能力&gt;"));
        assert!(!document_xml.contains('\u{1}'));
        assert!(archive.by_name("word/styles.xml").is_ok());
        let _ = std::fs::remove_dir_all(&directory);
    }
}
