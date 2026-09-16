/** Portable finite update utility; DSH remains the only application launcher. */
import { parseArgs } from 'node:util';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { satisfies } from 'semver';
import { inspectKit, installKit, nativeKit, repairKit } from './kit.ts';
import type { NativeTarget } from './native.ts';

try {
  if (!satisfies(process.versions.node, '^22.19 || >=24')) throw new Error('请使用 ClawMaster 自带的 Node 22.19 以上的 22.x 或 Node 24 及以上版本。');
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    'dsh-home': { type: 'string' }, 'runtime-root': { type: 'string' }, 'launch-manifest': { type: 'string' },
    yes: { type: 'boolean', default: false }, help: { type: 'boolean', default: false },
    'expected-sha256': { type: 'string' }, 'expected-patch-revision': { type: 'string' },
    'native-target': { type: 'string' }, 'expected-native-version': { type: 'string' }, 'expected-native-digest': { type: 'string' },
  } });
  if (values.help) {
    process.stdout.write('ClawMaster 更新接入包\n先运行: node update-kit.mjs inspect\n确认首次安装: node update-kit.mjs install --yes --expected-sha256 <component.sha256> --expected-patch-revision <patchRevision>\n离线应用或恢复已批准更新: node update-kit.mjs repair --yes --dsh-home <DSH_HOME>（必须先退出 Host）\n原生升级计划: node update-kit.mjs native\n下载并校验原生文件: native --yes --expected-native-version <version> --expected-native-digest <digest>\n位置参数: --dsh-home、--runtime-root、--launch-manifest；Linux 原生下载需 --native-target linux-x86_64 或 linux-x86_64-deb。\n');
  } else {
    if (positionals.length > 1) throw new Error('只支持一个操作：inspect、install、repair 或 native。');
    const action = positionals[0] ?? 'inspect';
    if (!['inspect', 'install', 'repair', 'native'].includes(action)) throw new Error('未知操作。请使用 inspect、install、repair 或 native。');
    if (action === 'inspect' && values.yes) throw new Error('inspect 只检查，不接受 --yes。');
    if (action === 'repair' && !values.yes) throw new Error('repair 会应用或恢复已批准的更新；请明确指定 --yes，并先退出 Host。');
    const home = values['dsh-home'] ?? process.env.DSH_HOME;
    const platformData = process.platform === 'darwin' ? join(homedir(), 'Library', 'Application Support')
      : process.platform === 'win32' ? process.env.APPDATA : process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share');
    const launch = values['launch-manifest'] ?? (platformData ? join(platformData, 'DeepSeek Harness', 'bin', 'dsh-launch.json') : undefined);
    const compatibility = { platform: process.platform, cwd: process.cwd(),
      ...(home ? { dshHome: resolve(home) } : {}), ...(values['runtime-root'] ? { runtimeRoot: resolve(values['runtime-root']) } : {}),
      ...(launch ? { launchManifestPath: resolve(launch) } : {}),
      ...(process.env.CLAWMASTER_RUNTIME_STATE ? { runtimeStatePath: resolve(process.env.CLAWMASTER_RUNTIME_STATE) } : {}),
      ...(process.env.CLAWMASTER_RUNTIME_RUN_ID ? { inheritedRunId: process.env.CLAWMASTER_RUNTIME_RUN_ID } : {}),
    };
    const options = { kitRoot: dirname(fileURLToPath(import.meta.url)), compatibility };
    const result = action === 'inspect' ? await inspectKit(options) : action === 'repair' ? await repairKit({ kitRoot: options.kitRoot, dshHome: home ? resolve(home) : (() => { throw new Error('repair 需要 --dsh-home 或 DSH_HOME。') })() }) : action === 'install' ? await installKit({ ...options, confirmed: values.yes,
      ...(values['expected-sha256'] ? { expectedSha256: values['expected-sha256'] } : {}), ...(values['expected-patch-revision'] ? { expectedPatchRevision: values['expected-patch-revision'] } : {}),
    }) : await nativeKit({ ...options, platform: process.platform, arch: process.arch, confirmed: values.yes,
      // Native target membership is checked against the actual platform in nativeKit.
      ...(values['native-target'] ? { target: values['native-target'] as NativeTarget } : {}),
      ...(values['expected-native-version'] ? { expectedVersion: values['expected-native-version'] } : {}), ...(values['expected-native-digest'] ? { expectedDigest: values['expected-native-digest'] } : {}),
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : '更新接入包执行失败。'}\n`);
  process.exitCode = 1;
}
