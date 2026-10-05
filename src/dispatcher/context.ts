// What every dispatcher rule receives. Rules are pure functions of this
// context: they read through the clients, write through the clients, and
// return digest rows. Nothing reads process.env below this line.

import type { Forge, CheckSummary } from "../forge/types.ts";
import type {
  LinearClient,
  VercelClient,
  SlackClient,
  Deployment,
} from "../services/types.ts";
import type { HubConfig, Project } from "../config.ts";

export interface DigestRow {
  /** which rule produced it */
  rule: "sync" | "line" | "heal" | "repair" | "merge" | "dispatch" | "promote";
  /** one line, plain language, Slack-ready */
  text: string;
  /** true = the owner must act; lands under "Needs you" in the report */
  needsYou?: boolean;
  /** PR number / ticket identifier / run id for the dashboard, when there is one */
  ref?: string;
  /** true = nothing is wrong, the dispatcher is only early (checks still
   *  running, GitHub still computing mergeability): the workflow comes back
   *  in a few minutes instead of waiting for the next cron */
  pending?: boolean;
}

export interface Ctx {
  forge: Forge;
  linear: LinearClient;
  vercel: VercelClient;
  slack: SlackClient;
  hub: HubConfig;
  project: Project;
  /** injectable clock */
  now: () => Date;
  /** when true, every write is logged and skipped */
  dryRun: boolean;
  log: (line: string) => void;
  /** the app's bot login, e.g. "pm-hub[bot]" — PRs by anyone else are ignored */
  botLogin: string;
  /** Controller-only provider adapter. Must identify the actual deployed revision. */
  resolveDeployment?: (
    branch: string,
    sha: string,
  ) => Promise<Deployment | null>;
  /** Local exact-revision configured-check receipt, used only when the provider has no checks. */
  resolveChecks?: (sha: string) => Promise<CheckSummary>;
}

/** The repo shorthand every rule uses. */
export const repoOf = (ctx: Ctx): string => ctx.project.config.repo;
export const branchesOf = (ctx: Ctx) => ctx.project.config.branches;
