/** Reproduce the pinned Better Sidebar source/artifact adapter changes after its base patch. */
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { transform } from 'esbuild';

const option = process.argv.indexOf('--package');
if (option < 0 || !process.argv[option + 1]) throw new Error('Pass --package with the 0.19.1 package after the recorded base patch.');
const root = resolve(process.argv[option + 1]);
const spec = JSON.parse(await readFile(new URL('./sidebar-editor-transforms.json', import.meta.url)));
const files = new Map();
async function load(path) {
  if (!files.has(path)) files.set(path, await readFile(join(root, path), 'utf8'));
  return files.get(path);
}
async function replace(path, before, after) {
  const source = await load(path);
  if (source.split(before).length !== 2) throw new Error(`Sidebar adapter input differs: ${path}`);
  files.set(path, source.replace(before, after));
}
for (const [path, hash] of Object.entries(spec.hashes)) {
  if (createHash('sha256').update(await load(path)).digest('hex') !== hash) throw new Error(`Sidebar base patch differs: ${path}`);
}
for (const [path, before, after] of spec.ops) await replace(path, before, after);
const compile = async (source, loader) => (await transform(source, { loader, target: 'es2022', jsxFactory: 'react.createElement', jsxFragment: 'react.Fragment' })).code
  .replace(/\b(useRef|useState|useCallback|useEffect)\b/g, 'react.$1')
  .replace(/\b(Modal|Button)\b/g, '_deepseek_ai_dsh_client_ui_primitives.$1');
await replace('lib/client.js', '\t\t\tconst controlsRef = (0, react.useRef)(null);\n', '\t\t\tconst controlsRef = (0, react.useRef)(null);\n' + await compile(spec.setup, 'ts'));
const modal = await compile(`const confirmation = (${spec.modal});`, 'tsx');
await replace('lib/client.js', '\t\t\tif (treeOnly || folderRoot !== void 0) return', modal + '\t\t\tif (treeOnly || folderRoot !== void 0) return');
await replace('lib/client.js', '\t\t\t\tchildren: [/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {\n\t\t\t\t\tclassName: sidebar_module_css_default.editorHeader,', '\t\t\t\tchildren: [confirmation, /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {\n\t\t\t\t\tclassName: sidebar_module_css_default.editorHeader,');
for (const path of ['lib/client.js', 'lib/client-editor.js', 'lib/client-registry.js', 'lib/client-terminal.js']) {
  for (const [before, after] of [
    ['refreshUnsavedConfirm: "文件已在磁盘更新，刷新将丢弃未保存编辑。继续吗？",', 'editorLeaveConfirm: "关闭、刷新或切换文件会丢弃未保存的内容。取消后可先保存，或明确放弃这些更改。",'],
    ['refreshUnsavedConfirm: "The file changed on disk. Refreshing will discard unsaved edits. Continue?",', 'editorLeaveConfirm: "Closing, refreshing or switching files will discard unsaved content. Cancel to save first, or discard these changes.",'],
  ]) await replace(path, before, `${before}\n${after}`);
}
for (const [path, source] of files) await writeFile(join(root, path), source);
console.log(`Reproduced Office toolbar/leave adapter in ${files.size} pinned Sidebar files.`);
