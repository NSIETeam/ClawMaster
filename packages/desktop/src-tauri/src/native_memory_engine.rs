use crate::native_state_store::{NativeStateStore, TREE_MEMORY};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::cmp::Ordering;
use std::collections::{HashMap, HashSet};
use std::sync::RwLock;

const MAX_CONTENT_CHARS: usize = 8_000;
const MAX_EVIDENCE_ITEMS: usize = 32;

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
pub struct MemoryScope {
    pub kind: String,
    pub id: String,
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MemoryRecord {
    pub id: String,
    pub scope: MemoryScope,
    pub kind: String,
    pub content: String,
    pub source_event_id: String,
    #[serde(default)]
    pub source_event_history: Vec<String>,
    pub evidence: Vec<String>,
    pub confidence: f32,
    pub sensitivity: String,
    pub expiry: Option<u64>,
    pub supersedes: Option<String>,
    pub revision: u64,
    pub manual: bool,
    pub tombstoned: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NewMemoryRecord {
    pub scope: MemoryScope,
    pub kind: String,
    pub content: String,
    pub source_event_id: String,
    #[serde(default)]
    pub evidence: Vec<String>,
    pub confidence: f32,
    pub sensitivity: String,
    pub expiry: Option<u64>,
    pub supersedes: Option<String>,
    #[serde(default)]
    pub manual: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(untagged)]
enum StoredMemoryEntry {
    Record(MemoryRecord),
    LegacyDocument {
        scope: String,
        display_path: String,
        content: String,
    },
}

#[derive(Default)]
struct MemoryIndex {
    records: HashMap<String, MemoryRecord>,
    source_events: HashMap<String, String>,
    postings: HashMap<(MemoryScope, String), HashSet<String>>,
}

impl MemoryIndex {
    fn insert(&mut self, record: MemoryRecord) {
        if let Some(previous) = self.records.remove(&record.id) {
            self.remove_postings(&previous);
        }
        if !record.tombstoned {
            for token in tokenize(&record.content) {
                self.postings
                    .entry((record.scope.clone(), token))
                    .or_default()
                    .insert(record.id.clone());
            }
        }
        for source_event_id in record
            .source_event_history
            .iter()
            .chain(std::iter::once(&record.source_event_id))
        {
            self.source_events
                .insert(source_event_id.clone(), record.id.clone());
        }
        self.records.insert(record.id.clone(), record);
    }

    fn remove_postings(&mut self, record: &MemoryRecord) {
        for token in tokenize(&record.content) {
            let key = (record.scope.clone(), token);
            if let Some(ids) = self.postings.get_mut(&key) {
                ids.remove(&record.id);
                if ids.is_empty() {
                    self.postings.remove(&key);
                }
            }
        }
    }
}

pub struct NativeMemoryEngine {
    store: NativeStateStore,
    index: RwLock<MemoryIndex>,
}

impl NativeMemoryEngine {
    pub fn open(store: NativeStateStore) -> Result<Self, String> {
        let scanned = store
            .scan::<StoredMemoryEntry>(TREE_MEMORY)
            .map_err(|error| error.to_string())?;
        let mut index = MemoryIndex::default();
        for entry in scanned.records {
            if let StoredMemoryEntry::Record(record) = entry.payload {
                index.insert(record);
            }
        }
        Ok(Self {
            store,
            index: RwLock::new(index),
        })
    }

    pub fn remember(&self, input: NewMemoryRecord) -> Result<MemoryRecord, String> {
        validate_new_record(&input)?;
        let mut index = self
            .index
            .write()
            .map_err(|_| "记忆索引锁已损坏".to_string())?;
        if let Some(id) = index.source_events.get(&input.source_event_id) {
            return index
                .records
                .get(id)
                .cloned()
                .ok_or_else(|| "记忆 sourceEvent 索引不一致".to_string());
        }
        let id = format!(
            "memory:{:x}",
            Sha256::digest(
                format!(
                    "{}:{}:{}",
                    input.scope.kind, input.scope.id, input.source_event_id
                )
                .as_bytes()
            )
        );
        let record = MemoryRecord {
            id,
            scope: input.scope,
            kind: input.kind,
            content: input.content.trim().to_string(),
            source_event_id: input.source_event_id,
            source_event_history: Vec::new(),
            evidence: input.evidence,
            confidence: input.confidence,
            sensitivity: input.sensitivity,
            expiry: input.expiry,
            supersedes: input.supersedes,
            revision: 1,
            manual: input.manual,
            tombstoned: false,
        };
        self.store
            .put_latest(
                TREE_MEMORY,
                &record.id,
                &record.source_event_id,
                StoredMemoryEntry::Record(record.clone()),
            )
            .map_err(|error| error.to_string())?;
        self.store.flush().map_err(|error| error.to_string())?;
        index.insert(record.clone());
        Ok(record)
    }

    pub fn forget(&self, id: &str, source_event_id: &str) -> Result<bool, String> {
        let mut index = self
            .index
            .write()
            .map_err(|_| "记忆索引锁已损坏".to_string())?;
        let Some(existing) = index.records.get(id).cloned() else {
            return Ok(false);
        };
        if existing.tombstoned {
            return Ok(false);
        }
        if source_event_id.trim().is_empty() {
            return Err("forget 缺少 sourceEventId".into());
        }
        let mut forgotten = existing;
        forgotten.tombstoned = true;
        forgotten.revision += 1;
        forgotten
            .source_event_history
            .push(forgotten.source_event_id.clone());
        forgotten.source_event_id = source_event_id.to_string();
        self.store
            .put_latest(
                TREE_MEMORY,
                &forgotten.id,
                source_event_id,
                StoredMemoryEntry::Record(forgotten.clone()),
            )
            .map_err(|error| error.to_string())?;
        self.store.flush().map_err(|error| error.to_string())?;
        index.insert(forgotten);
        Ok(true)
    }

    pub fn recall(
        &self,
        query: &str,
        scopes: &[MemoryScope],
        limit: usize,
        now_ms: u64,
    ) -> Result<Vec<MemoryRecord>, String> {
        if scopes.is_empty() || limit == 0 {
            return Ok(Vec::new());
        }
        let query_tokens = tokenize(query);
        if query_tokens.is_empty() {
            return Ok(Vec::new());
        }
        let index = self
            .index
            .read()
            .map_err(|_| "记忆索引锁已损坏".to_string())?;
        let allowed = scopes.iter().cloned().collect::<HashSet<_>>();
        let mut candidates = HashSet::new();
        for scope in scopes {
            let mut postings = query_tokens
                .iter()
                .filter_map(|token| index.postings.get(&(scope.clone(), token.clone())))
                .collect::<Vec<_>>();
            postings.sort_by_key(|ids| ids.len());
            let Some(first) = postings.first() else {
                continue;
            };
            let mut scoped = (*first).clone();
            for ids in postings.iter().skip(1) {
                scoped.retain(|id| ids.contains(id));
            }
            candidates.extend(scoped);
        }
        let superseded = index
            .records
            .values()
            .filter(|record| allowed.contains(&record.scope))
            .filter_map(|record| record.supersedes.clone())
            .collect::<HashSet<_>>();
        let query_lower = query.to_lowercase();
        let mut ranked = candidates
            .into_iter()
            .filter_map(|id| index.records.get(&id))
            .filter(|record| allowed.contains(&record.scope))
            .filter(|record| !record.tombstoned && !superseded.contains(&record.id))
            .filter(|record| record.expiry.is_none_or(|expiry| expiry > now_ms))
            .map(|record| {
                let record_tokens = tokenize(&record.content);
                let overlap = query_tokens.intersection(&record_tokens).count() as f32;
                let coverage = overlap / query_tokens.len().max(1) as f32;
                let phrase = record.content.to_lowercase().contains(&query_lower) as u8 as f32;
                let score = coverage * 10.0
                    + phrase * 3.0
                    + record.confidence
                    + if record.manual { 2.0 } else { 0.0 };
                (score, record)
            })
            .collect::<Vec<_>>();
        ranked.sort_by(|left, right| {
            right
                .0
                .partial_cmp(&left.0)
                .unwrap_or(Ordering::Equal)
                .then_with(|| right.1.revision.cmp(&left.1.revision))
                .then_with(|| left.1.id.cmp(&right.1.id))
        });
        Ok(ranked
            .into_iter()
            .take(limit.min(20))
            .map(|(_, record)| record.clone())
            .collect())
    }

    pub fn prompt_context(
        &self,
        query: &str,
        scopes: &[MemoryScope],
        max_tokens: usize,
        now_ms: u64,
    ) -> Result<(String, Vec<String>), String> {
        let records = self.recall(query, scopes, 5, now_ms)?;
        let mut remaining_chars = max_tokens.saturating_mul(4);
        let mut lines = Vec::new();
        let mut ids = Vec::new();
        for record in records {
            let prefix = format!("- [{}] ", record.id);
            if prefix.len() >= remaining_chars {
                break;
            }
            let available = remaining_chars - prefix.len();
            let content = record.content.chars().take(available).collect::<String>();
            remaining_chars = remaining_chars.saturating_sub(prefix.len() + content.len());
            lines.push(format!("{prefix}{content}"));
            ids.push(record.id);
            if remaining_chars < 32 {
                break;
            }
        }
        Ok((lines.join("\n"), ids))
    }
}

pub fn scope(kind: &str, id: impl Into<String>) -> MemoryScope {
    MemoryScope {
        kind: kind.into(),
        id: id.into(),
    }
}

pub fn project_scope_id(workspace: &std::path::Path) -> Result<String, String> {
    let canonical = workspace
        .canonicalize()
        .map_err(|error| format!("无法解析记忆项目目录: {error}"))?;
    Ok(format!(
        "project:{:x}",
        Sha256::digest(canonical.to_string_lossy().as_bytes())
    ))
}

fn validate_new_record(input: &NewMemoryRecord) -> Result<(), String> {
    let valid_scope = matches!(input.scope.kind.as_str(), "user" | "project" | "session");
    if !valid_scope || !valid_identity(&input.scope.id) {
        return Err("记忆 scope 必须是带 ID 的 user/project/session".into());
    }
    if input.content.trim().is_empty() || input.content.chars().count() > MAX_CONTENT_CHARS {
        return Err("记忆内容为空或超过 8000 字符".into());
    }
    if !valid_identity(&input.source_event_id) {
        return Err("记忆 sourceEventId 无效".into());
    }
    if input.evidence.len() > MAX_EVIDENCE_ITEMS
        || !(0.0..=1.0).contains(&input.confidence)
        || !matches!(
            input.sensitivity.as_str(),
            "public" | "internal" | "confidential"
        )
    {
        return Err("记忆 evidence、confidence 或 sensitivity 无效".into());
    }
    Ok(())
}

fn valid_identity(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))
}

