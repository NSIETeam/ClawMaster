# Agent Note: WatchDog home reports separate health observations

Status: implemented

English | [中文](2026-09-17-watchdog-home-health.zh.md)

## Problem

An app-service connection does not prove that a model answers, a scheduled worker is live, or a business result is complete. A single green connection indicator can hide those differences.

## Decision

WatchDog home leads with business-task outcomes. App-service connection, model-response evidence and schedule-worker observations appear in a collapsed runtime-and-service details section. Expanding it shows each observation separately. A loaded Session event window containing durable `assistant/message` evidence marks a successful response as observed; this does not prove current provider availability. Schedule status uses the latest returned worker summary and displays its observation time. Business counts cover only the task page currently loaded by the client.

Each observation keeps its evidence source visible when its section is open: the connection store, a real model request, a timestamped worker response, or the bounded task response. Business-task read failures remain visible in the primary summary; missing worker observations remain explicit in the details section. No field infers health from another.

## Alternatives considered

**Use one overall connected or healthy badge.** Rejected because the app connection cannot establish model, scheduler or business status.

**Probe the model automatically when home renders.** Rejected because rendering must not send a model request or incur an unrequested cost. A user task supplies the model evidence.

## Consequences

The model field remains unverified until a loaded Session contains a durable response. Its verified label records prior success, not present availability. A worker summary can become stale after its displayed observation time, and local counts exclude task pages that have not been loaded. The view communicates those limits and directs the next action for each status.

The home-health client tests verify that business outcomes stay visible while runtime details start collapsed and remain independently readable in both locales, including unavailable states and loaded-page counts.
