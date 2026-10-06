import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, parse, resolve } from "node:path";
import { setImmediate as yieldToController } from "node:timers/promises";
import type { LocalJob } from "../localRunners/types.ts";

export const TOKEN_FIELDS = [
  "inputTokens",
  "outputTokens",
  "cacheReadInputTokens",
  "cacheCreationInputTokens",
] as const;
export type TokenField = (typeof TOKEN_FIELDS)[number];
export type TokenTotals = Record<TokenField | "totalTokens", number>;
export interface TokenMeasurement extends Record<TokenField, number | null> {
  complete: boolean;
  model?: string;
}
export type UsageKind =
  | "pm"
  | "discovery"
  | "exploration"
  | "grumblin"
  | "developer"
  | "pm-planning"
  | "idea-planning"
  | "setup-analysis"
  | "setup-guidance"
  | "grumblin-generation";
export interface UsageContext {
  project?: string;
  projectInstanceId?: string;
  kind: UsageKind;
}
interface UsageRecord extends UsageContext {
  schemaVersion: 1;
  id: string;
  type: "run" | "operation";
  at: string;
  measurement: TokenMeasurement | null;
  capture?: {
    attempts: number;
    observed: boolean;
    nextAttemptAt?: string;
  };
}
export interface UsageCoverage {
  measuredRuns: number;
  unavailableRuns: number;
  measuredOperations: number;
  unavailableOperations: number;
  partialRecords: number;
  fields: Record<TokenField, number>;
}
const KINDS: UsageKind[] = [
  "pm",
  "discovery",
  "exploration",
  "grumblin",
  "developer",
  "pm-planning",
  "idea-planning",
  "setup-analysis",
  "setup-guidance",
  "grumblin-generation",
];
const NAME = /^[a-z][a-z0-9-]{0,62}$/;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const recordCache = new Map<
  string,
  {
    signature: string;
    readAt: number;
    records: UsageRecord[];
    damaged: boolean;
  }
>();
const storageWarnings = new Set<string>();
// Every service instance for a workspace shares admission. Metadata has its own
// small lane: dashboard history imports cannot wait behind slow Docker reads.
// Both lanes yield before fsync so saving 500 jobs never blocks the controller.
const captureQueues = new Map<
  string,
  {
    active: number;
    waiting: (() => void)[];
    pending: Map<string, Promise<void>>;
    next: Map<string, number>;
  }
>();
function enqueueCapture(
  root: string,
  key: string,
  now: number,
  admitRead: () => boolean,
  work: (readAllowed: boolean) => Promise<number>,
): Promise<void> {
  let queue = captureQueues.get(root);
  if (!queue) {
    queue = { active: 0, waiting: [], pending: new Map(), next: new Map() };
    captureQueues.set(root, queue);
  }
  const existing = queue.pending.get(key);
  if (existing) return existing;
  if (now < (queue.next.get(key) ?? 0)) return Promise.resolve();
  const state = queue;
  const pending = new Promise<void>((done) => {
    const start = () => {
      state.active++;
      const readAllowed = admitRead();
      void yieldToController()
        .then(() => work(readAllowed))
        .then((next) => state.next.set(key, next))
        .catch(() => state.next.set(key, Infinity))
        .finally(() => {
          state.active--;
          state.pending.delete(key);
          state.waiting.shift()?.();
          done();
        });
    };
    if (state.active < 2) start();
    else state.waiting.push(start);
  });
  state.pending.set(key, pending);
  return pending;
}
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const date = (value: unknown): value is string =>
  typeof value === "string" &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value;
