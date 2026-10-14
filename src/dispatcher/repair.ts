// Repair: an open developer PR that conflicts with the integration branch
// or has red checks is handed back to the developer on the same branch, a
// bounded number of times, then to the owner.

import type { FailedJob, PullRequest } from "../forge/types.ts";
import type { Ctx, DigestRow } from "./context.ts";
import { branchesOf, repoOf } from "./context.ts";
import { fireDeveloper, isLiveRun, lastIndexWhere } from "./dispatch.ts";
import {
  createDispatchReservation,
  reservationBody,
  reservationReceipt,
} from "./reservations.ts";
import { recoverFailedJobRerun } from "./rerunRecovery.ts";
import {
  CI_FIX_DISPATCHED_PREFIX,
  CI_NEEDS_OWNER_PREFIX,
  CONFLICT_NEEDS_OWNER_PREFIX,
  CONFLICT_DISPATCHED_PREFIX,
  LABELS,
  REPAIR_RESERVED_PREFIX,
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

async function repairStillApproved(
  ctx: Ctx,
  identifier: string,
): Promise<boolean> {
  const ticket = await ctx.linear.getTicket(identifier);
  return Boolean(
    ticket &&
    ctx.project.areas.some(
      (area) => area.linearProjectId === ticket.projectId,
    ) &&
    ticket.labels.includes(LABELS.approved) &&
    ![LABELS.needsHuman, LABELS.proposal, LABELS.verified].some((label) =>
      ticket.labels.includes(label),
    ) &&
    !["completed", "canceled"].includes(ticket.stateType),
  );
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
  } else {
    if (!already)
      await ctx.forge.addPullComment(repoOf(ctx), pr.number, comment);
    // The comment may have succeeded before a previous labeling request failed.
    // Replaying the idempotent label repairs that partial owner handoff.
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
  if (!(await repairStillApproved(ctx, identifier))) return null;
  const dispatches = comments
    .map(parseConflictDispatch)
    .filter((d): d is NonNullable<typeof d> => d !== null);
  const sameBase = (baseSha: string): boolean =>
    integrationSha.startsWith(baseSha);
  const latest = dispatches.at(-1);

  if (latest) {
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
  const args = {
    project: ctx.project.config.name,
    ticket: identifier,
    attempt,
    kind: "rc" as const,
    branch: pr.headRef,
    pr: pr.number,
  };
  const ticket = await ctx.linear.getTicket(identifier);
  if (!ticket) return null;
  const reservation = await createDispatchReservation(
    ctx,
    ticket,
    args,
    "conflict",
    { integrationSha, headSha: pr.headSha },
  );
  await ctx.forge.addPullComment(
    repo,
    pr.number,
    reservationBody(
      `${REPAIR_RESERVED_PREFIX} rc attempt ${attempt} (at ${short(pr.headSha)}, integration at ${short(integrationSha)})`,
      reservation,
    ),
  );
  const run = await fireDeveloper(ctx, {
    ...args,
    marker: reservation.id,
    scope: reservation.inputs.scope,
  });
  await ctx.forge.addPullComment(
    repo,
    pr.number,
    reservationReceipt(reservation, run),
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
  if (!(await repairStillApproved(ctx, identifier))) return null;
  const sha12 = short(pr.headSha);

  const fixes = comments.filter((b) => b.startsWith(CI_FIX_DISPATCHED_PREFIX));
  const recovery = await recoverFailedJobRerun(ctx, pr, comments);
  if (recovery.handled) return recovery.row ?? null;

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
  const args = {
    project: ctx.project.config.name,
    ticket: identifier,
    attempt,
    kind: "ci" as const,
    branch: pr.headRef,
    pr: pr.number,
  };
  const ticket = await ctx.linear.getTicket(identifier);
  if (!ticket) return null;
  const reservation = await createDispatchReservation(ctx, ticket, args, "ci", {
    headSha: pr.headSha,
  });
  await ctx.forge.addPullComment(
    repo,
    pr.number,
    reservationBody(
      `${REPAIR_RESERVED_PREFIX} ci attempt ${attempt} (at ${sha12})`,
      reservation,
    ),
  );
  const run = await fireDeveloper(ctx, {
    ...args,
    marker: reservation.id,
    scope: reservation.inputs.scope,
  });
  await ctx.forge.addPullComment(
    repo,
    pr.number,
    `${reservationReceipt(reservation, run)}\n\n${jobLines(checks.failedJobs)}`,
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
    const ticket = await ctx.linear.getTicket(identifier);
    if (
      !ticket ||
      !ctx.project.areas.some(
        (area) => area.linearProjectId === ticket.projectId,
      )
    ) {
      rows.push({
        rule: "repair",
        needsYou: true,
        ref: String(pr.number),
        text: `#${pr.number}: its ticket is missing or belongs to another project — review the mapping before repair`,
      });
      continue;
    }
    if (
      ["completed", "canceled"].includes(ticket.stateType) ||
      ticket.labels.includes(LABELS.proposal) ||
      ticket.labels.includes(LABELS.verified) ||
      !ticket.labels.includes(LABELS.approved)
    )
      continue;
    const comments = (await ctx.forge.listPullComments(repo, pr.number)).map(
      (c) => (c.author === ctx.botLogin ? c.body : ""),
    );
    const target: Target = { pr, identifier, comments };
    if (ticket.labels.includes(LABELS.needsHuman)) {
      rows.push({
        rule: "repair",
        needsYou: true,
        ref: String(pr.number),
        text: `#${pr.number} ${pr.title}: ticket ${identifier} needs owner review before more repair attempts`,
      });
      continue;
    }
    const reserved = lastIndexWhere(comments, (body) =>
      body.startsWith(REPAIR_RESERVED_PREFIX),
    );
    const recorded = lastIndexWhere(
      comments,
      (body) =>
        body.startsWith(CI_FIX_DISPATCHED_PREFIX) ||
        body.startsWith(CONFLICT_DISPATCHED_PREFIX),
    );
    if (reserved > recorded) {
      rows.push({
        rule: "repair",
        needsYou: true,
        ref: String(pr.number),
        text: `#${pr.number}: a repair was reserved without a run receipt — inspect existing provider work before retrying`,
      });
      continue;
    }
    // A PR can change from conflicting to red checks while its developer is
    // running. Check both repair lanes before starting either kind of work.
    let waiting = false;
    for (const prefix of [
      CONFLICT_DISPATCHED_PREFIX,
      CI_FIX_DISPATCHED_PREFIX,
    ]) {
      const receipt = comments.filter((body) => body.startsWith(prefix)).at(-1);
      if (!receipt) continue;
      const runId = runIdAfter(prefix, receipt);
      const run =
        runId === null
          ? null
          : await ctx.forge.getWorkflowRun(ctx.hub.hubRepo, runId);
      if (run === null) {
        rows.push({
          rule: "repair",
          needsYou: true,
          ref: String(pr.number),
          text: `#${pr.number}: an existing repair run cannot be confirmed — inspect provider work before retrying`,
        });
        waiting = true;
        break;
      }
      if (isLiveRun(run)) {
        const age = ctx.now().getTime() - Date.parse(run.createdAt);
        const deadline = (run.status === "queued" ? 1 : 2) * 60 * 60 * 1000;
        if (!Number.isFinite(age) || age > deadline)
          rows.push({
            rule: "repair",
            needsYou: true,
            ref: String(pr.number),
            text: `#${pr.number}: repair run ${runId} is ${run.status} beyond its ${deadline / 3_600_000}h deadline — inspect or cancel it before retrying`,
          });
        waiting = true;
        break;
      }
    }
    if (waiting) continue;
    const row =
      pr.mergeableState === "dirty"
        ? await repairConflict(ctx, target)
        : await repairChecks(ctx, target);
    if (row) rows.push(row);
  }
  return rows;
}
