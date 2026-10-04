import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseProjectDoc,
  resolveProjectId,
  runLinearProject,
  type LinearProjectApi,
} from "./linearProject.ts";

const DOC = `# ExampleApp — Core

> Generation and preview — owned by the core PM.

## What this is

The product.
`;

function fakeApi(over: Partial<LinearProjectApi> = {}): LinearProjectApi & {
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    listProjects: async () => [
      {
        id: "1e5fcead-6f1c-4a2b-9c3d-000000000001",
        name: "Core Development",
        url: "https://linear.app/x/project/core-development-1e5fcead6f1c",
      },
    ],
    listTeams: async () => [{ id: "team-1", key: "FM", name: "ExampleApp" }],
    createProject: async (input) => {
      calls.push(`create:${input.teamId}:${input.name}`);
      return { id: "new-uuid", url: "https://linear.app/x/project/new" };
    },
    updateProject: async (id, input) => {
      calls.push(`update:${id}:${input.name}`);
      return { id, url: "https://linear.app/x/project/updated" };
    },
    ...over,
  };
}

function hubWithArea(): string {
  const root = mkdtempSync(join(tmpdir(), "hub-lp-"));
  mkdirSync(join(root, "projects", "game", "core"), { recursive: true });
  writeFileSync(
    join(root, "projects", "game", "areas.json"),
    JSON.stringify({ areas: { core: { linearProjectId: "PASTE" } } }),
  );
  writeFileSync(
    join(root, "projects", "game", "core", "linear-project.md"),
    DOC,
  );
  return root;
}

const io = { log: () => {}, error: () => {} };

describe("parseProjectDoc", () => {
  it("splits name, short description and content", () => {
    const doc = parseProjectDoc(DOC);
    expect(doc.name).toBe("ExampleApp — Core");
    expect(doc.description).toBe(
      "Generation and preview — owned by the core PM.",
    );
    expect(doc.content).toBe("## What this is\n\nThe product.\n");
  });
  it("refuses a doc with no heading", () => {
    expect(() => parseProjectDoc("hello")).toThrow(/# Name/);
  });
});

describe("resolveProjectId", () => {
  it("passes a uuid through", async () => {
    const id = "1e5fcead-6f1c-4a2b-9c3d-000000000001";
    expect(await resolveProjectId(fakeApi(), id)).toBe(id);
  });
  it("matches a Linear overview URL by slug", async () => {
    expect(
      await resolveProjectId(
        fakeApi(),
        "https://linear.app/x/project/core-development-1e5fcead6f1c/overview",
      ),
    ).toBe("1e5fcead-6f1c-4a2b-9c3d-000000000001");
  });
  it("names the listing command when nothing matches", async () => {
    await expect(resolveProjectId(fakeApi(), "nope-123")).rejects.toThrow(
      /linear-projects/,
    );
  });
});

describe("runLinearProject", () => {
  it("creates in the only team and writes the id into areas.json", async () => {
    const root = hubWithArea();
    const api = fakeApi();
    expect(await runLinearProject(root, api, ["game", "core"], io)).toBe(0);
    expect(api.calls).toEqual(["create:team-1:ExampleApp — Core"]);
    const areas = JSON.parse(
      readFileSync(join(root, "projects", "game", "areas.json"), "utf8"),
    );
    expect(areas.areas.core.linearProjectId).toBe("new-uuid");
  });
  it("updates with --id and still writes the id", async () => {
    const root = hubWithArea();
    const api = fakeApi();
    const code = await runLinearProject(
      root,
      api,
      [
        "game",
        "core",
        "--id",
        "https://linear.app/x/project/core-development-1e5fcead6f1c/overview",
      ],
      io,
    );
    expect(code).toBe(0);
    expect(api.calls).toEqual([
      "update:1e5fcead-6f1c-4a2b-9c3d-000000000001:ExampleApp — Core",
    ]);
    const areas = JSON.parse(
      readFileSync(join(root, "projects", "game", "areas.json"), "utf8"),
    );
    expect(areas.areas.core.linearProjectId).toBe(
      "1e5fcead-6f1c-4a2b-9c3d-000000000001",
    );
  });
  it("asks for --team when several teams are visible", async () => {
    const root = hubWithArea();
    const errors: string[] = [];
    const api = fakeApi({
      listTeams: async () => [
        { id: "a", key: "FM", name: "ExampleApp" },
        { id: "b", key: "OPS", name: "Ops" },
      ],
    });
    const code = await runLinearProject(root, api, ["game", "core"], {
      log: () => {},
      error: (l) => errors.push(l),
    });
    expect(code).toBe(1);
    expect(errors[0]).toMatch(/--team/);
    expect(api.calls).toEqual([]);
  });
});
