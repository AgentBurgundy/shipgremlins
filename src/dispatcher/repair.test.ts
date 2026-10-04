import { describe, expect, it } from "vitest";
import { makeCtx, TEST_REPO } from "../services/fakes.ts";
import type { TestCtx } from "../services/fakes.ts";
import {
  CI_FIX_DISPATCHED_PREFIX,
  CI_NEEDS_OWNER_PREFIX,
  CI_RETRIED_PREFIX,
  CONFLICT_NEEDS_OWNER_PREFIX,
  formatConflictDispatch,
  LABELS,
} from "./notes.ts";
import { runRepair } from "./repair.ts";

const INTEGRATION = "pm-staging";
const PROJECT = "lin_core";

function world(
  ctx: TestCtx,
  pr: { mergeableState?: string; checks?: "failure" | "success" } = {},
) {
  const ticket = ctx.linear.seedTicket({
    projectId: PROJECT,
    identifier: "GAME-3",
  });
  const pull = ctx.forge.seedPull(TEST_REPO, {
    number: 5,
    headRef: "pm/game-3",
    mergeableState: pr.mergeableState ?? "clean",
  });
  if (pr.checks)
    ctx.forge.seedChecks(TEST_REPO, pull.headSha, {
      status: pr.checks,
      failedJobs:
        pr.checks === "failure"
          ? [{ name: "unit tests", url: "https://ci/job/1" }]
          : [],
    });
  const integ = ctx.forge.branch(TEST_REPO, INTEGRATION)!;
  return { ticket, pull, integ };
}

function seedConflictDispatch(
  ctx: TestCtx,
  runId: number,
  mrSha: string,
  baseSha: string,
  status: "completed" | "in_progress" = "completed",
) {
  ctx.forge.seedRun({
    id: runId,
    status,
    conclusion: status === "completed" ? "success" : null,
  });
  ctx.forge.seedComment(
    TEST_REPO,
    5,
    formatConflictDispatch(runId, mrSha, baseSha),
  );
}

describe("runRepair — conflicts", () => {
  it("dispatches a conflict resolution on the PR's branch and records both shas", async () => {
    const ctx = makeCtx();
    const { pull, integ } = world(ctx, { mergeableState: "dirty" });
    const rows = await runRepair(ctx);
    expect(ctx.forge.dispatched).toHaveLength(1);
    const d = ctx.forge.dispatched[0]!;
    expect(d.inputs).toEqual({
      project: "game",
      ticket: "GAME-3",
      attempt: "1",
      kind: "rc",
      branch: "pm/game-3",
      pr: "5",
    });
    expect(ctx.forge.comments(TEST_REPO, 5)).toEqual([
      formatConflictDispatch(d.runId, pull.headSha, integ),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ rule: "repair", ref: "5" });
    expect(rows[0]!.needsYou).toBeFalsy();
  });

  it("leaves a resolution that is still running alone", async () => {
    const ctx = makeCtx();
    const { pull, integ } = world(ctx, { mergeableState: "dirty" });
    seedConflictDispatch(ctx, 70, pull.headSha, integ, "in_progress");
    const rows = await runRepair(ctx);
    expect(ctx.forge.dispatched).toEqual([]);
    expect(ctx.forge.comments(TEST_REPO, 5)).toHaveLength(1);
    expect(rows).toEqual([]);
  });

  it("one failed attempt against the same base → tries again as attempt 2", async () => {
    const ctx = makeCtx();
    const { pull, integ } = world(ctx, { mergeableState: "dirty" });
    seedConflictDispatch(ctx, 70, pull.headSha, integ);
    await runRepair(ctx);
    expect(ctx.forge.dispatched).toHaveLength(1);
    expect(ctx.forge.dispatched[0]!.inputs.attempt).toBe("2");
    expect(ctx.forge.comments(TEST_REPO, 5)).toHaveLength(2);
  });

  it("two failed attempts against the same base → needs owner, ticket needs a human", async () => {
    const ctx = makeCtx();
    const { ticket, pull, integ } = world(ctx, { mergeableState: "dirty" });
    seedConflictDispatch(ctx, 70, pull.headSha, integ);
    seedConflictDispatch(ctx, 71, pull.headSha, integ);
    const rows = await runRepair(ctx);
    expect(ctx.forge.dispatched).toEqual([]);
    expect(ctx.forge.comments(TEST_REPO, 5).at(-1)).toBe(
      `${CONFLICT_NEEDS_OWNER_PREFIX} two resolution attempts failed against ${integ.slice(0, 12)}`,
    );
    expect(ctx.linear.labelsOf(ticket.id)).toContain(LABELS.needsHuman);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ rule: "repair", needsYou: true, ref: "5" });

    const before = ctx.forge.comments(TEST_REPO, 5).length;
    const again = await runRepair(ctx);
    expect(ctx.forge.comments(TEST_REPO, 5)).toHaveLength(before);
    expect(again).toHaveLength(1);
    expect(again[0]!.needsYou).toBe(true);
  });

  it("a base that moved underneath is not a failure — re-dispatches freely", async () => {
    const ctx = makeCtx();
    const { ticket, pull } = world(ctx, { mergeableState: "dirty" });
    const oldBase = "1111111111111111111111111111111111111111";
    seedConflictDispatch(ctx, 70, pull.headSha, oldBase);
    seedConflictDispatch(ctx, 71, pull.headSha, oldBase);
    const rows = await runRepair(ctx);
    expect(ctx.forge.dispatched).toHaveLength(1);
    expect(ctx.forge.dispatched[0]!.inputs.attempt).toBe("3");
    expect(
      ctx.forge
        .comments(TEST_REPO, 5)
        .some((c) => c.startsWith(CONFLICT_NEEDS_OWNER_PREFIX)),
    ).toBe(false);
    expect(ctx.linear.labelsOf(ticket.id)).not.toContain(LABELS.needsHuman);
    expect(rows[0]!.needsYou).toBeFalsy();
  });

  it("caps at four dispatches", async () => {
    const ctx = makeCtx();
    const { ticket, pull } = world(ctx, { mergeableState: "dirty" });
    for (let i = 0; i < 4; i++) {
      seedConflictDispatch(
        ctx,
        70 + i,
        pull.headSha,
        `${i}${i}${i}${i}${i}${i}${i}${i}${i}${i}${i}${i}aaaa`,
      );
    }
    const rows = await runRepair(ctx);
    expect(ctx.forge.dispatched).toEqual([]);
    expect(ctx.forge.comments(TEST_REPO, 5).at(-1)).toBe(
      `${CONFLICT_NEEDS_OWNER_PREFIX} re-conflicted after 4 resolutions`,
    );
    expect(ctx.linear.labelsOf(ticket.id)).toContain(LABELS.needsHuman);
    expect(rows[0]).toMatchObject({ needsYou: true });
  });
});

