import { createHash, timingSafeEqual } from 'node:crypto'
import { lstat, readFile, realpath, rm } from 'node:fs/promises'
import { parseEnv } from 'node:util'
import { isAbsolute, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { CredentialProvider, credentialRef, parseCredentialKey } from '@deepseek-ai/dsh-credentials'
import type {
  CredentialInfo, CredentialKey, CredentialRecord, CredentialRecordEntry, CredentialRecordInfo,
  CredentialRef, ResolvedCredential,
} from '@deepseek-ai/dsh-credentials'
import { parseCredentialsDocument } from '@deepseek-ai/dsh-credentials-local'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { createCredentialBroker, type CredentialBroker } from './native-transport.ts'

const MAX_LEGACY_BYTES = 1024 * 1024
const MAX_STORED_BYTES = 64 * 1024
const SECRET_ENV_NAME = /(?:^|_)(?:API_KEY|TOKEN|SECRET|PASSWORD|ACCESS_KEY|PRIVATE_KEY)$/iu
const INDEX_VERSION = 1

interface CredentialIndex {
  version: 1
  records: Record<string, 'api-key' | 'grant'>
}

interface ResolvedConfig {
  dshHome: string
  requestTimeoutMs: number
}

interface Config {
  dshHome?: string
  requestTimeoutMs: number
}

/** Build the broker client once per Host; stdin contains only Tauri broker replies. */
/** Native desktop provider for DSH's reference and record credential spaces. */
export default class KeychainCredentialProvider extends CredentialProvider {
  static Config = z.object({
    dshHome: z.string(),
    requestTimeoutMs: z.number().min(100).max(120_000).default(10_000),
  })

  private readonly spec: ResolvedConfig
  private readonly broker: CredentialBroker
  private operations: Promise<void> = Promise.resolve()
  private closed = false

  constructor(ctx: Context, config: Config) {
    super(ctx)
    this.spec = {
      dshHome: resolveDshHome(config.dshHome),
      requestTimeoutMs: config.requestTimeoutMs,
    }
    this.broker = createCredentialBroker({ stdin: process.stdin, stdout: process.stdout, timeoutMs: this.spec.requestTimeoutMs })
  }

  async* [Service.init](): AsyncGenerator<() => Promise<void> | void, void, void> {
    try { await this.migrateLegacyCredentials() }
    catch {
      this.ctx.logger.warn('credentials-keychain: secure-store migration is unavailable; legacy credentials were preserved')
    }
    yield async () => {
      this.closed = true
      await this.operations
      this.broker.close()
    }
  }

  async resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined> {
    const value = await this.broker.get(`ref:${ref}`)
    return value === undefined ? undefined : { value, source: 'os-secure-store' }
  }

  async describe(ref: CredentialRef): Promise<CredentialInfo> {
    return referenceInfo((await this.broker.get(`ref:${ref}`)) !== undefined)
  }

  async set(ref: CredentialRef, value: string): Promise<void> {
    assertValue(ref, value)
    await this.assertOpen()
    await this.broker.set(`ref:${ref}`, value)
    this.notifyUpdated(ref)
  }

  async unset(ref: CredentialRef): Promise<void> {
    await this.assertOpen()
    await this.broker.delete(`ref:${ref}`)
    this.notifyUpdated(ref)
  }

  async readRecord(key: CredentialKey): Promise<CredentialRecord | undefined> {
    const value = await this.broker.get(`record:${key}`)
    return value === undefined ? undefined : parseRecord(key, value)
  }

  async describeRecord(key: CredentialKey): Promise<CredentialRecordInfo> {
    const record = await this.readRecord(key)
    return record === undefined
      ? { configured: false, writable: true }
      : { configured: true, kind: record.kind, writable: true }
  }

  async listRecords(): Promise<readonly CredentialRecordEntry[]> {
    return this.enqueue(() => withFileLock(this.indexPath(), async () => {
      const index = await this.readIndex()
      const entries: CredentialRecordEntry[] = []
      let changed = false
      for (const [key, indexedKind] of Object.entries(index.records)) {
        const stored = await this.broker.get(`record:${key}`)
        if (stored === undefined) {
          delete index.records[key]
          changed = true
          continue
        }
        const record = parseRecord(parseCredentialKey(key), stored)
        if (record.kind !== indexedKind) {
          index.records[key] = record.kind
          changed = true
        }
        entries.push({ key: parseCredentialKey(key), kind: record.kind })
      }
      if (changed) await this.writeIndex(index)
      return entries
    }, { waitMs: 30_000 }))
  }

  async modifyRecord(
    key: CredentialKey,
    mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>,
  ): Promise<CredentialRecord | undefined> {
    await this.assertOpen()
    return this.enqueue(() => withFileLock(this.indexPath(), async () => {
      const index = await this.readIndex()
      const current = await this.readRecord(key)
      const next = await mutate(current)
      if (next === undefined) return current
      assertRecord(key, next)
      const serialized = JSON.stringify(next)
      if (serialized === undefined || Buffer.byteLength(serialized, 'utf8') > MAX_STORED_BYTES) {
        throw new Error('OS credential record exceeds the storage limit')
      }
      await this.broker.set(`record:${key}`, serialized)
      try {
        index.records[key] = next.kind
        await this.writeIndex(index)
      } catch {
        await restoreRecord(this.broker, key, current)
        throw new Error('OS credential record index could not be committed')
      }
      this.notifyRecordUpdated(key)
      return next
    }, { waitMs: 30_000 }))
  }

  async deleteRecord(key: CredentialKey): Promise<void> {
    await this.assertOpen()
    await this.enqueue(() => withFileLock(this.indexPath(), async () => {
      const index = await this.readIndex()
      const current = await this.readRecord(key)
      if (current === undefined && index.records[key] === undefined) return
      await this.broker.delete(`record:${key}`)
      delete index.records[key]
      try {
        await this.writeIndex(index)
      } catch {
        if (current !== undefined) await this.broker.set(`record:${key}`, JSON.stringify(current))
        throw new Error('OS credential record index could not be committed')
      }
      this.notifyRecordUpdated(key)
    }, { waitMs: 30_000 }))
  }

  private indexPath(): string {
    return `${this.spec.dshHome}/.credentials-index.json`
  }

  private async readIndex(): Promise<CredentialIndex> {
    let text: string
    try {
      const metadata = await lstat(this.indexPath())
      if (!metadata.isFile()) throw new Error('index must be a regular file')
      text = await readFile(this.indexPath(), 'utf8')
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: INDEX_VERSION, records: {} }
      throw new Error('OS credential record index could not be read')
    }
    let parsed: unknown
    try { parsed = JSON.parse(text) } catch { throw new Error('OS credential record index is invalid') }
    if (!isIndex(parsed)) throw new Error('OS credential record index is invalid')
    return parsed
  }

  private async writeIndex(index: CredentialIndex): Promise<void> {
    await writeFileAtomic(this.indexPath(), `${JSON.stringify(index, null, 2)}\n`, { mode: 0o600, dirMode: 0o700 })
    const verified = await this.readIndex()
    if (!sameIndex(index, verified)) throw new Error('OS credential record index verification failed')
  }

  private async enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const task = this.operations.then(operation)
    this.operations = task.then(() => undefined, () => undefined)
    return task
  }

  private async assertOpen(): Promise<void> {
    if (this.closed) throw new Error('OS credential provider is disposed')
  }

  private async migrateLegacyCredentials(): Promise<void> {
    const roots = await this.legacyRoots()
    const yamlSources: string[] = []
    const sourceSnapshots = new Map<string, string>()
    const pendingRefs = new Map<string, string>()
    const pendingRecords = new Map(parseCredentialsDocument('', 'legacy').records)
    const envDocuments: Array<{ filename: string; text: string; values: Record<string, string> }> = []
    const addRef = (name: string, value: string): boolean => {
      const existing = pendingRefs.get(name)
      if (existing !== undefined && !sameSecret(existing, value)) return false
      pendingRefs.set(name, value)
      return true
    }
    for (const root of roots) {
      for (const filename of [join(root, '.credentials.yaml'), join(root, '.env')]) {
        let text: string
        try {
          const metadata = await lstat(filename)
          if (!metadata.isFile() || metadata.size > MAX_LEGACY_BYTES) throw new Error('invalid source file')
          text = await readFile(filename, 'utf8')
          sourceSnapshots.set(filename, text)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
          this.ctx.logger.warn('credentials-keychain: a legacy source could not be inspected; all sources were preserved')
          return
        }
        if (filename.endsWith('.credentials.yaml')) {
          let legacy: ReturnType<typeof parseCredentialsDocument>
          try { legacy = parseCredentialsDocument(text, filename) }
          catch {
            this.ctx.logger.warn('credentials-keychain: a legacy credential file is invalid; all sources were preserved')
            return
          }
          for (const [name, value] of legacy.refs) {
            if (!addRef(name, value)) {
              this.ctx.logger.warn('credentials-keychain: conflicting legacy values were found; all sources were preserved')
              return
            }
          }
          for (const [key, record] of legacy.records) {
            const prior = pendingRecords.get(key)
            if (prior !== undefined && JSON.stringify(prior) !== JSON.stringify(record)) {
              this.ctx.logger.warn('credentials-keychain: conflicting legacy records were found; all sources were preserved')
              return
            }
            pendingRecords.set(key, record)
          }
          yamlSources.push(filename)
        } else {
          let values: Record<string, string>
          try { values = parseEnv(text) }
          catch {
            this.ctx.logger.warn('credentials-keychain: a legacy environment file is invalid; all sources were preserved')
            return
          }
          envDocuments.push({ filename, text, values })
        }
      }
    }
    const environment = launchEnvironmentOf(this.ctx)
    for (const [name, value] of Object.entries(process.env)) {
      if (!SECRET_ENV_NAME.test(name) || value === undefined || value === '') continue
      try { credentialRef(name) } catch { continue }
      const inherited = environment.getFrom(name, ['process'])
      if (inherited?.value && !addRef(name, inherited.value)) {
        this.ctx.logger.warn('credentials-keychain: conflicting inherited values were found; all sources were preserved')
        return
      }
    }
    const cwdEnv = resolve(process.cwd(), '.env')
    if (!envDocuments.some(layer => layer.filename === cwdEnv)) {
      try {
        const metadata = await lstat(cwdEnv)
        if (!metadata.isFile() || metadata.size > MAX_LEGACY_BYTES) throw new Error('invalid source file')
        const text = await readFile(cwdEnv, 'utf8')
        envDocuments.push({ filename: cwdEnv, text, values: parseEnv(text) })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          this.ctx.logger.warn('credentials-keychain: the working environment file is invalid; all sources were preserved')
          return
        }
      }
    }
    for (const layer of envDocuments) {
      for (const [name, value] of Object.entries(layer.values)) {
        if (!SECRET_ENV_NAME.test(name) || value === '') continue
        try { credentialRef(name) } catch { continue }
        if (!addRef(name, value)) {
          this.ctx.logger.warn('credentials-keychain: conflicting legacy values were found; all sources were preserved')
          return
        }
      }
    }
    for (const [ref, value] of pendingRefs) {
      await this.broker.setIfAbsent(`ref:${ref}`, value)
      const stored = await this.broker.get(`ref:${ref}`)
      if (stored === undefined || !sameSecret(stored, value)) {
        this.ctx.logger.warn('credentials-keychain: legacy credential migration is incomplete; the source was preserved')
        return
      }
    }
    for (const [key, record] of pendingRecords) {
      const encoded = JSON.stringify(record)
      if (encoded === undefined || Buffer.byteLength(encoded, 'utf8') > MAX_STORED_BYTES) {
        this.ctx.logger.warn('credentials-keychain: a legacy credential record exceeds the migration limit; the source was preserved')
        return
      }
      await this.broker.setIfAbsent(`record:${key}`, encoded)
      const stored = await this.broker.get(`record:${key}`)
      if (stored === undefined || !sameSecret(stored, encoded)) {
        this.ctx.logger.warn('credentials-keychain: legacy credential migration is incomplete; the source was preserved')
        return
      }
    }
    try {
      await this.enqueue(() => withFileLock(this.indexPath(), async () => {
        const index = await this.readIndex()
        for (const [key, record] of pendingRecords) index.records[key] = record.kind
        await this.writeIndex(index)
      }, { waitMs: 30_000 }))
      for (const layer of envDocuments) {
        const refs = Object.keys(layer.values).filter(name => pendingRefs.has(name))
        if (refs.length === 0) continue
        const next = removeDotEnvAssignments(layer.text, refs)
        if (next === undefined) {
          this.ctx.logger.warn('credentials-keychain: environment secrets could not be removed without changing their file; manual cleanup is required')
          return
        }
        await withFileLock(layer.filename, async () => {
          const metadata = await lstat(layer.filename)
          if (!metadata.isFile() || await readFile(layer.filename, 'utf8') !== layer.text) {
            throw new Error('environment source changed during migration')
          }
          await writeFileAtomic(layer.filename, next, { mode: metadata.mode & 0o777, dirMode: 0o700 })
        }, { waitMs: 30_000 })
      }
      for (const ref of pendingRefs.keys()) delete process.env[ref]
      for (const source of yamlSources) {
        await withFileLock(source, async () => {
          const metadata = await lstat(source)
          if (!metadata.isFile() || await readFile(source, 'utf8') !== sourceSnapshots.get(source)) {
            throw new Error('legacy credential source changed during migration')
          }
          await rm(source)
        }, { waitMs: 30_000 })
      }
      if (roots.length > 0) await rm(join(this.spec.dshHome, '.clawmaster-credential-sources.json'), { force: true })
      this.ctx.logger.info('credentials-keychain: legacy credentials were migrated to the OS secure store')
    } catch {
      this.ctx.logger.warn('credentials-keychain: legacy credential migration could not be committed; the source was preserved')
    }
  }

  private async legacyRoots(): Promise<string[]> {
    const selected = await realpath(resolve(this.spec.dshHome))
    const defaultPath = resolve(homedir(), '.dsh')
    let defaults = defaultPath
    try { defaults = await realpath(defaultPath) } catch { /* A missing default home cannot contain legacy files. */ }
    const allowed = new Set([selected, defaults])
    const explicitRoots: string[] = []
    const configuredRoots = process.env.CLAWMASTER_CREDENTIAL_LEGACY_ROOTS
    if (configuredRoots !== undefined) {
      if (Buffer.byteLength(configuredRoots, 'utf8') > 64 * 1024) throw new Error('legacy credential root list is oversized')
      let parsedRoots: unknown
      try { parsedRoots = JSON.parse(configuredRoots) } catch { throw new Error('legacy credential root list is invalid') }
      if (!Array.isArray(parsedRoots) || !parsedRoots.every((root: unknown) => typeof root === 'string' && isAbsolute(root) && resolve(root) === root)) {
        throw new Error('legacy credential root list is invalid')
      }
      for (const root of parsedRoots as string[]) {
        const metadata = await lstat(root)
        if (!metadata.isDirectory() || await realpath(root) !== root) throw new Error('legacy credential root is not a canonical directory')
        allowed.add(root)
        explicitRoots.push(root)
      }
    }
    const isolatedPath = process.env.CLAWMASTER_CREDENTIAL_ISOLATED_HOME
    if (isolatedPath !== undefined) {
      try { allowed.add(await realpath(resolve(isolatedPath))) } catch { /* A missing isolated home cannot contain legacy files. */ }
    }
    const manifestPath = join(selected, '.clawmaster-credential-sources.json')
    let text: string
    try {
      const metadata = await lstat(manifestPath)
      if (!metadata.isFile() || metadata.size > 64 * 1024) throw new Error('invalid manifest file')
      text = await readFile(manifestPath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [...new Set([selected, ...explicitRoots])]
      throw new Error('legacy credential source manifest could not be read')
    }
    let parsed: unknown
    try { parsed = JSON.parse(text) } catch { throw new Error('legacy credential source manifest is invalid') }
    if (typeof parsed !== 'object' || parsed === null || !('version' in parsed) || parsed.version !== 1 || !('roots' in parsed) || !Array.isArray(parsed.roots)) {
      throw new Error('legacy credential source manifest is invalid')
    }
    const roots = new Set<string>([selected, ...explicitRoots])
    for (const root of parsed.roots) {
      if (typeof root !== 'string' || !isAbsolute(root) || resolve(root) !== root || !allowed.has(root)) {
        throw new Error('legacy credential source path is outside the permitted roots')
      }
      const metadata = await lstat(root)
      if (!metadata.isDirectory()) throw new Error('legacy credential source root is not a regular directory')
      if (await realpath(root) !== root) throw new Error('legacy credential source root is not canonical')
      roots.add(root)
    }
    for (const root of roots) {
      try {
        const metadata = await lstat(root)
        if (!metadata.isDirectory() || await realpath(root) !== root) roots.delete(root)
      } catch { roots.delete(root) }
    }
    return [...roots]
  }
}

