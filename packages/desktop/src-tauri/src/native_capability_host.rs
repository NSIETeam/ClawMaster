use crate::native_state_store::{NativeStateStore, TREE_INDEX};
use base64::{engine::general_purpose::STANDARD, Engine};
use ring::signature::{UnparsedPublicKey, ED25519};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet, VecDeque};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tokio::sync::Notify;
use wasmi::{
    Caller, Config, Engine as WasmEngine, Linker, Module, Store, StoreLimits, StoreLimitsBuilder,
};

pub const CAPABILITY_HOST_API_V1: &str = "clawmaster.capability.v1";
const REGISTRY_ID: &str = "native-capability-registry-v1";
const MAX_PACKAGE_BYTES: u64 = 12 * 1024 * 1024;
const MAX_TOTAL_PACKAGE_BYTES: u64 = 35 * 1024 * 1024;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CapabilitySignature {
    pub key_id: String,
    pub value: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityDependency {
    pub id: String,
    pub minimum_version: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityManifest {
    pub schema_version: u32,
    pub id: String,
    pub version: String,
    pub api_version: String,
    pub platforms: Vec<String>,
    pub architectures: Vec<String>,
    pub entrypoint: String,
    pub permissions: Vec<String>,
    pub dependencies: Vec<CapabilityDependency>,
    pub compressed_size: u64,
    pub installed_size: u64,
    pub sha256: String,
    pub minimum_runtime_version: String,
    pub signature: CapabilitySignature,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SignedManifest<'a> {
    schema_version: u32,
    id: &'a str,
    version: &'a str,
    api_version: &'a str,
    platforms: &'a [String],
    architectures: &'a [String],
    entrypoint: &'a str,
    permissions: &'a [String],
    dependencies: &'a [CapabilityDependency],
    compressed_size: u64,
    installed_size: u64,
    sha256: &'a str,
    minimum_runtime_version: &'a str,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct InstalledCapability {
    pub manifest: CapabilityManifest,
    pub enabled: bool,
    pub installed_at: u64,
    pub previous_version: Option<String>,
}

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
struct CapabilityRegistry {
    installed: BTreeMap<String, InstalledCapability>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AgentAdmission {
    Active,
    Queued,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceSnapshot {
    pub active_agents: usize,
    pub queued_agents: usize,
    pub active_workers: usize,
    pub loaded_implementations: usize,
    pub trusted_key_count: usize,
    pub max_output_bytes: usize,
    pub max_event_queue: usize,
    pub max_timeout_seconds: u64,
}

#[derive(Default)]
struct ResourceState {
    active_agent: Option<String>,
    queued_agents: VecDeque<String>,
    active_workers: usize,
}

struct CapabilityStore {
    limits: StoreLimits,
    permissions: BTreeSet<String>,
    events: Vec<Vec<u8>>,
    artifacts: Vec<Vec<u8>>,
}

#[derive(Clone)]
pub struct ResourceGovernor {
    state: Arc<Mutex<ResourceState>>,
    agent_notify: Arc<Notify>,
    max_output_bytes: usize,
    max_event_queue: usize,
    max_timeout_seconds: u64,
}

impl Default for ResourceGovernor {
    fn default() -> Self {
        Self {
            state: Arc::new(Mutex::new(ResourceState::default())),
            agent_notify: Arc::new(Notify::new()),
            max_output_bytes: 1024 * 1024,
            max_event_queue: 1_000,
            max_timeout_seconds: 300,
        }
    }
}

impl ResourceGovernor {
    fn admit_agent(&self, agent_id: &str) -> Result<AgentAdmission, String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "资源治理锁已损坏".to_string())?;
        if state.active_agent.as_deref() == Some(agent_id)
            || state.queued_agents.iter().any(|id| id == agent_id)
        {
            return Err("Agent 已占用或已在等待队列中".into());
        }
        if state.active_agent.is_none() {
            state.active_agent = Some(agent_id.into());
            return Ok(AgentAdmission::Active);
        }
        if state.queued_agents.len() >= 32 {
            return Err("Agent 等待队列已满".into());
        }
        state.queued_agents.push_back(agent_id.into());
        Ok(AgentAdmission::Queued)
    }

    pub fn reserve_agent(&self, agent_id: &str) -> Result<(AgentAdmission, AgentLease), String> {
        let admission = self.admit_agent(agent_id)?;
        Ok((
            admission,
            AgentLease {
                governor: self.clone(),
                agent_id: agent_id.into(),
            },
        ))
    }

    fn release_agent(&self, agent_id: &str) -> Result<Option<String>, String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "资源治理锁已损坏".to_string())?;
        if state.active_agent.as_deref() != Some(agent_id) {
            state.queued_agents.retain(|queued| queued != agent_id);
            return Ok(state.active_agent.clone());
        }
        state.active_agent = state.queued_agents.pop_front();
        let next = state.active_agent.clone();
        drop(state);
        self.agent_notify.notify_waiters();
        Ok(next)
    }

    pub fn acquire_worker(&self) -> Result<WorkerLease, String> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| "资源治理锁已损坏".to_string())?;
        if state.active_workers >= 1 {
            return Err("8GB 配置只允许一个重型 worker".into());
        }
        state.active_workers += 1;
        Ok(WorkerLease {
            state: self.state.clone(),
        })
    }

    pub fn validate_output(&self, bytes: usize) -> Result<(), String> {
        if bytes > self.max_output_bytes {
            Err("能力输出超过 1 MiB 硬上限，请改用 artifact".into())
        } else {
            Ok(())
        }
    }

    pub fn validate_timeout(&self, seconds: u64) -> Result<(), String> {
        if seconds == 0 || seconds > self.max_timeout_seconds {
            Err("能力 timeout 超出资源预算".into())
        } else {
            Ok(())
        }
    }

    pub fn snapshot(&self) -> Result<ResourceSnapshot, String> {
        let state = self
            .state
            .lock()
            .map_err(|_| "资源治理锁已损坏".to_string())?;
        Ok(ResourceSnapshot {
            active_agents: usize::from(state.active_agent.is_some()),
            queued_agents: state.queued_agents.len(),
            active_workers: state.active_workers,
            loaded_implementations: state.active_workers,
            trusted_key_count: 0,
            max_output_bytes: self.max_output_bytes,
            max_event_queue: self.max_event_queue,
            max_timeout_seconds: self.max_timeout_seconds,
        })
    }
}

pub struct AgentLease {
    governor: ResourceGovernor,
    agent_id: String,
}

