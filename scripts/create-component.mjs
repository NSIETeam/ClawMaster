#!/usr/bin/env node
/**
 * @license Copyright 2026 NSIETeam SPDX-License-Identifier: Apache-2.0
 */

import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const KINDS = new Set(['tool', 'connector', 'runtime', 'agent-profile', 'theme', 'gui-shell']);
const OWNERS = new Set(['kernel', 'organization', 'vendor']);
const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{1,63}$/;

function entrypointsFor(id, kind) {
  const source = `components/${id}/src/index.ts`;
  switch (kind) {
    case 'connector': return { mcpServers: [source] };
    case 'runtime': return { runtimeBins: [source] };
    case 'theme': return { themeTokens: [`components/${id}/src/tokens.css`] };
    case 'gui-shell': return { desktopRoutes: [source] };
    default: return { tools: [source] };
  }
}

export async function createComponentScaffold(root, options) {
  const { id, kind, displayName, owner = 'organization' } = options;
  if (!ID_PATTERN.test(id ?? '')) throw new Error('id must be 2-64 lowercase characters');
  if (!KINDS.has(kind)) throw new Error(`unsupported component kind: ${kind}`);
  if (!OWNERS.has(owner)) throw new Error(`unsupported update owner: ${owner}`);
  if (!displayName?.trim()) throw new Error('displayName is required');

  const componentDir = path.join(root, 'components', id);
  try {
    await mkdir(componentDir, { recursive: false });
  } catch (error) {
    if (error?.code === 'ENOENT') {
      await mkdir(path.join(root, 'components'), { recursive: true });
      await mkdir(componentDir, { recursive: false });
    } else if (error?.code === 'EEXIST') {
      throw new Error(`component already exists: ${id}`);
    } else {
      throw error;
    }
  }
  await mkdir(path.join(componentDir, 'src'));

  const manifest = {
    manifestVersion: 1,
    id,
    displayName: displayName.trim(),
    version: '0.1.0',
    kind,
    updateOwner: owner,
    entrypoints: entrypointsFor(id, kind),
    permissions: [],
  };
  const manifestPath = path.join(componentDir, 'component.json');
  const sourcePath = path.join(componentDir, 'src', kind === 'theme' ? 'tokens.css' : 'index.ts');
  const source = kind === 'theme'
    ? `:root {\n  /* Add namespaced ${id} theme tokens here. */\n}\n`
    : `export interface ComponentContext {\n  readonly componentId: string;\n}\n\nexport function activate(context: ComponentContext): void {\n  void context;\n}\n`;

  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  await writeFile(sourcePath, source, 'utf8');
  await writeFile(
    path.join(componentDir, 'README.md'),
    `# ${displayName.trim()}\n\nGenerated ClawMaster ${kind} component. Keep package internals behind public exports and declare every permission in \`component.json\`.\n`,
    'utf8',
  );
  return { componentDir, manifestPath, sourcePath };
}

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]?.replace(/^--/, '');
    if (key) values[key] = argv[index + 1];
  }
  return values;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.id || !args.kind || !args.name) {
    console.error('Usage: npm run component:new -- --id acme.weather --kind connector --name "ACME Weather"');
    process.exitCode = 1;
    return;
  }
  const result = await createComponentScaffold(process.cwd(), {
    id: args.id,
    kind: args.kind,
    displayName: args.name,
    owner: args.owner,
  });
  console.log(`Created ${path.relative(process.cwd(), result.componentDir)}`);
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) await main();
