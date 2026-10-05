import type { PlannerExecutor } from "../pmPlanner/docker.ts";
import type { SourceControl } from "../sourceControl/types.ts";
import type { EnvironmentTarget } from "../projectCapabilities.ts";

export class ProjectOnboardingError extends Error {
  constructor(
    message: string,
    public readonly status = 400,
    public readonly code = "onboarding_error",
  ) {
    super(message);
    this.name = "ProjectOnboardingError";
  }
}
export interface SetupFile {
  path: string;
  content: string;
  reason: string;
}
export interface SetupDockerDraft {
  recipe:
    | { kind: "image"; image: string }
    | { kind: "dockerfile"; dockerfile: string; context: string };
  port: number;
  healthPath?: string;
  start?: string[];
  services?: { kind: "postgres" | "redis"; name: string; env: string }[];
  migrate?: string[];
  seed?: string[];
}
export interface OnboardingReport {
  summary: string;
  recommendation: "hosted" | "docker";
  rationale: string;
  stack: string[];
  repository: {
    provider: "github" | "gitlab";
    repo: string;
    branch: string;
    sha: string;
    filesRead: string[];
    truncated: boolean;
    inspection?: {
      strategy: "entrypoints-and-dependencies";
      totalFiles: number;
      treeTruncated: boolean;
      requests: number;
      sourceBytes: number;
      fetchedBytes: number;
      limits: {
        files: number;
        sourceBytes: number;
        fileBytes: number;
        fetchedBytes: number;
        depth: number;
      };
      files: {
        path: string;
        reason: string;
        excerpt: boolean;
        ranges?: { start: number; end: number }[];
      }[];
      unresolved: string[];
      criticalMissing: string[];
    };
  };
  missingInputs: {
    key: string;
    label: string;
    description: string;
    required: boolean;
  }[];
  hosted: {
    provider: "vercel" | "railway" | "cloud-run" | "url";
    instructions: string[];
  };
  docker: SetupDockerDraft | null;
  proposedFiles: SetupFile[];
  warnings: string[];
}
export interface SetupPull {
  url: string;
  number: number;
  branch: string;
  baseSha: string;
}
export interface OnboardingState {
  project: string;
  revision: string;
  configurationRevision: string;
  status:
    "idle" | "analyzing" | "analyzed" | "publishing" | "failed" | "interrupted";
  stage: string;
  message: string;
  updatedAt?: string;
  stale: boolean;
  report?: OnboardingReport;
  setupPull?: SetupPull;
  appliedProfile?: "hosted" | "docker";
}
export interface ApplyProfileInput {
  project: string;
  configurationRevision: string;
  profile: "hosted" | "docker";
  target: EnvironmentTarget;
  report?: OnboardingReport;
}
export interface ProjectOnboardingOptions {
  root: string;
  packageRoot: string;
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  sourceControl?: Pick<SourceControl, "resolveCredential"> &
    Partial<Pick<SourceControl, "acquireLease" | "releaseLease">>;
  execute?: PlannerExecutor;
  timeoutMs?: number;
  applyProfile?: (input: ApplyProfileInput) => Promise<unknown>;
}
