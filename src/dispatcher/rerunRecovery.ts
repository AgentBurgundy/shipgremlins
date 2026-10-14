import { randomUUID } from "node:crypto";
import type { FailedJobRerunTarget, PullRequest } from "../forge/types.ts";
import type { Ctx, DigestRow } from "./context.ts";
import {
  CI_RETRIED_PREFIX,
  CI_RERUN_ACK_PREFIX,
  CI_RERUN_PLAN_PREFIX,
  CI_RERUN_RESERVED_PREFIX,
} from "./notes.ts";

interface DurablePlan {
  schema: 1;
  id: string;
  sha: string;
  repository: string;
  createdAt: string;
  targets: FailedJobRerunTarget[];
}
const record = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);
function parsePlan(body: string): DurablePlan | null {
  if (!body.startsWith(CI_RERUN_PLAN_PREFIX) || body.length > 32_000)
    return null;
  try {
    const value: unknown = JSON.parse(body.slice(CI_RERUN_PLAN_PREFIX.length));
    if (
      !record(value) ||
      value.schema !== 1 ||
      typeof value.id !== "string" ||
      typeof value.sha !== "string" ||
      typeof value.repository !== "string" ||
      !Number.isFinite(Date.parse(String(value.createdAt))) ||
      !Array.isArray(value.targets) ||
      value.targets.length > 100
    )
      return null;
    for (const target of value.targets) {
      if (
        !record(target) ||
        !["github", "gitlab", "fake"].includes(String(target.provider)) ||
        target.repository !== value.repository ||
        target.sha !== value.sha ||
        !Number.isSafeInteger(target.runId) ||
        Number(target.runId) < 1 ||
        !Number.isSafeInteger(target.attempt) ||
        Number(target.attempt) < 1
      )
        return null;
      if (
        target.jobs !== undefined &&
        (!Array.isArray(target.jobs) ||
          target.jobs.length > 100 ||
          target.jobs.some(
            (job) =>
              !record(job) ||
              !Number.isSafeInteger(job.id) ||
              Number(job.id) < 1 ||
              typeof job.name !== "string",
          ))
      )
        return null;
    }
    return value as unknown as DurablePlan;
  } catch {
    return null;
  }
}

