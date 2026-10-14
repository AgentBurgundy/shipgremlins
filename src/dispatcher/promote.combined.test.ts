import { mkdtemp, mkdir, writeFile, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { realGit } from "../git.ts";
import { makeCtx, makeProject, TEST_REPO } from "../services/fakes.ts";
import { runPromote } from "./promote.ts";

it(
  "combines two PMs into one reusable build-checked draft and excludes untested commits",
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
        publishVerifiedDraft: true,
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
      await runPromote(ctx, opts);
      const [pull] = await ctx.forge.listOpenPulls(TEST_REPO, {
        base: "staging",
      });
      expect(pull).toMatchObject({
        headRef: "pm-release/combined/20261002",
        draft: true,
      });
      expect(pull!.body).toContain("owning PMs");
      expect(pull!.body).toContain("Change 2 — not tested");
      await git("checkout", "pm-staging");
      await addChange(10, "core/next.txt", true);
      await runPromote(ctx, opts);
      const pulls = await ctx.forge.listOpenPulls(TEST_REPO, {
        base: "staging",
      });
      expect(pulls).toHaveLength(1);
      expect(pulls[0]!.number).toBe(pull!.number);
      expect(pulls[0]!.body).toContain("Change 10");
      expect(await git("rev-parse", "origin/staging")).toBe(base);
      expect(
        await git("ls-tree", "-r", "--name-only", `origin/${pull!.headRef}`),
      ).not.toContain("untested.txt");
      expect(check).toHaveBeenCalledTimes(2);
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
      expect(check).toHaveBeenCalledTimes(2);
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  },
  process.platform === "win32" ? 60_000 : 20_000,
);
