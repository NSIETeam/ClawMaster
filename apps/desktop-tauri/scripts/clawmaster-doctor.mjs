#!/usr/bin/env node
/**
 * ClawMaster doctor — point-in-time system snapshot and health checks.
 *
 * Zero-dependency (node:*) on purpose: it must run on any install, including
 * one whose harness is broken. Every check encodes an incident class that
 * actually shipped:
 *
 *  - csp-static            blank window from a content-derived page policy
 *  - profile-bundles       host died on a bundle that exists nowhere (ghost)
 *  - patch-yaml            boot crash from a patch file that lost its array
 *  - session-lock          stale locks after a hard kill
 *  - im-stall-guards       websocket stall defaults regressing on update
 *  - openviking-backend    memory backend offline + retry storms
 *  - boot-errors           supervisor-recorded failures of the last boot
 *
 * Usage:
 *   node clawmaster-doctor.mjs            human report (exit 1 on any FAIL)
 *   node clawmaster-doctor.mjs --json     machine snapshot to stdout
 *   CM_DOCTOR_HOME=/tmp/fixture node …    examine another tree (tests)
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { hostname, platform, release } from 'node:os'

const HOME = process.env.CM_DOCTOR_HOME || (execFileSync('/bin/sh', ['-c', 'echo ~']).toString().trim())
const HARNESS = process.env.CM_DOCTOR_HARNESS_ROOT
  || join(HOME, 'Library/Application Support/DeepSeek Harness')
const DSH = join(HOME, '.dsh')
const APP = '/Applications/ClawMaster.app'

const DAY_MS = 24 * 3600 * 1000

const checks = []
const check = (id, severity, summary, evidence = {}, remedy = undefined) =>
  checks.push({ id, severity, summary, evidence, ...(remedy ? { remedy } : {}) })

function dirSize(path) {
  let total = 0
  const walk = dir => {
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const p = join(dir, e.name)
      try {
        if (e.isDirectory()) walk(p)
        else total += statSync(p).size
      } catch {}
    }
  }
  walk(path)
  return total
}

function httpStatus(port, timeoutMs = 2500) {
  return new Promise(resolve => {
    const req = createServer(() => {}).listen(0) // noop: keep event loop warm
    req.close()
    const net = require('node:http').get(`http://127.0.0.1:${port}/`, res => {
      resolve(res.statusCode)
      res.resume()
    })
    net.on('error', () => resolve(0))
    net.setTimeout(timeoutMs, () => { net.destroy(); resolve(0) })
  })
}

function yamlTopLevelArray(text) {
  let sawContent = false
  for (const line of text.split('\n')) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    sawContent = true
    return t.startsWith('[') || t.startsWith('- ')
  }
  // Comment-only and empty files parse to null, which the loader rejects
  // with "must be a top-level YAML array" — the exact boot-crash incident.
  return sawContent
}

async function main() {
  const snapshot = {
    schema: 1,
    at: new Date().toISOString(),
    host: { name: hostname(), platform, release },
  }

  // Versions
  try {
    const plist = readFileSync(join(APP, 'Contents/Info.plist'), 'utf8')
    snapshot.versions = { app: /CFBundleShortVersionString<\/key>\s*<string>([^<]+)/.exec(plist)?.[1] ?? 'unknown' }
  } catch { snapshot.versions = { app: 'not-installed' } }
  const manifestPath = join(HARNESS, 'runtime', 'manifest.json')
  let manifest = null
  try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) } catch {}
  snapshot.versions.harness = manifest?.bundleSha256?.slice(0, 16) ?? 'unknown'
  const harnessRoot = manifest?.harnessRoot || join(HARNESS, 'harness-versions', snapshot.versions.harness)

  // 1) processes
  let procs = ''
  try { procs = execFileSync('/bin/ps', ['axo', 'pid,command']).toString() } catch {}
  check('desktop-process',
    procs.includes('dsh-desktop') ? 'PASS' : 'FAIL',
    procs.includes('dsh-desktop') ? 'ClawMaster 桌面进程运行中' : '未发现桌面进程',
    { running: procs.includes('dsh-desktop') })

  // 2) web host port probe
  const port = manifest?.port ?? 17890
  const status = await Promise.race([
    fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2500) })
      .then(r => r.status).catch(() => 0),
    new Promise(r => setTimeout(() => r(0), 3000)),
  ])
  check('web-host', status === 401 || status === 200 ? 'PASS' : 'FAIL',
    `web host 端口 ${port} 应答 ${status || '无连接'}（401/200 为健康）`,
    { port, status })

  // 3) harness integrity light
  const cliEntry = manifest?.cliEntry || join(harnessRoot, 'apps/cli/lib/bin.js')
  check('harness-manifest', manifest && existsSync(cliEntry) ? 'PASS' : 'FAIL',
    manifest ? `manifest 在位，CLI 入口${existsSync(cliEntry) ? '可读' : '缺失'}` : 'runtime/manifest.json 缺失或损坏',
    { manifestPresent: !!manifest, cliEntryExists: existsSync(cliEntry) })

  // 4) CSP mode — the blank-window class
  let cspPass = false, cspEvidence = {}
  for (const f of [join(harnessRoot, 'packages/host/frontend-static/lib/index.js')]) {
    try {
      const lib = readFileSync(f, 'utf8')
      const staticPolicy = lib.includes("'unsafe-eval'")
      const contentDerived = /'sha256-\$\{/.test(lib) || /style-src 'self' 'nonce-/.test(lib)
      cspEvidence = { staticPolicy, contentDerived }
      cspPass = staticPolicy && !contentDerived
    } catch { cspEvidence = { libReadable: false }; cspPass = false }
  }
  check('csp-static', cspPass ? 'PASS' : 'FAIL',
    cspPass ? '页面 CSP 为静态固定策略（白窗类别已免疫）' : '页面 CSP 为内容推导或缺失 unsafe-eval（白窗风险）',
    cspEvidence, cspPass ? undefined : '升级到含静态 CSP 的版本，或对 harness 打同款两行补丁')

  // 5) profile bundles resolvable — the ghost-bundle class
  const bundleProblems = []
  const profilesDir = join(DSH, 'profiles')
  try {
    for (const profile of readdirSync(profilesDir, { withFileTypes: true })) {
      if (!profile.isDirectory()) continue
      const pkgPath = join(profilesDir, profile.name, 'package.json')
      if (!existsSync(pkgPath)) continue
      const bundles = JSON.parse(readFileSync(pkgPath, 'utf8'))?.dsh?.profile?.bundles ?? []
      for (const name of bundles) {
        const candidates = [
          join(harnessRoot, 'apps/cli/node_modules', name),
          join(profilesDir, profile.name, 'node_modules', name),
        ]
        if (!candidates.some(c => existsSync(c))) bundleProblems.push(`${profile.name}: ${name}`)
      }
    }
  } catch {}
  check('profile-bundles', bundleProblems.length === 0 ? 'PASS' : 'FAIL',
    bundleProblems.length === 0 ? '全部 profile bundle 均可解析' : `无法解析的 bundle：${bundleProblems.join(', ')}`,
    { unresolved: bundleProblems },
    bundleProblems.length === 0 ? undefined : '从 bundle 列表移除不存在的包，或安装对应组件')

  // 6) patch YAMLs — the boot-crash class
  const patchProblems = []
  for (const p of [join(DSH, 'cordis.patch.yml'), join(DSH, 'profiles/web/cordis.patch.yml')]) {
    try {
      if (!existsSync(p)) continue
      if (!yamlTopLevelArray(readFileSync(p, 'utf8'))) patchProblems.push(p)
    } catch { patchProblems.push(p) }
  }
  check('patch-yaml', patchProblems.length === 0 ? 'PASS' : 'FAIL',
    patchProblems.length === 0 ? '用户层/profile patch 文件为合法顶层数组' : `patch 文件非顶层数组：${patchProblems.join(', ')}`,
    { broken: patchProblems }, patchProblems.length === 0 ? undefined : '将文件内容恢复为 [] 或以 "- " 开头的列表')

  // 7) sessions snapshot
  let sessionCount = 0, sessionBytes = 0, staleLocks = 0
  const sessionsDir = join(DSH, 'sessions')
  try {
    for (const ws of readdirSync(sessionsDir, { withFileTypes: true })) {
      if (!ws.isDirectory()) continue
      for (const s of readdirSync(join(sessionsDir, ws.name), { withFileTypes: true })) {
        if (!s.isDirectory()) continue
        sessionCount += 1
        sessionBytes += dirSize(join(sessionsDir, ws.name, s.name))
        if (existsSync(join(sessionsDir, ws.name, s.name, 'session.lock'))) {
          try {
            const age = Date.now() - statSync(join(sessionsDir, ws.name, s.name, 'session.lock')).mtimeMs
            if (age > DAY_MS) staleLocks += 1
          } catch {}
        }
      }
    }
  } catch {}
  check('sessions', 'PASS', `${sessionCount} 个会话，共 ${(sessionBytes / 1048576).toFixed(1)} MB`,
    { sessionCount, sessionBytes, staleLocks })
  if (staleLocks > 0) check('session-lock', 'WARN', `${staleLocks} 个超过一天的残留 session.lock`, { staleLocks }, '重启应用后仍残留可手动删除')

  // 8) disk growth
  const cutoff = Date.now() - 30 * DAY_MS
  let staleWorkspaces = 0, staleBytes = 0
  try {
    for (const e of readdirSync(join(DSH, 'watchdog-workspaces'), { withFileTypes: true })) {
      const p = join(DSH, 'watchdog-workspaces', e.name)
      try {
        if (statSync(p).mtimeMs < cutoff) { staleWorkspaces += 1; staleBytes += dirSize(p) }
      } catch {}
    }
  } catch {}
  const chroniclePath = join(HOME, 'Library/Application Support/ClawMaster/OpenViking/data/viking/clawmaster/resources/codex-memory-archive/extensions/chronicle/resources')
  let summaries = 0
  try {
    summaries = readdirSync(chroniclePath).filter(n => n.endsWith('-10min-memory-summary')).length
  } catch {}
  check('disk-growth', staleWorkspaces === 0 ? 'PASS' : 'WARN',
    `过期工作区 ${staleWorkspaces} 个 (${(staleBytes / 1048576).toFixed(0)} MB)；记忆摘要 ${summaries} 份`,
    { staleWorkspaces, staleBytes, summaries },
    staleWorkspaces === 0 ? undefined : '运行 clawmaster-maintenance 或等待每周日自动清理')

  // 9) OpenViking backend
  const llmJson = join(HOME, 'Library/Application Support/ClawMaster/OpenViking/config/llm.json')
  const legacy = (() => {
    try { return /DEEPSEEK_API_KEY:\s*\S+/.test(readFileSync(join(DSH, '.credentials.yaml'), 'utf8')) } catch { return false }
  })()
  check('openviking-backend', existsSync(llmJson) || legacy ? 'PASS' : 'WARN',
    existsSync(llmJson) || legacy ? '记忆后端 LLM 已配置' : '记忆后端未配置（摘要功能离线，已停止重试）',
    { llmJson: existsSync(llmJson), legacyRef: legacy },
    existsSync(llmJson) || legacy ? undefined : '创建 OpenViking/config/llm.json（api_base/api_key 或 keychain_account）')

  // 10) im stall guards — future-update regression tripwire
  let imPass = false, imEvidence = { found: false }
  try {
    const versionsDir = join(HARNESS, 'harness-versions')
    for (const v of readdirSync(versionsDir, { withFileTypes: true })) {
      if (!v.isDirectory()) continue
      const stores = readdirSync(join(versionsDir, v.name, 'node_modules/.pnpm'), { withFileTypes: true })
        .filter(e => e.name.startsWith('@xmanrui+dsh-im@'))
      for (const store of stores) {
        const lib = join(versionsDir, v.name, 'node_modules/.pnpm', store.name,
          'node_modules/@xmanrui/dsh-im/lib/index.js')
        if (!existsSync(lib)) continue
        const text = readFileSync(lib, 'utf8')
        imEvidence = { found: true, watchdog120: text.includes('?o:120'), reply180: text.includes('??18e4') }
        imPass = imEvidence.watchdog120 && imEvidence.reply180
      }
    }
  } catch {}
  check('im-stall-guards', imPass ? 'PASS' : (imEvidence.found ? 'FAIL' : 'WARN'),
    imPass ? '飞书长连接卡点防护在位（120s 看门狗 / 180s 回复超时）'
      : imEvidence.found ? 'dsh-im 缺失卡点防护（升级可能回退）' : '未找到 dsh-im 安装',
    imEvidence, imPass ? undefined : '升级到含 im 卡点防护的版本')

  // 11) feishu bot binding ↔ long-connection state consistency
  const feishuDir = join(HOME, '.dsh/integrations/dsh-feishu')
  try {
    const config = JSON.parse(readFileSync(join(feishuDir, 'config.json'), 'utf8'))
    const boundIds = (config.bots || []).map(b => b.id)
    const botsDir = join(feishuDir, 'bots')
    const stateIds = readdirSync(botsDir, { withFileTypes: true })
      .filter(e => e.isDirectory() && e.name.startsWith('bot_'))
      .map(e => e.name)
    const missingState = boundIds.filter(id => !stateIds.includes(id))
    const unboundStates = stateIds.filter(id => !boundIds.includes(id))
    const ok = missingState.length === 0
    check('feishu-binding', ok ? 'PASS' : 'WARN',
      ok ? `${boundIds.length} 个飞书 bot 绑定与长连接状态一致`
        : `绑定不一致：缺状态 ${missingState.join(', ') || '无'}；游离状态 ${unboundStates.join(', ') || '无'}`,
      { bound: boundIds.length, states: stateIds.length, missingState, unboundStates },
      ok ? undefined : '重新绑定该 bot 或删除游离的 bots/<id> 目录')
  } catch (error) {
    check('feishu-binding', 'WARN', `飞书绑定检查不可用: ${error.message}`, {})
  }

  // 11) last boot errors
  let bootErrors = []
  try {
    const log = readFileSync(join(HARNESS, 'boot.log'), 'utf8')
    const last = log.slice(log.lastIndexOf('=== boot session started ==='))
    bootErrors = (last.match(/^.*ERROR.*$/gm) || []).slice(0, 5)
  } catch {}
  check('boot-errors', bootErrors.length === 0 ? 'PASS' : 'WARN',
    bootErrors.length === 0 ? '本轮启动无错误' : `${bootErrors.length} 条启动错误`,
    { errors: bootErrors })

  const fails = checks.filter(c => c.severity === 'FAIL').length
  const warns = checks.filter(c => c.severity === 'WARN').length
  const report = {
    ...snapshot,
    summary: { pass: checks.length - fails - warns, warn: warns, fail: fails, checks },
  }

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(report, null, 2))
  } else {
    console.log(`ClawMaster doctor — ${report.at}`)
    console.log(`版本: app ${snapshot.versions.app} / harness ${snapshot.versions.harness}\n`)
    for (const c of checks) {
      const icon = c.severity === 'PASS' ? '✓' : c.severity === 'WARN' ? '!' : '✗'
      console.log(` ${icon} [${c.id}] ${c.summary}`)
      if (c.remedy) console.log(`    → ${c.remedy}`)
    }
    console.log(`\n${report.summary.pass} 通过 / ${warns} 提醒 / ${fails} 失败`)
  }
  process.exit(fails > 0 ? 1 : 0)
}

main().catch(error => { console.error('doctor failed:', error); process.exit(2) })
