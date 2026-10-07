import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validatePayload } from "../localRunners/docker.ts";
import { runCheckedDelivery } from "../../runner-local/delivery.mjs";
import {
  promotionPortRef,
  preparePromotionRepairCheckout,
  verifyPromotionRepairSource,
} from "../../runner-local/promotion-repair.mjs";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
const nonce = "job-port-123";
const commitIdentity = {
  name: "Fixture",
  email: "77+fixture@users.noreply.github.com",
};
function fixture() {
  const repo = realpathSync(
    mkdtempSync(join(tmpdir(), "gremlins-port-worker-")),
  );
  roots.push(repo);
  const git = (args: string[]) => {
    const result = spawnSync("git", args, {
      cwd: repo,
      encoding: "utf8",
      windowsHide: true,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Fixture",
        GIT_AUTHOR_EMAIL: commitIdentity.email,
        GIT_COMMITTER_NAME: "Fixture",
        GIT_COMMITTER_EMAIL: commitIdentity.email,
        GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
      },
    });
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout;
  };
  const commit = (message: string) => {
    git(["add", "."]);
    git(["commit", "--quiet", "-m", message]);
    return git(["rev-parse", "HEAD"]).trim();
  };
  const write = (path: string, content: string) =>
    writeFileSync(join(repo, path), content);
  git(["init", "--quiet", "--initial-branch=staging"]);
  write("ticket.txt", "staging\n");
  write("unrelated.txt", "staging other\n");
  const stagingSha = commit("staging");
  git(["checkout", "-b", "pm-staging"]);
  write("ticket.txt", "approved feature\n");
  const original = commit("ticket feature");
  write("unrelated.txt", "unrelated integration change\n");
  const integrationSha = commit("other ticket");
  git(["checkout", "-b", `gremlins/${nonce}`]);
  const repair = {
    stagingSha,
    sourceShas: [original],
    allowedPaths: ["ticket.txt"],
  };
  const run = async (_command: string, args: string[]) => git(args);
  const port = (content = "approved feature\n", extra = false) => {
    git([
      "checkout",
      "-b",
      promotionPortRef(nonce).replace("refs/heads/", ""),
      stagingSha,
    ]);
    write("ticket.txt", content);
    if (extra) write("unrelated.txt", "import other ticket\n");
    const source = commit("isolated feature port");
    git(["checkout", `gremlins/${nonce}`]);
    return source;
  };
  const merge = (source: string, ours = false) =>
    git([
      "merge",
      "--no-ff",
      "--no-edit",
      ...(ours ? ["-s", "ours"] : []),
      source,
    ]);
  return {
    repo,
    git,
    write,
    commit,
    repair,
    integrationSha,
    run,
    port,
    merge,
    verify: () =>
      verifyPromotionRepairSource({
        integrationSha,
        repair,
        nonce,
        commitIdentity,
        run,
      }),
  };
}

