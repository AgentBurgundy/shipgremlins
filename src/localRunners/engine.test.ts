import { createHash, randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createLocalRunners,
  LocalRunnerError,
  LocalJobDeferredError,
} from "./engine.ts";
import type { DockerJobPayload, DockerRunners } from "./docker.ts";
import { RunnerWorkspaceError } from "./workspace.ts";
import { ManagedAccessError } from "./managedAccess.ts";
import { TestEnvironmentError } from "../testEnvironments/index.ts";
import type { LocalJobInput } from "./types.ts";
import { grumblinFixture } from "../grumblins/runtime-test-support.ts";
import { createUsage } from "../usage/index.ts";
import type { JobNotificationEvent } from "../slack/messages.ts";
import type { ActivityStore } from "../storage/activity.ts";

const lockWriteFault = vi.hoisted(() => ({
  once: undefined as ((fd: number) => void) | undefined,
}));
vi.mock("node:fs", async (load) => {
  const actual = await load<typeof import("node:fs")>();
  return {
    ...actual,
    writeFileSync: (...args: Parameters<typeof actual.writeFileSync>) => {
      const [file, value] = args;
      if (
        lockWriteFault.once &&
        typeof file === "number" &&
        typeof value === "string" &&
        value.startsWith('{"pid":') &&
        value.includes('"owner":')
      ) {
        const fault = lockWriteFault.once;
        lockWriteFault.once = undefined;
        fault(file);
      }
      return actual.writeFileSync(...args);
    },
  };
});

