import { mkdtempSync, realpathSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDashboardServer } from "./dashboard.ts";
import { initializeSetup } from "../setup/files.ts";
import type { LocalRunners } from "../localRunners/engine.ts";
import type { SourceControl } from "../sourceControl/types.ts";
let root: string, server: Server;
type AutonomyResponse = {
  autonomy: {
    revision: string;
    projectRevision: string;
    enabled: boolean;
    state: string;
  };
};
afterEach(async () => {
  if (server)
    await new Promise<void>((resolve) => server.close(() => resolve()));
  if (root) rmSync(root, { recursive: true, force: true });
});
async function fixture() {
  root = mkdtempSync(join(realpathSync(tmpdir()), "gremlins-autonomy-api-"));
  initializeSetup(root, process.cwd(), { project: "app", repo: "owner/app" });
  const start = vi.fn();
  const runners = {
    start,
    stop: async () => {},
    jobs: async () => [],
    status: async () => ({ runners: [], jobs: [] }),
  } as unknown as LocalRunners;
  server = createDashboardServer(root, process.cwd(), "a".repeat(64), [], {
    runners,
    sourceControl: { status: async () => [] } as unknown as SourceControl,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = (
    input?: unknown,
    auth = true,
    method = input === undefined ? "GET" : "POST",
  ) =>
    fetch(url + "/api/projects/app/autonomy", {
      method,
      headers: {
        ...(auth ? { authorization: `Bearer ${"a".repeat(64)}` } : {}),
        "content-type": "application/json",
      },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }),
    });
  return { call, start };
}
describe("project autonomy HTTP controls", () => {
  it("authenticates, saves intent, and rejects stale or unsupported writes", async () => {
    const f = await fixture();
    expect((await f.call(undefined, false)).status).toBe(401);
    expect((await f.call({}, true, "PUT")).status).toBe(405);
    const initial = ((await (await f.call()).json()) as AutonomyResponse)
      .autonomy;
    expect(initial).toMatchObject({ enabled: true, state: "blocked" });
    const input = {
      enabled: false,
      revision: initial.revision,
      projectRevision: initial.projectRevision,
    };
    expect((await f.call({ ...input, token: "private" })).status).toBe(400);
    expect((await f.call({ ...input, enabled: "yes" })).status).toBe(400);
    const response = await f.call(input);
    expect(response.status).toBe(200);
    const paused = ((await response.json()) as AutonomyResponse).autonomy;
    expect(paused).toMatchObject({
      enabled: false,
      state: "paused",
      investigationEnabled: false,
      codingEnabled: false,
    });
    expect((await f.call({ ...input, enabled: true })).status).toBe(409);
    expect(
      (
        await f.call({
          enabled: true,
          revision: paused.revision,
          projectRevision: paused.projectRevision,
        })
      ).status,
    ).toBe(200);
    const saved = JSON.parse(
      readFileSync(join(root, "projects/app/areas.json"), "utf8"),
    );
    expect(saved.areas.core).toMatchObject({
      enabled: true,
      codingEnabled: true,
    });
  });
});
