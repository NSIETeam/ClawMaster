/**
 * Result-stage review: turn facts into the entry the archive writes.
 *
 * The shape is the one the notes vault already uses for a digested work entry — summary,
 * decisions, evidence, next steps — so the result review lands in the same daily note the agent's
 * own `notes_digest` writes, and a reader compares them the same way. This module is pure: it
 * composes text from facts and never touches the vault.
 * @module @clawmaster/dsh-guard/review
 */

import type { TurnFacts } from './turn-facts.ts';

/** One composed result review, shaped for the notes vault's digest entry. */
export interface ResultReview {
  /** One sentence naming what the turn did. */
  summary: string;
  /** Claims a reader can check. */
  evidence: string[];
  /** What the review could not establish, stated rather than implied. */
  nextSteps: string[];
}

/** Bound on how many tool names one review lists before it summarizes the rest. */
const TOOL_SAMPLE = 6;

/** `a, b and 2 more`, so a long tool list stays one line. */
function sample(values: readonly string[]): string {
  if (values.length <= TOOL_SAMPLE) return values.join(', ');
  return `${values.slice(0, TOOL_SAMPLE).join(', ')} and ${values.length - TOOL_SAMPLE} more`;
}

/**
 * Compose the result review for one turn.
 * @param facts - Facts collected from the turn's events.
 * @returns The review, ready to append through the notes access.
 */
export function composeResultReview(facts: TurnFacts): ResultReview {
  const names = [...new Set(facts.tools.map(tool => tool.name))];
  const first = facts.tools[0];
  const summaryParts = [
    `Turn ${facts.turn} ran ${facts.tools.length} tool call${facts.tools.length === 1 ? '' : 's'}`,
    names.length > 0 ? `(${sample(names)})` : '',
    facts.files.length > 0 ? `touching ${facts.files.length} file${facts.files.length === 1 ? '' : 's'}` : '',
    first?.detail !== undefined ? `starting with: ${first.detail}` : '',
  ].filter(part => part !== '');
  const summary = facts.userPrompt !== undefined
    ? `${summaryParts.join(' ')} — asked: ${oneLine(facts.userPrompt, 120)}`
    : summaryParts.join(' ');

  const evidence: string[] = [];
  if (facts.commands.length > 0) evidence.push(`Commands: ${facts.commands.map(command => `\`${command}\``).join(', ')}`);
  if (facts.files.length > 0) evidence.push(`Files: ${facts.files.map(file => `\`${file}\``).join(', ')}`);
  if (facts.tools.length > 0) evidence.push(`Tool calls: ${facts.tools.map(tool => tool.name).join(', ')}`);

  const nextSteps: string[] = [];
  if (facts.failures > 0) nextSteps.push(`${facts.failures} tool result${facts.failures === 1 ? '' : 's'} reported a failure; the outcome is unverified until that is explained.`);
  if (!facts.hasVerification) nextSteps.push('No test, build or lint run appeared in this turn, so the result rests on inspection alone.');
  if (facts.files.length === 0 && facts.commands.length === 0) nextSteps.push('No file or command was named, so this review cannot say what changed.');

  return { summary, evidence, nextSteps };
}

/** Compress one line of the user's words for the summary. */
function oneLine(value: string, limit: number): string {
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
}