fn tokenize(text: &str) -> HashSet<String> {
    let normalized = text.to_lowercase();
    let mut tokens = HashSet::new();
    let mut ascii = String::new();
    let mut cjk = Vec::new();
    let flush_ascii = |value: &mut String, output: &mut HashSet<String>| {
        if value.len() >= 2 {
            output.insert(std::mem::take(value));
        } else {
            value.clear();
        }
    };
    for character in normalized.chars() {
        if character.is_ascii_alphanumeric() || character == '_' {
            flush_cjk(&mut cjk, &mut tokens);
            ascii.push(character);
        } else if is_cjk(character) {
            flush_ascii(&mut ascii, &mut tokens);
            cjk.push(character);
        } else {
            flush_ascii(&mut ascii, &mut tokens);
            flush_cjk(&mut cjk, &mut tokens);
        }
    }
    flush_ascii(&mut ascii, &mut tokens);
    flush_cjk(&mut cjk, &mut tokens);
    tokens
}

fn flush_cjk(characters: &mut Vec<char>, output: &mut HashSet<String>) {
    for character in characters.iter() {
        output.insert(character.to_string());
    }
    for pair in characters.windows(2) {
        output.insert(pair.iter().collect());
    }
    characters.clear();
}

fn is_cjk(character: char) -> bool {
    matches!(character as u32, 0x3400..=0x4DBF | 0x4E00..=0x9FFF | 0xF900..=0xFAFF)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    fn engine() -> (tempfile::TempDir, NativeMemoryEngine) {
        let root = tempfile::tempdir().unwrap();
        let store = NativeStateStore::open_for_test(root.path(), [61; 32]).unwrap();
        let engine = NativeMemoryEngine::open(store).unwrap();
        (root, engine)
    }

    fn input(scope: MemoryScope, source: &str, content: String) -> NewMemoryRecord {
        NewMemoryRecord {
            scope,
            kind: "fact".into(),
            content,
            source_event_id: source.into(),
            evidence: vec![format!("event:{source}")],
            confidence: 0.9,
            sensitivity: "internal".into(),
            expiry: None,
            supersedes: None,
            manual: false,
        }
    }

    #[test]
    fn source_replay_forget_and_supersede_are_authoritative() {
        let (root, engine) = engine();
        let scope = MemoryScope {
            kind: "project".into(),
            id: "p1".into(),
        };
        let first = engine
            .remember(input(scope.clone(), "event-1", "旧服务器端口 7000".into()))
            .unwrap();
        assert_eq!(
            engine
                .remember(input(scope.clone(), "event-1", "不得覆盖".into()))
                .unwrap(),
            first
        );
        assert_eq!(
            engine
                .store
                .count(crate::native_state_store::TREE_USAGE)
                .unwrap(),
            0
        );
        let mut replacement = input(scope.clone(), "event-2", "新服务器端口 7637".into());
        replacement.supersedes = Some(first.id.clone());
        let replacement = engine.remember(replacement).unwrap();
        assert_eq!(
            engine.recall("服务器端口", &[scope.clone()], 5, 0).unwrap(),
            vec![replacement.clone()]
        );
        assert!(engine.forget(&replacement.id, "event-forget").unwrap());
        assert!(engine
            .recall("服务器端口", &[scope], 5, 0)
            .unwrap()
            .is_empty());
        assert!(
            engine
                .remember(input(
                    MemoryScope {
                        kind: "project".into(),
                        id: "p1".into()
                    },
                    "event-2",
                    "重放不得复活".into(),
                ))
                .unwrap()
                .tombstoned
        );
        drop(engine);
        let reopened = NativeMemoryEngine::open(
            NativeStateStore::open_for_test(root.path(), [61; 32]).unwrap(),
        )
        .unwrap();
        assert!(
            reopened
                .remember(input(
                    MemoryScope {
                        kind: "project".into(),
                        id: "p1".into()
                    },
                    "event-2",
                    "重启后重放仍不得复活".into(),
                ))
                .unwrap()
                .tombstoned
        );
    }

    #[test]
    fn rejects_unbounded_or_unsafe_scope_and_event_identifiers() {
        let (_root, engine) = engine();
        let unsafe_scope = input(scope("session", "../other"), "event-1", "secret".into());
        assert!(engine.remember(unsafe_scope).is_err());
        let unsafe_event = input(
            scope("session", "safe"),
            "event with spaces",
            "secret".into(),
        );
        assert!(engine.remember(unsafe_event).is_err());
    }

    #[test]
    fn scope_filter_happens_before_chinese_english_and_code_ranking() {
        let (_root, engine) = engine();
        let user = MemoryScope {
            kind: "user".into(),
            id: "u1".into(),
        };
        let other = MemoryScope {
            kind: "user".into(),
            id: "u2".into(),
        };
        engine
            .remember(input(user.clone(), "cn", "库存预警使用安全库存阈值".into()))
            .unwrap();
        engine
            .remember(input(
                user.clone(),
                "en",
                "release rollback requires signed manifest".into(),
            ))
            .unwrap();
        engine
            .remember(input(
                user.clone(),
                "code",
                "RuntimeKernel::recover_all handles unknown_outcome".into(),
            ))
            .unwrap();
        engine
            .remember(input(other, "secret", "库存预警 secret-only".into()))
            .unwrap();
        assert_eq!(
            engine.recall("库存预警", &[user.clone()], 5, 0).unwrap()[0].source_event_id,
            "cn"
        );
        assert_eq!(
            engine
                .recall("signed manifest", &[user.clone()], 5, 0)
                .unwrap()[0]
                .source_event_id,
            "en"
        );
        assert_eq!(
            engine
                .recall("recover_all unknown_outcome", &[user], 5, 0)
                .unwrap()[0]
                .source_event_id,
            "code"
        );
    }

    #[test]
    #[ignore = "performance benchmark; run explicitly on an idle release-test host"]
    fn fifty_thousand_record_warm_recall_meets_the_release_budget() {
        let root = tempfile::tempdir().unwrap();
        let store = NativeStateStore::open_for_test(root.path(), [62; 32]).unwrap();
        let scope = MemoryScope {
            kind: "project".into(),
            id: "benchmark".into(),
        };
        let mut index_data = MemoryIndex::default();
        for index in 0..50_000 {
            index_data.insert(MemoryRecord {
                id: format!("memory-{index}"),
                scope: scope.clone(),
                kind: "fact".into(),
                content: format!("record {index} common payload marker-{index}"),
                source_event_id: format!("event-{index}"),
                source_event_history: Vec::new(),
                evidence: Vec::new(),
                confidence: 0.9,
                sensitivity: "internal".into(),
                expiry: None,
                supersedes: None,
                revision: 1,
                manual: false,
                tombstoned: false,
            });
        }
        let engine = NativeMemoryEngine {
            store,
            index: RwLock::new(index_data),
        };
        let started = Instant::now();
        let result = engine.recall("marker-42420", &[scope], 5, 0).unwrap();
        assert_eq!(result[0].source_event_id, "event-42420");
        assert!(
            started.elapsed().as_millis() < 50,
            "warm recall took {:?}",
            started.elapsed()
        );
    }

    #[test]
    #[ignore = "performance benchmark; run explicitly on an idle release-test host"]
    fn fifty_thousand_record_quality_and_latency_gate() {
        let root = tempfile::tempdir().unwrap();
        let store = NativeStateStore::open_for_test(root.path(), [65; 32]).unwrap();
        let scope = scope("project", "quality-benchmark");
        let mut index_data = MemoryIndex::default();
        for index in 0..50_000 {
            let topic = if index < 500 {
                format!("topic_{:03}", index / 5)
            } else {
                format!("noise_{index}")
            };
            index_data.insert(MemoryRecord {
                id: format!("quality-memory-{index}"),
                scope: scope.clone(),
                kind: "fact".into(),
                content: format!("{topic} evidence item {index}"),
                source_event_id: format!("quality-event-{index}"),
                source_event_history: Vec::new(),
                evidence: Vec::new(),
                confidence: 0.9,
                sensitivity: "internal".into(),
                expiry: None,
                supersedes: None,
                revision: 1,
                manual: false,
                tombstoned: false,
            });
        }
        let engine = NativeMemoryEngine {
            store,
            index: RwLock::new(index_data),
        };
        let mut durations = Vec::new();
        let mut relevant = 0usize;
        let mut returned = 0usize;
        for topic in 0..100 {
            let query = format!("topic_{topic:03}");
            let started = Instant::now();
            let results = engine.recall(&query, &[scope.clone()], 5, 0).unwrap();
            durations.push(started.elapsed());
            relevant += results
                .iter()
                .filter(|record| record.content.contains(&query))
                .count();
            returned += results.len();
        }
        let cold = durations[0];
        durations.sort();
        let p95 = durations[94];
        let recall = relevant as f64 / 500.0;
        let precision = relevant as f64 / returned.max(1) as f64;
        assert!(recall >= 0.90, "Recall@5 was {recall:.3}");
        assert!(precision >= 0.80, "Precision@5 was {precision:.3}");
        assert!(cold.as_millis() < 150, "cold recall took {cold:?}");
        assert!(p95.as_millis() < 50, "warm recall p95 took {p95:?}");
    }

    #[test]
    fn ten_thousand_adversarial_scope_queries_never_leak() {
        let (_root, engine) = engine();
        let allowed = MemoryScope {
            kind: "session".into(),
            id: "allowed".into(),
        };
        let denied = MemoryScope {
            kind: "session".into(),
            id: "denied".into(),
        };
        engine
            .remember(input(
                allowed.clone(),
                "allowed-event",
                "shared needle allowed".into(),
            ))
            .unwrap();
        engine
            .remember(input(
                denied,
                "denied-event",
                "shared needle denied secret".into(),
            ))
            .unwrap();
        for _ in 0..10_000 {
            let results = engine
                .recall("shared needle secret", &[allowed.clone()], 5, 0)
                .unwrap();
            assert!(results.iter().all(|record| record.scope == allowed));
        }
    }
}
