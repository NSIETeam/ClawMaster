use clawmaster_runtime_kernel::{
    KernelEvent, KernelStore, RuntimeKernel, ToolState, TurnRecord, TurnState,
};
use std::collections::{BTreeMap, BTreeSet};
use std::sync::{Arc, Mutex};

#[derive(Clone, Default)]
struct AdapterStore {
    turns: Arc<Mutex<BTreeMap<String, TurnRecord>>>,
    events: Arc<Mutex<Vec<KernelEvent>>>,
    completed: Arc<Mutex<BTreeSet<String>>>,
}

impl KernelStore for AdapterStore {
    fn load_turn(&self, turn_id: &str) -> Result<Option<TurnRecord>, String> {
        Ok(self.turns.lock().unwrap().get(turn_id).cloned())
    }

    fn list_turn_ids(&self) -> Result<BTreeSet<String>, String> {
        Ok(self.turns.lock().unwrap().keys().cloned().collect())
    }

    fn commit_turn_event(&self, turn: &TurnRecord, event: &KernelEvent) -> Result<(), String> {
        self.turns
            .lock()
            .unwrap()
            .insert(turn.turn_id.clone(), turn.clone());
        self.events.lock().unwrap().push(event.clone());
        Ok(())
    }

    fn append_event(&self, event: &KernelEvent) -> Result<(), String> {
        self.events.lock().unwrap().push(event.clone());
        Ok(())
    }

    fn completed_idempotency_keys(&self) -> Result<BTreeSet<String>, String> {
        Ok(self.completed.lock().unwrap().clone())
    }

    fn mark_idempotency_completed(&self, key: &str) -> Result<(), String> {
        self.completed.lock().unwrap().insert(key.into());
        Ok(())
    }
}

fn readonly_loop() -> Result<serde_json::Value, String> {
    let store = AdapterStore::default();
    let kernel = RuntimeKernel::new(store.clone());
    let mut turn = kernel
        .create_turn_for_session("cli-turn-1", Some("cli-session-1"), 1)
        .map_err(|error| error.to_string())?;
    kernel
        .transition_turn(&mut turn, TurnState::Planning, "model planning", 2)
        .map_err(|error| error.to_string())?;
    kernel
        .register_tool(
            &mut turn,
            "call-1",
            "read_file",
            br#"{"path":"README.md"}"#,
            "revision-1",
            "cli-turn-1:call-1",
            false,
            3,
        )
        .map_err(|error| error.to_string())?;
    kernel
        .transition_tool(&mut turn, "call-1", ToolState::Scheduled, "validated", 4)
        .map_err(|error| error.to_string())?;
    kernel
        .transition_tool(&mut turn, "call-1", ToolState::Executing, "executing", 5)
        .map_err(|error| error.to_string())?;
    kernel
        .transition_turn(&mut turn, TurnState::ExecutingTool, "executing", 6)
        .map_err(|error| error.to_string())?;
    kernel
        .transition_tool(&mut turn, "call-1", ToolState::Success, "observed", 7)
        .map_err(|error| error.to_string())?;
    kernel
        .transition_turn(&mut turn, TurnState::ObservingResult, "observed", 8)
        .map_err(|error| error.to_string())?;
    kernel
        .transition_turn(&mut turn, TurnState::WritingMemory, "writing memory", 9)
        .map_err(|error| error.to_string())?;
    kernel
        .transition_turn(&mut turn, TurnState::Checkpointing, "checkpointing", 10)
        .map_err(|error| error.to_string())?;
    kernel
        .transition_turn(&mut turn, TurnState::Completed, "completed", 11)
        .map_err(|error| error.to_string())?;
    let events = store.events.lock().unwrap().clone();
    Ok(serde_json::json!({"turn": turn, "events": events}))
}

fn main() {
    let scenario = std::env::args().nth(1).unwrap_or_default();
    let result = match scenario.as_str() {
        "readonly-loop" => readonly_loop(),
        _ => Err("unknown kernel adapter scenario".into()),
    };
    match result {
        Ok(value) => println!("{value}"),
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(2);
        }
    }
}
