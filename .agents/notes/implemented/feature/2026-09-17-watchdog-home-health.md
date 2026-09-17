# Agent Note: WatchDog home reports separate health observations

Status: implemented

English | [中文](2026-09-17-watchdog-home-health.zh.md)

## Problem

An app-service connection does not prove that a model answers, a scheduled worker is live, or a business result is complete. A single green connection indicator can hide those differences.

## Decision

WatchDog home reports app-service connection, model verification, schedule-worker observations and business-task attention counts as separate fields. A loaded Session event window containing durable `assistant/message` evidence marks a successful response as observed; this does not prove current provider availability. Schedule status uses the latest returned worker summary and displays its observation time. Business counts cover only the task page currently loaded by the client.

Each displayed value keeps its evidence source visible: the connection store, a real model request, a timestamped worker response, or the bounded task response. Errors and missing worker observations remain explicit states; no field infers health from another.

## Alternatives considered

**Use one overall connected or healthy badge.** Rejected because the app connection cannot establish model, scheduler or business status.

**Probe the model automatically when home renders.** Rejected because rendering must not send a model request or incur an unrequested cost. A user task supplies the model evidence.

## Consequences

The model field remains unverified until a loaded Session contains a durable response. Its verified label records prior success, not present availability. A worker summary can become stale after its displayed observation time, and local counts exclude task pages that have not been loaded. The view communicates those limits and directs the next action for each status.

The home-health client tests verify independent status rendering, unavailable states, bilingual copy, and loaded-page counts.
