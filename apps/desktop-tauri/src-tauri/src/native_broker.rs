use std::collections::{HashMap, HashSet};
use std::ffi::{OsStr, OsString};
use std::future::Future;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use crate::i18n::{self, Msg};
use fs2::FileExt;
use keyring::{Entry, Error as KeyringError};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};

const PREFIX: &str = "\u{1e}CLAWMASTER_RPA_V1:";
const CREDENTIAL_PREFIX: &str = "\u{1e}CLAWMASTER_CREDENTIALS_V1:";
const MAX_FRAME_BYTES: usize = 1024 * 1024;
const CREDENTIAL_PROTOCOL: &str = "clawmaster-credentials/1";
const CREDENTIAL_SERVICE: &str = "com.nsieteam.ClawMaster.credentials";
const MAX_CREDENTIAL_FRAME_BYTES: usize = 64 * 1024;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Request {
    call_id: String,
    tool: String,
    root: PathBuf,
    arguments: Value,
    summary: String,
    arguments_sha256: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Frame {
    #[serde(rename = "type")]
    kind: String,
    request: Option<Request>,
    call_id: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Reply<'a> {
    protocol: &'static str,
    #[serde(rename = "type")]
    kind: &'static str,
    call_id: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CredentialRequest {
    protocol: String,
    #[serde(rename = "type")]
    kind: String,
    request_id: String,
    reference: String,
    value: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CredentialReply<'a> {
    protocol: &'static str,
    #[serde(rename = "type")]
    kind: &'static str,
    request_id: &'a str,
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    value: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    inserted: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<&'static str>,
}

enum BrokerFrame {
    Rpa(Frame),
    Credential(CredentialRequest),
    CredentialHello,
}

#[derive(Clone, Default)]
pub struct BrokerState {
    consumed: Arc<Mutex<HashSet<String>>>,
    cancelled: Arc<Mutex<HashSet<String>>>,
    cancellations: Arc<Mutex<HashMap<String, tokio::sync::watch::Sender<bool>>>>,
    rpa_controllers:
        Arc<Mutex<HashMap<PathBuf, Arc<clawmaster_rpa_native::native_rpa::NativeRpa>>>>,
    rpa_supported: bool,
}

impl BrokerState {
    /// Keep OS credentials available when native RPA actions cannot run in this host.
    pub fn credentials_only() -> Self {
        Self {
            rpa_supported: false,
            ..Self::default()
        }
    }
}

/// Store inherited model credentials before the child environment is scrubbed.
pub fn migrate_environment_credentials(
    app: &AppHandle,
    environment: impl IntoIterator<Item = (OsString, OsString)>,
) {
    let Ok(app_data_dir) = app.path().app_data_dir() else {
        return;
    };
    for (name, value) in environment {
        let Some(request) = inherited_credential_request(name, value) else {
            continue;
        };
        let _ = credential_operation(&app_data_dir, request);
    }
}

fn inherited_credential_request(name: OsString, value: OsString) -> Option<CredentialRequest> {
    let name = name.to_string_lossy().into_owned();
    if !is_secret_environment_name(OsStr::new(&name)) {
        return None;
    }
    let value = value.to_string_lossy();
    if value.is_empty() || value.len() > MAX_CREDENTIAL_FRAME_BYTES {
        return None;
    }
    let reference = format!("ref:{name}");
    if !valid_reference(&reference) {
        return None;
    }
    Some(CredentialRequest {
        protocol: CREDENTIAL_PROTOCOL.into(),
        kind: "set-if-absent".into(),
        request_id: "startup-migration".into(),
        reference,
        value: Some(value.into_owned()),
    })
}

/// Apply the same secret-name rule when importing and scrubbing inherited variables.
pub(crate) fn is_secret_environment_name(name: &OsStr) -> bool {
    let normalized = name.to_string_lossy().to_ascii_lowercase();
    ["key", "secret", "token", "password"]
        .iter()
        .any(|marker| normalized.contains(marker))
}

/// Announce that this child has a private, bidirectional stdio broker channel.
pub fn announce_ready(writer: &Arc<Mutex<Box<dyn Write + Send>>>, state: &BrokerState) {
    if let Ok(mut output) = writer.lock() {
        let _ = write_rpa_ready(&mut **output, state.rpa_supported)
            .and_then(|_| output.write_all(b"{\"protocol\":\"clawmaster-credentials/1\",\"type\":\"ready\",\"supported\":true}\n"))
            .and_then(|_| output.flush());
    }
}

fn write_rpa_ready(output: &mut dyn Write, supported: bool) -> std::io::Result<()> {
    writeln!(output, "{{\"protocol\":\"clawmaster-rpa/1\",\"type\":\"ready\",\"supported\":{supported},\"capabilities\":[\"clawmaster-rpa/1\"]}}")
}

/// Consume one reserved RPA frame from the Host's inherited stdout stream.
pub fn handle_line(
    app: AppHandle,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    state: BrokerState,
    line: &str,
) -> bool {
    match parse_frame(line) {
        None => false,
        Some(BrokerFrame::Credential(request)) => {
            let call_id = request.request_id.clone();
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                let (ok, value, inserted, error) = process_credential_request(&app, request).await;
                let reply = CredentialReply {
                    protocol: CREDENTIAL_PROTOCOL,
                    kind: "result",
                    request_id: &call_id,
                    ok,
                    value,
                    inserted,
                    error,
                };
                if let Ok(mut output) = writer.lock() {
                    if let Ok(json) = serde_json::to_vec(&reply) {
                        let _ = output
                            .write_all(&json)
                            .and_then(|_| output.write_all(b"\n"))
                            .and_then(|_| output.flush());
                    }
                }
            });
            true
        }
        Some(BrokerFrame::CredentialHello) => {
            if let Ok(mut output) = writer.lock() {
                let _ = output
                    .write_all(b"{\"protocol\":\"clawmaster-credentials/1\",\"type\":\"ready\",\"supported\":true}\n")
                    .and_then(|_| output.flush());
            }
            true
        }
        Some(BrokerFrame::Rpa(frame)) => {
            if frame.kind == "hello" {
                if let Ok(mut output) = writer.lock() {
                    let _ = write_rpa_ready(&mut **output, state.rpa_supported)
                        .and_then(|_| output.flush());
                }
                return true;
            }
            if frame.kind == "cancel" {
                if let Some(call_id) = frame.call_id {
                    cancel_call(&state, call_id);
                }
                return true;
            }
            if frame.kind != "request" && frame.kind != "read" {
                return true;
            }
            let Some(request) = frame.request else {
                return true;
            };
            let read_only = frame.kind == "read";
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                let call_id = request.call_id.clone();
                let result = process_request(&app, &state, request, read_only).await;
                if let Ok(mut cancelled) = state.cancelled.lock() {
                    cancelled.remove(&call_id);
                }
                let reply = match result {
                    Ok(value) => Reply {
                        protocol: "clawmaster-rpa/1",
                        kind: "result",
                        call_id: &call_id,
                        result: Some(value),
                        error: None,
                    },
                    Err(error) => Reply {
                        protocol: "clawmaster-rpa/1",
                        kind: "result",
                        call_id: &call_id,
                        result: None,
                        error: Some(error),
                    },
                };
                if let Ok(mut output) = writer.lock() {
                    if let Ok(json) = serde_json::to_vec(&reply) {
                        let _ = output
                            .write_all(&json)
                            .and_then(|_| output.write_all(b"\n"))
                            .and_then(|_| output.flush());
                    }
                }
            });
            true
        }
    }
}