impl AgentLease {
    pub async fn wait_until_active(self) -> Result<Self, String> {
        loop {
            let notified = self.governor.agent_notify.notified();
            let active = self
                .governor
                .state
                .lock()
                .map_err(|_| "资源治理锁已损坏".to_string())?
                .active_agent
                .as_deref()
                == Some(self.agent_id.as_str());
            if active {
                drop(notified);
                return Ok(self);
            }
            notified.await;
        }
    }
}

impl Drop for AgentLease {
    fn drop(&mut self) {
        let _ = self.governor.release_agent(&self.agent_id);
    }
}

pub struct WorkerLease {
    state: Arc<Mutex<ResourceState>>,
}

impl Drop for WorkerLease {
    fn drop(&mut self) {
        if let Ok(mut state) = self.state.lock() {
            state.active_workers = state.active_workers.saturating_sub(1);
        }
    }
}

pub struct PreparedCapability {
    pub executable: PathBuf,
    pub manifest: CapabilityManifest,
    _lease: WorkerLease,
}

pub struct CapabilityHost {
    root: PathBuf,
    store: NativeStateStore,
    trusted_keys: BTreeMap<String, Vec<u8>>,
    governor: ResourceGovernor,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CapabilityInstallPlan {
    pub id: String,
    pub version: String,
    pub source: String,
    pub compressed_size: u64,
    pub installed_size: u64,
    pub permissions: Vec<String>,
    pub dependencies: Vec<CapabilityDependency>,
    pub replaces_version: Option<String>,
}

impl CapabilityHost {
    pub fn open(
        root: &Path,
        store: NativeStateStore,
        trusted_keys: BTreeMap<String, Vec<u8>>,
    ) -> Result<Self, String> {
        fs::create_dir_all(root).map_err(|error| format!("无法创建能力目录: {error}"))?;
        let host = Self {
            root: root.to_path_buf(),
            store,
            trusted_keys,
            governor: ResourceGovernor::default(),
        };
        host.reconcile_installations()?;
        Ok(host)
    }

    fn reconcile_installations(&self) -> Result<(), String> {
        let registry = self.registry()?;
        for entry in
            fs::read_dir(&self.root).map_err(|error| format!("无法读取能力目录: {error}"))?
        {
            let entry = entry.map_err(|error| error.to_string())?;
            let path = entry.path();
            let file_type = entry.file_type().map_err(|error| error.to_string())?;
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with(".staging-") {
                remove_capability_entry(&path, file_type)
                    .map_err(|error| format!("无法清理中断安装: {error}"))?;
                continue;
            }
            if !file_type.is_dir() || file_type.is_symlink() {
                continue;
            }
            let Some(installed) = registry.installed.get(&name) else {
                fs::remove_dir_all(&path)
                    .map_err(|error| format!("无法清理孤儿能力目录: {error}"))?;
                continue;
            };
            let retained = [
                Some(installed.manifest.version.as_str()),
                installed.previous_version.as_deref(),
            ]
            .into_iter()
            .flatten()
            .collect::<BTreeSet<_>>();
            for version_entry in
                fs::read_dir(&path).map_err(|error| format!("无法读取能力版本目录: {error}"))?
            {
                let version_entry = version_entry.map_err(|error| error.to_string())?;
                let version = version_entry.file_name().to_string_lossy().into_owned();
                if !retained.contains(version.as_str()) {
                    remove_capability_entry(
                        &version_entry.path(),
                        version_entry
                            .file_type()
                            .map_err(|error| error.to_string())?,
                    )
                    .map_err(|error| format!("无法清理孤儿能力版本: {error}"))?;
                }
            }
        }
        Ok(())
    }

    pub fn list(&self) -> Result<Vec<InstalledCapability>, String> {
        Ok(self.registry()?.installed.into_values().collect())
    }

    pub fn resource_snapshot(&self) -> Result<ResourceSnapshot, String> {
        let mut snapshot = self.governor.snapshot()?;
        snapshot.trusted_key_count = self.trusted_keys.len();
        Ok(snapshot)
    }

    pub fn reserve_agent(&self, agent_id: &str) -> Result<(AgentAdmission, AgentLease), String> {
        self.governor.reserve_agent(agent_id)
    }

    pub fn plan_install(
        &self,
        manifest: &CapabilityManifest,
        source: &str,
    ) -> Result<CapabilityInstallPlan, String> {
        self.verify_manifest(manifest)?;
        if (source != "user-selected-file" && !source.starts_with("https://"))
            || source.len() > 2_048
        {
            return Err("能力包来源必须是本机用户选择或有界 HTTPS 地址".into());
        }
        let registry = self.registry()?;
        self.verify_dependencies(manifest, &registry)?;
        Ok(CapabilityInstallPlan {
            id: manifest.id.clone(),
            version: manifest.version.clone(),
            source: source.into(),
            compressed_size: manifest.compressed_size,
            installed_size: manifest.installed_size,
            permissions: manifest.permissions.clone(),
            dependencies: manifest.dependencies.clone(),
            replaces_version: registry
                .installed
                .get(&manifest.id)
                .map(|item| item.manifest.version.clone()),
        })
    }

