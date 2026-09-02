use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};
use url::Url;

const MAX_SKILL_FILES: usize = 200;
const MAX_SKILL_BYTES: u64 = 5 * 1024 * 1024;
const MAX_GITHUB_TREE_BYTES: usize = 8 * 1024 * 1024;

#[derive(Debug, Deserialize)]
struct GitHubRepository {
    default_branch: String,
}

#[derive(Debug, Deserialize)]
struct GitHubTree {
    tree: Vec<GitHubTreeEntry>,
    truncated: bool,
}

#[derive(Debug, Deserialize)]
struct GitHubTreeEntry {
    path: String,
    mode: String,
    #[serde(rename = "type")]
    kind: String,
    size: Option<u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommunitySkillInstallResult {
    id: String,
    name: String,
    source: String,
    install_path: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledCommunitySkill {
    name: String,
    install_path: String,
}

fn skills_root(app: &AppHandle) -> Result<PathBuf, String> {
    let home = app
        .path()
        .home_dir()
        .map_err(|error| format!("无法确定用户目录：{error}"))?;
    Ok(home.join(".clawmaster-user").join("skills"))
}

#[tauri::command]
pub fn community_skill_list(app: AppHandle) -> Result<Vec<InstalledCommunitySkill>, String> {
    let root = skills_root(&app)?;
    if !root.exists() {
        return Ok(Vec::new());
    }
    let mut installed = Vec::new();
    for entry in fs::read_dir(root).map_err(|error| format!("读取本地插件目录失败：{error}"))?
    {
        let entry = entry.map_err(|error| format!("读取本地插件失败：{error}"))?;
        let file_type = entry
            .file_type()
            .map_err(|error| format!("检查本地插件失败：{error}"))?;
        if file_type.is_dir() && !file_type.is_symlink() && entry.path().join("SKILL.md").is_file()
        {
            installed.push(InstalledCommunitySkill {
                name: entry.file_name().to_string_lossy().into_owned(),
                install_path: entry.path().to_string_lossy().into_owned(),
            });
        }
    }
    installed.sort_by(|left, right| left.name.cmp(&right.name));
    Ok(installed)
}

fn validate_source(source: &str) -> Result<(String, String), String> {
    let parsed =
        Url::parse(source).map_err(|_| "插件来源必须是有效的 GitHub HTTPS 地址".to_string())?;
    if parsed.scheme() != "https" || parsed.host_str() != Some("github.com") {
        return Err("目前仅允许从 https://github.com 导入社区插件".into());
    }
    let parts = parsed
        .path_segments()
        .map(|value| value.collect::<Vec<_>>())
        .unwrap_or_default();
    if parts.len() != 2
        || parts.iter().any(|value| {
            value.is_empty()
                || !value
                    .chars()
                    .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.'))
        })
    {
        return Err("GitHub 插件地址必须是 https://github.com/owner/repository".into());
    }
    Ok((
        parts[0].to_string(),
        parts[1].trim_end_matches(".git").to_string(),
    ))
}

fn validate_slug(slug: &str) -> Result<(), String> {
    if slug.is_empty()
        || slug.len() > 80
        || !slug
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_'))
    {
        return Err("插件名称不合法".into());
    }
    Ok(())
}

fn select_skill_directory_from_tree(tree: &str, slug: &str) -> Option<String> {
    let exact = format!("{slug}/SKILL.md");
    let suffix = format!("/{slug}/SKILL.md");
    let mut matches = tree
        .lines()
        .map(str::trim)
        .filter(|entry| *entry == exact || entry.ends_with(&suffix))
        .filter(|entry| {
            entry
                .split('/')
                .all(|part| !part.is_empty() && part != "." && part != "..")
        })
        .filter_map(|entry| entry.strip_suffix("/SKILL.md"))
        .map(str::to_string)
        .collect::<Vec<_>>();
    matches.sort_by(|left, right| {
        left.split('/')
            .count()
            .cmp(&right.split('/').count())
            .then_with(|| left.cmp(right))
    });
    matches.into_iter().next()
}

fn curl_bytes(url: &str, max_bytes: usize, context: &str) -> Result<Vec<u8>, String> {
    let curl = if cfg!(target_os = "windows") {
        "curl.exe"
    } else {
        "/usr/bin/curl"
    };
    let max_bytes_arg = max_bytes.to_string();
    let output = Command::new(curl)
        .args([
            "--fail",
            "--location",
            "--silent",
            "--show-error",
            "--connect-timeout",
            "10",
            "--max-time",
            "60",
            "--max-filesize",
            &max_bytes_arg,
            "--header",
            "Accept: application/vnd.github+json",
            "--header",
            "User-Agent: ClawMaster/0.0.1-preview",
            url,
        ])
        .output()
        .map_err(|error| format!("无法启动系统下载器：{error}"))?;
    if !output.status.success() {
        return Err(format!(
            "{context}：{}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    if output.stdout.len() > max_bytes {
        return Err(format!("{context}：响应超过安全大小上限"));
    }
    Ok(output.stdout)
}

fn github_json<T: for<'de> Deserialize<'de>>(
    url: &str,
    max_bytes: usize,
    context: &str,
) -> Result<T, String> {
    let bytes = curl_bytes(url, max_bytes, context)?;
    serde_json::from_slice(&bytes).map_err(|error| format!("{context}：响应格式无效：{error}"))
}

fn raw_github_url(owner: &str, repository: &str, branch: &str, path: &str) -> Result<Url, String> {
    let mut url = Url::parse("https://raw.githubusercontent.com/")
        .map_err(|error| format!("构造 GitHub 下载地址失败：{error}"))?;
    {
        let mut segments = url
            .path_segments_mut()
            .map_err(|_| "构造 GitHub 下载地址失败".to_string())?;
        segments.push(owner).push(repository).push(branch);
        for part in path.split('/') {
            segments.push(part);
        }
    }
    Ok(url)
}

fn download_skill_from_github(
    owner: &str,
    repository: &str,
    slug: &str,
    destination: &Path,
) -> Result<(), String> {
    let repository_url = format!("https://api.github.com/repos/{owner}/{repository}");
    let metadata: GitHubRepository =
        github_json(&repository_url, 1024 * 1024, "读取 GitHub 仓库信息失败")?;
    let tree_url = format!(
        "https://api.github.com/repos/{owner}/{repository}/git/trees/{}?recursive=1",
        metadata.default_branch
    );
    let tree: GitHubTree =
        github_json(&tree_url, MAX_GITHUB_TREE_BYTES, "读取 GitHub 插件目录失败")?;
    if tree.truncated {
        return Err("GitHub 仓库目录过大，无法安全定位插件".into());
    }
    let tree_paths = tree
        .tree
        .iter()
        .map(|entry| entry.path.as_str())
        .collect::<Vec<_>>()
        .join("\n");
    let skill_relative = select_skill_directory_from_tree(&tree_paths, slug)
        .ok_or_else(|| format!("仓库中没有找到 {slug}/SKILL.md"))?;
    let prefix = format!("{skill_relative}/");
    let mut files = tree
        .tree
        .into_iter()
        .filter(|entry| entry.path.starts_with(&prefix) && entry.kind != "tree")
        .collect::<Vec<_>>();
    files.sort_by(|left, right| left.path.cmp(&right.path));
    if files.is_empty() || files.len() > MAX_SKILL_FILES {
        return Err("插件超过 200 个文件的本地导入上限".into());
    }
    let declared_bytes = files.iter().try_fold(0_u64, |total, entry| {
        if entry.kind != "blob" || entry.mode == "120000" {
            return Err("插件包含符号链接或子模块，已拒绝导入".to_string());
        }
        total
            .checked_add(entry.size.unwrap_or(MAX_SKILL_BYTES + 1))
            .ok_or_else(|| "插件大小无效".to_string())
    })?;
    if declared_bytes > MAX_SKILL_BYTES {
        return Err("插件超过 5 MiB 的本地导入上限".into());
    }
    let mut downloaded_bytes = 0_u64;
    for entry in files {
        let relative = entry
            .path
            .strip_prefix(&prefix)
            .ok_or_else(|| "GitHub 插件路径无效".to_string())?;
        if relative.is_empty()
            || relative
                .split('/')
                .any(|part| part.is_empty() || part == "." || part == "..")
        {
            return Err("GitHub 插件路径无效".into());
        }
        let target = relative
            .split('/')
            .fold(destination.to_path_buf(), |path, part| path.join(part));
        let parent = target
            .parent()
            .ok_or_else(|| "GitHub 插件路径无效".to_string())?;
        fs::create_dir_all(parent).map_err(|error| format!("创建插件目录失败：{error}"))?;
        let raw_url = raw_github_url(owner, repository, &metadata.default_branch, &entry.path)?;
        let remaining = (MAX_SKILL_BYTES - downloaded_bytes) as usize;
        let bytes = curl_bytes(
            raw_url.as_str(),
            remaining.max(1),
            "下载 GitHub 插件文件失败",
        )?;
        downloaded_bytes += bytes.len() as u64;
        if downloaded_bytes > MAX_SKILL_BYTES {
            return Err("插件超过 5 MiB 的本地导入上限".into());
        }
        fs::write(target, bytes).map_err(|error| format!("写入插件文件失败：{error}"))?;
    }
    if !destination.join("SKILL.md").is_file() {
        return Err("插件缺少 SKILL.md".into());
    }
    Ok(())
}

fn install(
    app: &AppHandle,
    id: &str,
    source: &str,
    slug: &str,
) -> Result<CommunitySkillInstallResult, String> {
    validate_slug(slug)?;
    let (owner, repository) = validate_source(source)?;
    let skills_root = skills_root(app)?;
    fs::create_dir_all(&skills_root).map_err(|error| format!("创建本地插件目录失败：{error}"))?;
    let destination = skills_root.join(slug);
    if destination.exists() {
        return Err(format!("插件 {slug} 已安装"));
    }
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let staged = skills_root.join(format!(".{slug}.installing-{nonce}"));
    let result = (|| {
        download_skill_from_github(&owner, &repository, slug, &staged)?;
        fs::rename(&staged, &destination).map_err(|error| format!("原子安装插件失败：{error}"))?;
        Ok(CommunitySkillInstallResult {
            id: id.to_string(),
            name: slug.to_string(),
            source: format!("{owner}/{repository}"),
            install_path: destination.to_string_lossy().into_owned(),
        })
    })();
    let _ = fs::remove_dir_all(&staged);
    result
}

#[tauri::command]
pub async fn community_skill_install(
    app: AppHandle,
    id: String,
    source: String,
    slug: String,
) -> Result<CommunitySkillInstallResult, String> {
    tauri::async_runtime::spawn_blocking(move || install(&app, &id, &source, &slug))
        .await
        .map_err(|error| format!("插件安装任务失败：{error}"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn github_source_is_strictly_scoped() {
        assert_eq!(
            validate_source("https://github.com/vercel-labs/skills").unwrap(),
            ("vercel-labs".into(), "skills".into())
        );
        assert!(validate_source("http://github.com/vercel-labs/skills").is_err());
        assert!(validate_source("https://example.com/vercel-labs/skills").is_err());
        assert!(validate_source("https://github.com/vercel-labs/skills/extra").is_err());
    }

    #[test]
    fn selects_only_the_requested_skill_directory() {
        let tree = [
            "README.md",
            "skills/docx/SKILL.md",
            "skills/pdf/SKILL.md",
            "skills/pdf/scripts/render.py",
            "examples/pdf/SKILL.md",
        ]
        .join("\n");
        assert_eq!(
            select_skill_directory_from_tree(&tree, "pdf"),
            Some("examples/pdf".into())
        );
        assert_eq!(select_skill_directory_from_tree(&tree, "missing"), None);
    }

    #[test]
    #[ignore = "requires public GitHub access"]
    fn downloads_only_one_real_github_skill() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("clawmaster-skill-e2e-{nonce}"));
        let result = download_skill_from_github("anthropics", "skills", "pdf", &root);
        assert!(result.is_ok(), "{}", result.unwrap_err());
        assert!(root.join("SKILL.md").is_file());
        let _ = fs::remove_dir_all(root);
    }
}
