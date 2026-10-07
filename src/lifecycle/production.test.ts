import { describe, expect, it, vi } from "vitest";
import { makeCtx, TEST_REPO } from "../services/fakes.ts";
import {
  parseCompletionManifest,
  ticketScopeHash,
  type CompletionManifest,
} from "./manifest.ts";
import { auditProduction, reconcileProduction } from "./production.ts";

const SHA = {
  source: "a".repeat(40),
  release: "b".repeat(40),
  current: "c".repeat(40),
  head: "d".repeat(40),
};
const file = (path = "app.ts", sha = "blob-1", mode = "100644") => ({
  path,
  sha,
  mode,
  type: "blob",
});

function world() {
  const ctx = makeCtx();
  const ticket = ctx.linear.seedTicket({
    projectId: "lin_core",
    identifier: "T-1",
    labels: ["pm:core", "pm-approved"],
    stateType: "started",
    stateId: "working",
    title: "Deliver feature",
    description: "Approved acceptance scope",
  });
  ctx.linear.workflowStates.push({
    id: "done-id",
    name: "Shipped",
    type: "completed",
    teamId: "team-1",
  });
  ctx.forge.seedBranch(TEST_REPO, "main", SHA.current);
  ctx.forge.seedPull(
    TEST_REPO,
    {
      number: 1,
      headRef: "pm/t-1",
      headSha: SHA.head,
      state: "merged",
      baseRef: "pm-staging",
      mergedAt: "2026-10-01T12:00:00Z",
      mergeCommitSha: SHA.source,
    },
    ["app.ts"],
  );
  ctx.forge.seedPull(
    TEST_REPO,
    {
      number: 9,
      headRef: "staging",
      state: "merged",
      baseRef: "main",
      mergedAt: "2026-10-02T10:00:00Z",
      mergeCommitSha: SHA.release,
    },
    ["app.ts"],
  );
  for (const sha of Object.values(SHA))
    ctx.forge.seedRevisionTree(TEST_REPO, sha, [file()]);
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
        approvedBy: "owner",
        approvedAt: "2026-10-01T10:00:00Z",
        completedStateId: "done-id",
        deliverables: [{ implementationPr: 1, productionPr: 9 }],
      },
    ],
  };
  return { ctx, ticket, manifest };
}

function compositionWorld() {
  const w = world();
  const promotionHead = "e".repeat(40),
    promotionMerge = "f".repeat(40),
    repairHead = "1".repeat(40),
    repairMerge = "2".repeat(40);
  w.ctx.forge.patchPull(TEST_REPO, 1, { headRef: "gremlins/job-original" });
  Object.assign(w.manifest.tickets[0]!.deliverables[0]!, {
    implementationBranch: "gremlins/job-original",
    implementationHeadSha: SHA.head,
    implementationMergeSha: SHA.source,
  });
  w.ctx.forge.seedPull(
    TEST_REPO,
    {
      number: 2,
      headRef: "gremlins/job-repair",
      headSha: repairHead,
      mergeCommitSha: repairMerge,
      state: "merged",
      baseRef: "pm-staging",
      mergedAt: "2026-10-01T14:00:00Z",
    },
    ["app.ts"],
  );
  w.ctx.forge.seedPull(
    TEST_REPO,
    {
      number: 5,
      headRef: "pm-release/core/20261001",
      headSha: promotionHead,
      mergeCommitSha: promotionMerge,
      state: "merged",
      baseRef: "staging",
      mergedAt: "2026-10-01T16:00:00Z",
    },
    ["app.ts"],
  );
  w.manifest.tickets[0]!.deliverables.push({
    implementationPr: 2,
    productionPr: 9,
    implementationBranch: "gremlins/job-repair",
    implementationHeadSha: repairHead,
    implementationMergeSha: repairMerge,
  });
  w.manifest.tickets[0]!.composition = {
    promotionPr: 5,
    branch: "pm-release/core/20261001",
    headSha: promotionHead,
    implementationPrs: [1, 2],
  };
  for (const sha of [
    repairHead,
    repairMerge,
    promotionHead,
    promotionMerge,
    SHA.release,
    SHA.current,
  ])
    w.ctx.forge.seedRevisionTree(TEST_REPO, sha, [file("app.ts", "repaired")]);
  return { ...w, promotionHead, promotionMerge, repairHead, repairMerge };
}

