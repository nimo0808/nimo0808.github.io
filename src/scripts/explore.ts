// Explore 客户端逻辑：只调用 Cloudflare Worker（默认同源 /api/chat，可用 PUBLIC_AI_ENDPOINT 覆盖），
// 浏览器里没有任何密钥或私有语料。
// 安全约定：
// - 用户输入、推荐卡片一律用 DOM API + textContent 构建；
// - 助手回答（Markdown）经 marked 渲染后再经 DOMPurify 净化，链接仅允许 http/https/相对路径。
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { getAiEndpoint } from '../lib/ai-endpoint';
import { FALLBACK_NOTICES, FALLBACK_QA, type FallbackQA, type FallbackReason } from '../data/explore-fallback';
import { playExploreIntro, type ExploreIntro } from './explore-intro';

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
// 开场结束时素材的显现（与文字消散重叠）：模糊到清晰、0.96 放大到 1、极轻微上升
const EMPTY_REVEAL_DURATION_MS = 650;
const EMPTY_REVEAL_STAGGER_MS = 70;
const EMPTY_REVEAL_BLUR_PX = 10;
const EMPTY_REVEAL_SCALE = 0.96;
const EMPTY_REVEAL_RISE_PX = 3;
const EMPTY_REVEAL_EASING = 'cubic-bezier(0.215, 0.61, 0.355, 1)'; // easeOutCubic

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

