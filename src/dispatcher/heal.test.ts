import { describe, expect, it } from "vitest";
import { makeCtx, TEST_REPO } from "../services/fakes.ts";
import type { TestCtx } from "../services/fakes.ts";
import {
  developerBranch,
  DISPATCHED_PREFIX,
  HEAL_GAVE_UP_PREFIX,
  LABELS,
  PR_OPENED_PREFIX,
  RETRIGGERED_PREFIX,
} from "./notes.ts";
import { runHeal } from "./heal.ts";

const PROJECT = "lin_core";

async function dispatchedTicket(
  ctx: TestCtx,
  runStatus: "queued" | "in_progress" | "completed",
  labels: string[] = [LABELS.dispatched],
) {
  const t = ctx.linear.seedTicket({
    projectId: PROJECT,
    identifier: "GAME-3",
    labels,
  });
  ctx.forge.seedRun({
    id: 50,
    status: runStatus,
    conclusion: runStatus === "completed" ? "success" : null,
  });
  await ctx.linear.addComment(t.id, `${DISPATCHED_PREFIX} 50 — url`);
  return t;
}

describe("runHeal", () => {
  it("reports overdue live work without dispatching a duplicate worker", async () => {
    const ctx = makeCtx();
    await dispatchedTicket(ctx, "queued");
    ctx.forge.seedRun({
      id: 50,
      status: "queued",
      createdAt: "2026-10-02T09:00:00Z",
    });
    const rows = await runHeal(ctx);
    expect(ctx.forge.dispatched).toEqual([]);
    expect(rows[0]).toMatchObject({ needsYou: true, ref: "GAME-3" });
    expect(rows[0]?.text).toContain("deadline");
  });

  it("never retries a completed Linear ticket", async () => {
    const ctx = makeCtx();
    const ticket = await dispatchedTicket(ctx, "completed");
    ticket.stateType = "completed";
    expect(await runHeal(ctx)).toEqual([]);
    expect(ctx.forge.dispatched).toEqual([]);
  });

  it("re-fires once when the run completed and left no PR", async () => {
    const ctx = makeCtx();
    const t = await dispatchedTicket(ctx, "completed");
    const rows = await runHeal(ctx);
    expect(ctx.forge.dispatched).toHaveLength(1);
    expect(ctx.forge.dispatched[0]!.inputs).toEqual({
      project: "game",
      ticket: "GAME-3",
      attempt: "2",
      kind: "build",
    });
    const runId = ctx.forge.dispatched[0]!.runId;
    expect(ctx.linear.commentsOf(t.id)).toEqual([
      `${DISPATCHED_PREFIX} 50 — url`,
      `${RETRIGGERED_PREFIX} ${runId}`,
    ]);
    expect(ctx.linear.labelsOf(t.id)).toEqual([LABELS.dispatched]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ rule: "heal", ref: "GAME-3" });
    expect(rows[0]!.needsYou).toBeFalsy();
  });

  it("hands the ticket to a human when the re-fired run also ends with no PR", async () => {
    const ctx = makeCtx();
    const t = await dispatchedTicket(ctx, "completed");
    ctx.forge.seedRun({ id: 51, status: "completed" });
    await ctx.linear.addComment(t.id, `${RETRIGGERED_PREFIX} 51`);
    const rows = await runHeal(ctx);
    expect(ctx.forge.dispatched).toEqual([]);
    expect(ctx.linear.commentsOf(t.id).at(-1)).toBe(
      `${HEAL_GAVE_UP_PREFIX} with no PR`,
    );
    expect(ctx.linear.labelsOf(t.id)).toEqual([LABELS.needsHuman]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      rule: "heal",
      needsYou: true,
      ref: "GAME-3",
    });
  });

  it("leaves a queued or running run alone", async () => {
    for (const status of ["queued", "in_progress"] as const) {
      const ctx = makeCtx();
      const t = await dispatchedTicket(ctx, status);
      const rows = await runHeal(ctx);
      expect(ctx.forge.dispatched).toEqual([]);
      expect(ctx.linear.commentsOf(t.id)).toHaveLength(1);
      expect(rows).toEqual([]);
    }
  });

  it("leaves a re-triggered run that is still running alone", async () => {
    const ctx = makeCtx();
    const t = await dispatchedTicket(ctx, "completed");
    ctx.forge.seedRun({ id: 51, status: "in_progress", conclusion: null });
    await ctx.linear.addComment(t.id, `${RETRIGGERED_PREFIX} 51`);
    const rows = await runHeal(ctx);
    expect(ctx.forge.dispatched).toEqual([]);
    expect(ctx.linear.labelsOf(t.id)).toEqual([LABELS.dispatched]);
    expect(rows).toEqual([]);
  });

  it("does nothing when the ticket carries a PR-opened comment after the dispatch", async () => {
    const ctx = makeCtx();
    const t = await dispatchedTicket(ctx, "completed");
    await ctx.linear.addComment(t.id, `${PR_OPENED_PREFIX} #4`);
    const rows = await runHeal(ctx);
    expect(ctx.forge.dispatched).toEqual([]);
    expect(rows).toEqual([]);
  });

  it("does nothing when an open bot PR exists on the developer branch", async () => {
    const ctx = makeCtx();
    await dispatchedTicket(ctx, "completed");
    ctx.forge.seedPull(TEST_REPO, { headRef: developerBranch("GAME-3") });
    const rows = await runHeal(ctx);
    expect(ctx.forge.dispatched).toEqual([]);
    expect(rows).toEqual([]);
  });

  it("a PR-opened comment before the latest dispatch does not count", async () => {
    const ctx = makeCtx();
    const t = ctx.linear.seedTicket({
      projectId: PROJECT,
      identifier: "GAME-3",
      labels: [LABELS.dispatched],
    });
    ctx.forge.seedRun({ id: 50, status: "completed" });
    ctx.forge.seedRun({ id: 60, status: "completed" });
    await ctx.linear.addComment(t.id, `${DISPATCHED_PREFIX} 50 — url`);
    await ctx.linear.addComment(t.id, `${PR_OPENED_PREFIX} #4`);
    await ctx.linear.addComment(t.id, `${DISPATCHED_PREFIX} 60 — url`);
    await runHeal(ctx);
    expect(ctx.forge.dispatched).toHaveLength(1);
  });

  it("skips verified and needs-human tickets", async () => {
    const ctx = makeCtx();
    await dispatchedTicket(ctx, "completed", [
      LABELS.dispatched,
      LABELS.verified,
    ]);
    const t2 = ctx.linear.seedTicket({
      projectId: PROJECT,
      identifier: "GAME-4",
      labels: [LABELS.dispatched, LABELS.needsHuman],
    });
    await ctx.linear.addComment(t2.id, `${DISPATCHED_PREFIX} 50 — url`);
    const rows = await runHeal(ctx);
    expect(ctx.forge.dispatched).toEqual([]);
    expect(rows).toEqual([]);
  });

  it("dry run writes nothing", async () => {
    const ctx = makeCtx({ dryRun: true });
    const t = await dispatchedTicket(ctx, "completed");
    await runHeal(ctx);
    expect(ctx.forge.dispatched).toEqual([]);
    expect(ctx.linear.commentsOf(t.id)).toHaveLength(1);
    expect(ctx.lines.some((l) => l.startsWith("[dry-run]"))).toBe(true);
  });

  it("leaves the sync rule's own tickets alone (they are re-dispatched as kind sync, not build)", async () => {
    const ctx = makeCtx();
    const t = ctx.linear.seedTicket({
      projectId: "lin_core",
      labels: [LABELS.sync, LABELS.dispatched],
    });
    const run = ctx.forge.seedRun({ id: 900, status: "completed" });
    await ctx.linear.addComment(t.id, `${DISPATCHED_PREFIX} ${run.id} — url`);
    const rows = await runHeal(ctx);
    expect(ctx.forge.dispatched).toEqual([]);
    expect(rows).toEqual([]);
  });
});
