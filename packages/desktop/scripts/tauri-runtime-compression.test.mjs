import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptsRoot = path.dirname(fileURLToPath(import.meta.url));

describe('Tauri Agent runtime compression contract', () => {
  it('uses one Brotli artifact consistently from staging through verification', async () => {
    const [
      prepare,
      binaryCapsule,
      directoryCapsule,
      agentBootstrap,
      parentLifetime,
      verify,
      agentSmoke,
      rpaSmoke,
      tauriConfig,
      rustSidecar,
    ] = await Promise.all([
      readFile(path.join(scriptsRoot, 'prepare-tauri-runtime.mjs'), 'utf8'),
      readFile(path.join(scriptsRoot, 'binary-capsule.mjs'), 'utf8'),
      readFile(path.join(scriptsRoot, 'directory-capsule.mjs'), 'utf8'),
      readFile(path.join(scriptsRoot, 'agent-capsule-bootstrap.mjs'), 'utf8'),
      readFile(path.join(scriptsRoot, 'sidecar-parent-lifetime.mjs'), 'utf8'),
      readFile(path.join(scriptsRoot, 'verify-tauri-bundle.mjs'), 'utf8'),
      readFile(path.join(scriptsRoot, 'smoke-tauri-agent-runtime.mjs'), 'utf8'),
      readFile(path.join(scriptsRoot, 'smoke-tauri-rpa-runtime.mjs'), 'utf8'),
      readFile(path.join(scriptsRoot, '..', 'src-tauri', 'tauri.conf.json'), 'utf8'),
      readFile(path.join(scriptsRoot, '..', 'src-tauri', 'src', 'agent_sidecar.rs'), 'utf8'),
    ]);
    expect(prepare).toContain("agent.br");
    expect(prepare).toContain("agent-manifest.json");
    expect(prepare).toContain('writeDirectoryCapsule');
    expect(prepare).toContain('CLAWMASTER_AGENT_ROOT');
    expect(prepare).toContain('readVerifiedBinaryCapsule');
    expect(prepare).toContain("run('strip', ['-x', sidecarPath])");
    expect(prepare).toContain("probe-packaged-sqlcipher.mjs");
    expect(prepare).not.toContain("run('strip', [sidecarPath])");
    expect(verify).toContain("agent.br");
    expect(verify).toContain('materializeDirectoryCapsule');
    expect(verify).toContain('readVerifiedBinaryCapsule');
    expect(verify).toContain("probe-packaged-sqlcipher.mjs");
    expect(prepare).toContain("node.br");
    expect(prepare).toContain("node-manifest.json");
    expect(prepare).toMatch(/capsuleName: 'node\.br',[\s\S]*?quality: 11,/u);
    expect(prepare).toContain("rg.br");
    expect(prepare).toContain("rg-manifest.json");
    expect(prepare).toMatch(/capsuleName: 'rg\.br',[\s\S]*?quality: 10,/u);
    expect(verify).toContain("node.br");
    expect(agentSmoke).toContain("node.br");
    expect(agentSmoke).toContain('readVerifiedBinaryCapsule');
    expect(agentSmoke).toContain("agent.br");
    expect(agentSmoke).not.toContain("'binaries'");
    expect(rpaSmoke).toContain('materializeDirectoryCapsule');
    expect(agentBootstrap).toContain('materializeDirectoryCapsule');
    expect(agentBootstrap).toContain('CLAWMASTER_AGENT_ROOT');
    expect(agentBootstrap).toContain('CLAWMASTER_PARENT_PIPE');
    expect(parentLifetime).toContain("input.once('end', stop)");
    expect(prepare).toContain('sidecar-parent-lifetime.mjs');
    expect(rustSidecar).toContain("node-manifest.json");
    expect(rustSidecar).toContain("brotli::Decompressor");
    expect(rustSidecar).toContain("materialize_ripgrep_capsule");
    expect(rustSidecar).toContain('.stdin(Stdio::piped())');
    expect(binaryCapsule).toContain('brotliCompressSync');
    expect(binaryCapsule).toContain('brotliDecompressSync');
    expect(directoryCapsule).toContain('brotliCompressSync');
    expect(directoryCapsule).toContain('brotliDecompressSync');
    expect(rustSidecar).not.toContain('find_sidecar');
    expect(tauriConfig).not.toContain('"externalBin"');
    expect(prepare).toContain('rmSync(binariesRoot, { recursive: true, force: true })');
    expect(`${prepare}\n${verify}`).not.toContain('server.mjs.br');
    expect(`${prepare}\n${verify}`).not.toContain('server.mjs.gz');
  });

  it('copies only executable native JavaScript into the packaged runtime', async () => {
    const prepare = await readFile(
      path.join(scriptsRoot, 'prepare-tauri-runtime.mjs'),
      'utf8',
    );
    expect(prepare).toContain("'dist', 'index.js'");
    expect(prepare).not.toContain("'otto-native', 'dist'), path.join(nativeDestination, 'dist'), { recursive: true }");
    expect(prepare).toContain("['lib', 'tools']");
    expect(prepare).toContain("['lib', 'entry']");
  });

  it('keeps optional Agent capabilities out of the resident entry module', async () => {
    const prepare = await readFile(
      path.join(scriptsRoot, 'prepare-tauri-runtime.mjs'),
      'utf8',
    );
    expect(prepare).toContain("'--splitting'");
    expect(prepare).toContain('`server=${path.join(repoRoot');
    expect(prepare).toContain('`document=${path.join(desktopRoot');
    expect(prepare).toContain("'--entry-names=[name]'");
    expect(prepare).toContain("'--chunk-names=chunks/[name]-[hash]'");
    expect(prepare).toContain("'--out-extension:.js=.mjs'");
    expect(prepare).toContain('`--outdir=${agentPayloadRoot}`');
    expect(prepare).not.toContain('`--outfile=${path.join(agentPayloadRoot, \'server.mjs\')}`');
  });

  it('keeps the native clipboard path text-only', async () => {
    const [cargo, rustShell, systemCommands] = await Promise.all([
      readFile(path.join(scriptsRoot, '..', 'src-tauri', 'Cargo.toml'), 'utf8'),
      readFile(path.join(scriptsRoot, '..', 'src-tauri', 'src', 'lib.rs'), 'utf8'),
      readFile(path.join(scriptsRoot, '..', 'src-tauri', 'src', 'system_commands.rs'), 'utf8'),
    ]);
    expect(cargo).toContain('arboard = { version = "3.6.1", default-features = false');
    expect(cargo).not.toContain('tauri-plugin-clipboard-manager');
    expect(rustShell).not.toContain('tauri_plugin_clipboard_manager');
    expect(systemCommands).toContain('arboard::Clipboard::new()');
    expect(systemCommands).toContain('clipboard.set_text(text)');
  });

  it('prevents a second Tauri launch from starting another Agent runtime', async () => {
    const [cargo, rustShell] = await Promise.all([
      readFile(path.join(scriptsRoot, '..', 'src-tauri', 'Cargo.toml'), 'utf8'),
      readFile(path.join(scriptsRoot, '..', 'src-tauri', 'src', 'lib.rs'), 'utf8'),
    ]);
    expect(cargo).toContain('tauri-plugin-single-instance');
    expect(rustShell.indexOf('tauri_plugin_single_instance::init'))
      .toBeLessThan(rustShell.indexOf('tauri_plugin_dialog::init'));
    expect(rustShell).toContain('app.get_webview_window("main")');
    expect(rustShell).toContain('window.set_focus()');
  });
});
