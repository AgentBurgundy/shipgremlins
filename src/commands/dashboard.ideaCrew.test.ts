import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createDashboardServer, type DashboardOptions } from "./dashboard.ts";
import { createIdeaCrew, type CrewDraft } from "../ideaCrew/index.ts";
import { samplePlan } from "../ideaCrew/test-support.ts";
import { createLocalRunners } from "../localRunners/engine.ts";
import { loadProject } from "../config.ts";
import { createSourceControl } from "../sourceControl/index.ts";
const roots: string[] = [],
  servers: Server[] = [];
const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
afterEach(async () => {
  for (const server of servers.splice(0))
    await new Promise<void>((done) => server.close(() => done()));
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
async function fixture(foundation?: DashboardOptions["foundation"]) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "gremlins-idea-api-"));
  roots.push(root);
  const ideaCrew = createIdeaCrew({
    root,
    packageRoot,
    env: { CLAUDE_CODE_OAUTH_TOKEN: "synthetic-claude-token" },
    execute: async () => samplePlan(),
    sourceControl: {
      resolveCredential: async () => ({
        token: "synthetic-source-token",
        method: "token",
      }),
    },
    fetch: async (url) =>
      Response.json(
        String(url).includes("branches?")
          ? [{ name: "main" }]
          : { default_branch: "main" },
      ),
  });
  const runners = createLocalRunners({ root, packageRoot });
  const sourceControl = createSourceControl({ root, env: {} });
  const owners = vi.spyOn(sourceControl, "repositoryOwners").mockResolvedValue({
    accountId: "1",
    owners: [{ id: "1", path: "owner", name: "Owner" }],
    truncated: false,
  });
  vi.spyOn(runners, "start").mockImplementation(() => {});
  const server = createDashboardServer(root, packageRoot, "b".repeat(64), [], {
    ideaCrew,
    runners,
    sourceControl,
    foundation,
  });
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    root,
    owners,
    call: (path: string, input?: unknown, auth = true) =>
      fetch(url + path, {
        method: input === undefined ? "GET" : "POST",
        headers: {
          "content-type": "application/json",
          ...(auth ? { authorization: `Bearer ${"b".repeat(64)}` } : {}),
        },
        ...(input === undefined ? {} : { body: JSON.stringify(input) }),
      }),
  };
}
describe("idea onboarding API", () => {
  it("authenticates planning, recovery and creation", async () => {
    const f = await fixture();
    for (const [path, data] of [
      ["/api/idea-plans", { idea: "Build a booking app for pottery classes." }],
      ["/api/idea-plans/11111111-1111-4111-8111-111111111111", undefined],
      ["/api/idea-plans/11111111-1111-4111-8111-111111111111/create", {}],
      ["/api/source-control/github/owners", undefined],
      ["/api/projects/studio/foundation", undefined],
      ["/api/projects/studio/foundation/build", {}],
      ["/api/projects/studio/foundation/inspect", {}],
    ] as const)
      expect((await f.call(path, data, false)).status).toBe(401);
  });
  it("requires a reviewed revision for a foundation build and keeps inspection separate", async () => {
    const status = { stage: "review", revision: "brief-1" } as Awaited<
      ReturnType<NonNullable<DashboardOptions["foundation"]>["status"]>
    >;
    const foundation = {
      status: vi.fn(async () => status),
      inspect: vi.fn(async () => status),
      needed: () => true,
      start: vi.fn(async () => ({ ...status, stage: "queued" })),
    };
    const f = await fixture(foundation);
    const plan = (await (
      await f.call("/api/idea-plans", {
        idea: "Build a booking app for pottery class students.",
      })
    ).json()) as CrewDraft;
    await f.call(`/api/idea-plans/${plan.id}/create`, {
      revision: plan.revision,
      project: "studio",
      repo: "owner/studio",
    });
    expect((await f.call("/api/projects/studio/foundation")).status).toBe(200);
    expect(
      (await f.call("/api/projects/studio/foundation/build", {})).status,
    ).toBe(400);
    expect(
      (
        await f.call("/api/projects/studio/foundation/build", {
          revision: "brief-1",
          prompt: "other scope",
        })
      ).status,
    ).toBe(400);
    expect(foundation.start).not.toHaveBeenCalled();
    expect(
      (
        await f.call("/api/projects/studio/foundation/build", {
          revision: "brief-1",
        })
      ).status,
    ).toBe(202);
    expect(foundation.start).toHaveBeenCalledWith("studio", {
      revision: "brief-1",
    });
    expect(
      (await f.call("/api/projects/studio/foundation/inspect", {})).status,
    ).toBe(200);
    expect(foundation.inspect).toHaveBeenCalledWith("studio");
  });
  it("lists repository owners only at the authenticated source endpoint", async () => {
    const f = await fixture();
    const response = await f.call("/api/source-control/github/owners");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      accountId: "1",
      owners: [{ path: "owner" }],
    });
    expect(
      (await f.call("/api/source-control/github/owners?token=secret")).status,
    ).toBe(400);
    expect(
      (
        await f.call(
          "/api/source-control/gitlab/owners?serverUrl=https%3A%2F%2Fgitlab.example.com",
        )
      ).status,
    ).toBe(200);
    expect(f.owners).toHaveBeenLastCalledWith({
      provider: "gitlab",
      serverUrl: "https://gitlab.example.com",
    });
  });
  it("plans before source setup, creates all PMs, and preserves the existing add-project route", async () => {
    const f = await fixture();
    const response = await f.call("/api/idea-plans", {
      idea: "Build a booking app for students taking pottery classes.",
    });
    expect(response.status).toBe(200);
    const draft = (await response.json()) as CrewDraft;
    expect((await f.call(`/api/idea-plans/${draft.id}`)).status).toBe(200);
    const create = await f.call(`/api/idea-plans/${draft.id}/create`, {
      revision: draft.revision,
      project: "studio",
      repo: "owner/studio",
      linearMode: "later",
    });
    expect(create.status).toBe(200);
    expect(((await create.json()) as { crew: unknown[] }).crew).toHaveLength(2);
    expect(loadProject(f.root, "studio").areas).toHaveLength(2);
    expect(
      (await f.call("/api/idea-plans", { idea: "too short", injected: true }))
        .status,
    ).toBe(400);
    const normal = await f.call("/api/projects", {
      project: "existing",
      repo: "owner/existing",
      linearMode: "later",
    });
    expect(normal.status).toBe(200);
    expect(loadProject(f.root, "existing").areas).toHaveLength(1);
  });
});
