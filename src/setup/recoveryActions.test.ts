import { describe, expect, it, vi } from "vitest";
import { makeCtx, TEST_REPO } from "../services/fakes.ts";
import {
  LABELS,
  DISPATCH_RESERVED_PREFIX,
  REPAIR_RESERVED_PREFIX,
  DISPATCHED_PREFIX,
} from "../dispatcher/notes.ts";
import {
  createDispatchReservation,
  reservationBody,
  reservationBinding,
} from "../dispatcher/reservations.ts";
import {
  bindRecoveryRun,
  listRecoveryReservations,
} from "./recoveryActions.ts";
import type { WorkflowRunEvidence } from "../forge/types.ts";

async function world(kind: "build" | "rc" | "ci" = "build") {
  const ctx = makeCtx();
  const ticket = ctx.linear.seedTicket({
    projectId: "lin_core",
    identifier: "GAME-7",
    labels: [LABELS.approved, LABELS.dispatched],
  });
  const pull =
    kind === "build"
      ? undefined
      : ctx.forge.seedPull(TEST_REPO, { number: 5, headRef: "pm/game-7" });
  const args = {
    project: ctx.project.config.name,
    ticket: ticket.identifier,
    attempt: kind === "build" ? 2 : 1,
    kind,
    ...(pull ? { pr: pull.number, branch: pull.headRef } : {}),
  };
  const scope = await createDispatchReservation(
    ctx,
    ticket,
    args,
    kind === "build" ? "dispatch" : kind === "rc" ? "conflict" : "ci",
    pull ? { headSha: pull.headSha } : {},
  );
  const body = reservationBody(
    kind === "build"
      ? `${DISPATCH_RESERVED_PREFIX} ${scope.id}`
      : `${REPAIR_RESERVED_PREFIX} ${kind} attempt 1`,
    scope,
  );
  if (pull) await ctx.forge.addPullComment(TEST_REPO, pull.number, body);
  else await ctx.linear.addComment(ticket.id, body);
  const run = ctx.forge.seedRun({ id: 99, status: "in_progress" });
  const evidence: WorkflowRunEvidence = {
    run,
    repository: ctx.hub.hubRepo,
    workflowFile: "developer.yml",
    ref: "main",
    event: "workflow_dispatch",
    inputs: {
      ...scope.inputs,
      branch: scope.inputs.branch ?? "",
      pr: scope.inputs.pr ?? "",
    },
    projectRepository: TEST_REPO,
    projectIntegrationBranch: ctx.project.config.branches.integration,
    ...(scope.projectInstanceId
      ? { projectInstanceId: scope.projectInstanceId }
      : {}),
  };
  ctx.forge.seedWorkflowEvidence(99, evidence);
  const comments = () =>
    pull ? ctx.forge.comments(TEST_REPO, 5) : ctx.linear.commentsOf(ticket.id);
  return {
    ctx,
    ticket,
    pull,
    scope,
    evidence,
    comments,
    input: { reservationId: scope.id, runId: 99 },
  };
}
describe("operator recovery with provider-authenticated scope", () => {
  it.each(["build", "rc", "ci"] as const)(
    "links a %s run without launching, retrying, publishing, or changing ticket workflow state",
    async (kind) => {
      const f = await world(kind);
      expect(await listRecoveryReservations(f.ctx)).toMatchObject([
        { id: f.scope.id, ticket: f.ticket.identifier, kind, supported: true },
      ]);
      expect(await bindRecoveryRun(f.ctx, f.input)).toMatchObject({
        status: "reconciled",
        reservationId: f.scope.id,
        runId: 99,
      });
      expect(f.comments().map(reservationBinding).filter(Boolean)).toEqual([
        { reservationId: f.scope.id, runId: 99 },
      ]);
      expect(await listRecoveryReservations(f.ctx)).toEqual([]);
      expect(
        await listRecoveryReservations(f.ctx, { includeBound: true }),
      ).toHaveLength(1);
      expect(await bindRecoveryRun(f.ctx, f.input)).toMatchObject({
        status: "already-reconciled",
      });
      expect(f.comments().map(reservationBinding).filter(Boolean)).toHaveLength(
        1,
      );
      expect(f.ctx.forge.dispatched).toEqual([]);
      expect(f.ctx.forge.reruns).toEqual([]);
      expect(f.ticket.stateType).toBe("backlog");
    },
  );
  it.each([
    "project",
    "ticket",
    "kind",
    "attempt",
    "marker",
    "scope",
    "branch",
    "pr",
  ])("rejects provider input mismatch %s", async (field) => {
    const f = await world("ci");
    f.evidence.inputs[field] = "different";
    await expect(bindRecoveryRun(f.ctx, f.input)).rejects.toThrow(
      "Provider evidence does not match",
    );
    expect(f.comments()).toHaveLength(1);
    expect(f.ctx.forge.dispatched).toEqual([]);
  });
  it.each([
    "hub",
    "target repository",
    "incarnation",
    "workflow",
    "ref",
    "integration",
    "event",
    "old run",
  ])("rejects mismatched immutable provider scope %s", async (scenario) => {
    const f = await world();
    if (scenario === "hub") f.evidence.repository = "another/hub";
    if (scenario === "target repository")
      f.evidence.projectRepository = "another/app";
    if (scenario === "incarnation")
      f.evidence.projectInstanceId = "replacement";
    if (scenario === "workflow") f.evidence.workflowFile = "another.yml";
    if (scenario === "ref") f.evidence.ref = "feature";
    if (scenario === "integration")
      f.evidence.projectIntegrationBranch = "another";
    if (scenario === "event") Object.assign(f.evidence, { event: "push" });
    if (scenario === "old run")
      f.evidence.run.createdAt = "2026-10-01T00:00:00Z";
    await expect(bindRecoveryRun(f.ctx, f.input)).rejects.toThrow(
      "Provider evidence does not match",
    );
    expect(f.comments()).toHaveLength(1);
  });
  it.each([
    "revoked",
    "canceled",
    "verified",
    "needs-human",
    "mapping",
    "base revision",
    "head revision",
  ])("rejects changed controller scope %s", async (scenario) => {
    const f = await world("rc");
    if (scenario === "revoked") f.ticket.labels = [];
    if (scenario === "canceled") f.ticket.stateType = "canceled";
    if (scenario === "verified") f.ticket.labels.push(LABELS.verified);
    if (scenario === "needs-human") f.ticket.labels.push(LABELS.needsHuman);
    if (scenario === "mapping") f.ticket.projectId = "other";
    if (scenario === "base revision")
      f.ctx.forge.seedBranch(
        TEST_REPO,
        f.scope.integrationBranch,
        "b".repeat(40),
      );
    if (scenario === "head revision")
      f.ctx.forge.patchPull(TEST_REPO, 5, { headSha: "b".repeat(40) });
    await expect(bindRecoveryRun(f.ctx, f.input)).rejects.toMatchObject({
      status: 409,
    });
    expect(f.comments()).toHaveLength(1);
  });
  it("repairs a lost receipt acknowledgment idempotently", async () => {
    const f = await world();
    const add = f.ctx.linear.addComment.bind(f.ctx.linear);
    vi.spyOn(f.ctx.linear, "addComment").mockImplementationOnce(
      async (...args) => {
        await add(...args);
        throw new Error("response lost");
      },
    );
    await expect(bindRecoveryRun(f.ctx, f.input)).rejects.toThrow();
    expect(await bindRecoveryRun(f.ctx, f.input)).toMatchObject({
      status: "already-reconciled",
    });
    expect(
      f.comments().filter((body) => body.startsWith(DISPATCHED_PREFIX)),
    ).toHaveLength(1);
    expect(f.ctx.forge.dispatched).toEqual([]);
  });
  it("serializes duplicate operator requests without duplicate receipts", async () => {
    const f = await world();
    const results = await Promise.all([
      bindRecoveryRun(f.ctx, f.input),
      bindRecoveryRun(f.ctx, f.input),
    ]);
    expect(results.map((result) => result.status)).toEqual([
      "reconciled",
      "already-reconciled",
    ]);
    expect(f.comments().map(reservationBinding).filter(Boolean)).toHaveLength(
      1,
    );
    expect(f.ctx.forge.dispatched).toEqual([]);
  });
  it("does not overwrite newer execution evidence with an older recovered receipt", async () => {
    const f = await world();
    await f.ctx.linear.addComment(f.ticket.id, `${DISPATCHED_PREFIX} 101`);
    await expect(bindRecoveryRun(f.ctx, f.input)).rejects.toThrow(
      "Newer execution evidence",
    );
    expect(f.comments().map(reservationBinding).filter(Boolean)).toEqual([]);
  });
  it("rejects browser-supplied proof fields and unavailable provider evidence", async () => {
    const f = await world();
    await expect(
      bindRecoveryRun(f.ctx, {
        ...f.input,
        inputs: f.scope.inputs,
      } as typeof f.input),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      bindRecoveryRun(f.ctx, { ...f.input, runId: 100 }),
    ).rejects.toMatchObject({ status: 409 });
    expect(f.comments()).toHaveLength(1);
  });
});
