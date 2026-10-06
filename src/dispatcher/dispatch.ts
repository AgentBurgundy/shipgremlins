// Dispatch: hand approved tickets to the developer, up to each area's WIP
// limit. Also home to the developer.yml trigger every rule shares.

import type { WorkflowRun } from "../forge/types.ts";
import type { LinearTicket } from "../services/types.ts";
import { branchesOf, repoOf, type Ctx, type DigestRow } from "./context.ts";
import { isCurrentRecoveryTicket, type RecoveryLane } from "./stopTheLine.ts";
import { DISPATCHED_PREFIX, LABELS, runIdAfter } from "./notes.ts";
import { codingPickupEnabled } from "../config.ts";

export type DeveloperKind = "build" | "rc" | "ci" | "sync" | "port";

export interface DeveloperArgs {
  project: string;
  ticket: string;
  attempt: number;
  kind: DeveloperKind;
  branch?: string;
  pr?: number;
}

const CLOSED_STATES = new Set(["completed", "canceled"]);
const LIVE_RUN = new Set<WorkflowRun["status"]>(["queued", "in_progress"]);

/** The exact workflow_dispatch inputs developer.yml declares (all strings). */
export function developerInputs(args: DeveloperArgs): Record<string, string> {
  const inputs: Record<string, string> = {
    project: args.project,
    ticket: args.ticket,
    attempt: String(args.attempt),
    kind: args.kind,
  };
  if (args.branch !== undefined) inputs.branch = args.branch;
  if (args.pr !== undefined) inputs.pr = String(args.pr);
  return inputs;
}

export async function fireDeveloper(
  ctx: Ctx,
  args: DeveloperArgs,
): Promise<WorkflowRun> {
  return ctx.forge.dispatchWorkflow(
    ctx.hub.hubRepo,
    "developer.yml",
    "main",
    developerInputs(args),
  );
}

export const isLiveRun = (run: WorkflowRun | null): boolean =>
  run !== null && LIVE_RUN.has(run.status);

/** index of the last element matching `test`, -1 when none (lib is ES2022) */
export function lastIndexWhere<T>(
  items: T[],
  test: (item: T) => boolean,
): number {
  for (let i = items.length - 1; i >= 0; i--) if (test(items[i]!)) return i;
  return -1;
}

const has = (t: LinearTicket, label: string): boolean =>
  t.labels.includes(label);

// A sync ticket is the dispatcher's own housekeeping, not an area's work in
// progress: it never takes a WIP slot from a real ticket.
const isInFlight = (t: LinearTicket): boolean =>
  !CLOSED_STATES.has(t.stateType) &&
  !has(t, LABELS.verified) &&
  !has(t, LABELS.needsHuman) &&
  !has(t, LABELS.ci) &&
  !has(t, LABELS.sync) &&
  !has(t, LABELS.port);

interface Candidate {
  ticket: LinearTicket;
  attempt: number;
  comments: string[];
}

async function candidatesFor(
  ctx: Ctx,
  projectId: string,
): Promise<Candidate[]> {
  const out: Candidate[] = [];
  const blocked = (t: LinearTicket): boolean =>
    has(t, LABELS.needsHuman) ||
    has(t, LABELS.proposal) ||
    has(t, LABELS.sync) ||
    has(t, LABELS.port);

  for (const t of await ctx.linear.listTickets(projectId, [LABELS.approved])) {
    if (has(t, LABELS.dispatched) || CLOSED_STATES.has(t.stateType)) continue;
    if (blocked(t)) continue;
    out.push({ ticket: t, attempt: 1, comments: [] });
  }
  for (const t of await ctx.linear.listTickets(projectId, [
    LABELS.testFailed,
  ])) {
    if (blocked(t)) continue;
    if (out.some((c) => c.ticket.id === t.id)) continue;
    const comments = (await ctx.linear.listComments(t.id)).map((c) => c.body);
    const dispatches = comments.filter((b) => b.startsWith(DISPATCHED_PREFIX));
    if (dispatches.length !== 1) continue;
    out.push({ ticket: t, attempt: 2, comments });
  }
  return out.sort((a, b) =>
    a.ticket.createdAt.localeCompare(b.ticket.createdAt),
  );
}

