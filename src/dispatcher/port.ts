// Port: a verified change that no longer applies on staging as written is a
// developer's job, not a dead end. Staging moves under the integration branch
// (the owner redesigns a screen, a promotion lands), and a change built
// before that cannot be copied over by `git cherry-pick` alone. Promotion
// hands the stuck changes of one area, oldest first, to a developer who
// cherry-picks each onto the promotion branch and resolves the conflicts;
// the `(cherry picked from commit …)` trailers tell the next promotion run
// what was ported.

import type { AreaConfig } from "../config.ts";
import type { Ctx, DigestRow } from "./context.ts";
import { fireDeveloper, isLiveRun } from "./dispatch.ts";
import { LABELS, PORT_DISPATCHED_PREFIX, runIdAfter } from "./notes.ts";

export interface PortChange {
  sha: string;
  number: number;
  title: string;
}

const PORT_MAX = 2;

/** One ticket per (branch, exact list): a list that changed is a new job. */
export const portMarker = (branch: string, changes: PortChange[]): string =>
  `port: ${branch} ${changes.map((c) => c.sha.slice(0, 12)).join(",")}`;

export async function dispatchPort(
  ctx: Ctx,
  area: AreaConfig,
  branch: string,
  changes: PortChange[],
): Promise<DigestRow> {
  const { staging, integration } = ctx.project.config.branches;
  const count = `${changes.length} change${changes.length === 1 ? "" : "s"}`;
  const say = (m: string) => ctx.log(`promote (${area.name}): ${m}`);
  const marker = portMarker(branch, changes);

  const existing = (
    await ctx.linear.listTickets(area.linearProjectId, [LABELS.port])
  ).find((t) => t.description.includes(marker));
  const dispatches = existing
    ? (await ctx.linear.listComments(existing.id))
        .map((c) => c.body)
        .filter((b) => b.startsWith(PORT_DISPATCHED_PREFIX))
    : [];
  const last = dispatches[dispatches.length - 1];
  const lastRunId = last ? runIdAfter(PORT_DISPATCHED_PREFIX, last) : null;
  if (lastRunId !== null) {
    const run = await ctx.forge.getWorkflowRun(ctx.hub.hubRepo, lastRunId);
    if (run && isLiveRun(run)) {
      say(`port run ${lastRunId} is still working on ${count}`);
      return {
        rule: "promote",
        text: `${area.name}: a developer is porting ${count} onto ${staging} (${existing!.identifier})`,
        ref: existing!.identifier,
      };
    }
  }
  if (dispatches.length >= PORT_MAX) {
    return {
      rule: "promote",
      text: `${area.name}: ${count} still do not apply on ${staging} after ${PORT_MAX} porting runs (${existing!.identifier}) — port them by hand on ${branch}`,
      needsYou: true,
      ref: existing!.identifier,
    };
  }

  const attempt = dispatches.length + 1;
  if (ctx.dryRun) {
    ctx.log(
      `[dry-run] promote: would send a developer to port ${count} onto ${branch} (attempt ${attempt})`,
    );
    return {
      rule: "promote",
      text: `${area.name}: ${count} need porting (dry run)`,
    };
  }
  const ticket =
    existing ??
    (await ctx.linear.createTicket({
      projectId: area.linearProjectId,
      title: `Port ${count} onto ${staging} for the ${area.name} promotion`,
      description: portTicketBody(staging, integration, branch, changes),
      // dispatched from birth and never `approved`: the dispatch rule must
      // not also build it as an ordinary ticket
      labels: [LABELS.port, LABELS.dispatched, area.label],
    }));
  const run = await fireDeveloper(ctx, {
    project: ctx.project.config.name,
    ticket: ticket.identifier,
    attempt,
    kind: "port",
    branch,
  });
  await ctx.linear.addComment(
    ticket.id,
    `${PORT_DISPATCHED_PREFIX} ${run.id} — ${run.htmlUrl}`,
  );
  say(
    `developer sent to port ${count} (${ticket.identifier}, attempt ${attempt})`,
  );
  return {
    rule: "promote",
    text: `${area.name}: developer sent to port ${count} onto ${staging} (${ticket.identifier}, attempt ${attempt}) → run ${run.id}`,
    ref: ticket.identifier,
  };
}

function portTicketBody(
  staging: string,
  integration: string,
  branch: string,
  changes: PortChange[],
): string {
  const q = "`";
  return [
    `These changes are verified on ${q}${integration}${q} but do not apply on ${q}${staging}${q} as written: ${q}${staging}${q} changed underneath them.`,
    "",
    portMarker(branch, changes),
    `**Branch:** ${q}${branch}${q} (the promotion branch, based on ${q}${staging}${q})`,
    "",
    "## Changes to port, oldest first",
    "",
    ...changes.map((c) => `- ${q}${c.sha}${q} #${c.number} ${c.title}`),
    "",
    "## What to do",
    "",
    `1. On ${q}${branch}${q}, for each change above IN ORDER: ${q}git cherry-pick -x <sha>${q}. The ${q}-x${q} is not optional — its ${q}(cherry picked from commit …)${q} line is how promotion knows the change is on the branch.`,
    `2. Where it conflicts, resolve it so the change does on today's ${q}${staging}${q} what it did on ${q}${integration}${q}. ${q}origin/${integration}${q} already holds every one of these changes working together with ${q}${staging}${q}'s newer code — read its version of the file to see how the change reads now. Bring over ONLY this change's part of it, never the unverified work around it. Then ${q}git cherry-pick --continue${q}, keeping the message and the trailer.`,
    "3. A change that cannot stand without work that is not in this list and not on the branch: `git cherry-pick --abort`, leave it out, and say so in your ticket comment. Do not pull in changes that are not listed.",
    "4. After each change, run the typecheck. At the end run the tests and fix what the porting broke.",
    `5. Push ${q}${branch}${q}. Open NO pull request — promotion opens or updates it.`,
    "",
    "## Acceptance criteria",
    "",
    `- Every listed change is on ${q}${branch}${q} with its ${q}(cherry picked from commit <sha>)${q} trailer, or is named in the ticket comment with the reason it was left out`,
    "- Typecheck and tests pass on the branch",
    "- Nothing that is not in the list was added",
  ].join("\n");
}
