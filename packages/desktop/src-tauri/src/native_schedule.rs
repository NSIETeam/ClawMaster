use crate::native_models::{ModelToolCall, ModelToolDefinition};
use chrono::{DateTime, Local, NaiveDate, Utc};
use chrono_tz::Tz;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fs;
use std::io::Write;
use std::path::Path;
use std::str::FromStr;

const MAX_FILE_BYTES: u64 = 4 * 1024 * 1024;
const MAX_SCHEDULES: usize = 10_000;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScheduleItem {
    id: String,
    title: String,
    start_at: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    end_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    notes: Option<String>,
    source: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<String>,
    created_at: String,
    updated_at: String,
}

#[derive(Default, Deserialize, Serialize)]
struct ScheduleFile {
    #[serde(default = "version")]
    version: u8,
    #[serde(default)]
    schedules: Vec<ScheduleItem>,
}

fn version() -> u8 {
    1
}

pub fn definitions() -> Vec<ModelToolDefinition> {
    vec![ModelToolDefinition {
        name: "local_schedule".into(),
        description: "List or manage the user's local schedule through the native Rust store. Create, update, and delete require confirmation.".into(),
        parameters: json!({"type":"object","properties":{
            "action":{"type":"string","enum":["list","create","update","delete"]},
            "id":{"type":"string","maxLength":160},
            "title":{"type":"string","maxLength":500},
            "startAt":{"type":"string","maxLength":100},
            "endAt":{"type":["string","null"],"maxLength":100},
            "notes":{"type":["string","null"],"maxLength":4000},
            "reason":{"type":["string","null"],"maxLength":1000},
            "date":{"type":"string","maxLength":10},
            "timezone":{"type":"string","maxLength":100}
        },"required":["action"],"additionalProperties":false}),
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

pub fn is_write(call: &ModelToolCall) -> bool {
    call.name == "local_schedule"
        && call.arguments.get("action").and_then(Value::as_str) != Some("list")
}

fn clean_required(value: &str, label: &str, max: usize) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty() || value.chars().count() > max {
        return Err(format!("{label} 不能为空或超过 {max} 字符"));
    }
    Ok(value.to_string())
}

fn clean_optional(value: Option<&str>, label: &str, max: usize) -> Result<Option<String>, String> {
    value
        .map(|value| clean_required(value, label, max))
        .transpose()
}

fn canonical_time(value: &str, label: &str) -> Result<String, String> {
    DateTime::parse_from_rfc3339(value.trim())
        .map(|time| time.with_timezone(&Utc).to_rfc3339())
        .map_err(|_| format!("{label} 必须是合法的 ISO 日期时间"))
}

fn validate_range(start: &str, end: Option<&str>) -> Result<(), String> {
    let start = DateTime::parse_from_rfc3339(start).map_err(|_| "开始时间无效".to_string())?;
    if let Some(end) = end {
        let end = DateTime::parse_from_rfc3339(end).map_err(|_| "结束时间无效".to_string())?;
        if end < start {
            return Err("结束时间不能早于开始时间".into());
        }
    }
    Ok(())
}

fn read(path: &Path) -> Result<ScheduleFile, String> {
    let backup = path.with_extension("json.bak");
    let source = if path.exists() || !backup.exists() {
        path
    } else {
        &backup
    };
    let metadata = match fs::metadata(source) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(ScheduleFile {
                version: 1,
                schedules: Vec::new(),
            })
        }
        Err(error) => return Err(format!("无法读取日程文件元数据: {error}")),
    };
    if metadata.len() > MAX_FILE_BYTES {
        return Err("日程文件超过 4 MiB 安全上限".into());
    }
    let file = fs::File::open(source).map_err(|error| format!("无法读取日程文件: {error}"))?;
    let mut value: ScheduleFile =
        serde_json::from_reader(file).map_err(|error| format!("日程文件损坏: {error}"))?;
    if value.version != 1 || value.schedules.len() > MAX_SCHEDULES {
        return Err("日程文件版本或条目数量无效".into());
    }
    for item in &mut value.schedules {
        match item.source.as_str() {
            "user" | "agent" => {}
            // Normalize schedules written by pre-ClawMaster releases at the storage boundary.
            "otto" => item.source = "agent".into(),
            _ => return Err("日程来源无效".into()),
        }
    }
    Ok(value)
}