export async function runDispatch(
  ctx: Ctx,
  opts: { recovery?: RecoveryLane } = {},
): Promise<DigestRow[]> {
  const rows: DigestRow[] = [];
  const projectName = ctx.project.config.name;

  for (const area of ctx.project.areas) {
    if (!codingPickupEnabled(area) && !opts.recovery) {
      ctx.log(`dispatch ${area.key}: disabled — skipping`);
      continue;
    }
    const dispatched = await ctx.linear.listTickets(area.linearProjectId, [
      LABELS.dispatched,
    ]);
    const inFlight = dispatched.filter(isInFlight).length;
    // One explicit recovery job has its own slot: normal WIP must not deadlock repair.
    const room = opts.recovery ? 1 : Math.max(0, area.wipLimit - inFlight);
    let candidates = await candidatesFor(ctx, area.linearProjectId);
    if (opts.recovery) {
      const current = await ctx.forge.getBranchSha(
        repoOf(ctx),
        branchesOf(ctx).integration,
      );
      if (current !== opts.recovery.sha) return rows;
      candidates = candidates.filter(
        ({ ticket }) =>
          ticket.id === opts.recovery!.ticketId &&
          isCurrentRecoveryTicket(ticket, current, branchesOf(ctx).integration),
      );
    } else {
      // CI fixes belong only to their explicit failed-revision recovery lane.
      candidates = candidates.filter(({ ticket }) => !has(ticket, LABELS.ci));
    }
    if (room === 0 || candidates.length === 0) {
      ctx.log(
        `dispatch ${area.key}: nothing to dispatch (in flight ${inFlight}/${area.wipLimit}, ${candidates.length} waiting)`,
      );
      continue;
    }

    for (const { ticket, attempt, comments: known } of candidates.slice(
      0,
      room,
    )) {
      const comments =
        known.length > 0
          ? known
          : (await ctx.linear.listComments(ticket.id)).map((c) => c.body);
      const latestIdx = lastIndexWhere(comments, (b) =>
        b.startsWith(DISPATCHED_PREFIX),
      );
      const runId =
        latestIdx === -1
          ? null
          : runIdAfter(DISPATCHED_PREFIX, comments[latestIdx]!);
      if (attempt === 1 && runId !== null) {
        const run = await ctx.forge.getWorkflowRun(ctx.hub.hubRepo, runId);
        if (isLiveRun(run)) {
          if (ctx.dryRun) {
            ctx.log(
              `[dry-run] label ${ticket.identifier} ${LABELS.dispatched} (run ${runId} is live)`,
            );
          } else {
            await ctx.linear.addLabel(ticket.id, LABELS.dispatched);
            ctx.log(
              `dispatch ${area.key}: ${ticket.identifier} already running as run ${runId} — repaired the label`,
            );
          }
          continue;
        }
      }

      if (ctx.dryRun) {
        ctx.log(
          `[dry-run] fire developer for ${ticket.identifier} (attempt ${attempt}), label + comment`,
        );
        rows.push({
          rule: "dispatch",
          text: `${area.name}: would dispatch ${ticket.identifier} (attempt ${attempt})`,
          ref: ticket.identifier,
        });
        continue;
      }
      const run = await fireDeveloper(ctx, {
        project: projectName,
        ticket: ticket.identifier,
        attempt,
        // A line-recovery ticket starts a fresh branch/PR. The workflow's
        // kind=ci is reserved for repairing an already existing PR.
        kind: "build",
      });
      await ctx.linear.addLabel(ticket.id, LABELS.dispatched);
      await ctx.linear.addComment(
        ticket.id,
        `${DISPATCHED_PREFIX} ${run.id} — ${run.htmlUrl}`,
      );
      ctx.log(
        `dispatch ${area.key}: ${ticket.identifier} → run ${run.id} (attempt ${attempt})`,
      );
      rows.push({
        rule: "dispatch",
        text: `${area.name}: ${ticket.identifier} ${ticket.title} → run ${run.id}${attempt > 1 ? ` (retry ${attempt})` : ""}`,
        ref: ticket.identifier,
      });
    }
  }
  return rows;
}
