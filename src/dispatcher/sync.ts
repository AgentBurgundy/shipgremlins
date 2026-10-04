// Sync: keep the integration branch current with staging. When staging is
// ahead, one PR `sync: staging → pm-staging` is opened and merged by the
// dispatcher itself as soon as GitHub reports it mergeable — no auto-merge,
// which a repository has to opt into and many do not. A conflicting sync PR
// is flagged to the owner exactly once.

import type { PullRequest } from "../forge/types.ts";
import { branchesOf, repoOf, type Ctx, type DigestRow } from "./context.ts";
import { fireDeveloper, isLiveRun } from "./dispatch.ts";
import {
  LABELS,
  runIdAfter,
  SYNC_BRANCH_PREFIX,
  SYNC_CONFLICT_PREFIX,
  SYNC_PR_TITLE,
  SYNC_RESOLVE_DISPATCHED_PREFIX,
  syncBranch,
} from "./notes.ts";

// A sync PR must land as a merge commit: squash or rebase rewrites the
// staging commits, so compare() would report staging ahead forever and a new
// sync PR would open every run.
const SYNC_MERGE_METHOD = "merge";
const SYNC_MERGEABLE = new Set(["clean", "unstable", "has_hooks"]);

export async function runSync(ctx: Ctx): Promise<DigestRow[]> {
  const repo = repoOf(ctx);
  const { staging, integration } = branchesOf(ctx);
  const rows: DigestRow[] = [];

  const { aheadBy } = await ctx.forge.compare(repo, integration, staging);
  if (aheadBy <= 0) {
    ctx.log(`sync: ${staging} is not ahead of ${integration}`);
    return rows;
  }

  const [existing] = await ctx.forge.listOpenPulls(repo, {
    base: integration,
    head: staging,
  });
  let pr: PullRequest;
  let opened = false;
  if (existing) {
    pr = existing;
  } else {
    if (ctx.dryRun) {
      ctx.log(
        `[dry-run] sync: would open ${SYNC_PR_TITLE(staging, integration)} and merge it`,
      );
      return rows;
    }
    const created = await ctx.forge.createPull(repo, {
      title: SYNC_PR_TITLE(staging, integration),
      head: staging,
      base: integration,
      draft: false,
      body: syncBody(staging, integration, aheadBy, ctx.now()),
    });
    // a just-created PR reports its mergeability only on a later read
    pr = (await ctx.forge.getPull(repo, created.number)) ?? created;
    opened = true;
  }

  if (SYNC_MERGEABLE.has(pr.mergeableState)) {
    if (ctx.dryRun) {
      ctx.log(`[dry-run] sync: would merge #${pr.number}`);
      return rows;
    }
    const result = await ctx.forge.mergePull(repo, pr.number, {
      method: SYNC_MERGE_METHOD,
      sha: pr.headSha,
    });
    if (result.merged) {
      rows.push({
        rule: "sync",
        text: `sync: merged #${pr.number} (${staging} → ${integration}, ${aheadBy} commit${aheadBy === 1 ? "" : "s"})`,
        ref: String(pr.number),
      });
    } else {
      rows.push({
        rule: "sync",
        text: `sync PR #${pr.number} would not merge: ${result.message ?? "no message"}`,
        needsYou: true,
        ref: String(pr.number),
      });
    }
    return rows;
  }

  if (pr.mergeableState !== "dirty") {
    rows.push({
      rule: "sync",
      text: `sync: ${opened ? "opened" : "waiting on"} #${pr.number} (${staging} → ${integration}, ${aheadBy} ahead) — mergeable state ${pr.mergeableState}`,
      ref: String(pr.number),
    });
  }

  if (pr.mergeableState === "dirty") {
    rows.push(...(await resolveConflict(ctx, pr)));
  }

  return rows;
}

function syncBody(
  staging: string,
  integration: string,
  aheadBy: number,
  now: Date,
): string {
  return [
    `Brings ${aheadBy} commit${aheadBy === 1 ? "" : "s"} from \`${staging}\` into \`${integration}\`.`,
    "",
    "Opened by the dispatcher, which merges it as soon as GitHub reports it mergeable.",
    `Opened at ${now.toISOString()}.`,
  ].join("\n");
}

const SYNC_RESOLVE_MAX = 2;

/** A conflicting sync is a developer's job, not the owner's: staging cannot
 *  be pushed to, so the developer merges staging into a fresh branch off the
 *  integration branch (`pm-sync/<staging sha>`), resolves, runs the tests and
 *  opens a PR; the merge rule lands it as a merge commit, which settles the
 *  sync PR too. Two developer runs that end without a PR → the owner, once. */
