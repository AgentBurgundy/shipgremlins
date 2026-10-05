import { afterEach, describe, expect, it, vi } from "vitest";
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  rmSync,
  mkdirSync,
  symlinkSync,
  realpathSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { initializeSetup } from "./files.ts";
import { loadProject } from "../config.ts";
import { readEditableConfig } from "./configEditor.ts";
import {
  createLinearProvisioning,
  type LinearProvisioningClient,
} from "./linearProvisioning.ts";
import type { LinearProjectResource, LinearTeam } from "../services/linear.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "gremlins-linear-mapping-")),
  );
  roots.push(root);
  initializeSetup(root, process.cwd(), { project: "demo", repo: "org/app" });
  const workspace = { id: randomUUID(), name: "Test" };
  const teams = new Map<string, LinearTeam>();
  const projects = new Map<string, LinearProjectResource>();
  const client: LinearProvisioningClient = {
    organization: vi.fn(async () => workspace),
    getTeam: vi.fn(async (id) => teams.get(id) ?? null),
    getProject: vi.fn(async (id) => projects.get(id) ?? null),
    resources: vi.fn(async () => ({
      teams: [...teams.values()],
      projects: [...projects.values()],
    })),
    createTeam: vi.fn(async (input) => {
      const intent = JSON.parse(
        readFileSync(join(root, ".run/linear/provisioning/demo.json"), "utf8"),
      );
      expect(intent.team.id).toBe(input.id);
      if (teams.has(input.id)) throw new Error("duplicate team");
      const team = { id: input.id, name: input.name, key: input.key };
      teams.set(input.id, team);
      return team;
    }),
    createProject: vi.fn(async (input) => {
      const intent = JSON.parse(
        readFileSync(join(root, ".run/linear/provisioning/demo.json"), "utf8"),
      );
      expect(
        Object.values(intent.areas).some(
          (value) => (value as { id: string }).id === input.id,
        ),
      ).toBe(true);
      if (!input.id || projects.has(input.id))
        throw new Error("duplicate project");
      const project = {
        id: input.id,
        name: input.name,
        teamIds: [input.teamId],
        url: "https://linear.app/test/project/" + input.id,
        description: input.description,
        content: input.content,
        icon: input.icon,
        color: input.color,
      };
      projects.set(input.id, project);
      return project;
    }),
    updateProject: vi.fn(async (id, input) => {
      const project = projects.get(id);
      if (!project) throw new Error("unknown project");
      Object.assign(project, input);
      return project;
    }),
  };
  const create = (mappingWrite?: (file: string, content: string) => void) =>
    createLinearProvisioning({
      root,
      client: async () => client,
      mappingWrite,
    });
  return { root, workspace, teams, projects, client, create };
}

