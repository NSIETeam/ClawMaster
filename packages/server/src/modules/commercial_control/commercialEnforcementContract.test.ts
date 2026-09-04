/**
 * @license Copyright 2026 ClawMaster SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const CLAWMASTER_ENFORCEMENT_V1_SHA256 =
  'af4217872dae276edae3101f211a8b7e685cc58356263ff025a938ced53d6ec5';

describe('ClawMaster commercial enforcement protocol', () => {
  it('matches the immutable Control v1 protocol fingerprint', () => {
    const contract = readFileSync(
      fileURLToPath(
        new URL('../../../../../docs/otto-commercial-enforcement-v1.json', import.meta.url),
      ),
    );

    expect(createHash('sha256').update(contract).digest('hex')).toBe(
      CLAWMASTER_ENFORCEMENT_V1_SHA256,
    );
  });
});
