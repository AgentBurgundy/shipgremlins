import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { initializeSetup } from "../setup/files.ts";
import { loadProject } from "../config.ts";
import { readEditableConfig } from "../setup/configEditor.ts";
import {
  createOnboardingStore,
  digest,
  type StoredOnboarding,
} from "./store.ts";
import { validateSetupAnalysis } from "./analysis.ts";
import { crewSourceIdentity } from "./crewContext.ts";
import { createProjectOnboarding } from "./index.ts";
import {
  recommendedDocker,
  prepareRecommendedDocker,
} from "./recommendedDocker.ts";

let root: string;
const sha = "a".repeat(40),
  file = "projects/app/project.json";
const dockerfile = "examples/test/Dockerfile";
beforeEach(() => {
  root = realpathSync(
    mkdtempSync(join(tmpdir(), "gremlins-recommended-docker-")),
  );
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
function edit(update: (raw: Record<string, unknown>) => void) {
  const path = join(root, file),
    raw = JSON.parse(readFileSync(path, "utf8"));
  update(raw);
  writeFileSync(path, JSON.stringify(raw, null, 2) + "\n");
}
async function fixture() {
  const report = validateSetupAnalysis(
    {
      summary: "Real dashboard with disposable test adapters.",
      recommendation: "docker",
      rationale: "The repository has a documented public test application.",
      stack: ["Node"],
      missingInputs: [],
      hosted: { provider: "url", instructions: [] },
      proposedFiles: [],
      warnings: [],
      docker: {
        recipe: { kind: "dockerfile", dockerfile, context: "." },
        port: 3000,
        healthPath: "/fixture/health",
        services: [],
      },
      projectSetup: {
        commands: {},
        firstPm: {
          name: "Dashboard journey",
          mandate: "Inspect the real dashboard journeys.",
          evidence: [{ path: "README.md", quote: "public fixture" }],
        },
        appAccess: {
          kind: "public",
          summary: "The test dashboard uses a synthetic session.",
          evidence: [{ path: "README.md", quote: "public fixture" }],
        },
      },
    },
    {
      repository: {
        provider: "github",
        repo: "owner/app",
        branch: "main",
        sha,
        filesRead: [dockerfile, "README.md"],
        truncated: false,
      },
      paths: [dockerfile, "README.md"],
      files: [
        { path: dockerfile, content: "FROM node:22\nEXPOSE 3000" },
        { path: "README.md", content: "A public fixture" },
      ],
    },
    [],
  );
  const store = createOnboardingStore(root);
  const state: StoredOnboarding = {
    schema: 1,
    project: "app",
    configurationRevision: readEditableConfig(root, file).revision,
    status: "analyzed",
    stage: "review-report",
    message: "Review",
    updatedAt: new Date().toISOString(),
    report,
    recommendationSourceRevision: digest(
      JSON.stringify(crewSourceIdentity(loadProject(root, "app"))),
    ),
  };
  await store.change("app", () => ({ state, result: undefined }));
  const input = () => ({
    revision: digest(JSON.stringify(store.read("app"))),
    configurationRevision: readEditableConfig(root, file).revision,
  });
  const checkHead = vi.fn(async () => sha);
  const prepare = () =>
    prepareRecommendedDocker({
      root,
      store,
      project: "app",
      input: input(),
      checkHead,
    });
  const status = () =>
    recommendedDocker(store.read("app"), loadProject(root, "app"));
  return { state, store, input, checkHead, prepare, status };
}

describe("suggested Docker setup", () => {
  it("applies an existing public recipe despite unrelated adoption/Linear edits without changing commands or PMs", async () => {
    const f = await fixture();
    edit((raw) => {
      raw.description = "Owner edits";
      raw.verified = "2026-10-07";
    });
    const before = loadProject(root, "app"),
      areas = readFileSync(join(root, "projects/app/areas.json"), "utf8");
    expect(f.state.configurationRevision).not.toBe(
      f.input().configurationRevision,
    );
    expect(f.status()).toMatchObject({
      status: "ready",
      environment: "pm-test",
    });
    await f.prepare();
    const after = loadProject(root, "app");
    expect(after.config.verification).toEqual({
      mode: "browser",
      environment: "pm-test",
    });
    expect(after.config.environments?.["pm-test"]).toMatchObject({
      kind: "docker",
      recipe: { dockerfile },
      access: { kind: "public" },
    });
    expect(after.config.commands).toEqual(before.config.commands);
    expect(after.config.verified).toBeNull();
    expect(readFileSync(join(root, "projects/app/areas.json"), "utf8")).toBe(
      areas,
    );
    expect(f.checkHead).toHaveBeenCalledWith(expect.anything(), "main");
    expect(f.status().status).toBe("configured");
    edit((raw) => {
      raw.verified = "2026-10-07";
    });
    const saved = readFileSync(join(root, file), "utf8");
    await f.prepare();
    expect(readFileSync(join(root, file), "utf8")).toBe(saved);
  });
  it("exposes and applies the recommendation through the service using read-only source access", async () => {
    await fixture();
    const resolveCredential = vi.fn(async () => ({
      token: "source-test-token",
      method: "oauth" as const,
    }));
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ sha })));
    const execute = vi.fn();
    const service = createProjectOnboarding({
      root,
      packageRoot: process.cwd(),
      env: {},
      sourceControl: { resolveCredential },
      fetch: fetcher,
      execute,
    });
    const state = await service.status("app");
    expect(state.recommendedDocker?.status).toBe("ready");
    const result = await service.prepareDocker("app", {
      revision: state.revision,
      configurationRevision: state.configurationRevision,
    });
    expect(result.recommendedDocker?.status).toBe("configured");
    expect(resolveCredential).toHaveBeenCalledWith(
      expect.objectContaining({ write: false, repository: "owner/app" }),
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(execute).not.toHaveBeenCalled();
  });
  it.each([
    "required-input",
    "private-access",
    "unknown-access",
    "new-files",
    "unread-dockerfile",
    "image",
    "invalid-recipe",
    "analyzing",
    "source-changed",
  ])("keeps %s suggestions from one-action setup", async (condition) => {
    const f = await fixture();
    await f.store.change("app", (state) => {
      const report = state!.report!;
      if (condition === "required-input")
        report.missingInputs.push({
          key: "database",
          label: "Database",
          description: "Needs an account",
          required: true,
        });
      if (condition === "private-access")
        report.projectSetup!.appAccess!.kind = "password";
      if (condition === "unknown-access") delete report.projectSetup!.appAccess;
      if (condition === "new-files")
        report.proposedFiles.push({
          path: ".gremlins/Dockerfile",
          content: "FROM node:22",
          reason: "New file",
        });
      if (condition === "unread-dockerfile")
        report.repository.filesRead = ["README.md"];
      if (condition === "image")
        report.docker!.recipe = { kind: "image", image: "node:22" };
      if (condition === "invalid-recipe") report.docker!.port = 0;
      if (condition === "analyzing") state!.status = "analyzing";
      if (condition === "source-changed")
        state!.recommendationSourceRevision = "0".repeat(64);
      return { state: state!, result: undefined };
    });
    const before = readFileSync(join(root, file), "utf8");
    expect(f.status().status).toBe("blocked");
    await expect(f.prepare()).rejects.toThrow();
    expect(readFileSync(join(root, file), "utf8")).toBe(before);
    expect(f.checkHead).not.toHaveBeenCalled();
  });
  it.each(["repo", "server", "branch"])(
    "invalidates an otherwise current suggestion after its %s changes",
    async (kind) => {
      const f = await fixture();
      edit((raw) => {
        if (kind === "repo") raw.repo = "owner/other";
        if (kind === "server") {
          raw.provider = "gitlab";
          raw.serverUrl = "https://gitlab.example.test";
        }
        if (kind === "branch")
          raw.workflow = { kind: "pull-request", baseBranch: "develop" };
      });
      expect(f.status().status).toBe("blocked");
      await expect(f.prepare()).rejects.toThrow(
        "repository or inspection branch changed",
      );
    },
  );
  it("preserves a selected browser target and dormant environments", async () => {
    const f = await fixture();
    const target = {
      kind: "url",
      role: "preview",
      url: "https://preview.example.test",
      access: { kind: "public" },
    };
    edit((raw) => {
      raw.environments = { "pm-test": target };
      raw.verification = { mode: "browser", environment: "pm-test" };
    });
    const before = readFileSync(join(root, file), "utf8");
    await expect(f.prepare()).rejects.toThrow("different browser environment");
    expect(readFileSync(join(root, file), "utf8")).toBe(before);
    edit((raw) => {
      raw.verification = { mode: "repository" };
    });
    expect(f.status().environment).toBe("pm-test-2");
    await f.prepare();
    expect(loadProject(root, "app").config.environments?.["pm-test"]).toEqual(
      target,
    );
  });
  it("refuses a changed source head and caller-supplied recipes without writing settings", async () => {
    const f = await fixture(),
      before = readFileSync(join(root, file), "utf8");
    f.checkHead.mockResolvedValue("b".repeat(40));
    await expect(f.prepare()).rejects.toThrow(
      "repository changed after analysis",
    );
    await expect(
      prepareRecommendedDocker({
        root,
        store: f.store,
        project: "app",
        input: { ...f.input(), target: {} } as ReturnType<typeof f.input>,
        checkHead: f.checkHead,
      }),
    ).rejects.toThrow("current source report");
    expect(readFileSync(join(root, file), "utf8")).toBe(before);
  });
  it.each(["configuration", "report"])(
    "does not apply over a concurrent %s change",
    async (kind) => {
      const f = await fixture();
      f.checkHead.mockImplementation(async () => {
        if (kind === "configuration")
          edit((raw) => {
            raw.description = "Keep concurrent edit";
          });
        else
          await f.store.change("app", (state) => {
            state!.report!.summary = "Newer report";
            return { state: state!, result: undefined };
          });
        return sha;
      });
      await expect(f.prepare()).rejects.toThrow("Project setup changed");
      expect(loadProject(root, "app").config.verification).toEqual({
        mode: "repository",
      });
      if (kind === "configuration")
        expect(
          JSON.parse(readFileSync(join(root, file), "utf8")).description,
        ).toBe("Keep concurrent edit");
    },
  );
  it("checks the actual PM test branch when browser setup changes the inspection branch", async () => {
    const f = await fixture();
    edit((raw) => {
      raw.workflow = { kind: "promotion" };
      raw.branches = {
        production: "main",
        staging: "staging",
        integration: "pm-staging",
      };
    });
    f.checkHead
      .mockResolvedValueOnce(sha)
      .mockResolvedValueOnce("b".repeat(40));
    await expect(f.prepare()).rejects.toThrow("PM test branch differs");
    expect(f.checkHead).toHaveBeenLastCalledWith(
      expect.anything(),
      "pm-staging",
    );
    expect(loadProject(root, "app").config.verification).toEqual({
      mode: "repository",
    });
  });
});
