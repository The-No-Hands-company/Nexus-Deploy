/**
 * The question "may this project build right now?", answered from the database
 * and a few measurements passed in, so it needs no disk, clock or Docker to test.
 */
import { checkBuildAllowed, countRecentBuilds, type Limits, type Verdict } from "./safeguards.js";

export type GuardData = {
  projects: ReadonlyArray<{ id: string; ownerId?: string | undefined }>;
  deployments: ReadonlyArray<{ projectId: string; triggeredBy: string; createdAt: number }>;
};

export type GuardContext = {
  isBuilding: (projectId: string) => boolean;
  hostFreePercent: number | null;
  sandboxUsedPercent: number | null;
  now: number;
};

/** A member's builds are counted across all the projects they own. */
export function evaluateBuildGuard(
  data: GuardData,
  project: { ownerId?: string | undefined },
  ctx: GuardContext,
  limits: Limits,
): Verdict {
  const owned = new Set(
    data.projects
      .filter((p) => p.ownerId !== undefined && p.ownerId === project.ownerId)
      .map((p) => p.id),
  );
  return checkBuildAllowed(
    {
      activeBuildsForMember: [...owned].filter((id) => ctx.isBuilding(id)).length,
      buildsLastHourForMember: countRecentBuilds(data.deployments, owned, ctx.now),
      hostFreePercent: ctx.hostFreePercent,
      sandboxUsedPercent: ctx.sandboxUsedPercent,
    },
    limits,
  );
}
