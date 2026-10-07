import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDeliveryService } from "./index.ts";
import { createDeliveryController } from "./controller.ts";
import type { createPromotionExecutor } from "./executor.ts";
import { FakeForge } from "../forge/fake.ts";
import {
  FakeLinear,
  makeProject,
  makeHub,
  TEST_REPO,
} from "../services/fakes.ts";
import type { LocalJob, LocalJobInput } from "../localRunners/types.ts";
import { validateSyncRepairPayload } from "../../runner-local/sync-repair.mjs";
import type {
  DockerJobPayload,
  DockerRunners,
} from "../localRunners/docker.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
const HEAD = "a".repeat(40),
  BASE = "b".repeat(40),
  FIX = "c".repeat(40);
async function world() {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "gremlins-integration-repair-")),
  );
  roots.push(root);
  writeFileSync(join(root, "hub.json"), JSON.stringify(makeHub()));
  const project = makeProject({
    config: { linear: { teamId: "team-1" }, workflow: { kind: "promotion" } },
  });
  const forge = new FakeForge(),
    linear = new FakeLinear();
  const ticket = linear.seedTicket({
    projectId: "lin_core",
    labels: ["pm:core", "pm-approved"],
    description: "## Acceptance criteria\n- Saved name appears.",
  });
  forge.seedBranch(TEST_REPO, "pm-staging", BASE);
  forge.seedChecks(TEST_REPO, BASE, { status: "success", failedJobs: [] });
  forge.seedChecks(TEST_REPO, HEAD, { status: "success", failedJobs: [] });
  forge.seedPull(
    TEST_REPO,
    {
      number: 1,
      headRef: "gremlins/job-original",
      headSha: HEAD,
      baseRef: "pm-staging",
      draft: true,
      mergeableState: "dirty",
    },
    ["app/name.ts"],
  );
  const ledger = () =>
    createDeliveryService({
      root,
      project,
      forge,
      linear,
      now: () => new Date("2026-10-07T00:00:00Z"),
    });
  const input = {
    jobId: "job-original",
    area: "core",
    ticket,
    pullNumber: 1,
    approvedBy: "owner",
    approvedAt: "2026-10-06T00:00:00Z",
  };
  await ledger().register(input);
  const jobs: LocalJob[] = [];
  let loseResponse = false;
  const enqueue = vi.fn(async (input: LocalJobInput) => {
    let job = jobs.find((j) => j.idempotencyKey === input.idempotencyKey);
    if (!job) {
      job = {
        ...input,
        id: "job-repair",
        runId: 2,
        status: "queued",
        createdAt: "2026-10-07T00:00:00Z",
      };
      jobs.push(job);
    }
    if (loseResponse) {
      loseResponse = false;
      throw new Error("lost queue response");
    }
    return job;
  });
  const failed = new Set<string>();
  const executed = vi.fn();
  const executor = (async () => {
    let sha = BASE;
    return {
      checkoutDir: root,
      git: {
        run: async (args: string[]) => {
          if (args[0] === "checkout") sha = args[2]!;
          return { code: 0, out: sha, err: "" };
        },
      },
      check: async () => {
        executed(sha);
        return { ok: !failed.has(sha), output: "configured test outcome" };
      },
    };
  }) as unknown as typeof createPromotionExecutor;
  const controller = () =>
    createDeliveryController({
      root,
      loadProject: () => project,
      sourceControl: {
        resolveCredential: async () => ({
          token: "source",
          method: "token" as const,
        }),
      },
      linearConnectionFor: () => ({
        resolveCredential: async () => ({
          token: "linear",
          authorization: "linear",
          method: "token" as const,
        }),
      }),
      forge: () => forge,
      linear: () => linear,
      qaJobs: async () => jobs,
      enqueueQaRepair: enqueue,
      docker: { ensureImage: async () => "image" },
      executor,
      now: () => new Date("2026-10-07T00:00:00Z"),
    });
  const payload = (): DockerJobPayload => ({
    kind: "developer",
    provider: "github",
    repoUrl: `https://github.com/${TEST_REPO}.git`,
    branch: "pm-staging",
    browserVerification: true,
    browserTarget: "https://preview.example",
    credentials: {
      GITHUB_TOKEN: "source",
      CLAUDE_CODE_OAUTH_TOKEN: "claude",
      LINEAR_API_KEY: "linear",
      PRIVATE_APP_TOKEN: "app",
    },
    prompt: "Write /output/implementation-report.json: full report contract",
    delivery: {
      ticket: ticket.identifier,
      title: ticket.title,
      repo: TEST_REPO,
      base: "pm-staging",
      branch: "gremlins/job-repair",
      acceptanceCriteria: ["Saved name appears."],
    },
  });
  return {
    root,
    project,
    forge,
    linear,
    ticket,
    input,
    ledger,
    controller,
    jobs,
    enqueue,
    failed,
    executed,
    payload,
    lose: () => {
      loseResponse = true;
    },
  };
}

