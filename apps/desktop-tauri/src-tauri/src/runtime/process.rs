use std::path::{Path, PathBuf};
use std::process::{Child, Command};

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Prevent spawned subprocesses from opening a visible console on Windows.
pub fn hide_console(cmd: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
}

/// Put the Host in its own process group so stop can signal the whole tree.
pub fn isolate_host_group(cmd: &mut Command) {
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    #[cfg(target_os = "linux")]
    {
        use std::os::unix::process::CommandExt;
        unsafe {
            cmd.pre_exec(|| {
                libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGKILL);
                Ok(())
            });
        }
    }
    let _ = cmd;
}

/// Terminate `pid` and every descendant. Used when Drop may not run (`app.exit`).
pub fn kill_process_tree(pid: u32) {
    if pid == 0 {
        return;
    }
    #[cfg(windows)]
    {
        let mut cmd = Command::new("taskkill");
        cmd.args(["/F", "/T", "/PID", &pid.to_string()]);
        hide_console(&mut cmd);
        let _ = cmd.status();
    }
    #[cfg(unix)]
    {
        unsafe {
            libc::kill(-(pid as i32), libc::SIGKILL);
        }
    }
}

/// Record the Host pid, Node image and creation token so a later launch can reap only its orphan.
///
/// WSL callers pass the Windows `wsl.exe` stub pid and the Linux Node image
/// path (`Path::new(linux_node)`). [`reclaim_stale_host`] will not match that
/// pair (Windows image ≠ Linux path), so live WSL reaping stays on
/// `HostHandle::stop`.
pub fn write_host_pid(path: &Path, pid: u32, node: &Path) -> Result<(), String> {
    let token = process_start_token(pid).ok_or("Cannot establish Host process creation identity")?;
    std::fs::write(path, format!("{pid}\n{}\n{token}\n", node.display())).map_err(|e| e.to_string())
}

/// Parse a `host.pid` file written by [`write_host_pid`].
pub fn parse_host_pid(raw: &str) -> Option<(u32, PathBuf)> {
    let mut lines = raw.lines();
    let pid = lines.next()?.trim().parse().ok()?;
    let node = lines.next()?.trim();
    if pid == 0 || node.is_empty() {
        return None;
    }
    Some((pid, PathBuf::from(node)))
}

fn parse_host_pid_record(raw: &str) -> Option<(u32, PathBuf, String)> {
    let (pid, node) = parse_host_pid(raw)?;
    let token = raw.lines().nth(2)?.trim();
    if token.is_empty() {
        return None;
    }
    Some((pid, node, token.to_string()))
}

/// Kill a previous Host tree when its recorded Node image still matches.
pub fn reclaim_stale_host(path: &Path) {
    let Ok(raw) = std::fs::read_to_string(path) else {
        return;
    };
    let _ = std::fs::remove_file(path);
    let Some((pid, node, token)) = parse_host_pid_record(&raw) else {
        return;
    };
    if !host_pid_matches(pid, &node, &token) {
        return;
    }
    kill_process_tree(pid);
}

fn host_pid_matches(pid: u32, expected_node: &Path, expected_token: &str) -> bool {
    let Some(image) = process_image_path(pid) else {
        return false;
    };
    crate::runtime::env_path::path_eq(&image, expected_node)
        && process_start_token(pid).as_deref() == Some(expected_token)
}

fn process_start_token(pid: u32) -> Option<String> {
    #[cfg(windows)]
    {
        use windows::Win32::Foundation::{CloseHandle, FILETIME};
        use windows::Win32::System::Threading::{
            GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
        };
        let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) }.ok()?;
        let mut creation = FILETIME::default();
        let mut exit = FILETIME::default();
        let mut kernel = FILETIME::default();
        let mut user = FILETIME::default();
        let result = unsafe {
            GetProcessTimes(handle, &mut creation, &mut exit, &mut kernel, &mut user)
        };
        let _ = unsafe { CloseHandle(handle) };
        result.ok()?;
        let ticks = (u64::from(creation.dwHighDateTime) << 32) | u64::from(creation.dwLowDateTime);
        Some(format!("windows:{ticks}"))
    }
    #[cfg(target_os = "macos")]
    {
        let mut info = std::mem::MaybeUninit::<libc::proc_bsdinfo>::zeroed();
        let size = std::mem::size_of::<libc::proc_bsdinfo>();
        let result = unsafe {
            libc::proc_pidinfo(
                i32::try_from(pid).ok()?,
                libc::PROC_PIDTBSDINFO,
                0,
                info.as_mut_ptr().cast(),
                i32::try_from(size).ok()?,
            )
        };
        if result != i32::try_from(size).ok()? {
            return None;
        }
        let info = unsafe { info.assume_init() };
        Some(format!("macos:{}:{}", info.pbi_start_tvsec, info.pbi_start_tvusec))
    }
    #[cfg(target_os = "linux")]
    {
        let raw = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
        let end = raw.rfind(") ")?;
        let start_time = raw.get(end + 2..)?.split_whitespace().nth(19)?;
        Some(format!("linux:{start_time}"))
    }
    #[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
    {
        let _ = pid;
        None
    }
}

