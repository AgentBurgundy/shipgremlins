import { afterEach, describe, expect, it, vi } from "vitest";
import { readConnections } from "../setup/connections.ts";
import { ChildProcess, type spawn } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import {
  createDashboardServer,
  runDashboard,
  openDashboardBrowser,
  lanAddresses,
  type DashboardOptions,
} from "./dashboard.ts";
import type { Updater, UpdateStatus } from "../update/index.ts";
import type { LocalRunners } from "../localRunners/engine.ts";
import type { DockerRunners } from "../localRunners/docker.ts";
import type { createJobPreparation } from "../localRunners/jobs.ts";
import type {
  OAuthConnection,
  OAuthProvider,
} from "../oauthConnection/types.ts";
import { OAuthConnectionError } from "../oauthConnection/types.ts";
import {
  createLinearProvisioning,
  LinearProvisioningError,
} from "../setup/linearProvisioning.ts";
import { initializeSetup } from "../setup/files.ts";
import { LinearApi } from "../services/linear.ts";
import { readEditableConfig } from "../setup/configEditor.ts";
import { PmPlannerError } from "../pmPlanner/index.ts";
import type { ActivityStore, RunActivity } from "../storage/activity.ts";
import {
  SourceControlError,
  type SourceControl,
  type SourceStatus,
} from "../sourceControl/types.ts";

