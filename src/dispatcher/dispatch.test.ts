import { describe, expect, it } from "vitest";
import { makeCtx, makeProject } from "../services/fakes.ts";
import { DISPATCHED_PREFIX, LABELS } from "./notes.ts";
import { developerInputs, fireDeveloper, runDispatch } from "./dispatch.ts";

const PROJECT = "lin_core";

describe("developerInputs", () => {
  it("builds the exact workflow_dispatch inputs with string values", () => {
    expect(
      developerInputs({
        project: "game",
        ticket: "GAME-1",
        attempt: 1,
        kind: "build",
      }),
    ).toEqual({
      project: "game",
      ticket: "GAME-1",
      attempt: "1",
      kind: "build",
    });
  });

  it("adds branch and pr for repairs", () => {
    expect(
      developerInputs({
        project: "game",
        ticket: "GAME-1",
        attempt: 2,
        kind: "rc",
        branch: "pm/game-1",
        pr: 7,
      }),
    ).toEqual({
      project: "game",
      ticket: "GAME-1",
      attempt: "2",
      kind: "rc",
      branch: "pm/game-1",
      pr: "7",
    });
  });
});

describe("fireDeveloper", () => {
  it("dispatches developer.yml on main in the hub repo", async () => {
    const ctx = makeCtx();
    const run = await fireDeveloper(ctx, {
      project: "game",
      ticket: "GAME-1",
      attempt: 1,
      kind: "build",
    });
    expect(run.id).toBeGreaterThan(0);
    expect(ctx.forge.dispatched).toEqual([
      {
        workflowFile: "developer.yml",
        ref: "main",
        inputs: {
          project: "game",
          ticket: "GAME-1",
          attempt: "1",
          kind: "build",
        },
        runId: run.id,
      },
    ]);
  });
});

