import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { findUiI18nViolations } from '../../../scripts/verify-client-ui-i18n.ts';

test('product panels keep visible copy in typed locale owners', async () => {
  const files = ['client.tsx', 'Workbench.tsx', 'BusinessModules.tsx', 'navigation.ts', 'WatchdogTutorial.tsx'];
  const failures = (await Promise.all(files.map(async file => findUiI18nViolations(
    `frontends/dsh/src/${file}`, await readFile(new URL(`../src/${file}`, import.meta.url), 'utf8'),
  )))).flat();
  assert.deepEqual(failures, []);
  assert.ok(findUiI18nViolations('frontends/dsh/src/client.tsx', 'const view = <button>Missing translation</button>').length > 0);
});
