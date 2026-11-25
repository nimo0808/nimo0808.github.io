// Explore 加载开场：素材加载期间静态居中显示一段介绍文字（轻微淡入上移落位），素材就绪后文字逐字“粒子消散”。
// 只用 transform / opacity / filter（WAAPI），不触发布局，也不使用 Canvas。
// 性能：blur 动画无法交给合成器（Chrome 判定 filter 会移动像素，整段动画退回主线程逐帧计算），
// 所以字符级只做 transform + opacity（可合成），模糊放在单词包裹上；字符在首次绘制前拆分、随机参数在入场后的
// 空闲时间抽取，动画分几批创建，消散开始时不再改动 DOM 结构。

/** 至少显示多久才消散，避免素材已缓存时文字一闪而过 */
const MIN_VISIBLE_MS = 1200;
/** 最多等待多久；超时后照常消散，未就绪的素材之后单独出现 */
const MAX_WAIT_MS = 8000;
/** 进入时淡入并上移落位 */
const ENTER_DURATION_MS = 400;
const ENTER_OFFSET_PX = 6;
const ENTER_EASING = 'cubic-bezier(0.215, 0.61, 0.355, 1)';
/** 入场结束后最迟多久完成预拆分（requestIdleCallback 的 timeout） */
const PREPARE_IDLE_TIMEOUT_MS = 200;
/** 单字最晚开始时间 */
const DISSOLVE_MAX_DELAY_MS = 450;
/** 单字最短 / 最长时长 */
const DISSOLVE_MIN_DURATION_MS = 300;
const DISSOLVE_MAX_DURATION_MS = 900;
/** 所有字符最晚结束时间：delay + duration 超出时压缩 duration（不低于最短时长） */
const DISSOLVE_MAX_END_MS = 1150;
/** 分批创建动画：每 DISSOLVE_BATCH_MS 一批，提前量覆盖约两帧的调度误差 */
const DISSOLVE_BATCH_MS = 150;
const DISSOLVE_SCHEDULE_LOOKAHEAD_MS = 34;
/** 消散开始后多久让素材开始显现（与文字消散重叠） */
const HANDOFF_DELAY_MS = 500;
/** 单词级模糊半径；同一单词内的字符共用 */
const WORD_BLUR_MIN_PX = 3.5;
const WORD_BLUR_MAX_PX = 7.5;
const WORD_BLUR_EASING = 'cubic-bezier(0.25, 0.46, 0.45, 0.94)'; // easeOutQuad
/** 行为占比：原地模糊 50%、向上轻飘 32%、大幅飞散 18%（按比例洗牌分配，实际占比与目标一致） */
const DISSOLVE_BEHAVIOR_WEIGHTS = { blur: 0.5, float: 0.32, scatter: 0.18 } as const;
/** 每个字符独立抽取的缓动；linear 只配短时长，作为偶尔的快速消失 */
const DISSOLVE_EASINGS = [
  { easing: 'cubic-bezier(0.215, 0.61, 0.355, 1)', weight: 0.4 }, // easeOutCubic
  { easing: 'cubic-bezier(0.25, 0.46, 0.45, 0.94)', weight: 0.35 }, // easeOutQuad
  { easing: 'cubic-bezier(0.165, 0.84, 0.44, 1)', weight: 0.15 }, // easeOutQuart
  { easing: 'linear', weight: 0.1 },
] as const;
const LINEAR_MAX_DURATION_MS = 450;
/** 开场中直接提问时的快速淡出 */
const INTERRUPT_FADE_MS = 150;
/** reduced-motion 下素材就绪后的淡出 */
const REDUCED_FADE_MS = 200;

export type ExploreIntroResult = 'complete' | 'interrupted';

export interface ExploreIntro {
  /** 开场结束（文字 DOM 已移除）后 resolve：自然结束为 complete，被提问打断为 interrupted */
  readonly finished: Promise<ExploreIntroResult>;
  /** 立即结束开场：文字快速淡出并移除 */
  interrupt(): Promise<ExploreIntroResult>;
}

interface ExploreIntroOptions {
  /** 五张素材全部 decode 完成（成功或失败都算完成） */
  ready: Promise<unknown>;
  reducedMotion: MediaQueryList;
  /**
   * 该让素材出现了：动效模式下在消散开始后 HANDOFF_DELAY_MS 调用（文字仍在消散）；
   * reduced-motion 下在文字淡出完成后调用。被提问打断时不会调用。
   */
  onHandoff?: () => void;
}

