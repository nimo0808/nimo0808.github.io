// @ts-check
import { defineConfig } from 'astro/config';

// https://astro.build/config
export default defineConfig({
  // GitHub Pages 用户站点（仓库 nimo0808.github.io），根路径部署，不设置 base
  site: 'https://nimo0808.github.io',
  vite: {
    build: {
      // CSP 为 script-src 'self'、font-src 'self'：
      // 禁止把小脚本内联进 HTML、禁止把字体内联成 data: URI，其余资源保持 Vite 默认（4KB）
      assetsInlineLimit: (filePath) => (/\.(?:m?js|woff2?)$/.test(filePath) ? false : undefined),
    },
  },
});
