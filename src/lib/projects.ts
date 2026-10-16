import { getCollection, type CollectionEntry } from 'astro:content';

export type Project = CollectionEntry<'projects'>;

/** 全部项目，按 frontmatter 的 order 升序（order 相同时按 slug 保持稳定）。 */
export async function getSortedProjects(): Promise<Project[]> {
  const projects = await getCollection('projects');
  return projects.sort((a, b) => a.data.order - b.data.order || a.id.localeCompare(b.id));
}
