//! Provision a Linux harness tree, Node runtime, and `$HOME/.dsh` inside WSL.

use std::fs;
use std::path::{Path, PathBuf};

use crate::i18n::{self, Msg};
use crate::overlay::{linux_plugin_file_url, overlay_yaml};
use crate::runtime::boot_log;
use crate::runtime::config::{npm_registry, DEFAULT_NODE_VERSION, DEFAULT_PNPM_VERSION};
use crate::runtime::host_env::node_version_compatible;
use crate::runtime::provision::{download_node_archive, node_archive_spec_for};
use crate::runtime::ProvisionEvent;

use super::{windows_to_wsl_mount, WslOutput, WslRunner};

fn err_harness() -> &'static str {
    i18n::t(Msg::WslErrHarness)
}
fn err_node() -> &'static str {
    i18n::t(Msg::WslErrNode)
}
fn err_pnpm() -> &'static str {
    i18n::t(Msg::WslErrPnpm)
}
const PNPM_TIMEOUT_SECS: &str = "600";
/// Linux-only PATH for `command -v node` so WSL does not surface Windows `node.exe`.
const LINUX_PROBE_PATH: &str = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin";

/// Linux paths for a WSL-mode Host after provisioning.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WslRuntimePaths {
    pub distro: String,
    pub linux_node: String,
    pub linux_cli: String,
    pub linux_harness_root: String,
    pub linux_dsh_home: String,
    /// Explicit canonical roots from the resolved Windows DSH home for legacy migration.
    pub linux_credential_roots: Vec<String>,
    pub linux_path: String,
    pub linux_patch: Option<String>,
}

/// Provision the Linux runtime and map approved Windows credential roots into WSL.
/// Credentials are read by the profile provider through the host broker, not copied here.
pub async fn ensure_wsl_runtime(
    runner: &dyn WslRunner,
    distro: &str,
    bundled_windows: &Path,
    bundle_hash: &str,
    windows_credential_roots: &[PathBuf],
    overlay_src: Option<&Path>,
    _notify_url: Option<&str>,
    progress: impl Fn(ProvisionEvent),
) -> Result<WslRuntimePaths, String> {
    progress(ProvisionEvent::Status(
        i18n::t(Msg::StatusPrepareWsl).into(),
    ));

    let linux_home = printenv_home(runner, distro)?;
    let linux_harness_root =
        format!("{linux_home}/.local/share/dsh-desktop/harness-versions/{bundle_hash}");
    let linux_cli = format!("{linux_harness_root}/apps/cli/lib/bin.js");
    let linux_runtime_root = format!("{linux_home}/.local/share/dsh-desktop/runtime");
    let preferred_node = format!("{linux_runtime_root}/node/bin/node");
    let linux_dsh_home = format!("{linux_home}/.dsh");
    let mut linux_credential_roots = Vec::new();
    for root in windows_credential_roots {
        match windows_to_wsl_mount(root) {
            Ok(root) => linux_credential_roots.push(root),
            Err(error) => boot_log::info(&format!("WSL credential source is unavailable: {error}")),
        }
    }

    ensure_harness_tree(
        runner,
        distro,
        bundled_windows,
        &linux_harness_root,
        &linux_cli,
    )?;
    progress(ProvisionEvent::Progress(20));

    let linux_node = ensure_linux_node(
        runner,
        distro,
        &preferred_node,
        &linux_runtime_root,
        &progress,
    )
    .await?;
    progress(ProvisionEvent::Progress(45));

    let node_bin_dir = linux_node
        .rsplit_once('/')
        .map(|(dir, _)| dir.to_string())
        .ok_or_else(|| format!("{}: invalid node path {linux_node}", err_node()))?;
    let linux_path = format!("{node_bin_dir}:/usr/bin");

    // A completed install is proven by pnpm's end-of-install
    // `node_modules/.modules.yaml`; the `.pnpm` store also exists when a
    // previous install was killed mid-link, and booting that store fails with
    // `ERR_MODULE_NOT_FOUND`.
    let deps_store = format!("{linux_harness_root}/node_modules/.pnpm");
    let deps_marker = format!("{linux_harness_root}/node_modules/.modules.yaml");
    if wsl_test_d(runner, distro, &deps_store)? && wsl_test_f(runner, distro, &deps_marker)? {
        boot_log::info("wsl harness dependencies installed; pnpm install skipped");
    } else {
        run_pnpm_install(runner, distro, &linux_path, &linux_harness_root)?;
    }
    progress(ProvisionEvent::Progress(75));


    let linux_patch = if let Some(src) = overlay_src {
        Some(implant_overlay(runner, distro, src, &linux_dsh_home)?)
    } else {
        None
    };
    progress(ProvisionEvent::Progress(90));

    Ok(WslRuntimePaths {
        distro: distro.to_string(),
        linux_node,
        linux_cli,
        linux_harness_root,
        linux_dsh_home,
        linux_credential_roots,
        linux_path,
        linux_patch,
    })
}

