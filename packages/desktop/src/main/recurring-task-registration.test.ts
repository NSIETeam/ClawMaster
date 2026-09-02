import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

describe('desktop resident task registration', () => {
  it('registers every recurring main-process task instead of using bare intervals', () => {
    const source = readFileSync(path.resolve(__dirname, 'index.ts'), 'utf8');

    expect(source).not.toContain('setInterval(');
    for (const taskName of [
      'desktop.enterprise-skill-usage',
      'desktop.enterprise-identity-refresh',
      'desktop.enterprise-module-update',
      'desktop.tray-menu-refresh',
      'desktop.tray-contact-refresh',
    ]) {
      expect(source).toContain(`name: '${taskName}'`);
    }
    expect(source).toContain('desktopRecurringTasks.stopAll()');
  });
});
