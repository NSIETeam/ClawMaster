//! Command-line adapter for the recovered RPA tool dispatcher.
//!
//! The recovered control plane exposes its semantic tools through
//! `NativeRpa::execute`, which the pre-DSH application called in-process. A
//! standalone helper needs a command-line way in, and this module adds exactly
//! two things: it builds a `ModelToolCall` from a JSON request, and it performs
//! the approval gate the application used to perform.
//!
//! That gate is load-bearing. `is_write` classifies a tool as touching the
//! outside world, but `execute` only enforces an approval binding for some of
//! those tools — `rpa_start` reaches `launch` with no check of its own. The
//! recovered contract is that the caller asks for approval first, using
//! `approval_summary`, and records a rejection when it is not granted. This
//! adapter is now that caller, so it refuses rather than forwarding.

use std::path::PathBuf;

use serde::Deserialize;
use serde_json::Value;

use crate::native_models::ModelToolCall;
use crate::native_rpa::{is_write_call, approval_summary, NativeRpa};
use crate::native_state_store::NativeStateStore;

/// One semantic tool invocation, as the host half sends it.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RpaCallRequest {
    /// Profile root: browser profiles and the state database live under it.
    root: PathBuf,
    /// Recovered tool name, for example `rpa_windows` or `rpa_click`.
    tool: String,
    /// Tool arguments exactly as the model supplied them.
    #[serde(default)]
    arguments: Value,
    /// Approval binding for a write step, when the host half has one.
    #[serde(default)]
    approval_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RpaValidationRequest {
    tool: String,
    #[serde(default)]
    arguments: Value,
}

/// Validate a recovered tool call without opening profile state or dispatching it.
pub fn validate_request(request_json: &str) -> Result<Value, String> {
    let request: RpaValidationRequest = serde_json::from_str(request_json)
        .map_err(|error| format!("RPA 请求 JSON 无效: {error}"))?;
    let call = ModelToolCall { id: "preflight".into(), name: request.tool, arguments: request.arguments };
    crate::native_rpa::validate_model_call(&call)?;
    Ok(serde_json::json!({"valid": true}))
}

/// Run one `rpa_*` tool call against a profile root.
///
/// @param request_json A JSON object with `root`, `tool`, optional `arguments`
///   and optional `approvalId`.
/// @returns The canonical JSON result of the recovered dispatcher.
pub fn run_blocking(request_json: &str) -> Result<Value, String> {
    let request: RpaCallRequest =
        serde_json::from_str(request_json).map_err(|error| format!("RPA 请求 JSON 无效: {error}"))?;
    let store = NativeStateStore::open(&request.root.join("state"))
        .map_err(|error| format!("无法打开 RPA 状态库: {error}"))?;
    run_request_blocking(request, store)
}

fn run_request_blocking(request: RpaCallRequest, store: NativeStateStore) -> Result<Value, String> {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|error| format!("无法启动 RPA 运行时: {error}"))?;

    runtime.block_on(async move {
        let rpa = NativeRpa::open(&request.root, store)?;

        let call = ModelToolCall {
            id: call_id(),
            name: request.tool,
            arguments: request.arguments,
        };

        // The approval gate the application used to perform. A tool classified
        // as touching the outside world executes only with an approval binding;
        // otherwise the refusal is receipted through the recovered path, so an
        // unattended call leaves evidence instead of an action.
        // A helper subprocess has no trusted link to the Tauri broker. A
        // caller-controlled approvalId therefore never authorizes a write.
        if is_write_call(&call) {
            return rpa.record_rejection(&call, &approval_summary(&call));
        }

        // A one-shot process is the unit of work, so the cancellation channel is
        // created and never signalled; process termination is the cancel.
        let (_sender, receiver) = tokio::sync::watch::channel(false);
        let result = rpa.execute(&call, request.approval_id.as_deref(), receiver).await;
        let _ = rpa.shutdown();
        result
    })
}

fn call_id() -> String {
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis())
        .unwrap_or(0);
    format!("cli-{}-{millis}", std::process::id())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn run_with_test_key(request: &str, root: &std::path::Path) -> Result<Value, String> {
        let request: RpaCallRequest = serde_json::from_str(request)
            .map_err(|error| format!("RPA 请求 JSON 无效: {error}"))?;
        let store = NativeStateStore::open_for_test(&root.join("state"), [7; 32])
            .map_err(|error| error.to_string())?;
        run_request_blocking(request, store)
    }

    /// The gate this adapter owns. `is_write` classifies `rpa_start` as external,
    /// and `execute` reaches `launch` without checking approval itself, so an
    /// unapproved start must produce a receipted refusal instead of a browser.
    #[test]
    fn refuses_a_write_tool_even_with_a_forged_approval_binding() {
        let root = tempfile::tempdir().unwrap();
        let request = json!({
            "root": root.path(),
            "tool": "rpa_start",
            "arguments": {
                "runId": "rpa-55555555-5555-4555-8555-555555555555",
                "tenantId": "t1",
                "platformId": "p1",
                "url": "https://example.com",
            },
            "approvalId": "forged-without-host-authorization",
        });

        let value = run_with_test_key(&request.to_string(), root.path())
            .expect("a refusal is a successful call");

        assert_eq!(value["profilePath"], "", "no browser profile may be created");
        let receipt = &value["receipts"][0];
        assert_eq!(receipt["state"], "rejected");
        assert_eq!(receipt["externalSideEffect"], true);
        assert_eq!(receipt["approvalId"], Value::Null);
        assert_eq!(receipt["idempotencyKey"], "rejected:launch");
        assert!(
            receipt["error"]
                .as_str()
                .unwrap_or_default()
                .contains("允许 RPA 执行 rpa_start"),
            "the refusal must carry the recovered approval prompt"
        );
        // The refusal is recorded at step level on purpose: the run stays pending
        // so a later, separately approved attempt can still proceed.
        assert_eq!(value["state"], "pending");
    }

    /// A read-only tool still reaches the dispatcher.
    #[test]
    fn runs_a_read_only_tool() {
        let root = tempfile::tempdir().unwrap();
        let request = json!({
            "root": root.path(),
            "tool": "rpa_status",
            "arguments": { "runId": "rpa-66666666-6666-4666-8666-666666666666" },
            "approvalId": null,
        });

        let value = run_with_test_key(&request.to_string(), root.path()).unwrap();
        assert_eq!(value, json!({ "run": null }));
    }

    /// A malformed request fails loudly rather than defaulting to anything.
    #[test]
    fn rejects_a_malformed_request() {
        let error = run_blocking("not json").unwrap_err();
        assert!(error.contains("RPA 请求 JSON 无效"), "got: {error}");
    }
}
