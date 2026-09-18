//! Document writers of the recovered native control plane.
//!
//! These are the recovered PDF, DOCX, PPTX and chart writers. They are not part
//! of the RPA path: the automation tools live in `native_tools` and `native_rpa`,
//! and they are separated here because they pull the `lopdf`, `zip` and embedded
//! OpenXML templates that an automation-only build does not need.

use lopdf::{Dictionary, Document, Object, ObjectId};
use serde::Deserialize;
use std::collections::BTreeMap;
use std::io::Write;
use std::path::Path;
use zip::write::SimpleFileOptions;

pub(crate) fn merge_pdfs(output: &Path, inputs: &[String]) -> Result<(), String> {
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

pub(crate) fn optimize_pdf(output: &Path, input: &Path) -> Result<(), String> {
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

// The pre-DSH agent tool layer called this convenience directly, taking the
// document fields as separate arguments. This crate reaches the same writer
// through the `docx-write` subcommand and the request file it reads, so no
// shipped caller remains and the recovered function is kept documented rather
// than deleted.
#[allow(dead_code)]
pub(crate) fn write_docx_content(
    output: &Path,
    title: &str,
    author: &str,
    department: &str,
    format: &str,
    content: &str,
) -> Result<(), String> {
    write_docx_request(
        output,
        &DocxRequest {
            title: title.to_string(),
            author: author.to_string(),
            department: department.to_string(),
            format: format.to_string(),
            content: content.to_string(),
        },
    )
}

pub(crate) fn write_pptx_content(
    output: &Path,
    title: &str,
    author: &str,
    content: &str,
) -> Result<(), String> {
    crate::native_pptx::write_pptx(output, title, author, content)
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

pub(crate) fn write_docx(output: &Path, request_path: &Path) -> Result<(), String> {
    let request: DocxRequest = serde_json::from_slice(
        &std::fs::read(request_path).map_err(|error| format!("read DOCX request: {error}"))?,
    )
    .map_err(|error| format!("parse DOCX request: {error}"))?;
    write_docx_request(output, &request)
}

fn write_docx_request(output: &Path, request: &DocxRequest) -> Result<(), String> {
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

#[cfg(test)]
mod tests {
    use super::*;
    use lopdf::{
        content::{Content, Operation},
        dictionary, Stream,
    };
    use std::io::Read;
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

    #[test]
    fn rust_pptx_provider_writes_editable_openxml_slides() {
        let directory =
            std::env::temp_dir().join(format!("clawmaster-pptx-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&directory);
        std::fs::create_dir_all(&directory).unwrap();
        let output = directory.join("briefing.pptx");
        write_pptx_content(
            &output,
            "季度进展",
            "研发部",
            "# 第一阶段\n\n- Rust 原生能力\n- 可编辑文本\n\n---\n\n# 下一步\n\n完成发布验收",
        )
        .unwrap();

        let mut archive = zip::ZipArchive::new(std::fs::File::open(&output).unwrap()).unwrap();
        let mut first_slide = String::new();
        archive
            .by_name("ppt/slides/slide1.xml")
            .unwrap()
            .read_to_string(&mut first_slide)
            .unwrap();
        assert!(first_slide.contains("第一阶段"));
        assert!(first_slide.contains("Rust 原生能力"));
        assert!(archive.by_name("ppt/slides/slide2.xml").is_ok());
        assert!(archive.by_name("ppt/presentation.xml").is_ok());
        let _ = std::fs::remove_dir_all(&directory);
    }
}
