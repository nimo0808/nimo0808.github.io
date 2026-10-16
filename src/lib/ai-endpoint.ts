/**
 * AI 端点在构建时通过 PUBLIC_AI_ENDPOINT 注入；未设置时默认使用同源的 /api/chat
 * （nimobin.com 上由同一个 Cloudflare Worker 提供）。
 * 这不是密钥：站点构建不需要、也不应包含任何 API Key。
 *
 * 允许两种写法：
 * - 以 / 开头的相对路径（同源），如 /api/chat；
 * - http/https 绝对地址，如本地调试时的 http://localhost:8787/api/chat。
 * 格式不合法时返回 null，Explore 会进入离线兜底模式。
 */
export const DEFAULT_AI_ENDPOINT = '/api/chat';

export function getAiEndpoint(): string | null {
  const raw = import.meta.env.PUBLIC_AI_ENDPOINT?.trim() || DEFAULT_AI_ENDPOINT;
  // 同源相对路径（排除 //host 这种协议相对地址）
  if (raw.startsWith('/') && !raw.startsWith('//')) return raw;
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null;
  } catch {
    return null;
  }
}

/**
 * CSP connect-src 需要额外放行的 origin：端点为同源相对路径（'self' 已覆盖）或不合法时返回 null。
 */
export function getAiEndpointCrossOrigin(): string | null {
  const endpoint = getAiEndpoint();
  if (!endpoint || endpoint.startsWith('/')) return null;
  return new URL(endpoint).origin;
}
