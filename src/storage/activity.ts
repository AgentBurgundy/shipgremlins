import type { Pool, PoolClient, PoolConfig } from "pg";
import { stripVTControlCharacters } from "node:util";
import { createHash } from "node:crypto";
import {
  createPostgres,
  type StorageDocker,
  type StorageStatus,
} from "./postgres.ts";
import { readConnections } from "../setup/connections.ts";
import type { LocalJob } from "../localRunners/types.ts";
import type { DockerRunners } from "../localRunners/docker.ts";

export interface ActivityEvent {
  id: string;
  type: "tool" | "progress" | "summary" | "check" | "result";
  timestamp: string;
  title: string;
  detail?: string;
  status?: "running" | "succeeded" | "failed";
}
export interface StoredArtifact {
  name: string;
  size: number;
  sha256?: string;
  png?: boolean;
  bytes?: Buffer;
}
export interface RunActivity {
  events: ActivityEvent[];
  summary?: string;
  checks: Array<{
    name: string;
    status: "running" | "succeeded" | "failed";
    detail?: string;
  }>;
}
export interface ActivityStore {
  ensure(): Promise<void>;
  status(): Promise<StorageStatus>;
  recordRun(job: LocalJob): Promise<void>;
  appendEvents(id: string, events: ActivityEvent[]): Promise<void>;
  saveLogs(id: string, logs: string[]): Promise<void>;
  saveArtifacts(id: string, files: StoredArtifact[]): Promise<void>;
  listRuns(options?: {
    limit?: number;
    beforeRunId?: number;
  }): Promise<LocalJob[]>;
  getRun(id: string | number): Promise<LocalJob | null>;
  events(id: string): Promise<ActivityEvent[]>;
  activity(id: string): Promise<RunActivity>;
  logs(id: string): Promise<string[]>;
  artifacts(id: string): Promise<Omit<StoredArtifact, "bytes">[]>;
  readArtifact(id: string, name: string): Promise<Buffer>;
  captureRun(job: LocalJob, docker: DockerRunners): Promise<void>;
  close(): Promise<void>;
}
export interface HistoryPool {
  query(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: Record<string, unknown>[] }>;
  connect(): Promise<Pick<PoolClient, "query" | "release">>;
  end(): Promise<void>;
  on?(event: string, handler: () => void): unknown;
}
const PREFIX = "GREMLINS_ACTIVITY ";
const TYPES = new Set(["tool", "progress", "summary", "check", "result"]);
const ID = /^job-[a-z0-9-]{1,100}$/;
const MAX_LOG = 512 * 1024,
  MAX_ARTIFACT = 10 * 1024 * 1024,
  MAX_RUN_ARTIFACTS = 40 * 1024 * 1024;
const pngMagic = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const artifactName = (name: string) =>
  name.length <= 240 &&
  /^[A-Za-z0-9_./ -]+$/.test(name) &&
  !name.split("/").some((part) => !part || part === "." || part === "..");

function event(value: unknown): ActivityEvent | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (
    typeof v.id !== "string" ||
    !/^[A-Za-z0-9:._/-]{1,160}$/.test(v.id) ||
    !TYPES.has(String(v.type)) ||
    typeof v.timestamp !== "string" ||
    v.timestamp.length > 40 ||
    Number.isNaN(Date.parse(v.timestamp)) ||
    typeof v.title !== "string" ||
    !v.title.trim()
  )
    return null;
  return {
    id: v.id,
    type: v.type as ActivityEvent["type"],
    timestamp: new Date(v.timestamp).toISOString(),
    title: v.title.slice(0, 200),
    ...(typeof v.detail === "string"
      ? { detail: v.detail.slice(0, 4000) }
      : {}),
    ...(["running", "succeeded", "failed"].includes(String(v.status))
      ? { status: v.status as ActivityEvent["status"] }
      : {}),
  };
}

