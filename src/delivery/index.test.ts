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
      verdict: "verified",
    });
    expect(w.linear.stateUpdates).toEqual([]);
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
