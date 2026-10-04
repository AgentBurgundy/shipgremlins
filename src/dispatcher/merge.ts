// Merge: every green, finished, unquestioned draft PR the developer opened
// against the integration branch lands there, oldest first. The integration
// branch takes any green agent PR — the owner reviews once, on the promotion
// PR — except changes to the hub's own config, which wait for the owner.

import { matchesPrefix } from "../config.ts";
import type { Comment, PullRequest } from "../forge/types.ts";
import { branchesOf, repoOf, type Ctx, type DigestRow } from "./context.ts";
import {
  formatMergeFailed,
  developerBranch,
  HUB_CONFIG_PREFIX,
  MERGE_FAILED_PREFIX,
  MERGED_PREFIX,
  parseMergeFailedSha,
  PR_OPENED_PREFIX,
  SYNC_BRANCH_PREFIX,
} from "./notes.ts";
import {
  integrationHealth,
  isCurrentRecoveryTicket,
  type RecoveryLane,
} from "./stopTheLine.ts";

const PROCEEDABLE_STATES = new Set(["clean", "unstable"]);

export async function runMerge(
  ctx: Ctx,
  opts: { lineStopped: boolean; recovery?: RecoveryLane },
): Promise<DigestRow[]> {
  const repo = repoOf(ctx);
  const { integration, staging } = branchesOf(ctx);
  const rows: DigestRow[] = [];

  // The sync PR (staging → integration) is the bot's too, but it belongs to
  // the sync rule: it is never a draft and never carries a developer note.
  const candidates = (
    await ctx.forge.listOpenPulls(repo, { base: integration })
  )
    .filter((pr) => pr.author === ctx.botLogin && pr.headRef !== staging)
    .sort(byAge);

  if (opts.lineStopped && !opts.recovery) {
    if (candidates.length > 0) {
      ctx.log(
        `merge: ${integration} is red — ${candidates.length} PR(s) wait for the line`,
      );
      rows.push({
        rule: "merge",
        text: `line stopped — ${candidates.length} PR${candidates.length === 1 ? "" : "s"} waiting`,
      });
    }
    return rows;
  }

  for (const pr of candidates) {
    if (
      opts.recovery &&
      pr.headRef !== developerBranch(opts.recovery.identifier)
    )
      continue;
    if (opts.recovery) {
      const ticket = await ctx.linear.getTicket(opts.recovery.ticketId);
      if (
        !ticket ||
        !isCurrentRecoveryTicket(ticket, opts.recovery.sha, integration)
      )
        continue;
    }
    const row = await mergeOne(ctx, pr, opts.recovery);
    if (row) rows.push(row);
    // Let checks and the exact deployment catch up before admitting another change.
    if (row?.text.startsWith("🚢")) break;
  }
  return rows;
}

