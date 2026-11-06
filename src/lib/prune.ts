/**
 * Which images the hourly sweep may delete.
 *
 * The sandbox daemon belongs to Deploy alone, so every image in it is ours and
 * "unused" is the only question. An image is kept if a project is running it, if
 * it is the release a rollback would restore, or if it is among a project's few
 * most recent deployments. A pulled image is listed by tag but recorded by
 * digest, so both spellings are checked.
 */
import type { ListedImage } from "./docker.js";

/** How many recent deployments per project keep their image, for rollback. */
export const KEEP_RECENT_DEPLOYMENTS = 3;

export function keepRefs(
  data: {
    projects: ReadonlyArray<{ id: string; imageTag?: string | undefined; previousImageTag?: string | undefined }>;
    deployments: ReadonlyArray<{ projectId: string; imageTag: string; createdAt: number }>;
  },
  recent: number = KEEP_RECENT_DEPLOYMENTS,
): Set<string> {
  const keep = new Set<string>();
  for (const project of data.projects) {
    if (project.imageTag) keep.add(project.imageTag);
    if (project.previousImageTag) keep.add(project.previousImageTag);
    data.deployments
      .filter((d) => d.projectId === project.id && d.imageTag)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, recent)
      .forEach((d) => keep.add(d.imageTag));
  }
  return keep;
}

/** References to pass to `docker rmi`: `repo:tag` for tagged images, the id for untagged ones. */
export function imagesToPrune(listed: readonly ListedImage[], keep: ReadonlySet<string>): string[] {
  const doomed: string[] = [];
  for (const image of listed) {
    const tagged = image.repository !== "<none>" && image.tag !== "<none>";
    const ref = tagged ? `${image.repository}:${image.tag}` : image.id;
    const byDigest = image.digest !== "<none>" ? `${image.repository}@${image.digest}` : null;
    if (keep.has(ref) || (byDigest !== null && keep.has(byDigest))) continue;
    doomed.push(ref);
  }
  return doomed;
}
