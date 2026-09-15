/** Finite first-install utility; DSH remains the only application launcher. */
import { parseArgs } from 'node:util'
import { resolve } from 'node:path'
import { installUpdater } from './installer.ts'

const { values } = parseArgs({ options: {
  'dsh-home': { type: 'string' }, 'runtime-root': { type: 'string' }, yes: { type: 'boolean', default: false }, help: { type: 'boolean', default: false },
  'expected-sha256': { type: 'string' }, 'expected-patch-revision': { type: 'string' },
} })
if (values.help) {
  process.stdout.write('ClawMaster 更新插件首次安装工具\n用法: node install.mjs --dsh-home <DSH_HOME> --runtime-root <运行时目录>\n确认安装时追加 --yes --expected-sha256 <计划中的sha256> --expected-patch-revision <计划中的expectedPatchRevision>\n未加 --yes 时只显示计划。已存在的更新插件不会被覆盖。\n')
} else {
  const dshHome = values['dsh-home'] ?? process.env.DSH_HOME
  if (!dshHome) throw new Error('请指定 --dsh-home，或从已设置 DSH_HOME 的 ClawMaster 会话运行。')
  const result = await installUpdater({ dshHome: resolve(dshHome), runtimeRoot: resolve(values['runtime-root'] ?? process.cwd()), confirmed: values.yes,
    ...(values['expected-sha256'] ? { expectedSha256: values['expected-sha256'] } : {}),
    ...(values['expected-patch-revision'] ? { expectedPatchRevision: values['expected-patch-revision'] } : {}),
  })
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
}
