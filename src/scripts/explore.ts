// Explore 客户端逻辑：只调用 Cloudflare Worker（默认同源 /api/chat，可用 PUBLIC_AI_ENDPOINT 覆盖），
// 浏览器里没有任何密钥或私有语料。
// 安全约定：
// - 用户输入、推荐卡片一律用 DOM API + textContent 构建；
// - 助手回答（Markdown）经 marked 渲染后再经 DOMPurify 净化，链接仅允许 http/https/相对路径。
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { getAiEndpoint } from '../lib/ai-endpoint';
import { FALLBACK_NOTICES, FALLBACK_QA, type FallbackQA, type FallbackReason } from '../data/explore-fallback';

interface ProjectCard {
  slug: string;
  title: string;
  year: string;
  tags: string[];
  cover: string;
}

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

type ChatResult =
  | { ok: true; reply: string; projects: string[] }
  | { ok: false; reason: FallbackReason };

const HISTORY_KEY = 'nimo_chat_history';
const REQUEST_TIMEOUT_MS = 15_000;
// 与 Worker 端校验保持一致
const MAX_MESSAGE_LENGTH = 500;
const MAX_HISTORY_ITEMS = 6;
const MAX_HISTORY_CONTENT = 1000;

const ALLOWED_TAGS = [
  'p', 'br', 'hr', 'strong', 'b', 'em', 'i', 'del', 'code', 'pre', 'blockquote',
  'ul', 'ol', 'li', 'a', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'table', 'thead', 'tbody', 'tr', 'th', 'td',
];

function isSafeHref(href: string): boolean {
  try {
    // 相对路径按当前页面解析，最终协议只能是 http/https（拒绝 javascript:、data:、mailto: 等）
    const url = new URL(href.trim(), window.location.href);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.nodeName !== 'A') return;
  const anchor = node as Element;
  const href = anchor.getAttribute('href');
  if (href === null) return;
  if (!isSafeHref(href)) {
    anchor.removeAttribute('href');
    return;
  }
  if (new URL(href.trim(), window.location.href).origin !== window.location.origin) {
    anchor.setAttribute('target', '_blank');
    anchor.setAttribute('rel', 'noopener noreferrer nofollow');
  }
});

function renderMarkdown(markdown: string): string {
  const html = marked.parse(markdown, { async: false, gfm: true });
  return DOMPurify.sanitize(html, { ALLOWED_TAGS, ALLOWED_ATTR: ['href', 'title'] });
}

function createEl<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (className) el.className = className;
  return el;
}

function loadHistory(): ChatMessage[] {
  try {
    const parsed: unknown = JSON.parse(sessionStorage.getItem(HISTORY_KEY) ?? '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (m): m is ChatMessage =>
        !!m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string',
    );
  } catch {
    return [];
  }
}

