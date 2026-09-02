import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const scriptsRoot = path.dirname(fileURLToPath(import.meta.url));

describe('source-size generated directory exclusions', () => {
  it.each(['doctor.cjs', 'source-size-report.mjs'])(
    '%s excludes local preview and generated Tauri outputs',
    (script) => {
      const source = readFileSync(path.join(scriptsRoot, script), 'utf8');
      expect(source).toContain("'dist-preview'");
      expect(source).toContain("'gen'");
    },
  );
});
