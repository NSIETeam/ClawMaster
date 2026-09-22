# Agent Note: Keep a failed panel visible instead of blank

Status: implemented

English | [中文](2026-09-22-panel-render-boundary.zh.md)

## Problem

Nothing in the product frontend caught a render error. A component that threw while rendering removed itself and everything above it from the tree, so the affected region rendered as nothing: a blank main panel, a blank sidebar component, or — when the throw happened in the shell's own subtree — a blank window. The failure that produced this product's blank-screen incidents was in the Host rather than in React, but the frontend had no second line of defence, and its own panels are large enough that any new rendering fault becomes a blank surface with no message.

## Decision

`frontends/dsh/src/RenderBoundary.tsx` is an error boundary that replaces the subtree it wraps with a visible alert naming the panel and the error message, plus a Retry that clears the recorded failure so the children render again. `client.tsx` wraps every surface it registers in the shell: the main panel, the onboarding settings panel, the settings section, each sidebar module, each module's settings panel, and the CRM and ERP tabs. The wrapper is one local helper, so a new registration cannot silently skip it without removing the call.

The fallback copy lives in the locale dictionary beside the other product strings, so it follows the same language rules as the surfaces it replaces. The boundary reports the caught error and its component stack on the browser console, because the visible message is for the person using the panel and the console is where diagnosis starts.

## Consequences

A rendering fault in one panel no longer empties the window, and it no longer hides which panel failed. The boundary catches render-phase throws only: an error thrown in an event handler, a promise rejection, or a failure inside the shell's own code above the boundaries still propagates, and this note does not claim otherwise.

Retry re-renders the same children against the same state. When the cause is a persistent data shape rather than a transient one, the boundary falls back to the alert again instead of looping, but a panel whose data is permanently malformed stays on the alert until that data changes; there is no automatic recovery beyond the retry.

`frontends/dsh/tests/render-boundary.client.spec.mjs` holds four cases: the alert names the failure, a sibling outside the failing boundary still renders, retry recovers once the cause is gone, and children render untouched when nothing throws. The spec is registered in `tests/vitest.navigation.config.ts`, because a client spec absent from that include list runs nowhere.
