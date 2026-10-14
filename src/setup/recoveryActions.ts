import type { Ctx } from "../dispatcher/context.ts";
import { branchesOf, repoOf } from "../dispatcher/context.ts";
import {
  LABELS,
  DISPATCHED_PREFIX,
  RETRIGGERED_PREFIX,
  CI_FIX_DISPATCHED_PREFIX,
  CONFLICT_DISPATCHED_PREFIX,
} from "../dispatcher/notes.ts";
import { ticketFromBranch } from "../dispatcher/repair.ts";
import {
  parseDispatchReservation,
  reservationBinding,
  reservationReceipt,
  type DispatchReservation,
} from "../dispatcher/reservations.ts";

export class RecoveryActionError extends Error {
  constructor(
    message: string,
    public readonly status = 409,
  ) {
    super(message);
    this.name = "RecoveryActionError";
  }
}
export interface RecoveryReservationView {
  id: string;
  project: string;
  ticket: string;
  pr?: number;
  kind: DispatchReservation["kind"];
  attempt: number;
  repository: string;
  createdAt: string;
  reason: "dispatch-response-unconfirmed";
  supported: boolean;
  remedy: string;
}
export interface RecoveryBindingInput {
  reservationId: string;
  runId: number;
}
export interface RecoveryBindingResult {
  status: "reconciled" | "already-reconciled";
  reservationId: string;
  ticket: string;
  pr?: number;
  runId: number;
  runUrl: string;
}
interface Located {
  reservation: DispatchReservation;
  comments: string[];
  ticketId: string;
  pr?: number;
}

async function reservations(ctx: Ctx): Promise<Located[]> {
  const out: Located[] = [],
    seen = new Set<string>();
  for (const area of ctx.project.areas) {
    for (const ticket of await ctx.linear.listTickets(area.linearProjectId, [
      LABELS.dispatched,
    ])) {
      if (seen.has(ticket.id)) continue;
      seen.add(ticket.id);
      const comments = (await ctx.linear.listComments(ticket.id)).map(
        (comment) => comment.body,
      );
      for (const body of comments) {
        const reservation = parseDispatchReservation(body);
        if (
          reservation &&
          !reservation.pr &&
          reservation.ticketId === ticket.id
        )
          out.push({ reservation, comments, ticketId: ticket.id });
      }
    }
  }
  for (const pull of await ctx.forge.listOpenPulls(repoOf(ctx), {
    base: branchesOf(ctx).integration,
  })) {
    if (pull.author !== ctx.botLogin) continue;
    const identifier = ticketFromBranch(pull.headRef);
    if (!identifier) continue;
    const ticket = await ctx.linear.getTicket(identifier);
    if (!ticket) continue;
    const comments = (
      await ctx.forge.listPullComments(repoOf(ctx), pull.number)
    )
      .filter((comment) => comment.author === ctx.botLogin)
      .map((comment) => comment.body);
    for (const body of comments) {
      const reservation = parseDispatchReservation(body);
      if (
        reservation &&
        reservation.pr === pull.number &&
        reservation.ticketId === ticket.id
      )
        out.push({
          reservation,
          comments,
          ticketId: ticket.id,
          pr: pull.number,
        });
    }
  }
  return out.filter(
    ({ reservation }) =>
      reservation.project === ctx.project.config.name &&
      reservation.repository === repoOf(ctx) &&
      reservation.hubRepository === ctx.hub.hubRepo,
  );
}

