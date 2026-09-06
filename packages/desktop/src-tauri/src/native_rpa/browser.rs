use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use url::Url;

#[derive(Clone)]
pub struct Candidate {
    pub id: &'static str,
    pub label: &'static str,
    pub executable: PathBuf,
    pub webdriver_contract: bool,
}

pub fn candidates() -> Vec<Candidate> {
    #[cfg(target_os = "macos")]
    {
        vec![
            Candidate {
                id: "chrome",
                label: "Google Chrome",
                executable: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome".into(),
                webdriver_contract: false,
            },
            Candidate {
                id: "edge",
                label: "Microsoft Edge",
                executable: "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge".into(),
                webdriver_contract: false,
            },
            Candidate {
                id: "safari-webdriver",
                label: "Safari WebDriver",
                executable: "/usr/bin/safaridriver".into(),
                webdriver_contract: true,
            },
        ]
    }
    #[cfg(target_os = "windows")]
    {
        let mut roots = ["PROGRAMFILES", "PROGRAMFILES(X86)"]
            .into_iter()
            .filter_map(std::env::var_os)
            .map(PathBuf::from)
            .collect::<Vec<_>>();
        if let Some(root) = std::env::var_os("LOCALAPPDATA").map(PathBuf::from) {
            roots.push(root);
        }
        vec![
            Candidate {
                id: "edge",
                label: "Microsoft Edge",
                executable: first_existing(&roots, "Microsoft/Edge/Application/msedge.exe"),
                webdriver_contract: false,
            },
            Candidate {
                id: "chrome",
                label: "Google Chrome",
                executable: first_existing(&roots, "Google/Chrome/Application/chrome.exe"),
                webdriver_contract: false,
            },
        ]
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        Vec::new()
    }
}

#[cfg(target_os = "windows")]
fn first_existing(roots: &[PathBuf], suffix: &str) -> PathBuf {
    roots
        .iter()
        .map(|root| root.join(suffix))
        .find(|path| path.is_file())
        .or_else(|| roots.first().map(|root| root.join(suffix)))
        .unwrap_or_else(|| PathBuf::from(suffix))
}

pub fn select(id: Option<&str>) -> Result<Candidate, String> {
    let available = candidates();
    if let Some(id) = id {
        return available
            .into_iter()
            .find(|candidate| candidate.id == id && candidate.executable.is_file())
            .ok_or_else(|| format!("系统浏览器 {id} 未安装"));
    }
    available
        .into_iter()
        .find(|candidate| !candidate.webdriver_contract && candidate.executable.is_file())
        .ok_or_else(|| "未找到受支持的系统 Chrome 或 Edge，请先安装浏览器".into())
}

pub fn validate_navigation_url(value: &str) -> Result<(), String> {
    let url = Url::parse(value).map_err(|_| "RPA URL 无效".to_string())?;
    let loopback = url
        .host_str()
        .is_some_and(|host| matches!(host, "localhost" | "127.0.0.1" | "[::1]"));
    if url.scheme() != "https" && !(url.scheme() == "http" && loopback) {
        return Err("RPA 仅允许 HTTPS 或 loopback 测试地址".into());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("RPA URL 不得包含凭据".into());
    }
    Ok(())
}

pub fn profile_path(root: &Path, tenant_id: &str, platform_id: &str, browser: &str) -> PathBuf {
    root.join(safe_segment(tenant_id))
        .join(safe_segment(platform_id))
        .join(browser)
}

pub fn spawn(candidate: &Candidate, profile: &Path, url: &str) -> Result<Child, String> {
    Command::new(&candidate.executable)
        .arg(format!("--user-data-dir={}", profile.display()))
        .arg("--no-first-run")
        .arg("--no-default-browser-check")
        .arg("--new-window")
        .arg(url)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|error| format!("无法启动系统浏览器 {}: {error}", candidate.label))
}

fn safe_segment(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn profiles_are_tenant_and_platform_isolated_without_plaintext_names() {
        let first = safe_segment("tenant-a");
        let second = safe_segment("tenant-b");
        assert_ne!(first, second);
        assert!(!first.contains("tenant"));
        assert!(validate_navigation_url("https://example.com/path").is_ok());
        assert!(validate_navigation_url("http://example.com/path").is_err());
        assert!(validate_navigation_url("https://user:secret@example.com/").is_err());
    }
}