fn printenv_home(runner: &dyn WslRunner, distro: &str) -> Result<String, String> {
    let out = wsl_exec(runner, distro, &["printenv", "HOME"])
        .map_err(|e| format!("{}: {e}", err_harness()))?;
    require_success(&out, err_harness())?;
    let home = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if home.is_empty() || !home.starts_with('/') {
        return Err(format!("{}: empty or invalid HOME", err_harness()));
    }
    Ok(home)
}

fn ensure_harness_tree(
    runner: &dyn WslRunner,
    distro: &str,
    bundled_windows: &Path,
    linux_harness_root: &str,
    linux_cli: &str,
) -> Result<(), String> {
    if wsl_test_f(runner, distro, linux_cli)? {
        return Ok(());
    }

    let src =
        windows_to_wsl_mount(bundled_windows).map_err(|e| format!("{}: {e}", err_harness()))?;
    let mkdir = wsl_exec(runner, distro, &["mkdir", "-p", linux_harness_root])
        .map_err(|e| format!("{}: {e}", err_harness()))?;
    require_success(&mkdir, err_harness())?;

    let src_dot = format!("{src}/.");
    let dest_slash = format!("{linux_harness_root}/");
    let copy = wsl_exec(runner, distro, &["cp", "-a", &src_dot, &dest_slash])
        .map_err(|e| format!("{}: {e}", err_harness()))?;
    require_success(&copy, err_harness())?;
    Ok(())
}

async fn ensure_linux_node(
    runner: &dyn WslRunner,
    distro: &str,
    preferred_node: &str,
    linux_runtime_root: &str,
    progress: &impl Fn(ProvisionEvent),
) -> Result<String, String> {
    if let Some(node) = probe_compatible_node(runner, distro, preferred_node)? {
        return Ok(node);
    }

    let which_script = format!("PATH={LINUX_PROBE_PATH} command -v node");
    let which = wsl_exec(runner, distro, &["/bin/sh", "-c", &which_script])
        .map_err(|e| format!("{}: {e}", err_node()))?;
    if which.code == 0 {
        let path = String::from_utf8_lossy(&which.stdout).trim().to_string();
        if !path.is_empty() && !is_windows_hosted_node_path(&path) {
            if let Some(node) = probe_compatible_node(runner, distro, &path)? {
                return Ok(node);
            }
        }
    }

    install_linux_node(runner, distro, preferred_node, linux_runtime_root, progress).await
}

/// True when `path` looks like a Windows Node image reached via `/mnt` or `.exe`.
fn is_windows_hosted_node_path(path: &str) -> bool {
    path.contains('\\') || path.to_ascii_lowercase().ends_with(".exe") || path.starts_with("/mnt/")
}

