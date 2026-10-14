import { createHash, randomUUID } from "node:crypto";
import type { LinearTicket } from "../services/types.ts";
import type { Ctx } from "./context.ts";
import { branchesOf, repoOf } from "./context.ts";
import { developerInputs, type DeveloperArgs } from "./dispatch.ts";
import type { WorkflowRun } from "../forge/types.ts";
import {
  CI_FIX_DISPATCHED_PREFIX,
  DISPATCHED_PREFIX,
  RETRIGGERED_PREFIX,
  formatConflictDispatch,
} from "./notes.ts";

export const RESERVATION_DATA_PREFIX = "shipgremlins-reservation: ";
export const RECOVERY_BOUND_PREFIX = "shipgremlins-recovery-bound: ";

export interface DispatchReservation {
  schema: 1;
  id: string;
  project: string;
  projectInstanceId?: string;
  repository: string;
  hubRepository: string;
  ticketId: string;
  ticket: string;
  linearProjectId: string;
  kind: "build" | "rc" | "ci";
  attempt: number;
  createdAt: string;
  receipt: "dispatch" | "heal" | "conflict" | "ci";
  inputs: Record<string, string>;
  integrationBranch: string;
  integrationSha: string;
  pr?: number;
  headSha?: string;
}

export async function createDispatchReservation(
  ctx: Ctx,
  ticket: LinearTicket,
  args: DeveloperArgs,
  receipt: DispatchReservation["receipt"],
  scope: { integrationSha?: string; headSha?: string } = {},
): Promise<DispatchReservation> {
  if (!["build", "rc", "ci"].includes(args.kind) || !ticket.projectId)
    throw new Error(
      "This developer request cannot establish an exact recovery scope.",
    );
  const integrationSha =
    scope.integrationSha ??
    (await ctx.forge.getBranchSha(repoOf(ctx), branchesOf(ctx).integration));
  if (!integrationSha)
    throw new Error(
      "The integration revision is unavailable; no developer was dispatched.",
    );
  const id = randomUUID();
  const reservation: DispatchReservation = {
    schema: 1,
    id,
    project: ctx.project.config.name,
    ...(ctx.project.config.instanceId
      ? { projectInstanceId: ctx.project.config.instanceId }
      : {}),
    repository: repoOf(ctx),
    hubRepository: ctx.hub.hubRepo,
    ticketId: ticket.id,
    ticket: ticket.identifier,
    linearProjectId: ticket.projectId,
    kind: args.kind as DispatchReservation["kind"],
    attempt: args.attempt,
    createdAt: ctx.now().toISOString(),
    receipt,
    inputs: developerInputs({ ...args, marker: id }),
    integrationBranch: branchesOf(ctx).integration,
    integrationSha,
    ...(args.pr ? { pr: args.pr } : {}),
    ...(scope.headSha ? { headSha: scope.headSha } : {}),
  };
  reservation.inputs.scope = createHash("sha256")
    .update(JSON.stringify({ ...reservation, inputs: undefined }))
    .digest("hex");
  return reservation;
}

export function reservationBody(
  prefix: string,
  reservation: DispatchReservation,
): string {
  return `${prefix}\n${RESERVATION_DATA_PREFIX}${JSON.stringify(reservation)}`;
}

export function reservationReceipt(
  reservation: DispatchReservation,
  run: WorkflowRun,
): string {
  const body =
    reservation.receipt === "heal"
      ? `${RETRIGGERED_PREFIX} ${run.id}`
      : reservation.receipt === "conflict"
        ? formatConflictDispatch(
            run.id,
            reservation.headSha!,
            reservation.integrationSha,
          )
        : reservation.receipt === "ci"
          ? `${CI_FIX_DISPATCHED_PREFIX} ${run.id} (at ${reservation.headSha!.slice(0, 12)})`
          : `${DISPATCHED_PREFIX} ${run.id} — ${run.htmlUrl}`;
  return `${body}\n${RECOVERY_BOUND_PREFIX}${JSON.stringify({ reservationId: reservation.id, runId: run.id })}`;
}

export function reservationBinding(
  body: string,
): { reservationId: string; runId: number } | null {
  const line = body
    .split(/\r?\n/)
    .find((value) => value.startsWith(RECOVERY_BOUND_PREFIX));
  if (!line) return null;
  try {
    const value = JSON.parse(line.slice(RECOVERY_BOUND_PREFIX.length));
    return typeof value.reservationId === "string" &&
      Number.isSafeInteger(value.runId) &&
      value.runId > 0
      ? value
      : null;
  } catch {
    return null;
  }
}

export function parseDispatchReservation(
  body: string,
): DispatchReservation | null {
  const lines = body
    .split(/\r?\n/)
    .filter((line) => line.startsWith(RESERVATION_DATA_PREFIX));
  if (lines.length !== 1 || lines[0]!.length > 16_000) return null;
  try {
    const value = JSON.parse(lines[0]!.slice(RESERVATION_DATA_PREFIX.length));
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      value.schema !== 1 ||
      typeof value.id !== "string" ||
      !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value.id) ||
      !["build", "rc", "ci"].includes(value.kind) ||
      !["dispatch", "heal", "conflict", "ci"].includes(value.receipt) ||
      !Number.isSafeInteger(value.attempt) ||
      value.attempt < 1 ||
      value.attempt > 4 ||
      !Number.isFinite(Date.parse(value.createdAt)) ||
      [
        "project",
        "repository",
        "hubRepository",
        "ticketId",
        "ticket",
        "linearProjectId",
        "integrationBranch",
        "integrationSha",
      ].some((key) => typeof value[key] !== "string" || !value[key]) ||
      !value.inputs ||
      typeof value.inputs !== "object" ||
      Array.isArray(value.inputs) ||
      Object.values(value.inputs).some((item) => typeof item !== "string") ||
      value.inputs.marker !== value.id ||
      value.inputs.project !== value.project ||
      value.inputs.ticket !== value.ticket ||
      value.inputs.kind !== value.kind ||
      value.inputs.attempt !== String(value.attempt) ||
      (value.pr !== undefined &&
        (!Number.isSafeInteger(value.pr) ||
          value.pr < 1 ||
          value.inputs.pr !== String(value.pr))) ||
      (value.kind !== "build" &&
        (typeof value.headSha !== "string" ||
          !value.pr ||
          !value.inputs.branch))
    )
      return null;
    if (
      (["dispatch", "heal"].includes(value.receipt) &&
        (value.kind !== "build" ||
          value.pr ||
          value.inputs.branch ||
          value.inputs.pr)) ||
      (value.receipt === "conflict" && value.kind !== "rc") ||
      (value.receipt === "ci" && value.kind !== "ci")
    )
      return null;
    if (
      value.inputs.scope !==
      createHash("sha256")
        .update(JSON.stringify({ ...value, inputs: undefined }))
        .digest("hex")
    )
      return null;
    return value as DispatchReservation;
  } catch {
    return null;
  }
}