function bound(located: Located) {
  return located.comments
    .map(reservationBinding)
    .find((binding) => binding?.reservationId === located.reservation.id);
}
function currentScope(ctx: Ctx, scope: DispatchReservation): boolean {
  return (
    (scope.projectInstanceId ?? null) ===
      (ctx.project.config.instanceId ?? null) &&
    scope.integrationBranch === branchesOf(ctx).integration &&
    ctx.project.areas.some(
      (area) => area.linearProjectId === scope.linearProjectId,
    )
  );
}
export async function listRecoveryReservations(
  ctx: Ctx,
  options: { includeBound?: boolean } = {},
): Promise<RecoveryReservationView[]> {
  return (await reservations(ctx))
    .filter((item) => options.includeBound || !bound(item))
    .map(({ reservation }) => ({
      id: reservation.id,
      project: reservation.project,
      ticket: reservation.ticket,
      ...(reservation.pr ? { pr: reservation.pr } : {}),
      kind: reservation.kind,
      attempt: reservation.attempt,
      repository: reservation.repository,
      createdAt: reservation.createdAt,
      reason: "dispatch-response-unconfirmed",
      supported:
        Boolean(ctx.forge.getWorkflowRunEvidence) &&
        currentScope(ctx, reservation),
      remedy:
        "Enter the existing provider run ID. ShipGremlins will verify its exact workflow inputs and repair this receipt without starting work.",
    }));
}