const random = (min: number, max: number) => min + Math.random() * (max - min);
const randomSign = () => (Math.random() < 0.5 ? -1 : 1);
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

type DissolveBehavior = keyof typeof DISSOLVE_BEHAVIOR_WEIGHTS;

/** 按占比生成 n 个行为并洗牌，避免纯随机抽样时占比偏离目标 */
function shuffledBehaviors(count: number): DissolveBehavior[] {
  const blur = Math.round(count * DISSOLVE_BEHAVIOR_WEIGHTS.blur);
  const float = Math.round(count * DISSOLVE_BEHAVIOR_WEIGHTS.float);
  const behaviors: DissolveBehavior[] = Array.from({ length: count }, (_, i) => {
    if (i < blur) return 'blur';
    if (i < blur + float) return 'float';
    return 'scatter';
  });
  for (let i = behaviors.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [behaviors[i], behaviors[j]] = [behaviors[j]!, behaviors[i]!];
  }
  return behaviors;
}

function pickEasing(): string {
  let roll = Math.random();
  for (const option of DISSOLVE_EASINGS) {
    roll -= option.weight;
    if (roll < 0) return option.easing;
  }
  return DISSOLVE_EASINGS[0].easing;
}

/** 三种行为的终点：原地模糊几乎不动；轻飘小幅上移；飞散大位移、旋转、缩放 */
function dissolveTarget(behavior: DissolveBehavior) {
  if (behavior === 'blur') {
    return { x: random(-2, 2), y: random(-3, 1), rotate: 0, scale: 1, duration: random(400, DISSOLVE_MAX_DURATION_MS) };
  }
  if (behavior === 'float') {
    return { x: random(-15, 15), y: random(-40, -12), rotate: random(-8, 8), scale: 1, duration: random(350, 850) };
  }
  return {
    x: randomSign() * random(30, 70),
    y: random(-90, -30),
    rotate: randomSign() * random(15, 35),
    scale: random(0.85, 1.15),
    duration: random(DISSOLVE_MIN_DURATION_MS, 750),
  };
}

interface IntroWord {
  element: HTMLElement;
  chars: HTMLElement[];
}

function splitIntoWords(text: HTMLElement): IntroWord[] {
  const content = text.textContent ?? '';
  const fragment = document.createDocumentFragment();
  const words: IntroWord[] = [];
  for (const part of content.split(/(\s+)/)) {
    if (!part) continue;
    if (/^\s+$/.test(part)) {
      // 空格保留为普通 inline span，仍是换行点，排版与拆分前一致
      const space = document.createElement('span');
      space.className = 'explore-intro-space';
      space.setAttribute('aria-hidden', 'true');
      space.textContent = ' ';
      fragment.append(space);
      continue;
    }
    const word = document.createElement('span');
    word.className = 'explore-intro-word';
    word.setAttribute('aria-hidden', 'true');
    const chars: HTMLElement[] = [];
    for (const ch of Array.from(part)) {
      const char = document.createElement('span');
      char.className = 'explore-intro-char';
      char.textContent = ch;
      word.append(char);
      chars.push(char);
    }
    fragment.append(word);
    words.push({ element: word, chars });
  }
  text.replaceChildren(fragment);
  return words;
}

/**
 * 每个单词一个随机基准延迟（单词内字符延迟接近但各有抖动，形成局部簇群）；
 * 首行和末行整体略早，画面从上下边缘先散开。基准与单词位置无关，不会形成从左到右的扫描。
 */
function wordBaseDelays(words: IntroWord[]): number[] {
  const tops = words.map((word) => word.element.offsetTop);
  const firstTop = Math.min(...tops);
  const lastTop = Math.max(...tops);
  return tops.map((top) => (top === firstTop || top === lastTop ? random(0, 260) : random(60, 380)));
}

interface PlannedAnimation {
  element: HTMLElement;
  keyframes: Keyframe[];
  options: KeyframeAnimationOptions;
}

