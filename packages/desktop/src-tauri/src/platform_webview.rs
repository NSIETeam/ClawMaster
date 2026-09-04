use serde::Deserialize;
use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, WebviewBuilder, WebviewUrl};
use url::Url;

const PLATFORM_WEBVIEW_LABEL: &str = "platform-browser";
const MAX_WEBVIEW_EDGE: f64 = 16_384.0;

#[derive(Clone, Copy, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlatformWebviewBounds {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

fn validate_url(value: &str) -> Result<Url, String> {
    let url = Url::parse(value).map_err(|_| "平台地址无效".to_string())?;
    if !matches!(url.scheme(), "http" | "https") || !url.username().is_empty() || url.password().is_some() {
        return Err("平台地址必须是没有内嵌凭据的 HTTP 或 HTTPS 地址".into());
    }
    Ok(url)
}

fn validate_bounds(bounds: PlatformWebviewBounds) -> Result<PlatformWebviewBounds, String> {
    let values = [bounds.x, bounds.y, bounds.width, bounds.height];
    if values.iter().any(|value| !value.is_finite())
        || bounds.x < 0.0
        || bounds.y < 0.0
        || bounds.width < 1.0
        || bounds.height < 1.0
        || values.iter().any(|value| *value > MAX_WEBVIEW_EDGE)
    {
        return Err("平台浏览器区域无效".into());
    }
    Ok(bounds)
}

fn apply_bounds(webview: &tauri::Webview, bounds: PlatformWebviewBounds) -> Result<(), String> {
    webview
        .set_position(LogicalPosition::new(bounds.x, bounds.y))
        .map_err(|error| format!("无法定位内置浏览器: {error}"))?;
    webview
        .set_size(LogicalSize::new(bounds.width, bounds.height))
        .map_err(|error| format!("无法调整内置浏览器: {error}"))
}

#[tauri::command]
pub async fn platform_webview_open(
    app: AppHandle,
    url: String,
    bounds: PlatformWebviewBounds,
) -> Result<(), String> {
    let url = validate_url(&url)?;
    let bounds = validate_bounds(bounds)?;
    if let Some(existing) = app.get_webview(PLATFORM_WEBVIEW_LABEL) {
        existing
            .close()
            .map_err(|error| format!("无法替换内置浏览器: {error}"))?;
    }
    let window = app
        .get_window("main")
        .ok_or_else(|| "ClawMaster 主窗口不可用".to_string())?;
    let builder = WebviewBuilder::new(PLATFORM_WEBVIEW_LABEL, WebviewUrl::External(url))
        .on_navigation(|candidate| validate_url(candidate.as_str()).is_ok());
    window
        .add_child(
            builder,
            LogicalPosition::new(bounds.x, bounds.y),
            LogicalSize::new(bounds.width, bounds.height),
        )
        .map_err(|error| format!("无法创建内置浏览器: {error}"))?;
    Ok(())
}

#[tauri::command]
pub fn platform_webview_set_bounds(
    app: AppHandle,
    bounds: PlatformWebviewBounds,
) -> Result<(), String> {
    let bounds = validate_bounds(bounds)?;
    let webview = app
        .get_webview(PLATFORM_WEBVIEW_LABEL)
        .ok_or_else(|| "内置浏览器尚未启动".to_string())?;
    apply_bounds(&webview, bounds)
}

#[tauri::command]
pub fn platform_webview_reload(app: AppHandle) -> Result<(), String> {
    let webview = app
        .get_webview(PLATFORM_WEBVIEW_LABEL)
        .ok_or_else(|| "内置浏览器尚未启动".to_string())?;
    webview
        .reload()
        .map_err(|error| format!("无法刷新内置浏览器: {error}"))
}

#[tauri::command]
pub fn platform_webview_close(app: AppHandle) -> Result<(), String> {
    if let Some(webview) = app.get_webview(PLATFORM_WEBVIEW_LABEL) {
        webview
            .close()
            .map_err(|error| format!("无法关闭内置浏览器: {error}"))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_credential_free_web_urls() {
        assert!(validate_url("https://example.com/login").is_ok());
        assert!(validate_url("http://127.0.0.1:8080/").is_ok());
        assert!(validate_url("file:///tmp/private").is_err());
        assert!(validate_url("https://user:secret@example.com/").is_err());
    }

    #[test]
    fn rejects_invalid_or_unbounded_layout_coordinates() {
        let valid = PlatformWebviewBounds { x: 10.0, y: 20.0, width: 640.0, height: 480.0 };
        assert!(validate_bounds(valid).is_ok());
        assert!(validate_bounds(PlatformWebviewBounds { width: 0.0, ..valid }).is_err());
        assert!(validate_bounds(PlatformWebviewBounds { x: f64::NAN, ..valid }).is_err());
        assert!(validate_bounds(PlatformWebviewBounds { height: 20_000.0, ..valid }).is_err());
    }
}
