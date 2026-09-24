# Agent Note: Lazy Loader Expression Evaluation

Status: implemented

English | [中文](2026-09-24-lazy-loader-expression-evaluation.zh.md)

## Problem

The browser bundle imports the configuration loader, whose module initialization created a `Function` even when no `!!js` expression was present. The desktop webview's Content Security Policy rejects dynamic code construction, so module import stopped the client before the application rendered.

## Decision

Create the evaluator inside `evaluate()` so ordinary imports do not compile dynamic code. Preserve expression evaluation for configurations that explicitly call this API. Do not add `unsafe-eval` to the browser policy. `apps/web/tests/loader-import-csp.e2e.ts` imports the evaluator through a real Chromium page served with the production policy and asserts that the module loads without browser errors.

## Alternatives considered

**Allow `unsafe-eval` in the browser policy:** this would permit dynamic compilation throughout the page and weaken the existing policy. **Create the evaluator on demand:** this keeps ordinary startup compatible with the policy and is the selected approach.

## Consequences

Normal browser startup no longer compiles the evaluator. Explicit expression evaluation still requires an execution context that permits dynamic code; the browser policy stays strict.
