use serde::Deserialize;
use sha2::{Digest, Sha256};
use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::net::{IpAddr, Ipv4Addr, SocketAddr, TcpListener, TcpStream};
#[cfg(unix)]
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
    node_runtime: PathBuf,
    resources: PathBuf,
    user_directory: PathBuf,
}

impl AgentSidecar {
    pub fn is_running(&self) -> bool {
        let Ok(mut child) = self.child.lock() else {
            return false;
        };
        child
            .as_mut()
            .is_some_and(|process| matches!(process.try_wait(), Ok(None)))
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BinaryCapsuleManifest {
    schema_version: u32,
    target: String,
    sha256: String,
    executable_bytes: u64,
    compressed_bytes: u64,
}

fn runtime_target() -> &'static str {
    if cfg!(all(target_os = "macos", target_arch = "aarch64")) {
        "darwin-arm64"
    } else if cfg!(all(target_os = "macos", target_arch = "x86_64")) {
        "darwin-x64"
    } else if cfg!(all(target_os = "windows", target_arch = "x86_64")) {
        "win32-x64"
    } else {
        "unsupported"
    }
}

fn hash_file(path: &Path) -> Result<(u64, String), Box<dyn std::error::Error>> {
    let mut file = fs::File::open(path)?;
    let mut digest = Sha256::new();
    let mut total = 0_u64;
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        digest.update(&buffer[..read]);
        total += read as u64;
    }
    Ok((total, format!("{:x}", digest.finalize())))
}

fn cached_binary_is_valid(
    path: &Path,
    manifest: &BinaryCapsuleManifest,
) -> Result<bool, Box<dyn std::error::Error>> {
    if !path.is_file() {
        return Ok(false);
    }
    let (bytes, hash) = hash_file(path)?;
    Ok(bytes == manifest.executable_bytes && hash == manifest.sha256)
}

fn materialize_binary_capsule(
    capsule_root: &Path,
    user_directory: &Path,
    capsule_name: &str,
    manifest_name: &str,
    cache_prefix: &str,
    minimum_bytes: u64,
    executable_suffix: &str,
) -> Result<PathBuf, Box<dyn std::error::Error>> {
    let capsule = capsule_root.join(capsule_name);
    let manifest_path = capsule_root.join(manifest_name);
    if !capsule.is_file() || !manifest_path.is_file() {
        return Err(format!("packaged ClawMaster {cache_prefix} capsule is missing").into());
    }
    let manifest: BinaryCapsuleManifest = serde_json::from_slice(&fs::read(&manifest_path)?)?;
    if manifest.schema_version != 1
        || manifest.target != runtime_target()
        || manifest.sha256.len() != 64
        || manifest.executable_bytes < minimum_bytes
        || manifest.compressed_bytes != fs::metadata(&capsule)?.len()
    {
        return Err(
            format!("packaged ClawMaster {cache_prefix} capsule manifest is invalid").into(),
        );
    }

    let cache_root = user_directory.join("runtime-cache");
    fs::create_dir_all(&cache_root)?;
    set_private_permissions(&cache_root, 0o700)?;
    let target = cache_root.join(format!(
        "{cache_prefix}-{}{executable_suffix}",
        manifest.sha256
    ));
    if cached_binary_is_valid(&target, &manifest)? {
        return Ok(target);
    }

    let pending = cache_root.join(format!(
        ".{cache_prefix}-{}-{}.tmp",
        manifest.sha256,
        std::process::id(),
    ));
    let _ = fs::remove_file(&pending);
    let source = fs::File::open(&capsule)?;
    let mut decompressor = brotli::Decompressor::new(source, 64 * 1024);
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    options.mode(0o700);
    let mut output = options.open(&pending)?;
    let mut digest = Sha256::new();
    let mut total = 0_u64;
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = decompressor.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        output.write_all(&buffer[..read])?;
        digest.update(&buffer[..read]);
        total += read as u64;
    }
    output.sync_all()?;
    drop(output);
    let hash = format!("{:x}", digest.finalize());
    if total != manifest.executable_bytes || hash != manifest.sha256 {
        let _ = fs::remove_file(&pending);
        return Err(format!(
            "packaged ClawMaster {cache_prefix} capsule failed integrity verification"
        )
        .into());
    }
    set_private_permissions(&pending, 0o700)?;
    if target.exists() {
        if cached_binary_is_valid(&target, &manifest)? {
            let _ = fs::remove_file(&pending);
            return Ok(target);
        }
        fs::remove_file(&target)?;
    }
    fs::rename(&pending, &target)?;
    Ok(target)
}

