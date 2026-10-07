import { afterEach, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
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
import { pathToFileURL } from "node:url";
import type { Project } from "../config.ts";
import type { LocalJob } from "../localRunners/types.ts";
import { validatePayload } from "../localRunners/docker.ts";
import { createSyncRepairPayload } from "./syncRepair.ts";
import {
  prepareSyncRepairCheckout,
  verifySyncRepairAncestry,
} from "../../runner-local/sync-repair.mjs";
import { runCheckedDelivery } from "../../runner-local/delivery.mjs";
import {
  jobEnvironments,
  restoreGitConfig,
} from "../../runner-local/runtime.mjs";

const identity = {
  name: "gremlin-user",
  email: "77+gremlin-user@users.noreply.github.com",
};
const project: Project = {
  config: {
    name: "shop",
    repo: "example/shop",
    provider: "github",
    instanceId: "project-instance",
    branches: {
      production: "main",
      staging: "staging",
      integration: "pm-staging",
    },
    workflow: { kind: "promotion" },
    verification: { mode: "repository" },
    database: "none",
    slackWebhookSecret: "UNRELATED_SECRET",
    runnerLabel: null,
    mergeMethod: "squash",
    commands: {
      install: "",
      test: "node verify.cjs",
      lint: null,
      typecheck: null,
    },
    verified: null,
    signIn: null,
  },
  areas: [],
  tiers: {
    ownerOnlyPrefixes: [],
    hubOwnerOnly: [],
    alwaysFree: [],
    guardTests: [],
    testFileMarkers: [],
  },
  dir: ".",
};
const job: LocalJob = {
  id: "job-sync-123",
  runId: 1,
  type: "developer",
  developerKind: "sync",
  ticket: "SYNC-123",
  project: "shop",
  projectInstanceId: "project-instance",
  status: "queued",
  createdAt: "2026-10-06T00:00:00.000Z",
};
const payload = (
  stagingSha = "a".repeat(40),
  integrationSha = "b".repeat(40),
) =>
  createSyncRepairPayload({
    project,
    job,
    stagingSha,
    integrationSha,
    credential: {
      token: "source-secret",
      method: "oauth",
      commitIdentity: identity,
    },
    claudeToken: "claude-secret",
  });
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function fixture(identical = false) {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "gremlins-sync-worker-")),
  );
  roots.push(root);
  const repo = join(root, "repo");
  mkdirSync(repo);
  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "Fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.test",
    GIT_COMMITTER_NAME: "Fixture",
    GIT_COMMITTER_EMAIL: "fixture@example.test",
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
  };
  const execute = (
    cwd: string,
    args: string[],
    execution: NodeJS.ProcessEnv = env,
  ) => {
    const result = spawnSync("git", args, {
      cwd,
      env: execution,
      encoding: "utf8",
      windowsHide: true,
    });
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout.trim();
  };
  const git = (args: string[]) => execute(repo, args);
  const commit = (message: string) => {
    git(["add", "."]);
    git(["commit", "--quiet", "-m", message]);
    return git(["rev-parse", "HEAD"]);
  };
  git(["init", "--quiet", "--initial-branch=pm-staging"]);
  writeFileSync(join(repo, "shared.txt"), "original\n");
  const base = commit("base");
  git(["checkout", "-b", "staging"]);
  writeFileSync(
    join(repo, "shared.txt"),
    identical ? "same fix\n" : "staging behavior\n",
  );
  if (!identical)
    writeFileSync(join(repo, "staging-only.txt"), "keep staging\n");
  const staging = commit("staging change");
  git(["checkout", "pm-staging"]);
  writeFileSync(
    join(repo, "shared.txt"),
    identical ? "same fix\n" : "integration behavior\n",
  );
  if (!identical)
    writeFileSync(join(repo, "integration-only.txt"), "keep integration\n");
  const integration = commit("integration change");
  git(["checkout", "-b", `gremlins/${job.id}`]);
  const run = async (_command: string, args: string[]) => git(args);
  const merge = () => {
    if (!identical) {
      expect(() => git(["merge", "--no-ff", "--no-edit", staging])).toThrow();
      writeFileSync(
        join(repo, "shared.txt"),
        "staging behavior\nintegration behavior\n",
      );
      commit("resolve both behaviors");
    } else git(["merge", "--no-ff", "--no-edit", staging]);
  };
  const deliver = (options: { failChecks?: boolean } = {}) => {
    const data = payload(staging, integration);
    const check = join(root, "verify.cjs");
    writeFileSync(
      check,
      identical
        ? "require('node:assert').equal(require('node:fs').readFileSync('shared.txt','utf8'),'same fix\\n');"
        : "const fs=require('node:fs'),a=require('node:assert'); a.equal(fs.readFileSync('shared.txt','utf8'),'staging behavior\\nintegration behavior\\n'); a.equal(fs.readFileSync('staging-only.txt','utf8'),'keep staging\\n'); a.equal(fs.readFileSync('integration-only.txt','utf8'),'keep integration\\n');",
    );
    const { execution } = jobEnvironments({}, "github", env, identity);
    const published: string[][] = [];
    const promise = runCheckedDelivery({
      commands: { test: "node verify.cjs" },
      delivery: data.delivery!,
      baseSha: integration,
      repoUrl: data.repoUrl!,
      provider: "github",
      commitIdentity: identity,
      syncRepair: { stagingSha: staging },
      report: {
        schema: 1,
        summary:
          "Merged staging with integration and preserved both behaviors.",
        acceptance: data.delivery!.acceptanceCriteria.map(
          (_criterion, index) => ({
            criterion: index + 1,
            status: "verified",
            evidence: "Git parents and configured checks.",
          }),
        ),
        ui: {
          changed: false,
          verification: "repository-only",
          evidence: "Repository checks; no candidate browser walkthrough.",
        },
        integration: {
          status: "not-verified",
          evidence: "No remote provider was tested.",
        },
        limitations: ["Candidate deployment awaits independent verification."],
      },
      run: async (command, args) => {
        if (command === "git") return execute(repo, args, execution);
        if (options.failChecks) throw new Error("Configured check failed");
        const result = spawnSync(process.execPath, [check], {
          cwd: repo,
          encoding: "utf8",
          windowsHide: true,
        });
        if (result.status !== 0) throw new Error(result.stderr);
        return result.stdout;
      },
      publish: async (command, args) => {
        published.push([command, ...args]);
        return command === "git"
          ? ""
          : "https://github.com/example/shop/pull/42";
      },
      prepareRepository: () => restoreGitConfig(repo, data.repoUrl!),
      writeBody: () => {},
    });
    return { promise, published };
  };
  return {
    root,
    repo,
    git,
    run,
    execute,
    commit,
    merge,
    deliver,
    base,
    staging,
    integration,
  };
}