async function supersededWorld() {
  const w = await world();
  await w.controller().reconcileIntegrationRepairs("game");
  w.forge.seedPull(
    TEST_REPO,
    {
      number: 2,
      headRef: "gremlins/job-repair",
      headSha: FIX,
      baseRef: "pm-staging",
      mergeableState: "clean",
    },
    ["app/name.ts"],
  );
  w.forge.seedChecks(TEST_REPO, FIX, { status: "success", failedJobs: [] });
  await w.ledger().register({
    ...w.input,
    jobId: "job-repair",
    pullNumber: 2,
    integrationRepairKey: w.jobs[0]!.idempotencyKey,
  });
  return w;
}

async function addOtherImplementation(w: Awaited<ReturnType<typeof world>>) {
  const ticket = w.linear.seedTicket({
    projectId: "lin_core",
    labels: ["pm:core", "pm-approved"],
    description: "## Acceptance criteria\n- Another saved field appears.",
  });
  w.forge.seedPull(
    TEST_REPO,
    {
      number: 3,
      headRef: "gremlins/job-other",
      headSha: "d".repeat(40),
      baseRef: "pm-staging",
      mergeableState: "behind",
    },
    ["app/name.ts"],
  );
  w.forge.seedChecks(TEST_REPO, "d".repeat(40), {
    status: "success",
    failedJobs: [],
  });
  return w.ledger().register({
    ...w.input,
    jobId: "job-other",
    pullNumber: 3,
    ticket,
  });
}

