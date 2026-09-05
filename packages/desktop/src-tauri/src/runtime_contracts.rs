use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};

mod generated {
    include!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../runtime-contracts/generated/runtime_contract_v2.rs"
    ));
}

pub use generated::*;

static V1_ADAPTER_USES: AtomicU64 = AtomicU64::new(0);

impl RuntimeContractStatus {
    pub fn current() -> Self {
        Self {
            protocol: ProtocolVersion {
                major: 2,
                minor: 0,
                patch: 0,
            },
            schema_version: RUNTIME_SCHEMA_VERSION.to_string(),
            v1_adapter_uses: V1_ADAPTER_USES.load(Ordering::Relaxed),
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeContractViolation {
    pub code: ErrorCode,
    pub message: String,
    pub retryable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub details: Option<Value>,
}

impl RuntimeContractViolation {
    fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
            retryable: false,
            details: None,
        }
    }

    fn with_details(mut self, details: Value) -> Self {
        self.details = Some(details);
        self
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum DecodedRuntimeEvent {
    Event(RuntimeEventEnvelope),
    Ignored { event_id: String, sequence: u64 },
}

fn as_object<'a>(
    value: &'a Value,
    label: &str,
) -> Result<&'a serde_json::Map<String, Value>, RuntimeContractViolation> {
    value.as_object().ok_or_else(|| {
        RuntimeContractViolation::new(
            ErrorCode::RuntimeInvalidEnvelope,
            format!("{label} must be an object"),
        )
    })
}

fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value.chars().enumerate().all(|(index, character)| {
            character.is_ascii_alphanumeric()
                || (index > 0 && matches!(character, '.' | '_' | ':' | '-'))
        })
}

fn required_id(
    object: &serde_json::Map<String, Value>,
    field: &str,
) -> Result<String, RuntimeContractViolation> {
    let value = object.get(field).and_then(Value::as_str).unwrap_or_default();
    if !valid_id(value) {
        return Err(RuntimeContractViolation::new(
            ErrorCode::RuntimeInvalidEnvelope,
            format!("{field} must be a non-empty protocol id"),
        ));
    }
    Ok(value.to_string())
}

fn validate_meta(
    object: &serde_json::Map<String, Value>,
    kind: &str,
) -> Result<(), RuntimeContractViolation> {
    if object.get("kind").and_then(Value::as_str) != Some(kind) {
        return Err(RuntimeContractViolation::new(
            ErrorCode::RuntimeInvalidEnvelope,
            format!("kind must be {kind}"),
        ));
    }
    for field in [
        "requestId",
        "sessionId",
        "turnId",
        "stepId",
        "traceId",
        "eventId",
    ] {
        required_id(object, field)?;
    }
    if object.get("sequence").and_then(Value::as_u64).unwrap_or_default() == 0 {
        return Err(RuntimeContractViolation::new(
            ErrorCode::RuntimeInvalidSequence,
            "sequence must be a positive integer",
        ));
    }
    let timestamp = object
        .get("timestamp")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if !timestamp.contains('T') || !(timestamp.ends_with('Z') || timestamp.contains('+')) {
        return Err(RuntimeContractViolation::new(
            ErrorCode::RuntimeInvalidEnvelope,
            "timestamp must be an ISO-8601 date-time",
        ));
    }
    let schema_version = object
        .get("schemaVersion")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let major = schema_version
        .split('.')
        .next()
        .and_then(|value| value.parse::<u64>().ok());
    if major != Some(2) {
        return Err(RuntimeContractViolation::new(
            ErrorCode::RuntimeUnsupportedProtocolMajor,
            "runtime protocol major is incompatible with 2",
        ));
    }
    if schema_version != RUNTIME_SCHEMA_VERSION {
        return Err(RuntimeContractViolation::new(
            ErrorCode::RuntimeInvalidEnvelope,
            format!("schemaVersion {schema_version} was not negotiated for this connection"),
        ));
    }
    let actor = object.get("actor").and_then(Value::as_str).unwrap_or_default();
    if !["user", "assistant", "system", "tool", "runtime"].contains(&actor) {
        return Err(RuntimeContractViolation::new(
            ErrorCode::RuntimeInvalidEnum,
            "actor is not a supported protocol value",
        ));
    }
    Ok(())
}

