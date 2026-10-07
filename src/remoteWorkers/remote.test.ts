import { afterEach, describe, expect, it, vi } from "vitest";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { initializeSetup } from "../setup/files.ts";
import type { PmReviewPlan } from "../delivery/types.ts";
import { createRemoteWorkers } from "./index.ts";
import {
  createRemoteWorker,
  controllerUrl,
  lockWorkerDirectory,
  selectRemoteArtifacts,
} from "./worker.ts";
import { startLeaseWatchdog } from "../../runner-local/lease.mjs";
import { grumblinFixture } from "../grumblins/runtime-test-support.ts";
import { RunnerWorkspaceError } from "../localRunners/workspace.ts";
import type {
  DockerArtifacts,
  DockerJobInspection,
  DockerJobPayload,
  DockerRunners,
} from "../localRunners/docker.ts";

const directories: string[] = [];
const root = () => {
  const path = realpathSync(
    mkdtempSync(join(tmpdir(), "gremlins-remote-test-")),
  );
  directories.push(path);
  return path;
};
afterEach(() => {
  vi.useRealTimers();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
const payload: DockerJobPayload = {
  kind: "pm",
  project: "alpha",
  repoUrl: "https://github.com/example/app.git",
  branch: "main",
  provider: "github",
  prompt: "Inspect the repository.",
  credentials: {
    GITHUB_TOKEN: "synthetic-source-secret",
    CLAUDE_CODE_OAUTH_TOKEN: "synthetic-model-secret",
  },
};
function dockerFixture() {
  const jobs = new Map<string, DockerJobInspection>();
  let output: DockerArtifacts = {
    result: {
      ok: true,
      kind: "verify",
      nonce: "job-one",
      screenshot: "screenshot.png",
      browser: "chromium",
    },
    files: [
      { name: "screenshot.png", size: 9, png: true },
      { name: "screenshots/check.png", size: 9, png: true },
    ],
  };
  const docker: DockerRunners = {
    preflight: vi.fn(async () => ({ available: true, message: "ready" })),
    ensureImage: vi.fn(async () => "shipgremlins-local:1234567890abcdef"),
    startJob: vi.fn(async (input) => {
      jobs.set(input.id, {
        exists: true,
        running: true,
        status: "running",
        workerId: input.workerId,
      });
      return { id: input.id, name: input.id, image: "test" };
    }),
    inspectJob: vi.fn(
      async (id) =>
        jobs.get(id) ?? { exists: false, running: false, status: "missing" },
    ),
    stopJob: vi.fn(async (id) => {
      const job = jobs.get(id);
      if (job)
        jobs.set(id, {
          ...job,
          running: false,
          status: "exited",
          exitCode: 130,
        });
    }),
    logs: vi.fn(async () => "Worker progress"),
    artifacts: vi.fn(async () => output),
    readArtifact: vi.fn(async () =>
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]),
    ),
    removeJob: vi.fn(async () => {}),
    refreshLease: vi.fn(async () => {}),
  };
  return {
    docker,
    jobs,
    setOutput: (value: DockerArtifacts) => {
      output = value;
    },
  };
}
function fixture() {
  let now = Date.now();
  const directory = root(),
    hub = createRemoteWorkers({ root: directory, clock: () => now });
  const enrollment = hub.createEnrollment({
      name: "Remote test",
      projects: ["alpha"],
    }),
    worker = hub.enroll({
      code: enrollment.code,
      platform: "linux",
      architecture: "x64",
    });
  const local = dockerFixture(),
    adapter = hub.adapter(local.docker);
  return {
    hub,
    enrollment,
    worker,
    adapter,
    directory,
    local,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe("remote worker enrollment and scope", () => {
  it("persists bounded usage artifacts through authenticated remote transfer and rejects replay without the lease", async () => {
    const f = fixture();
    await f.adapter.prepareWorker!("worker-one", f.worker.id);
    await f.adapter.startJob({
      id: "job-usage",
      workerId: "worker-one",
      payload,
    });
    const lease = f.hub.poll(f.worker.token).job!.lease;
    const metrics = Buffer.from(
      JSON.stringify({
        schemaVersion: 1,
        source: "claude-code",
        inputTokens: 12,
        outputTokens: null,
        cacheReadInputTokens: 4,
        cacheCreationInputTokens: 0,
        complete: false,
        reportedAt: "2026-10-05T00:00:00.000Z",
      }),
    );
    const request = {
      id: "job-usage",
      lease,
      name: "usage.json",
      content: metrics.toString("base64"),
    };
    f.hub.artifact(f.worker.token, request);
    expect(() =>
      f.hub.artifact(f.worker.token, { ...request, lease: "0".repeat(64) }),
    ).toThrow();
    expect(() =>
      f.hub.artifact(f.worker.token, {
        ...request,
        content: Buffer.alloc(4097).toString("base64"),
      }),
    ).toThrow("too large");
    f.hub.report(f.worker.token, {
      id: "job-usage",
      lease,
      running: false,
      exitCode: 1,
      logs: "stopped",
      result: { ok: false, kind: "pm" },
    });
    const restarted = createRemoteWorkers({ root: f.directory }).adapter(
      f.local.docker,
    );
    expect(await restarted.readArtifact("job-usage", "usage.json")).toEqual(
      metrics,
    );
  });
  it("preserves the immutable Grumblin through remote storage/restart and rejects Linear credentials", async () => {
    const f = fixture();
    await f.adapter.prepareWorker!("worker-one", f.worker.id);
    const grumblin = grumblinFixture({ project: "alpha" });
    const input: DockerJobPayload = {
      ...payload,
      pmMode: "grumblin",
      grumblin,
      browserVerification: true,
      grumblinTarget: { url: "https://test.invalid", role: "staging" },
    };
    await expect(
      f.adapter.startJob({
        id: "job-forbidden",
        workerId: "worker-one",
        payload: {
          ...input,
          credentials: { ...input.credentials, LINEAR_API_KEY: "never-send" },
        },
      }),
    ).rejects.toThrow("no Linear");
    await f.adapter.startJob({
      id: "job-grumblin",
      workerId: "worker-one",
      payload: input,
    });
    await expect(
      f.adapter.startJob({
        id: "job-grumblin",
        workerId: "worker-one",
        payload: { ...input, grumblin: { ...grumblin, clickBudget: 30 } },
      }),
    ).rejects.toThrow("already assigned");
    expect(f.hub.poll(f.worker.token).job?.payload).toMatchObject({
      pmMode: "grumblin",
      grumblin,
    });
    const restarted = createRemoteWorkers({ root: f.directory });
    expect(restarted.poll(f.worker.token).job?.payload).toMatchObject({
      pmMode: "grumblin",
      grumblin,
    });
    expect(f.local.docker.startJob).not.toHaveBeenCalled();
  });
  it("requires new enrollment after a project name is reused for a different incarnation", async () => {
    const f = fixture();
    initializeSetup(
      f.directory,
      fileURLToPath(new URL("../..", import.meta.url)),
      { project: "alpha", repo: "owner/old" },
    );
    await f.adapter.prepareWorker!("worker-one", f.worker.id);
    f.hub.poll(f.worker.token);
    expect(f.adapter.canRun!(f.worker.id, "alpha")).toBe(true);
    const path = join(f.directory, "projects/alpha/project.json");
    const config = JSON.parse(readFileSync(path, "utf8"));
    config.instanceId = "a1b2c3d4-1111-2222-3333-444444444444";
    config.repo = "owner/replacement";
    writeFileSync(path, JSON.stringify(config));
    expect(f.adapter.canRun!(f.worker.id, "alpha")).toBe(false);
    await expect(
      f.adapter.startJob({
        id: "job-old-scope",
        workerId: "worker-one",
        payload,
      }),
    ).rejects.toThrow("cannot accept work");
    const invite = f.hub.createEnrollment({
      name: "Replacement project",
      projects: ["alpha"],
    });
    const enrolled = f.hub.enroll({
      code: invite.code,
      platform: "linux",
      architecture: "x64",
    });
    f.hub.poll(enrolled.token);
    await f.adapter.prepareWorker!("worker-two", enrolled.id);
    expect(f.adapter.canRun!(enrolled.id, "alpha")).toBe(true);
    await expect(
      f.adapter.startJob({
        id: "job-new-scope",
        workerId: "worker-two",
        payload,
      }),
    ).resolves.toBeDefined();
  });
  it("only accepts review proof attested through the worker channel for the assigned plan", async () => {
    const f = fixture();
    await f.adapter.prepareWorker!("worker-one", f.worker.id);
    const plan = {
      schema: 1,
      id: "plan-test",
      jobId: "job-one",
      project: "alpha",
      area: "core",
      deployment: {
        id: "dep-test",
        url: "https://preview.example.com",
        sha: "a".repeat(40),
        state: "READY",
      },
      deliveries: [{ id: "delivery-test", criteria: ["Shows the feature"] }],
    } as unknown as PmReviewPlan;
    await f.adapter.startJob({
      id: "job-one",
      workerId: "worker-one",
      payload: {
        ...payload,
        nonce: "job-one",
        browserVerification: true,
        reviewPlan: plan,
      },
    });
    const assignment = f.hub.poll(f.worker.token).job!;
    expect(() =>
      f.hub.artifact(f.worker.token, {
        id: assignment.id,
        lease: assignment.lease,
        name: "pm-review-proof.json",
        content: Buffer.from("forged-model-proof").toString("base64"),
      }),
    ).toThrow(/unauthenticated/);
    const proof = Buffer.from(JSON.stringify({ manifest: {}, receipts: {} }));
    f.hub.artifact(f.worker.token, {
      id: assignment.id,
      lease: assignment.lease,
      name: "pm-review-proof.json",
      content: proof.toString("base64"),
      trustedReview: true,
    });
    f.hub.report(f.worker.token, {
      id: assignment.id,
      lease: assignment.lease,
      running: false,
      exitCode: 0,
      logs: "done",
      result: { ok: true, kind: "pm", reviewProof: { sha256: "MODEL-FORGED" } },
      review: {
        planHash: createHash("sha256")
          .update(JSON.stringify(plan))
          .digest("hex"),
        commitSha: plan.deployment.sha,
      },
    });
    const review = await f.adapter.verifyReview!(assignment.id, plan);
    expect(review.proof).toEqual(proof);
    expect(review.result).toEqual({
      ok: true,
      kind: "pm",
      nonce: "job-one",
      commitSha: plan.deployment.sha,
    });
    await expect(
      f.adapter.verifyReview!(assignment.id, { ...plan, id: "other-plan" }),
    ).rejects.toThrow(/no independent/);
  });
  it("uses an expiring single-use code and never exposes authentication in status or plaintext registry", () => {
    const f = fixture();
    expect(() =>
      f.hub.enroll({
        code: f.enrollment.code,
        platform: "linux",
        architecture: "x64",
      }),
    ).toThrow(/expired|used/);
    const text = JSON.stringify(f.hub.status());
    expect(text).not.toContain(f.worker.token);
    expect(text).not.toContain(f.enrollment.code);
    expect(f.hub.status().workers[0]).toMatchObject({
      enrolled: true,
      online: true,
      projects: ["alpha"],
    });
    const registry = readFileSync(
      join(f.directory, ".run", "remote-workers", "registry.enc"),
    );
    expect(registry.includes(Buffer.from(f.worker.token))).toBe(false);
  });
  it("rejects expired enrollments and unknown/revoked tokens", () => {
    const f = fixture();
    const code = f.hub.createEnrollment({
      name: "Late worker",
      projects: ["alpha"],
    });
    f.advance(600001);
    expect(() =>
      f.hub.enroll({ code: code.code, platform: "linux", architecture: "x64" }),
    ).toThrow(/expired/);
    expect(() => f.hub.poll("f".repeat(64))).toThrow(/authentication/);
    f.hub.revoke(f.worker.id);
    expect(() => f.hub.poll(f.worker.token)).toThrow(/revoked/);
  });
  it("scopes assignments to selected projects and avoids host Docker for a remote slot", async () => {
    const f = fixture();
    await f.adapter.prepareWorker!("worker-one", f.worker.id);
    expect(f.local.docker.ensureImage).not.toHaveBeenCalled();
    expect(f.adapter.canRun!(f.worker.id, "beta")).toBe(false);
    await expect(
      f.adapter.startJob({
        id: "job-one",
        workerId: "worker-one",
        payload: { ...payload, project: "beta" },
      }),
    ).rejects.toThrow(/cannot accept/);
    await f.adapter.startJob({
      id: "job-one",
      workerId: "worker-one",
      payload,
    });
    expect(f.hub.status().workers[0]?.logicalId).toBe("worker-one");
    const assignment = f.hub.poll(f.worker.token).job!;
    expect(assignment).toMatchObject({
      id: "job-one",
      payload: { project: "alpha", remoteLease: true },
    });
    expect(f.local.docker.startJob).not.toHaveBeenCalled();
    expect(
      readFileSync(
        join(f.directory, ".run", "remote-workers", "registry.enc"),
      ).includes(Buffer.from("synthetic-source-secret")),
    ).toBe(false);
  });
  it("fences reports and artifacts by worker and random job lease", async () => {
    const f = fixture();
    await f.adapter.prepareWorker!("worker-one", f.worker.id);
    await f.adapter.startJob({
      id: "job-one",
      workerId: "worker-one",
      payload,
    });
    const assignment = f.hub.poll(f.worker.token).job!;
    const other = f.hub.createEnrollment({
        name: "Other",
        projects: ["alpha"],
      }),
      otherWorker = f.hub.enroll({
        code: other.code,
        platform: "linux",
        architecture: "arm64",
      });
    const report = {
      id: "job-one",
      lease: assignment.lease,
      running: true,
      logs: "progress",
    };
    expect(() => f.hub.report(otherWorker.token, report)).toThrow(
      /does not belong/,
    );
    expect(() =>
      f.hub.report(f.worker.token, { ...report, lease: "a".repeat(64) }),
    ).toThrow(/does not belong/);
    expect(() =>
      f.hub.artifact(f.worker.token, {
        id: "job-one",
        lease: assignment.lease,
        name: "../secret",
        content: "YWJj",
      }),
    ).toThrow(/artifact name/);
  });
  it("redacts actual credential values and never retains hidden thinking as job logs", async () => {
    const f = fixture();
    await f.adapter.prepareWorker!("worker-one", f.worker.id);
    await f.adapter.startJob({
      id: "job-one",
      workerId: "worker-one",
      payload,
    });
    const job = f.hub.poll(f.worker.token).job!;
    f.hub.report(f.worker.token, {
      id: job.id,
      lease: job.lease,
      running: true,
      logs: 'synthetic-source-secret\n{"type":"assistant","message":{"content":[{"type":"thinking","thinking":"private-reasoning"}]}}',
    });
    expect(await f.adapter.logs(job.id)).not.toContain(
      "synthetic-source-secret",
    );
    expect(await f.adapter.logs(job.id)).not.toContain("private-reasoning");
    f.hub.artifact(f.worker.token, {
      id: job.id,
      lease: job.lease,
      name: "summary.md",
      content: Buffer.from("observations synthetic-model-secret").toString(
        "base64",
      ),
    });
    f.hub.report(f.worker.token, {
      id: job.id,
      lease: job.lease,
      running: false,
      exitCode: 0,
      logs: "done",
      result: { ok: true, kind: "pm", summary: "synthetic-source-secret" },
    });
    expect(
      (await f.adapter.readArtifact(job.id, "summary.md")).toString(),
    ).toBe("observations [REDACTED]");
    expect((await f.adapter.artifacts(job.id)).result?.summary).toBe(
      "[REDACTED]",
    );
  });
  it("preserves assignment after restart and expires an offline worker without reassigning its job", async () => {
    const f = fixture();
    await f.adapter.prepareWorker!("worker-one", f.worker.id);
    await f.adapter.startJob({
      id: "job-one",
      workerId: "worker-one",
      payload,
    });
    const first = f.hub.poll(f.worker.token).job!;
    const restarted = createRemoteWorkers({ root: f.directory });
    expect(restarted.poll(f.worker.token).job?.lease).toBe(first.lease);
    f.advance(150000);
    expect(await f.adapter.inspectJob("job-one")).toMatchObject({
      running: false,
      exitCode: 124,
    });
    expect(() =>
      f.hub.report(f.worker.token, {
        id: first.id,
        lease: first.lease,
        running: false,
        exitCode: 0,
        logs: "late",
        result: { ok: true },
      }),
    ).toThrow(/ended/);
    expect(f.hub.poll(f.worker.token).job).toBeNull();
  });
  it("requests cancellation without claiming the remote container already stopped", async () => {
    const f = fixture();
    await f.adapter.prepareWorker!("worker-one", f.worker.id);
    await f.adapter.startJob({
      id: "job-one",
      workerId: "worker-one",
      payload,
    });
    const first = f.hub.poll(f.worker.token).job!;
    await f.adapter.stopJob(first.id);
    expect(await f.adapter.inspectJob(first.id)).toMatchObject({
      running: true,
    });
    expect(f.hub.poll(f.worker.token).job).toMatchObject({ cancel: true });
    f.hub.report(f.worker.token, {
      id: first.id,
      lease: first.lease,
      running: false,
      exitCode: 130,
      logs: "canceled",
      result: { ok: false, kind: "pm" },
    });
    expect(await f.adapter.inspectJob(first.id)).toMatchObject({
      running: false,
      exitCode: 130,
    });
  });
  it("blocks symlink storage paths", () => {
    const directory = root(),
      target = root();
    symlinkSync(
      target,
      join(directory, ".run"),
      process.platform === "win32" ? "junction" : "dir",
    );
    expect(() =>
      createRemoteWorkers({ root: directory }).createEnrollment({
        name: "test",
        projects: ["alpha"],
      }),
    ).toThrow();
    expect(readdirSync(target)).toHaveLength(0);
  });
});

describe("remote worker process", () => {
  it("renews a mutable admission deadline while app preparation outlasts its first lease", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    const d = dockerFixture();
    d.docker.cleanupEnvironment = vi.fn(async () => {});
    const active = {
      id: "job-one",
      workerId: "worker-one",
      lease: "b".repeat(64),
      ttlMs: 120000,
      payload: { ...payload, remoteLease: true },
    };
    const fetcher = vi.fn(
      async (url: string | URL | Request) =>
        new Response(
          JSON.stringify(
            String(url).endsWith("/enroll")
              ? {
                  id: "remote-12345678-1234-1234-1234-123456789012",
                  token: "a".repeat(64),
                }
              : String(url).endsWith("/poll")
                ? { job: active }
                : {},
          ),
          { status: 200 },
        ),
    );
    const worker = createRemoteWorker({
      root: root(),
      controller: "https://controller.example",
      docker: d.docker,
      fetch: fetcher,
    });
    await worker.enroll("c".repeat(64));
    let release!: () => void;
    let admitted: DockerJobPayload | undefined;
    const ready = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.mocked(d.docker.startJob).mockImplementation(async (input) => {
      admitted = input.payload;
      await ready;
      d.jobs.set(input.id, {
        exists: true,
        running: true,
        status: "running",
        workerId: input.workerId,
      });
      return { id: input.id, name: input.id, image: "fixture" };
    });
    const pending = worker.step();
    await vi.advanceTimersByTimeAsync(0);
    expect(admitted).toBeDefined();
    const first = admitted!.remoteLeaseDeadline!;
    await vi.advanceTimersByTimeAsync(180000);
    expect(admitted!.remoteLeaseDeadline).toBeGreaterThan(first + 120000);
    release();
    await pending;
    expect(d.docker.refreshLease).toHaveBeenCalled();
    expect(d.docker.cleanupEnvironment).not.toHaveBeenCalled();
    d.jobs.set("job-one", {
      exists: true,
      running: false,
      status: "exited",
      exitCode: 0,
      workerId: "worker-one",
    });
    await worker.step();
    expect(d.docker.cleanupEnvironment).toHaveBeenCalledWith("job-one");
    const artifactOrder = vi
      .mocked(d.docker.readArtifact)
      .mock.invocationCallOrder.at(-1)!;
    expect(
      vi.mocked(d.docker.cleanupEnvironment).mock.invocationCallOrder[0],
    ).toBeGreaterThan(artifactOrder);
  });
  it("revokes the launch deadline and cleans app resources when canceled during preparation", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    const d = dockerFixture();
    d.docker.cleanupEnvironment = vi.fn(async () => {});
    let polls = 0;
    const job = {
      id: "job-one",
      workerId: "worker-one",
      lease: "b".repeat(64),
      ttlMs: 120000,
      payload: { ...payload, remoteLease: true },
    };
    const fetcher = vi.fn(
      async (url: string | URL | Request) =>
        new Response(
          JSON.stringify(
            String(url).endsWith("/enroll")
              ? {
                  id: "remote-12345678-1234-1234-1234-123456789012",
                  token: "a".repeat(64),
                }
              : { job: { ...job, cancel: ++polls > 1 } },
          ),
          { status: 200 },
        ),
    );
    const worker = createRemoteWorker({
      root: root(),
      controller: "https://controller.example",
      docker: d.docker,
      fetch: fetcher,
    });
    await worker.enroll("c".repeat(64));
    let release!: () => void;
    let admitted: DockerJobPayload | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.mocked(d.docker.startJob).mockImplementation(async (input) => {
      admitted = input.payload;
      await gate;
      d.jobs.set(input.id, {
        exists: true,
        running: true,
        status: "running",
        workerId: input.workerId,
      });
      return { id: input.id, name: input.id, image: "fixture" };
    });
    const pending = worker.step();
    const rejected = expect(pending).rejects.toThrow(
      "lease ended during environment preparation",
    );
    await vi.advanceTimersByTimeAsync(20000);
    expect(admitted?.remoteLeaseDeadline).toBe(0);
    release();
    await rejected;
    expect(d.docker.stopJob).toHaveBeenCalledWith("job-one");
    expect(d.docker.cleanupEnvironment).toHaveBeenCalledWith("job-one");
    expect(d.docker.refreshLease).not.toHaveBeenCalled();
  });
  it("prioritizes independent proof over model artifacts and terminates oversized review evidence clearly", () => {
    const names = new Set([
        "pm-review-proof.json",
        "review-screenshots/proof.png",
      ]),
      ordinary = Array.from({ length: 45 }, (_, index) => ({
        name: `file-${index}.md`,
        size: 10,
      }));
    const selected = selectRemoteArtifacts(
      [
        ...ordinary,
        { name: "pm-review-proof.json", size: 100 },
        { name: "review-screenshots/proof.png", size: 100 },
      ],
      names,
    );
    expect(selected.files.slice(0, 2).map((file) => file.name)).toEqual([
      ...names,
    ]);
    expect(selected.files).toHaveLength(40);
    expect(selected.omittedTrusted).toBe(false);
    const huge = Array.from({ length: 4 }, (_, index) => ({
      name: `review-screenshots/${index}.png`,
      size: 10 * 1024 * 1024,
    }));
    expect(
      selectRemoteArtifacts(huge, new Set(huge.map((file) => file.name))),
    ).toMatchObject({ omittedTrusted: true });
  });
  it("retains bounded token metadata without displacing a full reviewed-evidence quota", () => {
    const files = Array.from({ length: 40 }, (_, index) => ({
      name: `review-screenshots/${index}.png`,
      size: 800000,
    }));
    const result = selectRemoteArtifacts(
      [...files, { name: "usage.json", size: 4096 }],
      new Set(files.map((file) => file.name)),
    );
    expect(result.files).toHaveLength(41);
    expect(result.files.at(-1)).toEqual({ name: "usage.json", size: 4096 });
    expect(result.omittedTrusted).toBe(false);
    expect(
      selectRemoteArtifacts([{ name: "usage.json", size: 4097 }], new Set())
        .files,
    ).toEqual([]);
  });
  async function serverFixture() {
    const f = fixture(),
      server = createServer((req, res) => {
        void f.hub.handleRequest(req, res);
      });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const address = server.address() as { port: number };
    return {
      ...f,
      origin: `http://127.0.0.1:${address.port}`,
      close: () => new Promise<void>((done) => server.close(() => done())),
    };
  }
  it("runs the real authenticated HTTP protocol, survives process restart, and uploads PNG proof", async () => {
    const f = await serverFixture();
    try {
      const registration = f.hub.createEnrollment({
          name: "Process",
          projects: ["alpha"],
        }),
        docker = dockerFixture(),
        workerRoot = root(),
        worker = createRemoteWorker({
          root: workerRoot,
          controller: f.origin,
          docker: docker.docker,
        });
      await worker.enroll(registration.code);
      await f.adapter.prepareWorker!("worker-process", registration.id);
      await f.adapter.startJob({
        id: "job-one",
        workerId: "worker-process",
        payload: { kind: "verify", nonce: "job-one" },
      });
      await worker.step();
      expect(docker.docker.startJob).toHaveBeenCalledTimes(1);
      expect(docker.docker.refreshLease).toHaveBeenCalled();
      const restarted = createRemoteWorker({
        root: workerRoot,
        controller: f.origin,
        docker: docker.docker,
      });
      await restarted.step();
      expect(docker.docker.startJob).toHaveBeenCalledTimes(1);
      docker.jobs.set("job-one", {
        exists: true,
        running: false,
        status: "exited",
        workerId: "worker-process",
        exitCode: 0,
      });
      await restarted.step();
      expect(await f.adapter.inspectJob("job-one")).toMatchObject({
        running: false,
        exitCode: 0,
      });
      expect((await f.adapter.artifacts("job-one")).files).toMatchObject([
        { name: "screenshot.png", png: true, size: 9 },
        { name: "screenshots/check.png", png: true, size: 9 },
      ]);
      expect(
        (await f.adapter.readArtifact("job-one", "screenshot.png")).subarray(
          0,
          8,
        ),
      ).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      expect(
        (await f.adapter.readArtifact("job-one", "screenshots/check.png"))
          .length,
      ).toBe(9);
    } finally {
      await f.close();
    }
  }, 15000);
  it.each(["storage", "untrusted"])(
    "reports %s independent-review failure safely without replaying completed work",
    async (failure) => {
      const f = await serverFixture();
      try {
        const registration = f.hub.createEnrollment({
            name: "Review process",
            projects: ["alpha"],
          }),
          docker = dockerFixture(),
          workerRoot = root(),
          worker = createRemoteWorker({
            root: workerRoot,
            controller: f.origin,
            docker: docker.docker,
          });
        const storageMessage =
          "Runner storage has less than 5 GiB free. Free space on its storage drive before starting another job. Retained work and evidence were not deleted.";
        const verifyReview = vi.fn(async () => {
          throw failure === "storage"
            ? new RunnerWorkspaceError(storageMessage)
            : Object.assign(
                new Error("private path and unexpected credential"),
                {
                  name: "RunnerWorkspaceError",
                },
              );
        });
        docker.docker.verifyReview = verifyReview;
        vi.mocked(docker.docker.inspectJob).mockImplementation(async (id) => ({
          ...(docker.jobs.get(id) ?? {
            exists: false,
            running: false,
            status: "missing",
          }),
        }));
        const plan: PmReviewPlan = {
          schema: 1,
          id: "review-plan",
          jobId: "job-one",
          project: "alpha",
          area: "core",
          configuration: "c".repeat(64),
          createdAt: new Date().toISOString(),
          deployment: {
            id: "deployment-one",
            url: "https://preview.example.com",
            sha: "a".repeat(40),
            branch: "pm-staging",
            provider: "vercel",
            state: "READY",
          },
          deliveries: [
            {
              id: "delivery-one",
              ticket: {
                id: "ticket-one",
                identifier: "APP-1",
                title: "Show feature",
                description: "Show the approved feature.",
                projectId: "linear-project",
                teamId: "linear-team",
              },
              implementationPr: 1,
              mergeSha: "a".repeat(40),
              scopeHash: "d".repeat(64),
              criteria: ["Shows the feature"],
            },
          ],
        };
        await worker.enroll(registration.code);
        await f.adapter.prepareWorker!("worker-process", registration.id);
        await f.adapter.startJob({
          id: "job-one",
          workerId: "worker-process",
          payload: {
            ...payload,
            nonce: "job-one",
            browserVerification: true,
            reviewPlan: plan,
          },
        });
        await worker.step();
        docker.jobs.set("job-one", {
          exists: true,
          running: false,
          status: "exited",
          exitCode: 0,
          workerId: "worker-process",
        });
        await worker.step();

        const expectedMessage =
          failure === "storage"
            ? `${storageMessage} Completed work and evidence are retained; independent browser review did not finish. Promotion remains blocked.`
            : "Independent browser review could not complete. Promotion remains blocked.";
        expect(await f.adapter.inspectJob("job-one")).toMatchObject({
          running: false,
          exitCode: 1,
        });
        const artifacts = await f.adapter.artifacts("job-one");
        expect(artifacts.result).toEqual({
          ok: false,
          kind: "pm",
          error: expectedMessage,
        });
        expect(artifacts.files).toMatchObject([
          { name: "screenshot.png", png: true },
          { name: "screenshots/check.png", png: true },
        ]);
        const logs = await f.adapter.logs("job-one");
        expect(logs).toContain(expectedMessage);
        expect(logs).not.toContain("private path and unexpected credential");
        await expect(f.adapter.verifyReview!("job-one", plan)).rejects.toThrow(
          /no independent/,
        );

        const restarted = createRemoteWorker({
          root: workerRoot,
          controller: f.origin,
          docker: docker.docker,
        });
        await restarted.step();
        expect(verifyReview).toHaveBeenCalledOnce();
        expect(docker.docker.startJob).toHaveBeenCalledOnce();
        expect(docker.docker.removeJob).not.toHaveBeenCalled();
        expect(docker.docker.stopJob).not.toHaveBeenCalled();
        expect(docker.jobs.get("job-one")).toMatchObject({
          status: "exited",
          exitCode: 0,
        });
      } finally {
        await f.close();
      }
    },
    15000,
  );
  it("never replays an ambiguous attempted launch after worker restart", async () => {
    const f = await serverFixture();
    try {
      const registration = f.hub.createEnrollment({
          name: "Process",
          projects: ["alpha"],
        }),
        docker = dockerFixture(),
        workerRoot = root(),
        worker = createRemoteWorker({
          root: workerRoot,
          controller: f.origin,
          docker: docker.docker,
        });
      await worker.enroll(registration.code);
      await f.adapter.prepareWorker!("worker-process", registration.id);
      await f.adapter.startJob({
        id: "job-one",
        workerId: "worker-process",
        payload: { kind: "verify", nonce: "job-one" },
      });
      vi.mocked(docker.docker.startJob).mockRejectedValueOnce(
        new Error("connection lost"),
      );
      await expect(worker.step()).rejects.toThrow();
      const restarted = createRemoteWorker({
        root: workerRoot,
        controller: f.origin,
        docker: docker.docker,
      });
      await restarted.step();
      expect(docker.docker.startJob).toHaveBeenCalledTimes(1);
      expect(await f.adapter.inspectJob("job-one")).toMatchObject({
        running: false,
        exitCode: 125,
      });
    } finally {
      await f.close();
    }
  }, 15000);
  it("requires HTTPS except loopback or explicitly allowed private IPs", () => {
    expect(controllerUrl("https://worker.example")).toBe(
      "https://worker.example",
    );
    expect(controllerUrl("http://127.0.0.1:4311")).toContain("4311");
    expect(() => controllerUrl("http://192.168.1.20:4311")).toThrow(/HTTPS/);
    expect(controllerUrl("http://192.168.1.20:4311", true)).toContain(
      "192.168",
    );
    expect(controllerUrl("http://100.100.1.20", true)).toContain("100.100");
    for (const url of [
      "http://8.8.8.8",
      "http://private.example",
      "http://127.attacker.example",
      "https://user:secret@example.com",
      "https://example.com/#session=secret",
    ])
      expect(() => controllerUrl(url, true)).toThrow();
  });
  it("prevents concurrent worker processes from sharing a persisted launch identity", () => {
    const directory = root();
    const release = lockWorkerDirectory(directory);
    expect(() => lockWorkerDirectory(directory)).toThrow(
      /Another worker process/,
    );
    release();
    lockWorkerDirectory(directory)();
  });
  it("container lease independently stops on expiry and cannot be extended beyond the fixed bound", () => {
    vi.useFakeTimers();
    let now = 0;
    const stop = vi.fn(),
      exit = vi.fn();
    const clear = startLeaseWatchdog({
      stop,
      exit,
      now: () => now,
      read: () => ({ expiresAt: 10000 }),
    });
    now = 10001;
    vi.advanceTimersByTime(2000);
    expect(stop).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(10000);
    expect(exit).toHaveBeenCalledWith(124);
    clear();
    const stopBad = vi.fn();
    startLeaseWatchdog({
      stop: stopBad,
      exit,
      now: () => 0,
      read: () => ({ expiresAt: 120001 }),
    })();
    expect(stopBad).toHaveBeenCalledOnce();
  });
});
