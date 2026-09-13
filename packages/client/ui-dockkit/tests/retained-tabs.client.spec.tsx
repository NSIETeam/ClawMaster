// @vitest-environment jsdom
/** Tab body lifetimes under the docked surface's explicit retention option. */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { useEffect, useState } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { DockSurface } from '../src/components/DockSurface.tsx'
import { DockController } from '../src/engine/controller.ts'
import type { TabId } from '../src/contract/types.ts'
import { TEST_LABELS } from './fixtures.client.ts'

afterEach(cleanup)

/** Drive the real surface with stable tab identities and observable editor-local state. */
function fixture(keepVisitedTabsMounted: boolean) {
  const controller = new DockController()
  const first = controller.openContent({ contentId: 'first.csv', title: 'First', kind: 'file' })
  const second = controller.openContent({ contentId: 'files', title: 'Files', kind: 'file' })
  const unvisited = controller.openContent({ contentId: 'unvisited.csv', title: 'Unvisited', kind: 'file' })
  controller.focusTab(first)
  const mounted = vi.fn()
  const disposed = vi.fn()
  function Editor({ id }: { id: TabId }) {
    const [draft, setDraft] = useState('disk content')
    useEffect(() => {
      mounted(id)
      return () => { disposed(id) }
    }, [id])
    return <input aria-label={`draft ${id}`} value={draft} onChange={(event) => { setDraft(event.currentTarget.value) }} />
  }
  const surface = () => (
    <DockSurface
      state={controller.getSnapshot().state}
      canSplit={false}
      intents={controller}
      labels={TEST_LABELS}
      {...keepVisitedTabsMounted ? { keepVisitedTabsMounted: true } : {}}
      renderTab={tab => <Editor key={tab.id} id={tab.id} />}
    />
  )
  const view = render(surface())
  return {
    first, second, unvisited, mounted, disposed,
    select(id: TabId) { controller.focusTab(id); view.rerender(surface()) },
    close(id: TabId) { controller.closeTab(id); view.rerender(surface()) },
    setRetention(value: boolean) { keepVisitedTabsMounted = value; view.rerender(surface()) },
    input(id: TabId) { return screen.getByLabelText<HTMLInputElement>(`draft ${id}`) },
    unmount: view.unmount,
  }
}

it('keeps the default active-only lifetime and loses component-local drafts on a round trip', () => {
  const tabs = fixture(false)
  fireEvent.change(tabs.input(tabs.first), { target: { value: 'unsaved draft' } })
  tabs.select(tabs.second)
  expect(screen.queryByLabelText(`draft ${tabs.first}`)).toBeNull()
  expect(tabs.disposed).toHaveBeenCalledWith(tabs.first)
  tabs.select(tabs.first)
  expect(tabs.input(tabs.first).value).toBe('disk content')
})

it('mounts only visited tabs and retains each draft across repeated selection', () => {
  const tabs = fixture(true)
  const first = tabs.input(tabs.first)
  expect(tabs.mounted.mock.calls).toEqual([[tabs.first]])
  expect(screen.queryByLabelText(`draft ${tabs.second}`)).toBeNull()
  expect(screen.queryByLabelText(`draft ${tabs.unvisited}`)).toBeNull()
  fireEvent.change(first, { target: { value: 'first unsaved' } })
  tabs.select(tabs.second)
  const second = tabs.input(tabs.second)
  fireEvent.change(second, { target: { value: 'second unsaved' } })
  tabs.select(tabs.first)
  expect(tabs.input(tabs.first)).toBe(first)
  expect(first.value).toBe('first unsaved')
  tabs.select(tabs.second)
  expect(tabs.input(tabs.second)).toBe(second)
  expect(second.value).toBe('second unsaved')
  expect(tabs.mounted.mock.calls).toEqual([[tabs.first], [tabs.second]])
  expect(tabs.disposed).not.toHaveBeenCalled()
  expect(screen.queryByLabelText(`draft ${tabs.unvisited}`)).toBeNull()
})

it('hides inactive bodies, removes interaction and releases their focused control', () => {
  const tabs = fixture(true)
  const input = tabs.input(tabs.first)
  const body = input.closest<HTMLElement>('[data-dockkit-tab-body]')
  expect(body).not.toBeNull()
  input.focus()
  expect(document.activeElement).toBe(input)
  tabs.select(tabs.second)
  expect(body?.hidden).toBe(true)
  expect(body?.inert).toBe(true)
  expect(body?.getAttribute('aria-hidden')).toBe('true')
  expect(document.activeElement).not.toBe(input)
  tabs.select(tabs.first)
  expect(body?.hidden).toBe(false)
  expect(body?.inert).toBe(false)
  expect(body?.hasAttribute('aria-hidden')).toBe(false)
  const stylesheet = readFileSync(resolve(import.meta.dirname, '../src/components/dockkit.module.css'), 'utf8')
  expect(stylesheet).toMatch(/\.retainedBody\[hidden\]\s*\{\s*display:\s*none;/u)
})

it('releases a closed inactive tab and every remaining body when the surface unmounts', () => {
  const tabs = fixture(true)
  tabs.select(tabs.second)
  tabs.close(tabs.first)
  expect(tabs.disposed.mock.calls).toEqual([[tabs.first]])
  expect(screen.queryByLabelText(`draft ${tabs.first}`)).toBeNull()
  expect(tabs.input(tabs.second)).toBeDefined()
  tabs.unmount()
  expect(tabs.disposed.mock.calls).toEqual([[tabs.first], [tabs.second]])
  expect(tabs.mounted).not.toHaveBeenCalledWith(tabs.unvisited)
})

it('retains the empty-pane message when the option is enabled', () => {
  const controller = new DockController()
  const renderTab = vi.fn()
  render(
    <DockSurface state={controller.getSnapshot().state} canSplit={false} intents={controller}
      labels={TEST_LABELS} keepVisitedTabsMounted renderTab={renderTab} />,
  )
  expect(screen.getByText(TEST_LABELS.emptyPane)).toBeDefined()
  expect(renderTab).not.toHaveBeenCalled()
})

it('releases retained bodies when the surface returns to the default mount policy', () => {
  const tabs = fixture(true)
  tabs.select(tabs.second)
  tabs.setRetention(false)
  expect(tabs.disposed.mock.calls).toEqual([[tabs.first], [tabs.second]])
  expect(screen.queryByLabelText(`draft ${tabs.first}`)).toBeNull()
  expect(tabs.mounted.mock.calls).toEqual([[tabs.first], [tabs.second], [tabs.second]])
})
