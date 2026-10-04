// Repair: an open developer PR that conflicts with the integration branch
// or has red checks is handed back to the developer on the same branch, a
// bounded number of times, then to the owner.

import type { FailedJob, PullRequest } from "../forge/types.ts";
import type { Ctx, DigestRow } from "./context.ts";
import { branchesOf, repoOf } from "./context.ts";
import { fireDeveloper, isLiveRun } from "./dispatch.ts";
import {
  CI_FIX_DISPATCHED_PREFIX,
  CI_NEEDS_OWNER_PREFIX,
  CI_RETRIED_PREFIX,
  CONFLICT_NEEDS_OWNER_PREFIX,
  formatConflictDispatch,
  LABELS,
  parseConflictDispatch,
  runIdAfter,
} from "./notes.ts";

const CONFLICT_FAILED_MAX = 2;
const CONFLICT_DISPATCH_MAX = 4;
const CI_FIX_MAX = 2;
const BRANCH_RE = /^pm\/([^/]+)$/;

const short = (sha: string): string => sha.slice(0, 12);

/** "pm/game-12" → "GAME-12"; null for any other branch. */
export function ticketFromBranch(headRef: string): string | null {
  const m = headRef.match(BRANCH_RE);
  return m ? m[1]!.toUpperCase() : null;
}

interface Target {
  pr: PullRequest;
  identifier: string;
  comments: string[];
}

async function needsHuman(ctx: Ctx, identifier: string): Promise<void> {
  const ticket = await ctx.linear.getTicket(identifier);
  if (!ticket) {
    ctx.log(`repair: no Linear ticket ${identifier} to label`);
    return;
  }
  await ctx.linear.addLabel(ticket.id, LABELS.needsHuman);
}

async function giveUp(
  ctx: Ctx,
  { pr, identifier, comments }: Target,
  comment: string,
  text: string,
): Promise<DigestRow> {
  const already = comments.some((b) => b === comment);
  if (ctx.dryRun) {
    ctx.log(
      `[dry-run] PR #${pr.number}: comment "${comment}", label ${identifier} ${LABELS.needsHuman}`,
    );
  } else if (!already) {
    await ctx.forge.addPullComment(repoOf(ctx), pr.number, comment);
    await needsHuman(ctx, identifier);
  }
  ctx.log(`repair #${pr.number}: ${text}`);
  return {
    rule: "repair",
    text: `#${pr.number} ${pr.title}: ${text}`,
    needsYou: true,
    ref: String(pr.number),
  };
}

async function repairConflict(
  ctx: Ctx,
  target: Target,
): Promise<DigestRow | null> {
  const { pr, identifier, comments } = target;
  const repo = repoOf(ctx);
  const integrationSha = await ctx.forge.getBranchSha(
    repo,
    branchesOf(ctx).integration,
  );
  if (!integrationSha) {
    ctx.log(`repair #${pr.number}: integration branch has no sha — skipping`);
    return null;
  }
  const dispatches = comments
    .map(parseConflictDispatch)
    .filter((d): d is NonNullable<typeof d> => d !== null);
  const sameBase = (baseSha: string): boolean =>
    integrationSha.startsWith(baseSha);
  const latest = dispatches.at(-1);

  if (latest) {
    const run = await ctx.forge.getWorkflowRun(ctx.hub.hubRepo, latest.runId);
    if (isLiveRun(run)) {
      ctx.log(
        `repair #${pr.number}: conflict resolution run ${latest.runId} still going`,
      );
      return null;
    }
    if (sameBase(latest.baseSha)) {
      const failed = dispatches.filter((d) => sameBase(d.baseSha)).length;
      if (failed >= CONFLICT_FAILED_MAX) {
        return giveUp(
          ctx,
          target,
          `${CONFLICT_NEEDS_OWNER_PREFIX} two resolution attempts failed against ${short(integrationSha)}`,
          `two conflict resolutions failed against ${short(integrationSha)}`,
        );
      }
    }
  }
  if (dispatches.length >= CONFLICT_DISPATCH_MAX) {
    return giveUp(
      ctx,
      target,
      `${CONFLICT_NEEDS_OWNER_PREFIX} re-conflicted after ${CONFLICT_DISPATCH_MAX} resolutions`,
      `re-conflicted after ${CONFLICT_DISPATCH_MAX} resolutions`,
    );
  }
  const attempt = dispatches.length + 1;
  if (ctx.dryRun) {
    ctx.log(
      `[dry-run] PR #${pr.number}: fire conflict resolution attempt ${attempt} + comment`,
    );
    return null;
  }
  const run = await fireDeveloper(ctx, {
    project: ctx.project.config.name,
    ticket: identifier,
    attempt,
    kind: "rc",
    branch: pr.headRef,
    pr: pr.number,
  });
  await ctx.forge.addPullComment(
    repo,
    pr.number,
    formatConflictDispatch(run.id, pr.headSha, integrationSha),
  );
  ctx.log(
    `repair #${pr.number}: conflict resolution attempt ${attempt} → run ${run.id}`,
  );
  return {
    rule: "repair",
    text: `#${pr.number} ${pr.title}: conflict resolution attempt ${attempt} → run ${run.id}`,
    ref: String(pr.number),
  };
}