fn parse_frame(line: &str) -> Option<BrokerFrame> {
    let (prefix, encoded) = if let Some(encoded) = line.strip_prefix(PREFIX) {
        (PREFIX, encoded)
    } else if let Some(encoded) = line.strip_prefix(CREDENTIAL_PREFIX) {
        (CREDENTIAL_PREFIX, encoded)
    } else {
        return None;
    };
    if encoded.len() > MAX_FRAME_BYTES {
        return Some(if prefix == CREDENTIAL_PREFIX {
            BrokerFrame::Credential(CredentialRequest {
                protocol: CREDENTIAL_PROTOCOL.into(),
                kind: "invalid".into(),
                request_id: String::new(),
                reference: String::new(),
                value: None,
            })
        } else {
            BrokerFrame::Rpa(Frame {
                kind: "invalid".into(),
                request: None,
                call_id: None,
            })
        });
    }
    let Ok(header) = serde_json::from_str::<serde_json::Value>(encoded) else {
        return Some(if prefix == CREDENTIAL_PREFIX {
            BrokerFrame::Credential(CredentialRequest {
                protocol: CREDENTIAL_PROTOCOL.into(),
                kind: "invalid".into(),
                request_id: String::new(),
                reference: String::new(),
                value: None,
            })
        } else {
            BrokerFrame::Rpa(Frame {
                kind: "invalid".into(),
                request: None,
                call_id: None,
            })
        });
    };
    match header.get("protocol").and_then(Value::as_str) {
        Some("clawmaster-rpa/1") if prefix == PREFIX => {
            serde_json::from_value(header).ok().map(BrokerFrame::Rpa)
        }
        Some(CREDENTIAL_PROTOCOL) if prefix == CREDENTIAL_PREFIX => {
            if header.get("type").and_then(Value::as_str) == Some("hello") {
                Some(BrokerFrame::CredentialHello)
            } else {
                serde_json::from_value(header).ok().map(BrokerFrame::Credential)
            }
        }
        _ => None,
    }
}

