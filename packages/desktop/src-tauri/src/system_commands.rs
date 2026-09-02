use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
    sync::Mutex,
};

use crate::agent_sidecar;
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use serde::Serialize;
use tauri::{AppHandle, Manager, State, Theme, Window};
use tauri_plugin_dialog::DialogExt;
use url::Url;

#[derive(Default)]
pub struct ThemePreference(Mutex<ThemeChoice>);

#[derive(Default)]
pub struct DesktopFileState {
    file_grants: Mutex<HashSet<PathBuf>>,
    workspace_grants: Mutex<Vec<PathBuf>>,
}

const MAX_READ_FILE_BYTES: u64 = 50 * 1024 * 1024;
const MAX_TEXT_EXPORT_BYTES: usize = 10 * 1024 * 1024;

#[derive(Clone, Copy, Default)]
enum ThemeChoice {
    #[default]
    System,
    Light,
    Dark,
}

impl ThemeChoice {
    fn parse(value: &str) -> Result<Self, String> {
        match value {
            "system" => Ok(Self::System),
            "light" => Ok(Self::Light),
            "dark" => Ok(Self::Dark),
            _ => Err("invalid theme: expected system, light, or dark".into()),
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::System => "system",
            Self::Light => "light",
            Self::Dark => "dark",
        }
    }

    fn tauri_theme(self) -> Option<Theme> {
        match self {
            Self::System => None,
            Self::Light => Some(Theme::Light),
            Self::Dark => Some(Theme::Dark),
        }
    }
}

#[tauri::command]
pub fn open_external(url: String) -> Result<(), String> {
    let parsed = validate_external_url(&url)?;
    tauri_plugin_opener::open_url(parsed.as_str(), None::<&str>)
        .map_err(|error| format!("failed to open external URL: {error}"))
}

#[tauri::command]
pub fn open_path(app: AppHandle, path: String) -> Result<(), String> {
    let home = app
        .path()
        .home_dir()
        .map_err(|error| format!("failed to resolve the user directory: {error}"))?
        .canonicalize()
        .map_err(|error| format!("failed to inspect the user directory: {error}"))?;
    let candidate = PathBuf::from(path)
        .canonicalize()
        .map_err(|_| "path does not exist".to_string())?;
    validate_open_path(&candidate, &home)?;
    tauri_plugin_opener::open_path(candidate, None::<&str>)
        .map_err(|error| format!("failed to open path: {error}"))
}

#[tauri::command]
pub fn select_files(app: AppHandle, state: State<'_, DesktopFileState>) -> Vec<String> {
    let selected = app
        .dialog()
        .file()
        .add_filter(
            "Supported files",
            &[
                "png", "jpg", "jpeg", "gif", "webp", "bmp", "pdf", "doc", "docx", "xls", "xlsx",
                "ppt", "pptx", "txt", "csv", "json", "xml", "md", "zip", "log",
            ],
        )
        .blocking_pick_files()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|file| file.into_path().ok())
        .filter_map(|path| path.canonicalize().ok())
        .collect::<Vec<_>>();
    if let Ok(mut grants) = state.file_grants.lock() {
        grants.extend(selected.iter().cloned());
    }
    selected
        .into_iter()
        .map(|path| path.to_string_lossy().into_owned())
        .collect()
}

#[tauri::command]
pub fn select_folders(app: AppHandle, state: State<'_, DesktopFileState>) -> Vec<String> {
    let selected = app
        .dialog()
        .file()
        .blocking_pick_folders()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|folder| folder.into_path().ok())
        .filter_map(|path| path.canonicalize().ok())
        .collect::<Vec<_>>();
    if let Ok(mut grants) = state.workspace_grants.lock() {
        for path in &selected {
            if !grants.contains(path) {
                grants.insert(0, path.clone());
            }
        }
        grants.truncate(12);
    }
    selected
        .into_iter()
        .map(|path| path.to_string_lossy().into_owned())
        .collect()
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceDirectories {
    default_path: String,
    recent_paths: Vec<String>,
}

fn workspace_directories(home: &Path) -> WorkspaceDirectories {
    WorkspaceDirectories {
        default_path: home.to_string_lossy().into_owned(),
        recent_paths: Vec::new(),
    }
}

