import { afterEach, describe, expect, it, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUsage, parseUsageArtifact } from "./index.ts";
import type { LocalJob } from "../localRunners/types.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
const measurement = {
  inputTokens: 10,
  outputTokens: 4,
  cacheReadInputTokens: 20,
  cacheCreationInputTokens: 6,
  complete: true,
  model: "claude-sonnet-4-5",
};
const artifact = (value: object = measurement) =>
  Buffer.from(
    JSON.stringify({
      schemaVersion: 1,
      source: "claude-code",
      reportedAt: "2026-10-05T12:00:00.000Z",
      ...value,
    }),
  );
const job = (extra: Partial<LocalJob> = {}): LocalJob => ({
  id: "job-11111111-1111-4111-8111-111111111111",
  runId: 1,
  type: "pm",
  project: "app",
  area: "core",
  status: "succeeded",
  createdAt: "2026-10-05T11:00:00.000Z",
  startedAt: "2026-10-05T11:01:00.000Z",
  finishedAt: "2026-10-05T12:00:00.000Z",
  ...extra,
});
function fixture() {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "gremlins-usage-"));
  roots.push(root);
  let time = new Date("2026-10-05T13:00:00.000Z");
  const options = { root, now: () => time };
  return {
    root,
    options,
    usage: createUsage(options),
    advance: (milliseconds = 60001) => {
      time = new Date(time.getTime() + milliseconds);
    },
  };
}

