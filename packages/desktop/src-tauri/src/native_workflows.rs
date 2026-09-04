use crate::native_models::{ModelToolCall, ModelToolDefinition};
use serde_json::{json, Value};

pub struct DelegatedTask {
    pub agent_id: String,
    pub label: String,
    pub prompt: String,
}

pub type DelegatedResult = (String, Result<(String, u64, u64), String>);

pub fn definitions() -> Vec<ModelToolDefinition> {
    vec![ModelToolDefinition {
        name: "delegate_tasks".into(),
        description: "Delegate 1-8 independent read-only analysis tasks to parallel Rust-native sub-agents. Each sub-agent returns findings to the parent; only the parent may execute tools or modify state after normal confirmation.".into(),
        parameters: json!({"type":"object","properties":{"description":{"type":"string","maxLength":500},"tasks":{"type":"array","minItems":1,"maxItems":8,"items":{"type":"object","properties":{"label":{"type":"string","maxLength":120},"prompt":{"type":"string","maxLength":20000}},"required":["label","prompt"],"additionalProperties":false}}},"required":["description","tasks"],"additionalProperties":false}),
    }]
}

pub fn summaries() -> Vec<Value> {
    definitions()
        .into_iter()
        .map(
            |tool| json!({"name":tool.name,"displayName":tool.name,"description":tool.description}),
        )
        .collect()
}

pub fn contains(name: &str) -> bool {
    name == "delegate_tasks"
}

pub fn parse(call: &ModelToolCall) -> Result<(String, Vec<DelegatedTask>), String> {
    if !contains(&call.name) {
        return Err("未知 Workflow 工具".into());
    }
    let description = call
        .arguments
        .get("description")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    if description.is_empty() || description.chars().count() > 500 {
        return Err("Workflow 描述为空或过长".into());
    }
    let values = call
        .arguments
        .get("tasks")
        .and_then(Value::as_array)
        .ok_or_else(|| "delegate_tasks 缺少 tasks".to_string())?;
    if values.is_empty() || values.len() > 8 {
        return Err("Workflow 子任务数量必须为 1-8".into());
    }
    let mut tasks = Vec::new();
    for (index, value) in values.iter().enumerate() {
        let label = value
            .get("label")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim();
        let prompt = value
            .get("prompt")
            .and_then(Value::as_str)
            .unwrap_or("")
            .trim();
        if label.is_empty()
            || label.chars().count() > 120
            || prompt.is_empty()
            || prompt.chars().count() > 20_000
        {
            return Err(format!("Workflow 第 {} 个子任务字段无效", index + 1));
        }
        tasks.push(DelegatedTask {
            agent_id: format!("{}-agent-{}", call.id, index + 1),
            label: label.into(),
            prompt: prompt.into(),
        });
    }
    Ok((description.into(), tasks))
}

pub fn started(id: &str, description: &str, tasks: &[DelegatedTask], timestamp: u64) -> Value {
    let agents = tasks.iter().map(|task| json!({"agentId":task.agent_id,"label":task.label,"status":"running","startTime":timestamp,"toolCallCount":0,"currentPhase":"thinking"})).collect::<Vec<_>>();
    json!({"id":id,"slug":"parallel-analysis","description":description,"status":"running","startTime":timestamp,
        "totalTokenUsage":{"inputTokens":0,"outputTokens":0,"totalTokens":0},"phases":[{"index":0,"name":"并行分析","description":description,"agents":agents}],"agents":agents})
}

pub fn finish(workflow: &mut Value, results: &[DelegatedResult], timestamp: u64) {
    let mut input = 0_u64;
    let mut output = 0_u64;
    let mut failed = false;
    for agents_path in ["agents", "phases"] {
        if agents_path == "agents" {
            if let Some(agents) = workflow["agents"].as_array_mut() {
                update_agents(
                    agents,
                    results,
                    timestamp,
                    &mut input,
                    &mut output,
                    &mut failed,
                );
            }
        } else if let Some(agents) = workflow["phases"][0]["agents"].as_array_mut() {
            let mut ignored_in = 0;
            let mut ignored_out = 0;
            let mut ignored_failed = false;
            update_agents(
                agents,
                results,
                timestamp,
                &mut ignored_in,
                &mut ignored_out,
                &mut ignored_failed,
            );
        }
    }
    workflow["status"] = json!(if failed { "failed" } else { "completed" });
    workflow["endTime"] = json!(timestamp);
    workflow["totalTokenUsage"] =
        json!({"inputTokens":input,"outputTokens":output,"totalTokens":input+output});
}

pub fn recover_interrupted(workflows: &mut [Value], timestamp: u64) {
    for workflow in workflows {
        if workflow["status"] != "running" {
            continue;
        }
        workflow["status"] = json!("failed");
        workflow["endTime"] = json!(timestamp);
        for pointer in ["/agents", "/phases/0/agents"] {
            if let Some(agents) = workflow.pointer_mut(pointer).and_then(Value::as_array_mut) {
                for agent in agents {
                    if agent["status"] == "running" {
                        agent["status"] = json!("failed");
                        agent["endTime"] = json!(timestamp);
                        agent["outcome"] = json!("ClawMaster 在 Workflow 完成前退出");
                        agent
                            .as_object_mut()
                            .map(|value| value.remove("currentPhase"));
                    }
                }
            }
        }
    }
}

fn update_agents(
    agents: &mut [Value],
    results: &[DelegatedResult],
    timestamp: u64,
    input: &mut u64,
    output: &mut u64,
    failed: &mut bool,
) {
    for agent in agents {
        if let Some((_, result)) = results
            .iter()
            .find(|(id, _)| agent["agentId"] == id.as_str())
        {
            match result {
                Ok((text, i, o)) => {
                    *input += i;
                    *output += o;
                    agent["status"] = json!("completed");
                    agent["outcome"] = json!(text);
                    agent["tokenUsage"] =
                        json!({"inputTokens":i,"outputTokens":o,"totalTokens":i+o});
                }
                Err(message) => {
                    *failed = true;
                    agent["status"] = json!("failed");
                    agent["outcome"] = json!(message);
                }
            }
            agent["endTime"] = json!(timestamp);
            agent
                .as_object_mut()
                .map(|value| value.remove("currentPhase"));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn validates_bounds_and_builds_protocol_summary() {
        let call = ModelToolCall {
            id: "c".into(),
            name: "delegate_tasks".into(),
            arguments: json!({"description":"audit","tasks":[{"label":"a","prompt":"inspect"}]}),
        };
        let (d, t) = parse(&call).unwrap();
        let mut w = started("w", &d, &t, 1);
        finish(
            &mut w,
            &[(t[0].agent_id.clone(), Ok(("ok".into(), 2, 3)))],
            2,
        );
        assert_eq!(w["status"], "completed");
        assert_eq!(w["totalTokenUsage"]["totalTokens"], 5);
        let mut interrupted = vec![started("i", "audit", &t, 1)];
        recover_interrupted(&mut interrupted, 3);
        assert_eq!(interrupted[0]["status"], "failed");
        assert_eq!(interrupted[0]["agents"][0]["status"], "failed");
    }
}
