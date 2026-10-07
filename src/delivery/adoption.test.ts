import { afterEach, describe, expect, it, vi } from "vitest";
import {
  mkdtempSync,
  realpathSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeForge } from "../forge/fake.ts";
import { FakeLinear, makeProject, TEST_REPO } from "../services/fakes.ts";
import {
  createDraftAdoption,
  type CompletedDraft,
  type DraftMigration,
} from "./adoption.ts";
import { projectRuntimeKey } from "../projectIdentity.ts";
import {
  readDraftMigrations,
  saveDraftMigrationStatus,
} from "./migrationStatus.ts";

const SHA = "a".repeat(40),
  NEW = "b".repeat(40),
  at = "2026-10-06T12:00:00.000Z";
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function world() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "draft-adoption-")));
  roots.push(root);
  const project = makeProject({
    config: {
      instanceId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      workflow: { kind: "promotion" },
      linear: {
        teamId: "team-1",
        workspaceId: "workspace-1",
        connectionId: "default",
      },
    },
  });
  const forge = new FakeForge(),
    linear = new FakeLinear();
  const ticket = linear.seedTicket({
    id: "ticket-1",
    identifier: "GAME-1",
    projectId: "lin_core",
    teamId: "team-1",
    labels: ["pm:core", "pm-approved"],
    description: "## Acceptance criteria\n- The control works.",
  });
  const completed: CompletedDraft = {
    job: {
      id: "job-one",
      project: "game",
      projectInstanceId: project.config.instanceId,
      type: "developer",
      developerKind: "build",
      status: "succeeded",
      area: "core",
      ticket: "GAME-1",
      runId: 1,
      createdAt: at,
      linearBinding: {
        connectionId: "default",
        workspaceId: "workspace-1",
        ticketId: ticket.id,
      },
    },
    change: {
      jobId: "job-one",
      runId: 1,
      area: "core",
      ticket: "GAME-1",
      ticketId: ticket.id,
      status: "succeeded",
      createdAt: at,
      message: "complete",
      activityUrl: "/activity?run=job-one",
      pullRequests: [
        { number: 7, url: `https://github.com/${TEST_REPO}/pull/7` },
      ],
      checks: { headSha: SHA, commands: ["test"], completedAt: at },
    },
  };
  forge.seedPull(TEST_REPO, {
    number: 7,
    headRef: "gremlins/job-one",
    headSha: SHA,
    baseRef: "main",
    draft: true,
  });
  forge.seedChecks(TEST_REPO, SHA, { status: "success", failedJobs: [] });
  const registered = new Map<string, DraftMigration>();
  const register = vi.fn(async (value: DraftMigration) => {
    registered.set(value.jobId, value);
  });
  const checkHead = vi.fn(async (_sha: string) => ({
    status: "success" as const,
    failedJobs: [],
  }));
  const retarget = vi.spyOn(forge, "retargetPull");
  const options = {
    root,
    project,
    currentProject: () => project,
    forge,
    ticket: (id: string) => linear.getTicket(id),
    checkHead,
    registered: (id: string) => registered.has(id),
    register,
    now: () => new Date(at),
  };
  return {
    ...options,
    options,
    forge,
    ticket,
    completed,
    registered,
    retarget,
    service: () => createDraftAdoption(options),
    receipt: () =>
      JSON.parse(
        readFileSync(
          join(
            root,
            ".run",
            "delivery",
            projectRuntimeKey(project.config),
            "migrations",
            "job-one.json",
          ),
          "utf8",
        ),
      ) as DraftMigration,
  };
}
describe("completed native draft migration", () => {
  it("retains a redacted blocker across restart and replaces it after recovery", async () => {
    const w = world();
    w.checkHead.mockRejectedValueOnce(
      new Error("Bearer secret-provider-token"),
    );
    const blocked = await w.service().adopt(w.completed);
    expect(readDraftMigrations(w.root, w.project)).toEqual([
      { ...blocked, checkedAt: at },
    ]);
    expect(
      JSON.stringify(readDraftMigrations(w.root, w.project)),
    ).not.toContain("secret-provider-token");
    expect((await w.service().adopt(w.completed)).phase).toBe("adopted");
    expect(readDraftMigrations(w.root, w.project)).toEqual([
      expect.objectContaining({ jobId: "job-one", phase: "adopted" }),
    ]);
    const replacement = structuredClone(w.project);
    replacement.config.instanceId = "bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee";
    expect(readDraftMigrations(w.root, replacement)).toEqual([]);
    replacement.config.instanceId = w.project.config.instanceId;
    replacement.config.repo = "other/app";
    expect(readDraftMigrations(w.root, replacement)).toEqual([]);
  });
  it("bounds retained migration statuses without deleting approval receipts", async () => {
    const w = world();
    await w.service().adopt(w.completed);
    const directory = join(
      w.root,
      ".run",
      "delivery",
      projectRuntimeKey(w.project.config),
      "migration-status",
    );
    for (let i = 0; i < 205; i++)
      writeFileSync(
        join(directory, `job-${i}.json`),
        JSON.stringify({
          schema: 1,
          repository: TEST_REPO,
          provider: "github",
          serverUrl: null,
          status: {
            jobId: `job-${i}`,
            phase: "waiting",
            message: "Wait for provider checks.",
            checkedAt: at,
          },
        }),
      );
    saveDraftMigrationStatus(w.root, w.project, {
      jobId: "job-latest",
      phase: "waiting",
      message: "Wait for provider checks.",
      checkedAt: at,
    });
    expect(readDraftMigrations(w.root, w.project)).toHaveLength(200);
    expect(w.receipt().jobId).toBe("job-one");
  });
  it("rejects a promotion configuration that aliases production before retargeting", async () => {
    const w = world();
    w.project.config.branches.integration = "main";
    expect((await w.service().adopt(w.completed)).phase).toBe("blocked");
    expect(w.retarget).not.toHaveBeenCalled();
    expect(w.register).not.toHaveBeenCalled();
  });
  it("retargets only the retained draft and records fresh approval/checks without fabricated historical admission", async () => {
    const w = world();
    expect(await w.service().adopt(w.completed)).toMatchObject({
      phase: "adopted",
    });
    expect(w.checkHead).toHaveBeenCalledWith(SHA);
    expect(w.retarget).toHaveBeenCalledExactlyOnceWith(
      TEST_REPO,
      7,
      "pm-staging",
    );
    expect(w.register).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "completed-draft-migration",
        headSha: SHA,
        originalHeadSha: SHA,
        approvedAt: at,
        approvedBy: expect.stringContaining("workflow migration"),
        checks: {
          headSha: SHA,
          commands: ["install", "test"],
          completedAt: at,
        },
      }),
    );
    expect(w.receipt().ticket.id).toBe("ticket-1");
    expect((await w.forge.getPull(TEST_REPO, 7))?.draft).toBe(true);
    expect(w.forge.merged).toHaveLength(0);
    expect(await w.service().adopt(w.completed)).toMatchObject({
      phase: "adopted",
    });
    expect(w.register).toHaveBeenCalledOnce();
    expect(w.retarget).toHaveBeenCalledOnce();
  });
  it.each([
    "project incarnation",
    "status",
    "job kind",
    "ticket UUID",
    "workspace",
    "connection",
    "area",
    "URL",
    "missing receipt",
    "unapproved",
    "no criteria",
    "foreign branch",
    "staging target",
    "closed",
  ])(
    "refuses %s mismatches before checks or retargeting",
    async (condition) => {
      const w = world();
      switch (condition) {
        case "project incarnation":
          w.completed.job.projectInstanceId = undefined;
          break;
        case "status":
          w.completed.job.status = "failed";
          break;
        case "job kind":
          w.completed.job.developerKind = "sync";
          break;
        case "ticket UUID":
          w.completed.job.linearBinding!.ticketId = "other";
          break;
        case "workspace":
          w.completed.job.linearBinding!.workspaceId = "other";
          break;
        case "connection":
          w.completed.job.linearBinding!.connectionId = "other";
          break;
        case "area":
          w.ticket.labels = ["pm:other", "pm-approved"];
          break;
        case "URL":
          w.completed.change.pullRequests[0]!.url =
            "https://github.com/other/repo/pull/7";
          break;
        case "missing receipt":
          w.completed.change.checks = undefined;
          break;
        case "unapproved":
          w.ticket.labels = ["pm:core"];
          break;
        case "no criteria":
          w.ticket.description = "do stuff";
          break;
        case "foreign branch":
          w.forge.patchPull(TEST_REPO, 7, { headRef: "someone/work" });
          break;
        case "staging target":
          w.forge.patchPull(TEST_REPO, 7, { baseRef: "staging" });
          break;
        case "closed":
          w.forge.patchPull(TEST_REPO, 7, { state: "closed" });
          break;
      }
      expect(await w.service().adopt(w.completed)).toMatchObject({
        phase: "blocked",
      });
      expect(w.checkHead).not.toHaveBeenCalled();
      expect(w.retarget).not.toHaveBeenCalled();
      expect(w.register).not.toHaveBeenCalled();
    },
  );
  it.each(["failure", "pending"] as const)(
    "waits for provider checks: %s",
    async (status) => {
      const w = world();
      w.forge.seedChecks(TEST_REPO, SHA, { status, failedJobs: [] });
      expect(await w.service().adopt(w.completed)).toMatchObject({
        phase: status === "pending" ? "waiting" : "blocked",
      });
      expect(w.checkHead).not.toHaveBeenCalled();
      expect(w.retarget).not.toHaveBeenCalled();
    },
  );
  it("requires independent exact-head checks even when provider checks pass", async () => {
    const w = world();
    w.options.checkHead = vi.fn(async () => ({
      status: "failure" as never,
      failedJobs: [],
    }));
    expect(await w.service().adopt(w.completed)).toMatchObject({
      phase: "blocked",
    });
    expect(w.retarget).not.toHaveBeenCalled();
  });
  it("checks a legitimate newer descendant instead of reusing the original receipt", async () => {
    const w = world();
    w.forge.patchPull(TEST_REPO, 7, { headSha: NEW });
    w.forge.seedCompare(TEST_REPO, SHA, NEW, { aheadBy: 1, behindBy: 0 });
    expect(await w.service().adopt(w.completed)).toMatchObject({
      phase: "adopted",
    });
    expect(w.checkHead).toHaveBeenCalledWith(NEW);
    expect(w.receipt()).toMatchObject({ originalHeadSha: SHA, headSha: NEW });
  });
  it.each([true, false])(
    "allows metadata-only rewrites only with equal immutable trees: %s",
    async (equal) => {
      const w = world();
      w.forge.patchPull(TEST_REPO, 7, { headSha: NEW });
      w.forge.seedCompare(TEST_REPO, SHA, NEW, { aheadBy: 1, behindBy: 1 });
      const entry = {
        path: "app.ts",
        sha: "c".repeat(40),
        mode: "100644",
        type: "blob",
      };
      w.forge.seedRevisionTree(TEST_REPO, SHA, [entry]);
      w.forge.seedRevisionTree(TEST_REPO, NEW, [
        { ...entry, sha: equal ? entry.sha : "d".repeat(40) },
      ]);
      expect(await w.service().adopt(w.completed)).toMatchObject({
        phase: equal ? "adopted" : "blocked",
      });
      expect(w.checkHead).toHaveBeenCalledTimes(equal ? 1 : 0);
      expect(w.retarget).toHaveBeenCalledTimes(equal ? 1 : 0);
    },
  );
  it.each(["config", "approval", "scope", "head"])(
    "preserves work when %s changes during checks",
    async (kind) => {
      const w = world();
      w.checkHead.mockImplementation(async () => {
        if (kind === "config")
          w.project.config.branches.integration = "different";
        if (kind === "approval") w.ticket.labels = ["pm:core"];
        if (kind === "scope") w.ticket.description += "\n- Another thing.";
        if (kind === "head") w.forge.patchPull(TEST_REPO, 7, { headSha: NEW });
        return { status: "success", failedJobs: [] };
      });
      expect(await w.service().adopt(w.completed)).toMatchObject({
        phase: "blocked",
      });
      expect(w.retarget).not.toHaveBeenCalled();
      expect(w.register).not.toHaveBeenCalled();
    },
  );
  it("holds the durable lock through checks across service instances", async () => {
    const w = world();
    let release!: () => void;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered!: () => void;
    const active = new Promise<void>((resolve) => {
      entered = resolve;
    });
    w.checkHead.mockImplementation(async () => {
      entered();
      await wait;
      return { status: "success", failedJobs: [] };
    });
    const first = w.service().adopt(w.completed);
    await active;
    expect(await w.service().adopt(w.completed)).toMatchObject({
      phase: "busy",
    });
    release();
    expect(await first).toMatchObject({ phase: "adopted" });
    expect(w.retarget).toHaveBeenCalledOnce();
  });
  it("recovers a lost retarget response after restart without another mutation", async () => {
    const w = world();
    w.retarget.mockImplementationOnce(async () => {
      w.forge.patchPull(TEST_REPO, 7, { baseRef: "pm-staging" });
      throw new Error("Bearer private-token");
    });
    const failed = await w.service().adopt(w.completed);
    expect(failed.phase).toBe("blocked");
    expect(JSON.stringify(failed)).not.toContain("private-token");
    expect(w.register).not.toHaveBeenCalled();
    expect(await w.service().adopt(w.completed)).toMatchObject({
      phase: "adopted",
    });
    expect(w.retarget).toHaveBeenCalledOnce();
  });
  it("does not register a changed head after retarget", async () => {
    const w = world();
    w.retarget.mockImplementationOnce(async () => {
      w.forge.patchPull(TEST_REPO, 7, { baseRef: "pm-staging", headSha: NEW });
    });
    expect(await w.service().adopt(w.completed)).toMatchObject({
      phase: "blocked",
    });
    expect(w.register).not.toHaveBeenCalled();
  });
});
