#!/usr/bin/env node
/**
 * @license Copyright 2026 ClawMaster SPDX-License-Identifier: Apache-2.0
 *
 * Zero-dependency package boundary checker.
 */

import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = process.cwd();
const PACKAGES_DIR = path.join(ROOT, 'packages');
const COMPONENTS_DIR = path.join(ROOT, 'components');
const EXCLUDED_DIRS = new Set(['node_modules', 'dist', 'coverage', 'release']);
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);
const IMPORT_RE = /\b(?:import|export)\s+(?:type\s+)?(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

const BASELINE = new Set();

const ALLOWED_CORE_SOURCE_IMPORTS = new Set([
  'packages/core/src/a2a/atoaProtocol.js',
]);

const KERNEL_LIFECYCLE_FILES = new Set([
  'packages/core/src/core/turn.ts',
  'packages/core/src/core/turnStateMachine.ts',
  'packages/core/src/core/toolExecutionEngine.ts',
  'packages/core/src/core/coreToolScheduler.ts',
  'packages/core/src/core/nonInteractiveToolExecutor.ts',
  'packages/core/src/core/toolSchedulerAdapter.ts',
  'packages/core/src/core/sceneManager.ts',
  'packages/core/src/core/tokenLimits.ts',
  'packages/core/src/core/clawmasterChat.ts',
  'packages/core/src/core/prompts.ts',
  'packages/core/src/core/clawmasterRequest.ts',
  'packages/core/src/core/agentResourceBudget.ts',
  'packages/core/src/core/workflowRegistry.ts',
  'packages/core/src/core/workflowRunner.ts',
  'packages/core/src/core/workflowAgentBridge.ts',
]);

function toRel(file) {
  return path.relative(ROOT, file).split(path.sep).join('/');
}

function walk(dir, files) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!EXCLUDED_DIRS.has(entry.name)) walk(full, files);
      continue;
    }
    if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name))) files.push(full);
  }
}

function packageName(rel) {
  const parts = rel.split('/');
  return parts[0] === 'packages' ? parts[1] : null;
}

function isKernelFile(rel) {
  return KERNEL_LIFECYCLE_FILES.has(rel) || rel.startsWith('packages/core/src/policy/');
}

function resolveImport(fromRel, specifier) {
  if (!specifier.startsWith('.')) return null;
  const normalized = path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), specifier));
  return normalized.startsWith('packages/') ? normalized : null;
}

export function violationFor(fromRel, specifier) {
  const fromPackage = packageName(fromRel);
  const resolved = resolveImport(fromRel, specifier);
  if (fromRel.startsWith('components/') && resolved?.match(/^packages\/[^/]+\/src\//)) {
    return 'components must consume public package exports, not package source internals';
  }
  if (isKernelFile(fromRel)) {
    if (specifier === 'react' || specifier.startsWith('react/') || specifier === 'electron') {
      return 'kernel must not import a UI/runtime shell dependency';
    }
    if (resolved?.includes('/core/customModelAdapter.') || resolved?.includes('/utils/modelDiagnostics.')) {
      return 'kernel must depend on model routing contracts, not provider-specific adapters';
    }
    if (
      resolved?.startsWith('packages/core/src/memory/') &&
      !resolved.match(/\/memory\/(?:memorySubsystem|sessionMemoryInjector)\.(?:js|ts)$/)
    ) {
      return 'kernel must depend on the memory subsystem interface, not a memory implementation';
    }
  }
  if (!fromPackage) return null;
  if (fromPackage === 'core') {
    if (resolved?.startsWith('packages/server/') || resolved?.startsWith('packages/desktop/')) {
      return 'core must not import cli/server/desktop';
    }
  }
  if (resolved && ALLOWED_CORE_SOURCE_IMPORTS.has(resolved)) {
    return null;
  }
  if (specifier.includes('/core/src/') || specifier.match(/^\.\.\/\.\.\/core\/src\//)) {
    return 'cross-package core source import must use otto-core public exports';
  }
  if (fromPackage === 'server' && resolved?.startsWith('packages/desktop/src/')) {
    return 'server must not import desktop source';
  }
  if (fromPackage === 'desktop' && resolved?.startsWith('packages/server/src/')) {
    return 'desktop must not import server source deep paths';
  }
  if (fromPackage === 'desktop' && specifier.startsWith('otto-server/')) {
    return 'desktop must import otto-server through public package exports';
  }
  return null;
}

export function validateBoundaries() {
  const files = [];
  walk(PACKAGES_DIR, files);
  walk(COMPONENTS_DIR, files);
  const violations = [];
  for (const file of files) {
    const rel = toRel(file);
    const content = readFileSync(file, 'utf8');
    for (const match of content.matchAll(IMPORT_RE)) {
      const specifier = match[1] || match[2];
      if (!specifier) continue;
      const reason = violationFor(rel, specifier);
      if (!reason) continue;
      const basePrefix = `${rel} -> ${specifier}`;
      const baseline = [...BASELINE].find((entry) => entry.startsWith(basePrefix));
      violations.push({ rel, specifier, reason, baseline });
    }
  }
  return violations;
}

function main() {
  const violations = validateBoundaries();
  console.log('ClawMaster package and component boundary validation');
  if (violations.length === 0) {
    console.log('No boundary violations found.');
    process.exit(0);
  }
  for (const violation of violations) {
    const status = violation.baseline ? 'BASELINE' : 'FAIL';
    console.log(`${status} ${violation.rel} imports ${violation.specifier}`);
    console.log(`  ${violation.reason}`);
    if (violation.baseline) console.log(`  ${violation.baseline}`);
  }
  const newViolations = violations.filter((violation) => !violation.baseline);
  if (newViolations.length > 0) {
    console.error('');
    console.error(`Boundary validation failed: ${newViolations.length} new violation(s).`);
    process.exit(1);
  }
  console.log('');
  console.log(`Boundary validation passed with ${violations.length} baselined violation(s).`);
}

const isMain = process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) main();
