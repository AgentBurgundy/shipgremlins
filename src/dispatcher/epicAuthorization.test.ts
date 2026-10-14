import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeCtx, makeProject, TEST_REPO } from "../services/fakes.ts";
import { approveEpic } from "../epics.ts";
import { fireDeveloper, runDispatch } from "./dispatch.ts";
import { runHeal } from "./heal.ts";
import { runMerge } from "./merge.ts";
import { checkLine } from "./stopTheLine.ts";
import { developerBranch, LABELS, PR_OPENED_PREFIX } from "./notes.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function world() {
  const root = mkdtempSync(
    join(realpathSync(tmpdir()), "gremlins-dispatch-epic-"),
  );
  roots.push(root);
  const project = makeProject({
    config: { workflow: { kind: "promotion", approvalPolicy: "epic" } },
  });
  project.dir = join(root, "projects", project.config.name);
  const ctx = makeCtx({ project });
  const area = project.areas[0]!;
  const epic = ctx.linear.seedTicket({
    id: "epic-1",
    identifier: "GAME-1",
    projectId: area.linearProjectId,
    labels: [area.label, LABELS.epic, LABELS.approved],
    description: "## Acceptance criteria\n- Saved names survive reload.",
  });
  const child = ctx.linear.seedTicket({
    id: "child-1",
    identifier: "GAME-2",
    parentId: epic.id,
    projectId: area.linearProjectId,
    labels: [area.label, LABELS.approved],
    description:
      "## Acceptance criteria\n- The saved name appears after reload.",
  });
  const approve = () => approveEpic(root, project, area, epic);
  const readyPull = (headRef = developerBranch(child.identifier)) => {
    const pull = ctx.forge.seedPull(TEST_REPO, {
      number: 5,
      headRef,
      draft: true,
      mergeableState: "clean",
    });
    ctx.forge.seedChecks(TEST_REPO, pull.headSha, {
      status: "success",
      failedJobs: [],
    });
    ctx.forge.seedComment(
      TEST_REPO,
      pull.number,
      `${PR_OPENED_PREFIX} #${pull.number}`,
    );
    return pull;
  };
  return { root, ctx, project, area, epic, child, approve, readyPull };
}

