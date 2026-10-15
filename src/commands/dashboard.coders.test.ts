import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDashboardServer } from "./dashboard.ts";
import { initializeSetup } from "../setup/files.ts";
import {
  initializeCodingAgents,
  readCodingAgents,
  type CodingAgent,
} from "../codingAgents/index.ts";
import { loadProject } from "../config.ts";
import { readEditableConfig } from "../setup/configEditor.ts";
import type { LocalRunners } from "../localRunners/engine.ts";
import type { SourceControl } from "../sourceControl/types.ts";
import type { OAuthConnection } from "../oauthConnection/types.ts";
import type { createJobPreparation } from "../localRunners/jobs.ts";

const roots: string[] = [],
  servers: Server[] = [];
const session = "a".repeat(64);
afterEach(async () => {
  for (const server of servers.splice(0))
    await new Promise<void>((done) => {
      server.close(() => done());
      server.closeAllConnections();
    });
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});
async function fixture() {
  vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", undefined);
  vi.stubEnv("CODEX_AUTH_JSON", undefined);
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "gremlins-coders-http-")),
  );
  roots.push(root);
  initializeSetup(root, process.cwd(), {
    project: "demo",
    repo: "owner/app",
    settings: { workflow: { kind: "pull-request", baseBranch: "main" } },
  });
  const projectPath = join(root, "projects/demo/project.json"),
    areaPath = join(root, "projects/demo/areas.json");
  const project = JSON.parse(readFileSync(projectPath, "utf8"));
  project.verified = "2026-10-15";
  writeFileSync(projectPath, JSON.stringify(project));
  const areas = JSON.parse(readFileSync(areaPath, "utf8"));
  Object.assign(areas.areas.core, {
    enabled: false,
    codingEnabled: false,
    linearProjectId: randomUUID(),
    mandate: "Improve checkout with evidence.",
  });
  writeFileSync(areaPath, JSON.stringify(areas));
  writeFileSync(
    join(root, ".env"),
    "CLAUDE_CODE_OAUTH_TOKEN=synthetic-coder-connection\n",
  );
  initializeCodingAgents(root, "demo");
  const start = vi.fn(),
    enqueue = vi.fn(async (input) => ({ id: "job-synthetic", ...input }));
  const destructiveLock = vi.fn(
    async (_target: unknown, action: () => unknown) => action(),
  );
  const runners = {
    start,
    enqueue,
    stop: async () => {},
    jobs: async () => [],
    status: async () => ({
      runners: [
        {
          id: "worker-one",
          name: "Local",
          status: "ready",
          busy: false,
          paused: false,
          createdAt: "2026-10-15",
          verifiedAt: "2026-10-15",
        },
      ],
      jobs: [],
    }),
    withConfigurationMutation: destructiveLock,
  } as unknown as LocalRunners;
  const jobs = {
    validate: vi.fn(async (input) => ({
      project: loadProject(root, "demo"),
      area: loadProject(root, "demo").areas[0]!,
      coder: readCodingAgents(root, "demo").agents.find(
        (agent) => agent.key === input.coderKey,
      ),
      ticket: { id: "ticket-one", identifier: "APP-1" },
      linearBinding: { ticketId: "ticket-one", connectionId: "default" },
    })),
    selectDeveloperTicket: vi.fn(async (input) => ({
      ...input,
      ticket: "APP-1",
    })),
  } as unknown as ReturnType<typeof createJobPreparation>;
  const server = createDashboardServer(root, process.cwd(), session, [], {
    background: false,
    runners,
    jobs,
    sourceControl: {
      status: async () => [
        {
          provider: "github",
          serverUrl: "https://github.com",
          connected: true,
          available: true,
          method: "oauth",
        },
      ],
    } as unknown as SourceControl,
    linearConnection: {
      status: async () => ({
        provider: "linear",
        connected: true,
        available: true,
        method: "oauth",
      }),
    } as unknown as OAuthConnection,
  });
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = (
    path: string,
    input?: unknown,
    method = input === undefined ? "GET" : "PUT",
    auth = true,
  ) =>
    fetch(origin + path, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(auth ? { Authorization: `Bearer ${session}` } : {}),
      },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }),
    });
  const read = async () =>
    (await (await call("/api/projects/demo/coders")).json()) as {
      revision: string;
      agents: CodingAgent[];
      legacy: boolean;
    };
  return { root, call, read, start, enqueue, destructiveLock };
}
const draft = {
  key: "builder",
  name: "Checkout builder",
  enabled: false,
  areas: ["core"],
  maxConcurrent: 2,
  ai: { provider: "claude" as const, model: "sonnet" },
};
describe("separate coding agent HTTP contract", () => {
  it("lets owners pause a coder while queued work holds destructive configuration operations", async () => {
    const f = await fixture(),
      before = await f.read();
    expect(
      (
        await f.call("/api/projects/demo/coders", {
          revision: before.revision,
          agents: [{ ...draft, enabled: true }],
        })
      ).status,
    ).toBe(200);
    f.destructiveLock.mockImplementation(async () => {
      throw new Error("Queued or running work holds destructive changes.");
    });
    const current = readCodingAgents(f.root, "demo");
    const paused = await f.call("/api/projects/demo/coders", {
      revision: current.revision,
      agents: current.agents.map((agent) => ({ ...agent, enabled: false })),
    });
    expect(paused.status).toBe(200);
    expect(readCodingAgents(f.root, "demo").agents[0]!.enabled).toBe(false);
    expect(f.destructiveLock).not.toHaveBeenCalled();
  });
  it("requires readiness again when an enabled coder's queue was replaced", async () => {
    const f = await fixture(),
      before = await f.read();
    expect(
      (
        await f.call("/api/projects/demo/coders", {
          revision: before.revision,
          agents: [{ ...draft, enabled: true }],
        })
      ).status,
    ).toBe(200);
    const path = join(f.root, "projects/demo/areas.json"),
      areas = JSON.parse(readFileSync(path, "utf8"));
    areas.areas.core.instanceId = randomUUID();
    areas.areas.core.linearProjectId = "PASTE_LINEAR_PROJECT_ID";
    writeFileSync(path, JSON.stringify(areas));
    const current = readCodingAgents(f.root, "demo");
    const saved = await f.call("/api/projects/demo/coders", {
      revision: current.revision,
      agents: current.agents,
    });
    expect(saved.status).toBe(409);
    expect(await saved.json()).toMatchObject({
      error: expect.stringContaining("Linear"),
    });
  });
  it("creates named profiles with server identities and independent AI, then guards stale revisions", async () => {
    const f = await fixture(),
      before = await f.read();
    expect(before).toMatchObject({ agents: [], legacy: false });
    const saved = await f.call("/api/projects/demo/coders", {
      revision: before.revision,
      agents: [draft],
    });
    expect(saved.status).toBe(200);
    const view = (await saved.json()) as {
      agents: Array<
        CodingAgent & {
          effectiveAi: unknown;
          readiness: { canEnable: boolean };
        }
      >;
    };
    expect(view.agents[0]).toMatchObject({
      ...draft,
      instanceId: expect.any(String),
      effectiveAi: { provider: "claude", model: "sonnet", configured: true },
    });
    expect(view.agents[0]!.readiness.canEnable).toBe(true);
    expect(
      (
        await f.call("/api/projects/demo/coders", {
          revision: before.revision,
          agents: [],
        })
      ).status,
    ).toBe(409);
    expect(loadProject(f.root, "demo").areas[0]!.enabled).toBe(false);
  });
  it("allows disconnected paused drafts but refuses enabling their selected provider without fallback", async () => {
    const f = await fixture(),
      before = await f.read();
    const saved = await f.call("/api/projects/demo/coders", {
      revision: before.revision,
      agents: [{ ...draft, ai: { provider: "codex", model: "gpt-5.3-codex" } }],
    });
    expect(saved.status).toBe(200);
    const view = (await saved.json()) as {
      agents: Array<
        CodingAgent & {
          effectiveAi: unknown;
          readiness: { canEnable: boolean };
        }
      >;
    };
    expect(view.agents[0]).toMatchObject({
      effectiveAi: { provider: "codex", configured: false },
      readiness: { canEnable: false },
    });
    const current = await f.read();
    expect(
      (
        await f.call("/api/projects/demo/coders", {
          revision: current.revision,
          agents: current.agents.map((agent) => ({
            key: agent.key,
            instanceId: agent.instanceId,
            name: agent.name,
            enabled: true,
            areas: agent.areas,
            maxConcurrent: agent.maxConcurrent,
            ai: agent.ai,
          })),
        })
      ).status,
    ).toBe(409);
    expect(readCodingAgents(f.root, "demo").agents[0]!.enabled).toBe(false);
  });
  it("starts only the coder, binds manual runs and preserves individual intent through project pause", async () => {
    const f = await fixture(),
      before = await f.read();
    const response = await f.call("/api/projects/demo/coders", {
      revision: before.revision,
      agents: [{ ...draft, enabled: true }],
    });
    expect(response.status).toBe(200);
    const coder = readCodingAgents(f.root, "demo").agents[0]!;
    expect(loadProject(f.root, "demo").areas[0]!.enabled).toBe(false);
    expect(f.start).toHaveBeenCalled();
    const queued = await f.call(
      "/api/jobs",
      { type: "developer", project: "demo", coderKey: "builder" },
      "POST",
    );
    expect(queued.status).toBe(202);
    expect(f.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        coderKey: "builder",
        coderInstanceId: coder.instanceId,
        runOnce: true,
      }),
    );
    const pause = await f.call(
      "/api/projects/demo/autonomy",
      {
        enabled: false,
        revision: readEditableConfig(f.root, "projects/demo/areas.json")
          .revision,
        projectRevision: readEditableConfig(
          f.root,
          "projects/demo/project.json",
        ).revision,
      },
      "POST",
    );
    expect(pause.status).toBe(200);
    expect(loadProject(f.root, "demo").config.automationPaused).toBe(true);
    expect(readCodingAgents(f.root, "demo").agents[0]!.enabled).toBe(true);
    expect(loadProject(f.root, "demo").areas[0]!.enabled).toBe(false);
  });
  it("protects agent writes and rejects malformed profiles, credential material and PM coding toggles", async () => {
    const f = await fixture(),
      before = await f.read();
    expect(
      (await f.call("/api/projects/demo/coders", undefined, "GET", false))
        .status,
    ).toBe(401);
    expect((await f.call("/api/projects/demo/coders?other=true")).status).toBe(
      400,
    );
    for (const agents of [
      [{ ...draft, maxConcurrent: 10 }],
      [{ ...draft, areas: ["missing"] }],
      [
        {
          ...draft,
          ai: { provider: "claude", model: "synthetic-coder-connection" },
        },
      ],
      [{ ...draft, token: "credential" }],
    ])
      expect(
        (
          await f.call("/api/projects/demo/coders", {
            revision: before.revision,
            agents,
          })
        ).status,
      ).toBe(400);
    expect(
      (
        await f.call(
          "/api/projects/demo/areas/core/status",
          {
            enabled: false,
            codingEnabled: true,
            revision: readEditableConfig(f.root, "projects/demo/areas.json")
              .revision,
            projectRevision: readEditableConfig(
              f.root,
              "projects/demo/project.json",
            ).revision,
          },
          "POST",
        )
      ).status,
    ).toBe(400);
    expect(readCodingAgents(f.root, "demo").agents).toEqual([]);
  });
});
