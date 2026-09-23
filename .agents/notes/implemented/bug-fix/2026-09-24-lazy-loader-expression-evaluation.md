# Agent Note: Lazy Loader Expression Evaluation

Status: implemented

English | [中文](2026-09-24-lazy-loader-expression-evaluation.zh.md)

## Problem

The browser bundle imports the configuration loader, whose module initialization created a `Function` even when no `!!js` expression was present. The desktop webview's Content Security Policy rejects dynamic code construction, so module import stopped the client before the application rendered.

## Decision

Create the evaluator inside `evaluate()` so ordinary imports do not compile dynamic code. Preserve expression evaluation for configurations that explicitly call this API. Do not add `unsafe-eval` to the browser policy. `apps/web/tests/loader-import-csp.e2e.ts` imports the evaluator through a real Chromium page served with the production policy and asserts that the module loads without browser errors.