function normalizedInputs(inputs: Record<string, string>): string {
  return JSON.stringify(
    Object.fromEntries(
      Object.entries(inputs)
        .filter(
          ([key, value]) => value !== "" || !["branch", "pr"].includes(key),
        )
        .sort(([a], [b]) => a.localeCompare(b)),
    ),
  );
}
async function bindRecoveryRunOnce(
  ctx: Ctx,
  input: RecoveryBindingInput,
): Promise<RecoveryBindingResult> {
  if (
    !input ||
    Object.keys(input).some(
      (key) => !["reservationId", "runId"].includes(key),
    ) ||
    !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(
      input.reservationId,
    ) ||
    !Number.isSafeInteger(input.runId) ||
    input.runId < 1
  )
    throw new RecoveryActionError(
      "Choose a valid recovery reservation and provider run ID.",
      400,
    );
  if (ctx.dryRun)
    throw new RecoveryActionError(
      "Receipt recovery requires a writable controller session.",
    );
  const matches = (await reservations(ctx)).filter(
    (item) => item.reservation.id === input.reservationId,
  );
  if (matches.length !== 1)
    throw new RecoveryActionError(
      "This reservation is unavailable or ambiguous. Refresh its project before continuing.",
    );
  const located = matches[0]!,
    scope = located.reservation;
  if (!currentScope(ctx, scope))
    throw new RecoveryActionError(
      "Project identity or repository mapping changed. Review existing provider work before reconciling this reservation.",
    );
  if (!ctx.forge.getWorkflowRunEvidence)
    throw new RecoveryActionError(
      "This provider cannot prove workflow inputs for receipt recovery.",
    );
  const evidence = await ctx.forge.getWorkflowRunEvidence(
    ctx.hub.hubRepo,
    input.runId,
  );
  if (
    !evidence ||
    evidence.run.id !== input.runId ||
    evidence.repository !== scope.hubRepository ||
    evidence.workflowFile !== "developer.yml" ||
    evidence.ref !== "main" ||
    evidence.event !== "workflow_dispatch" ||
    evidence.projectRepository !== scope.repository ||
    (evidence.projectInstanceId ?? null) !==
      (scope.projectInstanceId ?? null) ||
    evidence.projectIntegrationBranch !== scope.integrationBranch ||
    normalizedInputs(evidence.inputs) !== normalizedInputs(scope.inputs) ||
    !Number.isFinite(Date.parse(evidence.run.createdAt)) ||
    Date.parse(evidence.run.createdAt) > ctx.now().getTime() + 10_000 ||
    Date.parse(evidence.run.createdAt) < Date.parse(scope.createdAt) - 10_000
  )
    throw new RecoveryActionError(
      "Provider evidence does not match this project's exact ticket, kind, attempt, repository, and recovery scope. No receipt was changed.",
    );
  const ticket = await ctx.linear.getTicket(scope.ticketId);
  if (
    !ticket ||
    ticket.identifier !== scope.ticket ||
    ticket.projectId !== scope.linearProjectId ||
    !ticket.labels.includes(LABELS.approved) ||
    [LABELS.needsHuman, LABELS.proposal, LABELS.verified].some((label) =>
      ticket.labels.includes(label),
    ) ||
    ticket.stateType === "canceled" ||
    (ticket.stateType === "completed" &&
      !ticket.labels.includes(LABELS.testFailed))
  )
    throw new RecoveryActionError(
      "The ticket is no longer approved in this project. Review its current state before repairing its receipt.",
    );
  const already = bound(located);
  if (already && already.runId !== input.runId)
    throw new RecoveryActionError(
      "This reservation is already linked to a different provider run.",
    );
  if (!already) {
    if (scope.pr) {
      const pull = await ctx.forge.getPull(scope.repository, scope.pr);
      if (
        !pull ||
        pull.state !== "open" ||
        pull.author !== ctx.botLogin ||
        pull.headRef !== scope.inputs.branch ||
        pull.baseRef !== scope.integrationBranch ||
        pull.headSha !== scope.headSha
      )
        throw new RecoveryActionError(
          "The pull request scope or exact head changed. Inspect its existing work before reconciling this receipt.",
        );
    }
    if (
      (await ctx.forge.getBranchSha(
        scope.repository,
        scope.integrationBranch,
      )) !== scope.integrationSha
    )
      throw new RecoveryActionError(
        "The integration revision changed. Inspect the existing provider run before reconciling this receipt.",
      );
    const comments = scope.pr
      ? (await ctx.forge.listPullComments(scope.repository, scope.pr))
          .filter((comment) => comment.author === ctx.botLogin)
          .map((comment) => comment.body)
      : (await ctx.linear.listComments(scope.ticketId)).map(
          (comment) => comment.body,
        );
    const currentBinding = comments
      .map(reservationBinding)
      .find((binding) => binding?.reservationId === scope.id);
    if (currentBinding && currentBinding.runId !== input.runId)
      throw new RecoveryActionError(
        "This reservation was linked to another run while it was being reviewed.",
      );
    if (!currentBinding) {
      const index = comments.findIndex(
        (body) => parseDispatchReservation(body)?.id === scope.id,
      );
      if (
        index < 0 ||
        comments
          .slice(index + 1)
          .some(
            (body) =>
              parseDispatchReservation(body) ||
              [
                DISPATCHED_PREFIX,
                RETRIGGERED_PREFIX,
                CI_FIX_DISPATCHED_PREFIX,
                CONFLICT_DISPATCHED_PREFIX,
              ].some((prefix) => body.startsWith(prefix)),
          )
      )
        throw new RecoveryActionError(
          "Newer execution evidence exists for this ticket. Review its current provider work before repairing an older receipt.",
        );
      const body = reservationReceipt(scope, evidence.run);
      if (scope.pr)
        await ctx.forge.addPullComment(scope.repository, scope.pr, body);
      else await ctx.linear.addComment(scope.ticketId, body);
    }
  }
  if (!scope.pr) await ctx.linear.addLabel(scope.ticketId, LABELS.dispatched);
  return {
    status: already ? "already-reconciled" : "reconciled",
    reservationId: scope.id,
    ticket: scope.ticket,
    ...(scope.pr ? { pr: scope.pr } : {}),
    runId: evidence.run.id,
    runUrl: evidence.run.htmlUrl,
  };
}

const bindingQueues = new Map<string, Promise<RecoveryBindingResult>>();
/** Serialize receipt repair within the controller so duplicate operator requests share durable evidence. */
export async function bindRecoveryRun(
  ctx: Ctx,
  input: RecoveryBindingInput,
): Promise<RecoveryBindingResult> {
  const key = `${ctx.project.dir}/${input?.reservationId ?? "invalid"}`;
  const previous = bindingQueues.get(key);
  const pending = (
    previous ? previous.catch(() => undefined) : Promise.resolve()
  ).then(() => bindRecoveryRunOnce(ctx, input));
  bindingQueues.set(key, pending);
  try {
    return await pending;
  } finally {
    if (bindingQueues.get(key) === pending) bindingQueues.delete(key);
  }
}
