import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createDeliveryService,
  type PmReviewManifest,
  type ReviewIngestion,
} from "./index.ts";
import { createDeliveryController } from "./controller.ts";
import { qaRepairInput } from "./qaRework.ts";
import { FakeForge } from "../forge/fake.ts";
import {
  FakeLinear,
  makeProject,
  makeHub,
  TEST_REPO,
} from "../services/fakes.ts";
import type { LocalJob, LocalJobInput } from "../localRunners/types.ts";
import type { DockerRunners } from "../localRunners/docker.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
const HEAD = "a".repeat(40),
  DEPLOY = "b".repeat(40);
const screenshot = {
  name: "review-screenshots/failed.png",
  sha256: "f".repeat(64),
};
function world() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "gremlins-qa-rework-")));
  roots.push(root);
  writeFileSync(join(root, "hub.json"), JSON.stringify(makeHub()));
  const project = makeProject({
    config: {
      linear: { teamId: "team-1", connectionId: "work" },
      workflow: { kind: "promotion" },
      verification: { mode: "browser", environment: "integration" },
      vercel: undefined,
      environments: {
        integration: {
          role: "preview",
          kind: "railway",
          projectId: "project",
          environmentId: "env",
          serviceId: "service",
        },
      },
    },
  });
  const forge = new FakeForge(),
    linear = new FakeLinear();
  const ticket = linear.seedTicket({
    projectId: "lin_core",
    labels: ["pm:core", "pm-approved"],
    description: "## Acceptance criteria\n- The saved name is visible.",
  });
  forge.seedBranch(TEST_REPO, "pm-staging", DEPLOY);
  forge.seedBranch(TEST_REPO, "staging", DEPLOY);
  forge.seedChecks(TEST_REPO, DEPLOY, { status: "success", failedJobs: [] });
  const create = () =>
    createDeliveryService({
      root,
      project,
      forge,
      linear,
      now: () => new Date("2026-10-06T00:00:00Z"),
    });
  const service = create();
  const deployment = {
    id: "deployment",
    url: "https://preview.example",
    sha: DEPLOY,
    branch: "pm-staging",
    provider: "railway",
    state: "READY" as const,
  };
  const jobs: LocalJob[] = [];
  let lostResponse = false;
  const enqueue = vi.fn(async (input: LocalJobInput) => {
    let job = jobs.find((j) => j.idempotencyKey === input.idempotencyKey);
    if (!job) {
      job = {
        ...input,
        id: `job-repair-${jobs.length + 1}`,
        runId: jobs.length + 1,
        status: "queued",
        createdAt: "2026-10-06T00:00:00Z",
      };
      jobs.push(job);
    }
    if (lostResponse) {
      lostResponse = false;
      throw new Error("Queue response lost");
    }
    return job;
  });
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
      resolveEnvironment: async () => ({
        provider: "railway" as const,
        url: deployment.url,
        deploymentId: deployment.id,
        commitSha: DEPLOY,
        branch: "pm-staging",
      }),
      qaJobs: async () => jobs,
      enqueueQaRepair: enqueue,
      now: () => new Date("2026-10-06T00:00:00Z"),
    });
  let number = 0;
  async function register(jobId = "job-original", qaRepairKey?: string) {
    const pr = ++number;
    forge.seedPull(
      TEST_REPO,
      {
        number: pr,
        headRef: `gremlins/${jobId}`,
        headSha: HEAD,
        baseRef: "pm-staging",
        state: "merged",
        mergeCommitSha: DEPLOY,
        mergedAt: "2026-10-05T23:00:00Z",
      },
      ["app/name.ts"],
    );
    return service.register({
      jobId,
      area: "core",
      ticket,
      pullNumber: pr,
      approvedBy: "owner",
      approvedAt: "2026-10-05T22:00:00Z",
      ...(qaRepairKey ? { qaRepairKey } : {}),
    });
  }
  let reviewNumber = 0;
  async function review(
    status: "passed" | "failed" | "blocked" = "failed",
    options: Partial<ReviewIngestion> = {},
    transform?: (manifest: PmReviewManifest) => void,
  ) {
    const plan = await service.prepareReview({
      area: "core",
      jobId: `job-review-${++reviewNumber}`,
      deployment,
    });
    if (!plan) return null;
    const manifest: PmReviewManifest = {
      schema: 1,
      planId: plan.id,
      jobId: plan.jobId,
      project: project.config.name,
      area: "core",
      testedSha: DEPLOY,
      deploymentId: deployment.id,
      deliveries: plan.deliveries.map((delivery) => ({
        id: delivery.id,
        status,
        assertions: delivery.criteria.map((criterion) => ({
          criterion,
          status,
          receiptId: `receipt-${delivery.id}`,
        })),
        screenshots: [screenshot],
      })),
    };
    transform?.(manifest);
    const input: ReviewIngestion = {
      planId: plan.id,
      manifest,
      trustedResult: {
        ok: true,
        kind: "pm",
        nonce: plan.jobId,
        commitSha: DEPLOY,
      },
      deployment,
      verifyArtifact: async () => true,
      verifyAssertion: async () => true,
      failureEvidence: async ({ criterion, receiptId }) => ({
        criterion,
        receiptId,
        expected:
          "At /account, expected text-visible: Saved name. The independently replayed predicate evaluated false.",
        url: "https://preview.example/account",
        screenshot,
      }),
      ...options,
    };
    return { plan, input, result: await service.ingestReview(input) };
  }
  return {
    root,
    project,
    forge,
    linear,
    ticket,
    service,
    create,
    controller,
    jobs,
    enqueue,
    register,
    review,
    loseResponse: () => {
      lostResponse = true;
    },
  };
}
async function failed() {
  const w = world();
  await w.register();
  await w.review();
  return w;
}

