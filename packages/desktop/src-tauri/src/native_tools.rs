use enigo::{Axis, Button, Coordinate, Direction, Enigo, Key, Keyboard, Mouse, Settings};
use lopdf::{Dictionary, Document, Object, ObjectId};
use serde::Serialize;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct NativeCapability {
    id: &'static str,
    provider: &'static str,
    status: &'static str,
    description: &'static str,
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
            },
            NativeCapability {
                id: "pdf.merge",
                provider: "rust:lopdf",
                status: "ready",
                description: "原生无损 PDF 合并，无需 pdfunite",
            },
            NativeCapability {
                id: "chart.svg",
                provider: "core:svg",
                status: "ready",
                description: "CSV/JSON 柱状图、折线图、散点图、饼图和直方图，无需 gnuplot",
            },
            NativeCapability {
                id: "slides.pptx",
                provider: "core:pptxgenjs",
                status: "ready",
                description: "可编辑 PPTX 生成，无需 marp",
            },
            NativeCapability {
                id: "document.docx",
                provider: "bundled:doc-writer",
                status: "ready",
                description: "DOCX 公文生成，无需 pandoc 或 typst",
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
        Some(other) => Err(format!("unsupported native tool: {other}")),
        None => Err("native tool name is required".to_string()),
    };
    Some(result)
}

#[cfg(test)]
mod tests {
    use super::*;
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
        assert!(ids.contains(&"chart.svg"));
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
}
