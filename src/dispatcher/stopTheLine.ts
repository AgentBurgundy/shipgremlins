// Stop the line: a red integration branch (failed checks or a failed Vercel
// deployment) halts merges and dispatches. The failed jobs are re-run once;
// still red → ONE fix ticket for the developer; two fixes inside 24h with
// the branch still red → the owner. State lives in Linear (the first area's
// project) because the dispatcher itself keeps nothing between runs.

import type { CheckSummary, PullRequest } from "../forge/types.ts";
import type { Deployment, LinearTicket } from "../services/types.ts";
import { branchesOf, repoOf, type Ctx, type DigestRow } from "./context.ts";
import { LABELS } from "./notes.ts";
import { promotionVercel } from "../projectCapabilities.ts";

const FIX_BUDGET = 2;
const FIX_WINDOW_MS = 24 * 60 * 60 * 1000;
const short = (sha: string): string => sha.slice(0, 12);

const shaLine = (sha: string): string => `sha: ${sha}`;
const isFixTicket = (t: LinearTicket): boolean =>
  t.labels.includes(LABELS.approved);

export interface RecoveryLane {
  ticketId: string;
  identifier: string;
  sha: string;
}

export function isCurrentRecoveryTicket(
  t: LinearTicket,
  sha: string,
  branch: string,
): boolean {
  const lines = t.description.split(/\r?\n/);
  return (
    t.labels.includes(LABELS.approved) &&
    t.labels.includes(LABELS.ci) &&
    !t.labels.includes(LABELS.needsHuman) &&
    !["completed", "canceled"].includes(t.stateType) &&
    lines.includes(shaLine(sha)) &&
    lines.includes(`branch: ${branch}`)
  );
}

export async function integrationHealth(ctx: Ctx): Promise<{
  state: "healthy" | "waiting" | "unhealthy" | "unknown";
  sha: string | null;
  reason: string;
  checks: CheckSummary;
  deployment: Deployment | null;
}> {
  const repo = repoOf(ctx);
  const { integration } = branchesOf(ctx);
  const target = promotionVercel(ctx.project.config);
  if (!target)
    return {
      state: "unknown",
      sha: null,
      reason:
        "Automatic promotion requires a Vercel promotion target with revision-bound verification; use the local draft PR workflow for this project.",
      checks: { status: "none", failedJobs: [] },
      deployment: null,
    };
  const { projectId, teamId } = target;
  const sha = await ctx.forge.getBranchSha(repo, integration);
  const missing: CheckSummary = { status: "none", failedJobs: [] };
  if (!sha)
    return {
      state: "unknown",
      sha,
      reason: `branch ${integration} not found in ${repo}`,
      checks: missing,
      deployment: null,
    };
  const checks = await ctx.forge.getChecks(repo, sha);
  const deployment = await ctx.vercel.latestDeployment(
    projectId,
    teamId ?? null,
    integration,
  );
  const exactDeployment =
    deployment?.sha === sha && deployment.branch === integration;
  const current = await ctx.forge.getBranchSha(repo, integration);
  if (current !== sha)
    return {
      state: "waiting",
      sha,
      checks,
      deployment,
      reason: "integration branch moved during health check",
    };
  if (
    checks.status === "failure" ||
    (exactDeployment && ["ERROR", "CANCELED"].includes(deployment.state))
  )
    return {
      state: "unhealthy",
      sha,
      checks,
      deployment,
      reason: "current integration revision has failed checks or deployment",
    };
  if (checks.status !== "success")
    return {
      state: "waiting",
      sha,
      checks,
      deployment,
      reason: `checks are ${checks.status} at ${short(sha)}`,
    };
  if (!deployment)
    return {
      state: "waiting",
      sha,
      checks,
      deployment,
      reason: `no deployment for ${short(sha)}`,
    };
  if (!exactDeployment)
    return {
      state: "waiting",
      sha,
      checks,
      deployment,
      reason: `deployment does not match current branch and revision ${short(sha)}`,
    };
  if (deployment.state !== "READY")
    return {
      state: "waiting",
      sha,
      checks,
      deployment,
      reason: `deployment is ${deployment.state || "unknown"} at ${short(sha)}`,
    };
  return {
    state: "healthy",
    sha,
    checks,
    deployment,
    reason: "checks and exact revision deployment are ready",
  };
}