describe("bounded replacement drafts for pre-merge repair", () => {
  it("recovers lost queue replies and restart without duplicating a repair", async () => {
    const w = await world();
    w.lose();
    await expect(
      w.controller().reconcileIntegrationRepairs("game"),
    ).rejects.toThrow("lost queue");
    expect(w.ledger().list()[0]!.integrationRepair?.phase).toBe("queued");
    await w.controller().reconcileIntegrationRepairs("game");
    await w.controller().reconcileIntegrationRepairs("game");
    expect(w.enqueue).toHaveBeenCalledTimes(1);
    expect(w.ledger().list()[0]!.integrationRepair?.jobId).toBe("job-repair");
  });
  it.each(["none", "failure"] as const)(
    "repairs independently reproduced checks with provider status %s",
    async (status) => {
      const w = await world();
      w.forge.patchPull(TEST_REPO, 1, { mergeableState: "clean" });
      w.forge.seedChecks(TEST_REPO, HEAD, { status, failedJobs: [] });
      w.failed.add(HEAD);
      await w.controller().reconcileIntegrationRepairs("game");
      expect(w.jobs).toHaveLength(1);
      expect(w.jobs[0]!.developerKind).toBe("ci");
      expect(w.executed).toHaveBeenCalledWith(HEAD);
      expect(w.executed).toHaveBeenCalledWith(BASE);
    },
  );
  it.each(["success", "none"] as const)(
    "updates an outdated implementation automatically with %s provider checks",
    async (status) => {
      const w = await world();
      w.forge.patchPull(TEST_REPO, 1, { mergeableState: "behind" });
      w.forge.seedChecks(TEST_REPO, HEAD, { status, failedJobs: [] });
      await w.controller().reconcileIntegrationRepairs("game");
      await w.controller().reconcileIntegrationRepairs("game");
      expect(w.enqueue).toHaveBeenCalledOnce();
      expect(w.jobs[0]).toMatchObject({ developerKind: "rc" });
      expect(w.ledger().list()[0]!.integrationRepair).toMatchObject({
        kind: "behind",
        integrationSha: BASE,
        headSha: HEAD,
      });
      const payload = await w
        .controller()
        .beforeDeveloper(w.jobs[0]!, w.payload(), w.ticket);
      expect(payload.expectedCommitSha).toBe(BASE);
      expect(payload.syncRepair).toEqual({ stagingSha: HEAD });
      expect(payload.prompt).toContain(
        "include the current integration branch",
      );
      expect(payload.prompt).toContain("without adding unrelated code changes");
      expect(w.forge.merged).toEqual([]);
      expect(w.linear.stateUpdates).toEqual([]);
    },
  );
  it("does not treat an outdated branch with provider access failures as a coding defect", async () => {
    const w = await world();
    w.forge.patchPull(TEST_REPO, 1, { mergeableState: "behind" });
    w.forge.seedChecks(TEST_REPO, HEAD, { status: "failure", failedJobs: [] });
    await w.controller().reconcileIntegrationRepairs("game");
    expect(w.jobs).toEqual([]);
    expect(w.ledger().list()[0]!.integrationRepair).toBeUndefined();
  });
  it.each(["pending", "permission", "baseline", "hub files"])(
    "does not launch for %s",
    async (reason) => {
      const w = await world();
      if (reason === "pending")
        w.forge.seedChecks(TEST_REPO, HEAD, {
          status: "pending",
          failedJobs: [],
        });
      if (reason === "permission") {
        w.forge.patchPull(TEST_REPO, 1, { mergeableState: "blocked" });
        w.forge.seedChecks(TEST_REPO, HEAD, {
          status: "failure",
          failedJobs: [],
        });
      }
      if (reason === "baseline") w.failed.add(BASE);
      if (reason === "hub files")
        w.forge.seedPull(
          TEST_REPO,
          {
            number: 1,
            headRef: "gremlins/job-original",
            headSha: HEAD,
            baseRef: "pm-staging",
            mergeableState: "dirty",
          },
          [".github/workflows/build.yml"],
        );
      await w.controller().reconcileIntegrationRepairs("game");
      expect(w.jobs).toHaveLength(0);
      if (reason === "hub files") expect(w.executed).not.toHaveBeenCalled();
    },
  );
  it("pins both source histories and strips browser/Linear credentials before coding", async () => {
    const w = await world();
    await w.controller().reconcileIntegrationRepairs("game");
    const payload = await w
      .controller()
      .beforeDeveloper(w.jobs[0]!, w.payload(), w.ticket);
    expect(payload.expectedCommitSha).toBe(BASE);
    expect(payload.syncRepair).toEqual({ stagingSha: HEAD });
    expect(payload.credentials).toEqual({
      GITHUB_TOKEN: "source",
      CLAUDE_CODE_OAUTH_TOKEN: "claude",
    });
    expect(payload.browserTarget).toBeUndefined();
    expect(payload.browserVerification).toBe(false);
    expect(() => validateSyncRepairPayload({ ...payload })).not.toThrow();
    expect(payload.prompt).toContain(
      "Fresh owning-PM deployment QA is still mandatory",
    );
    expect(payload.prompt).toContain(
      "Write /output/implementation-report.json",
    );
  });
  it.each(["scope", "head", "merged", "owner"])(
    "rejects moved %s at launch",
    async (changed) => {
      const w = await world();
      await w.controller().reconcileIntegrationRepairs("game");
      if (changed === "scope") w.ticket.description += "\n- More scope";
      if (changed === "head") w.forge.patchPull(TEST_REPO, 1, { headSha: FIX });
      if (changed === "merged")
        w.forge.patchPull(TEST_REPO, 1, {
          state: "merged",
          mergeCommitSha: BASE,
        });
      if (changed === "owner") w.project.areas[0]!.name = "Different owner";
      await expect(
        w.controller().beforeDeveloper(w.jobs[0]!, w.payload(), w.ticket),
      ).rejects.toThrow();
    },
  );
  it("supersedes only the original unmerged draft, keeps audit history, and requires new QA", async () => {
    const w = await world();
    const controller = w.controller();
    await controller.reconcileIntegrationRepairs("game");
    await controller.beforeDeveloper(w.jobs[0]!, w.payload(), w.ticket);
    w.forge.seedPull(
      TEST_REPO,
      {
        number: 2,
        headRef: "gremlins/job-repair",
        headSha: FIX,
        baseRef: "pm-staging",
        draft: true,
      },
      ["app/name.ts"],
    );
    w.forge.seedChecks(TEST_REPO, FIX, { status: "success", failedJobs: [] });
    await controller.completeJob(
      w.jobs[0]!,
      {
        ok: true,
        kind: "developer",
        nonce: "job-repair",
        prUrl: `https://github.com/${TEST_REPO}/pull/2`,
        headSha: FIX,
      },
      {} as DockerRunners,
    );
    const [original, replacement] = w.ledger().list();
    expect(original).toMatchObject({
      status: "blocked",
      supersededBy: "job-repair",
      integrationRepair: { phase: "replaced" },
    });
    expect(replacement).toMatchObject({
      status: "awaiting-merge",
      integrationRepairOf: "job-original",
    });
    expect(replacement!.review).toBeUndefined();
    expect(replacement!.promotion).toBeUndefined();
    expect((await w.forge.getPull(TEST_REPO, 1))!.state).toBe("open");
    await w.ledger().register(w.input); // Retried old worker reconciliation cannot revive it.
    expect(w.ledger().list()).toHaveLength(2);
    await w.ledger().advanceIntegration(async () => true);
    expect(w.forge.merged).toEqual([2]);
    // Replayed completion after merging is idempotent.
    await controller.completeJob(
      w.jobs[0]!,
      {
        ok: true,
        kind: "developer",
        nonce: "job-repair",
        prUrl: `https://github.com/${TEST_REPO}/pull/2`,
        headSha: FIX,
      },
      {} as DockerRunners,
    );
    expect(w.ledger().list()).toHaveLength(2);
  });
  it("rejects replacement that drops the original history", async () => {
    const w = await world();
    await w.controller().reconcileIntegrationRepairs("game");
    await w.controller().beforeDeveloper(w.jobs[0]!, w.payload(), w.ticket);
    w.forge.seedPull(
      TEST_REPO,
      {
        number: 2,
        headRef: "gremlins/job-repair",
        headSha: FIX,
        baseRef: "pm-staging",
      },
      ["app/name.ts"],
    );
    w.forge.seedCompare(TEST_REPO, HEAD, FIX, { aheadBy: 1, behindBy: 1 });
    await expect(
      w.ledger().register({
        ...w.input,
        jobId: "job-repair",
        pullNumber: 2,
        integrationRepairKey: w.jobs[0]!.idempotencyKey,
      }),
    ).rejects.toThrow("preserve both");
    expect(w.ledger().list()[0]!.supersededBy).toBeUndefined();
  });
  it("stops after one failed worker and never retries the same repair", async () => {
    const w = await world();
    await w.controller().reconcileIntegrationRepairs("game");
    w.jobs[0]!.status = "failed";
    await w.controller().reconcileIntegrationRepairs("game");
    await w.controller().reconcileIntegrationRepairs("game");
    expect(w.enqueue).toHaveBeenCalledTimes(1);
    expect(w.ledger().list()[0]!.integrationRepair?.phase).toBe("stopped");
  });
  it("does not recursively repair a conflicted replacement", async () => {
    const w = await world();
    await w.controller().reconcileIntegrationRepairs("game");
    w.forge.seedPull(
      TEST_REPO,
      {
        number: 2,
        headRef: "gremlins/job-repair",
        headSha: FIX,
        baseRef: "pm-staging",
        mergeableState: "dirty",
      },
      ["app/name.ts"],
    );
    await w.ledger().register({
      ...w.input,
      jobId: "job-repair",
      pullNumber: 2,
      integrationRepairKey: w.jobs[0]!.idempotencyKey,
    });
    await w.controller().reconcileIntegrationRepairs("game");
    expect(w.enqueue).toHaveBeenCalledTimes(1);
    expect(w.ledger().list()[1]!.message).toContain(
      "one allowed coding attempt",
    );
    expect(w.ledger().list()[1]!.status).toBe("blocked");
  });
  it("serializes repair admission and holds unrelated integration merges until its replacement", async () => {
    const w = await world();
    const other = await addOtherImplementation(w);
    await w.controller().reconcileIntegrationRepairs("game");
    expect(w.enqueue).toHaveBeenCalledOnce();
    expect(w.controller().deliveryStatus("game").integrationRepairActive).toBe(
      true,
    );
    expect(
      await w.ledger().reserveIntegrationRepair({
        deliveryId: other.id,
        kind: "behind",
        integrationSha: BASE,
      }),
    ).toBeNull();
    w.forge.patchPull(TEST_REPO, 3, { mergeableState: "clean" });
    await w.ledger().advanceIntegration(async () => true);
    expect(w.forge.merged).toEqual([]);
    w.forge.seedPull(
      TEST_REPO,
      {
        number: 2,
        headRef: "gremlins/job-repair",
        headSha: FIX,
        baseRef: "pm-staging",
        mergeableState: "clean",
      },
      ["app/name.ts"],
    );
    w.forge.seedChecks(TEST_REPO, FIX, { status: "success", failedJobs: [] });
    await w.ledger().register({
      ...w.input,
      jobId: "job-repair",
      pullNumber: 2,
      integrationRepairKey: w.jobs[0]!.idempotencyKey,
    });
    await w.controller().reconcileIntegrationRepairs("game");
    expect(w.enqueue).toHaveBeenCalledOnce();
    await w.ledger().advanceIntegration(async () => true);
    expect(w.forge.merged).toEqual([2]);
    expect(w.controller().deliveryStatus("game").integrationRepairActive).toBe(
      false,
    );
  });
  it("ends the active repair family honestly when external updates make its replacement outdated", async () => {
    const w = await supersededWorld();
    w.forge.patchPull(TEST_REPO, 2, { mergeableState: "behind" });
    await w.controller().reconcileIntegrationRepairs("game");
    await w.controller().reconcileIntegrationRepairs("game");
    expect(w.enqueue).toHaveBeenCalledOnce();
    expect(w.ledger().list()[1]).toMatchObject({ status: "blocked" });
    expect(w.ledger().list()[1]!.message).toContain("repair stopped");
    expect(w.controller().deliveryStatus("game").integrationRepairActive).toBe(
      false,
    );
  });
  it.each(["queued", "replacement"])(
    "does not let a stale %s repair family hold current integration work",
    async (phase) => {
      const w =
        phase === "replacement" ? await supersededWorld() : await world();
      if (phase === "queued")
        await w.controller().reconcileIntegrationRepairs("game");
      expect(
        w.controller().deliveryStatus("game").integrationRepairActive,
      ).toBe(true);
      w.project.config.commands.test = "npm run revised-test";
      expect(
        w.controller().deliveryStatus("game").integrationRepairActive,
      ).toBe(false);
      await addOtherImplementation(w);
      w.forge.patchPull(TEST_REPO, 3, { mergeableState: "clean" });
      await w.ledger().advanceIntegration(async () => true);
      expect(w.forge.merged).toEqual([3]);
      const stale = w
        .ledger()
        .list()
        .find(
          (record) =>
            record.id === (phase === "queued" ? "job-original" : "job-repair"),
        )!;
      expect(stale.status).toBe("blocked");
      if (phase === "queued")
        expect(stale.integrationRepair?.phase).toBe("stopped");
    },
  );
  it("does not let stale repair admission prevent a new current repair", async () => {
    const w = await world();
    await w.controller().reconcileIntegrationRepairs("game");
    w.project.config.commands.test = "npm run revised-test";
    const other = await addOtherImplementation(w);
    const admitted = await w.ledger().reserveIntegrationRepair({
      deliveryId: other.id,
      kind: "behind",
      integrationSha: BASE,
    });
    expect(admitted?.integrationRepair?.phase).toBe("queued");
  });
});

