import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeForge } from "../forge/fake.ts";
import { FakeGit } from "../git.ts";
import {
  FakeLinear,
  makeHub,
  makeProject,
  TEST_REPO,
} from "../services/fakes.ts";
import type { LocalJob } from "../localRunners/types.ts";
import type {
  DockerJobPayload,
  DockerRunners,
} from "../localRunners/docker.ts";
import { createDeliveryController, deliveryEnvironment } from "./controller.ts";
import { deliveryConfiguration } from "./index.ts";
import { createPromotionExecutor } from "./executor.ts";
import { createSourceControl } from "../sourceControl/index.ts";
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
const HEAD = "a".repeat(40),
  BASE = "b".repeat(40);
function world(realSource = false) {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "gremlins-delivery-controller-")),
  );
  roots.push(root);
  writeFileSync(join(root, "hub.json"), JSON.stringify(makeHub()));
  const project = makeProject({
    config: {
      workflow: { kind: "promotion" },
      vercel: undefined,
      linear: { teamId: "team-1", connectionId: "work" },
      verification: { mode: "browser", environment: "integration" },
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
    description: "## Acceptance criteria\n- Name is visible.",
  });
  forge.seedPull(
    TEST_REPO,
    {
      number: 1,
      headRef: "gremlins/job-one",
      headSha: HEAD,
      baseRef: "pm-staging",
      draft: true,
      mergeableState: "clean",
    },
    ["app/name.ts"],
  );
  forge.seedBranch(TEST_REPO, "pm-staging", BASE);
  const job: LocalJob = {
    id: "job-one",
    runId: 1,
    type: "developer",
    project: "game",
    area: "core",
    ticket: ticket.identifier,
    status: "running",
    createdAt: "2026-10-05T00:00:00Z",
  };
  const payload: DockerJobPayload = {
    kind: "developer",
    nonce: job.id,
    delivery: {
      ticket: ticket.identifier,
      title: "Fix name",
      repo: TEST_REPO,
      branch: "gremlins/job-one",
      base: "pm-staging",
      acceptanceCriteria: ["Name is visible."],
    },
  };
  const source = vi.fn(async () => ({
    token: "source-secret",
    method: "token" as const,
  }));
  const connectionFor = vi.fn(() => ({
    resolveCredential: async () => ({
      token: "linear-secret",
      authorization: "linear-secret",
      method: "token" as const,
    }),
  }));
  const check = vi.fn(async () => ({ ok: true, output: "passed" }));
  const executor = vi.fn(async () => {
    let sha = BASE;
    return {
      checkoutDir: root,
      git: {
        run: async (args: string[]) => {
          if (args[0] === "checkout") sha = args[2]!;
          return { code: 0, out: sha, err: "" };
        },
      },
      check,
    };
  }) as unknown as typeof createPromotionExecutor;
  const sourceAccess = realSource
    ? createSourceControl({
        root,
        env: { GITHUB_TOKEN: "synthetic-delivery-source-token" },
        fetch: async (input, init) => {
          expect(String(input)).toBe("https://api.github.com/user");
          expect(init?.method ?? "GET").toBe("GET");
          expect(new Headers(init?.headers).get("authorization")).toBe(
            "Bearer synthetic-delivery-source-token",
          );
          return new Response(
            JSON.stringify({ id: 123, login: "delivery-source-account" }),
          );
        },
      })
    : { resolveCredential: source };
  const controller = createDeliveryController({
    root,
    loadProject: () => project,
    sourceControl: sourceAccess,
    linearConnectionFor: connectionFor,
    forge: () => forge,
    linear: () => linear,
    resolveEnvironment: async () => ({
      provider: "railway",
      url: "https://preview.example",
      deploymentId: "dep",
      commitSha: BASE,
      branch: "pm-staging",
    }),
    docker: { ensureImage: async () => "shipgremlins-local:aaaaaaaaaaaaaaaa" },
    executor,
    now: () => new Date("2026-10-05T12:00:00Z"),
  });
  const result = {
    ok: true,
    kind: "developer",
    nonce: job.id,
    commitSha: BASE,
    headSha: HEAD,
    prUrl: `https://github.com/${TEST_REPO}/pull/1`,
    checks: ["install", "test"],
  };
  return {
    root,
    project,
    forge,
    linear,
    ticket,
    job,
    payload,
    source,
    sourceAccess,
    executor,
    connectionFor,
    controller,
    check,
    result,
  };
}
const noArtifacts = {} as DockerRunners;
describe("local delivery controller integration", () => {
  it("uses valid real source lease identifiers for independent checks and promotion, releasing both on completion or failure", async () => {
    const w = world(true);
    const source = w.sourceAccess as ReturnType<typeof createSourceControl>;
    const acquire = vi.spyOn(source, "acquireLease"),
      release = vi.spyOn(source, "releaseLease");
    await w.controller.beforeDeveloper(w.job, w.payload, w.ticket);
    await w.controller.completeJob(w.job, w.result, noArtifacts);
    expect(acquire).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: expect.stringMatching(/^job-checks-[a-f0-9]{24}$/),
      }),
    );
    expect(w.check).toHaveBeenCalledOnce();
    // The real credential contract is exercised before the normal later gate:
    // this unreviewed delivery must still not be packaged for staging.
    await expect(
      w.controller.preparePromotion("game", {
        docker: {
          ensureImage: async () => "shipgremlins-local:aaaaaaaaaaaaaaaa",
        },
      }),
    ).rejects.toThrow("verified deliveries");
    expect(acquire).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: expect.stringMatching(/^job-promotion-[a-f0-9]{24}$/),
        write: true,
      }),
    );
    expect(release.mock.calls.map(([id]) => id)).toEqual(
      acquire.mock.calls.map(([input]) => input.jobId),
    );
    expect(w.executor).toHaveBeenCalledTimes(2);
    expect(w.forge.merged).toEqual([]);
    expect(w.linear.stateUpdates).toEqual([]);
  });
  it("captures the approved ticket before launch and registers the actual exact-head draft idempotently", async () => {
    const w = world();
    await w.controller.beforeDeveloper(w.job, w.payload, w.ticket);
    await w.controller.completeJob(w.job, w.result, noArtifacts);
    await w.controller.completeJob(w.job, w.result, noArtifacts);
    expect(w.controller.deliveryStatus("game").deliveries).toHaveLength(1);
    expect(w.connectionFor).toHaveBeenCalledWith("work");
    expect(w.linear.stateUpdates).toEqual([]);
  });
  it("preserves the original approval snapshot when live ticket text changes", async () => {
    const w = world();
    await w.controller.beforeDeveloper(w.job, w.payload, w.ticket);
    w.ticket.description = "Changed scope";
    await w.controller.completeJob(w.job, w.result, noArtifacts);
    expect(
      w.controller.deliveryStatus("game").deliveries[0]!.ticket.description,
    ).toContain("Acceptance criteria");
    await w.controller.advanceIntegration("game");
    expect(w.forge.merged).toEqual([]);
    expect(w.controller.deliveryStatus("game").deliveries[0]!.status).toBe(
      "blocked",
    );
  });
  it("queues an owning-PM review only for the exact ready integration containing approved work", async () => {
    const w = world();
    await w.controller.beforeDeveloper(w.job, w.payload, w.ticket);
    await w.controller.completeJob(w.job, w.result, noArtifacts);
    expect(await w.controller.pendingReviews("game")).toEqual([]);
    w.forge.seedPull(TEST_REPO, {
      number: 1,
      headRef: "gremlins/job-one",
      headSha: HEAD,
      baseRef: "pm-staging",
      state: "merged",
      mergeCommitSha: BASE,
      mergedAt: "2026-10-05T10:00:00Z",
    });
    w.project.areas[0]!.enabled = false;
    const jobs = await w.controller.pendingReviews("game");
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      type: "pm",
      project: "game",
      area: "core",
      runOnce: true,
      idempotencyKey: expect.stringMatching(/^delivery-review:[a-f0-9]{64}$/),
    });
    expect(await w.controller.pendingReviews("game")).toEqual(jobs);
    w.project.areas[0]!.codingEnabled = false;
    expect(await w.controller.pendingReviews("game")).toEqual(jobs);
    w.forge.seedChecks(TEST_REPO, BASE, { status: "pending", failedJobs: [] });
    expect(await w.controller.pendingReviews("game")).toEqual([]);
    w.forge.seedChecks(TEST_REPO, BASE, { status: "success", failedJobs: [] });
    w.forge.seedBranch(TEST_REPO, "pm-staging", HEAD);
    expect(await w.controller.pendingReviews("game")).toEqual([]);
    w.forge.seedBranch(TEST_REPO, "pm-staging", BASE);
    w.forge.seedCompare(TEST_REPO, BASE, BASE, { aheadBy: 0, behindBy: 1 });
    expect(await w.controller.pendingReviews("game")).toEqual([]);
    w.forge.seedCompare(TEST_REPO, BASE, BASE, { aheadBy: 0, behindBy: 0 });
    w.ticket.description = "## Acceptance criteria\n- Different owner scope.";
    expect(await w.controller.pendingReviews("game")).toEqual([]);
    expect(w.forge.merged).toEqual([]);
    expect(w.linear.stateUpdates).toEqual([]);
  });
  it("rejects a changed published head and mismatched provider URL", async () => {
    const w = world();
    await w.controller.beforeDeveloper(w.job, w.payload, w.ticket);
    await expect(
      w.controller.completeJob(
        w.job,
        { ...w.result, headSha: BASE },
        noArtifacts,
      ),
    ).rejects.toThrow("draft moved");
    await expect(
      w.controller.completeJob(
        w.job,
        { ...w.result, prUrl: "https://evil.example/pull/1" },
        noArtifacts,
      ),
    ).rejects.toThrow("exact source-provider");
    expect(w.controller.deliveryStatus("game").deliveries).toEqual([]);
  });
  it("uses trusted local coding and integration checks when provider CI is absent", async () => {
    const w = world();
    w.check.mockImplementation(async () => {
      expect(
        existsSync(join(w.root, ".run", "delivery", "game", "write.lock")),
      ).toBe(false);
      return { ok: true, output: "independent checks outside ledger lock" };
    });
    await w.controller.beforeDeveloper(w.job, w.payload, w.ticket);
    await w.controller.completeJob(w.job, w.result, noArtifacts);
    await w.controller.advanceIntegration("game");
    expect(w.check).toHaveBeenCalledTimes(2);
    expect(w.forge.merged).toEqual([1]);
  });
  it.each(["pending", "failure"] as const)(
    "does not bypass explicit provider %s with local receipts",
    async (status) => {
      const w = world();
      await w.controller.beforeDeveloper(w.job, w.payload, w.ticket);
      await w.controller.completeJob(w.job, w.result, noArtifacts);
      w.forge.seedChecks(TEST_REPO, HEAD, { status, failedJobs: [] });
      await w.controller.advanceIntegration("game");
      expect(w.check).toHaveBeenCalledOnce();
      expect(w.forge.merged).toEqual([]);
    },
  );
  it("continues ordinary PM observation while delivery deployment evidence is unavailable", async () => {
    const w = world();
    await w.controller.beforeDeveloper(w.job, w.payload, w.ticket);
    await w.controller.completeJob(w.job, w.result, noArtifacts);
    w.forge.seedChecks(TEST_REPO, BASE, { status: "pending", failedJobs: [] });
    const patrol = { ...w.job, id: "job-patrol", type: "pm" as const };
    const payload = await w.controller.beforePm(patrol, {
      kind: "pm",
      nonce: patrol.id,
      branch: "pm-staging",
      browserVerification: true,
      prompt: "Inspect the app",
    });
    expect(payload.reviewPlan).toBeUndefined();
    expect(payload.prompt).toContain("do not claim delivery verification");
    await expect(
      w.controller.beforePm(
        {
          ...patrol,
          id: "job-triggered-review",
          idempotencyKey: "delivery-review:exact-deployment",
        },
        {
          kind: "pm",
          nonce: "job-triggered-review",
          branch: "pm-staging",
          browserVerification: true,
        },
      ),
    ).rejects.toThrow("deployment-triggered review");
  });
  it("selects a separate Railway candidate without invalidating integration approval", async () => {
    const w = world(),
      before = deliveryConfiguration(w.project, "core");
    w.project.config.environments!.candidate = {
      kind: "railway",
      role: "preview",
      projectId: "project",
      environmentId: "candidate-env",
      serviceId: "candidate-service",
    };
    w.project.config.workflow = {
      kind: "promotion",
      candidateEnvironment: "candidate",
    };
    expect(deliveryConfiguration(w.project, "core")).toBe(before);
    expect(deliveryEnvironment(w.project, "pm-staging")).toMatchObject({
      environmentId: "env",
      branch: "pm-staging",
    });
    expect(
      deliveryEnvironment(w.project, "pm-release/core/20261006"),
    ).toMatchObject({
      environmentId: "candidate-env",
      serviceId: "candidate-service",
      branch: "pm-release/core/20261006",
    });
    expect(w.controller.deliveryStatus("game").candidateEnvironment).toBe(
      "candidate",
    );
  });
  it("uses only the separate replay result, never a forged model-container proof", async () => {
    const w = world();
    await w.controller.beforeDeveloper(w.job, w.payload, w.ticket);
    await w.controller.completeJob(w.job, w.result, noArtifacts);
    w.forge.seedPull(
      TEST_REPO,
      {
        number: 1,
        headRef: "gremlins/job-one",
        headSha: HEAD,
        baseRef: "pm-staging",
        state: "merged",
        mergeCommitSha: BASE,
        mergedAt: "2026-10-05T10:00:00Z",
      },
      ["app/name.ts"],
    );
    const job = { ...w.job, id: "job-review", type: "pm" as const };
    const payload = await w.controller.beforePm(job, {
      kind: "pm",
      nonce: job.id,
      branch: "pm-staging",
      browserVerification: true,
      prompt: "Review",
    });
    const plan = payload.reviewPlan!;
    expect(plan).toBeDefined();
    expect(payload.browserTarget).toBe(plan.deployment.url);
    const original = {
      ok: true,
      kind: "pm",
      nonce: job.id,
      commitSha: HEAD,
      reviewProof: { file: "fake.json", sha256: "f".repeat(64) },
    };
    await expect(
      w.controller.completeJob(job, original, noArtifacts),
    ).rejects.toThrow("isolated delivery review");
    const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]),
      sha256 = createHash("sha256").update(png).digest("hex");
    const proof = {
      manifest: {
        schema: 1,
        planId: plan.id,
        jobId: job.id,
        project: "game",
        area: "core",
        testedSha: BASE,
        deploymentId: "dep",
        deliveries: [
          {
            id: w.job.id,
            status: "passed",
            assertions: [
              {
                criterion: plan.deliveries[0]!.criteria[0],
                status: "passed",
                receiptId: "receipt",
              },
            ],
            screenshots: [{ name: "review-screenshots/trusted.png", sha256 }],
          },
        ],
      },
      receipts: {
        jobId: job.id,
        planId: plan.id,
        commitSha: BASE,
        receipts: [
          {
            id: "receipt",
            jobId: job.id,
            planId: plan.id,
            deliveryId: w.job.id,
            criterion: plan.deliveries[0]!.criteria[0],
            status: "passed",
            testedSha: BASE,
            deploymentId: "dep",
            url: "https://preview.example",
            screenshot: { name: "review-screenshots/trusted.png", sha256 },
          },
        ],
      },
    };
    const verifyReview = vi.fn(async () => ({
      proof: Buffer.from(JSON.stringify(proof)),
      result: {
        ok: true as const,
        kind: "pm" as const,
        nonce: job.id,
        commitSha: BASE,
      },
      files: [],
    }));
    const readArtifact = vi.fn(async () => png);
    await w.controller.completeJob(job, original, {
      verifyReview,
      readArtifact,
    } as unknown as DockerRunners);
    expect(verifyReview).toHaveBeenCalledOnce();
    expect(readArtifact).toHaveBeenCalledWith(
      job.id,
      "review-screenshots/trusted.png",
    );
    expect(w.controller.deliveryStatus("game").deliveries[0]!.status).toBe(
      "verified",
    );
    const candidateSha = "c".repeat(40),
      stagingSha = "d".repeat(40);
    w.forge.seedBranch(TEST_REPO, "staging", stagingSha);
    const git = new FakeGit()
      .when("merge-base --is-ancestor", { code: 1 })
      .when("rev-parse HEAD", candidateSha)
      .when("rev-parse origin/staging", stagingSha);
    const verifyCandidate = vi.fn(async () => ({
      ok: false as const,
      reason: "Trusted candidate evidence pending",
    }));
    await w.controller.promote("game", {
      git,
      checkoutDir: w.root,
      check: async () => ({ ok: true, output: "independent candidate checks" }),
      verifyCandidate,
    });
    expect(verifyCandidate).toHaveBeenCalledOnce();
    const handoff = w.controller.deliveryStatus("game").candidates[0];
    expect(handoff).toMatchObject({
      project: "game",
      repo: TEST_REPO,
      area: "core",
      candidateSha,
      baseSha: stagingSha,
      changes: [1],
    });
    expect(JSON.stringify(handoff)).not.toContain("secret");
    const restarted = createDeliveryController({
      root: w.root,
      loadProject: () => w.project,
    });
    expect(restarted.deliveryStatus("game").candidates).toEqual([handoff]);
    w.project.areas[0]!.instanceId = "d6c5fa4b-a631-4c17-9d5e-8b9b8c790eea";
    expect(restarted.deliveryStatus("game").candidates).toEqual([]);
    expect(restarted.deliveryStatus("game").deliveries).toEqual([]);
    delete w.project.areas[0]!.instanceId;
    expect(restarted.deliveryStatus("game").candidates).toEqual([handoff]);
    expect(await w.forge.listOpenPulls(TEST_REPO, { base: "staging" })).toEqual(
      [],
    );
  });
});
