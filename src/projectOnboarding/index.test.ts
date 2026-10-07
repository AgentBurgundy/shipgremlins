import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  linkSync,
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
import { initializeSetup } from "../setup/files.ts";
import { loadProject } from "../config.ts";
import {
  createProjectOnboarding,
  type ProjectOnboardingOptions,
} from "./index.ts";
import { SETUP_SYSTEM, validateSetupAnalysis } from "./analysis.ts";
import {
  readRepository,
  resolveRepositoryHead,
  type RepositorySnapshot,
} from "./repository.ts";
import { publishSetupDraft } from "./publish.ts";
import { createOnboardingStore } from "./store.ts";
import { PlannerExecutionError } from "../pmPlanner/docker.ts";

const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
const SHA = "a".repeat(40),
  BLOB = "b".repeat(40),
  TREE = "c".repeat(40),
  HEAD = "d".repeat(40);
const TOKEN = "source-credential-private-for-test",
  CLAUDE = "model-credential-private-for-test";
let root: string;
const sourceFile = {
  path: "package.json",
  content:
    '{"scripts":{"start":"node server.js"},"dependencies":{"express":"4.0.0"}}',
};
const suggestion = () => ({
  summary: "An Express application with a start command.",
  recommendation: "docker",
  rationale:
    "package.json identifies a Node server; the setup recipe is proposed and untested.",
  stack: ["Node", "Express"],
  missingInputs: [
    {
      key: "auth",
      label: "Test account",
      description: "Provide a dedicated test user if sign-in is required.",
      required: false,
    },
  ],
  hosted: {
    provider: "url",
    instructions: ["Choose an existing nonproduction URL."],
  },
  docker: {
    recipe: {
      kind: "dockerfile",
      dockerfile: ".gremlins/Dockerfile",
      context: ".",
    },
    port: 3000,
  },
  proposedFiles: [
    {
      path: ".gremlins/Dockerfile",
      content:
        'FROM node:22\nWORKDIR /app\nCOPY . .\nRUN npm ci\nEXPOSE 3000\nCMD ["npm","start"]\n',
      reason: "A reviewable container definition.",
    },
  ],
  warnings: ["Review and merge new setup files before testing."],
});
const snapshot = (): RepositorySnapshot => ({
  repository: {
    provider: "github",
    repo: "owner/app",
    branch: "main",
    sha: SHA,
    filesRead: ["package.json"],
    truncated: false,
  },
  files: [sourceFile],
  paths: ["package.json", "server.js"],
});
const response = (
  value: unknown,
  status = 200,
  headers?: Record<string, string>,
) => new Response(JSON.stringify(value), { status, headers });
beforeEach(() => {
  root = mkdtempSync(join(realpathSync(tmpdir()), "gremlins-setup-analysis-"));
  initializeSetup(root, packageRoot, {
    project: "app",
    repo: "owner/app",
    settings: { workflow: { kind: "pull-request", baseBranch: "main" } },
  });
  vi.spyOn(globalThis, "fetch").mockRejectedValue(
    new Error("No external network in setup tests."),
  );
});
afterEach(async () => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});
function repositoryFetch() {
  return vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const path = String(url);
    expect(init?.headers).toMatchObject({ authorization: `Bearer ${TOKEN}` });
    expect(init?.redirect).toBe("error");
    if (path.endsWith("/commits/main")) return response({ sha: SHA });
    if (path.includes(`/git/trees/${SHA}?`))
      return response({
        tree: [
          {
            path: "package.json",
            type: "blob",
            mode: "100644",
            sha: BLOB,
            size: 100,
          },
        ],
      });
    if (path.endsWith(`/git/blobs/${BLOB}`))
      return response({
        encoding: "base64",
        content: Buffer.from(sourceFile.content).toString("base64"),
      });
    throw new Error("Unexpected fixture source request.");
  });
}
function fixture(extra: Partial<ProjectOnboardingOptions> = {}) {
  const fetcher = repositoryFetch();
  const execute = vi.fn(async () => suggestion());
  const sourceControl = {
    resolveCredential: vi.fn(async () => ({
      token: TOKEN,
      method: "oauth" as const,
    })),
  };
  const options = {
    root,
    packageRoot,
    env: { CLAUDE_CODE_OAUTH_TOKEN: CLAUDE },
    fetch: fetcher as typeof fetch,
    sourceControl,
    execute,
    ...extra,
  };
  return {
    service: createProjectOnboarding(options),
    fetcher,
    execute,
    sourceControl,
    options,
  };
}

