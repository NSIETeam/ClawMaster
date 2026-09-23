# Agent Note: Beta acceptance may omit live IM credentials

Status: implemented

English | [中文](2026-09-23-beta-live-im-optional.zh.md)

## Problem

Beta release acceptance requires real-model and desktop lifecycle evidence, but reading WeChat, Feishu, DingTalk, QQ, or WeCom is unsafe without an authorized test account.

## Decision

Beta manifests may mark selected-chat WeChat reading and the five IM UI integrations `not-run` with a reason that live connector credentials were intentionally omitted. Model, Office, Native RPA, lifecycle, upgrade, network recovery, approval, rollback, and write-safety checks remain mandatory.

## Consequences

This changes beta acceptance policy only; stable releases still require complete IM blocked or connected evidence. The policy grants no connector account authorization.

## Verification

`release-acceptance.test.mjs` covers the beta omission and the requirement for complete integrations on stable releases.
