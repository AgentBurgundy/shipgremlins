import { realpathSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import {
  createActivityStore,
  migrateHistory,
  parseActivityLogs,
  redactHistory,
  type HistoryPool,
} from "./activity.ts";
import { createActivityWriter } from "../../runner-local/activity.mjs";
import type { LocalJob } from "../localRunners/types.ts";
import type { DockerRunners } from "../localRunners/docker.ts";

const roots: string[] = [];
const root = () => {
  const value = mkdtempSync(
    join(realpathSync(tmpdir()), "gremlins-history-test-"),
  );
  roots.push(value);
  return value;
};
afterEach(() => {
  for (const value of roots.splice(0))
    rmSync(value, { recursive: true, force: true });
});
const job: LocalJob = {
  id: "job-history-proof",
  runId: 1,
  type: "pm",
  project: "example",
  area: "security",
  status: "succeeded",
  createdAt: "2026-10-04T12:00:00Z",
};
function memoryPool() {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  const runs = new Map<string, { metadata: unknown; logs: unknown }>(),
    events = new Map<string, unknown>(),
    artifacts = new Map<string, { metadata: unknown; payload: unknown }>();
  let failure = "",
    released = false;
  const query = async (text: string, values: unknown[] = []) => {
    calls.push({ text, values });
    if (failure && text.includes(failure))
      throw new Error("database failed secret-value");
    const id = String(values[0]);
    if (text.startsWith("INSERT INTO gremlins_runs")) {
      runs.set(id, {
        metadata: JSON.parse(String(values[2])),
        logs: runs.get(id)?.logs ?? [],
      });
    }
    if (text.startsWith("INSERT INTO gremlins_events"))
      events.set(id + ":" + values[1], JSON.parse(String(values[3])));
    if (text.startsWith("UPDATE gremlins_runs")) {
      const run = runs.get(id);
      if (run) run.logs = JSON.parse(String(values[1]));
    }
    if (text.startsWith("INSERT INTO gremlins_artifacts"))
      artifacts.set(id + ":" + values[1], {
        metadata: JSON.parse(String(values[2])),
        payload: values[3],
      });
    if (text.startsWith("SELECT metadata FROM gremlins_runs"))
      return {
        rows: text.includes("WHERE id=")
          ? ([runs.get(id)].filter(Boolean) as Record<string, unknown>[])
          : [...runs.values()],
      };
    if (text.startsWith("SELECT logs"))
      return { rows: runs.has(id) ? [{ logs: runs.get(id)!.logs }] : [] };
    if (text.startsWith("SELECT event"))
      return {
        rows: [...events.entries()]
          .filter(([key]) => key.startsWith(id + ":"))
          .map(([, event]) => ({ event })),
      };
    if (text.startsWith("SELECT metadata FROM gremlins_artifacts"))
      return {
        rows: [...artifacts.entries()]
          .filter(([key]) => key.startsWith(id + ":"))
          .map(([, value]) => ({ metadata: value.metadata })),
      };
    if (text.startsWith("SELECT payload")) {
      const value = artifacts.get(id + ":" + values[1]);
      return { rows: value ? [{ payload: value.payload }] : [] };
    }
    return { rows: [] };
  };
  const pool: HistoryPool = {
    query,
    connect: async () => ({
      query: query as PoolClient["query"],
      release: () => {
        released = true;
      },
    }),
    end: async () => {},
  };
  return {
    pool,
    calls,
    events,
    artifacts,
    fail: (text: string) => {
      failure = text;
    },
    released: () => released,
  };
}
function setup() {
  const fake = memoryPool();
  const store = createActivityStore({
    root: root(),
    externalDatabaseUrl: "postgresql://gremlins:fake@127.0.0.1/history",
    poolFactory: () => fake.pool,
    secrets: () => ["private-value"],
  });
  return { fake, store };
}

describe("durable safe run activity", () => {
  it("invalidates stale pools, rediscovers a changed managed port, and keeps status nonblocking", async () => {
    const directory = root();
    const id = createHash("sha256")
      .update(
        process.platform === "win32" ? directory.toLowerCase() : directory,
      )
      .digest("hex")
      .slice(0, 16);
    let port = 54001,
      closed = 0,
      dockerCalls = 0;
    const pools: ReturnType<typeof memoryPool>[] = [];
    const ports: number[] = [];
    const store = createActivityStore({
      root: directory,
      run: async (args) => {
        dockerCalls++;
        if (args[0] === "inspect")
          return {
            code: 0,
            stderr: "",
            stdout: JSON.stringify({
              Name: `/gremlins-postgres-${id}`,
              Config: {
                Labels: {
                  "io.shipgremlins.storage": id,
                  "io.shipgremlins.managed": "true",
                },
              },
              HostConfig: {
                PortBindings: { "5432/tcp": [{ HostIp: "127.0.0.1" }] },
              },
              State: { Running: true },
              NetworkSettings: {
                Ports: {
                  "5432/tcp": [{ HostIp: "127.0.0.1", HostPort: String(port) }],
                },
              },
            }),
          };
        return { code: 0, stderr: "", stdout: "" };
      },
      poolFactory: (config) => {
        ports.push(config.port!);
        const fake = memoryPool();
        fake.pool.end = async () => {
          closed++;
        };
        pools.push(fake);
        return fake.pool;
      },
    });
    expect(await store.status()).toMatchObject({ configured: false });
    expect(dockerCalls).toBe(0);
    await store.ensure();
    expect(ports).toEqual([54001]);
    const calls = dockerCalls;
    await store.status();
    expect(dockerCalls).toBe(calls);
    pools[0]!.fail("SELECT");
    port = 54002;
    await store.ensure();
    expect(closed).toBe(1);
    expect(ports).toEqual([54001, 54002]);
    pools[1]!.fail("SELECT metadata");
    await expect(store.listRuns()).rejects.toThrow("Check PostgreSQL");
    expect(closed).toBe(2);
    expect(await store.status()).toMatchObject({ ready: false });
    port = 54003;
    await store.ensure();
    expect(ports).toEqual([54001, 54002, 54003]);
    await store.close();
  });
  it("does not provision a database for legacy or fresh workspace reads", async () => {
    let called = false;
    const store = createActivityStore({
      root: root(),
      poolFactory: () => {
        called = true;
        throw new Error();
      },
    });
    expect(await store.listRuns()).toEqual([]);
    expect(await store.status()).toMatchObject({ configured: false });
    await store.recordRun(job);
    expect(called).toBe(false);
  });

  it("migrates transactionally with an advisory lock and rolls back failures", async () => {
    const fake = memoryPool();
    fake.fail("CREATE TABLE IF NOT EXISTS gremlins_events");
    await expect(migrateHistory(fake.pool)).rejects.toThrow();
    expect(fake.calls[0]?.text).toBe("BEGIN");
    expect(fake.calls[1]?.text).toContain("pg_advisory_xact_lock");
    expect(fake.calls.at(-1)?.text).toBe("ROLLBACK");
    expect(fake.released()).toBe(true);
  });

  it("keeps run data parameterized and events idempotent", async () => {
    const { store, fake } = setup();
    await store.ensure();
    await store.recordRun({
      ...job,
      message: "private-value should be redacted; ' SELECT 1",
    });
    const event = {
      id: "tool:1",
      type: "tool" as const,
      timestamp: job.createdAt,
      title: "Browser",
      detail: "private-value",
      status: "running" as const,
    };
    await store.appendEvents(job.id, [event, event]);
    expect(fake.events.size).toBe(1);
    expect(JSON.stringify(await store.getRun(job.id))).not.toContain(
      "private-value",
    );
    expect((await store.events(job.id))[0]?.detail).toBe("[REDACTED]");
    expect(fake.calls.map((call) => call.text).join("\n")).not.toContain(
      "private-value",
    );
    expect(
      fake.calls.find((call) =>
        call.text.startsWith("INSERT INTO gremlins_runs"),
      )?.values[2],
    ).toContain("[REDACTED]");
    await store.close();
  });

  it("retains logs and artifact bytes after container deletion", async () => {
    const { store } = setup();
    await store.ensure();
    let exists = true;
    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
    const docker = {
      inspectJob: async () => ({ exists }),
      logs: async () => "private-value safe output",
      artifacts: async () => ({
        result: { ok: true },
        files: [{ name: "screen.png", size: png.length, png: true }],
      }),
      readArtifact: async () => png,
    } as unknown as DockerRunners;
    await store.captureRun(job, docker);
    exists = false;
    await store.captureRun(job, docker);
    expect(await store.logs(job.id)).toEqual(["[REDACTED] safe output"]);
    expect(await store.readArtifact(job.id, "screen.png")).toEqual(png);
    expect(await store.artifacts(job.id)).toMatchObject([
      { name: "screen.png", png: true },
    ]);
    await store.close();
  });

  it("bounds logs and refuses traversal or unexpected binary artifacts", async () => {
    const { store, fake } = setup();
    await store.ensure();
    await store.recordRun(job);
    await store.saveLogs(job.id, [
      JSON.stringify({
        type: "assistant",
        message: {
          content: [{ type: "thinking", thinking: "private reasoning" }],
        },
      }),
      "private-value",
      ...Array(1000).fill("x".repeat(2000)),
    ]);
    const logs = await store.logs(job.id);
    expect(Buffer.byteLength(logs.join("\n"))).toBeLessThanOrEqual(512 * 1024);
    expect(logs.join("\n")).not.toContain("private reasoning");
    await store.saveArtifacts(job.id, [
      { name: "../private", size: 1, bytes: Buffer.from("x") },
      { name: "binary.exe", size: 1, bytes: Buffer.from("x") },
      {
        name: "result.json",
        size: 28,
        bytes: Buffer.from('{"summary":"private-value"}'),
      },
    ]);
    expect(fake.artifacts.size).toBe(1);
    expect(
      (await store.readArtifact(job.id, "result.json")).toString(),
    ).toContain("[REDACTED]");
    await expect(store.readArtifact(job.id, "../private")).rejects.toThrow(
      "Invalid artifact",
    );
    await store.close();
  });

  it("shows public tool calls, progress, summaries, and checks while dropping thinking", () => {
    const lines: string[] = [];
    const writer = createActivityWriter({
      write: (line) => lines.push(line),
      redact: (value) => redactHistory(value, ["private-value"]),
      now: () => new Date(job.createdAt),
    });
    writer.modelRecord({
      type: "assistant",
      message: {
        content: [
          { type: "thinking", thinking: "hidden reasoning" },
          { type: "text", text: "Checking the login flow" },
          {
            type: "tool_use",
            name: "browser_navigate",
            input: {
              url: "https://example.test",
              authorization: "private-value",
              nested: { thinking: "hidden" },
            },
          },
        ],
      },
    });
    writer.modelRecord({
      type: "result",
      result: "Found a login bug. private-value",
      is_error: false,
    });
    writer.emit("check", "test", undefined, "succeeded");
    const events = parseActivityLogs(lines);
    expect(events.map((event) => event.type)).toEqual([
      "progress",
      "tool",
      "summary",
      "check",
    ]);
    expect(JSON.stringify(events)).not.toMatch(
      /hidden reasoning|private-value|authorization/,
    );
    expect(writer.summary()).toContain("[REDACTED]");
    expect(
      parseActivityLogs(["GREMLINS_ACTIVITY {bad", '{"thinking":"secret"}']),
    ).toEqual([]);
  });
});
