import { describe, expect, it } from "vitest";
import { makeCtx, TEST_REPO } from "../services/fakes.ts";
import { checkLine } from "./stopTheLine.ts";
import { runDispatch } from "./dispatch.ts";
import { runMerge } from "./merge.ts";
import { runHeal } from "./heal.ts";
import { developerBranch, LABELS, PR_OPENED_PREFIX } from "./notes.ts";

async function recoveryContext() {
  const ctx = makeCtx();
  const sha = ctx.forge.branch(TEST_REPO, "pm-staging")!;
  ctx.forge.seedChecks(TEST_REPO, sha, { status: "failure", failedJobs: [] });
  await checkLine(ctx); // retry once
  const line = await checkLine(ctx); // scoped recovery ticket
  expect(line.recovery).toBeDefined();
  return { ctx, recovery: line.recovery! };
}

describe("stopped-line recovery", () => {
  it("uses the fresh-build workflow contract for both recovery dispatch and its bounded retry", async () => {
    const { ctx, recovery } = await recoveryContext();
    await runDispatch(ctx, { recovery });
    const first = ctx.forge.dispatched[0]!;
    expect(first.inputs).toEqual({
      project: "game",
      ticket: recovery.identifier,
      attempt: "1",
      kind: "build",
    });
    ctx.forge.seedRun({
      id: first.runId,
      status: "completed",
      conclusion: "failure",
    });
    await runHeal(ctx);
    expect(ctx.forge.dispatched[1]?.inputs).toEqual({
      project: "game",
      ticket: recovery.identifier,
      attempt: "2",
      kind: "build",
    });
  });

  it("dispatches its repair despite full ordinary WIP and leaves ordinary approved work paused", async () => {
    const { ctx, recovery } = await recoveryContext();
    for (let i = 0; i < 3; i++)
      ctx.linear.seedTicket({
        projectId: "lin_core",
        labels: [LABELS.dispatched],
      });
    ctx.linear.seedTicket({ projectId: "lin_core", labels: [LABELS.approved] });
    await runDispatch(ctx, { recovery });
    expect(ctx.forge.dispatched).toHaveLength(1);
    expect(ctx.forge.dispatched[0]?.inputs).toMatchObject({
      ticket: recovery.identifier,
      kind: "build",
    });
    await runDispatch(ctx, { recovery });
    expect(ctx.forge.dispatched).toHaveLength(1);
  });

  it.each(["current", "stale", "untrusted", "missing-head", "ordinary"])(
    "only a current authenticated repair can merge (%s)",
    async (scenario) => {
      const { ctx, recovery } = await recoveryContext();
      const pr = ctx.forge.seedPull(TEST_REPO, {
        headRef:
          scenario === "ordinary"
            ? "pm/another-ticket"
            : developerBranch(recovery.identifier),
      });
      ctx.forge.seedChecks(TEST_REPO, pr.headSha, {
        status: "success",
        failedJobs: [],
      });
      ctx.forge.seedComment(
        TEST_REPO,
        pr.number,
        `${PR_OPENED_PREFIX} #${pr.number}\nrecovery-sha: ${recovery.sha}\nhead-sha: ${scenario === "missing-head" ? "old-head" : pr.headSha}`,
        scenario === "untrusted" ? "untrusted-user" : ctx.botLogin,
      );
      if (scenario === "stale")
        ctx.forge.seedBranch(TEST_REPO, "pm-staging", "e".repeat(40));
      await runMerge(ctx, { lineStopped: true, recovery });
      expect(ctx.forge.merged).toEqual(
        scenario === "current" ? [pr.number] : [],
      );
    },
  );

  it("revoking repair approval stops its recovery dispatch and merge", async () => {
    const { ctx, recovery } = await recoveryContext();
    await ctx.linear.removeLabel(recovery.ticketId, LABELS.approved);
    await runDispatch(ctx, { recovery });
    expect(ctx.forge.dispatched).toEqual([]);
    const pr = ctx.forge.seedPull(TEST_REPO, {
      headRef: developerBranch(recovery.identifier),
    });
    ctx.forge.seedChecks(TEST_REPO, pr.headSha, {
      status: "success",
      failedJobs: [],
    });
    ctx.forge.seedComment(
      TEST_REPO,
      pr.number,
      `${PR_OPENED_PREFIX}\nrecovery-sha: ${recovery.sha}\nhead-sha: ${pr.headSha}`,
    );
    await runMerge(ctx, { lineStopped: true, recovery });
    expect(ctx.forge.merged).toEqual([]);
  });
});
