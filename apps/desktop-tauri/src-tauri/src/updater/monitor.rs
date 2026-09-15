//! Serial, process-owned update checks; time is measured after each completed request.

use std::{future::Future, sync::Mutex, time::Duration};
use tauri::async_runtime::JoinHandle;

const CHECK_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);
const FIRST_RETRY: Duration = Duration::from_secs(15 * 60);
const BUSY_RETRY: Duration = Duration::from_secs(60);

pub(super) enum Check {
    Available(String),
    Current,
    Busy,
    Disabled,
}

pub(super) enum Notice {
    Available(String),
    Failed(String),
}

/// Polling never owns downloads or installation. Availability is announced once per version
/// per process; temporary network failures retain that record and use bounded backoff.
pub(super) async fn run<C, CF, W, WF, N>(mut check: C, mut wait: W, mut notify: N)
where
    C: FnMut() -> CF,
    CF: Future<Output = Result<Check, String>>,
    W: FnMut(Duration) -> WF,
    WF: Future<Output = ()>,
    N: FnMut(Notice),
{
    let mut announced = std::collections::HashSet::new();
    let mut retry = FIRST_RETRY;
    loop {
        let delay = match check().await {
            Ok(Check::Disabled) => return,
            Ok(Check::Busy) => BUSY_RETRY,
            Ok(Check::Available(version)) => {
                retry = FIRST_RETRY;
                if announced.insert(version.clone()) {
                    notify(Notice::Available(version));
                }
                CHECK_INTERVAL
            }
            Ok(Check::Current) => {
                retry = FIRST_RETRY;
                CHECK_INTERVAL
            }
            Err(error) => {
                notify(Notice::Failed(error));
                let delay = retry;
                retry = (retry * 2).min(CHECK_INTERVAL);
                delay
            }
        };
        wait(delay).await;
    }
}

#[derive(Default)]
enum Worker {
    #[default]
    Idle,
    Running(JoinHandle<()>),
    Stopped,
}

/// The application owns one monitor, including when shutdown precedes completion of boot.
#[derive(Default)]
pub(crate) struct BackgroundUpdates(Mutex<Worker>);

impl BackgroundUpdates {
    pub(super) fn start(&self, future: impl Future<Output = ()> + Send + 'static) {
        let mut worker = self.0.lock().unwrap();
        if matches!(*worker, Worker::Idle) {
            *worker = Worker::Running(tauri::async_runtime::spawn(future));
        }
    }