function isolatedPortWorld() {
  const w = compositionWorld();
  const portSha = "3".repeat(40),
    baseSha = "4".repeat(40);
  // Only the isolated replacement remains in the registered active lineage.
  w.manifest.tickets[0]!.deliverables = [
    w.manifest.tickets[0]!.deliverables[0]!,
  ];
  w.manifest.tickets[0]!.composition!.implementationPrs = [1];
  w.manifest.tickets[0]!.deliverables[0]!.promotionSource = {
    sha: portSha,
    baseSha,
    paths: ["app.ts"],
  };
  w.ctx.forge.seedRevisionTree(TEST_REPO, baseSha, [
    file("app.ts", "old"),
    file("other.ts", "staging-other"),
  ]);
  w.ctx.forge.seedRevisionTree(TEST_REPO, portSha, [
    file("app.ts", "repaired"),
    file("other.ts", "staging-other"),
  ]);
  for (const sha of [SHA.head, SHA.source])
    w.ctx.forge.seedRevisionTree(TEST_REPO, sha, [
      file("app.ts", "repaired"),
      file("other.ts", "integration-other"),
    ]);
  w.ctx.forge.seedPullChanges(TEST_REPO, 1, []);
  w.ctx.forge.seedCompare(TEST_REPO, baseSha, portSha, {
    aheadBy: 1,
    behindBy: 0,
  });
  // Internal PR may have been squash merged: its head contains the port, but
  // integration's recorded merge SHA need only preserve exact tested content.
  w.ctx.forge.seedCompare(TEST_REPO, portSha, SHA.head, {
    aheadBy: 2,
    behindBy: 0,
  });
  w.ctx.forge.seedCompare(TEST_REPO, portSha, SHA.source, {
    aheadBy: 1,
    behindBy: 1,
  });
  return { ...w, portSha, baseSha };
}

