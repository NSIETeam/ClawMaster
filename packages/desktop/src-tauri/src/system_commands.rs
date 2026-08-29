use std::{
    path::{Path, PathBuf},
    sync::Mutex,
};

use serde::Serialize;
use tauri::{AppHandle, Manager, State, Theme, Window};
use tauri_plugin_clipboard_manager::ClipboardExt;
use tauri_plugin_dialog::DialogExt;
use url::Url;

#[derive(Default)]
pub struct ThemePreference(Mutex<ThemeChoice>);

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
pub fn select_files(app: AppHandle) -> Vec<String> {
    app.dialog()
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
        .map(|path| path.to_string_lossy().into_owned())
        .collect()
}

#[tauri::command]
pub fn select_folders(app: AppHandle) -> Vec<String> {
    app.dialog()
        .file()
        .blocking_pick_folders()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|folder| folder.into_path().ok())
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
pub fn get_workspace_directories(app: AppHandle) -> Result<WorkspaceDirectories, String> {
    app.path()
        .home_dir()
        .map(|home| workspace_directories(&home))
        .map_err(|error| format!("failed to resolve the user directory: {error}"))
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
pub fn write_clipboard(app: AppHandle, text: String) -> Result<(), String> {
    app.clipboard()
        .write_text(text)
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
        is_executable_path, validate_external_url, validate_open_path, workspace_directories,
        ThemeChoice,
    };
    use std::path::Path;

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
}