function init(
  input: HTMLInputElement,
  btn: HTMLButtonElement,
  container: HTMLElement,
  emptyState: HTMLElement,
  introRoot: HTMLElement | null,
  projects: ProjectCard[],
) {
  const endpoint = getAiEndpoint();
  const chatHistory = loadHistory();
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const emptyButtons = Array.from(
    emptyState.querySelectorAll<HTMLButtonElement>('[data-empty-question]'),
  );
  // 每张素材 decode 完成（失败也算完成）后记为 settled，开场超时后用来决定哪些素材先出现
  const emptyImageSettled = emptyButtons.map(() => false);
  const emptyImageDecodes = emptyButtons.map(async (button, index) => {
    const image = button.querySelector('img');
    if (image instanceof HTMLImageElement && typeof image.decode === 'function') {
      await image.decode().catch(() => undefined);
    }
    emptyImageSettled[index] = true;
  });
  const emptyImagesReady = Promise.all(emptyImageDecodes);
  let pending = false;
  let transitioning = false;
  let emptyShowFrame: number | undefined;
  let intro: ExploreIntro | null = null;
  let introHandedOff = false;

  const saveChat = () => {
    try {
      sessionStorage.setItem(HISTORY_KEY, JSON.stringify(chatHistory));
    } catch {
      // 存储不可用（隐私模式等）时忽略
    }
  };

  const scrollToBottom = () => window.scrollTo(0, document.body.scrollHeight);

  const waitForAnimationFrames = (count: number): Promise<void> => new Promise((resolve) => {
    const next = (remaining: number) => {
      if (remaining <= 0) {
        resolve();
        return;
      }
      window.requestAnimationFrame(() => next(remaining - 1));
    };
    next(count);
  });

  const showEmptyState = () => {
    if (container.childElementCount > 0) return;
    if (emptyShowFrame !== undefined) window.cancelAnimationFrame(emptyShowFrame);
    emptyState.hidden = false;
    emptyState.inert = false;
    emptyState.setAttribute('aria-hidden', 'false');
    emptyState.dataset.state = 'hidden';
    emptyShowFrame = window.requestAnimationFrame(() => {
      emptyShowFrame = undefined;
      if (container.childElementCount === 0 && !emptyState.hidden) {
        emptyState.dataset.state = 'visible';
      }
    });
  };

  // 开场衔接的素材显现：文字消散的“倒放”，模糊到清晰、轻微放大落位。
  // 动画加在按钮内的 img 上：按钮的 transform 留给首次提问 FLIP，filter 留给 hover 投影。
  // 进行中的显现动画 → 对应的清理函数
  const revealAnimations = new Map<Animation, () => void>();
  const revealImage = (button: HTMLButtonElement, delay: number) => {
    const image = button.querySelector('img');
    if (!(image instanceof HTMLImageElement) || typeof image.animate !== 'function') return;
    image.style.willChange = 'opacity, transform, filter';
    const animation = image.animate(
      [
        { opacity: 0, filter: `blur(${EMPTY_REVEAL_BLUR_PX}px)`, transform: `translate3d(0, ${EMPTY_REVEAL_RISE_PX}px, 0) scale(${EMPTY_REVEAL_SCALE})` },
        { opacity: 1, filter: 'blur(0px)', transform: 'translate3d(0, 0, 0) scale(1)' },
      ],
      { duration: EMPTY_REVEAL_DURATION_MS, delay, easing: EMPTY_REVEAL_EASING, fill: 'backwards' },
    );
    const cleanup = () => {
      if (!revealAnimations.delete(animation)) return;
      image.style.removeProperty('will-change');
      // Chrome 延迟序列化 CSSOM 写入的内联样式，之后读取会补出空的 style=""；先读取同步，再移除空属性
      if (image.getAttribute('style') === '') image.removeAttribute('style');
    };
    revealAnimations.set(animation, cleanup);
    animation.addEventListener('finish', cleanup);
    animation.addEventListener('cancel', cleanup);
  };
  // 提问时快进：同步结束全部显现动画并清理，FLIP 从最终尺寸开始测量
  const finishReveal = () => {
    for (const [animation, cleanup] of Array.from(revealAnimations)) {
      try {
        animation.finish();
      } catch {
        animation.cancel();
      }
      cleanup();
    }
  };

  // 人物最先，其余按与舞台中心的距离由近到远
  const revealOrder = (buttons: HTMLButtonElement[]): HTMLButtonElement[] => {
    const stage = emptyState.querySelector('.explore-empty-stage')?.getBoundingClientRect();
    if (!stage) return buttons;
    const centerX = stage.left + stage.width / 2;
    const centerY = stage.top + stage.height / 2;
    const distance = (button: HTMLButtonElement) => {
      if (button.classList.contains('explore-empty-button--person')) return -1;
      const rect = button.getBoundingClientRect();
      return Math.hypot(rect.left + rect.width / 2 - centerX, rect.top + rect.height / 2 - centerY);
    };
    return buttons
      .map((button) => ({ button, distance: distance(button) }))
      .sort((a, b) => a.distance - b.distance)
      .map(({ button }) => button);
  };

  // 开场衔接时显示素材：已就绪的按顺序显现，开场超时时仍未就绪的在各自 decode 完成后再单独显现
  const showEmptyStateAfterIntro = () => {
    const animate = !reducedMotion.matches;
    if (animate) emptyState.dataset.reveal = 'intro';
    emptyButtons.forEach((button, index) => {
      if (emptyImageSettled[index]) return;
      button.dataset.pending = '';
      void emptyImageDecodes[index]?.then(() => {
        delete button.dataset.pending;
        if (animate && !transitioning && emptyState.dataset.state === 'visible') revealImage(button, 0);
      });
    });
    showEmptyState();
    if (!animate) return;
    revealOrder(emptyButtons.filter((button) => button.dataset.pending === undefined)).forEach((button, index) => {
      revealImage(button, index * EMPTY_REVEAL_STAGGER_MS);
    });
  };

  const dockEmptyState = async (animate: boolean): Promise<void> => {
    if (emptyState.dataset.state === 'compact') return;
    if (emptyShowFrame !== undefined) {
      window.cancelAnimationFrame(emptyShowFrame);
      emptyShowFrame = undefined;
    }

    const shouldAnimate = animate && !reducedMotion.matches;
    if (shouldAnimate) {
      // Start decoding on init and wait here before taking FLIP snapshots. Keeping opacity inline also
      // prevents the temporary disabled state from dimming the scatter while decode is still pending.
      for (const button of emptyButtons) {
        button.style.opacity = '1';
        button.style.willChange = 'transform';
      }
      await emptyImagesReady;
    }

    const startRects = shouldAnimate
      ? emptyButtons.map((button) => button.getBoundingClientRect())
      : [];

    emptyState.hidden = false;
    emptyState.inert = false;
    emptyState.setAttribute('aria-hidden', 'false');
    emptyState.dataset.state = shouldAnimate ? 'transitioning' : 'compact';
    container.prepend(emptyState);

    if (!shouldAnimate) return;

    const endRects = emptyButtons.map((button) => button.getBoundingClientRect());
    const inverseTransforms = emptyButtons.map((button, index) => {
      const start = startRects[index];
      const end = endRects[index];
      if (!start || !end || end.width === 0 || end.height === 0) return null;
      const startCenterX = start.left + start.width / 2;
      const startCenterY = start.top + start.height / 2;
      const endCenterX = end.left + end.width / 2;
      const endCenterY = end.top + end.height / 2;
      const inverse = `translate3d(${startCenterX - endCenterX}px, ${startCenterY - endCenterY}px, 0) scale(${start.width / end.width}, ${start.height / end.height})`;
      button.style.animation = 'none';
      button.style.transition = 'none';
      button.style.transformOrigin = 'center center';
      button.style.transform = inverse;
      return inverse;
    });

    // Flush the inverse transforms before WAAPI starts, so the first painted frame stays at the scatter positions.
    for (const button of emptyButtons) window.getComputedStyle(button).transform;

    const animations = emptyButtons.flatMap((button, index) => {
      const inverse = inverseTransforms[index];
      if (!inverse) return [];
      return [button.animate(
        [
          { transform: inverse, opacity: 1 },
          { transform: 'translate3d(0, 0, 0) scale(1, 1)', opacity: 1 },
        ],
        {
          duration: 700,
          delay: index * 20,
          easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
          fill: 'both',
        },
      )];
    });

    await Promise.all(animations.map((animation) => animation.finished.catch(() => undefined)));

    // Persist the exact final pixels before changing state. Mobile WebKit can otherwise paint the
    // disabled compact style between removing a fill animation and enabling the buttons again.
    for (const button of emptyButtons) {
      button.style.transform = 'translate3d(0, 0, 0) scale(1, 1)';
      button.style.opacity = '1';
    }
    emptyState.dataset.state = 'compact';

    // Let the compact layout settle while the finished animations still own the same final pixels.
    await waitForAnimationFrames(2);
    for (const animation of animations) {
      try {
        animation.commitStyles?.();
      } catch {
        // Safari versions without a usable commitStyles implementation keep the explicit inline final style.
      }
      animation.cancel();
    }

    // Hand transform ownership back to compact CSS while will-change keeps the layer alive, then
    // demote the temporary layers only after the equivalent CSS frame has painted.
    for (const button of emptyButtons) {
      button.style.removeProperty('animation');
      button.style.removeProperty('transition');
      button.style.removeProperty('transform');
    }
    await waitForAnimationFrames(2);
    for (const button of emptyButtons) {
      button.style.removeProperty('transform-origin');
      button.style.removeProperty('will-change');
    }
  };

  const updateInteractionState = () => {
    input.disabled = transitioning;
    btn.disabled = pending || transitioning;
    for (const button of emptyButtons) button.disabled = pending || transitioning;
  };

  const setTransitioning = (value: boolean) => {
    transitioning = value;
    updateInteractionState();
  };

  const setPending = (value: boolean) => {
    pending = value;
    updateInteractionState();
  };

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

  async function submitQuestion(text: string) {
    const query = text.trim().slice(0, MAX_MESSAGE_LENGTH);
    if (!query || pending || transitioning) return;

    if (emptyState.dataset.state !== 'compact') {
      setTransitioning(true);
      try {
        if (intro) {
          // 开场中直接提问：文字快速淡出并移除，再从散点位置走现有的 FLIP 收拢流程。
          // 素材已开始显现（文字仍在消散）时不必等文字淡出，两者并行
          const current = intro;
          intro = null;
          if (introHandedOff) {
            void current.interrupt();
          } else {
            await current.interrupt();
            showEmptyState();
          }
        }
        finishReveal();
        await dockEmptyState(true);
      } finally {
        setTransitioning(false);
        for (const button of emptyButtons) button.style.removeProperty('opacity');
      }
    }

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
    setPending(true);

    const result = await requestAnswer(endpoint, query);

    loadingIndicator.remove();
    setPending(false);

    if (result.ok) {
      chatHistory.push({ role: 'user', content: query }, { role: 'assistant', content: result.reply });
      saveChat();
      appendAiAnswer(block, result.reply, matchProjects(result.reply, query, result.projects));
    } else {
      renderFallback(block.side, result.reason);
      scrollToBottom();
    }
  }

  btn.addEventListener('click', () => void submitQuestion(input.value));
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.isComposing) void submitQuestion(input.value);
  });
  for (const button of emptyButtons) {
    button.addEventListener('click', () => {
      const question = button.dataset.emptyQuestion;
      if (question) void submitQuestion(question);
    });
  }

  container.replaceChildren();
  // PUBLIC_AI_ENDPOINT 格式不合法时，进入页面就展示兜底提示与预设问题
  if (!endpoint) {
    const intro = createEl('div', 'message-unit');
    renderFallback(intro, 'unavailable');
    container.appendChild(intro);
  }

  if (container.childElementCount === 0) {
    const started = introRoot
      ? playExploreIntro(introRoot, {
        ready: emptyImagesReady,
        reducedMotion,
        // 文字消散到一半时素材开始显现；已被提问打断（intro 已清空）时不再显示
        onHandoff: () => {
          if (!intro) return;
          introHandedOff = true;
          showEmptyStateAfterIntro();
        },
      })
      : null;
    if (started) {
      intro = started;
      void started.finished.then(() => {
        if (intro === started) intro = null;
      });
    } else {
      showEmptyState();
    }
  } else {
    introRoot?.remove();
    dockEmptyState(false);
  }
}

const input = document.getElementById('userInput');
const btn = document.getElementById('sendBtn');
const container = document.getElementById('chatContainer');
const emptyState = document.getElementById('exploreEmpty');
const dataEl = document.getElementById('explore-data');

if (
  input instanceof HTMLInputElement &&
  btn instanceof HTMLButtonElement &&
  container &&
  emptyState &&
  dataEl
) {
  let projects: ProjectCard[] = [];
  try {
    projects = JSON.parse(dataEl.dataset.projects ?? '[]') as ProjectCard[];
  } catch {
    projects = [];
  }
  init(input, btn, container, emptyState, document.getElementById('exploreIntro'), projects);
}