const session = "a".repeat(64);
const directories: string[] = [];
const servers: Server[] = [];
const auth = { Authorization: `Bearer ${session}` };
function oauthFixture(provider: OAuthProvider): OAuthConnection {
  const status = {
    provider,
    available: true,
    connected: true,
    method: "oauth" as const,
    workspace: { id: "workspace", name: "Test workspace" },
  };
  return {
    status: vi.fn(async () => status),
    connect: vi.fn(async () => ({
      url: `https://shipgremlins.ai/api/${provider}/authorize?request=encrypted`,
    })),
    complete: vi.fn(async () => status),
    disconnect: vi.fn(async () => ({
      ...status,
      connected: false,
      method: "none" as const,
    })),
    resolveCredential: vi.fn(async () => ({
      token: "never-public",
      authorization: "Bearer never-public",
      method: "oauth" as const,
    })),
    acquireLease: vi.fn(async () => ({
      token: "never-public",
      authorization: "Bearer never-public",
      method: "oauth" as const,
    })),
    releaseLease: vi.fn(async () => {}),
  };
}
function temporary(): string {
  const directory = mkdtempSync(
    join(realpathSync(tmpdir()), "sg-dashboard-test-"),
  );
  directories.push(directory);
  return directory;
}
async function start(
  packageRoot?: string,
  networkHosts: string[] = [],
  options: DashboardOptions = {},
) {
  const root = temporary();
  const installation = packageRoot ?? temporary();
  if (!packageRoot) {
    mkdirSync(join(installation, "dashboard"));
    writeFileSync(
      join(installation, "dashboard", "index.html"),
      "<h1>Gremlin dashboard</h1>",
    );
    writeFileSync(join(installation, "private.html"), "never-public");
    writeFileSync(
      join(installation, "dashboard", "secret.json"),
      '{"token":"never-public"}',
    );
  }
  const server = createDashboardServer(
    root,
    installation,
    session,
    networkHosts,
    options,
  );
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return {
    root,
    installation,
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
  };
}
afterEach(async () => {
  for (const server of servers.splice(0))
    await new Promise<void>((done) => server.close(() => done()));
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function post(
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
) {
  return fetch(url, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("local dashboard HTTP boundary", () => {
  it("protects PM briefs and knowledge and admits discovery without Linear or hosting readiness", async () => {
    const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
    const enqueue = vi.fn(async (input) => ({ id: "job-discovery", ...input }));
    const runners = {
      jobs: vi.fn(async () => []),
      status: vi.fn(async () => ({
        runners: [{ status: "ready", verifiedAt: "2026-10-05", paused: false }],
        jobs: [],
      })),
      enqueue,
      start: vi.fn(),
      stop: vi.fn(async () => {}),
    } as unknown as LocalRunners;
    const validate = vi.fn(async () => ({
      area: { key: "core" },
      discoveryRevision: "f".repeat(64),
    }));
    const { root, url } = await start(packageRoot, [], {
      runners,
      sourceControl: sourceFixture(),
      jobs: { validate } as unknown as ReturnType<typeof createJobPreparation>,
    });
    initializeSetup(root, packageRoot, { project: "demo", repo: "owner/app" });
    writeFileSync(
      join(root, ".env"),
      "CLAUDE_CODE_OAUTH_TOKEN=synthetic-only\n",
    );
    const base = `${url}/api/projects/demo/pms/core`;
    expect((await fetch(`${base}/knowledge`)).status).toBe(401);
    expect((await fetch(`${base}/brief`)).status).toBe(401);
    expect(
      await (await fetch(`${base}/knowledge`, { headers: auth })).json(),
    ).toMatchObject({ state: "empty", documents: [], stale: false });
    const doc = (await (
      await fetch(`${base}/brief`, { headers: auth })
    ).json()) as { revision: string; brief: Record<string, unknown> };
    const saved = await post(`${base}/brief`, {
      revision: doc.revision,
      brief: { ...doc.brief, mandate: "Inspect code and trust boundaries." },
    });
    expect(saved.status).toBe(200);
    expect(
      (
        await post(`${base}/brief`, {
          revision: doc.revision,
          brief: doc.brief,
        })
      ).status,
    ).toBe(409);
    const input = {
      type: "pm",
      project: "demo",
      area: "core",
      pmMode: "discovery",
    };
    expect((await post(`${url}/api/jobs`, input)).status).toBe(202);
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        ...input,
        runOnce: true,
        discoveryRevision: "f".repeat(64),
      }),
    );
    expect(
      (
        await post(`${url}/api/jobs`, {
          ...input,
          discoveryRevision: "a".repeat(64),
        })
      ).status,
    ).toBe(400);
    expect(
      (await post(`${url}/api/jobs`, { ...input, pmMode: undefined })).status,
    ).toBe(409);
    expect(
      JSON.parse(readFileSync(join(root, "projects/demo/areas.json"), "utf8"))
        .areas.core.enabled,
    ).toBe(false);
  });
  it("serves live public activity and logs without waiting for PostgreSQL or running-job artifacts", async () => {
    const job = {
      id: "job-live",
      runId: 1,
      type: "pm",
      status: "running",
      createdAt: "2026-10-05T00:00:00Z",
    };
    const event = (id: string, type: string, title: string, detail?: string) =>
      "GREMLINS_ACTIVITY " +
      JSON.stringify({
        id,
        type,
        title,
        detail,
        timestamp: job.createdAt,
        status: "succeeded",
      });
    const logs = vi.fn(async () => [
      event("tool-1", "tool", "browser_navigate", "https://example.test"),
      event("check-1", "check", "Browser check", "Passed"),
      event("summary-1", "summary", "Agent summary", "Visible summary"),
      '\u001b[31m{"type":"assistant","message":{"content":[{"type":"thinking","thinking":"hidden-reasoning"}]}}',
      "sk-ant-oat01-synthetic-private-value",
    ]);
    const artifacts = vi.fn(async () => {
      throw new Error("Must not read unfinished artifacts");
    });
    const runners = {
      job: vi.fn(async () => job),
      jobs: vi.fn(async () => [job]),
      logs,
      artifacts,
      start: vi.fn(),
      stop: vi.fn(async () => {}),
    } as unknown as LocalRunners;
    const history = vi.fn(() => new Promise<never>(() => {}));
    const store = {
      activity: history,
      listRuns: history,
      close: vi.fn(async () => {}),
    } as unknown as ActivityStore;
    const { url } = await start(undefined, [], {
      runners,
      activityStore: store,
    });
    const [activityResponse, logResponse, artifactResponse, jobsResponse] =
      await Promise.all(
        [
          "/api/jobs/job-live/activity",
          "/api/jobs/job-live/logs",
          "/api/jobs/job-live/artifacts",
          "/api/jobs",
        ].map((path) =>
          fetch(url + path, {
            headers: auth,
            signal: AbortSignal.timeout(1200),
          }),
        ),
      );
    const activity = (await activityResponse!.json()) as RunActivity;
    expect(activityResponse!.status).toBe(200);
    expect(activity).toMatchObject({
      summary: "Visible summary",
      checks: [{ name: "Browser check", status: "succeeded" }],
      partial: true,
    });
    expect(activity.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ title: "Run running" }),
        expect.objectContaining({ title: "browser_navigate" }),
      ]),
    );
    const output = JSON.stringify(await logResponse!.json());
    expect(output).toContain("[REDACTED]");
    expect(output).not.toMatch(/hidden-reasoning|synthetic-private-value/);
    expect(await artifactResponse!.json()).toEqual({
      files: [],
      pending: true,
    });
    expect(await jobsResponse!.json()).toMatchObject({
      jobs: [job],
      historyAvailable: false,
    });
    expect(logs).toHaveBeenCalledOnce();
    expect(artifacts).not.toHaveBeenCalled();
  });

  it("bounds unavailable output reads, preserves lifecycle progress, and coalesces repeated polling", async () => {
    const job = {
      id: "job-slow",
      runId: 1,
      type: "pm",
      status: "running",
      createdAt: "2026-10-05T00:00:00Z",
    };
    const logs = vi.fn(() => new Promise<never>(() => {}));
    const runners = {
      job: vi.fn(async () => job),
      logs,
      start: vi.fn(),
      stop: vi.fn(async () => {}),
    } as unknown as LocalRunners;
    const store = {
      activity: vi.fn(() => new Promise<never>(() => {})),
      close: vi.fn(async () => {}),
    } as unknown as ActivityStore;
    const { url } = await start(undefined, [], {
      runners,
      activityStore: store,
    });
    const responses = await Promise.all(
      ["activity", "logs", "logs"].map((name) =>
        fetch(`${url}/api/jobs/job-slow/${name}`, {
          headers: auth,
          signal: AbortSignal.timeout(2500),
        }),
      ),
    );
    expect(responses.map((response) => response.status)).toEqual([
      200, 503, 503,
    ]);
    expect(await responses[0]!.json()).toMatchObject({
      events: [
        expect.objectContaining({ title: "Run running", type: "progress" }),
      ],
      partial: true,
    });
    expect(logs).toHaveBeenCalledOnce();
  });

  it("does not block completed-job logs behind artifact loading", async () => {
    const job = {
      id: "job-complete",
      runId: 1,
      type: "pm",
      status: "succeeded",
      createdAt: "2026-10-05T00:00:00Z",
    };
    const artifacts = vi.fn(() => new Promise<never>(() => {}));
    const runners = {
      job: vi.fn(async () => job),
      logs: vi.fn(async () => ["Completed output"]),
      artifacts,
      start: vi.fn(),
      stop: vi.fn(async () => {}),
    } as unknown as LocalRunners;
    const { url } = await start(undefined, [], { runners });
    const pending = fetch(`${url}/api/jobs/job-complete/artifacts`, {
      headers: auth,
      signal: AbortSignal.timeout(2500),
    });
    expect(
      await (
        await fetch(`${url}/api/jobs/job-complete/logs`, {
          headers: auth,
          signal: AbortSignal.timeout(700),
        })
      ).json(),
    ).toEqual({ lines: ["Completed output"] });
    expect((await pending).status).toBe(503);
    expect(artifacts).toHaveBeenCalledOnce();
  });

  it("exposes readiness, runs a paused PM once, and toggles automation without clearing verification", async () => {
    const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
    const enqueue = vi.fn(async () => ({ id: "manual-job", status: "queued" }));
    const runners = {
      status: vi.fn(async () => ({
        runners: [
          {
            id: "worker-one",
            name: "Local",
            status: "ready",
            busy: false,
            paused: false,
            verifiedAt: "2026-10-05",
            createdAt: "2026-10-05",
          },
        ],
        jobs: [],
        operation: { phase: "idle", message: "Ready" },
      })),
      enqueue,
      start: vi.fn(),
      stop: vi.fn(async () => {}),
    } as unknown as LocalRunners;
    const linearBinding = {
      connectionId: "default",
      workspaceId: randomUUID(),
    };
    const validate = vi.fn(async () => ({
      area: { key: "core" },
      linearBinding,
    }));
    const { url, root } = await start(packageRoot, [], {
      runners,
      jobs: { validate } as unknown as ReturnType<typeof createJobPreparation>,
      linearConnection: oauthFixture("linear"),
      vercelConnection: oauthFixture("vercel"),
      sourceControl: sourceFixture(),
    });
    initializeSetup(root, packageRoot, { project: "demo", repo: "org/app" });
    writeFileSync(
      join(root, ".env"),
      "CLAUDE_CODE_OAUTH_TOKEN=test-only-saved-ai\n",
    );
    const projectPath = join(root, "projects/demo/project.json"),
      areasPath = join(root, "projects/demo/areas.json");
    const project = JSON.parse(readFileSync(projectPath, "utf8"));
    project.verified = "2026-10-05";
    writeFileSync(projectPath, JSON.stringify(project));
    const areas = JSON.parse(readFileSync(areasPath, "utf8"));
    areas.areas.core.linearProjectId = randomUUID();
    areas.areas.core.mandate =
      "Review account boundaries using isolated test accounts.";
    writeFileSync(areasPath, JSON.stringify(areas));
    const snapshot = (await (
      await fetch(`${url}/api/projects/demo/readiness`, { headers: auth })
    ).json()) as {
      projectRevision: string;
      areasRevision: string;
      readiness: unknown;
    };
    expect(snapshot.readiness).toMatchObject({
      configured: true,
      verified: true,
      workerReady: true,
      canRun: true,
      areas: [{ enabled: false, canRun: true }],
    });
    expect(
      (
        await post(`${url}/api/jobs`, {
          type: "pm",
          project: "demo",
          area: "core",
          runOnce: true,
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await post(`${url}/api/jobs`, {
          type: "pm",
          project: "demo",
          area: "core",
        })
      ).status,
    ).toBe(202);
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "pm",
        area: "core",
        runOnce: true,
        linearBinding,
      }),
    );
    expect(JSON.parse(readFileSync(areasPath, "utf8")).areas.core.enabled).toBe(
      false,
    );
    const endpoint = `${url}/api/projects/demo/areas/core/status`,
      input = {
        enabled: true,
        revision: snapshot.areasRevision,
        projectRevision: snapshot.projectRevision,
      };
    expect(
      (
        await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input),
        })
      ).status,
    ).toBe(401);
    expect(
      (await post(endpoint, input, { Origin: "https://untrusted.example" }))
        .status,
    ).toBe(403);
    const response = await post(endpoint, input);
    expect(response.status).toBe(200);
    const enabled = (await response.json()) as { revision: string };
    expect(JSON.parse(readFileSync(projectPath, "utf8")).verified).toBe(
      "2026-10-05",
    );
    expect((await post(endpoint, input)).status).toBe(409);
    expect(
      (
        await post(endpoint, {
          ...input,
          enabled: false,
          revision: enabled.revision,
        })
      ).status,
    ).toBe(200);
    writeFileSync(join(root, ".env"), "CLAUDE_CODE_OAUTH_TOKEN=\n");
    const blocked = await post(`${url}/api/jobs`, {
      type: "pm",
      project: "demo",
      area: "core",
    });
    expect(blocked.status).toBe(409);
    expect(await blocked.text()).toContain("Claude Code");
  });
  it("protects mandate planning and returns only a draft without creating PM files", async () => {
    const plan = {
      draft: {
        name: "Account guardian",
        key: "accounts",
        label: "pm:accounts",
        charter: {
          ambition: "Make account tasks dependable.",
          goal: "Find and fix blockers in account journeys.",
          metricDefinition:
            "Account task completion; instrumentation is not yet verified.",
          users: ["Signed-in account owners"],
          expectedToBuild: ["Reliable account journeys"],
          nonGoals: ["Billing changes"],
          guardrails: ["Protect account isolation"],
          standingPriorities: ["Verify account permissions"],
        },
        paths: ["src/accounts"],
        sharedTouchpoints: [],
        metric: "/accounts",
        schedule: "0 13 * * 1-5",
        wipLimit: 2,
      },
      rationale: "The mandate targets account flows.",
      repository: {
        provider: "github" as const,
        repo: "org/app",
        branch: "main",
        pathCount: 5,
        truncated: false,
      },
      warnings: [],
    };
    const planner = { plan: vi.fn(async () => plan) };
    const { url, root } = await start(undefined, [], { pmPlanner: planner });
    const endpoint = `${url}/api/projects/demo/pm-plan`;
    expect(
      (
        await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mandate: "Review accounts." }),
        })
      ).status,
    ).toBe(401);
    expect(
      (await post(endpoint, { mandate: "Review accounts.", enabled: true }))
        .status,
    ).toBe(400);
    expect(
      (
        await post(
          endpoint,
          { mandate: "Review accounts." },
          { Origin: "https://untrusted.example" },
        )
      ).status,
    ).toBe(403);
    const response = await post(endpoint, { mandate: "Review accounts." });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(plan);
    expect(planner.plan).toHaveBeenCalledWith({
      project: "demo",
      mandate: "Review accounts.",
      signal: expect.any(AbortSignal),
    });
    expect(() =>
      readFileSync(join(root, "projects/demo/areas.json")),
    ).toThrow();
    planner.plan.mockRejectedValueOnce(
      new PmPlannerError(
        "Save the AI connection before planning.",
        "missing_ai",
        409,
      ),
    );
    const failure = await post(endpoint, { mandate: "Review accounts." });
    expect(failure.status).toBe(409);
    expect(await failure.text()).toContain("Save the AI connection");
  });
  it("serves only the known dashboard page routes on direct reload with API protection intact", async () => {
    const { url } = await start();
    for (const route of [
      "/overview",
      "/connections",
      "/projects",
      "/projects/demo",
      "/runners",
      "/activity",
      "/settings",
    ]) {
      const response = await fetch(url + route);
      expect(response.status, route).toBe(200);
      expect(response.headers.get("Content-Type")).toBe(
        "text/html; charset=utf-8",
      );
      expect(response.headers.get("Content-Security-Policy")).toContain(
        "script-src 'self'",
      );
      expect(await response.text()).toContain("Gremlin dashboard");
      expect(await (await fetch(url + route, { method: "HEAD" })).text()).toBe(
        "",
      );
    }
    for (const route of [
      "/unknown-page",
      "/settings/private",
      "/projects/demo/private",
      "/projects/.env",
      "/connections/secret.json",
    ])
      expect((await fetch(url + route)).status, route).toBe(404);
    expect((await fetch(`${url}/api/status`)).status).toBe(401);
    expect((await fetch(`${url}/api/projects`)).status).toBe(401);
  });
  it.each(["linear", "vercel"] as const)(
    "authenticates %s OAuth routes and derives the return URL server-side",
    async (provider) => {
      const connection = oauthFixture(provider);
      const { url } = await start(undefined, [], {
        [provider === "linear" ? "linearConnection" : "vercelConnection"]:
          connection,
      });
      expect((await fetch(`${url}/api/${provider}`)).status).toBe(401);
      expect(
        (
          await post(
            `${url}/api/${provider}/connect`,
            {},
            { Origin: "https://evil.example" },
          )
        ).status,
      ).toBe(403);
      expect(
        (
          await post(`${url}/api/${provider}/connect`, {
            returnUrl: "https://evil.example",
          })
        ).status,
      ).toBe(400);
      expect(connection.connect).not.toHaveBeenCalled();
      expect((await post(`${url}/api/${provider}/connect`, {})).status).toBe(
        200,
      );
      expect(connection.connect).toHaveBeenCalledWith(url + "/");
      expect(
        (
          await post(`${url}/api/${provider}/complete`, {
            envelope: "encrypted",
          })
        ).status,
      ).toBe(200);
      expect(connection.complete).toHaveBeenCalledWith("encrypted");
      const text = await (
        await fetch(`${url}/api/${provider}`, { headers: auth })
      ).text();
      expect(text).not.toContain("never-public");
      expect(JSON.parse(text)).toMatchObject({
        connected: true,
        method: "oauth",
      });
      connection.complete = vi.fn(async () => {
        throw new OAuthConnectionError(
          "Setup expired. Connect again.",
          "expired",
          409,
        );
      });
      expect(
        (await post(`${url}/api/${provider}/complete`, { envelope: "old" }))
          .status,
      ).toBe(409);
    },
  );

  it("preserves a saved app after Linear failure and exposes explicit retry and PM creation", async () => {
    const linearConnection = oauthFixture("linear");
    const linearProvisioning: NonNullable<
      DashboardOptions["linearProvisioning"]
    > = {
      status: vi.fn(() => ({ status: "skipped" as const })),
      resources: vi.fn(async () => ({ teams: [], projects: [] })),
      provision: vi.fn(async () => {
        throw new LinearProvisioningError("Retry the saved operation.", 502);
      }),
      addArea: vi.fn(async () => {}),
      repairMappings: vi.fn(async () => {
        throw new LinearProvisioningError("Reload current mappings.", 409);
      }),
    };
    const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
    const { url, root } = await start(packageRoot, [], {
      linearConnection,
      linearProvisioning,
    });
    const response = await post(`${url}/api/projects`, {
      project: "demo",
      repo: "org/app",
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      linear: { status: "error", message: "Retry the saved operation." },
    });
    expect(
      readFileSync(join(root, "projects/demo/project.json"), "utf8"),
    ).toContain("org/app");
    expect(linearProvisioning.provision).toHaveBeenCalledWith("demo", {
      teamId: undefined,
    });
    expect((await post(`${url}/api/projects/demo/linear`, {})).status).toBe(
      200,
    );
    expect(linearProvisioning.provision).toHaveBeenCalledTimes(2);
    expect(
      (
        await post(`${url}/api/projects/demo/areas`, {
          key: "security",
          name: "Security",
          mandate: "Test permission boundaries.",
        })
      ).status,
    ).toBe(200);
    expect(linearProvisioning.addArea).toHaveBeenCalledWith("demo", {
      key: "security",
      name: "Security",
      mandate: "Test permission boundaries.",
    });
    const fullBrief = {
      key: "full-brief",
      name: "Full brief",
      mandate: "界".repeat(12000),
      charter: {
        goal: "Check permission boundaries without guessing user requirements.",
      },
    };
    expect(
      (await post(`${url}/api/projects/demo/areas`, fullBrief)).status,
    ).toBe(200);
    expect(linearProvisioning.addArea).toHaveBeenLastCalledWith(
      "demo",
      fullBrief,
    );
    expect(
      (
        await post(`${url}/api/projects/demo/areas`, {
          ...fullBrief,
          mandate: "x".repeat(128 * 1024),
        })
      ).status,
    ).toBe(413);
    expect(
      (await fetch(`${url}/api/linear/resources`, { headers: auth })).status,
    ).toBe(200);
    expect(linearProvisioning.resources).toHaveBeenCalledOnce();
    expect(
      (
        await post(`${url}/api/service-connections`, {
          provider: "linear",
          id: "client-two",
          label: "Second workspace",
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await fetch(`${url}/api/linear/resources?connection=client-two`, {
          headers: auth,
        })
      ).status,
    ).toBe(200);
    expect(linearProvisioning.resources).toHaveBeenLastCalledWith(
      undefined,
      "client-two",
    );
    expect(
      (
        await fetch(`${url}/api/linear/resources?connection=missing`, {
          headers: auth,
        })
      ).status,
    ).toBe(409);
    expect(linearProvisioning.resources).toHaveBeenCalledTimes(2);
    const manual = await post(`${url}/api/projects`, {
      project: "manual",
      repo: "org/app",
      linearMode: "later",
    });
    expect(await manual.json()).toMatchObject({
      linear: { status: "skipped" },
    });
    expect(linearProvisioning.provision).toHaveBeenCalledTimes(2);
  });
  it.each(["linear", "vercel"] as const)(
    "keeps named %s account actions isolated and returns a secret-free catalog",
    async (provider) => {
      const original = oauthFixture(provider),
        second = oauthFixture(provider);
      const { url, root } = await start(undefined, [], {
        [provider === "linear" ? "linearConnection" : "vercelConnection"]:
          original,
        [provider === "linear" ? "linearConnectionFor" : "vercelConnectionFor"]:
          (id: string) => {
            expect(id).toBe("client-two");
            return second;
          },
        [provider === "linear" ? "vercelConnection" : "linearConnection"]:
          oauthFixture(provider === "linear" ? "vercel" : "linear"),
      });
      expect((await fetch(`${url}/api/service-connections`)).status).toBe(401);
      expect(
        (
          await post(`${url}/api/service-connections`, {
            provider,
            id: "client-two",
            label: "Second account",
          })
        ).status,
      ).toBe(200);
      expect(
        (
          await post(`${url}/api/service-connections`, {
            provider,
            id: "client-two",
            label: "Duplicate",
          })
        ).status,
      ).toBe(409);
      const catalog = await (
        await fetch(`${url}/api/service-connections`, { headers: auth })
      ).text();
      expect(catalog).toContain('"id":"client-two"');
      expect(catalog).toContain('"label":"Second account"');
      expect(catalog).not.toContain("never-public");
      expect(
        (await post(`${url}/api/${provider}/connect?connection=client-two`, {}))
          .status,
      ).toBe(200);
      expect(second.connect).toHaveBeenCalledWith(url + "/");
      expect(original.connect).not.toHaveBeenCalled();
      expect(
        (
          await post(`${url}/api/${provider}/complete?connection=client-two`, {
            envelope: "named-envelope",
          })
        ).status,
      ).toBe(200);
      expect(second.complete).toHaveBeenCalledWith("named-envelope");
      expect(original.complete).not.toHaveBeenCalled();
      expect(
        (await post(`${url}/api/${provider}/connect?connection=missing`, {}))
          .status,
      ).toBe(409);
      expect(
        (
          await post(
            `${url}/api/${provider}/connect?connection=default&connection=client-two`,
            {},
          )
        ).status,
      ).toBe(400);
      second.disconnect = vi.fn(async () => {
        throw new OAuthConnectionError("Account has active jobs.", "busy", 409);
      });
      expect(
        (
          await fetch(`${url}/api/${provider}?connection=client-two`, {
            method: "DELETE",
            headers: { ...auth, "Content-Type": "application/json" },
            body: "{}",
          })
        ).status,
      ).toBe(409);
      expect(original.disconnect).not.toHaveBeenCalled();
      expect(
        readFileSync(
          join(
            root,
            ".run/oauth",
            provider,
            "connections/client-two/connection.enc",
          ),
          "utf8",
        ),
      ).not.toContain("never-public");
    },
  );
  it("persists a project's selected Linear account before deferred setup and rejects nonexistent selections", async () => {
    const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
    const { url, root } = await start(packageRoot, [], {
      linearConnectionFor: () => oauthFixture("linear"),
      vercelConnection: oauthFixture("vercel"),
      linearConnection: oauthFixture("linear"),
    });
    expect(
      (
        await post(`${url}/api/service-connections`, {
          provider: "linear",
          id: "client-two",
          label: "Second workspace",
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await post(`${url}/api/projects`, {
          project: "demo",
          repo: "org/app",
          linearMode: "later",
          linear: { connectionId: "client-two" },
        })
      ).status,
    ).toBe(200);
    expect(
      JSON.parse(readFileSync(join(root, "projects/demo/project.json"), "utf8"))
        .linear,
    ).toEqual({ connectionId: "client-two" });
    const status = (await (
      await fetch(`${url}/api/status`, { headers: auth })
    ).json()) as {
      projects: { name: string; linear: { connectionId?: string } }[];
    };
    expect(status.projects[0]?.linear.connectionId).toBe("client-two");
    expect(
      (
        await post(`${url}/api/projects`, {
          project: "missing",
          repo: "org/app",
          linearMode: "later",
          linear: { connectionId: "missing" },
        })
      ).status,
    ).toBe(400);
    expect(() =>
      readFileSync(join(root, "projects/missing/project.json")),
    ).toThrow();
  });
  it("repairs existing Linear mappings with authenticated revision-guarded saves and no resource creation", async () => {
    const root = temporary(),
      packageRoot = fileURLToPath(new URL("../..", import.meta.url));
    initializeSetup(root, packageRoot, { project: "demo", repo: "org/app" });
    const team = { id: randomUUID(), name: "App team", key: "APP" };
    const resource = {
      id: randomUUID(),
      name: "Core",
      teamIds: [team.id],
      url: "https://linear.app/test/project/core",
    };
    const client = {
      organization: vi.fn(async () => ({
        id: randomUUID(),
        name: "Workspace",
      })),
      getTeam: vi.fn(async () => team),
      getProject: vi.fn(async () => resource),
      resources: vi.fn(async () => ({ teams: [team], projects: [resource] })),
      createTeam: vi.fn(async () => team),
      createProject: vi.fn(async () => resource),
      updateProject: vi.fn(async () => resource),
    };
    const server = createDashboardServer(root, packageRoot, session, [], {
      linearProvisioning: createLinearProvisioning({
        root,
        client: async () => client,
      }),
    });
    servers.push(server);
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const document = async (name: string) =>
      (
        await fetch(`${url}/api/config?path=projects%2Fdemo%2F${name}.json`, {
          headers: auth,
        })
      ).json() as Promise<{ revision: string }>;
    const project = await document("project"),
      areas = await document("areas");
    const input = {
      projectRevision: project.revision,
      areasRevision: areas.revision,
      teamId: team.id,
      areaProjects: { core: resource.id },
    };
    const endpoint = `${url}/api/projects/demo/linear/mappings`;
    expect(
      (
        await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input),
        })
      ).status,
    ).toBe(401);
    expect(
      (await post(endpoint, input, { Origin: "https://untrusted.example" }))
        .status,
    ).toBe(403);
    expect(client.getTeam).not.toHaveBeenCalled();
    const response = await post(endpoint, input);
    expect(response.status).toBe(200);
    const saved = (await response.json()) as {
      project: { revision: string; content: string };
      areas: { revision: string; content: string };
    };
    expect(saved).toMatchObject({
      ok: true,
      team: { id: team.id, name: team.name },
      projectRevision: saved.project.revision,
      areasRevision: saved.areas.revision,
    });
    expect(JSON.parse(saved.project.content)).toMatchObject({
      linear: { teamId: team.id },
      verified: null,
    });
    expect(JSON.parse(saved.areas.content).areas.core.linearProjectId).toBe(
      resource.id,
    );
    expect((await post(endpoint, input)).status).toBe(409);
    expect(client.createTeam).not.toHaveBeenCalled();
    expect(client.createProject).not.toHaveBeenCalled();
  });
  it("repairs malformed old Linear IDs using an explicitly selected account without loading the broken typed mapping", async () => {
    const root = temporary(),
      packageRoot = fileURLToPath(new URL("../..", import.meta.url));
    initializeSetup(root, packageRoot, { project: "demo", repo: "org/app" });
    const file = join(root, "projects/demo/project.json"),
      raw = JSON.parse(readFileSync(file, "utf8"));
    raw.linear = {
      teamId: "incorrect-team-id",
      workspaceId: "incorrect-workspace-id",
    };
    writeFileSync(file, JSON.stringify(raw));
    const workspace = { id: randomUUID(), name: "Correct workspace" },
      team = { id: randomUUID(), name: "Correct team", key: "APP" },
      projectId = randomUUID();
    const mocks = [
      vi
        .spyOn(LinearApi.prototype, "organization")
        .mockResolvedValue(workspace),
      vi.spyOn(LinearApi.prototype, "getTeam").mockResolvedValue(team),
      vi.spyOn(LinearApi.prototype, "getProject").mockResolvedValue({
        id: projectId,
        name: "Core",
        teamIds: [team.id],
        url: "https://linear.app/test/project/core",
      }),
    ];
    try {
      const connection = oauthFixture("linear");
      const server = createDashboardServer(root, packageRoot, session, [], {
        linearConnection: connection,
      });
      servers.push(server);
      await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const response = await post(`${url}/api/projects/demo/linear/mappings`, {
        projectRevision: readEditableConfig(root, "projects/demo/project.json")
          .revision,
        areasRevision: readEditableConfig(root, "projects/demo/areas.json")
          .revision,
        connectionId: "default",
        teamId: team.id,
        areaProjects: { core: projectId },
      });
      expect(response.status).toBe(200);
      expect(JSON.parse(readFileSync(file, "utf8")).linear).toMatchObject({
        teamId: team.id,
        workspaceId: workspace.id,
        connectionId: "default",
      });
      expect(connection.resolveCredential).toHaveBeenCalledWith({
        minValidityMs: 5 * 60_000,
      });
    } finally {
      for (const mock of mocks) mock.mockRestore();
    }
  });
  function sourceFixture() {
    const connected: SourceStatus = {
      provider: "github",
      serverUrl: "https://github.com",
      available: true,
      connected: true,
      method: "oauth",
      account: { id: "account-1", login: "test-user" },
    };
    return {
      status: vi.fn(async () => [connected]),
      connect: vi.fn(async () => ({
        id: "f".repeat(48),
        provider: "github" as const,
        userCode: "USER-CODE",
        verificationUri: "https://github.com/login/device",
        intervalSeconds: 5,
        expiresAt: "2026-10-04T18:00:00Z",
      })),
      poll: vi.fn(async () => ({
        status: "connected" as const,
        connection: connected,
      })),
      disconnect: vi.fn(async () => ({
        ...connected,
        connected: false,
        method: "none" as const,
      })),
      repositories: vi.fn(async () => ({
        repositories: [
          {
            id: "repo-1",
            provider: "github" as const,
            serverUrl: "https://github.com",
            fullName: "example/app",
            defaultBranch: "main",
            private: true,
            webUrl: "https://github.com/example/app",
            canPush: true,
          },
        ],
        truncated: false,
      })),
      resolveCredential: vi.fn(async () => ({
        token: "private-source-token",
        method: "oauth" as const,
      })),
      acquireLease: vi.fn(async () => ({
        token: "private-source-token",
        method: "oauth" as const,
      })),
      releaseLease: vi.fn(async () => {}),
    } satisfies SourceControl;
  }

  it("creates a repository-first app with selected commands and exposes editable capabilities", async () => {
    const { url, root } = await start(
      fileURLToPath(new URL("../..", import.meta.url)),
    );
    const workflow = { kind: "pull-request", baseBranch: "develop" };
    const commands = {
      install: "npm ci",
      test: "npm test",
      lint: null,
      typecheck: null,
      build: "npm run build",
    };
    const telemetry = {
      mixpanel: {
        region: "us",
        projectId: "123",
        usernameSecret: "MIXPANEL_USERNAME_DEMO",
        passwordSecret: "MIXPANEL_PASSWORD_DEMO",
      },
    };
    const response = await post(`${url}/api/projects`, {
      project: "demo",
      repo: "org/app",
      linearMode: "later",
      workflow,
      verification: { mode: "repository" },
      environments: {},
      commands,
      telemetry,
    });
    expect(response.status).toBe(200);
    const path = "projects/demo/project.json";
    expect(JSON.parse(readFileSync(join(root, path), "utf8"))).toMatchObject({
      workflow,
      verification: { mode: "repository" },
      environments: {},
      commands,
      verified: null,
      telemetry,
    });
    const status = (await (
      await fetch(`${url}/api/status`, { headers: auth })
    ).json()) as { projects: unknown[]; connections: unknown[] };
    expect(status.projects).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "demo",
          workflow,
          verification: { mode: "repository" },
          environments: {},
          commands,
          telemetry,
        }),
      ]),
    );
    expect(status.connections).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "MIXPANEL_USERNAME_DEMO",
          project: "demo",
          group: "telemetry",
          provider: "mixpanel",
          purpose: "telemetry-read",
          usages: expect.any(Array),
        }),
      ]),
    );
    expect(readFileSync(join(root, ".env.example"), "utf8")).toContain(
      "MIXPANEL_PASSWORD_DEMO=",
    );
    const document = (await (
      await fetch(`${url}/api/config?path=${encodeURIComponent(path)}`, {
        headers: auth,
      })
    ).json()) as { content: string; revision: string };
    const config = JSON.parse(document.content);
    config.environments = {
      qa: { kind: "url", role: "staging", url: "https://qa.example.com" },
    };
    config.verification = { mode: "browser", environment: "qa" };
    const saved = await fetch(`${url}/api/config`, {
      method: "PUT",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({
        path,
        revision: document.revision,
        content: JSON.stringify(config),
      }),
    });
    expect(saved.status).toBe(200);
    expect(JSON.parse(readFileSync(join(root, path), "utf8"))).toMatchObject({
      verification: { mode: "browser", environment: "qa" },
      environments: config.environments,
    });
  });

  it("rejects an active production target before creating a project", async () => {
    const { url, root } = await start(
      fileURLToPath(new URL("../..", import.meta.url)),
    );
    const response = await post(`${url}/api/projects`, {
      project: "demo",
      repo: "org/app",
      linearMode: "later",
      workflow: { kind: "pull-request", baseBranch: "main" },
      verification: { mode: "browser", environment: "prod" },
      environments: {
        prod: {
          kind: "url",
          role: "production",
          url: "https://prod.example.com",
        },
      },
    });
    expect(response.status).toBe(400);
    expect(() =>
      readFileSync(join(root, "projects/demo/project.json")),
    ).toThrow();
  });

  it("validates initial telemetry settings before writing project files without echoing credential values", async () => {
    const { url, root } = await start(
      fileURLToPath(new URL("../..", import.meta.url)),
    );
    const response = await post(`${url}/api/projects`, {
      project: "demo",
      repo: "org/demo",
      linearMode: "later",
      telemetry: {
        sentry: {
          host: "sentry.io",
          organization: "org",
          project: "demo",
          environment: "staging",
          tokenSecret: "never-store-this-credential-value",
        },
      },
    });
    expect(response.status).toBe(400);
    expect(await response.text()).not.toContain(
      "never-store-this-credential-value",
    );
    expect(() =>
      readFileSync(join(root, "projects/demo/project.json")),
    ).toThrow();
  });

  it("returns a verification conflict when settings are edited while provider checks are in flight", async () => {
    const sourceControl = sourceFixture();
    const linearConnection = oauthFixture("linear");
    const { url, root, installation } = await start(
      fileURLToPath(new URL("../..", import.meta.url)),
      [],
      { sourceControl, linearConnection },
    );
    initializeSetup(root, installation, { project: "demo", repo: "org/demo" });
    const areaPath = join(root, "projects/demo/areas.json");
    const areas = JSON.parse(readFileSync(areaPath, "utf8"));
    areas.areas.core.linearProjectId = "linear-project";
    writeFileSync(areaPath, JSON.stringify(areas));
    let entered!: () => void;
    const checking = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const continueCheck = new Promise<void>((resolve) => {
      release = resolve;
    });
    sourceControl.resolveCredential = vi.fn(async () => {
      entered();
      await continueCheck;
      return { token: "private-source-token", method: "oauth" as const };
    });
    const nativeFetch = globalThis.fetch;
    const fake = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input, init) => {
        const target = String(input);
        return target.startsWith(url)
          ? nativeFetch(input, init)
          : Response.json({ data: { project: { name: "Test project" } } });
      });
    try {
      const pending = post(`${url}/api/projects/demo/verify`, {});
      await checking;
      const path = "projects/demo/project.json";
      const document = (await (
        await fetch(`${url}/api/config?path=${encodeURIComponent(path)}`, {
          headers: auth,
        })
      ).json()) as { content: string; revision: string };
      const config = JSON.parse(document.content);
      config.commands.test = "npm run test:updated";
      const edit = await fetch(`${url}/api/config`, {
        method: "PUT",
        headers: { ...auth, "Content-Type": "application/json" },
        body: JSON.stringify({
          path,
          revision: document.revision,
          content: JSON.stringify(config),
        }),
      });
      expect(edit.status).toBe(200);
      release();
      const response = await pending;
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        error: expect.stringContaining("settings changed during verification"),
      });
      expect(JSON.parse(readFileSync(join(root, path), "utf8"))).toMatchObject({
        verified: null,
        commands: { test: "npm run test:updated" },
      });
    } finally {
      release();
      fake.mockRestore();
    }
  });

  it("exposes authenticated source app/device/repository actions without credential values", async () => {
    const sourceControl = sourceFixture();
    const { url } = await start(undefined, [], { sourceControl });
    expect((await fetch(`${url}/api/source-control`)).status).toBe(401);
    const status = (await (
      await fetch(`${url}/api/source-control`, { headers: auth })
    ).json()) as { connections: SourceStatus[] };
    expect(status.connections[0]).toMatchObject({
      connected: true,
      account: { login: "test-user" },
    });
    expect(JSON.stringify(status)).not.toContain("private-source-token");
    const connected = await post(
      `${url}/api/source-control/github/connect`,
      {},
    );
    expect(connected.status).toBe(200);
    expect(((await connected.json()) as { userCode: string }).userCode).toBe(
      "USER-CODE",
    );
    expect(sourceControl.connect).toHaveBeenCalledWith({ provider: "github" });
    expect(
      (
        await post(`${url}/api/source-control/github/poll`, {
          id: "f".repeat(48),
        })
      ).status,
    ).toBe(200);
    expect(sourceControl.poll).toHaveBeenCalledWith("f".repeat(48));
    const repositories = await fetch(
      `${url}/api/source-control/github/repositories?search=app`,
      { headers: auth },
    );
    expect(repositories.status).toBe(200);
    expect(
      ((await repositories.json()) as { repositories: { fullName: string }[] })
        .repositories[0]!.fullName,
    ).toBe("example/app");
    expect(sourceControl.repositories).toHaveBeenCalledWith({
      provider: "github",
      search: "app",
    });
    expect(
      (
        await fetch(`${url}/api/source-control/github`, {
          method: "DELETE",
          headers: { ...auth, "Content-Type": "application/json" },
          body: "{}",
        })
      ).status,
    ).toBe(200);
    expect(sourceControl.disconnect).toHaveBeenCalledWith({
      provider: "github",
    });
    const dashboard = (await (
      await fetch(`${url}/api/status`, { headers: auth })
    ).json()) as {
      connections: { name: string; configured: boolean }[];
      sourceConnections: SourceStatus[];
    };
    expect(
      dashboard.connections.find((item) => item.name === "GITHUB_TOKEN")!
        .configured,
    ).toBe(Boolean(process.env.GITHUB_TOKEN));
    expect(dashboard.sourceConnections[0]?.connected).toBe(true);
  });

  it("rejects source-control issuer overrides, credentials and cross-site requests", async () => {
    const sourceControl = sourceFixture();
    const { url } = await start(undefined, [], { sourceControl });
    for (const input of [
      { serverUrl: "http://127.0.0.1/internal" },
      { clientId: "untrusted-client" },
      { token: "private" },
    ])
      expect(
        (await post(`${url}/api/source-control/gitlab/connect`, input)).status,
      ).toBe(400);
    expect(
      (
        await fetch(
          `${url}/api/source-control/gitlab/repositories?serverUrl=https://evil.test`,
          { headers: auth },
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await post(
          `${url}/api/source-control/github/connect`,
          {},
          { Origin: "https://evil.test" },
        )
      ).status,
    ).toBe(403);
    expect(
      (await post(`${url}/api/source-control/github/poll`, { id: "../escape" }))
        .status,
    ).toBe(400);
    expect(sourceControl.connect).not.toHaveBeenCalled();
    expect(sourceControl.repositories).not.toHaveBeenCalled();
    expect(sourceControl.poll).not.toHaveBeenCalled();
  });

  it("validates an OAuth-selected repository before writing project configuration", async () => {
    const sourceControl = sourceFixture();
    const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
    const { url, root } = await start(packageRoot, [], { sourceControl });
    sourceControl.resolveCredential.mockRejectedValueOnce(
      new SourceControlError(
        "Repository not accessible",
        "permission_denied",
        403,
      ),
    );
    expect(
      (
        await post(`${url}/api/projects`, {
          project: "blocked-app",
          repo: "example/private",
        })
      ).status,
    ).toBe(400);
    expect(() =>
      readFileSync(join(root, "projects", "blocked-app", "project.json")),
    ).toThrow();
    const response = await post(`${url}/api/projects`, {
      project: "my-app",
      repo: "example/app",
    });
    expect(response.status).toBe(200);
    expect(sourceControl.resolveCredential).toHaveBeenLastCalledWith({
      provider: "github",
      serverUrl: "https://github.com",
      repository: "example/app",
      minValidityMs: 300000,
      write: true,
    });
    expect(await response.text()).not.toContain("private-source-token");
  });

  it("authenticates Slack connection actions and accepts only the OAuth return document across sites", async () => {
    const slack = {
      status: vi.fn(async () => ({
        available: true,
        connected: false,
        message: undefined,
      })),
      connect: vi.fn(async () => ({
        url: "https://shipgremlins.ai/api/slack/authorize?request=opaque",
      })),
      complete: vi.fn(async () => ({
        available: true,
        connected: true,
        message: undefined,
      })),
      webhook: vi.fn(async () => ({
        available: true,
        connected: true,
        message: undefined,
      })),
      disconnect: vi.fn(async () => ({
        available: true,
        connected: false,
        message: undefined,
      })),
    };
    const { url } = await start(undefined, [], { slack });
    expect((await fetch(`${url}/api/slack`)).status).toBe(401);
    expect((await fetch(`${url}/api/slack`, { headers: auth })).status).toBe(
      200,
    );
    expect((await post(`${url}/api/slack/connect`, {})).status).toBe(200);
    expect(slack.connect).toHaveBeenCalledWith(`${url}/`);
    expect(
      (
        await post(`${url}/api/slack/connect`, {
          returnUrl: "https://evil.test",
        })
      ).status,
    ).toBe(400);
    expect(
      (await post(`${url}/api/slack/complete`, { envelope: "encrypted" }))
        .status,
    ).toBe(200);
    expect(slack.complete).toHaveBeenCalledWith("encrypted");
    expect(
      (
        await post(
          `${url}/api/slack/webhook`,
          { url: "test" },
          { Origin: "https://evil.test" },
        )
      ).status,
    ).toBe(403);
    expect(slack.webhook).not.toHaveBeenCalled();
    const navigationStatus = await new Promise<number | undefined>(
      (done, reject) => {
        const navigation = request(
          `${url}/`,
          {
            headers: {
              "Sec-Fetch-Site": "cross-site",
              "Sec-Fetch-Mode": "navigate",
            },
          },
          (response) => {
            response.resume();
            response.once("end", () => done(response.statusCode));
          },
        );
        navigation.on("error", reject);
        navigation.end();
      },
    );
    expect(navigationStatus).toBe(200);
    expect(
      (
        await fetch(`${url}/api/slack`, {
          headers: {
            ...auth,
            "Sec-Fetch-Site": "cross-site",
            "Sec-Fetch-Mode": "navigate",
          },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await fetch(`${url}/api/slack`, {
          method: "DELETE",
          headers: { ...auth, "Content-Type": "application/json" },
          body: "{}",
        })
      ).status,
    ).toBe(200);
  });
  it("authenticates worker mutations, validates job inputs, and serves only authorized artifacts", async () => {
    const create = vi.fn(async () => ({
      id: "worker-demo",
      status: "provisioning",
    }));
    const enqueue = vi.fn(async () => ({ id: "job-demo", status: "queued" }));
    const runners = {
      create,
      enqueue,
      jobs: vi.fn(async () => []),
      job: vi.fn(async () => ({
        id: "job-demo",
        status: "succeeded",
        createdAt: "2026-10-05T00:00:00Z",
      })),
      start: vi.fn(),
      stop: vi.fn(async () => {}),
      status: vi.fn(async () => ({
        runners: [],
        jobs: [],
        operation: { phase: "idle", message: "Ready" },
      })),
      logs: vi.fn(async () => ["Browser ready"]),
      artifacts: vi.fn(async () => [{ name: "screenshot.png", size: 8 }]),
      readArtifact: vi.fn(async () =>
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      ),
    } as unknown as LocalRunners;
    const docker = {
      preflight: vi.fn(async () => ({
        available: true,
        message: "Docker ready",
      })),
    } as unknown as DockerRunners;
    const linearBinding = {
      connectionId: "client-two",
      workspaceId: randomUUID(),
      ticketId: randomUUID(),
    };
    const validate = vi.fn(async () => ({
      area: { key: "core" },
      ticket: { identifier: "APP-1", id: linearBinding.ticketId },
      linearBinding,
    }));
    const jobs = { validate } as unknown as ReturnType<
      typeof createJobPreparation
    >;
    const { url } = await start(undefined, [], { runners, docker, jobs });
    expect(
      (
        await fetch(`${url}/api/runners`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        })
      ).status,
    ).toBe(401);
    expect(create).not.toHaveBeenCalled();
    expect(
      (await post(`${url}/api/runners`, { token: "must-not-be-accepted" }))
        .status,
    ).toBe(400);
    expect((await post(`${url}/api/runners`, {})).status).toBe(202);
    expect(create).toHaveBeenCalledOnce();
    expect(
      (
        await post(`${url}/api/jobs`, {
          type: "developer",
          project: "app",
          ticket: "APP-1",
          prompt: "arbitrary",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await post(`${url}/api/jobs`, {
          type: "developer",
          project: "app",
          ticket: "APP-1",
          linearBinding: { connectionId: "attacker" },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await post(`${url}/api/jobs`, {
          type: "developer",
          project: "app",
          ticket: "APP-1",
        })
      ).status,
    ).toBe(202);
    expect(validate).toHaveBeenCalledOnce();
    expect(enqueue).toHaveBeenCalledOnce();
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ linearBinding, area: "core", ticket: "APP-1" }),
    );
    expect((await fetch(`${url}/api/jobs/job-demo/logs`)).status).toBe(401);
    expect(
      await (
        await fetch(`${url}/api/jobs/job-demo/logs`, { headers: auth })
      ).json(),
    ).toEqual({ lines: ["Browser ready"] });
    expect(
      await (
        await fetch(`${url}/api/jobs/job-demo/artifacts`, { headers: auth })
      ).json(),
    ).toMatchObject({
      files: [
        {
          name: "screenshot.png",
          url: "/api/jobs/job-demo/artifacts/screenshot.png",
        },
      ],
    });
    expect(
      (
        await fetch(`${url}/api/jobs/job-demo/artifacts/evil.html`, {
          headers: auth,
        })
      ).status,
    ).toBe(400);
    const screenshot = await fetch(
      `${url}/api/jobs/job-demo/artifacts/screenshot.png`,
      { headers: auth },
    );
    expect(screenshot.headers.get("Content-Type")).toBe("image/png");
    expect(screenshot.headers.get("Content-Security-Policy")).toContain(
      "sandbox",
    );
    expect((await screenshot.arrayBuffer()).byteLength).toBe(8);
  });
  it.each([
    [
      "a reused identifier in a different workspace",
      "different-workspace",
      202,
    ],
    [
      "the same ticket through another connection to its workspace",
      "same-workspace",
      409,
    ],
    [
      "the same immutable ticket after its identifier changed",
      "renamed-ticket",
      409,
    ],
    ["an unbound legacy job with the same identifier", "legacy", 409],
  ] as const)(
    "handles completed developer history for %s",
    async (_title, scenario, expected) => {
      const currentBinding = {
        connectionId: "current-account",
        workspaceId: randomUUID(),
        ticketId: randomUUID(),
      };
      const oldBinding =
        scenario === "legacy"
          ? undefined
          : scenario === "different-workspace"
            ? {
                connectionId: "previous-account",
                workspaceId: randomUUID(),
                ticketId: randomUUID(),
              }
            : {
                ...currentBinding,
                connectionId:
                  scenario === "same-workspace"
                    ? "another-account"
                    : currentBinding.connectionId,
              };
      const enqueue = vi.fn(async () => ({ id: "new-job", status: "queued" }));
      const runners = {
        jobs: vi.fn(async () => [
          {
            id: "old-job",
            runId: 1,
            type: "developer",
            project: "app",
            ticket: scenario === "renamed-ticket" ? "OLD-123" : "ENG-123",
            status: "succeeded",
            createdAt: "2026-10-05T00:00:00Z",
            linearBinding: oldBinding,
          },
        ]),
        enqueue,
        start: vi.fn(),
        stop: vi.fn(async () => {}),
      } as unknown as LocalRunners;
      const jobs = {
        validate: vi.fn(async () => ({
          area: { key: "core" },
          ticket: { identifier: "ENG-123", id: currentBinding.ticketId },
          linearBinding: currentBinding,
        })),
      } as unknown as ReturnType<typeof createJobPreparation>;
      const { url } = await start(undefined, [], { runners, jobs });
      expect(
        (
          await post(`${url}/api/jobs`, {
            type: "developer",
            project: "app",
            ticket: "ENG-123",
          })
        ).status,
      ).toBe(expected);
      if (expected === 202)
        expect(enqueue).toHaveBeenCalledWith(
          expect.objectContaining({
            linearBinding: currentBinding,
            idempotencyKey: `developer:app:${currentBinding.ticketId}`,
          }),
        );
      else expect(enqueue).not.toHaveBeenCalled();
    },
  );
  it("keeps authentication and exact same-origin checks for explicitly allowed LAN hosts", async () => {
    const { url } = await start(undefined, ["192.168.1.20"]);
    const port = new URL(url).port;
    const host = `192.168.1.20:${port}`;
    const call = (headers: Record<string, string>) =>
      new Promise<number>((done, reject) => {
        const req = request(`${url}/api/status`, { headers }, (res) => {
          res.resume();
          res.once("end", () => done(res.statusCode!));
        });
        req.once("error", reject);
        req.end();
      });
    expect(await call({ Host: host })).toBe(401);
    expect(await call({ ...auth, Host: host, Origin: `http://${host}` })).toBe(
      200,
    );
    expect(await call({ ...auth, Host: host, Origin: url })).toBe(403);
    expect(await call({ ...auth, Host: `192.168.1.99:${port}` })).toBe(403);
    expect(await call({ ...auth, Host: `evil.example:${port}` })).toBe(403);
    expect(await call({ ...auth, Host: "192.168.1.20:1" })).toBe(403);
  });

  it("keeps secrets out of the unauthenticated page and rejects preflight requests", async () => {
    const { root, url } = await start();
    writeFileSync(join(root, ".env"), "GITHUB_TOKEN=private-credential\n");
    const page = await fetch(url);
    const html = await page.text();
    expect(page.status).toBe(200);
    expect(html).not.toContain("private-credential");
    expect(html).not.toContain(session);
    expect(html).not.toContain(root);
    const blocked = await fetch(`${url}/api/connections`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ values: { GITHUB_TOKEN: "overwritten" } }),
    });
    expect(blocked.status).toBe(401);
    expect(readFileSync(join(root, ".env"), "utf8")).toContain(
      "private-credential",
    );
    for (const [path, headers, expected] of [
      ["/", {}, 405],
      ["/api/status", {}, 401],
      ["/api/connections", auth, 405],
      [
        "/api/connections",
        {
          Origin: "https://evil.example",
          "Access-Control-Request-Method": "POST",
        },
        403,
      ],
    ] as const) {
      const response = await fetch(url + path, { method: "OPTIONS", headers });
      expect(response.status).toBe(expected);
      expect(response.headers.get("access-control-allow-origin")).toBeNull();
      expect(await response.text()).not.toContain("private-credential");
    }
  });
  it("saves tokens without returning them and reports only configured booleans", async () => {
    const { root, url } = await start();
    const initial = await (
      await fetch(`${url}/api/status`, { headers: auth })
    ).json();
    expect(initial).toMatchObject({
      configDirectory: root,
      hubRepo: null,
      projects: [],
      runtime: { dashboard: "local", agents: "local-docker" },
    });
    const saved = await post(
      `${url}/api/connections`,
      {
        values: {
          GITHUB_TOKEN: "unique-private-token",
          LINEAR_API_KEY: "linear-private",
          CLAUDE_CODE_OAUTH_TOKEN:
            "export CLAUDE_CODE_OAUTH_TOKEN='sk-ant-oat01-synthetic_\n  wrapped-credential'",
        },
      },
      { Origin: url },
    );
    expect(await saved.json()).toEqual({ ok: true });
    const updated = await fetch(`${url}/api/status`, { headers: auth });
    const status = await updated.text();
    expect(status).not.toContain("unique-private-token");
    expect(status).not.toContain("linear-private");
    expect(status).not.toContain("wrapped-credential");
    expect(readConnections(root).CLAUDE_CODE_OAUTH_TOKEN).toBe(
      "sk-ant-oat01-synthetic_wrapped-credential",
    );
    expect(
      JSON.parse(status).connections.find(
        (item: { name: string }) => item.name === "GITHUB_TOKEN",
      ).configured,
    ).toBe(true);
    expect(updated.headers.get("cache-control")).toBe("private, no-store");
    expect(updated.headers.get("access-control-allow-origin")).toBeNull();
    expect(readFileSync(join(root, ".env"), "utf8")).toContain(
      "unique-private-token",
    );
    expect(
      (await post(`${url}/api/connections`, { values: { GITHUB_TOKEN: "" } }))
        .status,
    ).toBe(200);
    expect(readFileSync(join(root, ".env"), "utf8")).toContain(
      "unique-private-token",
    );
  });

  it("reports Claude input errors separately from credential storage failures", async () => {
    const { root, url } = await start();
    const invalid = await post(`${url}/api/connections`, {
      values: {
        CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-never-disclose; extra command",
      },
    });
    expect(invalid.status).toBe(400);
    const invalidText = await invalid.text();
    expect(invalidText).toContain("Claude");
    expect(invalidText).toContain("claude setup-token");
    expect(invalidText).not.toContain("never-disclose");
    expect(invalidText).not.toContain("Google");

    mkdirSync(join(root, ".env"));
    const blocked = await post(`${url}/api/connections`, {
      values: { CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-private-test" },
    });
    expect(blocked.status).toBe(400);
    const blockedText = await blocked.text();
    expect(blockedText).toContain(".env path is a directory");
    expect(blockedText).not.toContain("private-test");
    expect(blockedText).not.toContain("Google");
  });

  it("rejects missing or incorrect sessions, foreign origins, and DNS rebinding hosts", async () => {
    const { url } = await start();
    expect((await fetch(`${url}/api/status`)).status).toBe(401);
    expect(
      (
        await fetch(`${url}/api/status`, {
          headers: { Authorization: `Bearer ${"b".repeat(64)}` },
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await fetch(`${url}/api/status`, {
          headers: { ...auth, Origin: "https://evil.example" },
        })
      ).status,
    ).toBe(403);
    expect((await fetch(url, { headers: { Origin: "null" } })).status).toBe(
      403,
    );
    const foreignHost = await new Promise<number>((done, reject) => {
      const req = request(
        `${url}/api/status`,
        { headers: { ...auth, Host: "evil.example" } },
        (res) => {
          res.resume();
          res.on("end", () => done(res.statusCode!));
        },
      );
      req.on("error", reject);
      req.end();
    });
    expect(foreignHost).toBe(403);
    expect(
      (
        await post(
          `${url}/api/connections`,
          { values: { GITHUB_TOKEN: "secret" } },
          { "Sec-Fetch-Site": "cross-site" },
        )
      ).status,
    ).toBe(403);
  });

  it("rejects wrong methods, content types, unknown keys and oversized JSON", async () => {
    const { url } = await start();
    expect((await post(`${url}/api/status`, {})).status).toBe(405);
    expect(
      (await fetch(`${url}/api/connections`, { headers: auth })).status,
    ).toBe(405);
    expect(
      (
        await post(
          `${url}/api/connections`,
          { values: {} },
          { "Content-Type": "text/plain" },
        )
      ).status,
    ).toBe(415);
    const unknown = await post(`${url}/api/connections`, {
      values: { NODE_OPTIONS: "never-show-this-secret" },
    });
    expect(unknown.status).toBe(400);
    expect(await unknown.text()).not.toContain("never-show-this-secret");
    expect(
      (await post(`${url}/api/connections`, { values: {}, extra: true }))
        .status,
    ).toBe(400);
    expect(
      (
        await post(`${url}/api/connections`, {
          values: { GITHUB_TOKEN: "a".repeat(40_000) },
        })
      ).status,
    ).toBe(413);
    const chunked = await new Promise<number>((done, reject) => {
      const req = request(
        `${url}/api/connections`,
        {
          method: "POST",
          headers: {
            ...auth,
            "Content-Type": "application/json",
            "Transfer-Encoding": "chunked",
          },
        },
        (res) => {
          res.resume();
          res.on("end", () => done(res.statusCode!));
        },
      );
      req.on("error", reject);
      req.write('{"values":{"GITHUB_TOKEN":"');
      req.write("a".repeat(40_000));
      req.end('"}}');
    });
    expect(chunked).toBe(413);
  });

  it("serves only dashboard files and refuses traversal, junctions and configuration", async () => {
    const { url, installation } = await start();
    const page = await fetch(url);
    expect(await page.text()).toContain("Gremlin dashboard");
    expect(page.headers.get("content-security-policy")).toContain(
      "script-src 'self'",
    );
    expect(page.headers.get("content-security-policy")).toContain(
      "frame-ancestors 'none'",
    );
    const external = temporary();
    writeFileSync(join(external, "private.html"), "external-secret");
    symlinkSync(
      external,
      join(installation, "dashboard", "external"),
      "junction",
    );
    for (const path of [
      "/.env",
      "/secret.json",
      "/%2e%2e%2fprivate.html",
      "/%2e%2e%5cprivate.html",
      "/%00",
      "/%zz",
      "/external/private.html",
    ])
      expect((await fetch(url + path)).status, path).toBe(404);
    expect(await (await fetch(url, { method: "HEAD" })).text()).toBe("");
  });

  it("initializes a real project and preserves it on repeated requests", async () => {
    const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
    const { root, url } = await start(packageRoot);
    const input = {
      project: "test-app",
      repo: "example/app",
      hubRepo: "example/hub",
    };
    const created = await post(`${url}/api/projects`, input);
    expect(created.status).toBe(200);
    const createdBody = (await created.json()) as {
      result: { created: string[] };
    };
    expect(createdBody.result.created.length).toBeGreaterThan(0);
    const existing = readFileSync(
      join(root, "projects", "test-app", "project.json"),
      "utf8",
    );
    const repeatedBody = (await (
      await post(`${url}/api/projects`, input)
    ).json()) as { result: { created: string[] } };
    expect(repeatedBody.result.created).toEqual([]);
    expect(
      readFileSync(join(root, "projects", "test-app", "project.json"), "utf8"),
    ).toBe(existing);
    const status = await (
      await fetch(`${url}/api/status`, { headers: auth })
    ).json();
    expect(status).toMatchObject({
      hubRepo: "example/hub",
      projects: [{ name: "test-app", repo: "example/app" }],
    });
    expect(
      (await post(`${url}/api/projects`, { ...input, project: "../escape" }))
        .status,
    ).toBe(400);
  });

  it("creates local configuration without an automation repository or fork", async () => {
    const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
    const { url, root } = await start(packageRoot);
    const result = await post(`${url}/api/projects`, {
      project: "my-app",
      repo: "example/app",
    });
    expect(result.status).toBe(200);
    expect(
      JSON.parse(readFileSync(join(root, "hub.json"), "utf8")).runners.mode,
    ).toBe("local");
  });

  it("reports invalid startup arguments without opening a browser", async () => {
    const errors: string[] = [];
    for (const args of [
      ["--host", "0.0.0.0"],
      ["--port", "-1"],
      ["--port"],
      ["--no-open=false"],
      ["--lan=false"],
    ])
      expect(
        await runDashboard("unused", "unused", args, {
          log: () => {},
          error: (message) => errors.push(message),
        }),
      ).toBe(1);
    expect(errors).toHaveLength(5);
  });

  it("edits validated configuration through authenticated requests and rejects stale saves", async () => {
    const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
    const { root, url } = await start(packageRoot);
    await post(`${url}/api/projects`, {
      project: "demo",
      repo: "example/app",
      hubRepo: "example/hub",
    });
    writeFileSync(
      join(root, ".env"),
      "GITHUB_TOKEN=not-config-editor-content\n",
    );
    const listing = await (
      await fetch(`${url}/api/config`, { headers: auth })
    ).json();
    expect(listing).toMatchObject({
      files: expect.arrayContaining([
        { path: "hub.json", label: expect.any(String) },
      ]),
    });
    expect(JSON.stringify(listing)).not.toContain(".env");
    const document = (await (
      await fetch(`${url}/api/config?path=hub.json`, { headers: auth })
    ).json()) as { path: string; content: string; revision: string };
    const settings = JSON.parse(document.content);
    settings.runners.label = "reviewed-runner";
    const update = {
      ...document,
      content: JSON.stringify(settings, null, 2) + "\n",
    };
    const put = (payload: unknown, headers: Record<string, string> = auth) =>
      fetch(`${url}/api/config`, {
        method: "PUT",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    expect((await put(update, {})).status).toBe(401);
    expect((await put({ ...update, content: "{}" })).status).toBe(400);
    expect(readFileSync(join(root, "hub.json"), "utf8")).toBe(document.content);
    const saved = await put(update);
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({
      ok: true,
      revision: expect.any(String),
    });
    expect(
      JSON.parse(readFileSync(join(root, "hub.json"), "utf8")).runners.label,
    ).toBe("reviewed-runner");
    expect((await put(update)).status).toBe(409);
    for (const path of [
      ".env",
      "../package.json",
      "projects/_templates/project.json",
    ])
      expect([400, 404]).toContain(
        (
          await fetch(`${url}/api/config?path=${encodeURIComponent(path)}`, {
            headers: auth,
          })
        ).status,
      );
    expect((await post(`${url}/api/config`, update)).status).toBe(405);
  });

  it("reports broken config without hiding its editor, and never opens folders from LAN requests", async () => {
    const { root, url } = await start(undefined, ["192.168.1.20"]);
    writeFileSync(join(root, "hub.json"), "broken json");
    const response = await fetch(`${url}/api/status`, { headers: auth });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      hubRepo: null,
      configWarnings: [expect.stringContaining("hub.json")],
      runtime: { canOpenFolders: false },
    });
    const document = await fetch(`${url}/api/config?path=hub.json`, {
      headers: auth,
    });
    expect(document.status).toBe(200);
    expect(
      (await post(`${url}/api/open-folder`, { target: "configuration" }))
        .status,
    ).toBe(400);
    expect(
      (await post(`${url}/api/open-folder`, { target: "C:/Windows" })).status,
    ).toBe(400);
    expect(
      (await fetch(`${url}/api/open-folder`, { headers: auth })).status,
    ).toBe(405);
    expect(
      (
        await fetch(`${url}/api/open-folder`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: '{"target":"installation"}',
        })
      ).status,
    ).toBe(401);
  });

  it("stops promptly with an unfinished request and removes signal handlers", async () => {
    const root = temporary();
    const beforeInterrupt = process.listeners("SIGINT");
    const beforeTerminate = process.listeners("SIGTERM");
    let onReady!: (url: string) => void;
    const ready = new Promise<string>((done) => {
      onReady = done;
    });
    const running = runDashboard(root, root, ["--no-open"], {
      log: (line) => {
        const url = /http:\/\/127\.0\.0\.1:\d+\/#session=[a-f0-9]+/.exec(
          line,
        )?.[0];
        if (url) onReady(url);
      },
      error: () => {},
    });
    const url = new URL(await ready);
    const stop = process
      .listeners("SIGINT")
      .find((listener) => !beforeInterrupt.includes(listener))!;
    const req = request(`${url.origin}/api/connections`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${url.hash.slice("#session=".length)}`,
        "Content-Type": "application/json",
        "Content-Length": "1024",
      },
    });
    // A stalled body used to keep graceful shutdown open until requestTimeout.
    req.on("error", () => {});
    const connected = new Promise<void>((done) =>
      req.once("socket", (socket) => socket.once("connect", done)),
    );
    req.write("{");
    try {
      await connected;
      await new Promise<void>((done) => setImmediate(done));
      stop("SIGINT");
      expect(await running).toBe(0);
      expect(process.listeners("SIGINT")).toEqual(beforeInterrupt);
      expect(process.listeners("SIGTERM")).toEqual(beforeTerminate);
    } finally {
      req.destroy();
      if (process.listeners("SIGINT").includes(stop)) stop("SIGINT");
      await running;
    }
  });
});

describe("dashboard browser launch", () => {
  it.each([
    ["win32", "rundll32.exe", ["url.dll,FileProtocolHandler"]],
    ["darwin", "open", []],
    ["linux", "xdg-open", []],
  ] as const)(
    "opens the local capability URL without a shell on %s",
    (platform, command, prefix) => {
      const child = new ChildProcess();
      const launch = vi.fn(() => child);
      const logs: string[] = [];
      const url = `http://127.0.0.1:4311/#session=${session}`;
      openDashboardBrowser(
        url,
        { log: (line) => logs.push(line), error: () => {} },
        platform,
        launch as unknown as typeof spawn,
      );
      expect(launch).toHaveBeenCalledWith(command, [...prefix, url], {
        stdio: "ignore",
        detached: true,
        windowsHide: true,
      });
      child.emit("exit", 0, null);
      expect(logs).toEqual([]);
    },
  );

  it.each(["missing", "headless", "throws"])(
    "keeps a usable link when a browser launcher %s",
    (failure) => {
      const child = new ChildProcess();
      const logs: string[] = [];
      const launch = vi.fn(() => {
        if (failure === "throws") throw new Error("launcher failed");
        return child;
      });
      openDashboardBrowser(
        "http://127.0.0.1:4311/#session=private",
        { log: (line) => logs.push(line), error: () => {} },
        "linux",
        launch as unknown as typeof spawn,
      );
      if (failure === "missing") {
        child.emit("error", new Error("ENOENT"));
        child.emit("exit", 1, null);
      }
      if (failure === "headless") child.emit("exit", 3, null);
      expect(logs).toEqual([
        "No browser opened. On another device, restart with gremlins setup --lan, or use an SSH tunnel to the loopback address above.",
      ]);
    },
  );
});