    pub fn install<F>(
        &self,
        manifest: CapabilityManifest,
        payload: &[u8],
        approved: bool,
        now_ms: u64,
        health_check: F,
    ) -> Result<InstalledCapability, String>
    where
        F: FnOnce(&Path) -> Result<(), String>,
    {
        if !approved {
            return Err("安装能力包需要用户明确确认".into());
        }
        self.verify(&manifest, payload)?;
        let mut registry = self.registry()?;
        self.verify_dependencies(&manifest, &registry)?;
        let replacing = registry.installed.get(&manifest.id).cloned();
        let total = registry
            .installed
            .values()
            .filter(|item| item.manifest.id != manifest.id)
            .map(|item| item.manifest.installed_size)
            .sum::<u64>()
            .saturating_add(manifest.installed_size);
        if total > MAX_TOTAL_PACKAGE_BYTES {
            return Err("第一方能力包安装总量超过 35 MiB".into());
        }
        let package_root = self.root.join(&manifest.id);
        ensure_direct_child_directory(&self.root, &package_root, "能力包")?;
        let staging = self
            .root
            .join(format!(".staging-{}-{}", manifest.id, manifest.version));
        match fs::symlink_metadata(&staging) {
            Ok(metadata) => remove_capability_entry(&staging, metadata.file_type())
                .map_err(|error| error.to_string())?,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.to_string()),
        }
        ensure_direct_child_directory(&self.root, &staging, "能力暂存")?;
        let staged_entry = staging.join(&manifest.entrypoint);
        let mut output = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&staged_entry)
            .map_err(|error| format!("无法暂存能力入口: {error}"))?;
        output
            .write_all(payload)
            .map_err(|error| error.to_string())?;
        output.sync_all().map_err(|error| error.to_string())?;
        let staged_manifest = staging.join("manifest.json");
        let manifest_bytes =
            serde_json::to_vec_pretty(&manifest).map_err(|error| error.to_string())?;
        let mut manifest_output = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&staged_manifest)
            .map_err(|error| format!("无法暂存能力 manifest: {error}"))?;
        manifest_output
            .write_all(&manifest_bytes)
            .map_err(|error| error.to_string())?;
        manifest_output
            .sync_all()
            .map_err(|error| error.to_string())?;
        health_check(&staged_entry).map_err(|error| {
            let _ = fs::remove_dir_all(&staging);
            format!("能力健康检查失败: {error}")
        })?;
        validate_wasm_permissions(&staged_entry, &manifest.permissions).map_err(|error| {
            let _ = fs::remove_dir_all(&staging);
            format!("能力 Host ABI 校验失败: {error}")
        })?;
        let destination = package_root.join(&manifest.version);
        if fs::symlink_metadata(&destination).is_ok() {
            fs::remove_dir_all(&staging).map_err(|error| error.to_string())?;
            return Err("能力版本目录已存在，拒绝覆盖完整版本".into());
        }
        fs::rename(&staging, &destination)
            .map_err(|error| format!("无法原子提交能力版本: {error}"))?;
        let installed = InstalledCapability {
            previous_version: replacing.as_ref().map(|item| item.manifest.version.clone()),
            manifest,
            enabled: true,
            installed_at: now_ms,
        };
        registry
            .installed
            .insert(installed.manifest.id.clone(), installed.clone());
        self.save_registry(&registry)?;
        Ok(installed)
    }

    pub fn rollback(&self, id: &str) -> Result<InstalledCapability, String> {
        let mut registry = self.registry()?;
        let current = registry
            .installed
            .get(id)
            .cloned()
            .ok_or_else(|| "能力尚未安装".to_string())?;
        let previous = current
            .previous_version
            .as_deref()
            .ok_or_else(|| "能力没有可回滚版本".to_string())?;
        let package_root = self.root.join(id);
        validate_direct_child_directory(&self.root, &package_root, "能力包")?;
        let version_root = package_root.join(previous);
        validate_direct_child_directory(&package_root, &version_root, "能力版本")?;
        let manifest_path = version_root.join("manifest.json");
        validate_direct_child_file(&version_root, &manifest_path, "能力 manifest")?;
        let manifest: CapabilityManifest = serde_json::from_slice(
            &fs::read(&manifest_path).map_err(|error| format!("无法读取上一版本: {error}"))?,
        )
        .map_err(|error| format!("上一版本 manifest 损坏: {error}"))?;
        if manifest.id != id || manifest.version != previous {
            return Err("上一版本 manifest 身份不匹配".into());
        }
        let entrypoint = version_root.join(&manifest.entrypoint);
        validate_direct_child_file(&version_root, &entrypoint, "能力入口")?;
        let payload =
            fs::read(&entrypoint).map_err(|error| format!("无法读取上一版本: {error}"))?;
        self.verify(&manifest, &payload)?;
        wasm_health_check(&entrypoint).map_err(|error| format!("上一版本健康检查失败: {error}"))?;
        validate_wasm_permissions(&entrypoint, &manifest.permissions)
            .map_err(|error| format!("上一版本 Host ABI 校验失败: {error}"))?;
        let restored = InstalledCapability {
            manifest,
            previous_version: Some(current.manifest.version),
            enabled: true,
            installed_at: current.installed_at,
        };
        registry.installed.insert(id.into(), restored.clone());
        self.save_registry(&registry)?;
        Ok(restored)
    }

    pub fn uninstall(&self, id: &str, approved: bool) -> Result<(), String> {
        if !approved {
            return Err("卸载能力包需要用户明确确认".into());
        }
        let mut registry = self.registry()?;
        if registry.installed.remove(id).is_none() {
            return Err("能力尚未安装".into());
        }
        self.save_registry(&registry)?;
        let package_root = self.root.join(id);
        if package_root.exists() {
            fs::remove_dir_all(package_root).map_err(|error| format!("无法卸载能力包: {error}"))?;
        }
        Ok(())
    }

    pub fn prepare(&self, id: &str) -> Result<PreparedCapability, String> {
        let mut registry = self.registry()?;
        let installed = registry
            .installed
            .remove(id)
            .ok_or_else(|| "能力未安装".to_string())?;
        if !installed.enabled {
            return Err("能力未启用".into());
        }
        let package_root = self.root.join(id);
        validate_direct_child_directory(&self.root, &package_root, "能力包")?;
        let version_root = package_root.join(&installed.manifest.version);
        validate_direct_child_directory(&package_root, &version_root, "能力版本")?;
        let executable = version_root.join(&installed.manifest.entrypoint);
        validate_direct_child_file(&version_root, &executable, "能力入口")?;
        Ok(PreparedCapability {
            executable,
            manifest: installed.manifest,
            _lease: self.governor.acquire_worker()?,
        })
    }

    pub fn invoke(&self, id: &str, input: &[u8]) -> Result<Vec<u8>, String> {
        self.governor.validate_output(input.len())?;
        let prepared = self.prepare(id)?;
        let wasm =
            fs::read(&prepared.executable).map_err(|error| format!("无法读取能力入口: {error}"))?;
        if format!("{:x}", Sha256::digest(&wasm)) != prepared.manifest.sha256 {
            return Err("能力入口已被篡改，拒绝执行".into());
        }
        let mut config = Config::default();
        config.consume_fuel(true).floats(false);
        let engine = WasmEngine::new(&config);
        let module =
            Module::new(&engine, &wasm).map_err(|error| format!("能力 WASM 无效: {error}"))?;
        validate_host_imports(&module, &prepared.manifest.permissions)?;
        let limits = StoreLimitsBuilder::new()
            .memory_size(8 * 1024 * 1024)
            .instances(1)
            .memories(1)
            .tables(1)
            .build();
        let mut store = Store::new(
            &engine,
            CapabilityStore {
                limits,
                permissions: prepared.manifest.permissions.iter().cloned().collect(),
                events: Vec::new(),
                artifacts: Vec::new(),
            },
        );
        store.limiter(|state| &mut state.limits);
        store
            .set_fuel(10_000_000)
            .map_err(|error| format!("无法设置能力 fuel: {error}"))?;
        let mut linker = Linker::new(&engine);
        register_host_abi(&mut linker)?;
        let instance = linker
            .instantiate_and_start(&mut store, &module)
            .map_err(|error| format!("无法启动能力: {error}"))?;
        let memory = instance
            .get_memory(&store, "memory")
            .ok_or_else(|| "能力必须导出 memory".to_string())?;
        memory
            .write(&mut store, 0, input)
            .map_err(|error| format!("能力输入超过 memory 边界: {error}"))?;
        let run = instance
            .get_typed_func::<(i32, i32), i64>(&store, "run")
            .map_err(|_| "能力必须导出 run(i32,i32)->i64".to_string())?;
        let packed = run
            .call(&mut store, (0, input.len() as i32))
            .map_err(|error| format!("能力执行失败: {error}"))? as u64;
        let offset = (packed >> 32) as usize;
        let length = (packed & u32::MAX as u64) as usize;
        self.governor.validate_output(length)?;
        let mut output = vec![0; length];
        memory
            .read(&store, offset, &mut output)
            .map_err(|error| format!("能力输出超过 memory 边界: {error}"))?;
        Ok(output)
    }

    fn verify(&self, manifest: &CapabilityManifest, payload: &[u8]) -> Result<(), String> {
        self.verify_manifest(manifest)?;
        if payload.len() as u64 != manifest.compressed_size {
            return Err("能力包大小与 manifest 不一致".into());
        }
        let digest = format!("{:x}", Sha256::digest(payload));
        if digest != manifest.sha256 {
            return Err("能力包 SHA-256 不匹配".into());
        }
        Ok(())
    }

    fn verify_manifest(&self, manifest: &CapabilityManifest) -> Result<(), String> {
        validate_manifest(manifest)?;
        if manifest.api_version != CAPABILITY_HOST_API_V1 {
            return Err("能力 Host API 版本不兼容".into());
        }
        if !manifest
            .platforms
            .iter()
            .any(|value| value == std::env::consts::OS)
            || !manifest
                .architectures
                .iter()
                .any(|value| value == std::env::consts::ARCH)
        {
            return Err("能力平台或架构不匹配".into());
        }
        if !runtime_is_compatible(&manifest.minimum_runtime_version) {
            return Err("能力要求更高版本的 ClawMaster runtime".into());
        }
        if manifest.compressed_size > MAX_PACKAGE_BYTES
            || manifest.installed_size > MAX_PACKAGE_BYTES
        {
            return Err("能力包超过 12 MiB".into());
        }
        let key = self
            .trusted_keys
            .get(&manifest.signature.key_id)
            .ok_or_else(|| "能力签名 key ID 不受信任".to_string())?;
        let signature = STANDARD
            .decode(&manifest.signature.value)
            .map_err(|_| "能力签名不是有效 Base64")?;
        UnparsedPublicKey::new(&ED25519, key)
            .verify(&signed_bytes(manifest)?, &signature)
            .map_err(|_| "能力签名验证失败".to_string())
    }

    fn verify_dependencies(
        &self,
        manifest: &CapabilityManifest,
        registry: &CapabilityRegistry,
    ) -> Result<(), String> {
        for dependency in &manifest.dependencies {
            let Some(installed) = registry.installed.get(&dependency.id) else {
                return Err(format!("缺少能力依赖 {}", dependency.id));
            };
            if !version_is_compatible(&installed.manifest.version, &dependency.minimum_version) {
                return Err(format!("能力依赖 {} 版本过低", dependency.id));
            }
        }
        Ok(())
    }

    fn registry(&self) -> Result<CapabilityRegistry, String> {
        self.store
            .get::<CapabilityRegistry>(TREE_INDEX, REGISTRY_ID)
            .map(|record| record.map_or_else(CapabilityRegistry::default, |record| record.payload))
            .map_err(|error| error.to_string())
    }

    fn save_registry(&self, registry: &CapabilityRegistry) -> Result<(), String> {
        self.store
            .put_latest(TREE_INDEX, REGISTRY_ID, "capability-host", registry.clone())
            .map_err(|error| error.to_string())?;
        self.store.flush().map_err(|error| error.to_string())
    }
}

