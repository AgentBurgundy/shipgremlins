import { describe, expect, it } from "vitest";
import type { PullRequest } from "../forge/types.ts";
import type { SeedPull } from "../forge/fake.ts";
import { makeCtx, TEST_REPO, type TestCtx } from "../services/fakes.ts";
import {
  formatMergeFailed,
  HUB_CONFIG_PREFIX,
  MERGE_FAILED_PREFIX,
  MERGED_PREFIX,
  PR_OPENED_PREFIX,
} from "./notes.ts";
import { runMerge } from "./merge.ts";

const INTEGRATION = "pm-staging";

/** a draft bot PR to pm-staging that has everything merge needs */
function readyPull(
  ctx: TestCtx,
  over: SeedPull = {},
  files: string[] = ["app/page.tsx"],
): PullRequest {
  const pr = ctx.forge.seedPull(
    TEST_REPO,
    { baseRef: INTEGRATION, draft: true, mergeableState: "clean", ...over },
    files,
  );
  ctx.forge.seedChecks(TEST_REPO, pr.headSha, {
    status: "success",
    failedJobs: [],
  });
  ctx.forge.seedComment(
    TEST_REPO,
    pr.number,
    `${PR_OPENED_PREFIX} #${pr.number}`,
  );
  return pr;
}

const open = () => ({ lineStopped: false });

