// The build check: a change can apply cleanly on staging and still not build
// there, because it imports a file that a held change added. These tests fake
// the check from the git calls so far — "what is on the branch right now".

import { describe, expect, it } from "vitest";
import {
  makeCtx,
  makeProject,
  TEST_REPO,
  type TestCtx,
} from "../services/fakes.ts";
import { FakeGit } from "../git.ts";
import { promotionTitle } from "./notes.ts";
import {
  promoteWithEvidence as runPromote,
  passingEvidence,
} from "./verification.test-support.ts";
import { formatBrowserEvidence } from "./verification.ts";

const DIR = "/work/target";

function oneArea(): TestCtx {
  return makeCtx({
    project: makeProject({
      areas: [{ key: "core", name: "Core", paths: ["app/", "tests/"] }],
    }),
  });
}

let shaNo = 1;
function seedMerged(
  ctx: TestCtx,
  number: number,
  files: string[],
  mergedAt: string,
): string {
  const sha = "c0ffee" + (shaNo++).toString(16).padStart(34, "0");
  ctx.forge.seedPull(
    TEST_REPO,
    {
      number,
      title: `Change ${number}`,
      state: "merged",
      mergedAt,
      mergeCommitSha: sha,
      headRef: `pm/game-${number}`,
    },
    files,
  );
  ctx.forge.seedComment(
    TEST_REPO,
    number,
    formatBrowserEvidence(passingEvidence(sha)),
  );
  return sha;
}

/** the merge shas on the branch, replayed from the git calls so far */
function onBranch(git: FakeGit, carried: string[] = []): string[] {
  let head: string[] = [];
  for (const cmd of git.commands()) {
    if (cmd.startsWith("checkout -B") || cmd.startsWith("reset --hard origin/"))
      head = cmd.includes("origin/pm-release/") ? [...carried] : [];
    else if (cmd === "reset --hard HEAD~1") head = head.slice(0, -1);
    else if (cmd.startsWith("cherry-pick -x "))
      head = [...head, cmd.split(" ").pop()!];
  }
  return head;
}

/** builds unless one of `broken` is on the branch without its `needs` */
function checkFor(
  git: FakeGit,
  needs: Record<string, string>,
  carried: string[] = [],
) {
  const calls: string[][] = [];
  const check = async () => {
    const head = onBranch(git, carried);
    calls.push(head);
    const ok = head.every((sha) => !needs[sha] || head.includes(needs[sha]!));
    return { ok, output: ok ? "" : "Cannot find module" };
  };
  return { check, calls };
}

