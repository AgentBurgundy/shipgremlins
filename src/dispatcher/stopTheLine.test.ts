import { describe, expect, it } from "vitest";
import { makeCtx, TEST_REPO, type TestCtx } from "../services/fakes.ts";
import { LABELS } from "./notes.ts";
import { checkLine } from "./stopTheLine.ts";

const INTEGRATION = "pm-staging";
const AREA_PROJECT = "lin_core";

function redCtx(over: { now?: Date; dryRun?: boolean } = {}): {
  ctx: TestCtx;
  sha: string;
} {
  const ctx = makeCtx(over);
  const sha = ctx.forge.branch(TEST_REPO, INTEGRATION)!;
  ctx.forge.seedChecks(TEST_REPO, sha, {
    status: "failure",
    failedJobs: [
      {
        name: "unit",
        url: "https://github.com/owner/game/actions/runs/1/job/9",
        logTail: "Error: expected 1 to be 2",
      },
    ],
  });
  return { ctx, sha };
}

const fixTickets = (ctx: TestCtx) =>
  ctx.linear.created.filter((t) => t.labels.includes(LABELS.approved));

describe("checkLine", () => {
  it.each(["pending", "none"] as const)(
    "%s checks wait without retrying or filing repair work",
    async (status) => {
      const ctx = makeCtx();
      const sha = ctx.forge.branch(TEST_REPO, INTEGRATION)!;
      ctx.forge.seedChecks(TEST_REPO, sha, { status, failedJobs: [] });
      const result = await checkLine(ctx);
      expect(result.stopped).toBe(true);
      expect(result.rows[0]?.pending).toBe(true);
      expect(result.recovery).toBeUndefined();
      expect(ctx.forge.reruns).toEqual([]);
      expect(ctx.linear.created).toEqual([]);
    },
  );

  it.each(["READY", "ERROR", "BUILDING"])(
    "a %s deployment for an older revision cannot open or trigger repairs on the line",
    async (state) => {
      const ctx = makeCtx();
      ctx.vercel.seedDeployment("prj_game", INTEGRATION, {
        state,
        sha: "stale-sha",
      });
      const result = await checkLine(ctx);
      expect(result.stopped).toBe(true);
      expect(result.rows[0]?.pending).toBe(true);
      expect(ctx.forge.reruns).toEqual([]);
      expect(ctx.linear.created).toEqual([]);
    },
  );

  it("a missing deployment waits and does not create a false repair", async () => {
    const ctx = makeCtx();
    ctx.vercel.latestDeployment = async () => null;
    const result = await checkLine(ctx);
    expect(result.stopped).toBe(true);
    expect(result.rows[0]?.text).toContain("no deployment");
    expect(ctx.linear.created).toEqual([]);
  });

  it("a deployment still building at the current revision waits", async () => {
    const ctx = makeCtx();
    ctx.vercel.seedDeployment("prj_game", INTEGRATION, {
      state: "BUILDING",
      sha: ctx.forge.branch(TEST_REPO, INTEGRATION)!,
    });
    const result = await checkLine(ctx);
    expect(result.stopped).toBe(true);
    expect(result.rows[0]?.pending).toBe(true);
    expect(ctx.linear.created).toEqual([]);
  });

  it("green checks and a ready deployment → not stopped, nothing written", async () => {
    const ctx = makeCtx();
    const result = await checkLine(ctx);
    expect(result.stopped).toBe(false);
    expect(result.rows).toEqual([]);
    expect(ctx.forge.reruns).toEqual([]);
    expect(ctx.linear.created).toEqual([]);
  });

  it("red checks → stopped and the failed jobs re-run once", async () => {
    const { ctx, sha } = redCtx();
    const result = await checkLine(ctx);
    expect(result.stopped).toBe(true);
    expect(ctx.forge.reruns).toEqual([sha]);
    expect(fixTickets(ctx)).toHaveLength(0);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({ rule: "line" });
    expect(result.rows[0]!.text).toContain("retried checks");
  });

  it("a failed Vercel deployment stops the line even with green checks", async () => {
    const ctx = makeCtx();
    const sha = ctx.forge.branch(TEST_REPO, INTEGRATION)!;
    ctx.vercel.seedDeployment("prj_game", INTEGRATION, { state: "ERROR", sha });
    const result = await checkLine(ctx);
    expect(result.stopped).toBe(true);
    expect(ctx.forge.reruns).toEqual([sha]);
  });

  it("still red after the retry → one fix ticket with sha, jobs, logs and recent merges", async () => {
    const { ctx, sha } = redCtx();
    ctx.forge.seedPull(TEST_REPO, {
      number: 41,
      title: "feat: scoreboard",
      state: "merged",
      baseRef: INTEGRATION,
      mergedAt: "2026-10-02T09:00:00Z",
      mergeCommitSha: "abc123abc123abc123",
    });
    ctx.forge.seedPull(TEST_REPO, {
      number: 30,
      title: "old merge",
      state: "merged",
      baseRef: INTEGRATION,
      mergedAt: "2026-09-29T09:00:00Z",
    });

    await checkLine(ctx);
    const second = await checkLine(ctx);

    expect(second.stopped).toBe(true);
    expect(ctx.forge.reruns).toEqual([sha]);
    const fixes = fixTickets(ctx);
    expect(fixes).toHaveLength(1);
    const ticket = fixes[0]!;
    expect(ticket.title).toBe(`Fix red ${INTEGRATION} (${sha.slice(0, 12)})`);
    expect(ticket.labels).toEqual(
      expect.arrayContaining([LABELS.ci, LABELS.approved]),
    );
    expect(ticket.description).toContain(`sha: ${sha}`);
    expect(ticket.description).toContain("unit");
    expect(ticket.description).toContain(
      "https://github.com/owner/game/actions/runs/1/job/9",
    );
    expect(ticket.description).toContain("Error: expected 1 to be 2");
    expect(ticket.description).toContain("#41");
    expect(ticket.description).not.toContain("#30");
    expect(
      (await ctx.linear.listTickets(AREA_PROJECT, [LABELS.ci])).some(
        (t) => t.id === ticket.id,
      ),
    ).toBe(true);
    expect(second.rows).toHaveLength(1);
    expect(second.rows[0]!.text).toContain(ticket.identifier);
  });

  it("a third pass at the same sha files nothing new", async () => {
    const { ctx, sha } = redCtx();
    await checkLine(ctx);
    await checkLine(ctx);
    const third = await checkLine(ctx);
    expect(third.stopped).toBe(true);
    expect(ctx.forge.reruns).toEqual([sha]);
    expect(fixTickets(ctx)).toHaveLength(1);
    expect(third.rows).toHaveLength(1);
    expect(third.rows[0]!.needsYou).toBeFalsy();
  });

  it("two fix tickets in 24h and still red → needs you, no retry, no third ticket", async () => {
    const { ctx } = redCtx();
    for (const hoursAgo of [20, 8]) {
      ctx.linear.seedTicket({
        projectId: AREA_PROJECT,
        labels: [LABELS.ci, LABELS.approved],
        description: "sha: 1111111111111111111111111111111111111111",
        createdAt: new Date(
          ctx.now().getTime() - hoursAgo * 3_600_000,
        ).toISOString(),
      });
    }
    const result = await checkLine(ctx);
    expect(result.stopped).toBe(true);
    expect(ctx.forge.reruns).toEqual([]);
    expect(ctx.linear.created).toEqual([]);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({ rule: "line", needsYou: true });
    expect(result.rows[0]!.text).toContain(
      `${INTEGRATION} red after two automatic fixes`,
    );
  });

  it("fix tickets older than 24h do not count against the budget", async () => {
    const { ctx, sha } = redCtx();
    for (const hoursAgo of [30, 48]) {
      ctx.linear.seedTicket({
        projectId: AREA_PROJECT,
        labels: [LABELS.ci, LABELS.approved],
        description: "sha: 1111111111111111111111111111111111111111",
        createdAt: new Date(
          ctx.now().getTime() - hoursAgo * 3_600_000,
        ).toISOString(),
      });
    }
    const result = await checkLine(ctx);
    expect(result.stopped).toBe(true);
    expect(ctx.forge.reruns).toEqual([sha]);
    expect(result.rows[0]!.needsYou).toBeFalsy();
  });

  it("dry-run stops the line but writes nothing", async () => {
    const { ctx } = redCtx({ dryRun: true });
    const result = await checkLine(ctx);
    expect(result.stopped).toBe(true);
    expect(ctx.forge.reruns).toEqual([]);
    expect(ctx.linear.created).toEqual([]);
    expect(ctx.lines.some((l) => l.startsWith("[dry-run]"))).toBe(true);
  });
});
