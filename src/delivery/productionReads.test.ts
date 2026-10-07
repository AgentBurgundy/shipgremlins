import { describe, expect, it, vi } from "vitest";
import { makeCtx, TEST_REPO } from "../services/fakes.ts";
import { productionAuditReads } from "./productionReads.ts";

describe("reconciliation-scoped production reads", () => {
  it("shares immutable requests concurrently and never reuses them across reconciliations", async () => {
    const ctx = makeCtx(),
      sha = "a".repeat(40);
    ctx.forge.seedRevisionTree(TEST_REPO, sha, [
      { path: "app.ts", sha: "blob", mode: "100644", type: "blob" },
    ]);
    const tree = vi.spyOn(ctx.forge, "getRevisionTree");
    const reads = productionAuditReads(ctx);
    const [first, second] = await Promise.all([
      reads.forge.getRevisionTree!(TEST_REPO, sha),
      reads.forge.getRevisionTree!(TEST_REPO, sha),
    ]);
    first[0]!.path = "mutated";
    expect(second[0]!.path).toBe("app.ts");
    expect(tree).toHaveBeenCalledOnce();
    await productionAuditReads(ctx).forge.getRevisionTree!(TEST_REPO, sha);
    expect(tree).toHaveBeenCalledTimes(2);
  });

  it("keeps ticket authority, mutable branch heads and alias comparisons fresh", async () => {
    const ctx = makeCtx();
    const ticket = ctx.linear.seedTicket({ projectId: "lin_core" });
    ctx.forge.seedBranch(TEST_REPO, "main", "a".repeat(40));
    const get = vi.spyOn(ctx.linear, "getTicket"),
      head = vi.spyOn(ctx.forge, "getBranchSha"),
      compare = vi.spyOn(ctx.forge, "compare");
    const reads = productionAuditReads(ctx);
    await reads.linear.getTicket(ticket.id);
    await reads.forge.getBranchSha(TEST_REPO, "main");
    await reads.forge.compare(TEST_REPO, "staging", "main");
    ticket.stateType = "canceled";
    ctx.forge.seedBranch(TEST_REPO, "main", "b".repeat(40));
    expect((await reads.linear.getTicket(ticket.id))?.stateType).toBe(
      "canceled",
    );
    expect(await reads.forge.getBranchSha(TEST_REPO, "main")).toBe(
      "b".repeat(40),
    );
    await reads.forge.compare(TEST_REPO, "staging", "main");
    expect(get).toHaveBeenCalledTimes(2);
    expect(head).toHaveBeenCalledTimes(2);
    expect(compare).toHaveBeenCalledTimes(2);
  });
});