describe("runPromote build check", () => {
  it("checks once and changes nothing when the batch builds", async () => {
    const ctx = oneArea();
    const a = seedMerged(ctx, 10, ["app/a.ts"], "2026-10-01T10:00:00Z");
    const b = seedMerged(ctx, 11, ["app/b.ts"], "2026-10-01T11:00:00Z");
    const git = new FakeGit();
    const { check, calls } = checkFor(git, {});

    const rows = await runPromote(ctx, { git, checkoutDir: DIR, check });

    expect(calls).toEqual([[a, b]]);
    expect(git.commands().some((c) => c.startsWith("reset"))).toBe(false);
    expect(rows[0]!.text).toContain("2 new, 2 total, 0 held");
  });

  it("holds the change that does not build on staging by itself and ships the rest", async () => {
    const ctx = oneArea();
    const missing = "f".repeat(40); // the seam lives in a change that is not here
    const good = seedMerged(ctx, 10, ["app/a.ts"], "2026-10-01T10:00:00Z");
    const needsSeam = seedMerged(
      ctx,
      11,
      ["tests/billing.test.ts"],
      "2026-10-01T11:00:00Z",
    );
    const alsoGood = seedMerged(ctx, 12, ["app/c.ts"], "2026-10-01T12:00:00Z");
    const git = new FakeGit();
    const { check } = checkFor(git, { [needsSeam]: missing });

    const rows = await runPromote(ctx, { git, checkoutDir: DIR, check });

    expect(onBranch(git)).toEqual([good, alsoGood]);
    expect(git.commands()).toContain("reset --hard origin/staging");
    expect(git.commands()).toContain("reset --hard HEAD~1");
    const prs = await ctx.forge.listOpenPulls(TEST_REPO, { base: "staging" });
    expect(prs).toHaveLength(1);
    expect(prs[0]!.title).toBe(promotionTitle("Core", "2026-10-02", 2));
    expect(prs[0]!.body).toContain(
      "Change 11 — does not build on staging by itself — it needs work that is not promoted yet",
    );
    expect(rows[0]!.text).toContain("2 new, 2 total, 1 held");
  });

  it("rebuilds an open promotion whose carried change does not build, and force-pushes it", async () => {
    const ctx = oneArea();
    const missing = "f".repeat(40);
    const carriedBad = seedMerged(
      ctx,
      20,
      ["tests/billing.test.ts"],
      "2026-10-01T09:00:00Z",
    );
    const carriedGood = seedMerged(
      ctx,
      21,
      ["app/a.ts"],
      "2026-10-01T10:00:00Z",
    );
    const open = ctx.forge.seedPull(TEST_REPO, {
      number: 70,
      headRef: "pm-release/core/20261001",
      baseRef: "staging",
      draft: false,
      title: promotionTitle("Core", "2026-10-01", 2),
    });
    const git = new FakeGit([
      {
        match:
          "log --format=%B origin/staging..origin/pm-release/core/20261001",
        result: `x\n\n(cherry picked from commit ${carriedBad})\n\ny\n\n(cherry picked from commit ${carriedGood})\n`,
      },
    ]);
    const { check } = checkFor(git, { [carriedBad]: missing }, [
      carriedBad,
      carriedGood,
    ]);

    const rows = await runPromote(ctx, { git, checkoutDir: DIR, check });

    expect(onBranch(git, [carriedBad, carriedGood])).toEqual([carriedGood]);
    expect(git.commands()).toContain(
      `push --force-with-lease=refs/heads/pm-release/core/20261001:${open.headSha} origin HEAD:refs/heads/pm-release/core/20261001`,
    );
    const pr = (
      await ctx.forge.listOpenPulls(TEST_REPO, { base: "staging" })
    )[0]!;
    expect(pr.title).toBe(promotionTitle("Core", "2026-10-02", 1));
    expect(pr.body).toContain(
      "Change 20 — does not build on staging by itself",
    );
    expect(rows[0]!.text).toContain("0 new, 1 total, 1 held");
  });

  it("blocks promotion when staging itself does not build", async () => {
    const ctx = oneArea();
    seedMerged(ctx, 10, ["app/a.ts"], "2026-10-01T10:00:00Z");
    const git = new FakeGit();
    const check = async () => ({ ok: false, output: "staging is red" });

    const rows = await runPromote(ctx, { git, checkoutDir: DIR, check });

    expect(onBranch(git)).toEqual([]);
    expect(git.commands().some((c) => c.startsWith("push"))).toBe(false);
    expect(
      await ctx.forge.listOpenPulls(TEST_REPO, { base: "staging" }),
    ).toEqual([]);
    expect(rows[0]).toMatchObject({ needsYou: true });
    expect(rows[0]!.text).toContain("staging itself does not build");
  });

  it("does not drop a good change for sharing a file with a NEWER held merge", async () => {
    const ctx = oneArea();
    const missing = "f".repeat(40);
    const good = seedMerged(
      ctx,
      10,
      ["app/shared.css"],
      "2026-10-01T10:00:00Z",
    );
    const needsSeam = seedMerged(
      ctx,
      11,
      ["tests/billing.test.ts"],
      "2026-10-01T11:00:00Z",
    );
    // newer, untested, touches the same file as `good`: held before any pick
    ctx.forge.seedPull(
      TEST_REPO,
      {
        number: 12,
        title: "Change 12",
        state: "merged",
        mergedAt: "2026-10-01T12:00:00Z",
        mergeCommitSha: "d".repeat(40),
        headRef: "pm/game-12",
      },
      ["app/shared.css"],
    );
    // both are already on the open promotion, so neither is re-screened
    ctx.forge.seedPull(TEST_REPO, {
      number: 70,
      headRef: "pm-release/core/20261001",
      baseRef: "staging",
      draft: false,
      title: promotionTitle("Core", "2026-10-01", 2),
    });
    const git = new FakeGit([
      {
        match:
          "log --format=%B origin/staging..origin/pm-release/core/20261001",
        result: `x\n\n(cherry picked from commit ${good})\n\ny\n\n(cherry picked from commit ${needsSeam})\n`,
      },
    ]);
    const { check } = checkFor(git, { [needsSeam]: missing }, [
      good,
      needsSeam,
    ]);

    const rows = await runPromote(ctx, { git, checkoutDir: DIR, check });

    expect(onBranch(git, [good, needsSeam])).toEqual([good]);
    expect(rows[0]!.text).toContain("0 new, 1 total, 2 held");
  });

  it("picks a change that shares a file only with a NEWER held merge, and holds one that follows it", async () => {
    const ctx = oneArea();
    const older = seedMerged(ctx, 10, ["app/hot.ts"], "2026-10-01T10:00:00Z");
    const untested = (number: number, mergedAt: string, sha: string) =>
      ctx.forge.seedPull(
        TEST_REPO,
        {
          number,
          title: `Change ${number}`,
          state: "merged",
          mergedAt,
          mergeCommitSha: sha,
          headRef: `pm/game-${number}`,
        },
        ["app/hot.ts"],
      );
    untested(11, "2026-10-01T11:00:00Z", "d".repeat(40));
    const newer = seedMerged(ctx, 12, ["app/hot.ts"], "2026-10-01T12:00:00Z");
    const git = new FakeGit();

    const rows = await runPromote(ctx, { git, checkoutDir: DIR });

    expect(onBranch(git)).toEqual([older]);
    expect(onBranch(git)).not.toContain(newer);
    expect(rows[0]!.text).toContain("1 new, 1 total, 2 held");
  });
});

