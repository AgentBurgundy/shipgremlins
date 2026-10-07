import { expect, it } from "vitest";
import { currentChanges } from "./currentChanges.ts";
import type { ChangeSummary } from "./index.ts";

const ticketId = "99e73aea-03ce-4ab1-90dc-9f3e3525a243";
function change(runId: number, status: ChangeSummary["status"]): ChangeSummary {
  return {
    jobId: "job-" + runId,
    runId,
    ticket: "FOR-2",
    ticketId,
    linearBinding: {
      ticketId,
      workspaceId: "workspace-a",
      connectionId: "default",
    },
    status,
    message: status,
    activityUrl: "/activity?run=job-" + runId,
    createdAt: `2026-10-07T0${runId}:00:00Z`,
    pullRequests: [],
  };
}

it("shows a successful retry once and keeps the earlier failure in its history", () => {
  const failed = change(1, "failed"),
    completed = change(2, "succeeded");
  const all = [failed, completed];
  const result = currentChanges(all);
  expect(result).toHaveLength(1);
  expect(result[0]).toMatchObject({
    jobId: completed.jobId,
    status: "succeeded",
    previousAttempts: [failed],
  });
  expect(all).toEqual([failed, completed]);
  expect(completed).not.toHaveProperty("previousAttempts");
});

it("uses the newest attempt even while queued or failed, never an older success", () => {
  for (const status of ["queued", "running", "failed"] as const) {
    expect(
      currentChanges([change(1, "succeeded"), change(2, status)])[0]?.status,
    ).toBe(status);
  }
});

it("does not collapse matching display identifiers from different workspaces or unbound jobs", () => {
  const first = change(1, "succeeded"),
    second = change(2, "failed"),
    unbound = change(3, "queued");
  second.linearBinding!.workspaceId = "workspace-b";
  delete unbound.linearBinding;
  expect(currentChanges([first, second, unbound])).toHaveLength(3);
});

it("recognizes the same resolved workspace after a connection is renamed", () => {
  const first = change(1, "failed"),
    second = change(2, "succeeded");
  second.linearBinding!.connectionId = "renamed";
  expect(currentChanges([first, second])).toHaveLength(1);
});

it("does not trust an inconsistent retained ticket binding", () => {
  const first = change(1, "failed"),
    second = change(2, "succeeded");
  second.ticketId = "11111111-1111-4111-8111-111111111111";
  expect(currentChanges([first, second])).toHaveLength(2);
});
