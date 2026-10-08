import type { PasswordRecipe } from "../testAccess.ts";
import type {
  PlannerExecutor,
  PlannerFailureCode,
} from "../pmPlanner/docker.ts";
import type { SourceControl } from "../sourceControl/types.ts";
import type { EnvironmentTarget } from "../projectCapabilities.ts";
import type { PmDraft } from "../pmPlanner/index.ts";
import type { RecommendedDockerStatus } from "./recommendedDocker.ts";

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
  /** Untrusted, source-cited suggestions. Only explicit confirmation may save commands. */
  projectSetup?: ProjectSetupProposal;
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
export const PROJECT_COMMAND_KEYS = [
  "install",
  "lint",
  "typecheck",
  "test",
  "build",
] as const;
export type ProjectCommandKey = (typeof PROJECT_COMMAND_KEYS)[number];
export interface SetupEvidence {
  path: string;
  quote: string;
}
export interface SuggestedPm {
  name: string;
  mandate: string;
  evidence: SetupEvidence[];
  /** Complete editable adoption proposal; absent in older saved inspections. */
  draft?: PmDraft;
  rationale?: string;
}
export interface ProjectSetupProposal {
  commands: Partial<
    Record<
      ProjectCommandKey,
      { command: string; rationale: string; evidence: SetupEvidence[] }
    >
  >;
  firstPm: { name: string; mandate: string; evidence: SetupEvidence[] };
  /** Additional source-grounded responsibilities retained for later adoption. */
  suggestedPms?: SuggestedPm[];
  /** Source observations only; applying a recipe still requires a live login check. */
  appAccess?: {
    kind: "password" | "email-code" | "sso" | "public" | "unknown";
    summary: string;
    evidence: SetupEvidence[];
    password?: PasswordRecipe;
  };
}
export interface ConfirmProjectSetupInput {
  revision: string;
  configurationRevision: string;
  repositorySha: string;
  commandKeys: ProjectCommandKey[];
}
export interface SetupConfirmation {
  confirmed: boolean;
  confirmedAt?: string;
  repositorySha?: string;
  commandKeys?: ProjectCommandKey[];
}
export interface SetupPull {
  url: string;
  number: number;
  branch: string;
  baseSha: string;
}
export interface OnboardingState {
  recommendedDocker?: RecommendedDockerStatus;
  project: string;
  revision: string;
  configurationRevision: string;
  status:
    "idle" | "analyzing" | "analyzed" | "publishing" | "failed" | "interrupted";
  stage: string;
  message: string;
  failure?: { code: PlannerFailureCode; stage: string };
  updatedAt?: string;
  stale: boolean;
  /** Source identity still matches; setup edits do not discard adoptable drafts. */
  recommendationsReviewable?: boolean;
  report?: OnboardingReport;
  setupPull?: SetupPull;
  appliedProfile?: "hosted" | "docker";
  setupConfirmation?: SetupConfirmation;
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
