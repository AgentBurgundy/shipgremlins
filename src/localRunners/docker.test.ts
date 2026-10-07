import { realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import * as testEnvironments from "../testEnvironments/index.ts";
import * as workspaceStorage from "./workspace.ts";
import { fileURLToPath } from "node:url";
import {
  mkdtempSync,
  mkdirSync,
  linkSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runCheckedDelivery,
  readImplementationReport,
} from "../../runner-local/delivery.mjs";
import {
  enforceDeadline,
  jobEnvironments,
  MAX_JOB_MS,
  preparePublication,
  restoreGitConfig,
} from "../../runner-local/runtime.mjs";
import {
  createDockerRunners,
  validatePayload,
  type DockerRun,
  type DockerRunOptions,
  type DockerJobPayload,
} from "./docker.ts";

const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
const id = "job-browser-test";
const workerId = "worker-test";
const MANAGED = "io.shipgremlins.managed";
const JOB = "io.shipgremlins.job";
type FakeContainer = {
  Name: string;
  Config: { Image: string; Labels: Record<string, string> };
  State: { Running: boolean; Status: string; ExitCode: number };
};
function fake() {
  const calls: Array<{ args: string[]; options?: DockerRunOptions }> = [];
  const containers = new Map<string, FakeContainer>();
  const volumes = new Map<
    string,
    { Name: string; Labels: Record<string, string> }
  >();
  let imageExists = true;
  let helperResult: unknown = { result: { ok: true, nonce: id }, files: [] };
  let log = "worker output";
  const run: DockerRun = async (args, options) => {
    calls.push({ args, options });
    const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });
    const missing = (stderr: string) => ({ code: 1, stdout: "", stderr });
    if (args[0] === "version")
      return ok(JSON.stringify({ Os: "linux", Arch: "amd64" }));
    if (args[0] === "network" && args[1] === "inspect")
      return missing("No such network");
    if (args[0] === "network" && args[1] === "connect") return ok();
    if (args[0] === "ps") return ok();
    if (args[0] === "inspect") {
      const value = containers.get(args.at(-1)!);
      return value
        ? ok(JSON.stringify(value))
        : missing("Error: No such object");
    }
    if (args[0] === "image" && args.at(-1)?.startsWith("shipgremlins-app:"))
      return missing("No such image");
    if (args[0] === "image")
      return imageExists ? ok("[{}]") : missing("No such image");
    if (args[0] === "build") {
      imageExists = true;
      options?.onOutput?.("Built local image");
      return ok();
    }
    const labels = () =>
      Object.fromEntries(
        args.flatMap((arg, index) =>
          arg === "--label" ? [args[index + 1]!.split("=")] : [],
        ),
      );
    if (args[0] === "volume") {
      const name = args.at(-1)!;
      if (args[1] === "inspect") {
        const value = volumes.get(name);
        return value ? ok(JSON.stringify(value)) : missing("No such volume");
      }
      if (args[1] === "create") {
        volumes.set(name, { Name: name, Labels: labels() });
        return ok(name);
      }
      if (args[1] === "rm") {
        volumes.delete(name);
        return ok(name);
      }
    }
    if (args[0] === "create") {
      const name = args[args.indexOf("--name") + 1]!;
      containers.set(name, {
        Name: `/${name}`,
        Config: { Image: args.at(-1)!, Labels: labels() },
        State: { Running: false, Status: "created", ExitCode: 0 },
      });
      return ok("container-id");
    }
    if (args[0] === "start") {
      const value = containers.get(args[1]!)!;
      value.State = { Running: true, Status: "running", ExitCode: 0 };
      return ok();
    }
    if (args[0] === "stop") {
      const value = containers.get(args.at(-1)!)!;
      value.State = { Running: false, Status: "exited", ExitCode: 143 };
      return ok();
    }
    if (args[0] === "exec") return ok('{"accepted":true}');
    if (args[0] === "logs") return ok(log);
    if (args[0] === "rm") {
      containers.delete(args[1]!);
      return ok();
    }
    if (args[0] === "run")
      return ok(
        args.includes("read")
          ? Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString("base64")
          : JSON.stringify(helperResult),
      );
    throw new Error("Unexpected Docker command in test");
  };
  const api = createDockerRunners({ packageRoot, run });
  const complete = () => {
    containers.get(`gremlins-job-${id}`)!.State = {
      Running: false,
      Status: "exited",
      ExitCode: 0,
    };
  };
  return {
    calls,
    containers,
    volumes,
    run,
    api,
    complete,
    setImage: (value: boolean) => {
      imageExists = value;
    },
    setLog: (value: string) => {
      log = value;
    },
    setArtifacts: (value: unknown) => {
      helperResult = value;
    },
  };
}
const verify = { kind: "verify", nonce: id } satisfies DockerJobPayload;

it("binds only a verified per-job workspace while preserving separate output storage", async () => {
  const f = fake();
  const storage = {
    check: vi.fn(() => "/mnt/storage/gremlins"),
    preflight: vi.fn(async () => undefined),
    prepare: vi.fn(
      async () => `type=bind,source=/mnt/storage/gremlins/${id},target=/work`,
    ),
  };
  const factory = vi
    .spyOn(workspaceStorage, "createRunnerWorkspaceStorage")
    .mockReturnValue(storage);
  try {
    const api = createDockerRunners({
      packageRoot,
      run: f.run,
      environmentNamespace: "/configuration",
    });
    await api.startJob({ id, workerId, payload: verify });
    expect(factory).toHaveBeenCalledWith({
      configurationRoot: "/configuration",
      workspaceRoot: undefined,
      run: f.run,
    });
    const args = f.calls.find(({ args }) => args[0] === "create")!.args;
    expect(args).toContain(
      `type=bind,source=/mnt/storage/gremlins/${id},target=/work`,
    );
    expect(args).toContain(
      `type=volume,source=gremlins-output-${id},target=/output`,
    );
    await api.stopJob(id);
    await api.cleanupEnvironment!(id);
    expect(f.volumes.size).toBe(1);
    expect(f.containers.has(`gremlins-job-${id}`)).toBe(true);
  } finally {
    factory.mockRestore();
  }
});

