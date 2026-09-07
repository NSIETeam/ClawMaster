use super::*;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

struct RecordingHost<'a> {
    runtime: &'a NativeRuntime,
    outcome: &'static str,
    frames: Mutex<Vec<Value>>,
    grants: Mutex<Vec<PathBuf>>,
    files: crate::system_commands::DesktopFileState,
}

impl NativeLoopHost for RecordingHost<'_> {
    fn emit_event(&self, name: &str, payload: Value) -> Result<(), String> {
        assert_eq!(name, "desktop://server-frame");
        self.frames.lock().unwrap().push(payload.clone());
        if payload["type"] == "tool_confirmation_request" {
            self.runtime.handle(&frame(
                "tool_confirmation_response",
                json!({
                    "sessionId": payload["payload"]["sessionId"],
                    "callId": payload["payload"]["callId"],
                    "outcome": self.outcome,
                }),
            ))?;
        }
        Ok(())
    }

    fn desktop_app(&self) -> Result<&AppHandle, String> {
        Err("Desktop-only tools are unavailable in the loop fixture".into())
    }

    fn grant_generated_file(&self, workspace: &Path, path: &Path) -> Result<(), String> {
        self.files.grant_generated_file(workspace, path)?;
        self.grants.lock().unwrap().push(path.to_path_buf());
        Ok(())
    }
}

async fn read_request(socket: &mut tokio::net::TcpStream) -> Value {
    let mut bytes = Vec::new();
    let (start, length) = loop {
        let mut chunk = [0; 4096];
        let count = socket.read(&mut chunk).await.unwrap();
        assert!(count > 0, "HTTP request ended before headers");
        bytes.extend_from_slice(&chunk[..count]);
        assert!(bytes.len() < 1024 * 1024, "fixture request too large");
        if let Some(end) = bytes.windows(4).position(|part| part == b"\r\n\r\n") {
            let headers = std::str::from_utf8(&bytes[..end]).unwrap();
            let length = headers
                .lines()
                .find_map(|line| {
                    let (key, value) = line.split_once(':')?;
                    key.eq_ignore_ascii_case("content-length")
                        .then(|| value.trim().parse::<usize>().unwrap())
                })
                .expect("request content-length");
            assert!(length < 1024 * 1024);
            break (end + 4, length);
        }
    };
    while bytes.len() < start + length {
        let mut chunk = [0; 4096];
        let count = socket.read(&mut chunk).await.unwrap();
        assert!(count > 0, "HTTP request body truncated");
        bytes.extend_from_slice(&chunk[..count]);
    }
    serde_json::from_slice(&bytes[start..start + length]).unwrap()
}

fn tool_delta(name: &str, arguments: Value, text: &str) -> Value {
    // Some providers reuse this ID across rounds. The production loop must scope it.
    json!({"choices":[{"delta":{"content":text,"tool_calls":[{
        "index":0,"id":"call_0","function":{"name":name,"arguments":arguments.to_string()}
    }]},"finish_reason":"tool_calls"}]})
}

