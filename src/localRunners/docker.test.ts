import { realpathSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { fileURLToPath } from "node:url";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCheckedDelivery } from "../../runner-local/delivery.mjs";
import {
  enforceDeadline,
  jobEnvironments,
  MAX_JOB_MS,
  restoreGitConfig,
} from "../../runner-local/runtime.mjs";
import {
  createDockerRunners,
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
    if (args[0] === "inspect") {
      const value = containers.get(args.at(-1)!);
      return value
        ? ok(JSON.stringify(value))
        : missing("Error: No such object");
    }
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
const developer = {
  kind: "developer",
  repoUrl: "https://github.com/example/app.git",
  branch: "pm-staging",
  provider: "github",
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
  },
} satisfies DockerJobPayload;

describe("local Docker job runtime", () => {
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
    expect(create[create.indexOf("--restart") + 1]).toBe("no");
    expect(create).not.toContain("--privileged");
    expect(create.join(" ")).not.toContain("docker.sock");
    expect(create.join(" ")).not.toContain("type=bind");
    const commandText = JSON.stringify(test.calls.map((call) => call.args));
    expect(commandText).not.toContain("private-test-value");
    expect(commandText).not.toContain("private-model-value");
    const delivery = test.calls.find((call) => call.args[0] === "exec")!;
    expect(delivery.args).toContain("--interactive");
    expect(JSON.parse(delivery.options!.stdin!)).toEqual(developer);
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
      baseSha: "a".repeat(40),
      repoUrl: `https://${host}/example/app.git`,
      provider,
      run: async (command: string, args: string[]) => {
        calls.push([command, ...args]);
        if (command === "/bin/bash" && args[1] === failure)
          throw new Error("Check failed");
        if (args[0] === "branch") return developer.delivery.branch + "\n";
        if (args[0] === "status") return changed ? " M src/app.ts\n" : "";
        if (args[0] === "diff") return changed ? "src/app.ts\n" : "";
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
      });
      expect(h.calls.slice(0, 5).map((call) => call[2])).toEqual(
        Object.values(h.input.commands),
      );
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
      expect(commit).toContain("user.name=ShipGremlins");
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
      GREMLINS_GIT_TOKEN: "inherited-git",
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
      "GREMLINS_GIT_TOKEN",
    ])
      expect(execution).not.toHaveProperty(key);
    expect(execution).toMatchObject({
      CLAUDE_CODE_OAUTH_TOKEN: "model-secret",
      GREMLINS_PREVIEW_BYPASS: "preview-secret",
      GIT_ASKPASS: "/bin/false",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
    });
    expect(publication.GREMLINS_GIT_TOKEN).toBe("gitlab-secret");
    expect(publication).not.toHaveProperty("CLAUDE_CODE_OAUTH_TOKEN");
    expect(publication).not.toHaveProperty("GREMLINS_PREVIEW_BYPASS");
    expect(publication.GH_TOKEN).toBe("");
    expect(publication.GIT_ASKPASS).toBe("/opt/gremlins/git-askpass.sh");
    expect(inherited.GH_TOKEN).toBe("inherited-gh");
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
    } finally {
      vi.useRealTimers();
    }
  });
});
