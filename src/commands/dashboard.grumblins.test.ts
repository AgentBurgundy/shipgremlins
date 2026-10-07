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
  GrumblinError,
  type createGrumblins,
  type GrumblinProfileSnapshot,
} from "../grumblins/index.ts";
import {
  createLocalRunners,
  LocalRunnerError,
  type LocalRunners,
} from "../localRunners/engine.ts";
import type { LocalJob } from "../localRunners/types.ts";
import type { SourceControl } from "../sourceControl/types.ts";
import type { createJobPreparation } from "../localRunners/jobs.ts";
import type { OAuthConnection } from "../oauthConnection/types.ts";

const roots: string[] = [],
  servers: Server[] = [];
const session = "a".repeat(64);
afterEach(async () => {
  for (const server of servers.splice(0))
    await new Promise<void>((done) => server.close(() => done()));
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
async function fixture(
  options: {
    browser?: boolean;
    worker?: boolean;
    foundation?: boolean;
    instanceId?: string;
  } = {},
) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "grumblin-api-")));
  roots.push(root);
  initializeSetup(root, process.cwd(), { project: "demo", repo: "owner/app" });
  writeFileSync(join(root, ".env"), "CLAUDE_CODE_OAUTH_TOKEN=synthetic-only\n");
  const file = join(root, "projects", "demo", "project.json");
  const config = JSON.parse(readFileSync(file, "utf8"));
  if (options.instanceId) config.instanceId = options.instanceId;
  if (options.browser !== false) {
    config.verification = { mode: "browser", environment: "preview" };
    config.environments = {
      preview: {
        kind: "url",
        role: "preview",
        url: "https://preview.example.test",
        access: { kind: "public" },
      },
    };
  }
  if (options.foundation)
    config.ideaPlanId = "22222222-2222-4222-8222-222222222222";
  writeFileSync(file, JSON.stringify(config));
  const project = loadProject(root, "demo");
  const profile: GrumblinProfileSnapshot = {
    id: "11111111-1111-4111-8111-111111111111",
    key: "rushed-owner",
    name: "Pip",
    role: "Small shop owner",
    personality:
      "Impatient about repeated setup; values control over magical defaults.",
    goal: "Set up one project and see useful progress.",
    context: "Working between customer calls.",
    patience: "low",
    clickBudget: 8,
    familiarity: "first-time",
    device: "mobile",
    successCriteria: ["Can identify the next action without instructions."],
    relevanceRationale: "The project serves small shop owners.",
    assumptions: ["Mobile setup is a proposed scenario."],
    suggestedArea: "core",
    project: "demo",
    ...(project.config.instanceId
      ? { projectInstanceId: project.config.instanceId }
      : {}),
    revision: "a".repeat(64),
    contextRevision: "b".repeat(64),
    generatedAt: "2026-10-05T00:00:00.000Z",
    simulation: true,
  };
  const saved = {
    project: "demo",
    projectInstanceId: project.config.instanceId,
    revision: profile.revision,
    contextRevision: profile.contextRevision,
    profiles: [profile],
    generatedAt: profile.generatedAt,
    simulation: true as const,
    stale: false,
  };
  const grumblins = {
    read: vi.fn(() => saved),
    generate: vi.fn(async () => saved),
    profile: vi.fn((_project: string, id: string, revision: string) => {
      if (id !== profile.id || revision !== profile.revision)
        throw new GrumblinError("Refresh this Grumblin before running.", 409);
      return profile;
    }),
  } as unknown as ReturnType<typeof createGrumblins>;
  const queued: LocalJob[] = [];
  const enqueue = vi.fn(async (input) => {
    const job = {
      ...input,
      id: `job-${queued.length + 1}`,
      runId: queued.length + 1,
      status: "queued",
      createdAt: new Date().toISOString(),
    } as LocalJob;
    queued.push(job);
    return job;
  });
  const runners = {
    status: vi.fn(async () => ({
      runners:
        options.worker === false
          ? []
          : [
              {
                id: "worker",
                status: "ready",
                verifiedAt: "2026-10-05",
                paused: false,
              },
            ],
      jobs: queued,
    })),
    jobs: vi.fn(async () => queued),
    enqueue,
    start: vi.fn(),
    stop: vi.fn(async () => {}),
  } as unknown as LocalRunners;
  const validate = vi.fn(async () => ({
    project: loadProject(root, "demo"),
    area: project.areas[0]!,
    discoveryRevision: "c".repeat(64),
  }));
  const connection = {
    status: vi.fn(async () => ({
      provider: "linear",
      connected: false,
      available: true,
      method: "oauth",
    })),
  } as unknown as OAuthConnection;
  const sourceControl = {
    status: vi.fn(async () => [
      {
        provider: "github",
        serverUrl: "https://github.com",
        connected: true,
        available: true,
        method: "oauth",
      },
    ]),
  } as unknown as SourceControl;
  const server = createDashboardServer(root, process.cwd(), session, [], {
    grumblins,
    runners,
    sourceControl,
    jobs: { validate } as unknown as ReturnType<typeof createJobPreparation>,
    linearConnection: connection,
    vercelConnection: connection,
    background: false,
  });
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = (suffix = "", input?: unknown, auth = true) =>
    fetch(`${url}/api/projects/demo/grumblins${suffix}`, {
      method: input === undefined ? "GET" : "POST",
      headers: {
        ...(auth ? { Authorization: `Bearer ${session}` } : {}),
        "Content-Type": "application/json",
      },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }),
    });
  const run = (input = {}) =>
    call("/run", {
      profileId: profile.id,
      revision: profile.revision,
      ...input,
    });
  return {
    root,
    project,
    profile,
    grumblins,
    queued,
    runners,
    enqueue,
    validate,
    call,
    run,
  };
}
describe("project Grumblins API", () => {
  it.each([undefined, "33333333-3333-4333-8333-333333333333"])(
    "persists simulation requests in the real queue for project instance %s",
    async (instanceId) => {
      const f = await fixture({ instanceId });
      const queueOptions = { root: f.root, packageRoot: process.cwd() };
      const queue = createLocalRunners(queueOptions);
      f.enqueue.mockImplementation(queue.enqueue);
      vi.mocked(f.runners.jobs).mockImplementation(queue.jobs);

      const response = await f.run();
      const body = (await response.json()) as { job: LocalJob };
      expect(body).toMatchObject({
        reused: false,
        job: {
          status: "queued",
          project: "demo",
          pmMode: "grumblin",
          grumblin: f.profile,
          discoveryRevision: "c".repeat(64),
        },
      });
      expect(response.status).toBe(202);
      expect(body.job.projectInstanceId).toBe(instanceId);
      expect(await createLocalRunners(queueOptions).job(body.job.id)).toEqual(
        body.job,
      );
      expect(await (await f.run()).json()).toMatchObject({
        reused: true,
        job: { id: body.job.id },
      });
      expect(f.enqueue).toHaveBeenCalledOnce();

      await queue.cancel(body.job.id);
      const rerun = await f.run();
      expect(rerun.status).toBe(202);
      const next = (await rerun.json()) as { job: LocalJob };
      expect(next.job.id).not.toBe(body.job.id);
      expect(next.job.idempotencyKey).not.toBe(body.job.idempotencyKey);
    },
  );
  it("keeps customer planning available while blocking walkthroughs until the foundation exists", async () => {
    const f = await fixture({ foundation: true });
    expect((await f.call("/generate", {})).status).toBe(200);
    const response = await f.run();
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: expect.stringContaining("Build and merge the foundation"),
    });
    expect(f.enqueue).not.toHaveBeenCalled();
  });
  it("shows the actionable queue conflict rather than suggesting a connection problem", async () => {
    const f = await fixture();
    f.enqueue.mockRejectedValue(
      new LocalRunnerError(
        "That PM already has a running job. Wait for it to finish.",
        409,
      ),
    );
    const response = await f.run();
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: "That PM already has a running job. Wait for it to finish.",
    });
  });
  it("requires authentication and rejects supplied personas rather than trusting client instructions", async () => {
    const f = await fixture();
    expect((await f.call("", undefined, false)).status).toBe(401);
    expect((await f.run({ grumblin: { goal: "forged" } })).status).toBe(400);
    expect(f.enqueue).not.toHaveBeenCalled();
  });
  it("generates profiles with optional focus without starting a run", async () => {
    const f = await fixture({ browser: false });
    const response = await f.call("/generate", {
      focus: "First visit on a phone",
    });
    expect(response.status).toBe(200);
    expect(f.grumblins.generate).toHaveBeenCalledWith({
      project: "demo",
      focus: "First visit on a phone",
      signal: expect.any(AbortSignal),
    });
    expect(f.enqueue).not.toHaveBeenCalled();
    const roster = (await (await f.call()).json()) as {
      readiness: unknown;
      profiles: unknown[];
    };
    expect(roster.readiness).toMatchObject({
      canRun: false,
      blockers: expect.arrayContaining([
        expect.objectContaining({ id: "environment" }),
      ]),
    });
    expect(roster.profiles).toHaveLength(1);
  });
  it("queues a frozen server-selected profile without Linear setup or a full doctor stamp, and reuses active clicks", async () => {
    const f = await fixture();
    expect(f.project.config.verified).toBeNull();
    const response = await f.run();
    expect(await response.json()).toMatchObject({
      reused: false,
      job: {
        pmMode: "grumblin",
        runOnce: true,
        grumblin: f.profile,
        area: "core",
      },
    });
    expect(response.status).toBe(202);
    const repeat = await f.run();
    expect(await repeat.json()).toMatchObject({
      reused: true,
      job: { id: "job-1" },
    });
    expect(f.enqueue).toHaveBeenCalledTimes(1);
    expect(f.queued[0]!.linearBinding).toBeUndefined();
    const roster = (await (await f.call()).json()) as {
      readiness: { canRun: boolean };
      jobs: unknown[];
    };
    expect(roster.jobs).toHaveLength(1);
    expect(roster.readiness.canRun).toBe(true);
  });
  it.each([{ browser: false }, { worker: false }])(
    "preserves profiles and blocks execution when setup is incomplete %j",
    async (options) => {
      const f = await fixture(options);
      expect((await f.run()).status).toBe(409);
      expect(f.enqueue).not.toHaveBeenCalled();
    },
  );
  it("rejects stale reviews and unknown PM choices", async () => {
    const f = await fixture();
    expect((await f.run({ revision: "old" })).status).toBe(409);
    expect((await f.run({ area: "unknown" })).status).toBe(400);
    expect(f.enqueue).not.toHaveBeenCalled();
  });
  it("checks the reviewed profile again after async preparation and does not enqueue when it changed", async () => {
    const f = await fixture();
    vi.mocked(f.grumblins.profile)
      .mockImplementationOnce(() => f.profile)
      .mockImplementationOnce(() => f.profile)
      .mockImplementation(() => {
        throw new GrumblinError("Brief changed.", 409);
      });
    expect((await f.run()).status).toBe(409);
    expect(f.validate).toHaveBeenCalledOnce();
    expect(f.enqueue).not.toHaveBeenCalled();
  });
  it("does not silently reuse an active run for an invalid or different explicit PM", async () => {
    const f = await fixture();
    const file = join(f.root, "projects", "demo", "areas.json");
    const data = JSON.parse(readFileSync(file, "utf8"));
    data.areas.other = {
      ...data.areas.core,
      name: "Other PM",
      label: "pm:other",
      mandate: "Investigate another product journey.",
    };
    writeFileSync(file, JSON.stringify(data));
    expect((await f.run()).status).toBe(202);
    expect((await f.run({ area: "unknown" })).status).toBe(400);
    expect((await f.run({ area: "other" })).status).toBe(409);
    expect((await f.run({ area: "core" })).status).toBe(202);
    expect(f.enqueue).toHaveBeenCalledTimes(1);
  });
  it("rechecks the saved profile after awaiting queue lookup even when an active run exists", async () => {
    const f = await fixture();
    await f.run();
    vi.mocked(f.grumblins.profile)
      .mockImplementationOnce(() => f.profile)
      .mockImplementation(() => {
        throw new GrumblinError("Project changed.", 409);
      });
    expect((await f.run()).status).toBe(409);
    expect(f.enqueue).toHaveBeenCalledTimes(1);
  });
  it("serializes overlapping start clicks until the first enqueue completes", async () => {
    const f = await fixture();
    let release!: () => void, entered!: () => void;
    const pending = new Promise<void>((done) => {
      release = done;
    });
    const started = new Promise<void>((done) => {
      entered = done;
    });
    const enqueue = f.enqueue.getMockImplementation()!;
    f.enqueue.mockImplementationOnce(async (input) => {
      entered();
      await pending;
      return enqueue(input);
    });
    const first = f.run();
    await started;
    try {
      expect((await f.run()).status).toBe(409);
    } finally {
      release();
    }
    expect((await first).status).toBe(202);
    expect(f.enqueue).toHaveBeenCalledTimes(1);
  });
  it("allows deliberate reruns after completion with a new idempotency key", async () => {
    const f = await fixture();
    await f.run();
    f.queued[0]!.status = "succeeded";
    expect((await f.run()).status).toBe(202);
    expect(f.queued[0]!.idempotencyKey).not.toBe(f.queued[1]!.idempotencyKey);
  });
});
