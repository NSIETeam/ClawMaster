/**
 * Result-stage facts: what one turn actually did.
 *
 * The reviewer reads the session event stream it already observes and reduces a turn to the
 * claims a person can check — which tools ran, which files and commands they touched, whether a
 * failure surfaced, whether tests ran. It reads tolerantly: event payloads carry more than this
 * module needs, and a shape it does not recognize costs a detail, never the review.
 * @module @clawmaster/dsh-guard/turn-facts
 */

/** The part of a session event the review reads. Real events carry further fields. */
export interface ReviewEvent {
  type: string;
  data?: unknown;
}

/** One tool the turn ran, with the smallest identifying detail available. */
export interface ToolUse {
  name: string;
  /** A path or command the call named, when the payload exposed one. */
  detail?: string;
}

/** What one turn did, as evidence rather than as a summary. */
export interface TurnFacts {
  /** The turn number, as the events reported it. */
  turn: number;
  /** The user's own words for this turn, when the turn carried one. */
  userPrompt?: string;
  /** Tools in call order. */
  tools: ToolUse[];
  /** Distinct files the turn named through a file-shaped argument. */
  files: string[];
  /** Distinct shell commands the turn ran, truncated to one line each. */
  commands: string[];
  /** Tool results the harness marked as failures. */
  failures: number;
  /** Whether any command looks like a test, build or lint run. */
  hasVerification: boolean;
}

/** Argument keys that name a file rather than a command. */
const FILE_KEYS = ['file_path', 'path', 'filePath', 'id', 'target'];

/** Command keys, in the order a payload is likely to use them. */
const COMMAND_KEYS = ['command', 'cmd', 'script'];

/** Commands that count as verification for the review. */
const VERIFICATION = /\b(test|tests|vitest|jest|pytest|node --test|tsc|lint|oxlint|cargo (test|check)|pnpm (test|run test|run lint|run typecheck))\b/;

/** Read one record's string field without trusting the payload's shape. */
function text(record: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return undefined;
}

/** Narrow an unknown payload to a record. */
function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : undefined;
}

/** The first line of a command, bounded, so a heredoc cannot flood the note. */
function oneLine(command: string): string {
  const [first = ''] = command.split('\n');
  return first.length > 160 ? `${first.slice(0, 157)}…` : first;
}

/**
 * Reduce a turn's events to facts.
 * @param events - Every event observed for the turn, in order.
 * @returns The facts the result review is composed from.
 */
export function collectTurn(events: readonly ReviewEvent[]): TurnFacts {
  const facts: TurnFacts = {
    turn: 0,
    tools: [],
    files: [],
    commands: [],
    failures: 0,
    hasVerification: false,
  };
  const files = new Set<string>();
  const commands = new Set<string>();
  for (const event of events) {
    const data = record(event.data);
    if (event.type === 'turn/start' || event.type === 'turn/end') {
      const turn = data?.['turn'];
      if (typeof turn === 'number') facts.turn = turn;
      continue;
    }
    if (event.type === 'user/message') {
      const prompt = text(data ?? {}, ['text', 'content']);
      if (prompt !== undefined) facts.userPrompt = prompt;
      continue;
    }
    if (event.type !== 'tool/call') continue;
    const name = text(data ?? {}, ['name', 'tool', 'toolName']) ?? 'unknown';
    const args = record(data?.['arguments']) ?? record(data?.['args']) ?? data ?? {};
    const command = text(args, COMMAND_KEYS);
    const file = text(args, FILE_KEYS);
    const detail = command !== undefined ? oneLine(command) : file;
    facts.tools.push({ name, ...detail !== undefined ? { detail } : {} });
    if (command !== undefined) {
      commands.add(oneLine(command));
      if (VERIFICATION.test(command)) facts.hasVerification = true;
    }
    for (const key of FILE_KEYS) {
      const named = args[key];
      if (typeof named === 'string' && named.includes('/')) files.add(named);
    }
  }
  facts.files = [...files];
  facts.commands = [...commands];
  return facts;
}

/**
 * Whether a turn is worth archiving: it ran tools, or it said something. A turn that only exchanged
 * pleasantries earns no note, which is what keeps an archive quiet enough to stay useful.
 * @param facts - The turn's facts.
 * @returns True when the turn did work.
 */
export function isReviewable(facts: TurnFacts): boolean {
  return facts.tools.length > 0;
}
