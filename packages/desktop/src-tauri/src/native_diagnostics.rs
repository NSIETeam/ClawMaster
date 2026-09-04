use crate::{native_process, native_tools};
use serde_json::{json, Value};

pub fn doctor_report() -> Value {
    let manifest = native_tools::capability_manifest();
    let mut checks = manifest["capabilities"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|capability| {
            json!({
                "name": capability["description"],
                "category": "native-capability",
                "present": capability["status"] == "ready",
                "provider": capability["provider"],
                "capabilityId": capability["id"],
                "note": format!("替代依赖：{}", capability["replaces"].as_array().map(|items| items.iter().filter_map(Value::as_str).collect::<Vec<_>>().join(", ")).unwrap_or_default()),
                "required": true
            })
        })
        .collect::<Vec<_>>();
    for (name, note) in [
        ("git", "仅代码仓库操作需要"),
        ("cargo", "仅 Rust 项目开发和本地验证需要"),
    ] {
        let path = native_process::resolve_executable(name).ok();
        checks.push(json!({
            "name": name,
            "category": "optional-executable",
            "present": path.is_some(),
            "version": Value::Null,
            "installHint": if path.is_none() { format!("需要相关开发能力时再安装 {name}") } else { String::new() },
            "provider": path,
            "note": note,
            "required": false
        }));
    }
    let required_missing = checks
        .iter()
        .filter(|check| check["required"] == true && check["present"] == false)
        .count();
    let optional_missing = checks
        .iter()
        .filter(|check| check["required"] == false && check["present"] == false)
        .count();
    let present = checks
        .iter()
        .filter(|check| check["present"] == true)
        .count();
    let affected = checks
        .iter()
        .filter(|check| check["required"] == true && check["present"] == false)
        .filter_map(|check| check["capabilityId"].as_str())
        .collect::<Vec<_>>();
    json!({
        "platform": std::env::consts::OS,
        "checks": checks,
        "presentCount": present,
        "missingCount": required_missing,
        "optionalMissingCount": optional_missing,
        "affectedCapabilities": affected
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_replacements_are_required_and_ready() {
        let report = doctor_report();
        assert_eq!(report["missingCount"], 0);
        let checks = report["checks"].as_array().unwrap();
        assert!(checks.iter().any(|check| {
            check["capabilityId"] == "document.docx"
                && check["provider"] == "rust:zip+xml"
                && check["present"] == true
        }));
        assert!(checks.iter().any(|check| {
            check["capabilityId"] == "pdf.merge"
                && check["note"].as_str().unwrap().contains("pdfunite")
        }));
        assert!(checks.iter().any(|check| {
            check["capabilityId"] == "slides.pptx"
                && check["provider"] == "rust:zip+xml"
                && check["note"].as_str().unwrap().contains("pptxgenjs")
        }));
    }
}
