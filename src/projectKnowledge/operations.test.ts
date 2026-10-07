import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { initializeSetup } from "../setup/files.ts";
import type { ReadinessContext } from "../setup/pmReadiness.ts";
import type { LocalJob } from "../localRunners/types.ts";
import { projectOperations } from "./operations.ts";
import type { DeliveryRecord } from "../delivery/types.ts";

let root: string;
const context: ReadinessContext = {
  env: {},
  sourceConnections: [],
  serviceConnections: [],
  workers: [],
  localMode: true,
};
beforeEach(() => {
  root = mkdtempSync(
    join(realpathSync(tmpdir()), "gremlins-project-operations-"),
  );
  initializeSetup(root, fileURLToPath(new URL("../..", import.meta.url)), {
    project: "app",
    repo: "owner/app",
  });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
function markIdea() {
  const file = join(root, "projects/app/project.json"),
    config = JSON.parse(readFileSync(file, "utf8"));
  config.ideaPlanId = randomUUID();
  writeFileSync(file, JSON.stringify(config));
}
function delivery(
  status: DeliveryRecord["status"],
  overrides: Partial<DeliveryRecord> = {},
): DeliveryRecord {
  return {
    id: randomUUID(),
    jobId: randomUUID(),
    project: "app",
    area: "core",
    repository: "owner/app",
    configuration: "config",
    ticket: {
      id: randomUUID(),
      identifier: "APP-1",
      title: "Approved change",
      description: "Approved scope",
      projectId: "linear-project",
      teamId: "linear-team",
    },
    scopeHash: "scope",
    approvedBy: "owner",
    approvedAt: "2026-10-06T00:00:00Z",
    implementation: {
      number: 1,
      url: "https://github.com/owner/app/pull/1",
      branch: "gremlins/job-1",
      headSha: "head",
      author: "owner",
    },
    status,
    message: `Current ${status} status`,
    createdAt: "2026-10-06T00:00:00Z",
    updatedAt: "2026-10-06T00:00:00Z",
    ...overrides,
  };
}
describe("project operations priorities", () => {
  it("keeps automatic delivery and active repairs out of the human inbox", () => {
    const pending = [
      "awaiting-merge",
      "awaiting-deployment",
      "awaiting-review",
      "verified",
      "promoted",
    ].map((status) => delivery(status as DeliveryRecord["status"]));
    const repairing = delivery("failed", {
      rework: {
        key: "repair",
        rootDeliveryId: "original",
        attempt: 1,
        reviewHash: "hash",
        findings: [],
        phase: "queued",
        message: "A coder is queued with the QA evidence.",
      },
    });
    const mergeRepair = delivery("blocked", {
      integrationRepair: {
        key: "merge",
        kind: "conflict",
        headSha: "head",
        integrationSha: "base",
        phase: "running",
        message: "A coder is fixing the integration conflict.",
      },
    });
    const result = projectOperations(
      root,
      "app",
      [],
      context,
      [],
      [...pending, repairing, mergeRepair],
    );
    expect(result.inbox.filter((item) => item.kind === "delivery")).toEqual([]);
    expect(result.delivery.items).toHaveLength(7);
  });
  it("keeps genuine blockers and stopped QA repairs actionable in Changes", () => {
    const blocked = delivery("blocked", {
      message: "Deployment access is unavailable.",
    });
    const failed = delivery("failed", {
      rework: {
        key: "repair",
        rootDeliveryId: "original",
        attempt: 1,
        reviewHash: "hash",
        findings: [],
        phase: "stopped",
        message: "The automatic coding repair did not pass QA.",
      },
    });
    const result = projectOperations(
      root,
      "app",
      [],
      context,
      [],
      [blocked, failed],
    );
    const inbox = result.inbox.filter((item) => item.kind === "delivery");
    expect(inbox).toHaveLength(2);
    expect(inbox.map((item) => item.detail)).toContain(
      "The automatic coding repair did not pass QA.",
    );
    expect(
      inbox.every(
        (item) =>
          item.action?.label === "View blocker" &&
          item.action.href === "/projects/app?tab=changes",
      ),
    ).toBe(true);
  });
  it("keeps a stopped integration repair actionable while the draft still awaits merge", () => {
    const stopped = delivery("awaiting-merge", {
      integrationRepair: {
        key: "repair",
        kind: "checks",
        headSha: "head",
        integrationSha: "base",
        phase: "stopped",
        message: "The only automatic integration repair failed its checks.",
      },
    });
    const result = projectOperations(root, "app", [], context, [], [stopped]);
    expect(result.inbox.find((item) => item.kind === "delivery")).toMatchObject(
      {
        detail: "The only automatic integration repair failed its checks.",
        action: { label: "View blocker", href: "/projects/app?tab=changes" },
      },
    );
  });
  it("does not revive a superseded failure beside the current ticket attempt", () => {
    const older = delivery("failed");
    const current = delivery("awaiting-review", {
      ticket: older.ticket,
      createdAt: "2026-10-07T00:00:00Z",
    });
    const job: LocalJob = {
      id: older.jobId,
      runId: 1,
      type: "developer",
      project: "app",
      area: "core",
      status: "failed",
      createdAt: older.createdAt,
      message: "Previous attempt failed.",
    };
    const result = projectOperations(
      root,
      "app",
      [job],
      context,
      [],
      [older, current],
    );
    expect(
      result.inbox.filter((item) => ["run", "delivery"].includes(item.kind)),
    ).toEqual([]);
    expect(result.delivery.items.map((item) => item.id)).toEqual([current.id]);
  });
  it("uses an explicit replacement even when admission timestamps are identical", () => {
    const older = delivery("blocked", { id: "z-original" });
    const current = delivery("awaiting-merge", {
      id: "a-replacement",
      ticket: older.ticket,
      createdAt: older.createdAt,
    });
    older.supersededBy = current.id;
    const result = projectOperations(
      root,
      "app",
      [],
      context,
      [],
      [older, current],
    );
    expect(result.inbox.filter((item) => item.kind === "delivery")).toEqual([]);
    expect(result.delivery.items.map((item) => item.id)).toEqual([current.id]);
  });
  it("preserves individual draft review for an explicit pull-request workflow", () => {
    const file = join(root, "projects/app/project.json"),
      config = JSON.parse(readFileSync(file, "utf8"));
    config.workflow = { kind: "pull-request", baseBranch: "main" };
    writeFileSync(file, JSON.stringify(config));
    const item = delivery("awaiting-merge");
    const result = projectOperations(root, "app", [], context, [], [item]);
    expect(result.inbox.find((row) => row.kind === "delivery")?.action).toEqual(
      { label: "Review draft", href: item.implementation.url },
    );
  });
  it("gives a fresh idea one foundation action instead of premature discovery and environment tasks", () => {
    markIdea();
    const result = projectOperations(root, "app", [], context);
    expect(result.inbox).toEqual([
      expect.objectContaining({
        id: "setup:foundation",
        kind: "setup",
        action: {
          label: "Build foundation",
          href: "/projects/app?tab=environment",
        },
      }),
    ]);
    expect(result.knowledge.areas).toHaveLength(1);
  });
  it("keeps actual failed runs visible while avoiding empty-repository PM setup noise", () => {
    markIdea();
    const job: LocalJob = {
      id: "foundation-failed",
      runId: 1,
      type: "developer",
      project: "app",
      area: "core",
      status: "failed",
      createdAt: "2026-10-05",
      message: "The runner disconnected.",
    };
    const result = projectOperations(root, "app", [job], context);
    expect(result.inbox.map((item) => item.id)).toEqual([
      "setup:foundation",
      "run:foundation-failed",
    ]);
    expect(result.inbox[1]!.detail).toBe("The runner disconnected.");
  });
  it("preserves setup remedies and discovery for an existing application", () => {
    const result = projectOperations(root, "app", [], context);
    expect(result.inbox.some((item) => item.kind === "knowledge")).toBe(true);
    expect(result.inbox.some((item) => item.kind === "setup")).toBe(true);
    expect(result.inbox.some((item) => item.id === "setup:foundation")).toBe(
      false,
    );
  });
});
