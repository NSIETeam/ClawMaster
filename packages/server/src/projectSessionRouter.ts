/**
 * High-confidence project inference for a session that still uses the default
 * workspace. It only reuses projects the user has already selected elsewhere.
 */

import * as path from 'node:path';

import type { MessageContent, SessionSummary } from './protocol.js';

export type ProjectWorkspaceMatch = {
  workspacePath: string;
  confidence: number;
  matchedBy: 'path_reference' | 'project_name';
};

export interface ProjectWorkspaceInferenceInput {
  content: MessageContent;
  sessions: readonly SessionSummary[];
  currentSessionId: string;
  defaultWorkspacePath: string;
}

const GENERIC_PROJECT_NAMES = new Set([
  'app',
  'apps',
  'code',
  'desktop',
  'dev',
  'project',
  'projects',
  'repo',
  'server',
  'src',
  'test',
  'tests',
  'web',
]);

function normalizedPath(value: string): string {
  return path.resolve(value).replace(/\\/gu, '/').replace(/\/+$/u, '').toLocaleLowerCase();
}

function isWithin(candidate: string, referencedPath: string): boolean {
  return referencedPath === candidate || referencedPath.startsWith(`${candidate}/`);
}

function referencePaths(content: MessageContent): string[] {
  return content.flatMap((part) => {
    if (part.type === 'file_reference' || part.type === 'code_reference') {
      return [part.value.filePath];
    }
    if (part.type === 'folder_reference') return [part.value.folderPath];
    return [];
  }).filter(Boolean).map(normalizedPath);
}

function searchableText(content: MessageContent): string {
  return content.flatMap((part) => {
    if (part.type === 'text') return [part.value];
    if (part.type === 'text_file_content') return [part.value.fileName];
    if (part.type === 'folder_reference') return [part.value.folderName];
    if (
      part.type === 'file_reference'
      || part.type === 'code_reference'
      || part.type === 'image_reference'
    ) return [part.value.fileName];
    return [];
  }).join('\n').toLocaleLowerCase();
}

function projectNameIsSpecific(name: string): boolean {
  const normalized = name.toLocaleLowerCase();
  if (GENERIC_PROJECT_NAMES.has(normalized)) return false;
  return /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(name)
    ? Array.from(name).length >= 2
    : name.length >= 4;
}

function textMentionsProject(text: string, projectName: string): boolean {
  const normalized = projectName.toLocaleLowerCase();
  if (/[^a-z0-9_-]/iu.test(normalized)) return text.includes(normalized);
  const escaped = normalized.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, 'iu').test(text);
}

export function inferProjectWorkspace(
  input: ProjectWorkspaceInferenceInput,
): ProjectWorkspaceMatch | undefined {
  const defaultPath = normalizedPath(input.defaultWorkspacePath);
  const byPath = new Map<string, string>();
  for (const session of input.sessions) {
    if (session.sessionId === input.currentSessionId || !session.workspacePath?.trim()) continue;
    const normalized = normalizedPath(session.workspacePath);
    if (normalized === defaultPath) continue;
    byPath.set(normalized, session.workspacePath);
  }
  const candidates = [...byPath.entries()];
  if (candidates.length === 0) return undefined;

  const references = referencePaths(input.content);
  const pathMatches = candidates
    .filter(([candidate]) => references.some((reference) => isWithin(candidate, reference)))
    .sort((left, right) => right[0].length - left[0].length);
  if (pathMatches.length > 0) {
    return {
      workspacePath: pathMatches[0][1],
      confidence: 1,
      matchedBy: 'path_reference',
    };
  }

  const text = searchableText(input.content);
  const explicitPathMatches = candidates.filter(([candidate]) => text.includes(candidate));
  if (explicitPathMatches.length === 1) {
    return {
      workspacePath: explicitPathMatches[0][1],
      confidence: 1,
      matchedBy: 'path_reference',
    };
  }

  const nameMatches = candidates.filter(([, candidate]) => {
    const name = path.basename(candidate);
    return projectNameIsSpecific(name) && textMentionsProject(text, name);
  });
  if (nameMatches.length !== 1) return undefined;
  return {
    workspacePath: nameMatches[0][1],
    confidence: 0.92,
    matchedBy: 'project_name',
  };
}
