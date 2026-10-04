import { describe, expect, it } from "vitest";
import { makeCtx } from "../services/fakes.ts";
import { runTickets } from "./tickets.ts";

describe("tickets command", () => {
  it("audits without writes and exposes a machine-readable scope hash and state IDs", async () => {
    const ctx = makeCtx();
    ctx.linear.seedTicket({ projectId: "lin_core", labels: ["pm:core"] });
    const lines: string[] = [];
    expect(
      await runTickets(ctx, ["audit", "--json"], {
        log: (line) => lines.push(line),
        error: () => {},
      }),
    ).toBe(0);
    expect(JSON.parse(lines[0]!)).toMatchObject({
      dryRun: true,
      productionBranch: "main",
      tickets: [{ classification: "ambiguous" }],
    });
    expect(ctx.linear.stateUpdates).toHaveLength(0);
  });

  it.each([
    ["audit", "--apply"],
    ["reconcile"],
    ["reconcile", "--apply", "--dry-run"],
    ["unknown"],
  ])("rejects invalid or incomplete mutation command %j", async (...args) => {
    const ctx = makeCtx();
    const errors: string[] = [];
    expect(
      await runTickets(ctx, args, {
        log: () => {},
        error: (line) => errors.push(line),
      }),
    ).toBe(1);
    expect(errors).not.toHaveLength(0);
    expect(ctx.linear.stateUpdates).toHaveLength(0);
  });
});