describe("homelab network discovery", () => {
  it("lists private IPv4 interfaces once, excluding loopback and public addresses", () => {
    const addresses = [
      "192.168.1.20",
      "10.0.0.2",
      "172.16.0.4",
      "100.64.0.5",
      "127.0.0.1",
      "8.8.8.8",
      "172.32.0.1",
      "100.128.0.1",
      "192.168.1.20",
    ];
    expect(
      lanAddresses({
        ethernet: addresses.map((address) => ({
          address,
          family: "IPv4",
          internal: address === "127.0.0.1",
          netmask: "255.255.255.0",
          mac: "00:00:00:00:00:00",
          cidr: null,
        })),
      }),
    ).toEqual(["10.0.0.2", "100.64.0.5", "172.16.0.4", "192.168.1.20"]);
  });

  it("does not start a network listener when no private address exists", async () => {
    const errors: string[] = [];
    expect(
      await runDashboard(
        "unused",
        "unused",
        ["--lan"],
        { log: () => {}, error: (line) => errors.push(line) },
        () => [],
      ),
    ).toBe(1);
    expect(errors.join("\n")).toContain("No private LAN IPv4");
  });

  it("starts explicit LAN mode, prints reachable links, and shuts down", async () => {
    const root = temporary();
    const before = process.listeners("SIGINT");
    const logs: string[] = [];
    let ready!: (url: string) => void;
    const started = new Promise<string>((done) => {
      ready = done;
    });
    const running = runDashboard(
      root,
      root,
      ["--lan", "--port", "0"],
      {
        log: (line) => {
          logs.push(line);
          if (line.includes("/#session=")) ready(line.trim());
        },
        error: () => {},
      },
      () => ["192.168.1.20"],
    );
    const url = new URL(await started);
    const stop = process
      .listeners("SIGINT")
      .find((listener) => !before.includes(listener))!;
    try {
      expect(url.hostname).toBe("192.168.1.20");
      expect(url.port).not.toBe("0");
      const response = await fetch(`http://127.0.0.1:${url.port}/api/status`, {
        headers: {
          Authorization: `Bearer ${url.hash.slice("#session=".length)}`,
        },
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        runtime: { access: "lan", canOpenFolders: false },
      });
      expect(logs.join("\n")).not.toContain("0.0.0.0");
      expect(logs.join("\n")).toContain("LAN mode uses HTTP");
    } finally {
      stop("SIGINT");
      await running;
    }
  });
});

