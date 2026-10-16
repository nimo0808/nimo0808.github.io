/**
 * AI 端点（Cloudflare Worker 的 /chat 完整地址）在构建时通过 PUBLIC_AI_ENDPOINT 注入。
 * 这不是密钥：站点构建不需要、也不应包含任何 API Key。
 * 未配置或格式不合法时返回 null，Explore 会进入离线兜底模式，CSP 也不会放行额外的 connect-src。
 */
export function getAiEndpoint(): URL | null {
  const raw = import.meta.env.PUBLIC_AI_ENDPOINT?.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url : null;
  } catch {
    return null;
  }
}
