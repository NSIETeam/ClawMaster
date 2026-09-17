//! Apply updater selections before Host startup without making optional maintenance a launch prerequisite.

use std::fs;
use std::path::Path;
use std::process::Stdio;
use std::time::Duration;

use super::provision::RuntimePaths;

/// The helper is part of the provisioned, verified desktop bundle, never the candidate component.
pub async fn before_host_start(paths: &RuntimePaths) -> Result<(), String> {
    let helper = paths
        .harness_root
        .join("frontends/updates/dist/maintenance.mjs");
    if !helper.is_file() {
        return allow_start_without_maintenance(&paths.dsh_home, "the helper is missing");
    }
    let mut command = tokio::process::Command::new(&paths.node_binary);
    command
        .arg(&helper)
        .arg("--dsh-home")
        .arg(&paths.dsh_home)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::inherit())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            return allow_start_without_maintenance(
                &paths.dsh_home,
                &format!("the helper could not start: {error}"),
            )
        }
    };
    let status = match tokio::time::timeout(Duration::from_secs(60), child.wait()).await {
        Ok(Ok(status)) => status,
        Ok(Err(error)) => {
            return allow_start_without_maintenance(
                &paths.dsh_home,
                &format!("the helper result could not be collected: {error}"),
            )
        }
        Err(_) => {
            let _ = child.start_kill();
            let _ = child.wait().await;
            return allow_start_without_maintenance(&paths.dsh_home, "the helper timed out");
        }
    };
    if !status.success() {
        return allow_start_without_maintenance(
            &paths.dsh_home,
            &format!("the helper exited with {status}"),
        );
    }
    Ok(())
}

/// Keep a failed updater recovery visible without preventing core application startup.
fn allow_start_without_maintenance(dsh_home: &Path, reason: &str) -> Result<(), String> {
    let recovery = match has_pending_updater_operation(dsh_home) {
        Ok(true) => "an updater recovery remains pending; its journal was left unchanged".to_string(),
        Ok(false) => "no updater recovery is pending".to_string(),
        Err(error) => format!("updater recovery state could not be inspected ({error}); its files were left unchanged"),
    };
    super::boot_log::error(&format!(
        "optional component maintenance was skipped because {reason}; {recovery}; continuing core startup"
    ));
    Ok(())
}

/// Whether updater recovery is required before allowing the Host to read its profile.
fn has_pending_updater_operation(dsh_home: &Path) -> Result<bool, String> {
    let root = dsh_home.join("clawmaster-updates");
    let operations = root.join("operations");
    for path in [dsh_home, root.as_path(), operations.as_path()] {
        let metadata = match fs::symlink_metadata(path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
            Err(error) => return Err(format!("Cannot inspect updater state: {error}")),
        };
        let file_type = metadata.file_type();
        if !file_type.is_dir() || file_type.is_symlink() {
            return Err("Updater state directories must be real directories".into());
        }
    }
    for entry in fs::read_dir(&operations)
        .map_err(|error| format!("Cannot inspect updater operations: {error}"))?
    {
        let entry = entry.map_err(|error| format!("Cannot inspect updater operation: {error}"))?;
        if entry
            .path()
            .extension()
            .and_then(|extension| extension.to_str())
            != Some("json")
        {
            continue;
        }
        let metadata = fs::symlink_metadata(entry.path())
            .map_err(|error| format!("Cannot inspect updater operation: {error}"))?;
        let file_type = metadata.file_type();
        if !file_type.is_file() || file_type.is_symlink() || metadata.len() > 1024 * 1024 {
            return Err("Updater operation records must be bounded regular files".into());
        }
        let bytes = fs::read(entry.path())
            .map_err(|error| format!("Cannot read updater operation: {error}"))?;
        let record: serde_json::Value = serde_json::from_slice(&bytes)
            .map_err(|error| format!("Cannot validate updater operation: {error}"))?;
        let id = record["id"]
            .as_str()
            .ok_or("Updater operation has no component id")?;
        let activation = record["activation"]
            .as_str()
            .ok_or("Updater operation has no activation mode")?;
        let state = record["state"]
            .as_str()
            .ok_or("Updater operation has no state")?;
        if !matches!(activation, "hot" | "restart") {
            return Err("Updater operation has an unknown activation mode".into());
        }
        if !matches!(
            state,
            "staged"
                | "applied"
                | "switching"
                | "awaiting-health"
                | "completed"
                | "rolled-back"
                | "blocked"
        ) {
            return Err("Updater operation has an unknown state".into());
        }
        if id == "updates"
            && activation == "restart"
            && matches!(state, "staged" | "switching" | "awaiting-health")
        {
            return Ok(true);
        }
    }
    Ok(false)
}

#[cfg(test)]
mod tests {
    use std::fs;

    use super::*;
    use crate::runtime::provision::RuntimePaths;

