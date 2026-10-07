import { describe, expect, it, vi } from "vitest";
import { makeCtx, TEST_REPO } from "../services/fakes.ts";
import {
  ticketScopeHash,
  type CompletionManifest,
} from "../lifecycle/manifest.ts";
import { reconcileManagedCompletion } from "./managedCompletion.ts";
import type { DeliveryRecord } from "./types.ts";
const HEAD = "a".repeat(40),
  MERGE = "b".repeat(40),
  CANDIDATE = "c".repeat(40),
  PROD = "d".repeat(40);
function world() {
  const ctx = makeCtx();
  ctx.project.config.workflow = { kind: "promotion", approvalPolicy: "epic" };
  ctx.now = () => new Date("2026-10-07T12:00:00Z");
  const ticket = ctx.linear.seedTicket({
    projectId: "lin_core",
    labels: ["pm:core", "pm-approved"],
    description: "Bounded child scope",
    stateType: "started",
    stateId: "working",
    parentId: "epic",
  });
  ctx.linear.workflowStates.push({
    id: "done",
    name: "Done",
    type: "completed",
    teamId: "team-1",
  });
  const implementation = ctx.forge.seedPull(
    TEST_REPO,
    {
      number: 1,
      headRef: "gremlins/job-one",
      headSha: HEAD,
      baseRef: "pm-staging",
      state: "merged",
      mergeCommitSha: MERGE,
      mergedAt: "2026-10-02T12:00:00Z",
    },
    ["app.ts"],
  );
  const promotion = ctx.forge.seedPull(
    TEST_REPO,
    {
      number: 5,
      headRef: "pm-release/core",
      headSha: CANDIDATE,
      baseRef: "staging",
      state: "merged",
      mergeCommitSha: CANDIDATE,
      mergedAt: "2026-10-04T12:00:00Z",
    },
    ["app.ts"],
  );
  const production = ctx.forge.seedPull(
    TEST_REPO,
    {
      number: 9,
      headRef: "staging",
      headSha: CANDIDATE,
      baseRef: "main",
      state: "merged",
      mergeCommitSha: PROD,
      mergedAt: "2026-10-05T12:00:00Z",
    },
    ["app.ts"],
  );
  ctx.forge.seedBranch(TEST_REPO, "main", PROD);
  for (const sha of [HEAD, MERGE, CANDIDATE, PROD])
    ctx.forge.seedRevisionTree(TEST_REPO, sha, [
      { path: "app.ts", sha: "blob", mode: "100644", type: "blob" },
    ]);
  const records: DeliveryRecord[] = [
    {
      id: "job-one",
      jobId: "job-one",
      project: ctx.project.config.name,
      repository: TEST_REPO,
      configuration: "test-config",
      scopeHash: ticketScopeHash(ticket),
      approvedBy: "controller: epic-scoped work",
      createdAt: "2026-10-01T12:00:00Z",
      updatedAt: "2026-10-04T12:00:00Z",
      message: "Promotion recorded",
      ticket,
      area: "core",
      status: "promoted",
      approvedAt: "2026-10-01T12:00:00Z",
      implementation: {
        number: 1,
        branch: implementation.headRef,
        headSha: HEAD,
        mergeSha: MERGE,
        url: implementation.htmlUrl,
        author: ctx.botLogin,
      },
      promotion: {
        number: 5,
        branch: promotion.headRef,
        headSha: CANDIDATE,
        url: promotion.htmlUrl,
      },
    },
  ];
  const manifest: CompletionManifest = {
    version: 1,
    repo: TEST_REPO,
    productionBranch: "main",
    tickets: [
      {
        ticketId: ticket.id,
        projectId: "lin_core",
        teamId: "team-1",
        scopeHash: ticketScopeHash(ticket),
        approvedBy: "controller: epic-scoped work",
        approvedAt: "2026-10-01T12:00:00Z",
        completedStateId: "done",
        deliverables: [
          {
            implementationPr: 1,
            productionPr: 9,
            implementationBranch: implementation.headRef,
            implementationHeadSha: HEAD,
            implementationMergeSha: MERGE,
          },
        ],
      },
    ],
  };
  const ledger = {
    list: () => records,
    completionManifest: vi.fn(
      (input: {
        deliveryIds: string[];
        productionPr: number;
        completedStateId: string;
      }) => ({
        ...structuredClone(manifest),
        tickets: manifest.tickets.map((scope) => ({
          ...structuredClone(scope),
          completedStateId: input.completedStateId,
          deliverables: scope.deliverables.map((delivery) => ({
            ...delivery,
            productionPr: input.productionPr,
          })),
        })),
      }),
    ),
    completionEligible: vi.fn(
      async (_ids: string[]) =>
        records.length === 1 && ticket.stateType !== "completed",
    ),
  };
  return {
    ctx,
    ticket,
    records,
    ledger,
    implementation,
    promotion,
    production,
    manifest,
    run: () => reconcileManagedCompletion(ctx, ledger),
  };
}
describe("managed production completion", () => {
  it("rotates older production releases across restarted passes instead of permanently ignoring them", async () => {
    const w = world();
    for (let i = 0; i < 30; i++) {
      const sha = (1000 + i).toString(16).padStart(40, "0");
      w.ctx.forge.seedPull(
        TEST_REPO,
        {
          number: 100 + i,
          headRef: "staging",
          headSha: CANDIDATE,
          baseRef: "main",
          state: "merged",
          mergeCommitSha: sha,
          mergedAt: `2026-10-06T12:${String(i).padStart(2, "0")}:00Z`,
        },
        ["app.ts"],
      );
      w.ctx.forge.seedRevisionTree(TEST_REPO, sha, [
        { path: "app.ts", sha: "unrelated", mode: "100644", type: "blob" },
      ]);
    }
    const minute =
      Math.floor(new Date("2026-10-07T12:00:00Z").getTime() / 120_000) * 2;
    w.ctx.now = () => new Date(minute * 60_000);
    await w.run();
    expect(w.ctx.linear.stateUpdates).toHaveLength(0);
    w.ctx.now = () => new Date((minute + 1) * 60_000);
    await w.run();
    expect(w.ctx.linear.stateUpdates).toHaveLength(1);
  });
  it("batches a dozen child tickets with one mapped listing and one immutable read per identity", async () => {
    const w = world();
    const tickets = [w.ticket];
    for (let i = 2; i <= 12; i++) {
      const ticket = w.ctx.linear.seedTicket({
        ...w.ticket,
        id: `ticket-${i}`,
        identifier: `APP-${i}`,
        projectId: "lin_core",
      });
      tickets.push(ticket);
      const pull = w.ctx.forge.seedPull(
        TEST_REPO,
        {
          ...w.implementation,
          number: 10 + i,
          headRef: `gremlins/job-child-${i}`,
        },
        ["app.ts"],
      );
      w.records.push({
        ...w.records[0]!,
        id: `job-child-${i}`,
        ticket,
        scopeHash: ticketScopeHash(ticket),
        implementation: {
          ...w.records[0]!.implementation,
          number: pull.number,
          branch: pull.headRef,
        },
      });
    }
    w.ledger.completionEligible.mockImplementation(async (ids) =>
      w.records
        .filter((record) => ids.includes(record.id))
        .every(
          (record) =>
            tickets.find((ticket) => ticket.id === record.ticket.id)!
              .stateType !== "completed",
        ),
    );
    w.ledger.completionManifest.mockImplementation((input) => ({
      ...w.manifest,
      tickets: w.records
        .filter((record) => input.deliveryIds.includes(record.id))
        .map((record) => ({
          ...w.manifest.tickets[0]!,
          ticketId: record.ticket.id,
          scopeHash: record.scopeHash,
          deliverables: [
            {
              implementationPr: record.implementation.number,
              productionPr: input.productionPr,
              implementationBranch: record.implementation.branch,
              implementationHeadSha: HEAD,
              implementationMergeSha: MERGE,
            },
          ],
        })),
    }));
    const list = vi.spyOn(w.ctx.linear, "listTickets"),
      states = vi.spyOn(w.ctx.linear, "listWorkflowStates");
    const pulls = vi.spyOn(w.ctx.forge, "getPull"),
      trees = vi.spyOn(w.ctx.forge, "getRevisionTree"),
      comparisons = vi.spyOn(w.ctx.forge, "compare");
    const current = vi.spyOn(w.ctx.linear, "getTicket"),
      head = vi.spyOn(w.ctx.forge, "getBranchSha");
    const reports = await w.run();
    expect(
      reports.filter((report) => report.report.tickets[0]?.applied),
    ).toHaveLength(12);
    expect(w.ctx.linear.stateUpdates).toHaveLength(12);
    expect(list).toHaveBeenCalledOnce();
    expect(states).toHaveBeenCalledOnce();
    expect(pulls).toHaveBeenCalledTimes(14);
    expect(trees).toHaveBeenCalledTimes(4);
    expect(comparisons).toHaveBeenCalledTimes(2);
    expect(current).toHaveBeenCalledTimes(24);
    expect(head).toHaveBeenCalledTimes(26);
    expect(w.ledger.completionEligible).toHaveBeenCalledTimes(36);
  });

  it("rotates bounded ticket pages across restarts so blocked earlier work cannot starve later tickets", async () => {
    const w = world();
    const original = w.records[0]!;
    w.records.splice(0);
    for (let i = 0; i < 101; i++)
      w.records.push({
        ...original,
        id: `job-${i}`,
        ticket: {
          ...original.ticket,
          id: `ticket-${String(i).padStart(3, "0")}`,
        },
      });
    w.ledger.completionEligible.mockResolvedValue(false);
    w.ctx.now = () => new Date(0);
    await w.run();
    expect(w.ledger.completionEligible).toHaveBeenCalledTimes(100);
    expect(w.ledger.completionEligible).not.toHaveBeenCalledWith(["job-100"]);
    w.ledger.completionEligible.mockClear();
    w.ctx.now = () => new Date(60_000);
    await w.run(); // A fresh function/context cache, as after a controller restart.
    expect(w.ledger.completionEligible).toHaveBeenCalledExactlyOnceWith([
      "job-100",
    ]);
  });
  it("completes the original and verified QA repair from their exact final promotion tree", async () => {
    const w = world();
    const repairHead = "e".repeat(40),
      repairMerge = "f".repeat(40);
    const repair = w.ctx.forge.seedPull(
      TEST_REPO,
      {
        number: 2,
        headRef: "gremlins/job-repair",
        headSha: repairHead,
        baseRef: "pm-staging",
        state: "merged",
        mergeCommitSha: repairMerge,
        mergedAt: "2026-10-03T12:00:00Z",
      },
      ["app.ts"],
    );
    for (const sha of [repairHead, repairMerge, CANDIDATE, PROD])
      w.ctx.forge.seedRevisionTree(TEST_REPO, sha, [
        { path: "app.ts", sha: "repaired", mode: "100644", type: "blob" },
      ]);
    w.records.push({
      ...w.records[0]!,
      id: "job-repair",
      implementation: {
        ...w.records[0]!.implementation,
        number: 2,
        branch: repair.headRef,
        headSha: repairHead,
        mergeSha: repairMerge,
      },
    });
    w.manifest.tickets[0]!.deliverables.push({
      implementationPr: 2,
      productionPr: 9,
      implementationBranch: repair.headRef,
      implementationHeadSha: repairHead,
      implementationMergeSha: repairMerge,
    });
    w.ledger.completionEligible.mockImplementation(
      async () => w.ticket.stateType !== "completed",
    );
    const reports = await w.run();
    expect(reports[0]?.report.tickets[0]).toMatchObject({
      applied: true,
      classification: "production-confirmed",
    });
    expect(
      reports[0]?.report.tickets[0]?.evidence.map((item) => item.mapping),
    ).toEqual(["verified-composition", "verified-composition"]);
    expect(w.ctx.linear.stateUpdates).toHaveLength(1);
  });
  it("automatically completes exact verified promoted child scope after normal production merge, once", async () => {
    const w = world();
    const reports = await w.run();
    expect(
      reports[0]?.report.tickets.find((row) => row.ticketId === w.ticket.id)
        ?.applied,
    ).toBe(true);
    expect(w.ctx.linear.stateUpdates).toEqual([
      { ticketId: w.ticket.id, stateId: "done" },
    ]);
    await w.run();
    expect(w.ctx.linear.stateUpdates).toHaveLength(1);
    expect(w.ctx.forge.merged).toEqual([]);
  });
  it.each([
    "legacy",
    "unmerged-promotion",
    "changed-promotion",
    "unmerged-production",
    "wrong-production-base",
    "unverified-delivery",
    "new-delivery",
    "revoked-epic",
    "changed-source",
  ])(
    "does not complete when %s invalidates the automatic path",
    async (kind) => {
      const w = world();
      if (kind === "legacy")
        w.ctx.project.config.workflow = { kind: "promotion" };
      if (kind === "unmerged-promotion") w.promotion.state = "open";
      if (kind === "changed-promotion") w.promotion.headSha = "e".repeat(40);
      if (kind === "unmerged-production") w.production.state = "open";
      if (kind === "wrong-production-base") w.production.baseRef = "release";
      if (kind === "unverified-delivery")
        w.records[0]!.status = "awaiting-review";
      if (kind === "new-delivery")
        w.records.push({
          ...w.records[0]!,
          id: "new",
          status: "awaiting-merge",
        });
      if (kind === "revoked-epic")
        w.ledger.completionEligible.mockResolvedValue(false);
      if (kind === "changed-source")
        w.ctx.forge.seedRevisionTree(TEST_REPO, PROD, [
          { path: "app.ts", sha: "other", mode: "100644", type: "blob" },
        ]);
      await w.run();
      expect(w.ctx.linear.stateUpdates).toEqual([]);
    },
  );
  it("rechecks live owner authorization after writing the idempotent evidence comment", async () => {
    const w = world();
    const original = w.ctx.linear.addComment.bind(w.ctx.linear);
    vi.spyOn(w.ctx.linear, "addComment").mockImplementation(
      async (id, body) => {
        const comment = await original(id, body);
        w.ledger.completionEligible.mockResolvedValue(false);
        return comment;
      },
    );
    const reports = await w.run();
    expect(reports[0]?.report.tickets[0]?.reason).toContain("approval changed");
    expect(w.ctx.linear.stateUpdates).toEqual([]);
  });
  it("does not guess among multiple nonstandard completed states", async () => {
    const w = world();
    w.ctx.linear.workflowStates[0]!.name = "Shipped";
    w.ctx.linear.workflowStates.push({
      id: "duplicate",
      name: "Duplicate",
      type: "completed",
      teamId: "team-1",
    });
    const reports = await w.run();
    expect(w.ctx.linear.stateUpdates).toEqual([]);
    expect(reports[0]?.report.tickets[0]?.reason).toContain(
      "cannot choose among",
    );
    expect(
      reports[0]?.report.tickets[0]?.availableCompletedStates,
    ).toHaveLength(2);
  });
  it("explains a missing completed state without requesting another delivery approval", async () => {
    const w = world();
    w.ctx.linear.workflowStates.splice(0);
    const reports = await w.run();
    expect(reports[0]?.report.tickets[0]?.reason).toContain(
      "no completed workflow state",
    );
    expect(w.ctx.linear.stateUpdates).toEqual([]);
    expect(w.ctx.linear.commentsOf(w.ticket.id)).toEqual([]);
  });
  it("exposes exact-content provenance blockers instead of silently omitting completion", async () => {
    const w = world();
    w.ctx.forge.seedRevisionTree(TEST_REPO, PROD, [
      { path: "app.ts", sha: "repaired", mode: "100644", type: "blob" },
    ]);
    const reports = await w.run();
    expect(reports[0]?.report.tickets[0]?.reason).toContain(
      "does not preserve app.ts",
    );
    expect(w.ctx.linear.stateUpdates).toEqual([]);
  });
});
