# Dawn Capability Host Boundary

## Purpose

The Dawn kernel keeps lifecycle, policy, audit, model routing, memory contracts,
MCP, Skills, scheduling, goals, sub-agents, the RPA control plane, and connector
protocols in the base application. Heavy implementations such as Office
conversion, OCR, speech, video, and complex analytics are signed capability
packs loaded only for an active invocation.

## Trust and installation

- Trusted Ed25519 public keys are compiled into the application through
  `CLAWMASTER_CAPABILITY_PUBLIC_KEYS_JSON`. Runtime environment variables cannot
  replace the trust root.
- `capability_plan_install` validates the signed manifest before payload
  download and returns source, compressed size, installed size, permissions,
  dependencies, version, and replacement information for the confirmation UI.
- `capability_install` requires an explicit approval flag and independently
  verifies signature, SHA-256, API version, platform, architecture, dependency,
  runtime version, size, WASM structure, and imported permissions.
- Installation writes and syncs both the entrypoint and manifest inside a
  staging directory before health and permission checks, then commits the
  complete directory with one atomic rename. Startup reconciles disk state
  against the encrypted registry, removes staging and unreferenced versions,
  and preserves only the active and recorded previous complete versions.
- Package roots, version directories, manifests, and entrypoints must be direct
  canonical children and may not be symlinks. An existing version is immutable;
  reusing its version number with different bytes is rejected.
- Rollback revalidates identity, compiled trust-root signature, hash, platform,
  API compatibility, WASM health, imports, and permissions before changing the
  registry. A failed rollback leaves the current version active.
- Uninstall also requires explicit approval. Registry data is encrypted by the
  native state store.

## Runtime isolation

Capability code runs in wasmi with no WASI, shell, process, environment, socket,
or ambient file-system access. Memory is capped at 8 MiB, execution at 10
million fuel units, input/output at 1 MiB, events at 1,000, and heavy workers at
one. A second main agent queues instead of evicting the active agent.

The only accepted import namespace is `clawmaster.capability.v1`. Each imported
function must have its matching manifest permission. Artifact and event bytes
cross the ABI through bounded memory. File, network, and approval requests are
denied unless the native host provides an explicitly authorized operation; a
pack can never access kernel paths or secrets directly.

Installed payloads are hashed again before every invocation. A modified file is
rejected even if it passed installation verification.

## Release evidence still required

Issue #14 must remain open until the desktop UI renders the pre-download plan,
shows loading/install-required states, and installed Windows x64 and macOS ARM64
runs demonstrate worker reclamation, RSS reduction, and no orphan process. The
pack size gates also need to run against actual first-party capability packs.
