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
import { randomUUID } from "node:crypto";
import { initializeSetup } from "../setup/files.ts";
import { loadProject } from "../config.ts";
import { readEditableConfig } from "../setup/configEditor.ts";
import { createProjectOnboarding } from "./index.ts";
import { confirmSetup } from "./confirmation.ts";
import {
  createOnboardingStore,
  digest,
  type StoredOnboarding,
} from "./store.ts";
import { validateSetupAnalysis } from "./analysis.ts";
import type {
  ConfirmProjectSetupInput,
  ProjectSetupProposal,
} from "./types.ts";
import type { RepositorySnapshot } from "./repository.ts";

let root: string;
const sha = "a".repeat(40);
const source =
  '{"scripts":{"test:unit":"vitest run","build":"vite build"},"packageManager":"npm@10"}';
const snapshot: RepositorySnapshot = {
  repository: {
    provider: "github",
    repo: "owner/app",
    branch: "main",
    sha,
    filesRead: ["package.json"],
    truncated: false,
  },
  paths: ["package.json"],
  files: [{ path: "package.json", content: source }],
};
const proposal = (): ProjectSetupProposal => ({
  commands: {
    test: {
      command: "npm run test:unit",
      rationale: "The inspected manifest defines this unit-test script.",
      evidence: [{ path: "package.json", quote: '"test:unit":"vitest run"' }],
    },
    build: {
      command: "npm run build",
      rationale: "The manifest defines an existing build.",
      evidence: [{ path: "package.json", quote: '"build":"vite build"' }],
    },
  },
  firstPm: {
    name: "App investigator",
    mandate:
      "Understand the existing application and its real editing flows before proposing changes. Product intent beyond inspected source remains unknown.",
    evidence: [{ path: "package.json", quote: '"packageManager":"npm@10"' }],
  },
});
function report(projectSetup?: ProjectSetupProposal) {
  return validateSetupAnalysis(
    {
      summary: "An existing application with build and unit test scripts.",
      recommendation: "hosted",
      rationale: "No browser environment has been tested.",
      stack: ["Node"],
      missingInputs: [],
      hosted: { provider: "url", instructions: [] },
      docker: null,
      proposedFiles: [],
      warnings: [],
      ...(projectSetup ? { projectSetup } : {}),
    },
    snapshot,
    [],
  );
}
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "gremlins-confirm-")));
  initializeSetup(root, process.cwd(), {
    project: "app",
    repo: "owner/app",
    createInitialPm: false,
    settings: {
      workflow: { kind: "pull-request", baseBranch: "main" },
      verification: { mode: "repository" },
    },
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});
async function fixture(legacy = false) {
  const path = join(root, "projects/app/project.json"),
    raw = JSON.parse(readFileSync(path, "utf8"));
  raw.privateOwnerSetting = { keep: "exactly" };
  raw.verified = "2026-10-05";
  writeFileSync(path, JSON.stringify(raw, null, 2) + "\n");
  const store = createOnboardingStore(root),
    configurationRevision = readEditableConfig(
      root,
      "projects/app/project.json",
    ).revision;
  const state: StoredOnboarding = {
    schema: 1,
    project: "app",
    configurationRevision,
    status: "analyzed",
    stage: "review-report",
    message: "Review",
    updatedAt: new Date().toISOString(),
    report: report(legacy ? undefined : proposal()),
  };
  await store.change("app", () => ({ state, result: undefined }));
  const input: ConfirmProjectSetupInput = {
    revision: digest(JSON.stringify(state)),
    configurationRevision,
    repositorySha: sha,
    commandKeys: ["test"],
  };
  const checkHead = vi.fn(async () => sha);
  const sourceControl = {
    resolveCredential: vi.fn(async () => ({
      token: "source-only-token",
      method: "oauth" as const,
    })),
  };
  const fetcher = vi.fn(
    async () => new Response(JSON.stringify({ sha }), { status: 200 }),
  );
  const service = createProjectOnboarding({
    root,
    packageRoot: process.cwd(),
    env: {},
    sourceControl,
    fetch: fetcher,
  });
  const confirm = (reviewed = input) =>
    confirmSetup({ root, store, project: "app", input: reviewed, checkHead });
  return {
    store,
    state,
    path,
    input,
    checkHead,
    service,
    sourceControl,
    fetcher,
    confirm,
  };
}
describe("reviewed repository setup", () => {
  it("saves only selected commands, preserves all other settings and PMs, and survives restart/replay", async () => {
    const f = await fixture(),
      before = loadProject(root, "app"),
      areas = readFileSync(join(root, "projects/app/areas.json"), "utf8");
    const response = await f.service.confirm("app", f.input);
    const after = loadProject(root, "app");
    expect(after.config.commands).toEqual({
      ...before.config.commands,
      test: "npm run test:unit",
    });
    expect(after.config.verified).toBeNull();
    expect(
      JSON.parse(readFileSync(f.path, "utf8")).privateOwnerSetting,
    ).toEqual({ keep: "exactly" });
    expect(readFileSync(join(root, "projects/app/areas.json"), "utf8")).toBe(
      areas,
    );
    expect(after.areas).toHaveLength(0);
    expect(response).toMatchObject({
      status: "analyzed",
      stale: false,
      setupConfirmation: {
        confirmed: true,
        repositorySha: sha,
        commandKeys: ["test"],
      },
    });
    expect(response.report?.projectSetup).toEqual(proposal());
    expect(f.sourceControl.resolveCredential).toHaveBeenCalledWith(
      expect.objectContaining({ write: false, repository: "owner/app" }),
    );
    expect(f.fetcher).toHaveBeenCalledTimes(1);
    const saved = readFileSync(f.path, "utf8");
    await f.service.confirm("app", f.input);
    expect(readFileSync(f.path, "utf8")).toBe(saved);
    const restarted = createProjectOnboarding({
      root,
      packageRoot: process.cwd(),
      env: {},
    });
    expect((await restarted.status("app")).setupConfirmation?.confirmed).toBe(
      true,
    );
  });
  it("supports no selected commands without changing configuration bytes or verification", async () => {
    const f = await fixture(),
      before = readFileSync(f.path, "utf8");
    await f.confirm({ ...f.input, commandKeys: [] });
    expect(readFileSync(f.path, "utf8")).toBe(before);
    expect((await f.service.status("app")).setupConfirmation).toMatchObject({
      confirmed: true,
      commandKeys: [],
    });
  });
  it("recovers configuration saved before acknowledgement without applying unrelated edits", async () => {
    const f = await fixture();
    let writes = 0;
    const interruptedStore = {
      ...f.store,
      change: ((project, action) =>
        f.store.change(project, (state) => {
          const next = action(state);
          if (++writes === 2)
            throw new Error("Simulated crash after config CAS");
          return next;
        })) as typeof f.store.change,
    };
    await expect(
      confirmSetup({
        root,
        store: interruptedStore,
        project: "app",
        input: f.input,
        checkHead: f.checkHead,
      }),
    ).rejects.toThrow("could not be saved");
    expect(loadProject(root, "app").config.commands.test).toBe(
      "npm run test:unit",
    );
    expect((await f.service.status("app")).setupConfirmation?.confirmed).toBe(
      true,
    );
    expect((await f.service.status("app")).stale).toBe(false);
    await f.confirm();
    expect(f.store.read("app")!.stage).toBe("setup-confirmed");
  });
  it("rejects stale SHA, state revisions, forged selections and config edits before writing", async () => {
    const f = await fixture(),
      before = readFileSync(f.path, "utf8");
    await expect(
      f.confirm({ ...f.input, revision: "0".repeat(64) }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      f.confirm({ ...f.input, commandKeys: ["install"] }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      f.confirm({ ...f.input, commandKeys: ["test", "test"] }),
    ).rejects.toMatchObject({ status: 400 });
    f.checkHead.mockResolvedValueOnce("b".repeat(40));
    await expect(f.confirm()).rejects.toMatchObject({
      code: "stale_repository",
    });
    expect(readFileSync(f.path, "utf8")).toBe(before);
    const raw = JSON.parse(before);
    raw.commands.test = "owner-command";
    writeFileSync(f.path, JSON.stringify(raw));
    await expect(f.confirm()).rejects.toMatchObject({ status: 409 });
    expect(loadProject(root, "app").config.commands.test).toBe("owner-command");
    expect(f.store.read("app")!.setupAcknowledgement).toBeUndefined();
  });
  it("rechecks concurrent edits and project incarnation after source resolution", async () => {
    const f = await fixture();
    f.checkHead.mockImplementationOnce(async () => {
      const raw = JSON.parse(readFileSync(f.path, "utf8"));
      raw.instanceId = randomUUID();
      writeFileSync(f.path, JSON.stringify(raw));
      return sha;
    });
    await expect(f.confirm()).rejects.toMatchObject({ status: 409 });
    expect((await f.service.status("app")).setupConfirmation?.confirmed).toBe(
      false,
    );
    expect(loadProject(root, "app").config.commands.test).not.toBe(
      "npm run test:unit",
    );
  });
  it("serializes identical confirmations and invalidates acknowledgement after unrelated config or report changes", async () => {
    const f = await fixture();
    await Promise.all([f.confirm(), f.confirm()]);
    expect((await f.service.status("app")).setupConfirmation?.confirmed).toBe(
      true,
    );
    const raw = JSON.parse(readFileSync(f.path, "utf8"));
    raw.privateOwnerSetting.keep = "new";
    writeFileSync(f.path, JSON.stringify(raw));
    expect((await f.service.status("app")).setupConfirmation?.confirmed).toBe(
      false,
    );
    expect((await f.service.status("app")).stale).toBe(true);
    await expect(f.confirm()).rejects.toMatchObject({ status: 409 });
  });
  it("keeps legacy analysis readable but requires structured reanalysis for confirmation", async () => {
    const f = await fixture(true);
    expect((await f.service.status("app")).report).toBeDefined();
    await expect(f.confirm()).rejects.toMatchObject({
      code: "proposal_missing",
    });
    expect(f.checkHead).not.toHaveBeenCalled();
  });
});
describe("grounded setup recommendations", () => {
  it("accepts cited commands and empty commands while rejecting fabricated evidence or unsupported keys", () => {
    expect(report(proposal()).projectSetup).toEqual(proposal());
    expect(
      report({ ...proposal(), commands: {} }).projectSetup!.commands,
    ).toEqual({});
    const fabricated = proposal();
    fabricated.commands.test!.evidence[0]!.quote = "invented test script";
    expect(() => report(fabricated)).toThrow("cite inspected source");
    const unread = proposal();
    unread.firstPm.evidence[0]!.path = "unread.md";
    expect(() => report(unread)).toThrow("cite inspected source");
    const extra = proposal();
    Object.assign(extra.commands, { deploy: { command: "deploy production" } });
    expect(() => report(extra)).toThrow("cite inspected source");
    const multiline = proposal();
    multiline.commands.test!.command = "npm test\nsecond-command";
    expect(() => report(multiline)).toThrow("cite inspected source");
    expect(report().projectSetup).toBeUndefined();
  });
});