/** 预先抽好全部随机参数；消散开始时只需逐个调用 animate() */
function planDissolve(words: IntroWord[]): PlannedAnimation[] {
  const baseDelays = wordBaseDelays(words);
  const behaviors = shuffledBehaviors(words.reduce((sum, word) => sum + word.chars.length, 0));
  const planned: PlannedAnimation[] = [];
  let index = 0;
  words.forEach((word, wordIndex) => {
    let firstDelay = Number.POSITIVE_INFINITY;
    let endSum = 0;
    for (const char of word.chars) {
      const target = dissolveTarget(behaviors[index++] ?? 'blur');
      const easing = pickEasing();
      const delay = clamp((baseDelays[wordIndex] ?? 0) + random(-40, 70), 0, DISSOLVE_MAX_DELAY_MS);
      const wanted = easing === 'linear' ? Math.min(target.duration, random(DISSOLVE_MIN_DURATION_MS, LINEAR_MAX_DURATION_MS)) : target.duration;
      const duration = Math.max(DISSOLVE_MIN_DURATION_MS, Math.min(wanted, DISSOLVE_MAX_END_MS - delay));
      firstDelay = Math.min(firstDelay, delay);
      endSum += delay + duration;
      planned.push({
        element: char,
        keyframes: [
          { transform: 'translate3d(0, 0, 0) rotate(0deg) scale(1)', opacity: 1 },
          { transform: `translate3d(${target.x}px, ${target.y}px, 0) rotate(${target.rotate}deg) scale(${target.scale})`, opacity: 0 },
        ],
        options: { duration, delay, easing, fill: 'both' },
      });
    }
    // 单词模糊从最早的字符开始，在字符平均结束时达到最大并保持，原地淡出的字符也能看到明显模糊
    const blurEnd = endSum / word.chars.length;
    planned.push({
      element: word.element,
      keyframes: [{ filter: 'blur(0px)' }, { filter: `blur(${random(WORD_BLUR_MIN_PX, WORD_BLUR_MAX_PX).toFixed(2)}px)` }],
      options: { duration: Math.max(DISSOLVE_MIN_DURATION_MS, blurEnd - firstDelay), delay: firstDelay, easing: WORD_BLUR_EASING, fill: 'both' },
    });
  });
  return planned;
}

/**
 * 按延迟分几批创建动画，避免消散第一帧集中创建数百个动画和合成层；批数少，图层树只变动几次。
 * 所有动画共用同一个 startTime，时间轴与一次性创建完全相同；延迟期内的字符处于初始关键帧（原样），晚创建在视觉上没有差别。
 */
function startPlanned(planned: PlannedAnimation[], active: () => boolean): Promise<Animation[]> {
  const queue = [...planned].sort((a, b) => Number(a.options.delay ?? 0) - Number(b.options.delay ?? 0));
  const animations: Animation[] = [];
  const startTime = Number(document.timeline.currentTime ?? performance.now());
  let nextBatchAt = 0;
  const startDue = () => {
    const elapsed = Number(document.timeline.currentTime ?? performance.now()) - startTime;
    if (elapsed < nextBatchAt) return;
    const limit = nextBatchAt + DISSOLVE_BATCH_MS + DISSOLVE_SCHEDULE_LOOKAHEAD_MS;
    nextBatchAt += DISSOLVE_BATCH_MS;
    while (queue.length > 0 && Number(queue[0]!.options.delay ?? 0) <= Math.max(limit, elapsed + DISSOLVE_SCHEDULE_LOOKAHEAD_MS)) {
      const { element, keyframes, options } = queue.shift()!;
      const animation = element.animate(keyframes, options);
      animation.startTime = startTime;
      animations.push(animation);
    }
  };
  return new Promise((resolve) => {
    const pump = () => {
      if (!active()) {
        resolve(animations);
        return;
      }
      startDue();
      if (queue.length === 0) resolve(animations);
      else window.requestAnimationFrame(pump);
    };
    pump();
  });
}

type IdleHandle = { cancel(): void };
function whenIdle(callback: () => void, timeout: number): IdleHandle {
  if (typeof window.requestIdleCallback === 'function') {
    const id = window.requestIdleCallback(callback, { timeout });
    return { cancel: () => window.cancelIdleCallback(id) };
  }
  const id = window.setTimeout(callback, 0);
  return { cancel: () => window.clearTimeout(id) };
}

