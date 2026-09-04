use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State};

const RELEASES_API: &str = "https://api.github.com/repos/NSIETeam/ClawMaster/releases?per_page=20";
const RELEASE_PAGE: &str = "https://github.com/NSIETeam/ClawMaster/releases";
const MAX_INSTALLER_BYTES: u64 = 300 * 1024 * 1024;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateAsset {
    name: String,
    url: String,
    size: u64,
    sha256: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    version: String,
    #[serde(default)]
    notes: String,
    published_at: Option<String>,
    assets: serde_json::Map<String, serde_json::Value>,
}

#[derive(Clone, Debug, Deserialize)]
struct ReleaseAsset {
    name: String,
    browser_download_url: String,
}

#[derive(Clone, Debug, Deserialize)]
struct Release {
    tag_name: String,
    #[serde(default)]
    body: String,
    published_at: Option<String>,
    #[serde(default)]
    assets: Vec<ReleaseAsset>,
    #[serde(default)]
    draft: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(tag = "status", rename_all = "kebab-case")]
pub enum UpdateCheckResult {
    UpdateAvailable {
        #[serde(rename = "currentVersion")]
        current_version: String,
        version: String,
        notes: String,
        #[serde(rename = "publishedAt")]
        published_at: Option<String>,
        asset: Option<UpdateAsset>,
        #[serde(rename = "releasePageUrl")]
        release_page_url: String,
    },
    UpToDate {
        #[serde(rename = "currentVersion")]
        current_version: String,
        #[serde(rename = "latestVersion")]
        latest_version: Option<String>,
    },
    CheckFailed {
        #[serde(rename = "currentVersion")]
        current_version: String,
        message: String,
    },
}

#[derive(Clone)]
struct AvailableUpdate {
    asset: UpdateAsset,
}

#[derive(Clone)]
struct ReadyInstaller {
    path: PathBuf,
    sha256: String,
}