describe("automatic superseded draft cleanup", () => {
  it("closes only the registered original and preserves branches and both delivery records", async () => {
    const w = await supersededWorld();
    await addOtherImplementation(w);
    await w.controller().reconcileIntegrationRepairs("game");
    expect(w.forge.closed).toEqual([1]);
    expect(w.forge.deletedBranches).toEqual([]);
    expect(w.ledger().list()).toHaveLength(3);
    expect(w.ledger().list()[0]!.supersededClosedAt).toBeDefined();
    const read = vi.spyOn(w.forge, "getPull");
    await w.ledger().retireSupersededDrafts();
    expect(read).not.toHaveBeenCalled();
    expect(w.forge.closed).toEqual([1]);
  });
  it.each([
    "head",
    "branch",
    "base",
    "author",
    "merged",
    "replacement",
    "history",
    "configuration",
  ])("preserves superseded drafts when %s has changed", async (change) => {
    const w = await supersededWorld();
    if (change === "head") w.forge.patchPull(TEST_REPO, 1, { headSha: FIX });
    if (change === "branch")
      w.forge.patchPull(TEST_REPO, 1, { headRef: "external/branch" });
    if (change === "base") w.forge.patchPull(TEST_REPO, 1, { baseRef: "main" });
    if (change === "author")
      w.forge.patchPull(TEST_REPO, 1, { author: "someone-else" });
    if (change === "merged")
      w.forge.patchPull(TEST_REPO, 1, {
        state: "merged",
        mergeCommitSha: BASE,
      });
    if (change === "replacement")
      w.forge.patchPull(TEST_REPO, 2, { headSha: BASE });
    if (change === "history")
      w.forge.seedCompare(TEST_REPO, HEAD, FIX, { aheadBy: 1, behindBy: 1 });
    if (change === "configuration") w.project.config.commands.test = "changed";
    await w.ledger().retireSupersededDrafts();
    expect(w.forge.closed).toEqual([]);
    expect(w.ledger().list()[0]!.supersededClosedAt).toBeUndefined();
  });
  it.each([false, true])(
    "retries cleanup after a provider failure (lost response: %s)",
    async (lostResponse) => {
      const w = await supersededWorld();
      const close = w.forge.closePull.bind(w.forge);
      const closeSpy = vi
        .spyOn(w.forge, "closePull")
        .mockImplementationOnce(async (...args) => {
          if (lostResponse) await close(...args);
          throw new Error("private provider response");
        });
      await w.ledger().retireSupersededDrafts();
      expect(w.ledger().list()[0]!.supersededClosedAt).toBeUndefined();
      expect(w.ledger().list()[0]!.message).not.toContain("private provider");
      await w.ledger().retireSupersededDrafts();
      expect(w.ledger().list()[0]!.supersededClosedAt).toBeDefined();
      expect(w.forge.closed).toEqual([1]);
      expect(closeSpy).toHaveBeenCalledTimes(lostResponse ? 1 : 2);
    },
  );
  it("rechecks current configuration immediately before closure", async () => {
    const w = await supersededWorld();
    const current = vi.fn().mockReturnValueOnce(true).mockReturnValue(false);
    await w.ledger().retireSupersededDrafts(current);
    expect(w.forge.closed).toEqual([]);
    expect(current).toHaveBeenCalledTimes(2);
  });
});
