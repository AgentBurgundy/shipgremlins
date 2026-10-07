import { afterEach, expect, it, vi } from "vitest";
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { initializeSetup } from "../setup/files.ts";
import { createDashboardServer, type DashboardOptions } from "./dashboard.ts";
import type { StagingSyncStatus } from "../delivery/stagingSync.ts";

let root: string;
let server: Server;
afterEach(async () => {
  if (server) await new Promise<void>((done) => server.close(() => done()));
  vi.useRealTimers();
  if (root) rmSync(root, { recursive: true, force: true });
});

async function fixture(
  options: {
    enabled?: boolean;
    verified?: boolean;
    production?: boolean;
    productionError?: boolean;
    activeRepair?: boolean;
  } = {},
) {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  root = mkdtempSync(join(realpathSync(tmpdir()), "gremlins-sync-api-"));
  const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
  initializeSetup(root, packageRoot, { project: "app", repo: "owner/app" });
  const file = join(root, "projects", "app", "project.json");
  const raw = JSON.parse(readFileSync(file, "utf8"));
  raw.workflow =
    options.enabled === false
      ? { kind: "pull-request", baseBranch: "main" }
      : { kind: "promotion" };
  raw.branches = {
    integration: "pm-staging",
    staging: "staging",
    production: "main",
  };
  raw.verified = options.verified === false ? null : "2026-10-06T20:00:00Z";
  raw.verification = { mode: "browser", environment: "integration" };
  raw.environments = {
    integration: {
      kind: "railway",
      role: "preview",
      projectId: "p",
      environmentId: "integration",
      serviceId: "s",
    },
  };
  writeFileSync(file, JSON.stringify(raw));
  let state: StagingSyncStatus = {
    phase: "waiting-deployment",
    message: "Waiting for the updated app.",
  };
  const reconcileStaging = vi.fn(async () => state);
  let activeRepair = options.activeRepair ?? false;
  const reconcileIntegrationRepairs = vi.fn(async () => {});
  const advanceIntegration = vi.fn(async () => null);
  const reconcileProduction = vi.fn(async () => {
    if (options.productionError) throw new Error("Linear unavailable.");
    return [];
  });
  const pendingReviews = vi.fn(async () => [
    { type: "pm", project: "app", area: "core", runOnce: true },
  ]);
  const validate = vi.fn(async () => ({
    project: { config: { instanceId: raw.instanceId } },
  }));
  const enqueue = vi.fn(async () => ({ id: "job-review" }));
  const delivery = {
    deliveryStatus: () => ({
      enabled: options.enabled !== false,
      deliveries: [],
      declarations: options.production ? [{ id: "declared-release" }] : [],
      stagingSync: state,
      integrationRepairActive: activeRepair,
    }),
    reconcileIntegrationRepairs,
    advanceIntegration,
    reconcileStaging,
    reconcileProduction,
    pendingReviews,
  } as unknown as DashboardOptions["delivery"];
  server = createDashboardServer(root, packageRoot, "a".repeat(64), [], {
    delivery,
    improvements: {
      reconcile: vi.fn(async () => {}),
    } as unknown as DashboardOptions["improvements"],
    jobs: { validate } as unknown as DashboardOptions["jobs"],
    runners: {
      start: vi.fn(),
      stop: vi.fn(async () => {}),
      jobs: vi.fn(async () => []),
      enqueue,
    } as unknown as DashboardOptions["runners"],
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/projects/app/delivery`;
  const headers = {
    Authorization: `Bearer ${"a".repeat(64)}`,
    "Content-Type": "application/json",
  };
  const post = (input: unknown = {}) =>
    fetch(`${url}/sync`, {
      method: "POST",
      headers,
      body: JSON.stringify(input),
    });
  const waitForIdle = async () => {
    await vi.waitFor(async () => {
      const response = await fetch(url, { headers });
      const value = (await response.json()) as { operation: { phase: string } };
      expect(value.operation.phase).not.toBe("running");
    });
  };
  return {
    reconcileStaging,
    reconcileProduction,
    reconcileIntegrationRepairs,
    advanceIntegration,
    pendingReviews,
    enqueue,
    validate,
    post,
    waitForIdle,
    setActiveRepair: (active: boolean) => {
      activeRepair = active;
    },
    setState: (next: StagingSyncStatus) => {
      state = next;
    },
  };
}

it("syncs at startup and every minute, holding PM reviews until the current deployment is ready", async () => {
  const f = await fixture();
  await vi.waitFor(() => expect(f.reconcileStaging).toHaveBeenCalledTimes(1));
  await f.waitForIdle();
  expect(f.pendingReviews).not.toHaveBeenCalled();
  expect(f.enqueue).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(60_000);
  await f.waitForIdle();
  expect(f.reconcileStaging).toHaveBeenCalledTimes(2);
  expect(f.enqueue).not.toHaveBeenCalled();
  f.setState({ phase: "current", message: "The current test app is ready." });
  await vi.advanceTimersByTimeAsync(60_000);
  await vi.waitFor(() => expect(f.enqueue).toHaveBeenCalledTimes(1));
  expect(f.reconcileStaging).toHaveBeenCalledTimes(3);
  expect(f.pendingReviews).toHaveBeenCalledExactlyOnceWith("app");
});

it("lets an active integration repair finish before new staging sync without waiting for sync-current", async () => {
  const f = await fixture({ activeRepair: true });
  await vi.waitFor(() => expect(f.advanceIntegration).toHaveBeenCalledOnce());
  await f.waitForIdle();
  expect(f.reconcileIntegrationRepairs).toHaveBeenCalledOnce();
  expect(f.reconcileStaging).not.toHaveBeenCalled();
  expect(f.pendingReviews).not.toHaveBeenCalled();
  expect(f.enqueue).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(60_000);
  await f.waitForIdle();
  expect(f.advanceIntegration).toHaveBeenCalledTimes(2);
  expect(f.reconcileStaging).not.toHaveBeenCalled();
  f.setActiveRepair(false);
  await vi.advanceTimersByTimeAsync(60_000);
  await vi.waitFor(() => expect(f.reconcileStaging).toHaveBeenCalledOnce());
  expect(f.pendingReviews).not.toHaveBeenCalled();
  f.setState({ phase: "current", message: "The current test app is ready." });
  await vi.advanceTimersByTimeAsync(60_000);
  await vi.waitFor(() => expect(f.enqueue).toHaveBeenCalledOnce());
});

it("resumes staging immediately when repair reconciliation reports a stopped family", async () => {
  const f = await fixture({ activeRepair: true });
  await vi.waitFor(() => expect(f.advanceIntegration).toHaveBeenCalledOnce());
  await f.waitForIdle();
  f.reconcileIntegrationRepairs.mockImplementation(async () => {
    f.setActiveRepair(false);
  });
  await vi.advanceTimersByTimeAsync(60_000);
  await vi.waitFor(() => expect(f.reconcileStaging).toHaveBeenCalledOnce());
  expect(f.advanceIntegration).toHaveBeenCalledOnce();
});

it("accepts a manual retry and rejects additional request fields", async () => {
  const f = await fixture();
  await f.waitForIdle();
  expect((await f.post()).status).toBe(202);
  await vi.waitFor(() => expect(f.reconcileStaging).toHaveBeenCalledTimes(2));
  await f.waitForIdle();
  expect((await f.post({ branch: "main" })).status).toBe(400);
  expect(f.reconcileStaging).toHaveBeenCalledTimes(2);
});

it("continues production completion while staging waits and PM reviews remain held", async () => {
  const f = await fixture({ production: true });
  await vi.waitFor(() => expect(f.reconcileStaging).toHaveBeenCalledTimes(1));
  await f.waitForIdle();
  expect(f.reconcileProduction).toHaveBeenCalledExactlyOnceWith("app");
  expect(f.pendingReviews).not.toHaveBeenCalled();
  expect(f.enqueue).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(60_000);
  await f.waitForIdle();
  expect(f.reconcileProduction).toHaveBeenCalledTimes(2);
  expect(f.pendingReviews).not.toHaveBeenCalled();
});

it("keeps staging maintenance running when production completion cannot reach Linear", async () => {
  const f = await fixture({ production: true, productionError: true });
  await vi.waitFor(() => expect(f.reconcileStaging).toHaveBeenCalledTimes(1));
  expect(f.reconcileProduction).toHaveBeenCalledExactlyOnceWith("app");
  expect(f.pendingReviews).not.toHaveBeenCalled();
});

it.each([{ enabled: false }, { verified: false }])(
  "does not sync or enqueue PMs for an ineligible project: %j",
  async (options) => {
    const f = await fixture(options);
    await f.waitForIdle();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.reconcileStaging).not.toHaveBeenCalled();
    expect(f.pendingReviews).not.toHaveBeenCalled();
    expect(f.enqueue).not.toHaveBeenCalled();
    expect((await f.post()).status).toBe(409);
  },
);
