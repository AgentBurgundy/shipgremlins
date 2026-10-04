// Heal: a developer run that was dispatched and ended without opening a PR
// is re-fired once, judged by its run id. Live runs are never duplicated;
// overdue work is surfaced so a provider outage cannot disappear indefinitely.

import type { Ctx, DigestRow } from "./context.ts";
import { branchesOf, repoOf } from "./context.ts";
import { isCurrentRecoveryTicket } from "./stopTheLine.ts";
import { fireDeveloper, isLiveRun, lastIndexWhere } from "./dispatch.ts";
import {
  developerBranch,
  DISPATCHED_PREFIX,
  HEAL_GAVE_UP_PREFIX,
  LABELS,
  PR_OPENED_PREFIX,
  RETRIGGERED_PREFIX,
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
      if (
        ["completed", "canceled"].includes(t.stateType) ||
        t.labels.includes(LABELS.verified) ||
        t.labels.includes(LABELS.needsHuman) ||
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
      if (latestIdx === -1) continue;
      const latest = comments[latestIdx]!;
      const runId = runIdAfter(
        latest.startsWith(DISPATCHED_PREFIX)
          ? DISPATCHED_PREFIX
          : RETRIGGERED_PREFIX,
        latest,
      );
      if (runId === null) continue;
      const run = await ctx.forge.getWorkflowRun(ctx.hub.hubRepo, runId);
      if (run === null) {
        ctx.log(`heal ${t.identifier}: run ${runId} not found — leaving alone`);
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

      const retriggered = comments.some((b) =>
        b.startsWith(RETRIGGERED_PREFIX),
      );
      if (!retriggered) {
        if (ctx.dryRun) {
          ctx.log(
            `[dry-run] re-fire developer for ${t.identifier} (run ${runId} ended with no PR)`,
          );
          continue;
        }
        const next = await fireDeveloper(ctx, {
          project: ctx.project.config.name,
          ticket: t.identifier,
          attempt: 2,
          kind: "build",
        });
        await ctx.linear.addComment(t.id, `${RETRIGGERED_PREFIX} ${next.id}`);
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