it("fails storage admission before creating the agent container or passing credentials", async () => {
  const f = fake();
  const failure = new workspaceStorage.RunnerWorkspaceError(
    "Runner storage has less than 5 GiB free.",
  );
  const factory = vi
    .spyOn(workspaceStorage, "createRunnerWorkspaceStorage")
    .mockReturnValue({
      check: vi.fn(() => "/mnt/storage/gremlins"),
      preflight: vi.fn(async () => undefined),
      prepare: vi.fn(async () => {
        throw failure;
      }),
    });
  try {
    const api = createDockerRunners({ packageRoot, run: f.run });
    await expect(api.startJob({ id, workerId, payload: verify })).rejects.toBe(
      failure,
    );
    expect(
      f.calls.some(({ args }) =>
        ["create", "exec", "volume"].includes(args[0]!),
      ),
    ).toBe(false);
  } finally {
    factory.mockRestore();
  }
});

it("shows a safe storage readiness failure and refuses an image build on low disk", async () => {
  const f = fake();
  const failure = new workspaceStorage.RunnerWorkspaceError(
    "Runner storage has less than 5 GiB free.",
  );
  const factory = vi
    .spyOn(workspaceStorage, "createRunnerWorkspaceStorage")
    .mockReturnValue({
      check: vi.fn(() => {
        throw failure;
      }),
      preflight: vi.fn(async () => {
        throw failure;
      }),
      prepare: vi.fn(async () => undefined),
    });
  try {
    const api = createDockerRunners({ packageRoot, run: f.run });
    await expect(api.preflight()).resolves.toEqual({
      available: false,
      message: failure.message,
    });
    await expect(api.ensureImage()).rejects.toBe(failure);
    expect(f.calls).toEqual([]);
  } finally {
    factory.mockRestore();
  }
});

const developer = {
  kind: "developer",
  repoUrl: "https://github.com/example/app.git",
  branch: "pm-staging",
  provider: "github",
  commitIdentity: {
    name: "gremlin-user",
    email: "77+gremlin-user@users.noreply.github.com",
  },
  prompt: "Fix the approved ticket and run checks.",
  credentials: {
    GITHUB_TOKEN: "private-test-value",
    CLAUDE_CODE_OAUTH_TOKEN: "private-model-value",
  },
  commands: { install: "npm ci", test: "npm test" },
  delivery: {
    ticket: "APP-123",
    title: "Repair checkout",
    base: "pm-staging",
    branch: "gremlins/job-browser-test",
    repo: "example/app",
    acceptanceCriteria: ["Checkout persists after reload."],
  },
} satisfies DockerJobPayload;