function fakeUpdater(): Updater & { state: UpdateStatus } {
  const updater = {
    state: {
      phase: "idle" as const,
      currentVersion: "0.2.2",
      installedVersion: "0.2.2",
      message: "Ready to check.",
      restartRequired: false,
      canRollback: false,
    } as UpdateStatus,
    status() {
      return { ...this.state };
    },
    check: vi.fn(async () => updater.status()),
    apply: vi.fn(async () => updater.status()),
    rollback: vi.fn(async () => updater.status()),
  };
  return updater;
}

describe("dashboard runtime updates", () => {
  it("requires session authentication, same origin, supported actions, and an empty body", async () => {
    const updater = fakeUpdater();
    const { url } = await start(undefined, [], { updater });
    expect((await fetch(`${url}/api/updates`)).status).toBe(401);
    expect(
      (await post(`${url}/api/updates/apply`, {}, { Authorization: "" }))
        .status,
    ).toBe(401);
    expect(
      (
        await post(
          `${url}/api/updates/apply`,
          {},
          { Origin: "https://evil.example" },
        )
      ).status,
    ).toBe(403);
    expect((await post(`${url}/api/updates`, {})).status).toBe(405);
    expect(
      (await fetch(`${url}/api/updates/apply`, { headers: auth })).status,
    ).toBe(405);
    expect((await post(`${url}/api/updates/delete`, {})).status).toBe(404);
    expect(
      (await post(`${url}/api/updates/apply`, { repository: "someone/else" }))
        .status,
    ).toBe(400);
    expect(updater.apply).not.toHaveBeenCalled();
    expect((await fetch(`${url}/api/updates`, { headers: auth })).status).toBe(
      200,
    );
    expect(updater.check).not.toHaveBeenCalled();
  });

  it("keeps the dashboard responsive during installation and prevents overlapping operations", async () => {
    const updater = fakeUpdater();
    let finish!: () => void;
    const installing = new Promise<void>((done) => {
      finish = done;
    });
    updater.apply = vi.fn(async () => {
      updater.state.phase = "installing";
      await installing;
      updater.state = {
        ...updater.state,
        phase: "ready",
        restartRequired: true,
        canRollback: true,
      };
      return updater.status();
    });
    const { url } = await start(undefined, ["192.168.1.20"], { updater });
    expect((await post(`${url}/api/updates/apply`, {})).status).toBe(202);
    expect(
      await (await fetch(`${url}/api/updates`, { headers: auth })).json(),
    ).toMatchObject({ phase: "installing", canRestart: false });
    expect((await fetch(`${url}/api/status`, { headers: auth })).status).toBe(
      200,
    );
    for (const action of ["apply", "check", "rollback", "restart"])
      expect((await post(`${url}/api/updates/${action}`, {})).status).toBe(409);
    finish();
    await vi.waitFor(async () => {
      expect(
        await (await fetch(`${url}/api/updates`, { headers: auth })).json(),
      ).toMatchObject({ phase: "ready", restartRequired: true });
    });
    expect(updater.apply).toHaveBeenCalledOnce();
  });

  it("returns safe errors and keeps the rest of the dashboard usable after an update fails", async () => {
    const updater = fakeUpdater();
    updater.apply = vi.fn(async () => {
      throw new Error("private-token-sensitive-output");
    });
    const { url } = await start(undefined, [], { updater });
    expect((await post(`${url}/api/updates/apply`, {})).status).toBe(202);
    const response = await fetch(`${url}/api/updates`, { headers: auth });
    const text = await response.text();
    expect(text).not.toContain("private-token");
    expect(JSON.parse(text)).toMatchObject({ phase: "error" });
    expect((await fetch(`${url}/api/status`, { headers: auth })).status).toBe(
      200,
    );
  });

  it("restarts only a supervised dashboard with a different selected runtime", async () => {
    const updater = fakeUpdater();
    const restart = vi.fn();
    const { url } = await start(undefined, [], { updater, restart });
    expect((await post(`${url}/api/updates/restart`, {})).status).toBe(409);
    updater.state.restartRequired = true;
    const response = await post(`${url}/api/updates/restart`, {});
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ ok: true, restarting: true });
    await vi.waitFor(() => expect(restart).toHaveBeenCalledOnce());
    const direct = await start(undefined, [], { updater });
    expect((await post(`${direct.url}/api/updates/restart`, {})).status).toBe(
      400,
    );
  });
});