fn probe_compatible_node(
    runner: &dyn WslRunner,
    distro: &str,
    node_path: &str,
) -> Result<Option<String>, String> {
    if is_windows_hosted_node_path(node_path) {
        return Ok(None);
    }

    if node_path != "node" {
        let exists = wsl_exec(runner, distro, &["test", "-x", node_path])
            .map_err(|e| format!("{}: {e}", err_node()))?;
        if exists.code != 0 {
            return Ok(None);
        }
    }

    let ver =
        wsl_exec(runner, distro, &[node_path, "-v"]).map_err(|e| format!("{}: {e}", err_node()))?;
    if ver.code != 0 {
        return Ok(None);
    }
    let raw = String::from_utf8_lossy(&ver.stdout);
    let line = raw.lines().next().unwrap_or("").trim();
    if node_version_compatible(line) {
        Ok(Some(node_path.to_string()))
    } else {
        Ok(None)
    }
}

async fn install_linux_node(
    runner: &dyn WslRunner,
    distro: &str,
    preferred_node: &str,
    linux_runtime_root: &str,
    progress: &impl Fn(ProvisionEvent),
) -> Result<String, String> {
    // Re-check preferred before any download (e.g. prior extract already on disk).
    if let Some(node) = probe_compatible_node(runner, distro, preferred_node)? {
        return Ok(node);
    }

    let arch = linux_arch(runner, distro)?;
    let spec = node_archive_spec_for(DEFAULT_NODE_VERSION, "linux", &arch)
        .map_err(|e| format!("{}: {e}", err_node()))?;

    let cache = crate::runtime::app_data_root()
        .map_err(|e| format!("{}: {e}", err_node()))?
        .join("cache");
    fs::create_dir_all(&cache).map_err(|e| format!("{}: {e}", err_node()))?;
    let archive_path = cache.join(&spec.archive_name);
    progress(ProvisionEvent::Status(i18n::tf(
        Msg::StatusDownloadLinuxNode,
        DEFAULT_NODE_VERSION,
    )));
    download_node_archive(&spec, &archive_path, 30, 40, progress)
        .await
        .map_err(|e| format!("{}: {e}", err_node()))?;

    let archive_mnt =
        windows_to_wsl_mount(&archive_path).map_err(|e| format!("{}: {e}", err_node()))?;
    let node_dir = format!("{linux_runtime_root}/node");

    let rm = wsl_exec(runner, distro, &["rm", "-rf", &node_dir])
        .map_err(|e| format!("{}: {e}", err_node()))?;
    require_success(&rm, err_node())?;

    let mkdir = wsl_exec(runner, distro, &["mkdir", "-p", &node_dir])
        .map_err(|e| format!("{}: {e}", err_node()))?;
    require_success(&mkdir, err_node())?;

    let tar = wsl_exec(
        runner,
        distro,
        &[
            "tar",
            "-xzf",
            &archive_mnt,
            "--strip-components=1",
            "-C",
            &node_dir,
        ],
    )
    .map_err(|e| format!("{}: {e}", err_node()))?;
    require_success(&tar, err_node())?;

    let check = wsl_exec(runner, distro, &["test", "-x", preferred_node])
        .map_err(|e| format!("{}: {e}", err_node()))?;
    require_success(&check, err_node())?;
    Ok(preferred_node.to_string())
}

fn linux_arch(runner: &dyn WslRunner, distro: &str) -> Result<String, String> {
    let out =
        wsl_exec(runner, distro, &["uname", "-m"]).map_err(|e| format!("{}: {e}", err_node()))?;
    require_success(&out, err_node())?;
    let raw = String::from_utf8_lossy(&out.stdout).trim().to_string();
    match raw.as_str() {
        "x86_64" => Ok("x86_64".into()),
        "aarch64" | "arm64" => Ok("aarch64".into()),
        other => Err(format!("{}: unsupported uname -m: {other}", err_node())),
    }
}

