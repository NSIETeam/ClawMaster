/** Source-plane replay uses one DSH graph from every working directory. */
import { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import { register } from 'tsx/esm/api';

const source = register({ namespace: 'clawmaster-watchdog-schedule', tsconfig: fileURLToPath(new URL('../../../tsconfig.json', import.meta.url)) });
after(() => source.unregister());
await source.import('./watchdog-schedule-host.scenario.mjs', import.meta.url);
