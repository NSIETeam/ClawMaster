#!/usr/bin/env node
/** @license Copyright 2026 ClawMaster SPDX-License-Identifier: Apache-2.0 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = await readFile(path.join(root, 'src-tauri/src/native_runtime.rs'), 'utf8');
for (const required of ['list_sessions', 'create_session', 'send_user_message', 'get_history', 'get_models']) {
  if (!source.includes(`"${required}"`)) throw new Error(`native runtime missing ${required}`);
}
if (source.includes('node.br') || source.includes('sqlcipher')) {
  throw new Error('native-local runtime must not depend on downloaded Node or SQLCipher capsules');
}
console.log('[tauri-runtime] in-process native-local session protocol smoke passed');
