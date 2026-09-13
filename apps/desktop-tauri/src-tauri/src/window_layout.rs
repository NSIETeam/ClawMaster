//! Window-control layout metadata for the in-window title bar.
//!
//! The main window uses the platform's native decorations, so no in-window
//! title bar is drawn and `titlebar_height` is zero. macOS additionally merges
//! its native title bar into the window content ([`desktop_overlay`]), so the
//! title text never appears and the system window controls float over the
//! product UI instead of occupying a row of their own. The button-layout
//! parsing remains for the `__DSH_CHROME__` bootstrap payload and its tests.
//!
//! Windows keeps minimize/maximize/close on the right. macOS keeps close/
//! minimize/maximize on the left. Linux reads the window-manager button
//! layout when available, including split left/right placements.

use serde::Serialize;

/// One title-bar control the shell HTML may render.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum WindowButton {
    Minimize,
    Maximize,
    Close,
}

/// Buttons assigned to each side of the title bar.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct ControlsLayout {
    pub left: Vec<WindowButton>,
    pub right: Vec<WindowButton>,
    pub os: &'static str,
    pub titlebar_height: u32,
}

/// Window chrome the product Web UI has to lay itself out around.
///
/// The desktop window keeps the platform's native decorations; on macOS the
/// title bar is then drawn as an overlay over the window content, so the
/// content starts at the window top and the system controls sit on top of its
/// top-left corner. `controls_inset` is the vertical space those floating
/// controls occupy, which the column under them has to keep clear.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
pub struct DesktopOverlay {
    pub os: &'static str,
    /// `overlay` when the title bar is drawn over the content instead of above it.
    pub titlebar_style: &'static str,
    /// Vertical space the floating window controls occupy at the top-left.
    pub controls_inset: u32,
}

/// Resolve the overlay chrome for this host.
///
/// Returns `None` on platforms that reserve their own title bar row outside
/// the window content, where the Web UI owes the system controls no space.
pub fn desktop_overlay() -> Option<DesktopOverlay> {
    if cfg!(target_os = "macos") {
        Some(DesktopOverlay {
            os: current_os(),
            titlebar_style: "overlay",
            controls_inset: 28,
        })
    } else {
        None
    }
}

/// Resolve the live title-bar layout for this host.
///
/// `DSH_DESKTOP_BUTTON_LAYOUT` overrides the platform default using the
/// GNOME `left:right` token list (`close,minimize,maximize:` / `:minimize,maximize,close`).
pub fn resolve_controls_layout() -> ControlsLayout {
    let parsed = if let Ok(raw) = std::env::var("DSH_DESKTOP_BUTTON_LAYOUT") {
        parse_button_layout(&raw)
    } else {
        platform_button_layout()
    };
    ControlsLayout {
        left: parsed.0,
        right: parsed.1,
        os: current_os(),
        titlebar_height: titlebar_height(),
    }
}

fn current_os() -> &'static str {
    match std::env::consts::OS {
        "macos" => "macos",
        "windows" => "windows",
        "linux" => "linux",
        other => other,
    }
}

fn titlebar_height() -> u32 {
    0
}

