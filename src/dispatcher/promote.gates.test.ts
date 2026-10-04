import { describe, expect, it } from "vitest";
import { FakeGit } from "../git.ts";
import { makeCtx, TEST_REPO } from "../services/fakes.ts";
import { runPromote, type PromoteOpts } from "./promote.ts";
import { formatBrowserEvidence } from "./verification.ts";
import { passingEvidence } from "./verification.test-support.ts";

const CANDIDATE = "c".repeat(40);
const BASE = "b".repeat(40);
function fixture() {
  const ctx = makeCtx();
  ctx.forge.seedBranch(TEST_REPO, "staging", BASE);
  const source = "a".repeat(40);
  const pr = ctx.forge.seedPull(
    TEST_REPO,
    {
      number: 10,
      state: "merged",
      mergedAt: "2026-10-01T10:00:00Z",
      mergeCommitSha: source,
    },
    ["app/a.ts"],
  );
  ctx.forge.seedComment(
    TEST_REPO,
    pr.number,
    formatBrowserEvidence(passingEvidence(source)),
  );
  const git = new FakeGit({
    "rev-parse HEAD": CANDIDATE,
    "rev-parse origin/staging": BASE,
  });
  const opts: PromoteOpts = {
    git,
    checkoutDir: "/target",
    check: async () => ({ ok: true, output: "all checks passed" }),
  };
  return { ctx, git, opts };
}

describe("promotion release gates", () => {
  it("cannot bypass the mandatory local build check through the public API", async () => {
    const { ctx, git } = fixture();
    const rows = await runPromote(ctx, { git, checkoutDir: "/target" });
    expect(rows[0]?.needsYou).toBe(true);
    expect(git.calls).toEqual([]);
    expect(
      await ctx.forge.listOpenPulls(TEST_REPO, { base: "staging" }),
    ).toEqual([]);
  });

  it("direct promotion also blocks pending integration health", async () => {
    const { ctx, git, opts } = fixture();
    ctx.forge.seedChecks(
      TEST_REPO,
      ctx.forge.branch(TEST_REPO, "pm-staging")!,
      { status: "pending", failedJobs: [] },
    );
    const rows = await runPromote(ctx, opts);
    expect(rows[0]?.text).toContain("checks are pending");
    expect(git.calls).toEqual([]);
  });

  it("prepares a deployable candidate but creates no PR without browser evidence", async () => {
    const { ctx, git, opts } = fixture();
    const rows = await runPromote(ctx, opts);
    expect(git.commands()).toContain(
      "push origin HEAD:refs/heads/pm-release/core/20261002",
    );
    expect(rows[0]?.text).toContain(CANDIDATE);
    expect(rows[0]?.text).toContain(
      "no authenticated candidate browser evidence",
    );
    expect(rows[0]?.text).toContain(`base ${BASE}`);
    expect(rows[0]?.text).toContain(
      "release pm-release/core/20261002; PRs #10",
    );
    const handoff = ctx.lines.find((line) =>
      line.startsWith("Candidate verification: "),
    )!;
    expect(
      JSON.parse(handoff.slice("Candidate verification: ".length)),
    ).toEqual({
      project: "game",
      repo: TEST_REPO,
      author: ctx.botLogin,
      branch: "pm-release/core/20261002",
      releaseBranch: "pm-release/core/20261002",
      candidateSha: CANDIDATE,
      baseSha: BASE,
      changes: [10],
    });
    expect(handoff).not.toContain(opts.checkoutDir);
    expect(
      await ctx.forge.listOpenPulls(TEST_REPO, { base: "staging" }),
    ).toEqual([]);
  });

  it("never pushes unverified updates into an existing promotion PR", async () => {
    const { ctx, git, opts } = fixture();
    const existing = ctx.forge.seedPull(TEST_REPO, {
      number: 70,
      baseRef: "staging",
      headRef: "pm-release/core/20261001",
      body: "already reviewed",
      draft: false,
    });
    opts.verifyCandidate = async () => ({
      ok: false,
      reason: "screenshots absent",
    });
    const rows = await runPromote(ctx, opts);
    expect(git.commands()).toContain(
      `push origin HEAD:refs/heads/pm-candidate/core/${CANDIDATE}`,
    );
    expect(
      git
        .commands()
        .some((c) => c.startsWith("push") && c.endsWith(existing.headRef)),
    ).toBe(false);
    expect((await ctx.forge.getPull(TEST_REPO, 70))?.body).toBe(
      "already reviewed",
    );
    expect(rows[0]?.text).toContain("screenshots absent");
    expect(rows[0]?.text).toContain(`base ${BASE}`);
    const handoff = ctx.lines.find((line) =>
      line.startsWith("Candidate verification: "),
    )!;
    expect(
      JSON.parse(handoff.slice("Candidate verification: ".length)),
    ).toMatchObject({
      branch: `pm-candidate/core/${CANDIDATE}`,
      releaseBranch: existing.headRef,
      candidateSha: CANDIDATE,
      baseSha: BASE,
      changes: [10],
    });
  });

  it.each([
    "valid",
    "wrong-sha",
    "staging-moved",
    "candidate-moved",
    "line-failed",
  ])(
    "revalidates the exact candidate and branch state before opening a PR (%s)",
    async (scenario) => {
      const { ctx, git, opts } = fixture();
      opts.verifyCandidate = async (candidate) => {
        expect(git.commands()).toContain(
          `push origin HEAD:refs/heads/${candidate.branch}`,
        );
        expect(candidate).toMatchObject({
          sha: CANDIDATE,
          baseSha: BASE,
          changes: [10],
        });
        git.when(
          `ls-remote --heads origin ${candidate.branch}`,
          `${scenario === "candidate-moved" ? "e".repeat(40) : CANDIDATE}\trefs/heads/${candidate.branch}`,
        );
        if (scenario === "staging-moved")
          ctx.forge.seedBranch(TEST_REPO, "staging", "d".repeat(40));
        if (scenario === "line-failed")
          ctx.forge.seedChecks(
            TEST_REPO,
            ctx.forge.branch(TEST_REPO, "pm-staging")!,
            { status: "failure", failedJobs: [] },
          );
        return {
          ok: true,
          author: ctx.botLogin,
          evidence: passingEvidence(
            scenario === "wrong-sha" ? "f".repeat(40) : CANDIDATE,
          ),
        };
      };
      await runPromote(ctx, opts);
      expect(
        await ctx.forge.listOpenPulls(TEST_REPO, { base: "staging" }),
      ).toHaveLength(scenario === "valid" ? 1 : 0);
    },
  );
});
