import { appendFileSync } from 'node:fs';
import { openWatchdogScheduleStore } from '../../src/watchdog-schedule-store.ts';

const [path, configuration, sample, worker, effects] = process.argv.slice(2);
const store = await openWatchdogScheduleStore(path, 'local', JSON.parse(configuration));
process.on('message', message => {
  if (message !== 'claim') return;
  const instance = store.claim(worker, Number(sample));
  if (instance && store.beginDispatch(instance, Number(sample))) {
    appendFileSync(effects, `${instance.id}\n`);
    process.exit(72);
  }
  store.close();
  process.exit(0);
});
process.send('ready');