describe("durable token usage", () => {
  it("expires the read cache even with frequent polling and warns instead of rounding overflowing totals", () => {
    const f = fixture();
    f.usage.operation({ kind: "idea-planning" }, measurement, "cache");
    const timer = vi.spyOn(Date, "now").mockReturnValue(1000);
    try {
      expect(f.usage.summary().totals.totalTokens).toBe(40);
      const dir = join(f.root, ".run", "token-usage", "records"),
        file = join(dir, readdirSync(dir)[0]!);
      const value = JSON.parse(readFileSync(file, "utf8"));
      value.measurement.inputTokens = 20;
      writeFileSync(file, JSON.stringify(value));
      timer.mockReturnValue(3000);
      f.usage.summary();
      timer.mockReturnValue(5000);
      f.usage.summary();
      timer.mockReturnValue(6001);
      expect(f.usage.summary().totals.totalTokens).toBe(50);
    } finally {
      timer.mockRestore();
    }
    f.usage.operation(
      { kind: "idea-planning" },
      {
        inputTokens: Number.MAX_SAFE_INTEGER,
        outputTokens: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        complete: true,
      },
      "huge",
    );
    expect(f.usage.summary()).toMatchObject({
      totals: { totalTokens: Number.MAX_SAFE_INTEGER },
      warnings: expect.arrayContaining([expect.stringContaining("capped")]),
    });
  });
  it("deduplicates polls, survives restarts, and keeps project incarnations separate", async () => {
    const f = fixture(),
      reader = vi.fn(async () => artifact());
    await Promise.all([
      f.usage.captureJob(job(), reader),
      f.usage.captureJob(job(), reader),
    ]);
    await f.usage.captureJob(job(), reader);
    const restarted = createUsage(f.options);
    await restarted.captureJob(job(), reader);
    expect(reader).toHaveBeenCalledOnce();
    await restarted.captureJob(
      job({
        id: "job-22222222-2222-4222-8222-222222222222",
        projectInstanceId: "33333333-3333-4333-8333-333333333333",
      }),
      reader,
    );
    const result = restarted.summary({ range: "all" });
    expect(result.totals.totalTokens).toBe(80);
    expect(result.coverage.measuredRuns).toBe(2);
    expect(result.projects).toHaveLength(2);
    expect(
      restarted.summary({ project: "app", instance: "legacy" }).totals
        .totalTokens,
    ).toBe(40);
  });
  it("recovers late artifacts once and keeps terminal partial metrics final across polling and restart", async () => {
    const f = fixture();
    await f.usage.captureJob(job(), async () => {
      throw new Error("offline");
    });
    expect(f.usage.summary().coverage).toMatchObject({
      unavailableRuns: 1,
      measuredRuns: 0,
    });
    f.advance();
    await f.usage.captureJob(job(), async () =>
      artifact({ ...measurement, outputTokens: null, complete: false }),
    );
    expect(f.usage.summary()).toMatchObject({
      totals: { totalTokens: 36 },
      coverage: {
        partialRecords: 1,
        measuredRuns: 1,
        unavailableRuns: 0,
        fields: { inputTokens: 1, outputTokens: 0 },
      },
    });
    f.advance();
    const stopped = vi.fn(async () => artifact());
    await createUsage(f.options).captureJob(job(), stopped);
    expect(stopped).not.toHaveBeenCalled();
    expect(f.usage.summary()).toMatchObject({
      totals: { totalTokens: 36 },
      coverage: { partialRecords: 1, measuredRuns: 1 },
    });
    await f.usage.captureJob(
      job({ id: "job-22222222-2222-4222-8222-222222222222", status: "failed" }),
      async () =>
        artifact({
          inputTokens: 0,
          outputTokens: 0,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          complete: true,
        }),
    );
    expect(f.usage.summary()).toMatchObject({
      totals: { totalTokens: 36 },
      coverage: { measuredRuns: 2, unavailableRuns: 0 },
    });
  });
  it("defers historical metadata writes and shares a two-reader limit across service instances", async () => {
    const f = fixture();
    const metadata = Array.from({ length: 12 }, (_, index) =>
      f.usage.captureJob(job({ id: `history-${index}`, startedAt: undefined })),
    );
    expect(existsSync(join(f.root, ".run", "token-usage"))).toBe(false);
    await Promise.all(metadata);
    expect(f.usage.summary().coverage.unavailableRuns).toBe(12);
    let active = 0;
    let maximum = 0;
    const releases: (() => void)[] = [];
    const reader = vi.fn(async () => {
      active++;
      maximum = Math.max(maximum, active);
      await new Promise<void>((done) => releases.push(done));
      active--;
      return artifact();
    });
    const other = createUsage(f.options);
    const captures = Array.from({ length: 8 }, (_, index) =>
      (index % 2 ? f.usage : other).captureJob(
        job({ id: `run-${index}` }),
        reader,
      ),
    );
    for (let count = 2; count <= 8; count += 2) {
      await vi.waitFor(() => expect(reader).toHaveBeenCalledTimes(count));
      expect(active).toBe(2);
      for (const release of releases.splice(0)) release();
    }
    await Promise.all(captures);
    expect(maximum).toBe(2);
    expect(f.usage.summary().coverage.measuredRuns).toBe(8);
  });
  it("persists generic read failure backoff and a three-attempt cap across a cold restart", async () => {
    const f = fixture();
    const reader = vi.fn(async () => {
      throw new Error("unavailable");
    });
    await f.usage.captureJob(job(), reader);
    await f.usage.captureJob(job(), reader);
    expect(reader).toHaveBeenCalledTimes(1);
    const restarted = fixture();
    const original = join(f.root, ".run", "token-usage", "records");
    const destination = join(restarted.root, ".run", "token-usage", "records");
    mkdirSync(destination, { recursive: true });
    for (const file of readdirSync(original))
      writeFileSync(
        join(destination, file),
        readFileSync(join(original, file)),
      );
    await restarted.usage.captureJob(job(), reader);
    expect(reader).toHaveBeenCalledTimes(1);
    restarted.advance();
    await restarted.usage.captureJob(job(), reader);
    expect(reader).toHaveBeenCalledTimes(2);
    restarted.advance();
    await restarted.usage.captureJob(job(), reader);
    expect(reader).toHaveBeenCalledTimes(2);
    restarted.advance(300001);
    await restarted.usage.captureJob(job(), reader);
    expect(reader).toHaveBeenCalledTimes(3);
    restarted.advance(86400000);
    await createUsage(restarted.options).captureJob(job(), reader);
    expect(reader).toHaveBeenCalledTimes(3);
    const stored = JSON.parse(
      readFileSync(join(destination, readdirSync(destination)[0]!), "utf8"),
    );
    expect(stored.capture).toEqual({ attempts: 3, observed: true });
    expect(stored.measurement).toBeNull();
  });
  it("does not let metadata-only backfill or shutdown consume artifact recovery attempts", async () => {
    const f = fixture();
    await f.usage.captureJob(job());
    const reader = vi.fn(async () => artifact());
    await f.usage.captureJob(job(), reader);
    expect(reader).toHaveBeenCalledOnce();
    const releases: (() => void)[] = [];
    const blocked = vi.fn(async () => {
      await new Promise<void>((done) => releases.push(done));
      return artifact();
    });
    const captures = Array.from({ length: 8 }, (_, index) =>
      f.usage.captureJob(job({ id: `shutdown-${index}` }), blocked),
    );
    await vi.waitFor(() => expect(blocked).toHaveBeenCalledTimes(2));
    f.usage.cancelPendingReads();
    for (const release of releases) release();
    await Promise.all(captures);
    expect(blocked).toHaveBeenCalledTimes(2);
    expect(f.usage.summary().coverage).toMatchObject({
      measuredRuns: 3,
      unavailableRuns: 6,
    });
    await createUsage(f.options).captureJob(job({ id: "shutdown-7" }), reader);
    expect(reader).toHaveBeenCalledTimes(2);
  });
  it("imports API history promptly while the artifact lane is blocked, preserving its recovery state", async () => {
    const f = fixture();
    const releases: (() => void)[] = [];
    const reader = vi.fn(async () => {
      await new Promise<void>((done) => releases.push(done));
      return artifact();
    });
    const captures = [
      f.usage.captureJob(job(), reader),
      f.usage.captureJob(job({ id: "second-run" }), reader),
    ];
    await vi.waitFor(() => expect(reader).toHaveBeenCalledTimes(2));
    const api = createUsage(f.options);
    let imported = false;
    const importing = api.captureJob(job()).then(() => {
      imported = true;
    });
    try {
      await vi.waitFor(() => expect(imported).toBe(true), { timeout: 500 });
      expect(api.summary().coverage.unavailableRuns).toBe(2);
    } finally {
      for (const release of releases) release();
      await Promise.all([...captures, importing]);
    }
    expect(api.summary().coverage.measuredRuns).toBe(2);
    expect(reader).toHaveBeenCalledTimes(2);
  });
  it("does not retry a terminal invalid artifact or a markerless historical partial report", async () => {
    const f = fixture();
    const invalid = vi.fn(async () => Buffer.from("invalid artifact"));
    await f.usage.captureJob(job(), invalid);
    f.advance(86400000);
    await createUsage(f.options).captureJob(job(), invalid);
    expect(invalid).toHaveBeenCalledOnce();
    const dir = join(f.root, ".run", "token-usage", "records");
    const file = join(dir, readdirSync(dir)[0]!);
    const record = JSON.parse(readFileSync(file, "utf8"));
    delete record.capture;
    record.measurement = {
      ...measurement,
      complete: false,
      outputTokens: null,
    };
    const cold = fixture();
    const destination = join(cold.root, ".run", "token-usage", "records");
    mkdirSync(destination, { recursive: true });
    writeFileSync(
      join(destination, readdirSync(dir)[0]!),
      JSON.stringify(record),
    );
    await cold.usage.captureJob(job(), invalid);
    expect(invalid).toHaveBeenCalledOnce();
    expect(cold.usage.summary().coverage.partialRecords).toBe(1);
  });
  it("includes planning overhead, exact UTC ranges, zero days, and workspace-only filtering", () => {
    const f = fixture();
    f.usage.operation(
      { kind: "idea-planning" },
      measurement,
      "workspace",
      "2026-10-05T00:00:00.000Z",
    );
    f.usage.operation(
      { kind: "setup-analysis", project: "app" },
      measurement,
      "inside",
      "2026-09-29T00:00:00.000Z",
    );
    f.usage.operation(
      { kind: "pm-planning", project: "app" },
      null,
      "outside",
      "2026-09-28T23:59:59.999Z",
    );
    expect(f.usage.summary({ range: "7d" })).toMatchObject({
      from: "2026-09-29T00:00:00.000Z",
      totals: { totalTokens: 80 },
      coverage: { measuredOperations: 2, unavailableOperations: 0 },
    });
    expect(f.usage.summary({ range: "7d" }).daily).toHaveLength(7);
    expect(
      f.usage.summary({ range: "all" }).coverage.unavailableOperations,
    ).toBe(1);
    expect(f.usage.summary({ project: "_workspace" }).totals.totalTokens).toBe(
      40,
    );
    expect(f.usage.summary({ project: "app" }).totals.totalTokens).toBe(40);
    expect(() => f.usage.summary({ range: "../all" })).toThrow();
    expect(() => f.usage.summary({ instance: "legacy" })).toThrow();
  });
  it("never persists prompts, credentials, unsafe model names or invalid counters", () => {
    const f = fixture();
    f.usage.operation(
      { kind: "grumblin-generation", project: "app" },
      {
        ...measurement,
        model: "secret-token",
        prompt: "private prompt",
        credential: "private credential",
      },
      "safe",
    );
    const dir = join(f.root, ".run", "token-usage", "records");
    const contents = readdirSync(dir)
      .map((name) => readFileSync(join(dir, name), "utf8"))
      .join("");
    expect(contents).not.toMatch(
      /secret-token|private prompt|private credential/,
    );
    expect(
      parseUsageArtifact(artifact({ ...measurement, inputTokens: -1 })),
    ).toBeNull();
    expect(
      parseUsageArtifact(artifact({ ...measurement, outputTokens: Infinity })),
    ).toBeNull();
    expect(parseUsageArtifact(Buffer.alloc(4097))).toBeNull();
  });
  it("does not transfer replayed measurements to another project, and isolates corrupt records", async () => {
    const f = fixture();
    await f.usage.captureJob(job(), async () => artifact());
    await f.usage.captureJob(job({ project: "other" }), async () => artifact());
    expect(f.usage.summary({ project: "other" }).totals.totalTokens).toBe(0);
    const dir = join(f.root, ".run", "token-usage", "records");
    writeFileSync(join(dir, "f".repeat(64) + ".json"), "broken");
    expect(f.usage.summary()).toMatchObject({
      totals: { totalTokens: 40 },
      warnings: expect.arrayContaining([expect.stringContaining("incomplete")]),
    });
  });
  it("does not read artifacts for browser verification, unfinished, or never-started jobs", async () => {
    const f = fixture(),
      reader = vi.fn(async () => artifact());
    await f.usage.captureJob(job({ type: "verify" }), reader);
    await f.usage.captureJob(job({ status: "running" }), reader);
    await f.usage.captureJob(
      job({ status: "canceled", startedAt: undefined }),
      reader,
    );
    expect(reader).not.toHaveBeenCalled();
    expect(f.usage.summary().coverage).toMatchObject({
      measuredRuns: 0,
      unavailableRuns: 1,
    });
  });
});