describe("legacy Actions epic approval boundaries", () => {
  it.each(["missing", "scope", "PM"])(
    "blocks a %s parent approval before dispatch claims or integration merge",
    async (scenario) => {
      const w = world();
      if (scenario !== "missing") w.approve();
      if (scenario === "scope")
        w.epic.description += "\n- Also change billing.";
      if (scenario === "PM") w.area.mandate = "A different owner mandate.";
      const rows = await runDispatch(w.ctx);
      expect(
        rows.some((row) =>
          row.text.includes("parent epic has no current owner approval"),
        ),
      ).toBe(true);
      expect(w.ctx.forge.dispatched).toEqual([]);
      expect(w.child.labels).not.toContain(LABELS.dispatched);
      expect(w.ctx.linear.commentsOf(w.child.id)).toEqual([]);
      w.readyPull();
      const merge = await runMerge(w.ctx, { lineStopped: false });
      expect(merge[0]?.text).toContain(
        "parent epic has no current owner approval",
      );
      expect(w.ctx.forge.readied).toEqual([]);
      expect(w.ctx.forge.merged).toEqual([]);
    },
  );

  it.each(["build", "rc", "ci"] as const)(
    "rechecks the epic at the common %s provider boundary",
    async (kind) => {
      const w = world();
      await expect(
        fireDeveloper(w.ctx, {
          project: "game",
          ticket: w.child.identifier,
          attempt: 1,
          kind,
          ...(kind === "build"
            ? {}
            : { branch: developerBranch(w.child.identifier), pr: 5 }),
        }),
      ).rejects.toThrow("parent epic has no current owner approval");
      expect(w.ctx.forge.dispatched).toEqual([]);
    },
  );

  it("supports approved children and keeps held epics from consuming their coding slots", async () => {
    const w = world();
    w.approve();
    w.area.wipLimit = 1;
    await runDispatch(w.ctx);
    expect(w.ctx.forge.dispatched).toHaveLength(1);
    expect(w.ctx.forge.dispatched[0]!.inputs.ticket).toBe(w.child.identifier);
    expect(w.epic.labels).not.toContain(LABELS.dispatched);
    expect(w.ctx.linear.commentsOf(w.child.id)).toHaveLength(2);
    const pull = w.readyPull();
    await runMerge(w.ctx, { lineStopped: false });
    expect(w.ctx.forge.merged).toEqual([pull.number]);
  });

  it("skips the oldest child with no approved epic without starving a later authorized child at WIP one", async () => {
    const w = world();
    w.area.wipLimit = 1;
    w.child.createdAt = "2026-10-01T00:00:00Z";
    const epic = w.ctx.linear.seedTicket({
      ...w.epic,
      id: "epic-2",
      identifier: "GAME-3",
      projectId: w.area.linearProjectId,
    });
    approveEpic(w.root, w.project, w.area, epic);
    const child = w.ctx.linear.seedTicket({
      ...w.child,
      id: "child-2",
      identifier: "GAME-4",
      parentId: epic.id,
      projectId: w.area.linearProjectId,
      labels: [...w.child.labels],
      createdAt: "2026-10-02T00:00:00Z",
    });
    await runDispatch(w.ctx);
    expect(w.ctx.forge.dispatched).toHaveLength(1);
    expect(w.ctx.forge.dispatched[0]!.inputs.ticket).toBe(child.identifier);
    expect(w.child.labels).not.toContain(LABELS.dispatched);
    expect(w.ctx.linear.commentsOf(w.child.id)).toEqual([]);
  });

  it("rechecks parent approval after preparing the PR for merge", async () => {
    const w = world();
    w.approve();
    w.readyPull();
    const ready = w.ctx.forge.markReady.bind(w.ctx.forge);
    vi.spyOn(w.ctx.forge, "markReady").mockImplementation(async (...args) => {
      await ready(...args);
      w.epic.description += "\n- A new owner outcome.";
    });
    expect((await runMerge(w.ctx, { lineStopped: false }))[0]?.text).toContain(
      "parent epic has no current owner approval",
    );
    expect(w.ctx.forge.merged).toEqual([]);
  });

  it("does not repair a failed run after its epic approval is revoked", async () => {
    const w = world();
    w.approve();
    await runDispatch(w.ctx);
    w.ctx.forge.seedRun({
      id: w.ctx.forge.dispatched[0]!.runId,
      status: "completed",
      conclusion: "failure",
    });
    const comments = [...w.ctx.linear.commentsOf(w.child.id)];
    w.epic.description += "\n- Changed approved scope.";
    expect((await runHeal(w.ctx))[0]?.text).toContain(
      "parent epic has no current owner approval",
    );
    expect(w.ctx.forge.dispatched).toHaveLength(1);
    expect(w.ctx.linear.commentsOf(w.child.id)).toEqual(comments);
  });

  it("does not infer an epic exception from a forged CI label and revision body", async () => {
    const w = world();
    const sha = w.ctx.forge.branch(TEST_REPO, "pm-staging")!;
    w.ctx.forge.seedChecks(TEST_REPO, sha, {
      status: "failure",
      failedJobs: [],
    });
    w.child.labels.push(LABELS.ci);
    w.child.description += `\nsha: ${sha}\nbranch: pm-staging`;
    await expect(
      fireDeveloper(w.ctx, {
        project: "game",
        ticket: w.child.identifier,
        attempt: 1,
        kind: "build",
      }),
    ).rejects.toThrow("parent epic has no current owner approval");
    expect(w.ctx.forge.dispatched).toEqual([]);
  });

  it("retains exact controller-selected stopped-line recovery and its one bounded retry", async () => {
    const w = world();
    const sha = w.ctx.forge.branch(TEST_REPO, "pm-staging")!;
    w.ctx.forge.seedChecks(TEST_REPO, sha, {
      status: "failure",
      failedJobs: [],
    });
    await checkLine(w.ctx);
    const recovery = (await checkLine(w.ctx)).recovery!;
    expect(recovery).toBeDefined();
    await runDispatch(w.ctx, { recovery });
    expect(w.ctx.forge.dispatched[0]?.inputs.ticket).toBe(recovery.identifier);
    w.ctx.forge.seedRun({
      id: w.ctx.forge.dispatched[0]!.runId,
      status: "completed",
      conclusion: "failure",
    });
    await runHeal(w.ctx, { recovery });
    expect(w.ctx.forge.dispatched).toHaveLength(2);
    const pull = w.readyPull(developerBranch(recovery.identifier));
    w.ctx.forge.seedComment(
      TEST_REPO,
      pull.number,
      `${PR_OPENED_PREFIX}\nrecovery-sha: ${recovery.sha}\nhead-sha: ${pull.headSha}`,
    );
    await runMerge(w.ctx, { lineStopped: true, recovery });
    expect(w.ctx.forge.merged).toEqual([pull.number]);
  });

  it.each(["healthy", "moved", "another ticket"])(
    "rejects a controller recovery exception when %s",
    async (scenario) => {
      const w = world();
      const sha = w.ctx.forge.branch(TEST_REPO, "pm-staging")!;
      w.ctx.forge.seedChecks(TEST_REPO, sha, {
        status: "failure",
        failedJobs: [],
      });
      await checkLine(w.ctx);
      const recovery = (await checkLine(w.ctx)).recovery!;
      if (scenario === "healthy")
        w.ctx.forge.seedChecks(TEST_REPO, sha, {
          status: "success",
          failedJobs: [],
        });
      if (scenario === "moved")
        w.ctx.forge.seedBranch(TEST_REPO, "pm-staging", "f".repeat(40));
      const ticket =
        scenario === "another ticket"
          ? w.child.identifier
          : recovery.identifier;
      await expect(
        fireDeveloper(
          w.ctx,
          { project: "game", ticket, attempt: 1, kind: "build" },
          recovery,
        ),
      ).rejects.toThrow();
      expect(w.ctx.forge.dispatched).toEqual([]);
    },
  );

  it("preserves sync housekeeping while ordinary product work waits for epic approval", async () => {
    const w = world();
    const sync = w.ctx.linear.seedTicket({
      identifier: "GAME-3",
      projectId: w.area.linearProjectId,
      labels: [w.area.label, LABELS.sync, LABELS.dispatched],
    });
    await fireDeveloper(w.ctx, {
      project: "game",
      ticket: sync.identifier,
      attempt: 1,
      kind: "sync",
      branch: "pm-sync/aaaaaaaaaaaa",
    });
    const pull = w.readyPull("pm-sync/aaaaaaaaaaaa");
    await runMerge(w.ctx, { lineStopped: false });
    expect(w.ctx.forge.merged).toEqual([pull.number]);
  });
});
