use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProtocolVersion {
    pub major: u16,
    pub minor: u16,
    pub patch: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeEnvelopeMeta {
    pub protocol_version: u32,
    pub runtime_name: String,
    pub runtime_version: String,
    pub runtime_commit: String,
    pub event_schema_version: u16,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeInitializeRequest {
    pub runtime_root: String,
    pub app_version: String,
    pub platform: String,
    pub profile_digest: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeInfo {
    pub runtime_id: String,
    pub capabilities: Vec<String>,
    pub build_digest: String,
    pub contract: RuntimeEnvelopeMeta,
    pub profile_digest: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionDescriptor {
    pub session_id: String,
    pub runtime_id: String,
    pub runtime_name: String,
    pub sequence: u64,
    pub created_at_ms: u64,
    pub updated_at_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum RuntimeEvent {
    SessionCreated {
        session_id: String,
        title: Option<String>,
    },
    RuntimeError {
        session_id: Option<String>,
        code: String,
        message: String,
    },
    ApprovalRequested {
        request_id: String,
        session_id: String,
        message: String,
    },
    UserMessage {
        session_id: String,
        turn_id: String,
        content: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeEventEnvelope {
    pub event_id: String,
    pub session_id: String,
    pub sequence: u64,
    pub timestamp_ms: u64,
    pub schema_version: u16,
    pub turn_id: Option<String>,
    pub step_id: Option<String>,
    pub actor: String,
    pub trace_id: Option<String>,
    pub payload: RuntimeEvent,
    pub ignorable: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionPromptRequest {
    pub session_id: String,
    pub prompt: String,
    pub stream: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptReceipt {
    pub receipt_id: String,
    pub accepted: bool,
    pub queued: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalResponse {
    pub request_id: String,
    pub allow: bool,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RuntimeRequest {
    Initialize(RuntimeInitializeRequest),
    CreateSession,
    ResumeSession { session_id: String },
    Prompt(SessionPromptRequest),
    Cancel { session_id: String },
    CloseSession { session_id: String },
    ForkSession { from_session_id: String },
    ApprovalRespond(ApprovalResponse),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RuntimeResponse {
    Initialized(RuntimeInfo),
    SessionCreated(SessionDescriptor),
    PromptAccepted(PromptReceipt),
    Ok {
        message: String,
    },
    Error {
        code: String,
        message: String,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeContractVersion {
    pub protocol: ProtocolVersion,
    pub event_schema: u16,
}

impl RuntimeContractVersion {
    pub const CURRENT: RuntimeContractVersion = RuntimeContractVersion {
        protocol: ProtocolVersion {
            major: 1,
            minor: 0,
            patch: 0,
        },
        event_schema: 1,
    };
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn runtime_contract_version_can_serialize() {
        let encoded = serde_json::to_string(&RuntimeContractVersion::CURRENT)
            .expect("runtime contract version should be serializable");
        let value: serde_json::Value =
            serde_json::from_str(&encoded).expect("serialized payload should be valid json");
        assert_eq!(value["protocol"]["major"], json!(1));
    }
}
