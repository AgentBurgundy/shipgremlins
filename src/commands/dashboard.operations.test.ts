import { afterEach, it, expect, vi } from "vitest";
import {
  mkdtempSync,
  realpathSync,
  rmSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Server } from "node:http";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { initializeSetup } from "../setup/files.ts";
import { createDashboardServer } from "./dashboard.ts";
import type { LocalRunners } from "../localRunners/engine.ts";
import { loadProject } from "../config.ts";
import { createRemoteWorkers } from "../remoteWorkers/index.ts";
import type { createDeliveryController } from "../delivery/controller.ts";
import { createAutomaticPromotions } from "../delivery/automatic.ts";
let root: string, server: Server;
afterEach(async () => {
  if (server) await new Promise<void>((done) => server.close(() => done()));
  if (root) rmSync(root, { recursive: true, force: true });
});

it("resumes saved promotion intent on startup once, preserves a newer review and skips work no longer verified", async () => {
  root = mkdtempSync(
    join(realpathSync(tmpdir()), "gremlins-promotion-resume-"),
  );
  const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
  initializeSetup(root, packageRoot, { project: "app", repo: "owner/app" });
  const projectFile = join(root, "projects", "app", "project.json");
  writeFileSync(
    projectFile,
    JSON.stringify({
      ...JSON.parse(readFileSync(projectFile, "utf8")),
      verified: "2026-10-05T10:00:00Z",
    }),
  );
  const automatic = createAutomaticPromotions({ root });
  automatic.enqueue("app", "core", "b".repeat(64));
  let finish: (rows: { text: string }[]) => void;
  const firstAttempt = new Promise<{ text: string }[]>((resolve) => {
    finish = resolve;
  });
  const preparePromotion = vi
    .fn()
    .mockImplementationOnce(() => firstAttempt)
    .mockResolvedValue([{ text: "Waiting for trusted candidate evidence." }]);
  const delivery = {
    deliveryStatus: () => ({
      enabled: true,
      deliveries: [{ area: "core", status: "verified" }],
      declarations: [],
    }),
    preparePromotion,
  } as unknown as ReturnType<typeof createDeliveryController>;
  const open = async () => {
    server = createDashboardServer(root, packageRoot, "a".repeat(64), [], {
      delivery,
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  };
  await open();
  expect(preparePromotion).toHaveBeenCalledTimes(1);
  expect(preparePromotion.mock.calls[0]![0]).toBe("app");
  expect(preparePromotion.mock.calls[0]![1].area).toBe("core");
  expect(preparePromotion.mock.calls[0]![1].automatic).toBe(true);
  automatic.enqueue("app", "core", "c".repeat(64));
  automatic.enqueue("app", "other", "d".repeat(64));
  finish!([{ text: "Waiting for trusted candidate evidence." }]);
  await vi.waitFor(() => expect(automatic.pending()).toEqual([]));
  expect(preparePromotion).toHaveBeenCalledTimes(2);
  await new Promise<void>((done) => server.close(() => done()));
  await open();
  expect(preparePromotion).toHaveBeenCalledTimes(2);
});

it("retains pending promotion intent without automatically resuming an unverified project", async () => {
  root = mkdtempSync(
    join(realpathSync(tmpdir()), "gremlins-unverified-promotion-"),
  );
  const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
  initializeSetup(root, packageRoot, { project: "app", repo: "owner/app" });
  expect(loadProject(root, "app").config.verified).toBeNull();
  const automatic = createAutomaticPromotions({ root });
  automatic.enqueue("app", "core", "b".repeat(64));
  const preparePromotion = vi.fn(async () => []);
  server = createDashboardServer(root, packageRoot, "a".repeat(64), [], {
    delivery: {
      deliveryStatus: () => ({
        enabled: true,
        deliveries: [{ area: "core", status: "verified" }],
        declarations: [],
      }),
      preparePromotion,
    } as unknown as ReturnType<typeof createDeliveryController>,
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  expect(preparePromotion).not.toHaveBeenCalled();
  expect(automatic.pending()).toEqual([
    { project: "app", area: "core", key: "b".repeat(64) },
  ]);
});

it("retains a pending provider promotion for a delayed retry instead of dropping it or spinning", async () => {
  root = mkdtempSync(join(realpathSync(tmpdir()), "gremlins-promotion-retry-"));
  const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
  initializeSetup(root, packageRoot, { project: "app", repo: "owner/app" });
  const file = join(root, "projects", "app", "project.json");
  writeFileSync(
    file,
    JSON.stringify({
      ...JSON.parse(readFileSync(file, "utf8")),
      verified: "2026-10-05T10:00:00Z",
    }),
  );
  const automatic = createAutomaticPromotions({ root });
  const intent = { project: "app", area: "core", key: "b".repeat(64) };
  automatic.enqueue(intent.project, intent.area, intent.key);
  const preparePromotion = vi.fn(async () => [
    {
      rule: "promote",
      pending: true,
      text: "Provider checks are still running.",
    },
  ]);
  server = createDashboardServer(root, packageRoot, "a".repeat(64), [], {
    delivery: {
      deliveryStatus: () => ({
        enabled: true,
        deliveries: [{ area: "core", status: "verified" }],
        declarations: [],
      }),
      preparePromotion,
    } as unknown as ReturnType<typeof createDeliveryController>,
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  await vi.waitFor(() =>
    expect(automatic.pending({ readyOnly: true })).toEqual([]),
  );
  expect(automatic.pending()).toEqual([intent]);
  expect(preparePromotion).toHaveBeenCalledTimes(1);
  const saved = createAutomaticPromotions({ root });
  expect(saved.claim(intent)).toBeNull();
});

it("saves a separate candidate target with conflict protection and requires explicit production scope confirmation", async () => {
  root = mkdtempSync(join(realpathSync(tmpdir()), "gremlins-delivery-api-"));
  const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
  initializeSetup(root, packageRoot, { project: "app", repo: "owner/app" });
  const file = join(root, "projects", "app", "project.json"),
    raw = JSON.parse(readFileSync(file, "utf8"));
  raw.workflow = { kind: "promotion" };
  raw.branches = {
    integration: "pm-staging",
    staging: "staging",
    production: "main",
  };
  raw.verification = { mode: "browser", environment: "integration" };
  const railway = {
    kind: "railway",
    role: "preview",
    projectId: "p",
    environmentId: "integration",
    serviceId: "s",
  };
  raw.environments = {
    integration: railway,
    candidate: { ...railway, environmentId: "candidate" },
    production: { ...railway, role: "production", environmentId: "prod" },
  };
  writeFileSync(file, JSON.stringify(raw));
  expect(loadProject(root, "app").config.workflow?.kind).toBe("promotion");
  let finishAdvance: (value: null) => void;
  const advancing = new Promise<null>((resolve) => {
    finishAdvance = resolve;
  });
  const advanceIntegration = vi.fn(() => advancing);
  const prepareRelease = vi.fn(async () => ({
    number: 7,
    htmlUrl: "https://github.com/owner/app/pull/7",
  }));
  const declareProduction = vi.fn(async () => ({})),
    delivery = {
      deliveryStatus: () => ({
        enabled: true,
        deliveries: [],
        declarations: [],
        revision: "b".repeat(64),
      }),
      declareProduction,
      advanceIntegration,
      prepareRelease,
    } as unknown as ReturnType<typeof createDeliveryController>;
  server = createDashboardServer(root, packageRoot, "a".repeat(64), [], {
    delivery,
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/projects/app/delivery`,
    headers = {
      Authorization: `Bearer ${"a".repeat(64)}`,
      "Content-Type": "application/json",
    };
  const post = (action: string, input: unknown) =>
    fetch(`${url}/${action}`, {
      method: "POST",
      headers,
      body: JSON.stringify(input),
    });
  const state = (await (await fetch(url, { headers })).json()) as {
    candidateSetup: { revision: string; needsSelection: boolean };
  };
  expect(state.candidateSetup.needsSelection).toBe(false);
  const revision = state.candidateSetup.revision;
  expect(
    (await post("environment", { revision, environment: "integration" }))
      .status,
  ).toBe(400);
  expect(
    (await post("environment", { revision, environment: "production" })).status,
  ).toBe(400);
  expect(
    (await post("environment", { revision, environment: "candidate" })).status,
  ).toBe(200);
  expect(loadProject(root, "app").config.workflow).toEqual({
    kind: "promotion",
    candidateEnvironment: "candidate",
  });
  expect(
    (await post("environment", { revision, environment: "candidate" })).status,
  ).toBe(409);
  const declaration = {
    revision: "b".repeat(64),
    deliveryIds: ["delivery-1"],
    productionPr: 3,
    completedStateId: "done",
  };
  expect((await post("production", declaration)).status).toBe(400);
  expect(declareProduction).not.toHaveBeenCalled();
  expect(
    (await post("production", { ...declaration, scopeComplete: true })).status,
  ).toBe(202);
  expect(declareProduction).toHaveBeenCalledExactlyOnceWith("app", {
    ...declaration,
    scopeComplete: true,
  });
  // Long independent checks are accepted asynchronously; a second click cannot
  // start a duplicate merge attempt while the first still holds its operation.
  expect((await post("advance", {})).status).toBe(202);
  expect((await post("advance", {})).status).toBe(409);
  expect((await post("release", {})).status).toBe(409);
  expect(prepareRelease).not.toHaveBeenCalled();
  expect(advanceIntegration).toHaveBeenCalledTimes(1);
  finishAdvance!(null);
  const after = (await (await fetch(url, { headers })).json()) as {
    operation: { phase: string };
  };
  expect(after.operation.phase).toBe("idle");
  expect((await post("release", { branch: "main" })).status).toBe(400);
  const release = await post("release", {});
  expect(release.status).toBe(200);
  expect(await release.json()).toMatchObject({
    release: { number: 7, url: "https://github.com/owner/app/pull/7" },
  });
  expect(prepareRelease).toHaveBeenCalledExactlyOnceWith("app");
  prepareRelease.mockRejectedValueOnce(new Error("private-provider-error"));
  const failure = await post("release", {});
  expect(failure.status).toBe(409);
  expect(await failure.text()).not.toContain("private-provider-error");
});

it("accepts only the configured HTTPS proxy origin and keeps worker credentials separate from dashboard access", async () => {
  root = mkdtempSync(join(realpathSync(tmpdir()), "gremlins-proxy-api-"));
  const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
  initializeSetup(root, packageRoot, { project: "app", repo: "owner/app" });
  const remote = createRemoteWorkers({ root });
  const enrollment = remote.createEnrollment({
    name: "MacBook",
    projects: ["app"],
  });
  server = createDashboardServer(root, packageRoot, "a".repeat(64), [], {
    publicUrl: "https://gremlins.example.test",
    remote,
    runners: {
      start: vi.fn(),
      stop: vi.fn(async () => {}),
      addRemote: vi.fn(async () => {
        throw new Error("Capacity is full");
      }),
    } as unknown as LocalRunners,
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const call = (
    path: string,
    headers: Record<string, string>,
    input?: unknown,
  ) =>
    new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = request(
        {
          host: "127.0.0.1",
          port: (server.address() as AddressInfo).port,
          path,
          method: input === undefined ? "GET" : "POST",
          headers: { "Content-Type": "application/json", ...headers },
        },
        (res) => {
          let body = "";
          res.on("data", (chunk) => {
            body += chunk;
          });
          res.on("end", () => resolve({ status: res.statusCode!, body }));
        },
      );
      req.on("error", reject);
      req.end(input === undefined ? undefined : JSON.stringify(input));
    });
  const proxy = {
    Host: "gremlins.example.test",
    Origin: "https://gremlins.example.test",
  };
  expect((await call("/", proxy)).status).toBe(200);
  expect(
    (await call("/", { ...proxy, Origin: "https://attacker.example.test" }))
      .status,
  ).toBe(403);
  expect(
    (
      await call("/", {
        Host: "attacker.example.test",
        "X-Forwarded-Host": proxy.Host,
      })
    ).status,
  ).toBe(403);
  expect((await call("/api/remote/status", proxy)).status).toBe(401);
  const enrolled = await call("/api/remote/worker/enroll", proxy, {
    code: enrollment.code,
    platform: "darwin",
    architecture: "arm64",
  });
  expect(enrolled.status).toBe(200);
  const worker = JSON.parse(enrolled.body) as { token: string };
  expect(worker.token).toMatch(/^[a-f0-9]{64}$/);
  expect(
    (
      await call("/api/remote/status", {
        ...proxy,
        Authorization: `Bearer ${worker.token}`,
      })
    ).status,
  ).toBe(401);
  expect(
    (
      await call(
        "/api/remote/worker/poll",
        { ...proxy, Authorization: `Bearer ${"a".repeat(64)}` },
        {},
      )
    ).status,
  ).toBe(401);
});
it("protects operations, persists revision-guarded notes and limits, and requires explicit cancellation", async () => {
  root = mkdtempSync(join(realpathSync(tmpdir()), "gremlins-ops-api-"));
  const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
  initializeSetup(root, packageRoot, { project: "app", repo: "owner/app" });
  const cancel = vi.fn(async () => ({
    id: "job-00000000-0000-4000-8000-000000000000",
    status: "canceled",
  }));
  const runners = {
    jobs: vi.fn(async () => []),
    status: vi.fn(async () => ({
      runners: [],
      jobs: [],
      execution: [
        {
          project: "app",
          runsStarted: 6,
          runtimeMinutes: 42,
          reservedRuntimeMinutes: 0,
          runningJobs: 0,
        },
      ],
    })),
    start: vi.fn(),
    stop: vi.fn(async () => {}),
    cancel,
  } as unknown as LocalRunners;
  server = createDashboardServer(root, packageRoot, "a".repeat(64), [], {
    runners,
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    headers = {
      Authorization: `Bearer ${"a".repeat(64)}`,
      "Content-Type": "application/json",
    };
  const post = (path: string, input: unknown) =>
    fetch(base + path, {
      method: "POST",
      headers,
      body: JSON.stringify(input),
    });
  expect((await fetch(base + "/api/operations")).status).toBe(401);
  const ops = (await (
    await fetch(base + "/api/projects/app/operations", { headers })
  ).json()) as {
    budgets: { usage: { runsToday: number }; revision: string };
    knowledge: { areas: { state: string }[]; revision: string };
  };
  expect(ops.budgets.usage.runsToday).toBe(6);
  expect(ops.knowledge.areas[0]!.state).toBe("empty");
  const payload = {
    revision: ops.knowledge.revision,
    text: "Keep the test environment isolated.",
  };
  expect((await post("/api/projects/app/decisions", payload)).status).toBe(200);
  expect((await post("/api/projects/app/decisions", payload)).status).toBe(409);
  expect(
    (
      await post("/api/projects/app/execution", {
        revision: ops.budgets.revision,
        limits: { maxDailyRuns: 12, maxJobMinutes: 15 },
      })
    ).status,
  ).toBe(200);
  expect(loadProject(root, "app").config.execution?.maxDailyRuns).toBe(12);
  const endpoint = "/api/jobs/job-00000000-0000-4000-8000-000000000000/cancel";
  expect((await fetch(base + endpoint, { headers })).status).toBe(405);
  expect(cancel).not.toHaveBeenCalled();
  expect((await post(endpoint, {})).status).toBe(202);
  expect(cancel).toHaveBeenCalledTimes(1);
  expect((await fetch(base + "/inbox")).status).toBe(200);
});
