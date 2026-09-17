// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis'
import {
  createClientModuleSystem, parseBootManifest,
  type ClientBundleRegistration, type ClientModuleLoader, type ClientModuleLoaderTarget, type WebBootEntry, type WebBootGraph,
} from '@deepseek-ai/dsh-client-modules/client'
import { describe, expect, it, vi } from 'vitest'
import { assertEntriesActive, bootClient, type EntryStateLabel } from '../src/boot-client.ts'
import { FIBER_STATE } from '../src/loader-status.ts'

const BOOTSTRAP_ID = '@deepseek-ai/dsh-client-modules'

function graphOf(ids: readonly string[]): WebBootGraph {
  const entries: WebBootEntry[] = ids.map(id => ({ id, url: `/${id}.js`, rev: '1' }))
  return {
    rev: 'graph',
    entries,
    batches: [{ phase: 'application', url: '/application.js', rev: 'batch', entries: [...ids] }],
  }
}

/** Module system seeded with inline plugin modules; `loaded` records every transport call. */
function modulesOf(graph: WebBootGraph, staticModules: Record<string, unknown>): { modules: ClientModuleLoader; loaded: string[] } {
  const loaded: string[] = []
  const pendingQueue: ClientBundleRegistration[] = []
  const target: ClientModuleLoaderTarget = {
    mode: 'queue',
    pendingQueue,
    load: (registration) => { pendingQueue.push(registration) },
    create: options => createClientModuleSystem(target, { id: BOOTSTRAP_ID, exports: {} }, options),
  }
  const modules = target.create({
    boot: graph,
    staticModules,
    loadBundle: async (url) => { loaded.push(url) },
  })
  return { modules, loaded }
}

/** Recording progress sink. */
function stateSink(): { states: Map<string, EntryStateLabel[]>; onEntryState: (name: string, state: EntryStateLabel) => void } {
  const states = new Map<string, EntryStateLabel[]>()
  return {
    states,
    onEntryState: (name, state) => { states.set(name, [...(states.get(name) ?? []), state]) },
  }
}