fn materialize_node_capsule(
    resources: &Path,
    user_directory: &Path,
) -> Result<PathBuf, Box<dyn std::error::Error>> {
    materialize_binary_capsule(
        &resources.join("node"),
        user_directory,
        "node.br",
        "node-manifest.json",
        "node",
        1_000_000,
        if cfg!(windows) { ".exe" } else { "" },
    )
}

fn materialize_ripgrep_capsule(
    resources: &Path,
    user_directory: &Path,
) -> Result<PathBuf, Box<dyn std::error::Error>> {
    materialize_binary_capsule(
        &resources.join("ripgrep"),
        user_directory,
        "rg.br",
        "rg-manifest.json",
        "ripgrep",
        1_000_000,
        if cfg!(windows) { ".exe" } else { "" },
    )
}

fn endpoint_belongs_to_pid(raw: &str, pid: u32) -> bool {
    serde_json::from_str::<serde_json::Value>(raw)
        .ok()
        .and_then(|value| value.get("pid").and_then(serde_json::Value::as_u64))
        .is_some_and(|endpoint_pid| endpoint_pid == u64::from(pid))
}

fn product_user_directory(home: &Path) -> PathBuf {
    home.join(".clawmaster-user")
}

fn set_private_permissions(path: &Path, mode: u32) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        fs::set_permissions(path, fs::Permissions::from_mode(mode))?;
    }
    #[cfg(not(unix))]
    {
        let _ = (path, mode);
    }
    Ok(())
}

