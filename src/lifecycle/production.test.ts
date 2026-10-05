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

describe("production completion audit", () => {
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
