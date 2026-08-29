/**
 * @license Copyright 2026 NSIETeam SPDX-License-Identifier: Apache-2.0
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createComponentScaffold } from '../create-component.mjs';

const created = [];

afterEach(async () => {
  await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('component scaffold', () => {
  it('creates an isolated TypeScript component with a valid manifest', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'clawmaster-component-'));
    created.push(root);

    const result = await createComponentScaffold(root, {
      id: 'acme.weather',
      kind: 'connector',
      displayName: 'ACME Weather',
    });

    const manifest = JSON.parse(await readFile(result.manifestPath, 'utf8'));
    expect(manifest.id).toBe('acme.weather');
    expect(manifest.entrypoints.mcpServers).toEqual([
      'components/acme.weather/src/index.ts',
    ]);
    expect(await readFile(result.sourcePath, 'utf8')).toContain('activate');
  });

  it('refuses to overwrite an existing component', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'clawmaster-component-'));
    created.push(root);
    const options = { id: 'acme.safe', kind: 'tool', displayName: 'Safe' };

    await createComponentScaffold(root, options);
    await expect(createComponentScaffold(root, options)).rejects.toThrow('already exists');
  });
});
