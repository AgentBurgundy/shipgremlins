import { describe, expect, it, vi } from "vitest";
import { writeFileSync } from "node:fs";
import {
  createTestEnvironments,
  parseDockerTarget,
  type DockerEnvironmentTarget,
} from "./index.ts";
import type { DockerRun, DockerRunOptions } from "../localRunners/docker.ts";
const digest = `sha256:${"a".repeat(64)}`;
const target: DockerEnvironmentTarget = {
  kind: "docker",
  role: "preview",
  recipe: { kind: "image", image: "example/app:1" },
  port: 3000,
};
function fixture() {
  const calls: Array<{ args: string[]; options?: DockerRunOptions }> = [];
  const networks = new Map<string, Record<string, string>>();
  const containers = new Map<string, Record<string, string>>();
  const builds = new Map<string, Record<string, string>>();
  let failHealth = false;
  let healthOutput = "";
  let appState: Record<string, unknown> | undefined;
  const run: DockerRun = async (args, options) => {
    calls.push({ args, options });
    const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" }),
      missing = (kind: string) => ({
        code: 1,
        stdout: "",
        stderr: `No such ${kind}`,
      });
    const labels = () =>
      Object.fromEntries(
        args.flatMap((a, i) =>
          a === "--label" ? [args[i + 1]!.split("=")] : [],
        ),
      );
    const name = args[args.indexOf("--name") + 1]!;
    if (args[0] === "network") {
      if (args[1] === "inspect") {
        const l = networks.get(args.at(-1)!);
        return l ? ok(JSON.stringify({ Labels: l })) : missing("network");
      }
      if (args[1] === "create") {
        networks.set(args.at(-1)!, labels());
        return ok();
      }
      if (args[1] === "rm") {
        networks.delete(args.at(-1)!);
        return ok();
      }
      if (args[1] === "ls")
        return ok(
          [...networks.values()]
            .filter(
              (l) =>
                !args.some((a) =>
                  a.startsWith("label=io.shipgremlins.environment-owner="),
                ) ||
                l["io.shipgremlins.environment-owner"] ===
                  args
                    .find((a) =>
                      a.startsWith("label=io.shipgremlins.environment-owner="),
                    )!
                    .split("=")
                    .at(-1),
            )
            .map((l) => l["io.shipgremlins.job"])
            .join("\n"),
        );
    }
    if (args[0] === "ps") {
      const job = args
        .find((a) => a.startsWith("label=io.shipgremlins.job="))!
        .split("=")
        .at(-1);
      return ok(
        [...containers]
          .filter(([, l]) => l["io.shipgremlins.job"] === job)
          .map(([n]) => n)
          .join("\n"),
      );
    }
    if (args[0] === "inspect") {
      const l = containers.get(args.at(-1)!);
      return l
        ? ok(
            JSON.stringify({
              Config: { Labels: l },
              ...(args.at(-1)!.endsWith("-app") ? { State: appState } : {}),
            }),
          )
        : missing("container");
    }
    if (args[0] === "image") {
      const image = args.at(-1)!;
      if (args[1] === "ls")
        return ok(
          [...builds]
            .filter(
              ([, l]) =>
                l["io.shipgremlins.environment-owner"] ===
                args
                  .find((a) =>
                    a.startsWith("label=io.shipgremlins.environment-owner="),
                  )
                  ?.split("=")
                  .at(-1),
            )
            .map(([tag]) => tag)
            .join("\n"),
        );
      if (args[1] === "rm") {
        builds.delete(image);
        return ok();
      }
      if (image.startsWith("shipgremlins-app:"))
        return builds.has(image)
          ? ok(
              args.includes("{{.Id}}")
                ? digest
                : args.includes("{{json .Config.Labels}}")
                  ? JSON.stringify(builds.get(image))
                  : JSON.stringify({ Config: { Labels: builds.get(image) } }),
            )
          : missing("image");
      return ok(digest);
    }
    if (args[0] === "create") {
      containers.set(name, labels());
      return ok();
    }
    if (args[0] === "start") return ok();
    if (args[0] === "cp") {
      writeFileSync(args.at(-1)!, "credential-free tracked context");
      return ok();
    }
    if (args[0] === "build") {
      builds.set(args[args.indexOf("--tag") + 1]!, labels());
      return ok();
    }
    if (args[0] === "run") {
      if (name.endsWith("-health"))
        return failHealth
          ? {
              code: 1,
              stdout: healthOutput,
              stderr: "SECRET must never escape",
            }
          : ok('{"status":200}');
      containers.set(name, labels());
      return ok();
    }
    if (args[0] === "rm") {
      containers.delete(args.at(-1)!);
      return ok();
    }
    if (args[0] === "exec") return ok();
    throw new Error(`Unexpected fake command ${args[0]}`);
  };
  const api = createTestEnvironments({
    run,
    ensureImage: async () => "shipgremlins-local:1234567890abcdef",
    namespace: "test-workspace",
  });
  return {
    api,
    run,
    calls,
    networks,
    containers,
    builds,
    fail: (output = "", state?: Record<string, unknown>) => {
      failHealth = true;
      healthOutput = output;
      appState = state;
    },
  };
}
describe("managed application recipes", () => {
  it.each([
    { ...target, role: "production" },
    { ...target, port: 0 },
    { ...target, healthPath: "//evil.test" },
    { ...target, healthPath: "/?token=private" },
    { ...target, mounts: ["/var/run/docker.sock"] },
    {
      ...target,
      recipe: {
        kind: "dockerfile",
        context: "..",
        dockerfile: "../Dockerfile",
      },
    },
    {
      ...target,
      recipe: { kind: "dockerfile", context: "app", dockerfile: "Dockerfile" },
    },
    { ...target, recipe: { kind: "image", image: "--privileged" } },
    { ...target, start: "npm start" },
    { ...target, env: { TOKEN: "GITHUB_TOKEN" } },
    { ...target, env: { NODE_OPTIONS: "APP_SECRET" } },
    { ...target, services: [{ kind: "redis", name: "app", env: "REDIS_URL" }] },
    {
      ...target,
      services: [
        { kind: "postgres", name: "db", env: "URL" },
        { kind: "redis", name: "cache", env: "URL" },
      ],
    },
  ])("rejects unsafe recipe %j", (value) =>
    expect(() => parseDockerTarget(value)).toThrow(),
  );
  it("accepts repository-contained recipe and dedicated dependencies", () => {
    expect(
      parseDockerTarget({
        ...target,
        recipe: {
          kind: "dockerfile",
          context: "web",
          dockerfile: "web/Dockerfile",
        },
        services: [{ kind: "postgres", name: "db", env: "DATABASE_URL" }],
        migrate: ["npm", "run", "migrate"],
      }).services,
    ).toHaveLength(1);
  });
});
describe("managed application lifecycle", () => {
  it("does not tear down an app while its retained worker is still running", async () => {
    const f = fixture();
    const run: DockerRun = async (args, options) =>
      args[0] === "inspect" && args.at(-1) === "gremlins-job-job-live"
        ? {
            code: 0,
            stderr: "",
            stdout: JSON.stringify({
              Config: {
                Labels: {
                  "io.shipgremlins.managed": "true",
                  "io.shipgremlins.job": "job-live",
                },
              },
              State: { Running: true },
            }),
          }
        : f.run(args, options);
    const api = createTestEnvironments({
      run,
      ensureImage: async () => "shipgremlins-local:1234567890abcdef",
      namespace: "test-workspace",
    });
    await api.start({ jobId: "job-live", target });
    await expect(api.cleanup("job-live")).rejects.toThrow("running worker");
    expect(f.containers.size).toBe(1);
    expect(f.networks.size).toBe(1);
  });
  it("detaches a stopped owned worker while preserving its retained container", async () => {
    const f = fixture();
    const network = "gremlins-app-job-retained-net";
    const run: DockerRun = async (args, options) =>
      args[0] === "inspect" && args.at(-1) === "gremlins-job-job-retained"
        ? {
            code: 0,
            stderr: "",
            stdout: JSON.stringify({
              Config: {
                Labels: {
                  "io.shipgremlins.managed": "true",
                  "io.shipgremlins.job": "job-retained",
                },
              },
              State: { Running: false },
              NetworkSettings: { Networks: { [network]: {} } },
            }),
          }
        : args[0] === "network" && args[1] === "disconnect"
          ? { code: 0, stderr: "", stdout: "" }
          : f.run(args, options);
    const disconnect = vi.fn(run);
    const api = createTestEnvironments({
      run: disconnect,
      ensureImage: async () => "shipgremlins-local:1234567890abcdef",
      namespace: "test-workspace",
    });
    await api.start({ jobId: "job-retained", target });
    await api.cleanup("job-retained");
    expect(disconnect).toHaveBeenCalledWith(
      ["network", "disconnect", network, "gremlins-job-job-retained"],
      undefined,
    );
    expect(
      f.calls.some(
        (c) =>
          c.args[0] === "rm" && c.args.at(-1) === "gremlins-job-job-retained",
      ),
    ).toBe(false);
  });
  it("builds only a credential-free context from its pinned checkout", async () => {
    const f = fixture();
    const sha = "c".repeat(40);
    const result = await f.api.smoke({
      jobId: "job-build",
      target: {
        ...target,
        recipe: {
          kind: "dockerfile",
          context: "web",
          dockerfile: "web/Dockerfile",
        },
      },
      source: {
        repoUrl: "https://github.com/example/app.git",
        provider: "github",
        commitSha: sha,
        token: "source-secret",
      },
    });
    expect(result.commitSha).toBe(sha);
    const source = f.calls.find((c) => c.args[0] === "start")!;
    expect(JSON.parse(source.options!.stdin!)).toMatchObject({
      commitSha: sha,
      token: "source-secret",
      context: "web",
    });
    const build = f.calls.find((c) => c.args[0] === "build")!;
    expect(build.args).toContain("Dockerfile");
    expect(build.options?.stdinBuffer?.toString()).toBe(
      "credential-free tracked context",
    );
    expect(f.calls.map((c) => c.args.join(" ")).join("\n")).not.toContain(
      "source-secret",
    );
    expect(f.containers.size).toBe(0);
    expect(f.networks.size).toBe(0);
  });
  it("isolates reconciliation by workspace and expires abandoned verification probes", async () => {
    const f = fixture();
    await f.api.start({ jobId: "job-setup-old", target });
    await f.api.start({ jobId: "job-setup-new", target });
    f.networks.get("gremlins-app-job-setup-old-net")![
      "io.shipgremlins.environment-created"
    ] = String(Date.now() - 91 * 60_000);
    const foreign = createTestEnvironments({
      run: f.run,
      ensureImage: async () => "shipgremlins-local:1234567890abcdef",
      namespace: "other-workspace",
    });
    await foreign.reconcile([]);
    expect(f.networks.size).toBe(2);
    await f.api.reconcile([]);
    expect([...f.networks.keys()]).toEqual(["gremlins-app-job-setup-new-net"]);
    await f.api.smoke({ jobId: "job-active-smoke", target }, async () => {
      await f.api.reconcile([]);
      expect(f.networks.has("gremlins-app-job-active-smoke-net")).toBe(true);
    });
  });
  it("pins images and privately networks app; callback runs before cleanup", async () => {
    const f = fixture();
    const result = await f.api.smoke(
      { jobId: "job-test", target },
      async (env) => {
        expect(env.url).toBe("http://app.test:3000");
        expect(f.containers.size).toBe(1);
        expect(f.networks.size).toBe(1);
      },
    );
    expect(result.imageId).toBe(digest);
    expect(result.commitSha).toBeUndefined();
    expect(f.containers.size).toBe(0);
    expect(f.networks.size).toBe(0);
    const app = f.calls.find((c) =>
      c.args.includes("gremlins-app-job-test-app"),
    )!;
    expect(app.args).toContain(digest);
    expect(app.args).toContain("--cap-drop=ALL");
    expect(app.args.join(" ")).not.toMatch(
      /--publish|--privileged|docker.sock|--mount/,
    );
  });
  it("cleans on failed readiness and never exposes provider output", async () => {
    const f = fixture();
    f.fail();
    await expect(
      f.api.start({ jobId: "job-test", target }),
    ).rejects.toMatchObject({
      name: "TestEnvironmentError",
      code: "app_health_unreachable",
      message: expect.stringContaining(
        "Docker bridge networking and the host firewall",
      ),
    });
    expect(f.containers.size).toBe(0);
    expect(f.networks.size).toBe(0);
  });
  it.each([
    {
      output: '{"status":503}',
      state: undefined,
      code: "app_health_response",
      detail: "HTTP 503",
    },
    {
      output: '{"status":0,"errorCode":"ENOTFOUND"}',
      state: undefined,
      code: "app_health_unreachable",
      detail: "Docker DNS",
    },
    {
      output: "",
      state: { Running: false, Status: "exited", ExitCode: 2 },
      code: "app_exited",
      detail: "exit 2",
    },
    {
      output: "",
      state: {
        Running: false,
        Status: "exited",
        ExitCode: 137,
        OOMKilled: true,
      },
      code: "app_memory_limit",
      detail: "memory limit",
    },
  ])(
    "retains a safe actionable health failure for $code and cleans resources",
    async ({ output, state, code, detail }) => {
      const f = fixture();
      f.fail(output, state);
      await expect(
        f.api.start({ jobId: "job-health", target }),
      ).rejects.toMatchObject({
        code,
        message: expect.stringContaining(detail),
      });
      expect(f.containers.size).toBe(0);
      expect(f.networks.size).toBe(0);
    },
  );
  it("does not expose raw app or Docker output in a health failure", async () => {
    const f = fixture();
    f.fail('{"status":"SECRET","errorCode":"SECRET","body":"SECRET"}');
    const error = await f.api
      .start({ jobId: "job-health", target })
      .catch((error) => error);
    expect(error.message).not.toContain("SECRET");
    expect(error.message).toContain("No agent was started");
    expect(f.calls.some((call) => call.args[0] === "logs")).toBe(false);
  });
  it("cleans on failed browser authentication callback", async () => {
    const f = fixture();
    await expect(
      f.api.smoke({ jobId: "job-test", target }, async () => {
        throw new Error("Login failed");
      }),
    ).rejects.toThrow("Login failed");
    expect(f.containers.size).toBe(0);
    expect(f.networks.size).toBe(0);
  });
  it("keeps app secrets out of arguments and generates isolated database credentials", async () => {
    const f = fixture();
    await f.api.start({
      jobId: "job-test",
      target: {
        ...target,
        env: { APP_KEY: "TEST_APP_KEY" },
        services: [
          { kind: "postgres", name: "db", env: "DATABASE_URL" },
          { kind: "redis", name: "cache", env: "REDIS_URL" },
        ],
        migrate: ["npm", "run", "migrate"],
        seed: ["npm", "run", "seed"],
      },
      env: { APP_KEY: "private-fixture" },
    });
    const app = f.calls.find((c) =>
      c.args.includes("gremlins-app-job-test-app"),
    )!;
    expect(app.options?.env?.DATABASE_URL).toMatch(
      /^postgresql:\/\/gremlins:[a-f0-9]{48}@db:5432\/gremlins$/,
    );
    expect(app.options?.env?.REDIS_URL).toBe("redis://cache:6379");
    expect(f.calls.map((c) => c.args.join(" ")).join("\n")).not.toContain(
      "private-fixture",
    );
    expect(
      f.calls.filter(
        (c) =>
          c.args[0] === "run" &&
          c.args.includes("--entrypoint") &&
          c.args.includes("npm"),
      ),
    ).toHaveLength(2);
    await f.api.cleanup("job-test");
    expect(f.containers.size).toBe(0);
  });
  it("does not touch Docker when input names or source pin are invalid", async () => {
    const f = fixture();
    await expect(
      f.api.start({
        jobId: "job-test",
        target: { ...target, env: { APP_KEY: "TEST_APP_KEY" } },
        env: { OTHER: "secret" },
      }),
    ).rejects.toThrow("every named");
    await expect(
      f.api.start({
        jobId: "job-test",
        target: {
          ...target,
          recipe: {
            kind: "dockerfile",
            context: ".",
            dockerfile: "Dockerfile",
          },
        },
      }),
    ).rejects.toThrow("pinned");
    expect(f.calls).toHaveLength(0);
  });
  it("recovers orphan networks after restart without touching active jobs", async () => {
    const f = fixture();
    await f.api.start({ jobId: "job-a", target });
    await f.api.start({ jobId: "job-b", target });
    await f.api.reconcile(["job-b"]);
    expect([...f.networks.keys()]).toEqual(["gremlins-app-job-b-net"]);
    expect([...f.containers.keys()]).toEqual(["gremlins-app-job-b-app"]);
  });
  it("refuses forged resource ownership instead of broadly deleting by name", async () => {
    const f = fixture();
    await f.api.start({ jobId: "job-a", target });
    f.containers.get("gremlins-app-job-a-app")!["io.shipgremlins.managed"] =
      "false";
    await expect(f.api.cleanup("job-a")).rejects.toThrow("another application");
    expect(f.containers.size).toBe(1);
    expect(f.networks.size).toBe(1);
  });
  it("recovers an image-only interrupted cleanup and preserves active or foreign images", async () => {
    const f = fixture();
    const build = async (jobId: string) =>
      f.api.start({
        jobId,
        target: {
          ...target,
          recipe: {
            kind: "dockerfile",
            context: ".",
            dockerfile: "Dockerfile",
          },
        },
        source: {
          repoUrl: "https://github.com/owner/app.git",
          provider: "github",
          commitSha: "b".repeat(40),
          token: "",
        },
      });
    await build("job-orphan");
    await build("job-active");
    const orphanTag = [...f.builds].find(
      ([, labels]) => labels["io.shipgremlins.job"] === "job-orphan",
    )![0];
    // Simulate controller death after the app and its network were removed.
    f.networks.delete("gremlins-app-job-orphan-net");
    f.containers.delete("gremlins-app-job-orphan-app");
    await f.api.reconcile(["job-active"]);
    expect(f.builds.has(orphanTag)).toBe(false);
    expect(f.builds.size).toBe(1);
    expect(f.networks.has("gremlins-app-job-active-net")).toBe(true);
    const [activeTag, labels] = [...f.builds][0]!;
    labels["io.shipgremlins.managed"] = "false";
    await expect(f.api.cleanup("job-active")).rejects.toThrow(
      "another application",
    );
    expect(f.builds.has(activeTag)).toBe(true);
    expect(f.networks.has("gremlins-app-job-active-net")).toBe(true);
  });
});
