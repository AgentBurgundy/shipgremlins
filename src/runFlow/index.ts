import { createHash, randomBytes } from "node:crypto";
import {
  constants,
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import type { LocalJob } from "../localRunners/types.ts";
import type { AiSelection } from "../ai/provider.ts";
import { validateAiSelection } from "../../runner-local/codex.mjs";
import { safeOAuthPath } from "../oauthConnection/storage.ts";
import { writePrivate } from "../remoteWorkers/storage.ts";
import {
  applyRunFlowEvent,
  parseRunFlowLine,
  validRunFlowAuthorization,
  RUN_FLOW_PREFIX,
  type RunFlowAuthorization,
  type RunFlowSnapshot,
  type RunFlowState,
} from "../../runner-local/run-flow.mjs";
export type {
  RunFlowAuthorization,
  RunFlowSnapshot,
} from "../../runner-local/run-flow.mjs";

const MAX_LOG_BYTES = 1024 * 1024,
  MAX_RECORD_BYTES = 1024 * 1024,
  CACHE_MS = 2000,
  TERMINAL_RETRY_MS = 60_000,
  STALE_MS = 15_000,
  READ_TIMEOUT_MS = 600,
  RESPONSE_BUDGET_MS = 700;
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const only = (value: Record<string, unknown>, keys: string[]) =>
  Object.keys(value).every((key) => keys.includes(key));
const fail = () =>
  new Error("Trusted run progress could not be read or saved safely.");
interface SavedAuthorization {
  version: 1;
  identity: string;
  authorization: RunFlowAuthorization;
  ai?: AiSelection;
}
interface SavedEvents {
  version: 1;
  identity: string;
  observedAt: string;
  lines: string[];
}
type ReadLogs = (id: string) => Promise<string | string[]>;
type EnrichedJob<T extends LocalJob> = Omit<T, "flow" | "ai"> & {
  flow?: RunFlowSnapshot;
  ai?: AiSelection;
};
function identity(job: LocalJob) {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(job.id) ||
    !Number.isSafeInteger(job.runId) ||
    job.runId < 1 ||
    !["developer", "pm", "verify"].includes(job.type) ||
    typeof job.createdAt !== "string" ||
    job.createdAt.length > 40 ||
    !Number.isFinite(Date.parse(job.createdAt)) ||
    (job.project !== undefined &&
      !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(job.project)) ||
    (job.projectInstanceId !== undefined &&
      !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(
        job.projectInstanceId,
      ))
  )
    throw fail();
  const value = JSON.stringify([
    job.id,
    job.runId,
    job.type,
    job.project ?? null,
    job.projectInstanceId ?? null,
    job.area ?? null,
    job.ticket ?? null,
    job.attempt ?? null,
    job.developerKind ?? null,
    job.branch ?? null,
    job.pr ?? null,
    job.createdAt,
    job.pmMode ?? null,
  ]);
  if (value.length > 4096) throw fail();
  return value;
}
function readPrivate(file: string): unknown {
  safeOAuthPath(file);
  const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.size > MAX_RECORD_BYTES ||
      (process.platform !== "win32" && (stat.mode & 0o077) !== 0)
    )
      throw fail();
    return JSON.parse(readFileSync(fd, "utf8"));
  } finally {
    closeSync(fd);
  }
}
function logLines(logs: string | string[]): string[] {
  const chunks = typeof logs === "string" ? [logs] : logs;
  if (!Array.isArray(chunks)) throw fail();
  let size = 0;
  const retained: string[] = [];
  for (
    let index = chunks.length - 1;
    index >= 0 && size < MAX_LOG_BYTES;
    index--
  ) {
    const chunk = chunks[index];
    if (typeof chunk !== "string") throw fail();
    const available = MAX_LOG_BYTES - size;
    // Protocol lines are ASCII. A cut UTF-8 or partial line cannot authenticate.
    const tail = Buffer.from(chunk).subarray(-available).toString("utf8");
    retained.unshift(tail);
    size += Buffer.byteLength(tail) + 1;
  }
  return retained
    .join("\n")
    .split(/\r?\n/)
    .filter((line) => line.startsWith(RUN_FLOW_PREFIX));
}
export function createRunFlows({
  root,
  now = () => new Date(),
}: {
  root: string;
  now?: () => Date;
}) {
  const directory = join(root, ".run", "run-flows"),
    secrets = new Set<string>(),
    checked = new Map<string, number>(),
    checkedTerminal = new Map<string, { at: number; stamp: string }>(),
    observed = new Map<string, string>(),
    pendingReads = new Map<string, Promise<string | string[]>>(),
    completedReads = new Map<string, string>(),
    stale = new Set<string>();
  let batch: Promise<void> | undefined;
  let secretsStamp: string | undefined;
  const name = (job: LocalJob) =>
    createHash("sha256").update(job.id).digest("hex");
  const authFile = (job: LocalJob) =>
    join(directory, "authorizations", `${name(job)}.json`);
  const eventsFile = (job: LocalJob) =>
    join(directory, "snapshots", `${name(job)}.json`);
  function savedAuthorization(job: LocalJob): SavedAuthorization | undefined {
    const expected = identity(job),
      file = authFile(job);
    safeOAuthPath(file);
    if (!existsSync(file)) return undefined;
    const value = readPrivate(file);
    if (
      !object(value) ||
      !only(value, ["version", "identity", "authorization", "ai"]) ||
      value.version !== 1 ||
      value.identity !== expected ||
      !validRunFlowAuthorization(value.authorization)
    )
      throw fail();
    if (value.ai !== undefined) validateAiSelection(value.ai);
    secrets.add(value.authorization.key);
    return value as unknown as SavedAuthorization;
  }
  function retained(job: LocalJob, auth: SavedAuthorization) {
    const file = eventsFile(job);
    safeOAuthPath(file);
    if (!existsSync(file))
      return {
        lines: [] as string[],
        state: undefined as RunFlowState | undefined,
        observedAt: undefined as string | undefined,
      };
    const value = readPrivate(file);
    if (
      !object(value) ||
      !only(value, ["version", "identity", "observedAt", "lines"]) ||
      value.version !== 1 ||
      value.identity !== auth.identity ||
      typeof value.observedAt !== "string" ||
      !Number.isFinite(Date.parse(value.observedAt)) ||
      !Array.isArray(value.lines) ||
      value.lines.length > 256
    )
      throw fail();
    let state: RunFlowState | undefined;
    for (const line of value.lines) {
      const event = parseRunFlowLine(line, {
        authorization: auth.authorization,
        jobId: job.id,
        kind: job.type,
      });
      if (!event || event.sequence <= (state?.sequence ?? 0)) throw fail();
      const next = applyRunFlowEvent(state, event);
      if (!next || next === state) throw fail();
      state = next;
    }
    return {
      lines: value.lines as string[],
      state,
      observedAt: value.observedAt,
    };
  }
  function authorization(
    job: LocalJob,
    ai?: AiSelection,
  ): RunFlowAuthorization {
    const expected = identity(job),
      previous = savedAuthorization(job),
      selection = ai === undefined ? previous?.ai : validateAiSelection(ai);
    if (previous && JSON.stringify(previous.ai) === JSON.stringify(selection))
      return { ...previous.authorization };
    if (previous && retained(job, previous).state)
      throw new Error(
        "This run already has trusted AI provenance. Start a new run to change its AI provider.",
      );
    const value: SavedAuthorization = {
      version: 1,
      identity: expected,
      authorization: {
        version: 1,
        key: randomBytes(32).toString("hex"),
        maxRepairs: 2,
      },
      ...(selection ? { ai: selection } : {}),
    };
    writePrivate(authFile(job), JSON.stringify(value));
    secrets.add(value.authorization.key);
    return { ...value.authorization };
  }
  function capture(
    job: LocalJob,
    logs: string | string[],
  ): RunFlowSnapshot | undefined {
    try {
      const auth = savedAuthorization(job);
      if (!auth) return undefined;
      const previous = retained(job, auth);
      let state = previous.state;
      const lines = [...previous.lines];
      for (const line of logLines(logs)) {
        const event = parseRunFlowLine(line, {
          authorization: auth.authorization,
          jobId: job.id,
          kind: job.type,
        });
        if (!event || event.sequence <= (state?.sequence ?? 0)) continue;
        const next = applyRunFlowEvent(state, event);
        if (!next || next === state) continue;
        state = next;
        lines.push(line);
      }
      if (state && lines.length !== previous.lines.length) {
        const value: SavedEvents = {
          version: 1,
          identity: auth.identity,
          observedAt: now().toISOString(),
          lines,
        };
        writePrivate(eventsFile(job), JSON.stringify(value));
      }
      checked.set(name(job), +now());
      observed.set(name(job), now().toISOString());
      stale.delete(name(job));
      return flow(job);
    } catch {
      stale.add(name(job));
      return flow(job);
    }
  }
  function detail(job: LocalJob): { flow?: RunFlowSnapshot; ai?: AiSelection } {
    try {
      const auth = savedAuthorization(job);
      if (!auth) return {};
      const value = retained(job, auth),
        snapshot = value.state?.snapshot,
        observedAt = observed.get(name(job)) ?? value.observedAt;
      const expired =
        stale.has(name(job)) ||
        (["queued", "running"].includes(job.status) &&
          (!observedAt || +now() - Date.parse(observedAt) > STALE_MS));
      return {
        ...(value.state && auth.ai ? { ai: { ...auth.ai } } : {}),
        ...(snapshot
          ? {
              flow: {
                ...snapshot,
                freshness: expired
                  ? "stale"
                  : ["queued", "running"].includes(job.status)
                    ? "live"
                    : "complete",
                stale: expired,
                ...(observedAt ? { observedAt } : {}),
              } as RunFlowSnapshot,
            }
          : {}),
      };
    } catch {
      return {};
    }
  }
  function flow(job: LocalJob) {
    return detail(job).flow;
  }
  async function refresh(job: LocalJob, readLogs: ReadLogs) {
    const key = name(job);
    checked.set(key, +now());
    if (!["running", "queued"].includes(job.status))
      checkedTerminal.set(key, {
        at: +now(),
        stamp: `${job.status}:${job.finishedAt ?? ""}`,
      });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const pending = Promise.resolve().then(() => readLogs(job.id));
      pendingReads.set(key, pending);
      void pending.then(
        () => {
          if (pendingReads.get(key) === pending) pendingReads.delete(key);
        },
        () => {
          if (pendingReads.get(key) === pending) pendingReads.delete(key);
        },
      );
      // Keep the concurrency slot until the actual read settles. The shared
      // response budget below returns cached progress while slow reads continue.
      timer = setTimeout(() => stale.add(key), READ_TIMEOUT_MS);
      const logs = await pending;
      capture(job, logs);
      if (!["running", "queued"].includes(job.status))
        completedReads.set(key, `${job.status}:${job.finishedAt ?? ""}`);
    } catch {
      stale.add(key);
    } finally {
      clearTimeout(timer);
    }
  }
  async function enrich<T extends LocalJob>(
    jobs: T[],
    readLogs: ReadLogs,
  ): Promise<EnrichedJob<T>[]> {
    if (!batch) {
      const order = (a: LocalJob, b: LocalJob) =>
        (b.finishedAt ?? b.createdAt).localeCompare(
          a.finishedAt ?? a.createdAt,
        );
      const active = jobs
          .filter((job) => job.status === "running")
          .sort(order)
          .slice(0, 16),
        recent = jobs
          .filter((job) => !["running", "queued"].includes(job.status))
          .sort(order)
          .slice(0, 16);
      const selected = [...active, ...recent].filter((job) => {
        try {
          const terminal = !["running", "queued"].includes(job.status);
          const terminalCheck = checkedTerminal.get(name(job));
          const lastChecked = terminal
            ? terminalCheck?.stamp === `${job.status}:${job.finishedAt ?? ""}`
              ? terminalCheck.at
              : -Infinity
            : (checked.get(name(job)) ?? -Infinity);
          return (
            !!savedAuthorization(job) &&
            (!terminal ||
              completedReads.get(name(job)) !==
                `${job.status}:${job.finishedAt ?? ""}`) &&
            !pendingReads.has(name(job)) &&
            +now() - lastChecked >= (terminal ? TERMINAL_RETRY_MS : CACHE_MS)
          );
        } catch {
          return false;
        }
      });
      if (selected.length) {
        let cursor = 0;
        batch = Promise.all(
          Array.from({ length: Math.min(4, selected.length) }, async () => {
            while (cursor < selected.length)
              await refresh(selected[cursor++]!, readLogs);
          }),
        )
          .then(() => undefined)
          .finally(() => {
            batch = undefined;
          });
      }
    }
    if (batch) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        batch,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, RESPONSE_BUDGET_MS);
        }),
      ]);
      clearTimeout(timer);
    }
    // Historic metadata and worker/model output cannot claim trusted provenance.
    return jobs.map((job) => {
      const {
        flow: _flow,
        ai: _ai,
        ...publicJob
      } = job as T & { flow?: unknown; ai?: unknown };
      return { ...publicJob, ...detail(job) } as EnrichedJob<T>;
    });
  }
  function secretValues(): string[] {
    // Keys survive controller restarts; only protected controller files are read.
    try {
      const path = join(directory, "authorizations");
      safeOAuthPath(path);
      if (existsSync(path)) {
        const stat = statSync(path),
          stamp = `${stat.mtimeMs}:${stat.ctimeMs}`;
        if (stamp === secretsStamp) return [...secrets];
        for (const file of readdirSync(path)
          .filter((file) => /^[a-f0-9]{64}\.json$/.test(file))
          .slice(0, 4096)) {
          try {
            const value = readPrivate(join(path, file));
            if (object(value) && validRunFlowAuthorization(value.authorization))
              secrets.add(value.authorization.key);
          } catch {
            /* Unreadable files never become log content. */
          }
        }
        secretsStamp = stamp;
      }
    } catch {
      /* No untrusted filesystem diagnostic is exposed. */
    }
    return [...secrets];
  }
  return { authorization, capture, enrich, flow, secretValues };
}
