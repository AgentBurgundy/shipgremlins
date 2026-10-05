import type { SourceControl } from "../sourceControl/types.ts";
import type { VercelConnection } from "../vercelConnection/index.ts";
import type { EnvironmentTarget } from "../projectCapabilities.ts";

export type VercelTarget = Extract<EnvironmentTarget, { kind: "vercel" }>;
export interface VercelProject {
  id: string;
  name: string;
  repository?: string;
  provider?: "github" | "gitlab";
  repositoryId?: string;
  matchesRepository: boolean;
  productionBranch?: string;
  rootDirectory?: string;
  customEnvironments: { id: string; slug: string }[];
}
export interface VercelCandidate {
  id: string;
  state: string;
  environment: "production" | "preview" | "custom";
  branch?: string;
  sha?: string;
  url?: string;
  customEnvironmentId?: string;
  createdAt: number;
  selectable: boolean;
  reason?: string;
  target?: VercelTarget;
}
export interface VercelInventory {
  connectionId: string;
  teamId?: string | null;
  projects: VercelProject[];
  selectedProject?: VercelProject;
  deployments: VercelCandidate[];
  truncated: boolean;
}
export interface VercelPlan {
  id: string;
  projectId: string;
  projectName: string;
  branch: string;
  baseBranch: string;
  sha: string;
  createBranch: boolean;
  customEnvironmentId?: string;
  target: VercelTarget;
  warnings: string[];
  configurationRevision: string;
  createdAt: string;
}
export interface VercelSetupState {
  project: string;
  revision: string;
  configurationRevision: string;
  status:
    | "idle"
    | "discovering"
    | "discovered"
    | "prepared"
    | "deploying"
    | "deployed"
    | "failed";
  message: string;
  updatedAt: string;
  stale: boolean;
  inventory?: VercelInventory;
  plan?: VercelPlan;
  deployment?: VercelCandidate;
  target?: VercelTarget;
}
export interface VercelDiscoverInput {
  connectionId?: string;
  teamId?: string | null;
  projectId?: string;
  revision?: string;
}
export interface VercelPrepareInput {
  revision: string;
  branch?: string;
  baseBranch?: string;
  customEnvironmentId?: string;
}
export interface VercelDeployInput {
  revision: string;
  confirmTestData: boolean;
}
export interface VercelSetupOptions {
  root: string;
  packageRoot: string;
  sourceControl: Pick<SourceControl, "resolveCredential"> &
    Partial<Pick<SourceControl, "acquireLease" | "releaseLease">>;
  vercelConnectionFor: (
    connectionId?: string,
  ) => Pick<VercelConnection, "resolveCredential">;
  fetch?: typeof fetch;
}
export class VercelSetupError extends Error {
  constructor(
    message: string,
    public readonly status = 400,
    public readonly code = "vercel_setup",
  ) {
    super(message);
    this.name = "VercelSetupError";
  }
}
