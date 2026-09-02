import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const MAX_FILES = 200;
const MAX_BYTES = 5 * 1024 * 1024;
const MAX_TREE_BYTES = 8 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 60_000;

interface GitHubRepository { default_branch: string }
interface GitHubTreeEntry { path: string; mode: string; type: string; size?: number }
interface GitHubTree { tree: GitHubTreeEntry[]; truncated: boolean }

export interface CommunitySkillInstallInput { id: string; source: string; slug: string }
export interface CommunitySkillInstallResult { id: string; name: string; source: string; installPath: string }

export function parseCommunitySkillSource(source: string): { owner: string; repository: string } {
  const url = new URL(source);
  const parts = url.pathname.split('/').filter(Boolean);
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || parts.length !== 2) {
    throw new Error('目前仅允许从 https://github.com/owner/repository 导入社区插件');
  }
  const valid = /^[A-Za-z0-9._-]+$/;
  if (!parts.every((part) => valid.test(part))) throw new Error('GitHub 插件地址不合法');
  return { owner: parts[0], repository: parts[1].replace(/\.git$/, '') };
}

export function selectSkillDirectoryFromTree(tree: string, slug: string): string | null {
  const suffix = `/${slug}/SKILL.md`;
  const matches = tree.split(/\r?\n/u)
    .map((entry) => entry.trim())
    .filter((entry) => entry === `${slug}/SKILL.md` || entry.endsWith(suffix))
    .filter((entry) => entry.split('/').every((part) => part && part !== '.' && part !== '..'))
    .map((entry) => path.posix.dirname(entry))
    .sort((left, right) => left.split('/').length - right.split('/').length || left.localeCompare(right));
  return matches[0] ?? null;
}

function validateSlug(slug: string): void {
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(slug)) throw new Error('插件名称不合法');
}

async function fetchBytes(url: string, maxBytes: number, context: string): Promise<Uint8Array> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'ClawMaster/0.0.1-preview' },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`${context}：HTTP ${response.status}`);
    const declared = Number(response.headers.get('content-length') ?? 0);
    if (Number.isFinite(declared) && declared > maxBytes) throw new Error(`${context}：响应超过安全大小上限`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > maxBytes) throw new Error(`${context}：响应超过安全大小上限`);
    return bytes;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw new Error(`${context}：连接超时`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJson<T>(url: string, maxBytes: number, context: string): Promise<T> {
  const bytes = await fetchBytes(url, maxBytes, context);
  try { return JSON.parse(new TextDecoder().decode(bytes)) as T; } catch (error) {
    throw new Error(`${context}：响应格式无效：${error instanceof Error ? error.message : String(error)}`);
  }
}

async function downloadSkillFromGitHub(owner: string, repository: string, slug: string, destination: string): Promise<void> {
  const metadata = await fetchJson<GitHubRepository>(
    `https://api.github.com/repos/${owner}/${repository}`,
    1024 * 1024,
    '读取 GitHub 仓库信息失败',
  );
  const branch = encodeURIComponent(metadata.default_branch);
  const tree = await fetchJson<GitHubTree>(
    `https://api.github.com/repos/${owner}/${repository}/git/trees/${branch}?recursive=1`,
    MAX_TREE_BYTES,
    '读取 GitHub 插件目录失败',
  );
  if (tree.truncated) throw new Error('GitHub 仓库目录过大，无法安全定位插件');
  const skillRelativePath = selectSkillDirectoryFromTree(tree.tree.map((entry) => entry.path).join('\n'), slug);
  if (!skillRelativePath) throw new Error(`仓库中没有找到 ${slug}/SKILL.md`);
  const prefix = `${skillRelativePath}/`;
  const files = tree.tree
    .filter((entry) => entry.path.startsWith(prefix) && entry.type !== 'tree')
    .sort((left, right) => left.path.localeCompare(right.path));
  if (files.length === 0 || files.length > MAX_FILES) throw new Error('插件超过 200 个文件的本地导入上限');
  const declaredBytes = files.reduce((total, entry) => {
    if (entry.type !== 'blob' || entry.mode === '120000') throw new Error('插件包含符号链接或子模块，已拒绝导入');
    return total + (entry.size ?? MAX_BYTES + 1);
  }, 0);
  if (declaredBytes > MAX_BYTES) throw new Error('插件超过 5 MiB 的本地导入上限');
  let downloadedBytes = 0;
  for (const entry of files) {
    const relative = entry.path.slice(prefix.length);
    const parts = relative.split('/');
    if (!relative || parts.some((part) => !part || part === '.' || part === '..')) throw new Error('GitHub 插件路径无效');
    const rawPath = entry.path.split('/').map(encodeURIComponent).join('/');
    const bytes = await fetchBytes(
      `https://raw.githubusercontent.com/${owner}/${repository}/${branch}/${rawPath}`,
      Math.max(1, MAX_BYTES - downloadedBytes),
      '下载 GitHub 插件文件失败',
    );
    downloadedBytes += bytes.byteLength;
    if (downloadedBytes > MAX_BYTES) throw new Error('插件超过 5 MiB 的本地导入上限');
    const target = path.join(destination, ...parts);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, bytes);
  }
  try {
    if (!(await fs.stat(path.join(destination, 'SKILL.md'))).isFile()) throw new Error('插件缺少 SKILL.md');
  } catch (error) {
    if (error instanceof Error && error.message === '插件缺少 SKILL.md') throw error;
    throw new Error('插件缺少 SKILL.md');
  }
}

export async function installCommunitySkill(input: CommunitySkillInstallInput, homeDir = os.homedir()): Promise<CommunitySkillInstallResult> {
  validateSlug(input.slug);
  const source = parseCommunitySkillSource(input.source);
  const skillsRoot = path.join(homeDir, '.clawmaster-user', 'skills');
  const destination = path.join(skillsRoot, input.slug);
  await fs.mkdir(skillsRoot, { recursive: true });
  try { await fs.stat(destination); throw new Error(`插件 ${input.slug} 已安装`); } catch (error) {
    if (error instanceof Error && !('code' in error && error.code === 'ENOENT')) throw error;
  }
  const staged = path.join(skillsRoot, `.${input.slug}.installing-${randomUUID()}`);
  try {
    await downloadSkillFromGitHub(source.owner, source.repository, input.slug, staged);
    await fs.rename(staged, destination);
    return { id: input.id, name: input.slug, source: `${source.owner}/${source.repository}`, installPath: destination };
  } finally {
    await fs.rm(staged, { recursive: true, force: true });
  }
}
