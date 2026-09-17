import { randomUUID } from 'node:crypto'
import type { Readable, Writable } from 'node:stream'

const PREFIX = '\u001eCLAWMASTER_CREDENTIALS_V1:'
const PROTOCOL = 'clawmaster-credentials/1'
const MAX_FRAME_BYTES = 96 * 1024
const MAX_VALUE_BYTES = 64 * 1024
const ERROR_CODES = new Set(['unavailable', 'access-denied', 'invalid-reference', 'too-large', 'write-failed'])

export type CredentialOperation = 'get' | 'set' | 'set-if-absent' | 'delete'
export type CredentialBrokerError = 'unavailable' | 'access-denied' | 'invalid-reference' | 'too-large' | 'write-failed'

export interface CredentialBroker {
  get(reference: string): Promise<string | undefined>
  set(reference: string, value: string): Promise<void>
  setIfAbsent(reference: string, value: string): Promise<boolean>
  delete(reference: string): Promise<void>
  close(): void
}

interface PendingRequest {
  operation: CredentialOperation
  settle(value: string | undefined | boolean, error?: CredentialBrokerError): void
  timer: NodeJS.Timeout
}

/** Construct the request/reply client over the inherited Tauri Host pipes. */
export function createCredentialBroker(input: {
  stdin: Readable
  stdout: Writable
  timeoutMs: number
  createRequestId?: () => string
}): CredentialBroker {
  if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 100 || input.timeoutMs > 120_000) {
    throw new RangeError('credential broker timeout must be from 100 through 120000 ms')
  }
  const pending = new Map<string, PendingRequest>()
  let buffered = Buffer.alloc(0)
  let closed = false
  let discardingOversizedLine = false
  let resolveReady: (() => void) | undefined
  let rejectReady: ((error: Error) => void) | undefined
  const readiness = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject })
  void readiness.catch(() => {})
  const readyTimer = setTimeout(() => {
    rejectReady?.(new Error('OS credential store is unavailable'))
  }, input.timeoutMs)
  const failAll = (code: CredentialBrokerError): void => {
    closed = true
    clearTimeout(readyTimer)
    rejectReady?.(new Error(`OS credential store is unavailable (${code})`))
    for (const [id, request] of pending) {
      clearTimeout(request.timer)
      request.settle(undefined, code)
      pending.delete(id)
    }
  }
  const onData = (chunk: Buffer | string): void => {
    let bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    if (discardingOversizedLine) {
      const newline = bytes.indexOf(0x0a)
      if (newline < 0) return
      discardingOversizedLine = false
      bytes = bytes.subarray(newline + 1)
    }
    buffered = Buffer.concat([buffered, bytes])
    while (true) {
      const newline = buffered.indexOf(0x0a)
      if (newline < 0) {
        if (buffered.length > MAX_FRAME_BYTES) {
          buffered = Buffer.alloc(0)
          discardingOversizedLine = true
        }
        break
      }
      const line = buffered.subarray(0, newline)
      buffered = buffered.subarray(newline + 1)
      if (line.length === 0 || line.length > MAX_FRAME_BYTES) continue
      let frame: Record<string, unknown>
      try {
        const parsed: unknown = JSON.parse(line.toString('utf8'))
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) continue
        frame = parsed as Record<string, unknown>
      } catch {
        continue
      }
      if (frame['protocol'] !== PROTOCOL) continue
      if (frame['type'] === 'ready' && frame['supported'] === true) {
        clearTimeout(readyTimer)
        resolveReady?.()
        continue
      }
      if (frame['type'] !== 'result' || typeof frame['requestId'] !== 'string') continue
      const request = pending.get(frame['requestId'])
      if (request === undefined) continue
      pending.delete(frame['requestId'])
      clearTimeout(request.timer)
      if (frame['ok'] === true) {
        const value = frame['value']
        const inserted = frame['inserted']
        if (request.operation === 'set-if-absent' && typeof inserted !== 'boolean') {
          request.settle(undefined, 'unavailable')
        } else if (request.operation === 'get' && value !== undefined && typeof value !== 'string') {
          request.settle(undefined, 'unavailable')
        } else if (typeof value === 'string' && Buffer.byteLength(value, 'utf8') > MAX_VALUE_BYTES) {
          request.settle(undefined, 'too-large')
        } else {
          request.settle(request.operation === 'set-if-absent' ? inserted as boolean : typeof value === 'string' ? value : undefined)
        }
        continue
      }
      const error = frame['error']
      request.settle(undefined, typeof error === 'string' && ERROR_CODES.has(error)
        ? error as CredentialBrokerError
        : 'unavailable')
    }
  }
  const onEnd = (): void => failAll('unavailable')
  input.stdin.on('data', onData)
  input.stdin.on('end', onEnd)
  input.stdin.on('error', onEnd)
  input.stdin.resume()
  input.stdout.write(`${PREFIX}${JSON.stringify({ protocol: PROTOCOL, type: 'hello' })}\n`)

  const request = (operation: CredentialOperation, reference: string, value?: string): Promise<string | undefined | boolean> => {
    if (closed) return Promise.reject(new Error('OS credential store is unavailable'))
    if (Buffer.byteLength(reference, 'utf8') > 255) return Promise.reject(new Error('OS credential reference is invalid'))
    if (value !== undefined && Buffer.byteLength(value, 'utf8') > MAX_VALUE_BYTES) {
      return Promise.reject(new Error('OS credential value exceeds the storage limit'))
    }
    const requestId = input.createRequestId?.() ?? randomUUID()
    if (!requestId || pending.has(requestId)) return Promise.reject(new Error('OS credential request could not be identified'))
    return readiness.then(() => new Promise<string | undefined | boolean>((resolve, reject) => {
      if (closed) {
        reject(new Error('OS credential store is unavailable'))
        return
      }
      const timer = setTimeout(() => {
        pending.delete(requestId)
        reject(new Error('OS credential request timed out'))
      }, input.timeoutMs)
      pending.set(requestId, {
        operation,
        timer,
        settle(result, error) {
          if (error === undefined) resolve(result)
          else reject(new Error(`OS credential store operation failed (${error})`))
        },
      })
      const frame = JSON.stringify({ protocol: PROTOCOL, type: operation, requestId, reference,
        ...(value === undefined ? {} : { value }) })
      const bytes = Buffer.from(`${PREFIX}${frame}\n`, 'utf8')
      if (bytes.length > MAX_FRAME_BYTES) {
        clearTimeout(timer)
        pending.delete(requestId)
        reject(new Error('OS credential request exceeds the transport limit'))
        return
      }
      input.stdout.write(bytes, error => {
        if (error === null || error === undefined) return
        const saved = pending.get(requestId)
        if (saved === undefined) return
        pending.delete(requestId)
        clearTimeout(saved.timer)
        reject(new Error('OS credential broker could not receive the request'))
      })
    }))
  }
  return {
    async get(reference) {
      const result = await request('get', reference)
      return typeof result === 'string' ? result : undefined
    },
    async set(reference, value) { await request('set', reference, value) },
    async setIfAbsent(reference, value) { return (await request('set-if-absent', reference, value)) as boolean },
    async delete(reference) { await request('delete', reference) },
    close() {
      input.stdin.removeListener('data', onData)
      input.stdin.removeListener('end', onEnd)
      input.stdin.removeListener('error', onEnd)
      failAll('unavailable')
      if (input.stdin === process.stdin && input.stdin.listenerCount('data') === 0) input.stdin.pause()
    },
  }
}

export const credentialBrokerLimits = Object.freeze({ maxFrameBytes: MAX_FRAME_BYTES, maxValueBytes: MAX_VALUE_BYTES })