describe("project Setup Gremlin", () => {
  it("retains a previous report and fixed model failure category across restart, then clears failure on successful retry", async () => {
    const sourceControl = {
      resolveCredential: vi.fn(),
      acquireLease: vi.fn(async (_input: { jobId: string }) => ({
        token: TOKEN,
        method: "oauth" as const,
      })),
      releaseLease: vi.fn(async (_id: string) => {}),
    };
    const f = fixture({ sourceControl });
    await f.service.discover("app");
    await f.service.idle();
    const previous = (await f.service.status("app")).report;
    f.execute.mockRejectedValueOnce(new PlannerExecutionError("context_limit"));
    await f.service.discover("app");
    await f.service.idle();
    const restarted = createProjectOnboarding(f.options);
    const failed = await restarted.status("app");
    expect(failed).toMatchObject({
      status: "failed",
      stage: "failed",
      failure: { code: "context_limit", stage: "analyzing-files" },
      report: previous,
    });
    expect(failed.message).toContain("context");
    expect(failed.message).not.toContain("Check source access");
    for (const secret of [TOKEN, CLAUDE])
      expect(JSON.stringify(failed)).not.toContain(secret);
    expect(sourceControl.releaseLease.mock.calls.map(([id]) => id)).toEqual(
      sourceControl.acquireLease.mock.calls.map(([request]) => request.jobId),
    );
    await restarted.discover("app");
    await restarted.idle();
    expect(await restarted.status("app")).toMatchObject({ status: "analyzed" });
    expect(await restarted.status("app")).not.toHaveProperty("failure");
  });
  it("analyzes actual pinned source files without PMs, Linear, a verified worker, or application execution", async () => {
    writeFileSync(join(root, "projects/app/areas.json"), '{"areas":{}}\n');
    const f = fixture();
    const before = readFileSync(
      join(root, "projects/app/project.json"),
      "utf8",
    );
    const idle = await f.service.status("app");
    expect(idle.status).toBe("idle");
    expect(idle.configurationRevision).toMatch(/^[a-f0-9]{64}$/);
    await f.service.discover("app", { revision: idle.revision });
    await f.service.idle();
    const result = await f.service.status("app");
    expect(result.status).toBe("analyzed");
    expect(result.report?.repository.sha).toBe(SHA);
    expect(result.report?.repository.filesRead).toEqual(["package.json"]);
    const execution = (
      f.execute.mock.calls as unknown as {
        prompt: string;
        credential: string;
      }[][]
    )[0]![0]!;
    expect(execution.prompt).toContain("express");
    expect(JSON.parse(execution.prompt).workflow).toMatchObject({
      kind: "pull-request",
    });
    expect(execution.prompt).not.toContain(TOKEN);
    expect(execution.credential).toBe(CLAUDE);
    expect(JSON.stringify(result)).not.toContain(CLAUDE);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    expect(readFileSync(join(root, "projects/app/project.json"), "utf8")).toBe(
      before,
    );
    expect(result.message).toContain("has not been verified");
    expect(f.sourceControl.resolveCredential).toHaveBeenCalledWith(
      expect.objectContaining({ write: false, repository: "owner/app" }),
    );
  });
  it("requires Claude and reports safe provider errors without saving credentials", async () => {
    expect(
      (await fixture({ env: {} }).service.status("app")).message,
    ).toContain("Connect Claude Code");
    await expect(fixture({ env: {} }).service.discover("app")).rejects.toThrow(
      "Connect Claude",
    );
    const f = fixture({
      sourceControl: {
        resolveCredential: async () => {
          throw new Error(TOKEN);
        },
      },
    });
    await f.service.discover("app");
    await f.service.idle();
    const status = await f.service.status("app");
    expect(status.status).toBe("failed");
    expect(status.message).not.toContain(TOKEN);
    expect(
      readFileSync(join(root, ".run/project-onboarding/app.json"), "utf8"),
    ).not.toContain(TOKEN);
  });
  it("does not mistake ordinary process environment values for credentials", async () => {
    const f = fixture({
      env: {
        CLAUDE_CODE_OAUTH_TOKEN: CLAUDE,
        NODE_ENV: "production",
        npm_lifecycle_event: "typecheck",
      },
      execute: async () => ({
        ...suggestion(),
        summary: "Run typecheck and use synthetic data, never production.",
      }),
    });
    await f.service.discover("app");
    await f.service.idle();
    expect((await f.service.status("app")).status).toBe("analyzed");
    expect((await f.service.status("app")).report?.summary).toContain(
      "production",
    );
  });
  it("reserves source credentials during analysis and publication and releases failed operations", async () => {
    const sourceControl = {
      resolveCredential: vi.fn(),
      acquireLease: vi.fn(async (_input: { jobId: string }) => ({
        token: TOKEN,
        method: "oauth" as const,
      })),
      releaseLease: vi.fn(async (_id: string) => {}),
    };
    const f = fixture({ sourceControl });
    await f.service.discover("app");
    await f.service.idle();
    const report = await f.service.status("app");
    expect(report.status).toBe("analyzed");
    f.fetcher.mockImplementationOnce(async () => response({ sha: HEAD }));
    await f.service.prepareSetupPr("app", { revision: report.revision });
    await f.service.idle();
    expect((await f.service.status("app")).status).toBe("failed");
    expect(sourceControl.resolveCredential).not.toHaveBeenCalled();
    expect(sourceControl.acquireLease).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: expect.stringMatching(/^job-setup-source-[a-f0-9]{32}$/),
        write: false,
        repository: "owner/app",
      }),
    );
    expect(sourceControl.acquireLease).toHaveBeenCalledWith(
      expect.objectContaining({ write: true }),
    );
    const acquired = sourceControl.acquireLease.mock.calls.map(
      ([input]) => input.jobId,
    );
    expect(
      sourceControl.releaseLease.mock.calls.map((call) => call[0]),
    ).toEqual(acquired);
  });
  it("releases a source lease that arrives after cancellation", async () => {
    let finish!: (value: { token: string; method: "oauth" }) => void;
    const sourceControl = {
      resolveCredential: vi.fn(),
      acquireLease: vi.fn(
        () =>
          new Promise<{ token: string; method: "oauth" }>((resolve) => {
            finish = resolve;
          }),
      ),
      releaseLease: vi.fn(async (_id: string) => {}),
    };
    const f = fixture({ sourceControl });
    await f.service.discover("app");
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    await f.service.cancel("app", {
      revision: (await f.service.status("app")).revision,
    });
    await f.service.idle();
    finish({ token: TOKEN, method: "oauth" });
    await vi.waitFor(() =>
      expect(sourceControl.releaseLease).toHaveBeenCalledTimes(2),
    );
    expect(f.fetcher).not.toHaveBeenCalled();
    expect(f.execute).not.toHaveBeenCalled();
  });
  it("keeps a report current after its own environment CAS but not unrelated changes or a different inspection branch", async () => {
    const f = fixture();
    await f.service.discover("app");
    await f.service.idle();
    const before = await f.service.status("app"),
      file = join(root, "projects/app/project.json");
    const config = JSON.parse(readFileSync(file, "utf8"));
    config.environments = {
      setup: {
        kind: "url",
        role: "preview",
        url: "https://preview.example.test",
      },
    };
    config.verification = { mode: "browser", environment: "setup" };
    writeFileSync(file, JSON.stringify(config));
    expect((await f.service.status("app")).stale).toBe(true);
    const configured = await f.service.recordConfigured("app", {
      previousConfigurationRevision: before.configurationRevision,
      profile: "hosted",
    });
    expect(configured.stale).toBe(false);
    expect(configured.report).toEqual(before.report);
    writeFileSync(file, JSON.stringify(config) + "\n");
    const unrelated = await f.service.status("app");
    writeFileSync(file, JSON.stringify(config) + "\n\n");
    expect(
      (
        await f.service.recordConfigured("app", {
          previousConfigurationRevision: unrelated.configurationRevision,
          profile: "hosted",
        })
      ).stale,
    ).toBe(true);
    config.workflow.baseBranch = "develop";
    writeFileSync(file, JSON.stringify(config));
    expect(
      (
        await f.service.recordConfigured("app", {
          previousConfigurationRevision: configured.configurationRevision,
          profile: "hosted",
        })
      ).stale,
    ).toBe(true);
  });
  it("rejects stale state revisions and settings changed during analysis", async () => {
    let done!: (value: unknown) => void;
    const waiting = new Promise((resolve) => {
      done = resolve;
    });
    const f = fixture({ execute: async () => waiting });
    await expect(
      f.service.discover("app", { revision: "old" }),
    ).rejects.toThrow("changed");
    await f.service.discover("app");
    await vi.waitFor(() => expect(f.service.busy()).toBe(true));
    const path = join(root, "projects/app/project.json");
    writeFileSync(path, readFileSync(path, "utf8") + "\n");
    done(suggestion());
    await f.service.idle();
    expect((await f.service.status("app")).status).toBe("failed");
    expect((await f.service.status("app")).message).toContain(
      "settings changed",
    );
  });
  it("bounds hung model execution and does not admit concurrent duplicate work", async () => {
    const f = fixture({
      timeoutMs: 30,
      execute: async () => new Promise(() => {}),
    });
    await f.service.discover("app");
    await expect(f.service.discover("app")).rejects.toThrow("already running");
    await f.service.idle();
    expect((await f.service.status("app")).status).toBe("failed");
    expect((await f.service.status("app")).message).toMatch(
      /timed out|canceled/,
    );
    expect(f.service.busy()).toBe(false);
  });
  it("recovers an orphaned operation as interrupted and never silently republishes", async () => {
    const f = fixture();
    const state = await f.service.status("app");
    await createOnboardingStore(root).change("app", () => ({
      state: {
        schema: 1,
        project: "app",
        configurationRevision: state.configurationRevision,
        status: "publishing",
        stage: "publishing-draft",
        message: "Pending",
        updatedAt: new Date().toISOString(),
        operation: { id: "a".repeat(32), pid: 99999999 },
      },
      result: undefined,
    }));
    expect((await f.service.status("app")).status).toBe("interrupted");
    expect(f.fetcher).not.toHaveBeenCalled();
  });
  it("applies an explicit known URL without Claude/source and delegates config CAS", async () => {
    const applyProfile = vi.fn(async () => undefined);
    const f = fixture({ env: {}, applyProfile });
    const state = await f.service.status("app");
    const target = {
      kind: "url" as const,
      role: "preview" as const,
      url: "https://preview.example.test",
    };
    const result = await f.service.apply("app", {
      revision: state.revision,
      configurationRevision: state.configurationRevision,
      profile: "hosted",
      target,
    });
    expect(applyProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        project: "app",
        configurationRevision: state.configurationRevision,
        target,
      }),
    );
    expect(result.appliedProfile).toBe("hosted");
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.fetcher).not.toHaveBeenCalled();
    await expect(
      f.service.apply("app", {
        revision: state.revision,
        configurationRevision: state.configurationRevision,
        profile: "hosted",
        target,
      }),
    ).rejects.toThrow("changed");
  });
  it("fails closed on hard-linked state without modifying another file", async () => {
    mkdirSync(join(root, ".run/project-onboarding"), { recursive: true });
    const outside = join(root, "unrelated.txt");
    writeFileSync(outside, "preserve");
    linkSync(outside, join(root, ".run/project-onboarding/app.json"));
    await expect(fixture().service.status("app")).rejects.toThrow(
      "read safely",
    );
    expect(readFileSync(outside, "utf8")).toBe("preserve");
  });
  it("cancels a new analysis without discarding the previous report", async () => {
    const f = fixture();
    await f.service.discover("app");
    await f.service.idle();
    const previous = (await f.service.status("app")).report;
    f.execute.mockImplementationOnce(async () => new Promise(() => {}));
    await f.service.discover("app");
    const running = await f.service.status("app");
    await f.service.cancel("app", { revision: running.revision });
    await f.service.idle();
    const canceled = await f.service.status("app");
    expect(canceled.status).toBe("failed");
    expect(canceled.report).toEqual(previous);
    expect(f.service.busy()).toBe(false);
  });
  it("does not publish when the repository advanced since analysis", async () => {
    const f = fixture();
    await f.service.discover("app");
    await f.service.idle();
    f.fetcher.mockImplementationOnce(async () => response({ sha: HEAD }));
    await f.service.prepareSetupPr("app", {
      revision: (await f.service.status("app")).revision,
    });
    await f.service.idle();
    expect((await f.service.status("app")).message).toContain("branch changed");
    expect(
      f.fetcher.mock.calls.every(
        ([, init]) => !init?.method || init.method === "GET",
      ),
    ).toBe(true);
  });
  it("holds a durable operation while applying a profile so analysis cannot race configuration changes", async () => {
    let finish!: () => void;
    const f = fixture({
      applyProfile: () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    });
    const state = await f.service.status("app");
    const applying = f.service.apply("app", {
      revision: state.revision,
      configurationRevision: state.configurationRevision,
      profile: "hosted",
      target: {
        kind: "url",
        role: "preview",
        url: "https://preview.example.test",
      },
    });
    await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    await expect(f.service.discover("app")).rejects.toThrow("already running");
    finish();
    await applying;
    expect(f.service.busy()).toBe(false);
  });
});

