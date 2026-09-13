// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { en as commonEn } from '@deepseek-ai/dsh-client-locale/src/locales/en.ts'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { en, zh } from '../src/client/locale.ts'
import { ReasoningRow } from '../src/client/chat/ReasoningRow.tsx'
import { ContextInjectionRow } from '../src/client/chat/ContextInjectionRow.tsx'

afterEach(() => {
  cleanup()
  vi.unstubAllEnvs()
})

describe.each([
  ['en', makeTranslate(en, commonEn)],
  ['zh', makeTranslate(zh, commonZh)],
] as const)('ClawMaster process disclosures (%s)', (_locale, t) => {
  it('keeps reasoning out of the collapsed DOM through streaming and completion', () => {
    vi.stubEnv('DSH_CLIENT_BUILD_PROFILE', 'clawmaster')
    const view = render(<ReasoningRow text="private reasoning" running t={t} />)
    expect(view.container.textContent).not.toContain('private reasoning')
    expect(view.getByRole('button').getAttribute('aria-expanded')).toBe('false')
    view.rerender(<ReasoningRow text="private reasoning\ncompleted reasoning" running={false} t={t} />)
    expect(view.container.textContent).not.toContain('completed reasoning')
    expect(view.container.textContent).toMatchSnapshot()
    fireEvent.click(view.getByRole('button'))
    expect(view.container.textContent).toContain('completed reasoning')
    view.rerender(<ReasoningRow text="private reasoning\nupdated reasoning" running t={t} />)
    expect(view.getByRole('button').getAttribute('aria-expanded')).toBe('true')
    expect(view.container.textContent).toContain('updated reasoning')
    fireEvent.click(view.getByRole('button'))
    view.rerender(<ReasoningRow text="private reasoning\nfinal reasoning" running={false} t={t} />)
    expect(view.container.textContent).not.toContain('final reasoning')
  })

  it('keeps memory source visible and reveals its recorded body only on demand', () => {
    vi.stubEnv('DSH_CLIENT_BUILD_PROFILE', 'clawmaster')
    const props = {
      t, source: { kind: 'memory', form: 'notice', summary: 'private memory summary' },
      provenance: { role: 'inject' as const, label: 'OpenViking Memory' },
      form: 'notice' as const,
      content: [{ type: 'text' as const, text: 'private memory body' }],
    }
    const view = render(<ContextInjectionRow {...props} />)
    expect(view.container.textContent).toContain('OpenViking Memory')
    expect(view.container.textContent).not.toContain('private memory')
    expect(view.container.querySelector('[data-context-injection-body]')).toBeNull()
    expect(view.container.textContent).toMatchSnapshot()
    fireEvent.click(view.getByRole('button'))
    expect(view.container.textContent).toContain('private memory body')
    view.rerender(<ContextInjectionRow {...props} content={[{ type: 'text', text: 'updated memory body' }]} />)
    expect(view.container.textContent).toContain('updated memory body')
    expect(view.getByRole('button').getAttribute('aria-expanded')).toBe('true')
  })
})