async fn process_credential_request(
    app: &AppHandle,
    request: CredentialRequest,
) -> (bool, Option<String>, Option<bool>, Option<&'static str>) {
    if let Err(error) = validate_credential_request(&request) {
        return (false, None, None, Some(error));
    }
    let app_data_dir = match app.path().app_data_dir() {
        Ok(path) => path,
        Err(_) => return (false, None, None, Some("unavailable")),
    };
    let operation =
        tokio::task::spawn_blocking(move || credential_operation(&app_data_dir, request)).await;
    match operation {
        Ok(Ok((value, inserted))) => (true, value, inserted, None),
        Ok(Err(error)) => (false, None, None, Some(error)),
        Err(_) => (false, None, None, Some("unavailable")),
    }
}

fn validate_credential_request(request: &CredentialRequest) -> Result<(), &'static str> {
    if request.protocol != CREDENTIAL_PROTOCOL
        || request.request_id.is_empty()
        || request.request_id.len() > 256
        || !valid_reference(&request.reference)
    {
        return Err("invalid-reference");
    }
    if request
        .value
        .as_ref()
        .is_some_and(|value| value.len() > MAX_CREDENTIAL_FRAME_BYTES)
    {
        return Err("too-large");
    }
    Ok(())
}

fn credential_operation(
    app_data_dir: &std::path::Path,
    request: CredentialRequest,
) -> Result<(Option<String>, Option<bool>), &'static str> {
    let entry = Entry::new(CREDENTIAL_SERVICE, &request.reference).map_err(map_keyring_error)?;
    match request.kind.as_str() {
        "get" => match entry.get_password() {
            Ok(value) if value.len() <= MAX_CREDENTIAL_FRAME_BYTES => Ok((Some(value), None)),
            Ok(_) => Err("too-large"),
            Err(KeyringError::NoEntry) => Ok((None, None)),
            Err(error) => Err(map_keyring_error(error)),
        },
        "set" => {
            let value = request.value.as_deref().ok_or("write-failed")?;
            with_reference_lock(app_data_dir, &request.reference, || {
                entry.set_password(value).map_err(map_keyring_write_error)
            })?;
            Ok((None, None))
        }
        "delete" => {
            with_reference_lock(app_data_dir, &request.reference, || {
                match entry.delete_credential() {
                    Ok(()) | Err(KeyringError::NoEntry) => Ok(()),
                    Err(error) => Err(map_keyring_error(error)),
                }
            })?;
            Ok((None, None))
        }
        "set-if-absent" => {
            let value = request.value.as_deref().ok_or("write-failed")?;
            with_reference_lock(app_data_dir, &request.reference, || {
                match entry.get_password() {
                    Ok(_) => Ok(false),
                    Err(KeyringError::NoEntry) => {
                        entry.set_password(value).map_err(map_keyring_write_error)?;
                        Ok(true)
                    }
                    Err(error) => Err(map_keyring_error(error)),
                }
            })
            .map(|inserted| (None, Some(inserted)))
        }
        _ => Err("write-failed"),
    }
}

fn with_reference_lock<T>(
    app_data_dir: &std::path::Path,
    reference: &str,
    operation: impl FnOnce() -> Result<T, &'static str>,
) -> Result<T, &'static str> {
    let credentials_root = app_data_dir.join("credentials");
    std::fs::create_dir_all(&credentials_root).map_err(|_| "unavailable")?;
    set_private_directory_permissions(&credentials_root)?;
    let lock_root = credentials_root.join("migration-locks");
    std::fs::create_dir_all(&lock_root).map_err(|_| "unavailable")?;
    set_private_directory_permissions(&lock_root)?;
    let lock_name = hex::encode(Sha256::digest(reference.as_bytes()));
    let lock_path = lock_root.join(format!("{lock_name}.lock"));
    let mut options = std::fs::OpenOptions::new();
    options.create(true).truncate(false).read(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let lock = options.open(lock_path).map_err(|_| "unavailable")?;
    set_private_file_permissions(&lock)?;
    lock.lock_exclusive().map_err(|_| "unavailable")?;
    let result = operation();
    let _ = FileExt::unlock(&lock);
    result
}

fn set_private_directory_permissions(path: &std::path::Path) -> Result<(), &'static str> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))
            .map_err(|_| "unavailable")?;
    }
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

fn set_private_file_permissions(file: &std::fs::File) -> Result<(), &'static str> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(std::fs::Permissions::from_mode(0o600))
            .map_err(|_| "unavailable")?;
    }
    #[cfg(not(unix))]
    let _ = file;
    Ok(())
}

