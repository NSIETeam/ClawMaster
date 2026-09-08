# ClawMaster v0.0.2-beta.3 Release Notes

Status: release candidate pending final CI and installed-app acceptance

Supported platforms: Windows x64 and macOS ARM64

## What changed

- The desktop conversation now follows a compact Codex-like layout. Tool
  history is one expandable process record, failed attempts remain auditable,
  and the assistant answer is not rewritten or surrounded by duplicate alerts.
- The ClawMaster chef-hat mark is a single transparent, theme-adaptive vector
  across the sidebar, setup, empty conversation, and assistant response.
- Files, browser, mind map, and version surfaces stay out of the workspace until
  they are needed. Generated files open in the right-side workspace on demand.
- DOCX and PPTX can be edited by paragraph and saved as a new same-format copy.
  The original is never overwritten, unchanged package parts are preserved,
  and stale, signed, malformed, or externally modified documents fail closed.
- Model configuration and the API key are restored through encrypted native
  state and the operating-system credential store instead of requiring setup on
  every launch.
- Zhixin Pigeon's built-in entry now uses its HTTPS route, including migration
  away from a stale insecure local override.
- Clean builds of the optional RPA and workflow packages can no longer be
  skipped by stale TypeScript incremental metadata.

## Honest limitations

- XLSX and PDF are read-only in the local editor. DOCX/PPTX editing is bounded
  paragraph-level OOXML editing, not a replacement for every Microsoft Office
  layout or collaboration feature.
- This beta is not Authenticode-signed, Developer ID-signed, notarized, or
  stapled. The operating system may display an unknown-publisher warning.
- External business platforms and enterprise connectors are available only
  when their HTTPS endpoint, tenant authorization, and credentials are valid.
  An entry in the module catalog is not proof of production connectivity.
- Native computer use still requires the operating-system accessibility or UI
  automation permission and explicit approval before side effects.

## Release proof

The GitHub Release must be created from the exact commit that passes the single
consolidated CI run. Its Windows installer, macOS DMG, and `SHA256SUMS` must be
downloaded and reconciled before this candidate is announced as published.
Issue #21 remains the authoritative release gate until that evidence is added.
