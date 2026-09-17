import assert from 'node:assert/strict'
import test from 'node:test'
import { verifyDownloadPage } from './verify-download-page.mjs'

const repository = 'NSIETeam/ClawMaster-Desktop'
const version = '0.2.4-beta.1'
const tag = `desktop-v${version}`
const page = `https://nsieteam.github.io/ClawMaster/`
const links = [
  `https://github.com/${repository}/releases/download/${tag}/clawmaster-${version}-windows-x64-setup.exe`,
  `https://github.com/${repository}/releases/download/${tag}/clawmaster-${version}-macos-arm64.dmg`,
]
const response = (html, status = 200) => ({ ok: status >= 200 && status < 300, status, text: async () => html })

test('the beta download page advertises the exact version and both candidate installer URLs', async () => {
  const html = `<main data-clawmaster-release-version="${version}">${links.map(href => `<a href="${href}">Download</a>`).join('')}</main>`
  const result = await verifyDownloadPage({ url: page, version, tag, repository, fetchImpl: async () => response(html) })
  assert.deepEqual(result.assetUrls.sort(), [...links].sort())
})

test('the checker rejects stale pages, missing candidate URLs and remote failures', async () => {
  const html = `<main data-clawmaster-release-version="0.2.3"><a href="${links[0]}"></a></main>`
  await assert.rejects(verifyDownloadPage({ url: page, version, tag, repository, fetchImpl: async () => response(html) }), /release version differs/u)
  const withoutOne = `<main data-clawmaster-release-version="${version}"><a href="${links[0]}"></a></main>`
  await assert.rejects(verifyDownloadPage({ url: page, version, tag, repository, fetchImpl: async () => response(withoutOne) }), /omits the candidate asset URL/u)
  await assert.rejects(verifyDownloadPage({ url: page, version, tag, repository, fetchImpl: async () => response('', 503) }), /HTTP 503/u)
})

test('the checker refuses non-HTTPS or credential-bearing Pages URLs', async () => {
  await assert.rejects(verifyDownloadPage({ url: 'http://example.test', version, tag, repository }), /HTTPS/u)
  await assert.rejects(verifyDownloadPage({ url: 'https://user:secret@example.test', version, tag, repository }), /credentials/u)
})
