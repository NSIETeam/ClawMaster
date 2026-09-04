import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const repositoryRoot = path.resolve(import.meta.dirname, '../../..');
const sourceRoots = [
  'packages/desktop/src/renderer',
  'packages/desktop/src/main',
  'packages/core/src',
  'packages/server/src',
];

const compatibilityAllowlist = [
  '## ClawMaster Added Memories',
  'X-ClawMaster-',
  'ClawMaster proxy /v1/chat/stream handler',
  'ClawMaster-Private-Deployment/',
  'HKCU\\Software\\ClawMaster\\UsbLicenses',
];

function productionFiles(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!['dist', 'node_modules', 'target'].includes(entry.name)) {
        files.push(...productionFiles(fullPath));
      }
    } else if (/\.(?:ts|tsx)$/u.test(entry.name) && !entry.name.includes('.test.')) {
      files.push(fullPath);
    }
  }
  return files;
}

function exactBrandLiterals(file) {
  const source = fs.readFileSync(file, 'utf8');
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.Latest,
    true,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const matches = [];
  const visit = (node) => {
    const text = ts.isJsxText(node)
      ? node.getText(sourceFile)
      : ts.isStringLiteral(node)
          || ts.isNoSubstitutionTemplateLiteral(node)
          || ts.isTemplateHead(node)
          || ts.isTemplateMiddle(node)
          || ts.isTemplateTail(node)
        ? node.text
        : undefined;
    if (
      text
      && /\bClawMaster\b/u.test(text)
      && !compatibilityAllowlist.some((allowed) => text.includes(allowed))
      && !file.endsWith('diagnosticBundle.ts')
    ) {
      const location = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
      matches.push(`${path.relative(repositoryRoot, file)}:${location.line + 1} ${text.slice(0, 120)}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return matches;
}

describe('ClawMaster product brand contract', () => {
  it('keeps legacy ClawMaster identifiers internal and out of user-facing source literals', () => {
    const violations = sourceRoots.flatMap((root) =>
      productionFiles(path.join(repositoryRoot, root)).flatMap(exactBrandLiterals));
    expect(violations).toEqual([]);
  }, 15_000);

  it('does not resurrect the deleted ClawMaster Green distribution branch', () => {
    const packagingSources = [
      path.join(repositoryRoot, 'packages/desktop/package.json'),
      ...fs.readdirSync(path.join(repositoryRoot, 'packages/desktop/scripts'))
        .filter((name) => name.endsWith('.mjs') && !name.includes('.test.'))
        .map((name) => path.join(repositoryRoot, 'packages/desktop/scripts', name)),
    ];
    const violations = packagingSources.filter((file) =>
      /ClawMaster Green|otto-green|CLAWMASTER_GREEN/u.test(fs.readFileSync(file, 'utf8')));
    expect(violations).toEqual([]);
  });
});
