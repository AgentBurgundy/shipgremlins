import { afterEach, describe, expect, it, vi } from "vitest";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import type { PmReviewPlan } from "../delivery/types.ts";
import { createRemoteWorkers } from "./index.ts";
import {
  createRemoteWorker,
  controllerUrl,
  lockWorkerDirectory,
  selectRemoteArtifacts,
} from "./worker.ts";
import { startLeaseWatchdog } from "../../runner-local/lease.mjs";
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
