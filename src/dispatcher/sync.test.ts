import { describe, expect, it } from "vitest";
import { makeCtx, TEST_REPO } from "../services/fakes.ts";
import {
  LABELS,
  SYNC_CONFLICT_PREFIX,
  SYNC_PR_TITLE,
  SYNC_RESOLVE_DISPATCHED_PREFIX,
  syncBranch,
} from "./notes.ts";
import { runSync } from "./sync.ts";

const STAGING = "staging";
const INTEGRATION = "pm-staging";

describe("runSync", () => {
  it("does nothing when staging is not ahead of integration", async () => {
    const ctx = makeCtx();
    const rows = await runSync(ctx);
    expect(rows).toEqual([]);
    expect(await ctx.forge.listOpenPulls(TEST_REPO)).toEqual([]);
    expect(ctx.forge.autoMerged).toEqual([]);
  });

  it("opens the sync PR and merges it itself — never relying on auto-merge", async () => {
    const ctx = makeCtx();
    ctx.forge.seedCompare(TEST_REPO, INTEGRATION, STAGING, {
      aheadBy: 3,
      behindBy: 0,
    });
    const rows = await runSync(ctx);
    expect(await ctx.forge.listOpenPulls(TEST_REPO)).toEqual([]);
    expect(ctx.forge.merged).toHaveLength(1);
    const pr = ctx.forge.pull(TEST_REPO, ctx.forge.merged[0]!);
    expect(pr.title).toBe(SYNC_PR_TITLE(STAGING, INTEGRATION));
    expect(pr.headRef).toBe(STAGING);
    expect(pr.baseRef).toBe(INTEGRATION);
    expect(pr.state).toBe("merged");
    expect(ctx.forge.autoMerged).toEqual([]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ rule: "sync", ref: String(pr.number) });
    expect(rows[0]!.text).toContain("merged");
    expect(rows[0]!.needsYou).toBeFalsy();
  });

  it("merges an existing open sync PR instead of opening another", async () => {
    const ctx = makeCtx();
    ctx.forge.seedCompare(TEST_REPO, INTEGRATION, STAGING, {
      aheadBy: 1,
      behindBy: 0,
    });
    ctx.forge.seedPull(TEST_REPO, {
      number: 7,
      title: SYNC_PR_TITLE(STAGING, INTEGRATION),
      headRef: STAGING,
      baseRef: INTEGRATION,
      draft: false,
    });
    const rows = await runSync(ctx);
    expect(ctx.forge.merged).toEqual([7]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.text).toContain("#7");
    expect(rows[0]!.needsYou).toBeFalsy();
  });

  it("waits, without asking the owner, while GitHub has not settled the PR's mergeability", async () => {
    const ctx = makeCtx();
    ctx.forge.seedCompare(TEST_REPO, INTEGRATION, STAGING, {
      aheadBy: 1,
      behindBy: 0,
    });
    ctx.forge.seedPull(TEST_REPO, {
      number: 8,
      headRef: STAGING,
      baseRef: INTEGRATION,
      draft: false,
      mergeableState: "unknown",
    });
    const rows = await runSync(ctx);
    expect(ctx.forge.merged).toEqual([]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.text).toContain("waiting on #8");
    expect(rows[0]!.needsYou).toBeFalsy();
  });

  it("asks the owner when the host refuses the sync merge", async () => {
    const ctx = makeCtx();
    ctx.forge.seedCompare(TEST_REPO, INTEGRATION, STAGING, {
      aheadBy: 1,
      behindBy: 0,
    });
    ctx.forge.seedPull(TEST_REPO, {
      number: 9,
      headRef: STAGING,
      baseRef: INTEGRATION,
      draft: false,
    });
    ctx.forge.nextMergeRefusal = "Required status check is expected";
    const rows = await runSync(ctx);
    expect(rows[0]).toMatchObject({ needsYou: true });
    expect(rows[0]!.text).toContain("Required status check");
  });

  describe("a conflicting sync PR heals itself", () => {
    function conflicted() {
      const ctx = makeCtx();
      ctx.forge.seedCompare(TEST_REPO, INTEGRATION, STAGING, {
        aheadBy: 4,
        behindBy: 9,
      });
      const stagingSha = ctx.forge.seedBranch(
        TEST_REPO,
        STAGING,
        "aaaaaaaaaaaa1111aaaaaaaaaaaa1111aaaaaaaa",
      );
      const pr = ctx.forge.seedPull(TEST_REPO, {
        number: 9,
        headRef: STAGING,
        headSha: stagingSha,
        baseRef: INTEGRATION,
        draft: false,
        mergeableState: "dirty",
      });
      return { ctx, pr, stagingSha };
    }
    const syncTickets = (ctx: ReturnType<typeof makeCtx>) =>
      [...ctx.linear.tickets.values()].filter((t) =>
        t.labels.includes(LABELS.sync),
      );

    it("sends a developer to resolve it on a pm-sync branch instead of paging the owner", async () => {
      const { ctx, stagingSha } = conflicted();
      const rows = await runSync(ctx);

      expect(ctx.forge.dispatched).toHaveLength(1);
      const d = ctx.forge.dispatched[0]!;
      expect(d.workflowFile).toBe("developer.yml");
      expect(d.inputs).toMatchObject({
        kind: "sync",
        branch: syncBranch(stagingSha),
        attempt: "1",
      });

      const [ticket] = syncTickets(ctx);
      expect(ticket).toBeDefined();
      expect(ticket!.description).toContain(`staging: ${stagingSha}`);
      // dispatched from birth, never `approved`: the dispatch rule leaves it alone
      expect(ticket!.labels).toContain(LABELS.dispatched);
      expect(ticket!.labels).not.toContain(LABELS.approved);
      expect(d.inputs.ticket).toBe(ticket!.identifier);
      expect(
        ctx.linear
          .commentsOf(ticket!.id)
          .some((c) => c.startsWith(SYNC_RESOLVE_DISPATCHED_PREFIX)),
      ).toBe(true);

      expect(rows.some((r) => r.needsYou)).toBe(false);
      expect(ctx.forge.comments(TEST_REPO, 9)).toEqual([]);
    });

    it("leaves a resolution that is still running alone", async () => {
      const { ctx } = conflicted();
      await runSync(ctx); // run is queued in the fake
      const rows = await runSync(ctx);
      expect(ctx.forge.dispatched).toHaveLength(1);
      expect(syncTickets(ctx)).toHaveLength(1);
      expect(rows).toEqual([]);
    });

    it("re-dispatches once when the first run ended without a PR, on the same ticket", async () => {
      const { ctx } = conflicted();
      await runSync(ctx);
      ctx.forge.seedRun({
        id: ctx.forge.dispatched[0]!.runId,
        status: "completed",
      });
      await runSync(ctx);
      expect(ctx.forge.dispatched).toHaveLength(2);
      expect(ctx.forge.dispatched[1]!.inputs.attempt).toBe("2");
      expect(syncTickets(ctx)).toHaveLength(1);
    });

    it("pages the owner once, only after two resolution runs ended without a PR", async () => {
      const { ctx } = conflicted();
      await runSync(ctx);
      ctx.forge.seedRun({
        id: ctx.forge.dispatched[0]!.runId,
        status: "completed",
      });
      await runSync(ctx);
      ctx.forge.seedRun({
        id: ctx.forge.dispatched[1]!.runId,
        status: "completed",
      });

      const third = await runSync(ctx);
      expect(ctx.forge.dispatched).toHaveLength(2);
      expect(third.some((r) => r.needsYou)).toBe(true);
      const flagged = () =>
        ctx.forge
          .comments(TEST_REPO, 9)
          .filter((c) => c.startsWith(SYNC_CONFLICT_PREFIX));
      expect(flagged()).toHaveLength(1);

      const fourth = await runSync(ctx);
      expect(flagged()).toHaveLength(1);
      expect(fourth.some((r) => r.needsYou)).toBe(false);
    });

    it("does nothing more while the resolution PR is open — the merge rule lands it", async () => {
      const { ctx, stagingSha } = conflicted();
      ctx.forge.seedPull(TEST_REPO, {
        number: 30,
        headRef: syncBranch(stagingSha),
        baseRef: INTEGRATION,
      });
      const rows = await runSync(ctx);
      expect(ctx.forge.dispatched).toEqual([]);
      expect(syncTickets(ctx)).toEqual([]);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.text).toContain("#30");
      expect(rows[0]!.needsYou).toBeFalsy();
    });

    it("a new staging sha gets its own ticket and a fresh attempt count", async () => {
      const { ctx } = conflicted();
      await runSync(ctx);
      ctx.forge.seedRun({
        id: ctx.forge.dispatched[0]!.runId,
        status: "completed",
      });
      ctx.forge.seedBranch(
        TEST_REPO,
        STAGING,
        "bbbbbbbbbbbb2222bbbbbbbbbbbb2222bbbbbbbb",
      );
      await runSync(ctx);
      expect(syncTickets(ctx)).toHaveLength(2);
      expect(ctx.forge.dispatched[1]!.inputs.attempt).toBe("1");
    });
  });

  it("writes nothing in dry-run mode", async () => {
    const ctx = makeCtx({ dryRun: true });
    ctx.forge.seedCompare(TEST_REPO, INTEGRATION, STAGING, {
      aheadBy: 2,
      behindBy: 0,
    });
    await runSync(ctx);
    expect(await ctx.forge.listOpenPulls(TEST_REPO)).toEqual([]);
    expect(ctx.forge.autoMerged).toEqual([]);
    expect(ctx.lines.some((l) => l.startsWith("[dry-run]"))).toBe(true);
  });
});