describe("Linear app and mandate provisioning", () => {
  function selection(f: ReturnType<typeof fixture>) {
    const team = { id: randomUUID(), name: "Correct team", key: "FIX" };
    const project = {
      id: randomUUID(),
      name: "Correct PM",
      teamIds: [team.id],
      url: "https://linear.app/test/project/correct",
    };
    f.teams.set(team.id, team);
    f.projects.set(project.id, project);
    return {
      team,
      project,
      input: {
        teamId: team.id,
        projectRevision: readEditableConfig(
          f.root,
          "projects/demo/project.json",
        ).revision,
        areasRevision: readEditableConfig(f.root, "projects/demo/areas.json")
          .revision,
        areaProjects: { core: project.id } as Record<string, string | null>,
      },
    };
  }
  const savedFiles = (f: ReturnType<typeof fixture>) =>
    [
      "projects/demo/project.json",
      "projects/demo/areas.json",
      ".run/linear/provisioning/demo.json",
    ].map((path) => readFileSync(join(f.root, path), "utf8"));
  it("repairs existing team and PM bindings together, preserving unknown fields and allowing setup retry", async () => {
    const f = fixture();
    await f.create().provision("demo");
    const configFile = join(f.root, "projects/demo/project.json"),
      areaFile = join(f.root, "projects/demo/areas.json"),
      stateFile = join(f.root, ".run/linear/provisioning/demo.json");
    const config = JSON.parse(readFileSync(configFile, "utf8"));
    config.verified = "2026-10-05";
    config.operatorNote = "keep this";
    writeFileSync(configFile, JSON.stringify(config));
    const areas = JSON.parse(readFileSync(areaFile, "utf8"));
    areas.areas.core.enabled = true;
    areas.areas.core.extra = "keep PM fields";
    writeFileSync(areaFile, JSON.stringify(areas));
    const state = JSON.parse(readFileSync(stateFile, "utf8"));
    state.audit = { custom: "preserve" };
    state.team.custom = true;
    state.areas.core.custom = true;
    state.error = true;
    writeFileSync(stateFile, JSON.stringify(state));
    const picked = selection(f);
    const beforeCreateTeams = vi.mocked(f.client.createTeam).mock.calls.length,
      beforeCreateProjects = vi.mocked(f.client.createProject).mock.calls
        .length;
    const result = await f.create().repairMappings("demo", picked.input);
    expect(result).toMatchObject({
      ok: true,
      team: { id: picked.team.id, name: picked.team.name },
      linear: { status: "ready" },
    });
    expect(JSON.parse(result.project.content)).toMatchObject({
      verified: null,
      operatorNote: "keep this",
      linear: { teamId: picked.team.id, workspaceId: f.workspace.id },
    });
    expect(JSON.parse(result.areas.content).areas.core).toMatchObject({
      linearProjectId: picked.project.id,
      enabled: true,
      extra: "keep PM fields",
    });
    expect(JSON.parse(readFileSync(stateFile, "utf8"))).toMatchObject({
      audit: { custom: "preserve" },
      team: { id: picked.team.id, reuse: true, custom: true },
      areas: { core: { id: picked.project.id, created: true, custom: true } },
    });
    expect(
      JSON.parse(readFileSync(stateFile, "utf8")).areas.core,
    ).not.toHaveProperty("managedBrief");
    await f.create().provision("demo");
    expect(f.client.createTeam).toHaveBeenCalledTimes(beforeCreateTeams);
    expect(f.client.createProject).toHaveBeenCalledTimes(beforeCreateProjects);
    expect(loadProject(f.root, "demo").config.linear?.teamId).toBe(
      picked.team.id,
    );
  });
  it("explicitly unmaps and disables a PM without touching any remote resource", async () => {
    const f = fixture();
    await f.create().provision("demo");
    const picked = selection(f);
    picked.input.areaProjects.core = null;
    vi.mocked(f.client.createProject).mockClear();
    vi.mocked(f.client.createTeam).mockClear();
    const result = await f.create().repairMappings("demo", picked.input);
    expect(JSON.parse(result.areas.content).areas.core).toMatchObject({
      linearProjectId: "PASTE_LINEAR_PROJECT_ID",
      enabled: false,
    });
    expect(f.client.createProject).not.toHaveBeenCalled();
    expect(f.client.createTeam).not.toHaveBeenCalled();
    const intent = JSON.parse(
      readFileSync(join(f.root, ".run/linear/provisioning/demo.json"), "utf8"),
    );
    expect(intent.areas.core.created).toBe(false);
    expect(intent.areas.core.id).not.toBe(picked.project.id);
  });
  it("repairs a different workspace through the explicitly selected account and pins subsequent retries", async () => {
    const f = fixture();
    await f.create().provision("demo");
    const oldWorkspace = f.workspace.id,
      picked = selection(f);
    f.workspace.id = randomUUID();
    const calls: { project?: string; account?: string }[] = [];
    const service = createLinearProvisioning({
      root: f.root,
      client: async (project, explicit) => {
        const account =
          explicit ??
          (project
            ? loadProject(f.root, project).config.linear?.connectionId
            : "default");
        calls.push({ project, account });
        if (account !== "client-two") throw new Error("Wrong account selected");
        return f.client;
      },
    });
    const beforeCreate = vi.mocked(f.client.createProject).mock.calls.length;
    const result = await service.repairMappings("demo", {
      ...picked.input,
      connectionId: "client-two",
    });
    expect(result.linear).toMatchObject({
      status: "ready",
      connectionId: "client-two",
      workspaceId: f.workspace.id,
    });
    expect(f.workspace.id).not.toBe(oldWorkspace);
    expect(
      JSON.parse(
        readFileSync(
          join(f.root, ".run/linear/provisioning/demo.json"),
          "utf8",
        ),
      ),
    ).toMatchObject({
      connectionId: "client-two",
      workspaceId: f.workspace.id,
    });
    await service.provision("demo");
    expect(calls).toEqual([
      { project: "demo", account: "client-two" },
      { project: "demo", account: "client-two" },
    ]);
    expect(f.client.createProject).toHaveBeenCalledTimes(beforeCreate);
    const file = join(f.root, "projects/demo/project.json"),
      raw = JSON.parse(readFileSync(file, "utf8"));
    raw.linear.connectionId = "client-three";
    writeFileSync(file, JSON.stringify(raw));
    expect(service.status("demo")).toMatchObject({
      status: "error",
      connectionId: "client-three",
      message: expect.stringContaining("journal differ"),
    });
    await expect(service.provision("demo")).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("another account"),
    });
    expect(calls).toHaveLength(2);
  });
  it("retains an initial named account before its team exists and uses it for provisioning", async () => {
    const f = fixture(),
      file = join(f.root, "projects/demo/project.json");
    const raw = JSON.parse(readFileSync(file, "utf8"));
    raw.linear = { connectionId: "client-two" };
    writeFileSync(file, JSON.stringify(raw));
    const client = vi.fn(async (project?: string) => {
      expect(project).toBe("demo");
      expect(loadProject(f.root, project!).config.linear?.connectionId).toBe(
        "client-two",
      );
      return f.client;
    });
    const service = createLinearProvisioning({ root: f.root, client });
    expect(service.status("demo")).toMatchObject({
      status: "skipped",
      connectionId: "client-two",
    });
    expect(await service.provision("demo")).toMatchObject({
      status: "ready",
      connectionId: "client-two",
    });
    expect(loadProject(f.root, "demo").config.linear?.connectionId).toBe(
      "client-two",
    );
  });
  it.each([1, 2, 3])(
    "restores exact original files when local transaction write %s fails",
    async (failAt) => {
      const f = fixture();
      await f.create().provision("demo");
      const picked = selection(f);
      const before = savedFiles(f);
      let writes = 0;
      await expect(
        f
          .create((path, content) => {
            if (++writes === failAt) throw new Error("simulated write failure");
            writeFileSync(path, content);
          })
          .repairMappings("demo", picked.input),
      ).rejects.toMatchObject({ status: 500 });
      expect(savedFiles(f)).toEqual(before);
      expect(() =>
        readFileSync(join(f.root, ".run/linear/provisioning/demo.repair.json")),
      ).toThrow();
      expect((await f.create().repairMappings("demo", picked.input)).ok).toBe(
        true,
      );
    },
  );
  it("rejects stale revisions and concurrent edits during remote validation without overwriting edits", async () => {
    const f = fixture();
    await f.create().provision("demo");
    const picked = selection(f);
    const before = savedFiles(f);
    await expect(
      f.create().repairMappings("demo", {
        ...picked.input,
        areasRevision: "0".repeat(64),
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(savedFiles(f)).toEqual(before);
    const projectFile = join(f.root, "projects/demo/project.json");
    f.client.getTeam = vi.fn(async () => {
      const raw = JSON.parse(readFileSync(projectFile, "utf8"));
      raw.commands.test = "npm run newer-tests";
      writeFileSync(projectFile, JSON.stringify(raw));
      return picked.team;
    });
    await expect(
      f.create().repairMappings("demo", picked.input),
    ).rejects.toMatchObject({ status: 409 });
    expect(JSON.parse(readFileSync(projectFile, "utf8")).commands.test).toBe(
      "npm run newer-tests",
    );
    expect(savedFiles(f).slice(1)).toEqual(before.slice(1));
  });
  it.each(["pending", "committed"])(
    "recovers an interrupted %s repair before subsequent setup",
    async (phase) => {
      const f = fixture();
      await f.create().provision("demo");
      const picked = selection(f);
      const before = savedFiles(f);
      await f.create().repairMappings("demo", picked.input);
      const after = savedFiles(f),
        directory = join(f.root, ".run/linear/provisioning");
      const archive = readdirSync(directory).find((name) =>
        /^demo\.repair-/.test(name),
      )!;
      const transaction = JSON.parse(
        readFileSync(join(directory, archive), "utf8"),
      );
      transaction.id = randomUUID();
      transaction.phase = phase;
      writeFileSync(
        join(directory, "demo.repair.json"),
        JSON.stringify(transaction),
      );
      if (phase === "pending") {
        // A process can stop between any two file renames. The first two files
        // landed here; the journal remains old and must be restored together.
        writeFileSync(join(directory, "demo.json"), before[2]!);
        expect(f.create().status("demo").status).toBe("error");
        await expect(
          f.create().repairMappings("demo", {
            ...picked.input,
            areasRevision: "0".repeat(64),
          }),
        ).rejects.toMatchObject({ status: 409 });
        expect(savedFiles(f)).toEqual(before);
      } else {
        await f.create().provision("demo");
        expect(loadProject(f.root, "demo").config.linear?.teamId).toBe(
          picked.team.id,
        );
        expect(savedFiles(f)[1]).toBe(after[1]);
      }
      expect(() => readFileSync(join(directory, "demo.repair.json"))).toThrow();
      expect(
        readFileSync(
          join(directory, `demo.repair-${transaction.id}.json`),
          "utf8",
        ),
      ).toContain(phase);
    },
  );
  it("preserves evidence and refuses recovery when an interrupted transaction has a newer user edit", async () => {
    const f = fixture();
    await f.create().provision("demo");
    const picked = selection(f);
    await f.create().repairMappings("demo", picked.input);
    const directory = join(f.root, ".run/linear/provisioning");
    const archive = readdirSync(directory).find((name) =>
      /^demo\.repair-/.test(name),
    )!;
    const transaction = JSON.parse(
      readFileSync(join(directory, archive), "utf8"),
    );
    transaction.id = randomUUID();
    transaction.phase = "pending";
    writeFileSync(
      join(directory, "demo.repair.json"),
      JSON.stringify(transaction),
    );
    const projectFile = join(f.root, "projects/demo/project.json"),
      value = JSON.parse(readFileSync(projectFile, "utf8"));
    value.commands.test = "npm run my-new-tests";
    writeFileSync(projectFile, JSON.stringify(value));
    const current = savedFiles(f);
    await expect(f.create().provision("demo")).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("needs recovery"),
    });
    expect(savedFiles(f)).toEqual(current);
    expect(readFileSync(join(directory, "demo.repair.json"), "utf8")).toContain(
      transaction.id,
    );
  });
  it("rejects inaccessible, wrong-team and duplicate PM resources without changing files", async () => {
    const f = fixture();
    await f.create().provision("demo");
    await f.create().addArea("demo", {
      key: "growth",
      name: "Growth",
      mandate: "Review onboarding.",
    });
    const picked = selection(f);
    const before = savedFiles(f);
    picked.input.areaProjects.growth = picked.project.id;
    await expect(
      f.create().repairMappings("demo", picked.input),
    ).rejects.toThrow("duplicate mappings");
    picked.input.areaProjects.growth = null;
    picked.project.teamIds = [randomUUID()];
    await expect(
      f.create().repairMappings("demo", picked.input),
    ).rejects.toThrow("belong to the selected");
    f.projects.delete(picked.project.id);
    await expect(
      f.create().repairMappings("demo", picked.input),
    ).rejects.toThrow("accessible");
    expect(savedFiles(f)).toEqual(before);
  });
  it("persists an optional PM Mixpanel report through idempotent Linear mapping", async () => {
    const f = fixture();
    const file = join(f.root, "projects/demo/project.json");
    const config = JSON.parse(readFileSync(file, "utf8"));
    config.telemetry = {
      mixpanel: {
        region: "us",
        projectId: "123",
        usernameSecret: "MIXPANEL_USERNAME_DEMO",
        passwordSecret: "MIXPANEL_PASSWORD_DEMO",
      },
    };
    writeFileSync(file, JSON.stringify(config));
    await f.create().addArea("demo", {
      key: "growth",
      name: "Growth",
      mandate: "Review activation friction.",
      mixpanelReportId: "456",
    });
    await f.create().provision("demo");
    await f.create().provision("demo");
    expect(
      loadProject(f.root, "demo").areas.find((area) => area.key === "growth"),
    ).toMatchObject({ mixpanelReportId: "456", enabled: false });
    expect(f.client.createProject).toHaveBeenCalledTimes(2);
  });
  it.each([null, 7, "", "0", "-1", "1x", "https://mixpanel.com/report/1"])(
    "rejects invalid PM Mixpanel report %s without changing configuration or calling Linear",
    async (mixpanelReportId) => {
      const f = fixture();
      const file = join(f.root, "projects/demo/areas.json");
      const before = readFileSync(file, "utf8");
      await expect(
        f.create().addArea("demo", {
          key: "growth",
          name: "Growth",
          mandate: "Review activation.",
          mixpanelReportId,
        }),
      ).rejects.toThrow("positive numeric Mixpanel");
      expect(readFileSync(file, "utf8")).toBe(before);
      expect(f.client.getProject).not.toHaveBeenCalled();
      expect(f.client.createProject).not.toHaveBeenCalled();
    },
  );
  it("requires project Mixpanel configuration before adding a PM report mapping", async () => {
    const f = fixture();
    const file = join(f.root, "projects/demo/areas.json");
    const before = readFileSync(file, "utf8");
    await expect(
      f.create().addArea("demo", {
        key: "growth",
        name: "Growth",
        mandate: "Review activation.",
        mixpanelReportId: "456",
        linearProjectId: randomUUID(),
      }),
    ).rejects.toThrow("Configure Mixpanel");
    expect(readFileSync(file, "utf8")).toBe(before);
    expect(f.client.getProject).not.toHaveBeenCalled();
  });
  it("does not adopt an unrelated team with the same name", async () => {
    const f = fixture();
    const unrelated = { id: randomUUID(), name: "demo", key: "DEMO" };
    f.teams.set(unrelated.id, unrelated);
    const result = await f.create().provision("demo");
    expect(result.teamId).not.toBe(unrelated.id);
    expect(f.teams.size).toBe(2);
    expect(f.teams.get(unrelated.id)).toEqual(unrelated);
  });
  it("allows a valid PM key that matches an Object prototype property", async () => {
    const f = fixture();
    await f.create().provision("demo");
    await f.create().addArea("demo", {
      key: "constructor",
      name: "Constructor",
      mandate: "Test model construction.",
    });
    await f.create().provision("demo");
    expect(f.projects.size).toBe(2);
    expect(
      loadProject(f.root, "demo").areas.find(
        (area) => area.key === "constructor",
      )?.linearProjectId,
    ).not.toBe("PASTE_LINEAR_PROJECT_ID");
  });
  it("rejects linked state directories before reading or writing outside the configuration", async () => {
    const f = fixture();
    const outside = mkdtempSync(join(tmpdir(), "gremlins-linear-outside-"));
    roots.push(outside);
    mkdirSync(join(f.root, ".run/linear"), { recursive: true });
    symlinkSync(outside, join(f.root, ".run/linear/provisioning"), "junction");
    await expect(f.create().provision("demo")).rejects.toThrow("without links");
    expect(f.client.createTeam).not.toHaveBeenCalled();
  });
  it("creates one team and project, persists real ticket mapping, and repeats without duplicates", async () => {
    const f = fixture();
    const result = await f.create().provision("demo");
    expect(result.status).toBe("ready");
    const config = loadProject(f.root, "demo");
    expect(config.config.linear?.teamId).toBe(result.teamId);
    expect(f.projects.has(config.areas[0]!.linearProjectId)).toBe(true);
    expect(config.areas[0]!.enabled).toBe(false);
    await f.create().provision("demo");
    expect(f.client.createTeam).toHaveBeenCalledTimes(1);
    expect(f.client.createProject).toHaveBeenCalledTimes(1);
    expect(f.client.updateProject).not.toHaveBeenCalled();
  });
  it("creates a branded brief from the actual saved PM mandate and settings", async () => {
    const f = fixture();
    const file = join(f.root, "projects/demo/areas.json");
    const raw = JSON.parse(readFileSync(file, "utf8"));
    raw.areas.core = {
      ...raw.areas.core,
      name: "Account guardian",
      mandate:
        "Check **RBAC boundaries** with two isolated test accounts.\n\nReproduce cross-team access failures.",
      paths: ["src/accounts/", "api/roles.ts"],
      sharedTouchpoints: ["middleware.ts"],
      metric: "account_saved",
      schedule: "15 10 * * 1-5",
      wipLimit: 2,
    };
    writeFileSync(file, JSON.stringify(raw));
    writeFileSync(
      join(f.root, ".env"),
      "GITHUB_TOKEN=never-copy-source-token\nLINEAR_API_KEY=never-copy-linear-token\n",
    );
    await f.create().provision("demo");
    const input = vi.mocked(f.client.createProject).mock.calls[0]![0];
    expect(input).toMatchObject({
      name: "Account guardian",
      icon: "👾",
      color: "#c3f66b",
    });
    expect(input.description.length).toBeLessThanOrEqual(255);
    for (const expected of [
      raw.areas.core.mandate,
      "https://github.com/org/app",
      "src/accounts/",
      "middleware.ts",
      "account_saved",
      "15 10 * * 1-5",
      "UTC",
      "2 approved tickets",
      "pm:core",
      "pm-proposal",
      "pm-approved",
      "pm-needs-human",
      "draft PR/MR",
      "merged into production",
      "Run once",
      "repository code",
    ])
      expect(input.content).toContain(expected);
    expect(input.content).not.toContain("never-copy");
    expect(input.content).not.toContain("VERCEL_TOKEN");
    expect(f.client.updateProject).not.toHaveBeenCalled();
    expect(loadProject(f.root, "demo").areas[0]!.enabled).toBe(false);
  });
  it("uses versioned mandates and the actual GitLab repository for the initial brief", async () => {
    const f = fixture();
    const file = join(f.root, "projects/demo/project.json");
    const raw = JSON.parse(readFileSync(file, "utf8"));
    raw.provider = "gitlab";
    raw.serverUrl = "https://gitlab.example.com";
    raw.repo = "group/subgroup/app";
    raw.verification = { mode: "browser", environment: "preview" };
    raw.environments = {
      preview: {
        kind: "url",
        role: "preview",
        url: "https://preview.example.com",
      },
    };
    writeFileSync(file, JSON.stringify(raw));
    const mandate =
      "# Catalog patrol\n\nValidate real screenshots of the item editor.";
    writeFileSync(join(f.root, "projects/demo/core/mandate.md"), mandate);
    await f.create().provision("demo");
    const input = vi.mocked(f.client.createProject).mock.calls[0]![0];
    expect(input.content).toContain(mandate);
    expect(input.content).toContain(
      "https://gitlab.example.com/group/subgroup/app",
    );
    expect(input.content).toContain("capture actual screenshots");
    expect(input.content).toContain("deployed baseline is not proof");
  });
  it("resumes missing managed metadata after lost responses without replacing human edits", async () => {
    const f = fixture();
    const original = f.client.createProject;
    f.client.createProject = vi.fn(async (input) => {
      const created = await original(input);
      const remote = f.projects.get(created.id)!;
      remote.description = "Human notes added while setup was interrupted";
      remote.content = null;
      remote.icon = null;
      throw new Error("lost response with private upstream data");
    });
    const areasFile = join(f.root, "projects/demo/areas.json");
    const before = readFileSync(areasFile, "utf8");
    await expect(f.create().provision("demo")).rejects.toThrow(
      "Saved resource IDs",
    );
    expect(readFileSync(areasFile, "utf8")).toBe(before);
    vi.mocked(f.client.updateProject).mockRejectedValueOnce(
      new Error("private token upstream failure"),
    );
    await expect(f.create().provision("demo")).rejects.toThrow(
      "Saved resource IDs",
    );
    expect(readFileSync(areasFile, "utf8")).toBe(before);
    expect(f.create().status("demo").status).toBe("error");
    expect(
      JSON.parse(
        readFileSync(
          join(f.root, ".run/linear/provisioning/demo.json"),
          "utf8",
        ),
      ).areas.core.managedBrief.applied,
    ).toBe(false);
    await f.create().provision("demo");
    expect(f.client.createProject).toHaveBeenCalledTimes(1);
    const patch = vi.mocked(f.client.updateProject).mock.calls[1]![1];
    expect(patch).toMatchObject({
      icon: "👾",
      content: expect.stringContaining("ShipGremlins"),
    });
    expect(patch).not.toHaveProperty("description");
    expect(patch).not.toHaveProperty("color");
    const remote = [...f.projects.values()][0]!;
    expect(remote.description).toBe(
      "Human notes added while setup was interrupted",
    );
    remote.content = "A human-maintained project document";
    await f.create().provision("demo");
    expect(remote.content).toBe("A human-maintained project document");
    expect(f.client.updateProject).toHaveBeenCalledTimes(2);
  });
  it("does not retrofit a recovered legacy project without proof of managed metadata", async () => {
    const f = fixture();
    const create = f.client.createProject;
    f.client.createProject = vi.fn(async (input) => {
      await create(input);
      throw new Error("lost");
    });
    await expect(f.create().provision("demo")).rejects.toThrow();
    const stateFile = join(f.root, ".run/linear/provisioning/demo.json");
    const state = JSON.parse(readFileSync(stateFile, "utf8"));
    delete state.areas.core.managedBrief;
    writeFileSync(stateFile, JSON.stringify(state));
    const remote = [...f.projects.values()][0]!;
    remote.content = "";
    await f.create().provision("demo");
    expect(f.client.updateProject).not.toHaveBeenCalled();
    expect(remote.content).toBe("");
  });
  it("recovers remote team creation after lost response using the journaled UUID", async () => {
    const f = fixture();
    const create = f.client.createTeam;
    f.client.createTeam = vi.fn(async (input) => {
      await create(input);
      throw new Error("response lost SECRET");
    });
    await expect(f.create().provision("demo")).rejects.toThrow(
      "Saved resource IDs",
    );
    await f.create().provision("demo");
    expect(f.teams.size).toBe(1);
    expect(f.client.createTeam).toHaveBeenCalledTimes(1);
  });
  it("recovers a remote project after response loss without creating another or erasing files", async () => {
    const f = fixture();
    const configPath = join(f.root, "projects/demo/areas.json");
    const before = readFileSync(configPath, "utf8");
    const create = f.client.createProject;
    f.client.createProject = vi.fn(async (input) => {
      await create(input);
      throw new Error("lost response");
    });
    await expect(f.create().provision("demo")).rejects.toThrow();
    expect(readFileSync(configPath, "utf8")).toBe(before);
    expect(f.create().status("demo").status).toBe("error");
    await f.create().provision("demo");
    expect(f.projects.size).toBe(1);
    expect(f.client.createProject).toHaveBeenCalledTimes(1);
  });
  it("reuses a selected existing team and preserves legacy projects", async () => {
    const f = fixture();
    const team = { id: randomUUID(), name: "Original", key: "OLD" };
    f.teams.set(team.id, team);
    const project = {
      id: randomUUID(),
      name: "Legacy",
      url: "https://linear.app/test/legacy",
      teamIds: [team.id],
    };
    f.projects.set(project.id, project);
    const file = join(f.root, "projects/demo/areas.json");
    const config = JSON.parse(readFileSync(file, "utf8"));
    config.areas.core.linearProjectId = project.id;
    writeFileSync(file, JSON.stringify(config));
    await f.create().provision("demo", { teamId: team.id });
    expect(f.client.createTeam).not.toHaveBeenCalled();
    expect(f.client.createProject).not.toHaveBeenCalled();
    expect(f.client.updateProject).not.toHaveBeenCalled();
    expect(loadProject(f.root, "demo").areas[0]!.linearProjectId).toBe(
      project.id,
    );
  });
  it("refuses another workspace or team and never remaps existing IDs", async () => {
    const f = fixture();
    await f.create().provision("demo");
    const before = readFileSync(
      join(f.root, "projects/demo/areas.json"),
      "utf8",
    );
    await expect(
      f.create().provision("demo", { teamId: randomUUID() }),
    ).rejects.toThrow("different team");
    f.workspace.id = randomUUID();
    await expect(f.create().provision("demo")).rejects.toThrow(
      "different Linear workspace",
    );
    expect(readFileSync(join(f.root, "projects/demo/areas.json"), "utf8")).toBe(
      before,
    );
    expect(f.client.createTeam).toHaveBeenCalledTimes(1);
  });
  it("saves a disabled mandate and later maps it once, with validation before writes", async () => {
    const f = fixture();
    await f.create().provision("demo");
    await f.create().addArea("demo", {
      key: "security",
      name: "Security",
      mandate: "Test RBAC with test accounts.",
      charter: {
        ambition: "Prevent cross-account exposure.",
        guardrails: ["Use isolated test accounts"],
      },
      paths: ["src/"],
      schedule: "15 10 * * 1-5",
    });
    const area = loadProject(f.root, "demo").areas.find(
      (a) => a.key === "security",
    )!;
    expect(area.enabled).toBe(false);
    expect(area.mandate).toContain("RBAC");
    expect(area.charter?.ambition).toBe("Prevent cross-account exposure.");
    await f.create().provision("demo");
    await f.create().provision("demo");
    expect(f.client.createTeam).toHaveBeenCalledTimes(1);
    expect(f.client.createProject).toHaveBeenCalledTimes(2);
    expect(
      vi.mocked(f.client.createProject).mock.calls[1]![0].content,
    ).toContain("Prevent cross-account exposure.");
    await expect(
      f
        .create()
        .addArea("demo", { key: "security", name: "Again", mandate: "Again" }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      f
        .create()
        .addArea("demo", { key: "../bad", name: "Bad", mandate: "Bad" }),
    ).rejects.toThrow();
    await expect(
      f.create().addArea("demo", {
        key: "bad",
        name: "Bad",
        mandate: "Bad",
        schedule: "99 99 * * *",
      }),
    ).rejects.toThrow();
    await expect(
      f.create().addArea("demo", {
        key: "bad-brief",
        name: "Bad",
        mandate: "A real mandate",
        charter: { selfApprove: true },
      }),
    ).rejects.toThrow("product brief");
    expect(
      loadProject(f.root, "demo").areas.some(
        (item) => item.key === "bad-brief",
      ),
    ).toBe(false);
  });
  it("does not reset corrupt state or steal a live operation lock", async () => {
    const f = fixture();
    const dir = join(f.root, ".run/linear/provisioning");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "demo.lock"), String(process.pid));
    await expect(f.create().provision("demo")).rejects.toMatchObject({
      status: 409,
    });
    rmSync(join(dir, "demo.lock"));
    writeFileSync(join(dir, "demo.json"), "broken");
    await expect(f.create().provision("demo")).rejects.toThrow("needs repair");
    expect(readFileSync(join(dir, "demo.json"), "utf8")).toBe("broken");
    expect(f.client.createTeam).not.toHaveBeenCalled();
  });
});