fn platform_button_layout() -> (Vec<WindowButton>, Vec<WindowButton>) {
    #[cfg(target_os = "macos")]
    {
        return parse_button_layout("close,minimize,maximize:");
    }
    #[cfg(target_os = "windows")]
    {
        return parse_button_layout(":minimize,maximize,close");
    }
    #[cfg(target_os = "linux")]
    {
        return linux_button_layout();
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
    {
        parse_button_layout(":minimize,maximize,close")
    }
}

#[cfg(target_os = "linux")]
fn linux_button_layout() -> (Vec<WindowButton>, Vec<WindowButton>) {
    if let Some(raw) = gnome_button_layout() {
        return parse_button_layout(&raw);
    }
    if let Some(raw) = xfce_button_layout() {
        return parse_button_layout(&raw);
    }
    parse_button_layout(":minimize,maximize,close")
}

#[cfg(target_os = "linux")]
fn gnome_button_layout() -> Option<String> {
    let output = std::process::Command::new("gsettings")
        .args(["get", "org.gnome.desktop.wm.preferences", "button-layout"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let raw = String::from_utf8_lossy(&output.stdout);
    Some(raw.trim().trim_matches('\'').trim_matches('"').to_string())
}

#[cfg(target_os = "linux")]
fn xfce_button_layout() -> Option<String> {
    let output = std::process::Command::new("xfconf-query")
        .args(["-c", "xfwm4", "-p", "/general/button_layout"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let raw = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if raw.is_empty() {
        return None;
    }
    Some(normalize_xfce_layout(&raw))
}

/// Map XFCE `O|HMC` tokens onto the GNOME `left:right` list.
#[cfg(target_os = "linux")]
fn normalize_xfce_layout(raw: &str) -> String {
    let mut left = Vec::new();
    let mut right = Vec::new();
    let mut side = &mut left;
    for ch in raw.chars() {
        match ch {
            '|' => side = &mut right,
            'H' => side.push("minimize"),
            'M' => side.push("maximize"),
            'C' => side.push("close"),
            _ => {}
        }
    }
    format!("{}:{}", left.join(","), right.join(","))
}

/// Parse a GNOME-style `left:right` button-layout string.
pub fn parse_button_layout(raw: &str) -> (Vec<WindowButton>, Vec<WindowButton>) {
    let trimmed = raw.trim().trim_matches('\'').trim_matches('"');
    let (left_raw, right_raw) = match trimmed.split_once(':') {
        Some(parts) => parts,
        None => ("", trimmed),
    };
    (parse_side(left_raw), parse_side(right_raw))
}

fn parse_side(raw: &str) -> Vec<WindowButton> {
    raw.split(',')
        .filter_map(|token| match token.trim().to_ascii_lowercase().as_str() {
            "minimize" | "min" => Some(WindowButton::Minimize),
            "maximize" | "max" => Some(WindowButton::Maximize),
            "close" => Some(WindowButton::Close),
            _ => None,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::{desktop_overlay, parse_button_layout, WindowButton};

    #[test]
    fn macos_title_bar_merges_into_the_content() {
        let overlay = desktop_overlay();
        if cfg!(target_os = "macos") {
            let overlay = overlay.expect("macOS floats its window controls over the content");
            assert_eq!(overlay.titlebar_style, "overlay");
            assert_eq!(overlay.controls_inset, 28);
            assert_eq!(overlay.os, "macos");
        } else {
            assert_eq!(overlay, None);
        }
    }

    #[test]
    fn windows_default_keeps_controls_on_the_right() {
        assert_eq!(
            parse_button_layout(":minimize,maximize,close"),
            (
                vec![],
                vec![
                    WindowButton::Minimize,
                    WindowButton::Maximize,
                    WindowButton::Close
                ]
            )
        );
    }

    #[test]
    fn macos_default_keeps_traffic_lights_on_the_left() {
        assert_eq!(
            parse_button_layout("close,minimize,maximize:"),
            (
                vec![
                    WindowButton::Close,
                    WindowButton::Minimize,
                    WindowButton::Maximize
                ],
                vec![]
            )
        );
    }

    #[test]
    fn linux_may_split_close_left_and_maximize_right() {
        assert_eq!(
            parse_button_layout("close:maximize"),
            (vec![WindowButton::Close], vec![WindowButton::Maximize])
        );
    }

    #[test]
    fn ignores_app_menu_and_unknown_tokens() {
        assert_eq!(
            parse_button_layout("appmenu:minimize,maximize,close"),
            (
                vec![],
                vec![
                    WindowButton::Minimize,
                    WindowButton::Maximize,
                    WindowButton::Close
                ]
            )
        );
    }
}
