import { afterEach, describe, expect, it, vi } from "vitest";
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
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { createDashboardServer } from "./dashboard.ts";
import { initializeSetup } from "../setup/files.ts";
import { loadProject } from "../config.ts";
import {
  createLinearProvisioning,
  type LinearProvisioningClient,
} from "../setup/linearProvisioning.ts";
import type { LinearProjectResource, LinearTeam } from "../services/linear.ts";
import type { LocalRunners } from "../localRunners/engine.ts";
import type { SourceControl } from "../sourceControl/types.ts";
import type { OAuthConnection } from "../oauthConnection/types.ts";

const roots: string[] = [],
  servers: Server[] = [];
const session = "a".repeat(64);
afterEach(async () => {
  for (const server of servers.splice(0))
    await new Promise<void>((resolve) => server.close(() => resolve()));
  vi.restoreAllMocks();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

async function fixture(
  options: {
    permissionDenied?: boolean;
    noWorker?: boolean;
    inaccessibleRepository?: boolean;
    disconnected?: boolean;
  } = {},
) {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "gremlins-pm-prepare-")),
  );
  roots.push(root);
  initializeSetup(root, process.cwd(), { project: "demo", repo: "owner/app" });
  writeFileSync(join(root, ".env"), "CLAUDE_CODE_OAUTH_TOKEN=synthetic-only\n");
  const workspace = { id: randomUUID(), name: "Selected workspace" };
  const teams = new Map<string, LinearTeam>(),
    projects = new Map<string, LinearProjectResource>();
  const client: LinearProvisioningClient = {
    organization: vi.fn(async () => workspace),
    getTeam: vi.fn(async (id) => teams.get(id) ?? null),
    getProject: vi.fn(async (id) => projects.get(id) ?? null),
    resources: vi.fn(async () => ({
      teams: [...teams.values()],
      projects: [...projects.values()],
    })),
    createTeam: vi.fn(async (input) => {
      const team = { id: input.id, name: input.name, key: input.key };
      teams.set(team.id, team);
      return team;
    }),
    createProject: vi.fn(async (input) => {
      const project = {
        id: input.id!,
        name: input.name,
        teamIds: [input.teamId],
        url: "https://linear.app/test/project/" + input.id,
        description: input.description,
        content: input.content,
        color: input.color,
        icon: input.icon,
      };
      projects.set(project.id, project);
      return project;
    }),
    updateProject: vi.fn(async (id, input) => {
      const project = projects.get(id)!;
      Object.assign(project, input);
      return project;
    }),
    ensureLabels: vi.fn(async () => {
      if (options.permissionDenied)
        throw new Error("forbidden Bearer private-linear-token");
    }),
  };
  const provisioning = createLinearProvisioning({
    root,
    client: async () => client,
  });
  await provisioning.addArea("demo", {
    key: "later",
    name: "Later",
    mandate: "An intentionally paused future PM.",
  });
  const sourceControl = {
    status: vi.fn(async () => [
      {
        provider: "github",
        serverUrl: "https://github.com",
        available: true,
        connected: true,
        method: "oauth",
      },
    ]),
    resolveCredential: vi.fn(async () => ({
      token: "private-source-token",
      method: "oauth",
    })),
  } as unknown as SourceControl;
  const linearConnection = {
    status: vi.fn(async () => ({
      provider: "linear",
      available: true,
      connected: !options.disconnected,
      method: "oauth",
      workspace,
    })),
    resolveCredential: vi.fn(async () => ({
      token: "private-linear-token",
      authorization: "Bearer private-linear-token",
      workspaceId: workspace.id,
      method: "oauth",
    })),
  } as unknown as OAuthConnection;
  const enqueue = vi.fn(async (input) => ({ id: "job-test", ...input }));
  const runners = {
    status: vi.fn(async () => ({
      runners: options.noWorker
        ? []
        : [
            {
              id: "worker-1",
              name: "Local",
              status: "ready",
              verifiedAt: "2026-10-05",
              paused: false,
            },
          ],
      jobs: [],
    })),
    jobs: vi.fn(async () => []),
    enqueue,
    start: vi.fn(),
    stop: vi.fn(async () => {}),
    withConfigurationMutation: async (
      _target: unknown,
      action: () => unknown,
    ) => action(),
  } as unknown as LocalRunners;
  const server = createDashboardServer(root, process.cwd(), session, [], {
    runners,
    sourceControl,
    linearConnection,
    linearProvisioning: provisioning,
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const nativeFetch = globalThis.fetch;
  const remote = vi.fn(async (target: string, init?: RequestInit) => {
    if (target.startsWith("https://api.github.com/"))
      return Response.json(
        {},
        { status: options.inaccessibleRepository ? 403 : 200 },
      );
    if (target === "https://api.linear.app/graphql") {
      const request = JSON.parse(String(init?.body)) as {
        query: string;
        variables: { id: string };
      };
      const project = projects.get(request.variables.id);
      if (request.query.includes("GremlinsProject"))
        return Response.json({
          data: {
            projects: {
              nodes: project
                ? [
                    {
                      ...project,
                      teams: { nodes: project.teamIds.map((id) => ({ id })) },
                    },
                  ]
                : [],
            },
          },
        });
      return Response.json({ data: { project: project ?? null } });
    }
    throw new Error(`Unexpected external request: ${target}`);
  });
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const target = String(input);
    return target.startsWith(url)
      ? nativeFetch(input, init)
      : remote(target, init);
  });
  const run = async (pmMode?: "exploration") =>
    fetch(`${url}/api/jobs`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${session}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        type: "pm",
        project: "demo",
        area: "core",
        ...(pmMode ? { pmMode } : {}),
      }),
    });
  return {
    root,
    client,
    provisioning,
    enqueue,
    remote,
    run,
    projects,
    workspace,
    post: (path: string, input: unknown) =>
      fetch(url + path, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${session}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(input),
      }),
  };
}

