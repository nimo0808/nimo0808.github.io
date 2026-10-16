# nimobin：整站 + AI 助手（Cloudflare Workers）

一个 Worker（名称 `nimobin`）同时托管两样东西：

- 静态站点：Astro 构建出的 `../dist`，用 Workers Static Assets 直接响应（静态请求免费，不计入 Worker 调用次数）。
- AI 接口：同源的 `POST /api/chat`。只有 `/api/*` 会先进入 Worker 脚本（`assets.run_worker_first: ["/api/*"]`）。

DeepSeek 密钥只存在 Worker secret 里，私有语料在部署时打包进 Worker 脚本，二者都不会进入网页或 `dist`。

```
                     ┌──────────────── Cloudflare（zone: nimobin.com）────────────────┐
浏览器 ─ https://www.nimobin.com/* ─▶ Redirect Rule 301 ─▶ https://nimobin.com/*
                     │                                                                │
浏览器 ─ https://nimobin.com ──▶ Worker "nimobin"（Custom Domain）                       │
                     │            ├─ /api/*  ─▶ Worker 脚本 src/index.ts                │
                     │            │             └─ /api/chat：Origin 白名单 + IP 限流    │
                     │            │                + 语料检索 ──▶ DeepSeek API          │
                     │            └─ 其他路径 ─▶ Static Assets（../dist + _headers 响应头）│
                     └────────────────────────────────────────────────────────────────┘
```

## 前置条件

- Node.js 22 及以上。根目录和 `worker/` 都需要先 `npm ci`。
- `nimobin.com` 已在 Cloudflare 账号中、状态为 Active（NS 已生效）。
- 本机存在私有语料目录 `../private/corpus/`（`projects/*.md` + `aboutme.md`）。它已被 `.gitignore` 忽略，不在仓库里，换电脑时要自己拷贝。缺少语料时部署会直接报错，不会部署一个“空知识库”。

## 首次部署

```sh
# 在仓库根目录
npm ci && npm --prefix worker ci          # 安装固定版本依赖
cd worker
npx wrangler login                        # 浏览器授权 Cloudflare 账号
npx wrangler secret put DEEPSEEK_API_KEY  # 按提示粘贴新的 DeepSeek Key（不会写进任何文件）
cd ..
npm run deploy:cf                         # astro build → 在 worker/ 执行 wrangler deploy
```

- 第一次执行 `secret put` 时，如果 Worker `nimobin` 还不存在，wrangler 会提示先创建，选 Yes 即可。
- `deploy` 会自动为 `nimobin.com` 和 `www.nimobin.com` 创建 Workers Custom Domain（Cloudflare 自动添加 DNS 记录并签发证书），只改动 `nimobin.com` 这个 zone，不影响账号里的其他域名和 Worker。
- `workers_dev` 和 `preview_urls` 都关闭了，所以没有 `*.workers.dev` 地址，只能通过自定义域名访问。

部署后自检：

```sh
curl -I https://nimobin.com/                   # 200，带 Content-Security-Policy、X-Robots-Tag 等响应头
curl -I https://www.nimobin.com/explore/       # 配好 Redirect Rule 后应为 301 → https://nimobin.com/explore/
curl -s -X POST https://nimobin.com/api/chat \
  -H "Origin: https://nimobin.com" -H "Content-Type: application/json" \
  -d '{"message":"介绍一下 Pixelcam"}'          # {"reply":"...","projects":[...]}
```

## 仪表盘：配置 www → 根域名 301 跳转

`www.nimobin.com` 也绑定在 Worker 上（保证有证书和代理的 DNS 记录），跳转交给 Redirect Rules 在 Worker 之前完成，不需要让所有请求先跑 Worker。

1. 打开 Cloudflare 仪表盘，在账号首页点进域名 **nimobin.com**。
2. 左侧菜单 **Rules** → **Overview**。
3. 点 **Create rule** → **Redirect Rule**，在模板里选 **Redirect from WWW to Root**（也可以在 Overview 页的 Templates 区直接点这个模板）。
4. 确认模板填好的内容：
   - When incoming requests match：**Wildcard pattern**，Request URL 为 `https://www.*`
   - Then：Target URL 为 `https://${1}`，Status code 为 **301**，勾选 **Preserve query string**
5. 点 **Deploy**。

建议同时打开 **SSL/TLS** → **Edge Certificates** → **Always Use HTTPS**：上面的模板只匹配 https，打开后 `http://` 请求会先升级到 https 再跳转。