describe("bounded owning-PM QA repairs", () => {
  it.each(["failed", "blocked", "wrong origin", "missing screenshot"])(
    "uses only the independent replay boundary for coder admission: %s",
    async (outcome) => {
      const w = world();
      await w.register();
      const plan = (await w.service.prepareReview({
        area: "core",
        jobId: "job-independent-review",
        deployment: {
          id: "deployment",
          url: "https://preview.example",
          sha: DEPLOY,
          branch: "pm-staging",
          provider: "railway",
          state: "READY",
        },
      }))!;
      const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]);
      const image = {
        name: "review-screenshots/independent.png",
        sha256: createHash("sha256").update(png).digest("hex"),
      };
      const criterion = plan.deliveries[0]!.criteria[0]!;
      const proof = {
        manifest: {
          schema: 1,
          planId: plan.id,
          jobId: plan.jobId,
          project: "game",
          area: "core",
          testedSha: DEPLOY,
          deploymentId: "deployment",
          deliveries: [
            {
              id: "job-original",
              status: "failed",
              assertions: [
                {
                  criterion,
                  status: "failed",
                  receiptId: "receipt-independent",
                },
              ],
              screenshots: [image],
            },
          ],
        },
        receipts: {
          jobId: plan.jobId,
          planId: plan.id,
          commitSha: DEPLOY,
          receipts: [
            {
              id: "receipt-independent",
              jobId: plan.jobId,
              planId: plan.id,
              deliveryId: "job-original",
              criterion,
              status: outcome === "blocked" ? "blocked" : "failed",
              testedSha: DEPLOY,
              deploymentId: "deployment",
              url:
                outcome === "wrong origin"
                  ? "https://wrong.example/account"
                  : "https://preview.example/account",
              screenshot: image,
              check: {
                kind: "selector-visible",
                path: "/account",
                selector: "[data-testid=saved-name]",
              },
            },
          ],
        },
      };
      const job: LocalJob = {
        id: plan.jobId,
        runId: 10,
        type: "pm",
        project: "game",
        area: "core",
        status: "running",
        createdAt: "2026-10-06T00:00:00Z",
      };
      const c = w.controller();
      await c.completeJob(
        job,
        {
          ok: true,
          nonce: job.id,
          kind: "pm",
          reviewProof: "untrusted model assertion",
        },
        {
          verifyReview: async () => ({
            proof: Buffer.from(JSON.stringify(proof)),
            result: { ok: true, kind: "pm", nonce: job.id, commitSha: DEPLOY },
            files: [],
          }),
          readArtifact: async () =>
            outcome === "missing screenshot"
              ? Buffer.from("not a screenshot")
              : png,
        } as unknown as DockerRunners,
      );
      await c.reconcileQaRework("game");
      expect(w.jobs).toHaveLength(outcome === "failed" ? 1 : 0);
      expect(w.service.list()[0]!.status).toBe(
        outcome === "failed" ? "failed" : "blocked",
      );
    },
  );
  it("captures concrete independent failure evidence and queues one same-scope coding job across restarts", async () => {
    const w = await failed();
    const evidence = w.service.list()[0]!.review!.failures![0]!;
    expect(evidence.expected).toContain("text-visible: Saved name");
    await w.controller().reconcileQaRework("game");
    await w.controller().reconcileQaRework("game");
    expect(w.jobs).toHaveLength(1);
    expect(w.enqueue).toHaveBeenCalledOnce();
    expect(w.jobs[0]).toMatchObject({
      type: "developer",
      developerKind: "rc",
      area: "core",
      ticket: w.ticket.identifier,
      runOnce: true,
      attempt: 1,
      idempotencyKey: expect.stringMatching(/^qa-rework:[a-f0-9]{64}$/),
    });
    expect(w.create().list()[0]!.rework).toMatchObject({
      jobId: w.jobs[0]!.id,
      phase: "queued",
      attempt: 1,
    });
    expect(w.linear.stateUpdates).toEqual([]);
    expect(w.forge.merged).toEqual([]);
  });
  it("recovers an ambiguous enqueue response without duplicate jobs", async () => {
    const w = await failed();
    w.loseResponse();
    await expect(w.controller().reconcileQaRework("game")).rejects.toThrow(
      "Queue response lost",
    );
    expect(w.create().list()[0]!.rework?.jobId).toBeUndefined();
    await w.controller().reconcileQaRework("game");
    expect(w.jobs).toHaveLength(1);
    expect(w.enqueue).toHaveBeenCalledOnce();
    expect(w.create().list()[0]!.rework?.jobId).toBe(w.jobs[0]!.id);
  });
  it("preserves a published repair when its queue response is lost before reconciliation", async () => {
    const w = await failed();
    w.enqueue.mockImplementationOnce(async (input) => {
      const job: LocalJob = {
        ...input,
        id: "job-fast-repair",
        runId: 1,
        status: "running",
        createdAt: "2026-10-06T00:00:00Z",
      };
      w.jobs.push(job);
      await w.service.admitQaRepair(job);
      await w.register(job.id, job.idempotencyKey);
      job.status = "succeeded";
      throw new Error("Response lost after publication");
    });
    await expect(w.controller().reconcileQaRework("game")).rejects.toThrow(
      "Response lost after publication",
    );
    await w.controller().reconcileQaRework("game");
    expect(w.enqueue).toHaveBeenCalledOnce();
    expect(w.service.list()[0]!.rework?.phase).toBe("awaiting-review");
    expect(w.service.list()).toHaveLength(2);
  });
  it("stops on a retained terminal queue job missing from the recent job list", async () => {
    const w = await failed();
    w.enqueue.mockImplementationOnce(async (input) => ({
      ...input,
      id: "job-retained-failed",
      runId: 1,
      status: "failed",
      createdAt: "2026-10-06T00:00:00Z",
    }));
    await w.controller().reconcileQaRework("game");
    await w.controller().reconcileQaRework("game");
    expect(w.enqueue).toHaveBeenCalledOnce();
    expect(w.service.list()[0]!.rework?.phase).toBe("stopped");
  });
  it.each(["blocked", "missing receipt", "missing screenshot"])(
    "does not code an infrastructure/evidence blocker: %s",
    async (condition) => {
      const w = world();
      await w.register();
      await w.review(
        condition === "blocked" ? "blocked" : "failed",
        condition === "missing receipt"
          ? { failureEvidence: async () => null }
          : condition === "missing screenshot"
            ? { verifyArtifact: async () => false }
            : {},
      );
      expect(w.service.list()[0]!.status).toBe("blocked");
      await w.controller().reconcileQaRework("game");
      expect(w.enqueue).not.toHaveBeenCalled();
    },
  );
  it("does not run after approval, scope, PM or source configuration changes", async () => {
    for (const change of ["approval", "scope", "pm", "source"]) {
      const w = await failed();
      const reserved = (await w.service.reserveQaRepair("job-original"))!;
      if (change === "approval") w.ticket.labels = ["pm:core"];
      if (change === "scope")
        w.ticket.description += "\n- Additional unapproved outcome.";
      if (change === "pm") w.project.areas[0]!.paths.push("new-area/");
      if (change === "source") w.project.config.repo = "another/repository";
      await w
        .controller()
        .reconcileQaRework("game")
        .catch(() => undefined);
      expect(w.enqueue).not.toHaveBeenCalled();
      await expect(
        w.service.admitQaRepair({
          ...qaRepairInput(w.project, reserved),
          id: "job-illegal",
          runId: 1,
          status: "running",
          createdAt: "2026-10-06T00:00:00Z",
        }),
      ).rejects.toThrow();
    }
  });
  it("injects bounded failure context and pins the repair checkout to integration", async () => {
    const w = await failed();
    const c = w.controller();
    await c.reconcileQaRework("game");
    const job = w.jobs[0]!;
    job.status = "running";
    const prepared = await c.beforeDeveloper(
      job,
      {
        kind: "developer",
        prompt: "Approved ticket",
        delivery: {
          ticket: w.ticket.identifier,
          title: "Repair saved name",
          base: "pm-staging",
          branch: `gremlins/${job.id}`,
          repo: TEST_REPO,
          acceptanceCriteria: ["The saved name is visible."],
        },
      },
      w.ticket,
    );
    expect(prepared.expectedCommitSha).toBe(DEPLOY);
    expect(prepared.prompt).toContain("OWNING PM QA REPAIR");
    expect(prepared.prompt).toContain("text-visible: Saved name");
    expect(prepared.prompt).toContain(
      "Do not revert shared integration history",
    );
    await expect(
      c.beforeDeveloper({ ...job, area: "different" }, prepared, w.ticket),
    ).rejects.toThrow(/follow-up/);
    await expect(
      c.beforeDeveloper(
        { ...job, id: "job-duplicate" },
        {
          ...prepared,
          delivery: { ...prepared.delivery!, branch: "gremlins/job-duplicate" },
        },
        w.ticket,
      ),
    ).rejects.toThrow(/follow-up/);
  });
  it("refuses stale source heads and integration histories before repair admission", async () => {
    for (const change of ["head", "history"]) {
      const w = await failed();
      await w.controller().reconcileQaRework("game");
      if (change === "head")
        w.forge.patchPull(TEST_REPO, 1, { headSha: "c".repeat(40) });
      else
        w.forge.seedCompare(TEST_REPO, DEPLOY, DEPLOY, {
          aheadBy: 0,
          behindBy: 1,
        });
      await expect(w.service.admitQaRepair(w.jobs[0]!)).rejects.toThrow(
        "reviewed implementation changed",
      );
      await w.controller().reconcileQaRework("game");
      expect(w.service.list()[0]!.rework?.phase).toBe("stopped");
      expect(w.jobs).toHaveLength(1);
    }
  });
  it("stops after failed or canceled repairs without admitting another attempt", async () => {
    for (const status of ["failed", "canceled"] as const) {
      const w = await failed();
      await w.controller().reconcileQaRework("game");
      w.jobs[0]!.status = status;
      await w.controller().reconcileQaRework("game");
      await w.controller().reconcileQaRework("game");
      expect(w.jobs).toHaveLength(1);
      expect(w.create().list()[0]!.rework?.phase).toBe("stopped");
    }
  });
  it("rechecks original and repair together, then allows only the complete passing lineage to promote", async () => {
    const w = await failed();
    await w.controller().reconcileQaRework("game");
    expect(await w.review()).toBeNull(); // No repeat PM while a known failing revision is being repaired.
    const repair = w.jobs[0]!;
    await w.register(repair.id, repair.idempotencyKey);
    repair.status = "succeeded";
    const reviewed = (await w.review("passed"))!;
    expect(reviewed.plan.deliveries.map((d) => d.id)).toEqual([
      "job-original",
      repair.id,
    ]);
    expect(w.service.list().map((r) => r.status)).toEqual([
      "verified",
      "verified",
    ]);
    for (const number of [1, 2])
      expect(
        (
          await w.service.promotionOptions().candidateVerdict!(
            (await w.forge.getPull(TEST_REPO, number))!,
          )
        )?.verdict,
      ).toBe("verified");
    // A child alone cannot carry a newly failed original implementation forward.
    const later = await w.service.prepareReview({
      area: "core",
      jobId: "job-no-extra-review",
      deployment: reviewed.plan.deployment,
    });
    expect(later).toBeNull();
    await w.controller().reconcileQaRework("game");
    expect(w.jobs).toHaveLength(1);
  });
  it("stops after one automatic QA repair and preserves both implementation attempts", async () => {
    const w = await failed();
    for (let i = 1; i <= 1; i++) {
      await w.controller().reconcileQaRework("game");
      const repair = w.jobs[i - 1]!;
      expect(repair.attempt).toBe(i);
      await w.register(repair.id, repair.idempotencyKey);
      repair.status = "succeeded";
      await w.review("failed");
    }
    await w.controller().reconcileQaRework("game");
    await w.controller().reconcileQaRework("game");
    expect(w.jobs).toHaveLength(1);
    expect(w.service.list().at(-1)!.message).toContain(
      "after the automatic coding repair",
    );
    expect(
      w.service.list().every((r) => r.review?.failures?.length === 1),
    ).toBe(true);
    expect(w.forge.merged).toEqual([]);
    expect(w.linear.stateUpdates).toEqual([]);
  });
  it("never promotes a passing repair independently from its still-failing original", async () => {
    const w = await failed();
    await w.controller().reconcileQaRework("game");
    const job = w.jobs[0]!;
    await w.register(job.id, job.idempotencyKey);
    job.status = "succeeded";
    await w.review("failed", {}, (mixed) => {
      mixed.deliveries[1]!.status = "passed";
      mixed.deliveries[1]!.assertions.forEach((a) => {
        a.status = "passed";
      });
    });
    expect(w.service.list().map((r) => r.status)).toEqual([
      "failed",
      "verified",
    ]);
    expect(
      (
        await w.service.promotionOptions().candidateVerdict!(
          (await w.forge.getPull(TEST_REPO, 2))!,
        )
      )?.verdict,
    ).toBe("untested");
  });
  it("does not replace newer passing QA with an older failed completion replay", async () => {
    const w = world();
    await w.register();
    const older = (await w.review())!;
    await w.controller().reconcileQaRework("game");
    const job = w.jobs[0]!;
    await w.register(job.id, job.idempotencyKey);
    job.status = "succeeded";
    await w.review("passed");
    await w.service.ingestReview(older.input);
    expect(w.service.list().map((r) => r.status)).toEqual([
      "verified",
      "verified",
    ]);
    expect(w.jobs).toHaveLength(1);
  });
  it("keeps one review immutable when worker replay creates fresh receipt IDs", async () => {
    const w = world();
    await w.register();
    const original = (await w.review())!;
    await w.controller().reconcileQaRework("game");
    const manifest = structuredClone(
      original.input.manifest,
    ) as PmReviewManifest;
    manifest.deliveries[0]!.assertions[0]!.receiptId =
      "another-independent-replay";
    await w.service.ingestReview({ ...original.input, manifest });
    const record = w.service.list()[0]!;
    expect(record.review!.manifestHash).toBe(record.rework!.reviewHash);
    await expect(w.service.admitQaRepair(w.jobs[0]!)).resolves.toMatchObject({
      id: record.id,
    });
    expect(w.jobs).toHaveLength(1);
  });
  it("records no-change repairs as stopped rather than successful delivery", async () => {
    const w = await failed();
    const c = w.controller();
    await c.reconcileQaRework("game");
    const job = w.jobs[0]!;
    await c.beforeDeveloper(
      job,
      {
        kind: "developer",
        delivery: {
          ticket: w.ticket.identifier,
          title: "Repair saved name",
          base: "pm-staging",
          branch: `gremlins/${job.id}`,
          repo: TEST_REPO,
          acceptanceCriteria: ["The saved name is visible."],
        },
      },
      w.ticket,
    );
    await c.completeJob(
      job,
      { ok: true, kind: "developer", nonce: job.id, noChanges: true },
      {} as DockerRunners,
    );
    expect(w.service.list()[0]!.rework?.phase).toBe("stopped");
    expect(w.service.list()).toHaveLength(1);
  });
});