export function parseTokenMeasurement(value: unknown): TokenMeasurement | null {
  if (!object(value) || typeof value.complete !== "boolean") return null;
  const result = {} as TokenMeasurement;
  for (const field of TOKEN_FIELDS) {
    const count = value[field];
    if (count !== null && (!Number.isSafeInteger(count) || Number(count) < 0))
      return null;
    result[field] = count as number | null;
  }
  if (
    TOKEN_FIELDS.every((field) => result[field] === null) ||
    (value.complete && TOKEN_FIELDS.some((field) => result[field] === null))
  )
    return null;
  if (
    !Number.isSafeInteger(
      TOKEN_FIELDS.reduce((sum, field) => sum + (result[field] ?? 0), 0),
    )
  )
    return null;
  result.complete = value.complete;
  if (
    typeof value.model === "string" &&
    /^(?:(?:anthropic\.)?claude-[a-z0-9][a-z0-9._:-]{0,119}|sonnet|opus|haiku)$/.test(
      value.model,
    )
  )
    result.model = value.model;
  return result;
}
export function parseUsageArtifact(bytes: Buffer): TokenMeasurement | null {
  if (bytes.length > 4096) return null;
  try {
    const value: unknown = JSON.parse(bytes.toString("utf8"));
    if (
      !object(value) ||
      value.schemaVersion !== 1 ||
      value.source !== "claude-code" ||
      !date(value.reportedAt)
    )
      return null;
    return parseTokenMeasurement(value);
  } catch {
    return null;
  }
}
function safePath(path: string): void {
  for (let current = resolve(path); ; current = dirname(current)) {
    if (existsSync(current) && lstatSync(current).isSymbolicLink())
      throw new Error("Usage storage cannot contain symbolic links.");
    if (current === parse(current).root) break;
  }
}
function read(file: string): UsageRecord {
  safePath(file);
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > 4096)
    throw new Error("Invalid usage record.");
  return parseRecord(JSON.parse(readFileSync(file, "utf8")));
}
function parseRecord(value: unknown): UsageRecord {
  if (
    !object(value) ||
    value.schemaVersion !== 1 ||
    !["run", "operation"].includes(String(value.type)) ||
    typeof value.id !== "string" ||
    !/^[a-z0-9:-]{1,100}$/.test(value.id) ||
    !date(value.at) ||
    !KINDS.includes(value.kind as UsageKind) ||
    (value.project !== undefined &&
      (typeof value.project !== "string" || !NAME.test(value.project))) ||
    (value.projectInstanceId !== undefined &&
      (typeof value.projectInstanceId !== "string" ||
        !UUID.test(value.projectInstanceId))) ||
    (value.projectInstanceId !== undefined && value.project === undefined) ||
    (value.measurement !== null && !parseTokenMeasurement(value.measurement))
  )
    throw new Error("Invalid usage record.");
  if (
    value.capture !== undefined &&
    (!object(value.capture) ||
      value.type !== "run" ||
      !Number.isInteger(value.capture.attempts) ||
      Number(value.capture.attempts) < 1 ||
      Number(value.capture.attempts) > 3 ||
      typeof value.capture.observed !== "boolean" ||
      (value.capture.observed
        ? value.capture.nextAttemptAt !== undefined
        : !date(value.capture.nextAttemptAt) || value.capture.attempts === 3))
  )
    throw new Error("Invalid usage capture state.");
  return {
    schemaVersion: 1,
    id: value.id,
    type: value.type as UsageRecord["type"],
    at: value.at,
    kind: value.kind as UsageKind,
    ...(typeof value.project === "string" ? { project: value.project } : {}),
    ...(typeof value.projectInstanceId === "string"
      ? { projectInstanceId: value.projectInstanceId }
      : {}),
    measurement: parseTokenMeasurement(value.measurement),
    ...(object(value.capture)
      ? {
          capture: {
            attempts: value.capture.attempts as number,
            observed: value.capture.observed as boolean,
            ...(typeof value.capture.nextAttemptAt === "string"
              ? { nextAttemptAt: value.capture.nextAttemptAt }
              : {}),
          },
        }
      : {}),
  };
}
const totals = (): TokenTotals => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadInputTokens: 0,
  cacheCreationInputTokens: 0,
  totalTokens: 0,
});
const coverage = (): UsageCoverage => ({
  measuredRuns: 0,
  unavailableRuns: 0,
  measuredOperations: 0,
  unavailableOperations: 0,
  partialRecords: 0,
  fields: {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
  },
});
const bucket = () => ({ totals: totals(), coverage: coverage() });
function add(target: ReturnType<typeof bucket>, record: UsageRecord) {
  const measured = record.measurement;
  target.coverage[
    record.type === "run"
      ? measured
        ? "measuredRuns"
        : "unavailableRuns"
      : measured
        ? "measuredOperations"
        : "unavailableOperations"
  ]++;
  if (!measured) return false;
  let exceeded = false;
  const sum = (current: number, increment: number) => {
    const value = current + increment;
    if (!Number.isSafeInteger(value)) exceeded = true;
    return Math.min(Number.MAX_SAFE_INTEGER, value);
  };
  if (!measured.complete) target.coverage.partialRecords++;
  for (const field of TOKEN_FIELDS) {
    if (measured[field] !== null) target.coverage.fields[field]++;
    target.totals[field] = sum(target.totals[field], measured[field] ?? 0);
    target.totals.totalTokens = sum(
      target.totals.totalTokens,
      measured[field] ?? 0,
    );
  }
  return exceeded;
}
export function createUsage(options: { root: string; now?: () => Date }) {
  const base = join(resolve(options.root), ".run", "token-usage", "records");
  const now = options.now ?? (() => new Date());
  let captureGeneration = 0;
  let warning = false;
  const warn = () => {
    warning = true;
    storageWarnings.add(base);
  };
  const fileFor = (id: string) =>
    join(base, createHash("sha256").update(id).digest("hex") + ".json");
  function record(value: UsageRecord): boolean {
    try {
      value = parseRecord(value);
      const file = fileFor(value.id);
      safePath(file);
      if (existsSync(file)) {
        const previous = read(file);
        if (
          previous.id !== value.id ||
          previous.project !== value.project ||
          previous.projectInstanceId !== value.projectInstanceId ||
          previous.type !== value.type ||
          previous.kind !== value.kind
        )
          throw new Error("Usage identity mismatch.");
        value.at = previous.at;
        if (
          !value.capture ||
          previous.capture?.observed ||
          (previous.capture?.attempts ?? 0) > value.capture.attempts
        )
          value.capture = previous.capture;
        if (
          previous.measurement?.complete ||
          (!value.measurement && previous.measurement)
        )
          value.measurement = previous.measurement;
        if (
          previous.measurement &&
          value.measurement &&
          !value.measurement.complete
        )
          for (const field of TOKEN_FIELDS) {
            const old = previous.measurement[field],
              incoming = value.measurement[field];
            value.measurement[field] =
              old === null
                ? incoming
                : incoming === null
                  ? old
                  : Math.max(old, incoming);
          }
        if (JSON.stringify(previous) === JSON.stringify(value)) return true;
      }
      mkdirSync(base, { recursive: true, mode: 0o700 });
      const temporary = join(base, `.usage-${randomUUID()}.tmp`);
      try {
        const fd = openSync(temporary, "wx", 0o600);
        try {
          writeFileSync(fd, JSON.stringify(value));
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
        // Validate the exact bounded metadata before making it authoritative.
        read(temporary);
        renameSync(temporary, file);
      } finally {
        if (existsSync(temporary)) unlinkSync(temporary);
      }
      recordCache.delete(base);
      return true;
    } catch {
      warn();
      return false;
    }
  }
  function operation(
    context: UsageContext,
    measurement: unknown,
    id: string = randomUUID(),
    at = now().toISOString(),
  ) {
    record({
      schemaVersion: 1,
      id: `operation:${id}`,
      type: "operation",
      at,
      kind: context.kind,
      ...(context.project ? { project: context.project } : {}),
      ...(context.projectInstanceId
        ? { projectInstanceId: context.projectInstanceId }
        : {}),
      measurement: parseTokenMeasurement(measurement),
    });
  }
  async function captureJob(
    job: LocalJob,
    reader?: (id: string, name: string) => Promise<Buffer>,
  ): Promise<void> {
    if (
      job.type === "verify" ||
      !["succeeded", "failed", "canceled"].includes(job.status) ||
      !job.project
    )
      return;
    const timestamp = job.finishedAt ?? job.startedAt ?? job.createdAt;
    const at = Number.isFinite(Date.parse(timestamp))
      ? new Date(timestamp).toISOString()
      : timestamp;
    const value: UsageRecord = {
      schemaVersion: 1,
      id: job.id,
      type: "run",
      at,
      project: job.project,
      ...(job.projectInstanceId
        ? { projectInstanceId: job.projectInstanceId }
        : {}),
      kind: job.type === "developer" ? "developer" : (job.pmMode ?? "pm"),
      measurement: null,
    };
    const canRead = reader && (job.startedAt || job.launchAttemptedAt);
    const key = `${JSON.stringify(value)}:${canRead ? "artifact" : "metadata"}`;
    const generation = captureGeneration;
    return enqueueCapture(
      `${base}:${canRead ? "artifact" : "metadata"}`,
      key,
      now().getTime(),
      () => generation === captureGeneration,
      async (readAllowed) => {
        let previous: UsageRecord | undefined;
        try {
          if (existsSync(fileFor(job.id))) previous = read(fileFor(job.id));
        } catch {
          warn();
          return Infinity;
        }
        if (!canRead) {
          // The API can import history without observing or exhausting live capture.
          record(value);
          return Infinity;
        }
        if (!readAllowed) {
          // Shutdown drains cheap metadata without starting the queued Docker
          // backlog. A later controller may still recover these measurements.
          record(value);
          return 0;
        }
        // The CLI has stopped: valid partial counters are final, including records
        // written before capture markers existed. Never poll them for an upgrade.
        if (previous?.measurement || previous?.capture?.observed)
          return Infinity;
        const retryAt = Date.parse(previous?.capture?.nextAttemptAt ?? "");
        if (retryAt > now().getTime()) return retryAt;
        const attempts = (previous?.capture?.attempts ?? 0) + 1;
        const nextAttemptAt = new Date(
          now().getTime() + (attempts === 1 ? 60_000 : 300_000),
        ).toISOString();
        const capture = {
          attempts,
          observed: attempts === 3,
          ...(attempts < 3 ? { nextAttemptAt } : {}),
        };
        // Persist admission before contacting Docker. A restart cannot reset the
        // attempt budget, and an unwritable ledger must not spawn repeated helpers.
        if (!record({ ...value, capture })) return Infinity;
        try {
          const measured = parseUsageArtifact(
            await reader(job.id, "usage.json"),
          );
          record({
            ...value,
            measurement: measured,
            capture: { attempts, observed: true },
          });
          return Infinity;
        } catch {
          // Missing files and transport failures share the reader's generic error.
          // Bounded recovery allows late remote artifacts without endless polling.
          return attempts < 3 ? Date.parse(nextAttemptAt) : Infinity;
        }
      },
    );
  }
  function summary(
    query: { range?: string; project?: string; instance?: string } = {},
  ) {
    const range = query.range ?? "30d";
    if (
      !["7d", "30d", "all"].includes(range) ||
      (query.project !== undefined &&
        query.project !== "_workspace" &&
        !NAME.test(query.project)) ||
      (query.instance !== undefined &&
        (!query.project ||
          query.project === "_workspace" ||
          (query.instance !== "legacy" && !UUID.test(query.instance))))
    )
      throw new Error("Choose a valid usage range and project.");
    const today = now();
    const end = new Date(
      Date.UTC(
        today.getUTCFullYear(),
        today.getUTCMonth(),
        today.getUTCDate() + 1,
      ),
    );
    const from =
      range === "all"
        ? null
        : new Date(
            end.getTime() - (range === "7d" ? 7 : 30) * 86400000,
          ).toISOString();
    let all: UsageRecord[] = [];
    let damaged = false;
    try {
      safePath(base);
      const signature = existsSync(base)
        ? String(lstatSync(base).mtimeMs)
        : "absent";
      const cached = recordCache.get(base);
      const hit =
        cached?.signature === signature && Date.now() - cached.readAt < 5000;
      if (hit) {
        all = cached.records;
        damaged = cached.damaged;
      } else if (existsSync(base))
        for (const name of readdirSync(base)) {
          if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
          try {
            const value = read(join(base, name));
            if (fileFor(value.id) !== join(base, name)) throw new Error();
            all.push(value);
          } catch {
            damaged = true;
          }
        }
      if (!hit)
        recordCache.set(base, {
          signature,
          readAt: Date.now(),
          records: all,
          damaged,
        });
    } catch {
      damaged = true;
    }
    const selected = all.filter(
      (value) =>
        (!from || value.at >= from) &&
        value.at < end.toISOString() &&
        (query.project === undefined ||
          (query.project === "_workspace"
            ? value.project === undefined
            : value.project === query.project)) &&
        (query.instance === undefined ||
          (value.projectInstanceId ?? "legacy") === query.instance),
    );
    const total = bucket(),
      projects = new Map<
        string,
        ReturnType<typeof bucket> & {
          project: string | null;
          projectInstanceId: string | null;
        }
      >(),
      days = new Map<string, ReturnType<typeof bucket>>(),
      kinds = new Map<string, ReturnType<typeof bucket>>(),
      models = new Map<string, ReturnType<typeof bucket>>();
    let overflow = false;
    const start =
      from ?? selected.map((value) => value.at.slice(0, 10)).sort()[0];
    if (start && range !== "all")
      for (let day = Date.parse(start); day < end.getTime(); day += 86400000)
        days.set(new Date(day).toISOString().slice(0, 10), bucket());
    for (const value of selected) {
      overflow = add(total, value) || overflow;
      const key = `${value.project ?? "_workspace"}:${value.projectInstanceId ?? "legacy"}`;
      if (!projects.has(key))
        projects.set(key, {
          project: value.project ?? null,
          projectInstanceId: value.projectInstanceId ?? null,
          ...bucket(),
        });
      add(projects.get(key)!, value);
      const day = value.at.slice(0, 10);
      if (!days.has(day)) days.set(day, bucket());
      add(days.get(day)!, value);
      if (!kinds.has(value.kind)) kinds.set(value.kind, bucket());
      add(kinds.get(value.kind)!, value);
      const model = value.measurement?.model ?? "unknown";
      if (!models.has(model)) models.set(model, bucket());
      add(models.get(model)!, value);
    }
    return {
      range,
      from,
      to: today.toISOString(),
      ...total,
      projects: [...projects.values()].sort(
        (a, b) => b.totals.totalTokens - a.totals.totalTokens,
      ),
      daily: [...days]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([date, value]) => ({ date, ...value })),
      kinds: [...kinds].map(([kind, value]) => ({ kind, ...value })),
      models: [...models].map(([model, value]) => ({ model, ...value })),
      warnings: [
        ...(overflow
          ? [
              "Recorded totals exceed the numerical reporting limit and are capped. Individual measurements are preserved.",
            ]
          : []),
        ...(warning || storageWarnings.has(base) || damaged
          ? [
              "Some usage records could not be saved or read. Recorded totals may be incomplete.",
            ]
          : []),
        "Historical planning calls cannot be reconstructed. Missing run measurements are unavailable, not estimated usage; some runs stop before calling a model. Partial records include only reported token counts.",
      ],
    };
  }
  return {
    operation,
    captureJob,
    summary,
    cancelPendingReads: () => {
      captureGeneration++;
    },
  };
}