#[tauri::command]
pub fn get_workspace_directories(
    app: AppHandle,
    state: State<'_, DesktopFileState>,
) -> Result<WorkspaceDirectories, String> {
    let home = app
        .path()
        .home_dir()
        .map_err(|error| format!("failed to resolve the user directory: {error}"))?;
    let mut result = workspace_directories(&home);
    result.recent_paths = state
        .workspace_grants
        .lock()
        .map_err(|_| "workspace grant state is unavailable".to_string())?
        .iter()
        .map(|path| path.to_string_lossy().into_owned())
        .collect();
    Ok(result)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReadFileResult {
    file_path: String,
    file_name: String,
    size: u64,
    mime_type: String,
    data: String,
}

fn resolve_granted_file(path: &Path, grants: &HashSet<PathBuf>) -> Result<(PathBuf, u64), String> {
    let resolved = path
        .canonicalize()
        .map_err(|_| "selected file no longer exists".to_string())?;
    if !grants.contains(&resolved) {
        return Err("file access was not granted by the native picker".into());
    }
    let metadata = resolved
        .metadata()
        .map_err(|_| "selected file metadata is unavailable".to_string())?;
    if !metadata.is_file() {
        return Err("selected path is not a file".into());
    }
    if metadata.len() > MAX_READ_FILE_BYTES {
        return Err("selected file exceeds the 50 MiB attachment limit".into());
    }
    Ok((resolved, metadata.len()))
}

#[tauri::command]
pub fn read_file_path(
    file_path: String,
    state: State<'_, DesktopFileState>,
) -> Result<ReadFileResult, String> {
    let grants = state
        .file_grants
        .lock()
        .map_err(|_| "file grant state is unavailable".to_string())?;
    let (resolved, size) = resolve_granted_file(Path::new(&file_path), &grants)?;
    let data =
        fs::read(&resolved).map_err(|error| format!("failed to read selected file: {error}"))?;
    Ok(ReadFileResult {
        file_path: resolved.to_string_lossy().into_owned(),
        file_name: resolved
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("attachment")
            .to_string(),
        size,
        mime_type: mime_type_for_path(&resolved).to_string(),
        data: BASE64.encode(data),
    })
}

#[tauri::command]
pub fn extract_editable_document(
    app: AppHandle,
    file_path: String,
    state: State<'_, DesktopFileState>,
) -> Result<serde_json::Value, String> {
    let grants = state
        .file_grants
        .lock()
        .map_err(|_| "file grant state is unavailable".to_string())?;
    let (resolved, _) = resolve_granted_file(Path::new(&file_path), &grants)?;
    drop(grants);
    agent_sidecar::run_document_worker(
        &app,
        &serde_json::json!({
            "operation": "extract",
            "filePath": resolved,
        }),
    )
}

#[tauri::command]
pub fn export_edited_document(
    app: AppHandle,
    source_path: String,
    suggested_file_name: String,
    content: String,
    state: State<'_, DesktopFileState>,
) -> Result<Option<serde_json::Value>, String> {
    if content.len() > MAX_TEXT_EXPORT_BYTES {
        return Err("document export exceeds the 10 MiB limit".into());
    }
    let grants = state
        .file_grants
        .lock()
        .map_err(|_| "file grant state is unavailable".to_string())?;
    let (source, _) = resolve_granted_file(Path::new(&source_path), &grants)?;
    drop(grants);
    let selected = app
        .dialog()
        .file()
        .set_file_name(safe_suggested_file_name(&suggested_file_name))
        .blocking_save_file();
    let Some(out_path) = selected.and_then(|path| path.into_path().ok()) else {
        return Ok(None);
    };
    agent_sidecar::run_document_worker(
        &app,
        &serde_json::json!({
            "operation": "export",
            "sourcePath": source,
            "content": content,
            "outPath": out_path,
        }),
    )
    .map(Some)
}

fn mime_type_for_path(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|extension| extension.to_str())
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("png") => "image/png",
        Some("jpg" | "jpeg") => "image/jpeg",
        Some("gif") => "image/gif",
        Some("webp") => "image/webp",
        Some("bmp") => "image/bmp",
        Some("pdf") => "application/pdf",
        Some("doc") => "application/msword",
        Some("docx") => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        Some("xls") => "application/vnd.ms-excel",
        Some("xlsx") => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        Some("ppt") => "application/vnd.ms-powerpoint",
        Some("pptx") => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        Some("txt" | "log") => "text/plain",
        Some("md" | "markdown") => "text/markdown",
        Some("csv") => "text/csv",
        Some("json") => "application/json",
        Some("xml") => "application/xml",
        Some("zip") => "application/zip",
        _ => "application/octet-stream",
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalPathInspection {
    exists: bool,
    kind: &'static str,
    can_open: bool,
}

fn resolve_user_local_path(path: &Path, home: &Path) -> Option<PathBuf> {
    let home = home.canonicalize().ok()?;
    let resolved = path.canonicalize().ok()?;
    resolved.starts_with(home).then_some(resolved)
}

fn inspect_user_local_path(path: &Path, home: &Path) -> (LocalPathInspection, Option<PathBuf>) {
    let Some(resolved) = resolve_user_local_path(path, home) else {
        return (
            LocalPathInspection {
                exists: false,
                kind: "missing",
                can_open: false,
            },
            None,
        );
    };
    let kind = if resolved.is_dir() {
        "directory"
    } else if resolved.is_file() {
        "file"
    } else {
        "missing"
    };
    let exists = kind != "missing";
    let can_open = exists && (kind == "directory" || !is_executable_path(&resolved));
    (
        LocalPathInspection {
            exists,
            kind,
            can_open,
        },
        Some(resolved),
    )
}

#[tauri::command]
pub fn inspect_local_path(app: AppHandle, path: String) -> Result<LocalPathInspection, String> {
    let home = app
        .path()
        .home_dir()
        .map_err(|error| format!("failed to resolve the user directory: {error}"))?;
    Ok(inspect_user_local_path(Path::new(&path), &home).0)
}

#[derive(Debug, Serialize)]
pub struct ActivationResult {
    ok: bool,
    error: Option<String>,
}

#[tauri::command]
pub fn activate_local_path(app: AppHandle, path: String, action: String) -> ActivationResult {
    let Ok(home) = app.path().home_dir() else {
        return ActivationResult {
            ok: false,
            error: Some("无法解析用户目录。".into()),
        };
    };
    let (inspection, resolved) = inspect_user_local_path(Path::new(&path), &home);
    let Some(resolved) = resolved else {
        return ActivationResult {
            ok: false,
            error: Some("文件不存在，或不在当前用户目录内。".into()),
        };
    };
    let result = match action.as_str() {
        "reveal" => tauri_plugin_opener::reveal_item_in_dir(&resolved),
        "open" if inspection.can_open => tauri_plugin_opener::open_path(&resolved, None::<&str>),
        "open" => {
            return ActivationResult {
                ok: false,
                error: Some("为安全起见，可执行文件只能在文件夹中定位。".into()),
            }
        }
        _ => {
            return ActivationResult {
                ok: false,
                error: Some("不支持的文件操作。".into()),
            }
        }
    };
    match result {
        Ok(()) => ActivationResult {
            ok: true,
            error: None,
        },
        Err(error) => ActivationResult {
            ok: false,
            error: Some(error.to_string()),
        },
    }
}

fn safe_suggested_file_name(value: &str) -> String {
    Path::new(value)
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.trim().is_empty())
        .unwrap_or("clawmaster-export.md")
        .to_string()
}