describe("production completion audit", () => {
  it("completes a squash-merged isolated port with an ancestry-only integration PR", async () => {
    const w = isolatedPortWorld();
    const result = await reconcileProduction(w.ctx, w.manifest, {
      apply: true,
    });
    expect(result.tickets[0]).toMatchObject({
      classification: "production-confirmed",
      applied: true,
    });
    expect(result.tickets[0]!.evidence[0]).toMatchObject({
      promotionSourceSha: w.portSha,
      checkedPaths: ["app.ts"],
    });
  });
  it.each([
    "source scope",
    "untested source",
    "wrong baseline",
    "merge content",
    "source mode",
  ])("rejects altered isolated port provenance: %s", async (change) => {
    const w = isolatedPortWorld();
    if (change === "source scope")
      w.ctx.forge.seedRevisionTree(TEST_REPO, w.portSha, [
        file("app.ts", "repaired"),
        file("other.ts", "unrelated feature"),
      ]);
    if (change === "untested source")
      w.ctx.forge.seedCompare(TEST_REPO, w.portSha, SHA.head, {
        aheadBy: 2,
        behindBy: 1,
      });
    if (change === "wrong baseline")
      w.ctx.forge.seedCompare(TEST_REPO, w.baseSha, w.portSha, {
        aheadBy: 2,
        behindBy: 0,
      });
    if (change === "merge content")
      w.ctx.forge.seedRevisionTree(TEST_REPO, SHA.source, [
        file("app.ts", "dropped feature"),
      ]);
    if (change === "source mode")
      w.ctx.forge.seedRevisionTree(TEST_REPO, w.portSha, [
        file("app.ts", "repaired", "100755"),
        file("other.ts", "staging-other"),
      ]);
    const result = await reconcileProduction(w.ctx, w.manifest, {
      apply: true,
    });
    expect(result.tickets[0]!.classification).not.toBe("production-confirmed");
    expect(w.ctx.linear.stateUpdates).toEqual([]);
  });
  it("isolates a managed ticket update outage so other verified tickets can complete", async () => {
    const { ctx, manifest, ticket } = world();
    const second = ctx.linear.seedTicket({
      ...ticket,
      id: "second-ticket",
      identifier: "T-2",
      projectId: "lin_core",
    });
    ctx.forge.seedPull(
      TEST_REPO,
      {
        number: 2,
        headRef: "pm/t-2",
        headSha: SHA.head,
        state: "merged",
        baseRef: "pm-staging",
        mergedAt: "2026-10-01T12:00:00Z",
        mergeCommitSha: SHA.source,
      },
      ["app.ts"],
    );
    manifest.tickets.push({
      ...manifest.tickets[0]!,
      ticketId: second.id,
      scopeHash: ticketScopeHash(second),
      deliverables: [{ implementationPr: 2, productionPr: 9 }],
    });
    const update = ctx.linear.updateWorkflowState.bind(ctx.linear);
    vi.spyOn(ctx.linear, "updateWorkflowState").mockImplementation(
      async (id, state, guard) => {
        if (id === ticket.id) throw new Error("Provider unavailable");
        await update(id, state, guard);
      },
    );
    const result = await reconcileProduction(ctx, manifest, {
      apply: true,
      onlySuppliedTickets: true,
      continueOnTicketError: true,
    });
    expect(result.tickets[0]!.reason).toContain(
      "without blocking other tickets",
    );
    expect(result.tickets[1]!.applied).toBe(true);
    expect(ctx.linear.stateUpdates).toEqual([
      { ticketId: second.id, stateId: "done-id" },
    ]);
  });
  it("uses the exact verified final composition for overlapping original and QA-repair paths", async () => {
    const w = compositionWorld();
    const result = await reconcileProduction(w.ctx, w.manifest, {
      apply: true,
    });
    expect(result.tickets[0]).toMatchObject({
      classification: "production-confirmed",
      applied: true,
    });
    expect(result.tickets[0]!.evidence.map((e) => e.mapping)).toEqual([
      "verified-composition",
      "verified-composition",
    ]);
  });
  it("retains conservative individual-blob proof for legacy manifests without a composition receipt", async () => {
    const w = compositionWorld();
    delete w.manifest.tickets[0]!.composition;
    expect(
      (await auditProduction(w.ctx, w.manifest)).tickets[0]!.classification,
    ).toBe("ambiguous");
    expect(w.ctx.linear.stateUpdates).toEqual([]);
  });
  it.each([
    "promotion author",
    "promotion base",
    "promotion branch",
    "promotion head",
    "promotion unmerged",
    "promotion omitted path",
    "promotion merge edit",
    "implementation changed head",
    "implementation changed merge",
    "production revert",
    "production incomplete port",
    "release before promotion",
  ])("rejects a changed final composition: %s", async (change) => {
    const w = compositionWorld();
    if (change === "promotion author")
      w.ctx.forge.patchPull(TEST_REPO, 5, { author: "someone-else" });
    if (change === "promotion base")
      w.ctx.forge.patchPull(TEST_REPO, 5, { baseRef: "pm-staging" });
    if (change === "promotion branch")
      w.ctx.forge.patchPull(TEST_REPO, 5, { headRef: "pm-release/other" });
    if (change === "promotion head")
      w.ctx.forge.patchPull(TEST_REPO, 5, { headSha: "3".repeat(40) });
    if (change === "promotion unmerged")
      w.ctx.forge.patchPull(TEST_REPO, 5, { state: "open" });
    if (change === "promotion omitted path")
      w.ctx.forge.seedPullChanges(TEST_REPO, 5, [{ path: "unrelated.ts" }]);
    if (change === "promotion merge edit")
      w.ctx.forge.seedRevisionTree(TEST_REPO, w.promotionMerge, [
        file("app.ts", "changed-at-merge"),
      ]);
    if (change === "implementation changed head")
      w.ctx.forge.patchPull(TEST_REPO, 2, { headSha: "3".repeat(40) });
    if (change === "implementation changed merge")
      w.ctx.forge.patchPull(TEST_REPO, 2, { mergeCommitSha: "3".repeat(40) });
    if (change === "production revert")
      w.ctx.forge.seedRevisionTree(TEST_REPO, SHA.current, [
        file("app.ts", "original"),
      ]);
    if (change === "production incomplete port") {
      w.ctx.forge.seedCompare(TEST_REPO, w.promotionMerge, SHA.release, {
        aheadBy: 2,
        behindBy: 1,
      });
      w.ctx.forge.seedPullChanges(TEST_REPO, 9, [{ path: "unrelated.ts" }]);
    }
    if (change === "release before promotion")
      w.ctx.forge.patchPull(TEST_REPO, 5, { mergedAt: "2026-10-03T00:00:00Z" });
    expect(
      (await reconcileProduction(w.ctx, w.manifest, { apply: true }))
        .tickets[0]!.classification,
    ).toBe("ambiguous");
    expect(w.ctx.linear.stateUpdates).toEqual([]);
  });
  it.each([
    "missing repair",
    "unknown implementation",
    "duplicate implementation",
    "missing registered merge",
  ])("rejects an incomplete composition receipt: %s", (change) => {
    const w = compositionWorld();
    const scope = w.manifest.tickets[0]!;
    if (change === "missing repair") scope.composition!.implementationPrs = [1];
    if (change === "unknown implementation")
      scope.composition!.implementationPrs = [1, 7];
    if (change === "duplicate implementation")
      scope.composition!.implementationPrs = [1, 1];
    if (change === "missing registered merge")
      delete scope.deliverables[1]!.implementationMergeSha;
    expect(() => parseCompletionManifest(w.manifest)).toThrow(/composition/);
  });
  it("supports exact registered local-worker branches while rejecting a moved head", async () => {
    const { ctx, manifest } = world();
    ctx.forge.seedPull(
      TEST_REPO,
      {
        number: 1,
        headRef: "gremlins/job-local",
        headSha: SHA.head,
        state: "merged",
        baseRef: "pm-staging",
        mergedAt: "2026-10-01T12:00:00Z",
        mergeCommitSha: SHA.source,
      },
      ["app.ts"],
    );
    Object.assign(manifest.tickets[0]!.deliverables[0]!, {
      implementationBranch: "gremlins/job-local",
      implementationHeadSha: SHA.head,
    });
    expect(
      (await auditProduction(ctx, manifest)).tickets[0]?.classification,
    ).toBe("production-confirmed");
    manifest.tickets[0]!.deliverables[0]!.implementationHeadSha = "e".repeat(
      40,
    );
    expect(
      (await auditProduction(ctx, manifest)).tickets[0]?.classification,
    ).not.toBe("production-confirmed");
    expect(ctx.linear.stateUpdates).toEqual([]);
  });
  it("uses a nonempty approved complete scope, never arbitrary comments or verified labels", async () => {
    const { ctx, ticket } = world();
    ticket.labels.push("pm-verified");
    await ctx.linear.addComment(ticket.id, "Done! T-1 shipped with PR #9");
    const report = await auditProduction(ctx);
    expect(report.tickets[0]).toMatchObject({
      classification: "ambiguous",
      scopeHash: ticketScopeHash(ticket),
    });
    expect(ctx.linear.stateUpdates).toEqual([]);
  });

  it("confirms production merge even if deployment has failed; defaults to dry-run", async () => {
    const { ctx, manifest } = world();
    ctx.vercel.seedDeployment("prj_game", "main", { state: "ERROR" });
    const result = await reconcileProduction(ctx, manifest);
    expect(result.dryRun).toBe(true);
    expect(result.tickets[0]).toMatchObject({
      classification: "production-confirmed",
      proposedStateId: "done-id",
      evidence: [
        { productionMergeSha: SHA.release, mapping: "ancestry-and-content" },
      ],
    });
    expect(ctx.linear.stateUpdates).toHaveLength(0);
    expect(ctx.linear.commentsOf(manifest.tickets[0]!.ticketId)).toHaveLength(
      0,
    );
  });

  it.each(["pm-staging", "staging"])(
    "never completes a PR merged only to %s",
    async (baseRef) => {
      const { ctx, manifest } = world();
      ctx.forge.patchPull(TEST_REPO, 9, { baseRef });
      const result = await reconcileProduction(ctx, manifest, { apply: true });
      expect(result.tickets[0]?.classification).toBe("not-production");
      expect(ctx.linear.stateUpdates).toHaveLength(0);
    },
  );

  it.each(["open", "closed"] as const)(
    "rejects a production PR that is %s but unmerged",
    async (state) => {
      const { ctx, manifest } = world();
      ctx.forge.patchPull(TEST_REPO, 9, { state, mergedAt: null });
      expect(
        (await reconcileProduction(ctx, manifest, { apply: true })).tickets[0]
          ?.classification,
      ).toBe("not-production");
      expect(ctx.linear.stateUpdates).toHaveLength(0);
    },
  );

  it("requires all deliverables; a partially released ticket remains open", async () => {
    const { ctx, manifest } = world();
    ctx.forge.seedPull(TEST_REPO, { number: 2, headRef: "pm/t-1" });
    manifest.tickets[0]!.deliverables.push({
      implementationPr: 2,
      productionPr: 9,
    });
    const row = (await reconcileProduction(ctx, manifest, { apply: true }))
      .tickets[0];
    expect(row?.classification).toBe("ambiguous");
    expect(row?.evidence).toHaveLength(1);
    expect(ctx.linear.stateUpdates).toHaveLength(0);
  });

  it("supports squash/cherry-pick only when the production PR contains every exact changed file", async () => {
    const { ctx, manifest } = world();
    ctx.forge.seedCompare(TEST_REPO, SHA.source, SHA.release, {
      aheadBy: 2,
      behindBy: 1,
    });
    const row = (await auditProduction(ctx, manifest)).tickets[0];
    expect(row?.classification).toBe("production-confirmed");
    expect(row?.evidence[0]?.mapping).toBe("exact-content");
    ctx.forge.seedPullChanges(TEST_REPO, 9, [{ path: "unrelated.ts" }]);
    expect(
      (await auditProduction(ctx, manifest)).tickets[0]?.classification,
    ).toBe("ambiguous");
  });

  it.each([SHA.release, SHA.current, SHA.head])(
    "rejects changed contents at %s including reverts and edited ports",
    async (sha) => {
      const { ctx, manifest } = world();
      ctx.forge.seedRevisionTree(TEST_REPO, sha, [file("app.ts", "different")]);
      expect(
        (await reconcileProduction(ctx, manifest, { apply: true })).tickets[0]
          ?.classification,
      ).toBe("ambiguous");
      expect(ctx.linear.stateUpdates).toHaveLength(0);
    },
  );

  it("checks removed and renamed old paths and file modes", async () => {
    const { ctx, manifest } = world();
    ctx.forge.seedPullChanges(TEST_REPO, 1, [
      { path: "app.ts", previousPath: "old.ts" },
    ]);
    ctx.forge.seedRevisionTree(TEST_REPO, SHA.current, [
      file(),
      file("old.ts"),
    ]);
    expect((await auditProduction(ctx, manifest)).tickets[0]?.reason).toContain(
      "old.ts",
    );
    ctx.forge.seedRevisionTree(TEST_REPO, SHA.current, [
      file("app.ts", "blob-1", "100755"),
    ]);
    expect(
      (await auditProduction(ctx, manifest)).tickets[0]?.classification,
    ).toBe("ambiguous");
  });

  it("requires the release merge to remain in the production history", async () => {
    const { ctx, manifest } = world();
    ctx.forge.seedCompare(TEST_REPO, SHA.release, SHA.current, {
      aheadBy: 1,
      behindBy: 1,
    });
    expect((await auditProduction(ctx, manifest)).tickets[0]?.reason).toContain(
      "absent from current production",
    );
  });

  it("fails closed for missing/truncated tree data", async () => {
    const { ctx, manifest } = world();
    vi.spyOn(ctx.forge, "getRevisionTree").mockRejectedValue(
      new Error("truncated tree"),
    );
    expect((await auditProduction(ctx, manifest)).tickets[0]).toMatchObject({
      classification: "ambiguous",
      reason: "truncated tree",
    });
  });

  it("requires bot authorship and exact ticket branch linkage", async () => {
    const { ctx, manifest } = world();
    ctx.forge.patchPull(TEST_REPO, 1, { author: "stranger", body: "T-1" });
    expect(
      (await auditProduction(ctx, manifest)).tickets[0]?.classification,
    ).toBe("ambiguous");
    ctx.forge.patchPull(TEST_REPO, 1, {
      author: ctx.botLogin,
      headRef: "pm/t-123",
    });
    expect(
      (await auditProduction(ctx, manifest)).tickets[0]?.classification,
    ).toBe("ambiguous");
  });

  it("invalidates approval when title or acceptance scope changes", async () => {
    const { ctx, ticket, manifest } = world();
    ticket.description += " and another requirement";
    expect((await auditProduction(ctx, manifest)).tickets[0]?.reason).toContain(
      "changed after approval",
    );
  });

  it("scopes status mapping to the actual team and project", async () => {
    const { ctx, manifest } = world();
    ctx.linear.workflowStates[0]!.teamId = "another-team";
    expect(
      (await auditProduction(ctx, manifest)).tickets[0]?.classification,
    ).toBe("ambiguous");
    manifest.tickets[0]!.projectId = "another-project";
    expect((await auditProduction(ctx, manifest)).tickets[0]?.reason).toContain(
      "project changed",
    );
  });

  it("does not enroll tickets outside configured projects and area labels", async () => {
    const { ctx, ticket, manifest } = world();
    ticket.labels = [];
    await expect(auditProduction(ctx, manifest)).rejects.toThrow(
      "outside the configured",
    );
    manifest.repo = "other/repository";
    await expect(auditProduction(ctx, manifest)).rejects.toThrow(
      "does not match",
    );
  });
});

