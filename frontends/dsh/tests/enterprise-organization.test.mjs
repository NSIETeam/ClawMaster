/** Organization admission tests share the source graph with schedule consumers. */
import { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import { register } from 'tsx/esm/api';
const source = register({ namespace: 'clawmaster-organization', tsconfig: fileURLToPath(new URL('../../../tsconfig.json', import.meta.url)) });
after(() => source.unregister());
await source.import('./enterprise-organization.scenario.mjs', import.meta.url);
