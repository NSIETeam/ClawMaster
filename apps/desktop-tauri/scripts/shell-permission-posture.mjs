/** Audit the desktop shell's content-security policy and native-command grants against the reviewed posture. */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The only WebView allowed to reach native window commands.
 * The Host content WebView renders remote and workspace content and must not receive them.
 */
export const REVIEWED_WEBVIEWS = ['main']

/** Native commands the main WebView is granted, each a window or app control with no filesystem or network reach. */
export const REVIEWED_PERMISSIONS = [
  'core:window:allow-start-dragging',
  'allow-set-close-action',
  'allow-dismiss-close-prompt',
  'allow-restart-app',
]

/** Required value for every directive that must stay closed, keyed by directive name. */
export const CLOSED_CSP_DIRECTIVES = {
  'default-src': "'none'",
  'object-src': "'none'",
  'frame-src': "'none'",
  'base-uri': "'none'",
  'form-action': "'none'",
}

/** Directives the shell serves its own bundled assets from, which must stay same-origin and free of inline or eval allowances. */
export const SELF_ONLY_CSP_DIRECTIVES = ['script-src', 'style-src', 'img-src']

const FORBIDDEN_SOURCES = ["'unsafe-inline'", "'unsafe-eval'", '*']

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** @param {string} text @returns {string[]} Every occurrence of a source expression the posture forbids. */
function forbiddenSources(text) {
  return FORBIDDEN_SOURCES.filter(source => text.includes(source))
}

/**
 * Compare the shipped shell configuration with the reviewed posture.
 * Every finding names the exact directive, permission, or WebView that diverged.
 * @param {{confPath:string, capabilitiesDir:string}} paths
 * @returns {{ok:boolean, findings:{id:string, problem:string, evidence:string}[], csp:Record<string,string>, webviews:string[], permissions:string[]}}
 */
export function auditShellPosture({ confPath, capabilitiesDir }) {
  const findings = []
  const conf = JSON.parse(readFileSync(confPath, 'utf8'))
  const csp = conf?.app?.security?.csp
  const directives = isRecord(csp) ? csp : {}

  if (!isRecord(csp)) {
    findings.push({ id: 'csp-missing', problem: 'The shell carries no content-security policy object.', evidence: `app.security.csp = ${JSON.stringify(csp ?? null)}` })
  } else {
    for (const [directive, required] of Object.entries(CLOSED_CSP_DIRECTIVES)) {
      const actual = directives[directive]
      if (actual !== required) {
        findings.push({ id: `csp-${directive}-open`, problem: `${directive} must stay ${required} so the shell cannot load or embed foreign content.`, evidence: `${directive} = ${JSON.stringify(actual ?? null)}` })
      }
    }
    for (const directive of SELF_ONLY_CSP_DIRECTIVES) {
      const actual = directives[directive]
      if (typeof actual !== 'string' || !actual.includes("'self'")) {
        findings.push({ id: `csp-${directive}-not-self`, problem: `${directive} must allow the bundled shell assets through 'self'.`, evidence: `${directive} = ${JSON.stringify(actual ?? null)}` })
        continue
      }
      const forbidden = forbiddenSources(actual)
      if (forbidden.length > 0) {
        findings.push({ id: `csp-${directive}-forbidden-source`, problem: `${directive} admits a source the reviewed posture rejects.`, evidence: `${directive} = ${JSON.stringify(actual)} contains ${forbidden.join(', ')}` })
      }
    }
  }

  const capabilityFiles = readdirSync(capabilitiesDir).filter(name => name.endsWith('.json')).sort()
  const webviews = []
  const permissions = []
  for (const name of capabilityFiles) {
    const capability = JSON.parse(readFileSync(join(capabilitiesDir, name), 'utf8'))
    const declared = Array.isArray(capability.webviews) ? capability.webviews : []
    for (const webview of declared) {
      webviews.push(webview)
      if (!REVIEWED_WEBVIEWS.includes(webview)) {
        findings.push({ id: 'capability-webview-unreviewed', problem: 'A WebView outside the reviewed set is granted native commands.', evidence: `${name}: webviews includes ${JSON.stringify(webview)}` })
      }
    }
    const granted = Array.isArray(capability.permissions) ? capability.permissions : []
    for (const permission of granted) {
      permissions.push(typeof permission === 'string' ? permission : permission?.identifier)
      const identifier = typeof permission === 'string' ? permission : permission?.identifier
      if (!REVIEWED_PERMISSIONS.includes(identifier)) {
        findings.push({ id: 'capability-permission-unreviewed', problem: 'A native command was granted without extending the reviewed posture.', evidence: `${name}: permission ${JSON.stringify(identifier)}` })
      }
    }
  }

  return { ok: findings.length === 0, findings, csp: /** @type {Record<string,string>} */ (directives), webviews, permissions }
}

/**
 * Resolve the shell configuration inside a checkout.
 * @param {string} root Repository root.
 * @returns {{confPath:string, capabilitiesDir:string}}
 */
export function shellConfigPaths(root) {
  const tauri = join(root, 'apps', 'desktop-tauri', 'src-tauri')
  return { confPath: join(tauri, 'tauri.conf.json'), capabilitiesDir: join(tauri, 'capabilities') }
}
