import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { realGit } from "../git.ts";
import { makeCtx, makeProject, TEST_REPO } from "../services/fakes.ts";
import { runPromote } from "./promote.ts";

it(
  "automatically publishes one reusable PM-reviewed promotion, enforces supplied verification, and excludes untested commits",
  async () => {
    const temp = await mkdtemp(join(tmpdir(), "gremlins-combined-"));
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
      await git("config", "core.autocrlf", "false");
      await git("remote", "add", "origin", remote);
      await writeFile(join(checkout, "README.md"), "baseline\n");
      await git("add", ".");
      await git("commit", "-m", "baseline");
      const base = await git("rev-parse", "HEAD");
      await git("push", "origin", "staging");
      await git("checkout", "-b", "pm-staging");
      const ctx = makeCtx({
        project: makeProject({
          areas: [
            { key: "core", name: "Core", paths: ["core/"] },
            { key: "billing", name: "Billing", paths: ["billing/"] },
          ],
        }),
      });
      ctx.forge.seedBranch(TEST_REPO, "staging", base);
      const originalGetPull = ctx.forge.getPull.bind(ctx.forge);
      vi.spyOn(ctx.forge, "getPull").mockImplementation(
        async (repo, number) => {
          const pull = await originalGetPull(repo, number);
          if (!pull || !pull.headRef.startsWith("pm-release/")) return pull;
          const head = (
            await git("ls-remote", "--heads", "origin", pull.headRef)
          ).split(/\s+/)[0];
          if (head) ctx.forge.patchPull(repo, number, { headSha: head });
          return structuredClone(await originalGetPull(repo, number));
        },
      );
      for (const path of ["core", "billing"]) await mkdir(join(checkout, path));
      const addChange = async (
        number: number,
        file: string,
        verified: boolean,
      ) => {
        await writeFile(join(checkout, file), `change ${number}\n`);
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
            labels: verified ? ["reviewed"] : [],
            title: `Change ${number}`,
          },
          [file],
        );
        await git("push", "origin", "pm-staging");
        ctx.forge.seedBranch(TEST_REPO, "pm-staging", sha);
        ctx.forge.seedChecks(TEST_REPO, sha, {
          status: "success",
          failedJobs: [],
        });
        ctx.vercel.seedDeployment("prj_game", "pm-staging", { sha });
      };
      await addChange(1, "core/good.txt", true);
      await addChange(2, "core/untested.txt", false);
      await addChange(3, "billing/good.txt", true);
      const check = vi.fn(async () => {
        expect(await readFile(join(checkout, "core/good.txt"), "utf8")).toBe(
          "change 1\n",
        );
        expect(await readFile(join(checkout, "billing/good.txt"), "utf8")).toBe(
          "change 3\n",
        );
        expect(await git("ls-tree", "-r", "--name-only", "HEAD")).not.toContain(
          "untested.txt",
        );
        return { ok: true, output: "combined application checks passed" };
      });
      const opts = {
        git: realGit,
        checkoutDir: checkout,
        local: true,
        publishReviewedCandidate: true,
        check,
        candidateVerdict: async (pull: {
          number: number;
          labels: string[];
        }) => ({
          area: pull.number === 3 ? "billing" : "core",
          verdict: pull.labels.includes("reviewed")
            ? ("verified" as const)
            : ("untested" as const),
        }),
      };
      const verifyCandidate = vi.fn(async () => ({
        ok: false as const,
        reason: "configured candidate gate has not passed",
      }));
      const prepared = vi.fn(async () => {}),
        published = vi.fn(async () => {});
      const waiting = await runPromote(ctx, {
        ...opts,
        verifyCandidate,
        onCandidatePrepared: prepared,
        onPublished: published,
      });
      expect(waiting.some((row) => row.pending)).toBe(true);
      expect(verifyCandidate).toHaveBeenCalledOnce();
      expect(prepared).toHaveBeenCalledOnce();
      expect(published).not.toHaveBeenCalled();
      expect(
        await ctx.forge.listOpenPulls(TEST_REPO, { base: "staging" }),
      ).toEqual([]);
      await runPromote(ctx, { ...opts, onPublished: published });
      const [pull] = await ctx.forge.listOpenPulls(TEST_REPO, {
        base: "staging",
      });
      expect(pull).toMatchObject({
        headRef: "pm-release/combined/20261002",
        draft: false,
      });
      expect(pull!.body).toContain("owning PMs");
      expect(pull!.body).toContain("Change 2 — not tested");
      expect(pull!.body).toContain(
        "no separate browser review of this assembled candidate is claimed",
      );
      expect(published).toHaveBeenCalledWith(
        expect.objectContaining({ changes: [1, 3] }),
        expect.objectContaining({ number: pull!.number, draft: false }),
      );
      expect(ctx.forge.merged).toEqual([]);
      expect(ctx.forge.autoMerged).toEqual([]);
      await git("checkout", "pm-staging");
      await addChange(10, "core/next.txt", true);
      await runPromote(ctx, { ...opts, onPublished: published });
      const pulls = await ctx.forge.listOpenPulls(TEST_REPO, {
        base: "staging",
      });
      expect(pulls).toHaveLength(1);
      expect(pulls[0]!.number).toBe(pull!.number);
      expect(pulls[0]!.body).toContain("Change 10");
      const combinedSha = await git("rev-parse", `origin/${pull!.headRef}`);
      expect(published).toHaveBeenLastCalledWith(
        expect.objectContaining({ changes: [1, 3, 10], sha: combinedSha }),
        expect.objectContaining({ number: pull!.number, headSha: combinedSha }),
      );
      expect(await git("rev-parse", "origin/staging")).toBe(base);
      expect(
        await git("ls-tree", "-r", "--name-only", `origin/${pull!.headRef}`),
      ).not.toContain("untested.txt");
      expect(check).toHaveBeenCalledTimes(3);
      // A useful project batch can grow past ten tickets; no count threshold
      // prevents the initial small batch from being published.
      await git("checkout", "pm-staging");
      for (let number = 11; number <= 19; number++)
        await addChange(number, `core/next-${number}.txt`, true);
      await runPromote(ctx, { ...opts, onPublished: published });
      const [largeBatch] = await ctx.forge.listOpenPulls(TEST_REPO, {
        base: "staging",
      });
      expect(largeBatch!.number).toBe(pull!.number);
      expect(largeBatch!.title).toContain("12 changes");
      expect(published).toHaveBeenLastCalledWith(
        expect.objectContaining({
          changes: [1, 3, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19],
        }),
        expect.objectContaining({
          number: pull!.number,
          headSha: await git("rev-parse", `origin/${pull!.headRef}`),
        }),
      );
      expect(check).toHaveBeenCalledTimes(4);
      ctx.forge.seedPull(TEST_REPO, {
        number: 20,
        headRef: "pm-release/core/legacy",
        baseRef: "staging",
        state: "open",
        draft: true,
      });
      expect((await runPromote(ctx, opts))[0]!.text).toContain(
        "existing per-PM promotion PRs",
      );
      expect(check).toHaveBeenCalledTimes(4);
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  },
  // Full-suite Windows process contention can dominate the real Git work.
  process.platform === "win32" ? 120_000 : 20_000,
);