describe("trusted isolated promotion repair", () => {
  it("publishes a meaningful isolated port when integration needs only its ancestry", async () => {
    const f = fixture();
    await preparePromotionRepairCheckout({
      integrationSha: f.integrationSha,
      repair: f.repair,
      run: f.run,
    });
    const source = f.port();
    f.merge(source);
    expect(
      f.git(["diff", "--name-only", f.integrationSha, "HEAD"]).trim(),
    ).toBe("");
    expect(await f.verify()).toEqual({
      promotionSourceSha: source,
      promotionBaseSha: f.repair.stagingSha,
    });
    const published: string[] = [];
    const result = await runCheckedDelivery({
      commands: { test: "verify" },
      delivery: {
        ticket: "APP-1",
        title: "Port approved feature",
        base: "pm-staging",
        branch: `gremlins/${nonce}`,
        repo: "owner/app",
        acceptanceCriteria: ["Feature works"],
      },
      baseSha: f.integrationSha,
      repoUrl: "https://github.com/owner/app",
      provider: "github",
      commitIdentity,
      nonce,
      promotionRepair: f.repair,
      run: async (command, args) => {
        if (command === "/bin/bash") {
          expect(f.git(["show", "HEAD:ticket.txt"])).toBe("approved feature\n");
          expect(f.git(["show", "HEAD:unrelated.txt"])).toBe(
            "unrelated integration change\n",
          );
          return "passed";
        }
        return f.run(command, args);
      },
      publish: async (command) => {
        published.push(command);
        return command === "gh" ? "https://github.com/owner/app/pull/3" : "";
      },
      writeBody: () => {},
      prepareRepository: () => {},
      report: {
        schema: 1,
        summary: "Port feature",
        acceptance: [
          {
            criterion: 1,
            status: "verified",
            evidence: "Repository test passed; PM QA remains",
          },
        ],
        ui: {
          changed: false,
          verification: "repository-only",
          evidence: "No UI changes",
        },
        integration: {
          status: "not-applicable",
          evidence: "No external integration",
        },
        limitations: ["Awaiting PM QA"],
      },
    });
    expect(result).toMatchObject({
      promotionSourceSha: source,
      promotionBaseSha: f.repair.stagingSha,
      prUrl: "https://github.com/owner/app/pull/3",
    });
    expect(published).toEqual(["git", "gh"]);
  });
  it("rejects an ours merge that hides untested port content", async () => {
    const f = fixture();
    const source = f.port("different untested feature\n");
    f.merge(source, true);
    await expect(f.verify()).rejects.toThrow("exact promotion source content");
  });
  it("rejects unrelated files even when their content already exists in integration", async () => {
    const f = fixture();
    const source = f.port("approved feature\n", true);
    f.merge(source, true);
    await expect(f.verify()).rejects.toThrow(
      "outside its admitted ticket lineage",
    );
  });
  it("rejects a port based on integration that smuggles other ticket history", async () => {
    const f = fixture();
    f.git([
      "branch",
      promotionPortRef(nonce).replace("refs/heads/", ""),
      f.integrationSha,
    ]);
    await expect(f.verify()).rejects.toThrow("only parent is admitted staging");
  });
  it("rejects a final draft that loses unrelated integration history", async () => {
    const f = fixture();
    const source = f.port();
    f.git(["reset", "--hard", source]);
    await expect(f.verify()).rejects.toThrow(
      "preserve both admitted branch histories",
    );
  });
  it("rejects an unverified author on the isolated source that would be preserved by cherry-pick", async () => {
    const f = fixture();
    const source = f.port();
    f.merge(source);
    await expect(
      verifyPromotionRepairSource({
        integrationSha: f.integrationSha,
        repair: f.repair,
        nonce,
        run: f.run,
        commitIdentity: {
          ...commitIdentity,
          email: "other@users.noreply.github.com",
        },
      }),
    ).rejects.toThrow("verified source-account author");
  });
  it("rejects a source that is not part of the admitted integration history", async () => {
    const f = fixture();
    const source = f.port();
    f.merge(source);
    f.repair.sourceShas = [source];
    await expect(f.verify()).rejects.toThrow("every admitted source change");
  });
  it("rejects edits outside the finite scope in the final integration merge", async () => {
    const f = fixture();
    const source = f.port();
    f.merge(source);
    f.write("unrelated.txt", "lost unrelated code\n");
    f.commit("bad resolution");
    await expect(f.verify()).rejects.toThrow(
      "outside its admitted ticket lineage",
    );
  });
  it("rejects a promotion whose final file mode differs from its source", async () => {
    const f = fixture();
    const source = f.port();
    f.merge(source);
    f.git(["update-index", "--chmod=+x", "ticket.txt"]);
    f.git(["commit", "-m", "change executable bit"]);
    await expect(f.verify()).rejects.toThrow("exact promotion source content");
  });
});

describe("promotion repair payload admission", () => {
  const payload = () => ({
    kind: "developer" as const,
    nonce,
    provider: "github" as const,
    commitIdentity,
    prompt: "Repair the admitted selective promotion.",
    commands: { test: "npm test" },
    repoUrl: "https://github.com/owner/app",
    branch: "pm-staging",
    expectedCommitSha: "b".repeat(40),
    browserVerification: false,
    credentials: { GITHUB_TOKEN: "source", CLAUDE_CODE_OAUTH_TOKEN: "claude" },
    delivery: {
      ticket: "APP-1",
      title: "Port approved feature",
      base: "pm-staging",
      branch: `gremlins/${nonce}`,
      repo: "owner/app",
      acceptanceCriteria: ["Feature works"],
    },
    promotionRepair: {
      stagingSha: "a".repeat(40),
      sourceShas: ["c".repeat(40)],
      allowedPaths: ["src/feature.ts"],
    },
  });
  it("accepts the trusted bounded payload", () =>
    expect(() => validatePayload(payload())).not.toThrow());
  it.each([
    {
      promotionRepair: {
        stagingSha: "a".repeat(40),
        sourceShas: [],
        allowedPaths: ["src/a.ts"],
      },
    },
    {
      promotionRepair: {
        stagingSha: "a".repeat(40),
        sourceShas: ["c".repeat(40)],
        allowedPaths: ["../other"],
      },
    },
    {
      promotionRepair: {
        stagingSha: "a".repeat(40),
        sourceShas: ["c".repeat(40)],
        allowedPaths: [".git/config"],
      },
    },
    {
      promotionRepair: {
        stagingSha: "a".repeat(40),
        sourceShas: ["c".repeat(40)],
        allowedPaths: ["C:/other"],
      },
    },
    {
      promotionRepair: {
        stagingSha: "a".repeat(40),
        sourceShas: ["c".repeat(40)],
        allowedPaths: ["src/a.ts"],
        arbitrary: true,
      },
    },
    { syncRepair: { stagingSha: "a".repeat(40) } },
    { browserVerification: true },
    { credentials: { GITHUB_TOKEN: "source", PRIVATE_API_KEY: "unrelated" } },
    { nonce: "other-job" },
  ])("rejects unbounded, mixed, or credential-expanded intent %#", (patch) => {
    expect(() => validatePayload({ ...payload(), ...patch })).toThrow();
  });
});
