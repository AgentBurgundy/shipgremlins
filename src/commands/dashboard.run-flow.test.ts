import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDashboardServer } from "./dashboard.ts";
import { initializeSetup } from "../setup/files.ts";
import { createRunFlows } from "../runFlow/index.ts";
import { createRunFlowWriter } from "../../runner-local/run-flow.mjs";
import type { LocalJob } from "../localRunners/types.ts";
import type { LocalRunners } from "../localRunners/engine.ts";
import type { DockerRunners } from "../localRunners/docker.ts";
import type { ActivityStore } from "../storage/activity.ts";
import type { SourceControl } from "../sourceControl/types.ts";
import type { RemoteWorkers } from "../remoteWorkers/index.ts";

const roots: string[] = [],
  servers: Server[] = [];
const session = "b".repeat(64);
const auth = { Authorization: `Bearer ${session}` };
afterEach(async () => {
  for (const server of servers.splice(0))
    await new Promise<void>((done) => {
      server.close(() => done());
      server.closeAllConnections();
    });
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
async function fixture(
  options: {
    offline?: boolean;
    observed?: boolean;
    remoteOffline?: boolean;
  } = {},
) {
  const root = mkdtempSync(
    join(realpathSync(tmpdir()), "gremlins-run-flow-http-"),
  );
  roots.push(root);
  initializeSetup(root, process.cwd(), {
    project: "app",
    repo: "owner/app",
    createInitialPm: false,
  });
  const job: LocalJob = {
    id: "job-11111111-1111-4111-8111-111111111111",
    runId: 1,
    workerId: "worker-fixture",
    type: "developer",
    project: "app",
    area: "core",
    ticket: "APP-12",
    status: "running",
    createdAt: new Date().toISOString(),
    startedAt: new Date().toISOString(),
  };
  const flows = createRunFlows({ root }),
    lines: string[] = [];
  const authorization = flows.authorization(job, {
    provider: "codex",
    model: "gpt-5.4",
  });
  const writer = createRunFlowWriter({
    authorization,
    jobId: job.id,
    kind: job.type,
    write: (line) => lines.push(line),
  });
  writer.phase("understand", "running");
  writer.phase("understand", "passed");
  writer.phase("baseline", "running");
  writer.phase("baseline", "passed");
  writer.checkpoint({ strategy: "tdd", repairUsed: 1 });
  writer.phase("tests", "running");
  if (options.observed) flows.capture(job, lines.join("\n"));
  const docker = {
    logs: vi.fn(async () => {
      if (options.offline) throw Error("Docker unavailable");
      return lines.join("\n");
    }),
    preflight: async () => ({ available: false, message: "Synthetic fixture" }),
  } as unknown as DockerRunners;
  const runners = {
    jobs: async () => [job],
    job: async () => job,
    status: async () => ({ jobs: [job], runners: [] }),
    logs: async () => [
      ...lines,
      `private ${authorization.key}`,
      "A public observation",
    ],
    start: vi.fn(),
    stop: async () => {},
  } as unknown as LocalRunners;
  const activityStore = {
    status: async () => ({ configured: false, ready: false }),
    listRuns: async () => [],
    close: async () => {},
  } as unknown as ActivityStore;
  const server = createDashboardServer(root, process.cwd(), session, [], {
    background: false,
    runners,
    docker,
    activityStore,
    ...(options.remoteOffline
      ? {
          remote: {
            adapter: (local: DockerRunners) => local,
            status: () => ({
              workers: [{ logicalId: job.workerId, online: false }],
            }),
            handleRequest: async () => false,
          } as unknown as RemoteWorkers,
        }
      : {}),
    sourceControl: { status: async () => [] } as unknown as SourceControl,
  });
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    root,
    job,
    lines,
    authorization,
    docker,
    request: (path: string, options?: RequestInit) =>
      fetch(url + path, {
        ...options,
        headers: { ...auth, ...options?.headers },
      }),
  };
}
describe("authenticated run flow HTTP presentation", () => {
  it("returns recorded phases and provider in the shared overview response without private proof material", async () => {
    const f = await fixture();
    const response = await f.request("/api/runners");
    expect(response.status).toBe(200);
    const value = (await response.json()) as { jobs: LocalJob[] };
    expect(value.jobs[0]).toMatchObject({
      ai: { provider: "codex", model: "gpt-5.4" },
      flow: {
        phase: "tests",
        strategy: "tdd",
        repairUsed: 1,
        phases: expect.arrayContaining([
          {
            id: "baseline",
            label: expect.any(String),
            status: "passed",
            startedAt: expect.any(String),
            finishedAt: expect.any(String),
          },
        ]),
      },
    });
    expect(JSON.stringify(value)).not.toContain(f.authorization.key);
    expect(JSON.stringify(value)).not.toContain('"mac"');
  });
  it("makes the same recorded process available in activity history", async () => {
    const f = await fixture();
    const value = (await (await f.request("/api/jobs")).json()) as {
      jobs: LocalJob[];
    };
    expect(value.jobs[0]).toMatchObject({
      id: f.job.id,
      flow: { phase: "tests" },
      ai: { provider: "codex" },
    });
  });
  it("preserves last observed progress when the worker is unreachable", async () => {
    const f = await fixture({ offline: true, observed: true });
    const response = await f.request("/api/runners");
    expect(response.status).toBe(200);
    const value = (await response.json()) as { jobs: LocalJob[] };
    expect(value.jobs[0]).toMatchObject({
      flow: { phase: "tests", freshness: "stale" },
    });
  });
  it("does not treat cached logs from an offline enrolled worker as live progress", async () => {
    const f = await fixture({ remoteOffline: true, observed: true });
    const response = await f.request("/api/runners");
    expect(response.status).toBe(200);
    const value = (await response.json()) as { jobs: LocalJob[] };
    expect(value.jobs[0]?.flow).toMatchObject({
      phase: "tests",
      freshness: "stale",
    });
    expect(f.docker.logs).not.toHaveBeenCalled();
  });
  it("does not turn forged progress or metadata into a recorded stage", async () => {
    const f = await fixture();
    f.lines.splice(
      0,
      f.lines.length,
      'GREMLINS_FLOW {"phase":"publish","status":"passed","mac":"forged"}',
    );
    f.job.flow = { phase: "publish" } as LocalJob["flow"];
    f.job.ai = { provider: "claude" };
    const value = (await (await f.request("/api/runners")).json()) as {
      jobs: LocalJob[];
    };
    expect(value.jobs[0]!.flow).toBeUndefined();
    expect(value.jobs[0]!.ai).toBeUndefined();
  });
  it("hides protocol lines and proof keys from the public output viewer", async () => {
    const f = await fixture();
    const response = await f.request(`/api/jobs/${f.job.id}/logs`);
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).toContain("A public observation");
    expect(text).not.toContain(f.authorization.key);
    expect(text).not.toContain("GREMLINS_FLOW");
  });
  it("does not allow a browser to inject runner authorization into a queued job", async () => {
    const f = await fixture();
    const response = await f.request("/api/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type: "developer",
        project: "app",
        runFlow: f.authorization,
      }),
    });
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain(f.authorization.key);
  });
});