describe("PM prepare and verify admission", () => {
  it("saves adoption without remote mutations when the selected Linear connection is missing", async () => {
    const f = await fixture({ disconnected: true });
    const response = await f.post("/api/projects/demo/areas", {
      key: "investigator",
      name: "App investigator",
      mandate: "Understand the real app.",
    });
    const saved = loadProject(f.root, "demo");
    expect(await response.json()).toMatchObject({
      ok: true,
      projectInstanceId: saved.config.instanceId ?? null,
      areaInstanceId:
        saved.areas.find((area) => area.key === "investigator")!.instanceId ??
        null,
      linear: { status: "needs-connection" },
    });
    expect(
      loadProject(f.root, "demo").areas.find(
        (area) => area.key === "investigator",
      ),
    ).toMatchObject({
      enabled: false,
      linearProjectId: "PASTE_LINEAR_PROJECT_ID",
    });
    expect(f.client.organization).not.toHaveBeenCalled();
    expect(f.enqueue).not.toHaveBeenCalled();
  });
  it("automatically prepares a newly adopted PM even when its imported app has no Linear mapping", async () => {
    const f = await fixture();
    expect(loadProject(f.root, "demo").config.linear).toBeUndefined();
    const response = await f.post("/api/projects/demo/areas", {
      key: "investigator",
      name: "App investigator",
      mandate: "Understand the existing app and preserve its workflows.",
    });
    expect(response.status).toBe(200);
    const project = loadProject(f.root, "demo"),
      adopted = project.areas.find((area) => area.key === "investigator")!;
    expect(await response.json()).toMatchObject({
      ok: true,
      projectInstanceId: project.config.instanceId ?? null,
      areaInstanceId: adopted.instanceId ?? null,
      linear: { status: "ready" },
    });
    expect(adopted).toMatchObject({ enabled: false, codingEnabled: false });
    expect(adopted.linearProjectId).not.toBe("PASTE_LINEAR_PROJECT_ID");
    expect(
      project.areas
        .filter((area) => area.key !== "investigator")
        .every((area) => area.linearProjectId === "PASTE_LINEAR_PROJECT_ID"),
    ).toBe(true);
    expect(f.client.createTeam).toHaveBeenCalledTimes(1);
    expect(f.client.createProject).toHaveBeenCalledTimes(1);
    expect(f.client.ensureLabels).toHaveBeenCalledWith(
      project.config.linear!.teamId,
      ["pm:investigator", "pm-proposal"],
    );
    const restarted = createLinearProvisioning({
      root: f.root,
      client: async () => f.client,
    });
    await restarted.provision("demo", { areaKey: "investigator" });
    expect(f.client.createTeam).toHaveBeenCalledTimes(1);
    expect(f.client.createProject).toHaveBeenCalledTimes(1);
    expect(f.enqueue).not.toHaveBeenCalled();
  });
  it("keeps adoption saved and reports actual missing connection or provider permission failures", async () => {
    const f = await fixture({ permissionDenied: true });
    const response = await f.post("/api/projects/demo/areas", {
      key: "investigator",
      name: "App investigator",
      mandate: "Understand the real app.",
    });
    expect(response.status).toBe(200);
    const saved = (await response.json()) as {
      ok: boolean;
      linear: { status: string; message: string };
    };
    expect(saved).toMatchObject({ ok: true, linear: { status: "error" } });
    expect(saved.linear.message).toContain("read and create issue labels");
    expect(JSON.stringify(saved)).not.toContain("private-linear-token");
    expect(
      loadProject(f.root, "demo").areas.find(
        (area) => area.key === "investigator",
      ),
    ).toBeDefined();
    expect(f.enqueue).not.toHaveBeenCalled();
  });
  it.each([undefined, "exploration"] as const)(
    "prepares selected PM mappings, verifies real access, and admits %s through normal validation",
    async (mode) => {
      const f = await fixture();
      const response = await f.run(mode);
      expect(await response.json()).toMatchObject({
        job: {
          id: "job-test",
          type: "pm",
          area: "core",
          runOnce: true,
          ...(mode ? { pmMode: mode } : {}),
        },
      });
      expect(response.status).toBe(202);
      const project = loadProject(f.root, "demo");
      expect(project.config.verified).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(project.config.linear).toMatchObject({
        workspaceId: f.workspace.id,
      });
      expect(project.areas.find((area) => area.key === "later")).toMatchObject({
        enabled: false,
        linearProjectId: "PASTE_LINEAR_PROJECT_ID",
      });
      expect(f.client.ensureLabels).toHaveBeenCalledExactlyOnceWith(
        project.config.linear!.teamId,
        ["pm:core", "pm-proposal"],
      );
      expect(f.client.createProject).toHaveBeenCalledTimes(1);
      expect(f.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          linearBinding: {
            connectionId: "default",
            workspaceId: f.workspace.id,
          },
          discoveryRevision: expect.any(String),
        }),
      );
      expect(
        f.remote.mock.calls.some(([, init]) =>
          String(init?.body).includes("GremlinsProject"),
        ),
      ).toBe(true);
      await f.run(mode);
      expect(f.client.createProject).toHaveBeenCalledTimes(1);
    },
  );
  it("reports label permissions without credentials and keeps retries bound to the saved team", async () => {
    const f = await fixture({ permissionDenied: true });
    const response = await f.run();
    const body = JSON.stringify(await response.json());
    expect(response.status).toBe(409);
    expect(body).toContain("read and create issue labels");
    expect(body).not.toContain("private-linear-token");
    expect(f.enqueue).not.toHaveBeenCalled();
    expect(loadProject(f.root, "demo").config.verified).toBeNull();
    expect(f.client.createTeam).toHaveBeenCalledTimes(1);
    vi.mocked(f.client.ensureLabels!).mockResolvedValue(undefined);
    expect((await f.run()).status).toBe(202);
    expect(f.client.createTeam).toHaveBeenCalledTimes(1);
    expect(f.client.createProject).toHaveBeenCalledTimes(1);
  });
  it("does not create Linear resources while no eligible worker exists", async () => {
    const f = await fixture({ noWorker: true });
    const response = await f.run();
    expect(response.status).toBe(409);
    expect(JSON.stringify(await response.json())).toContain("worker");
    expect(f.client.organization).not.toHaveBeenCalled();
    expect(f.enqueue).not.toHaveBeenCalled();
  });
  it("keeps access verification failures unverified and never admits the job", async () => {
    const f = await fixture({ inaccessibleRepository: true });
    const response = await f.run();
    expect(response.status).toBe(409);
    expect(JSON.stringify(await response.json())).toContain(
      "PM setup needs attention",
    );
    expect(f.enqueue).not.toHaveBeenCalled();
    expect(loadProject(f.root, "demo").config.verified).toBeNull();
    expect(
      JSON.parse(readFileSync(join(f.root, "projects/demo/areas.json"), "utf8"))
        .areas.core.linearProjectId,
    ).not.toBe("PASTE_LINEAR_PROJECT_ID");
  });
});