fn validate_payload_enums(
    payload: &serde_json::Map<String, Value>,
) -> Result<(), RuntimeContractViolation> {
    let payload_type = payload.get("type").and_then(Value::as_str).unwrap_or_default();
    if matches!(payload_type, "toolStatus" | "toolResult") {
        let status = payload.get("status").and_then(Value::as_str).unwrap_or_default();
        if ![
            "proposed",
            "waitingApproval",
            "running",
            "succeeded",
            "failed",
            "cancelled",
            "unknownOutcome",
        ]
        .contains(&status)
        {
            return Err(RuntimeContractViolation::new(
                ErrorCode::RuntimeInvalidEnum,
                "tool status is not supported",
            ));
        }
    }
    if matches!(payload_type, "approval" | "approvalResolved") {
        let decision = payload
            .get("decision")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if !["allow", "deny", "cancel", "timeout"].contains(&decision) {
            return Err(RuntimeContractViolation::new(
                ErrorCode::RuntimeInvalidEnum,
                "approval decision is not supported",
            ));
        }
    }
    if payload_type == "finished" {
        let reason = payload.get("reason").and_then(Value::as_str).unwrap_or_default();
        if !["complete", "cancelled", "error"].contains(&reason) {
            return Err(RuntimeContractViolation::new(
                ErrorCode::RuntimeInvalidEnum,
                "finish reason is not supported",
            ));
        }
    }
    Ok(())
}

pub fn decode_runtime_event(input: &str) -> Result<DecodedRuntimeEvent, RuntimeContractViolation> {
    let value: Value = serde_json::from_str(input).map_err(|_| {
        RuntimeContractViolation::new(
            ErrorCode::RuntimeInvalidEnvelope,
            "runtime event envelope must be valid JSON",
        )
    })?;
    let object = as_object(&value, "runtime event envelope")?;
    validate_meta(object, "event")?;
    let ignorable = object.get("ignorable").and_then(Value::as_bool).ok_or_else(|| {
        RuntimeContractViolation::new(
            ErrorCode::RuntimeInvalidEnvelope,
            "ignorable must be boolean",
        )
    })?;
    let payload = as_object(
        object.get("payload").unwrap_or(&Value::Null),
        "runtime event payload",
    )?;
    let event_type = payload.get("type").and_then(Value::as_str).unwrap_or_default();
    if !RUNTIME_EVENT_TYPES.contains(&event_type) {
        if ignorable && !event_type.is_empty() {
            return Ok(DecodedRuntimeEvent::Ignored {
                event_id: required_id(object, "eventId")?,
                sequence: object.get("sequence").and_then(Value::as_u64).unwrap_or_default(),
            });
        }
        return Err(RuntimeContractViolation::new(
            ErrorCode::RuntimeUnknownRequiredEvent,
            "runtime sent an unknown mandatory event",
        )
        .with_details(json!({ "eventType": if event_type.is_empty() { "<missing>" } else { event_type } })));
    }
    validate_payload_enums(payload)?;
    let envelope = serde_json::from_value(value).map_err(|error| {
        RuntimeContractViolation::new(
            ErrorCode::RuntimeInvalidEnvelope,
            format!("runtime event does not match schema: {error}"),
        )
    })?;
    Ok(DecodedRuntimeEvent::Event(envelope))
}

pub fn decode_runtime_request(input: &str) -> Result<RuntimeRequestEnvelope, RuntimeContractViolation> {
    let value: Value = serde_json::from_str(input).map_err(|_| {
        RuntimeContractViolation::new(
            ErrorCode::RuntimeInvalidEnvelope,
            "runtime request envelope must be valid JSON",
        )
    })?;
    let object = as_object(&value, "runtime request envelope")?;
    validate_meta(object, "request")?;
    let payload = as_object(
        object.get("payload").unwrap_or(&Value::Null),
        "runtime request payload",
    )?;
    let request_type = payload.get("type").and_then(Value::as_str).unwrap_or_default();
    if !RUNTIME_REQUEST_TYPES.contains(&request_type) {
        return Err(RuntimeContractViolation::new(
            ErrorCode::RuntimeInvalidEnum,
            "runtime request type is not supported",
        ));
    }
    validate_payload_enums(payload)?;
    serde_json::from_value(value).map_err(|error| {
        RuntimeContractViolation::new(
            ErrorCode::RuntimeInvalidEnvelope,
            format!("runtime request does not match schema: {error}"),
        )
    })
}

#[derive(Debug, Clone, PartialEq)]
pub enum RuntimeSequenceResult {
    Accepted,
    Duplicate,
}

#[derive(Default)]
pub struct RuntimeEventSequence {
    sessions: HashMap<String, (u64, HashMap<String, Value>)>,
}

