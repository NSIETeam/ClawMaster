/** Generate desktop icon formats from the shared ClawMaster vector artwork. */
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const source = resolve(desktop, '../../frontends/dsh/src/clawmaster.svg')
const require = createRequire(import.meta.url)
const output = mkdtempSync(join(tmpdir(), 'clawmaster-vector-icons-'))
const formats = ['32x32.png', '64x64.png', '128x128.png', '128x128@2x.png', 'icon.png', 'icon.ico', 'icon.icns']

try {
  execFileSync(process.execPath, [require.resolve('@tauri-apps/cli/tauri.js'), 'icon', source, '--output', output], {
    cwd: desktop, stdio: ['ignore', 'pipe', 'pipe'],
  })
  const targets = formats.map(name => [join(output, name), join(desktop, 'src-tauri/icons', name)])
  targets.push([join(output, 'icon.png'), join(desktop, 'app-icon.png')])
  for (const [generated, target] of targets) {
    mkdirSync(dirname(target), { recursive: true })
    copyFileSync(generated, target)
  }
  console.log('ClawMaster vector icons generated.')
} finally {
  rmSync(output, { recursive: true, force: true })
}
