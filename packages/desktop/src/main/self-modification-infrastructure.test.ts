import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  FileSelfModificationRepository,
  GitSelfModificationWorkspaceManager,
  JsonlSelfModificationAudit,
  CommandSelfModificationVerifier,
} from './self-modification-infrastructure.js';
import type { SelfModificationRequest } from './self-modification-controller.js';

const request = (): SelfModificationRequest => ({
  id: 'change-1', goal: 'safe change', tenantId: 'tenant-1', actorId: 'user-1',
  changedPaths: ['skills/report/SKILL.md'], risk: 'policy-auto', state: 'draft',
  createdAt: '2026-09-03T00:00:00.000Z', updatedAt: '2026-09-03T00:00:00.000Z',
});

describe('self-modification infrastructure', () => {
  it('persists requests atomically and refuses unsafe ids', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'clawmaster-self-change-'));
    const repository = new FileSelfModificationRepository(root);
    await repository.save(request());
    expect(await repository.load('change-1')).toMatchObject({ id: 'change-1', state: 'draft' });
    await expect(repository.load('../secret')).rejects.toThrow('safe identifier');
  });

  it('rejects corrupted persisted requests instead of trusting them', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'clawmaster-self-change-'));
    await writeFile(path.join(root, 'change-1.json'), '{"id":"different"}\n');
    const repository = new FileSelfModificationRepository(root);
    await expect(repository.load('change-1')).rejects.toThrow('identity mismatch');
  });

  it('creates a worktree from the exact baseline without a shell', async () => {
    const workspaceRoot = await mkdtemp(path.join(os.tmpdir(), 'clawmaster-worktrees-'));
    const run = vi.fn(async () => 'b'.repeat(40));
    const manager = new GitSelfModificationWorkspaceManager({
      repositoryRoot: '/repo', workspaceRoot, run,
    });
    const result = await manager.create('change-1');
    expect(result).toEqual({
      path: path.resolve(workspaceRoot, 'change-1'), branch: 'self-change/change-1', baselineCommit: 'b'.repeat(40),
    });
    expect(run).toHaveBeenNthCalledWith(1, 'git', ['-C', '/repo', 'rev-parse', 'HEAD']);
    expect(run).toHaveBeenNthCalledWith(2, 'git', [
      '-C', '/repo', 'worktree', 'add', '-b', 'self-change/change-1', path.resolve(workspaceRoot, 'change-1'), 'b'.repeat(40),
    ]);
  });

  it('writes one redacted audit record per line', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'clawmaster-self-change-'));
    const file = path.join(root, 'audit.jsonl');
    const audit = new JsonlSelfModificationAudit(file);
    await audit.emit({ requestId: 'change-1', state: 'draft', at: '2026-09-03T00:00:00.000Z', detail: 'token=secret' });
    const record = JSON.parse((await readFile(file, 'utf8')).trim());
    expect(record.detail).toBe('[REDACTED]');
  });

  it('runs every required release gate and preserves failure evidence', async () => {
    const run = vi.fn(async (name: string) => (
      name === 'typecheck' ? { ok: false, detail: 'type error' } : { ok: true, detail: 'ok' }
    ));
    const verifier = new CommandSelfModificationVerifier(run);
    const result = await verifier.verify({
      ...request(), workspace: { path: '/worktree', branch: 'self-change/change-1', baselineCommit: 'b'.repeat(40) },
    });
    expect(result.ok).toBe(false);
    expect(result.checks.map((check) => check.name)).toEqual([
      'doctor', 'diff-check', 'focused-tests', 'typecheck', 'lint', 'build', 'code-map-check',
    ]);
    expect(result.checks.find((check) => check.name === 'typecheck')).toMatchObject({ status: 'failed', detail: 'type error' });
    expect(run).toHaveBeenCalledTimes(7);
  });
});
