// The forge is everything the dispatcher needs from the code host. GitHub is
// the only implementation in v1 (src/forge/github.ts); src/forge/fake.ts is the
// in-memory one every dispatcher test runs against. Keep this surface small:
// a method goes here only when a dispatcher rule needs it.

/** "owner/name" */
export type RepoRef = string;

export interface PullRequest {
  number: number;
  title: string;
  body: string;
  headRef: string;
  headSha: string;
  baseRef: string;
  draft: boolean;
  state: "open" | "closed" | "merged";
  /** login of the author (the app's bot login for agent PRs, e.g. "pm-hub[bot]") */
  author: string;
  /** null while GitHub is still computing it */
  mergeable: boolean | null;
  /** GitHub's mergeable_state: clean, dirty (conflict), blocked, unstable, behind, unknown */
  mergeableState: string;
  labels: string[];
  createdAt: string;
  updatedAt: string;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  htmlUrl: string;
}

export interface Comment {
  id: number;
  body: string;
  author: string;
  createdAt: string;
}

export interface FailedJob {
  name: string;
  url: string;
  /** last ~60 lines of the job log, when the forge can fetch it */
  logTail?: string;
}

export interface CheckSummary {
  /** success = every check succeeded; failure = at least one failed; pending = some still running; none = no checks reported */
  status: "success" | "failure" | "pending" | "none";
  failedJobs: FailedJob[];
}

export interface WorkflowRun {
  id: number;
  status: "queued" | "in_progress" | "completed";
  conclusion: string | null;
  createdAt: string;
  htmlUrl: string;
}

export interface CreatePullInput {
  title: string;
  head: string;
  base: string;
  body: string;
  draft: boolean;
}

export type MergeMethod = "merge" | "squash" | "rebase";

export interface RevisionTreeEntry {
  path: string;
  sha: string;
  mode: string;
  type: string;
}

export interface PullChange {
  path: string;
  previousPath?: string;
}

export interface MergeResult {
  merged: boolean;
  sha?: string;
  /** the host's message when not merged (405-style refusals land here) */
  message?: string;
}

export interface Forge {
  /** Complete immutable tree; reject truncated results instead of proving partial inclusion. */
  getRevisionTree?(repo: RepoRef, sha: string): Promise<RevisionTreeEntry[]>;
  /** Complete changed-path set, including old paths of renames. */
  listPullChanges?(repo: RepoRef, number: number): Promise<PullChange[]>;
  // ── branches ──────────────────────────────────────────────────────────────
  getBranchSha(repo: RepoRef, branch: string): Promise<string | null>;
  /** Create an immutable sync snapshot; never update or force an existing ref. */
  createBranch?(repo: RepoRef, branch: string, sha: string): Promise<void>;
  /** how many commits `head` has that `base` lacks, and vice versa */
  compare(
    repo: RepoRef,
    base: string,
    head: string,
  ): Promise<{ aheadBy: number; behindBy: number }>;
  deleteBranch(repo: RepoRef, branch: string): Promise<void>;

  // ── pull requests ─────────────────────────────────────────────────────────
  listOpenPulls(
    repo: RepoRef,
    opts?: { base?: string; head?: string },
  ): Promise<PullRequest[]>;
  /** PRs merged into `base` since the ISO timestamp, newest first */
  listMergedPulls(
    repo: RepoRef,
    base: string,
    since: string,
  ): Promise<PullRequest[]>;
  getPull(repo: RepoRef, number: number): Promise<PullRequest | null>;
  createPull(repo: RepoRef, input: CreatePullInput): Promise<PullRequest>;
  updatePull(
    repo: RepoRef,
    number: number,
    patch: { title?: string; body?: string },
  ): Promise<void>;
  /** Change only the target branch; never merge or rewrite the source branch. */
  retargetPull?(repo: RepoRef, number: number, base: string): Promise<void>;
  markReady(repo: RepoRef, number: number): Promise<void>;
  mergePull(
    repo: RepoRef,
    number: number,
    opts: { method: MergeMethod; sha: string },
  ): Promise<MergeResult>;
  enableAutoMerge(
    repo: RepoRef,
    number: number,
    method: MergeMethod,
  ): Promise<void>;
  listPullFiles(repo: RepoRef, number: number): Promise<string[]>;
  listPullComments(repo: RepoRef, number: number): Promise<Comment[]>;
  addPullComment(repo: RepoRef, number: number, body: string): Promise<Comment>;

  // ── checks ────────────────────────────────────────────────────────────────
  getChecks(repo: RepoRef, sha: string): Promise<CheckSummary>;
  /** re-run every failed job for the sha's check runs (no-op when none) */
  rerunFailedJobs(repo: RepoRef, sha: string): Promise<void>;

  // ── workflows (always on the HUB repo) ────────────────────────────────────
  /** fire workflow_dispatch; returns the run id once GitHub has created it */
  dispatchWorkflow(
    hubRepo: RepoRef,
    workflowFile: string,
    ref: string,
    inputs: Record<string, string>,
  ): Promise<WorkflowRun>;
  getWorkflowRun(hubRepo: RepoRef, runId: number): Promise<WorkflowRun | null>;
}