fn map_keyring_write_error(error: KeyringError) -> &'static str {
    match error {
        KeyringError::NoStorageAccess(_) | KeyringError::PlatformFailure(_) => "access-denied",
        _ => "write-failed",
    }
}

fn map_keyring_error(error: KeyringError) -> &'static str {
    match error {
        KeyringError::NoEntry => "unavailable",
        KeyringError::NoStorageAccess(_) | KeyringError::PlatformFailure(_) => "access-denied",
        _ => "write-failed",
    }
}

fn valid_reference(reference: &str) -> bool {
    if reference.is_empty() || reference.len() > 255 || reference.chars().any(char::is_control) {
        return false;
    }
    if let Some(name) = reference.strip_prefix("ref:") {
        let mut chars = name.chars();
        return chars
            .next()
            .is_some_and(|first| first == '_' || first.is_ascii_alphabetic())
            && chars.all(|character| character == '_' || character.is_ascii_alphanumeric());
    }
    let Some(record) = reference.strip_prefix("record:") else {
        return false;
    };
    let Some((scope, id)) = record.split_once('/') else {
        return false;
    };
    valid_record_component(scope) && valid_record_component(id) && !id.contains('/')
}

fn valid_record_component(component: &str) -> bool {
    !component.is_empty()
        && component
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
}

async fn process_request(
    app: &AppHandle,
    state: &BrokerState,
    request: Request,
    read_only: bool,
) -> Result<Value, String> {
    let (cancellation, receiver) = tokio::sync::watch::channel(false);
    state
        .cancellations
        .lock()
        .map_err(|_| "RPA cancellation registry unavailable")?
        .insert(request.call_id.clone(), cancellation);
    let result = if read_only {
        let call = clawmaster_rpa_native::native_models::ModelToolCall {
            id: request.call_id.clone(),
            name: request.tool.clone(),
            arguments: request.arguments.clone(),
        };
        if clawmaster_rpa_native::native_rpa::is_write_call(&call) {
            Err("the native broker only accepts read-only calls on the read channel".into())
        } else {
            dispatch(state, &request, None, receiver).await
        }
    } else {
        confirm_and_dispatch(
            state,
            &request,
            || confirm(app, &request),
            || dispatch(state, &request, Some(&request.call_id), receiver),
        )
        .await
    };
    if let Ok(mut cancellations) = state.cancellations.lock() {
        cancellations.remove(&request.call_id);
    }
    result
}

async fn confirm_and_dispatch<C, CFut, D, DFut>(
    state: &BrokerState,
    request: &Request,
    confirm: C,
    dispatch: D,
) -> Result<Value, String>
where
    C: FnOnce() -> CFut,
    CFut: Future<Output = Result<bool, String>>,
    D: FnOnce() -> DFut,
    DFut: Future<Output = Result<Value, String>>,
{
    if request.call_id.trim().is_empty() || request.call_id.len() > 256 {
        return Err("invalid RPA callId".into());
    }
    let call = clawmaster_rpa_native::native_models::ModelToolCall {
        id: request.call_id.clone(),
        name: request.tool.clone(),
        arguments: request.arguments.clone(),
    };
    if !clawmaster_rpa_native::native_rpa::is_write_call(&call) {
        return Err("the native broker only accepts DSH-approved write calls".into());
    }
    let canonical = serde_json::to_vec(&request.arguments).map_err(|error| error.to_string())?;
    let digest = hex::encode(Sha256::digest(&canonical));
    if canonical.len() > 64 * 1024 {
        return Err("RPA arguments exceed the confirmation limit".into());
    }
    if digest != request.arguments_sha256 {
        return Err("RPA arguments changed in transit; no action was dispatched".into());
    }
    let expected_summary = clawmaster_rpa_native::native_rpa::approval_summary(&call);
    if request.summary != expected_summary {
        return Err("RPA approval summary changed; no action was dispatched".into());
    }
    {
        let mut consumed = state
            .consumed
            .lock()
            .map_err(|_| "approval state unavailable")?;
        if !consumed.insert(request.call_id.clone()) {
            return Err("RPA callId was already consumed".into());
        }
    }
    if is_cancelled(state, &request.call_id) {
        return Err("RPA call cancelled before confirmation".into());
    }
    if !confirm().await? {
        return Err("RPA system confirmation denied or cancelled".into());
    }
    if is_cancelled(state, &request.call_id) {
        return Err("RPA call cancelled before dispatch".into());
    }

    dispatch().await
}

async fn dispatch(
    state: &BrokerState,
    request: &Request,
    approval_id: Option<&str>,
    receiver: tokio::sync::watch::Receiver<bool>,
) -> Result<Value, String> {
    let call = clawmaster_rpa_native::native_models::ModelToolCall {
        id: request.call_id.clone(),
        name: request.tool.clone(),
        arguments: request.arguments.clone(),
    };
    let controller = rpa_controller(state, &request.root)?;
    controller.execute(&call, approval_id, receiver).await
}

