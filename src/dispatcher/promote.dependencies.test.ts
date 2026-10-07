import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { realGit } from "../git.ts";
import { makeCtx, makeProject, TEST_REPO } from "../services/fakes.ts";
import { runPromote } from "./promote.ts";

it(
  "opens a checked smaller prerequisite batch instead of deadlocking A1 -> B1 -> A2..A10",
  async () => {
    const temp = await mkdtemp(join(tmpdir(), "gremlins-dependencies-"));
    const checkout = join(temp, "checkout"),
      remote = join(temp, "remote.git");
    const git = async (...args: string[]) => {
      const result = await realGit.run(args, checkout);
      if (result.code) throw new Error(result.err);
      return result.out.trim();
    };
    try {
      await mkdir(checkout);
      await git("init", "--bare", remote);
      await git("init", "-b", "staging");
      await git("config", "user.name", "Delivery test");
      await git("config", "user.email", "delivery@example.invalid");
      await git("remote", "add", "origin", remote);
      await writeFile(join(checkout, "app.txt"), "baseline\n");
      await git("add", ".");
      await git("commit", "-m", "baseline");
      const base = await git("rev-parse", "HEAD");
      await git("push", "origin", "staging");
      await git("checkout", "-b", "pm-staging");
      const ctx = makeCtx({
        project: makeProject({
          areas: [
            { key: "core", name: "Core", paths: ["app.txt"] },
            { key: "billing", name: "Billing", paths: ["app.txt"] },
          ],
        }),
      });
      ctx.project.config.workflow = {
        kind: "promotion",
        promotionBatchSize: 10,
      };
      ctx.forge.seedBranch(TEST_REPO, "staging", base);
      for (let number = 1; number <= 11; number++) {
        await writeFile(join(checkout, "app.txt"), `step ${number}\n`);
        await git("add", ".");
        await git("commit", "-m", `change ${number}`);
        const sha = await git("rev-parse", "HEAD");
        ctx.forge.seedPull(
          TEST_REPO,
          {
            number,
            state: "merged",
            mergeCommitSha: sha,
            mergedAt: `2026-10-01T10:${String(number).padStart(2, "0")}:00Z`,
            title: `Change ${number}`,
          },
          ["app.txt"],
        );
        ctx.forge.seedBranch(TEST_REPO, "pm-staging", sha);
        ctx.forge.seedChecks(TEST_REPO, sha, {
          status: "success",
          failedJobs: [],
        });
        ctx.vercel.seedDeployment("prj_game", "pm-staging", { sha });
      }
      await git("push", "origin", "pm-staging");
      const read = ctx.forge.getPull.bind(ctx.forge);
      vi.spyOn(ctx.forge, "getPull").mockImplementation(
        async (repo, number) => {
          const pull = await read(repo, number);
          if (pull?.headRef.startsWith("pm-release/")) {
            const headSha = (
              await git("ls-remote", "--heads", "origin", pull.headRef)
            ).split(/\s+/)[0]!;
            ctx.forge.patchPull(repo, number, { headSha });
          }
          return read(repo, number);
        },
      );
      const check = vi.fn(async () => ({ ok: true, output: "pass" }));
      const published = vi.fn(async () => {});
      const opts = {
        git: realGit,
        checkoutDir: checkout,
        local: true,
        automatic: true,
        publishReviewedCandidate: true,
        check,
        onPublished: published,
        candidateVerdict: async (pull: { number: number }) => ({
          area: pull.number === 2 ? "billing" : "core",
          ticketId: `ticket-${pull.number}`,
          verdict: "verified" as const,
        }),
      };
      const rows = await runPromote(ctx, { ...opts, area: "core" });
      expect(rows[0]!.text).toContain("smaller prerequisite batch");
      expect(published).toHaveBeenCalledWith(
        expect.objectContaining({ changes: [1] }),
        expect.anything(),
      );
      const core = (
        await ctx.forge.listOpenPulls(TEST_REPO, { base: "staging" })
      )[0]!;
      expect(core.body).toContain("## Prerequisite batch");
      expect(core.body).toContain(
        "normal target is 10 distinct tickets; this batch contains 1",
      );
      expect(await git("rev-parse", "origin/staging")).toBe(base);
      // Only the owner merges the final prerequisite PR; this unblocks B1, then A2.
      await git("checkout", "staging");
      await git("merge", "--ff-only", `origin/${core.headRef}`);
      await git("push", "origin", "staging");
      ctx.forge.patchPull(TEST_REPO, core.number, { state: "merged" });
      ctx.forge.seedBranch(
        TEST_REPO,
        "staging",
        await git("rev-parse", "HEAD"),
      );
      await runPromote(ctx, { ...opts, area: "billing" });
      expect(published).toHaveBeenLastCalledWith(
        expect.objectContaining({ changes: [2] }),
        expect.objectContaining({
          headRef: expect.stringContaining("pm-release/billing/"),
        }),
      );
      expect(check).toHaveBeenCalledTimes(2);
      expect(ctx.forge.merged).toEqual([]);
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  },
  process.platform === "win32" ? 120_000 : 30_000,
);