describe("trusted staging sync repair payload", () => {
  it("pins integration and staging with only source and Claude credentials", () => {
    const result = payload();
    expect(result.branch).toBe("pm-staging");
    expect(result.expectedCommitSha).toBe("b".repeat(40));
    expect(result.syncRepair).toEqual({ stagingSha: "a".repeat(40) });
    expect(Object.keys(result.credentials!).sort()).toEqual([
      "CLAUDE_CODE_OAUTH_TOKEN",
      "GITHUB_TOKEN",
    ]);
    expect(result.delivery).toMatchObject({
      base: "pm-staging",
      branch: `gremlins/${job.id}`,
      ticket: job.ticket,
    });
    expect(result.prompt).toContain("implementation-report.json");
    expect(result.prompt).not.toContain("source-secret");
    expect(() => validatePayload(result)).not.toThrow();
  });
  it("rejects public PM jobs, absent pins, extra sync fields and unrelated secrets", () => {
    const result = payload();
    for (const altered of [
      { ...result, kind: "pm" as const },
      { ...result, expectedCommitSha: undefined },
      {
        ...result,
        syncRepair: { stagingSha: "a".repeat(40), command: "arbitrary" },
      },
      {
        ...result,
        credentials: { ...result.credentials, LINEAR_API_KEY: "not-allowed" },
      },
      { ...result, browserVerification: true },
      { ...result, delivery: undefined },
    ])
      expect(() => validatePayload(altered)).toThrow(/Sync repair/);
    expect(() =>
      createSyncRepairPayload({
        project,
        job: { ...job, developerKind: "build" },
        stagingSha: "a".repeat(40),
        integrationSha: "b".repeat(40),
        credential: {
          token: "source",
          method: "token",
          commitIdentity: identity,
        },
        claudeToken: "claude",
      }),
    ).toThrow(/admitted/);
  });
});

