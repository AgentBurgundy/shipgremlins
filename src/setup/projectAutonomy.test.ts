import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { initializeSetup } from "./files.ts";
import { readEditableConfig } from "./configEditor.ts";
import { projectAutonomy, setProjectAutonomy } from "./projectAutonomy.ts";
import type { ReadinessContext } from "./pmReadiness.ts";
import type { LocalJob } from "../localRunners/types.ts";
import { loadProject } from "../config.ts";
import { knowledgeRevision } from "../pmKnowledge/index.ts";
import { PM_KNOWLEDGE_FILES } from "../pmKnowledge/prompts.ts";

let root: string;
const now = new Date("2026-10-14T12:30:00Z");
const context: ReadinessContext = {
  localMode: true,
  env: { GITHUB_TOKEN: "source", CLAUDE_CODE_OAUTH_TOKEN: "ai" },
  sourceConnections: [],
  serviceConnections: [],
  workers: [
    {
      id: "worker-one",
      name: "Local",
      status: "ready",
      busy: false,
      paused: false,
      createdAt: now.toISOString(),
      verifiedAt: now.toISOString(),
    },
  ],
};
beforeEach(() => {
  root = mkdtempSync(join(realpathSync(tmpdir()), "gremlins-autonomy-"));
  initializeSetup(root, process.cwd(), { project: "app", repo: "owner/app" });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
const input = (enabled: boolean) => ({
  enabled,
  revision: readEditableConfig(root, "projects/app/areas.json").revision,
  projectRevision: readEditableConfig(root, "projects/app/project.json")
    .revision,
});
const state = (jobs: LocalJob[] = [], ready = context) =>
  projectAutonomy(root, "app", jobs, ready, now);

describe("project autonomous work", () => {
  it("reports the next UTC patrol after discovery and keeps coding independent of a broken schedule", () => {
    const projectFile = join(root, "projects/app/project.json");
    const raw = JSON.parse(readFileSync(projectFile, "utf8"));
    raw.verified = "2026-10-14";
    writeFileSync(projectFile, JSON.stringify(raw));
    const areasFile = join(root, "projects/app/areas.json");
    const areas = JSON.parse(readFileSync(areasFile, "utf8"));
    areas.areas.core.schedule = "0 13 * * *";
    areas.areas.core.linearProjectId = "mapped-project";
    writeFileSync(areasFile, JSON.stringify(areas));
    const saveKnowledge = () => {
      const project = loadProject(root, "app");
      const directory = join(root, ".run/pm-knowledge/app/core");
      mkdirSync(directory, { recursive: true });
      writeFileSync(
        join(directory, "latest.json"),
        JSON.stringify({
          schema: 1,
          project: "app",
          area: "core",
          revision: knowledgeRevision(project, project.areas[0]!),
          documents: PM_KNOWLEDGE_FILES.map((name) => ({
            name,
            content: "Observed repository evidence.",
          })),
          provenance: { runId: 1, commitSha: "a".repeat(40) },
        }),
      );
    };
    saveKnowledge();
    const ready = {
      ...context,
      env: { ...context.env, LINEAR_API_KEY: "linear" },
    };
    expect(state([], ready)).toMatchObject({
      state: "waiting",
      nextRunAt: "2026-10-14T13:00:00.000Z",
      discoveryPending: [],
    });
    const codingPickup = {
      state: "current" as const,
      needsReview: [
        {
          ticketId: "ticket-2",
          identifier: "SHI-2",
          area: "core",
          jobId: "failed-2",
          runId: 2,
          status: "failed" as const,
          reason: "previous-failed" as const,
          href: "/activity?run=failed-2",
        },
      ],
    };
    expect(
      projectAutonomy(root, "app", [], ready, now, codingPickup),
    ).toMatchObject({
      state: "waiting",
      nextRunAt: "2026-10-14T13:00:00.000Z",
      codingPickup,
      message: expect.stringContaining("SHI-2 is approved but needs review"),
    });
    expect(
      projectAutonomy(root, "app", [], ready, now, {
        ...codingPickup,
        state: "unavailable",
      }).message,
    ).not.toContain("SHI-2");
    areas.areas.core.schedule = "99 99 * * *";
    writeFileSync(areasFile, JSON.stringify(areas));
    saveKnowledge();
    expect(state([], ready)).toMatchObject({
      state: "waiting",
      codingEnabled: true,
      nextRunAt: null,
      blockers: expect.arrayContaining([
        expect.objectContaining({ id: "schedule" }),
      ]),
    });
  });
  it("saves enabled intent before connections are ready and preserves project/brief settings", () => {
    setProjectAutonomy(root, "app", input(false));
    const projectBefore = readFileSync(
      join(root, "projects/app/project.json"),
      "utf8",
    );
    const areasBefore = JSON.parse(
      readFileSync(join(root, "projects/app/areas.json"), "utf8"),
    );
    expect(state().state).toBe("paused");
    setProjectAutonomy(root, "app", input(true));
    expect(state([], { ...context, env: {}, workers: [] })).toMatchObject({
      state: "blocked",
      enabled: true,
      investigationEnabled: true,
      codingEnabled: true,
      blockers: expect.arrayContaining([
        expect.objectContaining({ id: "source_connection" }),
      ]),
    });
    expect(readFileSync(join(root, "projects/app/project.json"), "utf8")).toBe(
      projectBefore,
    );
    const saved = JSON.parse(
      readFileSync(join(root, "projects/app/areas.json"), "utf8"),
    );
    expect(saved.areas.core).toEqual({
      ...areasBefore.areas.core,
      enabled: true,
      codingEnabled: true,
    });
  });
  it("recognizes repository discovery readiness without Linear, project verification or hosting", () => {
    const result = state();
    expect(result).toMatchObject({
      state: "waiting",
      nextRunAt: now.toISOString(),
    });
    expect(result.message).toContain("explore the repository");
    expect(result.blockers).toEqual([]);
    expect(result.discoveryPending).toHaveLength(1);
  });
  it("pauses both independent controls and permits pausing with unavailable connections", () => {
    setProjectAutonomy(root, "app", input(false));
    expect(state([], { ...context, env: {}, workers: [] })).toMatchObject({
      state: "paused",
      enabled: false,
      investigationEnabled: false,
      codingEnabled: false,
      nextRunAt: null,
      blockers: [],
    });
    const before = input(false).revision;
    setProjectAutonomy(root, "app", input(false));
    expect(input(false).revision).toBe(before);
  });
  it("rejects stale project and crew revisions without replacing newer edits", () => {
    const stale = input(false);
    const file = join(root, "projects/app/project.json");
    const raw = JSON.parse(readFileSync(file, "utf8"));
    raw.privateOperatorNote = "preserve";
    writeFileSync(file, JSON.stringify(raw));
    expect(() => setProjectAutonomy(root, "app", stale)).toThrow(/changed/);
    expect(state().enabled).toBe(true);
    const old = input(false);
    setProjectAutonomy(root, "app", input(false));
    expect(() =>
      setProjectAutonomy(root, "app", { ...old, enabled: true }),
    ).toThrow(/changed/);
  });
  it("shows running and queued work only for this project identity", () => {
    const job: LocalJob = {
      id: "job-one",
      runId: 1,
      type: "pm",
      project: "app",
      area: "core",
      status: "queued",
      createdAt: now.toISOString(),
    };
    expect(state([job]).state).toBe("queued");
    expect(state([{ ...job, status: "running" }]).state).toBe("running");
    const file = join(root, "projects/app/project.json");
    const raw = JSON.parse(readFileSync(file, "utf8"));
    raw.instanceId = "a0e1ad1b-7a44-4d88-8bbc-22308cd17790";
    writeFileSync(file, JSON.stringify(raw));
    expect(state([{ ...job, status: "running" }]).state).toBe("waiting");
  });
  it("requires an adopted crew and rejects malformed requests", () => {
    expect(() =>
      setProjectAutonomy(root, "app", { ...input(true), enabled: "yes" }),
    ).toThrow(/Provide enabled/);
    expect(() =>
      setProjectAutonomy(root, "app", { ...input(true), token: "private" }),
    ).toThrow(/Provide enabled/);
    writeFileSync(join(root, "projects/app/areas.json"), '{"areas":{}}');
    expect(() => setProjectAutonomy(root, "app", input(true))).toThrow(
      /Adopt a PM/,
    );
  });
});