#[cfg(windows)]
fn process_image_path(pid: u32) -> Option<PathBuf> {
    use windows::core::PWSTR;
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
        PROCESS_QUERY_LIMITED_INFORMATION,
    };

    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) }.ok()?;
    let mut buf = [0u16; 512];
    let mut size = buf.len() as u32;
    let ok = unsafe {
        QueryFullProcessImageNameW(
            handle,
            PROCESS_NAME_WIN32,
            PWSTR(buf.as_mut_ptr()),
            &mut size,
        )
    };
    let _ = unsafe { CloseHandle(handle) };
    ok.ok()?;
    let text = String::from_utf16_lossy(&buf[..size as usize]);
    if text.is_empty() {
        None
    } else {
        Some(PathBuf::from(text))
    }
}

#[cfg(unix)]
fn process_image_path(pid: u32) -> Option<PathBuf> {
    #[cfg(target_os = "macos")]
    {
        let mut buffer = [0u8; 4096];
        let length = unsafe {
            libc::proc_pidpath(
                i32::try_from(pid).ok()?,
                buffer.as_mut_ptr().cast(),
                buffer.len() as u32,
            )
        };
        if length > 0 {
            return String::from_utf8(buffer[..length as usize].to_vec())
                .ok()
                .filter(|value| !value.is_empty())
                .map(PathBuf::from);
        }
        return None;
    }

    #[cfg(not(target_os = "macos"))]
    std::fs::read_link(format!("/proc/{pid}/exe"))
        .ok()
        .or_else(|| {
            let raw = std::fs::read_to_string(format!("/proc/{pid}/cmdline")).ok()?;
            let first = raw.split('\0').next()?.trim();
            if first.is_empty() {
                None
            } else {
                Some(PathBuf::from(first))
            }
        })
}

#[cfg(not(any(windows, unix)))]
fn process_image_path(_pid: u32) -> Option<PathBuf> {
    None
}

/// Windows job that kills every assigned process when the last handle closes.
#[cfg(windows)]
pub struct KillOnCloseJob {
    handle: windows::Win32::Foundation::HANDLE,
}

#[cfg(windows)]
unsafe impl Send for KillOnCloseJob {}

#[cfg(windows)]
impl KillOnCloseJob {
    pub fn create() -> Option<Self> {
        use std::mem::size_of;
        use windows::Win32::System::JobObjects::{
            CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject,
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        };

        let handle = unsafe { CreateJobObjectW(None, None) }.ok()?;
        let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let sized = unsafe {
            SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                &raw const info as *const _,
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        };
        if sized.is_err() {
            let _ = unsafe { windows::Win32::Foundation::CloseHandle(handle) };
            return None;
        }
        Some(Self { handle })
    }

    pub fn assign(&self, child: &Child) -> bool {
        use std::os::windows::io::AsRawHandle;
        use windows::Win32::Foundation::HANDLE;
        use windows::Win32::System::JobObjects::AssignProcessToJobObject;
        let process = HANDLE(child.as_raw_handle());
        unsafe { AssignProcessToJobObject(self.handle, process) }.is_ok()
    }
}

#[cfg(windows)]
impl Drop for KillOnCloseJob {
    fn drop(&mut self) {
        let _ = unsafe { windows::Win32::Foundation::CloseHandle(self.handle) };
    }
}

#[cfg(test)]
mod tests {
    use super::parse_host_pid;
    use std::path::{Path, PathBuf};

    #[test]
    fn parses_pid_and_node_image() {
        assert_eq!(
            parse_host_pid("4321\nC:\\\\Program Files\\\\node.exe\n"),
            Some((4321, PathBuf::from(r"C:\\Program Files\\node.exe")))
        );
        assert_eq!(parse_host_pid("0\nC:\\\\node.exe\n"), None);
        assert_eq!(parse_host_pid("not-a-pid\nC:\\\\node.exe\n"), None);
    }

    #[test]
    fn stale_host_records_require_a_creation_identity() {
        assert_eq!(super::parse_host_pid_record("4321\nnode\n"), None);
        assert_eq!(
            super::parse_host_pid_record("4321\nnode\nlinux:123\n"),
            Some((4321, PathBuf::from("node"), "linux:123".into()))
        );
    }

    #[test]
    fn host_pid_record_writes_the_current_process_creation_token() {
        let path = std::env::temp_dir().join(format!("clawmaster-host-pid-{}", std::process::id()));
        let _ = std::fs::remove_file(&path);
        super::write_host_pid(&path, std::process::id(), Path::new("node")).unwrap();
        let raw = std::fs::read_to_string(&path).unwrap();
        assert!(super::parse_host_pid_record(&raw).is_some());
        let _ = std::fs::remove_file(path);
    }
}
