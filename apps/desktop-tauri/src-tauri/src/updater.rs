use std::{future::Future, sync::Arc};

use tauri::AppHandle;
use tauri_plugin_updater::UpdaterExt;

use crate::chrome;
use crate::i18n::{self, Msg};
use crate::runtime::ProvisionEvent;

/// Empty endpoints disable update requests, including releases that sign downloadable artifacts.
async fn with_update_channel<T, F, Work>(
    config: Option<&serde_json::Value>,
    operation: F,
) -> Result<Option<T>, String>
where
    F: FnOnce() -> Work,
    Work: Future<Output = Result<T, String>>,
{
    let Some(config) = config else {
        return Ok(None);
    };
    let config: tauri_plugin_updater::Config =
        serde_json::from_value(config.clone()).map_err(|error| error.to_string())?;
    let no_key = config.pubkey.trim().is_empty();
    let no_endpoints = config.endpoints.is_empty();
    if no_endpoints {
        return Ok(None);
    }
    if no_key {
        return Err(
            "ClawMaster update channel requires both endpoints and a signing public key".into(),
        );
    }
    operation().await.map(Some)
}

/// Install a signed update only when this release configures its own channel.
pub async fn install_available(
    app: &AppHandle,
    progress: Arc<dyn Fn(ProvisionEvent) + Send + Sync>,
) -> Result<(), String> {
    if cfg!(debug_assertions) {
        return Ok(());
    }

    with_update_channel(app.config().plugins.0.get("updater"), || {
        install_from_channel(app, progress)
    })
    .await
    .map(|_| ())
}

async fn install_from_channel(
    app: &AppHandle,
    progress: Arc<dyn Fn(ProvisionEvent) + Send + Sync>,
) -> Result<String, String> {
    progress(ProvisionEvent::Status(
        i18n::t(Msg::StatusCheckUpdate).into(),
    ));
    let Some(update) = app
        .updater()
        .map_err(|error| error.to_string())?
        .check()
        .await
        .map_err(|error| error.to_string())?
    else {
        return Ok(i18n::t(Msg::UpdaterCurrent).into());
    };

    progress(ProvisionEvent::Status(i18n::tf(
        Msg::StatusDownloadUpdate,
        &update.version,
    )));
    let progress_for_download = Arc::clone(&progress);
    let mut downloaded = 0_u64;
    update
        .download_and_install(
            move |chunk_length, content_length| {
                downloaded = downloaded.saturating_add(chunk_length as u64);
                if let Some(content_length) = content_length.filter(|length| *length > 0) {
                    let percent =
                        ((downloaded.saturating_mul(100)) / content_length).min(100) as u8;
                    progress_for_download(ProvisionEvent::Progress(percent));
                }
            },
            || {},
        )
        .await
        .map_err(|error| error.to_string())?;

    chrome::request_restart(app);
}

/// Check for a signed update from the tray. Debug builds skip the network.
pub async fn check_now(app: &AppHandle) -> Result<String, String> {
    if cfg!(debug_assertions) {
        return Ok(i18n::t(Msg::UpdaterDevSkip).into());
    }

    Ok(
        with_update_channel(app.config().plugins.0.get("updater"), || {
            install_from_channel(app, Arc::new(|_| {}))
        })
        .await?
        .unwrap_or_else(|| i18n::t(Msg::UpdaterUnconfigured).into()),
    )
}

#[cfg(test)]
mod tests {
    use super::with_update_channel;
    use serde_json::json;
    use std::cell::Cell;

    #[tokio::test]
    async fn shipped_config_never_starts_update_requests() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let calls = Cell::new(0);
        let result = with_update_channel(config["plugins"].get("updater"), || async {
            calls.set(calls.get() + 1);
            Ok(())
        })
        .await;
        assert_eq!(result, Ok(None));
        assert_eq!(calls.get(), 0);
    }

    #[tokio::test]
    async fn absent_disabled_or_invalid_channels_cannot_start_update_requests() {
        let calls = Cell::new(0);
        let configurations = [
            None,
            Some(json!({"pubkey": "", "endpoints": ["https://updates.example.test/latest.json"]})),
            Some(json!({"pubkey": "release-key", "endpoints": []})),
            Some(json!({"pubkey": 42, "endpoints": []})),
        ];
        for (index, config) in configurations.iter().enumerate() {
            let result = with_update_channel(config.as_ref(), || async {
                calls.set(calls.get() + 1);
                Ok(())
            })
            .await;
            if index == 0 || index == 2 {
                assert_eq!(result, Ok(None));
            } else {
                assert!(result.is_err());
            }
        }
        assert_eq!(calls.get(), 0);
    }

    #[tokio::test]
    async fn complete_configuration_invokes_the_update_operation() {
        let config = json!({"pubkey": "release-key", "endpoints": ["https://updates.example.test/latest.json"]});
        let calls = Cell::new(0);
        let result = with_update_channel(Some(&config), || async {
            calls.set(calls.get() + 1);
            Ok("checked")
        })
        .await;
        assert_eq!(result, Ok(Some("checked")));
        assert_eq!(calls.get(), 1);
    }
}
