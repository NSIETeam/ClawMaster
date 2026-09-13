---
description: "Local Word, Excel and PowerPoint editing through the existing DSH sidebar for ClawMaster desktop users and maintainers."
kind: "package-bundle"
---

# ClawMaster Office

English | [中文](README.zh.md)

## Summary

This desktop bundle opens `.docx`, `.xlsx` and `.pptx` files in the existing sidebar with local ONLYOFFICE editors and WebAssembly conversion. It reads and saves through the sidebar's existing Session-scoped file routes. Editing requires no model call, external document server or cloud upload. ONLYOFFICE legal notices and source links remain accessible in the viewer.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Open an Office file from the current task's file tree. Use the editor's Save control and wait for the viewer to report Saved before closing the tab, changing Sessions or quitting the application. The original filename and Office format are preserved. The desktop includes this private bundle; it is not a separately published npm installation.

If another writer changes the file after it was opened, saving reports a conflict and preserves the file on disk. Download the current draft from the viewer, or close and reopen the latest file. Network or conversion failures do not acknowledge success. Drafts remain only in the live viewer and are not recovered after an application crash.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation and contributor checks — click to expand</summary>

The [profile layer](cordis.patch.yml) registers three Better Sidebar file viewers and a static route on the existing DSH WebServer. DSH's connection service owns authentication and Host/Origin checks. The Host verifies a build-pinned manifest and every resource before registering the route; changed, extra, missing or symbolic-link resources fail startup. `runtimeRoot` may select an absolute directory containing the exact verified resources.

The iframe accepts one document from its owning viewer. The viewer hashes the opened bytes and sends a strong SHA-256 `If-Match` header when uploading an edited file. The [sidebar patch](../../apps/desktop-tauri/patches/dsh-better-sidebar@0.19.1.office-save.patch) serializes upload commits, checks the current revision after the body finishes, and returns HTTP 412 on conflict. This detects concurrent changes without promising atomic comparison against unrelated filesystem processes.

Run these commands from the repository root. Only preparation downloads the fixed upstream archive; `--archive /absolute/path/html.zip` uses an already downloaded archive with the same mandatory hash check. Ordinary build and `--check` perform no network operation. The standalone npm lock resolves registry packages; preparation and builds reject local dependency links.

```sh
npm ci --prefix frontends/office --ignore-scripts
node frontends/office/scripts/prepare-runtime.mjs
node frontends/office/scripts/build.mjs
node frontends/office/scripts/build.mjs --check
npm test --prefix frontends/office
```

Each editor frame loads a capability adapter before its SDK: WebKit versions without `requestIdleCallback` defer startup work with cancellable timers and report no idle budget. Available native scheduling remains unchanged. Preparation also guards Chromium-only memory sampling and canonicalizes the presentation theme URL; it preserves upstream legal markup. These [compatibility transformations](scripts/editor-compatibility.mjs) and their source are included in the verified runtime.

The runtime adds about 178 MiB of extracted assets before installer compression. Resource generation is deterministic and excluded from Git. [Upstream provenance](vendor/onlyoffice-web-local/SOURCE.json) pins the release archive, converter source and local changes. The [browser tests](tests/browser.test.mjs) exercise synthetic files with and without native idle scheduling in an isolated local server; they require Playwright Chromium and the patched sidebar package.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Desktop installation and composition](../../apps/desktop-tauri/README.md)
- [License and third-party sources](THIRD_PARTY_NOTICES.md)

-----

<a id="model-experience"></a>
## Model Experience

None. This bundle registers file viewers and static resources, and adds no tools, prompts or model-visible Session events.

<a id="known-limitations-and-deferred-work"></a>
## Known Limitations and Deferred Work

Input and saved files are limited to 100 MiB; the existing sidebar upload limit also applies. Only `.docx`, `.xlsx` and `.pptx` are registered. Legacy binary Office formats, macros, password-protected files, collaborative editing and exact Microsoft Office layout parity are outside this integration's acceptance. The pinned upstream UI is primarily Chinese and includes a subset of fonts; unavailable fonts use editor fallbacks. Keep an original copy when editing complex documents.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The local conversion runtime is AGPL-3.0-only. Preserve its legal notices, logo requirements and corresponding-source access when distributing the desktop; the [license](LICENSE) and [third-party notice](THIRD_PARTY_NOTICES.md) identify the source and modifications.

</details>
