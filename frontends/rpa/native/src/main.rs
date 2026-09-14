//! ClawMaster RPA native helper.
//!
//! The pre-DSH desktop binary served two roles from one executable: it answered
//! `--native-tool <name>` on the command line and otherwise started the GUI.
//! The GUI role belongs to ClawMaster's Tauri shell now, so this binary keeps
//! only the command-line role that the RPA host half drives.
//!
//! The contract is unchanged from the recovered implementation: JSON on stdout,
//! a human-readable error on stderr, exit code 2 for a failed native operation.

/// Print the RPA tool catalog the recovered control plane already declares.
///
/// It is answered here rather than inside `native_tools::dispatch_from_args` so
/// that recovered module stays byte-identical to the pre-DSH implementation.
fn print_definitions() -> i32 {
    match serde_json::to_string(&clawmaster_rpa_native::native_rpa::definitions()) {
        Ok(json) => {
            println!("{json}");
            0
        }
        Err(error) => {
            eprintln!("{error}");
            2
        }
    }
}

/// Answer whether a tool needs approval, and with what wording.
///
/// The host half asks this before running a tool so it can raise the recovered
/// prompt through the harness approval capability. It executes nothing: the
/// classification and the wording stay here, next to `is_write`, instead of
/// being duplicated in TypeScript where they could drift.
fn print_approval_request(tool: Option<&String>, arguments: Option<&String>) -> i32 {
    let Some(tool) = tool else {
        eprintln!("approval-request requires a tool name");
        return 64;
    };
    let arguments: serde_json::Value = match arguments {
        Some(json) => match serde_json::from_str(json) {
            Ok(value) => value,
            Err(error) => {
                eprintln!("approval-request arguments are not JSON: {error}");
                return 64;
            }
        },
        None => serde_json::Value::Object(serde_json::Map::new()),
    };
    let call = clawmaster_rpa_native::native_models::ModelToolCall {
        id: "approval-request".to_string(),
        name: tool.clone(),
        arguments,
    };
    let report = serde_json::json!({
        "write": clawmaster_rpa_native::native_rpa::is_write_call(&call),
        "summary": clawmaster_rpa_native::native_rpa::approval_summary(&call),
    });
    match serde_json::to_string(&report) {
        Ok(json) => {
            println!("{json}");
            0
        }
        Err(error) => {
            eprintln!("{error}");
            2
        }
    }
}

/// Run one recovered `rpa_*` tool call and print its canonical JSON result.
///
/// The request arrives as a single JSON argument, so a tool's arguments never
/// pass through a shell and never need quoting.
fn run_rpa_call(request_json: Option<&String>) -> i32 {
    let Some(request_json) = request_json else {
        eprintln!("rpa-call requires a JSON request argument");
        return 64;
    };
    match clawmaster_rpa_native::rpa_cli::run_blocking(request_json) {
        Ok(value) => match serde_json::to_string(&value) {
            Ok(json) => {
                println!("{json}");
                0
            }
            Err(error) => {
                eprintln!("{error}");
                2
            }
        },
        Err(error) => {
            eprintln!("{error}");
            2
        }
    }
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let subcommand = if args.first().map(String::as_str) == Some("--native-tool") {
        args.get(1).map(String::as_str)
    } else {
        None
    };

    if subcommand == Some("definitions") {
        std::process::exit(print_definitions());
    }

    if subcommand == Some("rpa-call") {
        std::process::exit(run_rpa_call(args.get(2)));
    }

    if subcommand == Some("approval-request") {
        std::process::exit(print_approval_request(args.get(2), args.get(3)));
    }

    match clawmaster_rpa_native::native_tools::dispatch_from_args(&args) {
        Some(Ok(())) => {}
        Some(Err(error)) => {
            eprintln!("{error}");
            std::process::exit(2);
        }
        None => {
            eprintln!(
                "usage: clawmaster-rpa-native --native-tool <capabilities|definitions|desktop-snapshot|input|pdf-merge|pdf-optimize|...>"
            );
            std::process::exit(64);
        }
    }
}