#[derive(Default)]
pub struct NativeUpdateState {
    available: Mutex<Option<AvailableUpdate>>,
    ready: Mutex<Option<ReadyInstaller>>,
    downloading: AtomicBool,
    cancelled: AtomicBool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateDownloadResult {
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    file_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    reused: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    cancelled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct UpdateInstallResult {
    ok: bool,
    message: String,
}

fn parse_version(value: &str) -> Option<(u64, u64, u64, Vec<String>)> {
    let value = value.trim().trim_start_matches('v');
    let value = value.split('+').next()?;
    let (core, prerelease) = value.split_once('-').map_or((value, ""), |parts| parts);
    let mut parts = core.split('.');
    let parsed = (
        parts.next()?.parse().ok()?,
        parts.next()?.parse().ok()?,
        parts.next()?.parse().ok()?,
        prerelease
            .split('.')
            .filter(|part| !part.is_empty())
            .map(str::to_owned)
            .collect(),
    );
    if parts.next().is_some() {
        None
    } else {
        Some(parsed)
    }
}

fn compare_versions(left: &str, right: &str) -> Option<std::cmp::Ordering> {
    let left = parse_version(left)?;
    let right = parse_version(right)?;
    let core = (left.0, left.1, left.2).cmp(&(right.0, right.1, right.2));
    if !core.is_eq() {
        return Some(core);
    }
    match (left.3.is_empty(), right.3.is_empty()) {
        (true, true) => Some(std::cmp::Ordering::Equal),
        (true, false) => Some(std::cmp::Ordering::Greater),
        (false, true) => Some(std::cmp::Ordering::Less),
        (false, false) => {
            for index in 0..left.3.len().max(right.3.len()) {
                let Some(a) = left.3.get(index) else {
                    return Some(std::cmp::Ordering::Less);
                };
                let Some(b) = right.3.get(index) else {
                    return Some(std::cmp::Ordering::Greater);
                };
                if a == b {
                    continue;
                }
                let order = match (a.parse::<u64>(), b.parse::<u64>()) {
                    (Ok(a), Ok(b)) => a.cmp(&b),
                    (Ok(_), Err(_)) => std::cmp::Ordering::Less,
                    (Err(_), Ok(_)) => std::cmp::Ordering::Greater,
                    (Err(_), Err(_)) => a.cmp(b),
                };
                return Some(order);
            }
            Some(std::cmp::Ordering::Equal)
        }
    }
}

fn allowed_download_url(value: &str) -> bool {
    url::Url::parse(value).is_ok_and(|url| {
        url.scheme() == "https"
            && url.username().is_empty()
            && url.password().is_none()
            && url.host_str().is_some_and(|host| {
                host == "github.com"
                    || host == "api.github.com"
                    || host == "githubusercontent.com"
                    || host.ends_with(".githubusercontent.com")
            })
    })
}

fn target_key() -> Option<&'static str> {
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    return Some("mac-arm64");
    #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
    return Some("win-x64");
    #[allow(unreachable_code)]
    None
}

fn sha256_file(path: &Path) -> Result<String, String> {
    let bytes = fs::read(path).map_err(|error| format!("无法读取安装包: {error}"))?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}

fn failed(current_version: String, message: impl Into<String>) -> UpdateCheckResult {
    UpdateCheckResult::CheckFailed {
        current_version,
        message: message.into(),
    }
}

#[tauri::command]
pub async fn update_check(
    app: AppHandle,
    state: State<'_, NativeUpdateState>,
) -> Result<UpdateCheckResult, String> {
    let current_version = app.package_info().version.to_string();
    *state.available.lock().expect("update state poisoned") = None;
    let response = match reqwest::Client::new()
        .get(RELEASES_API)
        .header("User-Agent", "ClawMaster-Desktop")
        .header("Accept", "application/vnd.github+json")
        .timeout(std::time::Duration::from_secs(15))
        .send()
        .await
    {
        Ok(response) if response.status().is_success() => response,
        Ok(response) => {
            return Ok(failed(
                current_version,
                format!("GitHub 更新服务返回 HTTP {}", response.status()),
            ))
        }
        Err(error) => {
            return Ok(failed(
                current_version,
                format!("无法连接 GitHub 更新服务: {error}"),
            ))
        }
    };
    let releases = match response.json::<Vec<Release>>().await {
        Ok(releases) => releases,
        Err(error) => {
            return Ok(failed(
                current_version,
                format!("无法解析 GitHub 发布信息: {error}"),
            ))
        }
    };
    let release = releases
        .into_iter()
        .filter(|release| !release.draft && parse_version(&release.tag_name).is_some())
        .max_by(|left, right| {
            compare_versions(&left.tag_name, &right.tag_name).unwrap_or(std::cmp::Ordering::Equal)
        });
    let Some(release) = release else {
        return Ok(failed(current_version, "GitHub 尚无可用发布版本"));
    };
    let version = release.tag_name.trim_start_matches('v').to_string();
    let Some(order) = compare_versions(&current_version, &version) else {
        return Ok(failed(
            current_version,
            format!("无法比较当前版本与发布版本 {version}"),
        ));
    };
    if !order.is_lt() {
        return Ok(UpdateCheckResult::UpToDate {
            current_version,
            latest_version: Some(version),
        });
    }
    let manifest_asset = release
        .assets
        .iter()
        .find(|asset| asset.name == "latest.json");
    let mut notes = release.body;
    let mut published_at = release.published_at;
    let mut asset = None;
    if let Some(manifest_asset) =
        manifest_asset.filter(|asset| allowed_download_url(&asset.browser_download_url))
    {
        if let Ok(response) = reqwest::Client::new()
            .get(&manifest_asset.browser_download_url)
            .header("User-Agent", "ClawMaster-Desktop")
            .timeout(std::time::Duration::from_secs(15))
            .send()
            .await
        {
            if let Ok(manifest) = response.json::<Manifest>().await {
                if manifest.version.trim_start_matches('v') == version {
                    notes = manifest.notes;
                    published_at = manifest.published_at;
                    asset = target_key()
                        .and_then(|key| manifest.assets.get(key))
                        .and_then(|value| serde_json::from_value::<UpdateAsset>(value.clone()).ok())
                        .filter(|asset| {
                            asset.size <= MAX_INSTALLER_BYTES
                                && asset.sha256.len() == 64
                                && allowed_download_url(&asset.url)
                        });
                }
            }
        }
    }
    if let Some(selected) = asset.clone() {
        *state.available.lock().expect("update state poisoned") =
            Some(AvailableUpdate { asset: selected });
    }
    Ok(UpdateCheckResult::UpdateAvailable {
        current_version,
        version,
        notes,
        published_at,
        asset,
        release_page_url: format!("{RELEASE_PAGE}/tag/{}", release.tag_name),
    })
}

#[tauri::command]
pub async fn update_download(
    app: AppHandle,
    state: State<'_, NativeUpdateState>,
) -> Result<UpdateDownloadResult, String> {
    if state.downloading.swap(true, Ordering::AcqRel) {
        return Ok(UpdateDownloadResult {
            ok: false,
            file_path: None,
            reused: None,
            cancelled: None,
            error: Some("已有一个下载任务在进行中".into()),
        });
    }
    state.cancelled.store(false, Ordering::Release);
    let result = download_inner(&app, &state).await;
    state.downloading.store(false, Ordering::Release);
    Ok(result)
}

async fn download_inner(app: &AppHandle, state: &NativeUpdateState) -> UpdateDownloadResult {
    let Some(available) = state
        .available
        .lock()
        .expect("update state poisoned")
        .clone()
    else {
        return UpdateDownloadResult {
            ok: false,
            file_path: None,
            reused: None,
            cancelled: None,
            error: Some("当前没有可下载的更新，请先检查更新".into()),
        };
    };
    let Some(file_name) = Path::new(&available.asset.name)
        .file_name()
        .and_then(|name| name.to_str())
    else {
        return UpdateDownloadResult {
            ok: false,
            file_path: None,
            reused: None,
            cancelled: None,
            error: Some("更新清单中的文件名无效".into()),
        };
    };
    let directory = match app.path().download_dir() {
        Ok(path) => path,
        Err(error) => {
            return UpdateDownloadResult {
                ok: false,
                file_path: None,
                reused: None,
                cancelled: None,
                error: Some(format!("无法定位下载目录: {error}")),
            }
        }
    };
    let final_path = directory.join(file_name);
    if final_path.is_file()
        && sha256_file(&final_path).is_ok_and(|hash| hash == available.asset.sha256.to_lowercase())
    {
        *state.ready.lock().expect("update state poisoned") = Some(ReadyInstaller {
            path: final_path.clone(),
            sha256: available.asset.sha256,
        });
        return UpdateDownloadResult {
            ok: true,
            file_path: Some(final_path.to_string_lossy().into_owned()),
            reused: Some(true),
            cancelled: None,
            error: None,
        };
    }
    let mut response = match reqwest::Client::new()
        .get(&available.asset.url)
        .header("User-Agent", "ClawMaster-Desktop")
        .timeout(std::time::Duration::from_secs(180))
        .send()
        .await
    {
        Ok(response)
            if response.status().is_success() && allowed_download_url(response.url().as_str()) =>
        {
            response
        }
        Ok(response) => {
            return UpdateDownloadResult {
                ok: false,
                file_path: None,
                reused: None,
                cancelled: None,
                error: Some(format!("安装包下载被拒绝或返回 HTTP {}", response.status())),
            }
        }
        Err(error) => {
            return UpdateDownloadResult {
                ok: false,
                file_path: None,
                reused: None,
                cancelled: None,
                error: Some(format!("下载安装包失败: {error}")),
            }
        }
    };
    if response
        .content_length()
        .is_some_and(|size| size > MAX_INSTALLER_BYTES)
    {
        return UpdateDownloadResult {
            ok: false,
            file_path: None,
            reused: None,
            cancelled: None,
            error: Some("安装包超过 300 MiB 安全上限".into()),
        };
    }
    let part_path = final_path.with_extension(format!(
        "{}.part",
        final_path
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or("download")
    ));
    let mut output = match fs::File::create(&part_path) {
        Ok(file) => file,
        Err(error) => {
            return UpdateDownloadResult {
                ok: false,
                file_path: None,
                reused: None,
                cancelled: None,
                error: Some(format!("无法创建临时安装包: {error}")),
            }
        }
    };
    let mut hasher = Sha256::new();
    let mut transferred = 0_u64;
    loop {
        if state.cancelled.load(Ordering::Acquire) {
            drop(output);
            let _ = fs::remove_file(&part_path);
            return UpdateDownloadResult {
                ok: false,
                file_path: None,
                reused: None,
                cancelled: Some(true),
                error: Some("下载已取消".into()),
            };
        }
        let chunk = match response.chunk().await {
            Ok(Some(chunk)) => chunk,
            Ok(None) => break,
            Err(error) => {
                drop(output);
                let _ = fs::remove_file(&part_path);
                return UpdateDownloadResult {
                    ok: false,
                    file_path: None,
                    reused: None,
                    cancelled: None,
                    error: Some(format!("读取安装包失败: {error}")),
                };
            }
        };
        transferred = transferred.saturating_add(chunk.len() as u64);
        if transferred > MAX_INSTALLER_BYTES
            || (available.asset.size != 0 && transferred > available.asset.size)
        {
            drop(output);
            let _ = fs::remove_file(&part_path);
            return UpdateDownloadResult {
                ok: false,
                file_path: None,
                reused: None,
                cancelled: None,
                error: Some("安装包大小超过发布清单或安全上限".into()),
            };
        }
        if let Err(error) = output.write_all(&chunk) {
            drop(output);
            let _ = fs::remove_file(&part_path);
            return UpdateDownloadResult {
                ok: false,
                file_path: None,
                reused: None,
                cancelled: None,
                error: Some(format!("无法写入临时安装包: {error}")),
            };
        }
        hasher.update(&chunk);
        let total = available.asset.size.max(transferred);
        let percent = if total == 0 {
            0.0
        } else {
            transferred as f64 * 100.0 / total as f64
        };
        let _ = app.emit(
            "desktop://update-progress",
            serde_json::json!({"percent":percent,"transferred":transferred,"total":total}),
        );
    }
    if available.asset.size != 0 && transferred != available.asset.size {
        drop(output);
        let _ = fs::remove_file(&part_path);
        return UpdateDownloadResult {
            ok: false,
            file_path: None,
            reused: None,
            cancelled: None,
            error: Some("安装包大小与发布清单不一致".into()),
        };
    }
    let hash = format!("{:x}", hasher.finalize());
    if hash != available.asset.sha256.to_lowercase() {
        drop(output);
        let _ = fs::remove_file(&part_path);
        return UpdateDownloadResult {
            ok: false,
            file_path: None,
            reused: None,
            cancelled: None,
            error: Some("安装包 SHA-256 与发布清单不一致".into()),
        };
    }
    if let Err(error) = output.sync_all().and_then(|_| {
        drop(output);
        fs::rename(&part_path, &final_path)
    }) {
        let _ = fs::remove_file(&part_path);
        return UpdateDownloadResult {
            ok: false,
            file_path: None,
            reused: None,
            cancelled: None,
            error: Some(format!("无法保存安装包: {error}")),
        };
    }
    let _ = app.emit(
        "desktop://update-progress",
        serde_json::json!({"percent":100,"transferred":transferred,"total":transferred}),
    );
    *state.ready.lock().expect("update state poisoned") = Some(ReadyInstaller {
        path: final_path.clone(),
        sha256: hash,
    });
    UpdateDownloadResult {
        ok: true,
        file_path: Some(final_path.to_string_lossy().into_owned()),
        reused: Some(false),
        cancelled: None,
        error: None,
    }
}

#[tauri::command]
pub fn update_cancel(state: State<'_, NativeUpdateState>) {
    state.cancelled.store(true, Ordering::Release);
}

#[tauri::command]
pub fn update_install(state: State<'_, NativeUpdateState>) -> UpdateInstallResult {
    let Some(ready) = state.ready.lock().expect("update state poisoned").clone() else {
        return UpdateInstallResult {
            ok: false,
            message: "没有已校验的安装包，请先下载更新。".into(),
        };
    };
    if sha256_file(&ready.path).map_or(true, |hash| hash != ready.sha256) {
        return UpdateInstallResult {
            ok: false,
            message: "安装前复验失败，安装包可能已被修改。".into(),
        };
    }
    match tauri_plugin_opener::open_path(&ready.path, None::<&str>) {
        Ok(()) => UpdateInstallResult {
            ok: true,
            message: "已打开安装包。安装完成后请重启 ClawMaster。".into(),
        },
        Err(error) => UpdateInstallResult {
            ok: false,
            message: format!("无法打开安装包: {error}"),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compares_release_and_prerelease_versions() {
        assert!(compare_versions("0.0.2-beta.1", "0.0.2-beta.2")
            .unwrap()
            .is_lt());
        assert!(compare_versions("0.0.2-beta.2", "0.0.2").unwrap().is_lt());
        assert!(compare_versions("v1.2.3", "1.2.3").unwrap().is_eq());
        assert!(compare_versions("invalid", "1.0.0").is_none());
    }

    #[test]
    fn accepts_only_official_https_download_hosts() {
        assert!(allowed_download_url(
            "https://release-assets.githubusercontent.com/a/file.dmg"
        ));
        assert!(!allowed_download_url("http://github.com/a/file.dmg"));
        assert!(!allowed_download_url(
            "https://github.com.evil.example/file.dmg"
        ));
    }
}
