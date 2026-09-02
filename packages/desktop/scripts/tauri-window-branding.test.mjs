import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const config = JSON.parse(fs.readFileSync(
  path.join(import.meta.dirname, '../src-tauri/tauri.conf.json'),
  'utf8',
));

describe('Tauri window branding', () => {
  it('keeps the product identity without painting it in the macOS title bar', () => {
    expect(config.productName).toBe('ClawMaster');
    expect(config.app.windows[0]).toMatchObject({
      title: 'ClawMaster',
      titleBarStyle: 'Overlay',
      hiddenTitle: true,
    });
  });
});