describe("sync repair Git evidence", () => {
  it("fetches both full histories before agent execution, including a shallow pinned checkout", async () => {
    const f = fixture();
    const remote = join(f.root, "remote.git"),
      checkout = join(f.root, "checkout");
    f.execute(f.root, ["clone", "--bare", f.repo, remote]);
    f.execute(f.root, [
      "clone",
      "--depth",
      "1",
      "--single-branch",
      "--branch",
      "pm-staging",
      pathToFileURL(remote).href,
      checkout,
    ]);
    const run = vi.fn(async (_command: string, args: string[]) =>
      f.execute(checkout, args),
    );
    expect(f.execute(checkout, ["rev-parse", "--is-shallow-repository"])).toBe(
      "true",
    );
    await prepareSyncRepairCheckout({
      integrationSha: f.integration,
      stagingSha: f.staging,
      run,
    });
    expect(f.execute(checkout, ["merge-base", f.integration, f.staging])).toBe(
      f.base,
    );
    expect(
      run.mock.calls.some(
        ([, args]) => args.includes("--unshallow") && args.includes(f.staging),
      ),
    ).toBe(true);
  });
  it("publishes a checked draft preserving both parents and branch-only changes", async () => {
    const f = fixture();
    f.merge();
    const { promise, published } = f.deliver();
    const result = await promise;
    expect(result.prUrl).toBe("https://github.com/example/shop/pull/42");
    expect(f.git(["show", "-s", "--format=%P"])).toBe(
      `${f.integration} ${f.staging}`,
    );
    expect(f.git(["show", "-s", "--format=%ae"])).toBe(identity.email);
    expect(readFileSync(join(f.repo, "integration-only.txt"), "utf8")).toBe(
      "keep integration\n",
    );
    expect(published[0]).toContain(`HEAD:refs/heads/gremlins/${job.id}`);
    expect(published[0]).not.toContain("--force");
    expect(published[1]).toContain("--draft");
    expect(published[1]).toContain("pm-staging");
  });
  it("publishes a meaningful ancestry-only merge even when the tree matches integration", async () => {
    const f = fixture(true);
    f.merge();
    expect(f.git(["diff", "--name-only", f.integration, "HEAD"])).toBe("");
    const { promise, published } = f.deliver();
    expect(await promise).toMatchObject({
      prUrl: "https://github.com/example/shop/pull/42",
    });
    expect(published).toHaveLength(2);
    expect(f.git(["show", "-s", "--format=%P"])).toBe(
      `${f.integration} ${f.staging}`,
    );
  });
  it("rejects a cherry-pick-shaped result missing either admitted ancestor", async () => {
    const f = fixture(true);
    for (const head of [f.integration, f.staging]) {
      f.git(["reset", "--hard", head]);
      await expect(
        verifySyncRepairAncestry({
          integrationSha: f.integration,
          stagingSha: f.staging,
          run: f.run,
        }),
      ).rejects.toThrow(/both admitted branch histories/);
    }
    f.git(["reset", "--hard", f.integration]);
    const { promise, published } = f.deliver();
    await expect(promise).rejects.toThrow(/both admitted branch histories/);
    expect(published).toEqual([]);
  });
  it("does not publish when configured checks fail", async () => {
    const f = fixture();
    f.merge();
    const { promise, published } = f.deliver({ failChecks: true });
    await expect(promise).rejects.toThrow("Configured check failed");
    expect(published).toEqual([]);
  });
  it("does not allow local grafts or replace refs to invent admitted ancestry", async () => {
    const f = fixture();
    writeFileSync(
      join(f.repo, ".git", "info", "grafts"),
      `${f.integration} ${f.staging}\n`,
    );
    await expect(
      verifySyncRepairAncestry({
        integrationSha: f.integration,
        stagingSha: f.staging,
        run: f.run,
      }),
    ).rejects.toThrow(/history was modified/);
    rmSync(join(f.repo, ".git", "info", "grafts"));
    f.git(["replace", f.integration, f.staging]);
    await expect(
      verifySyncRepairAncestry({
        integrationSha: f.integration,
        stagingSha: f.staging,
        run: f.run,
      }),
    ).rejects.toThrow(/both admitted branch histories/);
  });
});
