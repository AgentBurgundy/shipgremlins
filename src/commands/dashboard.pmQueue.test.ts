import { createHash, randomUUID } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDashboardServer } from "./dashboard.ts";
import { loadProject } from "../config.ts";
import {
  createLocalRunners,
  type LocalRunners,
} from "../localRunners/engine.ts";
import type {
  DockerJobPayload,
  DockerRunners,
} from "../localRunners/docker.ts";
import type { createJobPreparation } from "../localRunners/jobs.ts";
import type { LocalJob, LocalJobInput } from "../localRunners/types.ts";
import type { OAuthConnection } from "../oauthConnection/types.ts";
import { initializeSetup } from "../setup/files.ts";
import type { SourceControl } from "../sourceControl/types.ts";

const SESSION = "a".repeat(64);
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6eH8AAAAASUVORK5CYII=",
  "base64",
);
const roots: string[] = [];
const servers: Server[] = [];
const controllers: LocalRunners[] = [];
const releases: Array<() => void> = [];

afterEach(async () => {
  for (const release of releases.splice(0)) release();
  for (const server of servers.splice(0))
    await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const controller of controllers.splice(0)) await controller.stop();
  vi.restoreAllMocks();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function barrier() {
  let entered!: () => void;
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  releases.push(release);
  return {
    waiting,
    release,
    async hold() {
      entered();
      await pending;
    },
  };
}

async function fixture(workerCount: number) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "gremlins-pm-queue-"));
  roots.push(root);
  initializeSetup(root, process.cwd(), { project: "demo", repo: "owner/app" });
  writeFileSync(
    join(root, ".env"),
    "GITHUB_TOKEN=synthetic-source\nLINEAR_API_KEY=synthetic-linear\nCLAUDE_CODE_OAUTH_TOKEN=synthetic-ai\n",
  );
  const projectPath = join(root, "projects/demo/project.json");
  const project = JSON.parse(readFileSync(projectPath, "utf8"));
  project.verified = "2026-10-14";
  project.workflow = { kind: "pull-request", baseBranch: "main" };
  project.verification = { mode: "repository" };
  writeFileSync(projectPath, JSON.stringify(project));
  const areasPath = join(root, "projects/demo/areas.json");
  const areas = JSON.parse(readFileSync(areasPath, "utf8"));
  Object.assign(areas.areas.core, {
    enabled: false,
    codingEnabled: false,
    mandate: "Improve the checkout journey with reproducible evidence.",
    linearProjectId: randomUUID(),
  });
  areas.areas.billing = {
    ...areas.areas.core,
    name: "Billing",
    label: "pm:billing",
    mandate: "Make invoice history understandable.",
    linearProjectId: randomUUID(),
  };
  writeFileSync(areasPath, JSON.stringify(areas));

  type Container = {
    payload: DockerJobPayload;
    workerId: string;
    running: boolean;
    exitCode?: number;
  };
  const containers = new Map<string, Container>();
  let prepareGate: ReturnType<typeof barrier> | undefined;
  let inspectGate: { id: string; gate: ReturnType<typeof barrier> } | undefined;
  const docker = {
    preflight: vi.fn(async () => ({
      available: true,
      message: "Synthetic Docker is ready.",
    })),
    ensureImage: vi.fn(async () => "shipgremlins-local:" + "a".repeat(16)),
    startJob: vi.fn(
      async (input: {
        id: string;
        workerId: string;
        payload: DockerJobPayload;
      }) => {
        containers.set(input.id, {
          payload: input.payload,
          workerId: input.workerId,
          running: true,
        });
        return {
          id: input.id,
          name: input.id,
          image: "shipgremlins-local:" + "a".repeat(16),
        };
      },
    ),
    inspectJob: vi.fn(async (id: string) => {
      if (inspectGate?.id === id) await inspectGate.gate.hold();
      const container = containers.get(id);
      return container
        ? {
            exists: true,
            running: container.running,
            status: container.running ? "running" : "exited",
            exitCode: container.exitCode,
          }
        : { exists: false, running: false, status: "missing" };
    }),
    artifacts: vi.fn(async (id: string) => ({
      result: {
        ok: true,
        kind: containers.get(id)?.payload.kind,
        nonce: id,
        browser: "chromium",
        screenshot: "screenshot.png",
      },
      files: [
        {
          name: "screenshot.png",
          size: PNG.length,
          sha256: createHash("sha256").update(PNG).digest("hex"),
        },
      ],
    })),
    readArtifact: vi.fn(async () => PNG),
    logs: vi.fn(async () => "Synthetic runner output.\n"),
    removeJob: vi.fn(async () => {}),
    stopJob: vi.fn(async () => {}),
  } satisfies DockerRunners;
  const prepareJob = vi.fn(async (job: LocalJob): Promise<DockerJobPayload> => {
    if (job.area === "core" && prepareGate) await prepareGate.hold();
    return { kind: job.type, pmMode: job.pmMode, browserVerification: false };
  });
  const options = { root, packageRoot: process.cwd(), docker, prepareJob };
  const runners = createLocalRunners(options);
  controllers.push(runners);
  const finish = (id: string) => {
    const container = containers.get(id)!;
    container.running = false;
    container.exitCode = 0;
  };
  for (let i = 0; i < workerCount; i++) {
    const worker = await runners.create();
    await runners.tick();
    const verify = (await runners.jobs()).find(
      (job) =>
        job.workerId === worker.id &&
        job.type === "verify" &&
        job.status === "running",
    )!;
    finish(verify.id);
    await runners.tick();
  }
  expect(
    (await runners.status()).runners.every(
      (worker) => worker.status === "ready" && worker.verifiedAt,
    ),
  ).toBe(true);
  const jobs = {
    validate: vi.fn(async (input: LocalJobInput) => {
      const current = loadProject(root, input.project!);
      return {
        project: current,
        area: current.areas.find((area) => area.key === input.area)!,
        linearBinding: { connectionId: "default" },
      };
    }),
  } as unknown as ReturnType<typeof createJobPreparation>;
  const sourceControl = {
    status: vi.fn(async () => [
      {
        provider: "github",
        serverUrl: "https://github.com",
        available: true,
        connected: true,
        method: "oauth",
      },
    ]),
  } as unknown as SourceControl;
  const linearConnection = {
    status: vi.fn(async () => ({
      provider: "linear",
      available: true,
      connected: true,
      method: "token",
    })),
  } as unknown as OAuthConnection;
  const vercelConnection = {
    status: vi.fn(async () => ({
      provider: "vercel",
      available: true,
      connected: false,
      method: "none",
    })),
  } as unknown as OAuthConnection;
  let url = "";
  const nativeFetch = globalThis.fetch;
  const external = vi.fn(async () => {
    throw new Error("Outbound requests are forbidden in the queue fixture.");
  });
  vi.spyOn(globalThis, "fetch").mockImplementation((input, init) =>
    url && String(input).startsWith(url + "/")
      ? nativeFetch(input, init)
      : external(),
  );
  const server = createDashboardServer(root, process.cwd(), SESSION, [], {
    runners,
    docker,
    jobs,
    sourceControl,
    linearConnection,
    vercelConnection,
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  await runners.tick();
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = async (area: string) => {
    const response = await fetch(url + "/api/jobs", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${SESSION}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ type: "pm", project: "demo", area }),
    });
    return {
      status: response.status,
      body: (await response.json()) as { job: LocalJob; error?: string },
    };
  };
  const persisted = () =>
    JSON.parse(
      readFileSync(join(root, ".run/local-runners/state.json"), "utf8"),
    ) as { jobs: LocalJob[]; nextRunId: number };
  return {
    root,
    runners,
    docker,
    prepareJob,
    post,
    persisted,
    finish,
    external,
    holdPreparation() {
      prepareGate = barrier();
      return prepareGate;
    },
    holdInspection(id: string) {
      inspectGate = { id, gate: barrier() };
      return inspectGate.gate;
    },
  };
}