describe("runPromote and the owner's own PRs", () => {
  const human = (ctx: TestCtx, number: number, labels: string[]): string => {
    const sha = "0123456789" + String(number).padStart(30, "e");
    ctx.forge.seedPull(
      TEST_REPO,
      {
        number,
        title: `Owner change ${number}`,
        state: "merged",
        mergedAt: `2026-10-01T1${number % 10}:00:00Z`,
        mergeCommitSha: sha,
        author: "the-owner",
        headRef: `owner/thing-${number}`,
        labels,
      },
      [`app/owner-${number}.ts`],
    );
    ctx.forge.seedComment(
      TEST_REPO,
      number,
      formatBrowserEvidence(passingEvidence(sha)),
    );
    return sha;
  };

  it("promotes a verified human PR only when it is labeled pm-owner", async () => {
    const ctx = oneArea();
    const labeled = human(ctx, 31, ["pm-owner"]);
    const unlabeled = human(ctx, 32, []);
    const git = new FakeGit();

    const rows = await runPromote(ctx, { git, checkoutDir: DIR });

    expect(onBranch(git)).toEqual([labeled]);
    expect(onBranch(git)).not.toContain(unlabeled);
    expect(rows[0]!.text).toContain("1 new, 1 total, 0 held");
  });
});

describe("runPromote and sync resolutions", () => {
  it("neither promotes a pm-sync merge nor lets it hold changes on its files", async () => {
    const ctx = oneArea();
    // untested, merged first, touches the same file as the real change
    ctx.forge.seedPull(
      TEST_REPO,
      {
        number: 60,
        title: "Resolve sync conflict",
        state: "merged",
        mergedAt: "2026-10-01T08:00:00Z",
        mergeCommitSha: "5".repeat(40),
        headRef: "pm-sync/abc123abc123",
      },
      ["app/a.ts"],
    );
    const real = seedMerged(ctx, 61, ["app/a.ts"], "2026-10-01T09:00:00Z");
    const git = new FakeGit();

    const rows = await runPromote(ctx, { git, checkoutDir: DIR });

    expect(onBranch(git)).toEqual([real]);
    expect(rows[0]!.text).toContain("1 new, 1 total, 0 held");
  });
});
