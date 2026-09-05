use serde::Deserialize;
use serde_json::Value;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{
    webview::PageLoadEvent, AppHandle, LogicalPosition, LogicalSize, Manager, WebviewBuilder,
    WebviewUrl,
};
use tokio::sync::oneshot;
use url::Url;

const PLATFORM_WEBVIEW_LABEL: &str = "platform-browser";
const MAX_WEBVIEW_EDGE: f64 = 16_384.0;
const PLATFORM_LOAD_TIMEOUT: Duration = Duration::from_secs(20);
const PLATFORM_SNAPSHOT_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_SNAPSHOT_BYTES: usize = 256 * 1024;

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
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
    {
        return Err("平台地址必须是没有内嵌凭据的 HTTP 或 HTTPS 地址".into());
    }
    Ok(url)
}

pub(crate) fn validated_url_string(value: &str) -> Result<String, String> {
    validate_url(value).map(|url| url.to_string())
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
    let (loaded_tx, loaded_rx) = oneshot::channel();
    let loaded_tx = Arc::new(Mutex::new(Some(loaded_tx)));
    let builder = WebviewBuilder::new(PLATFORM_WEBVIEW_LABEL, WebviewUrl::External(url))
        .on_navigation(|candidate| validate_url(candidate.as_str()).is_ok())
        .on_page_load(move |_webview, payload| {
            if payload.event() != PageLoadEvent::Finished {
                return;
            }
            if let Ok(mut sender) = loaded_tx.lock() {
                if let Some(sender) = sender.take() {
                    let _ = sender.send(());
                }
            }
        });
    let webview = window
        .add_child(
            builder,
            LogicalPosition::new(bounds.x, bounds.y),
            LogicalSize::new(bounds.width, bounds.height),
        )
        .map_err(|error| format!("无法创建内置浏览器: {error}"))?;
    match tokio::time::timeout(PLATFORM_LOAD_TIMEOUT, loaded_rx).await {
        Ok(Ok(())) => Ok(()),
        Ok(Err(_)) => {
            let _ = webview.close();
            Err("内置浏览器在页面加载完成前意外关闭".into())
        }
        Err(_) => {
            let _ = webview.close();
            Err("内置浏览器加载超时，已回退系统浏览器".into())
        }
    }
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

fn decode_snapshot(raw: &str) -> Result<Value, String> {
    if raw.len() > MAX_SNAPSHOT_BYTES {
        return Err("浏览器 DOM 摘要超过 256 KiB 安全上限".into());
    }
    let outer: Value =
        serde_json::from_str(raw).map_err(|error| format!("无法解析浏览器 DOM 摘要: {error}"))?;
    let value = match outer {
        Value::String(inner) => serde_json::from_str(&inner)
            .map_err(|error| format!("无法解析浏览器 DOM 内容: {error}"))?,
        value => value,
    };
    if let Some(error) = value.get("error").and_then(Value::as_str) {
        return Err(format!("无法读取浏览器 DOM: {error}"));
    }
    Ok(value)
}

async fn evaluate_json(webview: &tauri::Webview, script: String) -> Result<Value, String> {
    let (snapshot_tx, snapshot_rx) = oneshot::channel();
    let snapshot_tx = Arc::new(Mutex::new(Some(snapshot_tx)));
    webview
        .eval_with_callback(script, move |raw| {
            if let Ok(mut sender) = snapshot_tx.lock() {
                if let Some(sender) = sender.take() {
                    let _ = sender.send(raw);
                }
            }
        })
        .map_err(|error| format!("无法请求浏览器 DOM 操作: {error}"))?;
    let raw = tokio::time::timeout(PLATFORM_SNAPSHOT_TIMEOUT, snapshot_rx)
        .await
        .map_err(|_| "浏览器 DOM 操作超时".to_string())?
        .map_err(|_| "浏览器 DOM 操作通道意外关闭".to_string())?;
    decode_snapshot(&raw)
}

pub async fn platform_webview_snapshot(app: &AppHandle) -> Result<Value, String> {
    let webview = app
        .get_webview(PLATFORM_WEBVIEW_LABEL)
        .ok_or_else(|| "内置浏览器尚未启动".to_string())?;
    evaluate_json(
        &webview,
        r#"(() => {
              try {
                const cleanUrl = (value) => {
                  try { const url = new URL(value, location.href); return url.origin + url.pathname; }
                  catch { return ''; }
                };
                const visible = (element) => {
                  const style = getComputedStyle(element);
                  const rect = element.getBoundingClientRect();
                  return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
                };
                const elements = Array.from(document.querySelectorAll('a,button,input,select,textarea,[role="button"],[role="link"]'))
                  .filter(visible)
                  .slice(0, 200)
                  .map((element, index) => ({
                    index,
                    tag: element.tagName.toLowerCase(),
                    type: element.getAttribute('type') || '',
                    text: (element.innerText || '').trim().slice(0, 300),
                    ariaLabel: (element.getAttribute('aria-label') || '').slice(0, 300),
                    placeholder: (element.getAttribute('placeholder') || '').slice(0, 300),
                    href: element.tagName === 'A' ? cleanUrl(element.href) : ''
                  }));
                return JSON.stringify({
                  url: cleanUrl(location.href),
                  title: document.title.slice(0, 500),
                  text: (document.body?.innerText || '').slice(0, 20000),
                  elements,
                  truncated: elements.length === 200 || (document.body?.innerText || '').length > 20000
                });
              } catch (error) {
                return JSON.stringify({ error: String(error) });
              }
            })()"#
            .to_string(),
    )
    .await
}

