import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  rmSync,
  realpathSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { initializeSetup } from "./files.ts";
import { createEnvironmentAccess } from "./environmentAccess.ts";
import {
  saveConnections,
  readConnections,
  projectConnections,
} from "./connections.ts";
import { parseTestAccess } from "../testAccess.ts";
import { assertBrowserSecretSafety } from "./credentialScope.ts";
import { loadProject } from "../config.ts";
import type { DockerRunners } from "../localRunners/docker.ts";
import { ManagedAccessError } from "../localRunners/managedAccess.ts";
import type { PlannerDockerRun } from "../pmPlanner/docker.ts";
import { TestEnvironmentError } from "../testEnvironments/index.ts";

let root: string;
const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
const access = {
  kind: "password" as const,
  loginPath: "/login",
  usernameSelector: "#email",
  passwordSelector: "#password",
  submitSelector: "button",
  successSelector: "#home",
  accounts: [
    {
      name: "Member",
      usernameSecret: "TEST_MEMBER_EMAIL",
      passwordSecret: "TEST_MEMBER_PASSWORD",
    },
  ],
};
function config(target: unknown) {
  const path = join(root, "projects/app/project.json"),
    value = JSON.parse(readFileSync(path, "utf8"));
  value.environments = { test: target };
  value.verification = { mode: "browser", environment: "test" };
  delete value.vercel;
  writeFileSync(path, JSON.stringify(value));
}
beforeEach(() => {
  root = mkdtempSync(
    join(realpathSync(tmpdir()), "gremlins-environment-test-"),
  );
  initializeSetup(root, packageRoot, {
    project: "app",
    repo: "owner/app",
    createInitialPm: false,
  });
  config({ kind: "url", role: "staging", url: "http://app.test:3000", access });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
function harness(
  failure = false,
  probeOutput?: unknown,
  cleanupFailure = false,
) {
  let job = "";
  const run = vi.fn<PlannerDockerRun>(async (args) => {
    if (args[0] === "create")
      job = args[args.indexOf("--label") + 1]!.split("=")[1]!;
    if (args[0] === "inspect") return { code: 0, stdout: job, stderr: "" };
    if (args[0] === "start")
      return {
        code: failure ? 1 : 0,
        stdout: JSON.stringify(
          probeOutput ??
            (failure
              ? { ok: false, stage: "login" }
              : {
                  ok: true,
                  checks: [{ name: "Browser opens application", passed: true }],
                  screenshot: Buffer.from([
                    137, 80, 78, 71, 13, 10, 26, 10, 0,
                  ]).toString("base64"),
                }),
        ),
        stderr: "",
      };
    return {
      code: args[0] === "rm" && cleanupFailure ? 1 : 0,
      stdout: "",
      stderr: "",
    };
  });
  const docker = {
    ensureImage: vi.fn(async () => "shipgremlins-local:0123456789abcdef"),
    smokeEnvironment: vi.fn(async (input, verify) => {
      const environment = {
        url: "http://app.test:3000",
        network: "private-network",
        imageId: "sha256:" + "a".repeat(64),
        health: { ready: true as const, status: 200 },
      };
      await verify?.(environment);
      return environment;
    }),
  } as unknown as DockerRunners;
  const sourceControl = {
    acquireLease: vi.fn(),
    releaseLease: vi.fn(async () => {}),
  };
  return {
    run,
    docker,
    sourceControl,
    service: createEnvironmentAccess({
      root,
      packageRoot,
      env: {},
      run,
      docker,
      sourceControl,
    }),
  };
}
describe("project environment onboarding", () => {
  it("starts source-only without a phantom PM or Linear mapping", () => {
    const project = loadProject(root, "app");
    expect(project.areas).toEqual([]);
    expect(existsSync(join(project.dir, "core/mandate.md"))).toBe(false);
  });
  it("saves named test accounts and app inputs with spaces and punctuation without altering other credentials", () => {
    config({
      kind: "docker",
      role: "staging",
      recipe: { kind: "image", image: "test/app:1" },
      port: 3000,
      access,
      env: { APP_SECRET: "TEST_APP_SECRET" },
    });
    const inputs = {
      TEST_MEMBER_EMAIL: "member@example.test",
      TEST_MEMBER_PASSWORD: " pass'word # with space ",
      TEST_APP_SECRET: "key\\path$()",
      GITHUB_TOKEN: "source-token",
    };
    saveConnections(root, inputs);
    expect(readConnections(root)).toMatchObject(inputs);
    expect(
      projectConnections(root).find(
        (item) => item.name === "TEST_MEMBER_PASSWORD",
      )?.provider,
    ).toBe("app");
    expect(JSON.stringify(projectConnections(root))).not.toContain(
      inputs.TEST_MEMBER_PASSWORD,
    );
  });
  it("never infers verification from analysis or configuration and rejects missing credentials before Docker", async () => {
    const { service, run } = harness();
    expect(service.status("app").status).toBe("untested");
    await service.verify("app");
    await service.idle();
    expect(service.status("app")).toMatchObject({
      status: "failed",
      checkedAt: expect.any(String),
      checks: [],
      diagnosis: {
        code: "account_credentials_missing",
        action: "manage_credentials",
      },
    });
    expect(run).not.toHaveBeenCalled();
  });
  it("persists a missing preview credential before provider calls or Docker", async () => {
    config({
      kind: "vercel",
      role: "preview",
      projectId: "prj_test",
      bypassSecret: "TEST_PREVIEW_ACCESS",
    });
    const { service, run, docker } = harness();
    await service.verify("app");
    await service.idle();
    expect(service.status("app")).toMatchObject({
      status: "failed",
      checkedAt: expect.any(String),
      checks: [],
      diagnosis: {
        code: "preview_credential_missing",
        action: "connect_preview",
      },
    });
    expect(run).not.toHaveBeenCalled();
    expect(docker.ensureImage).not.toHaveBeenCalled();
    expect(JSON.stringify(service.status("app"))).not.toContain(
      "TEST_PREVIEW_ACCESS",
    );
  });
  it("keeps passed stages and selector counts from a failed browser check without reflecting page text", async () => {
    config({ kind: "url", role: "staging", url: "https://app.test" });
    const checks = [
      { name: "Browser opens application", passed: true },
      { name: "Test account 1: login page opens", passed: true },
      { name: "Test account 1: username field", passed: false },
    ];
    const { service } = harness(true, {
      ok: false,
      checks,
      diagnosis: {
        code: "selector_ambiguous",
        field: "usernameSelector",
        matchCount: 3,
        detail: "private-password",
        title: "https://app.test/?secret=private",
        action: "retry",
      },
    });
    await service.verify("app");
    await service.idle();
    expect(service.status("app")).toMatchObject({
      status: "failed",
      checks,
      checkedAt: expect.any(String),
      diagnosis: {
        code: "selector_ambiguous",
        field: "usernameSelector",
        matchCount: 3,
        action: "edit_login",
      },
    });
    expect(JSON.stringify(service.status("app"))).not.toContain("private");
    expect(() => service.screenshot("app")).toThrow("Test this environment");
  });
  it.each([false, true])(
    "guides Vercel protection recovery with a saved bypass=%s",
    async (hasBypass) => {
      const bypass = "private-rejected-preview-value";
      config({
        kind: "vercel",
        role: "preview",
        projectId: "prj_test",
        branch: "main",
        ...(hasBypass ? { bypassSecret: "TEST_PREVIEW_ACCESS" } : {}),
      });
      if (hasBypass) saveConnections(root, { TEST_PREVIEW_ACCESS: bypass });
      const checks = [{ name: "Browser opens application", passed: false }];
      const { run, docker } = harness(true, {
        ok: false,
        checks,
        diagnosis: { code: "vercel_protection" },
      });
      const deployment = {
        id: "dpl_test",
        projectId: "prj_test",
        readyState: "READY",
        meta: { githubCommitRef: "main" },
        url: "app-preview.vercel.app",
      };
      const fetcher = vi.fn<typeof fetch>(async (url, init) => {
        expect(new Headers(init?.headers).get("authorization")).toBe(
          "Bearer private-vercel-token",
        );
        const path = new URL(String(url)).pathname;
        if (path === "/v6/deployments")
          return new Response(JSON.stringify({ deployments: [deployment] }));
        if (path === "/v13/deployments/dpl_test")
          return new Response(JSON.stringify(deployment));
        throw new Error("Unexpected fixture request");
      });
      const service = createEnvironmentAccess({
        root,
        packageRoot,
        env: {},
        run,
        docker,
        fetch: fetcher,
        vercelConnectionFor: () => ({
          resolveCredential: async () => ({
            token: "private-vercel-token",
            authorization: "Bearer private-vercel-token",
            method: "token" as const,
          }),
        }),
      });
      await service.verify("app");
      await service.idle();
      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(service.status("app")).toMatchObject({
        status: "failed",
        checkedAt: expect.any(String),
        checks,
        diagnosis: {
          code: hasBypass ? "preview_credential_rejected" : "vercel_protection",
          action: hasBypass ? "manage_credentials" : "connect_preview",
        },
      });
      const input = JSON.parse(
        run.mock.calls.find(([args]) => args[0] === "start")![1]!.stdin!,
      );
      expect(input).toMatchObject({
        url: "https://app-preview.vercel.app",
        vercel: true,
      });
      expect(input.bypass).toBe(hasBypass ? bypass : undefined);
      const publicEvidence =
        JSON.stringify(service.status("app")) +
        readFileSync(
          join(root, ".run/environment-access/app/state.json"),
          "utf8",
        );
      for (const secret of [
        bypass,
        "private-vercel-token",
        "TEST_PREVIEW_ACCESS",
      ]) {
        expect(publicEvidence).not.toContain(secret);
        expect(
          JSON.stringify(run.mock.calls.map(([args]) => args)),
        ).not.toContain(secret);
      }
      if (hasBypass)
        expect(service.status("app").diagnosis?.detail).toContain(
          "Update the automation bypass credential in Connections",
        );
    },
  );
  it.each([
    {
      ok: false,
      checks: [{ name: "private-password", passed: false }],
      diagnosis: { code: "environment_unreachable" },
    },
    { ok: false, checks: [], diagnosis: { code: "private-password" } },
    {
      ok: false,
      checks: [],
      diagnosis: {
        code: "selector_ambiguous",
        field: "passwordSelector",
        matchCount: 10001,
      },
    },
    null,
  ])("rejects malformed evidence without exposing it", async (output) => {
    config({ kind: "url", role: "staging", url: "https://app.test" });
    const { service } = harness(
      true,
      output === null ? "private-password" : output,
    );
    await service.verify("app");
    await service.idle();
    expect(service.status("app").diagnosis?.code).toBe("invalid_evidence");
    expect(JSON.stringify(service.status("app"))).not.toContain(
      "private-password",
    );
  });
  it("preserves successful checks but fails verification if browser cleanup fails", async () => {
    config({ kind: "url", role: "staging", url: "https://app.test" });
    const { service } = harness(false, undefined, true);
    await service.verify("app");
    await service.idle();
    expect(service.status("app")).toMatchObject({
      status: "failed",
      checks: [{ name: "Browser opens application", passed: true }],
      diagnosis: { code: "cleanup_pending" },
    });
  });
  it("passes credentials only over stdin, records real browser evidence, and invalidates changed environment settings", async () => {
    saveConnections(root, {
      TEST_MEMBER_EMAIL: "test@example.test",
      TEST_MEMBER_PASSWORD: "private-password",
    });
    const { service, run } = harness();
    expect((await service.verify("app")).status).toBe("testing");
    await expect(service.verify("app")).rejects.toThrow("already running");
    await service.idle();
    expect(service.status("app").status).toBe("passed");
    expect(service.screenshot("app").length).toBeGreaterThan(8);
    expect(JSON.stringify(run.mock.calls.map((call) => call[0]))).not.toContain(
      "private-password",
    );
    expect(
      run.mock.calls.find((call) => call[0][0] === "start")?.[1]?.stdin,
    ).toContain("private-password");
    expect(
      readFileSync(
        join(root, ".run/environment-access/app/state.json"),
        "utf8",
      ),
    ).not.toContain("private-password");
    expect(run.mock.calls.some((call) => call[0][0] === "rm")).toBe(true);
    config({ kind: "url", role: "staging", url: "http://another.test:3000" });
    expect(service.status("app").status).toBe("untested");
    expect(() => service.screenshot("app")).toThrow("Test this environment");
  });
  it("keeps failed login unverified and still removes the browser container", async () => {
    saveConnections(root, {
      TEST_MEMBER_EMAIL: "test@example.test",
      TEST_MEMBER_PASSWORD: "wrong-password",
    });
    const { service, run } = harness(true);
    await service.verify("app");
    await service.idle();
    expect(service.status("app")).toMatchObject({
      status: "failed",
      message: expect.stringContaining("could not sign in"),
    });
    expect(run.mock.calls.some((call) => call[0][0] === "rm")).toBe(true);
  });
  it("invalidates previous browser evidence when a referenced test credential changes", async () => {
    saveConnections(root, {
      TEST_MEMBER_EMAIL: "test@example.test",
      TEST_MEMBER_PASSWORD: "original-password",
    });
    const { service } = harness();
    await service.verify("app");
    await service.idle();
    expect(service.status("app").status).toBe("passed");
    saveConnections(root, { TEST_MEMBER_PASSWORD: "replacement-password" });
    expect(service.status("app").status).toBe("untested");
  });
  it("tests Docker on its private network and does not claim a prebuilt image matches a Git SHA", async () => {
    config({
      kind: "docker",
      role: "staging",
      recipe: { kind: "image", image: "test/app:1" },
      port: 3000,
      env: { APP_SECRET: "TEST_APP_SECRET" },
    });
    saveConnections(root, { TEST_APP_SECRET: "private-app-value" });
    const { service, docker, run } = harness();
    await service.verify("app");
    await service.idle();
    expect(docker.smokeEnvironment).toHaveBeenCalledWith(
      expect.objectContaining({ env: { APP_SECRET: "private-app-value" } }),
      expect.any(Function),
    );
    expect(
      run.mock.calls.find((call) => call[0][0] === "create")?.[0],
    ).toContain("private-network");
    expect(service.status("app")).toMatchObject({
      status: "passed",
      message: expect.stringContaining("No signed-in account"),
    });
    expect(service.status("app").commitSha).toBeUndefined();
    expect(JSON.stringify(run.mock.calls)).not.toContain("private-app-value");
  });
  it("identifies missing Docker application inputs before building or opening a browser", async () => {
    config({
      kind: "docker",
      role: "staging",
      recipe: { kind: "image", image: "test/app:1" },
      port: 3000,
      env: { API_KEY: "TEST_API_KEY" },
    });
    const { service, run, docker } = harness();
    await service.verify("app");
    await service.idle();
    expect(service.status("app")).toMatchObject({
      status: "failed",
      diagnosis: { code: "app_inputs_missing", action: "manage_credentials" },
    });
    expect(run).not.toHaveBeenCalled();
    expect(docker.smokeEnvironment).not.toHaveBeenCalled();
  });
  it("resolves build-only credentials separately and invalidates browser evidence when they rotate", async () => {
    config({
      kind: "docker",
      role: "staging",
      recipe: { kind: "dockerfile", dockerfile: "Dockerfile", context: "." },
      port: 3000,
      buildSecrets: { npmrc: "TEST_NPMRC" },
    });
    saveConnections(root, {
      TEST_NPMRC: "//registry.example.test/:_authToken=private-build-value\n",
    });
    const h = harness();
    h.sourceControl.acquireLease.mockResolvedValue({
      token: "private-source-token",
    });
    const service = createEnvironmentAccess({
      root,
      packageRoot,
      env: {},
      docker: h.docker,
      run: h.run,
      sourceControl: h.sourceControl,
      fetch: vi.fn(
        async () => new Response(JSON.stringify({ sha: "a".repeat(40) })),
      ),
    });
    await service.verify("app");
    await service.idle();
    expect(service.status("app").status).toBe("passed");
    expect(h.docker.smokeEnvironment).toHaveBeenCalledWith(
      expect.objectContaining({
        env: {},
        buildSecrets: {
          npmrc: "//registry.example.test/:_authToken=private-build-value\n",
        },
      }),
      expect.any(Function),
    );
    expect(JSON.stringify(h.run.mock.calls)).not.toContain(
      "private-build-value",
    );
    expect(
      projectConnections(root).find((item) => item.name === "TEST_NPMRC"),
    ).toMatchObject({ purpose: "build-secret", optional: false });
    saveConnections(root, { TEST_NPMRC: "replacement-build-value" });
    expect(service.status("app").status).toBe("untested");
  });
  it("rejects a saved opaque provider credential hidden in an ordinary public build argument", async () => {
    config({
      kind: "docker",
      role: "staging",
      recipe: { kind: "dockerfile", dockerfile: "Dockerfile", context: "." },
      port: 3000,
      buildArgs: { VERSION: "opaque-provider-credential" },
    });
    saveConnections(root, { GITHUB_TOKEN: "opaque-provider-credential" });
    const h = harness();
    await h.service.verify("app");
    await h.service.idle();
    expect(h.service.status("app")).toMatchObject({
      status: "failed",
      message: expect.stringContaining(
        "public build argument contains a saved credential",
      ),
    });
    expect(JSON.stringify(h.service.status("app"))).not.toContain(
      "opaque-provider-credential",
    );
    expect(h.sourceControl.acquireLease).not.toHaveBeenCalled();
    expect(h.run).not.toHaveBeenCalled();
  });
  it.each([
    "image_unavailable",
    "build_failed",
    "service_unhealthy",
    "migration_failed",
    "seed_failed",
    "app_unhealthy",
  ])("retains a safe actionable %s diagnosis from Docker", async (code) => {
    config({
      kind: "docker",
      role: "staging",
      recipe: { kind: "image", image: "test/app:1" },
      port: 3000,
    });
    const { service, docker } = harness();
    vi.mocked(docker.smokeEnvironment!).mockRejectedValue(
      new TestEnvironmentError("private container output", code),
    );
    await service.verify("app");
    await service.idle();
    expect(service.status("app")).toMatchObject({
      status: "failed",
      diagnosis: { code, action: "edit_environment" },
    });
    expect(JSON.stringify(service.status("app"))).not.toContain(
      "private container output",
    );
  });
  it("routes missing hosted staging credentials to Connections before the browser starts", async () => {
    config({
      kind: "railway",
      role: "staging",
      projectId: "project",
      serviceId: "service",
      environmentId: "staging",
    });
    const { service, run } = harness();
    await service.verify("app");
    await service.idle();
    expect(service.status("app")).toMatchObject({
      status: "failed",
      diagnosis: { code: "hosting_credentials", action: "manage_credentials" },
    });
    expect(run).not.toHaveBeenCalled();
  });
  it("invalidates successful hosted browser evidence when its selected provider credential rotates", async () => {
    config({
      kind: "railway",
      role: "staging",
      projectId: "project",
      serviceId: "service",
      environmentId: "staging",
    });
    saveConnections(root, { RAILWAY_TOKEN: "original-hosting-token" });
    const h = harness();
    const service = createEnvironmentAccess({
      root,
      packageRoot,
      env: {},
      docker: h.docker,
      run: h.run,
      fetch: vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              data: {
                environments: { edges: [{ node: { id: "staging" } }] },
                service: { id: "service", projectId: "project" },
                serviceInstance: {
                  latestDeployment: {
                    id: "deployment",
                    status: "SUCCESS",
                    meta: {},
                  },
                },
                domains: {
                  serviceDomains: [{ domain: "staging.example.test" }],
                },
              },
            }),
          ),
      ),
    });
    await service.verify("app");
    await service.idle();
    expect(service.status("app").status).toBe("passed");
    saveConnections(root, { RAILWAY_TOKEN: "replacement-hosting-token" });
    expect(service.status("app").status).toBe("untested");
  });
  it("fails readiness if the created browser container's cleanup ownership cannot be verified", async () => {
    config({ kind: "url", role: "staging", url: "https://app.test" });
    const { service, run } = harness();
    const original = run.getMockImplementation()!;
    run.mockImplementation(async (args, options) =>
      args[0] === "inspect"
        ? { code: 1, stdout: "", stderr: "Docker unavailable" }
        : original(args, options),
    );
    await service.verify("app");
    await service.idle();
    expect(service.status("app")).toMatchObject({
      status: "failed",
      diagnosis: { code: "cleanup_pending" },
    });
    expect(run.mock.calls.some(([args]) => args[0] === "rm")).toBe(false);
  });
  it("diagnoses an unavailable browser worker without reflecting Docker output", async () => {
    config({ kind: "url", role: "staging", url: "https://app.test" });
    const { service, docker } = harness();
    vi.mocked(docker.ensureImage).mockRejectedValue(
      new Error("private registry credential"),
    );
    await service.verify("app");
    await service.idle();
    expect(service.status("app")).toMatchObject({
      status: "failed",
      diagnosis: { code: "browser_unavailable" },
    });
    expect(JSON.stringify(service.status("app"))).not.toContain(
      "private registry credential",
    );
  });
  it("can replace malformed saved verification history with a fresh browser check", async () => {
    config({ kind: "url", role: "staging", url: "https://app.test" });
    const { service } = harness();
    await service.verify("app");
    await service.idle();
    const statePath = join(root, ".run/environment-access/app/state.json");
    writeFileSync(statePath, "{invalid");
    expect(service.status("app")).toMatchObject({
      status: "failed",
      message: expect.stringContaining("Retry"),
    });
    await service.verify("app");
    await service.idle();
    expect(service.status("app").status).toBe("passed");
  });
  it("does not expose unsupported stored fields or screenshot URLs", async () => {
    config({ kind: "url", role: "staging", url: "https://app.test" });
    const { service } = harness();
    await service.verify("app");
    await service.idle();
    const statePath = join(root, ".run/environment-access/app/state.json");
    const saved = JSON.parse(readFileSync(statePath, "utf8"));
    writeFileSync(
      statePath,
      JSON.stringify({
        ...saved,
        privateOutput: "private provider credential",
      }),
    );
    expect(service.status("app").status).toBe("passed");
    expect(JSON.stringify(service.status("app"))).not.toContain(
      "private provider credential",
    );
    writeFileSync(
      statePath,
      JSON.stringify({
        ...saved,
        screenshotUrl: "https://unknown.test/?token=private",
      }),
    );
    expect(service.status("app").status).toBe("failed");
    expect(JSON.stringify(service.status("app"))).not.toContain("unknown.test");
    writeFileSync(
      statePath,
      JSON.stringify({
        ...saved,
        checks: [{ name: "Browser opens application", passed: false }],
      }),
    );
    expect(service.status("app").status).toBe("failed");
  });
  it("rejects new environment tests after the controller closes", async () => {
    const { service, run } = harness();
    await service.close();
    await expect(service.verify("app")).rejects.toMatchObject({ status: 503 });
    expect(run).not.toHaveBeenCalled();
  });
  it("rejects controller credential references and cross-project telemetry aliasing", () => {
    expect(() =>
      parseTestAccess({
        ...access,
        accounts: [{ ...access.accounts[0], passwordSecret: "GITHUB_TOKEN" }],
      }),
    ).toThrow();
    initializeSetup(root, packageRoot, {
      project: "second",
      repo: "owner/second",
      createInitialPm: false,
    });
    const path = join(root, "projects/second/project.json"),
      second = JSON.parse(readFileSync(path, "utf8"));
    second.telemetry = {
      sentry: {
        organization: "org",
        project: "project",
        tokenSecret: "TEST_MEMBER_PASSWORD",
      },
    };
    writeFileSync(path, JSON.stringify(second));
    expect(() =>
      assertBrowserSecretSafety(loadProject(root, "app").config, root),
    ).toThrow();
  });
});

