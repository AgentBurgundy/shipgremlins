export type RunFlowKind = "developer" | "pm" | "verify";
export type RunFlowStatus =
  "pending" | "running" | "passed" | "failed" | "skipped" | "blocked";
export type RunFlowStrategy =
  "tdd" | "regression" | "refactor" | "visual" | "integration" | "fast";
export interface RunFlowAuthorization {
  version: 1;
  key: string;
  maxRepairs: 2;
}
export interface RunFlowPhase {
  id: string;
  label: string;
  status: RunFlowStatus;
  startedAt?: string;
  finishedAt?: string;
  summary?: string;
}
export interface RunFlowSnapshot {
  version: 1;
  kind: RunFlowKind;
  phase: string;
  status: "running" | "passed" | "failed" | "blocked";
  strategy?: RunFlowStrategy;
  repairUsed: number;
  repairLimit: 2;
  updatedAt: string;
  phases: RunFlowPhase[];
  events: Array<{
    id: string;
    phase: string;
    status: RunFlowStatus;
    at: string;
    summary?: string;
  }>;
  freshness?: "live" | "stale" | "complete";
  observedAt?: string;
  stale?: boolean;
}
export interface RunFlowEvent {
  version: 1;
  jobId: string;
  kind: RunFlowKind;
  sequence: number;
  at: string;
  type: "phase" | "checkpoint";
  phase?: string;
  status?: RunFlowStatus;
  summary?: string;
  strategy?: RunFlowStrategy;
  repairUsed?: number;
  mac: string;
}
export interface RunFlowState {
  sequence: number;
  repairUsed: number;
  strategy?: RunFlowStrategy;
  snapshot?: RunFlowSnapshot;
}
export const RUN_FLOW_PREFIX: string;
export const RUN_FLOW_PHASES: Record<RunFlowKind, Array<[string, string]>>;
export const RUN_FLOW_STRATEGIES: RunFlowStrategy[];
export const RUN_FLOW_SUMMARIES: Record<string, string>;
export function validRunFlowAuthorization(
  value: unknown,
): value is RunFlowAuthorization;
export function parseRunFlowLine(
  line: string,
  options: {
    authorization: RunFlowAuthorization;
    jobId: string;
    kind: RunFlowKind;
  },
): RunFlowEvent | undefined;
export function applyRunFlowEvent(
  previous: RunFlowState | undefined,
  event: RunFlowEvent,
): RunFlowState | undefined;
export function createRunFlowWriter(options: {
  authorization: RunFlowAuthorization;
  jobId: string;
  kind: RunFlowKind;
  write: (line: string) => void;
  now?: () => Date;
}): {
  phase(id: string, status: RunFlowStatus, summary?: string): void;
  checkpoint(value: { strategy?: RunFlowStrategy; repairUsed?: number }): void;
  snapshot(): RunFlowSnapshot | undefined;
};