describe("runRepair — red checks", () => {
  it("re-runs failed jobs once, then dispatches two fixes, then needs the owner", async () => {
    const ctx = makeCtx();
    const { ticket, pull } = world(ctx, { checks: "failure" });
    const sha12 = pull.headSha.slice(0, 12);

    const r1 = await runRepair(ctx);
    expect(ctx.forge.reruns).toEqual([pull.headSha]);
    expect(ctx.forge.comments(TEST_REPO, 5)).toEqual([
      `${CI_RETRIED_PREFIX} at ${sha12}`,
    ]);
    expect(r1).toHaveLength(1);
    expect(r1[0]!.needsYou).toBeFalsy();

    const r2 = await runRepair(ctx);
    expect(ctx.forge.reruns).toHaveLength(1);
    expect(ctx.forge.dispatched).toHaveLength(1);
    expect(ctx.forge.dispatched[0]!.inputs).toEqual({
      project: "game",
      ticket: "GAME-3",
      attempt: "1",
      kind: "ci",
      branch: "pm/game-3",
      pr: "5",
    });
    const fix1 = ctx.forge.comments(TEST_REPO, 5)[1]!;
    expect(
      fix1.startsWith(
        `${CI_FIX_DISPATCHED_PREFIX} ${ctx.forge.dispatched[0]!.runId} (at ${sha12})`,
      ),
    ).toBe(true);
    expect(fix1).toContain("unit tests");
    expect(fix1).toContain("https://ci/job/1");
    expect(r2[0]!.needsYou).toBeFalsy();

    // the fix run is still going: hands off
    const r3 = await runRepair(ctx);
    expect(ctx.forge.dispatched).toHaveLength(1);
    expect(r3).toEqual([]);

    ctx.forge.seedRun({
      id: ctx.forge.dispatched[0]!.runId,
      status: "completed",
    });
    await runRepair(ctx);
    expect(ctx.forge.dispatched).toHaveLength(2);
    expect(ctx.forge.dispatched[1]!.inputs.attempt).toBe("2");

    ctx.forge.seedRun({
      id: ctx.forge.dispatched[1]!.runId,
      status: "completed",
    });
    const r5 = await runRepair(ctx);
    expect(ctx.forge.dispatched).toHaveLength(2);
    expect(ctx.forge.comments(TEST_REPO, 5).at(-1)).toBe(CI_NEEDS_OWNER_PREFIX);
    expect(ctx.linear.labelsOf(ticket.id)).toContain(LABELS.needsHuman);
    expect(r5[0]).toMatchObject({ needsYou: true, ref: "5" });

    const r6 = await runRepair(ctx);
    expect(
      ctx.forge
        .comments(TEST_REPO, 5)
        .filter((c) => c === CI_NEEDS_OWNER_PREFIX),
    ).toHaveLength(1);
    expect(r6[0]!.needsYou).toBe(true);
  });

  it("re-runs again at a new head sha", async () => {
    const ctx = makeCtx();
    const { pull } = world(ctx, { checks: "failure" });
    ctx.forge.seedComment(TEST_REPO, 5, `${CI_RETRIED_PREFIX} at 000000000000`);
    await runRepair(ctx);
    expect(ctx.forge.reruns).toEqual([pull.headSha]);
    expect(ctx.forge.dispatched).toEqual([]);
  });

  it("ignores green or pending checks, non-bot PRs and non-developer branches", async () => {
    const ctx = makeCtx();
    world(ctx, { checks: "success" });
    const human = ctx.forge.seedPull(TEST_REPO, {
      number: 6,
      headRef: "pm/game-4",
      author: "alice",
      mergeableState: "dirty",
    });
    ctx.forge.seedChecks(TEST_REPO, human.headSha, {
      status: "failure",
      failedJobs: [],
    });
    ctx.forge.seedPull(TEST_REPO, {
      number: 7,
      headRef: "staging",
      mergeableState: "dirty",
    });
    const rows = await runRepair(ctx);
    expect(ctx.forge.dispatched).toEqual([]);
    expect(ctx.forge.reruns).toEqual([]);
    expect(rows).toEqual([]);
  });

  it("dry run writes nothing", async () => {
    const ctx = makeCtx({ dryRun: true });
    world(ctx, { mergeableState: "dirty" });
    await runRepair(ctx);
    expect(ctx.forge.dispatched).toEqual([]);
    expect(ctx.forge.comments(TEST_REPO, 5)).toEqual([]);
    expect(ctx.lines.some((l) => l.startsWith("[dry-run]"))).toBe(true);
  });
});