const jobLines = (jobs: FailedJob[]): string =>
  jobs.map((j) => `- ${j.name} — ${j.url}`).join("\n");

async function repairChecks(
  ctx: Ctx,
  target: Target,
): Promise<DigestRow | null> {
  const { pr, identifier, comments } = target;
  const repo = repoOf(ctx);
  const checks = await ctx.forge.getChecks(repo, pr.headSha);
  if (checks.status !== "failure") return null;
  const sha12 = short(pr.headSha);

  const fixes = comments.filter((b) => b.startsWith(CI_FIX_DISPATCHED_PREFIX));
  const latestFix = fixes.at(-1);
  const latestFixRun = latestFix
    ? runIdAfter(CI_FIX_DISPATCHED_PREFIX, latestFix)
    : null;
  if (latestFixRun !== null) {
    const run = await ctx.forge.getWorkflowRun(ctx.hub.hubRepo, latestFixRun);
    if (isLiveRun(run)) {
      ctx.log(`repair #${pr.number}: CI fix run ${latestFixRun} still going`);
      return null;
    }
  }

  const retried = `${CI_RETRIED_PREFIX} at ${sha12}`;
  if (!comments.some((b) => b.startsWith(retried))) {
    if (ctx.dryRun) {
      ctx.log(
        `[dry-run] PR #${pr.number}: re-run failed jobs at ${sha12} + comment`,
      );
      return null;
    }
    await ctx.forge.rerunFailedJobs(repo, pr.headSha);
    await ctx.forge.addPullComment(repo, pr.number, retried);
    ctx.log(`repair #${pr.number}: re-ran failed jobs at ${sha12}`);
    return {
      rule: "repair",
      text: `#${pr.number} ${pr.title}: checks red — re-ran the failed jobs`,
      ref: String(pr.number),
    };
  }

  if (fixes.length >= CI_FIX_MAX) {
    return giveUp(
      ctx,
      target,
      CI_NEEDS_OWNER_PREFIX,
      "CI still red after two fixes",
    );
  }
  const attempt = fixes.length + 1;
  if (ctx.dryRun) {
    ctx.log(
      `[dry-run] PR #${pr.number}: fire CI fix attempt ${attempt} + comment`,
    );
    return null;
  }
  const run = await fireDeveloper(ctx, {
    project: ctx.project.config.name,
    ticket: identifier,
    attempt,
    kind: "ci",
    branch: pr.headRef,
    pr: pr.number,
  });
  await ctx.forge.addPullComment(
    repo,
    pr.number,
    `${CI_FIX_DISPATCHED_PREFIX} ${run.id} (at ${sha12})\n\n${jobLines(checks.failedJobs)}`,
  );
  ctx.log(`repair #${pr.number}: CI fix attempt ${attempt} → run ${run.id}`);
  return {
    rule: "repair",
    text: `#${pr.number} ${pr.title}: CI fix attempt ${attempt} → run ${run.id}`,
    ref: String(pr.number),
  };
}

export async function runRepair(ctx: Ctx): Promise<DigestRow[]> {
  const rows: DigestRow[] = [];
  const repo = repoOf(ctx);
  const pulls = await ctx.forge.listOpenPulls(repo, {
    base: branchesOf(ctx).integration,
  });
  for (const pr of pulls) {
    if (pr.author !== ctx.botLogin) continue;
    const identifier = ticketFromBranch(pr.headRef);
    if (!identifier) continue;
    const comments = (await ctx.forge.listPullComments(repo, pr.number)).map(
      (c) => c.body,
    );
    const target: Target = { pr, identifier, comments };
    const row =
      pr.mergeableState === "dirty"
        ? await repairConflict(ctx, target)
        : await repairChecks(ctx, target);
    if (row) rows.push(row);
  }
  return rows;
}