describe("verification on configured agent services", () => {
  it.each([
    ["selector_unusable", "login_controls_changed"],
    ["authentication_unproven", "login_unverified"],
    ["credentials_rejected", "login_rejected"],
    ["identity_mismatch", "identity_mismatch"],
    ["storage_redaction_limit", "storage_redaction_limit"],
  ])(
    "turns runner %s into an actionable diagnosis without requiring legacy selector fields",
    async (code, expected) => {
      saveConnections(root, {
        TEST_MEMBER_EMAIL: "private-member",
        TEST_MEMBER_PASSWORD: "private-password",
      });
      const docker = {
        startJob: vi.fn(async () => {
          throw new ManagedAccessError(code, "Untrusted exception details");
        }),
        stopJob: vi.fn(async () => {}),
        cleanupEnvironment: vi.fn(async () => {}),
        removeJob: vi.fn(async () => {}),
      } as unknown as DockerRunners;
      const service = createEnvironmentAccess({
        root,
        packageRoot,
        docker,
        env: {},
        selectRunner: async () => ({ id: "worker-home", name: "Home runner" }),
      });
      await service.verify("app");
      await service.idle();
      expect(service.status("app")).toMatchObject({
        status: "failed",
        diagnosis: {
          code: expected,
          action:
            expected === "storage_redaction_limit"
              ? "edit_environment"
              : "edit_login",
        },
      });
      expect(JSON.stringify(service.status("app"))).not.toContain(
        "Untrusted exception details",
      );
      expect(docker.cleanupEnvironment).toHaveBeenCalledOnce();
    },
  );
  it("reserves a runner, uses its private browser job, and names that runner in readiness", async () => {
    saveConnections(root, {
      TEST_MEMBER_EMAIL: "private-member",
      TEST_MEMBER_PASSWORD: "private-password",
    });
    const release = vi.fn(async () => {}),
      selectRunner = vi.fn(async () => ({
        id: "worker-home",
        name: "Homelab runner",
        release,
      }));
    let payload:
        import("../localRunners/docker.ts").DockerJobPayload | undefined,
      id = "";
    const docker = {
      prepareWorker: vi.fn(async () => {}),
      startJob: vi.fn(async (input) => {
        payload = input.payload;
        id = input.id;
        return { id, name: id, image: "synthetic" };
      }),
      inspectJob: vi.fn(async () => ({
        exists: true,
        running: false,
        status: "exited",
        exitCode: 0,
        workerId: "worker-home",
      })),
      artifacts: vi.fn(async () => ({
        files: [],
        result: {
          ok: true,
          kind: "verify",
          nonce: id,
          accessReceipt: {
            version: 1,
            ...payload!.testAccess,
            origin: "http://app.test:3000",
            proof: {
              signedOut: true,
              signedIn: true,
              protectedRoute: true,
              receivingContext: true,
            },
          },
          checks: [{ name: "Browser opens application", passed: true }],
        },
      })),
      readArtifact: vi.fn(async () =>
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]),
      ),
      stopJob: vi.fn(async () => {}),
      cleanupEnvironment: vi.fn(async () => {}),
      removeJob: vi.fn(async () => {}),
    } as unknown as DockerRunners;
    const service = createEnvironmentAccess({
      root,
      packageRoot,
      docker,
      selectRunner,
      env: {},
    });
    await service.verify("app");
    await service.idle();
    expect(service.status("app")).toMatchObject({
      status: "passed",
      runnerId: "worker-home",
      runnerName: "Homelab runner",
    });
    expect(selectRunner).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
    expect(payload).toMatchObject({
      accessProbe: true,
      project: "app",
      browserTarget: "http://app.test:3000",
      credentials: {
        GREMLINS_TEST_USERNAME_1: "private-member",
        GREMLINS_TEST_PASSWORD_1: "private-password",
      },
    });
  });
  it("retains BuildKit inputs and runner identity when checking Docker through the managed agent service", async () => {
    config({
      kind: "docker",
      role: "staging",
      recipe: { kind: "dockerfile", context: ".", dockerfile: "Dockerfile" },
      port: 3000,
      access: { kind: "public" },
      env: { APP_KEY: "TEST_APP_KEY" },
      buildArgs: { NEXT_PUBLIC_API_URL: "https://staging.example.test" },
      buildSecrets: { npmrc: "TEST_NPMRC" },
    });
    const buildSecret =
      "//registry.example.test/:_authToken=private-managed-build\n";
    saveConnections(root, {
      TEST_APP_KEY: "private-managed-app",
      TEST_NPMRC: buildSecret,
    });
    let payload:
      import("../localRunners/docker.ts").DockerJobPayload | undefined;
    let id = "";
    const release = vi.fn(async () => {});
    const docker = {
      prepareWorker: vi.fn(async () => {}),
      startJob: vi.fn(async (input) => {
        payload = input.payload;
        id = input.id;
        return { id, name: id, image: "synthetic" };
      }),
      inspectJob: vi.fn(async () => ({
        exists: true,
        running: false,
        status: "exited",
        exitCode: 0,
        workerId: "worker-managed",
      })),
      artifacts: vi.fn(async () => ({
        files: [],
        result: {
          ok: true,
          kind: "verify",
          nonce: id,
          accessReceipt: {
            version: 1,
            ...payload!.testAccess,
            origin: "http://app.test:3000",
            proof: { public: true, receivingContext: true },
          },
          checks: [{ name: "Browser opens application", passed: true }],
        },
      })),
      readArtifact: vi.fn(async () =>
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]),
      ),
      stopJob: vi.fn(async () => {}),
      cleanupEnvironment: vi.fn(async () => {}),
      removeJob: vi.fn(async () => {}),
    } as unknown as DockerRunners;
    const sourceControl = {
      acquireLease: vi.fn(async () => ({
        token: "private-managed-source",
        method: "token" as const,
      })),
      releaseLease: vi.fn(async () => {}),
    };
    const service = createEnvironmentAccess({
      root,
      packageRoot,
      docker,
      sourceControl,
      env: {},
      fetch: vi.fn(
        async () => new Response(JSON.stringify({ sha: "a".repeat(40) })),
      ),
      selectRunner: async () => ({
        id: "worker-managed",
        name: "Managed Docker runner",
        release,
      }),
    });
    await service.verify("app");
    await service.idle();
    expect(service.status("app")).toMatchObject({
      status: "passed",
      runnerId: "worker-managed",
      runnerName: "Managed Docker runner",
      commitSha: "a".repeat(40),
    });
    expect(payload).toMatchObject({
      accessProbe: true,
      testEnvironment: {
        env: { APP_KEY: "private-managed-app" },
        buildSecrets: { npmrc: buildSecret },
        target: {
          buildArgs: { NEXT_PUBLIC_API_URL: "https://staging.example.test" },
        },
      },
    });
    expect(JSON.stringify(payload!.credentials)).not.toContain(
      "private-managed-build",
    );
    expect(JSON.stringify(service.status("app"))).not.toMatch(
      /private-managed-(?:build|app|source)/,
    );
    expect(release).toHaveBeenCalledOnce();
    expect(sourceControl.releaseLease).toHaveBeenCalledWith(id);
    expect(docker.cleanupEnvironment).toHaveBeenCalledWith(id);
  });
  it("does not silently fall back to controller Docker when no agent service can be chosen", async () => {
    config({
      kind: "url",
      role: "staging",
      url: "http://app.test:3000",
      access: { kind: "public" },
    });
    const docker = { startJob: vi.fn() } as unknown as DockerRunners;
    const service = createEnvironmentAccess({
      root,
      packageRoot,
      docker,
      env: {},
    });
    await service.verify("app");
    await service.idle();
    expect(service.status("app")).toMatchObject({
      status: "failed",
      message: expect.stringContaining("Set up an agent service"),
    });
    expect(docker.startJob).not.toHaveBeenCalled();
  });
});
