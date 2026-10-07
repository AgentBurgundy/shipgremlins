import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { makeProject, FakeLinear } from "../services/fakes.ts";
import { FakeForge } from "../forge/fake.ts";
import { createDeliveryController } from "./controller.ts";
import type { CompletedDraft } from "./adoption.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
it.each(["repository", "Linear"])(
  "persists an early %s access blocker and automatically retries without exposing credentials",
  async (unavailable) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "adoption-access-")));
    roots.push(root);
    const project = makeProject({
      config: { workflow: { kind: "promotion" }, linear: { teamId: "team-1" } },
    });
    const forge = new FakeForge(),
      linear = new FakeLinear();
    const ticket = linear.seedTicket({
      id: "ticket-one",
      identifier: "GAME-1",
      projectId: "lin_core",
      labels: ["pm:core"],
    });
    const completed: CompletedDraft = {
      job: {
        id: "job-one",
        project: "game",
        type: "developer",
        status: "succeeded",
        area: "core",
        ticket: ticket.identifier,
        runId: 1,
        createdAt: "2026-10-07T00:00:00Z",
        linearBinding: { connectionId: "default", ticketId: ticket.id },
      },
      change: {
        jobId: "job-one",
        runId: 1,
        status: "succeeded",
        area: "core",
        ticket: ticket.identifier,
        ticketId: ticket.id,
        createdAt: "2026-10-07T00:00:00Z",
        message: "Completed",
        activityUrl: "/activity?run=job-one",
        pullRequests: [
          { number: 7, url: "https://github.com/owner/game/pull/7" },
        ],
        checks: {
          headSha: "a".repeat(40),
          commands: ["test"],
          completedAt: "2026-10-07T00:00:00Z",
        },
      },
    };
    const stale = structuredClone(completed);
    stale.job.id = stale.change.jobId = "job-stale";
    stale.job.projectInstanceId = "old-incarnation";
    let recovering = false;
    const source = vi.fn(async () => {
      if (!recovering && unavailable === "repository")
        throw new Error("Bearer source-private-secret");
      return { token: "source-private-secret", method: "token" as const };
    });
    const connection = vi.fn(async () => {
      if (!recovering && unavailable === "Linear")
        throw new Error("Bearer linear-private-secret");
      return {
        token: "linear-private-secret",
        authorization: "linear-private-secret",
        method: "token" as const,
      };
    });
    const create = () =>
      createDeliveryController({
        root,
        loadProject: () => project,
        sourceControl: { resolveCredential: source },
        linearConnectionFor: () => ({ resolveCredential: connection }),
        forge: () => forge,
        linear: () => linear,
        completedDrafts: async () => [completed, stale],
        now: () => new Date("2026-10-07T00:00:00Z"),
      });
    const first = await create().reconcileCompletedDrafts("game");
    expect(first).toEqual([
      {
        jobId: "job-one",
        phase: "blocked",
        message: expect.stringContaining("saved connections"),
      },
    ]);
    expect(JSON.stringify(first)).not.toContain("private-secret");
    expect(create().deliveryStatus("game").draftMigrations).toEqual([
      expect.objectContaining(first[0]!),
    ]);
    recovering = true;
    const retried = await create().reconcileCompletedDrafts("game");
    expect(source).toHaveBeenCalledTimes(2);
    expect(retried.find((row) => row.jobId === "job-one")?.message).toContain(
      "approved ticket",
    );
    expect(create().deliveryStatus("game").draftMigrations).toEqual([
      expect.objectContaining({
        jobId: "job-one",
        message: expect.stringContaining("approved ticket"),
      }),
    ]);
    expect(forge.merged).toEqual([]);
    expect(forge.dispatched).toEqual([]);
  },
);
