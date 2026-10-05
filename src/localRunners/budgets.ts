import type { LocalJob } from "./types.ts";
import type { ExecutionLimits } from "../execution.ts";
export type { ExecutionLimits } from "../execution.ts";
export interface DailyUsage {
  runs: number;
  runtimeMs: number;
}
export type UsageLedger = Record<string, DailyUsage>;
export interface JobBudget {
  day: string;
  startedAt: string;
  maxMinutes: number;
  settledAt?: string;
  runtimeMs?: number;
}
export interface ProjectExecutionUsage {
  project: string;
  day: string;
  limits: ExecutionLimits;
  runsStarted: number;
  runtimeMinutes: number;
  reservedRuntimeMinutes: number;
  runningJobs: number;
  blockedReason?: string;
}
export function validateLimits(value: ExecutionLimits = {}): ExecutionLimits {
  const bounds = {
    maxConcurrentJobs: 4,
    maxDailyRuns: 1000,
    maxDailyRuntimeMinutes: 10080,
    maxJobMinutes: 45,
  };
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !(key in bounds))
  )
    throw new Error("Execution limits are invalid.");
  for (const [key, max] of Object.entries(bounds)) {
    const n = value[key as keyof ExecutionLimits];
    if (n !== undefined && (!Number.isSafeInteger(n) || n < 1 || n > max))
      throw new Error("Execution limits are invalid.");
  }
  return { ...value };
}
export function validLedger(value: unknown): value is UsageLedger {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length > 10000
  )
    return false;
  return Object.entries(value).every(
    ([key, item]) =>
      /^\d{4}-\d{2}-\d{2}:[a-z][a-z0-9-]{0,62}(?:~[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})?$/.test(
        key,
      ) &&
      item &&
      typeof item === "object" &&
      Object.keys(item).every((key) => ["runs", "runtimeMs"].includes(key)) &&
      Number.isSafeInteger(item.runs) &&
      item.runs >= 0 &&
      Number.isFinite(item.runtimeMs) &&
      item.runtimeMs >= 0,
  );
}
export function validJobBudget(value: unknown): value is JobBudget {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return (
    Object.keys(item).every((key) =>
      ["day", "startedAt", "maxMinutes", "settledAt", "runtimeMs"].includes(
        key,
      ),
    ) &&
    typeof item.day === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(item.day) &&
    typeof item.startedAt === "string" &&
    Number.isFinite(Date.parse(item.startedAt)) &&
    Number.isInteger(item.maxMinutes) &&
    Number(item.maxMinutes) >= 1 &&
    Number(item.maxMinutes) <= 45 &&
    (item.settledAt === undefined ||
      (typeof item.settledAt === "string" &&
        Number.isFinite(Date.parse(item.settledAt)))) &&
    (item.runtimeMs === undefined ||
      (typeof item.runtimeMs === "number" &&
        Number.isFinite(item.runtimeMs) &&
        item.runtimeMs >= 0))
  );
}
export function usageFor(
  project: string,
  limits: ExecutionLimits,
  ledger: UsageLedger,
  jobs: LocalJob[],
  now: Date,
  instanceId?: string,
): ProjectExecutionUsage {
  limits = validateLimits(limits);
  const day = now.toISOString().slice(0, 10),
    used = ledger[`${day}:${project}${instanceId ? `~${instanceId}` : ""}`] ?? {
      runs: 0,
      runtimeMs: 0,
    };
  const active = jobs.filter(
    (job) =>
      job.project === project &&
      job.projectInstanceId === instanceId &&
      job.status === "running",
  );
  const reserved = active
    .filter((job) => job.budget?.day === day && !job.budget.settledAt)
    .reduce((sum, job) => sum + job.budget!.maxMinutes, 0);
  const result: ProjectExecutionUsage = {
    project,
    day,
    limits,
    runsStarted: used.runs,
    runtimeMinutes: used.runtimeMs / 60000,
    reservedRuntimeMinutes: reserved,
    runningJobs: active.length,
  };
  if (active.length >= (limits.maxConcurrentJobs ?? 4))
    result.blockedReason = "Waiting for this project's running job limit.";
  else if (
    limits.maxDailyRuns !== undefined &&
    used.runs >= limits.maxDailyRuns
  )
    result.blockedReason =
      "This project's UTC daily run limit is reached. Queued work waits until the next UTC day or an owner changes the limit.";
  else if (
    limits.maxDailyRuntimeMinutes !== undefined &&
    limits.maxDailyRuntimeMinutes - result.runtimeMinutes - reserved < 1
  )
    result.blockedReason =
      "This project's UTC daily runtime budget is reserved or used. Queued work waits for capacity or the next UTC day.";
  return result;
}
export function reserveBudget(
  project: string,
  limits: ExecutionLimits,
  ledger: UsageLedger,
  jobs: LocalJob[],
  now: Date,
  instanceId?: string,
): JobBudget | null {
  const usage = usageFor(project, limits, ledger, jobs, now, instanceId);
  if (usage.blockedReason) return null;
  const remaining =
    limits.maxDailyRuntimeMinutes === undefined
      ? 45
      : Math.floor(
          limits.maxDailyRuntimeMinutes -
            usage.runtimeMinutes -
            usage.reservedRuntimeMinutes,
        );
  const budget = {
    day: usage.day,
    startedAt: now.toISOString(),
    maxMinutes: Math.min(limits.maxJobMinutes ?? 45, remaining),
  };
  const key = `${budget.day}:${project}${instanceId ? `~${instanceId}` : ""}`;
  ledger[key] ??= { runs: 0, runtimeMs: 0 };
  ledger[key].runs++;
  return budget;
}
export function settleBudget(
  job: LocalJob,
  ledger: UsageLedger,
  now: Date,
  neverStarted = false,
): void {
  if (!job.project || !job.budget || job.budget.settledAt) return;
  const budget = job.budget,
    key = `${budget.day}:${job.project}${job.projectInstanceId ? `~${job.projectInstanceId}` : ""}`;
  ledger[key] ??= { runs: 1, runtimeMs: 0 };
  const elapsed = Math.max(
    0,
    Math.min(
      now.getTime() - Date.parse(budget.startedAt),
      budget.maxMinutes * 60000,
    ),
  );
  if (neverStarted) ledger[key].runs = Math.max(0, ledger[key].runs - 1);
  else ledger[key].runtimeMs += elapsed;
  budget.settledAt = now.toISOString();
  budget.runtimeMs = neverStarted ? 0 : elapsed;
}
