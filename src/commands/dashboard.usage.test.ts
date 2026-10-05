import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createDashboardServer } from "./dashboard.ts";
import { createUsage } from "../usage/index.ts";
import type { LocalRunners } from "../localRunners/engine.ts";

const roots: string[] = [],
  servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0))
    await new Promise<void>((done) => server.close(() => done()));
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "usage-api-"));
  roots.push(root);
  const jobs = vi.fn(async () => [
    {
      id: "job-11111111-1111-4111-8111-111111111111",
      runId: 1,
      type: "pm",
      project: "old-app",
      status: "succeeded",
      createdAt: "2026-10-01T00:00:00.000Z",
      finishedAt: "2026-10-01T00:01:00.000Z",
    },
  ]);
  const server = createDashboardServer(
    root,
    process.cwd(),
    "a".repeat(64),
    [],
    {
      background: false,
      runners: {
        jobs,
        start: vi.fn(),
        stop: vi.fn(async () => {}),
      } as unknown as LocalRunners,
    },
  );
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    root,
    jobs,
    call: (query = "?range=all", auth = true, method = "GET") =>
      fetch(origin + "/api/usage" + query, {
        method,
        headers: {
          ...(auth ? { Authorization: "Bearer " + "a".repeat(64) } : {}),
        },
      }),
  };
}
describe("workspace usage API", () => {
  it("requires session auth, validates filters, and imports unavailable history once without a runner connection", async () => {
    const f = await fixture();
    expect((await f.call("", false)).status).toBe(401);
    expect(f.jobs).not.toHaveBeenCalled();
    expect((await f.call("?range=nope")).status).toBe(400);
    expect((await f.call("?project=../private")).status).toBe(400);
    expect((await f.call("?range=all&range=7d")).status).toBe(400);
    expect((await f.call("", true, "POST")).status).toBe(405);
    const result = (await (await f.call()).json()) as ReturnType<
      ReturnType<typeof createUsage>["summary"]
    >;
    expect(result).toMatchObject({
      totals: { totalTokens: 0 },
      coverage: { unavailableRuns: 1 },
    });
    expect(result.projects[0]).toMatchObject({
      project: "old-app",
      projectInstanceId: null,
    });
    await f.call();
    expect(f.jobs).toHaveBeenCalledOnce();
  });
  it("filters incarnations without accessing project files and retains all-workspace overhead", async () => {
    const f = await fixture(),
      usage = createUsage({ root: f.root });
    const measured = {
      inputTokens: 2,
      outputTokens: 3,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      complete: true,
    };
    usage.operation(
      {
        project: "removed-app",
        projectInstanceId: "33333333-3333-4333-8333-333333333333",
        kind: "pm-planning",
      },
      measured,
    );
    usage.operation({ kind: "idea-planning" }, measured);
    const filtered = (await (
      await f.call(
        "?range=all&project=removed-app&instance=33333333-3333-4333-8333-333333333333",
      )
    ).json()) as ReturnType<ReturnType<typeof createUsage>["summary"]>;
    expect(filtered.totals.totalTokens).toBe(5);
    expect(filtered.coverage.measuredOperations).toBe(1);
    expect(
      await (await f.call("?range=all&project=_workspace")).json(),
    ).toMatchObject({ totals: { totalTokens: 5 } });
    expect(await (await f.call()).json()).toMatchObject({
      totals: { totalTokens: 10 },
    });
  });
});
