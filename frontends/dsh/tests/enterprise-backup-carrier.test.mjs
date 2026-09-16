/** Real HTTP backup transfers use the production bridge and source dependency graph. */
import { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import { register } from 'tsx/esm/api';
const source = register({ namespace: 'clawmaster-backup-carrier', tsconfig: fileURLToPath(new URL('../../../tsconfig.json', import.meta.url)) });
after(() => source.unregister());
await source.import('./enterprise-backup-carrier.scenario.mjs', import.meta.url);
