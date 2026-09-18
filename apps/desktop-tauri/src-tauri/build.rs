use std::{env, fs, path::PathBuf};

fn main() {
    verify_desktop_version();
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "set_close_action",
            "dismiss_close_prompt",
            "restart_app",
        ]),
    ))
    .expect("failed to build desktop permission manifest")
}

fn verify_desktop_version() {
    let manifest_dir = PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").expect("Cargo sets CARGO_MANIFEST_DIR"));
    let desktop_dir = manifest_dir.parent().expect("src-tauri has desktop project parent");
    println!("cargo:rerun-if-changed={}", desktop_dir.join("version.json").display());
    println!("cargo:rerun-if-changed={}", desktop_dir.join("package.json").display());
    println!("cargo:rerun-if-changed={}", manifest_dir.join("tauri.conf.json").display());
    let canonical: serde_json::Value = serde_json::from_slice(
        &fs::read(desktop_dir.join("version.json")).expect("desktop version source is readable"),
    )
    .expect("desktop version source is valid JSON");
    let package: serde_json::Value = serde_json::from_slice(
        &fs::read(desktop_dir.join("package.json")).expect("desktop package manifest is readable"),
    )
    .expect("desktop package manifest is valid JSON");
    let tauri: serde_json::Value = serde_json::from_slice(
        &fs::read(manifest_dir.join("tauri.conf.json")).expect("Tauri config is readable"),
    )
    .expect("Tauri config is valid JSON");
    let source_version = canonical["desktop"].as_str().expect("version.json contains desktop string");
    let package_version = package["version"].as_str().expect("desktop package.json contains version string");
    let tauri_version = tauri["version"].as_str().expect("Tauri config contains version string");
    let cargo_version = env!("CARGO_PKG_VERSION");
    assert_eq!(package_version, source_version, "desktop package version differs from version.json; run npm run version:sync");
    assert_eq!(cargo_version, source_version, "Cargo package version differs from version.json; run npm run version:sync");
    assert_eq!(tauri_version, source_version, "Tauri version differs from version.json; run npm run version:sync");
}
