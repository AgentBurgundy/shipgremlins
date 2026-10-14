import {
  mkdtempSync,
  realpathSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  linkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  aiCredentials,
  hasAiCredentials,
  resolveAiSelection,
  saveAiSelection,
  selectedAiCredential,
} from "./provider.ts";
import {
  readAiRouting,
  saveAiRouting,
  projectAiTarget,
  type AiRoutingScope,
} from "./routing.ts";
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
const project = {
    name: "app",
    instanceId: "11111111-2222-3333-4444-555555555555",
  },
  area = {
    key: "checkout",
    instanceId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  },
  projectScope = { project },
  areaScope = { project, area };
function world() {
  const root = mkdtempSync(
    join(realpathSync(tmpdir()), "gremlins-ai-routing-"),
  );
  roots.push(root);
  return root;
}
function save(root: string, scope: AiRoutingScope, changes: object) {
  return saveAiRouting(
    root,
    scope,
    { revision: readAiRouting(root, scope, {}).revision, ...changes },
    {},
  );
}
const codex = JSON.stringify({
  auth_mode: "chatgpt",
  tokens: {
    id_token: "synthetic-id",
    access_token: "synthetic-access",
    refresh_token: "synthetic-refresh",
    account_id: "account-1",
  },
});
describe("scoped AI routing", () => {
  it("resolves area role, project role, project default and workspace in that order", () => {
    const root = world();
    saveAiSelection(root, { provider: "claude", model: "workspace" });
    expect(readAiRouting(root, areaScope, {}).effective).toEqual({
      setup: { provider: "claude", model: "workspace", source: "workspace" },
      pm: { provider: "claude", model: "workspace", source: "workspace" },
      coder: { provider: "claude", model: "workspace", source: "workspace" },
    });
    save(root, projectScope, {
      default: { provider: "codex", model: "project-default" },
      pm: { provider: "claude", model: "project-pm" },
      coder: { provider: "codex", model: "project-coder" },
    });
    let view = save(root, areaScope, {
      pm: { provider: "codex", model: "area-pm" },
    });
    expect(view.effective).toEqual({
      setup: {
        provider: "codex",
        model: "project-default",
        source: "project-default",
      },
      pm: { provider: "codex", model: "area-pm", source: "pm-role" },
      coder: {
        provider: "codex",
        model: "project-coder",
        source: "project-role",
      },
    });
    view = save(root, areaScope, { pm: null });
    expect(view.effective.pm).toEqual({
      provider: "claude",
      model: "project-pm",
      source: "project-role",
    });
    save(root, projectScope, { pm: null, coder: null });
    expect(readAiRouting(root, areaScope, {}).effective.pm.source).toBe(
      "project-default",
    );
    save(root, projectScope, { default: null });
    expect(readAiRouting(root, areaScope, {}).effective.pm.source).toBe(
      "workspace",
    );
  });
  it("returns only a selected provider/model to scoped callers and never falls back when disconnected", () => {
    const root = world(),
      env = { CLAUDE_CODE_OAUTH_TOKEN: "connected-claude" };
    save(root, projectScope, {
      coder: { provider: "codex", model: "coding-model" },
    });
    const target = projectAiTarget({ config: project }, "coder", area),
      selected = resolveAiSelection(root, env, target);
    expect(selected).toEqual({ provider: "codex", model: "coding-model" });
    expect(hasAiCredentials(root, env, selected)).toBe(false);
    expect(selectedAiCredential(root, env, selected)).toBeUndefined();
    expect(() => aiCredentials(root, env, selected)).toThrow(/Codex/);
    const result = selectedAiCredential(
      root,
      { ...env, CODEX_AUTH_JSON: codex },
      selected,
    )!;
    expect(result.ai).toEqual(selected);
    expect(JSON.parse(result.credential).tokens).toMatchObject({
      access_token: "synthetic-access",
      refresh_token: "",
    });
    expect(
      Object.keys(
        aiCredentials(root, { ...env, CODEX_AUTH_JSON: codex }, selected),
      ),
    ).toEqual(["CODEX_AUTH_JSON"]);
    expect(resolveAiSelection(root, env)).toEqual({ provider: "claude" });
    expect(resolveAiSelection(root, { CODEX_AUTH_JSON: codex })).toEqual({
      provider: "codex",
    });
  });
  it("supports legacy identities while isolating replacement project and PM incarnations", () => {
    const root = world(),
      legacy = { project: { name: "app" } };
    save(root, legacy, { coder: { provider: "codex" } });
    expect(readAiRouting(root, legacy, {}).effective.coder.provider).toBe(
      "codex",
    );
    expect(readAiRouting(root, projectScope, {}).effective.coder.provider).toBe(
      "claude",
    );
    const previous = save(root, areaScope, { pm: { provider: "codex" } });
    const replaced = {
      project,
      area: { ...area, instanceId: "22222222-3333-4444-5555-666666666666" },
    };
    expect(readAiRouting(root, replaced, {}).overrides).toEqual({});
    expect(() =>
      saveAiRouting(
        root,
        replaced,
        { revision: previous.revision, pm: null },
        {},
      ),
    ).toThrow(/changed/);
  });
  it("rejects stale and ABA revisions, including changed inherited project/workspace choices", () => {
    const root = world(),
      initial = readAiRouting(root, projectScope, {});
    save(root, projectScope, { default: { provider: "codex" } });
    save(root, projectScope, { default: null });
    expect(readAiRouting(root, projectScope, {}).revision).not.toBe(
      initial.revision,
    );
    expect(() =>
      saveAiRouting(
        root,
        projectScope,
        { revision: initial.revision, pm: { provider: "claude" } },
        {},
      ),
    ).toThrow(/changed/);
    const oldArea = readAiRouting(root, areaScope, {});
    save(root, projectScope, { pm: { provider: "codex" } });
    expect(() =>
      saveAiRouting(
        root,
        areaScope,
        { revision: oldArea.revision, pm: null },
        {},
      ),
    ).toThrow(/changed/);
    const beforeWorkspace = readAiRouting(root, projectScope, {});
    saveAiSelection(root, { provider: "codex" });
    expect(() =>
      saveAiRouting(
        root,
        projectScope,
        { revision: beforeWorkspace.revision, coder: null },
        {},
      ),
    ).toThrow(/changed/);
  });
  it("preserves unspecified roles and returns detached public route values", () => {
    const root = world();
    save(root, projectScope, {
      pm: { provider: "codex" },
      coder: { provider: "claude", model: "coder" },
    });
    const result = save(root, projectScope, { pm: null });
    expect(result.overrides).toEqual({
      coder: { provider: "claude", model: "coder" },
    });
    result.overrides.coder!.model = "forged";
    expect(readAiRouting(root, projectScope, {}).overrides.coder!.model).toBe(
      "coder",
    );
  });
  it.each([
    { pm: { provider: "openai", apiKey: "private" } },
    { coder: { provider: "codex", model: "model; shell" } },
    { pm: { provider: "claude", model: "x".repeat(101) } },
    { apiKey: "private" },
    { pm: undefined },
  ])("rejects unsupported or credential-bearing update fields %j", (change) => {
    const root = world();
    expect(() => save(root, projectScope, change)).toThrow();
    expect(readAiRouting(root, projectScope, {}).overrides).toEqual({});
  });
  it("rejects area defaults, traversal identities and unknown scope fields", () => {
    const root = world();
    expect(() =>
      save(root, areaScope, { default: { provider: "codex" } }),
    ).toThrow();
    for (const scope of [
      { project: { name: "../app" } },
      { project, area: { key: "bad/path" } },
      { project: { ...project, instanceId: "wrong" } },
      { project, path: "private" },
    ])
      expect(() => readAiRouting(root, scope as AiRoutingScope, {})).toThrow();
  });
  it("rejects hardlinked/corrupt private route state rather than silently using a workspace account", () => {
    const root = world();
    save(root, projectScope, { pm: { provider: "codex" } });
    const directory = join(root, ".run/ai/routes"),
      file = join(
        directory,
        readdirSync(directory).find((file) => file.endsWith(".json"))!,
      ),
      link = join(root, "route-link");
    linkSync(file, link);
    expect(() => readAiRouting(root, projectScope, {})).toThrow(/safely/);
    rmSync(link);
    const value = JSON.parse(readFileSync(file, "utf8"));
    value.overrides.pm = { provider: "external", apiKey: "private" };
    writeFileSync(file, JSON.stringify(value));
    expect(() =>
      resolveAiSelection(
        root,
        { CLAUDE_CODE_OAUTH_TOKEN: "available" },
        { ...projectScope, role: "pm" },
      ),
    ).toThrow(/safely/);
  });
  it("keeps a live controller lock closed and recovers a dead owner without losing CAS", () => {
    const root = world();
    save(root, projectScope, { pm: { provider: "codex" } });
    const directory = join(root, ".run/ai/routes"),
      filename = readdirSync(directory).find((file) => file.endsWith(".json"))!,
      lock = join(directory, filename.replace(/\.json$/, ".lock"));
    writeFileSync(lock, JSON.stringify({ pid: process.pid, token: "owner" }), {
      mode: 0o600,
    });
    expect(() => save(root, projectScope, { pm: null })).toThrow(
      /being updated/,
    );
    writeFileSync(
      lock,
      JSON.stringify({ pid: 2147483647, token: "dead-owner" }),
    );
    expect(save(root, projectScope, { pm: null }).overrides).toEqual({});
  });
});
