use crate::native_state_store::{NativeStateStore, StateStoreError, TREE_INDEX};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

const CAPSULE_PREFIX: &str = "state-capsule:";

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StateCapsule {
    pub session_id: String,
    pub goal: String,
    pub decisions: Vec<String>,
    pub file_hashes: BTreeMap<String, String>,
    pub verification_results: Vec<String>,
    pub incomplete_actions: Vec<String>,
    pub approval_status: BTreeMap<String, String>,
    pub memory_ids: Vec<String>,
    pub revision: u64,
    pub updated_at: u64,
}

fn capsule_id(session_id: &str) -> String {
    format!("{CAPSULE_PREFIX}{session_id}")
}

pub fn load(store: &NativeStateStore, session_id: &str) -> Result<StateCapsule, String> {
    match store.get::<StateCapsule>(TREE_INDEX, &capsule_id(session_id)) {
        Ok(Some(record)) => Ok(record.payload),
        Ok(None) | Err(StateStoreError::CorruptRecord { .. }) => Ok(StateCapsule {
            session_id: session_id.into(),
            ..StateCapsule::default()
        }),
        Err(error) => Err(error.to_string()),
    }
}

fn save(
    store: &NativeStateStore,
    mut capsule: StateCapsule,
    now_ms: u64,
) -> Result<StateCapsule, String> {
    capsule.revision += 1;
    capsule.updated_at = now_ms;
    store
        .put_latest(
            TREE_INDEX,
            &capsule_id(&capsule.session_id),
            "state-capsule",
            capsule.clone(),
        )
        .map_err(|error| error.to_string())?;
    store.flush().map_err(|error| error.to_string())?;
    Ok(capsule)
}

pub fn record_goal(
    store: &NativeStateStore,
    session_id: &str,
    goal: &str,
    memory_ids: Vec<String>,
    now_ms: u64,
) -> Result<StateCapsule, String> {
    let mut capsule = load(store, session_id)?;
    capsule.goal = goal.chars().take(2_000).collect();
    capsule.memory_ids = memory_ids.into_iter().take(20).collect();
    save(store, capsule, now_ms)
}

pub fn record_tool(
    store: &NativeStateStore,
    session_id: &str,
    tool_call_id: &str,
    status: &str,
    now_ms: u64,
) -> Result<StateCapsule, String> {
    let mut capsule = load(store, session_id)?;
    if matches!(
        status,
        "succeeded" | "failed" | "cancelled" | "unknownOutcome"
    ) {
        capsule.incomplete_actions.retain(|id| id != tool_call_id);
        capsule
            .verification_results
            .push(format!("{tool_call_id}:{status}"));
        capsule.verification_results = capsule
            .verification_results
            .into_iter()
            .rev()
            .take(20)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect();
    } else if !capsule
        .incomplete_actions
        .iter()
        .any(|id| id == tool_call_id)
    {
        capsule.incomplete_actions.push(tool_call_id.into());
    }
    save(store, capsule, now_ms)
}

pub fn record_approval(
    store: &NativeStateStore,
    session_id: &str,
    approval_id: &str,
    status: &str,
    now_ms: u64,
) -> Result<StateCapsule, String> {
    let mut capsule = load(store, session_id)?;
    capsule
        .approval_status
        .insert(approval_id.into(), status.into());
    save(store, capsule, now_ms)
}

pub fn prompt(capsule: &StateCapsule) -> String {
    let mut lines = vec![format!("goal: {}", capsule.goal)];
    if !capsule.decisions.is_empty() {
        lines.push(format!("decisions: {}", capsule.decisions.join(" | ")));
    }
    if !capsule.incomplete_actions.is_empty() {
        lines.push(format!(
            "incompleteActions: {}",
            capsule.incomplete_actions.join(", ")
        ));
    }
    if !capsule.approval_status.is_empty() {
        lines.push(format!(
            "approvals: {}",
            capsule
                .approval_status
                .iter()
                .map(|(id, status)| format!("{id}={status}"))
                .collect::<Vec<_>>()
                .join(", ")
        ));
    }
    if !capsule.memory_ids.is_empty() {
        lines.push(format!("memoryIds: {}", capsule.memory_ids.join(", ")));
    }
    lines.join("\n").chars().take(1_280).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn restores_goal_pending_actions_approvals_and_memory_after_restart() {
        let root = tempfile::tempdir().unwrap();
        let store = NativeStateStore::open_for_test(root.path(), [63; 32]).unwrap();
        record_goal(
            &store,
            "session-1",
            "ship safely",
            vec!["memory-1".into()],
            1,
        )
        .unwrap();
        record_tool(&store, "session-1", "call-1", "running", 2).unwrap();
        record_approval(&store, "session-1", "approval-1", "waiting", 3).unwrap();
        drop(store);

        let reopened = NativeStateStore::open_for_test(root.path(), [63; 32]).unwrap();
        let capsule = load(&reopened, "session-1").unwrap();
        assert_eq!(capsule.goal, "ship safely");
        assert_eq!(capsule.incomplete_actions, vec!["call-1"]);
        assert_eq!(capsule.approval_status["approval-1"], "waiting");
        assert_eq!(capsule.memory_ids, vec!["memory-1"]);
        assert!(prompt(&capsule).contains("incompleteActions"));

        let completed = record_tool(&reopened, "session-1", "call-1", "unknownOutcome", 4).unwrap();
        assert!(completed.incomplete_actions.is_empty());
        assert!(completed
            .verification_results
            .contains(&"call-1:unknownOutcome".into()));
    }
}