describe("local Docker job runtime", () => {
  it("counts app preparation against runtime and never launches when the budget is exhausted", async () => {
    let now = 1_000;
    const time = vi.spyOn(Date, "now").mockImplementation(() => now);
    const managed = {
      start: vi.fn(async () => {
        now += 125_000;
        return {
          url: "http://app.test:3000",
          network: "private-app-net",
          imageId: `sha256:${"f".repeat(64)}`,
          health: { ready: true as const, status: 200 },
        };
      }),
      cleanup: vi.fn(async () => {}),
      reconcile: vi.fn(async () => {}),
      smoke: vi.fn(),
    };
    const factory = vi
      .spyOn(testEnvironments, "createTestEnvironments")
      .mockReturnValue(managed);
    try {
      const payload: DockerJobPayload = {
        ...developer,
        expectedCommitSha: "a".repeat(40),
        maxRuntimeMinutes: 10,
        testEnvironment: {
          target: {
            kind: "docker",
            role: "preview",
            recipe: { kind: "image", image: "example/app:1" },
            port: 3000,
          },
        },
      };
      const f = fake();
      await f.api.startJob({ id, workerId, payload });
      const received = f.calls.find((c) =>
        c.args.includes("/opt/gremlins/receive-job.mjs"),
      )!.options!.stdin!;
      expect(JSON.parse(received)).toMatchObject({
        maxRuntimeMinutes: 10,
        remainingRuntimeMs: 475_000,
      });
      const expired = fake();
      await expect(
        expired.api.startJob({
          id,
          workerId,
          payload: { ...payload, maxRuntimeMinutes: 2 },
        }),
      ).rejects.toThrow("runtime budget");
      expect(expired.calls.some((c) => c.args[0] === "create")).toBe(false);
      expect(managed.cleanup).toHaveBeenCalledWith(id);
    } finally {
      factory.mockRestore();
      time.mockRestore();
    }
  });
  it("preserves a one-minute job's precise remaining budget through payload handoff", async () => {
    let now = 1_000;
    const time = vi.spyOn(Date, "now").mockImplementation(() => now);
    const managed = {
      start: vi.fn(async () => {
        now += 1_235;
        return {
          url: "http://app.test:3000",
          network: "private-app-net",
          imageId: `sha256:${"f".repeat(64)}`,
          health: { ready: true as const, status: 200 },
        };
      }),
      cleanup: vi.fn(async () => {}),
      reconcile: vi.fn(async () => {}),
      smoke: vi.fn(),
    };
    const factory = vi
      .spyOn(testEnvironments, "createTestEnvironments")
      .mockReturnValue(managed);
    try {
      const f = fake();
      await f.api.startJob({
        id,
        workerId,
        payload: {
          ...developer,
          maxRuntimeMinutes: 1,
          expectedCommitSha: "a".repeat(40),
          testEnvironment: {
            target: {
              kind: "docker",
              role: "preview",
              recipe: { kind: "image", image: "example/app:1" },
              port: 3000,
            },
          },
        },
      });
      const delivery = f.calls.find((c) =>
        c.args.includes("/opt/gremlins/receive-job.mjs"),
      )!;
      expect(JSON.parse(delivery.options!.stdin!)).toMatchObject({
        maxRuntimeMinutes: 1,
        remainingRuntimeMs: 58_765,
      });
      expect(await f.api.inspectJob(id)).toMatchObject({ running: true });
      expect(() =>
        validatePayload({
          ...developer,
          maxRuntimeMinutes: 1,
          remainingRuntimeMs: 60_001,
        }),
      ).toThrow("remaining");
    } finally {
      factory.mockRestore();
      time.mockRestore();
    }
  });
  it("keeps application inputs out of the model payload and attaches only its private network", async () => {
    const managed = {
      start: vi.fn(async () => ({
        url: "http://app.test:3000",
        network: "private-app-net",
        imageId: `sha256:${"f".repeat(64)}`,
        commitSha: "a".repeat(40),
        health: { ready: true as const, status: 200 },
      })),
      cleanup: vi.fn(async () => {}),
      reconcile: vi.fn(async () => {}),
      smoke: vi.fn(),
    };
    const factory = vi
      .spyOn(testEnvironments, "createTestEnvironments")
      .mockReturnValue(managed);
    try {
      const f = fake();
      const payload: DockerJobPayload = {
        ...developer,
        expectedCommitSha: "a".repeat(40),
        testEnvironment: {
          target: {
            kind: "docker",
            role: "preview",
            recipe: { kind: "image", image: "example/app:1" },
            port: 3000,
            env: { APP_KEY: "TEST_APP_KEY" },
          },
          env: { APP_KEY: "private-app-secret" },
        },
      };
      await f.api.startJob({ id, workerId, payload });
      expect(managed.start).toHaveBeenCalledWith(
        expect.objectContaining({ env: { APP_KEY: "private-app-secret" } }),
      );
      const delivered = f.calls.find((c) =>
        c.args.includes("/opt/gremlins/receive-job.mjs"),
      )!.options!.stdin!;
      expect(delivered).not.toContain("private-app-secret");
      expect(delivered).not.toContain("testEnvironment");
      expect(JSON.parse(delivered)).toMatchObject({
        expectedCommitSha: "a".repeat(40),
        prompt: expect.stringContaining("http://app.test:3000"),
      });
      expect(
        f.calls.some(
          (c) =>
            JSON.stringify(c.args) ===
            JSON.stringify([
              "network",
              "connect",
              "private-app-net",
              `gremlins-job-${id}`,
            ]),
        ),
      ).toBe(true);
      await f.api.stopJob(id);
      expect(managed.cleanup).toHaveBeenCalledWith(id);
    } finally {
      factory.mockRestore();
    }
  });
  it("allows only bounded test-account credential aliases and requires pinned app jobs", () => {
    expect(() =>
      validatePayload({
        ...developer,
        credentials: {
          ...developer.credentials,
          GREMLINS_TEST_USERNAME_1: "test-user",
          GREMLINS_TEST_PASSWORD_8: "test-password",
        },
      }),
    ).not.toThrow();
    expect(() =>
      validatePayload({
        ...developer,
        credentials: {
          ...developer.credentials,
          GREMLINS_TEST_PASSWORD_9: "test-password",
        },
      }),
    ).toThrow();
    const app = {
      target: {
        kind: "docker" as const,
        role: "preview" as const,
        recipe: { kind: "image" as const, image: "example/app:1" },
        port: 3000,
      },
    };
    expect(() =>
      validatePayload({ ...developer, testEnvironment: app }),
    ).toThrow("pinned");
    expect(() =>
      validatePayload({
        ...developer,
        kind: "pm",
        pmMode: "discovery",
        expectedCommitSha: "a".repeat(40),
        testEnvironment: app,
      }),
    ).toThrow("normal job");
  });
  it("stops only a labeled owned container and retains its output volume", async () => {
    const test = fake();
    await test.api.startJob({ id, workerId, payload: verify });
    await test.api.stopJob(id);
    expect(test.calls.find((call) => call.args[0] === "stop")?.args).toEqual([
      "stop",
      "--time",
      "20",
      `gremlins-job-${id}`,
    ]);
    expect(test.containers.size).toBe(1);
    expect(test.volumes.size).toBe(1);
    await test.api.stopJob(id);
    expect(test.calls.filter((call) => call.args[0] === "stop")).toHaveLength(
      1,
    );
    test.containers.get(`gremlins-job-${id}`)!.Config.Labels[MANAGED] = "false";
    await expect(test.api.stopJob(id)).rejects.toThrow();
    await expect(test.api.stopJob("../another")).rejects.toThrow();
  });
  it("allows product exploration to inspect code and file proposals, without code publication or delivery review", async () => {
    const payload: DockerJobPayload = {
      ...developer,
      kind: "pm",
      pmMode: "exploration",
      delivery: undefined,
      browserVerification: false,
      credentials: { ...developer.credentials, LINEAR_API_KEY: "linear-key" },
    };
    expect(() => validatePayload(payload)).not.toThrow();
    expect(() =>
      validatePayload({ ...payload, delivery: developer.delivery }),
    ).toThrow("cannot publish");
    expect(() => validatePayload({ ...payload, kind: "developer" })).toThrow(
      "PM mode",
    );
    expect(() => validatePayload({ ...payload, pmMode: "discovery" })).toThrow(
      "Discovery",
    );
    const test = fake();
    await test.api.startJob({ id, workerId, payload });
    expect(test.calls.some((call) => call.args[0] === "start")).toBe(true);
  });

  it("rejects discovery payloads with commands, publication or integration credentials before Docker starts", async () => {
    const test = fake();
    const payload: DockerJobPayload = {
      kind: "pm",
      pmMode: "discovery",
      browserVerification: false,
      repoUrl: developer.repoUrl,
      branch: "main",
      provider: "github",
      prompt: "Inspect code",
      nonce: id,
      credentials: developer.credentials,
    };
    for (const invalid of [
      {
        ...payload,
        credentials: { ...payload.credentials, LINEAR_API_KEY: "forbidden" },
      },
      { ...payload, commands: { install: "npm ci" } },
      { ...payload, delivery: developer.delivery },
      { ...payload, browserVerification: true },
    ]) {
      await expect(
        test.api.startJob({ id, workerId, payload: invalid }),
      ).rejects.toThrow();
    }
    expect(test.calls).toHaveLength(0);
    await test.api.startJob({ id, workerId, payload });
    expect(test.calls.some((call) => call.args[0] === "start")).toBe(true);
  });
  it("accepts bounded large UTF-8 prompts over stdin but rejects oversized contexts before launching", async () => {
    const valid = {
      ...developer,
      kind: "pm" as const,
      delivery: undefined,
      commands: undefined,
      prompt: "é".repeat(180000),
    };
    const test = fake();
    await test.api.startJob({ id, workerId, payload: valid });
    expect(
      test.calls.some((call) => call.options?.stdin?.includes(valid.prompt)),
    ).toBe(true);
    const invalid = fake();
    await expect(
      invalid.api.startJob({
        id,
        workerId,
        payload: { ...valid, prompt: "é".repeat(270000) },
      }),
    ).rejects.toThrow();
    expect(invalid.calls).toHaveLength(0);
  });
  it("checks the Docker server, supported architecture, and Linux mode", async () => {
    expect(await fake().api.preflight()).toMatchObject({
      available: true,
      os: "linux",
      architecture: "amd64",
    });
    for (const info of [
      { Os: "windows", Arch: "amd64" },
      { Os: "linux", Arch: "arm" },
    ]) {
      const api = createDockerRunners({
        packageRoot,
        run: async () => ({
          code: 0,
          stdout: JSON.stringify(info),
          stderr: "",
        }),
      });
      expect((await api.preflight()).available).toBe(false);
    }
    const api = createDockerRunners({
      packageRoot,
      run: async () => {
        throw new Error("private daemon error");
      },
    });
    expect(await api.preflight()).toMatchObject({
      available: false,
      message: "Install and start Docker Desktop or Docker Engine, then retry.",
    });
  });

  it("builds a deterministic packaged image once for concurrent requests", async () => {
    const test = fake();
    test.setImage(false);
    const progress: string[] = [];
    const [first, second] = await Promise.all([
      test.api.ensureImage((message) => progress.push(message)),
      test.api.ensureImage(),
    ]);
    expect(first).toMatch(/^shipgremlins-local:[a-f0-9]{16}$/);
    expect(second).toBe(first);
    expect(test.calls.filter((call) => call.args[0] === "build")).toHaveLength(
      1,
    );
    expect(
      test.calls.find((call) => call.args[0] === "build")?.args.at(-1),
    ).toMatch(/runner-local$/);
    expect(progress.at(-1)).toBe("Local worker image is ready.");
  });

  it("uses a detached isolated job and sends credentials only over stdin", async () => {
    const test = fake();
    const started = await test.api.startJob({
      id,
      workerId,
      payload: developer,
    });
    expect(started.name).toBe(`gremlins-job-${id}`);
    const create = test.calls.find((call) => call.args[0] === "create")!.args;
    expect(create).toContain("1000:1000");
    expect(create).toContain("no-new-privileges");
    expect(create).toContain("--cap-drop");
    expect(create[create.indexOf("--add-host") + 1]).toBe(
      "host.docker.internal:host-gateway",
    );
    expect(create).not.toContain("--network=host");
    expect(create[create.indexOf("--restart") + 1]).toBe("no");
    expect(create).not.toContain("--privileged");
    expect(create.join(" ")).not.toContain("docker.sock");
    expect(create.join(" ")).not.toContain("type=bind");
    const commandText = JSON.stringify(test.calls.map((call) => call.args));
    expect(commandText).not.toContain("private-test-value");
    expect(commandText).not.toContain("private-model-value");
    const delivery = test.calls.find((call) => call.args[0] === "exec")!;
    expect(delivery.args).toContain("--interactive");
    expect(JSON.parse(delivery.options!.stdin!)).toMatchObject(developer);
    expect(
      JSON.parse(delivery.options!.stdin!).maxRuntimeMinutes,
    ).toBeLessThanOrEqual(45);
    expect(await test.api.inspectJob(id)).toMatchObject({
      exists: true,
      running: true,
      status: "running",
      workerId,
    });
  });

  it("does not execute an existing deterministic job again", async () => {
    const test = fake();
    await test.api.startJob({ id, workerId, payload: verify });
    test.complete();
    await test.api.startJob({ id, workerId, payload: verify });
    expect(test.calls.filter((call) => call.args[0] === "exec")).toHaveLength(
      1,
    );
    await expect(
      test.api.startJob({ id, workerId: "worker-other", payload: verify }),
    ).rejects.toThrow("another worker");
  });

  it.each(["../escape", "--privileged", "a;evil", "job with spaces", "UPPER"])(
    "rejects unsafe job ids %s without touching Docker",
    async (value) => {
      const test = fake();
      await expect(
        test.api.startJob({ id: value, workerId, payload: verify }),
      ).rejects.toThrow("identifier");
      expect(test.calls).toHaveLength(0);
    },
  );

  it("rejects credentials in URLs and execution-control or signing credentials", async () => {
    const payloads: DockerJobPayload[] = [
      { ...developer, repoUrl: "https://private-token@github.com/example/app" },
      { ...developer, credentials: { NODE_OPTIONS: "--import arbitrary" } },
      {
        ...developer,
        credentials: { SHIPGREMLINS_ATTESTATION_KEY: "private-signing-key" },
      },
      { ...verify, credentials: { GITHUB_TOKEN: "private" } },
    ];
    for (const payload of payloads) {
      const test = fake();
      await expect(
        test.api.startJob({ id, workerId, payload }),
      ).rejects.toThrow();
      expect(test.calls).toHaveLength(0);
    }
  });

  it("accepts only normalized preview credentials", async () => {
    const test = fake();
    await test.api.startJob({
      id,
      workerId,
      payload: {
        ...developer,
        credentials: {
          GREMLINS_PREVIEW_BYPASS: "preview-secret",
          GREMLINS_PREVIEW_DATABASE_URL:
            "postgres://private:test@example/preview",
        },
      },
    });
    expect(JSON.stringify(test.calls.map((call) => call.args))).not.toContain(
      "preview-secret",
    );
  });

  it("refuses containers or output volumes with another owner", async () => {
    const test = fake();
    await test.api.startJob({ id, workerId, payload: verify });
    test.containers.get(`gremlins-job-${id}`)!.Config.Labels[JOB] =
      "job-someone-else";
    await expect(test.api.logs(id)).rejects.toThrow("not owned");
    await expect(test.api.removeJob(id)).rejects.toThrow("not owned");
    test.containers.get(`gremlins-job-${id}`)!.Config.Labels[JOB] = id;
    test.complete();
    test.volumes.get(`gremlins-output-${id}`)!.Labels[MANAGED] = "false";
    await expect(test.api.artifacts(id)).rejects.toThrow("unavailable");
  });

  it("redacts known credentials and strips terminal control codes from job logs", async () => {
    const test = fake();
    await test.api.startJob({ id, workerId, payload: developer });
    test.setLog(
      "\u001b[31mprivate-test-value private-model-value ghp_unknown123\u001b[0m",
    );
    expect(await test.api.logs(id)).toBe("[REDACTED] [REDACTED] [REDACTED]");
  });

  it("reports a missing container so the controller can use retained history", async () => {
    const test = fake();
    await expect(test.api.logs(id)).rejects.toThrow("retained run history");
    expect(test.calls.some((call) => call.args[0] === "logs")).toBe(false);
  });

  it("reads bounded artifacts through a read-only networkless helper after completion", async () => {
    const test = fake();
    await test.api.startJob({ id, workerId, payload: verify });
    await expect(test.api.artifacts(id)).rejects.toThrow("unavailable");
    test.complete();
    test.setArtifacts({
      result: { ok: true, nonce: id },
      files: [
        {
          name: "screenshot.png",
          size: 128,
          png: true,
          sha256: "a".repeat(64),
        },
      ],
    });
    expect((await test.api.artifacts(id)).files[0]).toMatchObject({
      png: true,
    });
    expect(
      (await test.api.readArtifact(id, "screenshot.png")).subarray(0, 8),
    ).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const helper = test.calls.find((call) => call.args[0] === "run")!.args;
    expect(helper).toContain("--read-only");
    expect(helper).toContain("none");
    expect(helper.join(" ")).toContain("target=/output,readonly");
    await expect(test.api.readArtifact(id, "../secret")).rejects.toThrow(
      "artifact name",
    );
  });

  it("preserves running jobs and removes only stopped owned resources", async () => {
    const test = fake();
    await test.api.startJob({ id, workerId, payload: verify });
    await expect(test.api.removeJob(id)).rejects.toThrow("must finish");
    test.complete();
    await test.api.removeJob(id);
    expect(test.containers.size).toBe(0);
    expect(test.volumes.size).toBe(0);
    expect(await test.api.inspectJob(id)).toEqual({
      exists: false,
      running: false,
      status: "missing",
    });
  });

  it("does not mistake a Docker outage for a missing job", async () => {
    const api = createDockerRunners({
      packageRoot,
      run: async () => ({
        code: 1,
        stdout: "",
        stderr: "Cannot connect to Docker daemon",
      }),
    });
    await expect(api.inspectJob(id)).rejects.toThrow(
      "Make sure Docker is running",
    );
  });
});