fn ensure_direct_child_directory(root: &Path, path: &Path, label: &str) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir(path).map_err(|error| format!("无法创建{label}目录: {error}"))?;
        }
        Err(error) => return Err(format!("无法检查{label}目录: {error}")),
    }
    validate_direct_child_directory(root, path, label)
}

fn validate_direct_child_directory(root: &Path, path: &Path, label: &str) -> Result<(), String> {
    let metadata =
        fs::symlink_metadata(path).map_err(|error| format!("无法检查{label}目录: {error}"))?;
    if metadata.file_type().is_symlink() {
        return Err(format!("{label}目录不能是符号链接"));
    }
    if !metadata.is_dir() {
        return Err(format!("{label}路径不是目录"));
    }
    let canonical_root = root
        .canonicalize()
        .map_err(|error| format!("无法解析能力根目录: {error}"))?;
    let canonical_path = path
        .canonicalize()
        .map_err(|error| format!("无法解析{label}目录: {error}"))?;
    if canonical_path.parent() != Some(canonical_root.as_path()) {
        return Err(format!("{label}目录逃逸能力根目录"));
    }
    Ok(())
}

fn validate_direct_child_file(root: &Path, path: &Path, label: &str) -> Result<(), String> {
    let metadata =
        fs::symlink_metadata(path).map_err(|error| format!("无法检查{label}: {error}"))?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(format!("{label}必须是普通文件"));
    }
    let canonical_root = root
        .canonicalize()
        .map_err(|error| format!("无法解析{label}根目录: {error}"))?;
    let canonical_path = path
        .canonicalize()
        .map_err(|error| format!("无法解析{label}: {error}"))?;
    if canonical_path.parent() != Some(canonical_root.as_path()) {
        return Err(format!("{label}逃逸版本目录"));
    }
    Ok(())
}

fn remove_capability_entry(path: &Path, file_type: fs::FileType) -> std::io::Result<()> {
    if file_type.is_dir() && !file_type.is_symlink() {
        fs::remove_dir_all(path)
    } else {
        fs::remove_file(path)
    }
}

