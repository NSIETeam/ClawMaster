use crate::native_state_store::{NativeStateStore, TREE_INDEX};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::path::{Component, Path};
use std::sync::Mutex;
use tauri::State;

const REGISTRY_ID: &str = "self-modification-registry-v1";
const SOURCE_ID: &str = "native-self-modification";
const MAX_REQUESTS: usize = 200;
const MAX_CHANGED_PATHS: usize = 512;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SelfModificationState {
    Draft,
    Editing,
    Verifying,
    VerificationFailed,
    ReviewRequired,
    Approved,
    Building,
    BuildFailed,
    CandidateRunning,
    CandidateFailed,
    Draining,
    Activating,
    Observing,
    Active,
    ActivationFailed,
    RolledBack,
    Rejected,
    Cancelled,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum SelfModificationRisk {
    PolicyAuto,
    HumanConfirmation,
    SecurityReview,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ApprovalKind {
    Policy,
    Human,
    SecurityReviewer,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalRecord {
    actor_id: String,
    kind: ApprovalKind,
    at: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SelfModificationAuditEvent {
    request_id: String,
    state: SelfModificationState,
    at: String,
    actor_id: String,
    detail: Option<String>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SelfModificationUsage {
    #[serde(default)]
    token_count: u64,
    provider: Option<String>,
    #[serde(default)]
    retry_count: u64,
    #[serde(default)]
    estimated_cost_usd: f64,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SelfModificationRequest {
    id: String,
    goal: String,
    tenant_id: String,
    actor_id: String,
    origin: String,
    input_version: String,
    code_version: String,
    capability_version: String,
    changed_paths: Vec<String>,
    risk: SelfModificationRisk,
    state: SelfModificationState,
    created_at: String,
    updated_at: String,
    approval: Option<ApprovalRecord>,
    failure: Option<String>,
    usage: SelfModificationUsage,
    idempotency_key: Option<String>,
    audit: Vec<SelfModificationAuditEvent>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateSelfModificationRequest {
    goal: String,
    tenant_id: String,
    actor_id: String,
    origin: Option<String>,
    input_version: Option<String>,
    code_version: Option<String>,
    capability_version: Option<String>,
    changed_paths: Vec<String>,
    usage: Option<SelfModificationUsage>,
    idempotency_key: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
struct SelfModificationRegistry {
    requests: BTreeMap<String, SelfModificationRequest>,
}

pub struct NativeSelfModification {
    store: NativeStateStore,
    registry: Mutex<SelfModificationRegistry>,
}

impl NativeSelfModification {
    pub fn open(app_data_dir: &Path) -> Result<Self, String> {
        Self::from_store(NativeStateStore::open(app_data_dir).map_err(|error| error.to_string())?)
    }

    fn from_store(store: NativeStateStore) -> Result<Self, String> {
        let registry = store
            .get::<SelfModificationRegistry>(TREE_INDEX, REGISTRY_ID)
            .map_err(|error| error.to_string())?
            .map_or_else(SelfModificationRegistry::default, |record| record.payload);
        Ok(Self {
            store,
            registry: Mutex::new(registry),
        })
    }

    fn list(&self) -> Result<Vec<SelfModificationRequest>, String> {
        let registry = self
            .registry
            .lock()
            .map_err(|_| "原生自修改状态锁已损坏".to_string())?;
        let mut requests = registry.requests.values().cloned().collect::<Vec<_>>();
        requests.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
        Ok(requests)
    }

    fn create(
        &self,
        input: CreateSelfModificationRequest,
    ) -> Result<SelfModificationRequest, String> {
        validate_create_input(&input)?;
        let mut current = self
            .registry
            .lock()
            .map_err(|_| "原生自修改状态锁已损坏".to_string())?;
        if let Some(key) = input.idempotency_key.as_deref() {
            if let Some(existing) = current
                .requests
                .values()
                .find(|request| request.idempotency_key.as_deref() == Some(key))
            {
                if same_create_request(existing, &input) {
                    return Ok(existing.clone());
                }
                return Err("自修改幂等键对应不同请求".into());
            }
        }
        if current.requests.len() >= MAX_REQUESTS {
            return Err("自修改请求已达到本机安全上限，请先归档旧请求".into());
        }
        let at = now();
        let id = random_id()?;
        let event = SelfModificationAuditEvent {
            request_id: id.clone(),
            state: SelfModificationState::Draft,
            at: at.clone(),
            actor_id: input.actor_id.clone(),
            detail: Some("request_created".into()),
        };
        let request = SelfModificationRequest {
            id: id.clone(),
            goal: input.goal.trim().to_string(),
            tenant_id: input.tenant_id.trim().to_string(),
            actor_id: input.actor_id.trim().to_string(),
            origin: input.origin.unwrap_or_else(|| "desktop".into()),
            input_version: input
                .input_version
                .unwrap_or_else(|| format!("manual:{at}")),
            code_version: input.code_version.unwrap_or_else(|| "current".into()),
            capability_version: input
                .capability_version
                .unwrap_or_else(|| "self-modification-v2".into()),
            risk: classify_risk(&input.changed_paths),
            changed_paths: input.changed_paths,
            state: SelfModificationState::Draft,
            created_at: at.clone(),
            updated_at: at,
            approval: None,
            failure: None,
            usage: input.usage.unwrap_or(SelfModificationUsage {
                token_count: 0,
                provider: None,
                retry_count: 0,
                estimated_cost_usd: 0.0,
            }),
            idempotency_key: input.idempotency_key,
            audit: vec![event],
        };
        let mut next = current.clone();
        next.requests.insert(id, request.clone());
        self.persist(&next)?;
        *current = next;
        Ok(request)
    }

    fn approve(
        &self,
        id: &str,
        actor_id: &str,
        kind: ApprovalKind,
    ) -> Result<SelfModificationRequest, String> {
        self.mutate(id, |request, at| {
            if request.risk == SelfModificationRisk::SecurityReview
                && kind != ApprovalKind::SecurityReviewer
            {
                return Err("受保护代码必须由人工安全审核员批准".into());
            }
            if request.risk == SelfModificationRisk::HumanConfirmation
                && kind == ApprovalKind::Policy
            {
                return Err("源码修改不能由策略自动批准".into());
            }
            request.approval = Some(ApprovalRecord {
                actor_id: required_text(actor_id, "审批 actorId")?.to_string(),
                kind,
                at: at.to_string(),
            });
            transition(
                request,
                SelfModificationState::Approved,
                at,
                Some(actor_id),
                None,
            )
        })
    }

    fn reject(
        &self,
        id: &str,
        actor_id: &str,
        kind: ApprovalKind,
    ) -> Result<SelfModificationRequest, String> {
        self.mutate(id, |request, at| {
            request.approval = Some(ApprovalRecord {
                actor_id: required_text(actor_id, "审批 actorId")?.to_string(),
                kind,
                at: at.to_string(),
            });
            transition(
                request,
                SelfModificationState::Rejected,
                at,
                Some(actor_id),
                None,
            )
        })
    }

    fn cancel(&self, id: &str) -> Result<SelfModificationRequest, String> {
        self.mutate(id, |request, at| {
            transition(request, SelfModificationState::Cancelled, at, None, None)
        })
    }

    fn mutate(
        &self,
        id: &str,
        operation: impl FnOnce(&mut SelfModificationRequest, &str) -> Result<(), String>,
    ) -> Result<SelfModificationRequest, String> {
        let mut current = self
            .registry
            .lock()
            .map_err(|_| "原生自修改状态锁已损坏".to_string())?;
        let mut next = current.clone();
        let request = next
            .requests
            .get_mut(id)
            .ok_or_else(|| format!("未知自修改请求: {id}"))?;
        operation(request, &now())?;
        let result = request.clone();
        self.persist(&next)?;
        *current = next;
        Ok(result)
    }

    fn persist(&self, registry: &SelfModificationRegistry) -> Result<(), String> {
        self.store
            .put_latest(TREE_INDEX, REGISTRY_ID, SOURCE_ID, registry.clone())
            .and_then(|_| self.store.flush())
            .map_err(|error| error.to_string())
    }
}

fn required_text<'a>(value: &'a str, field: &str) -> Result<&'a str, String> {
    let value = value.trim();
    if value.is_empty() {
        Err(format!("{field} 不能为空"))
    } else if value.chars().count() > 512 {
        Err(format!("{field} 超过长度上限"))
    } else {
        Ok(value)
    }
}

fn validate_create_input(input: &CreateSelfModificationRequest) -> Result<(), String> {
    required_text(&input.goal, "改进目标")?;
    required_text(&input.tenant_id, "tenantId")?;
    required_text(&input.actor_id, "actorId")?;
    if input.changed_paths.is_empty() || input.changed_paths.len() > MAX_CHANGED_PATHS {
        return Err("changedPaths 必须包含 1 到 512 个路径".into());
    }
    for path in &input.changed_paths {
        let normalized = path.replace('\\', "/");
        if normalized.is_empty()
            || Path::new(&normalized).is_absolute()
            || Path::new(&normalized).components().any(|component| {
                matches!(
                    component,
                    Component::ParentDir | Component::RootDir | Component::Prefix(_)
                )
            })
        {
            return Err(format!("自修改路径必须是仓库内相对路径: {path}"));
        }
    }
    if input.usage.as_ref().is_some_and(|usage| {
        !usage.estimated_cost_usd.is_finite() || usage.estimated_cost_usd < 0.0
    }) {
        return Err("estimatedCostUsd 必须是非负有限数".into());
    }
    Ok(())
}

fn same_create_request(
    request: &SelfModificationRequest,
    input: &CreateSelfModificationRequest,
) -> bool {
    request.goal == input.goal.trim()
        && request.tenant_id == input.tenant_id.trim()
        && request.actor_id == input.actor_id.trim()
        && request.changed_paths == input.changed_paths
}

fn classify_risk(paths: &[String]) -> SelfModificationRisk {
    let normalized = paths
        .iter()
        .map(|path| path.replace('\\', "/").to_ascii_lowercase())
        .collect::<Vec<_>>();
    if normalized.iter().any(|path| {
        path.contains("self-modification-")
            || path.contains("self_modification")
            || path.contains("/src-tauri/")
            || path.starts_with("src-tauri/")
            || ["update", "credential", "audit", "policy", "migration"]
                .iter()
                .any(|segment| path.split('/').any(|part| part.starts_with(segment)))
    }) {
        return SelfModificationRisk::SecurityReview;
    }
    if normalized.iter().all(|path| {
        path.split('/')
            .any(|part| matches!(part, "skills" | "prompts" | "forms"))
    }) {
        SelfModificationRisk::PolicyAuto
    } else {
        SelfModificationRisk::HumanConfirmation
    }
}

fn allowed_transition(from: SelfModificationState, to: SelfModificationState) -> bool {
    use SelfModificationState::*;
    matches!(
        (from, to),
        (Draft, Editing | Cancelled)
            | (Editing, Verifying | Cancelled)
            | (Verifying, ReviewRequired | VerificationFailed | Cancelled)
            | (ReviewRequired, Approved | Rejected | Cancelled)
            | (Approved, Building | Cancelled)
            | (Building, CandidateRunning | BuildFailed | CandidateFailed)
            | (CandidateRunning, Draining | CandidateFailed)
            | (Draining, Activating | ActivationFailed)
            | (Activating, Observing | ActivationFailed)
            | (Observing, Active | RolledBack)
            | (ActivationFailed, RolledBack)
    )
}

fn transition(
    request: &mut SelfModificationRequest,
    next: SelfModificationState,
    at: &str,
    actor_id: Option<&str>,
    detail: Option<String>,
) -> Result<(), String> {
    if !allowed_transition(request.state, next) {
        return Err(format!(
            "无效自修改状态转换: {:?} -> {:?}",
            request.state, next
        ));
    }
    request.state = next;
    request.updated_at = at.to_string();
    request.audit.push(SelfModificationAuditEvent {
        request_id: request.id.clone(),
        state: next,
        at: at.to_string(),
        actor_id: actor_id.unwrap_or(&request.actor_id).to_string(),
        detail,
    });
    Ok(())
}

fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}

fn random_id() -> Result<String, String> {
    let mut bytes = [0_u8; 16];
    getrandom::getrandom(&mut bytes).map_err(|error| format!("无法生成自修改请求 ID: {error}"))?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

#[tauri::command]
pub fn self_modification_list(
    state: State<'_, NativeSelfModification>,
) -> Result<Vec<SelfModificationRequest>, String> {
    state.list()
}

#[tauri::command]
pub fn self_modification_create(
    input: CreateSelfModificationRequest,
    state: State<'_, NativeSelfModification>,
) -> Result<SelfModificationRequest, String> {
    state.create(input)
}

#[tauri::command]
pub fn self_modification_approve(
    id: String,
    actor_id: String,
    kind: ApprovalKind,
    state: State<'_, NativeSelfModification>,
) -> Result<SelfModificationRequest, String> {
    state.approve(&id, &actor_id, kind)
}

#[tauri::command]
pub fn self_modification_reject(
    id: String,
    actor_id: String,
    kind: ApprovalKind,
    state: State<'_, NativeSelfModification>,
) -> Result<SelfModificationRequest, String> {
    state.reject(&id, &actor_id, kind)
}

#[tauri::command]
pub fn self_modification_cancel(
    id: String,
    state: State<'_, NativeSelfModification>,
) -> Result<SelfModificationRequest, String> {
    state.cancel(&id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    fn input(paths: &[&str], key: Option<&str>) -> CreateSelfModificationRequest {
        CreateSelfModificationRequest {
            goal: "精简前端".into(),
            tenant_id: "tenant-1".into(),
            actor_id: "user-1".into(),
            origin: None,
            input_version: None,
            code_version: Some("abc123".into()),
            capability_version: None,
            changed_paths: paths.iter().map(|path| (*path).to_string()).collect(),
            usage: None,
            idempotency_key: key.map(str::to_string),
        }
    }

    fn runtime() -> (tempfile::TempDir, NativeSelfModification) {
        let root = tempdir().unwrap();
        let store = NativeStateStore::open_for_test(root.path(), [91; 32]).unwrap();
        let runtime = NativeSelfModification::from_store(store).unwrap();
        (root, runtime)
    }

    #[test]
    fn classifies_protected_paths_and_rejects_escape_paths() {
        assert_eq!(
            classify_risk(&["packages/desktop/src-tauri/src/lib.rs".into()]),
            SelfModificationRisk::SecurityReview
        );
        assert_eq!(
            classify_risk(&["skills/report/SKILL.md".into()]),
            SelfModificationRisk::PolicyAuto
        );
        assert!(validate_create_input(&input(&["../outside"], None)).is_err());
        assert!(validate_create_input(&input(&["..\\outside"], None)).is_err());
        assert!(validate_create_input(&input(&["/tmp/outside"], None)).is_err());
    }

    #[test]
    fn create_is_idempotent_and_persists_encrypted_state() {
        let (root, runtime) = runtime();
        let first = runtime
            .create(input(
                &["packages/desktop/src/renderer/App.tsx"],
                Some("request-1"),
            ))
            .unwrap();
        let repeated = runtime
            .create(input(
                &["packages/desktop/src/renderer/App.tsx"],
                Some("request-1"),
            ))
            .unwrap();
        assert_eq!(first.id, repeated.id);
        assert_eq!(runtime.list().unwrap().len(), 1);

        drop(runtime);
        let store = NativeStateStore::open_for_test(root.path(), [91; 32]).unwrap();
        let reopened = NativeSelfModification::from_store(store).unwrap();
        assert_eq!(reopened.list().unwrap()[0].id, first.id);
    }

    #[test]
    fn approval_requires_the_correct_state_and_security_role() {
        let (_root, runtime) = runtime();
        let request = runtime
            .create(input(&["packages/desktop/src-tauri/src/lib.rs"], None))
            .unwrap();
        assert!(runtime
            .approve(&request.id, "reviewer", ApprovalKind::SecurityReviewer)
            .is_err());

        runtime
            .mutate(&request.id, |request, at| {
                transition(request, SelfModificationState::Editing, at, None, None)?;
                transition(request, SelfModificationState::Verifying, at, None, None)?;
                transition(
                    request,
                    SelfModificationState::ReviewRequired,
                    at,
                    None,
                    None,
                )
            })
            .unwrap();
        assert!(runtime
            .approve(&request.id, "user", ApprovalKind::Human)
            .is_err());
        let approved = runtime
            .approve(&request.id, "security", ApprovalKind::SecurityReviewer)
            .unwrap();
        assert_eq!(approved.state, SelfModificationState::Approved);
        assert_eq!(approved.audit.len(), 5);
        assert_eq!(approved.audit.last().unwrap().actor_id, "security");
    }

    #[test]
    fn terminal_states_cannot_be_replayed() {
        let (_root, runtime) = runtime();
        let request = runtime
            .create(input(&["packages/desktop/src/renderer/App.tsx"], None))
            .unwrap();
        let cancelled = runtime.cancel(&request.id).unwrap();
        assert_eq!(cancelled.state, SelfModificationState::Cancelled);
        assert!(runtime.cancel(&request.id).is_err());
    }
}
