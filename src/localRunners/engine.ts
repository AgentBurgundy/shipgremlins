import { createHash, randomUUID } from "node:crypto";
import { createUsage } from "../usage/index.ts";
import { isDeepStrictEqual } from "node:util";
import { validateGrumblinProfileSnapshot } from "../../runner-local/grumblin-profile.mjs";
import { loadProject } from "../config.ts";
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
import {
  notificationResult,
  sendJobNotification,
  type JobNotificationEvent,
  type NotificationResult,
} from "../slack/messages.ts";
import { publicActivityLogs, type ActivityStore } from "../storage/activity.ts";
import { validConnectionId } from "../oauthConnection/profileId.ts";
import {
  assertResourceAvailable,
  type ConfigurationMutation,
} from "../setup/resourceDeletion.ts";
import {
  infrastructureRetry,
  validFailure,
  type FailureCategory,
} from "./recovery.ts";
import {
  reserveBudget,
  settleBudget,
  usageFor,
  validLedger,
  validJobBudget,
  validateLimits,
  type UsageLedger,
  type ExecutionLimits,
} from "./budgets.ts";
import {
  createDockerRunners,
  type DockerJobPayload,
  type DockerRunners,
} from "./docker.ts";
import type {
  LocalJob,
  LocalJobInput,
  LocalRunnerStatus,
  LocalWorker,
  RunnerOperation,
  WorkerAction,
} from "./types.ts";

const ID =
  /^(?:job|worker)-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NAME = /^[a-z][a-z0-9-]{0,62}$/;
const MAX_WORKERS = 4;
const RECENT_JOBS = 500;
const MAX_STATE_BYTES = 8 * 1024 * 1024;
const TERMINAL = new Set(["succeeded", "failed", "canceled"]);
const INPUT_KEYS = [
  "type",
  "project",
  "projectInstanceId",
  "area",
  "ticket",
  "attempt",
  "developerKind",
  "branch",
  "pr",
  "idempotencyKey",
  "linearBinding",
  "runOnce",
  "pmMode",
  "grumblin",
  "discoveryRevision",
];

interface State {
  schema: 1;
  nextRunId: number;
  runners: LocalWorker[];
  jobs: LocalJob[];
  /** True only after Docker confirms that this owned container exists. */
  launched: Record<string, boolean>;
  operation: RunnerOperation;
  usage?: UsageLedger;
}

export class LocalRunnerError extends Error {
  constructor(
    message: string,
    public readonly status = 400,
  ) {
    super(message);
    this.name = "LocalRunnerError";
  }
}

/** A temporary credential admission delay, not a failed agent attempt. */
export class LocalJobDeferredError extends Error {
  constructor(
    message = "Waiting for active jobs to finish before refreshing the source connection. This job remains queued.",
    public readonly category:
      "credential-wait" | "environment-wait" = "credential-wait",
  ) {
    super(message);
    this.name = "LocalJobDeferredError";
  }
}

export interface LocalRunnersOptions {
  root: string;
  packageRoot: string;
  docker?: DockerRunners;
  prepareJob?: (job: LocalJob) => Promise<DockerJobPayload>;
  completeJob?: (job: LocalJob, docker: DockerRunners) => Promise<void>;
  beforeLaunch?: () => Promise<void>;
  releaseJobResources?: (jobId: string) => Promise<void>;
  scheduledJobs?: () => Promise<LocalJobInput[]>;
  activityStore?: ActivityStore;
  notify?: (event: JobNotificationEvent) => Promise<NotificationResult>;
  clock?: () => Date;
  executionLimits?: (project: string) => ExecutionLimits;
  admissionBlocker?: (job: LocalJob, active: LocalJob[]) => string | undefined;
  reconcileCompletedJob?: (
    job: LocalJob,
    result: Record<string, unknown>,
    docker: DockerRunners,
  ) => Promise<void>;
}

export interface LocalRunners {
  withConfigurationMutation: ConfigurationMutation;
  status(): Promise<LocalRunnerStatus>;
  create(): Promise<LocalWorker>;
  addRemote(remoteId: string, name: string): Promise<LocalWorker>;
  action(id: string, action: WorkerAction): Promise<LocalWorker | void>;
  enqueue(input: LocalJobInput): Promise<LocalJob>;
  cancel(id: string): Promise<LocalJob>;
  jobs(): Promise<LocalJob[]>;
  job(id: string | number): Promise<LocalJob | null>;
  logs(id: string): Promise<string[]>;
  artifacts(
    id: string,
  ): Promise<Awaited<ReturnType<DockerRunners["artifacts"]>>["files"]>;
  readArtifact(id: string, name: string): Promise<Buffer>;
  tick(): Promise<void>;
  start(): void;
  stop(): Promise<void>;
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validInput(value: unknown): value is LocalJobInput {
  if (
    !record(value) ||
    !["verify", "pm", "developer"].includes(String(value.type))
  )
    return false;
  if (Object.keys(value).some((key) => !INPUT_KEYS.includes(key))) return false;
  if (
    value.projectInstanceId !== undefined &&
    (typeof value.projectInstanceId !== "string" ||
      !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(
        value.projectInstanceId,
      ))
  )
    return false;
  if (
    value.pmMode !== undefined &&
    (value.type !== "pm" ||
      !["discovery", "exploration", "grumblin"].includes(
        value.pmMode as string,
      ) ||
      value.runOnce !== true ||
      typeof value.discoveryRevision !== "string" ||
      (value.pmMode === "discovery" && value.linearBinding !== undefined) ||
      value.ticket !== undefined)
  )
    return false;
  if (value.pmMode === "grumblin") {
    try {
      const profile = validateGrumblinProfileSnapshot(value.grumblin);
      if (
        profile.project !== value.project ||
        profile.projectInstanceId !== value.projectInstanceId ||
        value.linearBinding !== undefined
      )
        return false;
    } catch {
      return false;
    }
  } else if (value.grumblin !== undefined) return false;
  if (
    value.discoveryRevision !== undefined &&
    (value.type !== "pm" ||
      typeof value.discoveryRevision !== "string" ||
      !/^[a-f0-9]{64}$/.test(value.discoveryRevision))
  )
    return false;
  if (
    value.runOnce !== undefined &&
    (typeof value.runOnce !== "boolean" || value.type === "verify")
  )
    return false;
  if (value.linearBinding !== undefined) {
    const binding = value.linearBinding;
    if (
      !record(binding) ||
      !validConnectionId(binding.connectionId) ||
      Object.keys(binding).some(
        (key) => !["connectionId", "workspaceId", "ticketId"].includes(key),
      ) ||
      [binding.workspaceId, binding.ticketId].some(
        (id) =>
          id !== undefined &&
          (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(id)),
      )
    )
      return false;
  }
  for (const field of ["project", "area"] as const)
    if (
      value[field] !== undefined &&
      (typeof value[field] !== "string" || !NAME.test(value[field]))
    )
      return false;
  if (value.type !== "verify" && typeof value.project !== "string")
    return false;
  if (value.type === "pm" && typeof value.area !== "string") return false;
  if (value.type === "developer" && typeof value.ticket !== "string")
    return false;
  if (
    value.ticket !== undefined &&
    (typeof value.ticket !== "string" ||
      !/^[A-Za-z0-9-]{1,100}$/.test(value.ticket))
  )
    return false;
  if (
    value.attempt !== undefined &&
    (!Number.isSafeInteger(value.attempt) ||
      Number(value.attempt) < 1 ||
      Number(value.attempt) > 100)
  )
    return false;
  if (
    value.pr !== undefined &&
    (!Number.isSafeInteger(value.pr) || Number(value.pr) < 1)
  )
    return false;
  if (
    value.developerKind !== undefined &&
    !["build", "rc", "ci", "sync", "port"].includes(String(value.developerKind))
  )
    return false;
  if (
    value.branch !== undefined &&
    (typeof value.branch !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(value.branch) ||
      /\.\.|\/\/|\.lock(?:\/|$)|\/$/.test(value.branch))
  )
    return false;
  if (
    value.idempotencyKey !== undefined &&
    (typeof value.idempotencyKey !== "string" ||
      !/^[A-Za-z0-9:._/-]{1,256}$/.test(value.idempotencyKey))
  )
    return false;
  return true;
}

function inputOf(job: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    INPUT_KEYS.filter((key) => job[key] !== undefined).map((key) => [
      key,
      job[key],
    ]),
  );
}