fn run_pnpm_install(
    runner: &dyn WslRunner,
    distro: &str,
    linux_path: &str,
    linux_harness_root: &str,
) -> Result<(), String> {
    let registry = npm_registry();
    let script = format!(
        "cd \"$1\" && corepack enable && corepack prepare pnpm@{pnpm} --activate && pnpm install --prod --no-frozen-lockfile --registry \"$2\"",
        pnpm = DEFAULT_PNPM_VERSION,
    );
    let path_env = format!("PATH={linux_path}");
    let out = wsl_exec(
        runner,
        distro,
        &[
            "timeout",
            PNPM_TIMEOUT_SECS,
            "/usr/bin/env",
            "-u",
            "CI",
            &path_env,
            "/bin/sh",
            "-c",
            &script,
            "pnpm-install",
            linux_harness_root,
            &registry,
        ],
    )
    .map_err(|e| format!("{}: {e}", err_pnpm()))?;
    require_success(&out, err_pnpm())?;
    Ok(())
}

fn implant_overlay(
    runner: &dyn WslRunner,
    distro: &str,
    overlay_src: &Path,
    linux_dsh_home: &str,
) -> Result<String, String> {
    let plugin_src = overlay_src.join("index.mjs");
    if !plugin_src.is_file() {
        return Err(format!(
            "desktop overlay plugin missing: {}",
            plugin_src.display()
        ));
    }

    let dest_dir = format!("{linux_dsh_home}/desktop-overlay");
    let plugin_dest = format!("{dest_dir}/index.mjs");
    let patch_dest = format!("{dest_dir}/cordis.yml");
    let plugin_url = linux_plugin_file_url(&plugin_dest)?;
    let yaml = overlay_yaml(&plugin_url);

    let mkdir = wsl_exec(runner, distro, &["mkdir", "-p", &dest_dir]).map_err(|e| e.to_string())?;
    require_success(&mkdir, i18n::t(Msg::WslErrOverlay))?;

    let src_mnt = windows_to_wsl_mount(&plugin_src)?;
    let copy =
        wsl_exec(runner, distro, &["cp", &src_mnt, &plugin_dest]).map_err(|e| e.to_string())?;
    require_success(&copy, i18n::t(Msg::WslErrOverlay))?;

    let cache = crate::runtime::app_data_root()?.join("cache");
    fs::create_dir_all(&cache).map_err(|e| e.to_string())?;
    let yaml_path = cache.join("wsl-desktop-overlay-cordis.yml");
    fs::write(&yaml_path, yaml).map_err(|e| e.to_string())?;
    let yaml_mnt = windows_to_wsl_mount(&yaml_path)?;
    let copy_yaml =
        wsl_exec(runner, distro, &["cp", &yaml_mnt, &patch_dest]).map_err(|e| e.to_string())?;
    require_success(&copy_yaml, i18n::t(Msg::WslErrOverlay))?;

    Ok(patch_dest)
}

fn wsl_test_f(runner: &dyn WslRunner, distro: &str, path: &str) -> Result<bool, String> {
    let out = wsl_exec(runner, distro, &["test", "-f", path])
        .map_err(|e| format!("{}: {e}", err_harness()))?;
    Ok(out.code == 0)
}

/// `test -d` inside the WSL distro: true when `path` is a directory.
fn wsl_test_d(runner: &dyn WslRunner, distro: &str, path: &str) -> Result<bool, String> {
    let out = wsl_exec(runner, distro, &["test", "-d", path])
        .map_err(|e| format!("{}: {e}", err_harness()))?;
    Ok(out.code == 0)
}

fn wsl_exec(
    runner: &dyn WslRunner,
    distro: &str,
    program_args: &[&str],
) -> Result<WslOutput, String> {
    let mut args: Vec<&str> = Vec::with_capacity(3 + program_args.len());
    args.push("-d");
    args.push(distro);
    args.push("--exec");
    args.extend_from_slice(program_args);
    runner.run(&args)
}