async function mergeOne(
  ctx: Ctx,
  pr: PullRequest,
  recovery?: RecoveryLane,
): Promise<DigestRow | null> {
  const repo = repoOf(ctx);
  const label = `merge #${pr.number}`;
  const skip = (reason: string): null => {
    ctx.log(`${label}: skip — ${reason}`);
    return null;
  };

  const comments = sortedComments(
    await ctx.forge.listPullComments(repo, pr.number),
  );
  const bodies = comments
    .filter((c) => c.author === ctx.botLogin)
    .map((c) => c.body);
  if (
    recovery &&
    !bodies.some(
      (body) =>
        body.startsWith(PR_OPENED_PREFIX) &&
        body.split(/\r?\n/).includes(`recovery-sha: ${recovery.sha}`) &&
        body.split(/\r?\n/).includes(`head-sha: ${pr.headSha}`),
    )
  )
    return skip(
      "recovery completion lacks authenticated current-head and failed-revision evidence",
    );

  const heldSha = bodies
    .map(parseMergeFailedSha)
    .find((sha) => sha !== null && pr.headSha.startsWith(sha));
  if (heldSha)
    return skip(`merge failed at ${heldSha} and the head is still that sha`);

  // A PR this dispatcher marked ready and then failed to merge is still its
  // own to merge: only a PR readied by someone else is hands-off.
  const readiedHere = bodies.some((b) => b.startsWith(MERGE_FAILED_PREFIX));
  if (pr.draft === false && !readiedHere)
    return skip("not a draft — someone marked it ready");
  if (!bodies.some((b) => b.startsWith(PR_OPENED_PREFIX))) {
    return skip(
      `no ${PR_OPENED_PREFIX} comment — the developer has not finished`,
    );
  }

  const checks = await ctx.forge.getChecks(repo, pr.headSha);
  if (checks.status === "pending") {
    ctx.log(`${label}: skip — checks are pending`);
    return waiting(pr, "its checks are still running");
  }
  if (checks.status !== "success") return skip(`checks are ${checks.status}`);
  if (pr.mergeableState === "unknown") {
    ctx.log(`${label}: skip — mergeable state is unknown`);
    return waiting(pr, "GitHub has not settled whether it merges");
  }
  if (!PROCEEDABLE_STATES.has(pr.mergeableState)) {
    return skip(`mergeable state is ${pr.mergeableState}`);
  }

  const asker = unansweredClaudeAuthor(comments, ctx.botLogin);
  if (asker) return skip(`unanswered @claude comment from ${asker}`);

  const files = await ctx.forge.listPullFiles(repo, pr.number);
  const hubFiles = files.filter((f) =>
    matchesPrefix(f, ctx.project.tiers.hubOwnerOnly),
  );
  if (hubFiles.length > 0) {
    if (bodies.some((b) => b.startsWith(HUB_CONFIG_PREFIX))) {
      return skip("hub config change — already handed to the owner");
    }
    const body = `${HUB_CONFIG_PREFIX} ${hubFiles.join(", ")}`;
    if (ctx.dryRun) {
      ctx.log(`[dry-run] ${label}: would comment: ${body}`);
      return null;
    }
    await ctx.forge.addPullComment(repo, pr.number, body);
    return {
      rule: "merge",
      text: `#${pr.number} ${pr.title} touches hub config (${hubFiles.join(", ")}) — merge it yourself`,
      needsYou: true,
      ref: String(pr.number),
    };
  }

  if (ctx.dryRun) {
    ctx.log(`[dry-run] ${label}: would mark ready and merge "${pr.title}"`);
    return null;
  }

  // Look again right before merging: an earlier merge in THIS pass may have
  // put this PR in conflict, and the list above was read before it. Leaving
  // it a draft keeps it in the repair rule's hands instead of failing here.
  const fresh = await ctx.forge.getPull(repo, pr.number);
  if (!fresh || fresh.state !== "open") return skip("no longer open");
  if (fresh.headSha !== pr.headSha)
    return skip("the head moved during this pass — next run");
  if (!PROCEEDABLE_STATES.has(fresh.mergeableState)) {
    return skip(
      `mergeable state became ${fresh.mergeableState} after an earlier merge`,
    );
  }

  const currentSha = await ctx.forge.getBranchSha(
    repo,
    branchesOf(ctx).integration,
  );
  if (recovery) {
    if (currentSha !== recovery.sha)
      return skip("recovery revision is stale — integration moved");
  } else {
    const health = await integrationHealth(ctx);
    if (health.state !== "healthy") return waiting(pr, health.reason);
  }
  const freshChecks = await ctx.forge.getChecks(repo, fresh.headSha);
  if (freshChecks.status !== "success")
    return waiting(pr, "checks changed before merge");

  if (fresh.draft) await ctx.forge.markReady(repo, pr.number);
  // A sync-resolution PR carries staging's own commits: it must land as a
  // merge commit, or staging would still read as "ahead" and sync forever.
  const method = pr.headRef.startsWith(SYNC_BRANCH_PREFIX)
    ? "merge"
    : ctx.project.config.mergeMethod;
  const result = await ctx.forge.mergePull(repo, pr.number, {
    method,
    sha: pr.headSha,
  });
  if (!result.merged) {
    const message = result.message ?? "the host refused without a message";
    ctx.log(`${label}: refused — ${message}`);
    await ctx.forge.addPullComment(
      repo,
      pr.number,
      formatMergeFailed(pr.headSha, message),
    );
    // A conflict is the repair rule's job (it re-dispatches the developer on
    // this branch); anything else the owner has to look at.
    const conflict = /conflict/i.test(message);
    return {
      rule: "merge",
      text: conflict
        ? `#${pr.number} ${pr.title} conflicts with the branch — sent for repair`
        : `#${pr.number} ${pr.title} would not merge: ${message}`,
      ...(conflict ? {} : { needsYou: true }),
      ref: String(pr.number),
    };
  }

  await ctx.forge.addPullComment(
    repo,
    pr.number,
    `${MERGED_PREFIX} at ${ctx.now().toISOString()} (${(result.sha ?? pr.headSha).slice(0, 12)})`,
  );
  await ctx.forge.deleteBranch(repo, pr.headRef);
  ctx.log(`${label}: merged "${pr.title}"`);
  return {
    rule: "merge",
    text: `🚢 #${pr.number} ${pr.title}`,
    ref: String(pr.number),
  };
}

/** Nothing is wrong and nobody is needed: the dispatcher is early. */
function waiting(pr: PullRequest, why: string): DigestRow {
  return {
    rule: "merge",
    text: `#${pr.number} waits — ${why}`,
    ref: String(pr.number),
    pending: true,
  };
}

function byAge(a: PullRequest, b: PullRequest): number {
  return a.createdAt.localeCompare(b.createdAt) || a.number - b.number;
}

function sortedComments(comments: Comment[]): Comment[] {
  return [...comments].sort(
    (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id - b.id,
  );
}

/** The author of a human `@claude` comment the bot has not replied to since; null when none. */
export function unansweredClaudeAuthor(
  comments: Comment[],
  botLogin: string,
): string | null {
  const sorted = sortedComments(comments);
  for (let i = 0; i < sorted.length; i++) {
    const c = sorted[i]!;
    if (c.author === botLogin || !c.body.includes("@claude")) continue;
    const answered = sorted
      .slice(i + 1)
      .some((later) => later.author === botLogin);
    if (!answered) return c.author;
  }
  return null;
}
