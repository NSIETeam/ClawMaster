use serde_json::Value;

fn unsupported(command: &str) -> Result<Value, String> {
    Err(format!(
        "unsupported: Tauri command `{command}` is not implemented yet"
    ))
}

#[tauri::command]
fn desktop_connect() -> Result<Value, String> {
    unsupported("desktop_connect")
}

#[tauri::command]
fn desktop_disconnect() -> Result<Value, String> {
    unsupported("desktop_disconnect")
}

#[tauri::command]
fn desktop_send(_frame: Value) -> Result<Value, String> {
    unsupported("desktop_send")
}

#[tauri::command]
fn desktop_is_connected() -> Result<Value, String> {
    unsupported("desktop_is_connected")
}

#[tauri::command]
fn open_external(_url: String) -> Result<Value, String> {
    unsupported("open_external")
}

#[tauri::command]
fn open_path(_path: String) -> Result<Value, String> {
    unsupported("open_path")
}

#[tauri::command]
fn select_files() -> Result<Value, String> {
    unsupported("select_files")
}

#[tauri::command]
fn select_folders() -> Result<Value, String> {
    unsupported("select_folders")
}

#[tauri::command]
fn theme_get() -> Result<Value, String> {
    unsupported("theme_get")
}

#[tauri::command]
fn theme_set(_theme: String) -> Result<Value, String> {
    unsupported("theme_set")
}

#[tauri::command]
fn write_clipboard(_text: String) -> Result<Value, String> {
    unsupported("write_clipboard")
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            desktop_connect,
            desktop_disconnect,
            desktop_send,
            desktop_is_connected,
            open_external,
            open_path,
            select_files,
            select_folders,
            theme_get,
            theme_set,
            write_clipboard,
        ])
        .run(tauri::generate_context!())
        .expect("failed to run ClawMaster desktop shell");
}
