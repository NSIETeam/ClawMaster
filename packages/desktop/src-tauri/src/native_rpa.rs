use crate::native_models::{ModelToolCall, ModelToolDefinition};
use crate::native_state_store::{
    ArtifactMetadata, ArtifactRef, NativeStateStore, TREE_ARTIFACT_METADATA, TREE_EVENTS,
    TREE_INDEX,
};
use crate::native_tools;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::process::Child;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

mod browser;
mod semantic;

const RPA_INDEX_ID: &str = "native-rpa-index-v1";
const MAX_TARGET_SUMMARY_CHARS: usize = 500;

pub fn definitions() -> Vec<ModelToolDefinition> {
    vec![
        ModelToolDefinition {
            name: "rpa_browser_support".into(),
            description: "List installed system browsers supported by the Rust RPA driver. ClawMaster never downloads or bundles Chromium.".into(),
            parameters: json!({"type":"object","properties":{},"additionalProperties":false}),
        },
        ModelToolDefinition {
            name: "rpa_webdriver_probe".into(),
            description: "Run a bounded read-only version contract probe against an installed system WebDriver adapter such as Safari WebDriver.".into(),
            parameters: json!({"type":"object","properties":{
                "adapter":{"type":"string","enum":["safari-webdriver"]}
            },"required":["adapter"],"additionalProperties":false}),
        },
        ModelToolDefinition {
            name: "rpa_start".into(),
            description: "Start a visible system Chrome or Edge window with a ClawMaster-owned tenant/platform-isolated profile. Requires approval.".into(),
            parameters: json!({"type":"object","properties":{
                "runId":{"type":"string"},"tenantId":{"type":"string"},"platformId":{"type":"string"},
                "browser":{"type":"string","enum":["chrome","edge"]},"url":{"type":"string"}
            },"required":["runId","tenantId","platformId","url"],"additionalProperties":false}),
        },
        ModelToolDefinition {
            name: "rpa_windows".into(),
            description: "List system windows as bounded semantic references and bind the inventory to an encrypted artifact. The model selects a window reference, never a process ID or coordinate.".into(),
            parameters: json!({"type":"object","properties":{
                "runId":{"type":"string"},"stepId":{"type":"string"}
            },"required":["runId","stepId"],"additionalProperties":false}),
        },
        ModelToolDefinition {
            name: "rpa_snapshot".into(),
            description: "Capture one selected system window as a bounded semantic accessibility snapshot. The window reference must come from a bound encrypted rpa_windows artifact.".into(),
            parameters: json!({"type":"object","properties":{
                "runId":{"type":"string"},"stepId":{"type":"string"},
                "windowsArtifactId":{"type":"string"},"windowRef":{"type":"string","pattern":"^@w[1-9][0-9]*$"}
            },"required":["runId","stepId","windowsArtifactId","windowRef"],"additionalProperties":false}),
        },
        ModelToolDefinition {
            name: "rpa_screenshot".into(),
            description: "Capture one selected system window as PNG and store it only as an encrypted artifact. The model receives an artifact reference, not inline pixels.".into(),
            parameters: json!({"type":"object","properties":{
                "runId":{"type":"string"},"stepId":{"type":"string"},
                "windowsArtifactId":{"type":"string"},"windowRef":{"type":"string","pattern":"^@w[1-9][0-9]*$"}
            },"required":["runId","stepId","windowsArtifactId","windowRef"],"additionalProperties":false}),
        },
        ModelToolDefinition {
            name: "rpa_click".into(),
            description: "Perform a real OS mouse click bound to a prior semantic snapshot artifact. External submit/publish/delete actions require approval and are never blindly replayed.".into(),
            parameters: json!({"type":"object","properties":{
                "runId":{"type":"string"},"stepId":{"type":"string"},"snapshotArtifactId":{"type":"string"},
                "elementRef":{"type":"string","pattern":"^@e[1-9][0-9]*$"},"targetSummary":{"type":"string","maxLength":500},
                "externalSideEffect":{"type":"boolean"}
            },"required":["runId","stepId","snapshotArtifactId","elementRef","targetSummary","externalSideEffect"],"additionalProperties":false}),
        },
        ModelToolDefinition {
            name: "rpa_extract".into(),
            description: "Extract one bounded element record from a bound semantic snapshot. This is deterministic and never queries the live desktop by coordinates.".into(),
            parameters: json!({"type":"object","properties":{
                "runId":{"type":"string"},"stepId":{"type":"string"},"snapshotArtifactId":{"type":"string"},
                "elementRef":{"type":"string","pattern":"^@e[1-9][0-9]*$"}
            },"required":["runId","stepId","snapshotArtifactId","elementRef"],"additionalProperties":false}),
        },
        ModelToolDefinition {
            name: "rpa_fill".into(),
            description: "Focus a semantic text element with a real OS mouse click, select its current value, and type non-secret text through native keyboard input. Secrets must use a future keychain reference and are rejected here.".into(),
            parameters: json!({"type":"object","properties":{
                "runId":{"type":"string"},"stepId":{"type":"string"},"snapshotArtifactId":{"type":"string"},
                "elementRef":{"type":"string","pattern":"^@e[1-9][0-9]*$"},"text":{"type":"string","maxLength":2000},
                "targetSummary":{"type":"string","maxLength":500},"sensitive":{"type":"boolean","const":false}
            },"required":["runId","stepId","snapshotArtifactId","elementRef","text","targetSummary","sensitive"],"additionalProperties":false}),
        },
        ModelToolDefinition {
            name: "rpa_status".into(),
            description: "Read one durable RPA run and its receipts.".into(),
            parameters: json!({"type":"object","properties":{"runId":{"type":"string"}},"required":["runId"],"additionalProperties":false}),
        },
        ModelToolDefinition {
            name: "rpa_cancel".into(),
            description: "Cancel one ClawMaster-owned browser session without closing user-owned browsers. Requires approval.".into(),
            parameters: json!({"type":"object","properties":{"runId":{"type":"string"}},"required":["runId"],"additionalProperties":false}),
        },
    ]
}

