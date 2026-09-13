/**
 * Line diff for note proposals.
 * Pure, dependency-free and bounded: a very large input degrades to a whole-file
 * replacement instead of an O(n·m) table, and an oversized result is truncated with a marker.
 */

export type DiffKind = 'context' | 'add' | 'remove';

/** One line of a diff. */
export interface DiffLine {
  kind: DiffKind;
  text: string;
}

/** A diff plus the counts a reviewer needs and whether it was truncated. */
export interface UnifiedDiff {
  lines: DiffLine[];
  added: number;
  removed: number;
  truncated: boolean;
}

/** Above this many lines on either side the diff degrades to a replacement. */
const LCS_LIMIT = 2000;

function splitLines(text: string): string[] {
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

function lcs(left: string[], right: string[]): Uint32Array {
  const width = right.length + 1;
  const table = new Uint32Array((left.length + 1) * width);
  for (let i = left.length - 1; i >= 0; i -= 1) {
    for (let j = right.length - 1; j >= 0; j -= 1) {
      // noUncheckedIndexedAccess types every typed-array read as possibly undefined.
      table[i * width + j] = left[i] === right[j]
        ? (table[(i + 1) * width + j + 1] ?? 0) + 1
        : Math.max(table[(i + 1) * width + j] ?? 0, table[i * width + j + 1] ?? 0);
    }
  }
  return table;
}

function backtrack(left: string[], right: string[], table: Uint32Array): DiffLine[] {
  const width = right.length + 1;
  const lines: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < left.length && j < right.length) {
    if (left[i] === right[j]) { lines.push({ kind: 'context', text: left[i] ?? '' }); i += 1; j += 1; continue; }
    if ((table[(i + 1) * width + j] ?? 0) >= (table[i * width + j + 1] ?? 0)) {
      lines.push({ kind: 'remove', text: left[i] ?? '' });
      i += 1;
    } else {
      lines.push({ kind: 'add', text: right[j] ?? '' });
      j += 1;
    }
  }
  while (i < left.length) { lines.push({ kind: 'remove', text: left[i] ?? '' }); i += 1; }
  while (j < right.length) { lines.push({ kind: 'add', text: right[j] ?? '' }); j += 1; }
  return lines;
}

/** Read a changed block as removals followed by additions, the way a diff is read. */
function orderBlocks(lines: DiffLine[]): DiffLine[] {
  const ordered: DiffLine[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (line === undefined) break;
    if (line.kind === 'context') { ordered.push(line); index += 1; continue; }
    const block: DiffLine[] = [];
    while (index < lines.length && lines[index]?.kind !== 'context') {
      const changed = lines[index];
      if (changed !== undefined) block.push(changed);
      index += 1;
    }
    ordered.push(...block.filter(item => item.kind === 'remove'), ...block.filter(item => item.kind === 'add'));
  }
  return ordered;
}

/**
 * Diff two note bodies by line.
 * @param before - Current text.
 * @param after - Proposed text.
 * @param maxLines - Maximum diff lines kept; the middle is elided beyond it.
 * @returns The readable diff, its add/remove counts and whether it was truncated.
 */
export function unifiedDiff(before: string, after: string, maxLines = 400): UnifiedDiff {
  const left = splitLines(before);
  const right = splitLines(after);
  const degraded = left.length > LCS_LIMIT || right.length > LCS_LIMIT;
  const all = degraded
    ? [...left.map((text): DiffLine => ({ kind: 'remove', text })), ...right.map((text): DiffLine => ({ kind: 'add', text }))]
    : orderBlocks(backtrack(left, right, lcs(left, right)));
  const added = all.filter(line => line.kind === 'add').length;
  const removed = all.filter(line => line.kind === 'remove').length;
  if (all.length <= maxLines) return { lines: all, added, removed, truncated: false };
  const half = Math.floor(maxLines / 2);
  return {
    lines: [...all.slice(0, half), { kind: 'context', text: `… ${all.length - maxLines} lines elided …` }, ...all.slice(-half)],
    added,
    removed,
    truncated: true,
  };
}
