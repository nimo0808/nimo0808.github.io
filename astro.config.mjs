// @ts-check
import { defineConfig } from 'astro/config';
import siteFlags from './integrations/site-flags.mjs';

// https://astro.build/config
export default defineConfig({
  // 正式域名（Cloudflare Workers 托管）；GitHub Pages 回滚时同样使用该自定义域名，根路径部署，不设置 base
  site: 'https://nimobin.com',
  // 按 DEPLOY_TARGET / PUBLIC_SITE_INDEXABLE 处理 dist/_headers（noindex 开关、GitHub Pages 清理）
  integrations: [siteFlags()],
  vite: {
    build: {
      // CSP 为 script-src 'self'、font-src 'self'：
      // 禁止把小脚本内联进 HTML、禁止把字体内联成 data: URI，其余资源保持 Vite 默认（4KB）
      assetsInlineLimit: (filePath) => (/\.(?:m?js|woff2?)$/.test(filePath) ? false : undefined),
    },
  },
});