/** Only explicit public activity records, never raw model thinking, become history. */
export function parseActivityLogs(logs: string | string[]): ActivityEvent[] {
  const lines = typeof logs === "string" ? logs.split(/\r?\n/) : logs;
  const found = new Map<string, ActivityEvent>();
  for (const line of lines.slice(-10000)) {
    if (!line.startsWith(PREFIX) || line.length > 20000) continue;
    try {
      const parsed = event(JSON.parse(line.slice(PREFIX.length)));
      if (parsed) found.set(parsed.id, parsed);
    } catch {
      /* Ignore incomplete or malformed public activity lines. */
    }
  }
  return [...found.values()].slice(-2000);
}

function safeLog(line: string): string | null {
  if (
    /"(?:thinking|redacted_thinking|signature|reasoning_content)"\s*:|"type"\s*:\s*"(?:thinking|redacted_thinking)"/.test(
      line,
    )
  )
    return null;
  // Old workers emitted entire streaming JSON envelopes; keep only explicit public events.
  if (!line.startsWith(PREFIX))
    try {
      const value = JSON.parse(line);
      if (
        value &&
        typeof value === "object" &&
        ["assistant", "user", "system", "stream_event"].includes(value.type)
      )
        return null;
    } catch {
      /* Plain text command output is allowed. */
    }
  return line;
}

/** The live endpoint uses the same privacy boundary as persisted history. */
export function publicActivityLogs(
  logs: string | string[],
  secrets: string[] = [],
): string[] {
  const lines = (typeof logs === "string" ? logs.split(/\r?\n/) : logs)
    .slice(-10000)
    .map(stripVTControlCharacters)
    .map(safeLog)
    .filter((line): line is string => line !== null)
    .map((line) => redactHistory(line, secrets).slice(0, 16000));
  let length = 0;
  const limited: string[] = [];
  for (const line of lines.reverse()) {
    length += Buffer.byteLength(line) + 1;
    if (length > MAX_LOG) break;
    limited.unshift(line);
  }
  return limited;
}

/** Summaries and checks must reflect live events as well as saved ones. */
export function summarizeActivity(events: ActivityEvent[]): RunActivity {
  const summary = events
    .filter((item) => item.type === "summary")
    .at(-1)?.detail;
  const checks = new Map<string, RunActivity["checks"][number]>();
  for (const item of events)
    if (item.type === "check")
      checks.set(item.title, {
        name: item.title,
        status: item.status ?? "running",
        ...(item.detail ? { detail: item.detail } : {}),
      });
  return {
    events,
    ...(summary ? { summary } : {}),
    checks: [...checks.values()],
  };
}