fn cancel_call(state: &BrokerState, call_id: String) {
    if let Ok(mut cancelled) = state.cancelled.lock() {
        cancelled.insert(call_id.clone());
    }
    if let Ok(cancellations) = state.cancellations.lock() {
        if let Some(cancellation) = cancellations.get(&call_id) {
            let _ = cancellation.send(true);
        }
    }
}

fn rpa_controller(
    state: &BrokerState,
    root: &Path,
) -> Result<Arc<clawmaster_rpa_native::native_rpa::NativeRpa>, String> {
    std::fs::create_dir_all(root).map_err(|error| format!("cannot create RPA profile: {error}"))?;
    let metadata = std::fs::symlink_metadata(root)
        .map_err(|error| format!("cannot inspect RPA profile: {error}"))?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err("RPA profile root must be a real directory".into());
    }
    let root = root
        .canonicalize()
        .map_err(|error| format!("cannot resolve RPA profile: {error}"))?;
    controller_for_root(&state.rpa_controllers, root.clone(), || {
        let store =
            clawmaster_rpa_native::native_state_store::NativeStateStore::open(&root.join("state"))
                .map_err(|error| format!("cannot open RPA state: {error}"))?;
        clawmaster_rpa_native::native_rpa::NativeRpa::open(&root, store)
    })
}

fn controller_for_root<T>(
    controllers: &Mutex<HashMap<PathBuf, Arc<T>>>,
    root: PathBuf,
    open: impl FnOnce() -> Result<T, String>,
) -> Result<Arc<T>, String> {
    let mut controllers = controllers
        .lock()
        .map_err(|_| "RPA controller registry unavailable")?;
    if let Some(controller) = controllers.get(&root) {
        return Ok(Arc::clone(controller));
    }
    let controller = Arc::new(open()?);
    controllers.insert(root, Arc::clone(&controller));
    Ok(controller)
}

fn is_cancelled(state: &BrokerState, call_id: &str) -> bool {
    state
        .cancelled
        .lock()
        .map(|values| values.contains(call_id))
        .unwrap_or(true)
}

async fn confirm(app: &AppHandle, request: &Request) -> Result<bool, String> {
    let (send, receive) = tokio::sync::oneshot::channel();
    let args =
        serde_json::to_string_pretty(&request.arguments).unwrap_or_else(|_| "<unavailable>".into());
    let message = format!(
        "{}\nTool: {}\nCall: {}\nArguments: {}\nSHA-256: {}\nProfile: {}",
        request.summary,
        request.tool,
        request.call_id,
        args,
        request.arguments_sha256,
        request.root.display()
    );
    let mut dialog = app
        .dialog()
        .message(message)
        .title(i18n::t(Msg::RpaConfirmTitle))
        .buttons(MessageDialogButtons::OkCancelCustom(
            i18n::t(Msg::RpaConfirmAllowOnce).into(),
            i18n::t(Msg::RpaConfirmDeny).into(),
        ));
    if let Some(window) = app.get_window("main") {
        dialog = dialog.parent(&window);
    }
    dialog.show(move |accepted| {
        let _ = send.send(accepted);
    });
    receive
        .await
        .map_err(|_| "native confirmation dialog closed without an answer".to_owned())
}

#[cfg(test)]
mod tests {
    use super::{
        cancel_call, confirm_and_dispatch, controller_for_root, inherited_credential_request,
        parse_frame, valid_reference, validate_credential_request, with_reference_lock,
        BrokerFrame, BrokerState, CredentialReply, CredentialRequest, Request, CREDENTIAL_PREFIX,
        PREFIX,
    };
    use serde_json::{json, Value};
    use sha2::{Digest, Sha256};
    use std::collections::HashMap;
    use std::ffi::OsString;
    use std::fs;
    use std::path::PathBuf;
    use std::process::{Command, Stdio};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;
    use std::sync::Mutex;

    #[test]
    fn rpa_controller_is_reused_for_the_host_lifetime() {
        let root = PathBuf::from("/fixture/rpa");
        let controllers = Mutex::new(HashMap::new());
        let opens = AtomicUsize::new(0);
        let first = controller_for_root(&controllers, root.clone(), || {
            opens.fetch_add(1, Ordering::SeqCst);
            Ok(())
        })
        .unwrap();
        let second =
            controller_for_root(&controllers, root, || Err("must be reused".into())).unwrap();
        assert!(Arc::ptr_eq(&first, &second));
        assert_eq!(opens.load(Ordering::SeqCst), 1);

        let weak = Arc::downgrade(&first);
        drop(first);
        drop(second);
        assert!(weak.upgrade().is_some());
        drop(controllers);
        assert!(weak.upgrade().is_none());
    }