/** Remove only complete dotenv assignments for selected keys, preserving every other byte. */
export function removeDotEnvAssignments(text: string, names: readonly string[]): string | undefined {
  let parsed: Record<string, string>
  try { parsed = parseEnv(text) } catch { return undefined }
  const selected = new Set(names.filter(name => Object.hasOwn(parsed, name)))
  if (selected.size === 0) return text
  const lines = text.match(/[^\r\n]*(?:\r\n|\n|\r|$)/gu)?.filter(line => line.length > 0) ?? []
  const kept: string[] = []
  for (let index = 0; index < lines.length;) {
    const line = lines[index] ?? ''
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*(?:=|\s*$)/u.exec(line.replace(/\r?\n$/u, ''))
    const name = match?.[1]
    if (name === undefined || !selected.has(name)) {
      kept.push(line)
      index += 1
      continue
    }
    const assignment = /^\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=\s*(.*)$/u.exec(line.replace(/\r?\n$/u, ''))
    let last = index
    const firstValue = assignment?.[1] ?? ''
    const quote = firstValue[0]
    if (quote === '"' || quote === "'" || quote === '`') {
      let closed = hasClosingQuote(firstValue, quote)
      while (!closed && last + 1 < lines.length) {
        last += 1
        closed = hasClosingQuote(lines[last] ?? '', quote)
      }
      if (!closed) return undefined
    }
    index = last + 1
  }
  const result = kept.join('')
  try {
    const remaining = parseEnv(result)
    if ([...selected].some(name => Object.hasOwn(remaining, name))) return undefined
  } catch { return undefined }
  return result
}