    /// Stops update checks before returning. Tauri exit hooks can call this
    /// from either the main thread or an async updater installation task.
    pub(super) fn stop(&self) {
        let mut worker = self.0.lock().unwrap();
        if let Worker::Running(task) = std::mem::replace(&mut *worker, Worker::Stopped) {
            task.abort();
            tokio::task::block_in_place(|| {
                // Cancellation is the expected join result; a completed monitor is also valid.
                let _ = tauri::async_runtime::block_on(task);
            });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        cell::RefCell,
        collections::VecDeque,
        sync::{
            atomic::{AtomicBool, Ordering},
            Arc,
        },
    };

    #[tokio::test]
    async fn checks_repeat_and_announce_each_version_once_even_after_channel_changes() {
        let mut checks = VecDeque::from([
            Ok(Check::Available("0.2.2".into())),
            Ok(Check::Available("0.2.2".into())),
            Ok(Check::Current),
            Ok(Check::Available("0.2.3".into())),
            Ok(Check::Available("0.2.2".into())),
            Ok(Check::Disabled),
        ]);
        let notices = RefCell::new(Vec::new());
        let delays = RefCell::new(Vec::new());
        run(
            || std::future::ready(checks.pop_front().expect("extra check")),
            |delay| {
                delays.borrow_mut().push(delay);
                std::future::ready(())
            },
            |notice| match notice {
                Notice::Available(version) => notices.borrow_mut().push(version),
                Notice::Failed(error) => panic!("{error}"),
            },
        )
        .await;
        assert_eq!(*notices.borrow(), ["0.2.2", "0.2.3"]);
        assert_eq!(*delays.borrow(), vec![Duration::from_secs(21_600); 5]);
    }

    #[tokio::test]
    async fn failures_back_off_to_six_hours_and_success_resets_the_retry() {
        let mut checks: VecDeque<_> = (0..7).map(|_| Err("offline".into())).collect();
        checks.extend([
            Ok(Check::Current),
            Err("offline again".into()),
            Ok(Check::Busy),
            Err("still offline".into()),
            Ok(Check::Disabled),
        ]);
        let delays = RefCell::new(Vec::new());
        let errors = RefCell::new(Vec::new());
        run(
            || std::future::ready(checks.pop_front().expect("extra check")),
            |delay| {
                delays.borrow_mut().push(delay.as_secs());
                std::future::ready(())
            },
            |notice| match notice {
                Notice::Failed(error) => errors.borrow_mut().push(error),
                Notice::Available(_) => panic!("no available release"),
            },
        )
        .await;
        assert_eq!(
            *delays.borrow(),
            [900, 1800, 3600, 7200, 14400, 21600, 21600, 21600, 900, 60, 1800]
        );
        assert_eq!(errors.borrow().len(), 9);
    }

    #[tokio::test]
    async fn disabled_channel_finishes_without_scheduling_a_retry() {
        run(
            || async { Ok(Check::Disabled) },
            |_| async { panic!("disabled channel scheduled a check") },
            |_| panic!("disabled channel announced an update"),
        )
        .await;
    }

    struct Dropped(Arc<AtomicBool>);
    impl Drop for Dropped {
        fn drop(&mut self) {
            self.0.store(true, Ordering::SeqCst);
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn shutdown_cancels_an_inflight_request_and_waits_for_its_cleanup() {
        let worker = BackgroundUpdates::default();
        let dropped = Arc::new(AtomicBool::new(false));
        let cleanup = Dropped(dropped.clone());
        let (started, ready) = tokio::sync::oneshot::channel();
        worker.start(async move {
            let mut started = Some(started);
            run(
                || {
                    started.take().unwrap().send(()).unwrap();
                    std::future::pending()
                },
                |_| async { panic!("pending request finished") },
                |_| panic!("cancelled request announced an update"),
            )
            .await;
            drop(cleanup);
        });
        ready.await.unwrap();
        worker.stop();
        assert!(dropped.load(Ordering::SeqCst));
        worker.stop();
        worker.start(async { panic!("stopped monitor restarted") });
    }

    #[test]
    fn main_thread_shutdown_cancels_the_timer_before_a_second_check() {
        let worker = BackgroundUpdates::default();
        let dropped = Arc::new(AtomicBool::new(false));
        let cleanup = Dropped(dropped.clone());
        let (waiting, ready) = std::sync::mpsc::channel();
        worker.start(async move {
            let mut first = true;
            run(
                || {
                    assert!(first, "second request escaped cancellation");
                    first = false;
                    async { Ok(Check::Current) }
                },
                move |delay| {
                    assert_eq!(delay, CHECK_INTERVAL);
                    waiting.send(()).unwrap();
                    std::future::pending()
                },
                |_| panic!("current release notified"),
            )
            .await;
            drop(cleanup);
        });
        ready.recv_timeout(Duration::from_secs(30)).unwrap();
        worker.start(async { panic!("duplicate monitor started") });
        worker.stop();
        assert!(dropped.load(Ordering::SeqCst));
    }

    #[test]
    fn shutdown_before_boot_finishes_prevents_monitor_start() {
        let worker = BackgroundUpdates::default();
        worker.stop();
        let dropped = Arc::new(AtomicBool::new(false));
        let cleanup = Dropped(dropped.clone());
        worker.start(async move {
            panic!("monitor started after shutdown: {:?}", cleanup.0);
        });
        assert!(dropped.load(Ordering::SeqCst));
    }
}
