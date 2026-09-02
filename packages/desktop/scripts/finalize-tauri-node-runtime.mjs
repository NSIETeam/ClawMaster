#!/usr/bin/env node

import path from 'node:path';
import { writeNodeRuntimeAsset } from './tauri-node-runtime-contract.mjs';

function argument(name) {
  const index = process.argv.indexOf(name);
  if (index === -1 || !process.argv[index + 1]) throw new Error(`missing ${name}`);
  return process.argv[index + 1];
}

const binary = path.resolve(argument('--binary'));
const outputDirectory = path.resolve(argument('--output-directory'));
const target = argument('--target');
const { manifest, outputBinary } = writeNodeRuntimeAsset({
  binary,
  outputDirectory,
  target,
});
console.log(
  `[tauri-node] finalized ${target} Node ${manifest.source.version} `
  + `${(manifest.binary.bytes / 1024 / 1024).toFixed(1)} MiB at ${outputBinary}`,
);