fn require_success(out: &WslOutput, prefix: &str) -> Result<(), String> {
    if out.code == 0 {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&out.stderr);
    let stdout = String::from_utf8_lossy(&out.stdout);
    let detail = if !stderr.trim().is_empty() {
        stderr.trim().to_string()
    } else if !stdout.trim().is_empty() {
        stdout.trim().to_string()
    } else {
        format!("exit {}", out.code)
    };
    Err(format!("{prefix}: {detail}"))
}

#[cfg(test)]
mod tests {
    use super::{ensure_wsl_runtime, LINUX_PROBE_PATH};
    use crate::runtime::wsl::{WslOutput, WslRunner};
    use std::fs;
    use std::path::PathBuf;
    use std::sync::Mutex;

    /// Fake runner: scripted replies keyed by args prefix; records every invocation.
    struct Scripted {
        scripts: Mutex<Vec<(Vec<String>, WslOutput)>>,
        recorded: Mutex<Vec<Vec<String>>>,
    }

    impl Scripted {
        fn new(scripts: Vec<(Vec<String>, WslOutput)>) -> Self {
            Self {
                scripts: Mutex::new(scripts),
                recorded: Mutex::new(Vec::new()),
            }
        }

        fn recorded(&self) -> Vec<Vec<String>> {
            self.recorded.lock().expect("recorded lock").clone()
        }
    }

    impl WslRunner for Scripted {
        fn run(&self, args: &[&str]) -> Result<WslOutput, String> {
            let owned: Vec<String> = args.iter().map(|s| (*s).to_string()).collect();
            self.recorded
                .lock()
                .expect("recorded lock")
                .push(owned.clone());

            let mut scripts = self.scripts.lock().expect("scripts lock");
            let idx = scripts.iter().position(|(prefix, _)| {
                owned.len() >= prefix.len() && owned.iter().zip(prefix.iter()).all(|(a, b)| a == b)
            });
            match idx {
                Some(i) => Ok(scripts.remove(i).1),
                None => Err(format!("unexpected wsl args: {owned:?}")),
            }
        }
    }

    fn ok_out(stdout: &str) -> WslOutput {
        WslOutput {
            stdout: stdout.as_bytes().to_vec(),
            stderr: Vec::new(),
            code: 0,
        }
    }

    fn fail_out() -> WslOutput {
        WslOutput {
            stdout: Vec::new(),
            stderr: Vec::new(),
            code: 1,
        }
    }