describe("guarded opt-in reconciliation", () => {
  it("completes once with production proof and an idempotent evidence comment", async () => {
    const { ctx, ticket, manifest } = world();
    expect(
      (await reconcileProduction(ctx, manifest, { apply: true })).tickets[0]
        ?.applied,
    ).toBe(true);
    expect(ticket.stateType).toBe("completed");
    expect(ctx.linear.stateUpdates).toEqual([
      { ticketId: ticket.id, stateId: "done-id" },
    ]);
    expect(ctx.linear.commentsOf(ticket.id)[0]).toContain(SHA.release);
    await reconcileProduction(ctx, manifest, { apply: true });
    expect(ctx.linear.stateUpdates).toHaveLength(1);
    expect(ctx.linear.commentsOf(ticket.id)).toHaveLength(1);
  });

  it("keeps dry-run authoritative even with apply", async () => {
    const { ctx, manifest } = world();
    ctx.dryRun = true;
    expect(
      (await reconcileProduction(ctx, manifest, { apply: true })).dryRun,
    ).toBe(true);
    expect(ctx.linear.stateUpdates).toHaveLength(0);
  });

  it("preserves cancellation and does not bulk reopen uncertain Done tickets", async () => {
    const { ctx, ticket, manifest } = world();
    ticket.stateType = "canceled";
    expect(
      (await reconcileProduction(ctx, manifest, { apply: true })).tickets[0]
        ?.classification,
    ).toBe("canceled");
    ticket.stateType = "completed";
    ctx.forge.patchPull(TEST_REPO, 9, { baseRef: "staging" });
    expect(
      (await reconcileProduction(ctx, manifest, { apply: true })).tickets[0]
        ?.classification,
    ).toBe("not-production");
    expect(ticket.stateType).toBe("completed");
    expect(ctx.linear.stateUpdates).toHaveLength(0);
  });

  it("rereads cancellation and scope after the evidence comment", async () => {
    const { ctx, ticket, manifest } = world();
    const addComment = ctx.linear.addComment.bind(ctx.linear);
    vi.spyOn(ctx.linear, "addComment").mockImplementation(async (id, body) => {
      const comment = await addComment(id, body);
      ticket.stateType = "canceled";
      return comment;
    });
    const row = (await reconcileProduction(ctx, manifest, { apply: true }))
      .tickets[0];
    expect(row?.applied).toBeUndefined();
    expect(ctx.linear.stateUpdates).toHaveLength(0);
  });

  it("will not write from evidence for a stale production head", async () => {
    const { ctx, manifest } = world();
    vi.spyOn(ctx.forge, "getBranchSha")
      .mockResolvedValueOnce(SHA.current)
      .mockResolvedValue("new-head");
    expect(
      (await reconcileProduction(ctx, manifest, { apply: true })).tickets[0]
        ?.reason,
    ).toContain("Production advanced");
    expect(ctx.linear.stateUpdates).toHaveLength(0);
  });

  it("retries a failed transition without duplicating the evidence comment", async () => {
    const { ctx, ticket, manifest } = world();
    const write = vi
      .spyOn(ctx.linear, "updateWorkflowState")
      .mockRejectedValueOnce(new Error("Linear unavailable"));
    await expect(
      reconcileProduction(ctx, manifest, { apply: true }),
    ).rejects.toThrow("Linear unavailable");
    expect(ticket.stateType).toBe("started");
    await reconcileProduction(ctx, manifest, { apply: true });
    expect(write).toHaveBeenCalledTimes(2);
    expect(ctx.linear.commentsOf(ticket.id)).toHaveLength(1);
  });
});

