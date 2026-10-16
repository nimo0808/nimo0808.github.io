// 按部署目标整理 dist/ 里的平台文件（与 BaseLayout 读取同一组环境变量）：
// - DEPLOY_TARGET=github-pages：删除 _headers / .assetsignore（GitHub Pages 不使用，避免作为公开文件发布）；
// - 其他（Cloudflare Workers Static Assets）：PUBLIC_SITE_INDEXABLE=true 时，
//   从 dist/_headers 删除 `X-Robots-Tag: noindex` 行（页面里的 <meta name="robots"> 由 BaseLayout 按同一开关输出）。
// 注：本文件使用 Node API，项目未安装 @types/node，因此不加 // @ts-check。
import { readFile, rm, writeFile } from 'node:fs/promises';
import { loadEnv } from 'vite';

const NOINDEX_LINE = /^[ \t]+X-Robots-Tag:[ \t]*noindex[ \t]*\r?\n/gm;

/** @returns {import('astro').AstroIntegration} */
export default function siteFlags() {
  return {
    name: 'nimo-site-flags',
    hooks: {
      'astro:build:done': async ({ dir, logger }) => {
        // 与 Astro 一致：读取 .env / .env.production 以及 shell 环境变量
        const env = loadEnv('production', process.cwd(), '');
        const headersFile = new URL('_headers', dir);

        if (env.DEPLOY_TARGET === 'github-pages') {
          await rm(headersFile, { force: true });
          await rm(new URL('.assetsignore', dir), { force: true });
          logger.info('GitHub Pages 构建：已从 dist 移除 _headers 与 .assetsignore');
          return;
        }

        if (env.PUBLIC_SITE_INDEXABLE === 'true') {
          const original = await readFile(headersFile, 'utf8');
          const updated = original.replace(NOINDEX_LINE, '');
          if (updated === original) {
            logger.warn('PUBLIC_SITE_INDEXABLE=true，但 dist/_headers 中没有找到 X-Robots-Tag: noindex 行');
            return;
          }
          await writeFile(headersFile, updated, 'utf8');
          logger.info('PUBLIC_SITE_INDEXABLE=true：已从 dist/_headers 移除 X-Robots-Tag: noindex');
        } else {
          logger.info('临时 noindex 生效（页面 meta + _headers X-Robots-Tag）；正式发布时设置 PUBLIC_SITE_INDEXABLE=true');
        }
      },
    },
  };
}
