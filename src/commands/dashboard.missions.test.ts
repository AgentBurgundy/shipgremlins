import { afterEach, describe, expect, it, vi } from "vitest";
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createDashboardServer } from "./dashboard.ts";
import { initializeSetup } from "../setup/files.ts";
import { loadProject } from "../config.ts";
import {
  ImprovementError,
  type ChangeSummary,
  type createImprovements,
} from "../improvements/index.ts";
import type { LocalRunners } from "../localRunners/engine.ts";

const roots: string[] = [],
  servers: Server[] = [];
const session = "a".repeat(64),
  id = "11111111-1111-4111-8111-111111111111";
afterEach(async () => {
  for (const server of servers.splice(0))
    await new Promise<void>((done) => server.close(() => done()));
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
async function fixture(noPm = false, foundation = false) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "missions-api-")));
  roots.push(root);
  initializeSetup(root, process.cwd(), { project: "app", repo: "owner/app" });
  if (noPm)
    writeFileSync(
      join(root, "projects/app/areas.json"),
      JSON.stringify({ areas: {} }),
    );
  if (foundation) {
    const path = join(root, "projects/app/project.json"),
      value = JSON.parse(readFileSync(path, "utf8"));
    value.ideaPlanId = id;
    writeFileSync(path, JSON.stringify(value));
  }
  const mission = {
    id,
    project: "app",
    area: "core",
    outcome: "Improve a real outcome",
    revision: "revision",
    status: "needs-review",
  };
  const methods = {
    list: vi.fn(async () => ({
      missions: [mission],
      areas: [],
      changes: [] as ChangeSummary[],
    })),
    detail: vi.fn(async () => ({
      mission,
      candidates: [],
      observations: [],
      baselines: [],
      changes: [],
    })),
    create: vi.fn(async () => mission),
    plan: vi.fn(async () => mission),
    advance: vi.fn(async () => mission),
    followup: vi.fn(async () => mission),
    pause: vi.fn(async () => mission),
  };
  const runners = {
    start: () => {},
    stop: async () => {},
    jobs: async () => [],
    withConfigurationMutation: async (_scope: unknown, action: () => unknown) =>
      action(),
  } as unknown as LocalRunners;
  const server = createDashboardServer(root, process.cwd(), session, [], {
    background: false,
    improvements: methods as unknown as ReturnType<typeof createImprovements>,
    runners,
  });
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const url = "http://127.0.0.1:" + (server.address() as AddressInfo).port;
  const call = (suffix = "", input?: unknown, auth = true) =>
    fetch(url + "/api/projects/app/missions" + suffix, {
      method: input === undefined ? "GET" : "POST",
      headers: {
        "Content-Type": "application/json",
        ...(auth ? { Authorization: "Bearer " + session } : {}),
      },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }),
    });
  return { root, methods, call, mission };
}
describe("improvement mission HTTP boundary", () => {
  it("projects one current ticket state without deleting prior reconciliation attempts", async () => {
    const f = await fixture();
    const failed: ChangeSummary = {
      jobId: "job-old",
      runId: 1,
      ticket: "FOR-2",
      ticketId: id,
      linearBinding: {
        connectionId: "default",
        workspaceId: "workspace",
        ticketId: id,
      },
      status: "failed",
      message: "Earlier attempt failed",
      activityUrl: "/activity?run=job-old",
      createdAt: "2026-10-06T12:00:00Z",
      pullRequests: [],
    };
    const succeeded: ChangeSummary = {
      ...failed,
      jobId: "job-new",
      runId: 2,
      status: "succeeded",
      message: "Current work",
      createdAt: "2026-10-07T12:00:00Z",
    };
    const all = [failed, succeeded];
    f.methods.list.mockResolvedValueOnce({
      missions: [f.mission],
      areas: [],
      changes: all,
    });
    const result = (await (await f.call()).json()) as {
      changes: ChangeSummary[];
    };
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0]).toMatchObject({
      jobId: "job-new",
      status: "succeeded",
      previousAttempts: [failed],
    });
    expect(all).toEqual([failed, succeeded]);
  });
  it("requires authentication and preserves the collection/detail/mutation contract", async () => {
    const f = await fixture();
    expect((await f.call("", undefined, false)).status).toBe(401);
    expect(f.methods.list).not.toHaveBeenCalled();
    expect(await (await f.call()).json()).toMatchObject({
      missions: [f.mission],
    });
    expect(await (await f.call("/" + id)).json()).toMatchObject({
      mission: f.mission,
      candidates: [],
    });
    const response = await f.call("", {
      outcome: "Improve a real outcome",
      clientRequestId: id,
    });
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ mission: f.mission });
    expect(f.methods.create).toHaveBeenCalledWith("app", {
      outcome: "Improve a real outcome",
      clientRequestId: id,
    });
  });
  it("forwards exact approval revisions and explicit resume, rejecting extra authority fields", async () => {
    const f = await fixture(),
      steps = [{ ticketId: id, revision: "ticket-revision", dependsOn: [] }];
    expect(
      (
        await f.call("/" + id + "/plan", {
          revision: "mission-revision",
          steps,
        })
      ).status,
    ).toBe(202);
    expect(f.methods.plan).toHaveBeenCalledWith("app", id, {
      revision: "mission-revision",
      steps,
    });
    expect(
      (await f.call("/" + id + "/advance", { autoApprove: true })).status,
    ).toBe(400);
    expect(f.methods.advance).not.toHaveBeenCalled();
    expect(
      (await f.call("/" + id + "/resume", { revision: "resume-revision" }))
        .status,
    ).toBe(202);
    expect(f.methods.pause).toHaveBeenCalledWith(
      "app",
      id,
      "resume-revision",
      false,
    );
    expect(f.methods.advance).toHaveBeenCalledWith("app", id);
    f.methods.plan.mockRejectedValueOnce(
      new ImprovementError("Exact scope changed", 409),
    );
    expect(
      (await f.call("/" + id + "/plan", { revision: "old", steps })).status,
    ).toBe(409);
  });
  it("creates one focused paused PM for an explicit outcome without enabling either automation", async () => {
    const f = await fixture(true);
    expect(
      (
        await f.call("", {
          outcome: "Preserve entered values when Save fails",
          clientRequestId: "invalid",
        })
      ).status,
    ).toBe(400);
    expect(loadProject(f.root, "app").areas).toHaveLength(0);
    expect(
      (
        await f.call("", {
          outcome: "Preserve entered values when Save fails",
          clientRequestId: id,
        })
      ).status,
    ).toBe(202);
    const area = loadProject(f.root, "app").areas[0]!;
    expect(area).toMatchObject({
      key: "improvements",
      enabled: false,
      codingEnabled: false,
      mandate: "Preserve entered values when Save fails",
    });
    expect(f.methods.create).toHaveBeenCalledWith("app", {
      outcome: area.mandate,
      clientRequestId: id,
      area: "improvements",
    });
    await f.call("", { outcome: area.mandate, clientRequestId: id });
    expect(loadProject(f.root, "app").areas).toHaveLength(1);
  });
  it("requires foundation completion before creating an existing-app mission or PM", async () => {
    const f = await fixture(true, true);
    const response = await f.call("", { outcome: "Improve existing editing" });
    expect(response.status).toBe(409);
    expect(await response.text()).toContain("foundation");
    expect(f.methods.create).not.toHaveBeenCalled();
    expect(loadProject(f.root, "app").areas).toHaveLength(0);
  });
});