describe("completion manifest validation", () => {
  it.each([
    "../other",
    ".git/config",
    "C:/other",
    "other\\file",
    "bad\npath",
    "",
  ])("rejects unsafe promotion source path %j", (path) => {
    const w = isolatedPortWorld();
    w.manifest.tickets[0]!.deliverables[0]!.promotionSource!.paths = [path];
    expect(() => parseCompletionManifest(w.manifest)).toThrow(
      "finite safe paths",
    );
  });
  it("requires source provenance to have the complete registered implementation identity", () => {
    const w = isolatedPortWorld();
    delete w.manifest.tickets[0]!.deliverables[0]!.implementationMergeSha;
    expect(() => parseCompletionManifest(w.manifest)).toThrow(
      "exact implementation identities",
    );
  });
  it("rejects empty deliverables, duplicate tickets/PRs and missing approval", () => {
    const { manifest } = world();
    const scope = manifest.tickets[0]!;
    expect(() =>
      parseCompletionManifest({
        ...manifest,
        tickets: [{ ...scope, deliverables: [] }],
      }),
    ).toThrow("nonempty");
    expect(() =>
      parseCompletionManifest({ ...manifest, tickets: [scope, scope] }),
    ).toThrow("duplicate ticket");
    expect(() =>
      parseCompletionManifest({
        ...manifest,
        tickets: [{ ...scope, approvedBy: "" }],
      }),
    ).toThrow("approvedBy");
    expect(() =>
      parseCompletionManifest({
        ...manifest,
        tickets: [
          {
            ...scope,
            deliverables: [...scope.deliverables, ...scope.deliverables],
          },
        ],
      }),
    ).toThrow("duplicate implementation");
  });
});
