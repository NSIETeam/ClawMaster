# Agent Note: Make every product promise resolve to code and evidence

Status: implemented

English | [中文](2026-09-22-capability-ledger.zh.md)

## Problem

Product promises lived in prose across READMEs, and nothing connected a promise to the code that ships it or to the test that holds it. Two failures followed. A capability whose tests were deleted, renamed, or never written kept reading as supported. A capability that was never verified looked identical to one that was, because the absence of evidence left no trace anywhere a reviewer would look.

## Decision

`apps/desktop-tauri/capability-ledger.json` records each promised capability as one entry: the promise, the README or module contract that states it (`source`), the code that ships it (`code`), the evidence that holds it (`evidence`), the platforms the promise is asserted for (`platforms`), and its `status`.

`requires` names what the evidence needs beyond the checkout — an environment variable, an installed browser, a signing identity — so a grader who cannot reproduce a run learns what was missing instead of reading the entry as broken.

`apps/desktop-tauri/scripts/capability-ledger.mjs` checks the ledger against the checkout. A missing, absolute, or empty `source`, `code`, or `evidence` path fails. An entry with no `code` fails. A duplicate id fails, because a promise that cannot be read unambiguously cannot be audited. A platform outside `KNOWN_PLATFORMS` fails, so an unmeasured platform cannot be claimed by accident. A `requires` that is not a list of non-empty strings fails, so the prerequisites read as a list of things rather than a sentence. A `verified` entry with no evidence fails: advertising a capability requires evidence. An `unevidenced` entry with no `reason` fails: recording a gap is allowed, staying silent about it is not.

The ledger is the statement of what is asserted; the checker is what makes the assertion cost something. Adding a promise therefore means adding its code path, its evidence path, or an explicit reason it has none.

## Consequences

The checker verifies that evidence exists, not that it passes, and not that it covers the promise. A path to a test that no longer exercises the capability still satisfies it, so the ledger must be revised when evidence is repurposed rather than deleted. That limit is deliberate: deciding whether a test still covers a promise is a review judgement, and a mechanical gate that guessed would be worse than one that says what it checks.

Platform claims are assertions about testing, not measurements. The ledger separates what was exercised from what a policy covers: an entry lists a platform once the capability has been exercised there, so most entries name `macos-arm64` alone, while the shell configuration, the signature policy the acceptance matrix enforces, and the step that adds release evidence name all three desktop platforms because those claims are about shipped configuration and policy rather than a run on each platform. The ledger is where an unexercised platform stays visible instead of being implied.

`requires` names prerequisites the checker can read but cannot install or verify. An entry whose evidence needs a patched package and an installed browser is reproducible only once both are present, so a run that fails for want of either is a missing prerequisite rather than a failed capability. That distinction lives in the entry, next to the evidence path, because the checker cannot draw it.