## 正式发布：关闭临时 noindex

作品还没准备好，目前每个页面都会输出 `<meta name="robots" content="noindex">`，`_headers` 也给所有静态响应加了 `X-Robots-Tag: noindex`。两者由同一个开关 `PUBLIC_SITE_INDEXABLE` 控制：

```sh
PUBLIC_SITE_INDEXABLE=true npm run deploy:cf
```

也可以在根目录 `.env` 里写 `PUBLIC_SITE_INDEXABLE=true`，以后每次 `npm run deploy:cf` 都会生效。构建日志会显示 `已从 dist/_headers 移除 X-Robots-Tag: noindex`。GitHub Pages 构建读取同名的仓库变量（Settings → Secrets and variables → Actions → Variables）。

## 本地预览（整站 + /api/chat）

```sh
# worker/.dev.vars（已被 .gitignore 忽略），写入：
# DEEPSEEK_API_KEY=你的 key
npm run preview:cf          # 在根目录执行：astro build → wrangler dev，打开 http://localhost:8787
```

- `wrangler dev` 会把请求头里的 `localhost:8787` 改写成第一个 route（`nimobin.com`）。`wrangler.jsonc` 里设置了 `dev.upstream_protocol: "https"`，所以本地脚本看到的 Origin 是 `https://nimobin.com`，和线上走同一条白名单校验。
- 只改前端时，可以用 `npm run dev`（Astro 开发服务器，端口 4321）。此时 `/api/chat` 不存在，Explore 会进入兜底模式。要联调 AI，可以另开终端 `npm --prefix worker run dev`，再用 `PUBLIC_AI_ENDPOINT=http://localhost:8787/api/chat npm run dev` 启动站点（白名单已包含 `http://localhost:4321`）。

## 安全响应头与缓存

- 规则写在 `../public/_headers`，构建时复制到 `dist/_headers`。它只作用于静态资源响应，`/api/*` 的响应头由 `src/index.ts` 设置（`Cache-Control: no-store`、`X-Content-Type-Options: nosniff`）。
- `/*`：CSP（含 `frame-ancestors 'none'`）、`X-Content-Type-Options`、`Referrer-Policy`、`Permissions-Policy`、`Strict-Transport-Security`（一年，含子域名，不加 preload）、`X-Frame-Options: DENY`、临时 `X-Robots-Tag: noindex`。
- `/_astro/*`：带哈希的构建产物，`Cache-Control: public, max-age=31536000, immutable`。其余文件使用 Cloudflare 默认的 `max-age=0, must-revalidate` + ETag。
- 同一个 URL 模式只能写一个块，重复的块会互相覆盖，新增头请写进已有的块。
- Cloudflare 构建不再输出 `<meta http-equiv="Content-Security-Policy">`，只靠响应头，避免两份策略冲突。
- `public/.assetsignore` 让 wrangler 不上传 `.DS_Store`。

## 文件大小限制

Workers Static Assets 单个文件最大 **25 MiB**，免费计划每个版本最多 20,000 个文件。超过 25 MiB 的文件（例如大视频）会导致 `wrangler deploy` 失败，请压缩，或放到 R2 等对象存储再引用。目前 `dist` 约 4 MB、120 多个文件。

## 回滚到 GitHub Pages

仓库里的 `.github/workflows/deploy.yml` 保留着，推送到 `main` 时会继续构建 GitHub Pages 版本（`DEPLOY_TARGET=github-pages`：输出 meta CSP，删除 `_headers`）。GitHub Pages 上没有 `/api/chat`，Explore 会自动进入离线兜底模式。

1. 解除 Worker 的域名：Cloudflare 仪表盘 → **Workers & Pages** → `nimobin` → **Settings** → **Domains & Routes**，移除 `nimobin.com` 和 `www.nimobin.com`。这会同时删除它们自动创建的 DNS 记录。
2. 在 **nimobin.com** → **DNS** → **Records** 添加记录，代理状态都选 **DNS only**（灰色云朵），否则 GitHub 无法签发证书：
   - `A`，名称 `@`，内容依次为 `185.199.108.153`、`185.199.109.153`、`185.199.110.153`、`185.199.111.153`（4 条）
   - `CNAME`，名称 `www`，内容 `nimo0808.github.io`
