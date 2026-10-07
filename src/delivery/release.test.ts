import { describe, expect, it, vi } from "vitest";
import { makeCtx, TEST_REPO } from "../services/fakes.ts";
import { prepareProductionRelease } from "./release.ts";

const SHA = "a".repeat(40);
function fixture() {
  const ctx = makeCtx();
  ctx.project.config.workflow = { kind: "promotion" };
  ctx.forge.seedBranch(TEST_REPO, "staging", SHA);
  ctx.forge.seedBranch(TEST_REPO, "main", "e".repeat(40));
  vi.spyOn(ctx.forge, "compare").mockResolvedValue({ aheadBy: 3, behindBy: 0 });
  const resolveChecks = vi.fn(async () => ({
    status: "success" as const,
    failedJobs: [],
  }));
  return { ...ctx, resolveChecks };
}
describe("staging to production release", () => {
  it("opens one draft for the checked staging head and reuses it without merging", async () => {
    const f = fixture();
    const release = await prepareProductionRelease(f);
    expect(release).toMatchObject({
      baseRef: "main",
      headRef: "staging",
      draft: true,
      state: "open",
    });
    expect(release.body).toContain(SHA);
    expect(await prepareProductionRelease(f)).toEqual(release);
    expect(
      await f.forge.listOpenPulls(TEST_REPO, { base: "main" }),
    ).toHaveLength(1);
    expect(f.resolveChecks).toHaveBeenCalledOnce();
  });
  it("does not override a pending provider check with a local pass", async () => {
    const f = fixture();
    f.forge.seedChecks(TEST_REPO, SHA, { status: "pending", failedJobs: [] });
    await expect(prepareProductionRelease(f)).rejects.toThrow(
      "checks must pass",
    );
    expect(f.resolveChecks).not.toHaveBeenCalled();
    expect(await f.forge.listOpenPulls(TEST_REPO)).toEqual([]);
  });
  it("requires production changes to be tested in staging first", async () => {
    const f = fixture();
    vi.mocked(f.forge.compare).mockResolvedValue({ aheadBy: 3, behindBy: 1 });
    await expect(prepareProductionRelease(f)).rejects.toThrow(
      "production changes",
    );
  });
  it("rejects a moving staging head", async () => {
    const f = fixture();
    f.resolveChecks.mockImplementation(async () => {
      f.forge.seedBranch(TEST_REPO, "staging", "b".repeat(40));
      return { status: "success", failedJobs: [] };
    });
    await expect(prepareProductionRelease(f)).rejects.toThrow(
      "Staging changed",
    );
    expect(await f.forge.listOpenPulls(TEST_REPO)).toEqual([]);
  });
  it("holds a release if production changes during staging checks", async () => {
    const f = fixture();
    f.resolveChecks.mockImplementation(async () => {
      f.forge.seedBranch(TEST_REPO, "main", "b".repeat(40));
      return { status: "success", failedJobs: [] };
    });
    await expect(prepareProductionRelease(f)).rejects.toThrow(
      "Production changed",
    );
    expect(await f.forge.listOpenPulls(TEST_REPO)).toEqual([]);
  });
});
