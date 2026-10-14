import { mkdtempSync, realpathSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { initializeSetup } from "../setup/files.ts";
import { createDashboardServer } from "./dashboard.ts";
import type { LocalRunners } from "../localRunners/engine.ts";
import type { SourceControl } from "../sourceControl/types.ts";
let root: string, server: Server;
afterEach(async () => {
  if (server) await new Promise<void>((r) => server.close(() => r()));
  if (root) rmSync(root, { recursive: true, force: true });
});
async function fixture() {
  root = mkdtempSync(join(realpathSync(tmpdir()), "gremlins-policy-http-"));
  initializeSetup(root, process.cwd(), { project: "app", repo: "owner/app" });
  const start = vi.fn();
  server = createDashboardServer(root, process.cwd(), "a".repeat(64), [], {
    runners: {
      start,
      stop: async () => {},
      withConfigurationMutation: async <T>(
        _target: unknown,
        work: () => Promise<T>,
      ) => work(),
    } as unknown as LocalRunners,
    sourceControl: { status: async () => [] } as unknown as SourceControl,
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/projects/app/approval-policy`;
  return {
    start,
    call: (
      input?: unknown,
      auth = true,
      method = input === undefined ? "GET" : "POST",
    ) =>
      fetch(url, {
        method,
        headers: {
          ...(auth ? { authorization: `Bearer ${"a".repeat(64)}` } : {}),
          "content-type": "application/json",
        },
        ...(input === undefined ? {} : { body: JSON.stringify(input) }),
      }),
  };
}
describe("owner approval policy HTTP flow", () => {
  it("authenticates, defaults off, saves explicit bounded opt-in, and rejects stale writes", async () => {
    const { call, start } = await fixture();
    expect((await call(undefined, false)).status).toBe(401);
    const initial = (await (await call()).json()) as {
      revision: string;
      policy: Record<string, unknown>;
      audit: unknown[];
    };
    expect(initial.policy.enabled).toBe(false);
    expect(initial.audit).toEqual([]);
    expect((await call({}, true, "PUT")).status).toBe(405);
    expect(
      (
        await call({
          revision: initial.revision,
          policy: { ...initial.policy, enabled: true, allowedPaths: ["*"] },
        })
      ).status,
    ).toBe(400);
    start.mockClear();
    const policy = { ...initial.policy, enabled: true, allowedPaths: ["docs"] };
    const saved = await call({ revision: initial.revision, policy });
    expect(saved.status).toBe(200);
    expect(
      ((await saved.json()) as { policy: { enabled: boolean } }).policy.enabled,
    ).toBe(true);
    expect(start).toHaveBeenCalledOnce();
    expect(
      (
        await call({
          revision: initial.revision,
          policy: { ...policy, enabled: false },
        })
      ).status,
    ).toBe(409);
    const raw = JSON.parse(
      readFileSync(join(root, "projects/app/project.json"), "utf8"),
    );
    expect(raw.autonomousApproval).toEqual(policy);
  });
});
