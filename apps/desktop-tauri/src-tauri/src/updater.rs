//! Signed updates use separate download and installation confirmations; startup only checks.
use crate::i18n::{self, Msg};
use crate::{chrome, notify};
use std::{
    future::Future,
    sync::atomic::{AtomicBool, Ordering},
    time::Duration,
};
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons};
use tauri_plugin_updater::{Update, UpdaterExt};

static UPDATE_BUSY: AtomicBool = AtomicBool::new(false);

struct OperationGuard<'a>(&'a AtomicBool);
impl<'a> OperationGuard<'a> {
    fn acquire(flag: &'a AtomicBool) -> Option<Self> {
        flag.compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .ok()
            .map(|_| Self(flag))
    }
}
impl Drop for OperationGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum UpdateStage {
    Download,
    Install,
}

/// A cancelled confirmation or failed download cannot reach installation.
async fn confirmed_update<B, C, CF, D, DF, I>(
    mut confirm: C,
    download: D,
    install: I,
) -> Result<bool, String>
where
    C: FnMut(UpdateStage) -> CF,
    CF: Future<Output = Result<bool, String>>,
    D: FnOnce() -> DF,
    DF: Future<Output = Result<B, String>>,
    I: FnOnce(B) -> Result<(), String>,
{
    if !confirm(UpdateStage::Download).await? {
        return Ok(false);
    }
    let bytes = download().await?;
    if !confirm(UpdateStage::Install).await? {
        return Ok(false);
    }
    install(bytes)?;
    Ok(true)
}

/// Empty endpoints disable network operations. Enabled channels require their signing key.
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
    if config.endpoints.is_empty() {
        return Ok(None);
    }
    if config.pubkey.trim().is_empty() {
        return Err(
            "ClawMaster update channel requires both endpoints and a signing public key".into(),
        );
    }
    operation().await.map(Some)
}

async fn available(app: &AppHandle) -> Result<Option<Update>, String> {
    let before_exit = app.clone();
    app.updater_builder()
        .timeout(Duration::from_secs(30))
        .on_before_exit(move || {
            chrome::stop_host(&before_exit);
            before_exit.cleanup_before_exit();
        })
        .build()
        .map_err(|error| error.to_string())?
        .check()
        .await
        .map_err(|error| error.to_string())
}

/// Announce a stable update after startup without downloading, prompting, or restarting.
pub async fn check_available(app: &AppHandle) -> Result<(), String> {
    if cfg!(debug_assertions) {
        return Ok(());
    }
    let Some(_guard) = OperationGuard::acquire(&UPDATE_BUSY) else {
        return Ok(());
    };
    with_update_channel(app.config().plugins.0.get("updater"), || async {
        if let Some(update) = available(app).await? {
            notify::toast(
                app,
                "ClawMaster",
                &i18n::tf(Msg::UpdaterAvailable, &update.version),
            );
        }
        Ok(())
    })
    .await
    .map(|_| ())
}

async fn confirm_update(
    app: &AppHandle,
    stage: UpdateStage,
    version: &str,
) -> Result<bool, String> {
    let (message, action) = match stage {
        UpdateStage::Download => (Msg::UpdaterDownloadConfirm, Msg::UpdaterDownload),
        UpdateStage::Install => (Msg::UpdaterInstallConfirm, Msg::UpdaterInstall),
    };
    let (send, receive) = tokio::sync::oneshot::channel();
    let mut dialog = app
        .dialog()
        .message(i18n::tf(message, version))
        .title("ClawMaster")
        .buttons(MessageDialogButtons::OkCancelCustom(
            i18n::t(action).into(),
            i18n::t(Msg::UpdaterLater).into(),
        ));
    if let Some(window) = app.get_window("main") {
        dialog = dialog.parent(&window);
    }
    dialog.show(move |accepted| {
        let _ = send.send(accepted);
    });
    Ok(receive.await.unwrap_or(false))
}

