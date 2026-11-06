import type { Project } from "../types.js";

/**
 * The container serving a project now. Releases are blue/green, so each one gets
 * its own name; projects from before that fall back to the original fixed name.
 */
export function containerNameOf(project: Pick<Project, "name" | "containerName">): string {
  return project.containerName ?? `nexus-app-${project.name}`;
}
