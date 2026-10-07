import { afterEach, describe, expect, it, vi } from "vitest";
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeForge } from "../forge/fake.ts";
import { FakeLinear, makeProject, TEST_REPO } from "../services/fakes.ts";
import {
  acceptanceCriteria,
  createDeliveryService,
  type PmReviewManifest,
} from "./index.ts";
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
const HEAD = "a".repeat(40),
  MERGE = "b".repeat(40),
  DEPLOY = "c".repeat(40);
it("does not attach a deleted project's delivery ledger to its same-name replacement", async () => {
  const w = world();
  await w.service.register(w.input);
  expect(w.service.list()).toHaveLength(1);
  const original = readFileSync(
    join(w.root, ".run/delivery", w.project.config.name, "state.json"),
  );
  w.project.config.instanceId = "a1b2c3d4-1111-2222-3333-444444444444";
  expect(w.create().list()).toEqual([]);
  expect(
    readFileSync(
      join(w.root, ".run/delivery", w.project.config.name, "state.json"),
    ),
  ).toEqual(original);
});
function world() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "gremlins-delivery-")));
  roots.push(root);
  const project = makeProject({
    config: { linear: { teamId: "team-1" }, workflow: { kind: "promotion" } },
  });
  const forge = new FakeForge();
  const linear = new FakeLinear();
  const ticket = linear.seedTicket({
    projectId: "lin_core",
    labels: ["pm:core", "pm-approved"],
    description:
      "## Acceptance criteria\n- The saved name is visible.\n- The old name is absent.\n## Out of scope\n- Billing",
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
  forge.seedBranch(TEST_REPO, "pm-staging", DEPLOY);
  forge.seedChecks(TEST_REPO, DEPLOY, { status: "success", failedJobs: [] });
  const create = () =>
    createDeliveryService({
      root,
      project,
      forge,
      linear,
      now: () => new Date("2026-10-05T12:00:00Z"),
    });
  const service = create();
  const input = {
    jobId: "job-one",
    area: "core",
    ticket,
    pullNumber: 1,
    approvedBy: "owner",
    approvedAt: "2026-10-05T11:00:00Z",
  };
  const deployment = {
    id: "dep-one",
    url: "https://preview.example",
    sha: DEPLOY,
    branch: "pm-staging",
    provider: "railway",
    state: "READY" as const,
  };
  const merge = () =>
    forge.seedPull(
      TEST_REPO,
      {
        number: 1,
        headRef: "gremlins/job-one",
        headSha: HEAD,
        baseRef: "pm-staging",
        state: "merged",
        mergeCommitSha: MERGE,
        mergedAt: "2026-10-05T11:10:00Z",
      },
      ["app/name.ts"],
    );
  return {
    root,
    project,
    forge,
    linear,
    ticket,
    service,
    create,
    input,
    deployment,
    merge,
  };
}
async function admitted() {
  const w = world();
  await w.service.register(w.input);
  w.merge();
  const plan = (await w.service.prepareReview({
    area: "core",
    jobId: "job-review",
    deployment: w.deployment,
  }))!;
  const manifest: PmReviewManifest = {
    schema: 1,
    planId: plan.id,
    jobId: plan.jobId,
    project: "game",
    area: "core",
    testedSha: DEPLOY,
    deploymentId: "dep-one",
    deliveries: [
      {
        id: "job-one",
        status: "passed",
        assertions: plan.deliveries[0]!.criteria.map((criterion, i) => ({
          criterion,
          status: "passed",
          receiptId: `receipt-${i}`,
        })),
        screenshots: [
          { name: "review-screenshots/test.png", sha256: "d".repeat(64) },
        ],
      },
    ],
  };
  const ingestion = {
    planId: plan.id,
    manifest,
    trustedResult: {
      ok: true,
      kind: "pm",
      nonce: plan.jobId,
      commitSha: DEPLOY,
    },
    deployment: w.deployment,
    verifyArtifact: vi.fn(async () => true),
    verifyAssertion: vi.fn(async () => true),
  };
  return { ...w, plan, manifest, ingestion };
}
it("preserves a stale historical delivery without blocking a current owning-PM review", async () => {
  const w = world();
  await w.service.register(w.input);
  w.merge();
  w.project.config.commands.test = "npm run revised-test";
  const ticket = w.linear.seedTicket({
    projectId: "lin_core",
    labels: ["pm:core", "pm-approved"],
    description: "## Acceptance criteria\n- New behavior is visible.",
  });
  w.forge.seedPull(
    TEST_REPO,
    {
      number: 2,
      headRef: "gremlins/job-two",
      headSha: "d".repeat(40),
      baseRef: "pm-staging",
      draft: true,
    },
    ["app/name.ts"],
  );
  await w.service.register({
    ...w.input,
    jobId: "job-two",
    ticket,
    pullNumber: 2,
  });
  w.forge.seedPull(
    TEST_REPO,
    {
      number: 2,
      headRef: "gremlins/job-two",
      headSha: "d".repeat(40),
      baseRef: "pm-staging",
      state: "merged",
      mergeCommitSha: MERGE,
      mergedAt: "2026-10-05T11:10:00Z",
    },
    ["app/name.ts"],
  );
  expect(
    (await w.service.reviewCandidates(w.deployment)).map((r) => r.id),
  ).toEqual(["job-two"]);
  const plan = await w.service.prepareReview({
    area: "core",
    jobId: "job-review-two",
    deployment: w.deployment,
  });
  expect(plan?.deliveries.map((r) => r.id)).toEqual(["job-two"]);
  expect(w.service.list().find((r) => r.id === "job-one")?.status).toBe(
    "blocked",
  );
});
it("ports a conflicted verified ticket once, integrates it automatically, and requires fresh owning-PM QA of the isolated source", async () => {
  const w = await admitted();
  await w.service.ingestReview(w.ingestion);
  const staging = "8".repeat(40),
    source = "9".repeat(40),
    head = "e".repeat(40),
    merged = "f".repeat(40);
  w.forge.seedBranch(TEST_REPO, "staging", staging);
  const intent = (await w.service.reservePromotionRepair(1, staging))!;
  expect(intent.promotionRepair).toMatchObject({
    phase: "queued",
    sourceDeliveryIds: ["job-one"],
    sourceShas: [MERGE],
    allowedPaths: ["app/name.ts"],
  });
  expect(w.service.list()[0]!.status).toBe("blocked");
  expect(
    await w.service.prepareReview({
      area: "core",
      jobId: "job-too-early",
      deployment: w.deployment,
    }),
  ).toBeNull();
  const job = {
    id: "job-port",
    runId: 2,
    type: "developer" as const,
    developerKind: "port" as const,
    project: "game",
    area: "core",
    ticket: w.ticket.identifier,
    attempt: 1,
    runOnce: true,
    idempotencyKey: intent.promotionRepair!.key,
    status: "running" as const,
    createdAt: "2026-10-05T12:00:00Z",
  };
  await w.service.admitPromotionRepair(job);
  w.forge.seedPull(
    TEST_REPO,
    {
      number: 2,
      headRef: "gremlins/job-port",
      headSha: head,
      baseRef: "pm-staging",
      draft: true,
      mergeableState: "clean",
    },
    [],
  );
  w.forge.seedCompare(TEST_REPO, staging, source, { aheadBy: 1, behindBy: 0 });
  const repair = await w.service.register({
    ...w.input,
    jobId: job.id,
    pullNumber: 2,
    promotionRepairKey: intent.promotionRepair!.key,
    promotionSourceSha: source,
    promotionBaseSha: staging,
    expectedHeadSha: head,
  });
  expect(repair.promotionSource).toEqual({
    sha: source,
    baseSha: staging,
    paths: ["app/name.ts"],
  });
  expect(w.service.list()[0]!.supersededBy).toBe(job.id);
  expect(
    await w.service.promotionOptions().candidateVerdict!(
      (await w.forge.getPull(TEST_REPO, 2))!,
    ),
  ).toMatchObject({ verdict: "untested", sourceSha: source });
  w.forge.seedChecks(TEST_REPO, head, { status: "success", failedJobs: [] });
  // A pure lineage merge can have no integration diff; its standalone source is still nonempty and checked.
  await w.service.advanceIntegration(async () => true);
  expect(w.forge.merged).toEqual([2]);
  w.forge.patchPull(TEST_REPO, 2, { state: "merged", mergeCommitSha: merged });
  w.forge.seedBranch(TEST_REPO, "pm-staging", merged);
  w.forge.seedChecks(TEST_REPO, merged, { status: "success", failedJobs: [] });
  const deployment = { ...w.deployment, id: "port-deploy", sha: merged };
  const plan = (await w.service.prepareReview({
    area: "core",
    jobId: "job-port-review",
    deployment,
  }))!;
  expect(plan.deliveries.map((r) => r.id)).toEqual([job.id]);
  await w.service.ingestReview({
    ...w.ingestion,
    planId: plan.id,
    deployment,
    manifest: {
      ...w.manifest,
      planId: plan.id,
      jobId: plan.jobId,
      testedSha: merged,
      deploymentId: deployment.id,
      deliveries: [{ ...w.manifest.deliveries[0]!, id: job.id }],
    },
    trustedResult: {
      ok: true,
      kind: "pm",
      nonce: plan.jobId,
      commitSha: merged,
    },
  });
  expect(
    await w.service.promotionOptions().candidateVerdict!(
      (await w.forge.getPull(TEST_REPO, 2))!,
    ),
  ).toMatchObject({
    verdict: "verified",
    ticketId: w.ticket.id,
    sourceSha: source,
    sourcePaths: ["app/name.ts"],
  });
  expect(
    await w.service.promotionOptions().candidatePullNumbers!("core"),
  ).toEqual([2]);
  // Later staging drift cannot silently reset the one-port budget.
  expect(await w.service.reservePromotionRepair(2, staging)).toBeNull();
  expect(w.service.list().find((r) => r.id === job.id)!.message).toContain(
    "one automatic promotion port",
  );
});

it("stops an isolated port if its admitted baseline or source scope changes", async () => {
  const w = await admitted();
  await w.service.ingestReview(w.ingestion);
  const staging = "8".repeat(40);
  w.forge.seedBranch(TEST_REPO, "staging", staging);
  const original = (await w.service.reservePromotionRepair(1, staging))!;
  const job = {
    id: "job-port",
    runId: 2,
    type: "developer" as const,
    developerKind: "port" as const,
    project: "game",
    area: "core",
    ticket: w.ticket.identifier,
    attempt: 1,
    runOnce: true,
    idempotencyKey: original.promotionRepair!.key,
    status: "queued" as const,
    createdAt: "2026-10-05T12:00:00Z",
  };
  w.forge.seedBranch(TEST_REPO, "staging", "7".repeat(40));
  await expect(w.service.admitPromotionRepair(job)).rejects.toThrow("baseline");
  expect(w.service.list()[0]!.supersededBy).toBeUndefined();
});
it("recovers a lost close response from a durable promotion-retirement intent", async () => {
  const w = await admitted();
  await w.service.ingestReview(w.ingestion);
  const staging = "8".repeat(40),
    promotionHead = "7".repeat(40);
  w.forge.seedBranch(TEST_REPO, "staging", staging);
  const pull = w.forge.seedPull(TEST_REPO, {
    number: 20,
    baseRef: "staging",
    headRef: "pm-release/core/test",
    headSha: promotionHead,
    state: "open",
    draft: false,
  });
  await w.service.recordPromotion({
    deliveryIds: ["job-one"],
    pullNumber: 20,
    candidate: {
      checkoutDir: w.root,
      branch: "candidate/test",
      releaseBranch: pull.headRef,
      sha: promotionHead,
      baseSha: staging,
      changes: [1],
    },
    reviewedCandidate: true,
    trustedAuthor: pull.author,
  });
  const read = vi.spyOn(w.forge, "getPull"),
    close = w.forge.closePull.bind(w.forge);
  vi.spyOn(w.forge, "closePull").mockImplementation(async (repo, number) => {
    const saved = JSON.parse(
      readFileSync(join(w.root, ".run/delivery/game/state.json"), "utf8"),
    );
    expect(saved.records[0].promotionRepair.phase).toBe("queued");
    await close(repo, number);
    read.mockRejectedValueOnce(new Error("provider unavailable after close"));
    throw new Error("lost close response");
  });
  await expect(w.service.reservePromotionRepair(1, staging)).rejects.toThrow(
    "provider unavailable",
  );
  const restarted = w.create();
  expect(restarted.list()[0]!.promotion?.number).toBe(20);
  expect(
    (await restarted.reservePromotionRepair(1, staging))?.promotionRepair
      ?.phase,
  ).toBe("queued");
  expect(restarted.list()[0]!.promotion).toBeUndefined();
  expect(restarted.list()[0]!.promotionHistory).toHaveLength(1);
  expect(w.forge.closed).toEqual([20]);
});
it.each([false, true])(
  "retires only its exact unchanged promotion for repair (user moved head: %s)",
  async (moved) => {
    const w = await admitted();
    await w.service.ingestReview(w.ingestion);
    const staging = "8".repeat(40),
      promotionHead = "7".repeat(40);
    w.forge.seedBranch(TEST_REPO, "staging", staging);
    const pull = w.forge.seedPull(TEST_REPO, {
      number: 20,
      baseRef: "staging",
      headRef: "pm-release/core/test",
      headSha: promotionHead,
      state: "open",
      draft: false,
    });
    await w.service.recordPromotion({
      deliveryIds: ["job-one"],
      pullNumber: 20,
      candidate: {
        checkoutDir: w.root,
        branch: "candidate/test",
        releaseBranch: pull.headRef,
        sha: promotionHead,
        baseSha: staging,
        changes: [1],
      },
      reviewedCandidate: true,
      trustedAuthor: pull.author,
    });
    if (moved) w.forge.patchPull(TEST_REPO, 20, { headSha: "6".repeat(40) });
    expect(await w.service.promotionOptions().currentPromotion!(pull)).toBe(
      !moved,
    );
    const admittedPort = await w.service.reservePromotionRepair(1, staging);
    if (moved) {
      expect(admittedPort).toBeNull();
      expect(w.forge.closed).toEqual([]);
      expect(w.service.list()[0]!.promotion?.number).toBe(20);
    } else {
      expect(admittedPort?.promotionRepair?.phase).toBe("queued");
      expect(w.forge.closed).toEqual([20]);
      expect(w.service.list()[0]!.promotion).toBeUndefined();
      expect(w.service.list()[0]!.promotionHistory).toEqual([
        expect.objectContaining({ number: 20, headSha: promotionHead }),
      ]);
      expect(
        await w.service.promotionOptions().candidateVerdict!(
          (await w.forge.getPull(TEST_REPO, 1))!,
        ),
      ).toMatchObject({ rebuildingBatch: true, verdict: "untested" });
    }
  },
);
describe("durable owning-PM delivery", () => {
  it("does not assign a deleted PM's deliveries to a new PM with the same ID", async () => {
    const w = world();
    await w.service.register(w.input);
    const stateFile = join(w.root, ".run", "delivery", "game", "state.json");
    const oldRecord = JSON.parse(readFileSync(stateFile, "utf8")).records[0];
    w.project.areas[0]!.instanceId = "d6c5fa4b-a631-4c17-9d5e-8b9b8c790eea";
    expect(w.create().list()).toEqual([]);
    await expect(
      w.create().advanceIntegration(async () => true),
    ).resolves.toBeNull();
    await expect(
      w.create().prepareReview({
        area: "core",
        jobId: "job-fresh-review",
        deployment: w.deployment,
      }),
    ).resolves.toBeNull();
    expect(w.forge.merged).toEqual([]);
    expect(JSON.parse(readFileSync(stateFile, "utf8")).records[0]).toEqual(
      oldRecord,
    );
    await expect(w.create().register(w.input)).rejects.toThrow("changed");
    const pull = (await w.forge.getPull(TEST_REPO, 1))!;
    expect(
      await w.create().promotionOptions().candidateVerdict!(pull),
    ).toBeNull();
    w.forge.seedPull(
      TEST_REPO,
      { ...pull, number: 2, headRef: "gremlins/job-two" },
      ["app/name.ts"],
    );
    const fresh = await w
      .create()
      .register({ ...w.input, jobId: "job-two", pullNumber: 2 });
    expect(fresh.areaInstanceId).toBe(w.project.areas[0]!.instanceId);
    expect(
      w
        .create()
        .list()
        .map((r) => r.id),
    ).toEqual(["job-two"]);
    expect(JSON.parse(readFileSync(stateFile, "utf8")).records).toHaveLength(2);
  });
  it("registers exact approved draft once and survives controller restart", async () => {
    const w = world();
    await w.service.register(w.input);
    await w.create().register(w.input);
    expect(w.create().list()).toHaveLength(1);
    expect(w.linear.stateUpdates).toEqual([]);
    await expect(
      w.service.register({
        ...w.input,
        ticket: { ...w.ticket, teamId: "other" },
      }),
    ).rejects.toThrow("approved work");
  });
  it("requires the exact branch deployment and successful integration checks", async () => {
    const w = world();
    await w.service.register(w.input);
    w.merge();
    await expect(
      w.service.prepareReview({
        area: "core",
        jobId: "job-review",
        deployment: { ...w.deployment, sha: HEAD },
      }),
    ).rejects.toThrow("Integration moved");
    w.forge.seedChecks(TEST_REPO, DEPLOY, {
      status: "pending",
      failedJobs: [],
    });
    await expect(
      w.service.prepareReview({
        area: "core",
        jobId: "job-review",
        deployment: w.deployment,
      }),
    ).rejects.toThrow("checks must succeed");
  });
  it("does not turn partial criteria or model pass claims into verification", async () => {
    const w = await admitted();
    w.manifest.deliveries[0]!.assertions.pop();
    expect((await w.service.ingestReview(w.ingestion))[0]!.status).toBe(
      "blocked",
    );
    expect(w.ingestion.verifyAssertion).not.toHaveBeenCalled();
    expect(w.linear.stateUpdates).toEqual([]);
  });
  it("requires actual assertion and artifact receipts", async () => {
    const w = await admitted();
    w.ingestion.verifyArtifact.mockResolvedValue(false);
    expect((await w.service.ingestReview(w.ingestion))[0]!.status).toBe(
      "blocked",
    );
  });
  it("accepts complete exact evidence, is idempotent, and never marks Done", async () => {
    const w = await admitted();
    await w.service.ingestReview(w.ingestion);
    expect(w.create().list()[0]!.status).toBe("verified");
    await w.service.ingestReview(w.ingestion);
    expect(w.ingestion.verifyAssertion).toHaveBeenCalledTimes(2);
    const pull = (await w.forge.getPull(TEST_REPO, 1))!;
    expect(await w.service.promotionOptions().candidateVerdict!(pull)).toEqual({
      area: "core",
      ticketId: w.ticket.id,
      verdict: "verified",
    });
    expect(w.linear.stateUpdates).toEqual([]);
  });
  it("feeds admitted current-area PR IDs plus open carried lineages, without crowding released history into new batches", async () => {
    const w = await admitted();
    await w.service.ingestReview(w.ingestion);
    const file = join(w.root, ".run/delivery/game/state.json"),
      state = JSON.parse(readFileSync(file, "utf8"));
    const original = state.records[0];
    for (const [number, promotionNumber] of [
      [2, 20],
      [3, 21],
    ]) {
      const branch = `pm-release/core/batch-${promotionNumber}`;
      state.records.push({
        ...original,
        id: `job-${number}`,
        jobId: `job-${number}`,
        status: "promoted",
        implementation: { ...original.implementation, number },
        promotion: {
          number: promotionNumber,
          branch,
          headSha: HEAD,
          url: `https://github.com/${TEST_REPO}/pull/${promotionNumber}`,
        },
      });
      w.forge.seedPull(TEST_REPO, {
        number: promotionNumber,
        baseRef: "staging",
        headRef: branch,
        headSha: HEAD,
        state: promotionNumber === 20 ? "merged" : "open",
      });
    }
    state.records.push({
      ...original,
      id: "superseded",
      supersededBy: "job-one",
      implementation: { ...original.implementation, number: 4 },
    });
    writeFileSync(file, JSON.stringify(state));
    const options = w.service.promotionOptions();
    expect(await options.candidatePullNumbers!("core")).toEqual([1, 3]);
    expect(await options.candidatePullNumbers!("other")).toEqual([]);
    w.forge.patchPull(TEST_REPO, 21, { state: "closed" });
    expect(await options.candidatePullNumbers!("core")).toEqual([1]);
    w.project.config.commands.test = "npm run changed-checks";
    expect(await options.candidatePullNumbers!("core")).toEqual([]);
    expect(
      await options.candidateVerdict!((await w.forge.getPull(TEST_REPO, 1))!),
    ).toBeNull();
  });
  it("rejects wrong job proof without overwriting earlier state", async () => {
    const w = await admitted();
    const file = join(w.root, ".run/delivery/game/state.json"),
      before = readFileSync(file);
    await expect(
      w.service.ingestReview({
        ...w.ingestion,
        trustedResult: { ...w.ingestion.trustedResult, nonce: "other" },
      }),
    ).rejects.toThrow("not bound");
    expect(readFileSync(file)).toEqual(before);
  });
  it("withdrawn approval invalidates even a formerly verified delivery", async () => {
    const w = await admitted();
    await w.service.ingestReview(w.ingestion);
    w.ticket.labels = [];
    const pull = (await w.forge.getPull(TEST_REPO, 1))!;
    expect(
      (await w.service.promotionOptions().candidateVerdict!(pull))?.verdict,
    ).toBe("untested");
    await expect(w.service.ingestReview(w.ingestion)).rejects.toThrow(
      "approved ticket changed",
    );
  });
  it("preserves corrupt state rather than resetting it", async () => {
    const w = world();
    await w.service.register(w.input);
    const file = join(w.root, ".run/delivery/game/state.json");
    writeFileSync(file, "not JSON");
    expect(() => w.create().list()).toThrow();
    expect(readFileSync(file, "utf8")).toBe("not JSON");
  });
  it("merge advances only one exact approved owned change after healthy checks", async () => {
    const w = world();
    await w.service.register(w.input);
    w.forge.seedChecks(TEST_REPO, HEAD, { status: "success", failedJobs: [] });
    await w.service.advanceIntegration(async () => false);
    expect(w.forge.merged).toEqual([]);
    await w.service.advanceIntegration(async () => true);
    expect(w.forge.merged).toEqual([1]);
    expect(w.service.list()[0]!.status).toBe("awaiting-deployment");
  });
  it("does not let a stale delivery jam current approved work", async () => {
    const w = world();
    await w.service.register(w.input);
    w.project.config.commands.test = "npm run updated-test";
    w.forge.seedPull(
      TEST_REPO,
      {
        number: 2,
        headRef: "gremlins/job-two",
        headSha: MERGE,
        baseRef: "pm-staging",
        draft: true,
        mergeableState: "clean",
      },
      ["app/name.ts"],
    );
    await w.service.register({ ...w.input, jobId: "job-two", pullNumber: 2 });
    w.forge.seedChecks(TEST_REPO, MERGE, { status: "success", failedJobs: [] });
    await w.service.advanceIntegration(async () => true);
    expect(w.forge.merged).toEqual([2]);
    expect(w.service.list()[0]!.status).toBe("blocked");
    expect(w.service.list()[1]!.status).toBe("awaiting-deployment");
  });
  it.each(["head", "author", "base", "approval"])(
    "does not merge when %s changes while lifting a managed draft",
    async (changed) => {
      const w = world();
      await w.service.register(w.input);
      w.forge.seedChecks(TEST_REPO, HEAD, {
        status: "success",
        failedJobs: [],
      });
      const markReady = w.forge.markReady.bind(w.forge);
      vi.spyOn(w.forge, "markReady").mockImplementation(
        async (repo, number) => {
          await markReady(repo, number);
          if (changed === "head")
            w.forge.patchPull(repo, number, { headSha: MERGE });
          if (changed === "author")
            w.forge.patchPull(repo, number, { author: "other" });
          if (changed === "base")
            w.forge.patchPull(repo, number, { baseRef: "main" });
          if (changed === "approval") w.ticket.labels = [];
        },
      );
      await w.service.advanceIntegration(async () => true);
      expect(w.forge.merged).toEqual([]);
      expect(w.service.list()[0]!.status).toBe("blocked");
    },
  );
  it.each(["markReady", "mergePull"] as const)(
    "retries transient %s failures without requiring individual PR management",
    async (operation) => {
      const w = world();
      await w.service.register(w.input);
      w.forge.seedChecks(TEST_REPO, HEAD, {
        status: "success",
        failedJobs: [],
      });
      vi.spyOn(w.forge, operation).mockRejectedValueOnce(
        new Error("private-provider-response"),
      );
      await w.service.advanceIntegration(async () => true);
      expect(w.service.list()[0]).toMatchObject({ status: "awaiting-merge" });
      expect(w.service.list()[0]!.message).toContain("controller will");
      expect(w.service.list()[0]!.message).not.toContain("private-provider");
      expect(w.forge.merged).toEqual([]);
      await w.service.advanceIntegration(async () => true);
      expect(w.forge.merged).toEqual([1]);
    },
  );
  it("recovers an automatic merge response lost by the provider", async () => {
    const w = world();
    await w.service.register(w.input);
    w.forge.seedChecks(TEST_REPO, HEAD, { status: "success", failedJobs: [] });
    const merge = w.forge.mergePull.bind(w.forge);
    vi.spyOn(w.forge, "mergePull").mockImplementationOnce(async (...args) => {
      await merge(...args);
      throw new Error("lost response");
    });
    await w.service.advanceIntegration(async () => true);
    expect(w.service.list()[0]!.status).toBe("awaiting-merge");
    await w.service.advanceIntegration(async () => true);
    expect(w.forge.merged).toEqual([1]);
    expect(w.service.list()[0]!.status).toBe("awaiting-deployment");
  });
  it("accepts a matching provider merge completed while the managed draft is lifted", async () => {
    const w = world();
    await w.service.register(w.input);
    w.forge.seedChecks(TEST_REPO, HEAD, { status: "success", failedJobs: [] });
    const markReady = w.forge.markReady.bind(w.forge);
    vi.spyOn(w.forge, "markReady").mockImplementation(async (repo, number) => {
      await markReady(repo, number);
      await w.forge.mergePull(repo, number, { method: "merge", sha: HEAD });
    });
    await w.service.advanceIntegration(async () => true);
    expect(w.forge.merged).toEqual([1]);
    expect(w.service.list()[0]!.status).toBe("awaiting-deployment");
  });
  it.each([
    ["pending", "clean", "current checks"],
    ["failure", "clean", "bounded coding repair"],
    ["success", "dirty", "No individual PR review"],
    ["success", "behind", "No individual PR review"],
    ["success", "blocked", "Repository rules"],
    ["success", "unknown", "provider to confirm"],
  ] as const)(
    "explains automatic integration waiting for %s checks and %s mergeability",
    async (status, mergeableState, message) => {
      const w = world();
      await w.service.register(w.input);
      w.forge.patchPull(TEST_REPO, 1, { mergeableState });
      w.forge.seedChecks(TEST_REPO, HEAD, { status, failedJobs: [] });
      await w.service.advanceIntegration(async () => true);
      expect(w.forge.merged).toEqual([]);
      expect(w.service.list()[0]!.message).toContain(message);
      expect(w.service.list()[0]!.message).not.toContain("ready for review");
    },
  );
  it("lifts a checked owned draft before refreshing provider mergeability", async () => {
    const w = world();
    await w.service.register(w.input);
    w.forge.seedPull(
      TEST_REPO,
      {
        number: 1,
        headRef: "gremlins/job-one",
        headSha: HEAD,
        baseRef: "pm-staging",
        draft: true,
        mergeableState: "blocked",
      },
      ["app/name.ts"],
    );
    w.forge.seedChecks(TEST_REPO, HEAD, { status: "success", failedJobs: [] });
    await w.service.advanceIntegration(async () => false);
    expect(w.forge.readied).toEqual([]);
    await w.service.advanceIntegration(async () => true);
    expect(w.forge.readied).toEqual([1]);
    expect(w.forge.merged).toEqual([]);
    w.forge.seedPull(
      TEST_REPO,
      {
        number: 1,
        headRef: "gremlins/job-one",
        headSha: HEAD,
        baseRef: "pm-staging",
        draft: false,
        mergeableState: "clean",
      },
      ["app/name.ts"],
    );
    await w.service.advanceIntegration(async () => true);
    expect(w.forge.merged).toEqual([1]);
  });
  it("holds hub control files for owner review and preserves paused automation", async () => {
    const w = world();
    await w.service.register(w.input);
    w.project.areas[0]!.enabled = false;
    w.forge.seedPull(
      TEST_REPO,
      {
        number: 1,
        headRef: "gremlins/job-one",
        headSha: HEAD,
        baseRef: "pm-staging",
        draft: true,
        mergeableState: "clean",
      },
      [".github/workflows/build.yml"],
    );
    w.forge.seedChecks(TEST_REPO, HEAD, { status: "success", failedJobs: [] });
    await w.service.advanceIntegration(async () => true);
    expect(w.forge.merged).toEqual([]);
    expect(w.forge.readied).toEqual([]);
    expect(w.service.list()[0]!.message).toMatch(/Owner review/);
  });
  it.each([
    "app/api/auth/login.ts",
    "prisma/migrations/add-name.sql",
    "new-feature/outside-area-map.ts",
  ])(
    "automatically advances approved %s work to PM QA without individual owner review",
    async (file) => {
      const w = world();
      await w.service.register(w.input);
      w.forge.seedPull(
        TEST_REPO,
        {
          number: 1,
          headRef: "gremlins/job-one",
          headSha: HEAD,
          baseRef: "pm-staging",
          draft: true,
          mergeableState: "clean",
        },
        [file],
      );
      w.forge.seedChecks(TEST_REPO, HEAD, {
        status: "success",
        failedJobs: [],
      });
      await w.service.advanceIntegration(async () => true);
      expect(w.forge.readied).toEqual([1]);
      expect(w.forge.merged).toEqual([1]);
      expect(w.service.list()[0]!.status).toBe("awaiting-deployment");
      expect(w.linear.stateUpdates).toEqual([]);
    },
  );
  it("only extracts finite explicit criteria and excludes neighboring sections", () => {
    expect(
      acceptanceCriteria(
        "## Acceptance criteria\n- [ ] Visible result\n1. Correct access\n## Research\n- unrelated",
      ),
    ).toEqual(["Visible result", "Correct access"]);
    expect(acceptanceCriteria("Looks fine")).toEqual([]);
    expect(
      acceptanceCriteria(
        "## 5. Acceptance criteria and verification\n- Member sees their saved name.\n2) Guest cannot edit it.\n## 6. Owner actions\n- Approve",
      ),
    ).toEqual(["Member sees their saved name.", "Guest cannot edit it."]);
    expect(
      acceptanceCriteria(
        "## Acceptance criteria and verification\nNarrative alone is not a finite criterion list.",
      ),
    ).toEqual([]);
  });
});
