# Agent Note: Make every product promise resolve to code and evidence

Status: implemented

English | [中文](2026-09-22-capability-ledger.zh.md)

## Problem

Product promises lived in prose across READMEs, and nothing connected a promise to the code that ships it or to the test that holds it. Two failures followed. A capability whose tests were deleted, renamed, or never written kept reading as supported. A capability that was never verified looked identical to one that was, because the absence of evidence left no trace anywhere a reviewer would look.

## Decision

`apps/desktop-tauri/capability-ledger.json` records each promised capability as one entry: the promise, the README or module contract that states it (`source`), the code that ships it (`code`), the evidence that holds it (`evidence`), the platforms the promise is asserted for (`platforms`), and its `status`.

`apps/desktop-tauri/scripts/capability-ledger.mjs` checks the ledger against the checkout. A missing, absolute, or empty `source`, `code`, or `evidence` path fails. An entry with no `code` fails. A duplicate id fails, because a promise that cannot be read unambiguously cannot be audited. A platform outside `KNOWN_PLATFORMS` fails, so an unmeasured platform cannot be claimed by accident. A `verified` entry with no evidence fails: advertising a capability requires evidence. An `unevidenced` entry with no `reason` fails: recording a gap is allowed, staying silent about it is not.

The ledger is the statement of what is asserted; the checker is what makes the assertion cost something. Adding a promise therefore means adding its code path, its evidence path, or an explicit reason it has none.

## Consequences

The checker verifies that evidence exists, not that it passes, and not that it covers the promise. A path to a test that no longer exercises the capability still satisfies it, so the ledger must be revised when evidence is repurposed rather than deleted. That limit is deliberate: deciding whether a test still covers a promise is a review judgement, and a mechanical gate that guessed would be worse than one that says what it checks.

Platform claims are assertions about testing, not measurements. An entry lists a platform once capability has been exercised there; today every entry except the shell configuration names `macos-arm64` alone, and the ledger is the place that shows which platforms remain unexercised rather than implying parity. Entries currently reference `shell-permission-posture.test.mjs`, so the ledger rides on the branch that adds it.