/** Describe a reference without exposing its value or claiming an absent source. */
export function referenceInfo(configured: boolean): CredentialInfo {
  return configured
    ? { configured: true, source: 'os-secure-store', writable: true }
    : { configured: false, writable: true }
}

function hasClosingQuote(value: string, quote: string): boolean {
  let escaped = false
  for (let index = value[0] === quote ? 1 : 0; index < value.length; index += 1) {
    const character = value[index]
    if (escaped) { escaped = false; continue }
    if (character === '\\' && quote !== "'") { escaped = true; continue }
    if (character === quote) return true
  }
  return false
}

function assertValue(ref: CredentialRef, value: string): void {
  if (value.length === 0) throw new Error(`OS credential value for "${ref}" cannot be empty`)
  if (Buffer.byteLength(value, 'utf8') > MAX_STORED_BYTES) throw new Error('OS credential value exceeds the storage limit')
}

function parseRecord(key: CredentialKey, value: string): CredentialRecord {
  let parsed: unknown
  try { parsed = JSON.parse(value) } catch { throw new Error(`OS credential record "${key}" is invalid`) }
  if (!isRecord(parsed)) throw new Error(`OS credential record "${key}" is invalid`)
  assertRecord(key, parsed)
  return parsed
}

function assertRecord(key: CredentialKey, value: CredentialRecord): void {
  if (value.kind === 'api-key') {
    if (value.key !== undefined && (typeof value.key !== 'string' || value.key.length === 0)) {
      throw new Error(`OS credential record "${key}" is invalid`)
    }
    for (const [name, secret] of Object.entries(value.env ?? {})) {
      try { credentialRef(name) } catch { throw new Error(`OS credential record "${key}" is invalid`) }
      if (typeof secret !== 'string' || secret.length === 0) throw new Error(`OS credential record "${key}" is invalid`)
    }
    return
  }
  if (value.kind !== 'grant' || !isJsonValue(value.payload, new Set())) throw new Error(`OS credential record "${key}" is invalid`)
}