const roots: string[] = [];
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6eH8AAAAASUVORK5CYII=",
  "base64",
);
it.each(["succeeded", "failed", "canceled"])(
  "retains measured %s run usage once across terminal polls and restart",
  async (outcome) => {
    const f = fixture();
    await f.ready();
    const metrics = Buffer.from(
      JSON.stringify({
        schemaVersion: 1,
        source: "claude-code",
        inputTokens: 100,
        outputTokens: outcome === "succeeded" ? 50 : null,
        cacheReadInputTokens: 20,
        cacheCreationInputTokens: 10,
        complete: outcome === "succeeded",
        reportedAt: f.options.clock().toISOString(),
      }),
    );
    f.mock.readArtifact.mockImplementation(async () => metrics);
    const job = await f.engine.enqueue({
      type: "pm",
      project: "demo",
      area: "core",
    });
    await f.engine.tick();
    if (outcome === "canceled") await f.engine.cancel(job.id);
    else {
      f.finish(job.id, outcome === "succeeded" ? 0 : 1);
      await f.engine.tick();
    }
    await f.engine.stop();
    const usage = createUsage({ root: f.root, now: f.options.clock });
    expect(usage.summary()).toMatchObject({
      totals: { totalTokens: outcome === "succeeded" ? 180 : 130 },
      coverage: {
        measuredRuns: 1,
        unavailableRuns: 0,
        partialRecords: outcome === "succeeded" ? 0 : 1,
      },
    });
    const restarted = createLocalRunners(f.options);
    await restarted.tick();
    await restarted.stop();
    expect(usage.summary().coverage.measuredRuns).toBe(1);
    expect((await restarted.job(job.id))?.status).toBe(outcome);
  },
);
it("keeps a run successful when usage storage is blocked", async () => {
  const f = fixture();
  await f.ready();
  writeFileSync(join(f.root, ".run", "token-usage"), "unavailable storage");
  const job = await f.engine.enqueue({
    type: "pm",
    project: "demo",
    area: "core",
  });
  await f.engine.tick();
  f.finish(job.id);
  await f.engine.tick();
  await f.engine.stop();
  expect((await f.engine.job(job.id))?.status).toBe("succeeded");
});
it("keeps the app alive through trusted completion and retries terminal cleanup after Docker failure", async () => {
  const f = fixture();
  await f.ready();
  const cleanupEnvironment = vi.fn(async (_id: string) => {});
  f.options.docker.cleanupEnvironment = cleanupEnvironment;
  let finish!: () => void;
  const reconcileCompletedJob = vi.fn(
    async () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const engine = createLocalRunners({ ...f.options, reconcileCompletedJob });
  const job = await engine.enqueue({
    type: "pm",
    project: "demo",
    area: "core",
  });
  await engine.tick();
  f.finish(job.id);
  const tick = engine.tick();
  await vi.waitFor(() => expect(reconcileCompletedJob).toHaveBeenCalled());
  expect(cleanupEnvironment).not.toHaveBeenCalledWith(job.id);
  cleanupEnvironment.mockImplementationOnce(async (id) => {
    if (id === job.id) throw new Error("Docker offline");
  });
  finish();
  await tick;
  expect(cleanupEnvironment).toHaveBeenCalledWith(job.id);
  await engine.tick();
  expect(
    cleanupEnvironment.mock.calls.filter(([id]) => id === job.id).length,
  ).toBeGreaterThanOrEqual(2);
});
it("recovers old environment resources with one namespace sweep instead of one Docker cleanup per retained job", async () => {
  const f = fixture();
  await f.ready();
  const historical = await f.engine.enqueue({
    type: "pm",
    project: "demo",
    area: "core",
  });
  await f.engine.tick();
  f.finish(historical.id);
  await f.engine.tick();
  const cleanupEnvironment = vi.fn(async (_id: string) => {}),
    reconcileEnvironments = vi.fn(async (_ids: string[]) => {});
  f.options.docker.cleanupEnvironment = cleanupEnvironment;
  f.options.docker.reconcileEnvironments = reconcileEnvironments;
  const restarted = createLocalRunners(f.options);
  await restarted.tick();
  await restarted.tick();
  expect(cleanupEnvironment).not.toHaveBeenCalled();
  expect(reconcileEnvironments).toHaveBeenCalledOnce();
  expect(reconcileEnvironments).toHaveBeenCalledWith([]);
});
it("keeps historical managed identities quarantined after restart until their browser cleanup succeeds", async () => {
  const f = fixture();
  await f.ready();
  const historical = await f.engine.enqueue({
    type: "pm",
    project: "demo",
    area: "core",
  });
  await f.engine.tick();
  f.finish(historical.id);
  await f.engine.tick();
  let pending = true;
  const cleanupEnvironment = vi.fn(async (id: string) => {
    if (id === historical.id && pending)
      throw new Error("Remote cleanup not confirmed");
  });
  const releaseJobResources = vi.fn(async (_id: string) => {});
  f.options.docker.cleanupEnvironment = cleanupEnvironment;
  f.options.docker.requiresAccessCleanup = (id) => id === historical.id;
  f.options.docker.reconcileEnvironments = vi.fn(async () => {
    if (pending) throw new Error("Remote unreachable");
  });
  const restarted = createLocalRunners({ ...f.options, releaseJobResources });
  await restarted.tick();
  expect(cleanupEnvironment).toHaveBeenCalledWith(historical.id);
  expect(releaseJobResources).not.toHaveBeenCalledWith(historical.id);
  pending = false;
  await restarted.tick();
  expect(releaseJobResources).toHaveBeenCalledWith(historical.id);
  await restarted.stop();
});
it("serializes deletion guards with job admission and preserves typed mutation errors", async () => {
  const f = fixture(),
    queued = await f.engine.enqueue({
      type: "pm",
      project: "demo",
      area: "core",
    }),
    mutation = vi.fn();
  await expect(
    f.engine.withConfigurationMutation({ project: "demo" }, mutation),
  ).rejects.toMatchObject({ status: 409 });
  expect(mutation).not.toHaveBeenCalled();
  await f.engine.withConfigurationMutation(
    { project: "demo", area: "other" },
    mutation,
  );
  expect(mutation).toHaveBeenCalledOnce();
  await f.engine.cancel(queued.id);
  const stateFile = join(f.root, ".run", "local-runners", "state.json"),
    state = JSON.parse(readFileSync(stateFile, "utf8"));
  state.jobs.find((job: { id: string }) => job.id === queued.id).failure = {
    category: "completion",
    at: new Date().toISOString(),
    retryable: true,
  };
  writeFileSync(stateFile, JSON.stringify(state));
  await f.engine.withConfigurationMutation({ project: "demo" }, mutation);
  let enter!: () => void, release!: () => void;
  const started = new Promise<void>((done) => (enter = done)),
    gate = new Promise<void>((done) => (release = done));
  const active = f.engine.withConfigurationMutation({}, async () => {
    enter();
    await gate;
    return "saved";
  });
  await started;
  const second = createLocalRunners(f.options);
  await expect(
    second.enqueue({ type: "pm", project: "demo", area: "core" }),
  ).rejects.toMatchObject({ status: 409 });
  release();
  expect(await active).toBe("saved");
  const expected = Object.assign(new Error("specific guarded recovery error"), {
    status: 409,
  });
  await expect(
    f.engine.withConfigurationMutation({}, () => {
      throw expected;
    }),
  ).rejects.toBe(expected);
});
it("persists remote worker bindings and checks project scope before preparing credentials", async () => {
  const f = fixture(),
    prepareWorker = vi.fn(async () => {});
  f.options.docker.prepareWorker = prepareWorker;
  f.options.docker.canRun = (_remote, project) => project === "allowed";
  const remoteId = `remote-${randomUUID()}`,
    worker = await f.engine.addRemote(remoteId, "Cloud gremlin");
  expect(await f.engine.addRemote(remoteId, "Cloud gremlin")).toEqual(worker);
  await f.engine.tick();
  const verification = (await f.engine.jobs())[0]!;
  f.finish(verification.id);
  await f.engine.tick();
  const blocked = await f.engine.enqueue({
      type: "pm",
      project: "blocked",
      area: "core",
    }),
    allowed = await f.engine.enqueue({
      type: "pm",
      project: "allowed",
      area: "core",
    });
  const restarted = createLocalRunners(f.options);
  await restarted.tick();
  expect(await restarted.job(blocked.id)).toMatchObject({ status: "queued" });
  expect(await restarted.job(allowed.id)).toMatchObject({ status: "running" });
  expect(f.options.prepareJob).toHaveBeenCalledTimes(1);
  expect(prepareWorker).toHaveBeenLastCalledWith(worker.id, remoteId);
  expect(f.mock.ensureImage).not.toHaveBeenCalled();
  expect(f.calls.at(-1)?.payload.project).toBe("allowed");
});
it("persists explicit one-off job admission across a controller restart", async () => {
  const f = fixture();
  const queued = await f.engine.enqueue({
    type: "pm",
    project: "demo",
    area: "core",
    runOnce: true,
  });
  const restarted = createLocalRunners(f.options);
  expect(await restarted.job(queued.id)).toMatchObject({
    runOnce: true,
    status: "queued",
  });
  await expect(
    restarted.enqueue({ type: "verify", runOnce: true }),
  ).rejects.toThrow();
});

it("backs off confirmed pre-execution infrastructure failures durably and exhausts only two retries", async () => {
  const f = fixture();
  f.mock.ensureImage.mockRejectedValue(new Error("private outage details"));
  await f.engine.create();
  await f.engine.tick();
  const job = (await f.engine.jobs())[0]!;
  expect(job).toMatchObject({
    status: "queued",
    retries: 1,
    failure: { category: "infrastructure", retryable: true },
  });
  await f.engine.tick();
  expect(f.mock.ensureImage).toHaveBeenCalledTimes(1);
  const restarted = createLocalRunners(f.options);
  f.advance(15000);
  await restarted.tick();
  expect(await restarted.job(job.id)).toMatchObject({
    status: "queued",
    retries: 2,
  });
  f.advance(59999);
  await restarted.tick();
  expect(f.mock.ensureImage).toHaveBeenCalledTimes(2);
  f.advance(1);
  await restarted.tick();
  expect(await restarted.job(job.id)).toMatchObject({
    status: "failed",
    retries: 2,
    failure: { category: "infrastructure", retryable: false },
  });
  expect(f.mock.startJob).not.toHaveBeenCalled();
  expect(readFileSync(f.stateFile, "utf8")).not.toContain("private outage");
});

it("surfaces a storage prerequisite failure once without infrastructure retries or agent preparation", async () => {
  const f = fixture(),
    message =
      "Runner storage has less than 5 GiB free. Free space on its storage drive before starting another job. Retained work and evidence were not deleted.";
  f.mock.ensureImage.mockRejectedValue(new RunnerWorkspaceError(message));
  const worker = await f.engine.create();
  await f.engine.tick();
  const job = (await f.engine.jobs())[0]!;
  expect(job).toMatchObject({
    status: "failed",
    retries: 0,
    message,
    failure: { category: "infrastructure", retryable: false },
  });
  expect(job.nextAttemptAt).toBeUndefined();
  expect(
    (await f.engine.status()).runners.find((item) => item.id === worker.id),
  ).toMatchObject({ busy: false, message });
  const restarted = createLocalRunners(f.options);
  f.advance(90_000);
  await restarted.tick();
  await restarted.tick();
  expect((await restarted.job(job.id))?.message).toBe(message);
  expect(f.mock.ensureImage).toHaveBeenCalledTimes(1);
  expect(f.options.prepareJob).not.toHaveBeenCalled();
  expect(f.mock.startJob).not.toHaveBeenCalled();
  expect(f.mock.removeJob).not.toHaveBeenCalled();
});

it("stops a workspace launch refusal durably, releases its lease and restores unused run budget", async () => {
  const f = fixture();
  const worker = await f.ready();
  const releaseJobResources = vi.fn(async (_id: string) => {});
  const options = {
    ...f.options,
    releaseJobResources,
    executionLimits: () => ({ maxDailyRuns: 1 }),
  };
  const engine = createLocalRunners(options);
  const job = await engine.enqueue({
    type: "pm",
    project: "demo",
    area: "core",
  });
  const message =
    "The runner storage directory is missing. Mount its storage drive and restore the configured directory before starting a job.";
  f.mock.startJob.mockRejectedValueOnce(new RunnerWorkspaceError(message));
  f.mock.inspectJob.mockClear();
  await engine.tick();
  expect(await engine.job(job.id)).toMatchObject({
    status: "failed",
    message,
    retries: 0,
    failure: { category: "infrastructure", retryable: false },
  });
  expect(f.mock.inspectJob).not.toHaveBeenCalledWith(job.id);
  expect(releaseJobResources).toHaveBeenCalledWith(job.id);
  expect(
    (await engine.status()).runners.find((item) => item.id === worker.id),
  ).toMatchObject({ busy: false, status: "ready", message });
  const attempts = f.mock.startJob.mock.calls.length;
  const restarted = createLocalRunners(options);
  f.advance(90_000);
  await restarted.tick();
  expect(f.mock.startJob).toHaveBeenCalledTimes(attempts);
  expect(f.mock.removeJob).not.toHaveBeenCalledWith(job.id);
  expect(readFileSync(f.stateFile, "utf8")).not.toContain(
    "never-store-this-credential",
  );
  const replacement = await restarted.enqueue({
    type: "pm",
    project: "demo",
    area: "core",
  });
  await restarted.tick();
  expect((await restarted.job(replacement.id))?.status).toBe("running");
  expect((await restarted.job(job.id))?.status).toBe("failed");
});

it("does not trust a generic error merely named RunnerWorkspaceError", async () => {
  const f = fixture();
  f.mock.ensureImage.mockRejectedValue(
    Object.assign(new Error("private storage path and credential"), {
      name: "RunnerWorkspaceError",
    }),
  );
  await f.engine.create();
  await f.engine.tick();
  expect((await f.engine.jobs())[0]).toMatchObject({
    status: "queued",
    failure: { category: "infrastructure", retryable: true },
  });
  expect(readFileSync(f.stateFile, "utf8")).not.toContain(
    "private storage path and credential",
  );
});

it("cancels queued work durably and only stops the requested running owned job", async () => {
  const f = fixture();
  await f.ready();
  const queued = await f.engine.enqueue({
    type: "pm",
    project: "demo",
    area: "core",
  });
  expect(await f.engine.cancel(queued.id)).toMatchObject({
    status: "canceled",
  });
  await createLocalRunners(f.options).tick();
  expect(f.calls.some((call) => call.id === queued.id)).toBe(false);
  expect(f.mock.stopJob).not.toHaveBeenCalled();
  const running = await f.engine.enqueue({
    type: "developer",
    project: "demo",
    ticket: "APP-10",
  });
  await f.engine.tick();
  const result = await f.engine.cancel(running.id);
  expect(result).toMatchObject({
    status: "canceled",
    cancelRequestedAt: expect.any(String),
  });
  expect(f.mock.stopJob).toHaveBeenCalledExactlyOnceWith(running.id);
  expect(f.containers.has(running.id)).toBe(true);
  expect(f.mock.removeJob).not.toHaveBeenCalled();
  expect(await f.engine.cancel(running.id)).toMatchObject({
    status: "canceled",
  });
  expect(f.mock.stopJob).toHaveBeenCalledTimes(1);
});

it("records cancellation while preparation holds the engine lock and never launches afterward", async () => {
  const f = fixture();
  await f.ready();
  let release!: (payload: DockerJobPayload) => void;
  const prepareJob = vi.fn(
    () =>
      new Promise<DockerJobPayload>((resolve) => {
        release = resolve;
      }),
  );
  const cleanup = vi.fn(async () => {});
  const engine = createLocalRunners({
    ...f.options,
    prepareJob,
    releaseJobResources: cleanup,
  });
  const job = await engine.enqueue({
    type: "pm",
    project: "demo",
    area: "core",
  });
  const tick = engine.tick();
  await vi.waitFor(() => expect(prepareJob).toHaveBeenCalledOnce());
  const canceled = await engine.cancel(job.id);
  expect(canceled.cancelRequestedAt).toBeDefined();
  release({ kind: "pm" });
  await tick;
  expect(await engine.job(job.id)).toMatchObject({ status: "canceled" });
  expect(f.calls.some((call) => call.id === job.id)).toBe(false);
  expect(cleanup).toHaveBeenCalledWith(job.id);
});
it("stops the owned job immediately when cancellation arrives during locked completion work", async () => {
  const f = fixture();
  await f.ready();
  let rejectCompletion!: (error: Error) => void;
  const complete = vi.fn(
    () =>
      new Promise<void>((_resolve, reject) => {
        rejectCompletion = reject;
      }),
  );
  const engine = createLocalRunners({
    ...f.options,
    reconcileCompletedJob: complete,
  });
  const job = await engine.enqueue({
    type: "pm",
    project: "demo",
    area: "core",
  });
  await engine.tick();
  f.finish(job.id);
  const tick = engine.tick();
  await vi.waitFor(() => expect(complete).toHaveBeenCalledOnce());
  await engine.cancel(job.id);
  expect(f.mock.stopJob).toHaveBeenCalledExactlyOnceWith(job.id);
  rejectCompletion(new Error("Review stopped"));
  await tick;
  await engine.tick();
  expect(await engine.job(job.id)).toMatchObject({ status: "canceled" });
});

it("keeps cancellation pending and credentials reserved during Docker outage, then finishes after restart", async () => {
  const f = fixture();
  await f.ready();
  const cleanup = vi.fn(async () => {});
  const engine = createLocalRunners({
    ...f.options,
    releaseJobResources: cleanup,
  });
  const job = await engine.enqueue({
    type: "pm",
    project: "demo",
    area: "core",
  });
  await engine.tick();
  f.mock.stopJob.mockRejectedValueOnce(new Error("offline"));
  expect(await engine.cancel(job.id)).toMatchObject({
    status: "running",
    cancelRequestedAt: expect.any(String),
  });
  expect(cleanup).not.toHaveBeenCalledWith(job.id);
  const restarted = createLocalRunners({
    ...f.options,
    releaseJobResources: cleanup,
  });
  await restarted.tick();
  expect(await restarted.job(job.id)).toMatchObject({ status: "canceled" });
  expect(cleanup).toHaveBeenCalledWith(job.id);
});

it("persists daily run limits across restart, isolates projects, and resumes on the next UTC day", async () => {
  const f = fixture();
  await f.ready();
  const options = {
    ...f.options,
    executionLimits: () => ({ maxDailyRuns: 1, maxJobMinutes: 2 }),
  };
  const engine = createLocalRunners(options);
  const first = await engine.enqueue({
    type: "pm",
    project: "demo",
    area: "core",
  });
  await engine.tick();
  expect(f.calls.at(-1)?.payload.maxRuntimeMinutes).toBe(2);
  f.advance(60000);
  f.finish(first.id);
  await engine.tick();
  const second = await engine.enqueue({
    type: "pm",
    project: "demo",
    area: "other",
  });
  const restarted = createLocalRunners(options);
  await restarted.tick();
  expect(await restarted.job(second.id)).toMatchObject({
    status: "queued",
    message: expect.stringContaining("daily run limit"),
  });
  const independent = await restarted.enqueue({
    type: "pm",
    project: "another",
    area: "core",
  });
  await restarted.tick();
  expect(await restarted.job(independent.id)).toMatchObject({
    status: "running",
  });
  f.finish(independent.id);
  await restarted.tick();
  expect(
    (await restarted.status()).execution?.find(
      (item) => item.project === "demo",
    ),
  ).toMatchObject({ runsStarted: 1, runtimeMinutes: 1 });
  f.advance(86400000);
  await restarted.tick();
  expect(await restarted.job(second.id)).toMatchObject({ status: "running" });
});

it("stops only the job whose project runtime limit expires and accounts its reserved runtime", async () => {
  const f = fixture();
  await f.ready();
  const engine = createLocalRunners({
    ...f.options,
    executionLimits: () => ({ maxDailyRuntimeMinutes: 1, maxJobMinutes: 10 }),
  });
  const job = await engine.enqueue({
    type: "pm",
    project: "demo",
    area: "core",
  });
  await engine.tick();
  expect(f.calls.at(-1)?.payload.maxRuntimeMinutes).toBe(1);
  f.advance(60000);
  await engine.tick();
  expect(await engine.job(job.id)).toMatchObject({
    status: "failed",
    failure: { category: "runtime-limit" },
    budget: { runtimeMs: 60000 },
  });
  expect(f.mock.stopJob).toHaveBeenCalledWith(job.id);
  const queued = await engine.enqueue({
    type: "pm",
    project: "demo",
    area: "other",
  });
  await engine.tick();
  expect(await engine.job(queued.id)).toMatchObject({
    status: "queued",
    message: expect.stringContaining("daily runtime budget"),
  });
});

it("retries completion reconciliation without executing the agent or publication again", async () => {
  const f = fixture();
  await f.ready();
  const reconcileCompletedJob = vi.fn(async () => {
    throw new Error("provider unavailable");
  });
  const engine = createLocalRunners({ ...f.options, reconcileCompletedJob });
  const job = await engine.enqueue({
    type: "developer",
    project: "demo",
    ticket: "APP-20",
  });
  await engine.tick();
  f.finish(job.id);
  await engine.tick();
  expect(await engine.job(job.id)).toMatchObject({
    status: "running",
    reconciliationAttempts: 1,
  });
  const starts = f.mock.startJob.mock.calls.length;
  await engine.tick();
  expect(reconcileCompletedJob).toHaveBeenCalledTimes(1);
  f.advance(30000);
  const restarted = createLocalRunners({ ...f.options, reconcileCompletedJob });
  await restarted.tick();
  f.advance(60000);
  await restarted.tick();
  expect(await restarted.job(job.id)).toMatchObject({
    status: "failed",
    reconciliationAttempts: 3,
    failure: { category: "completion", retryable: false },
  });
  await expect(
    restarted.withConfigurationMutation(
      { project: "demo" },
      () => "historical failure retained",
    ),
  ).resolves.toBe("historical failure retained");
  expect(f.mock.startJob).toHaveBeenCalledTimes(starts);
});

it("retains completed work and usage when independent review hits a storage admission failure", async () => {
  const f = fixture();
  const worker = await f.ready();
  const message =
    "Runner storage has less than 5 GiB free. Free space on its storage drive before starting another job. Retained work and evidence were not deleted.";
  const completeJob = vi.fn(async () => {});
  const reconcileCompletedJob = vi.fn(async () => {
    throw new RunnerWorkspaceError(message);
  });
  const releaseJobResources = vi.fn(async (_id: string) => {});
  const options = {
    ...f.options,
    completeJob,
    reconcileCompletedJob,
    releaseJobResources,
    executionLimits: () => ({ maxDailyRuns: 1 }),
  };
  const engine = createLocalRunners(options);
  const job = await engine.enqueue({
    type: "pm",
    project: "demo",
    area: "core",
  });
  await engine.tick();
  f.advance(60_000);
  f.finish(job.id);
  await engine.tick();
  expect(await engine.job(job.id)).toMatchObject({
    status: "failed",
    exitCode: 0,
    message: expect.stringContaining(message),
    failure: { category: "infrastructure", retryable: false },
    budget: { runtimeMs: 60_000 },
  });
  expect((await engine.job(job.id))?.message).toContain(
    "Completed work and evidence are retained",
  );
  expect((await engine.job(job.id))?.nextAttemptAt).toBeUndefined();
  expect(releaseJobResources).toHaveBeenCalledWith(job.id);
  expect(
    (await engine.status()).runners.find((item) => item.id === worker.id),
  ).toMatchObject({
    busy: false,
    status: "ready",
    message: expect.stringContaining(message),
  });

  const starts = f.mock.startJob.mock.calls.length;
  const restarted = createLocalRunners(options);
  f.advance(180_000);
  await restarted.tick();
  await restarted.tick();
  expect(completeJob).toHaveBeenCalledOnce();
  expect(reconcileCompletedJob).toHaveBeenCalledOnce();
  expect(f.mock.startJob).toHaveBeenCalledTimes(starts);
  expect(f.mock.removeJob).not.toHaveBeenCalledWith(job.id);
  expect(f.mock.stopJob).not.toHaveBeenCalledWith(job.id);
  expect(f.containers.get(job.id)).toMatchObject({
    status: "exited",
    exitCode: 0,
  });
  expect(
    (await restarted.status()).execution?.find(
      (item) => item.project === "demo",
    ),
  ).toMatchObject({ runsStarted: 1, runtimeMinutes: 1 });
  const next = await restarted.enqueue({
    type: "pm",
    project: "demo",
    area: "core",
  });
  await restarted.tick();
  expect(await restarted.job(next.id)).toMatchObject({ status: "queued" });
  expect(f.mock.startJob).toHaveBeenCalledTimes(starts);
});

it("preserves the selected Grumblin across queued restart and requires matching worker persona provenance", async () => {
  const f = fixture();
  await f.ready();
  const input = {
    type: "pm" as const,
    project: "demo",
    area: "core",
    runOnce: true,
    pmMode: "grumblin" as const,
    grumblin: grumblinFixture({ project: "demo" }),
    discoveryRevision: "a".repeat(64),
  };
  const queued = await f.engine.enqueue(input);
  const completeJob = vi.fn(async () => {});
  const engine = createLocalRunners({
    ...f.options,
    completeJob,
    prepareJob: async (job) => ({
      kind: job.type,
      pmMode: job.pmMode,
      grumblin: job.grumblin,
    }),
  });
  expect(await engine.job(queued.id)).toMatchObject(input);
  await engine.tick();
  expect(f.mock.startJob).toHaveBeenLastCalledWith(
    expect.objectContaining({
      payload: expect.objectContaining({
        grumblin: input.grumblin,
        pmMode: "grumblin",
      }),
    }),
  );
  f.finish(queued.id);
  const originalArtifacts = f.mock.artifacts.getMockImplementation()!;
  f.mock.artifacts.mockImplementation(
    async (id) =>
      ({
        ...(await originalArtifacts(id)),
        result: {
          ok: true,
          kind: "pm",
          nonce: id,
          pmMode: "grumblin",
          grumblin: input.grumblin,
        },
      }) as unknown as Awaited<ReturnType<typeof originalArtifacts>>,
  );
  await engine.tick();
  expect(await engine.job(queued.id)).toMatchObject({
    status: "succeeded",
    grumblin: input.grumblin,
  });
  expect(completeJob).toHaveBeenCalledOnce();
  for (const invalid of [
    { ...input, grumblin: undefined },
    { ...input, pmMode: undefined },
    { ...input, grumblin: grumblinFixture({ project: "other" }) },
    { ...input, runOnce: false },
    { ...input, linearBinding: { connectionId: "default" } },
    { ...input, discoveryRevision: undefined },
  ])
    await expect(engine.enqueue(invalid)).rejects.toThrow();
  const mismatched = await engine.enqueue(input);
  await engine.tick();
  f.finish(mismatched.id);
  f.mock.artifacts.mockImplementation(
    async (id) =>
      ({
        ...(await originalArtifacts(id)),
        result: {
          ok: true,
          kind: "pm",
          nonce: id,
          pmMode: "grumblin",
          grumblin: { ...input.grumblin, clickBudget: 30 },
        },
      }) as unknown as Awaited<ReturnType<typeof originalArtifacts>>,
  );
  await engine.tick();
  expect(await engine.job(mismatched.id)).toMatchObject({
    status: "failed",
    failure: { category: "completion" },
  });
  expect(completeJob).toHaveBeenCalledOnce();
});

it("does not launch a Grumblin if preparation substitutes a different profile", async () => {
  const f = fixture();
  await f.ready();
  const queued = await f.engine.enqueue({
    type: "pm",
    project: "demo",
    area: "core",
    runOnce: true,
    pmMode: "grumblin",
    grumblin: grumblinFixture({ project: "demo" }),
    discoveryRevision: "a".repeat(64),
  });
  const engine = createLocalRunners({
    ...f.options,
    prepareJob: async (job) => ({
      kind: job.type,
      pmMode: job.pmMode,
      grumblin: grumblinFixture({ project: "demo", goal: "Different task" }),
    }),
  });
  const previous = f.mock.startJob.mock.calls.length;
  await engine.tick();
  expect(f.mock.startJob).toHaveBeenCalledTimes(previous);
  expect(await engine.job(queued.id)).toMatchObject({ status: "failed" });
});

it("admits explicit product exploration with a Linear binding and preserves its identity through completion", async () => {
  const f = fixture();
  await f.ready();
  const input = {
    type: "pm" as const,
    project: "demo",
    area: "core",
    runOnce: true,
    pmMode: "exploration" as const,
    discoveryRevision: "a".repeat(64),
    linearBinding: { connectionId: "default" },
  };
  const queued = await f.engine.enqueue(input);
  const completeJob = vi.fn(async () => {});
  const engine = createLocalRunners({
    ...f.options,
    completeJob,
    prepareJob: async (job) => ({ kind: job.type, pmMode: job.pmMode }),
  });
  await engine.tick();
  expect(f.mock.startJob).toHaveBeenCalledWith(
    expect.objectContaining({
      payload: expect.objectContaining({ pmMode: "exploration" }),
    }),
  );
  f.finish(queued.id);
  await engine.tick();
  expect(await engine.job(queued.id)).toMatchObject({
    ...input,
    status: "succeeded",
  });
  expect(completeJob).toHaveBeenCalledOnce();
  for (const invalid of [
    { ...input, type: "developer" as const },
    { ...input, runOnce: false },
    { ...input, discoveryRevision: undefined },
    { ...input, ticket: "APP-1" },
  ])
    await expect(engine.enqueue(invalid)).rejects.toThrow();
});

it("persists discovery admission and completes only after retry-safe knowledge adoption", async () => {
  const f = fixture();
  await f.ready();
  const input = {
    type: "pm" as const,
    project: "demo",
    area: "core",
    runOnce: true,
    pmMode: "discovery" as const,
    discoveryRevision: "a".repeat(64),
  };
  const queued = await f.engine.enqueue(input);
  const completeJob = vi.fn(async () => {});
  const engine = createLocalRunners({
    ...f.options,
    completeJob,
    prepareJob: async (job) => ({ kind: job.type, pmMode: job.pmMode }),
  });
  expect(await engine.job(queued.id)).toMatchObject(input);
  await engine.tick();
  f.finish(queued.id);
  await engine.tick();
  expect(completeJob).toHaveBeenCalledWith(
    expect.objectContaining({
      id: queued.id,
      pmMode: "discovery",
      discoveryRevision: input.discoveryRevision,
    }),
    f.options.docker,
  );
  expect(await engine.job(queued.id)).toMatchObject({
    status: "succeeded",
    pmMode: "discovery",
  });
  await engine.tick();
  expect(completeJob).toHaveBeenCalledTimes(1);
  await expect(engine.enqueue({ ...input, runOnce: false })).rejects.toThrow();
  await expect(
    engine.enqueue({ ...input, discoveryRevision: undefined }),
  ).rejects.toThrow();
  const failed = await engine.enqueue(input);
  await engine.tick();
  f.finish(failed.id);
  completeJob.mockRejectedValueOnce(new Error("stale output"));
  await engine.tick();
  expect(await engine.job(failed.id)).toMatchObject({
    status: "failed",
    message: expect.stringContaining("Previous knowledge was preserved"),
  });
});

function fixture() {
  const root = mkdtempSync(
    join(realpathSync(tmpdir()), "sg-local-engine-test-"),
  );
  roots.push(root);
  writeFileSync(join(root, "hub.json"), '{"hubRepo":"example/keep"}\r\n');
  writeFileSync(join(root, ".env"), "GITHUB_TOKEN=keep-this-private\n");
  const containers = new Map<
    string,
    {
      running: boolean;
      status: string;
      exitCode?: number;
      payload: DockerJobPayload;
    }
  >();
  const calls: { id: string; workerId: string; payload: DockerJobPayload }[] =
    [];
  let milliseconds = Date.parse("2026-10-04T15:00:00.000Z");
  const mock = {
    preflight: vi.fn(async () => ({ ready: true })),
    ensureImage: vi.fn(async () => undefined),
    startJob: vi.fn(
      async (job: {
        id: string;
        workerId: string;
        payload: DockerJobPayload;
      }) => {
        calls.push(job);
        containers.set(job.id, {
          running: true,
          status: "running",
          payload: job.payload,
        });
      },
    ),
    inspectJob: vi.fn(async (id: string) => {
      const container = containers.get(id);
      return container
        ? {
            exists: true,
            running: container.running,
            status: container.status,
            exitCode: container.exitCode,
          }
        : { exists: false, running: false, status: "missing" };
    }),
    logs: vi.fn(async () => "Starting gremlin\nTOKEN=[redacted]\nFinished\n"),
    artifacts: vi.fn(async (id: string) => ({
      result: {
        ok: true,
        kind: containers.get(id)?.payload.kind,
        nonce: id,
        screenshot: "screenshot.png",
        browser: "chromium",
      },
      files: [
        {
          name: "screenshot.png",
          size: PNG.length,
          sha256: createHash("sha256").update(PNG).digest("hex"),
        },
      ],
    })),
    readArtifact: vi.fn(async () => PNG),
    removeJob: vi.fn(async () => undefined),
    stopJob: vi.fn(async (id: string) => {
      const container = containers.get(id);
      if (container) {
        container.running = false;
        container.status = "exited";
        container.exitCode = 143;
      }
    }),
  };
  const options = {
    root,
    packageRoot: root,
    docker: mock as unknown as DockerRunners,
    prepareJob: vi.fn(
      async (job: { type: string }) =>
        ({
          kind: job.type,
          credentials: { GITHUB_TOKEN: "never-store-this-credential" },
          prompt: "Private generated agent instructions",
        }) as DockerJobPayload,
    ),
    clock: () => new Date(milliseconds),
    notify: vi.fn(async (_event: JobNotificationEvent) => ({
      status: "skipped" as const,
    })),
  };
  const engine = createLocalRunners(options);
  const finish = (id: string, code = 0) => {
    const container = containers.get(id)!;
    container.running = false;
    container.status = "exited";
    container.exitCode = code;
  };
  const ready = async () => {
    const worker = await engine.create();
    await engine.tick();
    const job = (await engine.status()).jobs[0]!;
    finish(job.id);
    await engine.tick();
    return worker;
  };
  return {
    root,
    options,
    engine,
    mock,
    containers,
    calls,
    finish,
    ready,
    advance: (amount: number) => {
      milliseconds += amount;
    },
    stateFile: join(root, ".run", "local-runners", "state.json"),
  };
}

afterEach(() => {
  lockWriteFault.once = undefined;
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe("durable local worker engine", () => {
  it("explains a lost signed-in session using trusted failure text, never raw worker errors", async () => {
    const f = fixture();
    await f.ready();
    const job = await f.engine.enqueue({
      type: "pm",
      project: "demo",
      area: "core",
    });
    await f.engine.tick();
    f.finish(job.id, 1);
    f.mock.artifacts.mockResolvedValue({
      result: {
        ok: false,
        kind: "pm",
        accessFailure: {
          code: "session_expired",
          message: "password=never-display",
        },
      },
      files: [],
    } as never);
    await f.engine.tick();
    const result = await f.engine.job(job.id);
    expect(result?.message).toContain("session expired");
    expect(JSON.stringify(result)).not.toContain("never-display");
    expect(result?.failure).toMatchObject({
      retryable: false,
      category: "configuration",
    });
  });
  it("keeps managed jobs queued for compatible workers before any preparation or credential lease", async () => {
    const f = fixture();
    await f.ready();
    f.options.docker.canCheckAccess = () => false;
    const engine = createLocalRunners({
      ...f.options,
      requiresManagedAccess: () => true,
    });
    const job = await engine.enqueue({
      type: "pm",
      project: "demo",
      area: "core",
    });
    await engine.tick();
    expect(await engine.job(job.id)).toMatchObject({
      status: "queued",
      message: expect.stringContaining("supports managed test access"),
    });
    expect(f.options.prepareJob).not.toHaveBeenCalled();
  });
  it.each([
    new ManagedAccessError(
      "invalid_credentials",
      "Test account rejected. Reconnect it in Test access.",
    ),
    new TestEnvironmentError(
      "The test app never became ready on port 4311. Check its start command.",
      "health_timeout",
    ),
  ])(
    "preserves a known pre-agent failure without reporting a missing container",
    async (error) => {
      const f = fixture();
      await f.ready();
      f.mock.startJob.mockRejectedValueOnce(error);
      const job = await f.engine.enqueue({
        type: "pm",
        project: "demo",
        area: "core",
      });
      await f.engine.tick();
      expect(await f.engine.job(job.id)).toMatchObject({
        status: "failed",
        message: error.message,
        failure: { category: "configuration", retryable: false },
      });
      f.advance(120000);
      await f.engine.tick();
      expect(f.mock.startJob).toHaveBeenCalledTimes(2); // Worker verification and one admitted attempt.
    },
  );
  it("reserves setup capacity until browser cleanup is confirmed, without scheduling another job", async () => {
    const f = fixture();
    const worker = await f.ready();
    const cleanup = vi.fn(async () => {});
    f.options.docker.cleanupEnvironment = cleanup;
    const reservation = await f.engine.reserveSetupWorker(
      "demo",
      "job-setup-11111111-1111-4111-8111-111111111111",
    );
    expect(reservation.id).toBe(worker.id);
    await expect(
      f.engine.reserveSetupWorker(
        "demo",
        "job-setup-22222222-2222-4222-8222-222222222222",
      ),
    ).rejects.toThrow(/available runner/);
    const job = await f.engine.enqueue({
      type: "pm",
      project: "demo",
      area: "core",
    });
    await f.engine.tick();
    expect((await f.engine.job(job.id))?.status).toBe("queued");
    cleanup.mockRejectedValueOnce(new Error("runner unreachable"));
    await expect(reservation.release()).rejects.toThrow(/could not complete/);
    expect((await f.engine.status()).runners[0]?.busy).toBe(true);
    await reservation.release();
    await f.engine.tick();
    expect((await f.engine.job(job.id))?.status).toBe("running");
  });
  it("does not steal a live setup reservation from a cooperating engine instance", async () => {
    const f = fixture();
    await f.ready();
    const cleanup = vi.fn(async () => {});
    f.options.docker.cleanupEnvironment = cleanup;
    const id = "job-setup-11111111-1111-4111-8111-111111111111";
    const reservation = await f.engine.reserveSetupWorker("demo", id);
    const other = createLocalRunners(f.options);
    await other.tick();
    expect(f.mock.stopJob).not.toHaveBeenCalledWith(id);
    expect(cleanup).not.toHaveBeenCalledWith(id);
    expect((await other.status()).runners[0]?.busy).toBe(true);
    await reservation.release();
    expect((await other.status()).runners[0]?.busy).toBe(false);
  });
  it("recovers a persisted setup reservation after restart only after stopping and cleaning its browser", async () => {
    const f = fixture();
    await f.ready();
    const sequence: string[] = [];
    f.mock.stopJob.mockImplementation(async () => {
      sequence.push("stop");
    });
    f.options.docker.cleanupEnvironment = async () => {
      sequence.push("cleanup");
    };
    await f.engine.reserveSetupWorker(
      "demo",
      "job-setup-11111111-1111-4111-8111-111111111111",
    );
    // Simulate a persisted reservation with no live owner in this process.
    const saved = JSON.parse(readFileSync(f.stateFile, "utf8"));
    for (const reservation of Object.values(saved.setupReservations) as Array<{
      ownerId?: string;
    }>)
      reservation.ownerId = randomUUID();
    writeFileSync(f.stateFile, JSON.stringify(saved));
    const restarted = createLocalRunners({
      ...f.options,
      releaseJobResources: async (id) => {
        if (id === "job-setup-11111111-1111-4111-8111-111111111111")
          sequence.push("release identity");
      },
    });
    await restarted.tick();
    expect(sequence.slice(0, 3)).toEqual([
      "stop",
      "cleanup",
      "release identity",
    ]);
    expect((await restarted.status()).runners[0]?.busy).toBe(false);
    expect(
      JSON.parse(readFileSync(f.stateFile, "utf8")).setupReservations,
    ).toEqual({});
  });
  it("persists validated account bindings across controller restart and rejects arbitrary binding fields", async () => {
    const f = fixture();
    const linearBinding = {
      connectionId: "client-one",
      workspaceId: "workspace-one",
      ticketId: "issue-one",
    };
    const queued = await f.engine.enqueue({
      type: "developer",
      project: "my-app",
      ticket: "ENG-123",
      linearBinding,
    });
    await f.engine.stop();
    const restarted = createLocalRunners(f.options);
    expect((await restarted.job(queued.id))?.linearBinding).toEqual(
      linearBinding,
    );
    await expect(
      restarted.enqueue({
        type: "developer",
        project: "my-app",
        ticket: "ENG-123",
        linearBinding: { ...linearBinding, token: "must-not-store" },
      } as LocalJobInput),
    ).rejects.toThrow(/valid local job/);
    expect(readFileSync(f.stateFile, "utf8")).not.toContain("must-not-store");
    await restarted.stop();
  });
  it("defers credential refresh contention without consuming retries or starting an agent", async () => {
    const f = fixture();
    await f.ready();
    const releaseJobResources = vi.fn(async () => {});
    const engine = createLocalRunners({
      ...f.options,
      releaseJobResources,
      prepareJob: async () => {
        throw new LocalJobDeferredError();
      },
    });
    const job = await engine.enqueue({
      type: "pm",
      project: "my-app",
      area: "core",
    });
    const starts = f.mock.startJob.mock.calls.length;
    await engine.tick();
    await engine.tick();
    expect(await engine.job(job.id)).toMatchObject({
      status: "queued",
      retries: 0,
    });
    expect((await engine.job(job.id))?.startedAt).toBeUndefined();
    expect((await engine.job(job.id))?.message).toContain("before refreshing");
    expect(f.mock.startJob).toHaveBeenCalledTimes(starts);
    expect(f.options.notify).not.toHaveBeenCalled();
    expect(releaseJobResources).toHaveBeenCalledWith(job.id);
    await engine.stop();
  });

  it("holds source leases until the container exits and retries terminal cleanup after a restart", async () => {
    const f = fixture();
    await f.ready();
    const releaseJobResources = vi.fn(async (_id: string) => {});
    const engine = createLocalRunners({ ...f.options, releaseJobResources });
    const job = await engine.enqueue({
      type: "developer",
      project: "my-app",
      ticket: "APP-17",
    });
    await engine.tick();
    await engine.tick();
    expect(releaseJobResources.mock.calls.some(([id]) => id === job.id)).toBe(
      false,
    );
    await engine.stop();
    expect(releaseJobResources.mock.calls.some(([id]) => id === job.id)).toBe(
      false,
    );
    f.finish(job.id);
    const restarted = createLocalRunners({ ...f.options, releaseJobResources });
    await restarted.tick();
    expect(
      releaseJobResources.mock.calls.filter(([id]) => id === job.id),
    ).toHaveLength(1);
    await restarted.tick();
    expect(
      releaseJobResources.mock.calls.filter(([id]) => id === job.id),
    ).toHaveLength(1);
    await restarted.stop();
  });

  it("does not release a lease while Docker cannot establish whether a job launched", async () => {
    const f = fixture();
    await f.ready();
    const releaseJobResources = vi.fn(async (_id: string) => {});
    const engine = createLocalRunners({ ...f.options, releaseJobResources });
    const job = await engine.enqueue({
      type: "pm",
      project: "my-app",
      area: "core",
    });
    f.mock.startJob.mockRejectedValueOnce(new Error("ambiguous"));
    f.mock.inspectJob.mockRejectedValueOnce(new Error("unavailable"));
    await engine.tick();
    expect((await engine.job(job.id))?.status).toBe("running");
    expect(releaseJobResources.mock.calls.some(([id]) => id === job.id)).toBe(
      false,
    );
    await engine.stop();
  });

  it("releases a lease after an ambiguous launch disappears without repeating potentially published work", async () => {
    const f = fixture();
    await f.ready();
    const events: string[] = [];
    let id = "";
    const releaseJobResources = async (jobId: string) => {
      if (jobId === id) events.push("release");
    };
    const prepareJob = async (): Promise<DockerJobPayload> => {
      events.push("acquire");
      return { kind: "pm" };
    };
    const engine = createLocalRunners({
      ...f.options,
      prepareJob,
      releaseJobResources,
    });
    id = (await engine.enqueue({ type: "pm", project: "my-app", area: "core" }))
      .id;
    f.mock.startJob.mockRejectedValueOnce(new Error("connection lost"));
    f.mock.inspectJob.mockRejectedValueOnce(new Error("unavailable"));
    await engine.tick();
    expect(events).toEqual(["acquire"]);
    const restarted = createLocalRunners({
      ...f.options,
      prepareJob,
      releaseJobResources,
    });
    await restarted.tick();
    expect(events).toEqual(["acquire", "release"]);
    expect(await restarted.job(id)).toMatchObject({
      status: "failed",
      retries: 0,
      failure: { category: "ambiguous-launch", retryable: false },
    });
    await engine.stop();
    await restarted.stop();
  });

  it("releases a prepared credential when the controller stops before launch", async () => {
    const f = fixture();
    await f.ready();
    let finishPreparation!: (payload: DockerJobPayload) => void;
    const prepareJob = vi.fn(
      () =>
        new Promise<DockerJobPayload>((resolve) => {
          finishPreparation = resolve;
        }),
    );
    const releaseJobResources = vi.fn(async (_id: string) => {});
    const engine = createLocalRunners({
      ...f.options,
      prepareJob,
      releaseJobResources,
    });
    const job = await engine.enqueue({
      type: "pm",
      project: "my-app",
      area: "core",
    });
    const tick = engine.tick();
    await vi.waitFor(() => expect(prepareJob).toHaveBeenCalledOnce());
    const stop = engine.stop();
    finishPreparation({
      kind: "pm",
      credentials: { GITHUB_TOKEN: "leased-token" },
    });
    await Promise.all([tick, stop]);
    expect((await engine.job(job.id))?.status).toBe("queued");
    expect(releaseJobResources).toHaveBeenCalledWith(job.id);
    expect(f.calls.some((call) => call.id === job.id)).toBe(false);
  });

  it("claims notifications before delivery and never repeats them after restart", async () => {
    const f = fixture();
    await f.ready();
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const observed: JobNotificationEvent[] = [];
    const notify = vi.fn(async (event: JobNotificationEvent) => {
      const file = join(
        f.root,
        ".run",
        "local-runners",
        "notifications",
        `${event.job.id}-${event.type}.json`,
      );
      expect(JSON.parse(readFileSync(file, "utf8")).status).toBe("attempted");
      observed.push(event);
      if (event.type === "started") await waiting;
      return { status: "sent" as const };
    });
    const engine = createLocalRunners({ ...f.options, notify });
    const job = await engine.enqueue({
      type: "pm",
      project: "my-app",
      area: "security",
    });
    await engine.tick(); // A stalled Slack request must not hold up Docker launch.
    expect((await engine.job(job.id))?.status).toBe("running");
    expect(notify).toHaveBeenCalledOnce();
    const restarted = createLocalRunners({ ...f.options, notify });
    await restarted.tick();
    expect(notify).toHaveBeenCalledOnce();
    f.finish(job.id);
    await restarted.tick();
    await vi.waitFor(() =>
      expect(observed.map((event) => event.type)).toEqual([
        "started",
        "succeeded",
      ]),
    );
    await restarted.tick();
    expect(notify).toHaveBeenCalledTimes(2);
    release();
    await engine.stop();
    await restarted.stop();
    expect(JSON.stringify(observed)).not.toContain(
      "never-store-this-credential",
    );
    expect(f.options.notify).not.toHaveBeenCalled(); // Browser verification stays quiet.
  });

  it("keeps Slack failures visible and durable without failing or retrying agent work", async () => {
    const f = fixture();
    await f.ready();
    const notify = vi.fn(async () => {
      throw new Error("secret webhook should not appear");
    });
    const engine = createLocalRunners({ ...f.options, notify });
    const job = await engine.enqueue({
      type: "developer",
      project: "my-app",
      ticket: "APP-4",
    });
    await engine.tick();
    f.finish(job.id);
    await engine.tick();
    await engine.stop();
    expect((await engine.job(job.id))?.status).toBe("succeeded");
    const restarted = createLocalRunners({ ...f.options, notify });
    await restarted.tick();
    expect(notify).toHaveBeenCalledTimes(2);
    const logs = await restarted.logs(job.id);
    expect(logs.join("\n")).toContain(
      "[Slack] The succeeded notification could not be delivered",
    );
    expect(logs.join("\n")).not.toContain("secret webhook");
    expect(readFileSync(f.stateFile, "utf8")).not.toContain("secret webhook");
    await restarted.stop();
  });

  it("reports a preparation blocker once without sending a false started event", async () => {
    const f = fixture();
    await f.ready();
    const notify = vi.fn(async (_event: JobNotificationEvent) => ({
      status: "sent" as const,
    }));
    const engine = createLocalRunners({
      ...f.options,
      prepareJob: async () => {
        throw new Error("private");
      },
      notify,
    });
    const job = await engine.enqueue({
      type: "pm",
      project: "my-app",
      area: "core",
    });
    await engine.tick();
    await engine.stop();
    expect((await engine.job(job.id))?.status).toBe("failed");
    expect(notify.mock.calls.map(([event]) => event.type)).toEqual(["failed"]);
  });

  it("runs the storage prerequisite for browser verification and honors stop while it is preparing", async () => {
    const f = fixture();
    let release!: () => void;
    const beforeLaunch = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const engine = createLocalRunners({ ...f.options, beforeLaunch });
    await engine.create();
    const tick = engine.tick();
    await vi.waitFor(() => expect(beforeLaunch).toHaveBeenCalledOnce());
    const stop = engine.stop();
    release();
    await Promise.all([tick, stop]);
    expect(f.mock.startJob).not.toHaveBeenCalled();
    expect((await engine.status()).jobs[0]!.status).toBe("queued");
  });

  it("captures durable run transitions without letting database failures change job outcome", async () => {
    const f = fixture();
    await f.ready();
    const captureRun = vi.fn(async () => {
      throw new Error("database password should not appear");
    });
    const store = {
      recordRun: vi.fn(async () => {}),
      captureRun,
    } as unknown as ActivityStore;
    const engine = createLocalRunners({ ...f.options, activityStore: store });
    const job = await engine.enqueue({
      type: "pm",
      project: "my-app",
      area: "security",
    });
    await engine.tick();
    f.finish(job.id);
    await engine.tick();
    await engine.stop();
    expect((await engine.job(job.id))?.status).toBe("succeeded");
    expect(captureRun).toHaveBeenCalledWith(
      expect.objectContaining({ id: job.id, status: "succeeded" }),
      f.options.docker,
    );
    const logs = (await engine.logs(job.id)).join("\n");
    expect(logs).toContain("Activity storage is unavailable");
    expect(logs).not.toContain("database password");
  });

  it("serves retained job logs and evidence when the Docker container is gone", async () => {
    const f = fixture();
    await f.ready();
    const job = await f.engine.enqueue({
      type: "pm",
      project: "my-app",
      area: "core",
    });
    await f.engine.tick();
    f.finish(job.id);
    await f.engine.tick();
    const store = {
      logs: vi.fn(async () => ["Retained activity"]),
      artifacts: vi.fn(async () => [
        { name: "screenshot.png", size: PNG.length },
      ]),
      readArtifact: vi.fn(async () => PNG),
    } as unknown as ActivityStore;
    const engine = createLocalRunners({ ...f.options, activityStore: store });
    f.mock.logs.mockRejectedValue(new Error("missing"));
    f.mock.artifacts.mockRejectedValue(new Error("missing"));
    f.mock.readArtifact.mockRejectedValue(new Error("missing"));
    expect(await engine.logs(job.id)).toEqual(["Retained activity"]);
    expect(await engine.artifacts(job.id)).toEqual([
      { name: "screenshot.png", size: PNG.length },
    ]);
    expect(await engine.readArtifact(job.id, "screenshot.png")).toEqual(PNG);
  });

  it("keeps running-job logs public and skips artifact storage until output is finalized", async () => {
    const f = fixture();
    const job = await f.engine.enqueue({
      type: "pm",
      project: "my-app",
      area: "core",
    });
    const artifacts = vi.fn(async () => {
      throw new Error("Storage must not be read for a running job");
    });
    const engine = createLocalRunners({
      ...f.options,
      activityStore: { artifacts } as unknown as ActivityStore,
    });
    f.mock.logs.mockResolvedValue(
      '{"type":"assistant","message":{"content":[{"type":"thinking","thinking":"hidden reasoning"}]}}\nPublic action\n',
    );
    expect(await engine.logs(job.id)).toEqual(["Public action", ""]);
    expect(await engine.artifacts(job.id)).toEqual([]);
    expect(artifacts).not.toHaveBeenCalled();
  });

  it("creates one capacity slot and only marks it ready after a real matching PNG proof", async () => {
    const f = fixture();
    expect(await f.engine.status()).toMatchObject({ runners: [], jobs: [] });
    const worker = await f.engine.create();
    expect(worker.status).toBe("provisioning");
    expect((await f.engine.status()).jobs).toEqual([
      expect.objectContaining({
        type: "verify",
        status: "queued",
        workerId: worker.id,
      }),
    ]);
    await f.engine.tick();
    expect(f.mock.ensureImage).toHaveBeenCalledOnce();
    const check = f.calls[0]!;
    expect(check.payload).toEqual({ kind: "verify", nonce: check.id });
    expect((await f.engine.status()).runners[0]?.verifiedAt).toBeUndefined();
    f.finish(check.id);
    await f.engine.tick();
    expect((await f.engine.status()).runners[0]).toMatchObject({
      status: "ready",
      busy: false,
      verifiedAt: expect.any(String),
    });
    expect((await f.engine.job(check.id))?.status).toBe("succeeded");
    expect(readFileSync(join(f.root, ".env"), "utf8")).toBe(
      "GITHUB_TOKEN=keep-this-private\n",
    );
    expect(readFileSync(join(f.root, "hub.json"), "utf8")).toBe(
      '{"hubRepo":"example/keep"}\r\n',
    );
    if (process.platform !== "win32")
      expect(statSync(f.stateFile).mode & 0o777).toBe(0o600);
  });

  it.each(["nonce", "missing screenshot", "bad PNG", "hash"])(
    "rejects a successful exit without trustworthy screenshot evidence: %s",
    async (failure) => {
      const f = fixture();
      await f.engine.create();
      await f.engine.tick();
      const job = f.calls[0]!;
      f.finish(job.id);
      const artifacts = await f.mock.artifacts(job.id);
      if (failure === "nonce") artifacts.result.nonce = "a-different-job";
      if (failure === "missing screenshot") artifacts.files = [];
      if (failure === "hash") artifacts.files[0]!.sha256 = "a".repeat(64);
      if (failure === "bad PNG")
        f.mock.readArtifact.mockResolvedValue(Buffer.from("not a PNG"));
      f.mock.artifacts.mockResolvedValue(artifacts);
      await f.engine.tick();
      expect((await f.engine.job(job.id))?.status).toBe("failed");
      expect((await f.engine.status()).runners[0]).toMatchObject({
        status: "error",
        busy: false,
      });
      expect((await f.engine.status()).runners[0]?.verifiedAt).toBeUndefined();
    },
  );

  it("queues idempotently, runs at most one job per worker, and never writes payloads or credentials into state", async () => {
    const f = fixture();
    await f.ready();
    const input: LocalJobInput = {
      type: "pm",
      project: "demo",
      area: "core",
      idempotencyKey: "pm:demo:core:slot-1",
    };
    const first = await f.engine.enqueue(input);
    expect(await f.engine.enqueue(input)).toEqual(first);
    await expect(
      f.engine.enqueue({ ...input, area: "security" }),
    ).rejects.toMatchObject({ status: 409 });
    const second = await f.engine.enqueue({
      ...input,
      area: "security",
      idempotencyKey: "pm:demo:core:slot-2",
    });
    await Promise.all([f.engine.tick(), f.engine.tick(), f.engine.tick()]);
    expect(f.calls.filter((call) => call.payload.kind === "pm")).toHaveLength(
      1,
    );
    expect((await f.engine.job(first.id))?.status).toBe("running");
    expect((await f.engine.job(second.id))?.status).toBe("queued");
    expect(readFileSync(f.stateFile, "utf8")).not.toMatch(
      /never-store|Private generated|GITHUB_TOKEN|credentials|prompt/,
    );
    f.finish(first.id);
    await f.engine.tick();
    expect((await f.engine.job(first.runId))?.status).toBe("succeeded");
    expect((await f.engine.job(second.id))?.status).toBe("running");
  });

  it("reconciles a running Docker job after controller restart without launching it twice", async () => {
    const f = fixture();
    await f.ready();
    const job = await f.engine.enqueue({
      type: "developer",
      project: "demo",
      ticket: "DEV-42",
      attempt: 1,
      developerKind: "build",
      idempotencyKey: "developer:DEV-42:1",
    });
    await f.engine.tick();
    const count = f.calls.length;
    const restarted = createLocalRunners(f.options);
    await restarted.tick();
    expect(f.calls).toHaveLength(count);
    expect((await restarted.job(job.id))?.status).toBe("running");
    f.finish(job.id);
    await restarted.tick();
    expect((await restarted.job(job.id))?.status).toBe("succeeded");
    expect(f.calls).toHaveLength(count);
  });

  it.each([
    { type: "pm", project: "demo", area: "core" },
    { type: "developer", project: "demo", ticket: "DEV-17" },
  ] as LocalJobInput[])(
    "rejects duplicate manual queued and running work: %o",
    async (input) => {
      const f = fixture();
      await f.ready();
      const job = await f.engine.enqueue(input);
      await expect(
        f.engine.enqueue({ ...input, idempotencyKey: "different-slot" }),
      ).rejects.toMatchObject({ status: 409 });
      await expect(f.engine.enqueue(input)).rejects.toMatchObject({
        status: 409,
      });
      await f.engine.tick();
      await expect(f.engine.enqueue(input)).rejects.toMatchObject({
        status: 409,
      });
      f.finish(job.id);
      await f.engine.tick();
      expect((await f.engine.enqueue(input)).id).not.toBe(job.id);
    },
  );

  it("does not repeat an agent job whose previously confirmed container disappeared", async () => {
    const f = fixture();
    await f.ready();
    const job = await f.engine.enqueue({
      type: "developer",
      project: "demo",
      ticket: "DEV-1",
      idempotencyKey: "DEV-1:1",
    });
    await f.engine.tick();
    const count = f.calls.length;
    f.containers.delete(job.id);
    const restarted = createLocalRunners(f.options);
    await restarted.tick();
    expect((await restarted.job(job.id))?.status).toBe("failed");
    expect(f.calls).toHaveLength(count);
  });

  it("reconciles the crash window between container creation and saving launch confirmation", async () => {
    const f = fixture();
    await f.engine.create();
    await f.engine.tick();
    const job = f.calls[0]!;
    const state = JSON.parse(readFileSync(f.stateFile, "utf8"));
    state.launched[job.id] = false;
    writeFileSync(f.stateFile, JSON.stringify(state));
    await createLocalRunners(f.options).tick();
    expect(f.calls).toHaveLength(1);
    expect(JSON.parse(readFileSync(f.stateFile, "utf8")).launched[job.id]).toBe(
      true,
    );
  });

  it("does not repeat an uncertain Docker launch even if its container is missing", async () => {
    const f = fixture();
    f.mock.startJob.mockRejectedValue(
      new Error("private error never print token=secret"),
    );
    await f.engine.create();
    await f.engine.tick();
    const job = (await f.engine.status()).jobs[0]!;
    expect(job).toMatchObject({ status: "failed", retries: 0 });
    await f.engine.tick();
    expect((await f.engine.job(job.id))?.status).toBe("failed");
    await f.engine.tick();
    expect(f.mock.startJob).toHaveBeenCalledTimes(1);
    expect(readFileSync(f.stateFile, "utf8")).not.toContain("private error");
  });

  it("does not automatically retry a nonzero AI exit", async () => {
    const f = fixture();
    await f.ready();
    const job = await f.engine.enqueue({
      type: "developer",
      project: "demo",
      ticket: "DEV-2",
    });
    await f.engine.tick();
    const count = f.calls.length;
    f.finish(job.id, 1);
    await f.engine.tick();
    await f.engine.tick();
    expect(await f.engine.job(job.id)).toMatchObject({
      status: "failed",
      exitCode: 1,
    });
    expect(f.calls).toHaveLength(count);
  });

  it("pauses new work while allowing current jobs to finish and refuses busy removal", async () => {
    const f = fixture();
    const worker = await f.ready();
    const first = await f.engine.enqueue({
      type: "pm",
      project: "demo",
      area: "core",
    });
    const second = await f.engine.enqueue({
      type: "pm",
      project: "demo",
      area: "security",
    });
    await f.engine.tick();
    await f.engine.action(worker.id, "pause");
    await expect(f.engine.action(worker.id, "remove")).rejects.toMatchObject({
      status: 409,
    });
    f.finish(first.id);
    await f.engine.tick();
    expect((await f.engine.status()).runners[0]).toMatchObject({
      status: "paused",
      busy: false,
      paused: true,
    });
    expect((await f.engine.job(second.id))?.status).toBe("queued");
    await f.engine.action(worker.id, "resume");
    await f.engine.tick();
    expect((await f.engine.job(second.id))?.status).toBe("running");
  });

  it("repairs by verifying again and removes only idle capacity while preserving logs and artifacts", async () => {
    const f = fixture();
    const worker = await f.ready();
    const firstCheck = f.calls[0]!;
    await f.engine.action(worker.id, "repair");
    expect((await f.engine.status()).runners[0]?.verifiedAt).toBeUndefined();
    await f.engine.tick();
    const nextCheck = f.calls[1]!;
    expect(nextCheck.id).not.toBe(firstCheck.id);
    expect(f.mock.ensureImage).toHaveBeenCalledTimes(2);
    f.finish(nextCheck.id);
    await f.engine.tick();
    await f.engine.action(worker.id, "remove");
    expect((await f.engine.status()).runners).toEqual([]);
    expect(await f.engine.logs(firstCheck.id)).toContain("TOKEN=[redacted]");
    expect((await f.engine.artifacts(firstCheck.id))[0]?.name).toBe(
      "screenshot.png",
    );
    expect(
      await f.engine.readArtifact(firstCheck.id, "screenshot.png"),
    ).toEqual(PNG);
    expect(f.mock.removeJob).not.toHaveBeenCalled();
  });

  it("bounds capacity and does not launch PMs on unverified workers", async () => {
    const f = fixture();
    for (let count = 0; count < 4; count++) await f.engine.create();
    await expect(f.engine.create()).rejects.toMatchObject({ status: 409 });
    const pm = await f.engine.enqueue({
      type: "pm",
      project: "demo",
      area: "core",
    });
    await f.engine.tick();
    expect(f.calls).toHaveLength(4);
    expect(f.calls.every((call) => call.payload.kind === "verify")).toBe(true);
    expect((await f.engine.job(pm.id))?.status).toBe("queued");
  });

  it("runs scheduling once per minute and deduplicates after controller restart", async () => {
    const f = fixture();
    const input: LocalJobInput = {
      type: "pm",
      project: "demo",
      area: "core",
      idempotencyKey: "pm:demo:core:slot",
    };
    const scheduledJobs = vi.fn(async () => [input]);
    const engine = createLocalRunners({ ...f.options, scheduledJobs });
    await engine.tick();
    await engine.tick();
    expect(scheduledJobs).toHaveBeenCalledOnce();
    f.advance(60_000);
    await engine.tick();
    expect(scheduledJobs).toHaveBeenCalledTimes(2);
    await createLocalRunners({ ...f.options, scheduledJobs }).tick();
    expect(await engine.jobs()).toHaveLength(1);
  });

  it("holds a cross-process lock so a second controller cannot start the same work", async () => {
    const f = fixture();
    await f.engine.create();
    let release!: () => void;
    let announce!: () => void;
    const waiting = new Promise<void>((done) => {
      release = done;
    });
    const started = new Promise<void>((done) => {
      announce = done;
    });
    f.mock.ensureImage.mockImplementation(async () => {
      announce();
      await waiting;
    });
    const tick = f.engine.tick();
    await started;
    await expect(createLocalRunners(f.options).tick()).rejects.toMatchObject({
      status: 409,
    });
    release();
    await tick;
    expect(f.calls).toHaveLength(1);
  });

  it("recovers an abandoned controller lock and refuses corrupt state without erasing it", async () => {
    const f = fixture();
    await f.engine.create();
    const directory = join(f.root, ".run", "local-runners");
    writeFileSync(
      join(directory, "state.lock"),
      JSON.stringify({ pid: 2147483647, owner: "old" }),
    );
    await f.engine.tick();
    expect(
      readdirSync(directory).some((file) =>
        file.startsWith("state.lock.abandoned-"),
      ),
    ).toBe(true);
    const corrupt = '{"schema":1,"runners":"token-do-not-print"}';
    writeFileSync(f.stateFile, corrupt);
    await expect(f.engine.status()).rejects.toThrow(
      "Keep state.json for recovery",
    );
    await expect(f.engine.create()).rejects.toBeInstanceOf(LocalRunnerError);
    expect(readFileSync(f.stateFile, "utf8")).toBe(corrupt);
  });

  it.each(["empty", "partial"])(
    "releases only its newly created %s lock after ENOSPC so a recovered disk can run again",
    async (contents) => {
      const f = fixture();
      const file = join(f.root, ".run", "local-runners", "state.lock");
      lockWriteFault.once = (fd) => {
        if (contents === "partial") writeFileSync(fd, '{"pid":');
        throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
      };
      await expect(f.engine.create()).rejects.toMatchObject({ code: "ENOSPC" });
      expect(existsSync(file)).toBe(false);
      expect(existsSync(f.stateFile)).toBe(false);
      expect(f.calls).toHaveLength(0);
      await f.engine.create();
      await f.engine.tick();
      expect(f.calls).toHaveLength(1);
    },
  );

  it("preserves a different controller's replacement lock when initializing its own lock fails", async () => {
    const f = fixture();
    const file = join(f.root, ".run", "local-runners", "state.lock");
    const replacement = JSON.stringify({
      pid: process.pid,
      owner: "other-controller",
    });
    lockWriteFault.once = () => {
      renameSync(file, `${file}.original`);
      writeFileSync(file, replacement);
      throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
    };
    await expect(f.engine.create()).rejects.toMatchObject({ code: "ENOSPC" });
    expect(readFileSync(file, "utf8")).toBe(replacement);
    expect(existsSync(`${file}.original`)).toBe(true);
    await expect(f.engine.create()).rejects.toMatchObject({ status: 409 });
    expect(readFileSync(file, "utf8")).toBe(replacement);
  });

  it.each(["", '{"pid":'])(
    "preserves an existing malformed lock %j for operator recovery",
    async (contents) => {
      const f = fixture();
      const directory = join(f.root, ".run", "local-runners");
      mkdirSync(directory, { recursive: true });
      const file = join(directory, "state.lock");
      writeFileSync(file, contents);
      await expect(f.engine.create()).rejects.toMatchObject({ status: 409 });
      expect(readFileSync(file, "utf8")).toBe(contents);
      expect(readdirSync(directory)).toEqual(["state.lock"]);
    },
  );

  it("rejects unknown queue fields and unsafe paths before preparing or launching anything", async () => {
    const f = fixture();
    for (const input of [
      { type: "pm", project: "../demo", area: "core" },
      {
        type: "developer",
        project: "demo",
        ticket: "DEV-1",
        branch: "../../other",
      },
      {
        type: "pm",
        project: "demo",
        area: "core",
        credentials: { TOKEN: "secret" },
      },
      { type: "verify" },
      null,
    ])
      await expect(
        f.engine.enqueue(input as unknown as LocalJobInput),
      ).rejects.toMatchObject({ status: 400 });
    await expect(f.engine.logs("../other")).rejects.toThrow("valid local job");
    expect(f.options.prepareJob).not.toHaveBeenCalled();
    expect(f.calls).toEqual([]);
  });

  it("refuses storage junctions without touching their target", async () => {
    const f = fixture();
    const external = join(f.root, "external");
    mkdirSync(external);
    symlinkSync(external, join(f.root, ".run"), "junction");
    await expect(f.engine.create()).rejects.toBeInstanceOf(LocalRunnerError);
    expect(readdirSync(external)).toEqual([]);
  });

  // This durability stress case flushes 502 real usage records in addition to
  // history/notification files. Allow slower Windows CI disks to finish those
  // writes; bounded capture/admission behavior has separate regression coverage.
  it("archives older terminal metadata without losing job history or retry-key deduplication", async () => {
    const f = fixture();
    const first = await f.engine.enqueue({
      type: "pm",
      project: "demo",
      area: "core",
      idempotencyKey: "keep-this-slot",
    });
    const state = JSON.parse(readFileSync(f.stateFile, "utf8"));
    state.jobs[0].status = "succeeded";
    state.jobs[0].finishedAt = f.options.clock().toISOString();
    // Seed valid completed metadata rather than launch hundreds of containers.
    for (let index = 0; index < 501; index++) {
      state.jobs.push({
        ...state.jobs[0],
        id: `job-${randomUUID()}`,
        runId: index + 2,
        idempotencyKey: `slot-${index}`,
      });
    }
    state.nextRunId = 503;
    // These are historical completions, including their already attempted
    // notifications. Omitting the claims would exercise 500 fsynced Slack
    // recovery attempts rather than the archive/deduplication behavior here.
    const notifications = join(
      f.root,
      ".run",
      "local-runners",
      "notifications",
    );
    mkdirSync(notifications, { recursive: true });
    for (const job of state.jobs)
      writeFileSync(
        join(notifications, `${job.id}-succeeded.json`),
        JSON.stringify({
          schema: 1,
          type: "succeeded",
          status: "skipped",
          attemptedAt: job.finishedAt,
          finishedAt: job.finishedAt,
        }),
      );
    writeFileSync(f.stateFile, JSON.stringify(state));
    const result = await f.engine.enqueue({
      type: "pm",
      project: "demo",
      area: "core",
      idempotencyKey: "keep-this-slot",
    });
    expect(result.id).toBe(first.id);
    const restarted = createLocalRunners(f.options);
    expect((await restarted.job(first.id))?.status).toBe("succeeded");
    expect(await restarted.jobs()).toHaveLength(502);
    expect(
      (
        await restarted.enqueue({
          type: "pm",
          project: "demo",
          area: "core",
          idempotencyKey: "keep-this-slot",
        })
      ).id,
    ).toBe(first.id);
    expect(f.options.notify).not.toHaveBeenCalled();
    expect(f.mock.artifacts).not.toHaveBeenCalled();
    // Usage persistence runs in a yielding background queue; admission itself
    // must not wait for hundreds of historical metadata fsyncs.
    await f.engine.stop();
    await restarted.stop();
    // Eviction retains unavailable coverage durably without reading old Docker output.
    expect(
      createUsage({ root: f.root, now: f.options.clock }).summary({
        range: "all",
      }).coverage.unavailableRuns,
    ).toBe(502);
    expect(JSON.parse(readFileSync(f.stateFile, "utf8")).jobs.length).toBe(500);
    expect(
      readdirSync(join(f.root, ".run", "local-runners", "history")),
    ).toHaveLength(2);
    expect(
      existsSync(
        join(f.root, ".run", "local-runners", "history", `${first.id}.json`),
      ),
    ).toBe(true);
  }, 60_000);

  it("stops controller polling without stopping any running job container", async () => {
    const f = fixture();
    vi.useFakeTimers();
    f.engine.start();
    await f.engine.stop();
    expect(f.mock.removeJob).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["image", "preparation"])(
    "stops before launch when requested during %s and keeps the job queued",
    async (stage) => {
      const f = fixture();
      let jobId: string;
      let release!: () => void;
      let announce!: () => void;
      const pending = new Promise<void>((done) => {
        release = done;
      });
      const entered = new Promise<void>((done) => {
        announce = done;
      });
      if (stage === "image") {
        await f.engine.create();
        jobId = (await f.engine.status()).jobs[0]!.id;
        f.mock.ensureImage.mockImplementation(async () => {
          announce();
          await pending;
        });
      } else {
        await f.ready();
        jobId = (
          await f.engine.enqueue({ type: "pm", project: "demo", area: "core" })
        ).id;
        f.options.prepareJob.mockImplementation(async (job) => {
          announce();
          await pending;
          return { kind: job.type } as DockerJobPayload;
        });
      }
      const count = f.calls.length;
      const tick = f.engine.tick();
      await entered;
      const stop = f.engine.stop();
      release();
      await Promise.all([tick, stop]);
      expect(f.calls).toHaveLength(count);
      expect(await f.engine.job(jobId)).toMatchObject({
        status: "queued",
        retries: 0,
      });
      expect((await f.engine.status()).runners[0]?.busy).toBe(false);
      const restarted = createLocalRunners(f.options);
      await restarted.tick();
      expect((await restarted.job(jobId))?.status).toBe("running");
    },
  );

  it("skips an already-active scheduled PM but continues scheduling other areas", async () => {
    const f = fixture();
    await f.engine.enqueue({ type: "pm", project: "demo", area: "core" });
    const scheduledJobs = async (): Promise<LocalJobInput[]> => [
      {
        type: "pm",
        project: "demo",
        area: "core",
        idempotencyKey: "scheduled:core",
      },
      {
        type: "pm",
        project: "demo",
        area: "security",
        idempotencyKey: "scheduled:security",
      },
    ];
    const engine = createLocalRunners({ ...f.options, scheduledJobs });
    await engine.tick();
    expect(await engine.jobs()).toHaveLength(2);
    expect((await engine.status()).operation.phase).toBe("idle");
  });
});