export function playExploreIntro(root: HTMLElement, { ready, reducedMotion, onHandoff }: ExploreIntroOptions): ExploreIntro | null {
  const text = root.querySelector<HTMLElement>('[data-intro-text]');
  if (!text || !text.textContent?.trim()) {
    root.remove();
    return null;
  }

  const animated = !reducedMotion.matches && typeof text.animate === 'function';
  // 在文字首次绘制之前拆分字符：拆分后的 inline-block 与连续文本的抗锯齿略有差异，静止时再拆分会出现轻微闪动；
  // 这里拆分时开场层仍是 hidden，用户看到的始终是拆分后的版本，消散开始时也不再改动 DOM
  const words = animated ? splitIntoWords(text) : [];

  root.hidden = false;

  let state: 'waiting' | 'dissolving' | 'interrupting' | 'done' = 'waiting';
  let resolveFinished: (result: ExploreIntroResult) => void = () => undefined;
  const finished = new Promise<ExploreIntroResult>((resolve) => {
    resolveFinished = resolve;
  });

  const timers: number[] = [];
  const wait = (ms: number) => new Promise<void>((resolve) => {
    timers.push(window.setTimeout(resolve, ms));
  });
  const clearTimers = () => {
    for (const timer of timers.splice(0)) window.clearTimeout(timer);
  };

  let handedOff = false;
  const handoff = () => {
    if (handedOff) return;
    handedOff = true;
    onHandoff?.();
  };

  // 文字超出可见区（极小屏幕）时才启用遮罩兜底，并允许在区域内滚动读完整段
  const updateOverflow = () => {
    root.toggleAttribute('data-overflow', text.offsetHeight > root.clientHeight);
  };
  updateOverflow();
  window.addEventListener('resize', updateOverflow);

  let planned: PlannedAnimation[] | null = null;
  let idle: IdleHandle | null = null;
  const prepare = () => {
    idle = null;
    if (!planned && state === 'waiting') planned = planDissolve(words);
  };

  if (animated) {
    const enter = text.animate(
      [
        { opacity: 0, transform: `translate3d(0, ${ENTER_OFFSET_PX}px, 0)` },
        { opacity: 1, transform: 'translate3d(0, 0, 0)' },
      ],
      { duration: ENTER_DURATION_MS, easing: ENTER_EASING },
    );
    // 入场结束后在空闲时间抽取随机参数（读取单词位置需要布局），消散开始时只创建动画
    void enter.finished.catch(() => undefined).then(() => {
      if (state === 'waiting') idle = whenIdle(prepare, PREPARE_IDLE_TIMEOUT_MS);
    });
  }

  const finish = (result: ExploreIntroResult) => {
    if (state === 'done') return;
    state = 'done';
    clearTimers();
    idle?.cancel();
    window.removeEventListener('resize', updateOverflow);
    root.remove();
    resolveFinished(result);
  };

  const fadeOut = async (duration: number) => {
    if (typeof root.animate !== 'function') return;
    const from = window.getComputedStyle(root).opacity;
    try {
      await root.animate([{ opacity: from }, { opacity: 0 }], { duration, easing: 'ease-out', fill: 'forwards' }).finished;
    } catch {
      // 动画被取消时直接结束
    }
  };

  const dissolve = async () => {
    // 消散开始即关闭兜底模式的滚动与点击，避免挡住随后显现的素材
    root.setAttribute('data-dissolving', '');
    if (!animated) {
      await fadeOut(REDUCED_FADE_MS);
      return;
    }
    idle?.cancel();
    prepare();
    timers.push(window.setTimeout(handoff, HANDOFF_DELAY_MS));
    const animations = await startPlanned(planned ?? [], () => state === 'dissolving');
    await Promise.all(animations.map((animation) => animation.finished.catch(() => undefined)));
  };

  void Promise.all([Promise.race([ready, wait(MAX_WAIT_MS)]), wait(MIN_VISIBLE_MS)]).then(async () => {
    if (state !== 'waiting') return;
    clearTimers();
    state = 'dissolving';
    await dissolve();
    if (state !== 'dissolving') return;
    handoff();
    finish('complete');
  });

  const interrupt = async (): Promise<ExploreIntroResult> => {
    if (state === 'waiting' || state === 'dissolving') {
      state = 'interrupting';
      clearTimers();
      root.setAttribute('data-dissolving', '');
      await fadeOut(INTERRUPT_FADE_MS);
      finish('interrupted');
    }
    return finished;
  };

  return { finished, interrupt };
}