describe("source and output boundaries", () => {
  it("keeps large trees and quote-heavy files inside the planner's serialized transport bound", async () => {
    const fetcher = vi.fn(async (url: string | URL | Request) => {
      const path = String(url);
      if (path.includes("/commits/")) return response({ sha: SHA });
      if (path.includes("/git/trees/"))
        return response({
          tree: Array.from({ length: 2100 }, (_, i) => ({
            path: `src/${String(i).padStart(4, "0")}-${"x".repeat(180)}.ts`,
            type: "blob",
            mode: "100644",
            sha: BLOB,
            size: 22000,
          })),
        });
      return response({
        encoding: "base64",
        content: Buffer.from(('"'.repeat(200) + "\n").repeat(110)).toString(
          "base64",
        ),
      });
    });
    const result = await readRepository(
      loadProject(root, "app"),
      TOKEN,
      fetcher as typeof fetch,
      AbortSignal.timeout(5000),
      [],
    );
    const payload = JSON.stringify({
      credential: CLAUDE,
      system: SETUP_SYSTEM,
      prompt: JSON.stringify({
        project: "app",
        repository: result.repository,
        files: result.files,
        paths: result.paths,
      }),
    });
    expect(Buffer.byteLength(payload)).toBeLessThan(2 * 1024 * 1024);
    expect(result.files.length).toBeGreaterThan(0);
    expect(result.repository.truncated).toBe(true);
    expect(result.repository.filesRead).toEqual(
      result.files.map((file) => file.path),
    );
  });
  it("rejects traversal, existing-file replacement, arbitrary app edits and leaked tokens", () => {
    for (const path of [
      "../Dockerfile",
      "src/app.ts",
      "package.json",
      ".env",
      ".github/workflows/pwn.yml",
    ]) {
      const value = suggestion();
      value.proposedFiles[0]!.path = path;
      expect(() => validateSetupAnalysis(value, snapshot(), [TOKEN])).toThrow();
    }
    const value = suggestion();
    value.summary = TOKEN;
    expect(() => validateSetupAnalysis(value, snapshot(), [TOKEN])).toThrow();
    expect(() =>
      validateSetupAnalysis(
        {
          ...suggestion(),
          docker: {
            recipe: {
              kind: "dockerfile",
              dockerfile: "invented/Dockerfile",
              context: ".",
            },
            port: 3000,
          },
        },
        snapshot(),
        [],
      ),
    ).toThrow();
    expect(SETUP_SYSTEM).toContain("UNTRUSTED DATA");
  });
  it("normalizes accidental literal paragraphs only in prose and refuses hosted certainty when entrypoints were omitted", () => {
    const value = suggestion();
    value.summary = "A real dashboard.\\n\\nIts providers are synthetic.";
    value.rationale = "Observed package.json.\\r\\n\\r\\nTest it before use.";
    value.proposedFiles[0]!.content = "RUN printf 'a\\n\\nb'";
    const result = validateSetupAnalysis(value, snapshot(), []);
    expect(result.summary).toContain("dashboard.\n\nIts providers");
    expect(result.rationale).toContain("package.json.\n\nTest");
    expect(result.proposedFiles[0]!.content).toBe(
      value.proposedFiles[0]!.content,
    );
    const incomplete = snapshot();
    incomplete.repository.inspection = {
      strategy: "entrypoints-and-dependencies",
      totalFiles: 3,
      treeTruncated: false,
      requests: 2,
      sourceBytes: 200,
      fetchedBytes: 200,
      limits: {
        files: 80,
        sourceBytes: 524288,
        fileBytes: 1048576,
        fetchedBytes: 8388608,
        depth: 7,
      },
      files: [],
      unresolved: ["src/server.ts"],
      criticalMissing: ["src/server.ts"],
    };
    expect(() =>
      validateSetupAnalysis(
        { ...suggestion(), recommendation: "hosted", docker: null },
        incomplete,
        [],
      ),
    ).toThrow("hosted-only recommendation is not grounded");
    expect(SETUP_SYSTEM).toContain("NOT mean its actual dashboard cannot run");
  });
  it("does not fetch private paths or symlink blobs; omits secret-bearing source content", async () => {
    const fetcher = vi.fn(async (url: string | URL | Request) => {
      const path = String(url);
      if (path.endsWith("/commits/main")) return response({ sha: SHA });
      if (path.includes("/git/trees/"))
        return response({
          tree: [
            { path: "package.json", type: "blob", mode: "100644", sha: BLOB },
            { path: ".env.local", type: "blob", mode: "100644", sha: TREE },
            {
              path: "credentials.json",
              type: "blob",
              mode: "100644",
              sha: TREE,
            },
            { path: "link.ts", type: "blob", mode: "120000", sha: TREE },
            { path: "server.ts", type: "blob", mode: "100644", sha: HEAD },
          ],
        });
      if (path.endsWith(BLOB))
        return response({
          encoding: "base64",
          content: Buffer.from(sourceFile.content).toString("base64"),
        });
      if (path.endsWith(HEAD))
        return response({
          encoding: "base64",
          content: Buffer.from(`const token = '${TOKEN}';`).toString("base64"),
        });
      throw new Error("Must not read private blobs.");
    });
    const result = await readRepository(
      loadProject(root, "app"),
      TOKEN,
      fetcher as typeof fetch,
      AbortSignal.timeout(1000),
      [TOKEN],
    );
    expect(result.repository.filesRead).toEqual(["package.json"]);
    expect(JSON.stringify(result.files)).not.toContain(TOKEN);
    expect(fetcher.mock.calls.some(([url]) => String(url).endsWith(TREE))).toBe(
      false,
    );
  });
  it("pins GitLab file reads to the resolved commit and keeps strict head resolution", async () => {
    const project = loadProject(root, "app");
    project.config.provider = "gitlab";
    project.config.serverUrl = "https://gitlab.example.test";
    const fetcher = vi.fn(async (url: string | URL | Request) =>
      String(url).includes("/repository/commits/")
        ? response({ id: SHA })
        : String(url).includes("/repository/tree?")
          ? response([
              { type: "blob", mode: "100644", path: "package.json", id: BLOB },
            ])
          : response({
              encoding: "base64",
              content: Buffer.from(sourceFile.content).toString("base64"),
            }),
    );
    const result = await readRepository(
      project,
      TOKEN,
      fetcher as typeof fetch,
      AbortSignal.timeout(1000),
      [],
    );
    expect(result.repository.sha).toBe(SHA);
    expect(
      fetcher.mock.calls
        .filter(([u]) => String(u).includes("/repository/files/"))
        .every(([u]) => String(u).endsWith(`?ref=${SHA}`)),
    ).toBe(true);
    expect(
      (
        await resolveRepositoryHead({
          project,
          credential: { token: TOKEN },
          fetch: fetcher as typeof fetch,
        })
      ).repoUrl,
    ).toBe("https://gitlab.example.test/owner/app.git");
  });
  it("uses provider default branch only for analysis after a missing configured branch", async () => {
    const usual = repositoryFetch();
    const fetcher = vi.fn(
      async (
        url: string | URL | Request,
        init?: RequestInit,
      ): Promise<Response> => {
        const path = String(url);
        if (path.endsWith("/commits/main")) return response({}, 404);
        if (path.endsWith("/repos/owner/app"))
          return response({ default_branch: "trunk" });
        if (path.endsWith("/commits/trunk")) return response({ sha: SHA });
        return usual(url, init);
      },
    );
    const project = loadProject(root, "app");
    const read = await readRepository(
      project,
      TOKEN,
      fetcher as typeof fetch,
      AbortSignal.timeout(1000),
      [],
    );
    expect(read.repository.branch).toBe("trunk");
    expect(read.usedDefaultBranch).toBe(true);
    expect(
      validateSetupAnalysis(suggestion(), read, []).warnings.join(" "),
    ).toContain("branch settings were not changed");
    await expect(
      resolveRepositoryHead({
        project,
        credential: { token: TOKEN },
        fetch: fetcher as typeof fetch,
      }),
    ).rejects.toThrow("Repository request failed");
  });
});

