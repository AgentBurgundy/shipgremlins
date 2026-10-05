import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createDashboardServer } from "./dashboard.ts";
import { createIdeaCrew, type CrewDraft } from "../ideaCrew/index.ts";
import { samplePlan } from "../ideaCrew/test-support.ts";
import { createLocalRunners } from "../localRunners/engine.ts";
import { loadProject } from "../config.ts";
const roots: string[] = [],
  servers: Server[] = [];
const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
afterEach(async () => {
  for (const server of servers.splice(0))
    await new Promise<void>((done) => server.close(() => done()));
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
async function fixture() {
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
  vi.spyOn(runners, "start").mockImplementation(() => {});
  const server = createDashboardServer(root, packageRoot, "b".repeat(64), [], {
    ideaCrew,
    runners,
  });
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    root,
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
    ] as const)
      expect((await f.call(path, data, false)).status).toBe(401);
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
