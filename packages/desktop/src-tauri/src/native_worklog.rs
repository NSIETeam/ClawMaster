use chrono::{Duration, Local, TimeZone};
use serde_json::{json, Value};
use std::fs;
use std::path::Path;

const MAX_AUDIT_BYTES: u64 = 16 * 1024 * 1024;

fn date_key(offset_days: i64) -> String {
    (Local::now() - Duration::days(offset_days))
        .format("%Y-%m-%d")
        .to_string()
}

fn entries(audit_path: &Path, date: &str) -> Vec<Value> {
    if audit_path
        .metadata()
        .is_ok_and(|metadata| metadata.len() > MAX_AUDIT_BYTES)
    {
        return Vec::new();
    }
    fs::read_to_string(audit_path)
        .unwrap_or_default()
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .filter_map(|record| {
            let timestamp = record.get("timestamp")?.as_i64()?;
            let local = Local.timestamp_millis_opt(timestamp).single()?;
            if local.format("%Y-%m-%d").to_string() != date {
                return None;
            }
            let state = record.get("state")?.as_str()?;
            if !matches!(state, "completed" | "failed" | "rejected") {
                return None;
            }
            Some(json!({
                "time":local.format("%H:%M").to_string(),
                "category":"Rust 原生工具",
                "action":record.get("tool").and_then(Value::as_str).unwrap_or("操作"),
                "success":state == "completed",
                "details":record.get("detail").and_then(Value::as_str),
                "entryType":"tool"
            }))
        })
        .collect()
}

pub fn today(audit_path: &Path) -> Value {
    let date = date_key(0);
    let values = entries(audit_path, &date);
    let successes = values
        .iter()
        .filter(|value| value["success"] == true)
        .count();
    json!({
        "date":date,"totalActions":values.len(),"workResults":0,
        "summary":if values.is_empty() {
            "今天还没有 Rust 原生工具工作记录。".to_string()
        } else {
            format!("今天记录了 {} 次原生工具操作，其中 {} 次成功。", values.len(), successes)
        }
    })
}

pub fn recent(audit_path: &Path, days: u64) -> Vec<Value> {
    (0..days.clamp(1, 92))
        .filter_map(|offset| {
            let date = date_key(offset as i64);
            let values = entries(audit_path, &date);
            (!values.is_empty()).then(|| json!({"date":date,"entries":values}))
        })
        .collect()
}

pub fn report(audit_path: &Path) -> Result<Value, String> {
    let summary = today(audit_path);
    let date = summary["date"].as_str().unwrap_or("unknown");
    let day_entries = entries(audit_path, date);
    let mut markdown = format!(
        "# ClawMaster 工作报告 {date}\n\n{}\n",
        summary["summary"].as_str().unwrap_or("")
    );
    for entry in day_entries {
        markdown.push_str(&format!(
            "\n- {} `{}` {}",
            entry["time"].as_str().unwrap_or("--:--"),
            entry["action"].as_str().unwrap_or("操作"),
            if entry["success"] == true {
                "成功"
            } else {
                "失败"
            }
        ));
    }
    let root = audit_path.parent().unwrap_or_else(|| Path::new("."));
    let reports = root.join("work-reports");
    fs::create_dir_all(&reports).map_err(|error| format!("无法创建工作报告目录: {error}"))?;
    let path = reports.join(format!("work-report-{date}.md"));
    let temporary = reports.join(format!(".work-report-{date}.tmp"));
    fs::write(&temporary, &markdown).map_err(|error| format!("无法写入工作报告: {error}"))?;
    fs::rename(&temporary, &path).map_err(|error| format!("无法提交工作报告: {error}"))?;
    Ok(json!({
        "ok":true,"date":date,"title":format!("ClawMaster 工作报告 {date}"),
        "markdown":markdown,"path":path,"message":"Rust 原生工作报告已生成"
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn projects_terminal_audit_records_into_a_report() {
        let root = tempfile::tempdir().unwrap();
        let audit = root.path().join("audit.jsonl");
        fs::write(&audit, format!("{}\n", json!({
            "timestamp":Local::now().timestamp_millis(),"tool":"read_file","state":"completed"
        }))).unwrap();
        assert_eq!(today(&audit)["totalActions"], 1);
        let value = report(&audit).unwrap();
        assert!(Path::new(value["path"].as_str().unwrap()).exists());
    }
}
