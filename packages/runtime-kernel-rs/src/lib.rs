use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fmt;

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TurnState {
    Created,
    Planning,
    AwaitingPermission,
    ExecutingTool,
    ObservingResult,
    WritingMemory,
    Checkpointing,
    Completed,
    Failed,
    Cancelled,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ToolState {
    Validating,
    Scheduled,
    AwaitingApproval,
    Executing,
    Success,
    Error,
    Cancelled,
    UnknownOutcome,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ApprovalOutcome {
    Approved,
    Rejected,
    Cancelled,
    TimedOut,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PolicyRisk {
    ReadOnly,
    High,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PolicyDecision {
    Allow,
    RequireApproval,
    Deny,
}

pub struct CentralPolicy;

impl CentralPolicy {
    pub fn evaluate(known: bool, enabled: bool, risk: PolicyRisk) -> PolicyDecision {
        if !known || !enabled {
            PolicyDecision::Deny
        } else if risk == PolicyRisk::High {
            PolicyDecision::RequireApproval
        } else {
            PolicyDecision::Allow
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalBinding {
    pub request_id: String,
    pub argument_digest: String,
    pub revision: String,
    pub expires_at_ms: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ToolRecord {
    pub call_id: String,
    pub name: String,
    pub state: ToolState,
    pub argument_digest: String,
    pub revision: String,
    pub idempotency_key: String,
    pub external_side_effect: bool,
    #[serde(default)]
    pub side_effect_started: bool,
    pub approval: Option<ApprovalBinding>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct TurnRecord {
    pub turn_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    pub state: TurnState,
    pub sequence: u64,
    pub tools: BTreeMap<String, ToolRecord>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct KernelEvent {
    pub turn_id: String,
    pub call_id: Option<String>,
    pub sequence: u64,
    pub state: String,
    pub reason: String,
    pub timestamp_ms: u64,
}

pub trait KernelStore {
    fn load_turn(&self, turn_id: &str) -> Result<Option<TurnRecord>, String>;
    fn list_turn_ids(&self) -> Result<BTreeSet<String>, String>;
    fn commit_turn_event(&self, turn: &TurnRecord, event: &KernelEvent) -> Result<(), String>;
    fn append_event(&self, event: &KernelEvent) -> Result<(), String>;
    fn completed_idempotency_keys(&self) -> Result<BTreeSet<String>, String>;
    fn mark_idempotency_completed(&self, key: &str) -> Result<(), String>;
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum KernelError {
    InvalidTransition { from: String, to: String },
    Conflict(String),
    Denied(String),
    Storage(String),
}

impl fmt::Display for KernelError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidTransition { from, to } => {
                write!(formatter, "illegal runtime transition: {from} -> {to}")
            }
            Self::Conflict(message) | Self::Denied(message) | Self::Storage(message) => {
                formatter.write_str(message)
            }
        }
    }
}

impl std::error::Error for KernelError {}

pub struct RuntimeKernel<S> {
    store: S,
}

impl<S: KernelStore> RuntimeKernel<S> {
    pub fn new(store: S) -> Self {
        Self { store }
    }

    pub fn create_turn(&self, turn_id: &str, now_ms: u64) -> Result<TurnRecord, KernelError> {
        self.create_turn_for_session(turn_id, None, now_ms)
    }

    pub fn create_turn_for_session(
        &self,
        turn_id: &str,
        session_id: Option<&str>,
        now_ms: u64,
    ) -> Result<TurnRecord, KernelError> {
        validate_id(turn_id)?;
        if let Some(session_id) = session_id {
            validate_id(session_id)?;
        }
        if self
            .store
            .load_turn(turn_id)
            .map_err(KernelError::Storage)?
            .is_some()
        {
            return Err(KernelError::Conflict("turn already exists".into()));
        }
        let turn = TurnRecord {
            turn_id: turn_id.into(),
            session_id: session_id.map(str::to_owned),
            state: TurnState::Created,
            sequence: 1,
            tools: BTreeMap::new(),
        };
        self.commit(&turn, None, "created", now_ms)?;
        Ok(turn)
    }

    pub fn transition_turn(
        &self,
        turn: &mut TurnRecord,
        next: TurnState,
        reason: &str,
        now_ms: u64,
    ) -> Result<(), KernelError> {
        if !valid_turn_transition(turn.state, next) {
            self.audit_rejection(
                turn,
                None,
                &format!("illegal {:?} -> {:?}", turn.state, next),
                now_ms,
            )?;
            return Err(KernelError::InvalidTransition {
                from: format!("{:?}", turn.state),
                to: format!("{:?}", next),
            });
        }
        turn.state = next;
        turn.sequence += 1;
        self.commit(turn, None, reason, now_ms)
    }

    pub fn register_tool(
        &self,
        turn: &mut TurnRecord,
        call_id: &str,
        name: &str,
        arguments: &[u8],
        revision: &str,
        idempotency_key: &str,
        external_side_effect: bool,
        now_ms: u64,
    ) -> Result<(), KernelError> {
        validate_id(call_id)?;
        validate_id(idempotency_key)?;
        if turn.state != TurnState::Planning {
            self.audit_rejection(
                turn,
                Some(call_id),
                &format!("tool registration rejected while turn is {:?}", turn.state),
                now_ms,
            )?;
            return Err(KernelError::Denied(
                "tools may only be registered while a turn is planning".into(),
            ));
        }
        if turn.tools.contains_key(call_id) {
            return Err(KernelError::Conflict("tool call already exists".into()));
        }
        turn.tools.insert(
            call_id.into(),
            ToolRecord {
                call_id: call_id.into(),
                name: bounded(name, 128)?,
                state: ToolState::Validating,
                argument_digest: digest(arguments),
                revision: bounded(revision, 160)?,
                idempotency_key: idempotency_key.into(),
                external_side_effect,
                side_effect_started: false,
                approval: None,
            },
        );
        turn.sequence += 1;
        self.commit(turn, Some(call_id), "tool validating", now_ms)
    }

    pub fn transition_tool(
        &self,
        turn: &mut TurnRecord,
        call_id: &str,
        next: ToolState,
        reason: &str,
        now_ms: u64,
    ) -> Result<(), KernelError> {
        let current = turn
            .tools
            .get(call_id)
            .ok_or_else(|| KernelError::Conflict("unknown tool call".into()))?
            .state;
        if !valid_tool_transition(current, next) {
            self.audit_rejection(
                turn,
                Some(call_id),
                &format!("illegal {:?} -> {:?}", current, next),
                now_ms,
            )?;
            return Err(KernelError::InvalidTransition {
                from: format!("{:?}", current),
                to: format!("{:?}", next),
            });
        }
        turn.tools.get_mut(call_id).expect("checked").state = next;
        turn.sequence += 1;
        self.commit(turn, Some(call_id), reason, now_ms)
    }

    pub fn request_approval(
        &self,
        turn: &mut TurnRecord,
        call_id: &str,
        request_id: &str,
        expires_at_ms: u64,
        now_ms: u64,
    ) -> Result<ApprovalBinding, KernelError> {
        validate_id(request_id)?;
        let current = turn
            .tools
            .get(call_id)
            .ok_or_else(|| KernelError::Conflict("unknown tool call".into()))?
            .state;
        if current != ToolState::Scheduled {
            self.audit_rejection(
                turn,
                Some(call_id),
                &format!("illegal {:?} -> {:?}", current, ToolState::AwaitingApproval),
                now_ms,
            )?;
            return Err(KernelError::InvalidTransition {
                from: format!("{:?}", current),
                to: format!("{:?}", ToolState::AwaitingApproval),
            });
        }
        let tool = turn.tools.get_mut(call_id).expect("checked");
        let binding = ApprovalBinding {
            request_id: request_id.into(),
            argument_digest: tool.argument_digest.clone(),
            revision: tool.revision.clone(),
            expires_at_ms,
        };
        tool.approval = Some(binding.clone());
        tool.state = ToolState::AwaitingApproval;
        turn.sequence += 1;
        self.commit(turn, Some(call_id), "approval requested and bound", now_ms)?;
        Ok(binding)
    }

    pub fn resolve_approval(
        &self,
        turn: &mut TurnRecord,
        call_id: &str,
        request_id: &str,
        arguments: &[u8],
        revision: &str,
        outcome: ApprovalOutcome,
        now_ms: u64,
    ) -> Result<bool, KernelError> {
        let tool = turn
            .tools
            .get(call_id)
            .ok_or_else(|| KernelError::Conflict("unknown tool call".into()))?;
        let binding = tool
            .approval
            .as_ref()
            .ok_or_else(|| KernelError::Denied("tool has no approval binding".into()))?;
        if binding.request_id != request_id
            || binding.argument_digest != digest(arguments)
            || binding.revision != revision
        {
            self.audit_rejection(turn, Some(call_id), "approval binding changed", now_ms)?;
            return Err(KernelError::Denied(
                "approval no longer matches request, arguments, or revision".into(),
            ));
        }
        if now_ms >= binding.expires_at_ms {
            self.transition_tool(
                turn,
                call_id,
                ToolState::Cancelled,
                "approval timed out",
                now_ms,
            )?;
            return Ok(false);
        }
        match outcome {
            ApprovalOutcome::Approved => {
                self.transition_tool(
                    turn,
                    call_id,
                    ToolState::Executing,
                    "approval accepted",
                    now_ms,
                )?;
                Ok(true)
            }
            ApprovalOutcome::Rejected => {
                self.transition_tool(
                    turn,
                    call_id,
                    ToolState::Cancelled,
                    "approval rejected",
                    now_ms,
                )?;
                Ok(false)
            }
            ApprovalOutcome::Cancelled => {
                self.transition_tool(
                    turn,
                    call_id,
                    ToolState::Cancelled,
                    "user cancelled",
                    now_ms,
                )?;
                Ok(false)
            }
            ApprovalOutcome::TimedOut => {
                self.transition_tool(
                    turn,
                    call_id,
                    ToolState::Cancelled,
                    "approval timed out",
                    now_ms,
                )?;
                Ok(false)
            }
        }
    }

    pub fn begin_external_side_effect(
        &self,
        turn: &mut TurnRecord,
        call_id: &str,
        now_ms: u64,
    ) -> Result<bool, KernelError> {
        let tool = turn
            .tools
            .get(call_id)
            .ok_or_else(|| KernelError::Conflict("unknown tool call".into()))?;
        if !tool.external_side_effect || tool.state != ToolState::Executing {
            return Err(KernelError::Denied(
                "external side effect is not approved and executing".into(),
            ));
        }
        if self
            .store
            .completed_idempotency_keys()
            .map_err(KernelError::Storage)?
            .contains(&tool.idempotency_key)
        {
            self.transition_tool(
                turn,
                call_id,
                ToolState::Success,
                "idempotent replay suppressed",
                now_ms,
            )?;
            return Ok(false);
        }
        turn.tools
            .get_mut(call_id)
            .expect("checked")
            .side_effect_started = true;
        turn.sequence += 1;
        self.commit(turn, Some(call_id), "external side effect started", now_ms)?;
        Ok(true)
    }

    pub fn cancel_open_tools(
        &self,
        turn: &mut TurnRecord,
        reason: &str,
        now_ms: u64,
    ) -> Result<(), KernelError> {
        let open = turn
            .tools
            .iter()
            .filter_map(|(call_id, tool)| {
                matches!(
                    tool.state,
                    ToolState::Validating
                        | ToolState::Scheduled
                        | ToolState::AwaitingApproval
                        | ToolState::Executing
                )
                .then_some((
                    call_id.clone(),
                    tool.external_side_effect && tool.side_effect_started,
                ))
            })
            .collect::<Vec<_>>();
        for (call_id, uncertain) in open {
            self.transition_tool(
                turn,
                &call_id,
                if uncertain {
                    ToolState::UnknownOutcome
                } else {
                    ToolState::Cancelled
                },
                if uncertain {
                    "external result uncertain after cancellation"
                } else {
                    reason
                },
                now_ms,
            )?;
        }
        Ok(())
    }

    pub fn complete_external_side_effect(
        &self,
        turn: &mut TurnRecord,
        call_id: &str,
        now_ms: u64,
    ) -> Result<(), KernelError> {
        let key = turn
            .tools
            .get(call_id)
            .ok_or_else(|| KernelError::Conflict("unknown tool call".into()))?
            .idempotency_key
            .clone();
        self.store
            .mark_idempotency_completed(&key)
            .map_err(KernelError::Storage)?;
        self.transition_tool(
            turn,
            call_id,
            ToolState::Success,
            "external side effect completed",
            now_ms,
        )
    }

    pub fn recover(&self, turn_id: &str, now_ms: u64) -> Result<Option<TurnRecord>, KernelError> {
        let Some(mut turn) = self
            .store
            .load_turn(turn_id)
            .map_err(KernelError::Storage)?
        else {
            return Ok(None);
        };
        let completed = self
            .store
            .completed_idempotency_keys()
            .map_err(KernelError::Storage)?;
        let interrupted = turn
            .tools
            .iter()
            .filter_map(|(id, tool)| {
                (tool.external_side_effect && tool.state == ToolState::Executing).then_some((
                    id.clone(),
                    tool.side_effect_started,
                    completed.contains(&tool.idempotency_key),
                ))
            })
            .collect::<Vec<_>>();
        let had_interrupted_tools = !interrupted.is_empty();
        for (call_id, side_effect_started, was_completed) in interrupted {
            self.transition_tool(
                &mut turn,
                &call_id,
                if was_completed {
                    ToolState::Success
                } else if side_effect_started {
                    ToolState::UnknownOutcome
                } else {
                    ToolState::Error
                },
                if was_completed {
                    "completed idempotency record recovered"
                } else if side_effect_started {
                    "interrupted external side effect requires reconciliation"
                } else {
                    "interrupted before external side effect started"
                },
                now_ms,
            )?;
        }
        if had_interrupted_tools && !is_terminal_turn(turn.state) {
            self.transition_turn(
                &mut turn,
                TurnState::Failed,
                "interrupted tool execution recovered; explicit user reconciliation required",
                now_ms,
            )?;
        }
        Ok(Some(turn))
    }

    pub fn recover_all(&self, now_ms: u64) -> Result<Vec<TurnRecord>, KernelError> {
        let turn_ids = self.store.list_turn_ids().map_err(KernelError::Storage)?;
        let mut recovered = Vec::new();
        for turn_id in turn_ids {
            if let Some(turn) = self.recover(&turn_id, now_ms)? {
                recovered.push(turn);
            }
        }
        Ok(recovered)
    }

    fn commit(
        &self,
        turn: &TurnRecord,
        call_id: Option<&str>,
        reason: &str,
        now_ms: u64,
    ) -> Result<(), KernelError> {
        self.store
            .commit_turn_event(
                turn,
                &KernelEvent {
                    turn_id: turn.turn_id.clone(),
                    call_id: call_id.map(str::to_owned),
                    sequence: turn.sequence,
                    state: call_id
                        .and_then(|id| turn.tools.get(id))
                        .map_or_else(|| state_name(turn.state), |tool| state_name(tool.state)),
                    reason: reason.chars().take(512).collect(),
                    timestamp_ms: now_ms,
                },
            )
            .map_err(KernelError::Storage)
    }

    fn audit_rejection(
        &self,
        turn: &TurnRecord,
        call_id: Option<&str>,
        reason: &str,
        now_ms: u64,
    ) -> Result<(), KernelError> {
        self.store
            .append_event(&KernelEvent {
                turn_id: turn.turn_id.clone(),
                call_id: call_id.map(str::to_owned),
                sequence: turn.sequence,
                state: "rejected_transition".into(),
                reason: reason.chars().take(512).collect(),
                timestamp_ms: now_ms,
            })
            .map_err(KernelError::Storage)
    }
}

fn valid_turn_transition(from: TurnState, to: TurnState) -> bool {
    use TurnState::*;
    matches!(
        (from, to),
        (Created, Planning)
            | (
                Planning,
                AwaitingPermission
                    | ExecutingTool
                    | ObservingResult
                    | WritingMemory
                    | Checkpointing
                    | Completed
                    | Failed
                    | Cancelled
            )
            | (
                AwaitingPermission,
                ExecutingTool | ObservingResult | Cancelled | Failed
            )
            | (ExecutingTool, ObservingResult | Failed | Cancelled)
            | (
                ObservingResult,
                Planning | WritingMemory | Checkpointing | Completed | Failed | Cancelled
            )
            | (
                WritingMemory,
                Checkpointing | Completed | Failed | Cancelled
            )
            | (Checkpointing, Completed | Failed | Cancelled)
    )
}

fn valid_tool_transition(from: ToolState, to: ToolState) -> bool {
    use ToolState::*;
    matches!(
        (from, to),
        (Validating, Scheduled | Error | Cancelled)
            | (Scheduled, AwaitingApproval | Executing | Error | Cancelled)
            | (AwaitingApproval, Executing | Cancelled | Error)
            | (Executing, Success | Error | Cancelled | UnknownOutcome)
    )
}

fn is_terminal_turn(state: TurnState) -> bool {
    matches!(
        state,
        TurnState::Completed | TurnState::Failed | TurnState::Cancelled
    )
}

fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn state_name<T: Serialize>(state: T) -> String {
    serde_json::to_value(state)
        .ok()
        .and_then(|value| value.as_str().map(str::to_owned))
        .unwrap_or_else(|| "invalid_state".into())
}

fn validate_id(value: &str) -> Result<(), KernelError> {
    if value.is_empty()
        || value.len() > 160
        || !value.chars().all(|character| {
            character.is_ascii_alphanumeric() || matches!(character, '-' | '_' | ':')
        })
    {
        return Err(KernelError::Denied("invalid runtime identifier".into()));
    }
    Ok(())
}

fn bounded(value: &str, max: usize) -> Result<String, KernelError> {
    if value.is_empty() || value.len() > max {
        return Err(KernelError::Denied("runtime value exceeds bounds".into()));
    }
    Ok(value.into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    #[derive(Clone, Default)]
    struct MemoryStore {
        turns: Arc<Mutex<BTreeMap<String, TurnRecord>>>,
        events: Arc<Mutex<Vec<KernelEvent>>>,
        completed: Arc<Mutex<BTreeSet<String>>>,
    }

    impl KernelStore for MemoryStore {
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

    fn scheduled_tool(kernel: &RuntimeKernel<MemoryStore>, turn: &mut TurnRecord, external: bool) {
        if turn.state == TurnState::Created {
            kernel
                .transition_turn(turn, TurnState::Planning, "planning", 2)
                .unwrap();
        }
        kernel
            .register_tool(
                turn,
                "call-1",
                "write_file",
                b"{\"path\":\"a\"}",
                "rev-1",
                "idem-1",
                external,
                3,
            )
            .unwrap();
        kernel
            .transition_tool(turn, "call-1", ToolState::Scheduled, "validated", 4)
            .unwrap();
    }

    #[test]
    fn rejects_and_audits_every_illegal_terminal_edge() {
        let store = MemoryStore::default();
        let kernel = RuntimeKernel::new(store.clone());
        let mut turn = kernel.create_turn("turn-1", 1).unwrap();
        let error = kernel
            .transition_turn(&mut turn, TurnState::Completed, "skip planning", 2)
            .unwrap_err();
        assert!(matches!(error, KernelError::InvalidTransition { .. }));
        assert_eq!(
            store.events.lock().unwrap().last().unwrap().state,
            "rejected_transition"
        );
    }

    #[test]
    fn approval_binds_request_arguments_revision_and_all_outcomes() {
        for (outcome, expected) in [
            (ApprovalOutcome::Approved, ToolState::Executing),
            (ApprovalOutcome::Rejected, ToolState::Cancelled),
            (ApprovalOutcome::Cancelled, ToolState::Cancelled),
            (ApprovalOutcome::TimedOut, ToolState::Cancelled),
        ] {
            let kernel = RuntimeKernel::new(MemoryStore::default());
            let mut turn = kernel.create_turn("turn-1", 1).unwrap();
            scheduled_tool(&kernel, &mut turn, true);
            kernel
                .request_approval(&mut turn, "call-1", "approval-1", 100, 4)
                .unwrap();
            kernel
                .resolve_approval(
                    &mut turn,
                    "call-1",
                    "approval-1",
                    b"{\"path\":\"a\"}",
                    "rev-1",
                    outcome,
                    5,
                )
                .unwrap();
            assert_eq!(turn.tools["call-1"].state, expected);
        }
    }

    #[test]
    fn timeout_and_parameter_tampering_never_execute() {
        let kernel = RuntimeKernel::new(MemoryStore::default());
        let mut turn = kernel.create_turn("turn-1", 1).unwrap();
        scheduled_tool(&kernel, &mut turn, true);
        kernel
            .request_approval(&mut turn, "call-1", "approval-1", 10, 4)
            .unwrap();
        assert!(kernel
            .resolve_approval(
                &mut turn,
                "call-1",
                "approval-1",
                b"changed",
                "rev-1",
                ApprovalOutcome::Approved,
                5
            )
            .is_err());
        assert!(!kernel
            .resolve_approval(
                &mut turn,
                "call-1",
                "approval-1",
                b"{\"path\":\"a\"}",
                "rev-1",
                ApprovalOutcome::Approved,
                11,
            )
            .unwrap());
        assert_eq!(turn.tools["call-1"].state, ToolState::Cancelled);
    }

    #[test]
    fn invalid_approval_edge_is_audited() {
        let store = MemoryStore::default();
        let kernel = RuntimeKernel::new(store.clone());
        let mut turn = kernel.create_turn("turn-1", 1).unwrap();
        kernel
            .transition_turn(&mut turn, TurnState::Planning, "planning", 2)
            .unwrap();
        kernel
            .register_tool(
                &mut turn,
                "call-1",
                "write_file",
                b"{}",
                "rev-1",
                "idem-1",
                true,
                3,
            )
            .unwrap();
        assert!(matches!(
            kernel.request_approval(&mut turn, "call-1", "approval-1", 10, 4),
            Err(KernelError::InvalidTransition { .. })
        ));
        assert_eq!(
            store.events.lock().unwrap().last().unwrap().state,
            "rejected_transition"
        );
    }

    #[test]
    fn interrupted_external_action_recovers_unknown_without_replay() {
        let store = MemoryStore::default();
        let kernel = RuntimeKernel::new(store.clone());
        let mut turn = kernel.create_turn("turn-1", 1).unwrap();
        scheduled_tool(&kernel, &mut turn, true);
        kernel
            .request_approval(&mut turn, "call-1", "approval-1", 100, 4)
            .unwrap();
        kernel
            .resolve_approval(
                &mut turn,
                "call-1",
                "approval-1",
                b"{\"path\":\"a\"}",
                "rev-1",
                ApprovalOutcome::Approved,
                5,
            )
            .unwrap();
        assert!(kernel
            .begin_external_side_effect(&mut turn, "call-1", 6)
            .unwrap());

        let restarted = RuntimeKernel::new(store);
        let recovered = restarted.recover("turn-1", 7).unwrap().unwrap();
        assert_eq!(recovered.tools["call-1"].state, ToolState::UnknownOutcome);
        assert_eq!(recovered.state, TurnState::Failed);
        assert!(restarted
            .begin_external_side_effect(&mut recovered.clone(), "call-1", 8)
            .is_err());
    }

    #[test]
    fn completed_idempotency_key_suppresses_duplicate_side_effect() {
        let store = MemoryStore::default();
        store.completed.lock().unwrap().insert("idem-1".into());
        let kernel = RuntimeKernel::new(store);
        let mut turn = kernel.create_turn("turn-1", 1).unwrap();
        scheduled_tool(&kernel, &mut turn, true);
        kernel
            .request_approval(&mut turn, "call-1", "approval-1", 100, 4)
            .unwrap();
        kernel
            .resolve_approval(
                &mut turn,
                "call-1",
                "approval-1",
                b"{\"path\":\"a\"}",
                "rev-1",
                ApprovalOutcome::Approved,
                5,
            )
            .unwrap();
        assert!(!kernel
            .begin_external_side_effect(&mut turn, "call-1", 6)
            .unwrap());
        assert_eq!(turn.tools["call-1"].state, ToolState::Success);
    }

    #[test]
    fn interrupted_before_external_side_effect_is_failed_not_unknown() {
        let store = MemoryStore::default();
        let kernel = RuntimeKernel::new(store.clone());
        let mut turn = kernel.create_turn("turn-1", 1).unwrap();
        scheduled_tool(&kernel, &mut turn, true);
        kernel
            .request_approval(&mut turn, "call-1", "approval-1", 100, 4)
            .unwrap();
        kernel
            .resolve_approval(
                &mut turn,
                "call-1",
                "approval-1",
                b"{\"path\":\"a\"}",
                "rev-1",
                ApprovalOutcome::Approved,
                5,
            )
            .unwrap();

        let recovered = RuntimeKernel::new(store)
            .recover("turn-1", 6)
            .unwrap()
            .unwrap();
        assert_eq!(recovered.tools["call-1"].state, ToolState::Error);
    }

    #[test]
    fn completed_external_side_effect_recovers_success_after_state_write_crash() {
        let store = MemoryStore::default();
        let kernel = RuntimeKernel::new(store.clone());
        let mut turn = kernel.create_turn("turn-1", 1).unwrap();
        scheduled_tool(&kernel, &mut turn, true);
        kernel
            .request_approval(&mut turn, "call-1", "approval-1", 100, 4)
            .unwrap();
        kernel
            .resolve_approval(
                &mut turn,
                "call-1",
                "approval-1",
                b"{\"path\":\"a\"}",
                "rev-1",
                ApprovalOutcome::Approved,
                5,
            )
            .unwrap();
        kernel
            .begin_external_side_effect(&mut turn, "call-1", 6)
            .unwrap();
        store.completed.lock().unwrap().insert("idem-1".into());

        let recovered = RuntimeKernel::new(store)
            .recover("turn-1", 7)
            .unwrap()
            .unwrap();
        assert_eq!(recovered.tools["call-1"].state, ToolState::Success);
        assert_eq!(recovered.state, TurnState::Failed);
    }

    #[test]
    fn recover_all_discovers_persisted_turns() {
        let store = MemoryStore::default();
        let kernel = RuntimeKernel::new(store.clone());
        kernel.create_turn("turn-1", 1).unwrap();
        kernel.create_turn("turn-2", 2).unwrap();
        let recovered = RuntimeKernel::new(store).recover_all(3).unwrap();
        assert_eq!(
            recovered
                .into_iter()
                .map(|turn| turn.turn_id)
                .collect::<BTreeSet<_>>(),
            BTreeSet::from(["turn-1".to_string(), "turn-2".to_string()])
        );
    }

    #[test]
    fn central_policy_defaults_unknown_and_disabled_capabilities_to_deny() {
        assert_eq!(
            CentralPolicy::evaluate(false, true, PolicyRisk::ReadOnly),
            PolicyDecision::Deny
        );
        assert_eq!(
            CentralPolicy::evaluate(true, false, PolicyRisk::ReadOnly),
            PolicyDecision::Deny
        );
        assert_eq!(
            CentralPolicy::evaluate(true, true, PolicyRisk::High),
            PolicyDecision::RequireApproval
        );
        assert_eq!(
            CentralPolicy::evaluate(true, true, PolicyRisk::ReadOnly),
            PolicyDecision::Allow
        );
    }

    #[test]
    fn every_turn_and_tool_edge_matches_the_declared_transition_matrix() {
        let turn_states = [
            TurnState::Created,
            TurnState::Planning,
            TurnState::AwaitingPermission,
            TurnState::ExecutingTool,
            TurnState::ObservingResult,
            TurnState::WritingMemory,
            TurnState::Checkpointing,
            TurnState::Completed,
            TurnState::Failed,
            TurnState::Cancelled,
        ];
        for from in turn_states {
            for to in turn_states {
                let store = MemoryStore::default();
                let kernel = RuntimeKernel::new(store.clone());
                let mut turn = TurnRecord {
                    turn_id: "turn-matrix".into(),
                    session_id: None,
                    state: from,
                    sequence: 1,
                    tools: BTreeMap::new(),
                };
                let result = kernel.transition_turn(&mut turn, to, "matrix", 1);
                assert_eq!(
                    result.is_ok(),
                    valid_turn_transition(from, to),
                    "turn edge {from:?} -> {to:?}"
                );
                if result.is_err() {
                    assert_eq!(
                        store.events.lock().unwrap().last().unwrap().state,
                        "rejected_transition"
                    );
                }
            }
        }

        let tool_states = [
            ToolState::Validating,
            ToolState::Scheduled,
            ToolState::AwaitingApproval,
            ToolState::Executing,
            ToolState::Success,
            ToolState::Error,
            ToolState::Cancelled,
            ToolState::UnknownOutcome,
        ];
        for from in tool_states {
            for to in tool_states {
                let store = MemoryStore::default();
                let kernel = RuntimeKernel::new(store.clone());
                let mut turn = TurnRecord {
                    turn_id: "turn-matrix".into(),
                    session_id: None,
                    state: TurnState::Planning,
                    sequence: 1,
                    tools: BTreeMap::from([(
                        "call-1".into(),
                        ToolRecord {
                            call_id: "call-1".into(),
                            name: "test".into(),
                            state: from,
                            argument_digest: digest(b"{}"),
                            revision: "rev-1".into(),
                            idempotency_key: "idem-1".into(),
                            external_side_effect: false,
                            side_effect_started: false,
                            approval: None,
                        },
                    )]),
                };
                let result = kernel.transition_tool(&mut turn, "call-1", to, "matrix", 1);
                assert_eq!(
                    result.is_ok(),
                    valid_tool_transition(from, to),
                    "tool edge {from:?} -> {to:?}"
                );
                if result.is_err() {
                    assert_eq!(
                        store.events.lock().unwrap().last().unwrap().state,
                        "rejected_transition"
                    );
                }
            }
        }
    }

    #[test]
    fn cancellation_settles_queued_and_running_tools_without_replaying_side_effects() {
        let kernel = RuntimeKernel::new(MemoryStore::default());
        let mut turn = kernel.create_turn("turn-1", 1).unwrap();
        kernel
            .transition_turn(&mut turn, TurnState::Planning, "planning", 2)
            .unwrap();
        for (id, external) in [("queued", false), ("external", true)] {
            kernel
                .register_tool(&mut turn, id, "test_tool", b"{}", "rev-1", id, external, 3)
                .unwrap();
            kernel
                .transition_tool(&mut turn, id, ToolState::Scheduled, "validated", 4)
                .unwrap();
        }
        kernel
            .transition_tool(&mut turn, "external", ToolState::Executing, "running", 5)
            .unwrap();
        kernel
            .begin_external_side_effect(&mut turn, "external", 6)
            .unwrap();

        kernel
            .cancel_open_tools(&mut turn, "turn cancelled", 7)
            .unwrap();
        assert_eq!(turn.tools["queued"].state, ToolState::Cancelled);
        assert_eq!(turn.tools["external"].state, ToolState::UnknownOutcome);
    }
}