fn signed_bytes(manifest: &CapabilityManifest) -> Result<Vec<u8>, String> {
    serde_json::to_vec(&SignedManifest {
        schema_version: manifest.schema_version,
        id: &manifest.id,
        version: &manifest.version,
        api_version: &manifest.api_version,
        platforms: &manifest.platforms,
        architectures: &manifest.architectures,
        entrypoint: &manifest.entrypoint,
        permissions: &manifest.permissions,
        dependencies: &manifest.dependencies,
        compressed_size: manifest.compressed_size,
        installed_size: manifest.installed_size,
        sha256: &manifest.sha256,
        minimum_runtime_version: &manifest.minimum_runtime_version,
    })
    .map_err(|error| error.to_string())
}

fn version_is_compatible(current: &str, minimum: &str) -> bool {
    fn core(value: &str) -> Option<(u64, u64, u64)> {
        let mut parts = value.split('-').next()?.split('.');
        Some((
            parts.next()?.parse().ok()?,
            parts.next()?.parse().ok()?,
            parts.next()?.parse().ok()?,
        ))
    }
    core(current)
        .zip(core(minimum))
        .is_some_and(|(current, required)| current >= required)
}

fn runtime_is_compatible(minimum: &str) -> bool {
    version_is_compatible(env!("CARGO_PKG_VERSION"), minimum)
}

fn validate_manifest(manifest: &CapabilityManifest) -> Result<(), String> {
    let safe_id = !manifest.id.is_empty()
        && manifest.id.len() <= 120
        && manifest.id.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'.' | b'-')
        });
    let safe_version = !manifest.version.is_empty()
        && manifest.version.len() <= 64
        && manifest
            .version
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-'));
    let safe_entry = !manifest.entrypoint.is_empty()
        && manifest.entrypoint.len() <= 120
        && !manifest.entrypoint.contains('/')
        && !manifest.entrypoint.contains('\\')
        && !manifest.entrypoint.starts_with('.');
    let safe_permissions = manifest.permissions.iter().all(|permission| {
        matches!(
            permission.as_str(),
            "artifact:read"
                | "artifact:write"
                | "approval:request"
                | "event:emit"
                | "file:selected-read"
                | "file:selected-write"
                | "network:declared-hosts"
        )
    });
    let safe_dependencies = manifest.dependencies.len() <= 16
        && manifest.dependencies.iter().all(|dependency| {
            !dependency.id.is_empty()
                && dependency.id.len() <= 120
                && dependency.id != manifest.id
                && version_is_compatible(&dependency.minimum_version, &dependency.minimum_version)
        });
    if manifest.schema_version != 1
        || !safe_id
        || !safe_version
        || !safe_entry
        || manifest.sha256.len() != 64
        || manifest.permissions.len() > 32
        || !safe_permissions
        || !safe_dependencies
        || manifest.platforms.is_empty()
        || manifest.architectures.is_empty()
    {
        return Err("能力 manifest 字段无效".into());
    }
    Ok(())
}

fn host_import_permission(name: &str) -> Option<&'static str> {
    match name {
        "artifact_read" => Some("artifact:read"),
        "artifact_write" => Some("artifact:write"),
        "approval_request" => Some("approval:request"),
        "event_emit" => Some("event:emit"),
        "file_selected_read" => Some("file:selected-read"),
        "file_selected_write" => Some("file:selected-write"),
        "network_request" => Some("network:declared-hosts"),
        _ => None,
    }
}

fn validate_host_imports(module: &Module, permissions: &[String]) -> Result<(), String> {
    for import in module.imports() {
        if import.module() != CAPABILITY_HOST_API_V1 {
            return Err("能力声明了未授权 Host ABI/WASI import".into());
        }
        let required = host_import_permission(import.name())
            .ok_or_else(|| "能力声明了未知 Host ABI import".to_string())?;
        if !permissions.iter().any(|permission| permission == required) {
            return Err(format!("能力未声明 Host ABI 所需权限 {required}"));
        }
    }
    Ok(())
}

fn read_host_bytes(
    caller: &Caller<'_, CapabilityStore>,
    pointer: i32,
    length: i32,
    maximum: usize,
) -> Option<Vec<u8>> {
    let pointer = usize::try_from(pointer).ok()?;
    let length = usize::try_from(length).ok()?;
    if length > maximum {
        return None;
    }
    let memory = caller.get_export("memory")?.into_memory()?;
    let mut bytes = vec![0; length];
    memory.read(caller, pointer, &mut bytes).ok()?;
    Some(bytes)
}

fn register_host_abi(linker: &mut Linker<CapabilityStore>) -> Result<(), String> {
    linker
        .func_wrap(
            CAPABILITY_HOST_API_V1,
            "event_emit",
            |mut caller: Caller<'_, CapabilityStore>, pointer: i32, length: i32| -> i32 {
                if !caller.data().permissions.contains("event:emit")
                    || caller.data().events.len() >= 1_000
                {
                    return -1;
                }
                let Some(bytes) = read_host_bytes(&caller, pointer, length, 64 * 1024) else {
                    return -1;
                };
                caller.data_mut().events.push(bytes);
                0
            },
        )
        .map_err(|error| format!("无法注册 event Host ABI: {error}"))?;
    linker
        .func_wrap(
            CAPABILITY_HOST_API_V1,
            "artifact_write",
            |mut caller: Caller<'_, CapabilityStore>, pointer: i32, length: i32| -> i32 {
                if !caller.data().permissions.contains("artifact:write") {
                    return -1;
                }
                let Some(bytes) = read_host_bytes(&caller, pointer, length, 1024 * 1024) else {
                    return -1;
                };
                caller.data_mut().artifacts.push(bytes);
                0
            },
        )
        .map_err(|error| format!("无法注册 artifact Host ABI: {error}"))?;
    linker
        .func_wrap(
            CAPABILITY_HOST_API_V1,
            "artifact_read",
            |caller: Caller<'_, CapabilityStore>, _pointer: i32, _length: i32| -> i32 {
                i32::from(caller.data().permissions.contains("artifact:read")) - 1
            },
        )
        .map_err(|error| format!("无法注册 artifact read Host ABI: {error}"))?;
    for (name, permission) in [
        ("approval_request", "approval:request"),
        ("file_selected_read", "file:selected-read"),
        ("file_selected_write", "file:selected-write"),
        ("network_request", "network:declared-hosts"),
    ] {
        linker
            .func_wrap(
                CAPABILITY_HOST_API_V1,
                name,
                move |caller: Caller<'_, CapabilityStore>, _pointer: i32, _length: i32| -> i32 {
                    if caller.data().permissions.contains(permission) {
                        0
                    } else {
                        -1
                    }
                },
            )
            .map_err(|error| format!("无法注册 {name} Host ABI: {error}"))?;
    }
    Ok(())
}