function validDate(value: unknown): boolean {
  return (
    typeof value === "string" &&
    value.length < 40 &&
    !Number.isNaN(Date.parse(value))
  );
}

function validJob(job: unknown): job is LocalJob {
  if (
    !record(job) ||
    !validInput(inputOf(job)) ||
    typeof job.id !== "string" ||
    !ID.test(job.id) ||
    !job.id.startsWith("job-")
  )
    return false;
  if (
    !Number.isSafeInteger(job.runId) ||
    Number(job.runId) < 1 ||
    !["queued", "running", "succeeded", "failed", "canceled"].includes(
      String(job.status),
    ) ||
    !validDate(job.createdAt)
  )
    return false;
  if (
    job.workerId !== undefined &&
    (typeof job.workerId !== "string" ||
      !ID.test(job.workerId) ||
      !job.workerId.startsWith("worker-"))
  )
    return false;
  if (
    job.retries !== undefined &&
    (!Number.isInteger(job.retries) ||
      Number(job.retries) < 0 ||
      Number(job.retries) > 2)
  )
    return false;
  if (
    job.message !== undefined &&
    (typeof job.message !== "string" || job.message.length > 1000)
  )
    return false;
  for (const field of [
    "startedAt",
    "finishedAt",
    "nextAttemptAt",
    "cancelRequestedAt",
    "launchAttemptedAt",
  ])
    if (job[field] !== undefined && !validDate(job[field])) return false;
  if (job.exitCode !== undefined && !Number.isInteger(job.exitCode))
    return false;
  if (job.failure !== undefined && !validFailure(job.failure)) return false;
  if (job.budget !== undefined && !validJobBudget(job.budget)) return false;
  if (
    job.reconciliationAttempts !== undefined &&
    (!Number.isInteger(job.reconciliationAttempts) ||
      Number(job.reconciliationAttempts) < 0 ||
      Number(job.reconciliationAttempts) > 3)
  )
    return false;
  return !Object.keys(job).some(
    (key) =>
      ![
        ...INPUT_KEYS,
        "id",
        "runId",
        "workerId",
        "status",
        "createdAt",
        "startedAt",
        "finishedAt",
        "message",
        "retries",
        "exitCode",
        "nextAttemptAt",
        "failure",
        "cancelRequestedAt",
        "budget",
        "reconciliationAttempts",
        "launchAttemptedAt",
      ].includes(key),
  );
}

function validWorker(worker: unknown): worker is LocalWorker {
  return (
    record(worker) &&
    typeof worker.id === "string" &&
    ID.test(worker.id) &&
    worker.id.startsWith("worker-") &&
    (worker.remoteId === undefined ||
      (typeof worker.remoteId === "string" &&
        /^remote-[a-f0-9-]{36}$/.test(worker.remoteId))) &&
    typeof worker.name === "string" &&
    /^[A-Za-z0-9 -]{1,80}$/.test(worker.name) &&
    ["provisioning", "ready", "busy", "paused", "error"].includes(
      String(worker.status),
    ) &&
    typeof worker.busy === "boolean" &&
    typeof worker.paused === "boolean" &&
    validDate(worker.createdAt) &&
    (worker.verifiedAt === undefined || validDate(worker.verifiedAt)) &&
    (worker.message === undefined ||
      (typeof worker.message === "string" && worker.message.length <= 1000)) &&
    Object.keys(worker).every((key) =>
      [
        "id",
        "remoteId",
        "name",
        "status",
        "busy",
        "paused",
        "createdAt",
        "verifiedAt",
        "message",
      ].includes(key),
    )
  );
}

function safePath(path: string): void {
  let current = resolve(path);
  for (;;) {
    try {
      if (lstatSync(current).isSymbolicLink())
        throw new LocalRunnerError(
          "Local runner storage cannot contain symbolic links or junctions.",
        );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (current === parse(current).root) break;
    current = dirname(current);
  }
}

function jsonFile(file: string, limit: number): unknown {
  safePath(file);
  const info = lstatSync(file);
  if (!info.isFile() || info.nlink !== 1 || info.size > limit)
    throw new Error("Invalid state file");
  return JSON.parse(readFileSync(file, "utf8"));
}

function writeJson(file: string, value: unknown): void {
  safePath(file);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = join(dirname(file), `.state-${randomUUID()}.tmp`);
  const fd = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(fd, JSON.stringify(value, null, 2) + "\n");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, file);
}

