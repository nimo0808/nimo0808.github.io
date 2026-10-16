/**
 * Explore 离线兜底内容（AI 端点未配置 / 网络不可达 / 超时 / 限流 / 关停时使用）。
 *
 * ⚠️ 需要你本人审阅：以下答案是根据 src/content/projects/*.md 的公开 frontmatter
 * （title / year / tags / summary）起草的草稿，以第一人称撰写，未使用任何私有语料。
 * 上线前请逐条确认措辞与事实；这些文字会原样打包进公开网页。
 *
 * - answer 支持 Markdown，渲染时同样经过 marked + DOMPurify 净化。
 * - projects 填项目 frontmatter 中的 slug，用于展示推荐卡片。
 */

export interface FallbackQA {
  question: string;
  answer: string;
  projects: string[];
}

export const FALLBACK_NOTICES = {
  unavailable: 'AI 助手暂时无法连接（部分网络环境下可能无法访问）。你可以先看看这些常见问题：',
  timeout: 'AI 助手响应超时了。你可以稍后再试，或先看看这些常见问题：',
  rate_limited: '提问有点频繁，请稍等一分钟再试。你也可以先看看这些常见问题：',
  ai_disabled: 'AI 助手暂时关闭了。你可以先看看这些常见问题：',
  error: 'AI 助手暂时出了点问题。你可以稍后再试，或先看看这些常见问题：',
} as const;

export type FallbackReason = keyof typeof FALLBACK_NOTICES;

export const FALLBACK_QA: FallbackQA[] = [
  {
    question: '你做过哪些代表性项目？',
    answer: [
      '我的作品主要集中在系统体验与视觉设计，大致分为几类：',
      '',
      '- **AI 与操作系统**：AIOS By Intent、Square AIOS Exploration（2024），Flyme 10 / 11 / 12（2023–2025）',
      '- **智能设备**：Glass AROS（AR 眼镜，2024）、WatchOS Sports and Health（2019）、Car&Phone Link（2024）、Polestar Phone（2024）',
      '- **品牌与视觉**：3D Wallpaper for Meizu（2019/2025）、Tencent QQ 小世界（2022）、PICKCAT Coding Community（2021）、ONES Global（2021）',
      '- **App 开发**：Pixelcam 相机应用（2025）',
    ].join('\n'),
    projects: ['aios', 'square-project', 'flyme-12', 'aros'],
  },
  {
    question: '你在 AI 交互方向做过哪些探索？',
    answer: [
      '- **AIOS By Intent**：以用户意图（Intent）为核心重构系统交互，设计意图式桌面、桌面小组件、负一屏信息流与 SmartBar AI 入口。',
      '- **Square AIOS Exploration**：定义新一代 AI Device OS 的交互与视觉体系，从 System UI 到 AI 智能助理交互模型，并探索多尺寸设备的适配策略。',
      '- **Flyme 12**：全新的智能语音形象与多模态交互动画，强化语音助手的存在感与反馈。',
      '- **Glass AROS**：把 Aicy AI 能力迁移到 AR 眼镜，通过自然语音实现“所见即问”。',
    ].join('\n'),
    projects: ['aios', 'square-project', 'flyme-12', 'aros'],
  },
  {
    question: '你负责过哪些操作系统的设计？',
    answer: [
      '- **Flyme 12（2025）**：系统视觉与交互升级、景深锁屏、桌面图标体系与全局动效优化。',
      '- **Flyme 11（2024）**：建立系统全局变量设计体系（UI 原子变量与颜色变量），推出 Alive 音乐壁纸。',
      '- **Flyme 10（2023）**：提出 Alive Color 生命色彩系统，升级桌面图标与 Alive 壁纸。',
      '- **Polestar Phone（2024）**：系统 UI 定制设计，用 Design Token 打通设计与工程。',
      '- **WatchOS Sports and Health（2019）**：手表系统品牌图形与视觉语言，设计三环运动记录体系。',
    ].join('\n'),
    projects: ['flyme-12', 'flyme-11', 'flyme-10', 'polestar-phone', 'watchos'],
  },
  {
    question: '你有自己开发的 App 吗？',
    answer: [
      '有，**Pixelcam（2025）** 是一款强调快速构图与风格化表达的相机应用，项目包含产品交互、视觉设计与 iOS 应用开发。',
      '',
      '它提供三种视觉特效模式：主体识别并突出主体、画面对半拉丝，以及全画面速度线拉丝，并内置多组经典滤镜，支持添加水印、保存效果图或 Live Photo。',
    ].join('\n'),
    projects: ['pixelcam'],
  },
];