/** Only receipt reconciliation can follow an uncertain provider POST, never another POST. */
export async function recoverFailedJobRerun(
  ctx: Ctx,
  pr: PullRequest,
  comments: string[],
): Promise<{ handled: boolean; row?: DigestRow }> {
  // Providers and fakes may return a mutable shared PR object. Freeze this pass's
  // requested revision before awaiting any state or receipt writes.
  pr = { ...pr };
  const repo = ctx.project.config.repo;
  const receipt = `${CI_RETRIED_PREFIX} at ${pr.headSha.slice(0, 12)}`;
  const hasReceipt = comments.some((body) => {
    const lines = body.split(/\r?\n/);
    return (
      lines[0] === receipt &&
      (!lines.some((line) => line.startsWith("head-sha: ")) ||
        lines.includes(`head-sha: ${pr.headSha}`))
    );
  });
  const row = (
    text: string,
    needsYou = false,
    pending = false,
  ): { handled: true; row: DigestRow } => ({
    handled: true,
    row: {
      rule: "repair",
      ref: String(pr.number),
      text: `#${pr.number} ${pr.title}: ${text}`,
      ...(needsYou ? { needsYou } : {}),
      ...(pending ? { pending } : {}),
    },
  });
  if (hasReceipt) {
    const previous = comments
      .map(parsePlan)
      .filter(
        (value): value is DurablePlan =>
          value !== null &&
          value.repository === repo &&
          value.sha === pr.headSha,
      )
      .at(-1);
    if (previous && ctx.forge.getFailedJobRerunEvidence) {
      for (const target of previous.targets)
        if ((await ctx.forge.getFailedJobRerunEvidence(target)).pending)
          return row(
            "the acknowledged CI retry is still pending; developer repair will wait",
            false,
            true,
          );
    } else if (
      ctx.forge.planFailedJobRerun &&
      (await ctx.forge.planFailedJobRerun(repo, pr.headSha)).state === "pending"
    )
      return row(
        "CI is still pending; developer repair will wait",
        false,
        true,
      );
    return { handled: false };
  }
  const exactHead = async () => {
    const current = await ctx.forge.getPull(repo, pr.number);
    return (
      current?.state === "open" &&
      current.headSha === pr.headSha &&
      current.headRef === pr.headRef &&
      current.baseRef === pr.baseRef
    );
  };
  if (!(await exactHead()))
    return row(
      "head changed before CI retry; existing work was preserved",
      false,
      true,
    );
  if (ctx.dryRun) {
    ctx.log(
      `[dry-run] PR #${pr.number}: plan and reserve exact-revision CI reruns`,
    );
    return { handled: true };
  }
  if (
    !ctx.forge.planFailedJobRerun ||
    !ctx.forge.rerunFailedJobTarget ||
    !ctx.forge.getFailedJobRerunEvidence
  )
    return row(
      "the provider cannot acknowledge exact-revision CI retries; inspect the failed jobs before proceeding",
      true,
    );
  if (
    comments.some(
      (body) => body.startsWith(CI_RERUN_PLAN_PREFIX) && !parsePlan(body),
    )
  )
    return row(
      "a durable CI retry plan is unreadable; inspect its existing provider work before retrying",
      true,
    );
  let plan = comments
    .map(parsePlan)
    .filter(
      (value): value is DurablePlan =>
        value !== null && value.repository === repo && value.sha === pr.headSha,
    )
    .at(-1);
  if (!plan) {
    const next = await ctx.forge.planFailedJobRerun(repo, pr.headSha);
    if (next.state === "pending")
      return row(
        "checks are still pending; failed jobs will wait before retrying",
        false,
        true,
      );
    plan = {
      schema: 1,
      id: randomUUID(),
      repository: repo,
      sha: pr.headSha,
      createdAt: ctx.now().toISOString(),
      targets: next.targets,
    };
    const body = `${CI_RERUN_PLAN_PREFIX}${JSON.stringify(plan)}`;
    if (!parsePlan(body))
      return row(
        "provider CI retry evidence is invalid; no jobs were requested",
        true,
      );
    await ctx.forge.addPullComment(repo, pr.number, body);
    comments.push(body);
  }
  for (const target of plan.targets) {
    const key = JSON.stringify({ planId: plan.id, runId: target.runId });
    const acknowledgment = `${CI_RERUN_ACK_PREFIX}${key}`;
    if (comments.includes(acknowledgment)) continue;
    const admission = `${CI_RERUN_RESERVED_PREFIX}${key}`;
    if (comments.includes(admission)) {
      const evidence = await ctx.forge.getFailedJobRerunEvidence(target);
      if (!evidence.acknowledged) {
        const overdue =
          ctx.now().getTime() - Date.parse(plan.createdAt) > 2 * 60_000;
        return row(
          "waiting for provider acknowledgment of the existing CI retry; no second retry was requested",
          overdue && !evidence.pending,
          !overdue || evidence.pending,
        );
      }
    } else {
      if (!(await exactHead()))
        return row(
          "head changed before CI retry; existing work was preserved",
          false,
          true,
        );
      await ctx.forge.addPullComment(repo, pr.number, admission);
      comments.push(admission);
      if (!(await exactHead()))
        return row(
          "head changed after CI retry admission; no provider request was sent",
          false,
          true,
        );
      await ctx.forge.rerunFailedJobTarget(target);
    }
    await ctx.forge.addPullComment(repo, pr.number, acknowledgment);
    comments.push(acknowledgment);
  }
  if (!(await exactHead()))
    return row(
      "head changed after CI retry; its old-revision acknowledgment was preserved",
      false,
      true,
    );
  await ctx.forge.addPullComment(
    repo,
    pr.number,
    `${receipt}\nhead-sha: ${pr.headSha}\nrerun-plan: ${plan.id}`,
  );
  return row(
    plan.targets.length
      ? "checks red — re-ran the failed jobs"
      : "no provider jobs can be retried; recorded the exact revision for developer repair",
  );
}
