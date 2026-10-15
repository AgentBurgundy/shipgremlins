import {
  chmodSync,
  linkSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadProject } from "../config.ts";
import { initializeSetup } from "../setup/files.ts";
import {
  projectAiTarget,
  readAiRouting,
  saveAiRouting,
} from "../ai/routing.ts";
import {
  CodingAgentError,
  codingAgentOwnsArea,
  codingAgentsForArea,
  effectiveCodingAi,
  ensureCodingAgents,
  initializeCodingAgents,
  previewCodingAgents,
  readCodingAgents,
  resolveCodingAgent,
  saveCodingAgents,
  type CodingAgentJob,
} from "./index.ts";

const roots: string[] = [];
const projectId = "11111111-2222-3333-4444-555555555555";
const areaId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function world() {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "gremlins-coders-"));
  roots.push(root);
  initializeSetup(root, process.cwd(), { project: "app", repo: "owner/app" });
  edit(root, "project.json", (value) => {
    value.instanceId = projectId;
  });
  edit(root, "areas.json", (value) => {
    value.areas.core!.instanceId = areaId;
    value.areas.core!.wipLimit = 2;
  });
  return root;
}
interface FixtureConfig {
  instanceId?: string;
  automationPaused?: boolean;
  areas: Record<
    string,
    {
      name: string;
      label: string;
      instanceId?: string;
      enabled: boolean;
      codingEnabled?: boolean;
      wipLimit: number;
    }
  >;
}
function edit(
  root: string,
  path: string,
  change: (value: FixtureConfig) => void,
) {
  const file = join(root, "projects/app", path),
    value = JSON.parse(readFileSync(file, "utf8"));
  change(value);
  writeFileSync(file, JSON.stringify(value, null, 2) + "\n");
}
const path = (root: string) => join(root, "projects/app/coders.json");
const save = (root: string, agents: unknown[]) =>
  saveCodingAgents(root, "app", {
    revision: readCodingAgents(root, "app").revision,
    agents,
  });
const draft = (changes: object = {}) => ({
  key: "builder",
  name: "Builder",
  enabled: false,
  areas: [],
  maxConcurrent: 1,
  ...changes,
});
function route(root: string, selection: object, area = false) {
  const project = loadProject(root, "app"),
    scope = projectAiTarget(
      project,
      "coder",
      area ? project.areas[0] : undefined,
    );
  saveAiRouting(
    root,
    scope,
    { revision: readAiRouting(root, scope, {}).revision, coder: selection },
    {},
  );
}
const job = (changes: Partial<CodingAgentJob> = {}): CodingAgentJob => ({
  type: "developer",
  project: "app",
  projectInstanceId: projectId,
  area: "core",
  ...changes,
});

