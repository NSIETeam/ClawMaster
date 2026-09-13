/** Keep the Loader fixture on the workspace source graph from every test working directory. */
import { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import { register } from 'tsx/esm/api';

const source = register({
  namespace: 'clawmaster-business-tool-flow',
  tsconfig: fileURLToPath(new URL('../../../tsconfig.json', import.meta.url)),
});
after(() => source.unregister());
await source.import('./business-tool-flow.scenario.mjs', import.meta.url);
