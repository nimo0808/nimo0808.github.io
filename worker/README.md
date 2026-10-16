# nimo-ai：作品集 AI 助手后端（Cloudflare Worker）

站点（GitHub Pages，纯静态）的 Explore 页只调用这个 Worker。DeepSeek 密钥只保存在 Worker 的 secret 里，私有语料在构建时打包进 Worker，二者都不会出现在网页里。

```
浏览器 Explore ──POST /chat──▶ Worker（Origin 白名单 + IP 限流 + 检索）──▶ DeepSeek
```

## 前置条件

- Node.js 22 及以上，已注册 Cloudflare 账号（免费计划即可）。
- 本机存在私有语料目录 `../private/corpus/`（`projects/*.md` + `aboutme.md`）。它已被 `.gitignore` 忽略，不在仓库里；换电脑时需要自行拷贝。缺少语料时部署会直接报错，不会部署一个“空知识库”。

## 首次部署（在 `worker/` 目录执行）

```sh
cd worker
npm ci                                   # 安装固定版本的 wrangler / typescript
npx wrangler login                       # 浏览器授权 Cloudflare 账号
npx wrangler secret put DEEPSEEK_API_KEY # 按提示粘贴新的 DeepSeek Key（不会写进任何文件）
npx wrangler deploy                      # 自动打包语料并部署
```

`deploy` 成功后会输出地址，形如 `https://nimo-ai.<你的子域>.workers.dev`。站点要用的是它的 `/chat` 完整地址。

## 把地址配置到站点

1. GitHub 仓库 → Settings → Secrets and variables → Actions → **Variables** → New repository variable：
   - Name：`PUBLIC_AI_ENDPOINT`
   - Value：`https://nimo-ai.<你的子域>.workers.dev/chat`
   
   这不是密钥，会被打包进公开网页；CSP 的 `connect-src` 也会据此自动放行该 origin。
2. Actions → Deploy to GitHub Pages → Run workflow（或推送一次代码）重新构建站点。
3. 本地调试站点时，在根目录 `.env` 写同样的 `PUBLIC_AI_ENDPOINT=...`（参考 `.env.example`）。

未配置 `PUBLIC_AI_ENDPOINT`、请求失败、超时（15 秒）、限流或关停时，Explore 会自动进入离线兜底模式（预设问题 + 静态答案，内容在 `src/data/explore-fallback.ts`）。

> workers.dev 域名在中国大陆可能无法访问，届时访客会看到兜底模式。阶段二买域名后，见文末“换自定义域名”。

## 自检

```sh
# 预检：应返回 204 且带 Access-Control-Allow-Origin
curl -i -X OPTIONS https://nimo-ai.<你的子域>.workers.dev/chat \
  -H "Origin: https://nimo0808.github.io" -H "Access-Control-Request-Method: POST"

# 正常提问：应返回 {"reply": "...", "projects": [...]}
curl -s -X POST https://nimo-ai.<你的子域>.workers.dev/chat \
  -H "Origin: https://nimo0808.github.io" -H "Content-Type: application/json" \
  -d '{"message":"介绍一下 Pixelcam"}'
```

## 日常操作

| 需求 | 做法 |
|---|---|
| 更新 AI 知识 | 修改 `../private/corpus/` 后重新 `npx wrangler deploy` |
| 更换 / 轮换密钥 | 重新执行 `npx wrangler secret put DEEPSEEK_API_KEY`（立即生效，无需重新部署） |
| 一键关停 AI | 把 `wrangler.jsonc` 中 `AI_ENABLED` 改为 `"false"` 后 `npx wrangler deploy`；或临时执行 `npx wrangler deploy --var AI_ENABLED:false`。此时 `/chat` 返回 503 `ai_disabled`，站点自动进入兜底模式 |
| 调整限流 | 修改 `wrangler.jsonc` 的 `ratelimits[0].simple`（`period` 只能是 10 或 60） |
| 改了 wrangler.jsonc 后 | `npm run types` 重新生成运行时类型，`npm run check` 做类型检查 |

## 本地开发

```sh
# worker/.dev.vars（已被 .gitignore 忽略），写入：
# DEEPSEEK_API_KEY=你的 key
npm run dev        # http://localhost:8787/chat
```

站点侧用 `PUBLIC_AI_ENDPOINT=http://localhost:8787/chat npm run dev` 启动（默认白名单已包含 `http://localhost:4321`）。

## 接口约定

`POST /chat`，`Content-Type: application/json`

```json
{ "message": "1-500 字符", "history": [{ "role": "user", "content": "≤1000 字符" }] }
```

- `history` 可选，最多 6 条，`role` 只能是 `user` / `assistant`。
- 成功：`200 {"reply": "Markdown 文本", "projects": ["相关项目 slug"]}`
- 失败统一返回 `{"error": "<code>"}`，不透传任何上游信息：

| 状态码 | code | 含义 |
|---|---|---|
| 400 | `invalid_request` | Content-Type 不是 JSON、请求体过大或字段不合法 |
| 403 | `forbidden_origin` | Origin 不在 `ALLOWED_ORIGINS` 白名单 |
| 404 | `not_found` | 路径不是 `/chat` |
| 405 | `method_not_allowed` | 不是 POST / OPTIONS |
| 429 | `rate_limited` | 触发限流（每 IP 每 60 秒 5 次） |
| 502 | `upstream_error` | DeepSeek 报错、超时（14 秒）或返回异常 |
| 503 | `ai_disabled` | `AI_ENABLED` 为 `"false"` |
| 503 | `not_configured` | 尚未设置 `DEEPSEEK_API_KEY` secret |

## 限流说明

- 使用 Cloudflare 官方 Workers Rate Limiting binding（已 GA），按 `CF-Connecting-IP` 计数。官方文档未标注需要付费计划，但以实际部署结果为准：如果 `deploy` 因 `ratelimits` 报错，可删除 `wrangler.jsonc` 中的 `ratelimits` 段再部署，代码会自动退回到内存限流。
- 局限：计数按 Cloudflare 机房独立且最终一致，不是精确计数；共享出口 IP（公司网络、移动网络）的访客会共用额度。内存兜底限流只在单个 isolate 内有效，重启即清零，只能挡住最粗暴的刷量。
- 真正的费用上限请在 DeepSeek 控制台控制（只充值小额余额）。

## 隐私与安全

- 不记录请求或回答内容：代码里只在上游失败时打印 HTTP 状态码；`observability` 关闭。
- 访客问题、最近几条对话历史和检索到的语料片段会发送给 DeepSeek 生成回答。
- 前端只在当前标签页的 sessionStorage 临时保存对话，关闭标签页即清除；Worker 不保存任何对话。
- **凡是写进语料的内容，都可能被访客通过提示注入“套”出来**。System prompt 只能降低概率，不能保证。涉及公司保密（NDA）的细节请不要放进 `private/corpus/`。

## 阶段二：换自定义域名

1. 在 Cloudflare 为域名添加 Worker 自定义域（例如 `api.example.com`），或在 `wrangler.jsonc` 中配置 `routes` / `custom_domain`。
2. `ALLOWED_ORIGINS` 追加站点的新域名（例如 `https://www.example.com`），重新部署。
3. 把 GitHub 变量 `PUBLIC_AI_ENDPOINT` 改为 `https://api.example.com/chat`，重新构建站点。
4. 确认无误后可把 `workers_dev` 改为 `false`。
