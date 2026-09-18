/** Route surface and argument schemas of the Feishu document capability. */
import { z } from 'zod';

/** Authenticated Fetch routes on the DSH Fetch carrier, which owns authentication. */
export const FEISHU_WHOAMI_PATH = '/api/clawmaster/feishu/whoami';
export const FEISHU_CAPABILITIES_PATH = '/api/clawmaster/feishu/capabilities';

const identifier = z.string().min(1).max(512);

export const whoamiSchema = z.object({}).strict();

export const capabilitiesSchema = z.object({}).strict();

export const docReadSchema = z.object({
  /** A docx document token, or a full Feishu document URL to extract one from. */
  document: identifier,
}).strict();

export const wikiSpacesSchema = z.object({}).strict();

export const wikiNodesSchema = z.object({
  spaceId: identifier,
  parentNodeToken: identifier.optional(),
}).strict();

export const wikiReadSchema = z.object({
  token: identifier,
}).strict();

export const driveListSchema = z.object({
  folderToken: identifier.optional(),
}).strict();

/** Pull a document token out of a pasted Feishu URL, or accept a bare token. */
export function documentTokenFrom(input: string): string {
  const value = input.trim();
  const match = /\/(?:docx|docs|wiki)\/([A-Za-z0-9]+)/.exec(value);
  if (match !== null) return match[1] ?? value;
  return value;
}
