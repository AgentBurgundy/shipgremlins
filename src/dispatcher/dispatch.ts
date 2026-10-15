// Dispatch: hand approved tickets to the developer, up to each area's WIP
// limit. Also home to the developer.yml trigger every rule shares.

import type { WorkflowRun } from "../forge/types.ts";
import type { LinearTicket } from "../services/types.ts";
import { branchesOf, repoOf, type Ctx, type DigestRow } from "./context.ts";
import {
  integrationHealth,
  isCurrentRecoveryTicket,
  type RecoveryLane,
} from "./stopTheLine.ts";
import {
  DISPATCHED_PREFIX,
  LABELS,
  RETRIGGERED_PREFIX,
  RETRY_RESERVED_PREFIX,
  DISPATCH_RESERVED_PREFIX,
  runIdAfter,
} from "./notes.ts";
import { codingPickupEnabled } from "../config.ts";
import { resolve } from "node:path";
import { lstatSync } from "node:fs";
import { createAutomaticApprovals } from "../autonomy/approval.ts";
import { epicCodingBlocker, usesEpicApproval } from "../epics.ts";
import {
  createDispatchReservation,
  reservationBody,
  reservationReceipt,
} from "./reservations.ts";

export type DeveloperKind = "build" | "rc" | "ci" | "sync" | "port";

export interface DeveloperArgs {
  project: string;
  ticket: string;
  attempt: number;
  kind: DeveloperKind;
  branch?: string;
  pr?: number;
  marker?: string;
  scope?: string;
}

const CLOSED_STATES = new Set(["completed", "canceled"]);
const LIVE_RUN = new Set<WorkflowRun["status"]>(["queued", "in_progress"]);
const hasNamedCoders = (ctx: Ctx) =>
  Boolean(
    lstatSync(resolve(ctx.project.dir, "coders.json"), {
      throwIfNoEntry: false,
    }),
  );

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
  if (args.marker !== undefined) inputs.marker = args.marker;
  if (args.scope !== undefined) inputs.scope = args.scope;
  return inputs;
}

export async function fireDeveloper(
  ctx: Ctx,
  args: DeveloperArgs,
  recovery?: RecoveryLane,
): Promise<WorkflowRun> {
  if (ctx.project.config.automationPaused)
    throw new Error(
      "Project automation is paused. Resume it before dispatching coding work.",
    );
  if (hasNamedCoders(ctx))
    throw new Error(
      "Named coding agents require the local controller with local or remote Docker workers. The legacy CI workflow cannot execute their saved identities or model choices.",
    );
  const ticket = await ctx.linear.getTicket(args.ticket);
  if (!["sync", "port"].includes(args.kind)) {
    const epicBlocker = await developerEpicBlocker(
      ctx,
      ticket,
      args.kind === "build" ? recovery : undefined,
    );
    if (epicBlocker) throw new Error(epicBlocker);
  }
  const approvals = createAutomaticApprovals(resolve(ctx.project.dir, "../.."));
  if (ticket && approvals.isAutomatic(ctx.project, ticket)) {
    const areas = ctx.project.areas.filter(
      (area) =>
        area.linearProjectId === ticket.projectId &&
        ticket.labels.includes(area.label),
    );
    if (areas.length !== 1)
      throw new Error(
        "Automatic approval has no unique current PM mapping; no developer was dispatched.",
      );
    const reason = approvals.blocker(ctx.project, areas[0]!, ticket);
    if (reason) throw new Error(reason);
  }
  return ctx.forge.dispatchWorkflow(
    ctx.hub.hubRepo,
    "developer.yml",
    "main",
    developerInputs(args),
  );
}