    #[tokio::test]
    async fn broker_cancellation_reaches_the_active_native_call() {
        let state = BrokerState::default();
        let call_id = "call-cancel-active".to_owned();
        let (sender, mut receiver) = tokio::sync::watch::channel(false);
        state
            .cancellations
            .lock()
            .unwrap()
            .insert(call_id.clone(), sender);

        cancel_call(&state, call_id.clone());

        receiver.changed().await.unwrap();
        assert!(*receiver.borrow());
        assert!(super::is_cancelled(&state, &call_id));
    }

    #[test]
    fn inherited_api_key_uses_the_credentials_providers_reference_namespace() {
        let request = inherited_credential_request(
            OsString::from("DEEPSEEK_API_KEY"),
            OsString::from("fixture-only-secret"),
        )
        .unwrap();
        assert_eq!(request.kind, "set-if-absent");
        assert_eq!(request.reference, "ref:DEEPSEEK_API_KEY");
        assert!(validate_credential_request(&request).is_ok());
        assert!(inherited_credential_request(
            OsString::from("LANG"),
            OsString::from("en_US.UTF-8")
        )
        .is_none());
        for name in ["AWS_ACCESS_KEY_ID", "MONKEY"] {
            assert!(inherited_credential_request(
                OsString::from(name),
                OsString::from("fixture-secret")
            )
            .is_some());
        }
    }

    #[test]
    fn event_parser_routes_rpa_and_credentials_protocols_without_crossing_frames() {
        let rpa = format!(
            "{PREFIX}{}",
            json!({"protocol":"clawmaster-rpa/1","type":"cancel","callId":"call-one"})
        );
        assert!(matches!(parse_frame(&rpa), Some(BrokerFrame::Rpa(_))));

        let credential = format!(
            "{CREDENTIAL_PREFIX}{}",
            json!({"protocol":"clawmaster-credentials/1","type":"get","requestId":"request-one","reference":"ref:OPENAI_API_KEY"})
        );
        assert!(matches!(
            parse_frame(&credential),
            Some(BrokerFrame::Credential(CredentialRequest { kind, .. })) if kind == "get"
        ));
        assert!(matches!(parse_frame(&format!(
            "{CREDENTIAL_PREFIX}{}",
            json!({"protocol":"clawmaster-credentials/1","type":"hello"})
        )), Some(BrokerFrame::CredentialHello)));
        assert!(parse_frame("ordinary host log").is_none());
        assert!(parse_frame(&format!(
            "{PREFIX}{}",
            json!({
                "protocol":"clawmaster-credentials/1",
                "type":"get",
                "requestId":"request-one",
                "reference":"ref:OPENAI_API_KEY"
            })
        ))
        .is_none());
    }

    #[test]
    fn credential_references_accept_only_bounded_keyring_identifiers() {
        for valid in ["ref:OPENAI_API_KEY", "ref:_PRIVATE", "record:oauth/github"] {
            assert!(valid_reference(valid), "{valid}");
        }
        for invalid in [
            "OPENAI_API_KEY",
            "ref:9INVALID",
            "ref:WITH-DASH",
            "record:OAuth/github",
            "record:oauth/github/extra",
            "record:/github",
            "record:oauth/",
            &format!("ref:{}", "A".repeat(252)),
        ] {
            assert!(!valid_reference(invalid), "{invalid}");
        }
    }

    #[test]
    fn credential_limits_fail_before_accessing_the_os_keyring() {
        let oversized = CredentialRequest {
            protocol: "clawmaster-credentials/1".into(),
            kind: "set".into(),
            request_id: "request-one".into(),
            reference: "ref:OPENAI_API_KEY".into(),
            value: Some("x".repeat(64 * 1024 + 1)),
        };
        assert_eq!(validate_credential_request(&oversized), Err("too-large"));

        let invalid_reference = CredentialRequest {
            protocol: "clawmaster-credentials/1".into(),
            kind: "get".into(),
            request_id: "request-two".into(),
            reference: "../../etc/passwd".into(),
            value: None,
        };
        assert_eq!(
            validate_credential_request(&invalid_reference),
            Err("invalid-reference")
        );
    }

    #[test]
    fn set_if_absent_reply_reports_only_whether_it_inserted() {
        let reply = CredentialReply {
            protocol: "clawmaster-credentials/1",
            kind: "result",
            request_id: "request-one",
            ok: true,
            value: None,
            inserted: Some(false),
            error: None,
        };
        let encoded = serde_json::to_string(&reply).unwrap();
        let decoded: Value = serde_json::from_str(&encoded).unwrap();
        assert_eq!(decoded["inserted"], false);
        assert!(decoded.get("value").is_none());
        assert!(!encoded.contains("secret"));
    }

