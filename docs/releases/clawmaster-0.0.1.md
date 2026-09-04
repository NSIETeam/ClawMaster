# ClawMaster v0.0.1 Windows Release Record

Released: 2026-09-04

## Scope and immutable evidence

This is the first formal ClawMaster Tauri desktop release. Its supported
artifact is Windows x64 only:

- tag and source commit: `v0.0.1` -> `0fccd81fca6af848293f9c923602419ee39be0c2`;
- installer: `ClawMaster_0.0.1_x64-setup.exe`;
- final installer size: 31,540,929 bytes (about 30.08 MiB);
- SHA-256: `335b7a2545f9087b1010d4874f8ebc899305ead5888d5fc9e0712d3aa6a697c6`.

The published EXE, the GitHub asset digest, and the accompanying checksum
manifest were downloaded after publishing and compared byte-for-byte. The
installer is a PE32 Windows NSIS self-extracting archive.

## Release evidence

The following completed successfully for the release commit:

- candidate CI: [run 33817825653](https://github.com/NSIETeam/ClawMaster/actions/runs/33817825653);
- candidate Windows release gate: [run 33817825793](https://github.com/NSIETeam/ClawMaster/actions/runs/33817825793);
- tagged Tauri build and GitHub Release publish: [run 33819991378](https://github.com/NSIETeam/ClawMaster/actions/runs/33819991378);
- tagged SQLCipher matrix: [run 33819991126](https://github.com/NSIETeam/ClawMaster/actions/runs/33819991126), successful on retry after a runner-side npm timeout.

The Windows gate built the installer, applied the formal artifact gate,
silently installed it on `windows-2022`, verified the installed runtime and
SQLCipher binding, then started `clawmaster-desktop.exe` using a fresh user
directory. This proves the released package ran in the CI Windows x64
environment; it does not prove compatibility with every end-user Windows or
endpoint-security configuration.

## What we learned

1. A build is not an acceptance test. Test the installed NSIS artifact, not
   only the staging directory. The installed artifact must load SQLCipher and
   remain alive through a fresh GUI startup.
2. One-shot child processes must exit deterministically. The document worker
   now flushes its JSON response and calls `process.exit(exitCode)` because
   imported dependencies can retain handles and otherwise block a synchronous
   caller forever.
3. Put timeouts and phase markers around packaged-runtime probes. A timeout is
   a useful failure signal; an unbounded Windows job only turns a small defect
   into a 45-minute ambiguous wait.
4. Windows process-launch assumptions differ from macOS. Invoke npm through
   the active Node executable and invoke JavaScript CLIs through their resolved
   entrypoint instead of relying on bare `npm` or `.bin` shell shims.
5. Verify checksum manifests with their line endings and paths in mind. The
   intermediate Windows `SHA256SUMS` file uses CRLF; a macOS `shasum -c` call
   needs normalization or an explicit digest comparison.
6. GitHub tag pushes ignore path filters, so the standalone SQLCipher workflow
   ran in addition to the Tauri workflow's reusable SQLCipher matrix. Add
   concurrency and prevent this duplicate tag execution before the next
   release.

## Current limitations and follow-up

- The installer is not Authenticode-signed. Windows SmartScreen may warn, so
  release notes must not imply a signed publisher.
- GitHub has no repository ruleset, branch protection, protected release tags,
  or protected deployment environment. Green workflow runs are a process gate,
  not a server-enforced merge or release restriction.
- Actions permit arbitrary third-party actions and do not require commit-SHA
  pinning. The repository's secret scanning and push protection are disabled.
- `npm audit --omit=dev` reported two high findings through
  `pptxgenjs@4.0.1 -> image-size@1.2.1`; the current npm suggestion is an
  unsuitable major downgrade, so this remains tracked risk rather than a
  claimed fix.
- The desktop product still contains configured domestic platform links and
  optional Aliyun SMS integration. Removing default npm mirrors did not remove
  those product integrations; do not conflate the two scopes.

## Next-release checklist

1. Confirm `main` is an ancestor of the exact release commit and the tag is
   exactly `v<package.json version>`.
2. Run `npm run doctor`, `git diff --check`, focused desktop contract tests,
   desktop lint/typecheck, then the formal GitHub candidate workflow.
3. Require the Windows job to pass installer build, formal gate, installed
   runtime/SQLCipher verification, fresh GUI startup, artifact upload, and
   checksum recording.
4. Create the tag only after the candidate run is green; wait for the tagged
   Tauri publish and SQLCipher matrix runs to finish successfully.
5. Download the final Release EXE and checksum manifest. Compare the EXE hash
   with both the manifest and the GitHub asset digest before announcing it.
6. State unsigned-install and remaining dependency risks plainly in the
   release communication.
