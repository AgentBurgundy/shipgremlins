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
import { fileURLToPath } from "node:url";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createDashboardServer, type DashboardOptions } from "./dashboard.ts";
import { initializeSetup } from "../setup/files.ts";
import { createLocalRunners } from "../localRunners/engine.ts";
import {
  createProjectOnboarding,
  type OnboardingState,
  type ProjectOnboardingOptions,
} from "../projectOnboarding/index.ts";
import { createOnboardingStore } from "../projectOnboarding/store.ts";
import { validateSetupAnalysis } from "../projectOnboarding/analysis.ts";
import type { SourceControl } from "../sourceControl/types.ts";
import { VercelSetupError } from "../vercelSetup/types.ts";
import { saveConnections } from "../setup/connections.ts";
import type { EnvironmentVerification } from "../setup/environmentAccess.ts";

interface SetupResponse extends OnboardingState {
  previewAccess?: { status: string; message: string };
  environment: null | {
    name: string;
    profile: string;
    target: unknown;
    verification: { status: string };
  };
}
const roots: string[] = [],
  servers: Server[] = [];
const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
const headers = {
  authorization: `Bearer ${"b".repeat(64)}`,
  "content-type": "application/json",
};
afterEach(async () => {
  for (const server of servers.splice(0))
    await new Promise<void>((done) => server.close(() => done()));
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});
async function fixture(
  extra: DashboardOptions = {},
  setupOptions: Partial<ProjectOnboardingOptions> = {},
) {
  const root = mkdtempSync(
    join(realpathSync(tmpdir()), "gremlins-onboarding-api-"),
  );
  roots.push(root);
  initializeSetup(root, packageRoot, {
    project: "app",
    repo: "owner/app",
    createInitialPm: false,
    settings: {
      workflow: { kind: "pull-request", baseBranch: "main" },
      verification: { mode: "repository" },
    },
  });
  const source = {
    status: async () => [],
    resolveCredential: vi.fn(async () => {
      throw new Error("Do not request a source token for manual setup.");
    }),
  } as unknown as SourceControl;
  const onboarding = createProjectOnboarding({
    root,
    packageRoot,
    sourceControl: source,
    env: {},
    ...setupOptions,
  });
  const runners = createLocalRunners({ root, packageRoot });
  vi.spyOn(runners, "start").mockImplementation(() => {});
  let testing = false;
  const environmentAccess = {
    status: vi.fn<() => EnvironmentVerification>(() => ({
      status: testing ? ("testing" as const) : ("untested" as const),
      message: "Synthetic probe state.",
    })),
    verify: vi.fn(async () => {
      testing = true;
      return {
        status: "testing" as const,
        message: "Synthetic browser test started.",
      };
    }),
    busy: vi.fn(() => testing),
    idle: async () => {},
    close: async () => {},
    screenshot: vi.fn(() => Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
  };
  const server = createDashboardServer(root, packageRoot, "b".repeat(64), [], {
    runners,
    sourceControl: source,
    projectOnboarding: onboarding,
    environmentAccess,
    ...extra,
  });
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = (
    path: string,
    input?: unknown,
    auth = true,
    method = input === undefined ? "GET" : "POST",
  ) =>
    fetch(url + path, {
      method,
      headers: auth ? headers : { "content-type": "application/json" },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }),
    });
  const state = async () => {
    const response = await call("/api/projects/app/onboarding");
    expect(response.status).toBe(200);
    return response.json() as Promise<SetupResponse>;
  };
  return {
    root,
    source,
    onboarding,
    runners,
    environmentAccess,
    call,
    state,
    projectFile: join(root, "projects/app/project.json"),
  };
}
const target = {
  kind: "url",
  role: "staging",
  url: "https://staging.example.test/",
};

