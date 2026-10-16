interface ImportMetaEnv {
  /** Cloudflare Worker /chat 的完整 URL（非密钥），未配置时 Explore 使用离线兜底模式 */
  readonly PUBLIC_AI_ENDPOINT?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
