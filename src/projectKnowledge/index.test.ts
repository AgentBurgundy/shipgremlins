import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { initializeSetup } from "../setup/files.ts";
import { loadProject } from "../config.ts";
import { knowledgeRevision } from "../pmKnowledge/index.ts";
import { createProjectKnowledge } from "./index.ts";
import { parseExecutionLimits } from "../execution.ts";
import type { LocalJob } from "../localRunners/types.ts";
let root: string;
beforeEach(() => {
  root = mkdtempSync(join(realpathSync(tmpdir()), "gremlins-project-brain-"));
  for (const project of ["app", "other"])
    initializeSetup(root, fileURLToPath(new URL("../..", import.meta.url)), {
      project,
      repo: `owner/${project}`,
    });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
describe("shared project knowledge", () => {
  it("includes whole owner decisions and explicitly reports bounded-context omissions", () => {
    const store = createProjectKnowledge({ root, secrets: () => [] }),
      decision = "a".repeat(3900) + " Never change billing calculations.";
    for (let i = 0; i < 5; i++)
      store.add("app", {
        text: decision,
        revision: store.read("app").revision,
      });
    const project = loadProject(root, "app"),
      context = store.context(project, project.areas[0]!);
    const payload = JSON.parse(context.slice(context.indexOf("\n{")));
    expect(Buffer.byteLength(JSON.stringify(payload))).toBeLessThanOrEqual(
      12 * 1024,
    );
    expect(payload.omittedOwnerDecisions).toBeGreaterThan(0);
    expect(payload.ownerDecisions.length).toBeGreaterThan(0);
    expect(
      payload.ownerDecisions.every(
        (d: { text: string }) => d.text === decision,
      ),
    ).toBe(true);
    expect(context).toContain("report incomplete owner context");
  });
  it("keeps multilingual decisions readable and removable when an addition exceeds the byte limit", () => {
    const directory = join(root, ".run", "project-knowledge", "app"),
      file = join(directory, "decisions.json");
    mkdirSync(directory, { recursive: true });
    const decisions = Array.from({ length: 43 }, () => ({
      id: randomUUID(),
      text: "界".repeat(4000),
      createdAt: "2026-10-05T00:00:00Z",
    }));
    const original = JSON.stringify({ schema: 1, decisions });
    writeFileSync(file, original);
    const store = createProjectKnowledge({ root, secrets: () => [] }),
      before = store.read("app");
    expect(() =>
      store.add("app", { revision: before.revision, text: "界".repeat(4000) }),
    ).toThrow(/storage limit/);
    expect(readFileSync(file, "utf8")).toBe(original);
    expect(store.read("app").decisions).toHaveLength(43);
    expect(
      store.remove("app", decisions[0]!.id, before.revision).decisions,
    ).toHaveLength(42);
  });
  it("serializes overlapping coding scopes without blocking unrelated projects or PM investigations", () => {
    const file = join(root, "projects", "app", "areas.json"),
      raw = JSON.parse(readFileSync(file, "utf8"));
    raw.areas.core.paths = ["."];
    writeFileSync(file, JSON.stringify(raw));
    const store = createProjectKnowledge({ root }),
      job = {
        id: "job-new",
        runId: 2,
        type: "developer",
        project: "app",
        area: "core",
        status: "queued",
        createdAt: "2026-10-05",
      } as LocalJob;
    const running = {
      ...job,
      id: "job-running",
      runId: 1,
      status: "running" as const,
    };
    expect(store.admissionBlocker(job, [running])).toContain("share ownership");
    expect(
      store.admissionBlocker({ ...job, project: "other" }, [running]),
    ).toBeUndefined();
    expect(
      store.admissionBlocker({ ...job, type: "pm" }, [running]),
    ).toBeUndefined();
  });
  it("preserves owner decisions across restarts, rejects stale writes and isolates projects", () => {
    const store = createProjectKnowledge({ root, secrets: () => [] });
    const before = store.read("app");
    const result = store.add("app", {
      revision: before.revision,
      text: "Ship large features dark; prioritize completed tasks.",
    });
    expect(createProjectKnowledge({ root }).read("app").decisions).toEqual(
      result.decisions,
    );
    expect(store.read("other").decisions).toEqual([]);
    expect(() =>
      store.add("app", { revision: before.revision, text: "Stale edit" }),
    ).toThrow(/changed/);
    expect(
      store.remove("app", result.decisions[0]!.id, result.revision).decisions,
    ).toEqual([]);
  });
  it("rejects secrets and corrupt owner stores without replacing them", () => {
    const store = createProjectKnowledge({
      root,
      secrets: () => ["my-unique-secret"],
    });
    expect(() =>
      store.add("app", {
        revision: store.read("app").revision,
        text: "Use my-unique-secret",
      }),
    ).toThrow(/credentials/);
    const dir = join(root, ".run", "project-knowledge", "app");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "decisions.json");
    writeFileSync(file, "broken");
    expect(() => store.read("app")).toThrow(/preserved/);
    expect(readFileSync(file, "utf8")).toBe("broken");
  });
  it("shares current sibling evidence with provenance, excludes stale observations and reports overlapping ownership", () => {
    const file = join(root, "projects", "app", "areas.json");
    const raw = JSON.parse(readFileSync(file, "utf8"));
    raw.areas.security = {
      ...raw.areas.core,
      name: "Security",
      label: "pm:security",
      memoryBranch: "pm/security",
      paths: ["src/auth"],
      sharedTouchpoints: [],
    };
    raw.areas.core.paths = ["src"];
    writeFileSync(file, JSON.stringify(raw));
    const project = loadProject(root, "app"),
      area = project.areas.find((a) => a.key === "security")!;
    const dir = join(root, ".run", "pm-knowledge", "app", "security");
    mkdirSync(dir, { recursive: true });
    const snapshot = {
      schema: 1,
      project: "app",
      area: "security",
      revision: knowledgeRevision(project, area),
      documents: ["discovery.md", "features.md", "queue.md", "memory.md"].map(
        (name) => ({
          name,
          content: "Only scoped queries may read tenant data.",
        }),
      ),
      provenance: {
        jobId: "job-1",
        runId: 1,
        commitSha: "a".repeat(40),
        repository: "owner/app",
        branch: "main",
        completedAt: "2026-10-05T00:00:00Z",
      },
    };
    writeFileSync(join(dir, "latest.json"), JSON.stringify(snapshot));
    const store = createProjectKnowledge({ root });
    expect(store.context(project, project.areas[0]!)).toContain(
      "Only scoped queries",
    );
    expect(store.read("app").overlaps).toContainEqual({
      path: "src",
      areas: ["core", "security"],
    });
    raw.areas.security.mandate = "Changed owner goals";
    writeFileSync(file, JSON.stringify(raw));
    const updated = loadProject(root, "app");
    expect(store.context(updated, updated.areas[0]!)).not.toContain(
      "Only scoped queries",
    );
    expect(
      store.read("app").areas.find((a) => a.key === "security")?.state,
    ).toBe("stale");
  });
});
describe("execution limit admission", () => {
  it("keeps existing config defaults and rejects typo or unbounded limits", () => {
    expect(parseExecutionLimits(undefined)).toBeUndefined();
    expect(
      parseExecutionLimits({ maxDailyRuns: 12, maxJobMinutes: 15 }),
    ).toEqual({ maxDailyRuns: 12, maxJobMinutes: 15 });
    for (const input of [
      { maxDailyRun: 5 },
      { maxDailyRuns: 0 },
      { maxJobMinutes: 46 },
      { maxConcurrentJobs: 1.5 },
      { maxDailyRuns: "12" },
      null,
    ])
      expect(() => parseExecutionLimits(input)).toThrow();
  });
});