    fn temp_dir(label: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "dsh-wsl-provision-{}-{}",
            label,
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    #[cfg(windows)]
    fn WSL_setup_does_not_inspect_or_copy_plaintext_credentials() {
        let bundled = temp_dir("bundled");
        let windows_home = temp_dir("win-home");
        fs::write(windows_home.join(".credentials.yaml"), "token: test\n").unwrap();
        fs::write(windows_home.join(".env"), "KEY=1\n").unwrap();
        fs::create_dir_all(windows_home.join("sessions")).unwrap();
        fs::write(windows_home.join("sessions").join("a.json"), "{}").unwrap();

        let hash = "abc123";
        let harness_bin =
            format!("/home/u/.local/share/dsh-desktop/harness-versions/{hash}/apps/cli/lib/bin.js");
        let preferred_node = "/home/u/.local/share/dsh-desktop/runtime/node/bin/node";

        let runner = Scripted::new(vec![
            (
                vec![
                    "-d".into(),
                    "Ubuntu".into(),
                    "--exec".into(),
                    "printenv".into(),
                    "HOME".into(),
                ],
                ok_out("/home/u\n"),
            ),
            (
                vec![
                    "-d".into(),
                    "Ubuntu".into(),
                    "--exec".into(),
                    "test".into(),
                    "-f".into(),
                    harness_bin,
                ],
                fail_out(),
            ),
            (
                vec![
                    "-d".into(),
                    "Ubuntu".into(),
                    "--exec".into(),
                    "mkdir".into(),
                ],
                ok_out(""),
            ),
            (
                vec!["-d".into(), "Ubuntu".into(), "--exec".into(), "cp".into()],
                ok_out(""),
            ),
            (
                vec![
                    "-d".into(),
                    "Ubuntu".into(),
                    "--exec".into(),
                    "test".into(),
                    "-x".into(),
                    preferred_node.into(),
                ],
                fail_out(),
            ),
            (
                vec![
                    "-d".into(),
                    "Ubuntu".into(),
                    "--exec".into(),
                    "/bin/sh".into(),
                    "-c".into(),
                    format!("PATH={LINUX_PROBE_PATH} command -v node"),
                ],
                ok_out("/usr/bin/node\n"),
            ),
            (
                vec![
                    "-d".into(),
                    "Ubuntu".into(),
                    "--exec".into(),
                    "test".into(),
                    "-x".into(),
                    "/usr/bin/node".into(),
                ],
                ok_out(""),
            ),
            (
                vec![
                    "-d".into(),
                    "Ubuntu".into(),
                    "--exec".into(),
                    "/usr/bin/node".into(),
                    "-v".into(),
                ],
                ok_out("v22.19.0\n"),
            ),
            (
                vec![
                    "-d".into(),
                    "Ubuntu".into(),
                    "--exec".into(),
                    "test".into(),
                    "-d".into(),
                    format!("/home/u/.local/share/dsh-desktop/harness-versions/{hash}/node_modules/.pnpm"),
                ],
                fail_out(),
            ),
            (
                vec![
                    "-d".into(),
                    "Ubuntu".into(),
                    "--exec".into(),
                    "timeout".into(),
                ],
                ok_out(""),
            ),
            (
                vec![
                    "-d".into(),
                    "Ubuntu".into(),
                    "--exec".into(),
                    "test".into(),
                    "-f".into(),
                    cred_dest.into(),
                ],
                fail_out(),
            ),
            (
                vec![
                    "-d".into(),
                    "Ubuntu".into(),
                    "--exec".into(),
                    "test".into(),
                    "-f".into(),
                    env_dest.into(),
                ],
                fail_out(),
            ),
            (
                vec![
                    "-d".into(),
                    "Ubuntu".into(),
                    "--exec".into(),
                    "mkdir".into(),
                    "-p".into(),
                    "/home/u/.dsh".into(),
                ],
                ok_out(""),
            ),
            (
                vec!["-d".into(), "Ubuntu".into(), "--exec".into(), "cp".into()],
                ok_out(""),
            ),
            (
                vec!["-d".into(), "Ubuntu".into(), "--exec".into(), "cp".into()],
                ok_out(""),
            ),
        ]);

        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let paths = rt
            .block_on(ensure_wsl_runtime(
                &runner,
                "Ubuntu",
                &bundled,
                hash,
                &[windows_home.clone()],
                None,
                None,
                |_| {},
            ))
            .expect("ensure_wsl_runtime");

        assert_eq!(paths.linux_dsh_home, "/home/u/.dsh");
        assert_eq!(
            paths.linux_credential_roots,
            vec![super::windows_to_wsl_mount(&fs::canonicalize(&windows_home).unwrap()).unwrap()]
        );
        assert_eq!(
            paths.linux_harness_root,
            format!("/home/u/.local/share/dsh-desktop/harness-versions/{hash}")
        );
        assert_eq!(paths.linux_node, "/usr/bin/node");
        assert!(paths.linux_node.ends_with("/bin/node"));
        assert!(!paths.linux_node.to_ascii_lowercase().ends_with("node.exe"));

        let recorded = runner.recorded();
        let cp_args: Vec<&Vec<String>> = recorded
            .iter()
            .filter(|args| args.iter().any(|a| a == "cp"))
            .collect();

        assert!(recorded.iter().flatten().all(|arg| {
            !arg.contains(".credentials.yaml") && !arg.ends_with("/.env")
        }), "WSL setup must not inspect or copy plaintext credentials: {recorded:?}");

        for args in &cp_args {
            assert!(
                args.iter().all(|a| !a.contains("sessions")),
                "cp must never copy sessions/: {args:?}"
            );
        }

        let harness_cp = cp_args.iter().find(|args| {
            args.iter()
                .any(|a| a.contains("dsh-desktop/harness-versions"))
        });
        assert!(
            harness_cp.is_some(),
            "expected harness tree cp into ~/.local/share/dsh-desktop/, recorded: {recorded:?}"
        );
        let harness_cp = harness_cp.unwrap();
        assert!(
            harness_cp
                .iter()
                .any(|a| a.starts_with("/mnt/") && !a.contains(".credentials")),
            "harness cp source must be under /mnt/: {harness_cp:?}"
        );

        let _ = fs::remove_dir_all(&bundled);
        let _ = fs::remove_dir_all(&windows_home);
    }

    #[test]
    fn rejects_windows_node_from_command_v_and_uses_linux_runtime() {
        let bundled = temp_dir("bundled-win-node");
        let windows_home = temp_dir("win-home-win-node");
        let hash = "def456";
        let harness_bin =
            format!("/home/u/.local/share/dsh-desktop/harness-versions/{hash}/apps/cli/lib/bin.js");
        let preferred_node = "/home/u/.local/share/dsh-desktop/runtime/node/bin/node";
        let windows_node = "/mnt/c/Program Files/nodejs/node.exe";

        let runner = Scripted::new(vec![
            (
                vec![
                    "-d".into(),
                    "Ubuntu".into(),
                    "--exec".into(),
                    "printenv".into(),
                    "HOME".into(),
                ],
                ok_out("/home/u\n"),
            ),
            (
                vec![
                    "-d".into(),
                    "Ubuntu".into(),
                    "--exec".into(),
                    "test".into(),
                    "-f".into(),
                    harness_bin,
                ],
                ok_out(""),
            ),
            // First preferred probe: missing.
            (
                vec![
                    "-d".into(),
                    "Ubuntu".into(),
                    "--exec".into(),
                    "test".into(),
                    "-x".into(),
                    preferred_node.into(),
                ],
                fail_out(),
            ),
            // WSL PATH pollution: Windows node.exe.
            (
                vec![
                    "-d".into(),
                    "Ubuntu".into(),
                    "--exec".into(),
                    "/bin/sh".into(),
                    "-c".into(),
                    format!("PATH={LINUX_PROBE_PATH} command -v node"),
                ],
                ok_out(&format!("{windows_node}\n")),
            ),
            // install_linux_node re-probes preferred (already extracted) — no download.
            (
                vec![
                    "-d".into(),
                    "Ubuntu".into(),
                    "--exec".into(),
                    "test".into(),
                    "-x".into(),
                    preferred_node.into(),
                ],
                ok_out(""),
            ),
            (
                vec![
                    "-d".into(),
                    "Ubuntu".into(),
                    "--exec".into(),
                    preferred_node.into(),
                    "-v".into(),
                ],
                ok_out("v22.19.0\n"),
            ),
            (
                vec![
                    "-d".into(),
                    "Ubuntu".into(),
                    "--exec".into(),
                    "test".into(),
                    "-d".into(),
                    format!("/home/u/.local/share/dsh-desktop/harness-versions/{hash}/node_modules/.pnpm"),
                ],
                fail_out(),
            ),
            (
                vec![
                    "-d".into(),
                    "Ubuntu".into(),
                    "--exec".into(),
                    "timeout".into(),
                ],
                ok_out(""),
            ),
        ]);

        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let paths = rt
            .block_on(ensure_wsl_runtime(
                &runner,
                "Ubuntu",
                &bundled,
                hash,
                &[windows_home.clone()],
                None,
                None,
                |_| {},
            ))
            .expect("ensure_wsl_runtime");

        assert_eq!(paths.linux_node, preferred_node);
        assert!(paths.linux_node.ends_with("/bin/node"));
        assert!(!paths.linux_node.to_ascii_lowercase().ends_with("node.exe"));

        let recorded = runner.recorded();
        for args in &recorded {
            assert!(
                args.iter()
                    .all(|a| !a.to_ascii_lowercase().contains("node.exe")),
                "recorded argv must never contain node.exe: {args:?}"
            );
        }
        assert!(
            recorded.iter().any(|args| {
                args.iter()
                    .any(|a| a.contains("command -v node") && a.contains(LINUX_PROBE_PATH))
            }),
            "command -v must use Linux-only PATH, recorded: {recorded:?}"
        );

        let _ = fs::remove_dir_all(&bundled);
        let _ = fs::remove_dir_all(&windows_home);
    }

    #[test]
    fn skips_pnpm_install_when_the_dependency_store_already_exists() {
        let bundled = temp_dir("bundled-installed");
        let windows_home = temp_dir("win-home-installed");
        let hash = "cafe01";
        let harness_bin =
            format!("/home/u/.local/share/dsh-desktop/harness-versions/{hash}/apps/cli/lib/bin.js");
        let preferred_node = "/home/u/.local/share/dsh-desktop/runtime/node/bin/node";
        let deps_store =
            format!("/home/u/.local/share/dsh-desktop/harness-versions/{hash}/node_modules/.pnpm");
        let deps_marker = format!(
            "/home/u/.local/share/dsh-desktop/harness-versions/{hash}/node_modules/.modules.yaml"
        );

        let runner = Scripted::new(vec![
            (
                vec![
                    "-d".into(),
                    "Ubuntu".into(),
                    "--exec".into(),
                    "printenv".into(),
                    "HOME".into(),
                ],
                ok_out("/home/u\n"),
            ),
            (
                vec![
                    "-d".into(),
                    "Ubuntu".into(),
                    "--exec".into(),
                    "test".into(),
                    "-f".into(),
                    harness_bin,
                ],
                ok_out(""),
            ),
            (
                vec![
                    "-d".into(),
                    "Ubuntu".into(),
                    "--exec".into(),
                    "test".into(),
                    "-x".into(),
                    preferred_node.into(),
                ],
                ok_out(""),
            ),
            (
                vec![
                    "-d".into(),
                    "Ubuntu".into(),
                    "--exec".into(),
                    preferred_node.into(),
                    "-v".into(),
                ],
                ok_out("v22.19.0\n"),
            ),
            (
                vec![
                    "-d".into(),
                    "Ubuntu".into(),
                    "--exec".into(),
                    "test".into(),
                    "-d".into(),
                    deps_store,
                ],
                ok_out(""),
            ),
            (
                vec![
                    "-d".into(),
                    "Ubuntu".into(),
                    "--exec".into(),
                    "test".into(),
                    "-f".into(),
                    deps_marker,
                ],
                ok_out(""),
            ),
        ]);

        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let paths = rt
            .block_on(ensure_wsl_runtime(
                &runner,
                "Ubuntu",
                &bundled,
                hash,
                &[windows_home.clone()],
                None,
                None,
                |_| {},
            ))
            .expect("ensure_wsl_runtime");
        assert!(paths.linux_harness_root.contains(hash));

        let recorded = runner.recorded();
        for args in recorded {
            assert!(
                args.iter().all(|a| a != "timeout"),
                "pnpm install must be skipped when the dependency store exists: {args:?}"
            );
        }

        let _ = fs::remove_dir_all(&bundled);
        let _ = fs::remove_dir_all(&windows_home);
    }
}
