import { describe, expect, it, vi } from "vitest";
import { makeCtx, TEST_REPO } from "../services/fakes.ts";
import {
  LABELS,
  CI_RETRIED_PREFIX,
  CI_RERUN_PLAN_PREFIX,
  CI_RERUN_RESERVED_PREFIX,
  CI_RERUN_ACK_PREFIX,
} from "./notes.ts";
import { runRepair } from "./repair.ts";
function world() {
  const ctx = makeCtx();
  ctx.linear.seedTicket({
    projectId: "lin_core",
    identifier: "GAME-3",
    labels: [LABELS.approved],
  });
  const pull = ctx.forge.seedPull(TEST_REPO, {
    number: 5,
    headRef: "pm/game-3",
  });
  ctx.forge.seedChecks(TEST_REPO, pull.headSha, {
    status: "failure",
    failedJobs: [{ name: "tests", url: "https://ci/job/1" }],
  });
  return { ctx, pull, comments: () => ctx.forge.comments(TEST_REPO, 5) };
}
describe("durable exact-revision CI rerun admission", () => {
  it.each(["provider response", "acknowledgment comment", "final receipt"])(
    "reconciles a lost %s without another rerun",
    async (failure) => {
      const f = world();
      if (failure === "provider response") {
        const request = f.ctx.forge.rerunFailedJobTarget.bind(f.ctx.forge);
        vi.spyOn(f.ctx.forge, "rerunFailedJobTarget").mockImplementationOnce(
          async (target) => {
            await request(target);
            throw new Error("response lost");
          },
        );
      } else {
        const add = f.ctx.forge.addPullComment.bind(f.ctx.forge);
        vi.spyOn(f.ctx.forge, "addPullComment").mockImplementationOnce(
          async (...args) => add(...args),
        );
        vi.spyOn(f.ctx.forge, "addPullComment").mockImplementation(
          async (repo, number, body) => {
            if (
              body.startsWith(
                failure === "final receipt"
                  ? CI_RETRIED_PREFIX
                  : CI_RERUN_ACK_PREFIX,
              )
            ) {
              f.ctx.forge.addPullComment = add;
              throw new Error("comment unavailable");
            }
            return add(repo, number, body);
          },
        );
      }
      await expect(runRepair(f.ctx)).rejects.toThrow();
      expect(f.ctx.forge.reruns).toEqual([f.pull.headSha]);
      await runRepair(f.ctx);
      expect(f.ctx.forge.reruns).toEqual([f.pull.headSha]);
      expect(
        f.comments().filter((body) => body.startsWith(CI_RETRIED_PREFIX)),
      ).toHaveLength(1);
      expect(f.comments().at(-1)).toContain(`head-sha: ${f.pull.headSha}`);
      expect(f.ctx.forge.dispatched).toEqual([]);
    },
  );
  it("does not replay an admitted request without provider acknowledgment", async () => {
    const f = world();
    vi.spyOn(f.ctx.forge, "rerunFailedJobTarget").mockRejectedValueOnce(
      new Error("unknown outcome"),
    );
    await expect(runRepair(f.ctx)).rejects.toThrow();
    const rows = await runRepair(f.ctx);
    expect(f.ctx.forge.rerunFailedJobTarget).toHaveBeenCalledTimes(1);
    expect(
      f.comments().some((body) => body.startsWith(CI_RERUN_RESERVED_PREFIX)),
    ).toBe(true);
    expect(rows[0]?.text).toContain("no second retry");
    expect(f.ctx.forge.dispatched).toEqual([]);
  });
  it("defers a plan with pending checks and keeps an acknowledged pending rerun ahead of code repair", async () => {
    const f = world();
    const plan = f.ctx.forge.planFailedJobRerun.bind(f.ctx.forge);
    vi.spyOn(f.ctx.forge, "planFailedJobRerun").mockResolvedValueOnce({
      state: "pending",
      targets: [],
    });
    expect((await runRepair(f.ctx))[0]).toMatchObject({ pending: true });
    expect(f.comments()).toEqual([]);
    f.ctx.forge.planFailedJobRerun = plan;
    await runRepair(f.ctx);
    vi.spyOn(f.ctx.forge, "getFailedJobRerunEvidence").mockResolvedValue({
      acknowledged: true,
      pending: true,
    });
    expect((await runRepair(f.ctx))[0]).toMatchObject({ pending: true });
    expect(f.ctx.forge.reruns).toHaveLength(1);
    expect(f.ctx.forge.dispatched).toEqual([]);
  });
  it("does not send a provider request when the head changes after durable admission", async () => {
    const f = world();
    const add = f.ctx.forge.addPullComment.bind(f.ctx.forge);
    vi.spyOn(f.ctx.forge, "addPullComment").mockImplementation(
      async (...args) => {
        const comment = await add(...args);
        if (args[2].startsWith(CI_RERUN_RESERVED_PREFIX))
          f.ctx.forge.patchPull(TEST_REPO, 5, { headSha: "b".repeat(40) });
        return comment;
      },
    );
    expect((await runRepair(f.ctx))[0]).toMatchObject({ pending: true });
    expect(f.ctx.forge.reruns).toEqual([]);
    expect(f.ctx.forge.dispatched).toEqual([]);
  });
  it("fails closed on corrupted durable plans and never accepts a same-prefix receipt for another exact head", async () => {
    const f = world();
    f.ctx.forge.seedComment(TEST_REPO, 5, `${CI_RERUN_PLAN_PREFIX}invalid`);
    expect((await runRepair(f.ctx))[0]).toMatchObject({ needsYou: true });
    expect(f.ctx.forge.reruns).toEqual([]);
    const other = world();
    other.ctx.forge.seedComment(
      TEST_REPO,
      5,
      `${CI_RETRIED_PREFIX} at ${other.pull.headSha.slice(0, 12)}\nhead-sha: ${other.pull.headSha.slice(0, 12)}${"f".repeat(28)}`,
    );
    await runRepair(other.ctx);
    expect(other.ctx.forge.reruns).toEqual([other.pull.headSha]);
  });
});
