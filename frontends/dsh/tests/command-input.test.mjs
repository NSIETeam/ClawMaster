/** Command admission shares the source graph with schedule consumers and the real HTTP bridge. */
import { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import { register } from 'tsx/esm/api';
const source = register({ namespace: 'clawmaster-command-input', tsconfig: fileURLToPath(new URL('../../../tsconfig.json', import.meta.url)) });
after(() => source.unregister());
await source.import('./command-input.scenario.mjs', import.meta.url);
