/** Authenticate component catalog bytes before strict schema and deployment checks. */
import { createPublicKey, verify } from 'node:crypto'
import { z } from 'zod'
import { valid } from 'semver'
import { fetchBytes, httpsUrl, type RequestOptions } from './download.ts'

const stableVersion = z.string().regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u)
const common = {
  id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u),
  packageName: z.string().regex(/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u),
  version: stableVersion,
  requiresDshVersion: z.string().refine(value => valid(value) === value, 'Requires one exact DSH version'),
  url: z.string(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  size: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
}
const itemSchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...common, kind: z.literal('component'), entry: z.literal('./dist/index.js'), activation: z.enum(['hot', 'restart']) }),
  z.strictObject({ ...common, kind: z.literal('runtime'), activation: z.literal('desktop-required') }),
])
const catalogSchema = z.strictObject({ schemaVersion: z.literal(1), generatedAt: z.iso.datetime(), components: z.array(itemSchema) })

/** Signed immutable component or runtime version descriptor. */
export type CatalogItem = z.infer<typeof itemSchema>
/** Authenticated catalog with deployment-constrained artifact URLs. */
export type Catalog = z.infer<typeof catalogSchema>
/** Catalog trust anchor and limits, supplied by deployment configuration. */
export interface CatalogOptions extends RequestOptions { catalogUrl: string; publicKeyPem: string; maxDownloadBytes: number }

/** Authenticate exact catalog bytes and validate every declared component.
 * @param bytes Exact JSON response bytes.
 * @param signature Detached base64 Ed25519 signature over those bytes.
 * @param options Pinned public key, catalog origin and download limit.
 * @returns Validated catalog; malformed or unauthenticated data throws.
 */
export function parseSignedCatalog(bytes: Uint8Array, signature: string, options: Pick<CatalogOptions, 'catalogUrl' | 'publicKeyPem' | 'maxDownloadBytes'>): Catalog {
  const catalogUrl = httpsUrl(options.catalogUrl)
  const encoded = signature.trim()
  const decoded = Buffer.from(encoded, 'base64')
  if (decoded.length !== 64 || decoded.toString('base64') !== encoded) throw new Error('Invalid component catalog signature encoding')
  const key = createPublicKey(options.publicKeyPem)
  if (key.asymmetricKeyType !== 'ed25519' || !verify(null, bytes, key, decoded)) throw new Error('Component catalog signature verification failed')
  const catalog = catalogSchema.parse(JSON.parse(Buffer.from(bytes).toString('utf8')))
  const ids = new Set<string>()
  for (const item of catalog.components) {
    if (ids.has(item.id)) throw new Error('Component catalog contains duplicate ids')
    ids.add(item.id)
    const url = httpsUrl(item.url)
    if (url.origin !== catalogUrl.origin || !url.pathname.startsWith('/updates/clawmaster/components/artifacts/') || url.pathname.endsWith('/')) throw new Error('Component artifact URL is outside the configured channel')
    if (item.size > options.maxDownloadBytes) throw new Error('Component artifact exceeds configured byte limit')
  }
  return catalog
}

/** Fetch catalog and detached signature without accepting redirects.
 * @param options Trusted catalog endpoint and limits.
 * @returns Authenticated catalog; no component is applied or downloaded.
 */
export async function fetchCatalog(options: CatalogOptions): Promise<Catalog> {
  httpsUrl(options.catalogUrl)
  const bytes = await fetchBytes(options.catalogUrl, options)
  const signature = await fetchBytes(`${options.catalogUrl}.sig`, options)
  return parseSignedCatalog(bytes, signature.toString('utf8'), options)
}
