# Agent Note: Render probe inputs

Status: implemented

English | [中文](2026-09-22-render-probe-inputs.zh.md)

## Problem

`csp-render-verify.yml` renders a packaged desktop app in a real browser and fails when the window is blank. It was pinned to one payload: the repository (`NSIETeam/ClawMaster-Desktop`), the run id (`35450188820`) and the artifact name were literals in its steps, and its name carried the version they built (`CSP Render Verify (0.0.1-beta.1)`).

That pinning left the blank-window check unable to answer the question it exists for. Two runs on 2026-09-20 show what it can detect: the unpatched payload reported `RENDER_STATE {"rootChildren":0,"loader":"queue","pending":1,"bodyChars":0}` with `CONSOLE_ERRORS []` and failed with `VERDICT: FAIL - blank window`; the same payload patched in two CSP lines in `packages/host/frontend-static/lib/index.js` (`script-src` gaining `'unsafe-eval'`, `style-src` becoming `'unsafe-inline'`) reported `{"rootChildren":1,"loader":"live","pending":0,"bodyChars":184}` and passed.

Those two results bound the question but do not answer it for the current line. The patched pair is the pair the installed harness `0.1.5-rc.2` already carries, while this repository's `packages/host/frontend-static/src/index.ts` narrows `script-src` (no `'unsafe-eval'`, added by `b70a42aa91`) and `style-src` (a nonce, added by `0fe355cc30`), and both commits are already ancestors of `desktop-v0.2.7`. The current source also consumes those injected nonces in several client packages, and its README states the script nonce authorizes the Cordis runner's compile without enabling `eval`. Whether a build of the current line renders is therefore untested, and no probe could be pointed at one.

## Decision

`csp-render-verify.yml` takes the render target as inputs: `repository`, `run_id` and `artifact`, with `run_id` required and defaulted to nothing so a stale payload cannot be re-rendered by accident. The steps read those inputs through `RENDER_REPOSITORY`, `RENDER_RUN_ID` and `RENDER_ARTIFACT`; the download names the repository explicitly and keeps its artifact name from the input. The probe, its verdict (`rootChildren > 0 && loader === 'live'`), its screenshot and its host log are unchanged, and the proof is still uploaded on failure.

`release-workflow.test.mjs`'s sibling `render-verify-workflow.test.mjs` pins that shape: one artifact download step that reads all three inputs and passes `--repo "$RENDER_REPOSITORY"`, an assertion shaped as the blank-window verdict with a non-zero exit, and proof uploaded under `if: always()`. Its negative fixtures are the pinned forms the change removes — the historical literal payload, a hardcoded repository, and two download steps — so the check is known to reject what it forbids.

## Alternatives considered

**Leave the probe pinned and dispatch it against the old payload only.** It would keep reporting a blank window for a payload nobody ships while saying nothing about the candidate that is about to be published.

**Add the render assertion to the release build's installed-app steps instead.** That places the check where a release cannot skip it, but it runs the browser assertion inside a build job that already takes up to 90 minutes per platform, and it cannot be dispatched against an already-built run. The parameterized probe can verify a finished candidate without rebuilding it, so it is the smaller change that answers the question first.

**Change the CSP to the patched pair in the same change.** The A/B shows that pair renders on the old payload, but `'unsafe-eval'` is a deliberate narrowing in this repository with consumers written for the nonce policy, and the evidence does not yet say which directive the old payload needed. Widening the policy on that evidence would trade a security posture for an unverified guess; the probe is what turns the guess into a measurement.

## Consequences

Verifying a candidate is now a dispatch that names its run: `gh workflow run csp-render-verify.yml -f run_id=<build run> -f artifact=<artifact>`. The workflow no longer implies a version in its name, so its result belongs to whatever run it was given.

The probe still needs a macOS runner, a packaged dmg, a first-boot `pnpm install` and Playwright, so it is a deliberate dispatch rather than a per-push gate. A render failure names the loader state and console errors and uploads the screenshot and host log, but it does not by itself identify which CSP directive or client feature caused the blank window.

## Verification

`node --test apps/desktop-tauri/scripts/render-verify-workflow.test.mjs` passes: the committed workflow satisfies the input, download, verdict and evidence rules, and each negative fixture returns its expected violation. `npm run test:update-manifest` in `apps/desktop-tauri` includes the file. The workflow's inputs were compared against the runs whose states this note cites: `35477587606` (blank) and `35478591257` (rendered with the patched payload).
