use serde_json::{json, Value};
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::process::Command;
use tokio::sync::watch;
use tokio::task::JoinHandle;
use tokio::time::{sleep, Duration};

const MAX_OUTPUT_BYTES: usize = 1_048_576;

fn valid_executable_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 120
        && name
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || "._+-".contains(character))
}

fn executable_candidates(name: &str) -> Vec<OsString> {
    #[cfg(windows)]
    {
        if Path::new(name).extension().is_some() {
            return vec![OsString::from(name)];
        }
        let extensions =
            std::env::var_os("PATHEXT").unwrap_or_else(|| OsString::from(".COM;.EXE;.BAT;.CMD"));
        return std::iter::once(OsString::from(name))
            .chain(
                extensions
                    .to_string_lossy()
                    .split(';')
                    .filter(|value| !value.is_empty())
                    .map(|extension| OsString::from(format!("{name}{extension}"))),
            )
            .collect();
    }
    #[cfg(not(windows))]
    {
        vec![OsString::from(name)]
    }
}

pub fn resolve_executable(name: &str) -> Result<PathBuf, String> {
    if !valid_executable_name(name) {
        return Err("依赖名称只能包含字母、数字、点、加号、减号和下划线".into());
    }
    let path = std::env::var_os("PATH").unwrap_or_default();
    for directory in std::env::split_paths(&path) {
        for candidate in executable_candidates(name) {
            let candidate = directory.join(candidate);
            if candidate.is_file() {
                return Ok(candidate);
            }
        }
    }
    Err(format!("缺少可执行依赖 `{name}`；请安装后重试，或先查询 native_capabilities 查看 Rust 内置替代能力"))
}

pub fn check_dependencies(names: &[String]) -> Result<Value, String> {
    if names.is_empty() || names.len() > 30 {
        return Err("依赖探测需要 1 至 30 个名称".into());
    }
    let mut available = Vec::new();
    let mut missing = Vec::new();
    for name in names {
        match resolve_executable(name) {
            Ok(path) => available.push(json!({"name":name,"path":path})),
            Err(_) => missing.push(name),
        }
    }
    Ok(json!({"available":available,"missing":missing,"allAvailable":missing.is_empty()}))
}

async fn read_limited<R>(mut reader: R) -> Result<(String, bool), String>
where
    R: AsyncRead + Unpin,
{
    let mut collected = Vec::new();
    let mut truncated = false;
    let mut chunk = [0_u8; 8192];
    loop {
        let count = reader
            .read(&mut chunk)
            .await
            .map_err(|error| format!("读取进程输出失败: {error}"))?;
        if count == 0 {
            break;
        }
        let remaining = MAX_OUTPUT_BYTES.saturating_sub(collected.len());
        if remaining > 0 {
            collected.extend_from_slice(&chunk[..count.min(remaining)]);
        }
        truncated |= count > remaining;
    }
    Ok((String::from_utf8_lossy(&collected).into_owned(), truncated))
}

async fn finish_output(
    mut task: JoinHandle<Result<(String, bool), String>>,
) -> Result<(String, bool), String> {
    tokio::select! {
        result = &mut task => result.map_err(|error| format!("进程输出任务失败: {error}"))?,
        _ = sleep(Duration::from_secs(2)) => {
            task.abort();
            Ok(("[output pipe remained open after process exit]".into(), true))
        }
    }
}

fn sanitized_command(executable: &Path, args: &[String], cwd: &Path) -> Command {
    let mut command = Command::new(executable);
    command
        .args(args)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .env_clear();
    for name in [
        "PATH",
        "HOME",
        "USERPROFILE",
        "TMPDIR",
        "TEMP",
        "LANG",
        "LC_ALL",
        "SystemRoot",
        "COMSPEC",
        "PATHEXT",
    ] {
        if let Some(value) = std::env::var_os(name) {
            command.env(name, value);
        }
    }
    command.env("CLAWMASTER_CLI", "1");
    command
}

