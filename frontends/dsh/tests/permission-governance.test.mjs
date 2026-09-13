/** Resolve the governance fixture against the repository source graph. */
import { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import { register } from 'tsx/esm/api';

const source = register({
  namespace: 'clawmaster-permission-governance',
  tsconfig: fileURLToPath(new URL('../../../tsconfig.json', import.meta.url)),
});
after(() => source.unregister());
await source.import('./permission-governance.scenario.mjs', import.meta.url);