#[tauri::command]
pub fn save_text_file(
    app: AppHandle,
    suggested_file_name: String,
    content: String,
) -> Result<Option<String>, String> {
    if content.len() > MAX_TEXT_EXPORT_BYTES {
        return Err("text export exceeds the 10 MiB limit".into());
    }
    let suggested = safe_suggested_file_name(&suggested_file_name);
    let selected = app
        .dialog()
        .file()
        .set_file_name(suggested)
        .blocking_save_file();
    let Some(path) = selected.and_then(|path| path.into_path().ok()) else {
        return Ok(None);
    };
    fs::write(&path, content).map_err(|error| format!("failed to save text export: {error}"))?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

#[tauri::command]
pub fn app_version(app: AppHandle) -> String {
    app.package_info().version.to_string()
}

#[tauri::command]
pub fn theme_get(preference: State<'_, ThemePreference>) -> Result<String, String> {
    preference
        .0
        .lock()
        .map(|theme| theme.as_str().to_string())
        .map_err(|_| "theme preference state is unavailable".into())
}

#[tauri::command]
pub fn theme_set(
    window: Window,
    preference: State<'_, ThemePreference>,
    theme: String,
) -> Result<String, String> {
    let selected = ThemeChoice::parse(&theme)?;
    window
        .set_theme(selected.tauri_theme())
        .map_err(|error| format!("failed to apply theme: {error}"))?;
    *preference
        .0
        .lock()
        .map_err(|_| "theme preference state is unavailable".to_string())? = selected;
    Ok(selected.as_str().to_string())
}

#[tauri::command]
pub fn write_clipboard(text: String) -> Result<(), String> {
    arboard::Clipboard::new()
        .and_then(|mut clipboard| clipboard.set_text(text))
        .map_err(|error| format!("failed to write clipboard: {error}"))
}

fn validate_external_url(value: &str) -> Result<Url, String> {
    let parsed = Url::parse(value).map_err(|_| "invalid external URL".to_string())?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("blocked external URL: only http and https are allowed".into());
    }
    Ok(parsed)
}

fn validate_open_path(candidate: &Path, home: &Path) -> Result<(), String> {
    if !candidate.starts_with(home) {
        return Err("blocked path: only existing paths in the user directory are allowed".into());
    }
    if is_executable_path(candidate) {
        return Err(
            "blocked path: executable files and application bundles cannot be opened".into(),
        );
    }
    Ok(())
}

