# Agent Note: WatchDog frontend checks DSH against built workspace declarations

Status: implemented

English | [中文](2026-09-17-watchdog-frontend-type-resolution.zh.md)

## Problem

The standalone npm frontend compiles outside the DSH workspace project graph. Its client sources consume DSH packages injected by the runtime, so npm installation alone does not provide every workspace API type. Resolving some imports from npm packages and others from the repository also creates incompatible branded types.

## Decision

[`frontends/dsh/tsconfig.typecheck.json`](../../../../frontends/dsh/tsconfig.typecheck.json) maps each imported DSH API to the owning workspace package's built declarations. The `dsh-session/types` mapping targets the same declaration module used by DSH Session types, so Agent event augmentations merge into the Session event union. The desktop release workflow builds the DSH workspace before running this frontend typecheck.

The dedicated configuration keeps these paths out of the frontend test runner's runtime resolution. The frontend bundle continues to leave runtime DSH imports for DSH's declared injection mechanism.

## Alternatives considered

**Resolve every package from the standalone npm install.** Those versions can differ from the DSH workspace build and give branded ids separate TypeScript identities.

**Extend the DSH base TypeScript project.** Its workspace source aliases pull files outside the frontend project into a composite TypeScript program. The frontend instead checks the workspace's public built declarations.

## Consequences

The frontend typecheck validates its DSH APIs against declarations produced from the same release source. A package move or declaration-entry change requires updating this mapping. The mapping does not change package injection or bundle contents.
