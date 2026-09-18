/** Deployment settings for metadata polling and explicitly approved update writes. */
import { createPublicKey } from 'node:crypto'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { z } from 'zod'
import { httpsUrl } from './download.ts'
import { COMPONENT_PUBLIC_KEY, NATIVE_PUBLIC_KEY } from './keys.ts'

const positive = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const duration = positive.max(2_147_483_647)
const url = z.string().refine(value => { try { httpsUrl(value); return true } catch { return false } }, 'Requires an unambiguous HTTPS URL')
const absolutePath = z.string().refine(value => isAbsolute(value) && resolve(value) === value && !/[\u0000-\u001f\u007f]/u.test(value), 'Requires an absolute normalized path')

/** Loader-compatible schema; zero polling interval disables automatic metadata checks. */
export const Config = z.strictObject({
  dshHome: absolutePath.default(() => process.env.DSH_HOME ?? join(homedir(), '.dsh')),
  catalogUrl: url.default('https://8.140.52.117/updates/clawmaster/components/catalog.json'),
  nativeManifestUrl: url.default('https://8.140.52.117/updates/clawmaster/v2/latest.json'),
  publicKeyPem: z.string().refine(value => { try { return createPublicKey(value).asymmetricKeyType === 'ed25519' } catch { return false } }, 'Requires an Ed25519 public key').default(COMPONENT_PUBLIC_KEY),
  nativePublicKey: z.string().refine(value => {
    const bytes = Buffer.from(value, 'base64')
    if (bytes.toString('base64') !== value) return false
    const lines = bytes.toString('utf8').trim().split(/\r?\n/u)
    const key = Buffer.from(lines[1] ?? '', 'base64')
    return lines.length === 2 && lines[0]?.startsWith('untrusted comment:') === true && key.length === 42 && key.subarray(0, 2).toString() === 'Ed'
  }, 'Requires a Tauri Minisign public-key envelope').default(NATIVE_PUBLIC_KEY),
  checkIntervalMs: z.number().int().min(0).max(2_147_483_647).default(60_000),
  requestTimeoutMs: duration.default(30_000),
  downloadTimeoutMs: duration.default(600_000),
  maxCatalogBytes: positive.default(2 * 1024 * 1024),
  maxDownloadBytes: positive.default(512 * 1024 * 1024),
  maxComponentArchiveBytes: positive.default(64 * 1024 * 1024),
  maxExpandedBytes: positive.default(256 * 1024 * 1024),
  maxArchiveEntries: positive.default(10_000),
  nativeTarget: z.enum(['windows-x86_64', 'darwin-x86_64', 'darwin-aarch64', 'linux-x86_64', 'linux-x86_64-deb']).optional(),
  locale: z.enum(['zh-CN', 'en-US']).default('zh-CN'),
}).prefault({})

/** Optional configuration accepted by the DSH Loader. */
export type UpdatesConfig = z.input<typeof Config>
/** Fully resolved deployment settings; tool arguments cannot override these values. */
export type ResolvedUpdatesConfig = z.output<typeof Config>

/** Resolve deployment defaults and reject malformed settings before registering effects.
 * @param input Loader configuration.
 * @returns Validated settings with all defaults explicit.
 */
export function resolveConfig(input: UpdatesConfig = {}): ResolvedUpdatesConfig { return Config.parse(input) }
