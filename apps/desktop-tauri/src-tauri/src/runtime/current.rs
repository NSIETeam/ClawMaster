//! Desktop-owned live Host identity, separate from provisioning and remembered facts.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use super::provision::RuntimePaths;

pub struct CurrentRuntime {
    path: PathBuf,
    record: serde_json::Value,
}

pub fn state_path(home: &Path) -> PathBuf {
    home.join("desktop").join("current-runtime.json")
}

pub fn new_run_id() -> Result<String, String> {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?;
    Ok(format!("{}-{}", std::process::id(), stamp.as_nanos()))
}

impl CurrentRuntime {
    /// Publish only after the owned Host has passed the readiness check.
    pub fn ready(
        paths: &RuntimePaths,
        pid: u32,
        port: u16,
        disabled: &[String],
        run_id: &str,
    ) -> Result<Self, String> {
        let bundle: serde_json::Value = serde_json::from_slice(
            &fs::read(paths.harness_root.join(".bundle-manifest.json"))
                .map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
        let hash = bundle["contentSha256"]
            .as_str()
            .filter(|s| s.len() == 64)
            .ok_or("Runtime bundle has no content digest")?;
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|e| e.to_string())?;
        let record = serde_json::json!({
            "schemaVersion": 1,
            "runId": run_id,
            "status": "ready",
            "observedAtUnixMs": stamp.as_millis(),
            "desktopVersion": env!("CARGO_PKG_VERSION"),
            "desktopPid": std::process::id(),
            "hostPid": pid,
            "port": port,
            "harnessRoot": paths.harness_root,
            "contentSha256": hash,
            "harnessVersion": bundle["harnessVersion"],
            "buildProvenance": bundle["buildProvenance"],
            "disabledPlugins": disabled,
        });
        let current = Self {
            path: state_path(&paths.dsh_home),
            record,
        };
        let _lock = lock_state(&current.path)?;
        write_private(&current.path, &current.record)?;
        Ok(current)
    }

    /// An older Host's teardown cannot mark its successor stopped.
    pub fn stopped(&self) -> Result<(), String> {
        let _lock = lock_state(&self.path)?;
        let stored: serde_json::Value =
            serde_json::from_slice(&fs::read(&self.path).map_err(|e| e.to_string())?)
                .map_err(|e| e.to_string())?;
        if stored["runId"] != self.record["runId"] {
            return Ok(());
        }
        let mut record = self.record.clone();
        record["status"] = "stopped".into();
        record["observedAtUnixMs"] = u64::try_from(
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_err(|e| e.to_string())?
                .as_millis(),
        )
        .map_err(|e| e.to_string())?
        .into();
        write_private(&self.path, &record)
    }
}

/// The OS releases this cross-process lock if a desktop exits during publication.
fn lock_state(path: &Path) -> Result<fs::File, String> {
    let parent = path.parent().ok_or("Runtime state has no parent")?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    if fs::symlink_metadata(parent)
        .map_err(|e| e.to_string())?
        .file_type()
        .is_symlink()
    {
        return Err("Runtime state directory cannot be a symbolic link".into());
    }
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
    }
    let file = options
        .open(parent.join("current-runtime.lock"))
        .map_err(|e| e.to_string())?;
    file.lock().map_err(|e| e.to_string())?;
    Ok(file)
}

fn write_private(path: &Path, value: &serde_json::Value) -> Result<(), String> {
    let parent = path.parent().ok_or("Runtime state has no parent")?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    if fs::symlink_metadata(parent)
        .map_err(|e| e.to_string())?
        .file_type()
        .is_symlink()
    {
        return Err("Runtime state directory cannot be a symbolic link".into());
    }
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_nanos();
    let temporary = parent.join(format!(
        ".current-runtime-{}-{nonce}.tmp",
        std::process::id()
    ));
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&temporary).map_err(|e| e.to_string())?;
    let result = (|| {
        writeln!(
            file,
            "{}",
            serde_json::to_string_pretty(value).map_err(|e| e.to_string())?
        )
        .map_err(|e| e.to_string())?;
        file.sync_all().map_err(|e| e.to_string())?;
        drop(file);
        fs::rename(&temporary, path).map_err(|e| e.to_string())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn records_ready_and_stopped_without_overwriting_a_successor() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root =
            std::env::temp_dir().join(format!("clawmaster-current-{}-{nonce}", std::process::id()));
        fs::create_dir(&root).unwrap();
        struct Cleanup(PathBuf);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                let _ = fs::remove_dir_all(&self.0);
            }
        }
        let _cleanup = Cleanup(root.clone());
        let paths = RuntimePaths {
            node_binary: "node".into(),
            pnpm_binary: "pnpm".into(),
            cli_entry: root.join("bin.js"),
            harness_root: root.clone(),
            runtime_root: root.clone(),
            dsh_home: root.clone(),
        };
        assert!(CurrentRuntime::ready(&paths, 1, 17890, &[], "first").is_err());
        fs::write(
            root.join(".bundle-manifest.json"),
            serde_json::json!({"contentSha256": "a".repeat(64), "harnessVersion": "fixture"})
                .to_string(),
        )
        .unwrap();
        let old = CurrentRuntime::ready(&paths, 1, 17890, &[], "first").unwrap();
        let new = CurrentRuntime::ready(&paths, 2, 17891, &[], "second").unwrap();
        old.stopped().unwrap();
        let read = || {
            serde_json::from_slice::<serde_json::Value>(&fs::read(state_path(&root)).unwrap())
                .unwrap()
        };
        assert_eq!(read()["hostPid"], 2);
        assert_eq!(read()["status"], "ready");
        new.stopped().unwrap();
        assert_eq!(read()["status"], "stopped");
        let lock = lock_state(&state_path(&root)).unwrap();
        let contender = OpenOptions::new()
            .read(true)
            .write(true)
            .open(root.join("desktop/current-runtime.lock"))
            .unwrap();
        assert!(matches!(
            contender.try_lock(),
            Err(std::fs::TryLockError::WouldBlock)
        ));
        drop(lock);
        contender.try_lock().unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(state_path(&root))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
    }
}