/** The recovery lane is controller state, never inferred from worker-editable labels. */
export async function developerEpicBlocker(
  ctx: Ctx,
  ticket: LinearTicket | null,
  recovery?: RecoveryLane,
): Promise<string | null> {
  if (!usesEpicApproval(ctx.project)) return null;
  if (
    ticket &&
    recovery &&
    ticket.id === recovery.ticketId &&
    ticket.identifier === recovery.identifier &&
    ctx.project.areas.some(
      (area) => area.linearProjectId === ticket.projectId,
    ) &&
    isCurrentRecoveryTicket(ticket, recovery.sha, branchesOf(ctx).integration)
  ) {
    const health = await integrationHealth(ctx);
    if (health.state === "unhealthy" && health.sha === recovery.sha)
      return null;
  }
  const areas = ticket
    ? ctx.project.areas.filter(
        (area) =>
          area.linearProjectId === ticket.projectId &&
          ticket.labels.includes(area.label),
      )
    : [];
  if (!ticket || areas.length !== 1)
    return "Epic approval has no unique current ticket and owning PM mapping. Repair its Linear mapping before coding.";
  return epicCodingBlocker(
    resolve(ctx.project.dir, "../.."),
    ctx.project,
    areas[0]!,
    ticket,
    ctx.linear,
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
    if (blocked(t) || has(t, LABELS.verified) || has(t, LABELS.testFailed))
      continue;
    out.push({ ticket: t, attempt: 1, comments: [] });
  }
  for (const t of await ctx.linear.listTickets(projectId, [
    LABELS.testFailed,
  ])) {
    if (
      blocked(t) ||
      !has(t, LABELS.approved) ||
      has(t, LABELS.verified) ||
      t.stateType === "canceled"
    )
      continue;
    if (out.some((c) => c.ticket.id === t.id)) continue;
    const comments = (await ctx.linear.listComments(t.id)).map((c) => c.body);
    const dispatches = comments.filter((b) => b.startsWith(DISPATCHED_PREFIX));
    if (
      dispatches.length !== 1 ||
      comments.some((body) => body.startsWith(RETRIGGERED_PREFIX))
    )
      continue;
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
  if (ctx.project.config.automationPaused)
    return [{ rule: "dispatch", text: "Project automation is paused." }];
  if (hasNamedCoders(ctx))
    return [
      {
        rule: "dispatch",
        text: "Use the local controller and local or remote Docker workers for named coding agents. The legacy CI workflow cannot execute their saved identities or model choices.",
        needsYou: true,
      },
    ];

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
    let room = opts.recovery ? 1 : Math.max(0, area.wipLimit - inFlight);
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
    if (candidates.length === 0) {
      ctx.log(
        `dispatch ${area.key}: nothing to dispatch (in flight ${inFlight}/${area.wipLimit}, ${candidates.length} waiting)`,
      );
      continue;
    }

    for (const { ticket, attempt, comments: known } of candidates) {
      // Retrying a ticket already counted in WIP reuses that ticket's slot.
      const needsSlot =
        opts.recovery ||
        !dispatched.some((item) => item.id === ticket.id && isInFlight(item));
      if (needsSlot && room === 0) continue;
      if (needsSlot) room--;
      const comments =
        known.length > 0
          ? known
          : (await ctx.linear.listComments(ticket.id)).map((c) => c.body);
      const latestIdx = lastIndexWhere(
        comments,
        (b) =>
          b.startsWith(DISPATCHED_PREFIX) || b.startsWith(RETRIGGERED_PREFIX),
      );
      const latest = latestIdx === -1 ? undefined : comments[latestIdx]!;
      const runId = !latest
        ? null
        : runIdAfter(
            latest.startsWith(DISPATCHED_PREFIX)
              ? DISPATCHED_PREFIX
              : RETRIGGERED_PREFIX,
            latest,
          );
      if (latest && runId === null) {
        rows.push({
          rule: "dispatch",
          ref: ticket.identifier,
          needsYou: true,
          text: `${ticket.identifier}: the existing dispatch receipt has no valid run ID — inspect it before starting more work`,
        });
        continue;
      }
      if (
        comments
          .slice(latestIdx + 1)
          .some((body) => body.startsWith(RETRY_RESERVED_PREFIX))
      ) {
        rows.push({
          rule: "dispatch",
          ref: ticket.identifier,
          needsYou: true,
          text: `${ticket.identifier}: a retry was reserved without a run receipt — inspect existing provider work before retrying`,
        });
        continue;
      }
      if (runId !== null) {
        const run = await ctx.forge.getWorkflowRun(ctx.hub.hubRepo, runId);
        // A finished receipt without a label is also a partial dispatch. Restore
        // it for bounded healing instead of resetting the ticket to attempt 1.
        if (attempt === 1 || isLiveRun(run) || run === null) {
          if (ctx.dryRun) {
            ctx.log(
              `[dry-run] restore ${ticket.identifier} ${LABELS.dispatched} for recorded run ${runId}`,
            );
          } else {
            await ctx.linear.addLabel(ticket.id, LABELS.dispatched);
            ctx.log(
              `dispatch ${area.key}: ${ticket.identifier} already recorded as run ${runId} — repaired the label`,
            );
          }
          if (run === null)
            rows.push({
              rule: "dispatch",
              ref: ticket.identifier,
              needsYou: true,
              text: `${ticket.identifier}: recorded run ${runId} is unavailable — inspect it before retrying`,
            });
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
      const currentTicket = await ctx.linear.getTicket(ticket.id);
      if (
        !currentTicket ||
        currentTicket.identifier !== ticket.identifier ||
        currentTicket.projectId !== area.linearProjectId ||
        !has(currentTicket, LABELS.approved) ||
        [
          LABELS.needsHuman,
          LABELS.proposal,
          LABELS.verified,
          LABELS.sync,
          LABELS.port,
        ].some((label) => has(currentTicket, label)) ||
        currentTicket.stateType === "canceled" ||
        (attempt === 1 && currentTicket.stateType === "completed") ||
        (attempt > 1 && !has(currentTicket, LABELS.testFailed))
      )
        continue;
      if (
        opts.recovery &&
        (!isCurrentRecoveryTicket(
          currentTicket,
          opts.recovery.sha,
          branchesOf(ctx).integration,
        ) ||
          (await ctx.forge.getBranchSha(
            repoOf(ctx),
            branchesOf(ctx).integration,
          )) !== opts.recovery.sha)
      )
        continue;
      const epicBlocker = await developerEpicBlocker(
        ctx,
        currentTicket,
        opts.recovery,
      );
      if (epicBlocker) {
        if (needsSlot) room++;
        rows.push({
          rule: "dispatch",
          ref: ticket.identifier,
          needsYou: true,
          text: `${ticket.identifier}: ${epicBlocker}`,
        });
        continue;
      }
      // Claim the ticket before the provider request. A lost dispatch response
      // must leave a visible receipt gap, not another automatic launch.
      await ctx.linear.addLabel(ticket.id, LABELS.dispatched);
      const args: DeveloperArgs = {
        project: projectName,
        ticket: ticket.identifier,
        attempt,
        // A line-recovery ticket starts a fresh branch/PR. The workflow's
        // kind=ci is reserved for repairing an already existing PR.
        kind: "build",
      };
      const reservation = await createDispatchReservation(
        ctx,
        currentTicket,
        args,
        "dispatch",
      );
      await ctx.linear.addComment(
        ticket.id,
        reservationBody(
          attempt > 1 && runId !== null
            ? `${RETRY_RESERVED_PREFIX} ${runId}`
            : `${DISPATCH_RESERVED_PREFIX} ${reservation.id}`,
          reservation,
        ),
      );
      const run = await fireDeveloper(
        ctx,
        {
          ...args,
          marker: reservation.id,
          scope: reservation.inputs.scope,
        },
        opts.recovery,
      );
      await ctx.linear.addComment(
        ticket.id,
        reservationReceipt(reservation, run),
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
