import type { Ctx } from "../dispatcher/context.ts";
import { usesEpicApproval } from "../epics.ts";
import {
  auditProduction,
  reconcileProduction,
  type ProductionAudit,
} from "../lifecycle/production.ts";
import type { CompletionManifest } from "../lifecycle/manifest.ts";
import type { createDeliveryService } from "./index.ts";
import type { DeliveryRecord } from "./types.ts";
import type { LinearTicket, LinearWorkflowState } from "../services/types.ts";
import { productionAuditReads } from "./productionReads.ts";

const TICKETS_PER_PASS = 100;
const RELEASES_PER_PASS = 30;

/** Managed child scope is finite in the controller ledger. No third owner declaration is needed. */
export async function reconcileManagedCompletion(
  ctx: Ctx,
  ledger: Pick<
    ReturnType<typeof createDeliveryService>,
    "list" | "completionManifest" | "completionEligible"
  >,
) {
  if (!usesEpicApproval(ctx.project)) return [];
  const { repo, branches } = ctx.project.config;
  const reads = productionAuditReads(ctx);
  const grouped = new Map<string, DeliveryRecord[]>();
  for (const record of ledger.list().filter((record) => !record.supersededBy))
    grouped.set(record.ticket.id, [
      ...(grouped.get(record.ticket.id) ?? []),
      record,
    ]);
  const candidates = [...grouped.values()]
    .filter((group) =>
      group.every((record) => record.status === "promoted" && record.promotion),
    )
    .sort((a, b) => a[0]!.ticket.id.localeCompare(b[0]!.ticket.id));
  if (!candidates.length) return [];
  // A clock-derived page survives restart. Blocked early tickets cannot monopolize
  // every pass; release pages advance more slowly so each ticket page sees each release page.
  const slot = Math.floor(ctx.now().getTime() / 60_000);
  const pages = Math.ceil(candidates.length / TICKETS_PER_PASS);
  const offset = (slot % pages) * TICKETS_PER_PASS;
  const selected = candidates.slice(offset, offset + TICKETS_PER_PASS);
  const reports: Array<{ id: string; report: ProductionAudit }> = [];
  let diagnosticHead: Promise<string | null> | undefined;
  async function blocked(
    group: DeliveryRecord[],
    reason: string,
    states: LinearWorkflowState[] = [],
  ) {
    const record = group[0]!;
    const ticket = await ctx.linear
      .getTicket(record.ticket.id)
      .catch(() => null);
    diagnosticHead ??= ctx.forge
      .getBranchSha(repo, branches.production)
      .catch(() => null);
    reports.push({
      id: `managed:${record.ticket.id}:waiting`,
      report: {
        repo,
        productionBranch: branches.production,
        productionHead: await diagnosticHead,
        checkedAt: ctx.now().toISOString(),
        dryRun: true,
        tickets: [
          {
            ticketId: record.ticket.id,
            identifier: record.ticket.identifier,
            projectId: record.ticket.projectId,
            teamId: record.ticket.teamId,
            currentState: ticket?.stateType ?? "unknown",
            scopeHash: record.scopeHash,
            classification: "ambiguous",
            reason,
            availableCompletedStates: states,
            evidence: [],
          },
        ],
      },
    });
  }
  const eligible: DeliveryRecord[][] = [];
  for (const group of selected) {
    try {
      if (await ledger.completionEligible(group.map((record) => record.id)))
        eligible.push(group);
    } catch {
      await blocked(
        group,
        "Automatic completion is waiting for current ticket and epic authorization. The controller will retry; no ticket state was changed.",
      );
    }
  }
  if (!eligible.length) return reports;
  if (!reads.linear.listWorkflowStates) {
    for (const group of eligible)
      await blocked(
        group,
        "Automatic completion is waiting for the Linear connection to read this team's workflow states. No ticket state was changed.",
      );
    return reports;
  }
  const mapped = new Map<string, LinearTicket>();
  for (const area of ctx.project.areas)
    for (const ticket of await reads.linear.listTickets(area.linearProjectId, [
      area.label,
    ]))
      mapped.set(ticket.id, ticket);
  const ready: Array<{ group: DeliveryRecord[]; done: string }> = [];
  for (const group of eligible) {
    const team = group[0]!.ticket.teamId;
    if (!team || group.some((record) => record.ticket.teamId !== team)) {
      await blocked(
        group,
        "Automatic completion is waiting for one consistent Linear team mapping for this ticket's recorded deliveries.",
      );
      continue;
    }
    if (!mapped.has(group[0]!.ticket.id)) {
      await blocked(
        group,
        "The ticket is no longer in its mapped PM project and area. Completion will retry when its ownership mapping is restored.",
      );
      continue;
    }
    try {
      const states = (await reads.linear.listWorkflowStates(team)).filter(
        (state) => state.teamId === team && state.type === "completed",
      );
      const namedDone = states.filter(
        (state) => state.name.trim().toLowerCase() === "done",
      );
      const done =
        states.length === 1
          ? states[0]
          : namedDone.length === 1
            ? namedDone[0]
            : undefined;
      if (!done) {
        await blocked(
          group,
          states.length
            ? "Automatic completion cannot choose among this Linear team's completed states. Keep one completed state named Done (or a single completed state); the controller will retry automatically. No ticket state was changed."
            : "This Linear team has no completed workflow state. Add a completed state in Linear; the controller will retry automatically. No ticket state was changed.",
          states,
        );
        continue;
      }
      let promotionsMerged = true;
      for (const record of group) {
        const pull = await reads.forge.getPull(repo, record.promotion!.number);
        if (
          !pull ||
          pull.state !== "merged" ||
          pull.baseRef !== branches.staging ||
          pull.headRef !== record.promotion!.branch ||
          pull.headSha !== record.promotion!.headSha ||
          !pull.mergeCommitSha ||
          !pull.mergedAt
        ) {
          promotionsMerged = false;
          break;
        }
      }
      if (!promotionsMerged) {
        await blocked(
          group,
          "Waiting for the recorded promotion batch to be merged unchanged into staging. Individual implementation PRs need no human review.",
        );
        continue;
      }
      ready.push({ group, done: done.id });
    } catch {
      await blocked(
        group,
        "Automatic completion is waiting for its Linear workflow or recorded promotion metadata. The controller will retry; no ticket state was changed.",
      );
    }
  }
  if (!ready.length) return reports;
  const since = ready
    .flatMap((item) => item.group)
    .map((record) => record.approvedAt)
    .sort()[0]!;
  const allReleases = (
    await ctx.forge.listMergedPulls(repo, branches.production, since)
  )
    .filter(
      (pull) =>
        pull.state === "merged" &&
        pull.headRef === branches.staging &&
        pull.baseRef === branches.production &&
        pull.mergeCommitSha &&
        pull.mergedAt,
    )
    .sort((a, b) => b.mergedAt!.localeCompare(a.mergedAt!));
  const older = allReleases.slice(1);
  const releasePages = Math.max(
    1,
    Math.ceil(older.length / (RELEASES_PER_PASS - 1)),
  );
  const releaseOffset =
    (Math.floor(slot / pages) % releasePages) * (RELEASES_PER_PASS - 1);
  const releases = [
    ...allReleases.slice(0, 1),
    ...older.slice(releaseOffset, releaseOffset + RELEASES_PER_PASS - 1),
  ];
  const pending = new Map(
    ready.map((item) => [item.group[0]!.ticket.id, item]),
  );
  const latestAudits = new Map<string, ProductionAudit>();
  for (const release of releases) {
    if (!pending.size) break;
    const manifest: CompletionManifest = {
      version: 1,
      repo,
      productionBranch: branches.production,
      tickets: [],
    };
    for (const [ticketId, item] of pending) {
      const { group, done } = item;
      try {
        const scope = ledger.completionManifest({
          deliveryIds: group.map((record) => record.id),
          productionPr: release.number,
          completedStateId: done,
        });
        const promotion = group[0]!.promotion!;
        // Only the complete, eligible repair lineage in one exact recorded promotion
        // may use its final composition. Ambiguous histories retain individual proof.
        if (
          group.every(
            (record) =>
              record.promotion!.number === promotion.number &&
              record.promotion!.branch === promotion.branch &&
              record.promotion!.headSha === promotion.headSha &&
              record.implementation?.mergeSha,
          )
        )
          for (const ticket of scope.tickets)
            ticket.composition = {
              promotionPr: promotion.number,
              branch: promotion.branch,
              headSha: promotion.headSha,
              implementationPrs: ticket.deliverables.map(
                (delivery) => delivery.implementationPr,
              ),
            };
        manifest.tickets.push(...scope.tickets);
      } catch {
        await blocked(
          group,
          "The finite delivery set changed during completion preparation. The controller will re-read its current scope on the next pass.",
        );
        pending.delete(ticketId);
      }
    }
    if (!manifest.tickets.length) continue;
    const audit = await auditProduction(reads, manifest, {
      onlySuppliedTickets: true,
    });
    const passing = new Set<string>();
    for (const row of audit.tickets) {
      if (!latestAudits.has(row.ticketId))
        latestAudits.set(row.ticketId, { ...audit, tickets: [row] });
      if (row.classification === "production-confirmed")
        passing.add(row.ticketId);
    }
    if (!passing.size) continue;
    const passingManifest = {
      ...manifest,
      tickets: manifest.tickets.filter((scope) => passing.has(scope.ticketId)),
    };
    // The cached audit observations are not write authority. Production head,
    // current ticket state/scope and controller authorization remain fresh at
    // both mutation boundaries inside reconcileProduction.
    const report = await reconcileProduction(reads, passingManifest, {
      apply: true,
      onlySuppliedTickets: true,
      continueOnTicketError: true,
      authorizeTicket: (ticketId) =>
        ledger.completionEligible(
          pending.get(ticketId)!.group.map((record) => record.id),
        ),
    });
    for (const row of report.tickets) {
      reports.push({
        id: `managed:${row.ticketId}:${release.number}`,
        report: { ...report, tickets: [row] },
      });
      pending.delete(row.ticketId);
    }
  }
  for (const [ticketId, item] of pending) {
    const audit = latestAudits.get(ticketId);
    if (audit)
      reports.push({ id: `managed:${ticketId}:waiting`, report: audit });
    else
      await blocked(
        item.group,
        "Waiting for a merged staging-to-production release containing this ticket's exact tested changes. No additional completion approval is required.",
      );
  }
  return reports;
}