describe("runMerge", () => {
  it("merges only the oldest ready PR, then waits for integration checks and deployment", async () => {
    const ctx = makeCtx();
    const newer = readyPull(ctx, {
      number: 12,
      title: "newer",
      createdAt: "2026-10-02T10:00:00Z",
    });
    const older = readyPull(ctx, {
      number: 11,
      title: "older",
      createdAt: "2026-10-01T10:00:00Z",
    });

    const rows = await runMerge(ctx, open());

    expect(ctx.forge.merged).toEqual([older.number]);
    expect(ctx.forge.readied).toEqual([older.number]);
    expect(ctx.forge.deletedBranches).toEqual([older.headRef]);
    expect((await ctx.forge.getPull(TEST_REPO, newer.number))?.draft).toBe(
      true,
    );
    expect(
      ctx.forge
        .comments(TEST_REPO, older.number)
        .some((c) => c.startsWith(MERGED_PREFIX)),
    ).toBe(true);
    expect(rows.map((r) => r.text)).toEqual(["🚢 #11 older"]);
    expect(rows.every((r) => r.rule === "merge" && !r.needsYou)).toBe(true);
    expect(rows[0]!.ref).toBe("11");
  });

  it("uses the project's merge method and the PR head sha", async () => {
    const ctx = makeCtx();
    const calls: { method: string; sha: string }[] = [];
    const original = ctx.forge.mergePull.bind(ctx.forge);
    ctx.forge.mergePull = async (repo, number, opts) => {
      calls.push(opts);
      return original(repo, number, opts);
    };
    const pr = readyPull(ctx);
    await runMerge(ctx, open());
    expect(calls).toEqual([{ method: "squash", sha: pr.headSha }]);
  });

  it("ignores PRs by other authors and PRs targeting other branches", async () => {
    const ctx = makeCtx();
    readyPull(ctx, { author: "someone-else" });
    readyPull(ctx, { baseRef: "staging" });
    const rows = await runMerge(ctx, open());
    expect(ctx.forge.merged).toEqual([]);
    expect(rows).toEqual([]);
  });

  describe("skip reasons (no row, logged)", () => {
    it("not a draft — someone marked it ready", async () => {
      const ctx = makeCtx();
      readyPull(ctx, { draft: false });
      const rows = await runMerge(ctx, open());
      expect(ctx.forge.merged).toEqual([]);
      expect(rows).toEqual([]);
      expect(
        ctx.lines.some((l) =>
          l.includes("not a draft — someone marked it ready"),
        ),
      ).toBe(true);
    });

    it("no PR opened comment", async () => {
      const ctx = makeCtx();
      const pr = ctx.forge.seedPull(TEST_REPO, { baseRef: INTEGRATION });
      ctx.forge.seedChecks(TEST_REPO, pr.headSha, {
        status: "success",
        failedJobs: [],
      });
      const rows = await runMerge(ctx, open());
      expect(ctx.forge.merged).toEqual([]);
      expect(rows).toEqual([]);
      expect(ctx.lines.some((l) => l.includes(PR_OPENED_PREFIX))).toBe(true);
    });

    it.each(["failure", "none"] as const)("checks %s", async (status) => {
      const ctx = makeCtx();
      const pr = readyPull(ctx);
      ctx.forge.seedChecks(TEST_REPO, pr.headSha, { status, failedJobs: [] });
      const rows = await runMerge(ctx, open());
      expect(ctx.forge.merged).toEqual([]);
      expect(rows).toEqual([]);
      expect(ctx.lines.some((l) => l.includes(`checks are ${status}`))).toBe(
        true,
      );
    });

    it("checks still running: no merge, and a `pending` row so the workflow comes back", async () => {
      const ctx = makeCtx();
      const pr = readyPull(ctx);
      ctx.forge.seedChecks(TEST_REPO, pr.headSha, {
        status: "pending",
        failedJobs: [],
      });
      const rows = await runMerge(ctx, open());
      expect(ctx.forge.merged).toEqual([]);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ rule: "merge", pending: true });
      expect(rows[0]!.needsYou).toBeFalsy();
      expect(ctx.lines.some((l) => l.includes("checks are pending"))).toBe(
        true,
      );
    });

    it("mergeability not settled yet: a `pending` row, not a silent skip", async () => {
      const ctx = makeCtx();
      readyPull(ctx, { mergeableState: "unknown" });
      const rows = await runMerge(ctx, open());
      expect(ctx.forge.merged).toEqual([]);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ pending: true });
      expect(rows[0]!.needsYou).toBeFalsy();
    });

    it.each(["dirty", "behind", "blocked"])(
      "mergeable state %s",
      async (mergeableState) => {
        const ctx = makeCtx();
        readyPull(ctx, { mergeableState });
        const rows = await runMerge(ctx, open());
        expect(ctx.forge.merged).toEqual([]);
        expect(rows).toEqual([]);
        expect(
          ctx.lines.some((l) =>
            l.includes(`mergeable state is ${mergeableState}`),
          ),
        ).toBe(true);
      },
    );

    it("mergeable state unstable still merges", async () => {
      const ctx = makeCtx();
      const pr = readyPull(ctx, { mergeableState: "unstable" });
      await runMerge(ctx, open());
      expect(ctx.forge.merged).toEqual([pr.number]);
    });
  });

  describe("@claude comments", () => {
    it("an unanswered @claude comment from a human blocks the merge", async () => {
      const ctx = makeCtx();
      const pr = readyPull(ctx);
      ctx.forge.seedComment(
        TEST_REPO,
        pr.number,
        "@claude please rename this",
        "owner",
        "2026-10-02T12:30:00Z",
      );
      const rows = await runMerge(ctx, open());
      expect(ctx.forge.merged).toEqual([]);
      expect(rows).toEqual([]);
      expect(ctx.lines.some((l) => l.includes("@claude"))).toBe(true);
    });

    it("an @claude comment the bot answered afterwards does not block", async () => {
      const ctx = makeCtx();
      const pr = readyPull(ctx);
      ctx.forge.seedComment(
        TEST_REPO,
        pr.number,
        "@claude please rename this",
        "owner",
        "2026-10-02T12:30:00Z",
      );
      ctx.forge.seedComment(
        TEST_REPO,
        pr.number,
        "Renamed as asked.",
        ctx.botLogin,
        "2026-10-02T12:45:00Z",
      );
      await runMerge(ctx, open());
      expect(ctx.forge.merged).toEqual([pr.number]);
    });

    it("the bot's own @claude mention does not block", async () => {
      const ctx = makeCtx();
      const pr = readyPull(ctx);
      ctx.forge.seedComment(
        TEST_REPO,
        pr.number,
        "note: @claude is the developer here",
        ctx.botLogin,
      );
      await runMerge(ctx, open());
      expect(ctx.forge.merged).toEqual([pr.number]);
    });
  });

  describe("owner holds", () => {
    it("a PR touching hubOwnerOnly files is held with one comment and a needs-you row", async () => {
      const ctx = makeCtx();
      const pr = readyPull(ctx, {}, [
        "app/page.tsx",
        ".github/workflows/ci.yml",
        "prompts/pm.md",
      ]);

      const first = await runMerge(ctx, open());
      expect(ctx.forge.merged).toEqual([]);
      expect(ctx.forge.readied).toEqual([]);
      const holds = () =>
        ctx.forge
          .comments(TEST_REPO, pr.number)
          .filter((c) => c.startsWith(HUB_CONFIG_PREFIX));
      expect(holds()).toHaveLength(1);
      expect(holds()[0]).toContain(".github/workflows/ci.yml");
      expect(holds()[0]).toContain("prompts/pm.md");
      expect(holds()[0]).not.toContain("app/page.tsx");
      expect(first).toHaveLength(1);
      expect(first[0]).toMatchObject({ rule: "merge", needsYou: true });

      const second = await runMerge(ctx, open());
      expect(holds()).toHaveLength(1);
      expect(second).toEqual([]);
      expect(ctx.forge.merged).toEqual([]);
    });

    it("a merge-failed comment holds the PR only while its head is that sha", async () => {
      const ctx = makeCtx();
      const pr = readyPull(ctx);
      ctx.forge.seedComment(
        TEST_REPO,
        pr.number,
        formatMergeFailed(pr.headSha, "Base branch was modified"),
      );

      const held = await runMerge(ctx, open());
      expect(ctx.forge.merged).toEqual([]);
      expect(held).toEqual([]);
      expect(ctx.lines.some((l) => l.includes("merge failed"))).toBe(true);

      const newSha = "f".repeat(40);
      ctx.forge.patchPull(TEST_REPO, pr.number, { headSha: newSha });
      ctx.forge.seedChecks(TEST_REPO, newSha, {
        status: "success",
        failedJobs: [],
      });
      const rows = await runMerge(ctx, open());
      expect(ctx.forge.merged).toEqual([pr.number]);
      expect(rows).toHaveLength(1);
    });

    it("a refused merge is commented with the sha and reported as needs you", async () => {
      const ctx = makeCtx();
      const pr = readyPull(ctx);
      ctx.forge.nextMergeRefusal = "Required status check is expected.";
      const rows = await runMerge(ctx, open());
      expect(ctx.forge.merged).toEqual([]);
      const failed = () =>
        ctx.forge
          .comments(TEST_REPO, pr.number)
          .filter((c) => c.startsWith(MERGE_FAILED_PREFIX));
      expect(failed()).toEqual([
        formatMergeFailed(pr.headSha, "Required status check is expected."),
      ]);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ rule: "merge", needsYou: true });
      expect(rows[0]!.text).toContain("Required status check is expected.");

      const again = await runMerge(ctx, open());
      expect(again).toEqual([]);
      expect(failed()).toHaveLength(1);
      expect(ctx.forge.merged).toEqual([]);
    });
  });

  it("merges nothing while the line is stopped and says how many wait", async () => {
    const ctx = makeCtx();
    readyPull(ctx);
    readyPull(ctx);
    const rows = await runMerge(ctx, { lineStopped: true });
    expect(ctx.forge.merged).toEqual([]);
    expect(ctx.forge.readied).toEqual([]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.text).toBe("line stopped — 2 PRs waiting");
    expect(rows[0]!.needsYou).toBeFalsy();
  });

  it("line stopped with nothing waiting adds no row", async () => {
    const ctx = makeCtx();
    const rows = await runMerge(ctx, { lineStopped: true });
    expect(rows).toEqual([]);
  });

  it("dry-run merges nothing and logs the would-be merge", async () => {
    const ctx = makeCtx({ dryRun: true });
    const pr = readyPull(ctx);
    const rows = await runMerge(ctx, open());
    expect(ctx.forge.merged).toEqual([]);
    expect(ctx.forge.readied).toEqual([]);
    expect(ctx.forge.comments(TEST_REPO, pr.number)).toHaveLength(1);
    expect(rows).toEqual([]);
    expect(
      ctx.lines.some(
        (l) => l.startsWith("[dry-run]") && l.includes(`#${pr.number}`),
      ),
    ).toBe(true);
  });

  it("re-checks each PR right before merging: one an earlier merge put in conflict stays a draft for repair", async () => {
    const ctx = makeCtx();
    const first = ctx.forge.seedPull(TEST_REPO, {
      number: 31,
      createdAt: "2026-10-01T00:00:00Z",
    });
    const second = ctx.forge.seedPull(TEST_REPO, {
      number: 32,
      createdAt: "2026-10-02T00:00:00Z",
    });
    for (const pr of [first, second]) {
      ctx.forge.seedComment(TEST_REPO, pr.number, `${PR_OPENED_PREFIX} — done`);
      ctx.forge.seedChecks(TEST_REPO, pr.headSha, {
        status: "success",
        failedJobs: [],
      });
    }
    // merging #31 makes #32 conflict, as GitHub would report on the next read
    const realMerge = ctx.forge.mergePull.bind(ctx.forge);
    ctx.forge.mergePull = async (repo, number, opts) => {
      const r = await realMerge(repo, number, opts);
      if (number === 31)
        ctx.forge.patchPull(TEST_REPO, 32, { mergeableState: "dirty" });
      return r;
    };
    const rows = await runMerge(ctx, { lineStopped: false });
    expect(ctx.forge.merged).toEqual([31]);
    expect(ctx.forge.readied).toEqual([31]);
    expect(ctx.forge.pull(TEST_REPO, 32).draft).toBe(true);
    expect(
      ctx.forge
        .comments(TEST_REPO, 32)
        .some((c) => c.startsWith(MERGE_FAILED_PREFIX)),
    ).toBe(false);
    expect(rows.filter((r) => r.needsYou)).toEqual([]);
  });

  it("merges a PR it readied itself on an earlier failed attempt once the head has moved", async () => {
    const ctx = makeCtx();
    const pr = ctx.forge.seedPull(TEST_REPO, {
      number: 41,
      draft: false,
      headSha: "bbbbbbbbbbbb2222",
    });
    ctx.forge.seedComment(TEST_REPO, 41, `${PR_OPENED_PREFIX} — done`);
    ctx.forge.seedComment(
      TEST_REPO,
      41,
      formatMergeFailed("aaaaaaaaaaaa1111", "Pull Request has merge conflicts"),
    );
    ctx.forge.seedChecks(TEST_REPO, pr.headSha, {
      status: "success",
      failedJobs: [],
    });
    await runMerge(ctx, { lineStopped: false });
    expect(ctx.forge.merged).toEqual([41]);
  });

  it("still leaves alone a non-draft PR somebody else marked ready", async () => {
    const ctx = makeCtx();
    const pr = ctx.forge.seedPull(TEST_REPO, { number: 42, draft: false });
    ctx.forge.seedComment(TEST_REPO, 42, `${PR_OPENED_PREFIX} — done`);
    ctx.forge.seedChecks(TEST_REPO, pr.headSha, {
      status: "success",
      failedJobs: [],
    });
    await runMerge(ctx, { lineStopped: false });
    expect(ctx.forge.merged).toEqual([]);
  });

  it("never treats the sync PR (staging → integration) as a developer PR", async () => {
    const ctx = makeCtx();
    ctx.forge.seedPull(TEST_REPO, {
      number: 43,
      headRef: "staging",
      draft: false,
    });
    await runMerge(ctx, { lineStopped: false });
    expect(ctx.forge.merged).toEqual([]);
    expect(ctx.lines.some((l) => l.includes("#43"))).toBe(false);
  });

  it("a conflict refusal is handed to repair, not to the owner", async () => {
    const ctx = makeCtx();
    const pr = ctx.forge.seedPull(TEST_REPO, { number: 44 });
    ctx.forge.seedComment(TEST_REPO, 44, `${PR_OPENED_PREFIX} — done`);
    ctx.forge.seedChecks(TEST_REPO, pr.headSha, {
      status: "success",
      failedJobs: [],
    });
    ctx.forge.nextMergeRefusal = "Pull Request has merge conflicts";
    const rows = await runMerge(ctx, { lineStopped: false });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.needsYou).toBeFalsy();
    expect(rows[0]!.text).toContain("sent for repair");
  });

  it("lands a sync-resolution PR as a MERGE commit even when the project squashes", async () => {
    const ctx = makeCtx();
    const pr = ctx.forge.seedPull(TEST_REPO, {
      number: 50,
      headRef: "pm-sync/aaaaaaaaaaaa",
    });
    ctx.forge.seedComment(TEST_REPO, 50, `${PR_OPENED_PREFIX} — done`);
    ctx.forge.seedChecks(TEST_REPO, pr.headSha, {
      status: "success",
      failedJobs: [],
    });
    const methods: string[] = [];
    const realMerge = ctx.forge.mergePull.bind(ctx.forge);
    ctx.forge.mergePull = async (repo, number, opts) => {
      methods.push(opts.method);
      return realMerge(repo, number, opts);
    };
    await runMerge(ctx, { lineStopped: false });
    expect(ctx.project.config.mergeMethod).toBe("squash");
    expect(ctx.forge.merged).toEqual([50]);
    expect(methods).toEqual(["merge"]);
  });
});
