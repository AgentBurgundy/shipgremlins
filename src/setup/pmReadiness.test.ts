import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { initializeSetup } from "./files.ts";
import { loadProject } from "../config.ts";
import { readEditableConfig } from "./configEditor.ts";
import { createRemoteWorkers } from "../remoteWorkers/index.ts";
import { createDockerRunners } from "../localRunners/docker.ts";
import {
  inspectPmReadiness,
  hasPmMandate,
  setPmAutomation,
  type ReadinessContext,
} from "./pmReadiness.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "gremlins-pm-ready-")));
  roots.push(root);
  initializeSetup(root, process.cwd(), { project: "demo", repo: "org/app" });
  const projectFile = join(root, "projects/demo/project.json"),
    areasFile = join(root, "projects/demo/areas.json");
  const project = JSON.parse(readFileSync(projectFile, "utf8"));
  project.verified = "2026-10-05";
  project.privateOperatorNote = "keep";
  writeFileSync(projectFile, JSON.stringify(project));
  const areas = JSON.parse(readFileSync(areasFile, "utf8"));
  areas.areas.core.linearProjectId = randomUUID();
  areas.areas.core.mandate =
    "Review account security with isolated test accounts.";
  areas.areas.core.custom = "keep";
  writeFileSync(areasFile, JSON.stringify(areas));
  const context: ReadinessContext = {
    env: {
      GITHUB_TOKEN: "saved-source",
      LINEAR_API_KEY: "saved-linear",
      CLAUDE_CODE_OAUTH_TOKEN: "saved-ai",
    },
    sourceConnections: [],
    serviceConnections: [],
    workers: [
      {
        id: "worker-one",
        name: "Local",
        status: "ready",
        busy: false,
        paused: false,
        createdAt: "2026-10-05",
        verifiedAt: "2026-10-05",
      },
    ],
    localMode: true,
  };
  const input = (enabled: boolean) => ({
    enabled,
    projectRevision: readEditableConfig(root, "projects/demo/project.json")
      .revision,
    revision: readEditableConfig(root, "projects/demo/areas.json").revision,
  });
  return {
    root,
    projectFile,
    areasFile,
    context,
    input,
    inspect: () => inspectPmReadiness(loadProject(root, "demo"), context),
  };
}
describe("PM readiness and automation controls", () => {
  it("enables approved coding independently of an invalid PM schedule and preserves that choice when pausing PMs", async () => {
    const f = fixture();
    const raw = JSON.parse(readFileSync(f.areasFile, "utf8"));
    raw.areas.core.schedule = "99 99 * * *";
    raw.areas.core.enabled = false;
    raw.areas.core.codingEnabled = false;
    writeFileSync(f.areasFile, JSON.stringify(raw));
    expect(f.inspect().areas[0]).toMatchObject({
      canEnable: false,
      coding: { canEnable: true, enableBlockers: [] },
    });
    expect(
      await setPmAutomation(
        f.root,
        "demo",
        "core",
        { ...f.input(false), codingEnabled: true },
        { context: async () => f.context },
      ),
    ).toMatchObject({ enabled: false, codingEnabled: true });
    const result = await setPmAutomation(
      f.root,
      "demo",
      "core",
      f.input(false),
      {
        context: async () => {
          throw new Error("connection offline");
        },
      },
    );
    expect(result).toMatchObject({ enabled: false, codingEnabled: true });
    const saved = JSON.parse(readFileSync(f.areasFile, "utf8")).areas.core;
    expect(saved).toMatchObject({ enabled: false, codingEnabled: true });
    expect(
      await setPmAutomation(
        f.root,
        "demo",
        "core",
        { ...f.input(false), codingEnabled: false },
        {
          context: async () => {
            throw new Error("still offline");
          },
        },
      ),
    ).toMatchObject({ enabled: false, codingEnabled: false });
  });
  it("persists legacy effective coding pickup separately on an owner PM toggle", async () => {
    const f = fixture();
    const raw = JSON.parse(readFileSync(f.areasFile, "utf8"));
    raw.areas.core.enabled = true;
    delete raw.areas.core.codingEnabled;
    writeFileSync(f.areasFile, JSON.stringify(raw));
    expect(f.inspect().areas[0]!.codingEnabled).toBe(true);
    const result = await setPmAutomation(
      f.root,
      "demo",
      "core",
      f.input(false),
      { context: async () => f.context },
    );
    expect(result).toMatchObject({ enabled: false, codingEnabled: true });
    expect(
      JSON.parse(readFileSync(f.areasFile, "utf8")).areas.core,
    ).toMatchObject({ enabled: false, codingEnabled: true });
  });
  it("accepts a real mandate file but rejects missing, oversized, or linked mandate locations", () => {
    const f = fixture();
    const project = loadProject(f.root, "demo");
    const area = { ...project.areas[0]!, mandate: undefined };
    const mandatePath = join(project.dir, "core/mandate.md");
    expect(hasPmMandate(project, area)).toBe(true);
    expect(hasPmMandate(project, { ...area, key: "missing" })).toBe(false);
    expect(hasPmMandate(project, { ...area, key: "../core" })).toBe(false);
    writeFileSync(mandatePath, "x".repeat(64 * 1024 + 1));
    expect(hasPmMandate(project, area)).toBe(false);
    const target = join(f.root, "external-mandate");
    mkdirSync(target);
    writeFileSync(
      join(target, "mandate.md"),
      "Outside the configured PM directory.",
    );
    symlinkSync(target, join(project.dir, "linked"), "junction");
    expect(hasPmMandate(project, { ...area, key: "linked" })).toBe(false);
  });
  it("enables automation without an idle worker and preserves verification and unrelated bytes", async () => {
    const f = fixture();
    f.context.workers = [];
    const before = readFileSync(f.projectFile, "utf8"),
      validate = vi.fn(async () => {});
    const result = await setPmAutomation(
      f.root,
      "demo",
      "core",
      f.input(true),
      { context: async () => f.context, validate },
    );
    expect(result).toMatchObject({
      enabled: true,
      readiness: {
        verified: true,
        workerReady: false,
        canRun: false,
        canEnable: true,
      },
    });
    expect(readFileSync(f.projectFile, "utf8")).toBe(before);
    expect(
      JSON.parse(readFileSync(f.areasFile, "utf8")).areas.core,
    ).toMatchObject({ enabled: true, custom: "keep" });
    expect(validate).toHaveBeenCalledOnce();
  });
  it("pauses even when connections are broken, without requesting new credentials", async () => {
    const f = fixture();
    await setPmAutomation(f.root, "demo", "core", f.input(true), {
      context: async () => f.context,
    });
    const validate = vi.fn(async () => {
      throw new Error("must not run");
    });
    expect(
      await setPmAutomation(f.root, "demo", "core", f.input(false), {
        context: async () => {
          throw new Error("connection corrupt");
        },
        validate,
      }),
    ).toMatchObject({ enabled: false });
    expect(validate).not.toHaveBeenCalled();
  });
  it("rejects both stale revisions and concurrent project edits during validation", async () => {
    const f = fixture();
    const input = f.input(true),
      beforeAreas = readFileSync(f.areasFile, "utf8");
    await expect(
      setPmAutomation(
        f.root,
        "demo",
        "core",
        { ...input, revision: "0".repeat(64) },
        { context: async () => f.context },
      ),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      setPmAutomation(
        f.root,
        "demo",
        "core",
        { ...input, projectRevision: "0".repeat(64) },
        { context: async () => f.context },
      ),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      setPmAutomation(f.root, "demo", "core", input, {
        context: async () => f.context,
        validate: async () => {
          const raw = JSON.parse(readFileSync(f.projectFile, "utf8"));
          raw.commands.test = "npm run new-check";
          writeFileSync(f.projectFile, JSON.stringify(raw));
        },
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(readFileSync(f.areasFile, "utf8")).toBe(beforeAreas);
    expect(JSON.parse(readFileSync(f.projectFile, "utf8")).commands.test).toBe(
      "npm run new-check",
    );
  });
  it("separates a paused schedule from manual run readiness and accepts a busy verified worker", () => {
    const f = fixture();
    f.context.workers[0]!.status = "busy";
    f.context.workers[0]!.busy = true;
    expect(f.inspect()).toMatchObject({
      configured: true,
      verified: true,
      workerReady: true,
      canRun: true,
      areas: [{ enabled: false, canRun: true, canEnable: true, blockers: [] }],
    });
  });
  it("uses the engine adapter's actual remote scope, heartbeat and revocation policy", () => {
    const f = fixture();
    let now = Date.now();
    const remote = createRemoteWorkers({ root: f.root, clock: () => now });
    const enrollment = remote.createEnrollment({
      name: "Scoped remote",
      projects: ["other-project"],
    });
    const registered = remote.enroll({
      code: enrollment.code,
      platform: "linux",
      architecture: "x64",
    });
    const run = vi.fn(async () => {
      throw new Error("Readiness must not launch Docker or provider work.");
    });
    const adapter = remote.adapter(
      createDockerRunners({ packageRoot: process.cwd(), run }),
    );
    f.context.workers[0]!.remoteId = registered.id;
    f.context.canRunWorker = adapter.canRun;
    expect(f.inspect()).toMatchObject({
      workerReady: false,
      canRun: false,
      canEnable: true,
    });
    const project = loadProject(f.root, "demo");
    const allowed = () =>
      inspectPmReadiness(
        {
          ...project,
          config: { ...project.config, name: "other-project" },
        },
        f.context,
      );
    expect(allowed().canRun).toBe(true);
    f.context.workers[0]!.status = "busy";
    f.context.workers[0]!.busy = true;
    expect(allowed().canRun).toBe(true);
    now += 60000;
    expect(allowed()).toMatchObject({
      workerReady: false,
      canRun: false,
      canEnable: true,
    });
    remote.poll(registered.token);
    expect(allowed().canRun).toBe(true);
    remote.revoke(registered.id);
    expect(allowed().canRun).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });
  it("does not mistake unknown remote eligibility for a local worker, but preserves local fallback", () => {
    const f = fixture();
    const local = { ...f.context.workers[0]! };
    f.context.workers[0]!.remoteId = `remote-${randomUUID()}`;
    expect(f.inspect().workerReady).toBe(false);
    f.context.workers.push({
      ...local,
      id: "local-fallback",
      status: "busy",
      busy: true,
    });
    expect(f.inspect().workerReady).toBe(true);
    f.context.canRunWorker = () => {
      throw new Error("Registry unavailable");
    };
    expect(f.inspect().workerReady).toBe(false);
    expect(f.inspect().canEnable).toBe(true);
  });
  it("reports actionable mapping, mandate, verification, and worker blockers", () => {
    const f = fixture();
    f.context.workers = [];
    const project = JSON.parse(readFileSync(f.projectFile, "utf8"));
    project.verified = null;
    writeFileSync(f.projectFile, JSON.stringify(project));
    const areas = JSON.parse(readFileSync(f.areasFile, "utf8"));
    areas.areas.core.linearProjectId = "PASTE_LINEAR_PROJECT_ID";
    delete areas.areas.core.mandate;
    writeFileSync(f.areasFile, JSON.stringify(areas));
    writeFileSync(join(f.root, "projects/demo/core/mandate.md"), "  \n");
    expect(f.inspect().areas[0]?.blockers.map((item) => item.action)).toEqual(
      expect.arrayContaining(["mapping", "mandate", "verify", "worker"]),
    );
    expect(f.inspect().canEnable).toBe(false);
    expect(f.inspect().areas[0]?.blockers).toContainEqual({
      id: "mandate",
      action: "mandate",
      message:
        "Open this PM's Product brief, write and save its mandate, then review it before running.",
    });
  });
  it("does not substitute a global Linear token for a missing named account", () => {
    const f = fixture();
    const raw = JSON.parse(readFileSync(f.projectFile, "utf8"));
    raw.linear = { connectionId: "client-two" };
    writeFileSync(f.projectFile, JSON.stringify(raw));
    expect(f.inspect().blockers).toContainEqual(
      expect.objectContaining({ id: "linear_connection", action: "linear" }),
    );
  });
  it("does not hide revoked source OAuth behind a saved manual token", () => {
    const f = fixture();
    f.context.sourceConnections = [
      {
        provider: "github",
        serverUrl: "https://github.com",
        available: true,
        connected: false,
        method: "oauth",
        needsReconnect: true,
      },
    ];
    expect(f.inspect().blockers).toContainEqual(
      expect.objectContaining({ id: "source_connection", action: "source" }),
    );
  });
  it("allows one-off readiness with an invalid schedule but refuses enabling automation", async () => {
    const f = fixture();
    const raw = JSON.parse(readFileSync(f.areasFile, "utf8"));
    raw.areas.core.schedule = "99 99 * * *";
    writeFileSync(f.areasFile, JSON.stringify(raw));
    expect(f.inspect().areas[0]).toMatchObject({
      canRun: true,
      canEnable: false,
    });
    await expect(
      setPmAutomation(f.root, "demo", "core", f.input(true), {
        context: async () => f.context,
      }),
    ).rejects.toMatchObject({
      status: 409,
      blockers: [expect.objectContaining({ id: "schedule" })],
    });
  });
});
