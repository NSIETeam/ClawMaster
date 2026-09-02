#!/usr/bin/env node
/** Prevent new unmanaged recurring work while the legacy inventory is migrated. */
const fs = require('node:fs');
const path = require('node:path');

const legacyMaximums = new Map(Object.entries({
  'packages/core/src/acp-client/acpAgentClient.ts': 2,
  'packages/core/src/core/proxyAuth.ts': 1,
  'packages/core/src/lsp/binaryManager.ts': 1,
  'packages/core/src/orchestration/enterpriseSync.ts': 1,
  'packages/core/src/tools/generate-document.ts': 1,
  'packages/core/src/tools/shell.ts': 1,
  'packages/desktop/src/main/server-manager.ts': 1,
  'packages/desktop/src/renderer/App.tsx': 4,
  'packages/server/src/enterprise/adminAccountsPage.ts': 1,
  'packages/server/src/enterprise/adminDashboardPage.ts': 1,
  'packages/server/src/enterprise/clusteredAttachmentMaintenance.ts': 1,
  'packages/server/src/enterprise/clusteredMlsMaintenance.ts': 1,
  'packages/server/src/enterprise/server.ts': 2,
  'packages/server/src/feishu/feishuAdapter.ts': 1,
  'packages/server/src/modules/commercial_control/privateDeploymentRuntime.ts': 1,
  'packages/server/src/modules/data_platform/keyRotationCoordinator.ts': 1,
  'packages/server/src/modules/federation_gateway/federationRuntime.ts': 1,
}));

const counts = new Map();

function scan(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    const relative = absolute.split(path.sep).join('/');
    if (entry.isDirectory()) {
      if (entry.name !== 'dist' && entry.name !== 'node_modules') scan(absolute);
      continue;
    }
    if (!/\.(?:ts|tsx)$/u.test(entry.name) || /\.test\.[^.]+$/u.test(entry.name)) continue;
    const matches = fs.readFileSync(absolute, 'utf8').match(/(?:window\.)?setInterval\(/gu);
    if (matches?.length) counts.set(relative, matches.length);
  }
}

scan('packages');
const violations = [];
for (const [file, count] of counts) {
  const maximum = legacyMaximums.get(file) ?? 0;
  if (count > maximum) violations.push(`${file}: ${count} direct timers (legacy maximum ${maximum})`);
}
for (const [file, maximum] of legacyMaximums) {
  if (!counts.has(file)) violations.push(`${file}: stale legacy timer allowance (${maximum})`);
}
if (violations.length) {
  console.error('New production setInterval usage is forbidden. Use RecurringTaskRegistry.');
  console.error(violations.join('\n'));
  process.exit(1);
}
console.log('Recurring task policy passed: no new unmanaged production intervals.');
