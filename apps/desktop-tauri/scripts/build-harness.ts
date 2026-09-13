/** Build and verify the ClawMaster browser artifacts embedded by Tauri. */
import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  assertClientBuildEnvironment,
  clientBuildProcessEnvironment,
  readClientBuildRecord,
  writeClientBuildRecord,
} from '../../../scripts/client-build-environment.ts'

const CLIENT_BRAND = {
  DSH_CLIENT_BUILD_PROFILE: 'clawmaster',
  DSH_CLIENT_TITLE: 'ClawMaster',
} as const

/** Reuse the desktop's existing raster mark in the Web application's SVG icon endpoint. */
function desktopFavicon(root: string): string {
  const icon = readFileSync(resolve(root, 'apps/desktop-tauri/app-icon.png')).toString('base64')
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">'
    + `<image width="512" height="512" href="data:image/png;base64,${icon}"/></svg>\n`
}

/**
 * Brand the Web install metadata and favicon after a complete desktop client build.
 * @param root - Repository containing verified ClawMaster client artifacts and the desktop icon.
 */
export function brandClawMasterWebAssets(root: string): void {
  const record = readClientBuildRecord(root)
  assertClientBuildEnvironment(record.environment, { ...record.environment, ...CLIENT_BRAND })
  const manifestPath = resolve(root, 'apps/web/dist/manifest.webmanifest')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>
  writeFileSync(manifestPath, `${JSON.stringify({ ...manifest, name: 'ClawMaster', short_name: 'ClawMaster' }, null, 2)}\n`)
  writeFileSync(resolve(root, 'apps/web/dist/favicon.svg'), desktopFavicon(root))
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
  if (process.argv[2] !== '--check') {
    const result = spawnSync(process.execPath, ['--import', 'tsx/esm', resolve(root, 'scripts/build.ts')], {
      cwd: root,
      env: clawmasterBuildEnvironment(process.env),
      stdio: 'inherit',
    })
    if (result.error !== undefined) throw result.error
    if (result.status !== 0) process.exit(result.status ?? 1)
    brandClawMasterWebAssets(root)
  }
  verifyClawMasterClient(root)
  console.log('ClawMaster client branding and artifact digest verified')
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) main()
