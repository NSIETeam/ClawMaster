/** Identity syntax shared by trusted governance providers and persisted business records. */
import { z } from 'zod';

/** Validate an opaque identifier supplied by the trusted identity authority.
 * @returns A non-empty identifier of at most 128 UTF-16 code units.
 */
export const trustedAuthorityIdentifierSchema = z.string().min(1).max(128);