export function redactHistory(value: string, secrets: string[] = []): string {
  let text = stripVTControlCharacters(value);
  for (const secret of secrets
    .filter(Boolean)
    .sort((a, b) => b.length - a.length))
    for (const encoded of new Set([
      secret,
      JSON.stringify(secret).slice(1, -1),
      encodeURIComponent(secret),
    ]))
      text = text.split(encoded).join("[REDACTED]");
  return text
    .replace(
      /(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|glpat-[A-Za-z0-9_-]+|sk-ant-[A-Za-z0-9_-]+)/g,
      "[REDACTED]",
    )
    .replace(/https:\/\/hooks\.slack\.com\/services\/[^\s"'<>]+/g, "[REDACTED]")
    .replace(
      /((?:postgres(?:ql)?|https?):\/\/)[^\s/@:]+:[^\s/@]+@/g,
      "$1[REDACTED]@",
    );
}

export async function migrateHistory(pool: HistoryPool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(737104629)");
    await client.query(
      "CREATE TABLE IF NOT EXISTS gremlins_schema (version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
    );
    const version = await client.query<{ version: number }>(
      "SELECT version FROM gremlins_schema ORDER BY version DESC LIMIT 1",
    );
    if (Number(version.rows[0]?.version ?? 0) > 1)
      throw new Error(
        "Run history uses a newer schema. Update ShipGremlins before opening it.",
      );
    await client.query(
      "CREATE TABLE IF NOT EXISTS gremlins_runs (id text PRIMARY KEY, run_id bigint NOT NULL, metadata jsonb NOT NULL, logs jsonb NOT NULL DEFAULT '[]'::jsonb, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now())",
    );
    await client.query(
      "CREATE INDEX IF NOT EXISTS gremlins_runs_order ON gremlins_runs (run_id DESC,created_at DESC)",
    );
    await client.query(
      "CREATE TABLE IF NOT EXISTS gremlins_events (run_id text NOT NULL REFERENCES gremlins_runs(id) ON DELETE CASCADE, id text NOT NULL, at timestamptz NOT NULL, event jsonb NOT NULL, PRIMARY KEY(run_id,id))",
    );
    await client.query(
      "CREATE TABLE IF NOT EXISTS gremlins_artifacts (run_id text NOT NULL REFERENCES gremlins_runs(id) ON DELETE CASCADE, name text NOT NULL, metadata jsonb NOT NULL, payload bytea, PRIMARY KEY(run_id,name))",
    );
    await client.query(
      "INSERT INTO gremlins_schema(version) VALUES (1) ON CONFLICT DO NOTHING",
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export function createActivityStore(options: {
  root: string;
  externalDatabaseUrl?: string;
  run?: StorageDocker;
  poolFactory?: (config: PoolConfig) => Promise<HistoryPool> | HistoryPool;
  secrets?: () => string[];
}): ActivityStore {
  const database = createPostgres(options);
  let pool: HistoryPool | undefined,
    connecting: Promise<HistoryPool> | undefined;
  const captured = new Set<string>();
  const knownSecrets = () => {
    if (options.secrets) return options.secrets();
    try {
      return Object.values(readConnections(options.root));
    } catch {
      return [];
    }
  };
  const clean = (text: string) => redactHistory(text, knownSecrets());
  const checkId = (id: string) => {
    if (!ID.test(id)) throw new Error("Invalid run identifier.");
  };
  async function invalidate(current: HistoryPool): Promise<void> {
    if (pool === current) {
      pool = undefined;
      database.markReady(false);
    }
    await current.end().catch(() => {});
  }
  async function connection(provision = false): Promise<HistoryPool | null> {
    if (!provision && !database.configured()) return null;
    if (pool) return pool;
    if (!connecting)
      connecting = (async () => {
        try {
          const config = await database.ensure();
          const boundedConfig = {
            ...config,
            idleTimeoutMillis: 10000,
            allowExitOnIdle: true,
            query_timeout: 5000,
            statement_timeout: 5000,
          };
          const next = options.poolFactory
            ? await options.poolFactory(boundedConfig)
            : (new (await import("pg")).Pool(boundedConfig) as Pool);
          next.on?.("error", () => {
            if (pool === next) void invalidate(next);
            else database.markReady(false);
          });
          try {
            await next.query("SELECT 1");
            await migrateHistory(next);
          } catch (error) {
            await next.end().catch(() => {});
            throw error;
          }
          pool = next;
          database.markReady(true);
          return next;
        } catch {
          database.markReady(false);
          throw new Error(
            "Run history is unavailable. Check PostgreSQL or Docker and retry; existing history was preserved.",
          );
        } finally {
          connecting = undefined;
        }
      })();
    return connecting;
  }
  async function query(text: string, values: unknown[] = []) {
    const current = await connection();
    if (!current) return { rows: [] };
    try {
      return await current.query(text, values);
    } catch {
      await invalidate(current);
      throw new Error(
        "Run history could not be read or saved. Check PostgreSQL and retry.",
      );
    }
  }
  const api: ActivityStore = {
    async ensure() {
      if (pool) {
        const current = pool;
        try {
          await current.query("SELECT 1");
          database.markReady(true);
          return;
        } catch {
          await invalidate(current);
        }
      }
      await connection(true);
    },
    async status() {
      // Dashboard status must not pull images, acquire setup locks, or wait on a DB.
      return database.status();
    },
    async recordRun(job) {
      checkId(job.id);
      const selected = Object.fromEntries(
        [
          "id",
          "runId",
          "type",
          "project",
          "area",
          "ticket",
          "workerId",
          "status",
          "createdAt",
          "startedAt",
          "finishedAt",
          "message",
          "retries",
          "exitCode",
          "developerKind",
          "branch",
          "pr",
        ]
          .filter(
            (key) =>
              (job as unknown as Record<string, unknown>)[key] !== undefined,
          )
          .map((key) => [
            key,
            (job as unknown as Record<string, unknown>)[key],
          ]),
      );
      const safe = JSON.parse(clean(JSON.stringify(selected))) as LocalJob;
      await query(
        "INSERT INTO gremlins_runs(id,run_id,metadata) VALUES ($1,$2,$3::jsonb) ON CONFLICT(id) DO UPDATE SET metadata=EXCLUDED.metadata,updated_at=now()",
        [job.id, job.runId, JSON.stringify(safe)],
      );
    },
    async appendEvents(id, events) {
      checkId(id);
      const secrets = knownSecrets();
      const unique = new Map<string, ActivityEvent>();
      for (const value of events.slice(-2000)) {
        const parsed = event(value);
        if (!parsed) continue;
        const safe = event(
          JSON.parse(redactHistory(JSON.stringify(parsed), secrets)),
        );
        if (safe) unique.set(safe.id, safe);
      }
      if (unique.size)
        await query(
          "INSERT INTO gremlins_events(run_id,id,at,event) SELECT $1,item->>'id',(item->>'timestamp')::timestamptz,item FROM jsonb_array_elements($2::jsonb) AS item WHERE EXISTS(SELECT 1 FROM gremlins_runs WHERE id=$1) ON CONFLICT(run_id,id) DO UPDATE SET event=EXCLUDED.event",
          [id, JSON.stringify([...unique.values()])],
        );
    },
    async saveLogs(id, logs) {
      checkId(id);
      const limited = publicActivityLogs(logs, knownSecrets());
      await query(
        "UPDATE gremlins_runs SET logs=$2::jsonb,updated_at=now() WHERE id=$1",
        [id, JSON.stringify(limited)],
      );
    },
    async saveArtifacts(id, files) {
      checkId(id);
      const secrets = knownSecrets();
      let total = 0;
      for (const file of files.slice(0, 100)) {
        if (
          !artifactName(file.name) ||
          !Number.isSafeInteger(file.size) ||
          file.size < 0 ||
          file.size > MAX_ARTIFACT
        )
          continue;
        let bytes = file.bytes;
        if (bytes) {
          if (
            bytes.length > MAX_ARTIFACT ||
            total + bytes.length > MAX_RUN_ARTIFACTS
          )
            continue;
          total += bytes.length;
          if (/\.(json|jsonl|md|txt|log|csv|html|ya?ml)$/i.test(file.name)) {
            const safe = bytes
              .toString("utf8")
              .split(/\r?\n/)
              .map(safeLog)
              .filter((line): line is string => line !== null)
              .map((line) => redactHistory(line, secrets))
              .join("\n");
            bytes = Buffer.from(safe);
          } else if (!file.name.endsWith(".png")) continue;
          if (
            file.name.endsWith(".png") &&
            !bytes.subarray(0, 8).equals(pngMagic)
          )
            continue;
        }
        const metadata = {
          name: file.name,
          size: bytes?.length ?? file.size,
          ...(bytes
            ? { sha256: createHash("sha256").update(bytes).digest("hex") }
            : file.sha256
              ? { sha256: file.sha256 }
              : {}),
          ...(file.name.endsWith(".png")
            ? { png: Boolean(bytes?.subarray(0, 8).equals(pngMagic)) }
            : {}),
        };
        await query(
          "INSERT INTO gremlins_artifacts(run_id,name,metadata,payload) SELECT $1,$2,$3::jsonb,$4 WHERE EXISTS(SELECT 1 FROM gremlins_runs WHERE id=$1) ON CONFLICT(run_id,name) DO UPDATE SET metadata=EXCLUDED.metadata,payload=COALESCE(EXCLUDED.payload,gremlins_artifacts.payload)",
          [id, file.name, JSON.stringify(metadata), bytes ?? null],
        );
      }
    },
    async listRuns(input = {}) {
      const limit = Math.max(
        1,
        Math.min(200, Number.isSafeInteger(input.limit) ? input.limit! : 100),
      );
      const before = Number.isSafeInteger(input.beforeRunId)
        ? input.beforeRunId
        : null;
      const result = await query(
        "SELECT metadata FROM gremlins_runs WHERE ($1::bigint IS NULL OR run_id<$1) ORDER BY run_id DESC,created_at DESC LIMIT $2",
        [before, limit],
      );
      return result.rows.map((row) => row.metadata as LocalJob);
    },
    async getRun(id) {
      const result =
        typeof id === "number"
          ? await query(
              "SELECT metadata FROM gremlins_runs WHERE run_id=$1 ORDER BY created_at DESC LIMIT 1",
              [id],
            )
          : (checkId(id),
            await query("SELECT metadata FROM gremlins_runs WHERE id=$1", [
              id,
            ]));
      return (result.rows[0]?.metadata as LocalJob) ?? null;
    },
    async events(id) {
      checkId(id);
      const result = await query(
        "SELECT event FROM (SELECT event,at,id FROM gremlins_events WHERE run_id=$1 ORDER BY at DESC,id DESC LIMIT 2000) recent ORDER BY at,id",
        [id],
      );
      return result.rows.map((row) => row.event as ActivityEvent);
    },
    async activity(id) {
      return summarizeActivity(await api.events(id));
    },
    async logs(id) {
      checkId(id);
      const result = await query("SELECT logs FROM gremlins_runs WHERE id=$1", [
        id,
      ]);
      return (result.rows[0]?.logs as string[]) ?? [];
    },
    async artifacts(id) {
      checkId(id);
      const result = await query(
        "SELECT metadata FROM gremlins_artifacts WHERE run_id=$1 ORDER BY name",
        [id],
      );
      return result.rows.map((row) => row.metadata as StoredArtifact);
    },
    async readArtifact(id, name) {
      checkId(id);
      if (!artifactName(name)) throw new Error("Invalid artifact name.");
      const result = await query(
        "SELECT payload FROM gremlins_artifacts WHERE run_id=$1 AND name=$2",
        [id, name],
      );
      const bytes = result.rows[0]?.payload;
      if (!Buffer.isBuffer(bytes))
        throw new Error("This artifact is unavailable in saved history.");
      return bytes;
    },
    async captureRun(job, docker) {
      if (!database.configured()) return;
      const key = `${job.id}:${job.status}`;
      if (captured.has(key)) return;
      await api.recordRun(job);
      if (!(await docker.inspectJob(job.id)).exists) return;
      const logs = (await docker.logs(job.id)).split(/\r?\n/);
      await api.saveLogs(job.id, logs);
      await api.appendEvents(job.id, parseActivityLogs(logs));
      await api.appendEvents(job.id, [
        {
          id: `lifecycle:${job.status}`,
          type:
            job.status === "succeeded" || job.status === "failed"
              ? "result"
              : "progress",
          timestamp: job.finishedAt ?? job.startedAt ?? job.createdAt,
          title: `Run ${job.status}`,
          detail: job.message,
          status:
            job.status === "failed"
              ? "failed"
              : job.status === "succeeded"
                ? "succeeded"
                : "running",
        },
      ]);
      if (["succeeded", "failed", "canceled"].includes(job.status)) {
        const artifacts = await docker.artifacts(job.id);
        const files: StoredArtifact[] = [];
        let bytes = 0;
        for (const file of artifacts.files) {
          if (
            file.size > MAX_ARTIFACT ||
            bytes + file.size > MAX_RUN_ARTIFACTS ||
            file.name.startsWith(".")
          )
            continue;
          const data = await docker.readArtifact(job.id, file.name);
          bytes += data.length;
          if (file.name === "activity.jsonl")
            await api.appendEvents(
              job.id,
              parseActivityLogs(
                data
                  .toString("utf8")
                  .split(/\r?\n/)
                  .map((line) => PREFIX + line),
              ),
            );
          files.push({ ...file, bytes: data });
        }
        await api.saveArtifacts(job.id, files);
        captured.add(key);
      }
    },
    async close() {
      const current = pool;
      pool = undefined;
      connecting = undefined;
      database.markReady(false);
      if (current) await current.end();
    },
  };
  return api;
}