pub fn wasm_health_check(path: &Path) -> Result<(), String> {
    let bytes = fs::read(path).map_err(|error| format!("无法读取 WASM: {error}"))?;
    let engine = WasmEngine::default();
    let module = Module::new(&engine, bytes).map_err(|error| format!("WASM 验证失败: {error}"))?;
    for import in module.imports() {
        if import.module() != CAPABILITY_HOST_API_V1
            || host_import_permission(import.name()).is_none()
        {
            return Err("能力声明了未知 Host ABI 或 WASI import".into());
        }
    }
    let has_memory = module.exports().any(|export| export.name() == "memory");
    let has_run = module.exports().any(|export| export.name() == "run");
    if !has_memory || !has_run {
        return Err("能力缺少 memory 或 run 导出".into());
    }
    Ok(())
}

fn validate_wasm_permissions(path: &Path, permissions: &[String]) -> Result<(), String> {
    let bytes = fs::read(path).map_err(|error| format!("无法读取 WASM: {error}"))?;
    let engine = WasmEngine::default();
    let module = Module::new(&engine, bytes).map_err(|error| format!("WASM 验证失败: {error}"))?;
    validate_host_imports(&module, permissions)
}

#[cfg(test)]
mod tests {
    use super::*;
    use ring::signature::{Ed25519KeyPair, KeyPair};

    fn signed_manifest(payload: &[u8], pair: &Ed25519KeyPair, version: &str) -> CapabilityManifest {
        let mut manifest = CapabilityManifest {
            schema_version: 1,
            id: "team.nsi.office".into(),
            version: version.into(),
            api_version: CAPABILITY_HOST_API_V1.into(),
            platforms: vec![std::env::consts::OS.into()],
            architectures: vec![std::env::consts::ARCH.into()],
            entrypoint: "worker.wasm".into(),
            permissions: vec!["artifact:write".into()],
            dependencies: Vec::new(),
            compressed_size: payload.len() as u64,
            installed_size: payload.len() as u64,
            sha256: format!("{:x}", Sha256::digest(payload)),
            minimum_runtime_version: "0.0.2".into(),
            signature: CapabilitySignature {
                key_id: "test-key".into(),
                value: String::new(),
            },
        };
        manifest.signature.value = STANDARD.encode(pair.sign(&signed_bytes(&manifest).unwrap()));
        manifest
    }

    fn host() -> (tempfile::TempDir, CapabilityHost, Ed25519KeyPair) {
        let root = tempfile::tempdir().unwrap();
        let store = NativeStateStore::open_for_test(&root.path().join("state"), [66; 32]).unwrap();
        let document = Ed25519KeyPair::generate_pkcs8(&ring::rand::SystemRandom::new()).unwrap();
        let pair = Ed25519KeyPair::from_pkcs8(document.as_ref()).unwrap();
        let trusted = BTreeMap::from([("test-key".into(), pair.public_key().as_ref().to_vec())]);
        let host = CapabilityHost::open(&root.path().join("packs"), store, trusted).unwrap();
        (root, host, pair)
    }

    #[tokio::test]
    async fn cold_start_is_zero_and_second_agent_queues_without_eviction() {
        let (_root, host, _pair) = host();
        assert_eq!(host.list().unwrap(), Vec::new());
        let cold = host.resource_snapshot().unwrap();
        assert_eq!(cold.active_workers, 0);
        assert_eq!(cold.trusted_key_count, 1);
        let (admission, first) = host.reserve_agent("a1").unwrap();
        assert_eq!(admission, AgentAdmission::Active);
        let first = first.wait_until_active().await.unwrap();
        let (admission, second) = host.reserve_agent("a2").unwrap();
        assert_eq!(admission, AgentAdmission::Queued);
        assert_eq!(host.resource_snapshot().unwrap().active_agents, 1);
        drop(first);
        let second = second.wait_until_active().await.unwrap();
        assert_eq!(host.resource_snapshot().unwrap().active_agents, 1);
        drop(second);
        assert_eq!(host.resource_snapshot().unwrap().active_agents, 0);
    }

    #[tokio::test]
    async fn dropped_reservations_leave_no_queued_or_active_agent() {
        let governor = ResourceGovernor::default();
        let (_, first) = governor.reserve_agent("first").unwrap();
        assert!(governor.reserve_agent("first").is_err());
        let (_, queued) = governor.reserve_agent("queued").unwrap();
        assert!(governor.reserve_agent("queued").is_err());
        assert_eq!(governor.snapshot().unwrap().queued_agents, 1);
        drop(queued);
        assert_eq!(governor.snapshot().unwrap().queued_agents, 0);
        let (_, waiting) = governor.reserve_agent("waiting").unwrap();
        assert!(tokio::time::timeout(
            std::time::Duration::from_millis(5),
            waiting.wait_until_active()
        )
        .await
        .is_err());
        assert_eq!(governor.snapshot().unwrap().queued_agents, 0);
        let (_, promoted) = governor.reserve_agent("promoted").unwrap();
        drop(first);
        drop(promoted);
        assert_eq!(governor.snapshot().unwrap().active_agents, 0);
    }

    #[tokio::test]
    async fn eight_agents_release_every_lease_and_worker_across_500_turns() {
        let governor = ResourceGovernor::default();
        let mut agents = Vec::new();
        for agent_index in 0..8 {
            let governor = governor.clone();
            agents.push(tokio::spawn(async move {
                let agent_id = format!("stress-agent-{agent_index}");
                for turn in 0..500 {
                    let (_, agent) = governor.reserve_agent(&agent_id).unwrap();
                    let agent = agent.wait_until_active().await.unwrap();
                    if turn % 25 == 0 {
                        let worker = governor.acquire_worker().unwrap();
                        drop(worker);
                    }
                    drop(agent);
                    tokio::task::yield_now().await;
                }
            }));
        }
        for agent in agents {
            agent.await.unwrap();
        }

        let snapshot = governor.snapshot().unwrap();
        assert_eq!(snapshot.active_agents, 0);
        assert_eq!(snapshot.queued_agents, 0);
        assert_eq!(snapshot.active_workers, 0);
        assert_eq!(snapshot.loaded_implementations, 0);
    }

