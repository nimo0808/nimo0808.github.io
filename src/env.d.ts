interface ImportMetaEnv {
  /** AI 接口地址（非密钥）：未设置时默认同源 /api/chat；也可填 http/https 绝对地址 */
  readonly PUBLIC_AI_ENDPOINT?: string;
  /** 设为 "true" 时允许搜索引擎收录；其他值（含未设置）输出 noindex */
  readonly PUBLIC_SITE_INDEXABLE?: string;
  /** 部署目标："github-pages" 时输出 meta CSP；未设置时按 Cloudflare 构建（CSP 由 _headers 响应头下发） */
  readonly DEPLOY_TARGET?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