    #[test]
    #[ignore = "subprocess helper"]
    fn set_if_absent_process_helper() {
        let Some(root) = std::env::var_os("CLAWMASTER_SET_ABSENT_TEST_ROOT") else {
            return;
        };
        let root = std::path::PathBuf::from(root);
        let variant = std::env::var("CLAWMASTER_SET_ABSENT_VARIANT").unwrap();
        fs::write(root.join(format!("ready-{variant}")), b"ready").unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while !root.join("start").exists() {
            assert!(
                std::time::Instant::now() < deadline,
                "start barrier timed out"
            );
            std::thread::yield_now();
        }
        let candidate = match variant.as_str() {
            "first" => "migration-secret-first",
            "second" => "migration-secret-second",
            "migration" => "migration-old-secret",
            "ordinary" => "user-current-secret",
            _ => panic!("unexpected test variant"),
        };
        let inserted = with_reference_lock(&root, "ref:OPENAI_API_KEY", || {
            let stored = root.join("credential-value");
            if variant == "ordinary" {
                fs::write(stored, candidate).map_err(|_| "unavailable")?;
                return Ok(true);
            }
            if stored.exists() {
                return Ok(false);
            }
            fs::write(stored, candidate).map_err(|_| "unavailable")?;
            Ok(true)
        })
        .unwrap();
        fs::write(root.join(format!("result-{variant}")), inserted.to_string()).unwrap();
    }

