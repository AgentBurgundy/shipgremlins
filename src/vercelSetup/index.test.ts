import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
import { initializeSetup } from "../setup/files.ts";
import { createVercelSetup } from "./index.ts";
import { createVercelSetupStore } from "./store.ts";
import { deploymentSummary, projectSummary } from "./provider.ts";
import { createVercelApi, paginated } from "./provider.ts";
import { loadProject } from "../config.ts";
import type { VercelInventory } from "./types.ts";

const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
const SHA = "a".repeat(40),
  OTHER = "b".repeat(40),
  VERCEL = "private-vercel-token",
  SOURCE = "private-source-token";
let root: string;
const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });
beforeEach(() => {
  root = mkdtempSync(join(realpathSync(tmpdir()), "gremlins-vercel-setup-"));
  initializeSetup(root, packageRoot, {
    project: "app",
    repo: "owner/app",
    settings: { workflow: { kind: "pull-request", baseBranch: "main" } },
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const project = {
    id: "prj_app",
    name: "app",
    rootDirectory: "apps/web",
    link: {
      type: "github",
      org: "owner",
      repo: "app",
      repoId: 123,
      productionBranch: "main",
    },
    customEnvironments: [{ id: "env_stage", slug: "staging" }],
    env: [{ key: "SECRET", value: "do-not-store-me" }],
  };
  const branches = new Map([["main", SHA]]);
  const deployment = {
    id: "dpl_new",
    projectId: "prj_app",
    url: "app-pm-staging.vercel.app",
    readyState: "READY",
    target: null,
    meta: { githubCommitRef: "pm-staging", githubCommitSha: SHA } as Record<
      string,
      string
    >,
    createdAt: Date.now(),
    customEnvironment: undefined as { id: string } | undefined,
  };
  let listed: unknown[] = [];
  let loseCreate = false;
  let hideCreated = false;
  let createStatus = 200;
  let branchStatus = 201;
  const calls: { url: URL; method: string; body: Record<string, unknown> }[] =
    [];
  const fetcher = vi.fn(
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input)),
        method = init?.method ?? "GET",
        body = JSON.parse(String(init?.body ?? "{}"));
      calls.push({ url, method, body });
      expect(init?.redirect).toBe("error");
      expect(init?.headers).toMatchObject({
        authorization: `Bearer ${url.hostname === "api.vercel.com" ? VERCEL : SOURCE}`,
      });
      if (url.hostname === "api.vercel.com") {
        expect(url.searchParams.get("teamId")).toBe("team_test");
        if (url.pathname === "/v9/projects")
          return response({
            projects: [
              project,
              {
                ...project,
                id: "prj_other",
                name: "other-app",
                link: { ...project.link, repo: "unrelated" },
              },
            ],
          });
        if (url.pathname === "/v9/projects/prj_app") return response(project);
        if (url.pathname === "/v6/deployments")
          return response({ deployments: listed });
        if (url.pathname === "/v13/deployments" && method === "POST") {
          if (createStatus !== 200) return response({}, createStatus);
          Object.assign(deployment.meta, body.meta);
          if (body.customEnvironmentSlugOrId)
            deployment.customEnvironment = {
              id: body.customEnvironmentSlugOrId,
            };
          if (!hideCreated) listed = [deployment];
          if (loseCreate) throw new Error(`transport lost ${VERCEL}`);
          return response({ id: deployment.id });
        }
        if (url.pathname === "/v13/deployments/dpl_new")
          return response(deployment);
      }
      if (url.hostname === "api.github.com") {
        const branch = decodeURIComponent(
          url.pathname.split("/git/ref/heads/")[1] ?? "",
        );
        if (branch)
          return branches.has(branch)
            ? response({ object: { sha: branches.get(branch) } })
            : response({}, 404);
        if (url.pathname.endsWith("/git/refs") && method === "POST") {
          if (branchStatus !== 201) return response({}, branchStatus);
          branches.set(body.ref.replace("refs/heads/", ""), body.sha);
          return response({ object: { sha: body.sha } }, 201);
        }
      }
      throw new Error(`Unexpected request ${method} ${url}`);
    },
  );
  const connection = vi.fn(async () => ({
    token: VERCEL,
    authorization: `Bearer ${VERCEL}`,
    method: "token" as const,
    teamId: "team_test",
  }));
  const source = vi.fn(async () => ({
    token: SOURCE,
    method: "token" as const,
  }));
  const create = () =>
    createVercelSetup({
      root,
      packageRoot,
      fetch: fetcher,
      sourceControl: { resolveCredential: source },
      vercelConnectionFor: () => ({ resolveCredential: connection }),
    });
  const service = create();
  const discover = () =>
    service.discover("app", {
      connectionId: "work",
      teamId: "team_test",
      projectId: "prj_app",
    });
  const prepare = async () =>
    service.prepare("app", { revision: (await discover()).revision });
  return {
    service,
    create,
    discover,
    prepare,
    project,
    branches,
    deployment,
    calls,
    source,
    connection,
    fetcher,
    setListed(value: unknown[]) {
      listed = value;
    },
    loseCreate() {
      loseCreate = true;
    },
    hideCreated() {
      hideCreated = true;
    },
    rejectCreate(status: number) {
      createStatus = status;
    },
    rejectBranch(status: number) {
      branchStatus = status;
    },
  };
}
describe("Vercel setup", () => {
  it("repairs an existing direct-PR project into isolated staging, preserving commands and schedules", async () => {
    const f = fixture();
    const path = join(root, "projects/app/project.json");
    const legacy = JSON.parse(readFileSync(path, "utf8"));
    legacy.branches = {
      production: "main",
      staging: "main",
      integration: "main",
    };
    writeFileSync(path, JSON.stringify(legacy));
    const areasBefore = readFileSync(
      join(root, "projects/app/areas.json"),
      "utf8",
    );
    const commands = loadProject(root, "app").config.commands;
    const plan = await f.service.prepare("app", {
      revision: (await f.discover()).revision,
      repairWorkflow: true,
    });
    expect(plan.plan).toMatchObject({
      branch: "pm-staging",
      baseBranch: "staging",
      createBranch: true,
      staging: { branch: "staging", sha: SHA, create: true },
    });
    expect(f.calls.filter((c) => c.method === "POST")).toEqual([]);
    const deployed = await f.service.deploy("app", {
      revision: plan.revision,
      confirmTestData: true,
    });
    expect(f.branches.get("main")).toBe(SHA);
    expect(f.branches.get("staging")).toBe(SHA);
    expect(f.branches.get("pm-staging")).toBe(SHA);
    const applied = await f.service.applyWorkflow("app", deployed.revision);
    const config = loadProject(root, "app").config;
    expect(config.workflow).toEqual({ kind: "promotion" });
    expect(config.branches).toEqual({
      production: "main",
      staging: "staging",
      integration: "pm-staging",
    });
    expect(config.verification).toEqual({
      mode: "browser",
      environment: "pm-staging",
    });
    expect(config.environments?.["pm-staging"]).toMatchObject({
      kind: "vercel",
      branch: "pm-staging",
      projectId: "prj_app",
      connectionId: "work",
    });
    expect(config.commands).toEqual(commands);
    expect(config.verified).toBeNull();
    expect(readFileSync(join(root, "projects/app/areas.json"), "utf8")).toBe(
      areasBefore,
    );
    expect(applied.workflowApplied).toBe(true);
    expect(applied.stale).toBe(false);
    await f.create().applyWorkflow("app", applied.revision);
    expect(
      f.calls.filter(
        (c) => c.method === "POST" && c.url.pathname.endsWith("/git/refs"),
      ),
    ).toHaveLength(2);
    expect(
      f.calls.filter(
        (c) => c.method === "POST" && c.url.pathname === "/v13/deployments",
      ),
    ).toHaveLength(1);
  });
  it("starts PM staging from existing staging without moving normal development", async () => {
    const f = fixture();
    f.branches.set("staging", OTHER);
    f.deployment.meta.githubCommitSha = OTHER;
    const plan = await f.service.prepare("app", {
      revision: (await f.discover()).revision,
      repairWorkflow: true,
    });
    expect(plan.plan).toMatchObject({
      sha: OTHER,
      staging: { create: false, sha: OTHER },
    });
    await f.service.deploy("app", {
      revision: plan.revision,
      confirmTestData: true,
    });
    expect(f.branches.get("staging")).toBe(OTHER);
    expect(f.branches.get("main")).toBe(SHA);
    expect(f.branches.get("pm-staging")).toBe(OTHER);
    expect(
      f.calls
        .filter(
          (c) => c.method === "POST" && c.url.pathname.endsWith("/git/refs"),
        )
        .map((c) => c.body.ref),
    ).toEqual(["refs/heads/pm-staging"]);
  });
  it("detects a non-main production branch for new promotion projects", async () => {
    const f = fixture();
    const path = join(root, "projects/app/project.json");
    const config = JSON.parse(readFileSync(path, "utf8"));
    config.workflow = { kind: "promotion" };
    writeFileSync(path, JSON.stringify(config));
    f.project.link.productionBranch = "production";
    f.branches.delete("main");
    f.branches.set("production", SHA);
    const plan = await f.prepare();
    expect(plan.plan?.workflowBranches).toEqual({
      production: "production",
      staging: "staging",
      integration: "pm-staging",
    });
    const deployed = await f.service.deploy("app", {
      revision: plan.revision,
      confirmTestData: true,
    });
    await f.service.applyWorkflow("app", deployed.revision);
    expect(loadProject(root, "app").config.branches.production).toBe(
      "production",
    );
    expect(f.branches.get("production")).toBe(SHA);
  });
  it("holds repair when staging moves and never resets either existing branch", async () => {
    const f = fixture();
    const plan = await f.service.prepare("app", {
      revision: (await f.discover()).revision,
      repairWorkflow: true,
    });
    f.branches.set("staging", OTHER);
    await expect(
      f.service.deploy("app", {
        revision: plan.revision,
        confirmTestData: true,
      }),
    ).rejects.toThrow("Staging moved");
    expect(f.calls.filter((c) => c.method === "POST")).toEqual([]);
    expect(f.branches.get("staging")).toBe(OTHER);
  });
  it("does not migrate configuration for a failed deployment or changed production mapping", async () => {
    const f = fixture();
    const plan = await f.service.prepare("app", {
      revision: (await f.discover()).revision,
      repairWorkflow: true,
    });
    const deployed = await f.service.deploy("app", {
      revision: plan.revision,
      confirmTestData: true,
    });
    f.project.link.productionBranch = "pm-staging";
    await expect(
      f.service.applyWorkflow("app", deployed.revision),
    ).rejects.toThrow("mapping changed");
    expect(loadProject(root, "app").config.workflow?.kind).toBe("pull-request");
  });
  it("preserves a realistic bounded 500-project and 500-deployment inventory", async () => {
    const f = fixture();
    f.setListed([f.deployment]);
    await f.discover();
    const store = createVercelSetupStore(root),
      initial = store.read("app")!;
    const project = initial.inventory!.selectedProject!,
      deployment = initial.inventory!.deployments[0]!;
    await store.change("app", (current) => {
      current!.inventory!.projects = Array.from({ length: 500 }, (_, i) => ({
        ...project,
        id: `prj_${i}`,
        name: `customer-application-${i}-preview-control-dashboard`,
        repository: `organization-${i}/customer-application-web-preview-dashboard`,
        rootDirectory: `applications/customer-${i}/website/dashboard`,
        customEnvironments: [
          { id: `env_${i}_staging`, slug: "staging" },
          { id: `env_${i}_qa`, slug: "quality-assurance" },
        ],
      }));
      current!.inventory!.deployments = Array.from({ length: 500 }, (_, i) => ({
        ...deployment,
        id: `dpl_${i}`,
        branch: `gremlins/feature-preview-${i}`,
        url: `https://customer-application-preview-${i}-staging.vercel.app`,
      }));
      return { state: current!, result: undefined };
    });
    const saved = readFileSync(
      join(root, ".run/vercel-setup/app.json"),
      "utf8",
    );
    expect(Buffer.byteLength(saved)).toBeGreaterThan(256 * 1024);
    expect(Buffer.byteLength(saved)).toBeLessThan(1024 * 1024);
    const read = await f.service.status("app");
    expect(read.inventory?.projects).toHaveLength(500);
    expect(read.inventory?.deployments).toHaveLength(500);
  });
  it("bounds paginated inventory and keeps arbitrary provider cursors off request URLs", async () => {
    const calls: string[] = [];
    const api = createVercelApi(
      async (input) => {
        calls.push(String(input));
        return response({
          projects: [{ id: `prj_${calls.length}` }],
          pagination: { next: calls.length },
        });
      },
      VERCEL,
      "team_test",
      AbortSignal.timeout(1000),
    );
    const result = await paginated(api, "/v9/projects", "projects");
    expect(result.truncated).toBe(true);
    expect(calls).toHaveLength(5);
    const unsafe = createVercelApi(
      async () =>
        response({
          projects: [],
          pagination: { next: "https://evil.example/?token=x" },
        }),
      VERCEL,
      undefined,
      AbortSignal.timeout(1000),
    );
    expect(
      (await paginated(unsafe, "/v9/projects", "projects")).truncated,
    ).toBe(true);
  });
  it("registers busy before yielding and refuses overlapping project mutations", async () => {
    const f = fixture();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.fetcher.mockImplementationOnce(async () => {
      await gate;
      return response({ projects: [f.project] });
    });
    const first = f.service.discover("app", { connectionId: "work" });
    expect(f.service.busy("app")).toBe(true);
    await expect(f.service.discover("app", {})).rejects.toMatchObject({
      code: "busy",
    });
    release();
    await first;
    await f.service.idle();
    expect(f.service.busy("app")).toBe(false);
  });
  it("only offers the newest deployment for each branch and custom environment", async () => {
    const f = fixture();
    f.setListed([
      { ...f.deployment, createdAt: 100 },
      {
        ...f.deployment,
        id: "dpl_latest",
        createdAt: 200,
        readyState: "ERROR",
      },
    ]);
    const state = await f.discover();
    expect(
      state.inventory?.deployments.every((value) => !value.selectable),
    ).toBe(true);
    expect(
      state.inventory?.deployments.find((value) => value.id === "dpl_new")
        ?.reason,
    ).toContain("newer deployment");
  });
  it("can retry after a definite deployment permission rejection", async () => {
    const f = fixture(),
      plan = await f.prepare();
    f.rejectCreate(403);
    await expect(
      f.service.deploy("app", {
        revision: plan.revision,
        confirmTestData: true,
      }),
    ).rejects.toMatchObject({ code: "provider_rejected" });
    expect(
      createVercelSetupStore(root).read("app")?.attempt?.deploymentSent,
    ).toBeUndefined();
    f.rejectCreate(200);
    const done = await f.service.deploy("app", {
      revision: (await f.service.status("app")).revision,
      confirmTestData: true,
    });
    expect(done.target?.projectId).toBe("prj_app");
    expect(
      f.calls.filter(
        (value) =>
          value.url.pathname.endsWith("/git/refs") && value.method === "POST",
      ),
    ).toHaveLength(1);
  });
  it("can retry after a definite source branch permission rejection", async () => {
    const f = fixture(),
      plan = await f.prepare();
    f.rejectBranch(403);
    await expect(
      f.service.deploy("app", {
        revision: plan.revision,
        confirmTestData: true,
      }),
    ).rejects.toThrow();
    expect(
      createVercelSetupStore(root).read("app")?.attempt?.branchSent,
    ).toBeUndefined();
    f.rejectBranch(201);
    expect(
      (
        await f.service.deploy("app", {
          revision: (await f.service.status("app")).revision,
          confirmTestData: true,
        })
      ).target?.projectId,
    ).toBe("prj_app");
  });
  it("discovers explicit account resources without reading env values or claiming deployment verification", async () => {
    const f = fixture();
    f.setListed([
      f.deployment,
      {
        ...f.deployment,
        id: "dpl_production",
        target: "production",
        meta: { githubCommitRef: "main", githubCommitSha: SHA },
      },
      {
        ...f.deployment,
        id: "dpl_custom",
        customEnvironment: { id: "env_stage" },
      },
    ]);
    const state = await f.discover();
    expect(state.inventory).toMatchObject({
      connectionId: "work",
      teamId: "team_test",
      selectedProject: {
        matchesRepository: true,
        rootDirectory: "apps/web",
        productionBranch: "main",
      },
    });
    expect(state.inventory!.projects[1]!.matchesRepository).toBe(false);
    expect(
      state.inventory!.deployments.find(
        (value) => value.id === "dpl_production",
      ),
    ).toMatchObject({ selectable: false, environment: "production" });
    expect(
      state.inventory!.deployments.find((value) => value.id === "dpl_custom")
        ?.target,
    ).toMatchObject({
      customEnvironmentId: "env_stage",
      connectionId: "work",
      teamId: "team_test",
    });
    expect(JSON.stringify(state)).not.toMatch(
      /do-not-store-me|private-vercel-token|private-source-token/,
    );
    expect(
      readFileSync(join(root, ".run/vercel-setup/app.json"), "utf8"),
    ).not.toContain("do-not-store-me");
    expect(f.source).not.toHaveBeenCalled();
    expect(f.calls.every((call) => call.method === "GET")).toBe(true);
  });
  it("never automatically selects a same-repository monorepo project", async () => {
    const f = fixture();
    const state = await f.service.discover("app", {
      connectionId: "work",
      teamId: "team_test",
    });
    expect(state.inventory?.selectedProject).toBeUndefined();
    expect(f.calls).toHaveLength(1);
  });
  it("prepares without writes then creates only the reviewed source branch and preview", async () => {
    const f = fixture(),
      prepared = await f.prepare();
    expect(prepared.plan).toMatchObject({
      branch: "pm-staging",
      baseBranch: "main",
      sha: SHA,
      createBranch: true,
    });
    expect(f.calls.every((call) => call.method === "GET")).toBe(true);
    await expect(
      f.service.deploy("app", {
        revision: prepared.revision,
        confirmTestData: false,
      }),
    ).rejects.toThrow("test data");
    const done = await f.service.deploy("app", {
      revision: prepared.revision,
      confirmTestData: true,
    });
    expect(done.target).toMatchObject({
      kind: "vercel",
      branch: "pm-staging",
      projectId: "prj_app",
      connectionId: "work",
    });
    const writes = f.calls.filter((call) => call.method === "POST");
    expect(writes).toHaveLength(2);
    expect(writes[0]!.body).toEqual({ ref: "refs/heads/pm-staging", sha: SHA });
    expect(writes[1]!.body).toMatchObject({
      project: "prj_app",
      gitSource: { type: "github", repoId: "123", ref: "pm-staging", sha: SHA },
      meta: { shipgremlinsSetupOperation: expect.any(String) },
    });
    expect(writes[1]!.body).not.toHaveProperty("target");
    expect(writes[1]!.body).not.toHaveProperty("env");
    await f.service.deploy("app", {
      revision: done.revision,
      confirmTestData: true,
    });
    expect(f.calls.filter((call) => call.method === "POST")).toHaveLength(2);
  });
  it("rejects stale configuration and source branch commits before any mutation", async () => {
    const f = fixture(),
      prepared = await f.prepare();
    f.branches.set("main", OTHER);
    await expect(
      f.service.deploy("app", {
        revision: prepared.revision,
        confirmTestData: true,
      }),
    ).rejects.toMatchObject({ code: "stale" });
    expect(f.calls.filter((call) => call.method === "POST")).toHaveLength(0);
    const current = await f.service.status("app");
    const file = join(root, "projects/app/project.json"),
      config = JSON.parse(readFileSync(file, "utf8"));
    config.commands.test = "npm test -- --changed";
    writeFileSync(file, JSON.stringify(config));
    await expect(
      f.service.deploy("app", {
        revision: current.revision,
        confirmTestData: true,
      }),
    ).rejects.toMatchObject({ code: "stale" });
  });
  it("rejects production branch, another team and stale review revision", async () => {
    const f = fixture();
    await expect(
      f.service.discover("app", { teamId: "team_other", projectId: "prj_app" }),
    ).rejects.toMatchObject({ status: 403 });
    expect(f.fetcher).not.toHaveBeenCalled();
    const state = await f.discover();
    await expect(
      f.service.prepare("app", { revision: state.revision, branch: "main" }),
    ).rejects.toThrow("nonproduction");
    await expect(
      f.service.prepare("app", { revision: state.revision }),
    ).rejects.toMatchObject({ code: "stale" });
    expect(f.calls.every((call) => call.method === "GET")).toBe(true);
  });
  it("reconciles an accepted deployment after a lost response across controller restart", async () => {
    const f = fixture(),
      prepared = await f.prepare();
    f.loseCreate();
    await expect(
      f.service.deploy("app", {
        revision: prepared.revision,
        confirmTestData: true,
      }),
    ).rejects.toMatchObject({ code: "provider_response" });
    await f.service.close();
    const restarted = f.create(),
      recovered = await restarted.status("app");
    expect(recovered.deployment?.id).toBe("dpl_new");
    expect(recovered.target?.branch).toBe("pm-staging");
    expect(
      f.calls.filter(
        (call) =>
          call.url.pathname === "/v13/deployments" && call.method === "POST",
      ),
    ).toHaveLength(1);
    expect(JSON.stringify(recovered)).not.toContain(VERCEL);
    await restarted.close();
  });
  it("does not repeat an ambiguous deployment or allow inventory reset to forget it", async () => {
    const f = fixture(),
      prepared = await f.prepare();
    f.loseCreate();
    f.hideCreated();
    await expect(
      f.service.deploy("app", {
        revision: prepared.revision,
        confirmTestData: true,
      }),
    ).rejects.toThrow();
    const current = await f.service.status("app");
    await expect(
      f.service.deploy("app", {
        revision: current.revision,
        confirmTestData: true,
      }),
    ).rejects.toMatchObject({ code: "unconfirmed" });
    await expect(f.discover()).rejects.toMatchObject({ code: "unconfirmed" });
    expect(
      f.calls.filter(
        (call) =>
          call.url.pathname === "/v13/deployments" && call.method === "POST",
      ),
    ).toHaveLength(1);
  });
  it("refreshes building deployments but never marks them selectable early", async () => {
    const f = fixture(),
      prepared = await f.prepare();
    f.deployment.readyState = "BUILDING";
    const building = await f.service.deploy("app", {
      revision: prepared.revision,
      confirmTestData: true,
    });
    expect(building.target).toBeUndefined();
    expect(building.deployment?.selectable).toBe(false);
    f.deployment.readyState = "READY";
    expect((await f.service.status("app")).target?.projectId).toBe("prj_app");
  });
  it("deploys only to a custom environment observed on the selected project", async () => {
    const f = fixture(),
      found = await f.discover();
    const planned = await f.service.prepare("app", {
      revision: found.revision,
      customEnvironmentId: "env_stage",
    });
    const result = await f.service.deploy("app", {
      revision: planned.revision,
      confirmTestData: true,
    });
    expect(result.target?.customEnvironmentId).toBe("env_stage");
    expect(
      f.calls.find(
        (call) =>
          call.url.pathname === "/v13/deployments" && call.method === "POST",
      )?.body.customEnvironmentSlugOrId,
    ).toBe("env_stage");
  });
  it("rejects deployment detail switching to production or an unrelated commit", async () => {
    const f = fixture(),
      planned = await f.prepare();
    f.deployment.meta.githubCommitSha = OTHER;
    await expect(
      f.service.deploy("app", {
        revision: planned.revision,
        confirmTestData: true,
      }),
    ).rejects.toMatchObject({ code: "deployment_mismatch" });
    expect((await f.service.status("app")).target).toBeUndefined();
  });
  it("scopes persisted plans to a recreated project's incarnation", async () => {
    const f = fixture();
    await f.prepare();
    const path = join(root, "projects/app/project.json"),
      config = JSON.parse(readFileSync(path, "utf8"));
    config.instanceId = "cc9bf427-bbbb-4b87-9faf-405a16c8da87";
    writeFileSync(path, JSON.stringify(config));
    expect((await f.service.status("app")).plan).toBeUndefined();
    expect(createVercelSetupStore(root).read("app")).toBeUndefined();
  });
  it("treats malicious custom environment metadata and unknown targets as unselectable", () => {
    const f = fixture(),
      config = loadProject(root, "app").config;
    const project = projectSummary(f.project, config)!;
    const inventory: VercelInventory = {
      connectionId: "work",
      projects: [project],
      selectedProject: project,
      deployments: [],
      truncated: false,
    };
    expect(
      deploymentSummary(
        { ...f.deployment, customEnvironment: { id: "env_unknown" } },
        inventory,
      )?.selectable,
    ).toBe(false);
    expect(
      deploymentSummary({ ...f.deployment, target: "unknown" }, inventory)
        ?.selectable,
    ).toBe(false);
    expect(
      deploymentSummary(
        {
          ...f.deployment,
          target: "production",
          customEnvironment: { id: "env_stage" },
        },
        inventory,
      )?.selectable,
    ).toBe(false);
    const evil = {
      ...f.project,
      link: {
        type: "gitlab",
        projectNamespace: "owner",
        projectName: "app",
        projectId: "123",
        projectUrl: "https://foreign.gitlab.example/owner/app",
      },
    };
    expect(
      projectSummary(evil, {
        ...config,
        provider: "gitlab",
        serverUrl: "https://gitlab.com",
      })?.matchesRepository,
    ).toBe(false);
  });
});
