import { afterEach, describe, expect, it, vi } from "vitest";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeSetup } from "./files.ts";
import { readEditableConfig } from "./configEditor.ts";
import { activateProjectCrew } from "./activateCrew.ts";
import type { ReadinessContext } from "./pmReadiness.ts";
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "gremlins-activate-")));
  roots.push(root);
  initializeSetup(root, process.cwd(), { project: "app", repo: "owner/app" });
  const projectFile = join(root, "projects/app/project.json"),
    areasFile = join(root, "projects/app/areas.json");
  const project = JSON.parse(readFileSync(projectFile, "utf8"));
  project.verified = "2026-10-07";
  project.workflow = { kind: "pull-request", baseBranch: "main" };
  writeFileSync(projectFile, JSON.stringify(project));
  const areas = JSON.parse(readFileSync(areasFile, "utf8"));
  Object.assign(areas.areas.core, {
    enabled: false,
    codingEnabled: false,
    linearProjectId: "mapped-core",
    mandate: "Improve the core flow",
    custom: "retain",
  });
  areas.areas.billing = {
    ...areas.areas.core,
    name: "Billing",
    label: "pm:billing",
    linearProjectId: "mapped-billing",
    mandate: "Make invoices understandable",
    schedule: "30 10 * * *",
  };
  writeFileSync(areasFile, JSON.stringify(areas));
  const context: ReadinessContext = {
    env: {
      GITHUB_TOKEN: "source",
      LINEAR_API_KEY: "linear",
      CLAUDE_CODE_OAUTH_TOKEN: "ai",
    },
    sourceConnections: [],
    serviceConnections: [],
    localMode: true,
    workers: [
      {
        id: "worker",
        name: "Local",
        status: "ready",
        busy: false,
        paused: false,
        createdAt: "2026-10-07",
        verifiedAt: "2026-10-07",
      },
    ],
  };
  const input = {
    projectRevision: readEditableConfig(root, "projects/app/project.json")
      .revision,
    areasRevision: readEditableConfig(root, "projects/app/areas.json").revision,
  };
  const validate = vi.fn(async (_area: string) => {});
  const run = () =>
    activateProjectCrew(root, "app", input, {
      context: async () => context,
      validate,
    });
  return {
    root,
    projectFile,
    areasFile,
    project,
    areas,
    context,
    input,
    validate,
    run,
  };
}
describe("crew activation", () => {
  it("activates managed epic automation only after its saved deployment probe passes, without creating epic authority", async () => {
    const f = fixture();
    f.project.workflow = {
      kind: "promotion",
      approvalPolicy: "epic",
      promotionBatchSize: 10,
    };
    f.project.verification = { mode: "browser", environment: "integration" };
    f.project.environments = {
      integration: {
        kind: "vercel",
        role: "preview",
        projectId: "prj_fixture",
        access: { kind: "public" },
      },
    };
    writeFileSync(f.projectFile, JSON.stringify(f.project));
    f.input.projectRevision = readEditableConfig(
      f.root,
      "projects/app/project.json",
    ).revision;
    f.context.env.VERCEL_TOKEN = "synthetic-provider";
    f.context.environmentVerification = () => ({ status: "failed" });
    await expect(f.run()).rejects.toThrow(/Finish project setup/);
    expect(JSON.parse(readFileSync(f.areasFile, "utf8"))).toEqual(f.areas);
    f.context.environmentVerification = () => ({ status: "passed" });
    const result = await f.run();
    expect(
      result.readiness.areas.every(
        (area) =>
          area.canRun &&
          area.coding.canEnable &&
          area.enabled &&
          area.codingEnabled,
      ),
    ).toBe(true);
    expect(existsSync(join(f.root, ".run/epics"))).toBe(false);
  });
  it("activates all ready areas atomically and preserves their configuration without approving work", async () => {
    const f = fixture(),
      projectBefore = readFileSync(f.projectFile, "utf8");
    const result = await f.run();
    expect(f.validate.mock.calls).toEqual([["core"], ["billing"]]);
    expect(result.ok).toBe(true);
    expect(result.areasRevision).not.toBe(f.input.areasRevision);
    const saved = JSON.parse(readFileSync(f.areasFile, "utf8"));
    for (const key of ["core", "billing"])
      expect(saved.areas[key]).toEqual({
        ...f.areas.areas[key],
        enabled: true,
        codingEnabled: true,
      });
    expect(readFileSync(f.projectFile, "utf8")).toBe(projectBefore);
    expect(
      result.readiness.areas.every(
        (area) => area.enabled && area.codingEnabled,
      ),
    ).toBe(true);
  });
  it.each(["worker", "linear", "mapping", "mandate"])(
    "keeps every area paused when %s is missing",
    async (kind) => {
      const f = fixture();
      if (kind === "worker") f.context.workers = [];
      if (kind === "linear") delete f.context.env.LINEAR_API_KEY;
      if (kind === "mapping")
        f.areas.areas.billing.linearProjectId = "PASTE_PROJECT_ID";
      if (kind === "mandate") delete f.areas.areas.billing.mandate;
      writeFileSync(f.areasFile, JSON.stringify(f.areas));
      f.input.areasRevision = readEditableConfig(
        f.root,
        "projects/app/areas.json",
      ).revision;
      const before = readFileSync(f.areasFile, "utf8");
      await expect(f.run()).rejects.toThrow(/Finish project setup/);
      expect(f.validate).not.toHaveBeenCalled();
      expect(readFileSync(f.areasFile, "utf8")).toBe(before);
    },
  );
  it("keeps the first area paused if validation of a later area fails", async () => {
    const f = fixture(),
      before = readFileSync(f.areasFile, "utf8");
    f.validate.mockImplementation(async (area) => {
      if (area === "billing") throw new Error("Repository unavailable");
    });
    await expect(f.run()).rejects.toThrow("Repository unavailable");
    expect(readFileSync(f.areasFile, "utf8")).toBe(before);
  });
  it.each(["project", "areas"])(
    "rejects a stale %s revision before checking providers",
    async (kind) => {
      const f = fixture();
      f.input[kind === "project" ? "projectRevision" : "areasRevision"] =
        "0".repeat(64);
      await expect(f.run()).rejects.toMatchObject({ status: 409 });
      expect(f.validate).not.toHaveBeenCalled();
    },
  );
  it("preserves a concurrent owner edit during asynchronous validation", async () => {
    const f = fixture();
    f.validate.mockImplementation(async (area) => {
      if (area === "billing") {
        f.areas.areas.core.schedule = "10 8 * * *";
        writeFileSync(f.areasFile, JSON.stringify(f.areas));
      }
    });
    await expect(f.run()).rejects.toMatchObject({ status: 409 });
    expect(JSON.parse(readFileSync(f.areasFile, "utf8"))).toEqual(f.areas);
  });
});