describe("runDispatch", () => {
  it.each([
    [true, false],
    [false, true],
    [false, false],
    [true, true],
  ] as const)(
    "uses coding=%s independently of patrol=%s",
    async (codingEnabled, enabled) => {
      const ctx = makeCtx({
        project: makeProject({ areas: [{ enabled, codingEnabled }] }),
      });
      ctx.linear.seedTicket({ projectId: PROJECT, labels: [LABELS.approved] });
      await runDispatch(ctx);
      expect(ctx.forge.dispatched).toHaveLength(codingEnabled ? 1 : 0);
    },
  );
  it("fires, labels and comments on an approved ticket", async () => {
    const ctx = makeCtx();
    const t = ctx.linear.seedTicket({
      projectId: PROJECT,
      identifier: "GAME-1",
      labels: [LABELS.approved],
    });
    const rows = await runDispatch(ctx);
    expect(ctx.forge.dispatched).toHaveLength(1);
    const d = ctx.forge.dispatched[0]!;
    expect(d.inputs).toEqual({
      project: "game",
      ticket: "GAME-1",
      attempt: "1",
      kind: "build",
    });
    expect(ctx.linear.labelsOf(t.id)).toContain(LABELS.dispatched);
    expect(ctx.linear.commentsOf(t.id)).toEqual([
      `${DISPATCHED_PREFIX} ${d.runId} — https://github.com/owner/pm-hub/actions/runs/${d.runId}`,
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.rule).toBe("dispatch");
    expect(rows[0]!.ref).toBe("GAME-1");
    expect(rows[0]!.needsYou).toBeFalsy();
  });

  it("takes wipLimit minus in-flight, oldest first", async () => {
    const ctx = makeCtx();
    ctx.linear.seedTicket({
      projectId: PROJECT,
      identifier: "GAME-10",
      labels: [LABELS.dispatched],
      stateType: "started",
    });
    ctx.linear.seedTicket({
      projectId: PROJECT,
      identifier: "GAME-2",
      labels: [LABELS.approved],
      createdAt: "2026-09-02T00:00:00Z",
    });
    ctx.linear.seedTicket({
      projectId: PROJECT,
      identifier: "GAME-1",
      labels: [LABELS.approved],
      createdAt: "2026-09-01T00:00:00Z",
    });
    ctx.linear.seedTicket({
      projectId: PROJECT,
      identifier: "GAME-3",
      labels: [LABELS.approved],
      createdAt: "2026-09-03T00:00:00Z",
    });
    await runDispatch(ctx);
    expect(ctx.forge.dispatched.map((d) => d.inputs.ticket)).toEqual([
      "GAME-1",
    ]);
  });

  it("does not count verified, needs-human or closed dispatched tickets as in flight", async () => {
    const ctx = makeCtx();
    ctx.linear.seedTicket({
      projectId: PROJECT,
      labels: [LABELS.dispatched, LABELS.verified],
      stateType: "started",
    });
    ctx.linear.seedTicket({
      projectId: PROJECT,
      labels: [LABELS.dispatched, LABELS.needsHuman],
      stateType: "started",
    });
    ctx.linear.seedTicket({
      projectId: PROJECT,
      labels: [LABELS.dispatched],
      stateType: "completed",
    });
    ctx.linear.seedTicket({
      projectId: PROJECT,
      identifier: "GAME-1",
      labels: [LABELS.approved],
    });
    ctx.linear.seedTicket({
      projectId: PROJECT,
      identifier: "GAME-2",
      labels: [LABELS.approved],
    });
    ctx.linear.seedTicket({
      projectId: PROJECT,
      identifier: "GAME-3",
      labels: [LABELS.approved],
    });
    await runDispatch(ctx);
    expect(ctx.forge.dispatched.map((d) => d.inputs.ticket)).toEqual([
      "GAME-1",
      "GAME-2",
    ]);
  });

  it("skips done/canceled, needs-human and proposal tickets on a first dispatch", async () => {
    const ctx = makeCtx();
    ctx.linear.seedTicket({
      projectId: PROJECT,
      labels: [LABELS.approved],
      stateType: "completed",
    });
    ctx.linear.seedTicket({
      projectId: PROJECT,
      labels: [LABELS.approved],
      stateType: "canceled",
    });
    ctx.linear.seedTicket({
      projectId: PROJECT,
      labels: [LABELS.approved, LABELS.needsHuman],
    });
    ctx.linear.seedTicket({
      projectId: PROJECT,
      labels: [LABELS.approved, LABELS.proposal],
    });
    ctx.linear.seedTicket({
      projectId: PROJECT,
      labels: [LABELS.approved, LABELS.dispatched],
    });
    const rows = await runDispatch(ctx);
    expect(ctx.forge.dispatched).toEqual([]);
    expect(rows).toEqual([]);
  });

  it("retries a test-failed ticket once as attempt 2, even when Linear shows it done", async () => {
    const ctx = makeCtx();
    const t = ctx.linear.seedTicket({
      projectId: PROJECT,
      identifier: "GAME-5",
      labels: [LABELS.testFailed, LABELS.dispatched],
      stateType: "completed",
    });
    ctx.forge.seedRun({ id: 40, status: "completed" });
    await ctx.linear.addComment(t.id, `${DISPATCHED_PREFIX} 40 — url`);
    await runDispatch(ctx);
    expect(ctx.forge.dispatched).toHaveLength(1);
    expect(ctx.forge.dispatched[0]!.inputs).toMatchObject({
      ticket: "GAME-5",
      attempt: "2",
      kind: "build",
    });
    expect(ctx.linear.commentsOf(t.id)).toHaveLength(2);
  });

  it("does not retry a test-failed ticket that was already retried", async () => {
    const ctx = makeCtx();
    const t = ctx.linear.seedTicket({
      projectId: PROJECT,
      labels: [LABELS.testFailed, LABELS.dispatched],
    });
    await ctx.linear.addComment(t.id, `${DISPATCHED_PREFIX} 40 — url`);
    await ctx.linear.addComment(t.id, `${DISPATCHED_PREFIX} 41 — url`);
    await runDispatch(ctx);
    expect(ctx.forge.dispatched).toEqual([]);
  });

  it("repairs a half-done dispatch (comment present, run live) without re-firing", async () => {
    const ctx = makeCtx();
    const t = ctx.linear.seedTicket({
      projectId: PROJECT,
      identifier: "GAME-7",
      labels: [LABELS.approved],
    });
    ctx.forge.seedRun({ id: 77, status: "in_progress", conclusion: null });
    await ctx.linear.addComment(t.id, `${DISPATCHED_PREFIX} 77 — url`);
    const rows = await runDispatch(ctx);
    expect(ctx.forge.dispatched).toEqual([]);
    expect(ctx.linear.labelsOf(t.id)).toContain(LABELS.dispatched);
    expect(ctx.linear.commentsOf(t.id)).toHaveLength(1);
    expect(rows).toEqual([]);
  });

  it("fires again when the earlier dispatch comment names a finished run", async () => {
    const ctx = makeCtx();
    const t = ctx.linear.seedTicket({
      projectId: PROJECT,
      identifier: "GAME-7",
      labels: [LABELS.approved],
    });
    ctx.forge.seedRun({ id: 77, status: "completed" });
    await ctx.linear.addComment(t.id, `${DISPATCHED_PREFIX} 77 — url`);
    await runDispatch(ctx);
    expect(ctx.forge.dispatched).toHaveLength(1);
  });

  it("skips disabled areas", async () => {
    const ctx = makeCtx({
      project: makeProject({ areas: [{ enabled: false }] }),
    });
    ctx.linear.seedTicket({ projectId: PROJECT, labels: [LABELS.approved] });
    await runDispatch(ctx);
    expect(ctx.forge.dispatched).toEqual([]);
  });

  it("dry run writes nothing and logs", async () => {
    const ctx = makeCtx({ dryRun: true });
    const t = ctx.linear.seedTicket({
      projectId: PROJECT,
      identifier: "GAME-1",
      labels: [LABELS.approved],
    });
    await runDispatch(ctx);
    expect(ctx.forge.dispatched).toEqual([]);
    expect(ctx.linear.labelsOf(t.id)).toEqual([LABELS.approved]);
    expect(ctx.linear.commentsOf(t.id)).toEqual([]);
    expect(ctx.lines.some((l) => l.startsWith("[dry-run]"))).toBe(true);
  });

  it("a sync ticket never takes a WIP slot and is never built as an ordinary ticket", async () => {
    const ctx = makeCtx(); // wipLimit 2
    ctx.linear.seedTicket({
      projectId: "lin_core",
      identifier: "T-SYNC",
      labels: [LABELS.sync, LABELS.dispatched, "pm:core"],
    });
    ctx.linear.seedTicket({
      projectId: "lin_core",
      identifier: "T-SYNC2",
      labels: [LABELS.sync, LABELS.approved, "pm:core"],
    });
    const a = ctx.linear.seedTicket({
      projectId: "lin_core",
      labels: [LABELS.approved],
    });
    const b = ctx.linear.seedTicket({
      projectId: "lin_core",
      labels: [LABELS.approved],
    });
    await runDispatch(ctx);
    expect(ctx.forge.dispatched.map((d) => d.inputs.ticket)).toEqual([
      a.identifier,
      b.identifier,
    ]);
  });
});