fn validate_browser_action(action: &str, index: usize) -> Result<(), String> {
    if !matches!(action, "click" | "focus" | "scroll") {
        return Err("浏览器动作仅支持 click、focus 或 scroll".into());
    }
    if index >= 200 {
        return Err("浏览器元素索引必须在 0 到 199 之间".into());
    }
    Ok(())
}

pub async fn platform_webview_action(
    app: &AppHandle,
    action: &str,
    index: usize,
) -> Result<Value, String> {
    validate_browser_action(action, index)?;
    let webview = app
        .get_webview(PLATFORM_WEBVIEW_LABEL)
        .ok_or_else(|| "内置浏览器尚未启动".to_string())?;
    let script = r#"(() => {
      try {
        const action = __ACTION__;
        const index = __INDEX__;
        const visible = (element) => {
          const style = getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
        };
        const elements = Array.from(document.querySelectorAll('a,button,input,select,textarea,[role="button"],[role="link"]'))
          .filter(visible)
          .slice(0, 200);
        const element = elements[index];
        if (!element) return JSON.stringify({ error: 'element index is no longer available; take a new snapshot' });
        if (action === 'click') element.click();
        if (action === 'focus') element.focus({ preventScroll: false });
        if (action === 'scroll') element.scrollIntoView({ block: 'center', inline: 'center' });
        return JSON.stringify({
          completed: true,
          action,
          index,
          tag: element.tagName.toLowerCase(),
          type: element.getAttribute('type') || '',
          text: (element.innerText || '').trim().slice(0, 300),
          ariaLabel: (element.getAttribute('aria-label') || '').slice(0, 300)
        });
      } catch (error) {
        return JSON.stringify({ error: String(error) });
      }
    })()"#
        .replace("__ACTION__", &serde_json::to_string(action).unwrap_or_else(|_| "\"\"".into()))
        .replace("__INDEX__", &index.to_string());
    evaluate_json(&webview, script).await
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
        let valid = PlatformWebviewBounds {
            x: 10.0,
            y: 20.0,
            width: 640.0,
            height: 480.0,
        };
        assert!(validate_bounds(valid).is_ok());
        assert!(validate_bounds(PlatformWebviewBounds {
            width: 0.0,
            ..valid
        })
        .is_err());
        assert!(validate_bounds(PlatformWebviewBounds {
            x: f64::NAN,
            ..valid
        })
        .is_err());
        assert!(validate_bounds(PlatformWebviewBounds {
            height: 20_000.0,
            ..valid
        })
        .is_err());
    }

    #[test]
    fn decodes_direct_and_json_string_snapshot_results() {
        let direct = decode_snapshot(r#"{"title":"Example","text":"Hello"}"#).unwrap();
        assert_eq!(direct["title"], "Example");
        let encoded = serde_json::to_string(r#"{"title":"Encoded"}"#).unwrap();
        assert_eq!(decode_snapshot(&encoded).unwrap()["title"], "Encoded");
        assert!(decode_snapshot(r#"{"error":"denied"}"#).is_err());
    }

    #[test]
    fn browser_actions_are_allowlisted_and_bounded() {
        assert!(validate_browser_action("click", 0).is_ok());
        assert!(validate_browser_action("focus", 199).is_ok());
        assert!(validate_browser_action("scroll", 3).is_ok());
        assert!(validate_browser_action("script", 0).is_err());
        assert!(validate_browser_action("click", 200).is_err());
    }
}
