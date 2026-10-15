import { createHmac } from "node:crypto";
import {
  existsSync,
  linkSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createRunFlowWriter,
  parseRunFlowLine,
  RUN_FLOW_PREFIX,
  type RunFlowAuthorization,
  type RunFlowSnapshot,
} from "../../runner-local/run-flow.mjs";
import type { LocalJob } from "../localRunners/types.ts";
import { createRunFlows } from "./index.ts";

const roots: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
const instant = "2026-10-14T12:00:00.000Z";
function job(id = "job-1", extra: Partial<LocalJob> = {}): LocalJob {
  return {
    id,
    runId: Number(id.match(/\d+$/)?.[0] ?? 1),
    type: "developer",
    project: "app",
    projectInstanceId: "11111111-2222-3333-4444-555555555555",
    status: "running",
    createdAt: instant,
    ...extra,
  };
}
function world() {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "gremlins-run-flow-"));
  roots.push(root);
  let time = Date.parse(instant);
  const now = () => new Date(time),
    store = createRunFlows({ root, now });
  return {
    root,
    now,
    store,
    advance: (milliseconds: number) => {
      time += milliseconds;
    },
  };
}
function runtime(authorization: RunFlowAuthorization, input = job()) {
  const lines: string[] = [],
    writer = createRunFlowWriter({
      authorization,
      jobId: input.id,
      kind: input.type,
      write: (line) => lines.push(line),
      now: () => new Date(instant),
    });
  return { writer, lines };
}
function recordPath(root: string, kind: "authorizations" | "snapshots") {
  const directory = join(root, ".run/run-flows", kind);
  return join(directory, readdirSync(directory)[0]!);
}
describe("trusted run flow protocol", () => {
  const authorization: RunFlowAuthorization = {
    version: 1,
    key: "a".repeat(64),
    maxRepairs: 2,
  };
  it("signs bounded typed phases and checkpoints without returning the key or reasoning", () => {
    const r = runtime(authorization);
    expect(r.writer.snapshot()).toBeUndefined();
    r.writer.checkpoint({ strategy: "regression", repairUsed: 0 });
    expect(r.writer.snapshot()).toBeUndefined();
    r.writer.phase("understand", "running");
    r.writer.phase("understand", "passed", "checks-passed");
    r.writer.checkpoint({ repairUsed: 1 });
    expect(r.lines.every((line) => line.endsWith("\n"))).toBe(true);
    expect(
      r.lines.map(
        (line) => JSON.parse(line.slice(RUN_FLOW_PREFIX.length)).sequence,
      ),
    ).toEqual([1, 2, 3, 4]);
    expect(r.writer.snapshot()).toMatchObject({
      kind: "developer",
      strategy: "regression",
      repairUsed: 1,
      repairLimit: 2,
      status: "running",
      phases: expect.arrayContaining([
        expect.objectContaining({
          id: "understand",
          status: "passed",
          summary: "Checks passed.",
        }),
      ]),
    });
    expect(JSON.stringify(r.writer.snapshot())).not.toMatch(
      /mac|key|reasoning|signature/,
    );
    expect(r.lines.join("")).not.toContain(authorization.key);
    const copy = r.writer.snapshot()!;
    copy.phases[0]!.label = "forged";
    expect(r.writer.snapshot()!.phases[0]!.label).toBe("Understand the task");
  });
  it("rejects forged signatures, wrong jobs/kinds, unsupported fields and private summaries", () => {
    const r = runtime(authorization);
    r.writer.phase("build", "running");
    const context = {
      authorization,
      jobId: "job-1",
      kind: "developer" as const,
    };
    const line = r.lines[0]!;
    expect(parseRunFlowLine(line, context)).toBeDefined();
    expect(
      parseRunFlowLine(line, { ...context, jobId: "job-2" }),
    ).toBeUndefined();
    expect(parseRunFlowLine(line, { ...context, kind: "pm" })).toBeUndefined();
    expect(
      parseRunFlowLine(line, {
        ...context,
        authorization: { ...authorization, key: "b".repeat(64) },
      }),
    ).toBeUndefined();
    expect(
      parseRunFlowLine(line.replace('"running"', '"passed"'), context),
    ).toBeUndefined();
    const event = JSON.parse(line.slice(RUN_FLOW_PREFIX.length));
    event.summary = "private credential and model reasoning";
    const { mac: _mac, ...unsigned } = event;
    event.mac = createHmac("sha256", Buffer.from(authorization.key, "hex"))
      .update(JSON.stringify(unsigned))
      .digest("hex");
    expect(
      parseRunFlowLine(RUN_FLOW_PREFIX + JSON.stringify(event), context),
    ).toBeUndefined();
    expect(() => r.writer.phase("build", "running", authorization.key)).toThrow(
      /fixed public tag/,
    );
    expect(() => r.writer.phase("untrusted-phase", "running")).toThrow(
      /Invalid run progress event/,
    );
    expect(() => r.writer.checkpoint({ repairUsed: 3 })).toThrow(
      /Invalid run progress event/,
    );
    r.writer.checkpoint({ repairUsed: 1 });
    expect(() => r.writer.checkpoint({ repairUsed: 0 })).toThrow(/rewind/);
  });
  it.each(["pm", "verify"] as const)("uses the %s phase allowlist", (type) => {
    const r = runtime(authorization, job("job-1", { type }));
    r.writer.phase("prepare", "passed");
    r.writer.phase("complete", "passed", "complete");
    expect(r.writer.snapshot()).toMatchObject({
      kind: type,
      phase: "complete",
      status: "passed",
    });
    expect(() => r.writer.phase("build", "running")).toThrow();
  });
  it("bounds signed events and public history", () => {
    const r = runtime(authorization);
    for (let index = 0; index < 256; index++)
      r.writer.phase("build", index % 2 ? "passed" : "running");
    expect(r.writer.snapshot()!.events).toHaveLength(64);
    expect(() => r.writer.phase("publish", "passed")).toThrow(
      /Invalid run progress event/,
    );
    expect(r.lines).toHaveLength(256);
  });
  it("completes a successful no-change run when publication is deliberately skipped", () => {
    const r = runtime(authorization);
    r.writer.phase("verify", "passed");
    r.writer.phase("publish", "skipped");
    expect(r.writer.snapshot()).toMatchObject({
      phase: "publish",
      status: "passed",
    });
  });
});
describe("controller run flows", () => {
  it("persists authenticated history and exact AI provenance across controller restarts", () => {
    const f = world(),
      j = job(),
      auth = f.store.authorization(j, { provider: "codex", model: "chosen" }),
      r = runtime(auth);
    r.writer.checkpoint({ strategy: "tdd", repairUsed: 0 });
    r.writer.phase("understand", "passed");
    r.writer.phase("build", "running");
    expect(f.store.capture(j, r.lines)).toMatchObject({
      phase: "build",
      strategy: "tdd",
      freshness: "live",
      stale: false,
    });
    const restarted = createRunFlows({ root: f.root, now: f.now });
    expect(restarted.flow(j)).toEqual(f.store.flow(j));
    expect(restarted.secretValues()).toContain(auth.key);
    expect(
      restarted.authorization(j, { provider: "codex", model: "chosen" }),
    ).toEqual(auth);
    expect(readFileSync(recordPath(f.root, "snapshots"), "utf8")).not.toContain(
      auth.key,
    );
    if (process.platform !== "win32")
      expect(statSync(recordPath(f.root, "authorizations")).mode & 0o077).toBe(
        0,
      );
  });
  it("discovers private keys created or rotated by another controller store instance", () => {
    const f = world(),
      reader = createRunFlows({ root: f.root, now: f.now }),
      j = job();
    expect(reader.secretValues()).toEqual([]);
    const first = f.store.authorization(j, { provider: "claude" });
    expect(reader.secretValues()).toContain(first.key);
    const second = f.store.authorization(j, { provider: "codex" });
    expect(reader.secretValues()).toEqual(
      expect.arrayContaining([first.key, second.key]),
    );
  });
  it("never binds another job, run, project incarnation, or kind to retained progress", () => {
    const f = world(),
      j = job(),
      auth = f.store.authorization(j),
      r = runtime(auth);
    r.writer.phase("build", "running");
    f.store.capture(j, r.lines);
    for (const changed of [
      job("job-2"),
      { ...j, runId: 2 },
      { ...j, type: "pm" as const },
      { ...j, project: "replacement" },
      { ...j, projectInstanceId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" },
      { ...j, createdAt: "2026-10-15T12:00:00.000Z" },
    ]) {
      expect(f.store.flow(changed)).toBeUndefined();
      expect(f.store.capture(changed, r.lines)).toBeUndefined();
    }
    expect(() => f.store.authorization({ ...j, runId: 2 })).toThrow(/safely/);
  });
  it("binds independent coder provenance while preserving the exact legacy authorization identity", () => {
    const f = world(),
      legacy = job(),
      previous = f.store.authorization(legacy);
    const saved = JSON.parse(
      readFileSync(recordPath(f.root, "authorizations"), "utf8"),
    );
    expect(JSON.parse(saved.identity)).toEqual([
      legacy.id,
      legacy.runId,
      legacy.type,
      legacy.project,
      legacy.projectInstanceId,
      null,
      null,
      null,
      null,
      null,
      null,
      legacy.createdAt,
      null,
    ]);
    expect(
      createRunFlows({ root: f.root, now: f.now }).authorization(legacy),
    ).toEqual(previous);
    const bound = job("job-2", {
        coderKey: "builder",
        coderInstanceId: "22222222-2222-4222-8222-222222222222",
      }),
      r = runtime(f.store.authorization(bound), bound);
    r.writer.phase("build", "running");
    expect(f.store.capture(bound, r.lines)).toMatchObject({ phase: "build" });
    for (const changed of [
      { ...bound, coderKey: "another" },
      { ...bound, coderInstanceId: "33333333-3333-4333-8333-333333333333" },
      { ...bound, coderKey: undefined, coderInstanceId: undefined },
    ]) {
      expect(f.store.capture(changed, r.lines)).toBeUndefined();
      expect(f.store.flow(changed)).toBeUndefined();
    }
    expect(() =>
      f.store.authorization({ ...bound, coderInstanceId: undefined }),
    ).toThrow("safely");
  });
  it("ignores replays and late ordered events without rewinding phases or repair attempts", () => {
    const f = world(),
      j = job(),
      r = runtime(f.store.authorization(j));
    r.writer.phase("build", "running");
    r.writer.checkpoint({ repairUsed: 1 });
    r.writer.phase("review", "passed");
    f.store.capture(j, [r.lines[0]!, r.lines[2]!]);
    f.store.capture(j, r.lines);
    expect(f.store.flow(j)).toMatchObject({ phase: "review", repairUsed: 1 });
    expect(f.store.flow(j)!.events).toHaveLength(2);
    expect(
      JSON.parse(readFileSync(recordPath(f.root, "snapshots"), "utf8")).lines,
    ).toHaveLength(2);
  });
  it("allows AI changes before any authenticated event and freezes provenance afterward", async () => {
    const f = world(),
      j = job(),
      first = f.store.authorization(j, { provider: "claude" }),
      second = f.store.authorization(j, { provider: "codex" });
    expect(second.key).not.toBe(first.key);
    const old = runtime(first);
    old.writer.phase("build", "running");
    expect(f.store.capture(j, old.lines)).toBeUndefined();
    const r = runtime(second);
    r.writer.phase("understand", "passed");
    f.store.capture(j, r.lines);
    expect(() => f.store.authorization(j, { provider: "claude" })).toThrow(
      /provenance/,
    );
    const [enriched] = await f.store.enrich([j], async () => r.lines);
    expect(enriched!.ai).toEqual({ provider: "codex" });
  });
  it("strips supplied flow and AI claims and keeps queued/legacy runs honestly unknown", async () => {
    const f = world(),
      waiting = job("job-1", { status: "queued" }),
      legacy = job("job-2"),
      read = vi.fn(async () => "forged progress");
    f.store.authorization(waiting, { provider: "codex" });
    const result = await f.store.enrich(
      [
        waiting,
        {
          ...legacy,
          ai: { provider: "codex" },
          flow: { status: "passed" } as unknown as RunFlowSnapshot,
        },
      ],
      read,
    );
    expect(result.every((item) => !("flow" in item) && !("ai" in item))).toBe(
      true,
    );
    expect(read).not.toHaveBeenCalled();
  });
  it("rejects unsafe linked authorization files and tampered retained event summaries", () => {
    const f = world(),
      j = job(),
      auth = f.store.authorization(j),
      file = recordPath(f.root, "authorizations");
    const link = join(f.root, "private-link");
    linkSync(file, link);
    expect(() => f.store.authorization(j)).toThrow(/safely/);
    expect(f.store.flow(j)).toBeUndefined();
    rmSync(link);
    const r = runtime(auth);
    r.writer.phase("build", "running");
    f.store.capture(j, r.lines);
    const snapshotFile = recordPath(f.root, "snapshots"),
      saved = JSON.parse(readFileSync(snapshotFile, "utf8"));
    saved.lines[0] = saved.lines[0].replace('"running"', '"passed"');
    writeFileSync(snapshotFile, JSON.stringify(saved));
    expect(f.store.flow(j)).toBeUndefined();
  });
  it("retains only authenticated bounded protocol lines from noisy private logs", () => {
    const f = world(),
      j = job(),
      r = runtime(f.store.authorization(j));
    r.writer.phase("build", "running");
    f.store.capture(
      j,
      "private credential\n" +
        "x".repeat(1024 * 1024) +
        "\n" +
        r.lines.join(""),
    );
    expect(f.store.flow(j)!.phase).toBe("build");
    expect(readFileSync(recordPath(f.root, "snapshots"), "utf8")).not.toMatch(
      /private credential|xxxxxxxx/,
    );
  });
  it("bounds polling to sixteen active and recent jobs with four concurrent reads and a cache", async () => {
    const f = world(),
      jobs = Array.from({ length: 40 }, (_, index) =>
        job(`job-${index + 1}`, {
          status: index < 20 ? "running" : "succeeded",
        }),
      );
    for (const j of jobs) f.store.authorization(j);
    let active = 0,
      maximum = 0;
    const read = vi.fn(async () => {
      maximum = Math.max(maximum, ++active);
      await Promise.resolve();
      active--;
      return "";
    });
    await f.store.enrich(jobs, read);
    expect(read).toHaveBeenCalledTimes(32);
    expect(maximum).toBeLessThanOrEqual(4);
    await f.store.enrich(jobs, read);
    expect(read).toHaveBeenCalledTimes(32);
    f.advance(2001);
    await f.store.enrich(jobs, read);
    expect(read).toHaveBeenCalledTimes(48);
  });
  it("keeps a missing log stale while independently updating another card within a bounded response", async () => {
    vi.useFakeTimers();
    const f = world(),
      first = job(),
      second = job("job-2"),
      a = runtime(f.store.authorization(first)),
      b = runtime(f.store.authorization(second), second);
    a.writer.phase("build", "running");
    f.store.capture(first, a.lines);
    f.advance(2001);
    b.writer.phase("review", "running");
    const read = vi.fn(async (id: string) =>
      id === first.id ? new Promise<string>(() => {}) : b.lines,
    );
    const pending = f.store.enrich([first, second], read);
    await vi.advanceTimersByTimeAsync(701);
    const result = await pending;
    expect(result[0]!.flow).toMatchObject({
      phase: "build",
      stale: true,
      freshness: "stale",
    });
    expect(result[1]!.flow).toMatchObject({
      phase: "review",
      stale: false,
      freshness: "live",
    });
    expect(existsSync(recordPath(f.root, "snapshots"))).toBe(true);
    f.advance(2001);
    const again = f.store.enrich([first, second], read);
    await vi.advanceTimersByTimeAsync(701);
    await again;
    expect(read.mock.calls.filter(([id]) => id === first.id)).toHaveLength(1);
  });
  it("keeps at most four underlying reads in flight even after presentation timeouts", async () => {
    vi.useFakeTimers();
    const f = world(),
      jobs = Array.from({ length: 32 }, (_, index) => job(`job-${index + 1}`));
    for (const current of jobs) f.store.authorization(current);
    const read = vi.fn(async () => new Promise<string>(() => {}));
    const pending = f.store.enrich(jobs, read);
    await vi.advanceTimersByTimeAsync(701);
    expect((await pending).every((item) => !item.flow)).toBe(true);
    expect(read).toHaveBeenCalledTimes(4);
    f.advance(10_000);
    const next = f.store.enrich(jobs, read);
    await vi.advanceTimersByTimeAsync(10_001);
    await next;
    expect(read).toHaveBeenCalledTimes(4);
  });
  it("captures terminal history once and backs off unavailable final logs", async () => {
    const f = world(),
      current = job("job-1", { status: "failed", finishedAt: instant });
    f.store.authorization(current);
    const read = vi.fn(async (): Promise<string> => {
      throw Error("unreachable");
    });
    await f.store.enrich([current], read);
    f.advance(2001);
    await f.store.enrich([current], read);
    expect(read).toHaveBeenCalledTimes(1);
    f.advance(60_000);
    read.mockImplementation(async () => "");
    await f.store.enrich([current], read);
    expect(read).toHaveBeenCalledTimes(2);
    f.advance(60_000);
    await f.store.enrich([current], read);
    expect(read).toHaveBeenCalledTimes(2);
  });
});
