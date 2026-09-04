use crate::native_models::CredentialStore;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine};
use ring::{
    rand::SystemRandom,
    signature::{Ed25519KeyPair, KeyPair, UnparsedPublicKey, ED25519},
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashSet;
use url::Url;

const KEY_ID: &str = "native-enterprise-ed25519-pkcs8";
const MAX_TTL: u64 = 30 * 24 * 60 * 60;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct EnterpriseState {
    workspace: Value,
    redeemed_invites: HashSet<String>,
}

impl Default for EnterpriseState {
    fn default() -> Self {
        Self {
            workspace: personal(),
            redeemed_invites: HashSet::new(),
        }
    }
}

#[derive(Deserialize, Serialize)]
struct Claims {
    v: u8,
    id: String,
    kind: String,
    issuer: String,
    company: String,
    issued: u64,
    expires: u64,
    department: Option<String>,
    position: Option<String>,
    direction: Option<String>,
    target_company: Option<String>,
}

fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn id(prefix: &str) -> String {
    let mut bytes = [0_u8; 16];
    let _ = getrandom::getrandom(&mut bytes);
    format!("{prefix}_{}", URL_SAFE_NO_PAD.encode(bytes))
}

fn clean(payload: &Value, key: &str, label: &str) -> Result<String, String> {
    let value = payload
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    if value.is_empty() || value.chars().count() > 200 || value.chars().any(char::is_control) {
        Err(format!("{label}为空、过长或包含控制字符"))
    } else {
        Ok(value.into())
    }
}

fn clean_link(payload: &Value, key: &str) -> Result<String, String> {
    let value = payload
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    if value.is_empty() || value.len() > 8 * 1024 || value.chars().any(char::is_control) {
        Err("企业邀请链接为空、过长或包含控制字符".into())
    } else {
        Ok(value.into())
    }
}

fn personal() -> Value {
    json!({"schemaVersion":1,"context":{"edition":"personal","role":"personal","userId":"local-user","displayName":"ClawMaster User",
        "capabilities":["agent:base","model:byok","skill:built-in","skill:auto-create","schedule:write"]},
        "members":[],"friends":[],"credits":{"balance":0,"frozen":0,"status":"design-preview"}})
}

pub fn snapshot(state: &EnterpriseState) -> Value {
    state.workspace.clone()
}

pub fn configure(state: &mut EnterpriseState, payload: &Value) -> Result<Value, String> {
    let manager = clean(payload, "managerName", "管理者姓名")?;
    let company = clean(payload, "companyName", "企业名称")?;
    let company_id = id("company");
    let departments = [
        "CEO 办公室",
        "产品与研发部",
        "市场部",
        "销售与客户成功部",
        "财务部",
        "人力与行政部",
    ]
    .into_iter()
    .map(|name| json!({"id":id("dept"),"companyId":company_id,"name":name}))
    .collect::<Vec<_>>();
    let management = departments[0]["id"].as_str().unwrap_or("");
    let mut positions = vec![
        json!({"id":id("position"),"companyId":company_id,"departmentId":management,"title":"CEO","incumbentUserId":"local-user"}),
    ];
    positions.extend(departments.iter().skip(1).map(|department| {
        json!({
            "id":id("position"),"companyId":company_id,"departmentId":department["id"],
            "title":format!("{}负责人", department["name"].as_str().unwrap_or("部门"))
        })
    }));
    let context = json!({"edition":"enterprise","role":"company_owner","userId":"local-user","displayName":manager,"companyId":company_id,
        "capabilities":["agent:base","model:byok","skill:built-in","skill:auto-create","skill:market","organization:read","schedule:write","billing:read","invite:issue","organization:manage","billing:manage"]});
    state.workspace = json!({"schemaVersion":1,"context":context,"managerWorkspace":{"profile":{"managerId":"local-user","managerName":manager,
        "companyName":company,"industry":payload.get("industry"),"employeeScale":payload.get("employeeScale"),"createdAt":chrono::Utc::now().to_rfc3339()},
        "context":context,"organization":{"rootCompanyId":company_id,"companies":[{"id":company_id,"name":company,"ownerUserId":"local-user"}],
        "departments":departments,"positions":positions}},
        "members":[{"userId":"local-user","displayName":manager,"companyId":company_id,"departmentId":management,"positionTitle":"CEO","role":"company_owner"}],
        "friends":[],"credits":{"balance":0,"frozen":0,"status":"design-preview"}});
    Ok(snapshot(state))
}

pub fn switch_personal(state: &mut EnterpriseState) -> Value {
    let manager = state.workspace.get("managerWorkspace").cloned();
    let friends = state
        .workspace
        .get("friends")
        .cloned()
        .unwrap_or_else(|| json!([]));
    state.workspace = personal();
    if let Some(value) = manager {
        state.workspace["managerWorkspace"] = value;
    }
    state.workspace["friends"] = friends;
    snapshot(state)
}

fn key_pair(store: &dyn CredentialStore) -> Result<Ed25519KeyPair, String> {
    let encoded = match store.get(KEY_ID) {
        Ok(value) => value,
        Err(_) => {
            let value = Ed25519KeyPair::generate_pkcs8(&SystemRandom::new())
                .map_err(|_| "无法生成 Ed25519 邀请密钥".to_string())?;
            let encoded = URL_SAFE_NO_PAD.encode(value.as_ref());
            store.set(KEY_ID, &encoded)?;
            encoded
        }
    };
    let bytes = URL_SAFE_NO_PAD
        .decode(encoded)
        .map_err(|_| "邀请私钥损坏".to_string())?;
    Ed25519KeyPair::from_pkcs8(&bytes).map_err(|_| "邀请私钥无效".to_string())
}

pub fn issue(
    state: &EnterpriseState,
    payload: &Value,
    store: &dyn CredentialStore,
) -> Result<Value, String> {
    let context = &state.workspace["context"];
    if !context["capabilities"]
        .as_array()
        .is_some_and(|items| items.iter().any(|item| item == "invite:issue"))
    {
        return Err("当前身份没有签发企业链接的权限".into());
    }
    let kind = clean(payload, "kind", "邀请类型")?;
    if !matches!(kind.as_str(), "position" | "company" | "company_link") {
        return Err("邀请类型无效".into());
    }
    if kind == "company_link" && context["role"] != "company_owner" {
        return Err("只有企业 CEO 可以签发父子公司链接".into());
    }
    if kind == "company_link"
        && !matches!(
            payload.get("direction").and_then(Value::as_str),
            Some("parent_invites_child" | "child_requests_parent")
        )
    {
        return Err("父子公司邀请方向无效".into());
    }
    let ttl = payload
        .get("expiresInSeconds")
        .and_then(Value::as_u64)
        .unwrap_or(604_800);
    if ttl == 0 || ttl > MAX_TTL {
        return Err("邀请有效期必须在 1 秒到 30 天之间".into());
    }
    let issued = now();
    let claims = Claims {
        v: 1,
        id: id("invite"),
        kind: kind.clone(),
        issuer: context["userId"].as_str().unwrap_or("").into(),
        company: context["companyId"].as_str().unwrap_or("").into(),
        issued,
        expires: issued + ttl,
        department: payload
            .get("departmentId")
            .and_then(Value::as_str)
            .map(str::to_owned),
        position: payload
            .get("positionId")
            .and_then(Value::as_str)
            .map(str::to_owned),
        direction: payload
            .get("direction")
            .and_then(Value::as_str)
            .map(str::to_owned),
        target_company: payload
            .get("targetCompanyId")
            .and_then(Value::as_str)
            .map(str::to_owned),
    };
    if kind == "position" && (claims.department.is_none() || claims.position.is_none()) {
        return Err("职位邀请缺少部门或职位".into());
    }
    if kind == "position" {
        let organization = &state.workspace["managerWorkspace"]["organization"];
        let department = claims.department.as_deref().unwrap_or("");
        let position = claims.position.as_deref().unwrap_or("");
        let valid_department = organization["departments"]
            .as_array()
            .is_some_and(|items| items.iter().any(|item| item["id"] == department));
        let valid_position = organization["positions"].as_array().is_some_and(|items| {
            items
                .iter()
                .any(|item| item["id"] == position && item["departmentId"] == department)
        });
        if !valid_department || !valid_position {
            return Err("邀请职位不存在或不属于指定部门".into());
        }
    }
    let pair = key_pair(store)?;
    let body =
        URL_SAFE_NO_PAD.encode(serde_json::to_vec(&claims).map_err(|error| error.to_string())?);
    let token = format!(
        "{body}.{}",
        URL_SAFE_NO_PAD.encode(pair.sign(body.as_bytes()).as_ref())
    );
    let mut url = Url::parse("otto://enterprise/join").map_err(|error| error.to_string())?;
    url.query_pairs_mut()
        .append_pair("token", &token)
        .append_pair("key", &URL_SAFE_NO_PAD.encode(pair.public_key().as_ref()));
    Ok(
        json!({"kind":kind,"link":url.as_str(),"expiresAt":chrono::DateTime::from_timestamp(claims.expires as i64,0).map(|date| date.to_rfc3339()).unwrap_or_default()}),
    )
}

fn verify_at(link: &str, current_time: u64) -> Result<Claims, String> {
    let url = Url::parse(link).map_err(|_| "企业邀请链接无效".to_string())?;
    if url.scheme() != "otto" || url.host_str() != Some("enterprise") || url.path() != "/join" {
        return Err("企业邀请链接来源无效".into());
    }
    let params = url
        .query_pairs()
        .collect::<std::collections::HashMap<_, _>>();
    let token = params
        .get("token")
        .ok_or_else(|| "邀请缺少 token".to_string())?;
    let key = URL_SAFE_NO_PAD
        .decode(
            params
                .get("key")
                .ok_or_else(|| "邀请缺少公钥".to_string())?
                .as_bytes(),
        )
        .map_err(|_| "邀请公钥无效".to_string())?;
    let (body, signature) = token
        .split_once('.')
        .ok_or_else(|| "邀请 token 无效".to_string())?;
    let signature = URL_SAFE_NO_PAD
        .decode(signature)
        .map_err(|_| "邀请签名无效".to_string())?;
    UnparsedPublicKey::new(&ED25519, key)
        .verify(body.as_bytes(), &signature)
        .map_err(|_| "邀请签名校验失败".to_string())?;
    let claims: Claims = serde_json::from_slice(
        &URL_SAFE_NO_PAD
            .decode(body)
            .map_err(|_| "邀请 payload 无效".to_string())?,
    )
    .map_err(|_| "邀请 payload 无效".to_string())?;
    if claims.v != 1 || claims.expires <= current_time || claims.expires <= claims.issued {
        return Err("邀请已过期或字段无效".into());
    }
    Ok(claims)
}

fn verify(link: &str) -> Result<Claims, String> {
    verify_at(link, now())
}

pub fn join(state: &mut EnterpriseState, payload: &Value) -> Result<Value, String> {
    let claims = verify(&clean_link(payload, "link")?)?;
    if claims.kind == "company_link" {
        return Err("父子公司链接需要由企业管理者接入".into());
    }
    let user = clean(payload, "userId", "用户 ID")?;
    let name = clean(payload, "displayName", "姓名")?;
    if !state.redeemed_invites.insert(claims.id) {
        return Err("该企业链接已使用".into());
    }
    state.workspace = json!({"schemaVersion":1,"context":{"edition":"enterprise","role":"member","userId":user,"displayName":name,"companyId":claims.company,
        "departmentId":claims.department,"positionId":claims.position,"capabilities":["agent:base","model:byok","skill:built-in","skill:auto-create","skill:market","organization:read","schedule:write","billing:read"]},
        "members":[{"userId":user,"displayName":name,"companyId":claims.company,"departmentId":claims.department,"positionId":claims.position,"role":"member"}],
        "friends":[],"credits":{"balance":0,"frozen":0,"status":"design-preview"}});
    Ok(snapshot(state))
}

pub fn add_friend(state: &mut EnterpriseState, payload: &Value) -> Result<Value, String> {
    let name = clean(payload, "displayName", "好友名称")?;
    let note = payload
        .get("note")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|v| !v.is_empty());
    state.workspace["friends"].as_array_mut().ok_or_else(||"好友数据损坏".to_string())?.push(json!({"id":id("friend"),"displayName":name,"note":note,"createdAt":chrono::Utc::now().to_rfc3339()}));
    Ok(snapshot(state))
}

