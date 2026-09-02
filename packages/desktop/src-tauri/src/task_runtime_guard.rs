use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use tauri::State;

#[derive(Default)]
pub struct TaskRuntimeGuard {
    inhibitor: Mutex<Option<Child>>,
}

#[cfg(any(target_os = "macos", test))]
fn caffeinate_args(pid: u32) -> [String; 3] {
    ["-i".into(), "-w".into(), pid.to_string()]
}

#[cfg(any(target_os = "windows", test))]
fn windows_inhibitor_script(pid: u32) -> String {
    format!(
        "$src='[System.Runtime.InteropServices.DllImport(\"kernel32.dll\")] public static extern uint SetThreadExecutionState(uint esFlags);'; Add-Type -MemberDefinition $src -Name Power -Namespace ClawMaster; [ClawMaster.Power]::SetThreadExecutionState(0x80000001); while (Get-Process -Id {pid} -ErrorAction SilentlyContinue) {{ Start-Sleep -Seconds 30 }}; [ClawMaster.Power]::SetThreadExecutionState(0x80000000)"
    )
}

#[cfg(any(target_os = "linux", test))]
fn linux_inhibitor_args() -> [&'static str; 6] {
    [
        "--what=idle:sleep",
        "--who=ClawMaster",
        "--why=ClawMaster task is running",
        "--mode=block",
        "sleep",
        "infinity",
    ]
}

fn spawn_inhibitor() -> Result<Child, String> {
    #[cfg(target_os = "macos")]
    let command = Command::new("/usr/bin/caffeinate")
        .args(caffeinate_args(std::process::id()))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn();

    #[cfg(target_os = "windows")]
    let command = {
        let script = windows_inhibitor_script(std::process::id());
        Command::new("powershell.exe")
            .args([
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-WindowStyle",
                "Hidden",
                "-Command",
                script.as_str(),
            ])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
    };

    #[cfg(target_os = "linux")]
    let command = Command::new("systemd-inhibit")
        .args(linux_inhibitor_args())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn();

    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    let command = Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "idle sleep prevention is unsupported on this platform",
    ));

    command.map_err(|error| format!("failed to prevent idle sleep: {error}"))
}

impl TaskRuntimeGuard {
    fn set_active(&self, active: bool) -> Result<bool, String> {
        let mut inhibitor = self
            .inhibitor
            .lock()
            .map_err(|_| "task runtime guard lock is poisoned".to_string())?;
        if active {
            if inhibitor.is_some() {
                return Ok(true);
            }
            *inhibitor = Some(spawn_inhibitor()?);
            Ok(true)
        } else {
            if let Some(mut child) = inhibitor.take() {
                let _ = child.kill();
                let _ = child.wait();
            }
            Ok(false)
        }
    }
}

#[tauri::command]
pub fn task_runtime_set_active(
    active: bool,
    state: State<'_, TaskRuntimeGuard>,
) -> Result<bool, String> {
    state.set_active(active)
}

pub fn stop(state: &TaskRuntimeGuard) {
    let _ = state.set_active(false);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn idle_sleep_inhibitor_is_tied_to_the_app_process() {
        assert_eq!(caffeinate_args(42), ["-i", "-w", "42"]);
        assert!(windows_inhibitor_script(42).contains("Get-Process -Id 42"));
        assert_eq!(linux_inhibitor_args().last(), Some(&"infinity"));
    }

    #[test]
    fn inactive_guard_is_idempotent() {
        let guard = TaskRuntimeGuard::default();
        assert!(!guard.set_active(false).unwrap());
        assert!(!guard.set_active(false).unwrap());
    }
}
