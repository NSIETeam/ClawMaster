use std::collections::HashMap;
use std::sync::Mutex;
use tauri::State;

pub const MAX_AGENT_STATE_BYTES: usize = 1024 * 1024;

#[derive(Default)]
pub struct AgentStatePool {
    states: Mutex<HashMap<String, Vec<u8>>>,
}

impl AgentStatePool {
    fn replace(&self, agent_id: String, state: Vec<u8>) -> Result<usize, String> {
        if agent_id.trim().is_empty() {
            return Err("agent id is required".to_string());
        }
        if state.len() > MAX_AGENT_STATE_BYTES {
            return Err(format!(
                "agent state exceeds {} bytes",
                MAX_AGENT_STATE_BYTES
            ));
        }
        let mut states = self
            .states
            .lock()
            .map_err(|_| "agent state pool lock is poisoned".to_string())?;
        states.insert(agent_id, state);
        Ok(states.values().map(Vec::len).max().unwrap_or(0))
    }

    fn bytes(&self, agent_id: &str) -> Result<usize, String> {
        let states = self
            .states
            .lock()
            .map_err(|_| "agent state pool lock is poisoned".to_string())?;
        Ok(states.get(agent_id).map_or(0, Vec::len))
    }

    fn remove(&self, agent_id: &str) -> Result<bool, String> {
        let mut states = self
            .states
            .lock()
            .map_err(|_| "agent state pool lock is poisoned".to_string())?;
        Ok(states.remove(agent_id).is_some())
    }
}

#[tauri::command]
pub fn agent_state_replace(
    agent_id: String,
    state: Vec<u8>,
    pool: State<'_, AgentStatePool>,
) -> Result<usize, String> {
    pool.replace(agent_id, state)
}

#[tauri::command]
pub fn agent_state_bytes(
    agent_id: String,
    pool: State<'_, AgentStatePool>,
) -> Result<usize, String> {
    pool.bytes(&agent_id)
}

#[tauri::command]
pub fn agent_state_remove(
    agent_id: String,
    pool: State<'_, AgentStatePool>,
) -> Result<bool, String> {
    pool.remove(&agent_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_state_above_one_mib() {
        let pool = AgentStatePool::default();
        let error = pool
            .replace("agent-1".to_string(), vec![0; MAX_AGENT_STATE_BYTES + 1])
            .unwrap_err();
        assert!(error.contains("exceeds"));
    }

    #[test]
    fn replaces_reads_and_removes_state() {
        let pool = AgentStatePool::default();
        assert_eq!(pool.replace("agent-1".to_string(), vec![1; 64]).unwrap(), 64);
        assert_eq!(pool.bytes("agent-1").unwrap(), 64);
        assert!(pool.remove("agent-1").unwrap());
        assert_eq!(pool.bytes("agent-1").unwrap(), 0);
    }
}
