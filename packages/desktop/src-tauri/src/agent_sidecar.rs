use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::net::{IpAddr, Ipv4Addr, SocketAddr, TcpListener, TcpStream};
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};

pub struct AgentSidecar {
    child: Mutex<Option<Child>>,
    endpoint_path: PathBuf,
}

fn endpoint_belongs_to_pid(raw: &str, pid: u32) -> bool {
    serde_json::from_str::<serde_json::Value>(raw)
        .ok()
        .and_then(|value| value.get("pid").and_then(serde_json::Value::as_u64))
        .is_some_and(|endpoint_pid| endpoint_pid == u64::from(pid))
}

fn ensure_custody_key(home: &Path) -> Result<PathBuf, Box<dyn std::error::Error>> {
    let directory = home.join(".otto-user/custody");
    fs::create_dir_all(&directory)?;
    fs::set_permissions(&directory, fs::Permissions::from_mode(0o700))?;
    let key = directory.join("database-sqlcipher.key");
    if !key.exists() {
        let mut random = [0_u8; 32];
        OpenOptions::new()
            .read(true)
            .open("/dev/urandom")?
            .read_exact(&mut random)?;
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&key)
        {
            Ok(mut file) => file.write_all(&random)?,
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error.into()),
        }
        random.fill(0);
    }
    Ok(key)
}

fn find_sidecar(main_executable: &Path) -> Result<PathBuf, Box<dyn std::error::Error>> {
    let directory = main_executable
        .parent()
        .ok_or("ClawMaster executable has no parent directory")?;
    ["clawmaster-node", "clawmaster-node-aarch64-apple-darwin"]
        .into_iter()
        .map(|name| directory.join(name))
        .find(|candidate| candidate.is_file())
        .ok_or_else(|| "packaged ClawMaster Node sidecar is missing".into())
}

fn allocate_loopback_port() -> Result<u16, Box<dyn std::error::Error>> {
    let listener = TcpListener::bind(("127.0.0.1", 0))?;
    Ok(listener.local_addr()?.port())
}

fn endpoint_port_for_pid(raw: &str, pid: u32) -> Option<u16> {
    let value = serde_json::from_str::<serde_json::Value>(raw).ok()?;
    let host = value.get("host")?.as_str()?;
    if !matches!(host, "127.0.0.1" | "localhost") {
        return None;
    }
    let endpoint_pid = value.get("pid")?.as_u64()?;
    if endpoint_pid != u64::from(pid) {
        return None;
    }
    u16::try_from(value.get("port")?.as_u64()?)
        .ok()
        .filter(|port| *port > 0)
}

fn wait_until_ready(child: &mut Child, endpoint_path: &Path) -> Result<(), String> {
    let deadline = Instant::now() + Duration::from_secs(20);
    while Instant::now() < deadline {
        if let Some(status) = child
            .try_wait()
            .map_err(|error| format!("failed to inspect Agent sidecar: {error}"))?
        {
            return Err(format!("Agent sidecar exited before startup: {status}"));
        }
        let ready = fs::read_to_string(endpoint_path)
            .ok()
            .and_then(|raw| endpoint_port_for_pid(&raw, child.id()))
            .is_some_and(|port| {
                let address = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port);
                TcpStream::connect_timeout(&address, Duration::from_millis(250)).is_ok()
            });
        if ready {
            return Ok(());
        }
        thread::sleep(Duration::from_millis(100));
    }
    let _ = child.kill();
    let _ = child.wait();
    Err("Agent sidecar did not become ready within 20 seconds".into())
}