impl RuntimeEventSequence {
    pub fn accept(
        &mut self,
        envelope: &RuntimeEventEnvelope,
    ) -> Result<RuntimeSequenceResult, RuntimeContractViolation> {
        let canonical = serde_json::to_value(envelope).map_err(|_| {
            RuntimeContractViolation::new(
                ErrorCode::RuntimeInvalidEnvelope,
                "runtime event could not be serialized",
            )
        })?;
        decode_runtime_event(&canonical.to_string())?;
        let state = self
            .sessions
            .entry(envelope.session_id.clone())
            .or_insert_with(|| (0, HashMap::new()));
        if let Some(previous) = state.1.get(&envelope.event_id) {
            if previous == &canonical {
                return Ok(RuntimeSequenceResult::Duplicate);
            }
            return Err(RuntimeContractViolation::new(
                ErrorCode::RuntimeDuplicateEventConflict,
                "eventId was replayed with different content",
            ));
        }
        if envelope.sequence <= state.0 {
            return Err(RuntimeContractViolation::new(
                ErrorCode::RuntimeInvalidSequence,
                format!(
                    "sequence {} does not advance session cursor {}",
                    envelope.sequence, state.0
                ),
            ));
        }
        state.0 = envelope.sequence;
        state.1.insert(envelope.event_id.clone(), canonical);
        Ok(RuntimeSequenceResult::Accepted)
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct RuntimeNegotiationResult {
    pub protocol: ProtocolVersion,
    pub capabilities: Vec<String>,
}

pub fn negotiate_runtime_contract(
    mut remote_versions: Vec<ProtocolVersion>,
    local_capabilities: &[String],
    remote_capabilities: &[String],
) -> Result<RuntimeNegotiationResult, RuntimeContractViolation> {
    remote_versions.retain(|version| version.major == 2);
    remote_versions.sort_by(|left, right| {
        right
            .minor
            .cmp(&left.minor)
            .then_with(|| right.patch.cmp(&left.patch))
    });
    let protocol = remote_versions.into_iter().next().ok_or_else(|| {
        RuntimeContractViolation::new(
            ErrorCode::RuntimeUnsupportedProtocolMajor,
            "runtime must support protocol major 2",
        )
    })?;
    let remote: HashSet<&str> = remote_capabilities.iter().map(String::as_str).collect();
    let mut capabilities: Vec<String> = local_capabilities
        .iter()
        .filter(|capability| remote.contains(capability.as_str()))
        .cloned()
        .collect::<HashSet<_>>()
        .into_iter()
        .collect();
    capabilities.sort();
    Ok(RuntimeNegotiationResult {
        protocol,
        capabilities,
    })
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct V1RuntimeEvent {
    pub event_id: String,
    pub session_id: String,
    pub sequence: u64,
    pub timestamp_ms: u64,
    pub turn_id: Option<String>,
    pub step_id: Option<String>,
    pub actor: Actor,
    pub trace_id: Option<String>,
    pub payload: Value,
}

pub fn v1_adapter_uses() -> u64 {
    V1_ADAPTER_USES.load(Ordering::Relaxed)
}

/// Temporary R02 compatibility boundary. Remove in R11 after one stable release at zero uses.
pub fn adapt_v1_event(input: V1RuntimeEvent) -> Result<RuntimeEventEnvelope, RuntimeContractViolation> {
    V1_ADAPTER_USES.fetch_add(1, Ordering::Relaxed);
    let payload = as_object(&input.payload, "v1 event payload")?;
    let event_type = payload.get("type").and_then(Value::as_str).unwrap_or_default();
    let payload = match event_type {
        "userMessage" => json!({
            "type": "contentDelta",
            "delta": payload.get("content").and_then(Value::as_str).unwrap_or_default(),
        }),
        "runtimeError" => json!({
            "type": "error",
            "error": {
                "code": "RUNTIME_INTERNAL_ERROR",
                "message": payload.get("message").and_then(Value::as_str).unwrap_or("Runtime v1 error"),
                "retryable": false,
            }
        }),
        _ => {
            return Err(RuntimeContractViolation::new(
                ErrorCode::RuntimeUnknownRequiredEvent,
                format!("v1 event {event_type} cannot be adapted"),
            ))
        }
    };
    let timestamp = time::OffsetDateTime::from_unix_timestamp_nanos(i128::from(input.timestamp_ms) * 1_000_000)
        .map_err(|_| RuntimeContractViolation::new(
            ErrorCode::RuntimeInvalidEnvelope,
            "v1 timestamp is outside the supported range",
        ))?
        .format(&time::format_description::well_known::Rfc3339)
        .map_err(|_| RuntimeContractViolation::new(
            ErrorCode::RuntimeInvalidEnvelope,
            "v1 timestamp could not be formatted",
        ))?;
    let event_id = input.event_id;
    let value = json!({
        "kind": "event",
        "requestId": format!("v1:{event_id}"),
        "sessionId": input.session_id,
        "turnId": input.turn_id.unwrap_or_else(|| format!("v1-turn:{event_id}")),
        "stepId": input.step_id.unwrap_or_else(|| format!("v1-step:{event_id}")),
        "traceId": input.trace_id.unwrap_or_else(|| format!("v1-trace:{event_id}")),
        "eventId": event_id,
        "sequence": input.sequence,
        "timestamp": timestamp,
        "schemaVersion": RUNTIME_SCHEMA_VERSION,
        "actor": input.actor,
        "ignorable": false,
        "payload": payload,
    });
    match decode_runtime_event(&value.to_string())? {
        DecodedRuntimeEvent::Event(envelope) => Ok(envelope),
        DecodedRuntimeEvent::Ignored { .. } => unreachable!("adapted events are mandatory"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn golden_event_value() -> Value {
        serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../runtime-contracts/golden/content-delta.v2.json"
        )))
        .expect("golden event must be valid JSON")
    }

    #[test]
    fn shared_golden_frames_round_trip_semantically() {
        let event_value = golden_event_value();
        let DecodedRuntimeEvent::Event(event) =
            decode_runtime_event(&event_value.to_string()).expect("event should decode")
        else {
            panic!("known event should not be ignored");
        };
        assert_eq!(serde_json::to_value(event).unwrap(), event_value);

        let request_value: Value = serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../runtime-contracts/golden/prompt.v2.json"
        )))
        .expect("golden request must be valid JSON");
        let request = decode_runtime_request(&request_value.to_string()).expect("request should decode");
        assert_eq!(serde_json::to_value(request).unwrap(), request_value);
    }

    #[test]
    fn invalid_ids_sequence_enum_and_major_are_rejected() {
        let mut value = golden_event_value();
        value.as_object_mut().unwrap().remove("turnId");
        assert_eq!(decode_runtime_event(&value.to_string()).unwrap_err().code, ErrorCode::RuntimeInvalidEnvelope);
        let mut value = golden_event_value();
        value["sequence"] = json!(0);
        assert_eq!(decode_runtime_event(&value.to_string()).unwrap_err().code, ErrorCode::RuntimeInvalidSequence);
        let mut value = golden_event_value();
        value["actor"] = json!("operator");
        assert_eq!(decode_runtime_event(&value.to_string()).unwrap_err().code, ErrorCode::RuntimeInvalidEnum);
        let mut value = golden_event_value();
        value["schemaVersion"] = json!("3.0.0");
        assert_eq!(decode_runtime_event(&value.to_string()).unwrap_err().code, ErrorCode::RuntimeUnsupportedProtocolMajor);
    }

    #[test]
    fn unknown_event_policy_is_fail_closed_unless_ignorable() {
        let mut value = golden_event_value();
        value["payload"] = json!({ "type": "futureTelemetry", "sample": 1 });
        value["ignorable"] = json!(true);
        assert!(matches!(decode_runtime_event(&value.to_string()).unwrap(), DecodedRuntimeEvent::Ignored { .. }));
        value["ignorable"] = json!(false);
        assert_eq!(decode_runtime_event(&value.to_string()).unwrap_err().code, ErrorCode::RuntimeUnknownRequiredEvent);
    }

    #[test]
    fn sequence_is_monotonic_and_replay_is_idempotent() {
        let DecodedRuntimeEvent::Event(event) = decode_runtime_event(&golden_event_value().to_string()).unwrap() else {
            panic!("known event should decode")
        };
        let mut sequence = RuntimeEventSequence::default();
        assert_eq!(sequence.accept(&event).unwrap(), RuntimeSequenceResult::Accepted);
        assert_eq!(sequence.accept(&event).unwrap(), RuntimeSequenceResult::Duplicate);
        let mut rollback = event.clone();
        rollback.event_id = "event-2".to_string();
        assert_eq!(sequence.accept(&rollback).unwrap_err().code, ErrorCode::RuntimeInvalidSequence);
        let mut conflict = event.clone();
        conflict.payload = RuntimeEventPayload::ContentDelta { delta: "changed".to_string() };
        assert_eq!(sequence.accept(&conflict).unwrap_err().code, ErrorCode::RuntimeDuplicateEventConflict);
    }

    #[test]
    fn v1_adapter_is_observable() {
        let before = v1_adapter_uses();
        let adapted = adapt_v1_event(V1RuntimeEvent {
            event_id: "legacy-1".to_string(),
            session_id: "session-1".to_string(),
            sequence: 1,
            timestamp_ms: 1_788_652_800_000,
            turn_id: None,
            step_id: None,
            actor: Actor::Assistant,
            trace_id: None,
            payload: json!({ "type": "userMessage", "content": "legacy content" }),
        }).expect("supported v1 event should adapt");
        assert!(matches!(adapted.payload, RuntimeEventPayload::ContentDelta { .. }));
        assert_eq!(v1_adapter_uses(), before + 1);
        assert_eq!(RuntimeContractStatus::current().v1_adapter_uses, before + 1);
    }
}