fn ensure_custody_key(user_directory: &Path) -> Result<PathBuf, Box<dyn std::error::Error>> {
    let directory = user_directory.join("custody");
    fs::create_dir_all(&directory)?;
    set_private_permissions(&directory, 0o700)?;
    let key = directory.join("database-sqlcipher.key");
    if !key.exists() {
        let mut random = [0_u8; 32];
        getrandom::getrandom(&mut random)
            .map_err(|error| format!("secure random generation failed: {error}"))?;
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        options.mode(0o600);
        match options.open(&key) {
            Ok(mut file) => {
                file.write_all(&random)?;
                set_private_permissions(&key, 0o600)?;
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(error.into()),
        }
        random.fill(0);
    }
    Ok(key)
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
    // A populated personal workspace can spend more than 20 seconds opening
    // SQLCipher and restoring local indexes on first launch. Keep rejecting an
    // empty shell, but do not abort the desktop while the healthy local runtime
    // is still completing its bounded startup work.
    let deadline = Instant::now() + Duration::from_secs(60);
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
    Err("Agent sidecar did not become ready within 60 seconds".into())
}

/// Start the packaged Agent service before the renderer attempts WebSocket discovery.
/// Failure is fatal: opening an interface without its runtime would create an empty shell.
pub fn spawn(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let resources = app.path().resource_dir()?.join("runtime");
    let server = resources.join("agent/bootstrap.mjs");
    let sqlcipher = resources.join("sqlcipher/better_sqlite3.node");
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
        .ok_or("user home is unavailable for Agent custody")?;
    for required in [&server, &sqlcipher] {
        if !required.is_file() {
            return Err(format!("packaged Agent runtime is missing {}", required.display()).into());
        }
    }
    let user_directory = product_user_directory(&home);
    let sidecar = materialize_node_capsule(&resources, &user_directory)?;
    let document_runtime = sidecar.clone();
    let ripgrep = materialize_ripgrep_capsule(&resources, &user_directory)?;
    let custody_key = ensure_custody_key(&user_directory)?;
    let logs_directory = user_directory.join("logs");
    fs::create_dir_all(&logs_directory)?;
    set_private_permissions(&logs_directory, 0o700)?;
    let mut log_options = OpenOptions::new();
    log_options.create(true).append(true);
    #[cfg(unix)]
    log_options.mode(0o600);
    let log = log_options.open(logs_directory.join("tauri-agent.log"))?;
    let error_log = log.try_clone()?;
    let port = allocate_loopback_port()?;
    let endpoint_path = user_directory.join("server-endpoint.json");
    let mut command = Command::new(sidecar);
    command
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
        .env("OTTO_RIPGREP_BINARY", ripgrep)
        .env("OTTO_SQLCIPHER_NATIVE_BINDING", &sqlcipher)
        .env("OTTO_DATABASE_ENCRYPTION_KEY_FILE", custody_key)
        .env("OTTO_DATABASE_ENCRYPTION_KEY_ID", "desktop-local-custody")
        .env("OTTO_SERVER_PORT", port.to_string())
        .env("OTTO_USER_DIR", &user_directory)
        .env("CLAWMASTER_USER_DIR", product_user_directory(&home))
        .env("CLAWMASTER_PARENT_PIPE", "1")
        .env("CLAWMASTER_PARENT_PID", std::process::id().to_string())
        // Keep the write end alive inside Child. If the desktop exits for any
        // reason, the OS closes it and bootstrap exits on stdin EOF.
        .stdin(Stdio::piped())
        .stdout(Stdio::from(log))
        .stderr(Stdio::from(error_log));
    for name in ["SystemRoot", "WINDIR", "PATHEXT", "COMSPEC", "TEMP", "TMP"] {
        if let Some(value) = std::env::var_os(name) {
            command.env(name, value);
        }
    }
    let mut child = command.spawn()?;
    wait_until_ready(&mut child, &endpoint_path)?;
    app.manage(AgentSidecar {
        child: Mutex::new(Some(child)),
        endpoint_path,
        node_runtime: document_runtime,
        resources,
        user_directory,
    });
    Ok(())
}

pub fn run_document_worker(
    app: &AppHandle,
    request: &serde_json::Value,
) -> Result<serde_json::Value, String> {
    let state = app
        .try_state::<AgentSidecar>()
        .ok_or_else(|| "Agent sidecar is unavailable".to_string())?;
    let bootstrap = state.resources.join("agent/bootstrap.mjs");
    let mut command = Command::new(&state.node_runtime);
    command
        .arg(bootstrap)
        .arg("document")
        .env_clear()
        .env("HOME", std::env::var_os("HOME").unwrap_or_default())
        .env(
            "USERPROFILE",
            std::env::var_os("USERPROFILE").unwrap_or_default(),
        )
        .env("PATH", std::env::var_os("PATH").unwrap_or_default())
        .env("TMPDIR", std::env::temp_dir())
        .env("TEMP", std::env::temp_dir())
        .env("TMP", std::env::temp_dir())
        .env("CLAWMASTER_RESOURCES_PATH", &state.resources)
        .env("OTTO_USER_DIR", &state.user_directory)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command
        .spawn()
        .map_err(|error| format!("failed to start document worker: {error}"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "document worker stdout is unavailable".to_string())?;
    let output_reader = thread::spawn(move || {
        let mut output = stdout;
        let mut value = String::new();
        output.read_to_string(&mut value).map(|_| value)
    });
    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(request.to_string().as_bytes())
            .map_err(|error| format!("failed to send document request: {error}"))?;
    }
    let deadline = Instant::now() + Duration::from_secs(45);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(25)),
            Ok(None) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err("document conversion exceeded 45 seconds".into());
            }
            Err(error) => return Err(format!("failed to inspect document worker: {error}")),
        }
    }
    let stdout = output_reader
        .join()
        .map_err(|_| "document worker output thread failed".to_string())?
        .map_err(|error| format!("failed to read document result: {error}"))?;
    let response: serde_json::Value = serde_json::from_str(&stdout)
        .map_err(|_| "document worker returned an invalid response".to_string())?;
    if response.get("ok").and_then(serde_json::Value::as_bool) != Some(true) {
        return Err(response
            .get("error")
            .and_then(serde_json::Value::as_str)
            .unwrap_or("document conversion failed")
            .to_string());
    }
    response
        .get("result")
        .cloned()
        .ok_or_else(|| "document worker returned no result".to_string())
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

    #[test]
    fn product_state_is_isolated_from_otto() {
        let home = Path::new("/Users/example");
        assert_eq!(product_user_directory(home), home.join(".clawmaster-user"));
        assert_ne!(product_user_directory(home), home.join(".otto-user"));
    }

    #[test]
    fn node_capsule_is_verified_and_reused_from_private_cache() {
        let root =
            std::env::temp_dir().join(format!("clawmaster-node-capsule-{}", std::process::id(),));
        let resources = root.join("resources");
        let capsule_root = resources.join("node");
        let user = root.join("user");
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&capsule_root).unwrap();
        let payload = vec![42_u8; 1_000_001];
        let mut compressed = Vec::new();
        {
            let mut source = payload.as_slice();
            let mut compressor = brotli::CompressorWriter::new(&mut compressed, 4096, 6, 22);
            std::io::copy(&mut source, &mut compressor).unwrap();
        }
        let hash = format!("{:x}", Sha256::digest(&payload));
        fs::write(capsule_root.join("node.br"), &compressed).unwrap();
        fs::write(
            capsule_root.join("node-manifest.json"),
            serde_json::json!({
                "schemaVersion": 1,
                "target": runtime_target(),
                "sha256": hash,
                "executableBytes": payload.len(),
                "compressedBytes": compressed.len(),
            })
            .to_string(),
        )
        .unwrap();

        let first = materialize_node_capsule(&resources, &user).unwrap();
        fs::write(&first, b"tampered cache").unwrap();
        let second = materialize_node_capsule(&resources, &user).unwrap();
        assert_eq!(first, second);
        assert_eq!(fs::read(&first).unwrap(), payload);
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn ripgrep_capsule_is_verified_and_materialized_as_an_executable() {
        let root = std::env::temp_dir()
            .join(format!("clawmaster-ripgrep-capsule-{}", std::process::id(),));
        let resources = root.join("resources");
        let capsule_root = resources.join("ripgrep");
        let user = root.join("user");
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&capsule_root).unwrap();
        let payload = vec![24_u8; 1_000_001];
        let mut compressed = Vec::new();
        {
            let mut source = payload.as_slice();
            let mut compressor = brotli::CompressorWriter::new(&mut compressed, 4096, 6, 22);
            std::io::copy(&mut source, &mut compressor).unwrap();
        }
        let hash = format!("{:x}", Sha256::digest(&payload));
        fs::write(capsule_root.join("rg.br"), &compressed).unwrap();
        fs::write(
            capsule_root.join("rg-manifest.json"),
            serde_json::json!({
                "schemaVersion": 1,
                "target": runtime_target(),
                "sha256": hash,
                "executableBytes": payload.len(),
                "compressedBytes": compressed.len(),
            })
            .to_string(),
        )
        .unwrap();

        let materialized = materialize_ripgrep_capsule(&resources, &user).unwrap();
        assert_eq!(fs::read(&materialized).unwrap(), payload);
        #[cfg(unix)]
        assert_ne!(
            fs::metadata(&materialized).unwrap().permissions().mode() & 0o100,
            0
        );
        let _ = fs::remove_dir_all(&root);
    }
}