pub fn contains(name: &str) -> bool {
    matches!(
        name,
        "rpa_browser_support"
            | "rpa_webdriver_probe"
            | "rpa_start"
            | "rpa_windows"
            | "rpa_snapshot"
            | "rpa_screenshot"
            | "rpa_click"
            | "rpa_extract"
            | "rpa_fill"
            | "rpa_status"
            | "rpa_cancel"
    )
}

pub fn is_write(name: &str) -> bool {
    !matches!(
        name,
        "rpa_browser_support" | "rpa_webdriver_probe" | "rpa_status"
    )
}

pub fn approval_summary(call: &ModelToolCall) -> String {
    let target = call
        .arguments
        .get("targetSummary")
        .and_then(Value::as_str)
        .or_else(|| call.arguments.get("url").and_then(Value::as_str))
        .or_else(|| call.arguments.get("runId").and_then(Value::as_str))
        .unwrap_or("未提供目标");
    format!(
        "允许 RPA 执行 {}？目标：{}",
        call.name,
        target
            .chars()
            .take(MAX_TARGET_SUMMARY_CHARS)
            .collect::<String>()
    )
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RpaRunState {
    Pending,
    Running,
    AwaitingApproval,
    Paused,
    Succeeded,
    Failed,
    Cancelled,
    UnknownOutcome,
}

#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RpaStepState {
    Pending,
    Started,
    Succeeded,
    Failed,
    Rejected,
    UnknownOutcome,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RpaReceipt {
    pub run_id: String,
    pub step_id: String,
    pub attempt: u32,
    pub state: RpaStepState,
    pub idempotency_key: String,
    pub action: String,
    pub target_summary: String,
    pub external_side_effect: bool,
    pub approval_id: Option<String>,
    pub artifact_ids: Vec<String>,
    pub error: Option<String>,
    pub started_at: u64,
    pub completed_at: Option<u64>,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RpaRun {
    pub id: String,
    pub tenant_id: String,
    pub platform_id: String,
    pub browser: String,
    pub profile_path: String,
    pub state: RpaRunState,
    pub current_step_id: Option<String>,
    pub receipts: Vec<RpaReceipt>,
    pub created_at: u64,
    pub updated_at: u64,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RpaSnapshotResult {
    pub run: RpaRun,
    pub artifact: ArtifactRef,
    pub snapshot: Value,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RpaWindowInventoryResult {
    pub run: RpaRun,
    pub artifact: ArtifactRef,
    pub inventory: semantic::WindowInventory,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RpaScreenshotResult {
    pub run: RpaRun,
    pub artifact: ArtifactRef,
    pub media_type: String,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
struct RpaIndex {
    run_ids: BTreeSet<String>,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BrowserSupport {
    pub id: String,
    pub label: String,
    pub executable: Option<String>,
    pub installed: bool,
    pub webdriver_contract: bool,
}

pub struct NativeRpa {
    root: PathBuf,
    store: NativeStateStore,
    owned_browsers: Mutex<BTreeMap<String, Child>>,
}

impl NativeRpa {
    pub fn open(root: &Path, store: NativeStateStore) -> Result<Self, String> {
        std::fs::create_dir_all(root)
            .map_err(|error| format!("无法创建 RPA profile 目录: {error}"))?;
        let controller = Self {
            root: root.to_path_buf(),
            store,
            owned_browsers: Mutex::new(BTreeMap::new()),
        };
        controller.recover_interrupted()?;
        Ok(controller)
    }

    pub fn browser_support(&self) -> Vec<BrowserSupport> {
        browser::candidates()
            .into_iter()
            .map(|candidate| BrowserSupport {
                id: candidate.id.into(),
                label: candidate.label.into(),
                installed: candidate.executable.is_file(),
                executable: candidate
                    .executable
                    .is_file()
                    .then(|| candidate.executable.to_string_lossy().into_owned()),
                webdriver_contract: candidate.webdriver_contract,
            })
            .collect()
    }

    pub fn launch(
        &self,
        run_id: &str,
        tenant_id: &str,
        platform_id: &str,
        browser: Option<&str>,
        url: &str,
    ) -> Result<RpaRun, String> {
        validate_id(run_id, "run")?;
        validate_id(tenant_id, "tenant")?;
        validate_id(platform_id, "platform")?;
        browser::validate_navigation_url(url)?;
        if self.load(run_id)?.is_some() {
            return Err("RPA run ID 已存在".into());
        }
        let candidate = browser::select(browser)?;
        if candidate.webdriver_contract {
            return Err(
                "Safari 只提供系统 WebDriver adapter，不能作为 xa11y owned Chrome 会话启动".into(),
            );
        }
        let profile = browser::profile_path(&self.root, tenant_id, platform_id, candidate.id);
        std::fs::create_dir_all(&profile)
            .map_err(|error| format!("无法创建隔离浏览器 profile: {error}"))?;
        let child = browser::spawn(&candidate, &profile, url)?;
        let timestamp = now_ms();
        let run = RpaRun {
            id: run_id.into(),
            tenant_id: tenant_id.into(),
            platform_id: platform_id.into(),
            browser: candidate.id.into(),
            profile_path: profile.to_string_lossy().into_owned(),
            state: RpaRunState::Running,
            current_step_id: None,
            receipts: Vec::new(),
            created_at: timestamp,
            updated_at: timestamp,
        };
        self.save(&run)?;
        self.owned_browsers
            .lock()
            .map_err(|_| "RPA owned browser 锁已损坏".to_string())?
            .insert(run.id.clone(), child);
        Ok(run)
    }

    pub fn windows(&self, run_id: &str, step_id: &str) -> Result<RpaWindowInventoryResult, String> {
        let mut run = self.required_run(run_id)?;
        let receipt_index = self.start_step(
            &mut run,
            step_id,
            "desktop.windows",
            "系统窗口清单",
            false,
            None,
        )?;
        let inventory = match semantic::inventory() {
            Ok(inventory) => inventory,
            Err(error) => {
                fail_receipt(&mut run, receipt_index, &error, false);
                self.save(&run)?;
                return Err(error);
            }
        };
        let bytes = serde_json::to_vec(&inventory).map_err(|error| error.to_string())?;
        let artifact = self
            .store
            .put_artifact(&format!("rpa-windows-{run_id}-{step_id}"), &bytes)
            .map_err(|error| error.to_string())?;
        complete_receipt(&mut run, receipt_index, Some(&artifact));
        self.save(&run)?;
        Ok(RpaWindowInventoryResult {
            run,
            artifact,
            inventory,
        })
    }

    pub fn snapshot(
        &self,
        run_id: &str,
        step_id: &str,
        windows_artifact_id: &str,
        window_ref: &str,
    ) -> Result<RpaSnapshotResult, String> {
        let mut run = self.required_run(run_id)?;
        self.require_bound_artifact(&run, windows_artifact_id, "窗口清单")?;
        let inventory: semantic::WindowInventory = self.read_artifact(windows_artifact_id)?;
        let receipt_index = self.start_step(
            &mut run,
            step_id,
            "desktop.snapshot",
            window_ref,
            false,
            None,
        )?;
        let snapshot = match semantic::snapshot(&inventory, window_ref) {
            Ok(snapshot) => snapshot,
            Err(error) => {
                fail_receipt(&mut run, receipt_index, &error, false);
                self.save(&run)?;
                return Err(error);
            }
        };
        let bytes = serde_json::to_vec(&snapshot).map_err(|error| error.to_string())?;
        let artifact = self
            .store
            .put_artifact(&format!("rpa-snapshot-{run_id}-{step_id}"), &bytes)
            .map_err(|error| error.to_string())?;
        complete_receipt(&mut run, receipt_index, Some(&artifact));
        self.save(&run)?;
        Ok(RpaSnapshotResult {
            run,
            artifact,
            snapshot,
        })
    }

    pub fn screenshot(
        &self,
        run_id: &str,
        step_id: &str,
        windows_artifact_id: &str,
        window_ref: &str,
    ) -> Result<RpaScreenshotResult, String> {
        let mut run = self.required_run(run_id)?;
        self.require_bound_artifact(&run, windows_artifact_id, "窗口清单")?;
        let inventory: semantic::WindowInventory = self.read_artifact(windows_artifact_id)?;
        let receipt_index = self.start_step(
            &mut run,
            step_id,
            "desktop.screenshot",
            window_ref,
            false,
            None,
        )?;
        let bytes = match semantic::screenshot_png(&inventory, window_ref) {
            Ok(bytes) => bytes,
            Err(error) => {
                fail_receipt(&mut run, receipt_index, &error, false);
                self.save(&run)?;
                return Err(error);
            }
        };
        let artifact = self
            .store
            .put_artifact(&format!("rpa-screenshot-{run_id}-{step_id}.png"), &bytes)
            .map_err(|error| error.to_string())?;
        complete_receipt(&mut run, receipt_index, Some(&artifact));
        self.save(&run)?;
        Ok(RpaScreenshotResult {
            run,
            artifact,
            media_type: "image/png".into(),
        })
    }

    #[allow(clippy::too_many_arguments)]
    pub fn click(
        &self,
        run_id: &str,
        step_id: &str,
        snapshot_artifact_id: &str,
        element_ref: &str,
        target_summary: &str,
        approval_id: Option<&str>,
        external_side_effect: bool,
    ) -> Result<RpaRun, String> {
        let mut run = self.required_run(run_id)?;
        if external_side_effect && approval_id.is_none() {
            return self.reject_step(
                run,
                step_id,
                "desktop.click",
                target_summary,
                "外部点击缺少 approval binding",
            );
        }
        self.require_bound_artifact(&run, snapshot_artifact_id, "语义快照")?;
        let (x, y) = self.resolve_element(snapshot_artifact_id, element_ref)?;
        let receipt_index = self.start_step(
            &mut run,
            step_id,
            "desktop.click",
            target_summary,
            external_side_effect,
            approval_id,
        )?;
        let result = native_tools::input_tool(&[
            "click".into(),
            x.to_string(),
            y.to_string(),
            "left".into(),
            "single".into(),
        ]);
        match result {
            Ok(()) => complete_receipt(&mut run, receipt_index, None),
            Err(error) => fail_receipt(&mut run, receipt_index, &error, false),
        }
        self.save(&run)?;
        Ok(run)
    }

    pub fn extract(
        &self,
        run_id: &str,
        step_id: &str,
        snapshot_artifact_id: &str,
        element_ref: &str,
    ) -> Result<Value, String> {
        let mut run = self.required_run(run_id)?;
        self.require_bound_artifact(&run, snapshot_artifact_id, "语义快照")?;
        let receipt_index = self.start_step(
            &mut run,
            step_id,
            "desktop.extract",
            element_ref,
            false,
            None,
        )?;
        let element = self.resolve_element_record(snapshot_artifact_id, element_ref)?;
        complete_receipt(&mut run, receipt_index, None);
        self.save(&run)?;
        Ok(json!({"run":run,"element":element}))
    }

    #[allow(clippy::too_many_arguments)]
    pub fn fill(
        &self,
        run_id: &str,
        step_id: &str,
        snapshot_artifact_id: &str,
        element_ref: &str,
        text: &str,
        target_summary: &str,
        sensitive: bool,
        approval_id: Option<&str>,
    ) -> Result<RpaRun, String> {
        if sensitive {
            return Err(
                "RPA 不允许把 secret 明文放入模型工具参数；请使用系统 Keychain 引用".into(),
            );
        }
        if text.chars().count() > 2_000 {
            return Err("RPA 输入文本超过 2000 字符上限".into());
        }
        let mut run = self.required_run(run_id)?;
        self.require_bound_artifact(&run, snapshot_artifact_id, "语义快照")?;
        let (x, y) = self.resolve_element(snapshot_artifact_id, element_ref)?;
        let receipt_index = self.start_step(
            &mut run,
            step_id,
            "desktop.fill",
            target_summary,
            false,
            approval_id,
        )?;
        let select_all = if cfg!(target_os = "macos") {
            "meta+a"
        } else {
            "ctrl+a"
        };
        let result = native_tools::input_tool(&[
            "click".into(),
            x.to_string(),
            y.to_string(),
            "left".into(),
            "single".into(),
        ])
        .and_then(|_| native_tools::input_tool(&["hotkey".into(), select_all.into()]))
        .and_then(|_| native_tools::input_tool(&["type".into(), text.into()]));
        match result {
            Ok(()) => complete_receipt(&mut run, receipt_index, None),
            Err(error) => fail_receipt(&mut run, receipt_index, &error, false),
        }
        self.save(&run)?;
        Ok(run)
    }

    pub fn cancel(&self, run_id: &str) -> Result<RpaRun, String> {
        let mut run = self.required_run(run_id)?;
        if let Some(mut child) = self
            .owned_browsers
            .lock()
            .map_err(|_| "RPA owned browser 锁已损坏".to_string())?
            .remove(run_id)
        {
            let _ = child.kill();
            let _ = child.wait();
        }
        if let Some(current) = run.current_step_id.as_deref() {
            if let Some(receipt) = run.receipts.iter_mut().find(|item| item.step_id == current) {
                receipt.state = if receipt.external_side_effect {
                    RpaStepState::UnknownOutcome
                } else {
                    RpaStepState::Failed
                };
                receipt.error = Some("用户取消了 owned browser session".into());
                receipt.completed_at = Some(now_ms());
            }
        }
        run.state = if run
            .receipts
            .last()
            .is_some_and(|receipt| receipt.state == RpaStepState::UnknownOutcome)
        {
            RpaRunState::UnknownOutcome
        } else {
            RpaRunState::Cancelled
        };
        run.current_step_id = None;
        self.save(&run)?;
        Ok(run)
    }

    pub fn get(&self, run_id: &str) -> Result<Option<RpaRun>, String> {
        self.load(run_id)
    }

    fn resolve_element(&self, artifact_id: &str, element_ref: &str) -> Result<(i32, i32), String> {
        let element = self.resolve_element_record(artifact_id, element_ref)?;
        let bounds = element
            .get("bounds")
            .ok_or_else(|| "RPA 元素没有可点击边界".to_string())?;
        Ok((
            bounded_coordinate(bounds, "centerX")?,
            bounded_coordinate(bounds, "centerY")?,
        ))
    }

    fn resolve_element_record(
        &self,
        artifact_id: &str,
        element_ref: &str,
    ) -> Result<Value, String> {
        let snapshot: Value = self.read_artifact(artifact_id)?;
        snapshot
            .get("elements")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .find(|element| element.get("ref").and_then(Value::as_str) == Some(element_ref))
            .cloned()
            .ok_or_else(|| "RPA 元素引用不属于绑定快照".to_string())
    }

    fn read_artifact<T: for<'de> Deserialize<'de>>(&self, artifact_id: &str) -> Result<T, String> {
        let metadata = self
            .store
            .get::<ArtifactMetadata>(TREE_ARTIFACT_METADATA, artifact_id)
            .map_err(|error| error.to_string())?
            .ok_or_else(|| "RPA 快照 artifact 不存在".to_string())?;
        let bytes = self
            .store
            .read_artifact(&ArtifactRef {
                sha256: metadata.payload.sha256,
                byte_length: metadata.payload.byte_length,
            })
            .map_err(|error| error.to_string())?;
        serde_json::from_slice(&bytes).map_err(|_| "RPA 加密 artifact 已损坏".to_string())
    }

    fn require_bound_artifact(
        &self,
        run: &RpaRun,
        artifact_id: &str,
        label: &str,
    ) -> Result<(), String> {
        if artifact_id.len() == 64
            && run
                .receipts
                .iter()
                .any(|receipt| receipt.artifact_ids.iter().any(|id| id == artifact_id))
        {
            Ok(())
        } else {
            Err(format!("RPA {label} artifact 未绑定当前 run"))
        }
    }

    pub fn execute(
        &self,
        call: &ModelToolCall,
        approval_id: Option<&str>,
    ) -> Result<Value, String> {
        let text = |name: &str| {
            call.arguments
                .get(name)
                .and_then(Value::as_str)
                .ok_or_else(|| format!("RPA 参数 {name} 缺失"))
        };
        match call.name.as_str() {
            "rpa_browser_support" => {
                serde_json::to_value(self.browser_support()).map_err(|error| error.to_string())
            }
            "rpa_webdriver_probe" => Ok(json!({
                "adapter":text("adapter")?,
                "version":browser::probe_webdriver(text("adapter")?)?
            })),
            "rpa_start" => serde_json::to_value(self.launch(
                text("runId")?,
                text("tenantId")?,
                text("platformId")?,
                call.arguments.get("browser").and_then(Value::as_str),
                text("url")?,
            )?)
            .map_err(|error| error.to_string()),
            "rpa_windows" => serde_json::to_value(self.windows(text("runId")?, text("stepId")?)?)
                .map_err(|error| error.to_string()),
            "rpa_snapshot" => serde_json::to_value(self.snapshot(
                text("runId")?,
                text("stepId")?,
                text("windowsArtifactId")?,
                text("windowRef")?,
            )?)
            .map_err(|error| error.to_string()),
            "rpa_screenshot" => serde_json::to_value(self.screenshot(
                text("runId")?,
                text("stepId")?,
                text("windowsArtifactId")?,
                text("windowRef")?,
            )?)
            .map_err(|error| error.to_string()),
            "rpa_click" => serde_json::to_value(
                self.click(
                    text("runId")?,
                    text("stepId")?,
                    text("snapshotArtifactId")?,
                    text("elementRef")?,
                    text("targetSummary")?,
                    approval_id,
                    call.arguments
                        .get("externalSideEffect")
                        .and_then(Value::as_bool)
                        .unwrap_or(false),
                )?,
            )
            .map_err(|error| error.to_string()),
            "rpa_extract" => self.extract(
                text("runId")?,
                text("stepId")?,
                text("snapshotArtifactId")?,
                text("elementRef")?,
            ),
            "rpa_fill" => serde_json::to_value(
                self.fill(
                    text("runId")?,
                    text("stepId")?,
                    text("snapshotArtifactId")?,
                    text("elementRef")?,
                    text("text")?,
                    text("targetSummary")?,
                    call.arguments
                        .get("sensitive")
                        .and_then(Value::as_bool)
                        .unwrap_or(true),
                    approval_id,
                )?,
            )
            .map_err(|error| error.to_string()),
            "rpa_status" => Ok(json!({"run":self.get(text("runId")?)?})),
            "rpa_cancel" => serde_json::to_value(self.cancel(text("runId")?)?)
                .map_err(|error| error.to_string()),
            _ => Err("未知 RPA 工具".into()),
        }
    }

    pub fn record_rejection(&self, call: &ModelToolCall, reason: &str) -> Result<Value, String> {
        let run_id = call
            .arguments
            .get("runId")
            .and_then(Value::as_str)
            .ok_or_else(|| "RPA 拒绝记录缺少 runId".to_string())?;
        if call.name == "rpa_start" && self.load(run_id)?.is_none() {
            let timestamp = now_ms();
            let run = RpaRun {
                id: run_id.into(),
                tenant_id: call
                    .arguments
                    .get("tenantId")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown")
                    .chars()
                    .take(120)
                    .collect(),
                platform_id: call
                    .arguments
                    .get("platformId")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown")
                    .chars()
                    .take(120)
                    .collect(),
                browser: call
                    .arguments
                    .get("browser")
                    .and_then(Value::as_str)
                    .unwrap_or("auto")
                    .into(),
                profile_path: String::new(),
                state: RpaRunState::Pending,
                current_step_id: None,
                receipts: Vec::new(),
                created_at: timestamp,
                updated_at: timestamp,
            };
            let rejected = self.reject_step(
                run,
                "launch",
                &call.name,
                call.arguments
                    .get("url")
                    .and_then(Value::as_str)
                    .unwrap_or("system browser"),
                reason,
            )?;
            return serde_json::to_value(rejected).map_err(|error| error.to_string());
        }
        let run = self.required_run(run_id)?;
        let step_id = call
            .arguments
            .get("stepId")
            .and_then(Value::as_str)
            .unwrap_or(&call.name);
        serde_json::to_value(
            self.reject_step(
                run,
                step_id,
                &call.name,
                call.arguments
                    .get("targetSummary")
                    .and_then(Value::as_str)
                    .unwrap_or(run_id),
                reason,
            )?,
        )
        .map_err(|error| error.to_string())
    }

    fn start_step(
        &self,
        run: &mut RpaRun,
        step_id: &str,
        action: &str,
        target_summary: &str,
        external_side_effect: bool,
        approval_id: Option<&str>,
    ) -> Result<usize, String> {
        validate_id(step_id, "step")?;
        if !matches!(run.state, RpaRunState::Running | RpaRunState::Pending) {
            return Err("RPA run 当前不可执行步骤".into());
        }
        if run.receipts.iter().any(|receipt| {
            receipt.step_id == step_id
                && matches!(
                    receipt.state,
                    RpaStepState::Succeeded | RpaStepState::Started
                )
        }) {
            return Err("RPA step 已执行或结果未确认，拒绝重复副作用".into());
        }
        let attempt = run
            .receipts
            .iter()
            .filter(|receipt| receipt.step_id == step_id)
            .count() as u32
            + 1;
        let idempotency_key = format!(
            "rpa:{:x}",
            Sha256::digest(format!("{}:{step_id}:{attempt}", run.id).as_bytes())
        );
        run.receipts.push(RpaReceipt {
            run_id: run.id.clone(),
            step_id: step_id.into(),
            attempt,
            state: RpaStepState::Started,
            idempotency_key,
            action: action.into(),
            target_summary: target_summary
                .chars()
                .take(MAX_TARGET_SUMMARY_CHARS)
                .collect(),
            external_side_effect,
            approval_id: approval_id.map(str::to_owned),
            artifact_ids: Vec::new(),
            error: None,
            started_at: now_ms(),
            completed_at: None,
        });
        run.current_step_id = Some(step_id.into());
        run.updated_at = now_ms();
        self.save(run)?;
        Ok(run.receipts.len() - 1)
    }

    fn reject_step(
        &self,
        mut run: RpaRun,
        step_id: &str,
        action: &str,
        target_summary: &str,
        reason: &str,
    ) -> Result<RpaRun, String> {
        validate_id(step_id, "step")?;
        run.receipts.push(RpaReceipt {
            run_id: run.id.clone(),
            step_id: step_id.into(),
            attempt: 0,
            state: RpaStepState::Rejected,
            idempotency_key: format!("rejected:{step_id}"),
            action: action.into(),
            target_summary: target_summary
                .chars()
                .take(MAX_TARGET_SUMMARY_CHARS)
                .collect(),
            external_side_effect: true,
            approval_id: None,
            artifact_ids: Vec::new(),
            error: Some(reason.into()),
            started_at: now_ms(),
            completed_at: Some(now_ms()),
        });
        run.state = RpaRunState::AwaitingApproval;
        run.current_step_id = Some(step_id.into());
        self.save(&run)?;
        Ok(run)
    }

    fn recover_interrupted(&self) -> Result<(), String> {
        let index = self.index()?;
        for run_id in index.run_ids {
            let Some(mut run) = self.load(&run_id)? else {
                continue;
            };
            let Some(step_id) = run.current_step_id.clone() else {
                continue;
            };
            let Some(receipt) = run.receipts.iter_mut().rev().find(|receipt| {
                receipt.step_id == step_id && receipt.state == RpaStepState::Started
            }) else {
                continue;
            };
            if receipt.external_side_effect {
                receipt.state = RpaStepState::UnknownOutcome;
                receipt.error = Some("应用中断后外部动作结果未知，禁止自动重试".into());
                run.state = RpaRunState::UnknownOutcome;
            } else {
                receipt.state = RpaStepState::Pending;
                receipt.error = Some("只读步骤在应用中断后可安全恢复".into());
                run.state = RpaRunState::Pending;
            }
            receipt.completed_at = Some(now_ms());
            run.current_step_id = None;
            self.save(&run)?;
        }
        Ok(())
    }

    fn required_run(&self, run_id: &str) -> Result<RpaRun, String> {
        self.load(run_id)?
            .ok_or_else(|| "RPA run 不存在".to_string())
    }

    fn load(&self, run_id: &str) -> Result<Option<RpaRun>, String> {
        validate_id(run_id, "run")?;
        self.store
            .get::<RpaRun>(TREE_EVENTS, &format!("rpa-run-{run_id}"))
            .map(|record| record.map(|record| record.payload))
            .map_err(|error| error.to_string())
    }

    fn save(&self, run: &RpaRun) -> Result<(), String> {
        self.store
            .put_latest(
                TREE_EVENTS,
                &format!("rpa-run-{}", run.id),
                "native-rpa",
                run.clone(),
            )
            .map_err(|error| error.to_string())?;
        let mut index = self.index()?;
        index.run_ids.insert(run.id.clone());
        self.store
            .put_latest(TREE_INDEX, RPA_INDEX_ID, "native-rpa", index)
            .map_err(|error| error.to_string())?;
        self.store.flush().map_err(|error| error.to_string())
    }

    fn index(&self) -> Result<RpaIndex, String> {
        self.store
            .get::<RpaIndex>(TREE_INDEX, RPA_INDEX_ID)
            .map(|record| record.map_or_else(RpaIndex::default, |record| record.payload))
            .map_err(|error| error.to_string())
    }
}

impl Drop for NativeRpa {
    fn drop(&mut self) {
        if let Ok(children) = self.owned_browsers.get_mut() {
            for child in children.values_mut() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }
}

fn validate_id(value: &str, label: &str) -> Result<(), String> {
    if value.is_empty()
        || value.len() > 120
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
    {
        return Err(format!("RPA {label} ID 无效"));
    }
    Ok(())
}

fn bounded_coordinate(arguments: &Value, name: &str) -> Result<i32, String> {
    let value = arguments
        .get(name)
        .and_then(Value::as_i64)
        .ok_or_else(|| format!("RPA 参数 {name} 缺失"))?;
    i32::try_from(value).map_err(|_| format!("RPA 参数 {name} 超出桌面坐标范围"))
}

fn complete_receipt(run: &mut RpaRun, index: usize, artifact: Option<&ArtifactRef>) {
    let receipt = &mut run.receipts[index];
    receipt.state = RpaStepState::Succeeded;
    receipt.completed_at = Some(now_ms());
    if let Some(artifact) = artifact {
        receipt.artifact_ids.push(artifact.sha256.clone());
    }
    run.current_step_id = None;
    run.state = RpaRunState::Running;
    run.updated_at = now_ms();
}

fn fail_receipt(run: &mut RpaRun, index: usize, error: &str, interrupted: bool) {
    let receipt = &mut run.receipts[index];
    receipt.state = if interrupted && receipt.external_side_effect {
        RpaStepState::UnknownOutcome
    } else {
        RpaStepState::Failed
    };
    receipt.error = Some(error.chars().take(1_000).collect());
    receipt.completed_at = Some(now_ms());
    run.current_step_id = Some(receipt.step_id.clone());
    run.state = if receipt.state == RpaStepState::UnknownOutcome {
        RpaRunState::UnknownOutcome
    } else {
        RpaRunState::Failed
    };
    run.updated_at = now_ms();
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[cfg(test)]
mod tests {
    use super::*;

    fn controller() -> (tempfile::TempDir, NativeRpa) {
        let root = tempfile::tempdir().unwrap();
        let store = NativeStateStore::open_for_test(&root.path().join("state"), [77; 32]).unwrap();
        let controller = NativeRpa::open(&root.path().join("profiles"), store).unwrap();
        (root, controller)
    }

    fn run(id: &str, external: bool) -> RpaRun {
        let now = now_ms();
        RpaRun {
            id: id.into(),
            tenant_id: "tenant-a".into(),
            platform_id: "platform-a".into(),
            browser: "chrome".into(),
            profile_path: "/isolated".into(),
            state: RpaRunState::Running,
            current_step_id: Some("submit".into()),
            receipts: vec![RpaReceipt {
                run_id: id.into(),
                step_id: "submit".into(),
                attempt: 1,
                state: RpaStepState::Started,
                idempotency_key: "idempotency".into(),
                action: "desktop.click".into(),
                target_summary: "submit order".into(),
                external_side_effect: external,
                approval_id: external.then(|| "approval-1".into()),
                artifact_ids: Vec::new(),
                error: None,
                started_at: now,
                completed_at: None,
            }],
            created_at: now,
            updated_at: now,
        }
    }

    #[test]
    fn recovery_retries_readonly_but_never_replays_external_steps() {
        let (root, controller) = controller();
        controller.save(&run("readonly", false)).unwrap();
        controller.save(&run("external", true)).unwrap();
        drop(controller);
        let store = NativeStateStore::open_for_test(&root.path().join("state"), [77; 32]).unwrap();
        let recovered = NativeRpa::open(&root.path().join("profiles"), store).unwrap();
        assert_eq!(
            recovered.get("readonly").unwrap().unwrap().state,
            RpaRunState::Pending
        );
        assert_eq!(
            recovered.get("external").unwrap().unwrap().state,
            RpaRunState::UnknownOutcome
        );
    }

    #[test]
    fn rejected_external_click_is_receipted_without_mouse_action() {
        let (_root, controller) = controller();
        let mut current = run("rejected", false);
        current.current_step_id = None;
        current.receipts.clear();
        controller.save(&current).unwrap();
        let rejected = controller
            .click(
                "rejected",
                "submit",
                &"0".repeat(64),
                "@e1",
                "submit order",
                None,
                true,
            )
            .unwrap();
        assert_eq!(rejected.state, RpaRunState::AwaitingApproval);
        assert_eq!(rejected.receipts[0].state, RpaStepState::Rejected);
        assert!(rejected.receipts[0]
            .idempotency_key
            .starts_with("rejected:"));
    }

    #[test]
    fn resolves_coordinates_only_from_the_bound_semantic_snapshot() {
        let (_root, controller) = controller();
        let snapshot = json!({"elements":[
            {"ref":"@e1","name":"提交","bounds":{"centerX":120,"centerY":240}},
            {"ref":"@e2","name":"纯文本","bounds":null}
        ]});
        let bytes = serde_json::to_vec(&snapshot).unwrap();
        let artifact = controller
            .store
            .put_artifact("rpa-semantic-snapshot", &bytes)
            .unwrap();
        assert_eq!(
            controller.resolve_element(&artifact.sha256, "@e1").unwrap(),
            (120, 240)
        );
        assert!(controller
            .resolve_element(&artifact.sha256, "@e999")
            .is_err());
        assert!(controller.resolve_element(&artifact.sha256, "@e2").is_err());
        assert!(controller.resolve_element(&"0".repeat(64), "@e1").is_err());
    }

    #[test]
    fn sensitive_fill_is_rejected_before_any_native_input() {
        let (_root, controller) = controller();
        let error = controller
            .fill(
                "missing-run",
                "fill-secret",
                &"0".repeat(64),
                "@e1",
                "secret-value",
                "password field",
                true,
                Some("approval-1"),
            )
            .unwrap_err();
        assert!(error.contains("secret"));
        assert!(controller.get("missing-run").unwrap().is_none());
    }
}
