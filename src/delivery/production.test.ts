import { afterEach, describe, expect, it, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeCtx, TEST_REPO } from "../services/fakes.ts";
import {
  ticketScopeHash,
  type CompletionManifest,
} from "../lifecycle/manifest.ts";
import type { DeliveryRecord } from "./types.ts";
import { createProductionDeclarations } from "./production.ts";
const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
const HEAD = "a".repeat(40),
  MERGE = "b".repeat(40),
  PROD = "c".repeat(40);
function world() {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "gremlins-production-")),
  );
  roots.push(root);
  const ctx = makeCtx();
  ctx.now = () => new Date("2026-10-06T12:00:00Z");
  const ticket = ctx.linear.seedTicket({
    projectId: "lin_core",
    labels: ["pm:core", "pm-approved"],
    description: "Finite scope",
    stateType: "started",
    stateId: "working",
  });
  ctx.linear.workflowStates.push({
    id: "done",
    name: "Done",
    type: "completed",
    teamId: "team-1",
  });
  const manifest: CompletionManifest = {
    version: 1,
    repo: TEST_REPO,
    productionBranch: "main",
    tickets: [
      {
        ticketId: ticket.id,
        projectId: "lin_core",
        teamId: "team-1",
        scopeHash: ticketScopeHash(ticket),
        approvedBy: "prior",
        approvedAt: "2026-10-01",
        completedStateId: "done",
        deliverables: [
          {
            implementationPr: 1,
            productionPr: 9,
            implementationBranch: "gremlins/job-one",
            implementationHeadSha: HEAD,
          },
        ],
      },
    ],
  };
  ctx.forge.seedPull(
    TEST_REPO,
    {
      number: 1,
      headRef: "gremlins/job-one",
      headSha: HEAD,
      baseRef: "pm-staging",
      state: "merged",
      mergeCommitSha: MERGE,
      mergedAt: "2026-10-01T12:00:00Z",
    },
    ["app.ts"],
  );
  ctx.forge.seedPull(
    TEST_REPO,
    { number: 9, headRef: "staging", baseRef: "main", state: "open" },
    ["app.ts"],
  );
  ctx.forge.seedBranch(TEST_REPO, "main", PROD);
  for (const sha of [HEAD, MERGE, PROD])
    ctx.forge.seedRevisionTree(TEST_REPO, sha, [
      { path: "app.ts", sha: "blob", mode: "100644", type: "blob" },
    ]);
  const records = [{ id: "job-one" }] as DeliveryRecord[];
  const completionManifest = vi.fn(() => structuredClone(manifest));
  const store = createProductionDeclarations({
    root,
    project: ctx.project,
    ledger: { list: () => records, completionManifest },
    context: async () => ctx,
    now: () => new Date("2026-10-05T12:00:00Z"),
  });
  const input = () => ({
    revision: store.status().revision,
    deliveryIds: ["job-one"],
    productionPr: 9,
    completedStateId: "done",
    scopeComplete: true as const,
  });
  return { root, ctx, ticket, records, store, input, completionManifest };
}
describe("owner-confirmed production completeness", () => {
  it("recovers only a confirmed dead controller lock and preserves ambiguous locks", async () => {
    const w = world(),
      directory = join(w.root, ".run", "delivery", w.ctx.project.config.name),
      lock = join(directory, "production.lock");
    mkdirSync(directory, { recursive: true });
    writeFileSync(lock, "2147483646");
    const kill = vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("gone"), { code: "ESRCH" });
    });
    await w.store.declare(w.input());
    expect(kill).toHaveBeenCalledWith(2147483646, 0);
    expect(existsSync(lock)).toBe(false);
    const prior = readFileSync(join(directory, "production.json"), "utf8");
    writeFileSync(lock, "");
    await expect(w.store.declare(w.input())).rejects.toThrow(
      "Another controller",
    );
    expect(readFileSync(lock, "utf8")).toBe("");
    expect(readFileSync(join(directory, "production.json"), "utf8")).toBe(
      prior,
    );
  });
  it("requires current revision and explicit finite scope confirmation", async () => {
    const w = world();
    await expect(
      w.store.declare({ ...w.input(), scopeComplete: false } as never),
    ).rejects.toThrow("Confirm");
    const stale = w.input();
    w.records.push({ id: "job-two" } as DeliveryRecord);
    await expect(w.store.declare(stale)).rejects.toThrow("state changed");
    expect(w.ctx.linear.stateUpdates).toEqual([]);
  });
  it("does not complete a ticket before its actual production PR merge", async () => {
    const w = world();
    await w.store.declare(w.input());
    await w.store.reconcile();
    expect(w.ctx.linear.stateUpdates).toEqual([]);
    w.ctx.forge.seedPull(
      TEST_REPO,
      {
        number: 9,
        headRef: "staging",
        baseRef: "main",
        state: "merged",
        mergeCommitSha: PROD,
        mergedAt: "2026-10-05T13:00:00Z",
      },
      ["app.ts"],
    );
    await w.store.reconcile();
    expect(w.ctx.linear.stateUpdates).toEqual([
      { ticketId: w.ticket.id, stateId: "done" },
    ]);
    await w.store.reconcile();
    expect(w.ctx.linear.stateUpdates).toHaveLength(1);
  });
  it("a later scope expansion blocks an earlier declaration", async () => {
    const w = world();
    await w.store.declare(w.input());
    w.completionManifest.mockImplementation(() => {
      throw new Error("new delivery needs owner review");
    });
    await expect(w.store.reconcile()).rejects.toThrow("new delivery");
    expect(w.ctx.linear.stateUpdates).toEqual([]);
  });
});