pub fn accept_company_link(state: &mut EnterpriseState, payload: &Value) -> Result<Value, String> {
    if state.workspace["context"]["role"] != "company_owner" {
        return Err("只有企业 CEO 可以接入父子公司链接".into());
    }
    let claims = verify(&clean_link(payload, "link")?)?;
    if claims.kind != "company_link" {
        return Err("链接不是父子公司邀请".into());
    }
    if !state.redeemed_invites.insert(claims.id) {
        return Err("该企业链接已使用".into());
    }
    state.workspace["companyLink"] = json!({"companyId":claims.company,"direction":claims.direction,"targetCompanyId":claims.target_company});
    Ok(snapshot(state))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;
    #[derive(Default)]
    struct Memory(Mutex<Option<String>>);
    impl CredentialStore for Memory {
        fn set(&self, _: &str, v: &str) -> Result<(), String> {
            *self.0.lock().unwrap() = Some(v.into());
            Ok(())
        }
        fn get(&self, _: &str) -> Result<String, String> {
            self.0
                .lock()
                .unwrap()
                .clone()
                .ok_or_else(|| "missing".into())
        }
        fn delete(&self, _: &str) -> Result<(), String> {
            Ok(())
        }
    }
    #[test]
    fn signed_invites_verify_and_are_one_time() {
        let store = Memory::default();
        let mut issuer = EnterpriseState::default();
        configure(
            &mut issuer,
            &json!({"managerName":"Ada","companyName":"NSI"}),
        )
        .unwrap();
        let invite = issue(
            &issuer,
            &json!({"kind":"company","expiresInSeconds":60}),
            &store,
        )
        .unwrap();
        let mut member = EnterpriseState::default();
        let p = json!({"link":invite["link"],"userId":"u2","displayName":"Lin"});
        assert_eq!(
            join(&mut member, &p).unwrap()["context"]["edition"],
            "enterprise"
        );
        assert!(join(&mut member, &p).is_err());
        let link = invite["link"].as_str().unwrap();
        let mut tampered = link.to_string();
        let last = tampered.pop().unwrap();
        tampered.push(if last == 'A' { 'B' } else { 'A' });
        assert!(verify(&tampered).is_err());
        assert!(verify_at(link, now() + 61).is_err());
        let second = issue(
            &issuer,
            &json!({"kind":"company","expiresInSeconds":60}),
            &store,
        )
        .unwrap();
        let invalid = json!({"link":second["link"],"userId":"u3","displayName":""});
        assert!(join(&mut member, &invalid).is_err());
        let corrected = json!({"link":second["link"],"userId":"u3","displayName":"Kai"});
        assert!(join(&mut member, &corrected).is_ok());
    }
}
