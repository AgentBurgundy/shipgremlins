// Every comment the agents and the dispatcher write, and every comment they
// read back, is defined HERE and nowhere else. The prompts and the workflows
// quote these strings; src/contracts.test.ts fails if they drift.

/** The developer's claim on a ticket, written first thing in developer.yml. */
export const CLAIMED_PREFIX = "🔧 Claimed by run";
/** The developer's "done" marker on the ticket AND the PR. Merge requires it on the PR. */
export const PR_OPENED_PREFIX = "🔧 PR opened";
/** The dispatcher's dispatch receipt on the Linear ticket. */
export const DISPATCHED_PREFIX = "Dispatched → run";
/** The dispatcher's merge receipt on the PR. */
export const MERGED_PREFIX = "🚢 Merged by the dispatcher";
/** The PM's test verdict on a PR: "🧪 Verified on pm-staging" or "🧪 Failed on pm-staging". */
export const VERIFIED_PREFIX = "🧪 Verified on pm-staging";
export const FAILED_PREFIX = "🧪 Failed on pm-staging";

export const NEEDS_OWNER_PREFIX = "🚫 needs owner";
export const MERGE_FAILED_PREFIX = "🚫 needs owner: merge failed at";
export const HUB_CONFIG_PREFIX = "🚫 needs owner: hub config —";
export const SYNC_CONFLICT_PREFIX = "🚫 needs owner: sync conflict";
export const CONFLICT_NEEDS_OWNER_PREFIX =
  "🚫 needs owner: conflict with pm-staging —";
export const CI_NEEDS_OWNER_PREFIX =
  "🚫 needs owner: CI still red after two fixes";
export const HEAL_GAVE_UP_PREFIX = "🚫 needs owner: two runs ended";

export const CONFLICT_DISPATCHED_PREFIX =
  "🔀 Conflict resolution dispatched → run";
export const CI_FIX_DISPATCHED_PREFIX = "🔁 CI fix dispatched → run";
export const CI_RETRIED_PREFIX = "🔁 Retried failed jobs";
export const RETRIGGERED_PREFIX = "♻️ Re-triggered → run";
/** On the sync ticket: a developer was sent to resolve a staging → integration conflict. */
export const SYNC_RESOLVE_DISPATCHED_PREFIX =
  "🔀 Sync resolution dispatched → run";

/** Linear labels (lowercase, hyphenated — created on first use). */
/** On the port ticket: a developer was sent to port verified changes onto the promotion branch. */
export const PORT_DISPATCHED_PREFIX = "🚚 Port dispatched → run";

export const LABELS = {
  epic: "pm-epic",
  tierA: "pm-tier-a",
  tierB: "pm-tier-b",
  tierC: "pm-tier-c",
  proposal: "pm-proposal",
  approved: "pm-approved",
  dispatched: "pm-dispatched",
  verified: "pm-verified",
  testFailed: "pm-test-failed",
  needsHuman: "pm-needs-human",
  ci: "pm-ci",
  /** a dispatcher-made ticket asking a developer to resolve a staging → integration sync conflict */
  sync: "pm-sync",
  /** a promotion-made ticket asking a developer to port verified changes that no longer apply on staging */
  port: "pm-port",
  /** on a PR: the owner's own work, merged into the integration branch by
   *  hand — tested by the PM and promoted like a developer's */
  owner: "pm-owner",
} as const;

/** The branch names the system creates in a target. */
export const developerBranch = (ticketIdentifier: string): string =>
  `pm/${ticketIdentifier.toLowerCase()}`;
export const releaseBranch = (area: string, yyyymmdd: string): string =>
  `pm-release/${area}/${yyyymmdd}`;
/** The branch a developer resolves a sync conflict on: integration + staging merged. */
export const SYNC_BRANCH_PREFIX = "pm-sync/";
export const syncBranch = (stagingSha: string): string =>
  `${SYNC_BRANCH_PREFIX}${stagingSha.slice(0, 12)}`;
export const SYNC_PR_TITLE = (staging: string, integration: string): string =>
  `sync: ${staging} → ${integration}`;
export const promotionTitle = (
  areaName: string,
  date: string,
  count: number,
): string =>
  `PM promotion: ${areaName} — ${date} (${count} change${count === 1 ? "" : "s"})`;

/** Parse the run id out of any "<prefix> <id>" comment; null when absent. */
export function runIdAfter(prefix: string, body: string): number | null {
  if (!body.startsWith(prefix)) return null;
  const m = body.slice(prefix.length).match(/^\s*(\d+)/);
  return m ? Number(m[1]) : null;
}

/** "🔀 Conflict resolution dispatched → run 12 (at abc123, pm-staging at def456)" */
export function parseConflictDispatch(
  body: string,
): { runId: number; mrSha: string; baseSha: string } | null {
  if (!body.startsWith(CONFLICT_DISPATCHED_PREFIX)) return null;
  const m = body.match(
    /run (\d+) \(at ([0-9a-f]+), pm-staging at ([0-9a-f]+)\)/,
  );
  if (!m) return null;
  return { runId: Number(m[1]), mrSha: m[2]!, baseSha: m[3]! };
}

/** "🚫 needs owner: merge failed at abc123 — <message>" → the sha, or null. */
export function parseMergeFailedSha(body: string): string | null {
  const m = body.match(/^🚫 needs owner: merge failed at ([0-9a-f]+) —/);
  return m ? m[1]! : null;
}

export const formatConflictDispatch = (
  runId: number,
  mrSha: string,
  baseSha: string,
): string =>
  `${CONFLICT_DISPATCHED_PREFIX} ${runId} (at ${mrSha.slice(0, 12)}, pm-staging at ${baseSha.slice(0, 12)})`;

export const formatMergeFailed = (sha: string, message: string): string =>
  `${MERGE_FAILED_PREFIX} ${sha.slice(0, 12)} — ${message}`;
