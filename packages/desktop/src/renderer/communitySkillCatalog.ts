export type CommunitySkillCategory = 'coding' | 'design' | 'office' | 'research' | 'automation';

export interface CommunitySkillCatalogItem {
  id: string;
  name: string;
  source: string;
  installs: number;
  category: CommunitySkillCategory;
  description: string;
  installUrl: string;
}

const skill = (
  id: string,
  installs: number,
  category: CommunitySkillCategory,
  description: string,
): CommunitySkillCatalogItem => {
  const parts = id.split('/');
  const source = parts.slice(0, 2).join('/');
  const name = parts.slice(2).join('/');
  return { id, name, source, installs, category, description, installUrl: `https://github.com/${source}` };
};

/**
 * Offline-first snapshot of widely installed skills from skills.sh.
 * Counts are deliberately rounded and only communicate relative popularity.
 * The source URL and selected skill slug are always shown before installation.
 */
export const FEATURED_COMMUNITY_SKILLS: readonly CommunitySkillCatalogItem[] = [
  skill('vercel-labs/skills/find-skills', 3_200_000, 'research', '发现和选择更多 Agent Skill'),
  skill('mattpocock/skills/grill-me', 1_000_000, 'coding', '用追问审查方案与代码'),
  skill('mattpocock/skills/grill-with-docs', 863_600, 'research', '结合文档进行深入审查'),
  skill('anthropics/skills/frontend-design', 837_300, 'design', '构建有辨识度的前端界面'),
  skill('mattpocock/skills/improve-codebase-architecture', 830_500, 'coding', '分析并改善代码架构'),
  skill('mattpocock/skills/tdd', 803_100, 'coding', '测试驱动开发工作流'),
  skill('vercel-labs/agent-browser/agent-browser', 757_700, 'automation', '浏览器操作与页面验证'),
  skill('vercel-labs/agent-skills/react-best-practices', 677_100, 'coding', 'React 与 Next.js 工程实践'),
  skill('vercel-labs/agent-skills/web-design-guidelines', 593_100, 'design', '网页设计规范检查'),
  skill('mattpocock/skills/grilling', 582_600, 'coding', '深入审查实现与推理'),
  skill('mattpocock/skills/domain-modeling', 531_400, 'coding', '领域模型与边界设计'),
  skill('mattpocock/skills/codebase-design', 515_600, 'coding', '代码库结构设计'),
  skill('mattpocock/skills/diagnosing-bugs', 507_600, 'coding', '系统化定位软件缺陷'),
  skill('remotion-dev/skills/remotion-best-practices', 502_600, 'design', 'Remotion 视频工程实践'),
  skill('mattpocock/skills/implement', 461_500, 'coding', '从计划推进到可验证实现'),
  skill('mattpocock/skills/code-review', 449_400, 'coding', '结构化代码审查'),
  skill('leonxlnx/taste-skill/taste-skill', 424_500, 'design', '提升前端视觉品味'),
  skill('mattpocock/skills/research', 410_700, 'research', '可追溯的技术调研'),
  skill('mattpocock/skills/to-spec', 406_800, 'office', '把想法整理为工程规格'),
  skill('mattpocock/skills/to-tickets', 399_800, 'office', '把规格拆成任务单'),
  skill('supabase/agent-skills/supabase-postgres-best-practices', 378_700, 'coding', 'Postgres 性能与安全实践'),
  skill('anthropics/skills/skill-creator', 367_400, 'automation', '创建可复用 Agent Skill'),
  skill('mattpocock/skills/prototype', 366_200, 'coding', '将产品想法快速变成可验证原型'),
  skill('nextlevelbuilder/ui-ux-pro-max-skill/ui-ux-pro-max', 337_400, 'design', 'UI/UX 设计辅助'),
  skill('vercel-labs/agent-skills/composition-patterns', 313_500, 'coding', 'React 组合模式'),
  skill('leonxlnx/taste-skill/redesign-skill', 311_600, 'design', '重构既有产品界面'),
  skill('shadcn/ui/shadcn', 271_700, 'design', '使用 shadcn 组件系统'),
  skill('pbakaus/impeccable/impeccable', 254_800, 'design', '产品界面精修与质检'),
  skill('prisma/skills/prisma-database-setup', 249_200, 'coding', '配置 Prisma 数据库'),
  skill('supabase/agent-skills/supabase', 247_900, 'coding', 'Supabase 应用开发'),
  skill('scrapegraphai/just-scrape/just-scrape', 244_900, 'automation', '结构化网页采集'),
  skill('obra/superpowers/systematic-debugging', 242_300, 'coding', '系统化调试方法'),
  skill('obra/superpowers/writing-plans', 234_400, 'office', '编写可执行实施计划'),
  skill('obra/superpowers/requesting-code-review', 214_300, 'coding', '发起高质量代码审查'),
  skill('obra/superpowers/test-driven-development', 212_300, 'coding', '通用测试驱动开发'),
  skill('anthropics/skills/pptx', 211_600, 'office', '创建和编辑演示文稿'),
  skill('coreyhaines31/marketingskills/seo-audit', 197_500, 'research', 'SEO 审核与改进'),
  skill('obra/superpowers/verification-before-completion', 194_800, 'coding', '完成前验证与证据检查'),
  skill('anthropics/skills/pdf', 187_700, 'office', '读取、生成与检查 PDF'),
  skill('anthropics/skills/docx', 180_100, 'office', '创建和编辑 Word 文档'),
  skill('anthropics/skills/xlsx', 160_700, 'office', '创建和分析电子表格'),
] as const;

export function filterCommunitySkills(
  items: readonly CommunitySkillCatalogItem[],
  query: string,
  category: CommunitySkillCategory | 'all',
): CommunitySkillCatalogItem[] {
  const needle = query.trim().toLocaleLowerCase();
  return items.filter((item) =>
    (category === 'all' || item.category === category) &&
    (!needle || `${item.name} ${item.source} ${item.description}`.toLocaleLowerCase().includes(needle)),
  );
}
