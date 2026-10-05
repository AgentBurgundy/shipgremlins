import { describe, expect, it } from "vitest";
import {
  reserveBudget,
  settleBudget,
  usageFor,
  validLedger,
  type UsageLedger,
} from "./budgets.ts";
import type { LocalJob } from "./types.ts";
const now = new Date("2026-10-05T12:00:00Z");
const job = (project: string, budget: LocalJob["budget"]): LocalJob => ({
  id: "job-synthetic",
  runId: 1,
  type: "pm",
  project,
  area: "core",
  status: "running",
  createdAt: now.toISOString(),
  budget,
});
describe("bounded execution accounting", () => {
  it("isolates a recreated project's daily counters and active jobs while retaining old accounting", () => {
    const id = "a1b2c3d4-1111-2222-3333-444444444444";
    const ledger: UsageLedger = {};
    const limits = { maxDailyRuns: 1, maxConcurrentJobs: 1 };
    const old = job("app", reserveBudget("app", limits, ledger, [], now)!);
    expect(
      usageFor("app", limits, ledger, [old], now, id).blockedReason,
    ).toBeUndefined();
    const replacement = {
      ...job("app", reserveBudget("app", limits, ledger, [old], now, id)!),
      projectInstanceId: id,
    };
    settleBudget(replacement, ledger, new Date(now.getTime() + 60_000));
    expect(usageFor("app", limits, ledger, [], now, id).runtimeMinutes).toBe(1);
    expect(usageFor("app", limits, ledger, [], now).runtimeMinutes).toBe(0);
    expect(ledger["2026-10-05:app"]?.runs).toBe(1);
    expect(validLedger(ledger)).toBe(true);
  });
  it("reserves daily capacity before execution and settles once without fabricated costs", () => {
    const ledger: UsageLedger = {};
    const limits = {
      maxDailyRuntimeMinutes: 3,
      maxJobMinutes: 2,
      maxDailyRuns: 3,
    };
    const first = reserveBudget("app", limits, ledger, [], now)!;
    const active = job("app", first);
    const second = reserveBudget("app", limits, ledger, [active], now)!;
    expect(second.maxMinutes).toBe(1);
    expect(
      reserveBudget("app", limits, ledger, [active, job("app", second)], now),
    ).toBeNull();
    settleBudget(active, ledger, new Date(now.getTime() + 30000));
    settleBudget(active, ledger, new Date(now.getTime() + 90000));
    const usage = usageFor(
      "app",
      limits,
      ledger,
      [{ ...active, status: "succeeded" }, job("app", second)],
      now,
    );
    expect(usage).toMatchObject({
      runsStarted: 2,
      runtimeMinutes: 0.5,
      reservedRuntimeMinutes: 1,
    });
    expect(JSON.stringify(usage)).not.toMatch(/cost|dollar/i);
  });
  it("refunds confirmed pre-execution reservations and leaves other projects untouched", () => {
    const ledger: UsageLedger = {};
    const budget = reserveBudget("app", {}, ledger, [], now)!;
    reserveBudget("another", {}, ledger, [], now);
    settleBudget(job("app", budget), ledger, now, true);
    expect(ledger["2026-10-05:app"]?.runs).toBe(0);
    expect(ledger["2026-10-05:another"]?.runs).toBe(1);
    expect(validLedger(ledger)).toBe(true);
  });
  it("rejects malformed counters and bounds concurrent work per project", () => {
    expect(validLedger({ "2026-10-05:app": { runs: -1, runtimeMs: 0 } })).toBe(
      false,
    );
    expect(
      usageFor(
        "app",
        { maxConcurrentJobs: 1 },
        {},
        [job("app", undefined)],
        now,
      ).blockedReason,
    ).toContain("running job limit");
    expect(
      usageFor(
        "another",
        { maxConcurrentJobs: 1 },
        {},
        [job("app", undefined)],
        now,
      ).blockedReason,
    ).toBeUndefined();
  });
});
