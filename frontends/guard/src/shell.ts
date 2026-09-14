/**
 * Quote-aware shell text handling.
 *
 * The guard has to see what a command line actually names — which program runs and which paths it
 * receives — without running anything. This is deliberately a reader, not an evaluator: it splits
 * on unquoted operators, separates leading `VAR=value` assignments, and records redirect targets.
 * Anything it cannot parse confidently stays in `argv` for the rule set to see rather than being
 * dropped, so an unparsed command is reviewed conservatively instead of silently skipped.
 * @module @clawmaster/dsh-guard/shell
 */

import { isWindowsPath } from './paths.ts';

/** One command line piece: its argv plus the assignments and redirects around it. */
export interface ShellSegment {
  /** The raw text of this segment, for diagnostics and reasons. */
  raw: string;
  /** argv after leading `VAR=value` assignments were separated out. */
  argv: string[];
  /** Assignments that preceded the command in this segment (`HOME=/tmp rm -rf ~`). */
  assignments: Record<string, string>;
  /** Targets of `>` / `>>` / `2>` redirects, in order; `2>&1` is a descriptor copy, not a target. */
  redirects: string[];
}

/** Unquoted shell operators that end one command and begin the next. */
const OPERATORS = new Set(['&&', '||', ';', '|', '&', '\n']);

/** A redirect operator, optionally glued to its target (`>out.txt`, `2>>log`). */
const REDIRECT = /^(?:&>>?|[12]?>>?)(?<target>.*)$/;

/**
 * Split a command line into tokens, honouring single quotes, double quotes and backslash escapes.
 * Operators come back as their own tokens.
 * @param command - The raw command line.
 * @returns Tokens in order.
 */
export function tokenize(command: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: '"' | "'" | undefined;
  let started = false;
  const push = () => { if (started) { tokens.push(current); current = ''; started = false; } };

  for (let index = 0; index < command.length; index += 1) {
    const character = command[index] ?? '';
    if (quote !== undefined) {
      if (character === quote) { quote = undefined; continue; }
      if (quote === '"' && character === '\\' && index + 1 < command.length) {
        index += 1;
        current += command[index] ?? '';
        continue;
      }
      current += character;
      continue;
    }
    if (character === "'" || character === '"') { quote = character; started = true; continue; }
    if (character === '\\' && index + 1 < command.length) { index += 1; current += command[index] ?? ''; started = true; continue; }
    if (character === ' ' || character === '\t') { push(); continue; }
    // Grouping punctuation is structural: `(rm -rf ~)` must read as the command `rm`, not as the
    // word `(rm`. `$(` and `${` keep their text so variable and substitution syntax stays intact.
    const previous = index === 0 ? '' : command[index - 1] ?? '';
    if ((character === '(' || character === ')') && previous !== '$') { push(); tokens.push(character); continue; }
    const pair = command.slice(index, index + 2);
    if (OPERATORS.has(pair)) { push(); tokens.push(pair); index += 1; continue; }
    if (OPERATORS.has(character)) { push(); tokens.push(character); continue; }
    current += character;
    started = true;
  }
  push();
  return tokens;
}

/**
 * Split a command line into the segments that each name one program.
 * @param command - The raw command line.
 * @returns Segments in execution order, with assignments and redirect targets resolved.
 */
export function splitSegments(command: string): ShellSegment[] {
  const segments: ShellSegment[] = [];
  let tokens: string[] = [];
  const flush = () => {
    if (tokens.length === 0) return;
    segments.push(describe(tokens));
    tokens = [];
  };
  for (const token of tokenize(command)) {
    if (OPERATORS.has(token)) { flush(); continue; }
    tokens.push(token);
  }
  flush();
  return segments;
}

/** Build one segment from its tokens: leading assignments out, redirects recorded, grouping signs dropped. */
function describe(tokens: readonly string[]): ShellSegment {
  const argv: string[] = [];
  const assignments: Record<string, string> = {};
  const redirects: string[] = [];
  let index = 0;
  // A subshell or a group opener is punctuation, not the program name.
  while (index < tokens.length && (tokens[index] === '(' || tokens[index] === '{')) index += 1;
  for (; index < tokens.length; index += 1) {
    const token = tokens[index] ?? '';
    if (token === ')' || token === '}') continue;
    const redirect = REDIRECT.exec(token);
    if (redirect !== null && !token.startsWith('&')) {
      const glued = redirect.groups?.['target'] ?? '';
      if (glued !== '') { redirects.push(glued); continue; }
      const next = tokens[index + 1];
      if (next !== undefined && !OPERATORS.has(next)) { redirects.push(next); index += 1; }
      continue;
    }
    if (argv.length === 0) {
      const assignment = /^(?<name>[A-Za-z_][A-Za-z0-9_]*)=(?<value>.*)$/.exec(token);
      if (assignment !== null) {
        assignments[assignment.groups?.['name'] ?? ''] = assignment.groups?.['value'] ?? '';
        continue;
      }
    }
    argv.push(token);
  }
  return { raw: tokens.join(' '), argv, assignments, redirects };
}

/**
 * Expand the shell references the guard can resolve without an environment: `~`, `$HOME`,
 * `${HOME}`, and any assignment made in the same command line.
 * @param word - One argument as written.
 * @param context - The resolved home directory, working directory and any same-line assignments.
 * @returns The path the argument most likely names, still possibly a glob.
 */
export function expandWord(word: string, context: { home: string; cwd: string; assignments?: Record<string, string> }): string {
  let value = word;
  const home = context.assignments?.['HOME'] ?? context.home;
  value = value.replace(/^\$(\{HOME\}|HOME)\b/, home);
  value = value.replace(/\$\{HOME\}/g, home);
  value = value.replace(/\$H(?:\{HOME\})?/g, home);
  if (value === '~' || value.startsWith('~/')) value = `${home}${value.slice(1)}`;
  for (const [name, replacement] of Object.entries(context.assignments ?? {})) {
    value = value.replaceAll(`$${name}`, replacement).replaceAll(`\${${name}}`, replacement);
  }
  if (value.startsWith('/') || isWindowsPath(value)) return value;
  return `${context.cwd === '/' ? '' : context.cwd}/${value}`;
}

/** True when a word still contains glob or unexpanded-variable syntax after expansion. */
export function hasPattern(value: string): boolean {
  return /[*?[\]]/.test(value) || value.includes('$');
}
