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
} from "../projectOnboarding/index.ts";
import type { SourceControl } from "../sourceControl/types.ts";

interface SetupResponse extends OnboardingState {
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
async function fixture(extra: DashboardOptions = {}) {
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
  });
  const runners = createLocalRunners({ root, packageRoot });
  vi.spyOn(runners, "start").mockImplementation(() => {});
  let testing = false;
  const environmentAccess = {
    status: vi.fn(() => ({
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
