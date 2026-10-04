import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { realGit } from "../git.ts";
import { makeCtx, TEST_REPO } from "../services/fakes.ts";
import { runPromote } from "./promote.ts";
import {
  formatBrowserEvidence,
  type CandidateVerification,
} from "./verification.ts";
import { passingEvidence } from "./verification.test-support.ts";

describe("promotion with real git", () => {
  it("reuses the same deployable commit when evidence arrives on a later invocation", async () => {
    const temp = await mkdtemp(join(tmpdir(), "shipgremlins-promotion-"));
    try {
      const remote = join(temp, "remote.git");
      const checkout = join(temp, "checkout");
      await mkdir(checkout);
      const git = async (args: string[], cwd = checkout): Promise<string> => {
        const result = await realGit.run(args, cwd);
        if (result.code !== 0) throw new Error(result.err);
        return result.out.trim();
      };
      await git(["init", "--bare", remote], temp);
      await git(["init", "-b", "staging"]);
      await git(["config", "user.name", "Verification test"]);
      await git(["config", "user.email", "test@example.invalid"]);
      await git(["remote", "add", "origin", remote]);
      await writeFile(join(checkout, "README.md"), "staging baseline\n");
      await git(["add", "."]);
      await git(["commit", "-m", "baseline"]);
      const baseSha = await git(["rev-parse", "HEAD"]);
      await git(["push", "origin", "staging"]);
      await git(["checkout", "-b", "pm-staging"]);
      await mkdir(join(checkout, "app"));
      await writeFile(
        join(checkout, "app", "feature.txt"),
        "verified feature\n",
      );
      await git(["add", "."]);
      await git(["commit", "-m", "feature"]);
      const sourceSha = await git(["rev-parse", "HEAD"]);
      await git(["push", "origin", "pm-staging"]);
      const ctx = makeCtx();
      ctx.forge.seedBranch(TEST_REPO, "staging", baseSha);
      ctx.forge.seedBranch(TEST_REPO, "pm-staging", sourceSha);
      ctx.forge.seedChecks(TEST_REPO, sourceSha, {
        status: "success",
        failedJobs: [],
      });
      ctx.vercel.seedDeployment("prj_game", "pm-staging", { sha: sourceSha });
      ctx.forge.seedPull(
        TEST_REPO,
        {
          number: 10,
          state: "merged",
          mergeCommitSha: sourceSha,
          mergedAt: "2026-10-01T10:00:00Z",
        },
        ["app/feature.txt"],
      );
      ctx.forge.seedComment(
        TEST_REPO,
        10,
        formatBrowserEvidence(passingEvidence(sourceSha)),
      );
      const observed: CandidateVerification[] = [];
      const check = async () => ({ ok: true, output: "local check fixture" });
      await runPromote(ctx, {
        git: realGit,
        checkoutDir: checkout,
        check,
        verifyCandidate: async (candidate) => {
          observed.push(candidate);
          return { ok: false, reason: "browser run still pending" };
        },
      });
      expect(
        await ctx.forge.listOpenPulls(TEST_REPO, { base: "staging" }),
      ).toEqual([]);
      await runPromote(ctx, {
        git: realGit,
        checkoutDir: checkout,
        check,
        verifyCandidate: async (candidate) => {
          observed.push(candidate);
          return {
            ok: true,
            author: ctx.botLogin,
            evidence: passingEvidence(candidate.sha),
          };
        },
      });
      expect(observed).toHaveLength(2);
      expect(observed[1]).toEqual(observed[0]);
      expect(
        await ctx.forge.listOpenPulls(TEST_REPO, { base: "staging" }),
      ).toHaveLength(1);

      // Further work cannot change that open PR until its own candidate is verified.
      await git(["checkout", "pm-staging"]);
      await writeFile(join(checkout, "app", "next.txt"), "second feature\n");
      await git(["add", "."]);
      await git(["commit", "-m", "second feature"]);
      const nextSha = await git(["rev-parse", "HEAD"]);
      await git(["push", "origin", "pm-staging"]);
      ctx.forge.seedBranch(TEST_REPO, "pm-staging", nextSha);
      ctx.forge.seedChecks(TEST_REPO, nextSha, {
        status: "success",
        failedJobs: [],
      });
      ctx.vercel.seedDeployment("prj_game", "pm-staging", { sha: nextSha });
      ctx.forge.seedPull(
        TEST_REPO,
        {
          number: 20,
          state: "merged",
          mergeCommitSha: nextSha,
          mergedAt: "2026-10-01T11:00:00Z",
        },
        ["app/next.txt"],
      );
      ctx.forge.seedComment(
        TEST_REPO,
        20,
        formatBrowserEvidence(passingEvidence(nextSha)),
      );
      const pending = async (candidate: CandidateVerification) => {
        observed.push(candidate);
        return { ok: false as const, reason: "waiting for second browser run" };
      };
      await runPromote(ctx, {
        git: realGit,
        checkoutDir: checkout,
        check,
        verifyCandidate: pending,
      });
      await runPromote(ctx, {
        git: realGit,
        checkoutDir: checkout,
        check,
        verifyCandidate: pending,
      });
      expect(observed).toHaveLength(4);
      expect(observed[3]).toEqual(observed[2]);
      expect(observed[2]!.branch).toContain("pm-candidate/core/");
      expect(
        await git(["rev-parse", `origin/${observed[0]!.releaseBranch}`]),
      ).toBe(observed[0]!.sha);
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  }, 20_000);
});