    #[test]
    fn installation_requires_approval_signature_hash_platform_and_health() {
        let (_root, host, pair) = host();
        let payload = b"\0asm\x01\0\0\0";
        let manifest = signed_manifest(payload, &pair, "1.0.0");
        assert!(host
            .install(manifest.clone(), payload, false, 1, |_| Ok(()))
            .is_err());
        let mut bad_hash = manifest.clone();
        bad_hash.sha256 = "0".repeat(64);
        assert!(host
            .install(bad_hash, payload, true, 1, |_| Ok(()))
            .is_err());
        let mut bad_platform = manifest.clone();
        bad_platform.platforms = vec!["unsupported".into()];
        bad_platform.signature.value =
            STANDARD.encode(pair.sign(&signed_bytes(&bad_platform).unwrap()));
        assert!(host
            .install(bad_platform, payload, true, 1, |_| Ok(()))
            .is_err());
        assert!(host
            .install(manifest.clone(), payload, true, 1, |_| Err("boom".into()))
            .is_err());
        assert!(host.list().unwrap().is_empty());
        assert!(host.install(manifest, payload, true, 2, |_| Ok(())).is_ok());
    }

    #[test]
    fn stages_a_complete_version_before_health_check_and_atomic_commit() {
        let (_root, host, pair) = host();
        let payload = b"\0asm\x01\0\0\0";
        let manifest = signed_manifest(payload, &pair, "1.0.0");

        host.install(manifest, payload, true, 1, |entrypoint| {
            let staged_manifest = entrypoint.parent().unwrap().join("manifest.json");
            assert!(staged_manifest.is_file());
            Ok(())
        })
        .unwrap();
    }

    #[test]
    fn refuses_to_replace_an_existing_version_with_different_bytes() {
        let (_root, host, pair) = host();
        let first = wat::parse_str(
            r#"(module
                (memory (export "memory") 1)
                (data (i32.const 32) "first")
                (func (export "run") (param i32 i32) (result i64)
                    (i64.const 137438953477)))"#,
        )
        .unwrap();
        host.install(
            signed_manifest(&first, &pair, "1.0.0"),
            &first,
            true,
            1,
            wasm_health_check,
        )
        .unwrap();

