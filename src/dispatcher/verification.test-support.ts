import type { TestCtx } from "../services/fakes.ts";
import type { PromoteOpts } from "./promote.ts";
import { runPromote } from "./promote.ts";
import type { BrowserEvidence } from "./verification.ts";

export function passingEvidence(
  sourceSha: string,
  status: BrowserEvidence["status"] = "passed",
): BrowserEvidence {
  return {
    schemaVersion: 1,
    sourceSha,
    testedSha: sourceSha,
    status,
    runId: "test-verifier-run",
    deployment: {
      id: "deployment-under-test",
      url: "https://candidate.example.test",
      sha: sourceSha,
    },
    screenshots: ["https://artifacts.example.test/screenshot.png"],
    assertions: [{ name: "Acceptance criterion", status }],
  };
}

/** Existing selection/build scenarios explicitly supply the new verification prerequisites. */
export async function promoteWithEvidence(ctx: TestCtx, opts: PromoteOpts) {
  const sha = "c".repeat(40);
  const baseSha = "b".repeat(40);
  ctx.forge.seedBranch(
    ctx.project.config.repo,
    ctx.project.config.branches.staging,
    baseSha,
  );
  const original = opts.git.run.bind(opts.git);
  let verifiedBranch: string | undefined;
  opts.git.run = async (args, cwd) => {
    const result = await original(args, cwd);
    if (args.join(" ") === "rev-parse HEAD") return { ...result, out: sha };
    if (
      args.join(" ") ===
      `rev-parse origin/${ctx.project.config.branches.staging}`
    )
      return { ...result, out: baseSha };
    if (
      verifiedBranch &&
      args.join(" ") === `ls-remote --heads origin ${verifiedBranch}`
    )
      return { ...result, out: `${sha}\trefs/heads/${verifiedBranch}\n` };
    return result;
  };
  try {
    return await runPromote(ctx, {
      ...opts,
      check:
        opts.check ??
        (async () => ({ ok: true, output: "all required checks passed" })),
      verifyCandidate: async (candidate) => {
        verifiedBranch = candidate.branch;
        return {
          ok: true,
          author: ctx.botLogin,
          evidence: passingEvidence(candidate.sha),
        };
      },
    });
  } finally {
    opts.git.run = original;
  }
}
