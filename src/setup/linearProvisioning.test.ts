import { afterEach, describe, expect, it, vi } from "vitest";
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  rmSync,
  mkdirSync,
  symlinkSync,
  realpathSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { initializeSetup } from "./files.ts";
import { loadProject } from "../config.ts";
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
      };
      projects.set(input.id, project);
      return project;
    }),
  };
  const create = () =>
    createLinearProvisioning({ root, client: async () => client });
  return { root, workspace, teams, projects, client, create };
}

describe("Linear app and mandate provisioning", () => {
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
      paths: ["src/"],
      schedule: "15 10 * * 1-5",
    });
    const area = loadProject(f.root, "demo").areas.find(
      (a) => a.key === "security",
    )!;
    expect(area.enabled).toBe(false);
    expect(area.mandate).toContain("RBAC");
    await f.create().provision("demo");
    await f.create().provision("demo");
    expect(f.client.createTeam).toHaveBeenCalledTimes(1);
    expect(f.client.createProject).toHaveBeenCalledTimes(2);
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