/// Start the packaged Agent service before the renderer attempts WebSocket discovery.
/// Failure is fatal: opening an interface without its runtime would create an empty shell.
pub fn spawn(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let resources = app.path().resource_dir()?.join("runtime");
    let server = resources.join("agent/server.mjs");
    let sqlcipher = resources.join("sqlcipher/better_sqlite3.node");
    let ripgrep = resources.join("ripgrep/rg");
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .ok_or("HOME is unavailable for Agent custody")?;
    for required in [&server, &sqlcipher, &ripgrep] {
        if !required.is_file() {
            return Err(format!("packaged Agent runtime is missing {}", required.display()).into());
        }
    }
    let sidecar = find_sidecar(&std::env::current_exe()?)?;
    let custody_key = ensure_custody_key(&home)?;
    let user_directory = home.join(".otto-user");
    let logs_directory = user_directory.join("logs");
    fs::create_dir_all(&logs_directory)?;
    fs::set_permissions(&logs_directory, fs::Permissions::from_mode(0o700))?;
    let log = OpenOptions::new()
        .create(true)
        .append(true)
        .mode(0o600)
        .open(logs_directory.join("tauri-agent.log"))?;
    let error_log = log.try_clone()?;
    let port = allocate_loopback_port()?;
    let endpoint_path = home.join(".otto-user/server-endpoint.json");
    let mut child = Command::new(sidecar)
        .arg(server)
        .arg("start")
        .current_dir(&home)
        .env_clear()
        .env("HOME", &home)
        .env("PWD", &home)
        .env("PATH", std::env::var_os("PATH").unwrap_or_default())
        .env("TMPDIR", std::env::temp_dir())
        .env(
            "LANG",
            std::env::var_os("LANG").unwrap_or_else(|| "C.UTF-8".into()),
        )
        .env("CLAWMASTER_RESOURCES_PATH", &resources)
        .env("OTTO_RIPGREP_BINARY", &ripgrep)
        .env("OTTO_SQLCIPHER_NATIVE_BINDING", &sqlcipher)
        .env("OTTO_DATABASE_ENCRYPTION_KEY_FILE", custody_key)
        .env("OTTO_DATABASE_ENCRYPTION_KEY_ID", "desktop-local-custody")
        .env("OTTO_SERVER_PORT", port.to_string())
        .env("OTTO_USER_DIR", user_directory)
        .stdin(Stdio::null())
        .stdout(Stdio::from(log))
        .stderr(Stdio::from(error_log))
        .spawn()?;
    wait_until_ready(&mut child, &endpoint_path)?;
    app.manage(AgentSidecar {
        child: Mutex::new(Some(child)),
        endpoint_path,
    });
    Ok(())
}

pub fn stop(app: &AppHandle) {
    let Some(sidecar) = app.try_state::<AgentSidecar>() else {
        return;
    };
    let Ok(mut guard) = sidecar.child.lock() else {
        return;
    };
    let Some(mut child) = guard.take() else {
        return;
    };
    let pid = child.id();
    let _ = child.kill();
    let _ = child.wait();
    let owns_endpoint = fs::read_to_string(&sidecar.endpoint_path)
        .map(|raw| endpoint_belongs_to_pid(&raw, pid))
        .unwrap_or(false);
    if owns_endpoint {
        let _ = fs::remove_file(&sidecar.endpoint_path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sidecar_lookup_rejects_an_empty_shell() {
        let executable = std::env::temp_dir()
            .join("clawmaster-missing-sidecar")
            .join("ClawMaster");
        assert!(find_sidecar(&executable)
            .unwrap_err()
            .to_string()
            .contains("missing"));
    }

    #[test]
    fn allocates_a_real_dynamic_loopback_port() {
        assert_ne!(allocate_loopback_port().unwrap(), 0);
    }

    #[test]
    fn endpoint_cleanup_only_targets_the_spawned_process() {
        let raw = r#"{"host":"127.0.0.1","port":7637,"pid":42}"#;
        assert!(endpoint_belongs_to_pid(raw, 42));
        assert!(!endpoint_belongs_to_pid(raw, 43));
        assert!(!endpoint_belongs_to_pid("not-json", 42));
    }

    #[test]
    fn ready_endpoint_must_be_loopback_and_match_the_spawned_pid() {
        let ready = r#"{"host":"127.0.0.1","port":7637,"pid":42}"#;
        assert_eq!(endpoint_port_for_pid(ready, 42), Some(7637));
        assert_eq!(endpoint_port_for_pid(ready, 43), None);
        assert_eq!(
            endpoint_port_for_pid(r#"{"host":"example.com","port":7637,"pid":42}"#, 42),
            None,
        );
    }
}