        let second = wat::parse_str(
            r#"(module
                (memory (export "memory") 1)
                (data (i32.const 32) "later")
                (func (export "run") (param i32 i32) (result i64)
                    (i64.const 137438953477)))"#,
        )
        .unwrap();
        let error = host
            .install(
                signed_manifest(&second, &pair, "1.0.0"),
                &second,
                true,
                2,
                wasm_health_check,
            )
            .unwrap_err();

        assert!(error.contains("版本"));
        assert_eq!(host.invoke("team.nsi.office", b"{}").unwrap(), b"first");
    }

    #[test]
    fn restart_removes_orphan_versions_but_preserves_current_and_previous() {
        let root = tempfile::tempdir().unwrap();
        let store = NativeStateStore::open_for_test(&root.path().join("state"), [67; 32]).unwrap();
        let document = Ed25519KeyPair::generate_pkcs8(&ring::rand::SystemRandom::new()).unwrap();
        let pair = Ed25519KeyPair::from_pkcs8(document.as_ref()).unwrap();
        let trusted = BTreeMap::from([("test-key".into(), pair.public_key().as_ref().to_vec())]);
        let packs = root.path().join("packs");
        let host = CapabilityHost::open(&packs, store.clone(), trusted.clone()).unwrap();
        let first = b"\0asm\x01\0\0\0";
        host.install(
            signed_manifest(first, &pair, "1.0.0"),
            first,
            true,
            1,
            |_| Ok(()),
        )
        .unwrap();
        let second = wat::parse_str("(module (func))").unwrap();
        host.install(
            signed_manifest(&second, &pair, "2.0.0"),
            &second,
            true,
            2,
            |_| Ok(()),
        )
        .unwrap();
        drop(host);

        let orphan = packs.join("team.nsi.office/3.0.0");
        fs::create_dir_all(&orphan).unwrap();
        fs::write(orphan.join("worker.wasm"), b"partial").unwrap();
        fs::create_dir(packs.join(".staging-team.nsi.office-4.0.0")).unwrap();

        CapabilityHost::open(&packs, store, trusted).unwrap();

        assert!(packs.join("team.nsi.office/1.0.0").is_dir());
        assert!(packs.join("team.nsi.office/2.0.0").is_dir());
        assert!(!orphan.exists());
        assert!(!packs.join(".staging-team.nsi.office-4.0.0").exists());
    }

    #[cfg(unix)]
    #[test]
    fn installation_rejects_a_symlinked_package_root_without_writing_outside() {
        use std::os::unix::fs::symlink;

        let (root, host, pair) = host();
        let outside = root.path().join("outside");
        fs::create_dir(&outside).unwrap();
        symlink(&outside, root.path().join("packs").join("team.nsi.office")).unwrap();
        let payload = b"\0asm\x01\0\0\0";

        let error = host
            .install(
                signed_manifest(payload, &pair, "1.0.0"),
                payload,
                true,
                1,
                |_| Ok(()),
            )
            .unwrap_err();

        assert!(error.contains("符号链接") || error.contains("目录"));
        assert!(!outside.join("1.0.0/worker.wasm").exists());
    }

    #[test]
    fn rollback_rejects_a_tampered_previous_version_and_keeps_current_active() {
        let (root, host, pair) = host();
        let first = wat::parse_str(
            r#"(module
                (memory (export "memory") 1)
                (data (i32.const 32) "first")
                (func (export "run") (param i32 i32) (result i64)
                    (i64.const 137438953477)))"#,
        )
        .unwrap();
        host.install(
            signed_manifest(&first, &pair, "1.0.0"),
            &first,
            true,
            1,
            wasm_health_check,
        )
        .unwrap();
        let second = wat::parse_str(
            r#"(module
                (memory (export "memory") 1)
                (data (i32.const 32) "later")
                (func (export "run") (param i32 i32) (result i64)
                    (i64.const 137438953477)))"#,
        )
        .unwrap();
        host.install(
            signed_manifest(&second, &pair, "2.0.0"),
            &second,
            true,
            2,
            wasm_health_check,
        )
        .unwrap();
        fs::write(
            root.path().join("packs/team.nsi.office/1.0.0/worker.wasm"),
            b"tampered",
        )
        .unwrap();

        assert!(host.rollback("team.nsi.office").is_err());
        assert_eq!(host.invoke("team.nsi.office", b"{}").unwrap(), b"later");
        assert_eq!(host.list().unwrap()[0].manifest.version, "2.0.0");
    }

    #[cfg(unix)]
    #[test]
    fn invocation_rejects_an_entrypoint_symlink_even_when_bytes_match() {
        use std::os::unix::fs::symlink;

        let (root, host, pair) = host();
        let wasm = wat::parse_str(
            r#"(module
                (memory (export "memory") 1)
                (func (export "run") (param i32 i32) (result i64) (i64.const 0)))"#,
        )
        .unwrap();
        host.install(
            signed_manifest(&wasm, &pair, "1.0.0"),
            &wasm,
            true,
            1,
            wasm_health_check,
        )
        .unwrap();
        let entrypoint = root.path().join("packs/team.nsi.office/1.0.0/worker.wasm");
        let outside = root.path().join("outside.wasm");
        fs::write(&outside, &wasm).unwrap();
        fs::remove_file(&entrypoint).unwrap();
        symlink(&outside, &entrypoint).unwrap();

        let error = host.invoke("team.nsi.office", b"{}").unwrap_err();
        assert!(error.contains("普通文件") || error.contains("逃逸"));
    }

    #[test]
    fn plans_before_download_and_requires_approval_to_uninstall() {
        let (_root, host, pair) = host();
        let payload = b"\0asm\x01\0\0\0";
        let manifest = signed_manifest(payload, &pair, "1.0.0");
        let plan = host
            .plan_install(&manifest, "https://releases.clawmaster-ai.com/office.wasm")
            .unwrap();
        assert_eq!(plan.compressed_size, payload.len() as u64);
        assert_eq!(plan.permissions, vec!["artifact:write"]);
        assert_eq!(
            host.plan_install(&manifest, "user-selected-file")
                .unwrap()
                .source,
            "user-selected-file"
        );
        assert!(host
            .plan_install(&manifest, "http://insecure.test/office.wasm")
            .is_err());
        host.install(manifest, payload, true, 1, |_| Ok(()))
            .unwrap();
        assert!(host.uninstall("team.nsi.office", false).is_err());
        host.uninstall("team.nsi.office", true).unwrap();
        assert!(host.list().unwrap().is_empty());
    }

    #[test]
    fn lazy_worker_release_upgrade_and_rollback_preserve_complete_versions() {
        let (_root, host, pair) = host();
        let first = wat::parse_str(
            r#"(module
                (memory (export "memory") 1)
                (func (export "run") (param i32 i32) (result i64) (i64.const 0)))"#,
        )
        .unwrap();
        host.install(
            signed_manifest(&first, &pair, "1.0.0"),
            &first,
            true,
            1,
            wasm_health_check,
        )
        .unwrap();
        assert_eq!(host.resource_snapshot().unwrap().active_workers, 0);
        let prepared = host.prepare("team.nsi.office").unwrap();
        assert!(prepared.executable.is_file());
        assert_eq!(host.resource_snapshot().unwrap().active_workers, 1);
        drop(prepared);
        assert_eq!(host.resource_snapshot().unwrap().active_workers, 0);

        let second = wat::parse_str(
            r#"(module
                (memory (export "memory") 1)
                (func (export "run") (param i32 i32) (result i64) (i64.const 0)))"#,
        )
        .unwrap();
        host.install(
            signed_manifest(&second, &pair, "2.0.0"),
            &second,
            true,
            2,
            wasm_health_check,
        )
        .unwrap();
        assert_eq!(
            host.rollback("team.nsi.office").unwrap().manifest.version,
            "1.0.0"
        );
        assert!(host.governor.validate_output(1024 * 1024 + 1).is_err());
        assert!(host.governor.validate_timeout(301).is_err());
    }

    #[test]
    fn executes_fuel_and_memory_bounded_wasm_without_ambient_imports() {
        let (_root, host, pair) = host();
        let wasm = wat::parse_str(
            r#"(module
                (memory (export "memory") 1)
                (data (i32.const 1024) "{\22ok\22:true}")
                (func (export "run") (param i32 i32) (result i64)
                    (i64.const 4398046511115)))"#,
        )
        .unwrap();
        let manifest = signed_manifest(&wasm, &pair, "1.0.0");
        host.install(manifest, &wasm, true, 1, wasm_health_check)
            .unwrap();
        assert_eq!(
            host.invoke("team.nsi.office", br#"{"input":1}"#).unwrap(),
            br#"{"ok":true}"#
        );
        assert_eq!(host.resource_snapshot().unwrap().active_workers, 0);

        let imported = wat::parse_str(
            r#"(module
                (import "wasi_snapshot_preview1" "fd_write" (func))
                (memory (export "memory") 1)
                (func (export "run") (param i32 i32) (result i64) (i64.const 0)))"#,
        )
        .unwrap();
        assert!(wasm_health_check(&write_test_wasm(&imported)).is_err());
    }

    #[test]
    fn allows_only_declared_versioned_host_abi_imports() {
        let (_root, host, pair) = host();
        let wasm = wat::parse_str(
            r#"(module
                (import "clawmaster.capability.v1" "event_emit" (func $emit (param i32 i32) (result i32)))
                (memory (export "memory") 1)
                (data (i32.const 32) "ready")
                (func (export "run") (param i32 i32) (result i64)
                    (drop (call $emit (i32.const 32) (i32.const 5)))
                    (i64.const 0)))"#,
        )
        .unwrap();
        let mut undeclared = signed_manifest(&wasm, &pair, "1.0.0");
        assert!(host
            .install(undeclared.clone(), &wasm, true, 1, wasm_health_check)
            .unwrap_err()
            .contains("event:emit"));
        undeclared.permissions.push("event:emit".into());
        undeclared.signature.value =
            STANDARD.encode(pair.sign(&signed_bytes(&undeclared).unwrap()));
        host.install(undeclared, &wasm, true, 2, wasm_health_check)
            .unwrap();
        assert_eq!(host.invoke("team.nsi.office", b"{}").unwrap(), b"");
    }

    #[test]
    fn refuses_an_installed_wasm_that_was_modified_after_verification() {
        let (_root, host, pair) = host();
        let wasm = wat::parse_str(
            r#"(module
                (memory (export "memory") 1)
                (func (export "run") (param i32 i32) (result i64) (i64.const 0)))"#,
        )
        .unwrap();
        host.install(
            signed_manifest(&wasm, &pair, "1.0.0"),
            &wasm,
            true,
            1,
            wasm_health_check,
        )
        .unwrap();
        let installed = host.prepare("team.nsi.office").unwrap();
        fs::write(&installed.executable, b"tampered").unwrap();
        drop(installed);
        assert!(host
            .invoke("team.nsi.office", b"{}")
            .unwrap_err()
            .contains("篡改"));
    }

    fn write_test_wasm(bytes: &[u8]) -> PathBuf {
        let path =
            std::env::temp_dir().join(format!("clawmaster-capability-{}.wasm", std::process::id()));
        fs::write(&path, bytes).unwrap();
        path
    }
}
