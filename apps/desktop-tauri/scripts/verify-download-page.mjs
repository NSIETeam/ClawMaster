/** Check the published ClawMaster download page against one candidate release. */
import assert from 'node:assert/strict'
import { realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { installerAssetsForVersion } from './verify-release-assets.mjs'

function anchors(html) {
  return [...html.matchAll(/<a\b([^>]*)>/giu)].flatMap(match => {
    const href = /\bhref\s*=\s*(["'])(.*?)\1/iu.exec(match[1] ?? '')
    return href ? [href[2].replaceAll('&amp;', '&')] : []
  })
}

/** @param {{url:string,version:string,tag:string,repository:string,fetchImpl?:typeof fetch}} options Exact version, tag and GitHub repository shown by the live download page. @returns {Promise<{url:string,version:string,assetUrls:string[]}>} Verified links. */
export async function verifyDownloadPage({ url, version, tag, repository, fetchImpl = fetch }) {
  let pageUrl
  try { pageUrl = new URL(url) }
  catch { throw new Error('CLAWMASTER_DOWNLOAD_PAGE_URL must be an absolute HTTPS page URL') }
  assert.equal(pageUrl.protocol, 'https:', 'CLAWMASTER_DOWNLOAD_PAGE_URL must use HTTPS')
  assert.equal(pageUrl.username, '', 'Download page URL cannot contain credentials')
  assert.equal(pageUrl.password, '', 'Download page URL cannot contain credentials')
  pageUrl.hash = ''
  const response = await fetchImpl(pageUrl, { redirect: 'follow', signal: AbortSignal.timeout(15_000) })
  if (!response.ok) throw new Error(`ClawMaster download page returned HTTP ${response.status}`)
  const html = await response.text()
  assert.ok(Buffer.byteLength(html) <= 5 * 1024 * 1024, 'ClawMaster download page exceeds 5 MiB')
  const marker = /<[^>]*\bdata-clawmaster-release-version\s*=\s*(["'])(.*?)\1[^>]*>/iu.exec(html)
  assert.equal(marker?.[2], version, 'ClawMaster download page release version differs from the candidate')
  const links = new Set(anchors(html))
  const assetUrls = Object.values(installerAssetsForVersion(version)).map(file => `https://github.com/${repository}/releases/download/${tag}/${file}`)
  for (const assetUrl of assetUrls) assert.ok(links.has(assetUrl), `ClawMaster download page omits the candidate asset URL: ${assetUrl}`)
  return { url: pageUrl.href, version, assetUrls }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(resolve(process.argv[1]))).href) {
  const { values } = parseArgs({ options: { url: { type: 'string' }, version: { type: 'string' }, tag: { type: 'string' }, repository: { type: 'string' } } })
  const url = values.url ?? process.env.CLAWMASTER_DOWNLOAD_PAGE_URL
  assert.ok(url && values.version && values.tag && values.repository, 'Required: --url <HTTPS page> --version <version> --tag <desktop-v*> --repository <owner/name> (or CLAWMASTER_DOWNLOAD_PAGE_URL)')
  process.stdout.write(`${JSON.stringify(await verifyDownloadPage({ url, version: values.version, tag: values.tag, repository: values.repository }))}\n`)
}