describe("PM queue admission while the local controller is working", () => {
  it("returns 202 and durably queues a second PM during first-PM preparation, then uses the idle second worker", async () => {
    const f = await fixture(2);
    const first = await f.post("core");
    expect(first.status).toBe(202);
    const gate = f.holdPreparation();
    const tick = f.runners.tick();
    await gate.waiting;
    const duplicate = await f.post("core");
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error).toContain(
      "already has a queued or running job",
    );
    const second = await f.post("billing");
    expect(second, JSON.stringify(second.body)).toMatchObject({
      status: 202,
      body: { job: { area: "billing", status: "queued" } },
    });
    const saved = f.persisted().jobs;
    expect(saved.find((job) => job.id === first.body.job.id)).toMatchObject({
      status: "running",
      area: "core",
    });
    expect(saved.find((job) => job.id === second.body.job.id)).toMatchObject({
      status: "queued",
      area: "billing",
    });
    expect(second.body.job.runId).toBeGreaterThan(first.body.job.runId);
    expect(
      f.docker.startJob.mock.calls.some(
        ([input]) => input.id === second.body.job.id,
      ),
    ).toBe(false);
    gate.release();
    await tick;
    const running = (await f.runners.jobs()).filter((job) => job.type === "pm");
    expect(running).toHaveLength(2);
    expect(running.every((job) => job.status === "running")).toBe(true);
    expect(new Set(running.map((job) => job.workerId)).size).toBe(2);
    expect(f.external).not.toHaveBeenCalled();
  });
  it("keeps a second accepted PM durable while Docker inspection holds the only worker and dispatches once after completion", async () => {
    const f = await fixture(1);
    const first = await f.post("core");
    expect(first.status).toBe(202);
    await f.runners.tick();
    const firstWorker = (await f.runners.job(first.body.job.id))?.workerId;
    expect(firstWorker).toMatch(/^worker-/);
    const gate = f.holdInspection(first.body.job.id);
    const tick = f.runners.tick();
    await gate.waiting;
    const second = await f.post("billing");
    expect(second, JSON.stringify(second.body)).toMatchObject({
      status: 202,
      body: { job: { area: "billing", status: "queued" } },
    });
    expect(
      f.persisted().jobs.find((job) => job.id === second.body.job.id)?.status,
    ).toBe("queued");
    gate.release();
    await tick;
    expect((await f.runners.job(second.body.job.id))?.status).toBe("queued");
    expect(
      f.docker.startJob.mock.calls.some(
        ([input]) => input.id === second.body.job.id,
      ),
    ).toBe(false);
    f.finish(first.body.job.id);
    await f.runners.tick();
    expect(await f.runners.job(first.body.job.id)).toMatchObject({
      status: "succeeded",
    });
    expect(await f.runners.job(second.body.job.id)).toMatchObject({
      status: "running",
      workerId: firstWorker,
    });
    await f.runners.tick();
    expect(
      f.docker.startJob.mock.calls.filter(
        ([input]) => input.id === second.body.job.id,
      ),
    ).toHaveLength(1);
    expect(f.external).not.toHaveBeenCalled();
  });
});
