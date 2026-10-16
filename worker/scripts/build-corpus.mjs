// 把 ../private/corpus 下的私有语料打包成 ../private/build/corpus.json，供 Worker 在构建时 import。
// - 语料与产物都在 private/（已 .gitignore），不会被提交，也不会进入站点 dist。
// - frontmatter 采用受限格式：每行 `key: <JSON 值>`，例如 `title: "Pixelcam"`、`order: 14`、`tags: ["a", "b"]`。
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const corpusDir = new URL('../../private/corpus/', import.meta.url);
const projectsDir = new URL('projects/', corpusDir);
const aboutFile = new URL('aboutme.md', corpusDir);
const outDir = new URL('../../private/build/', import.meta.url);
const outFile = new URL('corpus.json', outDir);

function fail(message) {
  console.error(`[build-corpus] ${message}`);
  process.exit(1);
}

function parseMarkdown(text, name) {
  const normalized = text.replace(/\r\n/g, '\n');
  const match = normalized.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!match) return { meta: {}, body: normalized.trim() };
  const meta = {};
  for (const line of match[1].split('\n')) {
    if (!line.trim()) continue;
    const idx = line.indexOf(':');
    if (idx === -1) fail(`${name}: frontmatter 行格式错误（缺少冒号）`);
    const key = line.slice(0, idx).trim();
    const raw = line.slice(idx + 1).trim();
    try {
      meta[key] = JSON.parse(raw);
    } catch {
      fail(`${name}: frontmatter 字段 "${key}" 不是合法的 JSON 值`);
    }
  }
  return { meta, body: normalized.slice(match[0].length).trim() };
}

if (!existsSync(projectsDir) || !existsSync(aboutFile)) {
  fail('未找到 ../private/corpus/projects/ 或 ../private/corpus/aboutme.md。私有语料不在仓库中，请先在本机准备好再部署。');
}

const files = (await readdir(projectsDir)).filter((f) => f.endsWith('.md')).sort();
const projects = [];
for (const file of files) {
  const { meta, body } = parseMarkdown(await readFile(new URL(file, projectsDir), 'utf8'), file);
  const { slug, order, title, year, tags } = meta;
  if (typeof slug !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) fail(`${file}: 缺少合法的 slug`);
  if (typeof title !== 'string' || !title) fail(`${file}: 缺少 title`);
  if (!Array.isArray(tags) || tags.some((t) => typeof t !== 'string')) fail(`${file}: tags 必须是字符串数组`);
  projects.push({
    slug,
    order: typeof order === 'number' ? order : Number.MAX_SAFE_INTEGER,
    title,
    year: typeof year === 'string' ? year : '',
    tags,
    body,
  });
}
projects.sort((a, b) => a.order - b.order || a.slug.localeCompare(b.slug));

const about = parseMarkdown(await readFile(aboutFile, 'utf8'), 'aboutme.md');

await mkdir(outDir, { recursive: true });
await writeFile(outFile, JSON.stringify({ projects, about: about.body }), 'utf8');
console.log(`[build-corpus] 已打包 ${projects.length} 个项目 + aboutme`);
