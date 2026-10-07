import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { realGit } from "../git.ts";
import { makeCtx, TEST_REPO } from "../services/fakes.ts";
import { runPromote } from "./promote.ts";

it(
  "retires an unchanged conflicted open batch, then promotes only its freshly QAed isolated repair source",
  async () => {
    const temp = await mkdtemp(join(tmpdir(), "gremlins-port-")),
      checkout = join(temp, "checkout"),
      remote = join(temp, "remote.git");
    const git = async (...args: string[]) => {
      const r = await realGit.run(args, checkout);
      if (r.code) throw new Error(r.err);
      return r.out.trim();
    };
    try {
      await mkdir(checkout);
      await git("init", "--bare", remote);
      await git("init", "-b", "staging");
      await git("config", "user.name", "Delivery test");
      await git("config", "user.email", "delivery@example.invalid");
      await git("remote", "add", "origin", remote);
      const commit = async (content: string) => {
        await writeFile(join(checkout, "app.txt"), content + "\n");
        await git("add", ".");
        await git("commit", "-m", content);
        return git("rev-parse", "HEAD");
      };
      const base = await commit("baseline");
      await git("push", "origin", "staging");
      await git("checkout", "-b", "pm-staging");
      const original = await commit("original feature");
      await git("push", "origin", "pm-staging");
      const ctx = makeCtx();
      ctx.project.config.workflow = {
        kind: "promotion",
        promotionBatchSize: 1,
      };
      ctx.forge.seedBranch(TEST_REPO, "staging", base);
      const deploy = (sha: string) => {
        ctx.forge.seedBranch(TEST_REPO, "pm-staging", sha);
        ctx.forge.seedChecks(TEST_REPO, sha, {
          status: "success",
          failedJobs: [],
        });
        ctx.vercel.seedDeployment("prj_game", "pm-staging", { sha });
      };
      deploy(original);
      ctx.forge.seedPull(
        TEST_REPO,
        {
          number: 1,
          state: "merged",
          mergeCommitSha: original,
          mergedAt: "2026-10-01T10:00:00Z",
          title: "Original",
        },
        ["app.txt"],
      );
      const read = ctx.forge.getPull.bind(ctx.forge);
      vi.spyOn(ctx.forge, "getPull").mockImplementation(
        async (repo, number) => {
          const p = await read(repo, number);
          if (p?.headRef.startsWith("pm-release/"))
            ctx.forge.patchPull(repo, number, {
              headSha: (
                await git("ls-remote", "--heads", "origin", p.headRef)
              ).split(/\s+/)[0]!,
            });
          return read(repo, number);
        },
      );
      const replacement = { sha: "", reviewed: false };
      const candidateVerdict = async (p: { number: number }) => ({
        area: "core",
        ticketId: "ticket-one",
        verdict: (p.number === 1
          ? replacement.sha
            ? "untested"
            : "verified"
          : replacement?.reviewed
            ? "verified"
            : "untested") as "verified" | "untested",
        ...(p.number === 2 && replacement.sha
          ? {
              sourceSha: replacement.sha,
              sourcePaths: ["app.txt"],
              rebuildingBatch: true,
            }
          : {}),
      });
      const check = vi.fn(async () => ({ ok: true, output: "pass" })),
        published = vi.fn(async () => {});
      const opts = {
        git: realGit,
        checkoutDir: checkout,
        area: "core",
        automatic: true,
        local: true,
        publishReviewedCandidate: true,
        check,
        onPublished: published,
        candidateVerdict,
      };
      await runPromote(ctx, opts);
      const old = (
        await ctx.forge.listOpenPulls(TEST_REPO, { base: "staging" })
      )[0]!;
      const oldHead = await git("rev-parse", `origin/${old.headRef}`);
      await git("checkout", "staging");
      const staging = await commit("normal staging work");
      await git("push", "origin", "staging");
      ctx.forge.seedBranch(TEST_REPO, "staging", staging);
      const onPromotionConflict = vi.fn(
        async ({ pullNumber }: { pullNumber: number }) => {
          expect(pullNumber).toBe(1);
          await ctx.forge.closePull(TEST_REPO, old.number);
          return true;
        },
      );
      const held = await runPromote(ctx, {
        ...opts,
        currentPromotion: async () => true,
        onPromotionConflict,
      });
      expect(held[0]!.text).toContain("retired and preserved in history");
      expect(onPromotionConflict).toHaveBeenCalledOnce();
      expect(await git("rev-parse", `origin/${old.headRef}`)).toBe(oldHead);
      // Bounded worker creates an isolated one-parent source, integrates it, then PM QA reviews it.
      await git("checkout", "-b", "gremlins-port-job-port", "staging");
      const isolated = await commit(
        "normal staging work plus repaired feature",
      );
      await git("checkout", "pm-staging");
      await git("merge", "-s", "ours", "--no-edit", "staging");
      await git("read-tree", "--reset", "-u", isolated);
      await git("commit", "-m", "integration repair");
      await git("merge", "--no-edit", "gremlins-port-job-port");
      const merge = await git("rev-parse", "HEAD");
      await git("push", "origin", "pm-staging");
      deploy(merge);
      ctx.forge.seedPull(
        TEST_REPO,
        {
          number: 2,
          state: "merged",
          mergeCommitSha: merge,
          mergedAt: "2026-10-01T11:00:00Z",
          title: "Isolated repair",
        },
        [],
      );
      replacement.sha = isolated;
      const exact = { ...opts, candidatePullNumbers: async () => [2] };
      const before = published.mock.calls.length;
      await runPromote(ctx, exact);
      expect(published).toHaveBeenCalledTimes(before);
      replacement.reviewed = true;
      ctx.project.config.workflow = {
        kind: "promotion",
        promotionBatchSize: 10,
      };
      await runPromote(ctx, exact);
      expect(published).toHaveBeenLastCalledWith(
        expect.objectContaining({ changes: [2] }),
        expect.objectContaining({ draft: false }),
      );
      const fresh = (
        await ctx.forge.listOpenPulls(TEST_REPO, { base: "staging" })
      )[0]!;
      expect(fresh.number).not.toBe(old.number);
      expect(fresh.body).toContain("## Rebuilt batch");
      expect(await git("show", `origin/${fresh.headRef}:app.txt`)).toBe(
        "normal staging work plus repaired feature",
      );
      expect(await git("rev-parse", "origin/staging")).toBe(staging);
      ctx.forge.patchPull(TEST_REPO, 2, { mergeCommitSha: original });
      await expect(runPromote(ctx, exact)).rejects.toThrow(
        "differs from its PM-tested integration result",
      );
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  },
  process.platform === "win32" ? 120_000 : 30_000,
);