describe("reviewable setup publication", () => {
  it("creates only new allowlisted files on an immutable GitHub parent and an explicit draft", async () => {
    const writes: { path: string; body: Record<string, unknown> }[] = [];
    const report = validateSetupAnalysis(suggestion(), snapshot(), []);
    const fetcher = vi.fn(
      async (url: string | URL | Request, init?: RequestInit) => {
        const path = String(url);
        if (init?.method === "POST") {
          const body = JSON.parse(String(init.body));
          writes.push({ path, body });
          return path.endsWith("/git/trees")
            ? response({ sha: TREE })
            : path.endsWith("/git/commits")
              ? response({ sha: HEAD })
              : path.endsWith("/git/refs")
                ? response({})
                : response({
                    number: 12,
                    html_url: "https://github.com/owner/app/pull/12",
                    draft: true,
                  });
        }
        if (path.includes("/contents/") || path.includes("/git/ref/"))
          return response({}, 404);
        if (path.includes("/git/commits/"))
          return response({ tree: { sha: BLOB } });
        if (path.includes("/pulls?")) return response([]);
        throw new Error("Unexpected publication request.");
      },
    );
    const pull = await publishSetupDraft(
      loadProject(root, "app"),
      report,
      TOKEN,
      fetcher as typeof fetch,
      AbortSignal.timeout(1000),
    );
    expect(pull.number).toBe(12);
    expect(
      writes.find((w) => w.path.endsWith("/git/trees"))?.body,
    ).toMatchObject({
      base_tree: BLOB,
      tree: [{ path: ".gremlins/Dockerfile", type: "blob" }],
    });
    expect(
      writes.find((w) => w.path.endsWith("/git/commits"))?.body.parents,
    ).toEqual([SHA]);
    expect(writes.at(-1)?.body.draft).toBe(true);
    expect(writes.every((w) => !w.path.includes("merge"))).toBe(true);
  });
  it("does not overwrite an existing file even when absent from a truncated tree", async () => {
    const report = validateSetupAnalysis(suggestion(), snapshot(), []);
    const fetcher = vi.fn(async () => response({ type: "file" }));
    await expect(
      publishSetupDraft(
        loadProject(root, "app"),
        report,
        TOKEN,
        fetcher as typeof fetch,
        AbortSignal.timeout(1000),
      ),
    ).rejects.toThrow("already exists");
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it("reconciles a GitLab draft created before a lost response without duplicate commits or merge requests", async () => {
    const project = loadProject(root, "app");
    project.config.provider = "gitlab";
    project.config.serverUrl = "https://gitlab.example.test";
    const report = validateSetupAnalysis(suggestion(), snapshot(), []);
    report.repository.provider = "gitlab";
    let branchCreated = false,
      pullCreated = false;
    const writes: Record<string, unknown>[] = [];
    const pull = {
      iid: 9,
      web_url: "https://gitlab.example.test/owner/app/-/merge_requests/9",
      draft: true,
      state: "opened",
    };
    const fetcher = vi.fn(
      async (url: string | URL | Request, init?: RequestInit) => {
        const path = String(url);
        if (init?.method === "POST") {
          const body = JSON.parse(String(init.body));
          writes.push(body);
          if (path.endsWith("/repository/commits")) {
            branchCreated = true;
            return response({ id: HEAD });
          }
          if (path.endsWith("/merge_requests")) {
            pullCreated = true;
            throw new Error(
              "Response was lost after provider accepted request.",
            );
          }
          throw new Error("Unexpected mutation.");
        }
        if (path.includes("/repository/files/") && path.endsWith(`?ref=${SHA}`))
          return response({}, 404);
        if (path.includes("/repository/branches/"))
          return branchCreated
            ? response({ commit: { id: HEAD } })
            : response({}, 404);
        if (path.endsWith(`/repository/commits/${HEAD}`))
          return response({ parent_ids: [SHA] });
        if (path.includes(`/repository/commits/${HEAD}/diff`))
          return response([
            { new_file: true, new_path: ".gremlins/Dockerfile" },
          ]);
        if (
          path.includes("/repository/files/") &&
          path.endsWith(`?ref=${HEAD}`)
        )
          return response({
            encoding: "base64",
            content: Buffer.from(report.proposedFiles[0]!.content).toString(
              "base64",
            ),
          });
        if (path.includes("/merge_requests?"))
          return response(pullCreated ? [pull] : []);
        throw new Error("Unexpected fixture request.");
      },
    );
    await expect(
      publishSetupDraft(
        project,
        report,
        TOKEN,
        fetcher as typeof fetch,
        AbortSignal.timeout(1000),
      ),
    ).rejects.toThrow("Response was lost");
    const recovered = await publishSetupDraft(
      project,
      report,
      TOKEN,
      fetcher as typeof fetch,
      AbortSignal.timeout(1000),
    );
    expect(recovered.number).toBe(9);
    expect(writes).toHaveLength(2);
    expect(writes[0]).toMatchObject({
      start_sha: SHA,
      actions: [{ action: "create", file_path: ".gremlins/Dockerfile" }],
    });
    expect(writes[1]!.title).toMatch(/^Draft:/);
    expect(writes[0]!.force).toBeUndefined();
  });
});