fn write(path: &Path, file: &ScheduleFile) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "日程路径缺少父目录".to_string())?;
    fs::create_dir_all(parent).map_err(|error| format!("无法创建日程目录: {error}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(parent, fs::Permissions::from_mode(0o700))
            .map_err(|error| format!("无法保护日程目录: {error}"))?;
    }
    let temporary = path.with_extension("json.tmp");
    let mut output =
        fs::File::create(&temporary).map_err(|error| format!("无法创建日程临时文件: {error}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&temporary, fs::Permissions::from_mode(0o600))
            .map_err(|error| format!("无法保护日程临时文件: {error}"))?;
    }
    serde_json::to_writer_pretty(&mut output, file)
        .map_err(|error| format!("无法编码日程: {error}"))?;
    output
        .write_all(b"\n")
        .map_err(|error| format!("无法写入日程: {error}"))?;
    output
        .sync_all()
        .map_err(|error| format!("无法同步日程: {error}"))?;
    let backup = path.with_extension("json.bak");
    if path.exists() {
        let _ = fs::remove_file(&backup);
        fs::rename(path, &backup).map_err(|error| format!("无法备份日程: {error}"))?;
    }
    match fs::rename(&temporary, path) {
        Ok(()) => {
            let _ = fs::remove_file(backup);
            Ok(())
        }
        Err(error) => {
            if backup.exists() {
                let _ = fs::rename(&backup, path);
            }
            let _ = fs::remove_file(temporary);
            Err(format!("无法提交日程: {error}"))
        }
    }
}

fn now() -> String {
    Utc::now().to_rfc3339()
}

fn next_id() -> String {
    let mut bytes = [0_u8; 8];
    let _ = getrandom::getrandom(&mut bytes);
    format!(
        "schedule-{:x}-{:x}",
        Utc::now().timestamp_millis(),
        u64::from_le_bytes(bytes)
    )
}

pub fn list(
    path: &Path,
    date: Option<&str>,
    timezone: Option<&str>,
) -> Result<Vec<ScheduleItem>, String> {
    let mut schedules = read(path)?.schedules;
    if let Some(date) = date {
        NaiveDate::parse_from_str(date, "%Y-%m-%d")
            .map_err(|_| "日期必须是实际存在的 YYYY-MM-DD".to_string())?;
        if let Some(timezone) = timezone.map(str::trim).filter(|value| !value.is_empty()) {
            let timezone =
                Tz::from_str(timezone).map_err(|_| "时区必须是有效的 IANA 名称".to_string())?;
            schedules.retain(|item| {
                DateTime::parse_from_rfc3339(&item.start_at).is_ok_and(|time| {
                    time.with_timezone(&timezone).format("%Y-%m-%d").to_string() == date
                })
            });
        } else {
            schedules.retain(|item| {
                DateTime::parse_from_rfc3339(&item.start_at).is_ok_and(|time| {
                    time.with_timezone(&Local).format("%Y-%m-%d").to_string() == date
                })
            });
        }
    }
    schedules.sort_by(|left, right| left.start_at.cmp(&right.start_at));
    Ok(schedules)
}

pub fn create(path: &Path, payload: &Value, source: &str) -> Result<ScheduleItem, String> {
    let mut file = read(path)?;
    if file.schedules.len() >= MAX_SCHEDULES {
        return Err("日程数量已达到 10000 条上限".into());
    }
    let title = clean_required(
        payload.get("title").and_then(Value::as_str).unwrap_or(""),
        "日程标题",
        500,
    )?;
    let start_at = canonical_time(
        payload.get("startAt").and_then(Value::as_str).unwrap_or(""),
        "开始时间",
    )?;
    let end_at = match payload.get("endAt") {
        None | Some(Value::Null) => None,
        Some(Value::String(value)) => Some(canonical_time(value, "结束时间")?),
        Some(_) => return Err("结束时间必须是字符串或 null".into()),
    };
    validate_range(&start_at, end_at.as_deref())?;
    let timestamp = now();
    let item = ScheduleItem {
        id: next_id(),
        title,
        start_at,
        end_at,
        notes: match payload.get("notes") {
            None | Some(Value::Null) => None,
            Some(Value::String(value)) => clean_optional(Some(value), "日程备注", 4000)?,
            Some(_) => return Err("日程备注必须是字符串或 null".into()),
        },
        source: source.into(),
        reason: match payload.get("reason") {
            None | Some(Value::Null) => None,
            Some(Value::String(value)) => clean_optional(Some(value), "日程原因", 1000)?,
            Some(_) => return Err("日程原因必须是字符串或 null".into()),
        },
        created_at: timestamp.clone(),
        updated_at: timestamp,
    };
    file.schedules.push(item.clone());
    file.schedules
        .sort_by(|left, right| left.start_at.cmp(&right.start_at));
    write(path, &file)?;
    Ok(item)
}

pub fn update(path: &Path, payload: &Value) -> Result<ScheduleItem, String> {
    let id = clean_required(
        payload.get("id").and_then(Value::as_str).unwrap_or(""),
        "日程 ID",
        160,
    )?;
    let mut file = read(path)?;
    let item = file
        .schedules
        .iter_mut()
        .find(|item| item.id == id)
        .ok_or_else(|| "未找到要更新的日程".to_string())?;
    if let Some(title) = payload.get("title").and_then(Value::as_str) {
        item.title = clean_required(title, "日程标题", 500)?;
    }
    if let Some(start) = payload.get("startAt").and_then(Value::as_str) {
        item.start_at = canonical_time(start, "开始时间")?;
    }
    if let Some(value) = payload.get("endAt") {
        item.end_at = if value.is_null() {
            None
        } else {
            Some(canonical_time(
                value
                    .as_str()
                    .ok_or_else(|| "结束时间必须是字符串或 null".to_string())?,
                "结束时间",
            )?)
        };
    }
    if let Some(value) = payload.get("notes") {
        item.notes = match value {
            Value::Null => None,
            Value::String(value) => clean_optional(Some(value), "日程备注", 4000)?,
            _ => return Err("日程备注必须是字符串或 null".into()),
        };
    }
    if let Some(value) = payload.get("reason") {
        item.reason = match value {
            Value::Null => None,
            Value::String(value) => clean_optional(Some(value), "日程原因", 1000)?,
            _ => return Err("日程原因必须是字符串或 null".into()),
        };
    }
    validate_range(&item.start_at, item.end_at.as_deref())?;
    item.updated_at = now();
    let result = item.clone();
    file.schedules
        .sort_by(|left, right| left.start_at.cmp(&right.start_at));
    write(path, &file)?;
    Ok(result)
}

pub fn remove(path: &Path, id: &str) -> Result<bool, String> {
    let id = clean_required(id, "日程 ID", 160)?;
    let mut file = read(path)?;
    let before = file.schedules.len();
    file.schedules.retain(|item| item.id != id);
    if file.schedules.len() == before {
        return Ok(false);
    }
    write(path, &file)?;
    Ok(true)
}

pub fn execute(path: &Path, call: &ModelToolCall) -> Result<Value, String> {
    if call.name != "local_schedule" {
        return Err("未知 Rust 日程工具".into());
    }
    match call
        .arguments
        .get("action")
        .and_then(Value::as_str)
        .unwrap_or("")
    {
        "list" => Ok(
            json!({"schedules":list(path, call.arguments.get("date").and_then(Value::as_str), call.arguments.get("timezone").and_then(Value::as_str))?}),
        ),
        "create" => Ok(json!({"schedule":create(path, &call.arguments, "agent")?})),
        "update" => Ok(json!({"schedule":update(path, &call.arguments)?})),
        "delete" => Ok(
            json!({"deleted":remove(path, call.arguments.get("id").and_then(Value::as_str).unwrap_or(""))?}),
        ),
        _ => Err("日程 action 必须是 list、create、update 或 delete".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn creates_filters_updates_and_removes_compatible_schedules() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("schedules.json");
        let item = create(
            &path,
            &json!({"title":"上海会议","startAt":"2026-09-05T00:30:00Z"}),
            "user",
        )
        .unwrap();
        assert_eq!(
            list(&path, Some("2026-09-05"), Some("Asia/Shanghai"))
                .unwrap()
                .len(),
            1
        );
        let updated = update(&path, &json!({"id":item.id,"notes":"确认议程"})).unwrap();
        assert_eq!(updated.notes.as_deref(), Some("确认议程"));
        assert!(remove(&path, &updated.id).unwrap());
        assert!(list(&path, None, None).unwrap().is_empty());
    }

    #[test]
    fn rejects_invalid_ranges_and_timezones() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("schedules.json");
        assert!(create(&path, &json!({"title":"x","startAt":"bad"}), "user").is_err());
        assert!(create(
            &path,
            &json!({"title":"x","startAt":"2026-09-05T02:00:00Z","endAt":"2026-09-05T01:00:00Z"}),
            "user"
        )
        .is_err());
        assert!(list(&path, Some("2026-09-05"), Some("Mars/Base")).is_err());
        assert!(list(&path, Some("2026-02-30"), Some("UTC")).is_err());
        assert!(create(
            &path,
            &json!({"title":"x","startAt":"2026-09-05T01:00:00Z","notes":42}),
            "user"
        )
        .is_err());
    }

    #[test]
    fn model_created_schedules_use_the_clawmaster_agent_source() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("schedules.json");
        let result = execute(
            &path,
            &ModelToolCall {
                id: "schedule-call".into(),
                name: "local_schedule".into(),
                arguments: json!({
                    "action":"create",
                    "title":"复盘",
                    "startAt":"2026-09-05T01:00:00Z"
                }),
            },
        )
        .unwrap();

        assert_eq!(result["schedule"]["source"], "agent");
    }

    #[test]
    fn normalizes_legacy_schedule_sources_at_the_storage_boundary() {
        let root = tempfile::tempdir().unwrap();
        let path = root.path().join("schedules.json");
        fs::write(
            &path,
            r#"{"version":1,"schedules":[{"id":"legacy","title":"历史日程","startAt":"2026-09-05T01:00:00Z","source":"otto","createdAt":"2026-09-01T00:00:00Z","updatedAt":"2026-09-01T00:00:00Z"}]}"#,
        )
        .unwrap();

        let schedules = list(&path, None, None).unwrap();
        assert_eq!(schedules[0].source, "agent");
    }
}
