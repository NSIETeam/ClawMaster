use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs::{self, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};
use zip::{ZipArchive, ZipWriter};

const MAX_XML_BYTES: u64 = 10 * 1024 * 1024;
const MAX_BLOCKS: usize = 20_000;
static STAGE_SEQUENCE: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditableBlock {
    pub id: String,
    pub location: String,
    pub text: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlockEdit {
    pub id: String,
    pub original_text: String,
    pub text: String,
}

#[derive(Clone, Debug)]
struct XmlBlock {
    public: EditableBlock,
    ranges: Vec<std::ops::Range<usize>>,
}

fn digest_file(path: &Path) -> Result<String, String> {
    let bytes = fs::read(path).map_err(|error| format!("无法读取文档校验值: {error}"))?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}

fn escape_xml_text(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

fn validate_xml_text(value: &str) -> Result<(), String> {
    if value.chars().all(|character| {
        matches!(character, '\u{9}' | '\u{A}' | '\u{D}')
            || ('\u{20}'..='\u{D7FF}').contains(&character)
            || ('\u{E000}'..='\u{FFFD}').contains(&character)
            || ('\u{10000}'..='\u{10FFFF}').contains(&character)
    }) {
        Ok(())
    } else {
        Err("编辑内容包含 Office XML 不支持的控制字符".into())
    }
}

fn parsed_xml(xml: &str) -> Result<roxmltree::Document<'_>, String> {
    roxmltree::Document::parse_with_options(
        xml,
        roxmltree::ParsingOptions {
            allow_dtd: false,
            nodes_limit: MAX_BLOCKS as u32 * 20,
            ..Default::default()
        },
    )
    .map_err(|error| format!("Office XML 结构无效: {error}"))
}

fn part_label(part: &str) -> String {
    if part == "word/document.xml" {
        return "正文".into();
    }
    if part.starts_with("word/header") {
        return "页眉".into();
    }
    if part.starts_with("word/footer") {
        return "页脚".into();
    }
    if let Some(slide) = part
        .strip_prefix("ppt/slides/slide")
        .and_then(|value| value.strip_suffix(".xml"))
    {
        return format!("第 {slide} 页");
    }
    part.rsplit('/').next().unwrap_or(part).to_string()
}

fn text_blocks(part: &str, xml: &str) -> Result<Vec<XmlBlock>, String> {
    let document = parsed_xml(xml)?;
    let mut blocks = Vec::new();
    for paragraph in document
        .descendants()
        .filter(|node| node.is_element() && node.tag_name().name() == "p")
    {
        let text_nodes = paragraph
            .descendants()
            .filter(|node| {
                node.is_text()
                    && node.parent().is_some_and(|parent| {
                        parent.is_element() && parent.tag_name().name() == "t"
                    })
            })
            .collect::<Vec<_>>();
        if text_nodes.is_empty() {
            continue;
        }
        if blocks.len() >= MAX_BLOCKS {
            return Err("文档可编辑段落超过 20000 个，请拆分后编辑".into());
        }
        let index = blocks.len();
        blocks.push(XmlBlock {
            public: EditableBlock {
                id: format!("{part}#{index}"),
                location: format!("{} · 段落 {}", part_label(part), index + 1),
                text: text_nodes
                    .iter()
                    .map(|node| node.text().unwrap_or(""))
                    .collect(),
            },
            ranges: text_nodes.into_iter().map(|node| node.range()).collect(),
        });
    }
    Ok(blocks)
}

fn editable_parts(format: &str, archive: &mut ZipArchive<fs::File>) -> Result<Vec<String>, String> {
    let all_names = (0..archive.len())
        .filter_map(|index| {
            archive
                .by_index(index)
                .ok()
                .map(|entry| entry.name().to_string())
        })
        .collect::<Vec<_>>();
    if all_names
        .iter()
        .any(|name| name.starts_with("_xmlsignatures/"))
    {
        return Err("文档包含数字签名，编辑会使签名失效；请先在 Office 中另存为未签名副本".into());
    }
    let mut names = all_names
        .into_iter()
        .filter(|name| match format {
            "docx" => {
                name == "word/document.xml"
                    || name.starts_with("word/header")
                    || name.starts_with("word/footer")
            }
            "pptx" => name.starts_with("ppt/slides/slide") && name.ends_with(".xml"),
            _ => false,
        })
        .collect::<Vec<_>>();
    names.sort();
    Ok(names)
}

pub fn extract(path: &Path, format: &str) -> Result<(Vec<EditableBlock>, String), String> {
    let file = fs::File::open(path).map_err(|error| format!("无法打开 Office 文档: {error}"))?;
    let mut archive =
        ZipArchive::new(file).map_err(|error| format!("Office 文档结构无效: {error}"))?;
    let mut result = Vec::new();
    for part in editable_parts(format, &mut archive)? {
        let mut entry = archive
            .by_name(&part)
            .map_err(|error| format!("无法读取 {part}: {error}"))?;
        if entry.encrypted() || entry.size() > MAX_XML_BYTES {
            return Err("Office 文档包含加密或过大的 XML 内容，不能安全内嵌编辑".into());
        }
        let mut xml = String::new();
        entry
            .read_to_string(&mut xml)
            .map_err(|error| format!("Office XML 不是有效 UTF-8: {error}"))?;
        let remaining = MAX_BLOCKS.saturating_sub(result.len());
        let mut blocks = text_blocks(&part, &xml)?;
        if blocks.len() > remaining {
            return Err("文档可编辑内容块超过 20000 个，请拆分后编辑".into());
        }
        result.extend(blocks.drain(..).map(|block| block.public));
    }
    if result.is_empty() {
        return Err("文档中没有可定位的可编辑文本".into());
    }
    Ok((result, digest_file(path)?))
}

fn apply_part_edits(
    part: &str,
    xml: &str,
    edits: &HashMap<String, &BlockEdit>,
) -> Result<(String, std::collections::HashSet<String>), String> {
    let mut replacements = Vec::new();
    let mut found = std::collections::HashSet::new();
    for block in text_blocks(part, xml)? {
        let Some(edit) = edits.get(&block.public.id) else {
            continue;
        };
        found.insert(block.public.id.clone());
        if edit.original_text != block.public.text {
            return Err(format!("文档内容块 {} 已变化，请重新打开后再编辑", edit.id));
        }
        if edit.text != edit.original_text {
            let mut ranges = block.ranges.into_iter();
            if let Some(first) = ranges.next() {
                replacements.push((first, escape_xml_text(&edit.text)));
                replacements.extend(ranges.map(|range| (range, String::new())));
            }
        }
    }
    replacements.sort_by_key(|(range, _)| std::cmp::Reverse(range.start));
    let mut output = xml.to_string();
    for (range, replacement) in replacements {
        output.replace_range(range, &replacement);
    }
    Ok((output, found))
}

fn stage_path(destination: &Path) -> Result<(PathBuf, fs::File), String> {
    let parent = destination
        .parent()
        .ok_or_else(|| "目标文件缺少父目录".to_string())?;
    for _ in 0..32 {
        let sequence = STAGE_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let path = parent.join(format!(
            ".clawmaster-office-{}-{sequence}.tmp",
            std::process::id()
        ));
        match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(file) => return Ok((path, file)),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(format!("无法创建 Office 编辑暂存文件: {error}")),
        }
    }
    Err("无法分配 Office 编辑暂存文件".into())
}