describe("authenticated project onboarding", () => {
  it("starts automatic environment setup only through authenticated bounded POST input and returns its progress", async () => {
    let preparing = false;
    const environmentSetup = {
      status: vi.fn(() =>
        preparing
          ? {
              status: "preparing" as const,
              step: "find_preview" as const,
              message: "Finding the app preview…",
              configurationRevision: "a".repeat(64),
              updatedAt: "2026-10-06T00:00:00.000Z",
            }
          : undefined,
      ),
      prepare: vi.fn(async () => {
        preparing = true;
      }),
      busy: vi.fn(() => preparing),
      idle: async () => {},
      close: async () => {},
    } as unknown as NonNullable<DashboardOptions["environmentSetup"]>;
    const f = await fixture({ environmentSetup });
    const initial = await f.state();
    expect(environmentSetup.prepare).not.toHaveBeenCalled();
    const path = "/api/projects/app/onboarding/prepare-environment";
    const input = {
      configurationRevision: initial.configurationRevision,
      force: true,
    };
    expect((await f.call(path, input, false)).status).toBe(401);
    expect((await f.call(path)).status).toBe(405);
    expect((await f.call(path + "?token=no", input)).status).toBe(400);
    expect(
      (await f.call(path, { ...input, token: "private-value" })).status,
    ).toBe(400);
    expect((await f.call(path, { ...input, repair: true })).status).toBe(400);
    expect((await f.call(path, { ...input, force: "yes" })).status).toBe(400);
    expect((await f.call(path, {})).status).toBe(400);
    const response = await f.call(path, input);
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({
      environmentSetupSupported: true,
      environmentSetup: { status: "preparing", step: "find_preview" },
    });
    expect(environmentSetup.prepare).toHaveBeenCalledExactlyOnceWith(
      "app",
      input,
    );
    expect((await f.call("/api/updates/apply", {})).status).toBe(409);
    expect((await f.call("/api/connections", {})).status).toBe(409);
    expect(
      (
        await f.call("/api/projects/app/onboarding/configure", {
          configurationRevision: initial.configurationRevision,
          profile: "hosted",
          target,
        })
      ).status,
    ).toBe(409);
  });
  it("reports actual saved preview credentials and current browser evidence after refresh without exposing secrets", async () => {
    const f = await fixture();
    const config = JSON.parse(readFileSync(f.projectFile, "utf8"));
    config.verification = { mode: "browser", environment: "preview" };
    config.environments = {
      preview: {
        kind: "vercel",
        role: "preview",
        projectId: "prj_test",
        branch: "pm-staging",
      },
    };
    writeFileSync(f.projectFile, JSON.stringify(config));
    expect((await f.state()).previewAccess?.status).toBe("unchecked");
    config.environments.preview.bypassSecret = "VERCEL_BYPASS_TEST";
    writeFileSync(f.projectFile, JSON.stringify(config));
    const missing = await f.state();
    expect(missing.previewAccess).toMatchObject({
      status: "missing",
      message: expect.stringContaining("value is missing"),
    });
    saveConnections(f.root, {
      VERCEL_BYPASS_TEST: "private-automation-bypass",
    });
    const saved = await f.state();
    expect(saved.previewAccess?.status).toBe("saved");
    expect(JSON.stringify(saved)).not.toContain("private-automation-bypass");
    f.environmentAccess.status.mockReturnValue({
      status: "passed",
      message: "Browser access verified.",
      checks: [{ name: "Browser opens application", passed: true }],
    });
    expect((await f.state()).previewAccess?.status).toBe("verified");
    f.environmentAccess.status.mockReturnValue({
      status: "untested",
      message: "Settings changed.",
    });
    expect((await f.state()).previewAccess?.status).toBe("saved");
    config.environments.preview = target;
    writeFileSync(f.projectFile, JSON.stringify(config));
    expect((await f.state()).previewAccess).toBeUndefined();
  });

  it("connects access only for the saved Vercel environment through an authenticated revision-bound action", async () => {
    const vercelAccess = {
      connect: vi.fn(async () => ({
        status: "connected" as const,
        message: "Preview access connected. Test the environment next.",
      })),
      busy: vi.fn(() => false),
      close: async () => {},
    } as unknown as NonNullable<DashboardOptions["vercelAccess"]>;
    const f = await fixture({ vercelAccess });
    const path = "/api/projects/app/onboarding/vercel/access";
    const initial = await f.state();
    const input = { configurationRevision: initial.configurationRevision };
    expect((await f.call(path, input, false)).status).toBe(401);
    expect((await f.call(path)).status).toBe(405);
    expect((await f.call(path + "?token=no", input)).status).toBe(400);
    expect((await f.call(path, {})).status).toBe(400);
    expect((await f.call(path, { configurationRevision: "old" })).status).toBe(
      400,
    );
    expect((await f.call(path, { ...input, token: "raw-value" })).status).toBe(
      400,
    );
    expect((await f.call(path, { ...input, projectId: "other" })).status).toBe(
      400,
    );
    expect((await f.call(path, input)).status).toBe(400);
    expect(vercelAccess.connect).not.toHaveBeenCalled();
    const configured = await f.call("/api/projects/app/onboarding/configure", {
      ...input,
      profile: "hosted",
      environment: "preview",
      target: {
        kind: "vercel",
        role: "preview",
        projectId: "prj_test",
        connectionId: "default",
        teamId: "team_test",
        branch: "pm-staging",
      },
    });
    expect(configured.status).toBe(200);
    const current = await f.state();
    const savedInput = { configurationRevision: current.configurationRevision };
    const response = await f.call(path, savedInput);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      project: "app",
      environment: { name: "preview", target: { projectId: "prj_test" } },
      previewAccess: { status: "connected" },
    });
    expect(vercelAccess.connect).toHaveBeenCalledWith("app", savedInput);
    expect(f.environmentAccess.verify).not.toHaveBeenCalled();
    expect(await f.runners.jobs()).toEqual([]);
    let release!: () => void;
    let entered!: () => void;
    const waiting = new Promise<void>((done) => {
      release = done;
    });
    const started = new Promise<void>((done) => {
      entered = done;
    });
    vi.mocked(vercelAccess.connect).mockImplementationOnce(async () => {
      entered();
      await waiting;
      return { status: "connected", message: "Preview access connected." };
    });
    const pending = f.call(path, savedInput);
    await started;
    try {
      for (const route of [
        "/api/connections",
        "/api/vercel/connect",
        "/api/vercel/complete",
        "/api/service-connections",
      ]) {
        expect((await f.call(route, {})).status).toBe(409);
      }
      expect((await f.call("/api/vercel", {}, true, "DELETE")).status).toBe(
        409,
      );
      expect((await f.call(path, savedInput)).status).toBe(409);
    } finally {
      release();
    }
    expect((await pending).status).toBe(200);
    vi.mocked(vercelAccess.connect).mockRejectedValueOnce(
      new VercelSetupError(
        "Reconnect Vercel with access to deployment protection.",
        403,
      ),
    );
    const denied = await f.call(path, savedInput);
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({
      error: "Reconnect Vercel with access to deployment protection.",
    });
    vi.mocked(vercelAccess.busy).mockReturnValue(true);
    expect((await f.call(path, savedInput)).status).toBe(409);
    expect(
      (await f.call("/api/projects/app/onboarding/verify", {})).status,
    ).toBe(409);
    expect(
      (await f.call("/api/projects/app/onboarding/discover", {})).status,
    ).toBe(409);
    expect(f.environmentAccess.verify).not.toHaveBeenCalled();
  });
  it("authenticates reviewed command confirmation and returns durable setup state without adopting or running", async () => {
    const sha = "a".repeat(40),
      fetcher = vi.fn(
        async () => new Response(JSON.stringify({ sha }), { status: 200 }),
      );
    const f = await fixture({}, { fetch: fetcher });
    vi.mocked(f.source.resolveCredential).mockResolvedValue({
      token: "read-only-fixture",
      method: "oauth",
    });
    const path = "/api/projects/app/onboarding/confirm",
      current = await f.state();
    const report = validateSetupAnalysis(
      {
        summary: "Inspected unit test script.",
        recommendation: "hosted",
        rationale:
          "Existing source defines tests; no environment was verified.",
        stack: [],
        missingInputs: [],
        hosted: { provider: "url", instructions: [] },
        docker: null,
        proposedFiles: [],
        warnings: [],
        projectSetup: {
          commands: {
            test: {
              command: "npm run test:unit",
              rationale: "Existing package script.",
              evidence: [
                { path: "package.json", quote: '"test:unit":"vitest"' },
              ],
            },
          },
          firstPm: {
            name: "App investigator",
            mandate:
              "Understand actual application behavior before proposing changes.",
            evidence: [{ path: "package.json", quote: '"test:unit":"vitest"' }],
          },
        },
      },
      {
        repository: {
          provider: "github",
          repo: "owner/app",
          branch: "main",
          sha,
          filesRead: ["package.json"],
          truncated: false,
        },
        files: [
          {
            path: "package.json",
            content: '{"scripts":{"test:unit":"vitest"}}',
          },
        ],
        paths: ["package.json"],
      },
      [],
    );
    await createOnboardingStore(f.root).change("app", () => ({
      state: {
        schema: 1,
        project: "app",
        configurationRevision: current.configurationRevision,
        status: "analyzed",
        stage: "review-report",
        message: "Review",
        updatedAt: new Date().toISOString(),
        report,
      },
      result: undefined,
    }));
    const reviewed = await f.state(),
      input = {
        revision: reviewed.revision,
        configurationRevision: reviewed.configurationRevision,
        repositorySha: sha,
        commandKeys: ["test"],
      };
    expect((await f.call(path, input, false)).status).toBe(401);
    expect(
      (await f.call(path, { ...input, commands: { test: "unreviewed" } }))
        .status,
    ).toBe(400);
    expect(fetcher).not.toHaveBeenCalled();
    const response = await f.call(path, input);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      stale: false,
      setupConfirmation: { confirmed: true, commandKeys: ["test"] },
    });
    expect(JSON.parse(readFileSync(f.projectFile, "utf8")).commands.test).toBe(
      "npm run test:unit",
    );
    expect(
      JSON.parse(readFileSync(join(f.root, "projects/app/areas.json"), "utf8"))
        .areas,
    ).toEqual({});
    expect(await f.runners.jobs()).toEqual([]);
    expect(f.environmentAccess.verify).not.toHaveBeenCalled();
    expect((await f.call(path, input)).status).toBe(200);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("protects Vercel setup actions, binds review revisions, and routes chat without deploying", async () => {
    const status = {
      project: "app",
      revision: "r1",
      configurationRevision: "c1",
      status: "idle",
      message: "Find previews",
      updatedAt: new Date().toISOString(),
      stale: false,
    };
    const vercelSetup = {
      status: vi.fn(async () => status),
      discover: vi.fn(async () => status),
      prepare: vi.fn(async () => status),
      deploy: vi.fn(async () => status),
      busy: () => false,
      idle: async () => {},
      close: async () => {},
    } as unknown as NonNullable<DashboardOptions["vercelSetup"]>;
    const environmentGuide = {
      ask: vi.fn(async () => ({ answer: "Choose a preview." })),
      busy: () => false,
      close: async () => {},
    };
    const f = await fixture({ vercelSetup, environmentGuide });
    const path = "/api/projects/app/onboarding/vercel";
    expect((await f.call(path, undefined, false)).status).toBe(401);
    expect(
      (
        await f.call(
          path + "/deploy",
          { revision: "r1", confirmTestData: true },
          false,
        )
      ).status,
    ).toBe(401);
    expect((await f.call(path + "?token=no")).status).toBe(400);
    expect((await f.call(path + "/deploy", { revision: "r1" })).status).toBe(
      400,
    );
    expect(
      (
        await f.call(path + "/deploy", {
          revision: "r1",
          confirmTestData: true,
          target: "production",
        })
      ).status,
    ).toBe(400);
    expect(
      (await f.call(path + "/prepare", { branch: "pm-staging" })).status,
    ).toBe(400);
    expect(
      (await f.call(path + "/discover", { connectionId: "does-not-exist" }))
        .status,
    ).toBe(409);
    expect(vercelSetup.discover).not.toHaveBeenCalled();
    expect(
      (
        await f.call(path + "/discover", {
          connectionId: "default",
          teamId: "team_test",
        })
      ).status,
    ).toBe(200);
    expect(vercelSetup.discover).toHaveBeenCalledWith("app", {
      connectionId: "default",
      teamId: "team_test",
    });
    expect(
      (
        await f.call(path + "/chat", {
          message: "Can this preview use my test database?",
        })
      ).status,
    ).toBe(200);
    expect(environmentGuide.ask).toHaveBeenCalledWith(
      "app",
      "Can this preview use my test database?",
    );
    expect(vercelSetup.deploy).not.toHaveBeenCalled();
    expect(
      (
        await f.call(path + "/deploy", {
          revision: "r1",
          confirmTestData: true,
        })
      ).status,
    ).toBe(200);
    expect(vercelSetup.deploy).toHaveBeenCalledWith("app", {
      revision: "r1",
      confirmTestData: true,
    });
  });
  it("requires authorization for reports, actions and screenshots", async () => {
    const f = await fixture();
    for (const path of ["", "/screenshot"])
      expect(
        (await f.call(`/api/projects/app/onboarding${path}`, undefined, false))
          .status,
      ).toBe(401);
    expect(
      (await f.call("/api/projects/app/onboarding/discover", {}, false)).status,
    ).toBe(401);
    expect((await f.call("/api/projects/missing/onboarding")).status).toBe(404);
    expect(
      (await f.call("/api/projects/app/onboarding?extra=true")).status,
    ).toBe(400);
    expect(f.source.resolveCredential).not.toHaveBeenCalled();
  });
  it("saves an explicit existing URL with CAS while preserving unrelated config and no provider requirements", async () => {
    const f = await fixture();
    const raw = JSON.parse(readFileSync(f.projectFile, "utf8"));
    raw.description = "preserve owner context";
    raw.verified = new Date().toISOString();
    writeFileSync(f.projectFile, JSON.stringify(raw));
    const state = await f.state();
    expect(state.environment).toBeNull();
    const response = await f.call("/api/projects/app/onboarding/configure", {
      configurationRevision: state.configurationRevision,
      profile: "hosted",
      target,
    });
    expect(response.status).toBe(200);
    const result = (await response.json()) as SetupResponse;
    expect(result.environment).toMatchObject({
      name: "pm-test",
      profile: "hosted",
      target,
      verification: { status: "untested" },
    });
    const saved = JSON.parse(readFileSync(f.projectFile, "utf8"));
    expect(saved.description).toBe("preserve owner context");
    expect(saved.verified).toBeNull();
    expect(saved.verification).toEqual({
      mode: "browser",
      environment: "pm-test",
    });
    expect(
      (
        await f.call("/api/projects/app/onboarding/configure", {
          configurationRevision: state.configurationRevision,
          profile: "hosted",
          target,
        })
      ).status,
    ).toBe(409);
    expect(f.source.resolveCredential).not.toHaveBeenCalled();
    expect(
      JSON.parse(readFileSync(join(f.root, "projects/app/areas.json"), "utf8"))
        .areas,
    ).toEqual({});
  });
  it("validates profile and production boundaries without modifying saved config", async () => {
    const f = await fixture(),
      state = await f.state(),
      before = readFileSync(f.projectFile, "utf8");
    for (const body of [
      { profile: "docker", target },
      { profile: "hosted", target: { ...target, role: "production" } },
      {
        profile: "hosted",
        target: { ...target, url: "https://user:password@example.test" },
      },
      { profile: "hosted", environment: "../another" },
      { profile: "hosted", environment: "missing" },
    ])
      expect(
        (
          await f.call("/api/projects/app/onboarding/configure", {
            configurationRevision: state.configurationRevision,
            ...body,
          })
        ).status,
      ).toBe(400);
    expect(readFileSync(f.projectFile, "utf8")).toBe(before);
  });
  it("starts verification independently and blocks conflicting saves, delete and updates while the test runs", async () => {
    const f = await fixture(),
      state = await f.state();
    const configured = (await (
      await f.call("/api/projects/app/onboarding/configure", {
        configurationRevision: state.configurationRevision,
        profile: "hosted",
        target,
      })
    ).json()) as SetupResponse;
    const result = await f.call("/api/projects/app/onboarding/verify", {});
    expect(result.status).toBe(202);
    expect(
      ((await result.json()) as SetupResponse).environment!.verification.status,
    ).toBe("testing");
    expect(f.environmentAccess.verify).toHaveBeenCalledWith("app");
    expect(
      (
        await f.call("/api/projects/app/onboarding/configure", {
          configurationRevision: configured.configurationRevision,
          profile: "hosted",
          target,
        })
      ).status,
    ).toBe(409);
    expect((await f.call("/api/updates/apply", {})).status).toBe(409);
    const deletion = (await (
      await f.call("/api/projects/app/deletion")
    ).json()) as { blockers: string[] };
    expect(deletion.blockers.join(" ")).toMatch(/environment test/);
    const image = await f.call("/api/projects/app/onboarding/screenshot");
    expect(image.status).toBe(200);
    expect(image.headers.get("content-type")).toBe("image/png");
  });
  it("returns actionable analysis prerequisites and requires explicit reviewed publication revision", async () => {
    const f = await fixture();
    const response = await f.call("/api/projects/app/onboarding/discover", {});
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toMatch(
      /Connect Claude/,
    );
    expect(
      (await f.call("/api/projects/app/onboarding/setup-pr", {})).status,
    ).toBe(400);
    expect(
      (await f.call("/api/projects/app/onboarding/cancel", {})).status,
    ).toBe(409);
    expect(f.source.resolveCredential).not.toHaveBeenCalled();
  });
  it("adds an onboarding project without an initial PM or Linear provisioning and does not fail if Claude is missing", async () => {
    const f = await fixture();
    const response = await f.call("/api/projects", {
      project: "new-app",
      repo: "owner/new-app",
      onboarding: true,
    });
    expect(response.status).toBe(200);
    const result = (await response.json()) as {
      linear: { status: string };
      onboarding: OnboardingState;
    };
    expect(result.linear.status).toBe("skipped");
    expect(result.onboarding.status).toBe("idle");
    expect(
      JSON.parse(
        readFileSync(join(f.root, "projects/new-app/areas.json"), "utf8"),
      ).areas,
    ).toEqual({});
    const discover = vi.spyOn(f.onboarding, "discover");
    expect(
      (
        await f.call("/api/projects", {
          project: "new-app",
          repo: "owner/new-app",
          onboarding: true,
        })
      ).status,
    ).toBe(200);
    expect(discover).not.toHaveBeenCalled();
  });
});
