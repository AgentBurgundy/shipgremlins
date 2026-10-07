import { afterEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeForge } from "../forge/fake.ts";
import { makeProject, TEST_REPO } from "../services/fakes.ts";
import { projectRuntimeKey } from "../projectIdentity.ts";
import type { LocalJob, LocalJobInput } from "../localRunners/types.ts";
import type { ReviewDeployment } from "./types.ts";
import { createStagingSync, stagingSyncScope } from "./stagingSync.ts";

const STAGING = "a".repeat(40),
  INTEGRATION = "b".repeat(40),
  MERGED = "c".repeat(40),
  REPAIRED = "d".repeat(40),
  MOVED = "e".repeat(40),
  PRODUCTION = "f".repeat(40);
const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function world() {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "gremlins-staging-sync-")),
  );
  roots.push(root);
  const project = makeProject({
    config: {
      instanceId: randomUUID(),
      workflow: { kind: "promotion" },
      verification: { mode: "browser", environment: "integration" },
      environments: {
        integration: {
          kind: "url",
          role: "preview",
          url: "https://preview.example.test",
        },
      },
    },
  });
  const currentProject = structuredClone(project);
  let clock = new Date("2026-10-06T12:00:00Z");
  const forge = new FakeForge();
  forge.seedBranch(TEST_REPO, "staging", STAGING);
  forge.seedBranch(TEST_REPO, "pm-staging", INTEGRATION);
  forge.seedBranch(TEST_REPO, "main", PRODUCTION);
  const comparisons = new Map<string, { aheadBy: number; behindBy: number }>();
  const compare = (
    base: string,
    head: string,
    aheadBy: number,
    behindBy = 0,
  ) => {
    comparisons.set(`${base}:${head}`, { aheadBy, behindBy });
    forge.seedCompare(TEST_REPO, base, head, { aheadBy, behindBy });
  };
  // FakeForge defaults to 0/0. Fail closed unless every immutable ancestry
  // comparison made by this service was explicitly supplied by the fixture.
  vi.spyOn(forge, "compare").mockImplementation(async (repo, base, head) => {
    expect(repo).toBe(TEST_REPO);
    expect(base).toMatch(/^[a-f0-9]{40}$/);
    expect(head).toMatch(/^[a-f0-9]{40}$/);
    const found = comparisons.get(`${base}:${head}`);
    if (!found)
      throw new Error(`Unseeded immutable comparison ${base}:${head}`);
    return found;
  });
  compare(INTEGRATION, STAGING, 2, 1);
  compare(MERGED, STAGING, 0, 3);
  compare(REPAIRED, STAGING, 0, 2);
  compare(REPAIRED, INTEGRATION, 0, 2);
  forge.seedChecks(TEST_REPO, STAGING, { status: "success", failedJobs: [] });
  forge.seedChecks(TEST_REPO, REPAIRED, { status: "success", failedJobs: [] });
  const originalMerge = forge.mergePull.bind(forge);
  const merge = vi
    .spyOn(forge, "mergePull")
    .mockImplementation(async (repo, number, options) => {
      const result = await originalMerge(repo, number, options);
      if (!result.merged) return result;
      // The generic fake emits abbreviated SHAs. Real provider results are full.
      forge.seedBranch(repo, "pm-staging", MERGED);
      forge.patchPull(repo, number, { mergeCommitSha: MERGED });
      return { ...result, sha: MERGED };
    });
  const createPull = vi.spyOn(forge, "createPull");
  const createBranch = vi.spyOn(forge, "createBranch");
  // HTTP reads return snapshots, not mutable references to the provider fake.
  vi.spyOn(forge, "getPull").mockImplementation(async (...args) =>
    structuredClone(await FakeForge.prototype.getPull.apply(forge, args)),
  );
  vi.spyOn(forge, "listOpenPulls").mockImplementation(async (...args) =>
    structuredClone(await FakeForge.prototype.listOpenPulls.apply(forge, args)),
  );
  const checkMerge = vi.fn(async (_integration: string, _head: string) => true);
  const deployment = vi.fn(async (): Promise<ReviewDeployment> => ({
    id: "deployment-current",
    url: "https://preview.example.test",
    sha: MERGED,
    branch: "pm-staging",
    provider: "vercel",
    state: "READY",
  }));
  const jobs: LocalJob[] = [];
  const enqueue = vi.fn(async (input: LocalJobInput): Promise<LocalJob> => {
    const job: LocalJob = {
      ...input,
      id: `job-${randomUUID()}`,
      runId: jobs.length + 1,
      status: "queued",
      createdAt: clock.toISOString(),
    };
    jobs.push(job);
    return job;
  });
  const scope = stagingSyncScope(project);
  const snapshot = `gremlins/staging-sync-${scope.slice(0, 12)}-${STAGING}`;
  const directory = join(
    root,
    ".run",
    "delivery",
    projectRuntimeKey(project.config),
    "staging-sync",
  );
  const options = {
    root,
    project,
    currentProject: () => currentProject,
    forge: async () => forge,
    checkMerge,
    deployment,
    jobs: async () => jobs,
    enqueue,
    now: () => clock,
  };
  const restart = () => createStagingSync(options);
  const service = restart();
  const dirty = () =>
    forge.seedPull(TEST_REPO, {
      headRef: snapshot,
      headSha: STAGING,
      baseRef: "pm-staging",
      draft: false,
      mergeableState: "dirty",
    });
  const resolution = (job: LocalJob, patch = {}) =>
    forge.seedPull(TEST_REPO, {
      headRef: `gremlins/${job.id}`,
      headSha: REPAIRED,
      baseRef: "pm-staging",
      draft: true,
      ...patch,
    });
  return {
    root,
    project,
    forge,
    options,
    restart,
    service,
    compare,
    merge,
    createPull,
    createBranch,
    checkMerge,
    deployment,
    jobs,
    enqueue,
    snapshot,
    directory,
    dirty,
    resolution,
    change: (update: (p: typeof project) => void) => {
      update(currentProject);
    },
    clock: (date: string) => {
      clock = new Date(date);
    },
    state: () =>
      JSON.parse(readFileSync(join(directory, `${scope}.json`), "utf8")),
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("durable local staging synchronization", () => {
  it("merges an immutable snapshot with both histories, keeps staging, and uses no coding agent", async () => {
    const w = world();
    expect(await w.service.reconcile()).toMatchObject({
      phase: "current",
      stagingSha: STAGING,
      integrationSha: MERGED,
    });
    expect(w.createBranch).toHaveBeenCalledExactlyOnceWith(
      TEST_REPO,
      w.snapshot,
      STAGING,
    );
    expect(w.createPull).toHaveBeenCalledWith(
      TEST_REPO,
      expect.objectContaining({
        head: w.snapshot,
        base: "pm-staging",
        draft: false,
      }),
    );
    expect(w.checkMerge).toHaveBeenCalledExactlyOnceWith(INTEGRATION, STAGING);
    expect(w.merge).toHaveBeenCalledExactlyOnceWith(TEST_REPO, 1, {
      method: "merge",
      sha: STAGING,
    });
    expect(w.forge.branch(TEST_REPO, "staging")).toBe(STAGING);
    expect(w.forge.branch(TEST_REPO, "main")).toBe(PRODUCTION);
    expect(w.forge.deletedBranches).toEqual([]);
    expect(w.enqueue).not.toHaveBeenCalled();
    expect(w.forge.dispatched).toEqual([]);
    expect(w.restart().status()).toMatchObject({ phase: "current" });
  });

  it("requires promotion workflow and completed verification", async () => {
    const w = world();
    w.change((p) => {
      p.config.verified = null;
    });
    expect((await w.service.reconcile()).phase).toBe("disabled");
    w.change((p) => {
      p.config.verified = "2026-10-06";
      p.config.workflow = { kind: "pull-request", baseBranch: "main" };
    });
    expect((await w.service.reconcile()).phase).toBe("disabled");
    expect(w.createPull).not.toHaveBeenCalled();
  });

  it("does not create work when staging is already included or when only checking", async () => {
    const w = world();
    expect((await w.service.reconcile({ checkOnly: true })).phase).toBe(
      "checking",
    );
    w.compare(INTEGRATION, STAGING, 0, 2);
    w.deployment.mockResolvedValue({
      id: "dpl",
      url: "https://preview.example.test",
      provider: "vercel",
      branch: "pm-staging",
      sha: INTEGRATION,
      state: "READY",
    });
    expect((await w.service.reconcile()).phase).toBe("current");
    expect(w.createPull).not.toHaveBeenCalled();
    expect(w.checkMerge).not.toHaveBeenCalled();
    expect(w.enqueue).not.toHaveBeenCalled();
  });

  it.each(["failure", "pending"] as const)(
    "blocks a merge on %s provider checks",
    async (status) => {
      const w = world();
      w.forge.seedChecks(TEST_REPO, STAGING, { status, failedJobs: [] });
      expect((await w.service.reconcile()).phase).toBe(
        status === "failure" ? "blocked" : "waiting-checks",
      );
      expect(w.merge).not.toHaveBeenCalled();
      expect(w.checkMerge).not.toHaveBeenCalled();
      expect(w.enqueue).not.toHaveBeenCalled();
    },
  );

  it("blocks failed combined checks and bounds retry frequency without creating more PRs", async () => {
    const w = world();
    w.checkMerge.mockResolvedValue(false);
    expect((await w.service.reconcile()).phase).toBe("blocked");
    expect((await w.restart().reconcile()).phase).toBe("blocked");
    expect(w.checkMerge).toHaveBeenCalledOnce();
    w.clock("2026-10-06T12:06:00Z");
    w.checkMerge.mockResolvedValue(true);
    expect((await w.restart().reconcile()).phase).toBe("current");
    expect(w.checkMerge).toHaveBeenCalledTimes(2);
    expect(w.createPull).toHaveBeenCalledOnce();
  });

  it("waits for branch protections and never enables an override or auto-merge", async () => {
    const w = world();
    w.forge.seedPull(TEST_REPO, {
      headRef: w.snapshot,
      headSha: STAGING,
      baseRef: "pm-staging",
      draft: false,
      mergeableState: "blocked",
    });
    expect((await w.service.reconcile()).phase).toBe("waiting-merge");
    expect(w.merge).not.toHaveBeenCalled();
    expect(w.forge.autoMerged).toEqual([]);
    expect(w.enqueue).not.toHaveBeenCalled();
  });

  it.each(["old revision", "wrong branch", "not ready"])(
    "waits for the exact integration deployment: %s",
    async (kind) => {
      const w = world();
      w.deployment.mockResolvedValue({
        id: "dpl",
        url: "https://preview.example.test",
        provider: "vercel",
        sha: kind === "old revision" ? INTEGRATION : MERGED,
        branch: kind === "wrong branch" ? "staging" : "pm-staging",
        state: kind === "not ready" ? ("BUILDING" as "READY") : "READY",
      });
      expect((await w.service.reconcile()).phase).toBe("waiting-deployment");
      expect(w.merge).toHaveBeenCalledOnce();
      w.deployment.mockResolvedValue({
        id: "dpl",
        url: "https://preview.example.test",
        provider: "vercel",
        sha: MERGED,
        branch: "pm-staging",
        state: "READY",
      });
      expect((await w.restart().reconcile()).phase).toBe("current");
      expect(w.merge).toHaveBeenCalledOnce();
    },
  );

  it("keeps the cross-controller lock throughout awaited checks", async () => {
    const w = world(),
      wait = deferred<boolean>();
    w.checkMerge.mockReturnValue(wait.promise);
    const first = w.service.reconcile();
    await vi.waitFor(() => expect(w.checkMerge).toHaveBeenCalledOnce());
    expect(existsSync(join(w.directory, "operation.lock"))).toBe(true);
    const second = await w.restart().reconcile();
    expect(second).toMatchObject({
      phase: "checking",
      message: expect.stringContaining("Another staging sync"),
    });
    expect(w.createPull).toHaveBeenCalledOnce();
    expect(w.merge).not.toHaveBeenCalled();
    wait.resolve(true);
    expect((await first).phase).toBe("current");
    expect(w.merge).toHaveBeenCalledOnce();
    expect(existsSync(join(w.directory, "operation.lock"))).toBe(false);
  });

  it("holds the lock while waiting for deployment evidence too", async () => {
    const w = world(),
      wait = deferred<ReviewDeployment>();
    w.deployment.mockReturnValue(wait.promise);
    const first = w.service.reconcile();
    await vi.waitFor(() => expect(w.deployment).toHaveBeenCalledOnce());
    expect((await w.restart().reconcile()).phase).toBe("checking");
    expect(w.createPull).toHaveBeenCalledOnce();
    wait.resolve({
      id: "dpl",
      url: "https://preview.example.test",
      provider: "vercel",
      sha: MERGED,
      branch: "pm-staging",
      state: "READY",
    });
    expect((await first).phase).toBe("current");
    expect(w.merge).toHaveBeenCalledOnce();
  });

  it("adopts an existing sync PR after restart", async () => {
    const w = world();
    w.forge.seedChecks(TEST_REPO, STAGING, {
      status: "pending",
      failedJobs: [],
    });
    await w.service.reconcile();
    w.forge.seedChecks(TEST_REPO, STAGING, {
      status: "success",
      failedJobs: [],
    });
    expect((await w.restart().reconcile()).phase).toBe("current");
    expect(w.createPull).toHaveBeenCalledOnce();
    expect(w.createBranch).toHaveBeenCalledOnce();
  });

  it("recovers a lost PR-creation response without another PR", async () => {
    const w = world(),
      create = FakeForge.prototype.createPull.bind(w.forge);
    w.createPull.mockImplementationOnce(async (...args) => {
      await create(...args);
      throw new Error("private-provider-secret");
    });
    expect((await w.service.reconcile()).phase).toBe("blocked");
    expect((await w.restart().reconcile()).phase).toBe("current");
    expect(w.createPull).toHaveBeenCalledOnce();
  });

  it("never overwrites an externally changed snapshot branch", async () => {
    const w = world();
    w.forge.seedBranch(TEST_REPO, w.snapshot, MOVED);
    expect((await w.service.reconcile()).phase).toBe("blocked");
    expect(w.createBranch).not.toHaveBeenCalled();
    expect(w.createPull).not.toHaveBeenCalled();
    expect(w.forge.branch(TEST_REPO, w.snapshot)).toBe(MOVED);
  });

  it("limits each conflicting staging revision to two local coding attempts", async () => {
    const w = world();
    w.dirty();
    expect((await w.service.reconcile()).phase).toBe("repairing");
    await w.restart().reconcile();
    expect(w.enqueue).toHaveBeenCalledOnce();
    expect(w.jobs[0]).toMatchObject({
      type: "developer",
      developerKind: "sync",
      runOnce: true,
      branch: "pm-staging",
      ticket: `SYNC-${STAGING.slice(0, 12)}`,
      attempt: 1,
    });
    w.jobs[0]!.status = "failed";
    expect((await w.restart().reconcile()).phase).toBe("repairing");
    expect(w.jobs[1]!.attempt).toBe(2);
    w.jobs[1]!.status = "failed";
    expect(await w.restart().reconcile()).toMatchObject({
      phase: "blocked",
      message: expect.stringContaining("Two Coding Gremlin attempts"),
    });
    expect(w.enqueue).toHaveBeenCalledTimes(2);
    expect(w.forge.dispatched).toEqual([]);
    expect(w.state().repairs).toHaveLength(2);
  });

  it("does not queue conflict repairs in observation mode", async () => {
    const w = world();
    w.dirty();
    expect((await w.service.reconcile({ queueRepair: false })).phase).toBe(
      "repairing",
    );
    expect(w.enqueue).not.toHaveBeenCalled();
    expect(w.state().repairs).toEqual([]);
  });

  it("reconciles an accepted queue request after the enqueue response is lost", async () => {
    const w = world();
    w.dirty();
    w.enqueue.mockImplementationOnce(async (input) => {
      w.jobs.push({
        ...input,
        id: `job-${randomUUID()}`,
        runId: 1,
        status: "queued",
        createdAt: "2026-10-06T12:00:00Z",
      });
      throw new Error("private-queue-error");
    });
    expect((await w.service.reconcile()).phase).toBe("blocked");
    expect((await w.restart().reconcile()).phase).toBe("repairing");
    expect(w.enqueue).toHaveBeenCalledOnce();
    expect(w.state().repairs[0].jobId).toBe(w.jobs[0]!.id);
  });

  it.each([false, true])(
    "respects a canceled repair even if a PR exists (%s)",
    async (withPull) => {
      const w = world();
      w.dirty();
      await w.service.reconcile();
      const job = w.jobs[0]!;
      job.status = "canceled";
      if (withPull) w.resolution(job);
      expect((await w.restart().reconcile()).phase).toBe("blocked");
      expect(w.merge).not.toHaveBeenCalled();
      expect(w.forge.readied).toEqual([]);
      expect(w.enqueue).toHaveBeenCalledOnce();
    },
  );

  it.each(["queued", "running"] as const)(
    "waits for a %s repair to finish even if its PR already exists",
    async (status) => {
      const w = world();
      w.dirty();
      await w.service.reconcile();
      w.jobs[0]!.status = status;
      w.resolution(w.jobs[0]!);
      expect((await w.restart().reconcile()).phase).toBe("repairing");
      expect(w.merge).not.toHaveBeenCalled();
      expect(w.forge.readied).toEqual([]);
      expect(w.enqueue).toHaveBeenCalledOnce();
    },
  );

  it.each([STAGING, INTEGRATION])(
    "requires a repair head to include ancestry %s before merging",
    async (missing) => {
      const w = world();
      w.dirty();
      await w.service.reconcile();
      w.jobs[0]!.status = "succeeded";
      const pull = w.resolution(w.jobs[0]!);
      w.compare(REPAIRED, missing, 1);
      expect((await w.service.reconcile()).phase).toBe("blocked");
      expect(w.merge).not.toHaveBeenCalled();
      w.compare(REPAIRED, missing, 0, 2);
      expect((await w.restart().reconcile()).phase).toBe("current");
      expect(w.forge.readied).toEqual([pull.number]);
      expect(w.merge).toHaveBeenCalledExactlyOnceWith(TEST_REPO, pull.number, {
        method: "merge",
        sha: REPAIRED,
      });
      expect(w.checkMerge).toHaveBeenCalledExactlyOnceWith(
        INTEGRATION,
        REPAIRED,
      );
      expect(w.enqueue).toHaveBeenCalledOnce();
    },
  );

  it.each(["staging", "integration"])(
    "rejects repair admission after %s moves",
    async (branch) => {
      const w = world();
      w.dirty();
      await w.service.reconcile();
      const job = w.jobs[0]!;
      expect(await w.restart().repairIntent(job)).toMatchObject({
        stagingSha: STAGING,
        integrationSha: INTEGRATION,
        jobId: job.id,
      });
      w.forge.seedBranch(
        TEST_REPO,
        branch === "staging" ? "staging" : "pm-staging",
        MOVED,
      );
      await expect(w.restart().repairIntent(job)).rejects.toThrow(
        "source branches moved",
      );
    },
  );

  it.each([
    [
      "id",
      `job-${"0".repeat(8)}-${"0".repeat(4)}-${"0".repeat(4)}-${"0".repeat(4)}-${"0".repeat(12)}`,
    ],
    ["type", "pm"],
    ["developerKind", "build"],
    ["project", "other"],
    ["projectInstanceId", "other-instance"],
    ["ticket", "FORGED-1"],
    ["attempt", 2],
    ["branch", "main"],
    ["runOnce", false],
    ["idempotencyKey", "forged"],
  ])("refuses forged repair admission field %s", async (field, value) => {
    const w = world();
    w.dirty();
    await w.service.reconcile();
    await expect(
      w
        .restart()
        .repairIntent({ ...w.jobs[0]!, [field as string]: value } as LocalJob),
    ).rejects.toThrow("matching controller admission");
  });

  it("refuses a forged queued job when reconciling its existing resolution PR", async () => {
    const w = world();
    w.dirty();
    await w.service.reconcile();
    w.jobs[0]!.developerKind = "build";
    w.jobs[0]!.status = "succeeded";
    w.resolution(w.jobs[0]!);
    expect((await w.restart().reconcile()).phase).toBe("blocked");
    expect(w.merge).not.toHaveBeenCalled();
    expect(w.forge.readied).toEqual([]);
  });

  it("does not merge when configuration changes during combined checks", async () => {
    const w = world();
    w.checkMerge.mockImplementation(async () => {
      w.change((p) => {
        p.config.commands.test = "npm run changed-test";
      });
      return true;
    });
    expect((await w.service.reconcile()).phase).toBe("blocked");
    expect(w.merge).not.toHaveBeenCalled();
    expect(w.enqueue).not.toHaveBeenCalled();
    expect(existsSync(join(w.directory, "operation.lock"))).toBe(false);
  });

  it("does not merge when a source branch moves during combined checks", async () => {
    const w = world();
    w.checkMerge.mockImplementation(async () => {
      w.forge.seedBranch(TEST_REPO, "staging", MOVED);
      return true;
    });
    expect((await w.service.reconcile()).phase).toBe("checking");
    expect(w.merge).not.toHaveBeenCalled();
  });

  it("rejects a pull head replaced while its original revision was being checked", async () => {
    const w = world();
    w.checkMerge.mockImplementation(async () => {
      w.forge.patchPull(TEST_REPO, 1, { headSha: MOVED });
      return true;
    });
    expect((await w.service.reconcile()).phase).toBe("checking");
    expect(w.checkMerge).toHaveBeenCalledExactlyOnceWith(INTEGRATION, STAGING);
    expect(w.merge).not.toHaveBeenCalled();
  });

  it("does not call an old deployment current when integration moves during its lookup", async () => {
    const w = world();
    w.compare(INTEGRATION, STAGING, 0, 2);
    w.deployment.mockImplementation(async () => {
      w.forge.seedBranch(TEST_REPO, "pm-staging", MOVED);
      return {
        id: "dpl",
        url: "https://preview.example.test",
        provider: "vercel",
        sha: INTEGRATION,
        branch: "pm-staging",
        state: "READY",
      };
    });
    expect((await w.service.reconcile()).phase).toBe("checking");
    expect(w.merge).not.toHaveBeenCalled();
  });

  it("rechecks provider checks immediately before merging", async () => {
    const w = world();
    w.checkMerge.mockImplementation(async () => {
      w.forge.seedChecks(TEST_REPO, STAGING, {
        status: "failure",
        failedJobs: [],
      });
      return true;
    });
    expect((await w.service.reconcile()).phase).toBe("waiting-checks");
    expect(w.merge).not.toHaveBeenCalled();
  });

  it("does not publish provider or command secrets in errors or durable status", async () => {
    const w = world();
    w.checkMerge.mockRejectedValue(
      new Error("PRIVATE-TOKEN credentials and command output"),
    );
    const result = await w.service.reconcile();
    expect(result.phase).toBe("blocked");
    const text = JSON.stringify([result, w.restart().status(), w.state()]);
    expect(text).not.toContain("PRIVATE-TOKEN");
    expect(text).not.toContain("credentials and command output");
    expect(
      readdirSync(w.directory).filter((name) => name.endsWith(".tmp")),
    ).toEqual([]);
    expect(w.merge).not.toHaveBeenCalled();
  });
});
