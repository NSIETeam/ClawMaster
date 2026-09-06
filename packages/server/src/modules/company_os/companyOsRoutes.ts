/** @license Copyright 2026 ClawMaster SPDX-License-Identifier: Apache-2.0 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AccountView } from '../../enterprise/db.js';
import type { AdminPrincipal } from '../../enterprise/enterpriseRouteDispatcher.js';
import type { CanonicalEvent } from './index.js';
import {
  DurableBrandWatchdog,
  DurableCompanyOsEventBus,
  type CompanyOsEventStore,
} from './durableEventBus.js';
import { buildOperatingBrief, OPERATING_EVENT_TYPES } from './operatingBrief.js';

export interface CompanyOsRouteInput {
  path: string;
  method: string;
  req: IncomingMessage;
  res: ServerResponse;
  memberAccount: AccountView | null;
  adminPrincipal: AdminPrincipal | null;
  store: CompanyOsEventStore;
  listConnectorReadiness(organizationId: string): Promise<unknown[]>;
  readBody(req: IncomingMessage, maxLength?: number): Promise<Record<string, unknown>>;
  sendJSON(res: ServerResponse, status: number, data: unknown): void;
}

function text(body: Record<string, unknown>, key: string, optional = false): string | undefined {
  const value = body[key];
  if (optional && value === undefined) return undefined;
  if (typeof value !== 'string' || !value.trim()) throw new Error(`invalid_${key}`);
  return value.trim();
}

function adminOrganization(input: CompanyOsRouteInput): string | null {
  return input.adminPrincipal?.organizationId ?? null;
}

function readableOrganization(input: CompanyOsRouteInput): string | null {
  return input.memberAccount?.organizationId ?? adminOrganization(input);
}

export async function handleCompanyOsRoute(input: CompanyOsRouteInput): Promise<boolean> {
  if (!input.path.startsWith('/enterprise/companyos/')) return false;
  const bus = new DurableCompanyOsEventBus(input.store);
  const watchdog = new DurableBrandWatchdog(input.store, bus);
  const decisionMatch = /^\/enterprise\/companyos\/tasks\/([^/]+)\/decision$/u.exec(input.path);

  if (decisionMatch && input.method === 'POST') {
    const organizationId = adminOrganization(input);
    if (!organizationId) {
      input.sendJSON(input.res, 403, { error: 'CompanyOS 管理员权限不足' });
      return true;
    }
    try {
      const taskId = decodeURIComponent(decisionMatch[1]!);
      const body = await input.readBody(input.req);
      if (body.decision !== 'approve' && body.decision !== 'reject') {
        throw new Error('invalid_decision');
      }
      input.sendJSON(input.res, 200, {
        task: watchdog.decideTask(organizationId, taskId, body.decision),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const status = message === 'task_not_found'
        ? 404
        : message === 'task_already_decided' ? 409 : 400;
      input.sendJSON(input.res, status, { error: message });
    }
    return true;
  }

  if (input.path === '/enterprise/companyos/events' && input.method === 'POST') {
    const organizationId = adminOrganization(input);
    if (!organizationId) {
      input.sendJSON(input.res, 403, { error: 'CompanyOS 管理员权限不足' });
      return true;
    }
    try {
      const body = await input.readBody(input.req, 1_000_000);
      const idempotencyKey = text(body, 'idempotencyKey')!;
      const eventInput: CanonicalEvent = {
        id: text(body, 'id', true) ?? `${organizationId}:${idempotencyKey}`,
        organizationId,
        type: text(body, 'type')!,
        payload: body.payload ?? null,
        source: text(body, 'source')!,
        sourceRevision: text(body, 'sourceRevision')!,
        observedAt: text(body, 'observedAt')!,
        correlationId: text(body, 'correlationId')!,
        causationId: text(body, 'causationId', true),
        idempotencyKey,
      };
      const event = bus.publish(eventInput);
      input.sendJSON(input.res, 201, { event });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      input.sendJSON(input.res, message === 'idempotency_conflict' ? 409 : 400, { error: message });
    }
    return true;
  }

  if (input.path === '/enterprise/companyos/watchdog/inspect' && input.method === 'POST') {
    const organizationId = adminOrganization(input);
    if (!organizationId) {
      input.sendJSON(input.res, 403, { error: 'CompanyOS 管理员权限不足' });
      return true;
    }
    input.sendJSON(input.res, 200, { processed: watchdog.inspectOrganization(organizationId) });
    return true;
  }

  if (input.path === '/enterprise/companyos/actions' && input.method === 'GET') {
    const organizationId = readableOrganization(input);
    if (!organizationId) {
      input.sendJSON(input.res, 401, { error: 'CompanyOS 账号会话无效' });
      return true;
    }
    input.sendJSON(input.res, 200, { actions: watchdog.listActions(organizationId) });
    return true;
  }

  if (input.path === '/enterprise/companyos/brief' && input.method === 'GET') {
    const organizationId = readableOrganization(input);
    if (!organizationId) {
      input.sendJSON(input.res, 401, { error: 'CompanyOS 账号会话无效' });
      return true;
    }
    input.sendJSON(input.res, 200, {
      brief: buildOperatingBrief({
        organizationId,
        events: bus.listEvents(organizationId, OPERATING_EVENT_TYPES),
        actions: watchdog.listActions(organizationId),
        asOf: new Date(input.store.now()).toISOString(),
      }),
    });
    return true;
  }

  if (input.path === '/enterprise/companyos/connectors' && input.method === 'GET') {
    const organizationId = readableOrganization(input);
    if (!organizationId) {
      input.sendJSON(input.res, 401, { error: 'CompanyOS 账号会话无效' });
      return true;
    }
    input.sendJSON(input.res, 200, {
      connectors: await input.listConnectorReadiness(organizationId),
    });
    return true;
  }

  if (input.path === '/enterprise/companyos/tasks' && input.method === 'GET') {
    const organizationId = readableOrganization(input);
    if (!organizationId) {
      input.sendJSON(input.res, 401, { error: 'CompanyOS 账号会话无效' });
      return true;
    }
    input.sendJSON(input.res, 200, { tasks: watchdog.listTasks(organizationId) });
    return true;
  }

  if (input.path === '/enterprise/companyos/audit' && input.method === 'GET') {
    const organizationId = adminOrganization(input);
    if (!organizationId) {
      input.sendJSON(input.res, 403, { error: 'CompanyOS 管理员权限不足' });
      return true;
    }
    input.sendJSON(input.res, 200, { audit: watchdog.listAudit(organizationId) });
    return true;
  }

  input.sendJSON(input.res, 405, { error: 'CompanyOS 路由或方法不受支持' });
  return true;
}