export function createLocalRunners(options: LocalRunnersOptions): LocalRunners {
  const base = join(resolve(options.root), ".run", "local-runners");
  const stateFile = join(base, "state.json");
  const history = join(base, "history");
  const keys = join(base, "keys");
  const notifications = join(base, "notifications");
  const cancellations = join(base, "cancellations");
  const docker =
    options.docker ??
    createDockerRunners({
      packageRoot: options.packageRoot,
      environmentNamespace: options.root,
    });
  const clock = options.clock ?? (() => new Date());
  const tokenUsage = createUsage({ root: options.root, now: clock });
  let imageReady = false;
  let inFlight: Promise<void> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let lastScheduled = 0;
  let stopping = false;
  const background = new Set<Promise<void>>();
  const captures = new Map<string, Promise<void>>();
  const capturePending = new Map<string, LocalJob>();
  const captured = new Map<string, { fingerprint: string; at: number }>();
  const sideEffectWarnings = new Map<string, string>();
  const releasedResources = new Set<string>();
  let historicalTerminalEnvironments: Set<string> | undefined;
  let lastEnvironmentSweep: number | undefined;
  const now = () => clock().toISOString();

  async function releaseResources(job: LocalJob): Promise<void> {
    if (releasedResources.has(job.id)) return;
    try {
      await options.releaseJobResources?.(job.id);
      if (
        TERMINAL.has(job.status) &&
        !historicalTerminalEnvironments?.has(job.id)
      )
        await docker.cleanupEnvironment?.(job.id);
      sideEffectWarnings.delete(`resources:${job.id}`);
      if (TERMINAL.has(job.status)) releasedResources.add(job.id);
    } catch {
      sideEffectWarnings.set(
        `resources:${job.id}`,
        "Run resource cleanup is pending. Existing work and evidence are preserved; cleanup will retry.",
      );
    }
  }

  function track(promise: Promise<void>): void {
    background.add(promise);
    void promise
      .finally(() => background.delete(promise))
      .catch(() => undefined);
  }

  function capture(job: LocalJob): void {
    const store = options.activityStore;
    if (!store) return;
    const snapshot = { ...job };
    const fingerprint = JSON.stringify(snapshot);
    const previous = captured.get(job.id);
    if (
      previous?.fingerprint === fingerprint &&
      (job.status !== "running" || clock().getTime() - previous.at < 4000)
    )
      return;
    if (captures.has(job.id)) {
      capturePending.set(job.id, snapshot);
      return;
    }
    const task = (async () => {
      try {
        if (snapshot.status === "queued") await store.recordRun(snapshot);
        else await store.captureRun(snapshot, docker);
        captured.set(job.id, { fingerprint, at: clock().getTime() });
        sideEffectWarnings.delete(`storage:${job.id}`);
      } catch {
        sideEffectWarnings.set(
          `storage:${job.id}`,
          "Activity storage is unavailable. Docker logs and artifacts remain available; the job was not repeated.",
        );
      }
    })().finally(() => {
      captures.delete(job.id);
      const pending = capturePending.get(job.id);
      capturePending.delete(job.id);
      // Ensure a quick finish isn't lost behind an earlier running snapshot.
      if (
        pending &&
        (pending.status !== snapshot.status ||
          pending.finishedAt !== snapshot.finishedAt)
      )
        capture(pending);
    });
    captures.set(job.id, task);
    track(task);
  }

  function notificationPath(
    job: LocalJob,
    type: JobNotificationEvent["type"],
  ): string {
    return join(notifications, `${job.id}-${type}.json`);
  }

  function notify(job: LocalJob, workerName?: string): void {
    if (
      job.type === "verify" ||
      !["running", "succeeded", "failed"].includes(job.status)
    )
      return;
    const type: JobNotificationEvent["type"] =
      job.status === "running"
        ? "started"
        : job.status === "succeeded"
          ? "succeeded"
          : "failed";
    const file = notificationPath(job, type);
    const attemptedAt = now();
    try {
      safePath(file);
      mkdirSync(notifications, { recursive: true, mode: 0o700 });
      // Exclusive creation is the delivery claim across both processes and restarts.
      const fd = openSync(file, "wx", 0o600);
      try {
        writeFileSync(
          fd,
          JSON.stringify({ schema: 1, type, status: "attempted", attemptedAt }),
        );
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST")
        sideEffectWarnings.set(
          `slack:${job.id}`,
          "Slack delivery could not be recorded safely. No notification was sent; the job continues.",
        );
      return;
    }
    const snapshot = { ...job };
    track(
      (async () => {
        let result: NotificationResult;
        try {
          let details: JobNotificationEvent["result"];
          if (type === "succeeded") {
            try {
              details = notificationResult(
                (await docker.artifacts(snapshot.id)).result,
              );
            } catch {
              /* Still report the persisted completion, without unverified detail. */
            }
          }
          result = await (
            options.notify ??
            ((event) => sendJobNotification(options.root, event))
          )({
            id: `${snapshot.id}:${type}`,
            type,
            job: snapshot,
            workerName,
            result: details,
          });
        } catch {
          result = { status: "failed" };
        }
        try {
          // Persist only a fixed status, never provider response text or webhook URLs.
          writeJson(file, {
            schema: 1,
            type,
            status: ["sent", "skipped", "failed"].includes(result.status)
              ? result.status
              : "failed",
            attemptedAt,
            finishedAt: now(),
          });
        } catch {
          sideEffectWarnings.set(
            `slack:${job.id}`,
            "Slack delivery status could not be saved. Its recorded attempt will not repeat.",
          );
        }
      })(),
    );
  }

  function notificationLogs(job: LocalJob): string[] {
    const lines: string[] = [];
    for (const type of ["started", "succeeded", "failed"] as const) {
      const file = notificationPath(job, type);
      try {
        safePath(file);
        if (!existsSync(file)) continue;
        const value = jsonFile(file, 4096);
        if (!record(value)) throw new Error();
        if (value.status === "failed")
          lines.push(
            `[Slack] The ${type} notification could not be delivered. Check the Slack connection and channel permissions. This attempt will not repeat.`,
          );
        else if (value.status === "attempted")
          lines.push(
            `[Slack] The ${type} notification was attempted; delivery is not confirmed. It will not repeat after a restart.`,
          );
      } catch {
        lines.push(
          "[Slack] A delivery record could not be read. It has been preserved without resending.",
        );
      }
    }
    for (const key of [
      `slack:${job.id}`,
      `storage:${job.id}`,
      `resources:${job.id}`,
    ])
      if (sideEffectWarnings.has(key)) lines.push(sideEffectWarnings.get(key)!);
    return lines;
  }

  function empty(): State {
    return {
      schema: 1,
      nextRunId: 1,
      runners: [],
      jobs: [],
      launched: {},
      usage: {},
      operation: {
        phase: "idle",
        message: "Create a local worker to get started.",
      },
    };
  }

  function read(): State {
    try {
      safePath(stateFile);
      if (!existsSync(stateFile)) return empty();
      const state = jsonFile(stateFile, MAX_STATE_BYTES);
      if (
        !record(state) ||
        state.schema !== 1 ||
        !Number.isSafeInteger(state.nextRunId) ||
        Number(state.nextRunId) < 1 ||
        !Array.isArray(state.runners) ||
        state.runners.length > MAX_WORKERS ||
        !state.runners.every(validWorker) ||
        !Array.isArray(state.jobs) ||
        !state.jobs.every(validJob) ||
        !record(state.launched) ||
        (state.usage !== undefined && !validLedger(state.usage)) ||
        Object.entries(state.launched).some(
          ([id, value]) => !ID.test(id) || typeof value !== "boolean",
        ) ||
        !record(state.operation) ||
        !["idle", "working", "error"].includes(String(state.operation.phase)) ||
        typeof state.operation.message !== "string" ||
        state.operation.message.length > 1000 ||
        Object.keys(state.operation).some(
          (key) => !["phase", "message", "runnerId"].includes(key),
        ) ||
        (state.operation.runnerId !== undefined &&
          (typeof state.operation.runnerId !== "string" ||
            !ID.test(state.operation.runnerId))) ||
        Object.keys(state).some(
          (key) =>
            ![
              "schema",
              "nextRunId",
              "runners",
              "jobs",
              "launched",
              "operation",
              "usage",
            ].includes(key),
        )
      )
        throw new Error();
      const jobs = state.jobs as LocalJob[];
      const workers = state.runners as LocalWorker[];
      if (
        new Set(jobs.map((job) => job.id)).size !== jobs.length ||
        new Set(jobs.map((job) => job.runId)).size !== jobs.length ||
        new Set(workers.map((worker) => worker.id)).size !== workers.length ||
        jobs.some((job) => job.runId >= Number(state.nextRunId))
      )
        throw new Error();
      for (const worker of workers)
        if (
          jobs.filter(
            (job) => job.workerId === worker.id && job.status === "running",
          ).length > 1
        )
          throw new Error();
      return state as unknown as State;
    } catch {
      throw new LocalRunnerError(
        "Local runner state could not be read. Keep state.json for recovery; no workers or configuration have been replaced.",
        500,
      );
    }
  }

  function save(state: State): void {
    state.usage ??= {};
    const oldest = new Date(clock().getTime() - 31 * 86400000)
      .toISOString()
      .slice(0, 10);
    const activeDays = new Set(
      state.jobs
        .filter((job) => job.status === "running" && job.budget)
        .map((job) => `${job.budget!.day}:${job.project}`),
    );
    for (const key of Object.keys(state.usage))
      if (key.slice(0, 10) < oldest && !activeDays.has(key))
        delete state.usage[key];
    const terminal = state.jobs.filter((job) => TERMINAL.has(job.status));
    const archive = terminal.slice(
      0,
      Math.max(0, state.jobs.length - RECENT_JOBS),
    );
    for (const job of archive) writeJson(join(history, `${job.id}.json`), job);
    const archived = new Set(archive.map((job) => job.id));
    state.jobs = state.jobs.filter((job) => !archived.has(job.id));
    for (const job of archive) delete state.launched[job.id];
    writeJson(stateFile, state);
    // Side effects happen after durable transitions and do not hold up the queue.
    for (const job of [...state.jobs, ...archive])
      track(
        tokenUsage.captureJob(job, async (id, name) => {
          try {
            return await docker.readArtifact(id, name);
          } catch (error) {
            if (options.activityStore)
              return options.activityStore.readArtifact(id, name);
            throw error;
          }
        }),
      );
    for (const job of state.jobs) {
      capture(job);
      if (job.status !== "running" || state.launched[job.id])
        notify(
          job,
          state.runners.find((worker) => worker.id === job.workerId)?.name,
        );
    }
  }

  function acquire(): () => void {
    safePath(base);
    mkdirSync(base, { recursive: true, mode: 0o700 });
    const file = join(base, "state.lock");
    const owner = randomUUID();
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const fd = openSync(file, "wx", 0o600);
        try {
          writeFileSync(fd, JSON.stringify({ pid: process.pid, owner }));
        } finally {
          closeSync(fd);
        }
        return () => {
          try {
            const lock = jsonFile(file, 4096);
            if (record(lock) && lock.owner === owner) unlinkSync(file);
          } catch {
            /* Never release a different controller's lock. */
          }
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        let dead = false;
        try {
          const lock = jsonFile(file, 4096);
          if (
            record(lock) &&
            Number.isSafeInteger(lock.pid) &&
            Number(lock.pid) > 0
          ) {
            try {
              process.kill(Number(lock.pid), 0);
            } catch (check) {
              dead = (check as NodeJS.ErrnoException).code === "ESRCH";
            }
          }
        } catch {
          /* Invalid locks are preserved for manual inspection. */
        }
        if (!dead || attempt > 0)
          throw new LocalRunnerError(
            "Another local runner operation is in progress. Try again shortly.",
            409,
          );
        renameSync(file, join(base, `state.lock.abandoned-${randomUUID()}`));
      }
    }
    throw new LocalRunnerError("Local runner storage is locked.", 409);
  }

  async function exclusive<T>(
    operation: (state: State) => Promise<T> | T,
  ): Promise<T> {
    const release = acquire();
    try {
      return await operation(read());
    } catch (error) {
      if (error instanceof LocalRunnerError) throw error;
      throw new LocalRunnerError(
        "The local runner operation could not complete. Check Docker and storage permissions; saved configuration is unchanged.",
        500,
      );
    } finally {
      release();
    }
  }

  function archivedJob(id: string): LocalJob | undefined {
    if (!ID.test(id) || !id.startsWith("job-"))
      throw new LocalRunnerError("Choose a valid local job.");
    const file = join(history, `${id}.json`);
    safePath(file);
    if (!existsSync(file)) return undefined;
    try {
      const job = jsonFile(file, 16 * 1024);
      if (validJob(job) && job.id === id) return job;
    } catch {
      /* Use a safe recovery message rather than the file's content. */
    }
    throw new LocalRunnerError(
      "This job's saved history could not be read. Its Docker logs and artifacts have been preserved.",
      500,
    );
  }

  function keyedJob(state: State, key: string): LocalJob | undefined {
    const current = state.jobs.find((job) => job.idempotencyKey === key);
    if (current) return current;
    const file = join(
      keys,
      `${createHash("sha256").update(key).digest("hex")}.json`,
    );
    safePath(file);
    if (!existsSync(file)) return undefined;
    const value = jsonFile(file, 4096);
    if (!record(value) || typeof value.id !== "string" || !ID.test(value.id))
      throw new LocalRunnerError(
        "The local job index needs recovery. Existing jobs have been preserved.",
        500,
      );
    const job =
      state.jobs.find((item) => item.id === value.id) ?? archivedJob(value.id);
    if (job && job.idempotencyKey !== key)
      throw new LocalRunnerError("The local job index needs recovery.", 500);
    return job;
  }

  function queue(
    state: State,
    input: LocalJobInput,
    workerId?: string,
  ): LocalJob {
    if (!validInput(input))
      throw new LocalRunnerError(
        "Choose a valid project, job type, area or ticket, and retry key. Credentials and prompts are not accepted in queue requests.",
      );
    if (input.project) {
      try {
        assertResourceAvailable(options.root, input.project, input.area);
      } catch (error) {
        throw new LocalRunnerError(
          error instanceof Error
            ? error.message
            : "This resource is reserved for recovery.",
          409,
        );
      }
    }
    if (input.idempotencyKey) {
      const existing = keyedJob(state, input.idempotencyKey);
      if (existing) {
        if (
          JSON.stringify(
            inputOf(existing as unknown as Record<string, unknown>),
          ) !==
          JSON.stringify(inputOf(input as unknown as Record<string, unknown>))
        )
          throw new LocalRunnerError(
            "This retry key already identifies different work. Keep the original job or use a new key.",
            409,
          );
        return existing;
      }
    }
    if (
      state.jobs.some(
        (job) =>
          !TERMINAL.has(job.status) &&
          job.type === input.type &&
          job.project === input.project &&
          (input.type === "pm"
            ? job.area === input.area
            : input.type === "developer"
              ? job.ticket === input.ticket
              : false),
      )
    )
      throw new LocalRunnerError(
        "That PM or ticket already has a queued or running job. Wait for it to finish before starting another.",
        409,
      );
    if (state.jobs.filter((job) => !TERMINAL.has(job.status)).length >= 500)
      throw new LocalRunnerError(
        "The local queue has 500 unfinished jobs. Let existing work finish before adding more.",
        409,
      );
    const job: LocalJob = {
      ...input,
      ...(input.grumblin
        ? { grumblin: validateGrumblinProfileSnapshot(input.grumblin) }
        : {}),
      id: `job-${randomUUID()}`,
      runId: state.nextRunId++,
      status: "queued",
      createdAt: now(),
      retries: 0,
      ...(workerId ? { workerId } : {}),
    };
    state.jobs.push(job);
    if (input.idempotencyKey)
      writeJson(
        join(
          keys,
          `${createHash("sha256").update(input.idempotencyKey).digest("hex")}.json`,
        ),
        { id: job.id },
      );
    return job;
  }

  function verify(state: State, worker: LocalWorker): LocalJob {
    const pending = state.jobs.find(
      (job) =>
        job.type === "verify" &&
        job.workerId === worker.id &&
        !TERMINAL.has(job.status),
    );
    if (pending) return pending;
    worker.verifiedAt = undefined;
    worker.status = worker.paused ? "paused" : "provisioning";
    worker.message = "Browser verification is queued.";
    return queue(
      state,
      { type: "verify", idempotencyKey: `verify:${worker.id}:${randomUUID()}` },
      worker.id,
    );
  }

  function idleWorker(worker: LocalWorker): void {
    worker.busy = false;
    worker.status = worker.paused
      ? "paused"
      : worker.verifiedAt
        ? "ready"
        : "error";
  }

  function failed(
    state: State,
    job: LocalJob,
    worker: LocalWorker | undefined,
    message: string,
    exitCode?: number,
    category: FailureCategory = "worker-exit",
  ): void {
    job.status = "failed";
    job.message = message;
    job.finishedAt = now();
    job.failure = { category, at: now(), retryable: false };
    job.nextAttemptAt = undefined;
    settleBudget(job, (state.usage ??= {}), clock());
    if (exitCode !== undefined) job.exitCode = exitCode;
    if (worker) {
      if (job.type === "verify") worker.verifiedAt = undefined;
      idleWorker(worker);
      worker.message =
        job.type === "verify"
          ? "Browser verification failed. Repair this worker before using it."
          : "The last job failed. Its redacted logs are available.";
    }
    delete state.launched[job.id];
  }

  function retryBeforeLaunch(
    state: State,
    job: LocalJob,
    worker: LocalWorker | undefined,
  ): void {
    const retry = infrastructureRetry(
      job.retries ?? 0,
      state.launched[job.id] === true || Boolean(job.launchAttemptedAt),
      clock(),
    );
    if (retry) {
      settleBudget(job, (state.usage ??= {}), clock(), true);
      job.budget = undefined;
      Object.assign(job, retry);
      job.failure = { category: "infrastructure", at: now(), retryable: true };
      job.status = "queued";
      job.startedAt = undefined;
      job.message = `Infrastructure was unavailable before execution. Retry ${retry.retries} of 2 waits until ${retry.nextAttemptAt}.`;
      if (worker) {
        idleWorker(worker);
        if (job.type === "verify" && !worker.paused)
          worker.status = "provisioning";
      }
      if (job.type !== "verify") job.workerId = undefined;
    } else
      failed(
        state,
        job,
        worker,
        "The job container is unavailable. It was not automatically repeated to avoid duplicate work.",
        undefined,
        state.launched[job.id] || job.launchAttemptedAt
          ? "ambiguous-launch"
          : "infrastructure",
      );
  }

  function cancellation(
    job: LocalJob,
  ): { at: string; reason: "user" | "runtime-limit" } | null {
    const file = join(cancellations, `${job.id}.json`);
    safePath(file);
    if (!existsSync(file)) return null;
    const value = jsonFile(file, 1024);
    if (
      !record(value) ||
      !validDate(value.at) ||
      !["user", "runtime-limit"].includes(String(value.reason))
    )
      throw new LocalRunnerError(
        "A cancellation record needs repair; no work was repeated.",
        500,
      );
    return value as { at: string; reason: "user" | "runtime-limit" };
  }
  function requestCancellation(
    job: LocalJob,
    reason: "user" | "runtime-limit",
  ) {
    const existing = cancellation(job);
    if (existing) return existing;
    const request = { at: now(), reason };
    writeJson(join(cancellations, `${job.id}.json`), request);
    return request;
  }
  async function reconcileCancellation(
    state: State,
    job: LocalJob,
  ): Promise<boolean> {
    const request = cancellation(job);
    if (!request) return false;
    job.cancelRequestedAt = request.at;
    if (job.status === "running") {
      try {
        const container = await docker.inspectJob(job.id);
        if (container.exists && container.running) {
          await docker.stopJob(job.id);
          const stopped = await docker.inspectJob(job.id);
          if (stopped.exists && stopped.running) throw new Error();
        }
      } catch {
        job.message =
          "Cancellation is recorded. Waiting for Docker to confirm this job has stopped; its worker and credentials remain reserved.";
        return true;
      }
    }
    const worker = state.runners.find((item) => item.id === job.workerId);
    if (request.reason === "runtime-limit")
      failed(
        state,
        job,
        worker,
        "This run reached its configured runtime limit and was stopped. Review any output or draft publication before starting new work.",
        124,
        "runtime-limit",
      );
    else {
      settleBudget(job, (state.usage ??= {}), clock(), job.status === "queued");
      job.status = "canceled";
      job.finishedAt = now();
      job.nextAttemptAt = undefined;
      job.message =
        "Canceled. The local container is stopped; existing outputs and any external changes are preserved for review.";
      delete state.launched[job.id];
      if (worker) {
        if (job.type === "verify") worker.verifiedAt = undefined;
        idleWorker(worker);
      }
    }
    return true;
  }

  function executionUsage(state: State, project: string, ignoreId?: string) {
    return usageFor(
      project,
      validateLimits(options.executionLimits?.(project) ?? {}),
      (state.usage ??= {}),
      state.jobs.filter((job) => job.id !== ignoreId),
      clock(),
      existsSync(join(options.root, "projects", project, "project.json"))
        ? loadProject(options.root, project).config.instanceId
        : undefined,
    );
  }
  function canLaunch(state: State, job: LocalJob): boolean {
    if (job.nextAttemptAt && Date.parse(job.nextAttemptAt) > clock().getTime())
      return false;
    if (job.type === "verify" || !job.project) return true;
    try {
      const blocked = options.admissionBlocker?.(
        job,
        state.jobs.filter(
          (item) => item.status === "running" && item.id !== job.id,
        ),
      );
      if (blocked) {
        job.message = blocked.slice(0, 1000);
        return false;
      }
      const usage = executionUsage(state, job.project, job.id);
      if (usage.blockedReason) {
        job.message = usage.blockedReason;
        return false;
      }
      return true;
    } catch {
      job.message =
        "Execution limits could not be read. Repair project settings before this queued job can run.";
      return false;
    }
  }

  async function reconcile(state: State, job: LocalJob): Promise<void> {
    if (await reconcileCancellation(state, job)) return;
    const worker = state.runners.find((item) => item.id === job.workerId);
    let container: Awaited<ReturnType<DockerRunners["inspectJob"]>>;
    try {
      container = await docker.inspectJob(job.id);
    } catch {
      state.operation = {
        phase: "error",
        message:
          "Docker is temporarily unavailable. Running jobs have not been retried.",
      };
      return;
    }
    if (!container.exists) {
      retryBeforeLaunch(state, job, worker);
      return;
    }
    state.launched[job.id] = true;
    if (container.running) {
      if (
        job.budget &&
        clock().getTime() - Date.parse(job.budget.startedAt) >=
          job.budget.maxMinutes * 60000
      ) {
        requestCancellation(job, "runtime-limit");
        await reconcileCancellation(state, job);
        return;
      }
      if (worker) {
        worker.busy = true;
        worker.status = worker.paused ? "paused" : "busy";
      }
      return;
    }
    if (container.status !== "exited" || container.exitCode !== 0) {
      failed(
        state,
        job,
        worker,
        "The worker job stopped unsuccessfully. Inspect its redacted logs before retrying.",
        container.exitCode,
      );
      return;
    }
    settleBudget(job, (state.usage ??= {}), clock());
    if (job.nextAttemptAt && Date.parse(job.nextAttemptAt) > clock().getTime())
      return;
    if (job.type === "verify") {
      try {
        const artifacts = await docker.artifacts(job.id);
        const proof = artifacts.result;
        const screenshot = artifacts.files.find(
          (file) => file.name === "screenshot.png",
        );
        if (
          !record(proof) ||
          proof.ok !== true ||
          proof.nonce !== job.id ||
          proof.browser !== "chromium" ||
          proof.screenshot !== "screenshot.png" ||
          !screenshot ||
          screenshot.size <= 8 ||
          !/^[a-f0-9]{64}$/.test(screenshot.sha256 ?? "")
        )
          throw new Error();
        const bytes = await docker.readArtifact(job.id, "screenshot.png");
        if (
          !bytes
            .subarray(0, 8)
            .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
          createHash("sha256").update(bytes).digest("hex") !== screenshot.sha256
        )
          throw new Error();
        if (worker) worker.verifiedAt = now();
      } catch {
        failed(
          state,
          job,
          worker,
          "The browser check did not produce matching PNG evidence. This worker is not ready.",
        );
        return;
      }
    } else {
      try {
        const result = (await docker.artifacts(job.id)).result;
        if (!record(result) || result.ok !== true || result.kind !== job.type)
          throw new Error();
        if (job.type === "pm") {
          if (
            (job.pmMode === "discovery" || job.pmMode === "grumblin") &&
            !options.completeJob
          )
            throw new Error();
          if (
            job.pmMode === "grumblin" &&
            (result.pmMode !== "grumblin" ||
              result.nonce !== job.id ||
              !isDeepStrictEqual(result.grumblin, job.grumblin))
          )
            throw new Error();
          await options.completeJob?.({ ...job, finishedAt: now() }, docker);
        }
        if (options.reconcileCompletedJob) {
          try {
            await options.reconcileCompletedJob(
              { ...job, finishedAt: now() },
              result,
              docker,
            );
          } catch {
            job.reconciliationAttempts = (job.reconciliationAttempts ?? 0) + 1;
            if (job.reconciliationAttempts < 3) {
              job.failure = {
                category: "completion",
                at: now(),
                retryable: true,
              };
              job.nextAttemptAt = new Date(
                clock().getTime() + 30_000 * job.reconciliationAttempts,
              ).toISOString();
              job.message =
                "Worker finished. Delivery reconciliation is pending; only its completion record will be retried, never the agent or publication.";
              return;
            }
            failed(
              state,
              job,
              worker,
              "Worker finished but delivery reconciliation needs attention. Inspect the existing draft and evidence; the agent and publication were not repeated.",
              undefined,
              "completion",
            );
            return;
          }
        }
      } catch {
        failed(
          state,
          job,
          worker,
          job.pmMode === "discovery"
            ? "Discovery could not save a matching knowledge snapshot. Previous knowledge was preserved; review its artifacts and current PM brief before retrying."
            : "The agent exited without a matching completion record or knowledge snapshot. Inspect its logs and artifacts before retrying; previous knowledge was preserved.",
          undefined,
          "completion",
        );
        return;
      }
    }
    job.status = "succeeded";
    job.exitCode = 0;
    job.finishedAt = now();
    job.nextAttemptAt = undefined;
    job.failure = undefined;
    job.message =
      job.type === "verify"
        ? "Chromium started and a matching screenshot was verified."
        : job.pmMode === "discovery"
          ? "Discovery finished and its repository knowledge was saved."
          : "The local worker completed this job.";
    delete state.launched[job.id];
    if (worker) {
      idleWorker(worker);
      worker.message = worker.paused
        ? "Paused. The current job has finished."
        : "Ready for queued work.";
    }
  }

  async function launch(
    state: State,
    job: LocalJob,
    worker: LocalWorker,
  ): Promise<void> {
    if (stopping) return;
    if (await reconcileCancellation(state, job)) {
      save(state);
      if (job.status !== "running") await releaseResources(job);
      return;
    }
    if (!canLaunch(state, job)) return;
    const keepQueued = async () => {
      job.status = "queued";
      job.startedAt = undefined;
      job.message =
        "The controller stopped before launch. This job remains queued.";
      delete state.launched[job.id];
      idleWorker(worker);
      if (job.type === "verify" && !worker.paused)
        worker.status = "provisioning";
      state.operation = {
        phase: "idle",
        message: "The local controller has stopped scheduling.",
      };
      save(state);
      await releaseResources(job);
    };
    job.workerId = worker.id;
    job.status = "running";
    job.startedAt = now();
    job.nextAttemptAt = undefined;
    job.message = "Preparing an isolated job container.";
    worker.busy = true;
    worker.status = worker.verifiedAt ? "busy" : "provisioning";
    state.launched[job.id] = false;
    state.operation = {
      phase: "working",
      message: "Preparing the local worker image and job container.",
      runnerId: worker.id,
    };
    save(state);
    try {
      await options.beforeLaunch?.();
      if (stopping) {
        await keepQueued();
        return;
      }
      if (docker.prepareWorker)
        await docker.prepareWorker(worker.id, worker.remoteId);
      else if (!imageReady) {
        await docker.ensureImage();
        imageReady = true;
      }
    } catch {
      if (stopping) {
        await keepQueued();
        return;
      }
      retryBeforeLaunch(state, job, worker);
      save(state);
      await releaseResources(job);
      return;
    }
    if (stopping) {
      await keepQueued();
      return;
    }
    let payload: DockerJobPayload;
    try {
      payload =
        job.type === "verify"
          ? { kind: "verify", nonce: job.id }
          : await options.prepareJob!(job);
      if (
        !payload ||
        payload.kind !== job.type ||
        payload.pmMode !== job.pmMode ||
        !isDeepStrictEqual(payload.grumblin, job.grumblin)
      )
        throw new Error();
    } catch (error) {
      if (stopping) {
        await keepQueued();
        return;
      }
      if (error instanceof LocalJobDeferredError) {
        job.status = "queued";
        job.startedAt = undefined;
        job.message = error.message;
        job.failure = {
          category: error.category,
          at: now(),
          retryable: true,
        };
        job.nextAttemptAt = new Date(clock().getTime() + 30_000).toISOString();
        delete state.launched[job.id];
        idleWorker(worker);
        save(state);
        await releaseResources(job);
        return;
      }
      failed(
        state,
        job,
        worker,
        "This job could not be prepared. Check project configuration and saved connections. No agent was started.",
        undefined,
        "configuration",
      );
      save(state);
      await releaseResources(job);
      return;
    }
    if (stopping) {
      await keepQueued();
      return;
    }
    if (await reconcileCancellation(state, job)) {
      save(state);
      if (job.status !== "running") await releaseResources(job);
      return;
    }
    if (job.project) {
      let limits: ExecutionLimits;
      try {
        limits = validateLimits(options.executionLimits?.(job.project) ?? {});
      } catch {
        failed(
          state,
          job,
          worker,
          "Execution limits changed during preparation. Repair the project settings before starting a new run.",
          undefined,
          "configuration",
        );
        save(state);
        await releaseResources(job);
        return;
      }
      job.budget =
        reserveBudget(
          job.project,
          limits,
          (state.usage ??= {}),
          state.jobs.filter((item) => item.id !== job.id),
          clock(),
          job.projectInstanceId,
        ) ?? undefined;
      if (!job.budget) {
        job.status = "queued";
        job.startedAt = undefined;
        job.message = executionUsage(state, job.project, job.id).blockedReason;
        idleWorker(worker);
        save(state);
        await releaseResources(job);
        return;
      }
      payload.maxRuntimeMinutes = job.budget.maxMinutes;
      save(state);
    }
    try {
      job.launchAttemptedAt = now();
      save(state);
      if (job.project) payload.project = job.project;
      await docker.startJob({ id: job.id, workerId: worker.id, payload });
      state.launched[job.id] = true;
      job.message = "Running in an isolated Docker container.";
      job.failure = undefined;
      worker.status = "busy";
    } catch {
      try {
        const container = await docker.inspectJob(job.id);
        if (container.exists) {
          state.launched[job.id] = true;
          await reconcile(state, job);
        } else retryBeforeLaunch(state, job, worker);
      } catch {
        // An ambiguous launch is reconciled by deterministic container ID on the
        // next tick; it must never be blindly retried while Docker is unreachable.
        job.message = "Waiting for Docker to confirm whether this job started.";
        job.failure = {
          category: "ambiguous-launch",
          at: now(),
          retryable: false,
        };
      }
    }
    save(state);
    if (job.status !== "running") await releaseResources(job);
  }

  async function tickOnce(): Promise<void> {
    await exclusive(async (state) => {
      // One namespace sweep recovers historical resources. Avoid three Docker
      // subprocesses per retained terminal run when restarting a large history.
      if (docker.reconcileEnvironments && !historicalTerminalEnvironments)
        historicalTerminalEnvironments = new Set(
          state.jobs
            .filter((job) => TERMINAL.has(job.status))
            .map((job) => job.id),
        );
      state.operation = {
        phase: "idle",
        message: "Local workers are watching the queue.",
      };
      for (const job of state.jobs.filter(
        (item) => item.status === "running",
      )) {
        await reconcile(state, job);
        if (job.status === "queued") {
          // A restart can discover a lease acquired just before a crash, with no
          // container created. Release it before retrying the same durable job.
          save(state);
          await releaseResources(job);
        }
      }
      save(state);
      for (const job of state.jobs.filter((item) => item.status === "queued"))
        await reconcileCancellation(state, job);
      for (const job of state.jobs.filter((item) => TERMINAL.has(item.status)))
        await releaseResources(job);
      if (
        lastEnvironmentSweep === undefined ||
        clock().getTime() - lastEnvironmentSweep >= 60_000
      ) {
        lastEnvironmentSweep = clock().getTime();
        await docker
          .reconcileEnvironments?.(
            state.jobs
              .filter((job) => !TERMINAL.has(job.status))
              .map((job) => job.id),
          )
          .catch(() => {
            state.operation = {
              phase: "error",
              message:
                "Disposable environment cleanup needs attention. Check Docker; active jobs were preserved.",
            };
          });
      }
      if (stopping) {
        state.operation = {
          phase: "idle",
          message: "The local controller has stopped scheduling.",
        };
        save(state);
        return;
      }
      if (
        options.scheduledJobs &&
        clock().getTime() - lastScheduled >= 60_000
      ) {
        lastScheduled = clock().getTime();
        try {
          const scheduled = await options.scheduledJobs();
          for (const input of stopping ? [] : scheduled) {
            if (!input.idempotencyKey) throw new Error();
            try {
              queue(state, input);
            } catch (error) {
              if (!(error instanceof LocalRunnerError) || error.status !== 409)
                throw error;
            }
          }
        } catch {
          state.operation = {
            phase: "error",
            message:
              "Scheduled work could not be checked. Existing jobs continue; check project configuration and connections.",
          };
        }
        save(state);
      }
      for (const worker of state.runners) {
        if (stopping) break;
        if (
          worker.paused ||
          state.jobs.some(
            (job) => job.workerId === worker.id && job.status === "running",
          )
        )
          continue;
        const job =
          state.jobs.find(
            (item) =>
              item.status === "queued" &&
              item.type === "verify" &&
              item.workerId === worker.id &&
              canLaunch(state, item),
          ) ??
          (worker.verifiedAt
            ? state.jobs.find(
                (item) =>
                  item.status === "queued" &&
                  item.type !== "verify" &&
                  (!item.workerId || item.workerId === worker.id) &&
                  (docker.canRun?.(worker.remoteId, item.project) ?? true) &&
                  canLaunch(state, item),
              )
            : undefined);
        if (job) await launch(state, job, worker);
      }
      if (stopping)
        state.operation = {
          phase: "idle",
          message: "The local controller has stopped scheduling.",
        };
      else if (state.operation.phase !== "error")
        state.operation = {
          phase: "idle",
          message: state.jobs.some((job) => job.status === "running")
            ? "Local jobs are running. Closing this dashboard does not stop their containers."
            : "Local workers are watching the queue.",
        };
      save(state);
    });
  }

  async function allJobs(): Promise<LocalJob[]> {
    const state = read();
    safePath(history);
    if (existsSync(history))
      for (const file of readdirSync(history)) {
        const id = file.replace(/\.json$/, "");
        if (file !== `${id}.json` || !ID.test(id) || !id.startsWith("job-"))
          continue;
        if (!state.jobs.some((job) => job.id === id)) {
          const archived = archivedJob(id);
          if (archived) state.jobs.push(archived);
        }
      }
    return state.jobs.map(visibleJob).sort((a, b) => b.runId - a.runId);
  }
  function visibleJob(job: LocalJob): LocalJob {
    if (TERMINAL.has(job.status)) return job;
    const request = cancellation(job);
    return request
      ? {
          ...job,
          cancelRequestedAt: request.at,
          message:
            "Cancellation requested. Waiting for this job's local container to stop.",
        }
      : job;
  }

  async function findJob(id: string | number): Promise<LocalJob | null> {
    if (typeof id === "number")
      return (
        (await allJobs()).find((job) => job.runId === id) ??
        (await options.activityStore?.getRun(id).catch(() => null)) ??
        null
      );
    if (!ID.test(id) || !id.startsWith("job-"))
      throw new LocalRunnerError("Choose a valid local job.");
    return (
      read()
        .jobs.map(visibleJob)
        .find((job) => job.id === id) ??
      archivedJob(id) ??
      (await options.activityStore?.getRun(id).catch(() => null)) ??
      null
    );
  }

  async function requireJob(id: string): Promise<LocalJob> {
    const job = await findJob(id);
    if (!job) throw new LocalRunnerError("That local job was not found.", 404);
    return job;
  }

  const api: LocalRunners = {
    async status() {
      const state = read();
      return {
        runners: state.runners,
        jobs: state.jobs
          .slice()
          .map(visibleJob)
          .sort((a, b) => b.runId - a.runId)
          .slice(0, 100),
        operation: state.operation,
        execution: [
          ...new Set(
            state.jobs.flatMap((job) => (job.project ? [job.project] : [])),
          ),
        ].map((project) => {
          try {
            return executionUsage(state, project);
          } catch {
            return {
              project,
              day: now().slice(0, 10),
              limits: {},
              runsStarted: 0,
              runtimeMinutes: 0,
              reservedRuntimeMinutes: 0,
              runningJobs: 0,
              blockedReason:
                "Execution settings are unavailable; no new jobs will launch.",
            };
          }
        }),
      };
    },
    create: () =>
      exclusive((state) => {
        if (state.runners.length >= MAX_WORKERS)
          throw new LocalRunnerError(
            "This machine already has four local workers. Reuse an existing worker or remove an idle one first.",
            409,
          );
        const worker: LocalWorker = {
          id: `worker-${randomUUID()}`,
          name: `Local gremlin ${state.runners.length + 1}`,
          status: "provisioning",
          busy: false,
          paused: false,
          createdAt: now(),
        };
        state.runners.push(worker);
        verify(state, worker);
        state.operation = {
          phase: "idle",
          message: "Worker created. Its browser check is queued.",
          runnerId: worker.id,
        };
        save(state);
        return worker;
      }),
    addRemote: (remoteId, name) =>
      exclusive((state) => {
        if (
          !/^remote-[a-f0-9-]{36}$/.test(remoteId) ||
          !/^[A-Za-z0-9 -]{1,80}$/.test(name)
        )
          throw new LocalRunnerError("Choose a valid enrolled remote worker.");
        const existing = state.runners.find(
          (worker) => worker.remoteId === remoteId,
        );
        if (existing) return existing;
        if (state.runners.length >= MAX_WORKERS)
          throw new LocalRunnerError(
            "This workspace already has four worker slots.",
            409,
          );
        const worker: LocalWorker = {
          id: `worker-${randomUUID()}`,
          remoteId,
          name,
          status: "provisioning",
          busy: false,
          paused: false,
          createdAt: now(),
        };
        state.runners.push(worker);
        verify(state, worker);
        save(state);
        return worker;
      }),
    action: (id, action) =>
      exclusive((state) => {
        const worker = state.runners.find((item) => item.id === id);
        if (!worker)
          throw new LocalRunnerError("That local worker was not found.", 404);
        if (!["verify", "pause", "resume", "repair", "remove"].includes(action))
          throw new LocalRunnerError("Choose a valid worker action.");
        const busy = state.jobs.some(
          (job) => job.workerId === id && job.status === "running",
        );
        if (action === "pause") {
          worker.paused = true;
          worker.status = "paused";
          worker.message = busy
            ? "Paused. The current job will finish before this worker stops accepting work."
            : "Paused. Queued work will wait.";
        } else if (action === "resume") {
          worker.paused = false;
          worker.status = busy
            ? "busy"
            : worker.verifiedAt
              ? "ready"
              : "provisioning";
          if (!busy && !worker.verifiedAt) verify(state, worker);
        } else {
          if (busy)
            throw new LocalRunnerError(
              "This worker is running a job. Pause it and wait for the current job to finish first.",
              409,
            );
          if (action === "remove") {
            for (const job of state.jobs.filter(
              (item) => item.workerId === id && item.status === "queued",
            )) {
              if (job.type === "verify") {
                job.status = "canceled";
                job.finishedAt = now();
                job.message =
                  "The idle worker was removed before verification started.";
              } else job.workerId = undefined;
            }
            state.runners = state.runners.filter((item) => item.id !== id);
            save(state);
            return;
          }
          if (action === "repair") imageReady = false;
          worker.paused = false;
          verify(state, worker);
        }
        save(state);
        return worker;
      }),
    withConfigurationMutation: async (target, operation) => {
      if (
        (target.project !== undefined && !NAME.test(target.project)) ||
        (target.area !== undefined &&
          (!target.project || !NAME.test(target.area)))
      )
        throw new LocalRunnerError("Choose a valid configuration target.");
      const release = acquire();
      try {
        const jobs = read().jobs;
        if (
          jobs.some(
            (job) =>
              (!target.project || job.project === target.project) &&
              (!target.area || job.area === target.area) &&
              !TERMINAL.has(job.status),
          )
        )
          throw new LocalRunnerError(
            "Configuration is in use by queued, running, or recoverable jobs. Cancel queued work and resolve active or pending delivery reconciliation before deleting or restoring it.",
            409,
          );
        return await operation();
      } finally {
        release();
      }
    },
    enqueue: (input) =>
      exclusive((state) => {
        if (!validInput(input))
          throw new LocalRunnerError(
            "Choose a valid local job request. Credentials and prompts are not queue fields.",
          );
        if (input.type === "verify")
          throw new LocalRunnerError(
            "Use a worker's Verify action to queue its browser check.",
          );
        const job = queue(state, input);
        save(state);
        return job;
      }),
    async cancel(id) {
      const job = await requireJob(id);
      if (TERMINAL.has(job.status)) return job;
      const request = requestCancellation(job, "user");
      try {
        return await exclusive(async (state) => {
          const current = state.jobs.find((item) => item.id === id);
          if (!current) return job;
          if (!TERMINAL.has(current.status)) {
            await reconcileCancellation(state, current);
            save(state);
            if (TERMINAL.has(current.status)) await releaseResources(current);
          }
          return current;
        });
      } catch (error) {
        if (error instanceof LocalRunnerError && error.status === 409) {
          // A bounded completion phase can hold the queue lock. The durable
          // request is already saved, so stop only this admitted job now and
          // leave state/credential reconciliation to the queue transaction.
          if (job.status === "running" && job.launchAttemptedAt)
            await docker.stopJob(job.id).catch(() => {});
          return {
            ...job,
            cancelRequestedAt: request.at,
            message:
              "Cancellation recorded. The controller will stop this job before admitting more work.",
          };
        }
        throw error;
      }
    },
    jobs: allJobs,
    job: findJob,
    async logs(id) {
      const job = await requireJob(id);
      let logs: string;
      try {
        logs = await docker.logs(id);
      } catch {
        const stored = await options.activityStore?.logs(id).catch(() => []);
        if (!stored?.length)
          throw new LocalRunnerError(
            "Job logs are unavailable. Check Docker and activity storage.",
            503,
          );
        logs = stored.join("\n");
      }
      return [
        ...publicActivityLogs(logs).slice(-1000),
        ...notificationLogs(job),
      ];
    },
    async artifacts(id) {
      const job = await requireJob(id);
      // Output is still being written and has not passed final sanitization.
      // Do not ask Docker or a recovering database for unfinished artifacts.
      if (job.status === "queued" || job.status === "running") return [];
      try {
        return (await docker.artifacts(id)).files;
      } catch {
        const stored = await options.activityStore
          ?.artifacts(id)
          .catch(() => []);
        if (!stored?.length)
          throw new LocalRunnerError(
            "Artifacts are unavailable. Check Docker and activity storage.",
            503,
          );
        return stored;
      }
    },
    async readArtifact(id, name) {
      await requireJob(id);
      try {
        return await docker.readArtifact(id, name);
      } catch {
        if (options.activityStore)
          return options.activityStore.readArtifact(id, name);
        throw new LocalRunnerError(
          "That artifact is unavailable. Check Docker and activity storage.",
          404,
        );
      }
    },
    tick() {
      if (inFlight) return inFlight;
      inFlight = tickOnce().finally(() => {
        inFlight = undefined;
      });
      return inFlight;
    },
    start() {
      if (timer) return;
      stopping = false;
      const poll = () => {
        void api.tick().catch(() => {
          /* Durable state is kept intact; retry on the next tick. */
        });
      };
      timer = setInterval(poll, 5000);
      poll();
    },
    async stop() {
      stopping = true;
      tokenUsage.cancelPendingReads();
      if (timer) clearInterval(timer);
      timer = undefined;
      await inFlight;
      tokenUsage.cancelPendingReads();
      // Delivery has a short timeout; flushing here preserves its final status.
      while (background.size) await Promise.allSettled([...background]);
    },
  };
  return api;
}