export async function checkLine(
  ctx: Ctx,
): Promise<{ stopped: boolean; recovery?: RecoveryLane; rows: DigestRow[] }> {
  const repo = repoOf(ctx);
  const { integration } = branchesOf(ctx);
  const health = await integrationHealth(ctx);
  const { sha, checks, deployment } = health;
  if (!sha) {
    return {
      stopped: true,
      rows: [
        {
          rule: "line",
          text: `⛔ Line stopped — branch ${integration} not found in ${repo}`,
          needsYou: true,
        },
      ],
    };
  }

  if (health.state === "healthy") {
    ctx.log(`line: ${integration} is green at ${short(sha)}`);
    return { stopped: false, rows: [] };
  }

  if (health.state !== "unhealthy") {
    return {
      stopped: true,
      rows: [
        {
          rule: "line",
          pending: true,
          text: `⏳ Line waiting — ${health.reason}`,
        },
      ],
    };
  }

  const area = ctx.project.areas[0];
  if (!area) {
    return {
      stopped: true,
      rows: [
        {
          rule: "line",
          text: `⛔ Line stopped — ${integration} is red and the project has no area to file a fix under`,
          needsYou: true,
        },
      ],
    };
  }

  const ciTickets = await ctx.linear.listTickets(area.linearProjectId, [
    LABELS.ci,
  ]);
  const windowStart = ctx.now().getTime() - FIX_WINDOW_MS;
  const recentFixes = ciTickets.filter(
    (t) => isFixTicket(t) && Date.parse(t.createdAt) >= windowStart,
  );
  const forSha = ciTickets.filter((t) =>
    t.description.split(/\r?\n/).includes(shaLine(sha)),
  );
  const retryMarker = forSha.find((t) => !isFixTicket(t));
  const fixTicket = forSha.find((t) =>
    isCurrentRecoveryTicket(t, sha, integration),
  );
  if (recentFixes.length >= FIX_BUDGET && !fixTicket) {
    ctx.log(
      `line: ${integration} red after ${recentFixes.length} automatic fixes in 24h — needs a human`,
    );
    return {
      stopped: true,
      rows: [
        {
          rule: "line",
          text: `${integration} red after two automatic fixes — ${recentFixes.map((t) => t.identifier).join(", ")}`,
          needsYou: true,
        },
      ],
    };
  }

  if (!retryMarker && !fixTicket) {
    const title = `Retried checks on ${integration} (${short(sha)})`;
    const description = [
      shaLine(sha),
      "",
      `The dispatcher re-ran the failed jobs on ${integration} once at ${ctx.now().toISOString()}. If the branch is still red next run, a fix ticket follows.`,
      "",
      ...failureSection(checks, deployment),
    ].join("\n");
    if (ctx.dryRun) {
      ctx.log(`[dry-run] line: would re-run failed jobs at ${short(sha)}`);
      ctx.log(`[dry-run] line: would file "${title}" (${LABELS.ci})`);
    } else {
      await ctx.forge.rerunFailedJobs(repo, sha);
      await ctx.linear.createTicket({
        projectId: area.linearProjectId,
        title,
        description,
        labels: [LABELS.ci],
      });
    }
    return {
      stopped: true,
      rows: [
        {
          rule: "line",
          text: `⛔ Line stopped — retried checks on ${integration} (${short(sha)})`,
          ref: short(sha),
        },
      ],
    };
  }

  if (!fixTicket) {
    const since = new Date(windowStart).toISOString();
    const merged = await ctx.forge.listMergedPulls(repo, integration, since);
    const title = `Fix red ${integration} (${short(sha)})`;
    const description = fixDescription({
      sha,
      integration,
      checks,
      deployment,
      merged,
      now: ctx.now(),
    });
    if (ctx.dryRun) {
      ctx.log(
        `[dry-run] line: would file "${title}" (${LABELS.ci}, ${LABELS.approved})`,
      );
      return {
        stopped: true,
        rows: [
          {
            rule: "line",
            text: `⛔ Line stopped — would file a fix for ${integration} (${short(sha)})`,
            ref: short(sha),
          },
        ],
      };
    }
    const ticket = await ctx.linear.createTicket({
      projectId: area.linearProjectId,
      title,
      description,
      labels: [LABELS.ci, LABELS.approved],
      priority: 1,
    });
    return {
      stopped: true,
      recovery: { ticketId: ticket.id, identifier: ticket.identifier, sha },
      rows: [
        {
          rule: "line",
          text: `⛔ Line stopped — filed ${ticket.identifier} to fix ${integration} (${short(sha)})`,
          ref: ticket.identifier,
        },
      ],
    };
  }

  ctx.log(
    `line: ${integration} still red at ${short(sha)} — fix ${fixTicket.identifier} already filed`,
  );
  return {
    stopped: true,
    recovery: { ticketId: fixTicket.id, identifier: fixTicket.identifier, sha },
    rows: [
      {
        rule: "line",
        text: `⛔ Line stopped — ${integration} red at ${short(sha)}, fix ${fixTicket.identifier} in progress`,
        ref: fixTicket.identifier,
      },
    ],
  };
}

function failureSection(
  checks: CheckSummary,
  deployment: Deployment | null,
): string[] {
  const lines: string[] = [];
  if (checks.status === "failure") {
    lines.push("## Failed jobs");
    if (checks.failedJobs.length === 0) lines.push("- (names unavailable)");
    for (const job of checks.failedJobs) {
      lines.push(`- ${job.name} — ${job.url}`);
      if (job.logTail) lines.push("", "```", job.logTail.trimEnd(), "```", "");
    }
  }
  if (deployment?.state === "ERROR") {
    lines.push(
      "## Deployment",
      `- Vercel deployment ${deployment.id} for ${deployment.branch} is ERROR — https://${deployment.url}`,
    );
  }
  return lines;
}

function fixDescription(args: {
  sha: string;
  integration: string;
  checks: CheckSummary;
  deployment: Deployment | null;
  merged: PullRequest[];
  now: Date;
}): string {
  const { sha, integration, checks, deployment, merged, now } = args;
  const lines = [
    shaLine(sha),
    `branch: ${integration}`,
    `filed: ${now.toISOString()}`,
    "",
    `\`${integration}\` is red at ${short(sha)} after one automatic retry. Fix it on a NEW branch off \`${integration}\` and open a draft PR targeting \`${integration}\`.`,
    "",
    ...failureSection(checks, deployment),
    "",
    `## Merged into ${integration} in the last 24h`,
  ];
  if (merged.length === 0) lines.push("- nothing");
  for (const pr of merged) {
    lines.push(
      `- #${pr.number} ${pr.title} — ${pr.htmlUrl}${pr.mergeCommitSha ? ` (${short(pr.mergeCommitSha)})` : ""}`,
    );
  }
  return lines.join("\n");
}