function init(input: HTMLInputElement, btn: HTMLButtonElement, container: HTMLElement, projects: ProjectCard[]) {
  const endpoint = getAiEndpoint();
  const chatHistory = loadHistory();
  let pending = false;

  const saveChat = () => {
    try {
      sessionStorage.setItem(HISTORY_KEY, JSON.stringify(chatHistory));
    } catch {
      // 存储不可用（隐私模式等）时忽略
    }
  };

  const scrollToBottom = () => window.scrollTo(0, document.body.scrollHeight);

  function appendUserBlock(text: string): { unit: HTMLElement; side: HTMLElement } {
    const unit = createEl('div', 'message-unit');
    const question = createEl('div', 'user-question');
    question.textContent = text;
    const side = createEl('div', 'ai-side-content');
    unit.append(question, side);
    container.appendChild(unit);
    return { unit, side };
  }

  function typeWriter(element: HTMLElement, text: string, callback?: () => void) {
    let i = 0;
    const interval = window.setInterval(() => {
      if (i < text.length) {
        element.innerHTML = renderMarkdown(text.substring(0, i + 1));
        i++;
        scrollToBottom();
      } else {
        window.clearInterval(interval);
        callback?.();
      }
    }, 8);
  }

  function renderProjectCards(cards: ProjectCard[], parentUnit: HTMLElement) {
    if (cards.length === 0) return;
    const grid = createEl('div', 'result-grid');
    for (const p of cards) {
      const card = createEl('a', 'project-card show');
      card.href = `/projects/${encodeURIComponent(p.slug)}`;
      const img = createEl('img');
      img.src = p.cover;
      img.alt = p.title;
      img.loading = 'lazy';
      const title = createEl('div', 'card-title');
      title.textContent = p.title;
      const year = createEl('div', 'card-year');
      year.textContent = p.year;
      card.append(img, title, year);
      grid.appendChild(card);
    }
    parentUnit.appendChild(grid);
  }

  // 推荐卡片：Worker 检索命中的项目 + 回答里提到的标题 + 问题里提到的标签（沿用原有匹配方式）
  function matchProjects(answer: string, query: string, related: string[]): ProjectCard[] {
    const a = answer.toLowerCase();
    const q = query.toLowerCase();
    return projects.filter(
      (p) =>
        related.includes(p.slug) ||
        a.includes(p.title.toLowerCase()) ||
        p.tags.some((tag) => q.includes(tag.toLowerCase())),
    );
  }

  function appendAiAnswer(parent: { unit: HTMLElement; side: HTMLElement }, text: string, cards: ProjectCard[]) {
    const answer = createEl('div', 'ai-answer');
    parent.side.appendChild(answer);
    typeWriter(answer, text, () => renderProjectCards(cards, parent.unit));
  }

  function showFallbackAnswer(qa: FallbackQA) {
    const block = appendUserBlock(qa.question);
    const cards = qa.projects
      .map((slug) => projects.find((p) => p.slug === slug))
      .filter((p): p is ProjectCard => !!p);
    appendAiAnswer(block, qa.answer, cards);
    scrollToBottom();
  }

  function renderFallback(parent: HTMLElement, reason: FallbackReason) {
    const notice = createEl('p', 'fallback-notice');
    notice.textContent = FALLBACK_NOTICES[reason];
    const list = createEl('div', 'fallback-questions');
    for (const qa of FALLBACK_QA) {
      const button = createEl('button', 'fallback-question');
      button.type = 'button';
      button.textContent = qa.question;
      button.addEventListener('click', () => showFallbackAnswer(qa));
      list.appendChild(button);
    }
    parent.append(notice, list);
  }

  async function requestAnswer(url: string, message: string): Promise<ChatResult> {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    const history = chatHistory
      .slice(-MAX_HISTORY_ITEMS)
      .map((m) => ({ role: m.role, content: m.content.slice(0, MAX_HISTORY_CONTENT) }));
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message, history }),
        credentials: 'omit',
        signal: controller.signal,
      });
      const data: unknown = await res.json().catch(() => null);
      const body = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>;
      if (!res.ok) {
        if (body.error === 'rate_limited') return { ok: false, reason: 'rate_limited' };
        if (body.error === 'ai_disabled') return { ok: false, reason: 'ai_disabled' };
        return { ok: false, reason: 'error' };
      }
      if (typeof body.reply !== 'string' || !body.reply.trim()) return { ok: false, reason: 'error' };
      const related = Array.isArray(body.projects)
        ? body.projects.filter((s): s is string => typeof s === 'string')
        : [];
      return { ok: true, reply: body.reply, projects: related };
    } catch {
      return { ok: false, reason: controller.signal.aborted ? 'timeout' : 'unavailable' };
    } finally {
      window.clearTimeout(timer);
    }
  }

  async function handleChat() {
    const query = input.value.trim().slice(0, MAX_MESSAGE_LENGTH);
    if (!query || pending) return;
    const block = appendUserBlock(query);
    input.value = '';
    scrollToBottom();

    if (!endpoint) {
      renderFallback(block.side, 'unavailable');
      scrollToBottom();
      return;
    }

    const loadingIndicator = createEl('div', 'thinking-status');
    loadingIndicator.textContent = 'thinking...';
    block.side.appendChild(loadingIndicator);
    pending = true;
    btn.disabled = true;

    const result = await requestAnswer(endpoint, query);

    loadingIndicator.remove();
    pending = false;
    btn.disabled = false;

    if (result.ok) {
      chatHistory.push({ role: 'user', content: query }, { role: 'assistant', content: result.reply });
      saveChat();
      appendAiAnswer(block, result.reply, matchProjects(result.reply, query, result.projects));
    } else {
      renderFallback(block.side, result.reason);
      scrollToBottom();
    }
  }

  btn.addEventListener('click', handleChat);
  input.addEventListener('keypress', (e) => {
    if (e.key === 'Enter' && !e.isComposing) handleChat();
  });

  container.replaceChildren();
  // PUBLIC_AI_ENDPOINT 格式不合法时，进入页面就展示兜底提示与预设问题
  if (!endpoint) {
    const intro = createEl('div', 'message-unit');
    renderFallback(intro, 'unavailable');
    container.appendChild(intro);
  }
}

const input = document.getElementById('userInput');
const btn = document.getElementById('sendBtn');
const container = document.getElementById('chatContainer');
const dataEl = document.getElementById('explore-data');

if (
  input instanceof HTMLInputElement &&
  btn instanceof HTMLButtonElement &&
  container &&
  dataEl
) {
  let projects: ProjectCard[] = [];
  try {
    projects = JSON.parse(dataEl.dataset.projects ?? '[]') as ProjectCard[];
  } catch {
    projects = [];
  }
  init(input, btn, container, projects);
}
