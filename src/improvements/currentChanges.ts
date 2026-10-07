import type { ChangeSummary } from "./index.ts";

export type CurrentChange = ChangeSummary & {
  previousAttempts: ChangeSummary[];
};
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;

/** A presentation projection only: delivery reconciliation still receives every attempt. */
export function currentChanges(changes: ChangeSummary[]): CurrentChange[] {
  const tickets = new Map<string, CurrentChange>();
  const ordered = [...changes].sort(
    (a, b) =>
      b.createdAt.localeCompare(a.createdAt) ||
      b.runId - a.runId ||
      b.jobId.localeCompare(a.jobId),
  );
  for (const change of ordered) {
    const binding = change.linearBinding;
    const key =
      binding &&
      typeof binding.ticketId === "string" &&
      UUID.test(binding.ticketId) &&
      binding.ticketId === change.ticketId
        ? JSON.stringify([
            binding.workspaceId ? "workspace" : "connection",
            binding.workspaceId || binding.connectionId,
            binding.ticketId.toLowerCase(),
          ])
        : "job:" + change.jobId;
    const current = tickets.get(key);
    if (current) current.previousAttempts.push(change);
    else tickets.set(key, { ...change, previousAttempts: [] });
  }
  return [...tickets.values()];
}
