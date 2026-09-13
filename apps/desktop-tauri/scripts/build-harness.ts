/** Build and verify the ClawMaster browser artifacts embedded by Tauri. */
import { spawnSync } from 'node:child_process'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  assertClientBuildEnvironment,
  clientBuildProcessEnvironment,
  readClientBuildRecord,
  writeClientBuildRecord,
} from '../../../scripts/client-build-environment.ts'
import { captureBuildSource, desktopBuildMode, HARNESS_PROVENANCE_PATH, recordHarnessBuild, verifyHarnessBuild } from './build-provenance.mjs'

const CLIENT_BRAND = {
  DSH_CLIENT_BUILD_PROFILE: 'clawmaster',
  DSH_CLIENT_TITLE: 'ClawMaster',
} as const

/** Keep the Web icon byte-identical to the frontend's vector artwork. */
function desktopFavicon(root: string): string {
  const icon = readFileSync(resolve(root, 'frontends/dsh/src/clawmaster.svg'), 'utf8')
  if (!/<svg\b/u.test(icon) || !/<path\b/u.test(icon)
    || /<(?:[\w-]+:)?(?:image|feImage|foreignObject)\b|data:image\//iu.test(icon)) {
    throw new Error('ClawMaster icon must contain SVG paths without embedded or linked images')
  }
  return icon
}

/**
 * Brand the Web install metadata and favicon after a complete desktop client build.
 * @param root - Repository containing verified ClawMaster client artifacts and the shared vector artwork.
 */
export function brandClawMasterWebAssets(root: string): void {
  const record = readClientBuildRecord(root)
  assertClientBuildEnvironment(record.environment, { ...record.environment, ...CLIENT_BRAND })
  const icon = desktopFavicon(root)
  const manifestPath = resolve(root, 'apps/web/dist/manifest.webmanifest')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>
  writeFileSync(manifestPath, `${JSON.stringify({ ...manifest, name: 'ClawMaster', short_name: 'ClawMaster' }, null, 2)}\n`)
  writeFileSync(resolve(root, 'apps/web/dist/favicon.svg'), icon)
  writeClientBuildRecord(root, record.environment)
}

/**
 * Reject stale or differently branded artifacts before packaging.
 * @param root - Repository containing the complete client build record.
 */
export function verifyClawMasterClient(root: string): void {
  const record = readClientBuildRecord(root)
  assertClientBuildEnvironment(record.environment, { ...record.environment, ...CLIENT_BRAND })
  const manifest = JSON.parse(readFileSync(resolve(root, 'apps/web/dist/manifest.webmanifest'), 'utf8')) as Record<string, unknown>
  if (manifest.name !== 'ClawMaster' || manifest.short_name !== 'ClawMaster') {
    throw new Error('ClawMaster Web install metadata has upstream branding')
  }
  if (readFileSync(resolve(root, 'apps/web/dist/favicon.svg'), 'utf8') !== desktopFavicon(root)) {
    throw new Error('ClawMaster Web favicon differs from the desktop icon')
  }
}

/**
 * Select ClawMaster branding independently of an inherited upstream build profile.
 * @param environment - Parent environment; non-client values remain available to build tools.
 * @returns Build environment with the product's public title and profile.
 */
export function clawmasterBuildEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return clientBuildProcessEnvironment(environment, CLIENT_BRAND)
}

function main(): void {
  const root = resolve(import.meta.dirname, '../../..')
  const mode = desktopBuildMode()
  if (process.argv[2] !== '--check') {
    const source = captureBuildSource(root, mode)
    rmSync(resolve(root, HARNESS_PROVENANCE_PATH), { force: true })
    const result = spawnSync(process.execPath, ['--import', 'tsx/esm', resolve(root, 'scripts/build.ts')], {
      cwd: root,
      env: clawmasterBuildEnvironment(process.env),
      stdio: 'inherit',
    })
    if (result.error !== undefined) throw result.error
    if (result.status !== 0) process.exit(result.status ?? 1)
    brandClawMasterWebAssets(root)
    recordHarnessBuild(root, source, mode)
  }
  verifyClawMasterClient(root)
  verifyHarnessBuild(root, mode)
  console.log('ClawMaster client branding and artifact digest verified')
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) main()
