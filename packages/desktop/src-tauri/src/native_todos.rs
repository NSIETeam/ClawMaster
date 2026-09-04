use crate::native_models::{ModelToolCall, ModelToolDefinition};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashSet;

const MAX_TODOS: usize = 100;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TodoItem {
    id: String,
    content: String,
    status: String,
    priority: String,
}

pub fn definitions() -> Vec<ModelToolDefinition> {
    vec![ModelToolDefinition {
        name: "todo_write".into(),
        description: "Replace the native task list with the current plan and progress. Requires confirmation.".into(),
        parameters: json!({"type":"object","properties":{
            "todos":{"type":"array","maxItems":100,"items":{"type":"object","properties":{
                "id":{"type":"string","maxLength":160},
                "content":{"type":"string","maxLength":1000},
                "status":{"type":"string","enum":["pending","in_progress","completed"]},
                "priority":{"type":"string","enum":["high","medium","low"]}
            },"required":["id","content","status","priority"],"additionalProperties":false}}
        },"required":["todos"],"additionalProperties":false}),
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

fn clean(value: Option<&str>, label: &str, max: usize) -> Result<String, String> {
    let value = value.unwrap_or("").trim();
    if value.is_empty() || value.chars().count() > max {
        return Err(format!("{label} 不能为空或超过 {max} 字符"));
    }
    Ok(value.to_string())
}

pub fn parse(call: &ModelToolCall) -> Result<Vec<TodoItem>, String> {
    if call.name != "todo_write" {
        return Err("未知 Rust 待办工具".into());
    }
    let values = call
        .arguments
        .get("todos")
        .and_then(Value::as_array)
        .ok_or_else(|| "todos 必须是数组".to_string())?;
    if values.len() > MAX_TODOS {
        return Err("待办不能超过 100 项".into());
    }
    let mut ids = HashSet::new();
    values
        .iter()
        .map(|value| {
            let id = clean(value.get("id").and_then(Value::as_str), "待办 ID", 160)?;
            if !ids.insert(id.clone()) {
                return Err("待办 ID 不能重复".into());
            }
            let content = clean(
                value.get("content").and_then(Value::as_str),
                "待办内容",
                1000,
            )?;
            let status = clean(value.get("status").and_then(Value::as_str), "待办状态", 20)?;
            if !matches!(status.as_str(), "pending" | "in_progress" | "completed") {
                return Err("待办状态无效".into());
            }
            let priority = clean(
                value.get("priority").and_then(Value::as_str),
                "待办优先级",
                20,
            )?;
            if !matches!(priority.as_str(), "high" | "medium" | "low") {
                return Err("待办优先级无效".into());
            }
            Ok(TodoItem {
                id,
                content,
                status,
                priority,
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_a_bounded_unique_todo_list() {
        let valid = ModelToolCall {
            id: "call".into(),
            name: "todo_write".into(),
            arguments: json!({"todos":[
                {"id":"1","content":"Migrate","status":"in_progress","priority":"high"}
            ]}),
        };
        assert_eq!(parse(&valid).unwrap().len(), 1);
        let duplicate = ModelToolCall {
            arguments: json!({"todos":[
                {"id":"1","content":"a","status":"pending","priority":"low"},
                {"id":"1","content":"b","status":"pending","priority":"low"}
            ]}),
            ..valid
        };
        assert!(parse(&duplicate).is_err());
    }
}