/// Tray-triggered updates download only after consent and install only after a second confirmation.
pub async fn check_now(app: &AppHandle) -> Result<String, String> {
    if cfg!(debug_assertions) {
        return Ok(i18n::t(Msg::UpdaterDevSkip).into());
    }
    let Some(_guard) = OperationGuard::acquire(&UPDATE_BUSY) else {
        return Ok(i18n::t(Msg::UpdaterBusy).into());
    };
    notify::toast(app, "ClawMaster", i18n::t(Msg::StatusCheckUpdate));
    with_update_channel(app.config().plugins.0.get("updater"), || async {
        let Some(mut update) = available(app).await? else {
            return Ok(i18n::t(Msg::UpdaterCurrent).into());
        };
        update.timeout = Some(Duration::from_secs(900));
        let installed = confirmed_update(
            |stage| confirm_update(app, stage, &update.version),
            || async {
                notify::toast(
                    app,
                    "ClawMaster",
                    &i18n::tf(Msg::StatusDownloadUpdate, &update.version),
                );
                update
                    .download(|_, _| {}, || {})
                    .await
                    .map_err(|error| error.to_string())
            },
            |bytes| update.install(bytes).map_err(|error| error.to_string()),
        )
        .await?;
        if installed {
            chrome::request_restart(app);
        }
        Ok(i18n::t(Msg::UpdaterCancelled).into())
    })
    .await
    .map(|message| message.unwrap_or_else(|| i18n::t(Msg::UpdaterUnconfigured).into()))
}

#[cfg(test)]
mod tests {
    use super::{confirmed_update, with_update_channel, OperationGuard, UpdateStage};
    use serde_json::json;
    use std::{
        cell::{Cell, RefCell},
        sync::atomic::AtomicBool,
    };

    #[tokio::test]
    async fn refusing_download_performs_no_download_or_installation() {
        let calls = RefCell::new(Vec::new());
        let result = confirmed_update(
            |stage| {
                calls.borrow_mut().push(stage);
                async { Ok(false) }
            },
            || async { panic!("cancelled download started") },
            |_: Vec<u8>| panic!("cancelled installation started"),
        )
        .await;
        assert_eq!(result, Ok(false));
        assert_eq!(*calls.borrow(), vec![UpdateStage::Download]);
    }

    #[tokio::test]
    async fn refusing_installation_preserves_the_running_version_after_download() {
        let downloaded = Cell::new(false);
        let result = confirmed_update(
            |stage| async move { Ok(stage == UpdateStage::Download) },
            || async {
                downloaded.set(true);
                Ok(vec![1, 2, 3])
            },
            |_| panic!("installation ran without its own confirmation"),
        )
        .await;
        assert_eq!(result, Ok(false));
        assert!(downloaded.get());
    }

    #[tokio::test]
    async fn failed_download_or_signature_check_cannot_offer_installation() {
        let stages = RefCell::new(Vec::new());
        let result = confirmed_update(
            |stage| {
                stages.borrow_mut().push(stage);
                async { Ok(true) }
            },
            || async { Err::<Vec<u8>, _>("signature verification failed".into()) },
            |_| panic!("invalid bytes reached installation"),
        )
        .await;
        assert_eq!(result, Err("signature verification failed".into()));
        assert_eq!(*stages.borrow(), vec![UpdateStage::Download]);
    }

    #[tokio::test]
    async fn two_confirmations_install_the_verified_download_once() {
        let stages = RefCell::new(Vec::new());
        let installed = Cell::new(0);
        let result = confirmed_update(
            |stage| {
                stages.borrow_mut().push(stage);
                async { Ok(true) }
            },
            || async { Ok(vec![1, 2, 3]) },
            |bytes| {
                assert_eq!(bytes, vec![1, 2, 3]);
                installed.set(installed.get() + 1);
                Ok(())
            },
        )
        .await;
        assert_eq!(result, Ok(true));
        assert_eq!(
            *stages.borrow(),
            vec![UpdateStage::Download, UpdateStage::Install]
        );
        assert_eq!(installed.get(), 1);
    }

    #[tokio::test]
    async fn aborting_an_update_releases_the_single_operation_slot() {
        let flag = std::sync::Arc::new(AtomicBool::new(false));
        let owned = flag.clone();
        let (send, receive) = tokio::sync::oneshot::channel();
        let operation = tokio::spawn(async move {
            let _guard = OperationGuard::acquire(&owned).unwrap();
            send.send(()).unwrap();
            std::future::pending::<()>().await;
        });
        receive.await.unwrap();
        assert!(OperationGuard::acquire(&flag).is_none());
        operation.abort();
        assert!(operation.await.unwrap_err().is_cancelled());
        assert!(OperationGuard::acquire(&flag).is_some());
    }

    #[tokio::test]
    async fn shipped_stable_channel_has_the_committed_key_and_official_endpoint() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(
            config["plugins"]["updater"]["endpoints"],
            json!([
            "https://github.com/NSIETeam/ClawMaster-Desktop/releases/latest/download/latest.json"
        ])
        );
        assert_eq!(
            config["plugins"]["updater"]["pubkey"]
                .as_str()
                .unwrap()
                .trim(),
            include_str!("../../release-signing.pub").trim()
        );
        assert_eq!(
            with_update_channel(config["plugins"].get("updater"), || async { Ok("checked") }).await,
            Ok(Some("checked"))
        );
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
