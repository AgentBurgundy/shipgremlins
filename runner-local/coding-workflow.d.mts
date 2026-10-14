export interface CodingState {
  baseSha: string;
  headSha: string;
  diffHash: string;
  patchHash?: string;
  testHarnessHash?: string;
  files: string[];
  entries: Array<{ path: string; hash: string; mode: number }>;
  diff: string;
}
export function createCodingPhaseRunner(input: {
  ai: import("./codex.mjs").AiSelection;
  credentials: Record<string, string>;
  env: NodeJS.ProcessEnv;
  mcpServers: Record<string, { command: string; args: string[] }>;
  run: (
    command: string,
    args: string[],
    options: {
      cwd: string;
      env: NodeJS.ProcessEnv;
      model: true;
      usageCollector: ReturnType<
        typeof import("./usage.mjs").createUsageCollector
      >;
      input: string;
    },
  ) => Promise<string>;
  redact?: (value: string) => string;
  onUsage?: (value: import("./usage.mjs").UsageArtifact | undefined) => void;
  directory?: string;
  repository?: string;
  memory?: string;
  readonlyProgram?: string;
  taskPrompt?: string;
}): (phase: CodingPhase) => Promise<unknown>;
export interface CodingPhase {
  phase: "understand" | "tests" | "build" | "review";
  readonly: boolean;
  schema: Record<string, unknown>;
  prompt: string;
}
export interface CodingJournal {
  schema: 1;
  baseSha: string;
  strategy?: string;
  repairUsed: number;
  status: string;
  phases: Record<string, string>;
  checks: Array<{
    name: string;
    stage: string;
    code: number;
    commandHash: string;
    outputHash: string;
    sourceHash: string;
    afterSourceHash: string;
    output: string;
    startedAt: string;
    completedAt: string;
  }>;
  review?: {
    sourceHash: string;
    findings: unknown[];
    reviewedDiffHash: string;
  };
  testProof?: {
    sourceHash: string;
    commandHash: string;
    outputHash: string;
    tests: CodingState["entries"];
  };
  latestSource?: { headSha: string; diffHash: string; files: string[] };
  plan?: unknown;
}
export const CODING_SCHEMAS: Record<
  "understand" | "tests" | "build" | "review",
  Record<string, unknown>
>;
export class CodingWorkflowError extends Error {
  code: string;
  phase: string;
  constructor(code: string, phase: string);
}
export function classifyCodingFailure(
  output: string,
  code?: number,
): "authentication" | "infrastructure" | "check_failed";
export function writeCodingCheckpoint(
  directory: string,
  journal: CodingJournal,
): void;
export function writeCodingTask(directory: string, prompt: string): string;
export function assertCodingTask(
  directory: string,
  prompt: string,
  phase?: string,
): void;
export function verifiedCodingDeliveryChecks(
  authorization: object,
  commands: Partial<
    Record<"install" | "test" | "lint" | "typecheck" | "build", string | null>
  >,
): Promise<string[]>;
export function captureCodingState(input: {
  directory: string;
  baseSha: string;
  run: (command: string, args: string[]) => Promise<string>;
  maxBytes?: number;
  maxFiles?: number;
}): Promise<CodingState>;
export function runCodingWorkflow(input: {
  baseSha: string;
  criteria: string[];
  commands: Partial<
    Record<"install" | "test" | "lint" | "typecheck" | "build", string | null>
  >;
  prompt: string;
  invoke: (phase: CodingPhase) => Promise<unknown>;
  check: (input: {
    name: string;
    command: string;
    stage: string;
  }) => Promise<{ code: number; output: string }>;
  state: () => Promise<CodingState>;
  flow?: {
    phase: (id: string, status: string) => void;
    checkpoint: (value: { strategy?: string; repairUsed: number }) => void;
  };
  checkpoint?: (journal: CodingJournal) => void;
  redact?: (value: string) => string;
  now?: () => Date;
  maxRepairs?: 2;
}): Promise<{
  journal: CodingJournal;
  checksAuthorization: object;
  assertPublishable(): Promise<void>;
  published(noChanges?: boolean): void;
}>;