async fn exercise_production_loop(outcome: &'static str) {
    let (_root, runtime) = tests::runtime();
    runtime
        .credentials
        .set("loop-fixture", "local-fixture-only")
        .unwrap();
    let workspace = tempfile::tempdir().unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base_url = format!("http://{}/v1", listener.local_addr().unwrap());
    let final_text = if outcome == "approved" {
        "Created three slides."
    } else {
        "Write denied."
    };
    let responses = vec![
        tool_delta("native_capabilities", json!({}), "Checking capabilities."),
        tool_delta(
            "generate_pptx",
            json!({
                "outputPath":"result.pptx", "title":"Loop regression",
                "content":"# One\nFirst\n---\n# Two\nSecond\n---\n# Three\nThird"
            }),
            "Generating the file.",
        ),
        json!({"choices":[{"delta":{"content":final_text},"finish_reason":"stop"}]}),
    ];
    let server = async move {
        let mut requests = Vec::new();
        for delta in responses {
            let (mut socket, _) = listener.accept().await.unwrap();
            requests.push(read_request(&mut socket).await);
            let body = format!("data: {delta}\n\ndata: [DONE]\n\n");
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()
            );
            socket.write_all(response.as_bytes()).await.unwrap();
        }
        requests
    };
    let model = NativeModel {
        id: "loop-fixture".into(),
        display_name: "Loop fixture".into(),
        provider: "openai".into(),
        base_url,
        model_id: "loop-fixture".into(),
        max_tokens: None,
        enabled: true,
        credential_id: "loop-fixture".into(),
    };
    let host = RecordingHost {
        runtime: &runtime,
        outcome,
        frames: Mutex::new(Vec::new()),
        grants: Mutex::new(Vec::new()),
        files: Default::default(),
    };
    let mut turn = runtime
        .runtime_kernel
        .create_turn_for_session("loop-turn", Some("loop-session"), now_ms())
        .unwrap();
    runtime
        .runtime_kernel
        .transition_turn(&mut turn, TurnState::Planning, "test planning", now_ms())
        .unwrap();
    let (_cancel_sender, cancel) = watch::channel(false);
    let run = runtime.run_model_tool_loop(
        ToolLoopContext {
            app: &host,
            session_id: "loop-session",
            message_id: "loop-message",
            model: &model,
            turn_id: "loop-turn",
            workspace: workspace.path(),
            enabled_capabilities: None,
        },
        vec![ModelMessage {
            role: "user".into(),
            text: "Check native_capabilities then generate_pptx with three slides.".into(),
        }],
        cancel,
        &mut turn,
    );
    // Poll both futures together: timeout drops the server as well as the real loop.
    let (result, requests) =
        tokio::time::timeout(Duration::from_secs(20), async { tokio::join!(run, server) })
            .await
            .expect("production tool loop timed out");
    let result = result.unwrap_or_else(|error| panic!("production loop failed: {error}"));
    let StreamCompletion::Completed(completion) = result else {
        panic!("unexpected cancellation")
    };
    assert_eq!(
        completion.text, final_text,
        "intermediate prose leaked into final reply"
    );
    assert_eq!(requests.len(), 3);
    let capabilities = requests[1]["messages"].as_array().unwrap().last().unwrap()["content"]
        .as_str()
        .unwrap();
    for name in [
        "generate_pptx",
        "generate_docx",
        "merge_pdfs",
        "optimize_pdf",
    ] {
        assert!(
            capabilities.contains(name),
            "capability missing from next model request: {name}"
        );
    }
    assert!(!capabilities.contains("generate_document"));
    assert_eq!(turn.tools.len(), 2, "reused provider ID must not collide");
    let frames = host.frames.lock().unwrap();
    assert_eq!(
        frames
            .iter()
            .filter(|frame| frame["type"] == "tool_confirmation_request")
            .count(),
        1
    );
    let output = workspace.path().join("result.pptx");
    let grants = host.grants.lock().unwrap();
    let results = frames
        .iter()
        .filter(|frame| frame["type"] == "runtime_event")
        .filter_map(|frame| {
            let envelope: RuntimeEventEnvelope =
                serde_json::from_value(frame["payload"]["event"].clone()).unwrap();
            match envelope.payload {
                RuntimeEventPayload::ToolResult {
                    tool_call_id,
                    status,
                    result,
                } => Some((tool_call_id, status, result)),
                _ => None,
            }
        })
        .collect::<Vec<_>>();
    assert_eq!(results.len(), 2);
    assert_ne!(results[0].0, results[1].0);
    assert_eq!(results[0].1, ToolStatus::Succeeded);
    if outcome == "approved" {
        assert!(turn
            .tools
            .values()
            .all(|tool| tool.state == ToolState::Success));
        let mut zip = zip::ZipArchive::new(fs::File::open(&output).unwrap()).unwrap();
        for index in 1..=3 {
            assert!(zip.by_name(&format!("ppt/slides/slide{index}.xml")).is_ok());
        }
        assert!(zip.by_name("ppt/slides/slide4.xml").is_err());
        assert_eq!(*grants, vec![output.canonicalize().unwrap()]);
        assert_eq!(results[1].1, ToolStatus::Succeeded);
        assert_eq!(
            results[1].2["generatedFile"]["path"],
            json!(output.canonicalize().unwrap())
        );
    } else {
        assert!(!output.exists(), "denied write created a file");
        assert!(grants.is_empty());
        assert!(matches!(
            results[1].1,
            ToolStatus::Failed | ToolStatus::Cancelled
        ));
        assert!(results
            .iter()
            .all(|(_, _, result)| result.get("generatedFile").is_none()));
        assert!(turn
            .tools
            .values()
            .any(|tool| tool.state != ToolState::Success));
    }
    assert!(runtime.pending_confirmations.lock().unwrap().is_empty());
}

#[tokio::test]
async fn production_loop_discovers_generates_and_grants_after_approval() {
    exercise_production_loop("approved").await;
}

#[tokio::test]
async fn production_loop_denial_never_writes_or_grants_a_file() {
    exercise_production_loop("denied").await;
}