async function resolveConflict(
  ctx: Ctx,
  syncPr: PullRequest,
): Promise<DigestRow[]> {
  const repo = repoOf(ctx);
  const { staging, integration } = branchesOf(ctx);
  const stagingSha =
    (await ctx.forge.getBranchSha(repo, staging)) ?? syncPr.headSha;
  const branch = syncBranch(stagingSha);

  const resolution = (
    await ctx.forge.listOpenPulls(repo, { base: integration })
  ).find(
    (p) =>
      p.author === ctx.botLogin && p.headRef.startsWith(SYNC_BRANCH_PREFIX),
  );
  if (resolution) {
    const text = `sync: #${syncPr.number} conflicts — resolution PR #${resolution.number} is open`;
    ctx.log(text);
    return [{ rule: "sync", text, ref: String(resolution.number) }];
  }

  const area = ctx.project.areas[0]!;
  const marker = `staging: ${stagingSha}`;
  const existing = (
    await ctx.linear.listTickets(area.linearProjectId, [LABELS.sync])
  ).find((t) => t.description.includes(marker));
  const notes = existing
    ? (await ctx.linear.listComments(existing.id)).map((c) => c.body)
    : [];
  const dispatches = notes.filter((b) =>
    b.startsWith(SYNC_RESOLVE_DISPATCHED_PREFIX),
  );
  const last = dispatches[dispatches.length - 1];
  const lastRunId = last
    ? runIdAfter(SYNC_RESOLVE_DISPATCHED_PREFIX, last)
    : null;
  if (lastRunId !== null) {
    const run = await ctx.forge.getWorkflowRun(ctx.hub.hubRepo, lastRunId);
    if (run && isLiveRun(run)) {
      ctx.log(`sync: resolution run ${lastRunId} is still working`);
      return [];
    }
  }

  if (dispatches.length >= SYNC_RESOLVE_MAX) {
    const comments = await ctx.forge.listPullComments(repo, syncPr.number);
    if (comments.some((c) => c.body.startsWith(SYNC_CONFLICT_PREFIX))) {
      ctx.log(
        `sync: #${syncPr.number} still conflicts — already with the owner`,
      );
      return [];
    }
    const body = `${SYNC_CONFLICT_PREFIX} — two resolution runs ended without a PR; ${staging} does not merge cleanly into ${integration} (${ctx.now().toISOString()})`;
    if (ctx.dryRun) {
      ctx.log(`[dry-run] sync: would comment on #${syncPr.number}: ${body}`);
    } else {
      await ctx.forge.addPullComment(repo, syncPr.number, body);
    }
    return [
      {
        rule: "sync",
        text: `sync PR #${syncPr.number} still conflicts after two automatic resolutions — resolve it by hand`,
        needsYou: true,
        ref: String(syncPr.number),
      },
    ];
  }

  const attempt = dispatches.length + 1;
  if (ctx.dryRun) {
    ctx.log(
      `[dry-run] sync: would send a developer to resolve #${syncPr.number} on ${branch} (attempt ${attempt})`,
    );
    return [];
  }
  const ticket =
    existing ??
    (await ctx.linear.createTicket({
      projectId: area.linearProjectId,
      title: `Resolve sync conflict: ${staging} → ${integration} (${stagingSha.slice(0, 12)})`,
      description: syncTicketBody(
        staging,
        integration,
        stagingSha,
        branch,
        syncPr.number,
      ),
      // dispatched from birth and never `approved`: the dispatch rule must
      // not also build it as an ordinary ticket
      labels: [LABELS.sync, LABELS.dispatched, area.label],
    }));
  const run = await fireDeveloper(ctx, {
    project: ctx.project.config.name,
    ticket: ticket.identifier,
    attempt,
    kind: "sync",
    branch,
  });
  await ctx.linear.addComment(
    ticket.id,
    `${SYNC_RESOLVE_DISPATCHED_PREFIX} ${run.id} — ${run.htmlUrl}`,
  );
  return [
    {
      rule: "sync",
      text: `sync: #${syncPr.number} conflicts — developer sent to resolve it (${ticket.identifier}, attempt ${attempt}) → run ${run.id}`,
      ref: ticket.identifier,
    },
  ];
}

function syncTicketBody(
  staging: string,
  integration: string,
  stagingSha: string,
  branch: string,
  syncPrNumber: number,
): string {
  const q = "`";
  return [
    `${q}${staging}${q} does not merge cleanly into ${q}${integration}${q} (sync PR #${syncPrNumber}).`,
    "",
    `staging: ${stagingSha}`,
    `**Branch:** ${q}${branch}${q} (created from ${q}${integration}${q})`,
    "",
    "## What to do",
    "",
    `1. On ${q}${branch}${q}, ${q}git merge origin/${staging}${q} and resolve every conflict.`,
    `2. Conflicts almost always come from promotions: ${q}${staging}${q} holds a cherry-picked COPY of a change ${q}${integration}${q} has since edited again. For those hunks keep ${q}${integration}${q}'s side. Keep ${q}${staging}${q}'s side only for work that exists nowhere on ${q}${integration}${q}.`,
    "3. Run the project's tests and typecheck; fix anything the merge broke.",
    `4. Open a draft PR ${q}${branch}${q} → ${q}${integration}${q}. The dispatcher merges it as a merge commit, which settles the sync PR.`,
    "",
    "## Acceptance criteria",
    "",
    `1. ${q}git merge-base --is-ancestor origin/${staging} HEAD${q} succeeds on the branch.`,
    "2. The test and typecheck commands pass.",
    `3. No change that only exists on ${q}${integration}${q} is lost.`,
    "",
    "Flag: none. Tier: B.",
  ].join("\n");
}
