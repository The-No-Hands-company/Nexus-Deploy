export type VerifyStatus = "pass" | "fail" | "skip";

export type VerifyResult = {
  id: string;
  title: string;
  status: VerifyStatus;
  detail: string;
};

export type FixtureKind = "node" | "python" | "dockerfile" | "image";

export type DeployedFixture = {
  kind: FixtureKind;
  projectId: string;
  slug: string;
  host: string;
  containerName: string;
  firstDeploymentId: string;
  volumeName?: string;
};

export type EdgeResponse = {
  status: number;
  headers: Record<string, string>;
  body: string;
};

export type EgressProbeResult = {
  loopbackReached: boolean;
  lanReached: boolean;
  lanTargets: string[];
};

export type ContainerCapsResult = {
  memoryMaxBytes: number | null;
  logDriver: string;
  logMaxSize: string;
  logMaxFile: string;
  logCompress: string;
};

export type ReleaseExerciseOutcome = {
  inFlightTotal: number;
  inFlightFailed: number;
  upgradedVersion: string;
  unhealthyDeploymentStatus: string;
  versionDuringUnhealthy: string;
  rolledBackVersion: string;
};

export type VolumeExerciseOutcome = {
  project: DeployedFixture;
  writtenMarker: string;
  readAfterRedeploy: string;
  versionAfterRedeploy: string;
};

export type CleanupCheckOutcome = {
  remainingContainers: string[];
  remainingRoutes: string[];
  remainingSlugs: string[];
  remainingVolumes: string[];
};

/**
 * Operations the conformance suite drives. In `npm run verify` this is backed
 * by the real Deploy HTTP server, edge proxy, Cloud route table, Railpack and
 * the rootless sandbox daemon; in unit tests it is backed by an in-memory fake.
 */
export type VerifyHarness = {
  baseDomain: string;
  controlHost: string;
  expectedMemoryBytes: number;
  deployFixture(kind: FixtureKind): Promise<DeployedFixture>;
  getFixture(kind: FixtureKind): DeployedFixture | undefined;
  edgeFetch(
    host: string,
    path: string,
    init?: { method?: string; headers?: Record<string, string>; body?: string },
  ): Promise<EdgeResponse>;
  probeContainerEgress(containerName: string): Promise<EgressProbeResult>;
  inspectContainerCaps(containerName: string): Promise<ContainerCapsResult>;
  exerciseReleaseLifecycle(fixture: DeployedFixture): Promise<ReleaseExerciseOutcome>;
  exerciseVolumePersistence(): Promise<VolumeExerciseOutcome>;
  deleteAllFixturesAndVerify(): Promise<CleanupCheckOutcome>;
  cleanup(): Promise<void>;
};

export type VerifyStep = {
  id: string;
  title: string;
  needs?: string[];
  run(h: VerifyHarness): Promise<{ status: "pass" | "fail"; detail: string }>;
};
