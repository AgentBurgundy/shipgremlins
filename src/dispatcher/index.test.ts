import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeCtx } from "../services/fakes.ts";
import type { DigestRow } from "./context.ts";

const mocks = vi.hoisted(() => ({
  runSync: vi.fn(),
  checkLine: vi.fn(),
  runHeal: vi.fn(),
  runRepair: vi.fn(),
  runMerge: vi.fn(),
  runDispatch: vi.fn(),
  runPromote: vi.fn(),
}));

vi.mock("./sync.ts", () => ({ runSync: mocks.runSync }));
vi.mock("./stopTheLine.ts", () => ({ checkLine: mocks.checkLine }));
vi.mock("./heal.ts", () => ({ runHeal: mocks.runHeal }));
vi.mock("./repair.ts", () => ({ runRepair: mocks.runRepair }));
vi.mock("./merge.ts", () => ({ runMerge: mocks.runMerge }));
vi.mock("./dispatch.ts", () => ({ runDispatch: mocks.runDispatch }));
vi.mock("./promote.ts", () => ({ runPromote: mocks.runPromote }));

import { runDispatcher } from "./index.ts";

const row = (rule: DigestRow["rule"], text: string = rule): DigestRow => ({
  rule,
  text,
});

const fakeGit = { run: vi.fn() };
const promoteOpts = { git: fakeGit, checkoutDir: "/tmp/target" };

beforeEach(() => {
  for (const fn of Object.values(mocks)) fn.mockReset();
  mocks.runSync.mockResolvedValue([row("sync")]);
  mocks.checkLine.mockResolvedValue({ stopped: false, rows: [] });
  mocks.runHeal.mockResolvedValue([row("heal")]);
  mocks.runRepair.mockResolvedValue([row("repair")]);
  mocks.runMerge.mockResolvedValue([row("merge")]);
  mocks.runDispatch.mockResolvedValue([row("dispatch")]);
  mocks.runPromote.mockResolvedValue([row("promote")]);
});

describe("runDispatcher", () => {
  it("waits for health on the new integration revision after any successful merge", async () => {
    const ctx = makeCtx();
    mocks.runMerge.mockResolvedValue([row("merge", "🚢 #10 repaired")]);
    await runDispatcher(ctx, promoteOpts);
    expect(mocks.runDispatch).not.toHaveBeenCalled();
    expect(mocks.runPromote).not.toHaveBeenCalled();
  });

  it("runs every rule in order and concatenates their rows", async () => {
    const ctx = makeCtx();
    const order: string[] = [];
    for (const [name, fn] of Object.entries(mocks)) {
      fn.mockImplementation(async () => {
        order.push(name);
        return name === "checkLine"
          ? { stopped: false, rows: [row("line", name)] }
          : [row("sync", name)];
      });
    }

    const rows = await runDispatcher(ctx, promoteOpts);

    expect(order).toEqual([
      "runSync",
      "checkLine",
      "runHeal",
      "runRepair",
      "runMerge",
      "runRepair",
      "runDispatch",
      "runPromote",
    ]);
    // the second repair pass repeats the first one's row; it is reported once
    expect(rows.map((r) => r.text)).toEqual([...new Set(order)]);
    expect(mocks.runMerge).toHaveBeenCalledWith(ctx, { lineStopped: false });
    expect(mocks.runPromote).toHaveBeenCalledWith(ctx, promoteOpts);
  });

  it("a stopped line still heals and repairs, but never dispatches or promotes ordinary work", async () => {
    const ctx = makeCtx();
    mocks.checkLine.mockResolvedValue({
      stopped: true,
      rows: [row("line", "⛔ Line stopped")],
    });

    const rows = await runDispatcher(ctx, promoteOpts);

    expect(mocks.runHeal).toHaveBeenCalledTimes(1);
    expect(mocks.runRepair).toHaveBeenCalledTimes(2);
    expect(mocks.runMerge).toHaveBeenCalledWith(ctx, { lineStopped: true });
    expect(mocks.runDispatch).not.toHaveBeenCalled();
    expect(mocks.runPromote).not.toHaveBeenCalled();
    expect(rows.map((r) => r.text)).toEqual([
      "sync",
      "⛔ Line stopped",
      "heal",
      "repair",
      "merge",
    ]);
  });

  it("passes only the explicit current-revision recovery lane while stopped", async () => {
    const ctx = makeCtx();
    const recovery = {
      ticketId: "repair-id",
      identifier: "FIX-7",
      sha: "a".repeat(40),
    };
    mocks.checkLine.mockResolvedValue({ stopped: true, recovery, rows: [] });
    await runDispatcher(ctx, promoteOpts);
    expect(mocks.runMerge).toHaveBeenCalledWith(ctx, {
      lineStopped: true,
      recovery,
    });
    expect(mocks.runDispatch).toHaveBeenCalledWith(ctx, { recovery });
    expect(mocks.runPromote).not.toHaveBeenCalled();
  });

  it("skips promotion when no git checkout is supplied", async () => {
    const ctx = makeCtx();
    const rows = await runDispatcher(ctx);
    expect(mocks.runPromote).not.toHaveBeenCalled();
    expect(rows.map((r) => r.rule)).toEqual([
      "sync",
      "heal",
      "repair",
      "merge",
      "dispatch",
    ]);
  });

  it("a throwing rule becomes a needs-you row and the later rules still run", async () => {
    const ctx = makeCtx();
    mocks.runRepair.mockRejectedValue(new Error("Linear 502"));

    const rows = await runDispatcher(ctx, promoteOpts);

    const crash = rows.find((r) => r.rule === "repair");
    expect(crash).toMatchObject({
      rule: "repair",
      needsYou: true,
      text: "repair crashed: Linear 502",
    });
    expect(mocks.runMerge).toHaveBeenCalledTimes(1);
    expect(mocks.runDispatch).toHaveBeenCalledTimes(1);
    expect(mocks.runPromote).toHaveBeenCalledTimes(1);
    expect(rows.map((r) => r.rule)).toEqual([
      "sync",
      "heal",
      "repair",
      "merge",
      "dispatch",
      "promote",
    ]);
    expect(ctx.lines.some((l) => l.includes("Linear 502"))).toBe(true);
  });

  it("a crashed line check fails closed: merges hold and nothing dispatches", async () => {
    const ctx = makeCtx();
    mocks.checkLine.mockRejectedValue(new Error("Vercel timeout"));

    const rows = await runDispatcher(ctx);

    expect(rows.find((r) => r.rule === "line")).toMatchObject({
      needsYou: true,
      text: "line crashed: Vercel timeout",
    });
    expect(mocks.runMerge).toHaveBeenCalledWith(ctx, { lineStopped: true });
    expect(mocks.runDispatch).not.toHaveBeenCalled();
  });

  it("reports a non-Error throw by its string form", async () => {
    const ctx = makeCtx();
    mocks.runSync.mockRejectedValue("boom");
    const rows = await runDispatcher(ctx);
    expect(rows[0]).toMatchObject({ rule: "sync", text: "sync crashed: boom" });
  });
});
