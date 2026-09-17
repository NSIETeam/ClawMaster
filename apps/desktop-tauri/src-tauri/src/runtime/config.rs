//! Mirror URLs and harness version for first-run provisioning.

/// Default Node LTS aligned with repo engines (`^22.19 || >=24`).
pub const DEFAULT_NODE_VERSION: &str = "22.19.0";

/// Trusted upstream archive digests from https://nodejs.org/dist/v22.19.0/SHASUMS256.txt.
/// Changing the runtime version also requires reviewing its published archive digests.
pub fn node_archive_sha256(archive_name: &str) -> Result<&'static str, String> {
    match archive_name {
        "node-v22.19.0-win-x64.zip" => {
            Ok("ea3fad0e67a991d8477d8c01344b56e69c676ccb733f065b22436994b1253f86")
        }
        "node-v22.19.0-win-x86.zip" => {
            Ok("708b8a297a19e9ac433e32ac0fc496755757c5e00bd5a0683917e73cae5fe8ea")
        }
        "node-v22.19.0-darwin-x64.tar.gz" => {
            Ok("3cfed4795cd97277559763c5f56e711852d2cc2420bda1cea30c8aa9ac77ce0c")
        }
        "node-v22.19.0-darwin-arm64.tar.gz" => {
            Ok("c59006db713c770d6ec63ae16cb3edc11f49ee093b5c415d667bb4f436c6526d")
        }
        "node-v22.19.0-linux-x64.tar.gz" => {
            Ok("d36e56998220085782c0ca965f9d51b7726335aed2f5fc7321c6c0ad233aa96d")
        }
        "node-v22.19.0-linux-arm64.tar.gz" => {
            Ok("d32817b937219b8f131a28546035183d79e7fd17a86e38ccb8772901a7cd9009")
        }
        _ => Err(format!(
            "No trusted SHA-256 for Node archive: {archive_name}"
        )),
    }
}

/// Lowest accepted Node 22 minor; matches workspace `engines.node`.
pub const MIN_NODE_MINOR_FOR_22: u64 = 19;

/// Major versions at or above this are accepted without a minor floor.
pub const MIN_UNRESTRICTED_NODE_MAJOR: u64 = 24;

/// pnpm version aligned with root packageManager.
pub const DEFAULT_PNPM_VERSION: &str = "11.7.0";

/// Host port range start for `dsh web`.
pub const DEFAULT_WEB_PORT: u16 = 17_890;

/// Bundled harness resource directory name inside Tauri resources.
pub const BUNDLED_HARNESS_DIR: &str = "harness-source";

/// Parent for bundle-specific writable harness trees under app data.
pub const HARNESS_VERSIONS_DIR: &str = "harness-versions";

/// China-friendly Node mirror (override with `DSH_NODE_MIRROR`).
pub fn node_mirror_base() -> String {
    std::env::var("DSH_NODE_MIRROR").unwrap_or_else(|_| "https://npmmirror.com/mirrors/node".into())
}

/// npm/pnpm registry (override with `DSH_NPM_REGISTRY`).
pub fn npm_registry() -> String {
    std::env::var("DSH_NPM_REGISTRY").unwrap_or_else(|_| "https://registry.npmmirror.com".into())
}

/// When set to `local`, use monorepo checkout instead of bundled tree.
pub fn dev_launch_mode() -> Option<String> {
    std::env::var("DSH_DESKTOP_LAUNCH").ok()
}