pub async fn run(
    executable: &Path,
    args: &[String],
    cwd: &Path,
    timeout_seconds: u64,
    mut cancel: watch::Receiver<bool>,
) -> Result<Value, String> {
    if args.len() > 100 || args.iter().map(String::len).sum::<usize>() > 32_768 {
        return Err("命令参数数量或总长度超过限制".into());
    }
    if *cancel.borrow() {
        return Ok(json!({
            "executable": executable, "args": args, "directory": cwd,
            "success": false, "exitCode": null, "termination": "cancelled",
            "stdout": "", "stderr": "", "stdoutTruncated": false, "stderrTruncated": false
        }));
    }
    let mut child = sanitized_command(executable, args, cwd)
        .spawn()
        .map_err(|error| format!("无法启动 `{}`: {error}", executable.display()))?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "无法捕获进程标准输出".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "无法捕获进程错误输出".to_string())?;
    let stdout_task = tokio::spawn(read_limited(stdout));
    let stderr_task = tokio::spawn(read_limited(stderr));
    let timeout_seconds = timeout_seconds.clamp(1, 300);
    let timer = sleep(Duration::from_secs(timeout_seconds));
    tokio::pin!(timer);

    let (status, termination) = tokio::select! {
        status = child.wait() => (
            Some(status.map_err(|error| format!("等待进程失败: {error}"))?),
            "exited"
        ),
        _ = &mut timer => {
            let _ = child.kill().await;
            let _ = child.wait().await;
            (None, "timeout")
        },
        changed = cancel.changed() => {
            if changed.is_ok() && *cancel.borrow() {
                let _ = child.kill().await;
                let _ = child.wait().await;
                (None, "cancelled")
            } else {
                let status = child.wait().await.map_err(|error| format!("等待进程失败: {error}"))?;
                (Some(status), "exited")
            }
        }
    };
    let (stdout, stdout_truncated) = finish_output(stdout_task).await?;
    let (stderr, stderr_truncated) = finish_output(stderr_task).await?;
    Ok(json!({
        "executable": executable,
        "args": args,
        "directory": cwd,
        "success": status.as_ref().is_some_and(|value| value.success()),
        "exitCode": status.and_then(|value| value.code()),
        "termination": termination,
        "stdout": stdout,
        "stderr": stderr,
        "stdoutTruncated": stdout_truncated,
        "stderrTruncated": stderr_truncated
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::AsyncWriteExt;

    #[test]
    fn reports_available_and_missing_dependencies() {
        let result =
            check_dependencies(&["cargo".into(), "definitely-missing-clawmaster-bin".into()])
                .unwrap();
        assert_eq!(result["allAvailable"], false);
        assert_eq!(result["missing"][0], "definitely-missing-clawmaster-bin");
        assert_eq!(result["available"][0]["name"], "cargo");
    }

    #[tokio::test]
    async fn runs_with_bounded_output_and_reports_exit_status() {
        let root = tempfile::tempdir().unwrap();
        #[cfg(windows)]
        let (executable, args) = (
            resolve_executable("cmd").unwrap(),
            vec!["/d".into(), "/s".into(), "/c".into(), "echo native".into()],
        );
        #[cfg(not(windows))]
        let (executable, args) = (resolve_executable("printf").unwrap(), vec!["native".into()]);
        let (_sender, cancel) = watch::channel(false);
        let result = run(&executable, &args, root.path(), 5, cancel)
            .await
            .unwrap();
        assert_eq!(result["success"], true);
        assert!(result["stdout"].as_str().unwrap().contains("native"));
    }

    #[tokio::test]
    async fn cancellation_terminates_the_process() {
        #[cfg(windows)]
        let (executable, args) = (
            resolve_executable("ping").unwrap(),
            vec!["127.0.0.1".into(), "-n".into(), "30".into()],
        );
        #[cfg(not(windows))]
        let (executable, args) = (resolve_executable("sleep").unwrap(), vec!["30".into()]);
        let root = tempfile::tempdir().unwrap();
        let (sender, cancel) = watch::channel(false);
        let task =
            tokio::spawn(async move { run(&executable, &args, root.path(), 60, cancel).await });
        sender.send_replace(true);
        let result = task.await.unwrap().unwrap();
        assert_eq!(result["termination"], "cancelled");
    }

    #[tokio::test]
    async fn output_capture_is_hard_bounded() {
        let (mut writer, reader) = tokio::io::duplex(16 * 1024);
        let write = tokio::spawn(async move {
            writer
                .write_all(&vec![b'x'; MAX_OUTPUT_BYTES + 1])
                .await
                .unwrap();
        });
        let (output, truncated) = read_limited(reader).await.unwrap();
        write.await.unwrap();
        assert_eq!(output.len(), MAX_OUTPUT_BYTES);
        assert!(truncated);
    }
}
