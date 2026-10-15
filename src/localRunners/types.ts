export type SourceProvider = "github" | "gitlab";
export type JobType = "verify" | "pm" | "developer";
export type WorkerAction = "verify" | "pause" | "resume" | "repair" | "remove";

export interface LocalJobInput {
  type: JobType;
  project?: string;
  /** Bound by the controller; omitted only for legacy project incarnations. */
  projectInstanceId?: string;
  area?: string;
  /** Independent coding profile selected by the controller, never the owning PM identity. */
  coderKey?: string;
  /** Exact coding-profile incarnation; replaced profiles cannot inherit queued work. */
  coderInstanceId?: string;
  ticket?: string;
  attempt?: number;
  developerKind?: "build" | "rc" | "ci" | "sync" | "port";
  branch?: string;
  pr?: number;
  /** Stable scheduled slot or ticket attempt; never a credential. */
  idempotencyKey?: string;
  /** Controller-validated account/workspace/ticket identity; never a credential. */
  linearBinding?: {
    connectionId: string;
    workspaceId?: string;
    ticketId?: string;
  };
  /** Explicit controller-authorized one-off; it does not enable scheduled automation. */
  runOnce?: boolean;
  /** Explicit PM work strategy; Grumblins simulate a saved user's app walkthrough. */
  pmMode?: "discovery" | "exploration" | "grumblin";
  /** Exact generated profile selected at admission; never regenerate during a run. */
  grumblin?: import("../grumblins/schema.ts").GrumblinProfileSnapshot;
  /** Owner configuration snapshot for adopting learned PM observations. */
  discoveryRevision?: string;
}

/** Controller-created one-off contracts also carry automatic work reservations. */
export function isAutomaticLocalJob(input: LocalJobInput): boolean {
  return (
    input.runOnce !== true ||
    [
      "auto-discovery:",
      "qa-rework:",
      "integration-repair:",
      "promotion-repair:",
      "staging-sync:",
    ].some((prefix) => input.idempotencyKey?.startsWith(prefix))
  );
}

export interface LocalJob extends LocalJobInput {
  /** Read-only presentation fields, restored from authenticated runner observations. */
  ai?: import("../ai/provider.ts").AiSelection;
  flow?: import("../../runner-local/run-flow.mjs").RunFlowSnapshot;
  id: string;
  runId: number;
  workerId?: string;
  status: "queued" | "running" | "succeeded" | "failed" | "canceled";
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  message?: string;
  retries?: number;
  exitCode?: number;
  nextAttemptAt?: string;
  failure?: import("./recovery.ts").JobFailure;
  cancelRequestedAt?: string;
  budget?: import("./budgets.ts").JobBudget;
  reconciliationAttempts?: number;
  launchAttemptedAt?: string;
}

export interface LocalWorker {
  id: string;
  remoteId?: string;
  name: string;
  status: "provisioning" | "ready" | "busy" | "paused" | "error";
  busy: boolean;
  paused: boolean;
  createdAt: string;
  verifiedAt?: string;
  message?: string;
}

export interface RunnerOperation {
  phase: "idle" | "working" | "error";
  message: string;
  runnerId?: string;
}

export interface LocalRunnerStatus {
  runners: LocalWorker[];
  jobs: LocalJob[];
  operation: RunnerOperation;
  execution?: import("./budgets.ts").ProjectExecutionUsage[];
}
