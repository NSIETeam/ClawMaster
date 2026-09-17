/** Browser actions exercised under the production Host response policy. */
import { DynamicCordisStyles, evaluateClientHalf } from '../../../packages/extensions/cordis-client-runner/src/client/evaluator.ts'
import type { DynamicCordisClientSource } from '@deepseek-ai/dsh-api-remotes/client'

document.querySelector('#run')!.addEventListener('click', () => {
  void (async () => {
    const response = await fetch('/source')
    if (!response.ok) {
      document.body.dataset.result = 'refused'
      return
    }
    const source = await response.json() as DynamicCordisClientSource
    const plugin = await evaluateClientHalf(source.pluginId, source.code, {
      invoke: () => Promise.resolve(null),
      noteError: () => {},
    }, new DynamicCordisStyles(source.pluginId))
    if (typeof plugin === 'function') plugin({})
    else plugin.apply({})
    document.body.dataset.result = 'loaded'
  })().catch((error: unknown) => { document.body.dataset.result = String(error) })
})

document.querySelector('#attack')!.addEventListener('click', () => {
  const violations: string[] = []
  document.addEventListener('securitypolicyviolation', (event) => {
    violations.push(event.effectiveDirective)
    document.body.dataset.violations = JSON.stringify(violations)
    document.body.dataset.violationCount = String(violations.length)
  })
  const styleNonce = document.querySelector<HTMLMetaElement>('meta[name="dsh-style-nonce"]')!.content
  for (const nonce of ['', 'wrong-nonce', styleNonce]) {
    const script = document.createElement('script')
    script.nonce = nonce
    script.textContent = 'document.body.dataset.injected = "true"'
    document.head.append(script)
    script.remove()
  }
  const button = document.createElement('button')
  button.setAttribute('onclick', 'document.body.dataset.injected = "true"')
  document.body.append(button)
  button.click()
  button.remove()
  try {
    // oxlint-disable-next-line typescript/no-implied-eval -- negative CSP probe.
    const probe = new Function('document.body.dataset.injected = "true"') as () => void
    probe()
  } catch (error) {
    document.body.dataset.evalError = (error as Error).name
  }
})

document.body.dataset.ready = 'true'
