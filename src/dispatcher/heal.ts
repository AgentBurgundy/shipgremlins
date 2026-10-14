// Heal: a developer run that was dispatched and ended without opening a PR
// is re-fired once, judged by its run id. Live runs are never duplicated;
// overdue work is surfaced so a provider outage cannot disappear indefinitely.

import type { Ctx, DigestRow } from "./context.ts";
import { branchesOf, repoOf } from "./context.ts";
import { isCurrentRecoveryTicket } from "./stopTheLine.ts";
import { fireDeveloper, isLiveRun, lastIndexWhere } from "./dispatch.ts";
import {
  createDispatchReservation,
  reservationBody,
  reservationReceipt,
} from "./reservations.ts";
import {
  developerBranch,
  DISPATCHED_PREFIX,
  HEAL_GAVE_UP_PREFIX,
  LABELS,
  PR_OPENED_PREFIX,
  RETRIGGERED_PREFIX,
  RETRY_RESERVED_PREFIX,
  runIdAfter,
} from "./notes.ts";

const isDispatchNote = (body: string): boolean =>
  body.startsWith(DISPATCHED_PREFIX) || body.startsWith(RETRIGGERED_PREFIX);

export async function runHeal(ctx: Ctx): Promise<DigestRow[]> {
  const rows: DigestRow[] = [];
  const repo = repoOf(ctx);

  for (const area of ctx.project.areas) {
    const tickets = await ctx.linear.listTickets(area.linearProjectId, [
      LABELS.dispatched,
    ]);
    for (const t of tickets) {
      if (t.labels.includes(LABELS.needsHuman)) {
        const comments = (await ctx.linear.listComments(t.id)).map(
          (c) => c.body,
        );
        if (comments.some((body) => body.startsWith(HEAL_GAVE_UP_PREFIX))) {
          // An earlier owner handoff may have labeled successfully and then
          // failed while releasing WIP. Finish that idempotent cleanup.
          if (ctx.dryRun)
            ctx.log(
              `[dry-run] release exhausted ${t.identifier} from dispatched WIP`,
            );
          else await ctx.linear.removeLabel(t.id, LABELS.dispatched);
          rows.push({
            rule: "heal",
            needsYou: true,
            ref: t.identifier,
            text: `${t.identifier} ${t.title}: two developer runs ended with no PR`,
          });
        }
        continue;
      }
      if (
        ["completed", "canceled"].includes(t.stateType) ||
        t.labels.includes(LABELS.verified) ||
        t.labels.includes(LABELS.proposal) ||
        // the sync rule re-dispatches its own tickets (a different kind)
        t.labels.includes(LABELS.sync) ||
        // promotion re-dispatches its own port tickets
        t.labels.includes(LABELS.port)
      )
        continue;
      if (t.labels.includes(LABELS.ci)) {
        const integration = branchesOf(ctx).integration;
        const current = await ctx.forge.getBranchSha(repo, integration);
        if (!current || !isCurrentRecoveryTicket(t, current, integration))
          continue;
      }
      const comments = (await ctx.linear.listComments(t.id)).map((c) => c.body);
      const latestIdx = lastIndexWhere(comments, isDispatchNote);
      if (latestIdx === -1) {
        rows.push({
          rule: "heal",
          needsYou: true,
          ref: t.identifier,
          text: `${t.identifier}: dispatched work has no run receipt — inspect provider work before retrying`,
        });
        continue;
      }
      const latest = comments[latestIdx]!;
      const runId = runIdAfter(
        latest.startsWith(DISPATCHED_PREFIX)
          ? DISPATCHED_PREFIX
          : RETRIGGERED_PREFIX,
        latest,
      );
      if (runId === null) {
        rows.push({
          rule: "heal",
          needsYou: true,
          ref: t.identifier,
          text: `${t.identifier}: dispatch receipt has an invalid run ID — inspect it before retrying`,
        });
        continue;
      }
      if (
        comments
          .slice(latestIdx + 1)
          .some((body) => body.startsWith(RETRY_RESERVED_PREFIX))
      ) {
        rows.push({
          rule: "heal",
          needsYou: true,
          ref: t.identifier,
          text: `${t.identifier}: a retry was reserved without a run receipt — inspect existing provider work before retrying`,
        });
        continue;
      }
      const run = await ctx.forge.getWorkflowRun(ctx.hub.hubRepo, runId);
      if (run === null) {
        ctx.log(`heal ${t.identifier}: run ${runId} not found — leaving alone`);
        rows.push({
          rule: "heal",
          needsYou: true,
          ref: t.identifier,
          text: `${t.identifier}: recorded run ${runId} is unavailable — inspect it before retrying`,
        });
        continue;
      }
      if (isLiveRun(run)) {
        const age = ctx.now().getTime() - Date.parse(run.createdAt);
        const deadline = (run.status === "queued" ? 1 : 2) * 60 * 60 * 1000;
        if (!Number.isFinite(age) || age > deadline)
          rows.push({
            rule: "heal",
            needsYou: true,
            ref: t.identifier,
            text: `${t.identifier}: run ${runId} is ${run.status} beyond its ${deadline / 3_600_000}h deadline — inspect or cancel the provider run before retrying`,
          });
        continue;
      }
      if (
        comments
          .slice(latestIdx + 1)
          .some((b) => b.startsWith(PR_OPENED_PREFIX))
      )
        continue;
      const open = await ctx.forge.listOpenPulls(repo, {
        head: developerBranch(t.identifier),
      });
      if (open.some((p) => p.author === ctx.botLogin)) continue;

      // A run receipt is evidence of execution, not continuing authorization.
      const currentTicket = await ctx.linear.getTicket(t.id);
      if (
        !currentTicket ||
        currentTicket.identifier !== t.identifier ||
        currentTicket.projectId !== area.linearProjectId ||
        !currentTicket.labels.includes(LABELS.approved) ||
        [
          LABELS.needsHuman,
          LABELS.proposal,
          LABELS.verified,
          LABELS.sync,
          LABELS.port,
        ].some((label) => currentTicket.labels.includes(label)) ||
        ["completed", "canceled"].includes(currentTicket.stateType)
      )
        continue;
      if (currentTicket.labels.includes(LABELS.ci)) {
        const integration = branchesOf(ctx).integration;
        const current = await ctx.forge.getBranchSha(repo, integration);
        if (
          !current ||
          !isCurrentRecoveryTicket(currentTicket, current, integration)
        )
          continue;
      }

      const retriggered =
        comments.some((b) => b.startsWith(RETRIGGERED_PREFIX)) ||
        comments.filter((b) => b.startsWith(DISPATCHED_PREFIX)).length >= 2;
      if (!retriggered) {
        if (ctx.dryRun) {
          ctx.log(
            `[dry-run] re-fire developer for ${t.identifier} (run ${runId} ended with no PR)`,
          );
          continue;
        }
        // Record the retry before sending it. If the request succeeds but its
        // response or receipt is lost, the next pass must reconcile, not repeat.
        const args = {
          project: ctx.project.config.name,
          ticket: t.identifier,
          attempt: 2,
          kind: "build" as const,
        };
        const reservation = await createDispatchReservation(
          ctx,
          currentTicket,
          args,
          "heal",
        );
        await ctx.linear.addComment(
          t.id,
          reservationBody(`${RETRY_RESERVED_PREFIX} ${runId}`, reservation),
        );
        const next = await fireDeveloper(ctx, {
          ...args,
          marker: reservation.id,
          scope: reservation.inputs.scope,
        });
        await ctx.linear.addComment(
          t.id,
          reservationReceipt(reservation, next),
        );
        ctx.log(
          `heal ${t.identifier}: run ${runId} ended with no PR — re-fired as run ${next.id}`,
        );
        rows.push({
          rule: "heal",
          text: `${t.identifier} ${t.title}: run ${runId} ended with no PR — re-fired as run ${next.id}`,
          ref: t.identifier,
        });
        continue;
      }
      if (ctx.dryRun) {
        ctx.log(
          `[dry-run] give up on ${t.identifier}: comment, label ${LABELS.needsHuman}, unlabel ${LABELS.dispatched}`,
        );
        continue;
      }
      if (!comments.includes(`${HEAL_GAVE_UP_PREFIX} with no PR`))
        await ctx.linear.addComment(t.id, `${HEAL_GAVE_UP_PREFIX} with no PR`);
      await ctx.linear.addLabel(t.id, LABELS.needsHuman);
      await ctx.linear.removeLabel(t.id, LABELS.dispatched);
      ctx.log(
        `heal ${t.identifier}: two runs ended with no PR — needs a human`,
      );
      rows.push({
        rule: "heal",
        text: `${t.identifier} ${t.title}: two developer runs ended with no PR`,
        needsYou: true,
        ref: t.identifier,
      });
    }
  }
  return rows;
}
