import { expect, it, vi } from "vitest";
import { FakeGit } from "../git.ts";
import { makeCtx, makeProject, TEST_REPO } from "../services/fakes.ts";
import { runPromote, MAX_MANAGED_CANDIDATES } from "./promote.ts";

function fixture() {
  const ctx = makeCtx({
    project: makeProject({
      areas: [
        { key: "core", name: "Core", paths: ["core/"] },
        { key: "billing", name: "Billing", paths: ["billing/"] },
      ],
    }),
  });
  ctx.project.config.workflow = { kind: "promotion", promotionBatchSize: 100 };
  const core = Array.from({ length: 100 }, (_, index) => index + 1);
  for (let number = 1; number <= 220; number++)
    ctx.forge.seedPull(
      TEST_REPO,
      {
        number,
        state: "merged",
        baseRef: "pm-staging",
        headRef: `gremlins/job-${number}`,
        mergedAt:
          number <= 100 ? "2026-01-01T12:00:00Z" : "2026-10-01T12:00:00Z",
        mergeCommitSha: number.toString(16).padStart(40, "0"),
      },
      [`${number <= 100 ? "core" : "billing"}/${number}.ts`],
    );
  const git = new FakeGit({
    "rev-parse HEAD": "c".repeat(40),
    "rev-parse origin/staging": "d".repeat(40),
  });
  const candidatePullNumbers = vi.fn(async () => core);
  const check = vi.fn(async () => ({ ok: true, output: "checks passed" }));
  const verifyCandidate = vi.fn(async () => ({
    ok: false as const,
    reason: "Capture pending",
  }));
  const opts = {
    git,
    checkoutDir: "/target",
    area: "core",
    local: true,
    automatic: true,
    candidatePullNumbers,
    check,
    verifyCandidate,
    candidateVerdict: async (pull: { number: number }) => ({
      area: pull.number <= 100 ? "core" : "billing",
      ticketId: `ticket-${pull.number}`,
      verdict: "verified" as const,
    }),
  };
  return { ctx, core, opts, git, check, verifyCandidate, candidatePullNumbers };
}

it("collects a hundred admitted older-area tickets despite a hundred newer unrelated integration PRs", async () => {
  const f = fixture();
  const recent = await f.ctx.forge.listMergedPulls(
    TEST_REPO,
    "pm-staging",
    "2026-08-01T00:00:00Z",
  );
  expect(recent).toHaveLength(120);
  expect(recent.every((pull) => pull.number > 100)).toBe(true);
  await runPromote(f.ctx, f.opts);
  expect(f.candidatePullNumbers).toHaveBeenCalledExactlyOnceWith("core");
  expect(f.check).toHaveBeenCalledOnce();
  expect(f.verifyCandidate).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ changes: f.core }),
  );
  expect(
    f.git.commands().filter((command) => command.startsWith("cherry-pick -x")),
  ).toHaveLength(100);
  expect(f.ctx.forge.merged).toEqual([]);
});

it("does not count a freshly retargeted or foreign-authored admitted PR toward the threshold", async () => {
  const f = fixture();
  f.ctx.forge.patchPull(TEST_REPO, 1, { baseRef: "main" });
  f.ctx.forge.patchPull(TEST_REPO, 2, { author: "different-user" });
  const rows = await runPromote(f.ctx, f.opts);
  expect(rows[0]!.text).toContain("98/100 PM-tested tickets");
  expect(f.check).not.toHaveBeenCalled();
  expect(f.verifyCandidate).not.toHaveBeenCalled();
});

it("bounds exact admitted provider reads instead of silently truncating the manifest", async () => {
  const f = fixture(),
    get = vi.spyOn(f.ctx.forge, "getPull");
  f.opts.candidatePullNumbers.mockResolvedValueOnce(
    Array.from({ length: MAX_MANAGED_CANDIDATES + 1 }, (_, index) => index + 1),
  );
  await expect(runPromote(f.ctx, f.opts)).rejects.toThrow("at most 300");
  expect(get).not.toHaveBeenCalled();
  expect(f.check).not.toHaveBeenCalled();
});
