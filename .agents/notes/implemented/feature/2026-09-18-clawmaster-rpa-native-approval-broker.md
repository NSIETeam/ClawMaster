# Agent Note: Native RPA writes require the desktop broker

Status: implemented

English | [中文](2026-09-18-clawmaster-rpa-native-approval-broker.zh.md)

## Problem

A non-empty approval id supplied to the standalone RPA helper is caller-controlled data and cannot prove that a DSH approval occurred.

## Decision

The DSH Host sends read-only calls and approved writes over its inherited bidirectional stdio pipes. The Tauri Rust process rejects writes on the read channel; writes on the approval channel must pass the DSH approval service, native confirmation, tool classification, call id, canonical argument hash and approval summary checks before dispatch. Helper CLI write calls and raw input are refused. The Host sends a fresh hello when the RPA component starts, so it can recover a ready frame even if another provider consumed the startup frames first. WSL receives an explicit unsupported RPA response while retaining the separate OS credential broker.

The desktop process treats the broker as an optional component. Its absence disables native RPA writes without preventing the Host or other desktop features from starting.

The broker keeps one native RPA controller per canonical profile root for the Host process lifetime. A successful browser start therefore remains available to later calls; dropping the Host releases its controllers and terminates browsers owned by them.

## Alternatives considered

**Trusting `approvalId` in helper arguments** was rejected because callers can forge it without contacting the DSH approval service.

**Loopback HTTP, environment variables, argv tokens or temporary authorization files** were rejected because they expose authorization outside the parent-child pipe and add credentials that the helper could reuse.

**Using only the DSH approval prompt** was rejected because the Rust process would have no independent user confirmation before issuing native input.

## Consequences

Each desktop write requires two user decisions. When the desktop broker is available, state-backed reads use the same per-Host controller as writes, preventing a second process from reopening the controller's locked database. A helper fallback is permitted only when the broker reports unsupported before dispatch; transport failures do not retry the call in another process. A timed-out request sends a cancellation frame to the active native call; `rpa_wait` observes it, while an already-dispatched native action may finish and is reported as unknown. Stateless capability and definition queries do not open the state database.