describe("first-class coding agent storage", () => {
  it("reads deterministic legacy profiles without writing and preserves independent switches, old AI routes and WIP", () => {
    const root = world();
    edit(root, "areas.json", (value) => {
      value.areas.core!.codingEnabled = false;
      value.areas.other = {
        ...value.areas.core!,
        name: "Other",
        label: "pm:other",
        instanceId: randomUUID(),
        enabled: false,
        codingEnabled: true,
        wipLimit: 8,
      };
    });
    route(root, { provider: "codex", model: "project-coder" });
    route(root, { provider: "claude", model: "old-core" }, true);
    const before = readdirSync(root, { recursive: true }).sort();
    const first = readCodingAgents(root, "app"),
      second = readCodingAgents(root, "app");
    expect(first).toEqual(second);
    expect(first.legacy).toBe(true);
    expect(first.agents).toMatchObject([
      {
        key: "core",
        enabled: false,
        areas: ["core"],
        maxConcurrent: 2,
        ai: { provider: "claude", model: "old-core" },
      },
      {
        key: "other",
        enabled: true,
        areas: ["other"],
        maxConcurrent: 4,
        ai: { provider: "codex", model: "project-coder" },
      },
    ]);
    expect(first.agents[0]!.instanceId).toMatch(/^[a-f0-9-]{36}$/);
    expect(readdirSync(root, { recursive: true }).sort()).toEqual(before);
    expect(codingAgentsForArea(root, loadProject(root, "app"), "core")).toEqual(
      [],
    );
    const legacy = resolveCodingAgent(root, loadProject(root, "app"), job());
    expect(
      effectiveCodingAi(root, loadProject(root, "app"), legacy, {}),
    ).toEqual({ provider: "claude", model: "old-core" });
  });
  it("freezes legacy coders once and adds no implicit coder when another PM is adopted", () => {
    const root = world(),
      legacy = readCodingAgents(root, "app");
    const saved = ensureCodingAgents(root, "app"),
      bytes = readFileSync(path(root));
    expect(saved.legacy).toBe(false);
    expect(saved.agents).toEqual(legacy.agents);
    expect(ensureCodingAgents(root, "app")).toEqual(saved);
    expect(initializeCodingAgents(root, "app")).toEqual(saved);
    expect(readFileSync(path(root))).toEqual(bytes);
    edit(root, "areas.json", (value) => {
      value.areas.newpm = {
        ...value.areas.core!,
        label: "pm:newpm",
        instanceId: randomUUID(),
        enabled: true,
      };
    });
    expect(readCodingAgents(root, "app").agents).toEqual(saved.agents);
    expect(
      codingAgentsForArea(root, loadProject(root, "app"), "newpm"),
    ).toEqual([]);
  });
  it("initializes new projects with no coders and never overwrites explicit settings", () => {
    const root = world();
    const empty = initializeCodingAgents(root, "app");
    expect(empty).toMatchObject({ legacy: false, agents: [] });
    expect(
      JSON.parse(readFileSync(path(root), "utf8")).compatibility.agents,
    ).toEqual([]);
    const saved = save(root, [draft()]);
    expect(initializeCodingAgents(root, "app")).toEqual(saved);
    expect(ensureCodingAgents(root, "app")).toEqual(saved);
  });
  it("previews purely, stamps missing new identities and atomically saves the exact reviewed profiles privately", () => {
    const root = world();
    initializeCodingAgents(root, "app");
    const before = readFileSync(path(root)),
      current = readCodingAgents(root, "app");
    const preview = previewCodingAgents(root, "app", {
      revision: current.revision,
      agents: [
        draft(),
        draft({
          key: "helper",
          name: "Helper",
          enabled: true,
          areas: ["core"],
          maxConcurrent: 4,
          ai: { provider: "codex", model: "chosen" },
        }),
      ],
    });
    expect(preview.agents[0]!.instanceId).toMatch(/^[a-f0-9-]{36}$/);
    expect(readFileSync(path(root))).toEqual(before);
    const saved = saveCodingAgents(root, "app", {
      revision: current.revision,
      agents: preview.agents,
    });
    expect(saved.agents).toEqual(preview.agents);
    expect(saved.revision).not.toBe(current.revision);
    if (process.platform !== "win32")
      expect(statSync(path(root)).mode & 0o077).toBe(0);
    expect(
      readdirSync(join(root, "projects/app")).some((name) =>
        name.endsWith(".tmp"),
      ),
    ).toBe(false);
    expect(JSON.stringify(saved)).not.toMatch(
      /compatibility|retiredInstances|areaInstances|generation/,
    );
    expect(() =>
      saveCodingAgents(root, "app", { revision: current.revision, agents: [] }),
    ).toThrow(/changed/);
    expect(readCodingAgents(root, "app")).toEqual(saved);
  });
  it.each([
    ["unknown fields", [draft({ secret: "must-not-echo" })]],
    ["invalid provider", [draft({ ai: { provider: "other" } })]],
    [
      "invalid model",
      [draft({ ai: { provider: "codex", model: "token with spaces" } })],
    ],
    ["unknown PM", [draft({ areas: ["missing"] })]],
    ["enabled without assignment", [draft({ enabled: true })]],
    ["duplicate assignments", [draft({ areas: ["core", "core"] })]],
    ["duplicate keys", [draft(), draft()]],
    [
      "duplicate identities",
      [
        draft({ instanceId: areaId }),
        draft({ key: "another", instanceId: areaId }),
      ],
    ],
    ["invalid identity", [draft({ instanceId: "not-a-uuid" })]],
    ["reserved key", [draft({ key: "con" })]],
    ["empty name", [draft({ name: " " })]],
    ["control characters", [draft({ name: "unsafe\nname" })]],
    ["unbounded concurrency", [draft({ maxConcurrent: 5 })]],
    ["fractional concurrency", [draft({ maxConcurrent: 1.5 })]],
    [
      "too many profiles",
      Array.from({ length: 21 }, (_, i) => draft({ key: `coder-${i}` })),
    ],
  ])("rejects %s without changing protected state", (_name, agents) => {
    const root = world();
    initializeCodingAgents(root, "app");
    const before = readFileSync(path(root));
    expect(() => save(root, agents)).toThrow(CodingAgentError);
    expect(readFileSync(path(root))).toEqual(before);
  });
  it("rejects stale project/PM revisions and changes to existing identities", () => {
    const root = world();
    const old = ensureCodingAgents(root, "app");
    for (const agent of [
      { ...old.agents[0]!, instanceId: undefined },
      { ...old.agents[0]!, instanceId: randomUUID() },
    ])
      expect(() => save(root, [agent])).toThrow(/changed/);
    const bytes = readFileSync(path(root));
    edit(root, "areas.json", (value) => {
      value.areas.core!.enabled = !value.areas.core!.enabled;
    });
    expect(() =>
      saveCodingAgents(root, "app", {
        revision: old.revision,
        agents: old.agents,
      }),
    ).toThrow(/changed/);
    const newer = readCodingAgents(root, "app");
    edit(root, "project.json", (value) => {
      value.automationPaused = true;
    });
    expect(() =>
      saveCodingAgents(root, "app", {
        revision: newer.revision,
        agents: newer.agents,
      }),
    ).toThrow(/changed/);
    expect(readFileSync(path(root))).toEqual(bytes);
  });
  it("fences linked files and paths, oversized/malformed documents, and permissive private-file modes", () => {
    const root = world();
    initializeCodingAgents(root, "app");
    const canonical = readFileSync(path(root));
    const linked = join(root, "linked.json");
    linkSync(path(root), linked);
    expect(() => readCodingAgents(root, "app")).toThrow(/safely/);
    expect(() => save(root, [])).toThrow(/safely/);
    rmSync(linked);
    if (process.platform !== "win32") {
      renameSync(path(root), linked);
      symlinkSync(linked, path(root), "file");
      expect(() => readCodingAgents(root, "app")).toThrow(/safely/);
      rmSync(path(root));
      renameSync(linked, path(root));
    }
    const directory = join(root, "projects/app"),
      actual = join(root, "app-protected");
    renameSync(directory, actual);
    symlinkSync(actual, directory, "junction");
    expect(() => readCodingAgents(root, "app")).toThrow(/safely/);
    rmSync(directory);
    renameSync(actual, directory);
    for (const content of ["not-json", " ".repeat(128 * 1024 + 1)]) {
      writeFileSync(path(root), content);
      expect(() => readCodingAgents(root, "app")).toThrow(/safely/);
    }
    writeFileSync(path(root), canonical);
    if (process.platform !== "win32") {
      chmodSync(path(root), 0o644);
      expect(() => readCodingAgents(root, "app")).toThrow(/safely/);
      chmodSync(path(root), 0o600);
    }
    expect(readCodingAgents(root, "app").agents).toEqual([]);
  });
  it("respects a live lifecycle lock and never mutates a replacement project's store", () => {
    const root = world();
    const current = ensureCodingAgents(root, "app"),
      bytes = readFileSync(path(root));
    const lock = join(root, ".run/linear/provisioning/app.lock");
    writeFileSync(lock, String(process.pid), { mode: 0o600 });
    expect(() => save(root, current.agents)).toThrow(/holds this project/);
    rmSync(lock);
    edit(root, "project.json", (value) => {
      value.instanceId = randomUUID();
    });
    expect(() => readCodingAgents(root, "app")).toThrow(/safely/);
    expect(() =>
      saveCodingAgents(root, "app", { revision: current.revision, agents: [] }),
    ).toThrow(/safely/);
    expect(readFileSync(path(root))).toEqual(bytes);
  });
  it("requires exact job identities and allows explicit owner review to repair replaced PM assignments", () => {
    const root = world();
    const saved = ensureCodingAgents(root, "app"),
      agent = saved.agents[0]!;
    let project = loadProject(root, "app");
    const bound = job({
      coderKey: agent.key,
      coderInstanceId: agent.instanceId,
    });
    expect(resolveCodingAgent(root, project, bound)).toEqual(agent);
    for (const change of [
      { coderInstanceId: randomUUID() },
      { coderInstanceId: undefined },
      { coderKey: undefined },
      { projectInstanceId: undefined },
      { project: "elsewhere" },
      { area: "missing" },
    ])
      expect(() =>
        resolveCodingAgent(root, project, { ...bound, ...change }),
      ).toThrow(/changed/);
    edit(root, "areas.json", (value) => {
      value.areas.core!.instanceId = randomUUID();
    });
    expect(() => codingAgentsForArea(root, project, "core")).toThrow(/changed/);
    project = loadProject(root, "app");
    expect(codingAgentOwnsArea(root, project, agent, "core")).toBe(false);
    expect(codingAgentsForArea(root, project, "core")).toEqual([]);
    expect(() => resolveCodingAgent(root, project, bound)).toThrow(/changed/);
    save(root, readCodingAgents(root, "app").agents);
    expect(codingAgentOwnsArea(root, project, agent, "core")).toBe(true);
    expect(resolveCodingAgent(root, project, bound).instanceId).toBe(
      agent.instanceId,
    );
  });
  it("prevents deleted/recreated keys or moved identities from inheriting older bound jobs", () => {
    const root = world(),
      first = ensureCodingAgents(root, "app").agents[0]!;
    expect(() => save(root, [{ ...first, key: "renamed" }])).toThrow(/changed/);
    save(root, []);
    expect(() => save(root, [first])).toThrow(/changed/);
    const { instanceId: _old, ...withoutId } = first;
    const replacement = save(root, [withoutId]).agents[0]!;
    expect(replacement.instanceId).not.toBe(first.instanceId);
    expect(() =>
      resolveCodingAgent(
        root,
        loadProject(root, "app"),
        job({ coderKey: first.key, coderInstanceId: first.instanceId }),
      ),
    ).toThrow(/changed/);
  });
  it("uses project coder routing for explicit inheritance and never accepts caller-forged AI settings", () => {
    const root = world();
    route(root, { provider: "codex", model: "project" });
    route(root, { provider: "claude", model: "pm" }, true);
    initializeCodingAgents(root, "app");
    const agent = save(root, [draft({ areas: ["core"] })]).agents[0]!,
      project = loadProject(root, "app");
    expect(effectiveCodingAi(root, project, agent, {})).toEqual({
      provider: "codex",
      model: "project",
    });
    expect(
      effectiveCodingAi(
        root,
        project,
        { ...agent, ai: { provider: "claude", model: "forged" } },
        {},
      ),
    ).toEqual({ provider: "codex", model: "project" });
    const pinned = save(root, [
      { ...agent, ai: { provider: "claude", model: "explicit" } },
    ]).agents[0]!;
    expect(effectiveCodingAi(root, project, pinned, {})).toEqual({
      provider: "claude",
      model: "explicit",
    });
  });
  it("preserves frozen legacy AI only for actual pre-migration queued/running jobs and rejects fresh unbound requests", () => {
    const root = world();
    route(root, { provider: "claude", model: "before" }, true);
    const first = ensureCodingAgents(root, "app"),
      agent = first.agents[0]!,
      project = loadProject(root, "app");
    const old = job({
      id: `job-${randomUUID()}`,
      status: "queued",
      createdAt: "2000-01-01T00:00:00.000Z",
    });
    save(root, [{ ...agent, ai: { provider: "codex", model: "after" } }]);
    const legacy = resolveCodingAgent(root, project, old);
    expect(legacy.ai).toEqual({ provider: "claude", model: "before" });
    expect(effectiveCodingAi(root, project, legacy, {}, old)).toEqual({
      provider: "claude",
      model: "before",
    });
    expect(effectiveCodingAi(root, project, agent, {})).toEqual({
      provider: "codex",
      model: "after",
    });
    const cutoff = JSON.parse(readFileSync(path(root), "utf8")).compatibility
      .savedAt;
    for (const value of [
      job(),
      { ...old, id: undefined },
      { ...old, status: "failed" },
      { ...old, createdAt: cutoff },
      { ...old, projectInstanceId: undefined },
    ])
      expect(() => resolveCodingAgent(root, project, value)).toThrow(/changed/);
    save(root, [
      { ...readCodingAgents(root, "app").agents[0]!, enabled: false },
    ]);
    expect(resolveCodingAgent(root, project, old)).toEqual({
      ...legacy,
      enabled: false,
    });
    expect(effectiveCodingAi(root, project, legacy, {}, old)).toEqual(
      legacy.ai,
    );
    save(root, []);
    expect(() => resolveCodingAgent(root, project, old)).toThrow(/changed/);
    expect(() => effectiveCodingAi(root, project, legacy, {}, old)).toThrow(
      /changed/,
    );
    edit(root, "areas.json", (value) => {
      value.areas.core!.instanceId = randomUUID();
    });
    expect(() =>
      resolveCodingAgent(root, loadProject(root, "app"), old),
    ).toThrow(/changed/);
  });
  it("preserves only pre-migration stored project-wide sync jobs without exposing a maintenance coder", () => {
    const root = world();
    route(root, { provider: "claude", model: "maintenance-before" });
    const view = ensureCodingAgents(root, "app"),
      project = loadProject(root, "app");
    const old = job({
      area: undefined,
      developerKind: "sync",
      id: `job-${randomUUID()}`,
      status: "running",
      createdAt: "2000-01-01T00:00:00.000Z",
    });
    route(root, { provider: "codex", model: "maintenance-after" });
    const resolved = resolveCodingAgent(root, project, old);
    expect(resolved).toMatchObject({
      key: "legacy-maintenance",
      enabled: false,
      areas: [],
    });
    expect(readCodingAgents(root, "app").agents).toEqual(view.agents);
    expect(effectiveCodingAi(root, project, resolved, {}, old)).toEqual({
      provider: "claude",
      model: "maintenance-before",
    });
    for (const change of [
      { id: undefined },
      { developerKind: "build" },
      { status: "succeeded" },
      { coderKey: "core" },
      { createdAt: new Date(Date.now() + 1000).toISOString() },
    ])
      expect(() =>
        resolveCodingAgent(root, project, { ...old, ...change }),
      ).toThrow(/changed/);
    const fresh = world();
    initializeCodingAgents(fresh, "app");
    expect(() =>
      resolveCodingAgent(fresh, loadProject(fresh, "app"), old),
    ).toThrow(/changed/);
  });
});