describe("trusted local job publication", () => {
  function harness(provider: "github" | "gitlab" = "github") {
    const calls: string[][] = [];
    const published: string[][] = [];
    let failure = "";
    let changed = true;
    let changedFiles = "src/app.ts\n";
    const host = provider === "github" ? "github.com" : "gitlab.com";
    const prUrl = `https://${host}/example/app/${provider === "github" ? "pull" : "-/merge_requests"}/123`;
    let body = "";
    const input = {
      commands: {
        install: "npm ci",
        test: "npm test",
        lint: "npm run lint",
        typecheck: "npm run typecheck",
        build: "npm run build",
      },
      delivery: developer.delivery,
      report: {
        schema: 1,
        summary: "Persist checkout changes before navigation.",
        acceptance: [
          {
            criterion: 1,
            status: "verified",
            evidence: "checkout.test.ts passes the save and reload regression.",
          },
        ],
        ui: {
          changed: false,
          verification: "repository-only",
          evidence:
            "No appearance change; save behavior checked by regression tests.",
        },
        integration: {
          status: "not-applicable",
          evidence: "No external provider change.",
        },
        limitations: [] as string[],
      },
      baseSha: "a".repeat(40),
      repoUrl: `https://${host}/example/app.git`,
      provider,
      commitIdentity: developer.commitIdentity,
      run: async (command: string, args: string[]) => {
        calls.push([command, ...args]);
        if (command === "/bin/bash" && args.at(-1) === failure)
          throw new Error("Check failed");
        if (args[0] === "branch") return developer.delivery.branch + "\n";
        if (args[0] === "status") return changed ? " M src/app.ts\n" : "";
        if (args[0] === "diff") return changed ? changedFiles : "";
        if (args[0] === "rev-parse") return "b".repeat(40) + "\n";
        return "";
      },
      publish: async (command: string, args: string[]) => {
        published.push([command, ...args]);
        return command === "git" ? "" : prUrl;
      },
      writeBody: (value: string) => {
        body = value;
      },
      prepareRepository: () => {
        calls.push(["restore-trusted-config"]);
      },
    };
    return {
      input,
      calls,
      published,
      prUrl,
      body: () => body,
      fail: (value: string) => {
        failure = value;
      },
      noChanges: () => {
        changed = false;
      },
      changedFiles: (files: string) => {
        changedFiles = files;
      },
    };
  }

  it.each([
    "npm ci",
    "npm test",
    "npm run lint",
    "npm run typecheck",
    "npm run build",
  ])("never publishes when %s fails", async (command) => {
    const h = harness();
    h.fail(command);
    await expect(runCheckedDelivery(h.input)).rejects.toThrow("Check failed");
    expect(h.published).toEqual([]);
    expect(h.body()).toBe("");
  });

  it.each(["github", "gitlab"] as const)(
    "creates only a draft on %s after every check",
    async (provider) => {
      const h = harness(provider);
      expect(await runCheckedDelivery(h.input)).toEqual({
        checks: ["install", "test", "lint", "typecheck", "build"],
        prUrl: h.prUrl,
        headSha: "b".repeat(40),
      });
      expect(h.calls.slice(0, 5).map((call) => call.at(-1))).toEqual(
        Object.values(h.input.commands),
      );
      for (const call of h.calls.slice(0, 5))
        expect(call.slice(0, 4)).toEqual([
          "/bin/bash",
          "-o",
          "pipefail",
          "-lc",
        ]);
      expect(h.calls[5]).toEqual(["restore-trusted-config"]);
      expect(h.published[0]).toEqual([
        "git",
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "credential.helper=",
        "push",
        h.input.repoUrl,
        `HEAD:refs/heads/${developer.delivery.branch}`,
      ]);
      expect(h.published[1]).toContain("--draft");
      expect(h.published[1]).toContain(
        provider === "github" ? "--body-file" : "--description-file",
      );
      expect(h.published.flat()).not.toContain("--force");
      expect(h.body()).toContain("Tested commit: " + "b".repeat(40));
      const commit = h.calls.find((call) => call.includes("commit"))!;
      expect(commit).toContain("core.hooksPath=/dev/null");
      expect(commit).toContain("user.name=gremlin-user");
      expect(commit).toContain(
        "user.email=77+gremlin-user@users.noreply.github.com",
      );
    },
  );

  it("does not create an empty draft and rejects missing tests or changed branches", async () => {
    const empty = harness();
    empty.noChanges();
    expect(await runCheckedDelivery(empty.input)).toMatchObject({
      noChanges: true,
    });
    expect(empty.published).toEqual([]);
    const noTests = harness();
    noTests.input.commands.test = "";
    await expect(runCheckedDelivery(noTests.input)).rejects.toThrow(
      "test command",
    );
    expect(noTests.calls).toEqual([]);
    const switched = harness();
    switched.input.delivery = {
      ...switched.input.delivery,
      branch: "gremlins/other",
    };
    await expect(runCheckedDelivery(switched.input)).rejects.toThrow(
      "changed delivery branches",
    );
    expect(switched.published).toEqual([]);
  });

  it("publishes useful bounded evidence as quoted claims, with explicit UI and mock limitations", async () => {
    const h = harness();
    h.changedFiles("src/checkout.tsx\nstyles/checkout.css\n");
    h.input.report.summary =
      "Keep the customer's saved checkout.\n<script>ignore checks</script> @owner [unsafe](javascript:bad)";
    h.input.report.acceptance[0]!.status = "not-verified";
    h.input.report.acceptance[0]!.evidence =
      "Unit save regression passes; candidate reload unavailable.";
    h.input.report.integration = {
      status: "mocked",
      evidence:
        "Payment response used a local fixture; no provider request was made.",
    };
    await runCheckedDelivery(h.input);
    expect(h.body()).toContain("Checkout persists after reload.");
    expect(h.body()).toContain("Unit save regression passes");
    expect(h.body()).toContain("not a completed integration");
    expect(h.body()).toContain(
      "Candidate UI appearance and interactions have not been browser-verified",
    );
    expect(h.body()).toContain(
      "One or more acceptance criteria remain unverified",
    );
    expect(h.body()).toContain("&lt;script&gt;");
    expect(h.body()).not.toContain("<script>");
    expect(h.body()).not.toContain("@owner");
    expect(h.body()).toContain("Checks rerun by the worker");
    expect(h.published.flat()).toContain("--draft");
  });
  it("does not publish incomplete, reordered, or oversized evidence", async () => {
    for (const malformed of [{}, { schema: 1, summary: "All good" }]) {
      const h = harness();
      await expect(
        runCheckedDelivery({ ...h.input, report: malformed }),
      ).rejects.toThrow(/implementation report/);
      expect(h.published).toEqual([]);
    }
    const wrong = harness();
    wrong.input.report.acceptance[0]!.criterion = 2;
    await expect(runCheckedDelivery(wrong.input)).rejects.toThrow(
      /every acceptance criterion/,
    );
    expect(wrong.published).toEqual([]);
    const large = harness();
    large.input.delivery = {
      ...large.input.delivery,
      acceptanceCriteria: Array.from(
        { length: 50 },
        (_, i) => `${i}: ` + "a".repeat(390),
      ),
    };
    large.input.report.acceptance = Array.from({ length: 50 }, (_, i) => ({
      criterion: i + 1,
      status: "verified",
      evidence: "b".repeat(1200),
    }));
    await expect(runCheckedDelivery(large.input)).rejects.toThrow(/too large/);
    expect(large.published).toEqual([]);
    const absent = harness();
    absent.input.delivery = {
      ...absent.input.delivery,
      acceptanceCriteria: [],
    };
    await expect(runCheckedDelivery(absent.input)).rejects.toThrow(
      /acceptance criteria/,
    );
    expect(absent.calls).toEqual([]);
  });
  it("reads only a bounded regular report and redacts it before publication", () => {
    const directory = mkdtempSync(
      join(realpathSync(tmpdir()), "gremlins-report-"),
    );
    try {
      const path = join(directory, "implementation-report.json");
      expect(() => readImplementationReport(directory)).toThrow(/regular/);
      writeFileSync(path, JSON.stringify({ summary: "secret-value" }));
      expect(
        readImplementationReport(directory, (text) =>
          text.replaceAll("secret-value", "[REDACTED]"),
        ),
      ).toEqual({ summary: "[REDACTED]" });
      writeFileSync(path, "x".repeat(64 * 1024 + 1));
      expect(() => readImplementationReport(directory)).toThrow(/64 KiB/);
      writeFileSync(path, "not JSON");
      expect(() => readImplementationReport(directory)).toThrow(/valid JSON/);
      const linked = join(directory, "shared-report.json");
      linkSync(path, linked);
      expect(() => readImplementationReport(directory)).toThrow(/regular/);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it("withholds source tokens from models and all configured commands", () => {
    const credentials = {
      GITHUB_TOKEN: "github-secret",
      GITLAB_TOKEN: "gitlab-secret",
      CLAUDE_CODE_OAUTH_TOKEN: "model-secret",
      GREMLINS_PREVIEW_BYPASS: "preview-secret",
    };
    const inherited = {
      PATH: "/usr/bin",
      GH_TOKEN: "inherited-gh",
      GLAB_TOKEN: "inherited-glab",
      GITLAB_ACCESS_TOKEN: "inherited-gitlab",
      OAUTH_TOKEN: "inherited-oauth",
      CI_JOB_TOKEN: "inherited-ci",
      GREMLINS_GIT_TOKEN: "inherited-git",
      SHELLOPTS: "xtrace",
    };
    const { execution, publication } = jobEnvironments(
      credentials,
      "gitlab",
      inherited,
    );
    for (const key of [
      "GITHUB_TOKEN",
      "GH_TOKEN",
      "GITLAB_TOKEN",
      "GLAB_TOKEN",
      "GITLAB_ACCESS_TOKEN",
      "OAUTH_TOKEN",
      "CI_JOB_TOKEN",
      "GREMLINS_GIT_TOKEN",
    ])
      expect(execution).not.toHaveProperty(key);
    expect(execution).toMatchObject({
      CLAUDE_CODE_OAUTH_TOKEN: "model-secret",
      GREMLINS_PREVIEW_BYPASS: "preview-secret",
      GIT_ASKPASS: "/bin/false",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      SHELLOPTS: "pipefail",
    });
    expect(publication.GREMLINS_GIT_TOKEN).toBe("gitlab-secret");
    expect(publication.GITLAB_TOKEN).toBe("gitlab-secret");
    expect(publication.GLAB_IS_OAUTH2).toBe("true");
    expect(publication.GLAB_ENABLE_CI_AUTOLOGIN).toBe("false");
    expect(publication.GLAB_SEND_TELEMETRY).toBe("false");
    expect(publication).not.toHaveProperty("GLAB_TOKEN");
    expect(publication).not.toHaveProperty("OAUTH_TOKEN");
    expect(publication).not.toHaveProperty("CLAUDE_CODE_OAUTH_TOKEN");
    expect(publication).not.toHaveProperty("GREMLINS_PREVIEW_BYPASS");
    expect(publication.GH_TOKEN).toBe("");
    expect(publication.GIT_ASKPASS).toBe("/opt/gremlins/git-askpass.sh");
    expect(inherited.GH_TOKEN).toBe("inherited-gh");
    expect(inherited.SHELLOPTS).toBe("xtrace");
  });
  it("sets both commit identities from controller metadata and discards inherited author overrides", () => {
    const inherited = {
      GIT_AUTHOR_NAME: "Wrong",
      GIT_AUTHOR_EMAIL: "wrong@example.test",
      GIT_COMMITTER_NAME: "Wrong",
      GIT_COMMITTER_EMAIL: "wrong@example.test",
      GIT_AUTHOR_DATE: "old",
      EMAIL: "wrong@example.test",
    };
    const { execution, publication } = jobEnvironments(
      {},
      "github",
      inherited,
      developer.commitIdentity,
    );
    for (const value of [execution, publication]) {
      expect(value).toMatchObject({
        GIT_AUTHOR_NAME: "gremlin-user",
        GIT_AUTHOR_EMAIL: developer.commitIdentity.email,
        GIT_COMMITTER_NAME: "gremlin-user",
        GIT_COMMITTER_EMAIL: developer.commitIdentity.email,
      });
      expect(value).not.toHaveProperty("EMAIL");
      expect(value).not.toHaveProperty("GIT_AUTHOR_DATE");
    }
    expect(() =>
      validatePayload({ ...developer, commitIdentity: undefined }),
    ).toThrow("verified source-account");
    expect(() =>
      validatePayload({
        ...developer,
        commitIdentity: {
          name: "owner\nattacker",
          email: developer.commitIdentity.email,
        },
      }),
    ).toThrow("verified source-account");
    expect(() =>
      validatePayload({
        ...developer,
        commitIdentity: { name: "owner", email: "gremlins@shipgremlins.ai" },
      }),
    ).toThrow("verified source-account");
  });
  it("normalizes an already committed model change without changing its tested tree", async () => {
    const directory = mkdtempSync(
      join(realpathSync(tmpdir()), "gremlins-author-test-"),
    );
    const git = (args: string[], env: NodeJS.ProcessEnv = process.env) => {
      const result = spawnSync("git", args, {
        cwd: directory,
        env,
        encoding: "utf8",
      });
      if (result.status !== 0) throw new Error(result.stderr);
      return result.stdout.trim();
    };
    try {
      git(["init", "--quiet"]);
      writeFileSync(join(directory, "app.txt"), "before");
      git(["add", "."]);
      git([
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.test",
        "commit",
        "--quiet",
        "-m",
        "base",
      ]);
      const base = git(["rev-parse", "HEAD"]);
      git(["checkout", "-b", developer.delivery.branch]);
      writeFileSync(join(directory, "app.txt"), "after");
      git(["add", "."]);
      git([
        "-c",
        "user.name=Invented Gremlin",
        "-c",
        "user.email=gremlins@shipgremlins.ai",
        "commit",
        "--quiet",
        "-m",
        "model change",
      ]);
      const tree = git(["rev-parse", "HEAD^{tree}"]);
      const h = harness();
      const { execution } = jobEnvironments(
        {},
        "github",
        process.env,
        developer.commitIdentity,
      );
      await runCheckedDelivery({
        ...h.input,
        baseSha: base,
        commands: { test: "fixture check" },
        run: async (command, args) =>
          command === "git" ? git(args, execution) : "",
        prepareRepository: () => restoreGitConfig(directory, h.input.repoUrl),
      });
      expect(git(["show", "-s", "--format=%an|%ae|%cn|%ce"])).toBe(
        `gremlin-user|${developer.commitIdentity.email}|gremlin-user|${developer.commitIdentity.email}`,
      );
      expect(git(["rev-parse", "HEAD^{tree}"])).toBe(tree);
      expect(h.body()).toContain(
        `Tested commit: ${git(["rev-parse", "HEAD"])}`,
      );
      expect(h.published[0]).toContain("push");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
  it.skipIf(process.platform === "win32")(
    "fails a real piped check before publication and preserves successful pipelines",
    async () => {
      const failed = harness(),
        execute = async (command: string, args: string[]) => {
          const result = spawnSync(command, args, {
            encoding: "utf8",
            timeout: 10000,
          });
          if (result.status !== 0) throw new Error("Pipeline failed");
          return result.stdout;
        };
      failed.input.commands = {
        install: "",
        test: "false | cat",
        lint: "",
        typecheck: "",
        build: "",
      };
      failed.input.run = execute;
      await expect(runCheckedDelivery(failed.input)).rejects.toThrow(
        "Pipeline failed",
      );
      expect(failed.published).toEqual([]);
      const { execution } = jobEnvironments({}, "github", {
        PATH: process.env.PATH,
        SHELLOPTS: "xtrace",
      });
      expect(
        spawnSync("/bin/bash", ["-lc", "false | cat"], { env: execution })
          .status,
      ).not.toBe(0);
      expect(
        spawnSync("/bin/bash", ["-lc", "true | cat"], { env: execution })
          .status,
      ).toBe(0);
      expect(
        spawnSync("/bin/bash", ["-o", "pipefail", "-lc", "true | cat"]).status,
      ).toBe(0);
    },
  );

  it("publishes from fresh CLI configuration pinned to the selected issuer", () => {
    const root = mkdtempSync(
      join(realpathSync(tmpdir()), "gremlins-publish-test-"),
    );
    let cleanHome: string | undefined;
    try {
      mkdirSync(join(root, ".git"));
      writeFileSync(join(root, ".git", "config"), "[core]\n bare = false\n");
      const publication: Record<string, string> = {
        GITLAB_TOKEN: "only-publication",
        HOME: "/work/model-home",
        GLAB_CONFIG_DIR: "/work/model-config",
        GITLAB_API_HOST: "wrong.invalid",
        GLAB_API_PROTOCOL: "http",
        GLAB_DEBUG_HTTP: "true",
      };
      cleanHome = preparePublication(
        root,
        "https://gitlab.example.com:8443/team/app.git",
        publication,
      );
      expect(cleanHome).not.toBe(root);
      expect(publication).toMatchObject({
        HOME: cleanHome,
        XDG_CONFIG_HOME: cleanHome,
        GH_CONFIG_DIR: cleanHome,
        GLAB_CONFIG_DIR: cleanHome,
        GITLAB_HOST: "gitlab.example.com:8443",
        GITLAB_API_HOST: "gitlab.example.com:8443",
        GLAB_API_PROTOCOL: "https",
        GLAB_DEBUG_HTTP: "false",
        GITLAB_CI: "false",
        GITLAB_TOKEN: "only-publication",
      });
      expect(readFileSync(join(root, ".git", "config"), "utf8")).toContain(
        "gitlab.example.com:8443/team/app.git",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
      if (cleanHome) rmSync(cleanHome, { recursive: true, force: true });
    }
  });

  it("replaces model-edited credential helpers, hooks, and URL rewriting before publication", () => {
    const root = mkdtempSync(
      join(realpathSync(tmpdir()), "gremlins-git-config-"),
    );
    try {
      mkdirSync(join(root, ".git"));
      writeFileSync(
        join(root, ".git", "config"),
        '[url "https://other.invalid/"]\n insteadOf = https://github.com/\n[credential]\n helper = !evil\n[core]\n hooksPath = /work/evil\n',
      );
      restoreGitConfig(root, "https://github.com/example/app.git");
      const config = readFileSync(join(root, ".git", "config"), "utf8");
      expect(config).toContain('url = "https://github.com/example/app.git"');
      expect(config).toContain("hooksPath = /dev/null");
      expect(config).not.toMatch(/evil|insteadOf|credential/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("enforces a fixed 45-minute deadline with bounded termination and cancellation", () => {
    vi.useFakeTimers();
    try {
      const stop = vi.fn(),
        exit = vi.fn();
      const clear = enforceDeadline(stop, exit);
      vi.advanceTimersByTime(MAX_JOB_MS - 1);
      expect(stop).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(stop).toHaveBeenCalledOnce();
      vi.advanceTimersByTime(10000);
      expect(exit).toHaveBeenCalledWith(124);
      clear();
      const cancel = enforceDeadline(stop, exit);
      cancel();
      vi.advanceTimersByTime(MAX_JOB_MS + 10000);
      expect(stop).toHaveBeenCalledOnce();
      expect(exit).toHaveBeenCalledOnce();
      const shorter = enforceDeadline(stop, exit, 1);
      vi.advanceTimersByTime(59999);
      expect(stop).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(1);
      expect(stop).toHaveBeenCalledTimes(2);
      shorter();
      expect(() => enforceDeadline(stop, exit, 46)).toThrow();
      const remaining = enforceDeadline(stop, exit, 1, 58_765);
      vi.advanceTimersByTime(58_764);
      expect(stop).toHaveBeenCalledTimes(2);
      vi.advanceTimersByTime(1);
      expect(stop).toHaveBeenCalledTimes(3);
      remaining();
      for (const value of [0, -1, 60_001, 1.5, Infinity])
        expect(() => enforceDeadline(stop, exit, 1, value)).toThrow(
          "remaining",
        );
    } finally {
      vi.useRealTimers();
    }
  });
});
