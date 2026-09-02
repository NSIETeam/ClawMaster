#!/usr/bin/env node

import path from 'node:path';
import { verifyNodeRuntimeAsset } from './tauri-node-runtime-contract.mjs';

function argument(name) {
  const index = process.argv.indexOf(name);
  if (index === -1 || !process.argv[index + 1]) throw new Error(`missing ${name}`);
  return process.argv[index + 1];
}

const result = verifyNodeRuntimeAsset({
  directory: path.resolve(argument('--asset-directory')),
  target: argument('--target'),
  nodeVersion: argument('--node-version'),
});
console.log(
  `[tauri-node] verified ${result.manifest.target} Node ${result.probe.nodeVersion} `
  + `ABI ${result.probe.moduleAbi}`,
);
