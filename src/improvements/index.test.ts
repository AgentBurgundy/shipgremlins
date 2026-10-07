import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeSetup } from "../setup/files.ts";
import { loadProject, type Project } from "../config.ts";
import { createImprovements, missionCodingBlocker } from "./index.ts";
import type { LocalJob, LocalJobInput } from "../localRunners/types.ts";
import type { LinearTicket } from "../services/types.ts";
import { grumblinFixture } from "../grumblins/runtime-test-support.ts";

let root: string;
const teamId = "11111111-1111-4111-8111-111111111111";
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "improvement-mission-")));
  initializeSetup(root, process.cwd(), { project: "app", repo: "owner/app" });
  edit("project.json", (value) => {
    value.workflow = { kind: "pull-request", baseBranch: "main" };
    value.linear = { connectionId: "default", teamId };
  });
  edit("areas.json", (value) => {
    value.areas.core.linearProjectId = "mapped-project";
    value.areas.core.instanceId = randomUUID();
  });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
function edit(
  name: string,
  change: (value: {
    workflow: {
      kind: string;
      baseBranch?: string;
      approvalPolicy?: "epic" | "ticket";
    };
    linear: { connectionId: string; teamId: string };
    areas: { core: { linearProjectId: string; instanceId: string } };
  }) => void,
) {
  const file = join(root, "projects/app", name);
  const value = JSON.parse(readFileSync(file, "utf8"));
  change(value);
  writeFileSync(file, JSON.stringify(value));
}
function fixture() {
  const jobs: LocalJob[] = [];
  const tickets = [1, 2].map((number): LinearTicket => ({
    id: randomUUID(),
    identifier: "APP-" + number,
    title: "Improve actual workflow " + number,
    description:
      "Implement the existing data path.\n\n## Acceptance criteria\n- Existing saved records remain editable.\n- A failed request preserves the user's changes.",
    labels: ["pm:core", "pm-proposal"],
    stateType: "unstarted",
    priority: number,
    projectId: "mapped-project",
    teamId,
    createdAt: "2026-10-05",
    updatedAt: "2026-10-05",
    url: "https://linear.app/test/issue/APP-" + number,
  }));
  const candidates = vi.fn(async () => ({
    items: tickets.map((ticket) => ({
      ...ticket,
      revision: "review-" + ticket.id,
      area: "core",
      canApprove: true,
    })),
  }));
  const ticket = vi.fn(async (_project: Project, id: string) =>
    structuredClone(tickets.find((item) => item.id === id) ?? null),
  );
  const approve = vi.fn(async (_project: string, id: string) => {
    tickets.find((item) => item.id === id)!.labels = ["pm:core", "pm-approved"];
  });
  const enqueue = vi.fn(async (input: LocalJobInput) => {
    const existing = jobs.find(
      (job) => job.idempotencyKey === input.idempotencyKey,
    );
    if (existing) return existing;
    const exact = tickets.find((item) => item.identifier === input.ticket);
    const job: LocalJob = {
      ...input,
      id: "job-" + (jobs.length + 1),
      runId: jobs.length + 1,
      status: "queued",
      createdAt: new Date().toISOString(),
      ...(exact
        ? {
            linearBinding: {
              connectionId: "default",
              workspaceId: "resolved-workspace",
              ticketId: exact.id,
            },
          }
        : {}),
    };
    jobs.push(job);
    return job;
  });
  const merged = vi.fn(async () => false);
  const profile = grumblinFixture({
    projectInstanceId: loadProject(root, "app").config.instanceId,
  });
  const options = {
    root,
    jobs: async () => jobs,
    enqueue,
    candidates,
    ticket,
    approve,
    merged,
    deliveries: () => [],
    profile: () => profile,
  };
  const service = createImprovements(options);
  const start = () =>
    service.create("app", {
      outcome: "Make editing existing records reliable",
      area: "core",
    });
  const plan = async (id: string, both = false) => {
    const detail = await service.detail("app", id);
    return service.plan("app", id, {
      revision: detail.mission.revision,
      steps: tickets.slice(0, both ? 2 : 1).map((item, index) => ({
        ticketId: item.id,
        revision: "review-" + item.id,
        dependsOn: index ? [tickets[0]!.id] : [],
      })),
    });
  };
  return {
    service,
    options,
    jobs,
    tickets,
    enqueue,
    candidates,
    ticket,
    approve,
    merged,
    profile,
    start,
    plan,
  };
}
describe("durable improvement missions", () => {
  it("routes new epic-governed missions to epic approval instead of treating an epic as a coding step", async () => {
    edit("project.json", (value) => {
      value.workflow = { kind: "promotion", approvalPolicy: "epic" };
    });
    const f = fixture(),
      mission = await f.start();
    f.tickets[0]!.labels.push("pm-epic");
    expect((await f.service.detail("app", mission.id)).approvalPolicy).toBe(
      "epic",
    );
    await expect(f.plan(mission.id)).rejects.toThrow("Epic review");
    expect(f.approve).not.toHaveBeenCalled();
    expect(f.jobs.every((job) => job.type === "pm")).toBe(true);
    expect(
      (await f.service.detail("app", mission.id)).mission.plan,
    ).toBeUndefined();
  });
  it("keeps staging maintenance out of product changes and exposes the staged workflow", async () => {
    edit("project.json", (value) => {
      value.workflow = { kind: "promotion" };
    });
    const f = fixture();
    const job: LocalJob = {
      id: "job-sync-fixture",
      runId: 1,
      type: "developer",
      developerKind: "sync",
      project: "app",
      projectInstanceId: loadProject(root, "app").config.instanceId,
      status: "succeeded",
      createdAt: new Date().toISOString(),
      ticket: "SYNC-123",
    };
    f.jobs.push(job);
    f.service.captureResult(job, {
      ok: true,
      kind: "developer",
      nonce: job.id,
      prUrl: "https://github.com/owner/app/pull/1",
      headSha: "a".repeat(40),
      checks: ["test"],
    });
    const result = await f.service.list("app");
    expect(result.workflow).toEqual({ kind: "promotion" });
    expect(result.changes).toEqual([]);
  });
  it("preserves the mission workspace across restart and damaged journals while isolating replacement projects", async () => {
    const f = fixture(),
      project = loadProject(root, "app");
    expect(f.service.hasMissions(project)).toBe(false);
    await f.start();
    const restarted = createImprovements(f.options);
    expect(restarted.hasMissions(project)).toBe(true);
    const file = join(root, ".run", "improvements", "app", "missions.json");
    writeFileSync(file, "{ repair required");
    expect(restarted.hasMissions(project)).toBe(true);
    expect(readFileSync(file, "utf8")).toBe("{ repair required");
    expect(
      restarted.hasMissions({
        ...project,
        config: { ...project.config, instanceId: randomUUID() },
      }),
    ).toBe(false);
  });
  it("recovers an accepted approval with a lost response without approving twice", async () => {
    const f = fixture(),
      mission = await f.start();
    const approve = f.approve.getMockImplementation()!;
    f.approve.mockImplementationOnce(async (project, id) => {
      await approve(project, id);
      throw new Error("Approval response lost");
    });
    const interrupted = await f.plan(mission.id);
    expect(interrupted.message).toContain("Approval response lost");
    expect(f.jobs).toHaveLength(1);
    const restarted = createImprovements(f.options);
    const recovered = await restarted.advance("app", mission.id);
    expect(recovered.plan!.steps[0]!.status).toBe("queued");
    expect(f.approve).toHaveBeenCalledTimes(1);
    await restarted.advance("app", mission.id);
    expect(f.jobs).toHaveLength(2);
  });
  it("retains the explicitly selected followup profile and deduplicates pending replay", async () => {
    const f = fixture(),
      mission = await f.start();
    f.jobs[0]!.status = "succeeded";
    const input = {
      profileId: f.profile.id,
      profileRevision: f.profile.revision,
    };
    await f.service.followup("app", mission.id, input);
    const restarted = createImprovements(f.options);
    const repeated = await restarted.followup("app", mission.id, input);
    expect(repeated.followups).toHaveLength(1);
    expect(f.jobs).toHaveLength(2);
    expect(f.jobs[1]).toMatchObject({
      pmMode: "grumblin",
      grumblin: JSON.parse(JSON.stringify(f.profile)),
      runOnce: true,
    });
    expect(f.approve).not.toHaveBeenCalled();
  });
  it("never treats a prior completed attempt as proof of a newly approved plan", async () => {
    const f = fixture(),
      mission = await f.start();
    f.jobs.push({
      id: "old-scope",
      runId: 2,
      type: "developer",
      project: "app",
      projectInstanceId: loadProject(root, "app").config.instanceId,
      area: "core",
      ticket: f.tickets[0]!.identifier,
      linearBinding: { ticketId: f.tickets[0]!.id, connectionId: "default" },
      status: "succeeded",
      createdAt: "2020-01-01T00:00:00Z",
    });
    f.merged.mockResolvedValue(true);
    const planned = await f.plan(mission.id, true);
    expect(planned.message).toContain("predates this plan");
    expect(f.jobs).toHaveLength(2);
    expect(f.merged).not.toHaveBeenCalled();
    expect(
      missionCodingBlocker(root, "app", f.tickets[1]!.id, f.tickets[1]),
    ).toBeDefined();
  });
  it("recovers a lost enqueue response and restart without another investigation", async () => {
    const f = fixture(),
      enqueue = f.enqueue.getMockImplementation()!;
    f.enqueue.mockImplementationOnce(async (input) => {
      await enqueue(input);
      throw new Error("Lost response");
    });
    const mission = await f.start();
    expect(mission.investigation.jobId).toBe(f.jobs[0]!.id);
    const restarted = createImprovements(f.options);
    const again = await restarted.create("app", {
      outcome: mission.outcome,
      area: "core",
    });
    expect(again.id).toBe(mission.id);
    expect(again.investigation.jobId).toBe(f.jobs[0]!.id);
    expect(f.enqueue).toHaveBeenCalledTimes(1);
    expect(f.approve).not.toHaveBeenCalled();
  });
  it("rejects scope changed between candidate review and exact ticket lookup", async () => {
    const f = fixture(),
      mission = await f.start();
    f.ticket.mockImplementationOnce(async () => ({
      ...f.tickets[0]!,
      title: "Different owner scope",
    }));
    await expect(f.plan(mission.id)).rejects.toThrow("proposal changed");
    expect(f.approve).not.toHaveBeenCalled();
    expect(f.jobs).toHaveLength(1);
    expect(
      (await f.service.detail("app", mission.id)).mission.plan,
    ).toBeUndefined();
  });
  it("approves finite dependencies once, adopts an explicit successful retry, and unlocks only after merge", async () => {
    const f = fixture(),
      mission = await f.start();
    f.jobs[0]!.status = "succeeded";
    await f.plan(mission.id, true);
    expect(f.approve).toHaveBeenCalledTimes(2);
    expect(f.jobs).toHaveLength(2);
    expect(
      missionCodingBlocker(root, "app", f.tickets[1]!.id, f.tickets[1]),
    ).toContain("prerequisite");
    const failed = f.jobs[1]!;
    failed.status = "failed";
    await f.service.advance("app", mission.id);
    expect(f.jobs).toHaveLength(2); // Failed model jobs never retry themselves.
    const retry: LocalJob = {
      ...failed,
      id: "explicit-retry",
      runId: 3,
      status: "succeeded",
      idempotencyKey: undefined,
    };
    f.jobs.push(retry);
    f.merged.mockResolvedValue(true);
    await f.service.advance("app", mission.id);
    const restarted = createImprovements(f.options);
    const detail = await restarted.detail("app", mission.id);
    expect(detail.mission.plan!.steps[0]!.jobId).toBe(retry.id);
    expect(detail.mission.plan!.steps[1]!.status).toBe("queued");
    expect(
      missionCodingBlocker(root, "app", f.tickets[1]!.id, f.tickets[1]),
    ).toBeUndefined();
    await restarted.advance("app", mission.id);
    expect(f.jobs).toHaveLength(4);
    expect(f.approve).toHaveBeenCalledTimes(2);
    edit("project.json", (value) => {
      value.workflow.baseBranch = "different-base";
    });
    expect(
      missionCodingBlocker(root, "app", f.tickets[1]!.id, f.tickets[1]),
    ).toContain("coding base changed");
    const blocked = await restarted.advance("app", mission.id);
    expect(blocked.message).toContain("coding base changed");
    expect(f.jobs).toHaveLength(4);
  });
  it("does not adopt a successful attempt from another Linear account", async () => {
    const f = fixture(),
      mission = await f.start();
    await f.plan(mission.id);
    const failed = f.jobs[1]!;
    failed.status = "failed";
    f.jobs.push({
      ...failed,
      id: "foreign-attempt",
      runId: 3,
      status: "succeeded",
      idempotencyKey: undefined,
      linearBinding: {
        ...failed.linearBinding!,
        connectionId: "other-account",
      },
    });
    const result = await f.service.advance("app", mission.id);
    expect(result.plan!.steps[0]!.jobId).toBe(failed.id);
    expect(result.plan!.steps[0]!.status).toBe("failed");
    expect(f.jobs).toHaveLength(3);
  });
  it("preserves old PM history while recreated PMs get independent missions and reconciliation", async () => {
    const f = fixture(),
      request = randomUUID();
    const old = await f.service.create("app", {
      outcome: "Preserve existing work",
      clientRequestId: request,
    });
    edit("areas.json", (value) => {
      value.areas.core.instanceId = randomUUID();
    });
    await expect(
      f.service.create("app", {
        outcome: old.outcome,
        clientRequestId: request,
      }),
    ).rejects.toThrow("different improvement");
    const fresh = await f.service.create("app", { outcome: old.outcome });
    expect(fresh.id).not.toBe(old.id);
    await f.service.reconcile("app");
    const listed = await f.service.list("app");
    expect(listed.missions).toHaveLength(2);
    expect(
      listed.missions.find((item) => item.id === old.id)!.message,
    ).toContain("PM changed");
    expect(
      listed.missions.find((item) => item.id === fresh.id)!.investigation.jobId,
    ).toBe(f.jobs[1]!.id);
    expect(f.jobs).toHaveLength(2);
  });
  it("retains safe draft links and explicit no-change outcomes through job eviction", async () => {
    const f = fixture(),
      mission = await f.start();
    await f.plan(mission.id);
    const coding = f.jobs[1]!;
    const result = {
      ok: true,
      kind: "developer",
      nonce: coding.id,
      prUrl: "https://github.com/owner/app/pull/12",
      headSha: "a".repeat(40),
      checks: ["test", "arbitrary secret command"],
    };
    f.service.captureResult(coding, {
      ...result,
      prUrl: "https://github.com/other/repo/pull/12",
    });
    expect((await f.service.list("app")).changes[0]!.pullRequests).toEqual([]);
    f.service.captureResult(coding, result);
    f.jobs.length = 0;
    const change = (await createImprovements(f.options).list("app"))
      .changes[0]!;
    expect(change.activityUrl).toBe("/activity?run=" + coding.id);
    expect(change.pullRequests[0]!.number).toBe(12);
    expect(change.checks!.commands).toEqual(["test"]);
    f.service.captureResult(
      { ...coding, id: "no-change", runId: 3 },
      { ok: true, kind: "developer", nonce: "no-change", noChanges: true },
    );
    expect((await f.service.list("app")).changes[0]).toMatchObject({
      noChanges: true,
      pullRequests: [],
    });
  });
  it("pauses future admissions without mutating running work and rejects changed ticket scopes", async () => {
    const f = fixture(),
      mission = await f.start();
    const planned = await f.plan(mission.id);
    f.jobs[1]!.status = "running";
    const paused = await f.service.pause("app", mission.id, planned.revision);
    expect(paused.status).toBe("paused");
    expect(f.jobs[1]!.status).toBe("running");
    expect(
      missionCodingBlocker(root, "app", f.tickets[0]!.id, f.tickets[0]),
    ).toContain("paused");
    await f.service.pause("app", mission.id, paused.revision, false);
    expect(
      missionCodingBlocker(root, "app", f.tickets[0]!.id, {
        ...f.tickets[0]!,
        title: "Changed",
      }),
    ).toContain("scope changed");
  });
});