function isRecord(value: unknown): value is CredentialRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const candidate = value as Record<string, unknown>
  return candidate['kind'] === 'api-key' || candidate['kind'] === 'grant'
}

function isJsonValue(value: unknown, seen: Set<object>): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (typeof value !== 'object' || seen.has(value)) return false
  if (Object.getPrototypeOf(value) !== Object.prototype && !Array.isArray(value)) return false
  seen.add(value)
  const valid = Object.values(value).every(child => isJsonValue(child, seen))
  seen.delete(value)
  return valid
}

function isIndex(value: unknown): value is CredentialIndex {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const candidate = value as Record<string, unknown>
  if (candidate['version'] !== INDEX_VERSION || candidate['records'] === null
    || typeof candidate['records'] !== 'object' || Array.isArray(candidate['records'])) return false
  return Object.entries(candidate['records'] as Record<string, unknown>).every(([key, kind]) => {
    try { parseCredentialKey(key) } catch { return false }
    return kind === 'api-key' || kind === 'grant'
  })
}

function sameIndex(left: CredentialIndex, right: CredentialIndex): boolean {
  const a = Object.entries(left.records).sort(([x], [y]) => x.localeCompare(y))
  const b = Object.entries(right.records).sort(([x], [y]) => x.localeCompare(y))
  return a.length === b.length && a.every(([key, kind], index) => b[index]?.[0] === key && b[index]?.[1] === kind)
}

function sameSecret(left: string, right: string): boolean {
  const a = createHash('sha256').update(left).digest()
  const b = createHash('sha256').update(right).digest()
  return timingSafeEqual(a, b)
}

async function restoreRecord(broker: CredentialBroker, key: CredentialKey, current: CredentialRecord | undefined): Promise<void> {
  if (current === undefined) await broker.delete(`record:${key}`)
  else await broker.set(`record:${key}`, JSON.stringify(current))
}