describe('bootClient', () => {
  it('activates every seeded row without touching the bundle transport', async () => {
    const graph = graphOf(['provider', 'consumer'])
    const { modules, loaded } = modulesOf(graph, {
      provider: { apply: (ctx: Context) => { ctx.reflect.provide('x', { marker: 'x' }) } },
      consumer: { inject: ['x'], apply: () => {} },
    })
    const ctx = new Context()
    const sink = stateSink()

    await bootClient({ ctx, modules, manifest: modules.manifest, onEntryState: sink.onEntryState })

    expect(loaded).toEqual([])
    const consumer = sink.states.get('consumer') ?? []
    expect(consumer[0]).toBe('loading')
    expect(consumer.at(-1)).toBe('active')
    expect(sink.states.get('provider')?.at(-1)).toBe('active')
    await ctx.fiber.dispose()
  })

  it('reports a row waiting on a service the roster never provides', async () => {
    const graph = graphOf(['orphan'])
    const { modules } = modulesOf(graph, { orphan: { inject: ['nothing'], apply: () => {} } })
    const ctx = new Context()

    await expect(bootClient({ ctx, modules, manifest: modules.manifest })).rejects.toThrow(
      'orphan: pending (waiting for service: nothing)',
    )
    await ctx.fiber.dispose()
  })

  it('removes an optional row that waits on an unavailable service while keeping core boot active', async () => {
    const graph: WebBootGraph = {
      ...graphOf(['core', 'addon']),
      entries: [
        { id: 'core', url: '/core.js', rev: '1' },
        { id: 'addon', url: '/addon.js', rev: '1', optional: true },
      ],
    }
    const { modules } = modulesOf(graph, {
      core: { apply: () => {} },
      addon: { inject: ['unavailableAddonService'], apply: () => {} },
    })
    const ctx = new Context()
    await bootClient({ ctx, modules, manifest: modules.manifest })
    expect(Array.from(ctx.loader.entries(), entry => entry.options.name)).toEqual(['core', 'addon'])
    expect(ctx.loader.resolve(Array.from(ctx.loader.entries()).find(entry => entry.options.name === 'addon')!.id).fiber?.state)
      .not.toBe(FIBER_STATE.ACTIVE)
    await ctx.fiber.dispose()
  })

  it('removes an optional row when its apply function fails', async () => {
    const graph = graphOf(['core', 'addon'])
    graph.entries[1]!.optional = true
    const { modules } = modulesOf(graph, {
      core: { apply: () => {} },
      addon: { apply: () => { throw new Error('optional failure') } },
    })
    const ctx = new Context()
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await bootClient({ ctx, modules, manifest: modules.manifest })
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(Array.from(ctx.loader.entries(), entry => entry.options.name)).toEqual(['core'])
    } finally {
      log.mockRestore()
      await ctx.fiber.dispose()
    }
  })

  it('removes an optional row whose bundle never registers a factory while preserving required entries', async () => {
    const graph = graphOf(['core', 'addon'])
    graph.entries[1]!.optional = true
    const { modules } = modulesOf(graph, { core: { apply: () => {} } })
    const ctx = new Context()
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await bootClient({ ctx, modules, manifest: modules.manifest })
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(Array.from(ctx.loader.entries(), entry => entry.options.name)).toEqual(['core'])
      expect(log).toHaveBeenCalledWith(
        expect.stringContaining('optional client component addon could not be loaded'),
        expect.any(Error),
      )
    } finally {
      log.mockRestore()
      await ctx.fiber.dispose()
    }
  })

  it('keeps the app booted when an optional dependency and its consumer cannot load', async () => {
    const graph: WebBootGraph = {
      rev: 'graph',
      entries: [
        { id: 'core', url: '/core.js', rev: '1' },
        { id: 'addon', url: '/addon.js', rev: '1', optional: true },
        { id: 'screen', url: '/screen.js', rev: '1', optional: true, external: ['addon/client'] },
      ],
      batches: [{ phase: 'application', url: '/application.js', rev: 'batch', entries: ['core', 'addon', 'screen'] }],
    }
    const { modules } = modulesOf(graph, { core: { apply: () => {} } })
    const ctx = new Context()
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await bootClient({ ctx, modules, manifest: modules.manifest })
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(Array.from(ctx.loader.entries(), entry => entry.options.name)).toEqual(['core'])
    } finally {
      log.mockRestore()
      await ctx.fiber.dispose()
    }
  })

  it('activates a healthy optional service provider and its optional consumer after core boot', async () => {
    const graph: WebBootGraph = {
      rev: 'graph',
      entries: [
        { id: 'core', url: '/core.js', rev: '1' },
        { id: 'addon', url: '/addon.js', rev: '1', optional: true },
        { id: 'consumer', url: '/consumer.js', rev: '1', optional: true, inject: ['addon'] },
      ],
      batches: [{ phase: 'application', url: '/application.js', rev: 'batch', entries: ['core', 'addon', 'consumer'] }],
    }
    const { modules } = modulesOf(graph, {
      core: { apply: () => {} },
      addon: { apply: (ctx: Context) => { ctx.provide('addon', { available: true }) } },
      consumer: { inject: ['addon'], apply: (ctx: Context) => { expect(ctx.get('addon')).toEqual({ available: true }) } },
    })
    const ctx = new Context()
    const sink = stateSink()
    await bootClient({ ctx, modules, manifest: modules.manifest, onEntryState: sink.onEntryState })
    for (let attempt = 0; attempt < 10 && sink.states.get('consumer')?.at(-1) !== 'active'; attempt++) {
      await new Promise(resolve => setImmediate(resolve))
    }
    expect(sink.states.get('addon')?.at(-1)).toBe('active')
    expect(sink.states.get('consumer')?.at(-1)).toBe('active')
    await ctx.fiber.dispose()
  })

  it('surfaces the Loader import error for a row that is neither seeded nor a graph row', async () => {
    const { modules } = modulesOf(graphOf(['seeded']), { seeded: { apply: () => {} } })
    const manifest = parseBootManifest(graphOf(['ghost']))
    const ctx = new Context()
    const sink = stateSink()

    await expect(bootClient({ ctx, modules, manifest, onEntryState: sink.onEntryState })).rejects.toThrow(
      /failed to import loader entry \S+ \(ghost\): client-modules: cannot resolve/,
    )
    expect(sink.states.get('ghost')).toEqual(['loading'])
    await ctx.fiber.dispose()
  })
})

describe('assertEntriesActive', () => {
  interface FakeEntry { name: string; fiber?: { state: number; inject: Record<string, null> } }

  /** Loader-shaped double: entries with scripted fiber states, services by name. */
  function auditCtx(entries: readonly FakeEntry[], services: Record<string, unknown> = {}): Context {
    return {
      loader: {
        * entries() {
          for (const entry of entries) yield { options: { name: entry.name }, fiber: entry.fiber }
        },
      },
      get: (name: string) => services[name],
    } as unknown as Context
  }

  it('passes when every entry is active', () => {
    expect(() => { assertEntriesActive(auditCtx([{ name: 'a', fiber: { state: FIBER_STATE.ACTIVE, inject: {} } }])) }).not.toThrow()
  })

  it('names import failures, missing services, and other non-active states', () => {
    const ctx = auditCtx([
      { name: 'lost' },
      { name: 'waiting', fiber: { state: FIBER_STATE.PENDING, inject: { present: null, a: null, b: null } } },
      { name: 'opaque', fiber: { state: FIBER_STATE.PENDING, inject: {} } },
      { name: 'broken', fiber: { state: FIBER_STATE.FAILED, inject: {} } },
    ], { present: {} })

    expect(() => { assertEntriesActive(ctx) }).toThrow([
      'web boot: 4 entries did not activate',
      'lost: import failed (see console for the import error)',
      'waiting: pending (waiting for services: a, b)',
      'opaque: pending (waiting for services: unknown)',
      'broken: failed',
    ].join('\n'))
  })

  it('uses the singular form for one failing entry', () => {
    expect(() => { assertEntriesActive(auditCtx([{ name: 'lost' }])) }).toThrow('web boot: 1 entry did not activate\n')
  })
})
