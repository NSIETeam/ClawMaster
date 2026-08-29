/**
 * @license Copyright 2026 NSIETeam SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { violationFor } from '../validate-boundaries.mjs';

describe('architecture boundary rules', () => {
  it('keeps UI frameworks and Electron out of the runtime kernel', () => {
    expect(violationFor('packages/core/src/core/turn.ts', 'react')).toContain(
      'UI/runtime shell',
    );
    expect(violationFor('packages/core/src/core/turn.ts', 'electron')).toContain(
      'UI/runtime shell',
    );
  });

  it('allows the memory interface but rejects memory implementations', () => {
    expect(
      violationFor(
        'packages/core/src/core/turn.ts',
        '../memory/memorySubsystem.js',
      ),
    ).toBeNull();
    expect(
      violationFor(
        'packages/core/src/core/turn.ts',
        '../memory/localKnowledgeStore.js',
      ),
    ).toContain('memory implementation');
  });

  it('prevents external components from importing package internals', () => {
    expect(
      violationFor(
        'components/acme.connector/src/index.ts',
        '../../../packages/core/src/core/turn.js',
      ),
    ).toContain('public package exports');
  });
});
