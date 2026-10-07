import { expect, it } from "vitest";
import { makeProject } from "../services/fakes.ts";
import { deliveryConfiguration } from "../delivery/index.ts";
import { ticketScopeHash } from "../lifecycle/manifest.ts";
import type { DeliveryRecord } from "../delivery/types.ts";
import type { LinearTicket } from "../services/types.ts";
import type { LocalJob } from "./types.ts";
import { codingWorkInProgress } from "./workInProgress.ts";

it("releases trusted QA batches from WIP but counts coding, failed, blocked, stale or changed-scope work once per ticket", () => {
  const project = makeProject({
    config: { workflow: { kind: "promotion", promotionBatchSize: 10 } },
  });
  const area = project.areas[0]!;
  const ticket = {
    id: "one",
    identifier: "APP-1",
    title: "Name",
    description: "## Acceptance criteria\n- The name saves",
    projectId: area.linearProjectId,
    stateType: "started",
  } as LinearTicket;
  const job = {
    id: "job-one",
    runId: 1,
    type: "developer",
    project: project.config.name,
    area: area.key,
    ticket: ticket.identifier,
    status: "succeeded",
  } as LocalJob;
  const record = {
    jobId: job.id,
    area: area.key,
    status: "verified",
    ticket,
    scopeHash: ticketScopeHash(ticket),
    configuration: deliveryConfiguration(project, area.key),
    implementation: { mergeSha: "a".repeat(40) },
    review: { verdict: "passed" },
  } as unknown as DeliveryRecord;
  const count = (records = [record], history = [job], tickets = [ticket]) =>
    codingWorkInProgress(project, area, tickets, history, records);
  expect(count()).toBe(0);
  expect(count([{ ...record, status: "promoted" }])).toBe(0);
  for (const status of ["awaiting-review", "failed", "blocked"] as const)
    expect(count([{ ...record, status }])).toBe(1);
  expect(count([{ ...record, configuration: "old-config" }])).toBe(1);
  expect(
    count([record], [job], [{ ...ticket, description: "Expanded scope" }]),
  ).toBe(1);
  expect(
    count(
      [record],
      [job, { ...job, id: "repair", runId: 2, status: "running" }],
    ),
  ).toBe(1);
  expect(
    count(
      [record],
      [job, { ...job, id: "repair", runId: 2, status: "failed" }],
    ),
  ).toBe(1);
  expect(count([{ ...record, status: "failed" }, record], [])).toBe(0);
  expect(
    count(
      [{ ...record, status: "blocked" }],
      [job],
      [{ ...ticket, stateType: "completed" }],
    ),
  ).toBe(0);
});
