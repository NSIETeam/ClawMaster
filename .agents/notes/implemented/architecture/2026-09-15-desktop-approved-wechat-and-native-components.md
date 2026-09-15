# Agent Note: Approved WeChat reads and native desktop components

Status: implemented

English | [中文](2026-09-15-desktop-approved-wechat-and-native-components.zh.md)

## Problem

A JavaScript plugin can load successfully while its native executable is absent from the installed desktop. That distinction matters for WeChat reading: the tool needs a working platform provider and approval for the specific conversation before it inspects message content. Desktop upgrades also need to coexist with an updater already mounted by the portable access kit.

## Decision

The [RPA component](../../../../frontends/rpa/README.md) owns `wechat_read` as a DSH tool. Every invocation requires an agent session and an `allowed-once` approval bound to the exact selected conversation and message limit. The tool starts no native process before approval, rejects cancellation and changed arguments, and validates the returned scope. Approval explains that returned messages enter the session record and the configured model. Conversation text is marked as untrusted data.

The macOS provider verifies the WeChat application identity, selected conversation title and visible message area. It selects visible message references within the approved limit before reading their text and rejects ambiguous or unsupported interfaces. It does not select another chat, scroll, capture screenshots, read databases, listen continuously or send messages. Windows and Linux return an explicit unsupported result. System Accessibility permission and per-call DSH approval serve different purposes; neither substitutes for the other. Direct local operating-system access remains outside this tool's approval enforcement.

The [desktop packaging scripts](../../../../apps/desktop-tauri/README.md) compile the RPA executable for each release target and include it inside the component's platform directory. Packaging verifies the binary format, architecture, size, digest and non-interactive capabilities command. Installed-runtime checks resolve the distributed executable and discover the tool through the production Host. Source-only tests explicitly skip absent native executables; release acceptance requires the executable and cannot treat a skip as native evidence.

Desktop assembly adds a desktop-owned bundle patch and its manifest declaration to the packaged updater, while preserving the published component archive and source manifest. The runtime lists `@clawmaster/dsh-updates` directly, allowing the existing access kit to detect an installed updater and refuse duplicate bootstrap. These packaging additions are covered by the desktop bundle's provenance. Profile preparation reads DSH patch data through its owning parser and omits the desktop insertion layer when an existing layer owns the updater row. User patch bytes, component configuration and disabled choices remain unchanged. The component's [installation and activation decision](2026-09-15-installed-dsh-component-updates.md) continues to own signed downloads, one-shot preparation and staged self-updates; bundling the component does not redefine those operations.

## Alternatives considered

**Use an unrestricted personal-account automation package.** A package that also navigates, sends or changes contacts grants more access than a bounded reading request needs. The provider performs only the selected visible read.

**Read a desktop snapshot and filter its output.** Filtering after collection can expose sidebar previews, drafts or unapproved message bodies to the reader. Selecting element references before text retrieval keeps collection within the approved operation.

**Treat successful JavaScript loading as native acceptance.** A missing or wrong-platform executable can remain invisible until the user's first tool call. Target-specific packaging and checks against the distributed runtime cover that failure.

**Always insert the desktop updater row.** Cordis insertion does not deduplicate an existing row with the same identifier. Detecting the existing contribution preserves the user's updater and prevents duplicate command registration.

## Consequences

WeChat interface changes can make reads unavailable even when the executable and approval work. Unsupported layouts fail without widening the scope. Synthetic accessibility fixtures establish selection behavior. The ACP [approved](../../../../snapshots/acp/wechat-read-approved/snapshot.yml) and [rejected](../../../../snapshots/acp/wechat-read-rejected/snapshot.yml) recorded-session scenarios verify one-shot decisions, persisted tool output and helper invocation through the shipped profile, using only synthetic messages. A real authorized client read remains separate acceptance evidence and does not establish full-history support.

Native RPA artifacts are platform-specific. They are distributed inside their matching desktop installers rather than advertised as one universal component archive. An installer upgrade retains DSH credentials, settings and conversations, while replacing product binaries through the native update flow.

Updater 0.1.1 validates original tar header paths as well as platform-normalized entry paths. Windows directory-rename collisions can reuse a cached payload only after checking the real directory, regular file, length and digest; unrelated permission failures remain errors. Published 0.1.0 files remain immutable, and existing user-mounted updater versions are preserved. Linux native state uses the system Secret Service for encryption keys shared by separate helper invocations; an unavailable service cannot fall back to transient credentials or plaintext. Linux release tests run against an owned Secret Service on a private D-Bus session with disposable key storage.
