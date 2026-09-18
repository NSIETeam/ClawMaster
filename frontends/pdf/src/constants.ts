/**
 * Values both halves of the component agree on.
 *
 * This module must stay free of `node:` imports: the browser bundle reaches it through
 * `protocol.ts`, so anything added here has to be valid in a browser. The path *policy*
 * itself lives in `paths.ts`, which is host-only.
 */

/** The only extension these tools write. */
export const PDF_EXTENSION = '.pdf';