    fn paths(root: &Path) -> RuntimePaths {
        RuntimePaths {
            node_binary: root.join("node"),
            pnpm_binary: root.join("pnpm"),
            cli_entry: root.join("cli.js"),
            harness_root: root.join("harness"),
            runtime_root: root.join("runtime"),
            dsh_home: root.join("home"),
        }
    }

    #[tokio::test]
    async fn missing_maintenance_helper_allows_host_start_when_no_update_needs_recovery() {
        let root = tempfile::tempdir().unwrap();
        assert_eq!(before_host_start(&paths(root.path())).await, Ok(()));
    }

    #[test]
    fn failed_optional_maintenance_allows_core_start_without_pending_update() {
        let root = tempfile::tempdir().unwrap();
        assert_eq!(
            allow_start_without_maintenance(root.path(), "test failure"),
            Ok(())
        );
    }

    #[test]
    fn failed_optional_maintenance_keeps_pending_update_and_allows_core_start() {
        let root = tempfile::tempdir().unwrap();
        let operations = root.path().join("clawmaster-updates/operations");
        fs::create_dir_all(&operations).unwrap();
        fs::write(
            operations.join("pending.json"),
            r#"{"id":"updates","activation":"restart","state":"awaiting-health"}"#,
        )
        .unwrap();
        let journal = operations.join("pending.json");
        let original = fs::read(&journal).unwrap();
        assert_eq!(
            allow_start_without_maintenance(root.path(), "test failure"),
            Ok(())
        );
        assert_eq!(fs::read(journal).unwrap(), original);
    }

    #[tokio::test]
    async fn missing_maintenance_helper_keeps_pending_updater_recovery_and_allows_host_start() {
        let root = tempfile::tempdir().unwrap();
        let runtime = paths(root.path());
        let operations = runtime.dsh_home.join("clawmaster-updates/operations");
        fs::create_dir_all(&operations).unwrap();
        fs::write(
            operations.join("pending.json"),
            r#"{"id":"updates","activation":"restart","state":"switching"}"#,
        )
        .unwrap();
        let journal = operations.join("pending.json");
        let original = fs::read(&journal).unwrap();
        assert_eq!(before_host_start(&runtime).await, Ok(()));
        assert_eq!(fs::read(journal).unwrap(), original);
    }

    #[tokio::test]
    async fn failed_maintenance_helper_keeps_pending_update_and_allows_host_start() {
        let root = tempfile::tempdir().unwrap();
        let mut runtime = paths(root.path());
        let helper = runtime
            .harness_root
            .join("frontends/updates/dist/maintenance.mjs");
        fs::create_dir_all(helper.parent().unwrap()).unwrap();
        fs::write(helper, "export {};").unwrap();
        let operations = runtime.dsh_home.join("clawmaster-updates/operations");
        fs::create_dir_all(&operations).unwrap();
        let journal = operations.join("pending.json");
        fs::write(
            &journal,
            r#"{"id":"updates","activation":"restart","state":"awaiting-health"}"#,
        )
        .unwrap();
        let original = fs::read(&journal).unwrap();

        runtime.node_binary = root.path().join("missing-node");
        assert_eq!(before_host_start(&runtime).await, Ok(()));
        assert_eq!(fs::read(journal).unwrap(), original);
    }

    #[tokio::test]
    async fn missing_maintenance_helper_allows_completed_updater_records() {
        let root = tempfile::tempdir().unwrap();
        let runtime = paths(root.path());
        let operations = runtime.dsh_home.join("clawmaster-updates/operations");
        fs::create_dir_all(&operations).unwrap();
        fs::write(
            operations.join("completed.json"),
            r#"{"id":"updates","activation":"restart","state":"completed"}"#,
        )
        .unwrap();
        assert_eq!(before_host_start(&runtime).await, Ok(()));
    }

    #[tokio::test]
    async fn missing_maintenance_helper_keeps_corrupt_operation_records_and_allows_host_start() {
        let root = tempfile::tempdir().unwrap();
        let runtime = paths(root.path());
        let operations = runtime.dsh_home.join("clawmaster-updates/operations");
        fs::create_dir_all(&operations).unwrap();
        fs::write(operations.join("unreadable.json"), "{").unwrap();
        let journal = operations.join("unreadable.json");
        assert_eq!(fs::read(&journal).unwrap(), b"{");
        assert_eq!(before_host_start(&runtime).await, Ok(()));
        assert_eq!(fs::read(journal).unwrap(), b"{");
    }

    #[test]
    fn unknown_updater_operation_state_does_not_prevent_core_start() {
        let root = tempfile::tempdir().unwrap();
        let operations = root.path().join("clawmaster-updates/operations");
        fs::create_dir_all(&operations).unwrap();
        fs::write(
            operations.join("unknown.json"),
            r#"{"id":"updates","activation":"restart","state":"corrupt-state"}"#,
        )
        .unwrap();
        let journal = operations.join("unknown.json");
        let original = fs::read(&journal).unwrap();
        assert_eq!(
            allow_start_without_maintenance(root.path(), "test failure"),
            Ok(())
        );
        assert_eq!(fs::read(journal).unwrap(), original);
    }
}