3. GitHub 仓库 `nimo0808.github.io` → **Settings** → **Pages** → **Custom domain** 填 `nimobin.com` → Save，等 DNS 检查通过后勾选 **Enforce HTTPS**。用 Actions 部署时不需要 `CNAME` 文件。
4. 可以停用前面的 Redirect Rule；www 跳转由 GitHub Pages 自己处理。

要切回 Cloudflare：反向操作，删除上面的 A / CNAME 记录，并在 GitHub 移除自定义域名，然后 `npm run deploy:cf`（会重新创建 Custom Domain）。

## 日常操作

| 需求 | 做法 |
|---|---|
| 更新网站或 AI 知识 | 修改站点或 `../private/corpus/` 后，在根目录 `npm run deploy:cf` |
| 更换 / 轮换密钥 | `cd worker && npx wrangler secret put DEEPSEEK_API_KEY`（立即生效，无需重新部署） |
| 一键关停 AI | 把 `wrangler.jsonc` 中 `AI_ENABLED` 改为 `"false"` 后 `npm run deploy:cf`。此时 `/api/chat` 返回 503 `ai_disabled`，站点自动进入兜底模式 |
| 调整 Origin 白名单 | 修改 `wrangler.jsonc` 的 `ALLOWED_ORIGINS`（逗号分隔） |
| 调整限流 | 修改 `wrangler.jsonc` 的 `ratelimits[0].simple`（`period` 只能是 10 或 60） |
| 改了 wrangler.jsonc 后 | `npm run types` 重新生成运行时类型，`npm run check` 做类型检查 |
| 只检查打包、不上传 | `npm run build && cd worker && npx wrangler deploy --dry-run` |

## 接口约定

`POST /api/chat`，`Content-Type: application/json`

```json
{ "message": "1-500 字符", "history": [{ "role": "user", "content": "≤1000 字符" }] }
```

- `history` 可选，最多 6 条，`role` 只能是 `user` / `assistant`。
- 必须带白名单内的 `Origin`。浏览器对 POST 总会带 Origin（同源也一样），这用来阻止其他网站从浏览器调用。对白名单 Origin 仍返回 CORS 头并处理 OPTIONS 预检，方便本地跨端口开发。
- 成功：`200 {"reply": "Markdown 文本", "projects": ["相关项目 slug"]}`
- 失败统一返回 `{"error": "<code>"}`，不透传任何上游信息：

| 状态码 | code | 含义 |
|---|---|---|
| 400 | `invalid_request` | Content-Type 不是 JSON、请求体过大或字段不合法 |
| 403 | `forbidden_origin` | Origin 不在 `ALLOWED_ORIGINS` 白名单 |
| 404 | `not_found` | `/api/*` 下的其他路径 |
| 405 | `method_not_allowed` | 不是 POST / OPTIONS |
| 429 | `rate_limited` | 触发限流（每 IP 每 60 秒 5 次） |
| 502 | `upstream_error` | DeepSeek 报错、超时（14 秒）或返回异常 |
| 503 | `ai_disabled` | `AI_ENABLED` 为 `"false"` |
| 503 | `not_configured` | 尚未设置 `DEEPSEEK_API_KEY` secret |

## 限流说明

- 使用 Cloudflare 官方 Workers Rate Limiting binding（已 GA），按 `CF-Connecting-IP` 计数。官方文档没有标注需要付费计划，但以实际部署结果为准：如果 `deploy` 因 `ratelimits` 报错，可以删掉 `wrangler.jsonc` 中的 `ratelimits` 段再部署，代码会自动退回到内存限流。
- 局限：计数按 Cloudflare 机房独立且最终一致，不是精确计数；共享出口 IP（公司网络、移动网络）的访客会共用额度。内存兜底限流只在单个 isolate 内有效，重启即清零，只能挡住最粗暴的刷量。
- 真正的费用上限请在 DeepSeek 控制台控制（只充值小额余额）。

## 隐私与安全

- 不记录请求或回答内容：代码里只在上游失败时打印 HTTP 状态码；`observability` 关闭。
- 访客问题、最近几条对话历史和检索到的语料片段会发送给 DeepSeek 生成回答。
- 前端只在当前标签页的 sessionStorage 临时保存对话，关闭标签页即清除；Worker 不保存任何对话。
- **凡是写进语料的内容，都可能被访客通过提示注入“套”出来**。System prompt 只能降低概率，不能保证。涉及公司保密（NDA）的细节不要放进 `private/corpus/`。