fn is_executable_path(path: &Path) -> bool {
    const BLOCKED_EXTENSIONS: &[&str] = &[
        "app", "appimage", "bat", "bin", "cmd", "com", "cpl", "exe", "gadget", "hta", "inf", "ins",
        "inx", "ipa", "isu", "jar", "job", "js", "jse", "lnk", "msc", "msi", "msp", "mst", "osx",
        "paf", "pif", "ps1", "reg", "rgs", "run", "scr", "sct", "sh", "shb", "shs", "u3p", "vb",
        "vbe", "vbs", "vbscript", "workflow", "ws", "wsf", "wsh",
    ];
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .map(str::to_ascii_lowercase);
    if extension
        .as_deref()
        .is_some_and(|value| BLOCKED_EXTENSIONS.contains(&value))
    {
        return true;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if path.is_file()
            && path
                .metadata()
                .map(|metadata| metadata.permissions().mode() & 0o111 != 0)
                .unwrap_or(true)
        {
            return true;
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::{
        inspect_user_local_path, is_executable_path, mime_type_for_path, resolve_granted_file,
        safe_suggested_file_name, validate_external_url, validate_open_path, workspace_directories,
        ThemeChoice,
    };
    use std::{collections::HashSet, fs, path::Path};

    #[test]
    fn external_urls_are_limited_to_http_and_https() {
        assert!(validate_external_url("https://example.com/docs").is_ok());
        assert!(validate_external_url("http://localhost:3000").is_ok());
        assert!(validate_external_url("file:///etc/passwd").is_err());
        assert!(validate_external_url("javascript:alert(1)").is_err());
        assert!(validate_external_url("not a url").is_err());
    }

    #[test]
    fn theme_choice_is_an_explicit_allow_list() {
        assert_eq!(ThemeChoice::parse("system").unwrap().as_str(), "system");
        assert_eq!(ThemeChoice::parse("light").unwrap().as_str(), "light");
        assert_eq!(ThemeChoice::parse("dark").unwrap().as_str(), "dark");
        assert!(ThemeChoice::parse("contrast").is_err());
    }

    #[test]
    fn executable_extensions_are_blocked_case_insensitively() {
        assert!(is_executable_path(Path::new("installer.EXE")));
        assert!(is_executable_path(Path::new("script.sh")));
        assert!(is_executable_path(Path::new("ClawMaster.app")));
        assert!(!is_executable_path(Path::new("report.pdf")));
    }

    #[test]
    fn paths_outside_the_user_directory_are_blocked() {
        assert!(validate_open_path(
            Path::new("/Users/alice/report.pdf"),
            Path::new("/Users/alice")
        )
        .is_ok());
        assert!(validate_open_path(
            Path::new("/private/tmp/report.pdf"),
            Path::new("/Users/alice")
        )
        .is_err());
    }

    #[test]
    fn workspace_defaults_to_home_without_inventing_recent_grants() {
        let directories = workspace_directories(Path::new("/Users/alice"));
        assert_eq!(directories.default_path, "/Users/alice");
        assert!(directories.recent_paths.is_empty());
    }

    #[test]
    fn attachment_reads_require_an_exact_native_picker_grant() {
        let path =
            std::env::temp_dir().join(format!("clawmaster-file-grant-{}.txt", std::process::id()));
        fs::write(&path, b"hello").unwrap();
        let canonical = path.canonicalize().unwrap();
        assert!(resolve_granted_file(&path, &HashSet::new()).is_err());
        let mut grants = HashSet::new();
        grants.insert(canonical.clone());
        assert_eq!(
            resolve_granted_file(&path, &grants).unwrap(),
            (canonical, 5)
        );
        let _ = fs::remove_file(path);
    }

    #[test]
    fn local_output_inspection_stays_inside_the_user_home() {
        let home =
            std::env::temp_dir().join(format!("clawmaster-output-home-{}", std::process::id()));
        fs::create_dir_all(&home).unwrap();
        let output = home.join("report.md");
        fs::write(&output, "done").unwrap();
        let (inside, resolved) = inspect_user_local_path(&output, &home);
        assert!(inside.exists);
        assert_eq!(inside.kind, "file");
        assert!(inside.can_open);
        assert!(resolved.is_some());
        let (outside, _) = inspect_user_local_path(Path::new("/etc/hosts"), &home);
        assert!(!outside.exists);
        let _ = fs::remove_file(output);
        let _ = fs::remove_dir(home);
    }

    #[test]
    fn text_exports_drop_directory_traversal_from_suggestions() {
        assert_eq!(safe_suggested_file_name("../../report.md"), "report.md");
        assert_eq!(safe_suggested_file_name(""), "clawmaster-export.md");
    }

    #[test]
    fn attachment_mime_types_are_explicit_and_case_insensitive() {
        assert_eq!(mime_type_for_path(Path::new("photo.JPEG")), "image/jpeg");
        assert_eq!(
            mime_type_for_path(Path::new("archive.unknown")),
            "application/octet-stream"
        );
    }
}