    #[test]
    fn set_if_absent_is_atomic_across_processes_and_never_returns_the_stored_value() {
        const FIRST: &str = "migration-secret-first";
        const SECOND: &str = "migration-secret-second";
        let root = tempfile::tempdir().unwrap();
        let executable = std::env::current_exe().unwrap();
        let mut children = Vec::new();
        for variant in ["first", "second"] {
            children.push(
                Command::new(&executable)
                    .args([
                        "--exact",
                        "native_broker::tests::set_if_absent_process_helper",
                        "--ignored",
                    ])
                    .env("CLAWMASTER_SET_ABSENT_TEST_ROOT", root.path())
                    .env("CLAWMASTER_SET_ABSENT_VARIANT", variant)
                    .stdout(Stdio::piped())
                    .stderr(Stdio::piped())
                    .spawn()
                    .unwrap(),
            );
        }
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while !(root.path().join("ready-first").exists()
            && root.path().join("ready-second").exists())
        {
            assert!(
                std::time::Instant::now() < deadline,
                "workers did not reach the barrier"
            );
            std::thread::yield_now();
        }
        fs::write(root.path().join("start"), b"go").unwrap();
        for child in children {
            let output = child.wait_with_output().unwrap();
            assert!(output.status.success());
            let output = String::from_utf8_lossy(&output.stdout).to_string()
                + &String::from_utf8_lossy(&output.stderr);
            assert!(!output.contains(FIRST));
            assert!(!output.contains(SECOND));
        }
        let first_inserted = fs::read_to_string(root.path().join("result-first")).unwrap();
        let second_inserted = fs::read_to_string(root.path().join("result-second")).unwrap();
        assert!(matches!(
            (first_inserted.as_str(), second_inserted.as_str()),
            ("true", "false") | ("false", "true")
        ));
        let stored = fs::read_to_string(root.path().join("credential-value")).unwrap();
        assert!(stored == FIRST || stored == SECOND);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let credentials_root = root.path().join("credentials");
            let lock_root = root.path().join("credentials/migration-locks");
            let lock_file = lock_root.join(format!(
                "{}.lock",
                hex::encode(Sha256::digest(b"ref:OPENAI_API_KEY"))
            ));
            assert_eq!(
                fs::metadata(credentials_root).unwrap().permissions().mode() & 0o777,
                0o700
            );
            assert_eq!(
                fs::metadata(lock_root).unwrap().permissions().mode() & 0o777,
                0o700
            );
            assert_eq!(
                fs::metadata(lock_file).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
    }

    #[test]
    fn concurrent_ordinary_set_cannot_be_overwritten_by_an_older_migration_value() {
        let root = tempfile::tempdir().unwrap();
        let executable = std::env::current_exe().unwrap();
        let mut children = Vec::new();
        for variant in ["migration", "ordinary"] {
            children.push(
                Command::new(&executable)
                    .args([
                        "--exact",
                        "native_broker::tests::set_if_absent_process_helper",
                        "--ignored",
                    ])
                    .env("CLAWMASTER_SET_ABSENT_TEST_ROOT", root.path())
                    .env("CLAWMASTER_SET_ABSENT_VARIANT", variant)
                    .stdout(Stdio::piped())
                    .stderr(Stdio::piped())
                    .spawn()
                    .unwrap(),
            );
        }
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while !(root.path().join("ready-migration").exists()
            && root.path().join("ready-ordinary").exists())
        {
            assert!(
                std::time::Instant::now() < deadline,
                "workers did not reach the barrier"
            );
            std::thread::yield_now();
        }
        fs::write(root.path().join("start"), b"go").unwrap();
        for child in children {
            let output = child.wait_with_output().unwrap();
            assert!(output.status.success());
            let output = String::from_utf8_lossy(&output.stdout).to_string()
                + &String::from_utf8_lossy(&output.stderr);
            assert!(!output.contains("migration-old-secret"));
            assert!(!output.contains("user-current-secret"));
        }
        assert_eq!(
            fs::read_to_string(root.path().join("credential-value")).unwrap(),
            "user-current-secret"
        );
    }

    fn request() -> Request {
        let call = clawmaster_rpa_native::native_models::ModelToolCall {
            id: "call-one".into(),
            name: "rpa_click".into(),
            arguments: json!({"targetSummary":"Save button"}),
        };
        let canonical = serde_json::to_vec(&call.arguments).unwrap();
        let summary = clawmaster_rpa_native::native_rpa::approval_summary(&call);
        Request {
            call_id: call.id,
            tool: call.name,
            root: "unused".into(),
            summary,
            arguments_sha256: hex::encode(Sha256::digest(canonical)),
            arguments: call.arguments,
        }
    }

    #[tokio::test]
    async fn allowed_request_dispatches_exactly_once_and_replay_is_refused() {
        let state = BrokerState::default();
        let dispatched = Arc::new(AtomicUsize::new(0));
        let prompts = Arc::new(AtomicUsize::new(0));
        let first_request = request();
        let first_dispatched = Arc::clone(&dispatched);
        let first_prompts = Arc::clone(&prompts);
        assert_eq!(
            confirm_and_dispatch(
                &state,
                &first_request,
                || async move {
                    first_prompts.fetch_add(1, Ordering::SeqCst);
                    Ok(true)
                },
                || async move {
                    first_dispatched.fetch_add(1, Ordering::SeqCst);
                    Ok(json!({"ok":true}))
                },
            )
            .await
            .unwrap(),
            json!({"ok":true}),
        );
        let replay_request = request();
        let replay_dispatched = Arc::clone(&dispatched);
        let replay_prompts = Arc::clone(&prompts);
        assert!(confirm_and_dispatch(
            &state,
            &replay_request,
            || async move {
                replay_prompts.fetch_add(1, Ordering::SeqCst);
                Ok(true)
            },
            || async move {
                replay_dispatched.fetch_add(1, Ordering::SeqCst);
                Ok(json!({"ok":true}))
            },
        )
        .await
        .unwrap_err()
        .contains("already consumed"));
        assert_eq!(prompts.load(Ordering::SeqCst), 1);
        assert_eq!(dispatched.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn deny_cancel_dialog_failure_and_hash_mismatch_never_dispatch() {
        let dispatched = Arc::new(AtomicUsize::new(0));
        let state = BrokerState::default();
        let make_dispatch = || {
            let count = Arc::clone(&dispatched);
            move || async move {
                count.fetch_add(1, Ordering::SeqCst);
                Ok::<Value, String>(Value::Null)
            }
        };

        let denied =
            confirm_and_dispatch(&state, &request(), || async { Ok(false) }, make_dispatch()).await;
        assert!(denied.unwrap_err().contains("denied"));

        let cancelled_state = BrokerState::default();
        let cancelled_request = request();
        let cancel_id = cancelled_request.call_id.clone();
        let cancel_state = cancelled_state.clone();
        let cancelled = confirm_and_dispatch(
            &cancelled_state,
            &cancelled_request,
            move || async move {
                cancel_state.cancelled.lock().unwrap().insert(cancel_id);
                Ok(true)
            },
            make_dispatch(),
        )
        .await;
        assert!(cancelled.unwrap_err().contains("cancelled before dispatch"));

        let failed = confirm_and_dispatch(
            &BrokerState::default(),
            &request(),
            || async { Err("dialog failure".into()) },
            make_dispatch(),
        )
        .await;
        assert_eq!(failed.unwrap_err(), "dialog failure");

        let mut tampered = request();
        tampered.arguments_sha256 = "00".repeat(32);
        let mismatch = confirm_and_dispatch(
            &BrokerState::default(),
            &tampered,
            || async { Ok(true) },
            make_dispatch(),
        )
        .await;
        assert!(mismatch.unwrap_err().contains("changed in transit"));
        assert_eq!(dispatched.load(Ordering::SeqCst), 0);
    }
}
