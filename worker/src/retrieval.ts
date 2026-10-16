// 语料检索：对项目标题 / slug / 标签 / 正文做关键词打分，取最相关的 3 个项目详情 + aboutme。
// 打分以原 explore.astro 的规则为基础（标题包含 +10、标签包含 +5），再补充 slug 短语、标题单词和正文关键词。

export interface CorpusProject {
  slug: string;
  order: number;
  title: string;
  year: string;
  tags: string[];
  body: string;
}

export interface Corpus {
  projects: CorpusProject[];
  about: string;
}

export interface RetrievalResult {
  /** 拼接进 system prompt 的资料 */
  context: string;
  /** 与问题强相关的项目 slug，用于前端推荐卡片 */
  related: string[];
}

const MAX_DETAILED_PROJECTS = 3;
const MIN_DETAIL_SCORE = 3;
const MIN_RELATED_SCORE = 5;
const TITLE_STOPWORDS = new Set(['for', 'and', 'the', 'new']);

function queryTerms(q: string): string[] {
  const ascii = (q.match(/[a-z0-9][a-z0-9+#.-]*/g) ?? []).filter((w) => w.length >= 2);
  const bigrams: string[] = [];
  for (const run of q.match(/[\u4e00-\u9fff]+/g) ?? []) {
    for (let i = 0; i < run.length - 1; i++) bigrams.push(run.slice(i, i + 2));
  }
  return [...new Set([...ascii, ...bigrams])];
}

export function scoreProject(project: CorpusProject, query: string): number {
  const q = query.toLowerCase().trim();
  if (!q) return 0;
  const title = project.title.toLowerCase();
  let score = 0;

  // 原有规则
  if (title.includes(q) || q.includes(title)) score += 10;
  if (project.tags.some((t) => {
    const tag = t.toLowerCase();
    return tag.includes(q) || q.includes(tag);
  })) score += 5;

  // slug 短语，如 "flyme 12" / "flyme12"
  if (q.includes(project.slug.replace(/-/g, ' ')) || q.includes(project.slug.replace(/-/g, ''))) score += 8;

  // 标题中的单词，如 "pickcat"、"polestar"
  for (const word of title.split(/[^a-z0-9\u4e00-\u9fff]+/)) {
    if (word.length >= 3 && !TITLE_STOPWORDS.has(word) && q.includes(word)) score += 3;
  }

  // 正文关键词（英文单词 + 中文二元组），最多 +5
  const body = project.body.toLowerCase();
  let hits = 0;
  for (const term of queryTerms(q)) if (body.includes(term)) hits++;
  score += Math.min(hits, 5);

  return score;
}

export function retrieve(corpus: Corpus, query: string): RetrievalResult {
  const ranked = corpus.projects
    .map((project) => ({ project, score: scoreProject(project, query) }))
    .filter((r) => r.score >= MIN_DETAIL_SCORE)
    .sort((a, b) => b.score - a.score || a.project.order - b.project.order)
    .slice(0, MAX_DETAILED_PROJECTS);

  const index = corpus.projects
    .map((p) => `- ${p.title}（${p.year}）｜标签：${p.tags.join('、')}`)
    .join('\n');

  const details = ranked.length
    ? ranked
        .map(({ project: p }) => `### ${p.title}（${p.year}）\n标签：${p.tags.join('、')}\n${p.body}`)
        .join('\n\n')
    : '（没有与本问题直接相关的作品详情）';

  const context = [
    '[PROJECT_INDEX] 全部作品列表',
    index,
    '',
    '[PROJECT_DETAILS] 与问题最相关的作品详情',
    details,
    '',
    '[ABOUT_NIMO] 个人资料',
    corpus.about,
  ].join('\n');

  return {
    context,
    related: ranked.filter((r) => r.score >= MIN_RELATED_SCORE).map((r) => r.project.slug),
  };
}
