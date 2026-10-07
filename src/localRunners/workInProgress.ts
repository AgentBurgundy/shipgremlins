import type { AreaConfig, Project } from "../config.ts";
import { deliveryConfiguration } from "../delivery/index.ts";
import type { DeliveryRecord } from "../delivery/types.ts";
import { ticketScopeHash } from "../lifecycle/manifest.ts";
import type { LinearTicket } from "../services/types.ts";
import type { LocalJob } from "./types.ts";

const live = (job: LocalJob) => ["queued", "running"].includes(job.status);
const closed = (ticket: LinearTicket) =>
  ["completed", "canceled"].includes(ticket.stateType);

/** WIP ends at trusted PM QA, while queue deduplication continues through release. */
export function codingWorkInProgress(
  project: Project,
  area: AreaConfig,
  tickets: LinearTicket[],
  history: LocalJob[],
  deliveries: DeliveryRecord[],
): number {
  const records = [
    ...new Map(
      deliveries
        .filter(
          (record) =>
            record.area === area.key &&
            record.areaInstanceId === area.instanceId &&
            !record.supersededBy,
        )
        .map((record) => [record.ticket.id, record]),
    ).values(),
  ];
  const verified = (record: DeliveryRecord, ticket?: LinearTicket) =>
    ["verified", "promoted"].includes(record.status) &&
    record.configuration === deliveryConfiguration(project, area.key) &&
    !!record.implementation.mergeSha &&
    !!record.review &&
    !["failed", "blocked"].includes(record.review.verdict ?? "passed") &&
    (!ticket || record.scopeHash === ticketScopeHash(ticket));
  const counted = new Set<string>();
  const byTicket = new Map<string, LocalJob[]>();
  for (const job of history) {
    if (
      job.type !== "developer" ||
      job.developerKind === "sync" ||
      job.project !== project.config.name ||
      job.projectInstanceId !== project.config.instanceId ||
      job.area !== area.key
    )
      continue;
    const ticket = tickets.find((item) =>
      job.linearBinding?.ticketId
        ? item.id === job.linearBinding.ticketId
        : item.identifier === job.ticket,
    );
    const key =
      ticket?.id ?? job.linearBinding?.ticketId ?? job.ticket ?? job.id;
    byTicket.set(key, [...(byTicket.get(key) ?? []), job]);
  }
  for (const [key, attempts] of byTicket) {
    const ticket = tickets.find(
      (item) => item.id === key || item.identifier === key,
    );
    if (attempts.some(live)) {
      counted.add(key);
      continue;
    }
    if (ticket && closed(ticket)) continue;
    const latest = [...attempts].sort((a, b) => b.runId - a.runId)[0]!;
    const record = records.find((item) => item.jobId === latest.id);
    if (record && verified(record, ticket)) continue;
    // An old job no longer in this PM's mapped queue is history, not its WIP.
    if (ticket || record) counted.add(key);
  }
  for (const record of records) {
    if (
      byTicket.has(record.ticket.id) ||
      byTicket.has(record.ticket.identifier)
    )
      continue;
    const ticket = tickets.find((item) => item.id === record.ticket.id);
    if (ticket && closed(ticket)) continue;
    if (!verified(record, ticket)) counted.add(record.ticket.id);
  }
  return counted.size;
}
