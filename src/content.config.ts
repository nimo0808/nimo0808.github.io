import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

// 作品集（首页展示、详情页、Explore 推荐卡片）。
// 注意：这里只放可公开的 frontmatter，不要写正文；AI 私有语料放在 private/corpus（不提交）。
const projects = defineCollection({
  // glob loader 会把 frontmatter 中的 slug 作为 entry.id，用于生成 /projects/<slug> 链接
  loader: glob({ pattern: '**/[^_]*.md', base: './src/content/projects' }),
  schema: z.object({
    // 稳定的 ASCII URL 标识，改文件名不会影响公开链接
    slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'slug 只能包含小写字母、数字和连字符'),
    // 排序字段（首页、Explore 均按此升序）
    order: z.number().int().positive(),
    title: z.string(),
    // 详情页显示的简短介绍
    summary: z.string(),
    year: z.string(),
    tags: z.array(z.string()).min(1),
    cover: z.string(),
    // 详情页大图路径数组
    details: z.array(z.string()),
    // App Store 下载链接（app development 模版用）
    appStoreUrl: z
      .string()
      .url()
      .refine((u) => !u.includes('...') && !u.includes('…'), '请填写真实的 App Store 链接，不要使用占位地址')
      .optional(),
  }),
});

export const collections = { projects };
