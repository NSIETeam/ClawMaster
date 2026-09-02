use parking_lot::RwLock;
use std::collections::HashMap;
use std::sync::Arc;

struct AgentState {
    memory_bytes: usize,
}

pub struct AgentPool {
    max_memory_bytes: usize,
    max_agents: usize,
    agents: Arc<RwLock<HashMap<String, AgentState>>>,
    current_memory: Arc<RwLock<usize>>,
}

impl AgentPool {
    pub fn new(max_memory_mb: u32, max_agents: u32) -> Self {
        Self {
            max_memory_bytes: max_memory_mb as usize * 1024 * 1024,
            max_agents: max_agents as usize,
            agents: Arc::new(RwLock::new(HashMap::new())),
            current_memory: Arc::new(RwLock::new(0)),
        }
    }

    pub fn register(&self, id: String, initial_memory_mb: u32) -> Result<bool, String> {
        let mut agents = self.agents.write();
        let mut current_memory = self.current_memory.write();
        let initial_memory = initial_memory_mb as usize * 1024 * 1024;

        if agents.len() >= self.max_agents {
            return Ok(false);
        }

        if *current_memory + initial_memory > self.max_memory_bytes {
            return Ok(false);
        }

        agents.insert(
            id,
            AgentState {
                memory_bytes: initial_memory,
            },
        );
        *current_memory += initial_memory;
        Ok(true)
    }

    pub fn update_memory(&self, id: &str, new_memory_mb: u32) -> Result<bool, String> {
        let mut agents = self.agents.write();
        let mut current_memory = self.current_memory.write();
        let new_memory = new_memory_mb as usize * 1024 * 1024;

        if let Some(agent) = agents.get_mut(id) {
            let old_memory = agent.memory_bytes;
            if *current_memory - old_memory + new_memory > self.max_memory_bytes {
                return Ok(false);
            }
            agent.memory_bytes = new_memory;
            *current_memory = *current_memory - old_memory + new_memory;
            Ok(true)
        } else {
            Ok(false)
        }
    }

    pub fn unregister(&self, id: &str) -> Result<bool, String> {
        let mut agents = self.agents.write();
        let mut current_memory = self.current_memory.write();
        if let Some(removed) = agents.remove(id) {
            *current_memory -= removed.memory_bytes;
            Ok(true)
        } else {
            Ok(false)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::AgentPool;

    #[test]
    fn rejects_new_agents_instead_of_evicting_an_active_agent() {
        let pool = AgentPool::new(64, 1);
        assert!(pool.register("active".into(), 10).unwrap());
        assert!(!pool.register("second".into(), 10).unwrap());
        assert!(pool.update_memory("active", 12).unwrap());
        assert!(pool.unregister("active").unwrap());
        assert!(pool.register("second".into(), 10).unwrap());
    }
}
