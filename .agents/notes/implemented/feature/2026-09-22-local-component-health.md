# Agent Note: Serve component health to the operator's own desktop only

Status: implemented

English | [中文](2026-09-22-local-component-health.zh.md)

## Problem

The home reported the app connection, model evidence, scheduled workers and business tasks, and nothing about the Host's own components, so a plugin the Host had disabled was invisible to the person using it. The facts existed but reached only the model: `runtime_status` and the logged runtime context carry the component inventory and the disabled-plugin list, and the browser had no route to either. Adding one raised a question the codebase had already answered for every other product route — which permission gates it — and the answer was not obvious here: the ten `GovernanceAction` values cover records, audit, tasks, attachments and workspaces, and none of them describes reading the Host's own runtime.

## Decision

`frontends/dsh/src/runtime-health-host.ts` serves `GET /api/clawmaster/runtime` and refuses it unless `GovernanceAccess.mode` is `local`. A shared Host serves identities that are not the operator of that machine, so its component inventory stays out of the browser; the client renders that refusal as unobserved rather than as healthy. The route reads no file itself: `mountRuntimeHealth` takes the observation as an injected reader and `host.ts` passes `observeRuntime(process.env.CLAWMASTER_RUNTIME_STATE)`, which keeps the resolution of workspace packages out of the route's own tests.

The payload is the observation date, availability and reason, the `release`/`development` mode, the component count, and the names of plugins this Host disabled. It carries no filesystem path, digest, PID, port or credential. `frontends/dsh/src/runtime-health-client.ts` reads it once when the home loads and again on refresh, and reports every failure — refused, unreachable, malformed — as unobserved.

## Consequences

Component health is a fifth layer on the home: an unobserved or refused route is neutral, a disabled plugin names the layer in the attention line above the collapsed details, and the details row carries the count. This is what the layer can support — the Host's record of what it loaded — and not a per-component functional check, which the row's own text states.

The route is served only in local mode, so an enterprise deployment sees the layer as unobserved rather than as the server's component list. Enabling it there needs a permission action that does not exist yet, and choosing one means deciding which roles may read Host facts; that decision is unmade.

The component inventory is already model-visible through `runtime_status` and the logged runtime context, which carry no governance check. This route does not widen that disclosure to a shared Host, but it does mean the browser now reads the same record the model does, so a future change to `observeRuntime`'s disclosure affects both.