pub fn write_copy(
    source: &Path,
    destination: &Path,
    format: &str,
    expected_digest: &str,
    edits: &[BlockEdit],
) -> Result<usize, String> {
    if digest_file(source)? != expected_digest {
        return Err("原文档已被其他程序修改，请重新打开后再保存".into());
    }
    if destination.exists() {
        return Err("请选择尚不存在的新文件名，不能覆盖已有文件".into());
    }
    let mut unique = HashMap::new();
    for edit in edits {
        if edit.text != edit.original_text {
            validate_xml_text(&edit.text)?;
            if edit
                .text
                .chars()
                .any(|character| matches!(character, '\r' | '\n'))
            {
                return Err("Office 单个段落暂不支持插入换行，请分别编辑现有段落".into());
            }
            let boundary_whitespace = |character: char| matches!(character, ' ' | '\t');
            if edit.text.chars().next().is_some_and(boundary_whitespace)
                || edit
                    .text
                    .chars()
                    .next_back()
                    .is_some_and(boundary_whitespace)
            {
                return Err("Office 段落首尾空白可能被原格式折叠，请删除首尾空白后保存".into());
            }
        }
        if edit.text.len() > MAX_XML_BYTES as usize
            || unique.insert(edit.id.clone(), edit).is_some()
        {
            return Err("编辑内容过大或包含重复内容块".into());
        }
    }
    let input = fs::File::open(source).map_err(|error| format!("无法打开 Office 原件: {error}"))?;
    let mut archive =
        ZipArchive::new(input).map_err(|error| format!("Office 文档结构无效: {error}"))?;
    let editable = editable_parts(format, &mut archive)?
        .into_iter()
        .collect::<std::collections::BTreeSet<_>>();
    let (stage, output) = stage_path(destination)?;
    let result = (|| -> Result<usize, String> {
        let mut writer = ZipWriter::new(output);
        writer.set_raw_comment(archive.comment().to_vec().into_boxed_slice());
        let mut found = std::collections::HashSet::new();
        for index in 0..archive.len() {
            let mut entry = archive
                .by_index(index)
                .map_err(|error| format!("无法读取 Office 包: {error}"))?;
            let name = entry.name().to_string();
            if editable.contains(&name) {
                let part_edits = unique
                    .iter()
                    .filter(|(id, _)| id.starts_with(&format!("{name}#")))
                    .map(|(id, edit)| (id.clone(), *edit))
                    .collect::<HashMap<_, _>>();
                if part_edits.is_empty() {
                    writer
                        .raw_copy_file(entry)
                        .map_err(|error| format!("无法保留 Office 包内容: {error}"))?;
                    continue;
                }
                let options = entry.options();
                let mut xml = String::new();
                entry
                    .read_to_string(&mut xml)
                    .map_err(|error| format!("Office XML 不是有效 UTF-8: {error}"))?;
                let (updated, part_found) = apply_part_edits(&name, &xml, &part_edits)?;
                found.extend(part_found);
                writer
                    .start_file(&name, options)
                    .map_err(|error| format!("无法写入 Office 包: {error}"))?;
                writer
                    .write_all(updated.as_bytes())
                    .map_err(|error| format!("无法写入 Office XML: {error}"))?;
            } else {
                writer
                    .raw_copy_file(entry)
                    .map_err(|error| format!("无法保留 Office 包内容: {error}"))?;
            }
        }
        if found.len() != unique.len() {
            return Err("部分编辑内容块已不存在，请重新打开文档".into());
        }
        writer
            .finish()
            .map_err(|error| format!("无法完成 Office 文档: {error}"))?
            .sync_all()
            .map_err(|error| format!("无法同步 Office 文档: {error}"))?;
        if let Err(link_error) = fs::hard_link(&stage, destination) {
            let mut staged = fs::File::open(&stage)
                .map_err(|error| format!("无法读取 Office 编辑暂存文件: {error}"))?;
            let mut published = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(destination)
                .map_err(|error| format!("无法发布 Office 编辑副本 ({link_error}): {error}"))?;
            if let Err(error) =
                std::io::copy(&mut staged, &mut published).and_then(|_| published.sync_all())
            {
                drop(published);
                let _ = fs::remove_file(destination);
                return Err(format!("无法发布 Office 编辑副本: {error}"));
            }
        }
        Ok(edits
            .iter()
            .filter(|edit| edit.text != edit.original_text)
            .count())
    })();
    let _ = fs::remove_file(&stage);
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;
    use zip::write::SimpleFileOptions;

    fn sample(path: &Path) {
        let mut writer = ZipWriter::new(Cursor::new(Vec::new()));
        writer.set_comment("clawmaster-test");
        writer
            .start_file("[Content_Types].xml", SimpleFileOptions::default())
            .unwrap();
        writer.write_all(b"<Types/>").unwrap();
        writer
            .start_file("word/document.xml", SimpleFileOptions::default())
            .unwrap();
        writer.write_all(br#"<w:document xmlns:w="urn:w"><w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Hello &amp; one</w:t></w:r></w:p><w:p><w:r><w:t>Second</w:t></w:r></w:p></w:document>"#).unwrap();
        let bytes = writer.finish().unwrap().into_inner();
        fs::write(path, bytes).unwrap();
    }

    fn sample_pptx(path: &Path) {
        let mut writer = ZipWriter::new(Cursor::new(Vec::new()));
        for (name, text) in [
            ("ppt/slides/slide1.xml", "第一页"),
            ("ppt/slides/slide2.xml", "第二页"),
        ] {
            writer
                .start_file(name, SimpleFileOptions::default())
                .unwrap();
            writer
                .write_all(
                    format!(
                        r#"<p:sld xmlns:p="urn:p" xmlns:a="urn:a"><a:p><a:r><a:t>{text}</a:t></a:r></a:p></p:sld>"#
                    )
                    .as_bytes(),
                )
                .unwrap();
        }
        fs::write(path, writer.finish().unwrap().into_inner()).unwrap();
    }

    #[test]
    fn edits_only_selected_xml_text_and_preserves_other_package_bytes() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("source.docx");
        let target = root.path().join("edited.docx");
        sample(&source);
        let (blocks, digest) = extract(&source, "docx").unwrap();
        assert_eq!(
            blocks
                .iter()
                .map(|block| block.text.as_str())
                .collect::<Vec<_>>(),
            ["Hello & one", "Second"]
        );
        let changed = write_copy(
            &source,
            &target,
            "docx",
            &digest,
            &[BlockEdit {
                id: blocks[0].id.clone(),
                original_text: blocks[0].text.clone(),
                text: "Final <one>".into(),
            }],
        )
        .unwrap();
        assert_eq!(changed, 1);
        let file = fs::File::open(target).unwrap();
        let mut archive = ZipArchive::new(file).unwrap();
        assert_eq!(archive.comment(), b"clawmaster-test");
        let mut xml = String::new();
        archive
            .by_name("word/document.xml")
            .unwrap()
            .read_to_string(&mut xml)
            .unwrap();
        assert!(xml.contains("<w:rPr><w:b/></w:rPr><w:t>Final &lt;one&gt;</w:t>"));
        assert!(xml.contains("<w:t>Second</w:t>"));
        let mut untouched = String::new();
        archive
            .by_name("[Content_Types].xml")
            .unwrap()
            .read_to_string(&mut untouched)
            .unwrap();
        assert_eq!(untouched, "<Types/>");
    }

    #[test]
    fn permits_unchanged_paragraphs_with_preserved_boundary_whitespace() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("source.docx");
        let target = root.path().join("edited.docx");
        let mut writer = ZipWriter::new(Cursor::new(Vec::new()));
        writer
            .start_file("word/document.xml", SimpleFileOptions::default())
            .unwrap();
        writer
            .write_all(br#"<w:document xmlns:w="urn:w"><w:p><w:r><w:t xml:space="preserve"> kept </w:t></w:r></w:p><w:p><w:r><w:t>Change me</w:t></w:r></w:p></w:document>"#)
            .unwrap();
        fs::write(&source, writer.finish().unwrap().into_inner()).unwrap();
        let (blocks, digest) = extract(&source, "docx").unwrap();

        let changed = write_copy(
            &source,
            &target,
            "docx",
            &digest,
            &[
                BlockEdit {
                    id: blocks[0].id.clone(),
                    original_text: blocks[0].text.clone(),
                    text: blocks[0].text.clone(),
                },
                BlockEdit {
                    id: blocks[1].id.clone(),
                    original_text: blocks[1].text.clone(),
                    text: "Changed".into(),
                },
            ],
        )
        .unwrap();

        assert_eq!(changed, 1);
    }

    #[test]
    fn refuses_stale_sources_existing_destinations_and_unknown_blocks() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("source.docx");
        sample(&source);
        let (blocks, digest) = extract(&source, "docx").unwrap();
        fs::write(root.path().join("existing.docx"), b"keep").unwrap();
        assert!(write_copy(
            &source,
            &root.path().join("existing.docx"),
            "docx",
            &digest,
            &[]
        )
        .is_err());
        assert!(write_copy(
            &source,
            &root.path().join("unknown.docx"),
            "docx",
            &digest,
            &[BlockEdit {
                id: "word/document.xml#99".into(),
                original_text: "x".into(),
                text: "y".into(),
            }]
        )
        .is_err());
        fs::write(&source, b"changed outside").unwrap();
        assert!(write_copy(
            &source,
            &root.path().join("stale.docx"),
            "docx",
            &digest,
            &[BlockEdit {
                id: blocks[0].id.clone(),
                original_text: blocks[0].text.clone(),
                text: "new".into(),
            }]
        )
        .unwrap_err()
        .contains("其他程序修改"));
    }

    #[test]
    fn rejects_signed_packages_and_invalid_xml_characters() {
        let root = tempfile::tempdir().unwrap();
        let signed = root.path().join("signed.docx");
        let mut writer = ZipWriter::new(Cursor::new(Vec::new()));
        writer
            .start_file("word/document.xml", SimpleFileOptions::default())
            .unwrap();
        writer
            .write_all(br#"<w:document xmlns:w="urn:w"><w:t>text</w:t></w:document>"#)
            .unwrap();
        writer
            .start_file("_xmlsignatures/sig1.xml", SimpleFileOptions::default())
            .unwrap();
        writer.write_all(b"<Signature/>").unwrap();
        fs::write(&signed, writer.finish().unwrap().into_inner()).unwrap();
        assert!(extract(&signed, "docx").unwrap_err().contains("数字签名"));

        let source = root.path().join("source.docx");
        sample(&source);
        let (blocks, digest) = extract(&source, "docx").unwrap();
        assert!(write_copy(
            &source,
            &root.path().join("invalid.docx"),
            "docx",
            &digest,
            &[BlockEdit {
                id: blocks[0].id.clone(),
                original_text: blocks[0].text.clone(),
                text: "bad\u{1}text".into(),
            }]
        )
        .unwrap_err()
        .contains("控制字符"));
    }

    #[test]
    fn edits_one_pptx_slide_without_rewriting_the_other_slide() {
        let root = tempfile::tempdir().unwrap();
        let source = root.path().join("source.pptx");
        let target = root.path().join("edited.pptx");
        sample_pptx(&source);
        let (blocks, digest) = extract(&source, "pptx").unwrap();
        assert_eq!(blocks[0].location, "第 1 页 · 段落 1");
        assert_eq!(blocks[1].location, "第 2 页 · 段落 1");

        let mut source_archive = ZipArchive::new(fs::File::open(&source).unwrap()).unwrap();
        let untouched_crc = source_archive
            .by_name("ppt/slides/slide2.xml")
            .unwrap()
            .crc32();
        write_copy(
            &source,
            &target,
            "pptx",
            &digest,
            &[BlockEdit {
                id: blocks[0].id.clone(),
                original_text: blocks[0].text.clone(),
                text: "新第一页".into(),
            }],
        )
        .unwrap();

        let mut target_archive = ZipArchive::new(fs::File::open(&target).unwrap()).unwrap();
        assert_eq!(
            target_archive
                .by_name("ppt/slides/slide2.xml")
                .unwrap()
                .crc32(),
            untouched_crc
        );
        let mut changed_xml = String::new();
        target_archive
            .by_name("ppt/slides/slide1.xml")
            .unwrap()
            .read_to_string(&mut changed_xml)
            .unwrap();
        assert!(changed_xml.contains("<a:t>新第一页</a:t>"));
    }
}
