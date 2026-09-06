# Platform Workspace Boundary

ClawMaster opens business platforms in a Tauri child WebView. This surface is
an isolated browser workspace, not proof that the platform is authenticated or
operational.

## Security contract

- Remote endpoints must use HTTPS. Plain HTTP is accepted only for loopback
  development addresses.
- URLs containing a username or password are rejected. ClawMaster never asks
  the renderer to store a platform password.
- Platform URL and remember-login preferences are scoped by the current
  account workspace key and platform ID.
- Persistent browser storage uses a SHA-256-derived identifier for the account
  scope and platform ID. Windows WebView2 receives a dedicated data directory;
  macOS WKWebView receives a dedicated data-store identifier.
- Without remember-login, the WebView uses an incognito/non-persistent store.
  With remember-login, only that scoped platform Cookie store persists.
- Navigation remains limited to HTTPS or loopback URLs. Page load completion is
  reported as "workspace opened", never as a successful login or business
  connection.

## Ownership

- Renderer status and configuration: `packages/desktop/src/renderer/components/PlatformWorkspace.tsx`
- Tenant-scoped setting keys and approved defaults: `packages/desktop/src/renderer/moduleCatalog.ts`
- Typed Tauri bridge: `packages/desktop/src/renderer/hostBridge.ts`
- Native URL validation, storage isolation and WebView lifecycle:
  `packages/desktop/src-tauri/src/platform_webview.rs`

## Remaining release evidence

Unit tests prove deterministic scope separation and rejection of insecure
addresses. Issue #12 still requires installed Windows and macOS runs against
dedicated staging tenants for all five platforms: login restoration, a
read-only action, a separately approved write action, rejection without side
effects, and receipt traceability. Those live results must not be replaced by
fixtures or by a successful WebView load.
