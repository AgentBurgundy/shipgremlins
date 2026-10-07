// GitHub over REST v3 + GraphQL v4 with fetch only. Everything the Forge
// interface needs and nothing more; src/forge/fake.ts mirrors the behaviour.

import { randomUUID } from "node:crypto";
import { fetchJson, fetchText, HttpError } from "../http.ts";
import type {
  CheckSummary,
  Comment,
  CreatePullInput,
  FailedJob,
  Forge,
  MergeMethod,
  MergeResult,
  PullRequest,
  PullChange,
  RevisionTreeEntry,
  RepoRef,
  WorkflowRun,
} from "./types.ts";

export interface GitHubForgeOptions {
  token: string;
  /** default https://api.github.com; GHE: https://ghe.example/api/v3 */
  apiBase?: string;
  /** ms between dispatchWorkflow polls (default 2000) */
  pollMs?: number;
  /** how many polls before giving up (default 10) */
  pollAttempts?: number;
  now?: () => Date;
}

const PAGE = 100;
const LOG_TAIL_LINES = 60;
/** clock skew allowed between us and GitHub when matching a dispatched run */
const DISPATCH_SKEW_MS = 10_000;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACTIONS_JOB_RE = /\/actions\/runs\/(\d+)\/jobs?\/(\d+)/;

interface RestPull {
  number: number;
  node_id: string;
  title: string;
  body: string | null;
  head: { ref: string; sha: string };
  base: { ref: string };
  draft: boolean;
  state: "open" | "closed";
  user: { login: string } | null;
  mergeable?: boolean | null;
  mergeable_state?: string;
  labels: { name: string }[];
  created_at: string;
  updated_at: string;
  merged_at: string | null;
  merge_commit_sha: string | null;
  html_url: string;
}

interface RestComment {
  id: number;
  body: string | null;
  user: { login: string } | null;
  created_at: string;
}

interface RestCheckRun {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  html_url: string | null;
  details_url: string | null;
  app: { slug: string } | null;
}

interface RestStatus {
  context: string;
  state: string;
  target_url: string | null;
}

interface RestRun {
  id: number;
  name: string | null;
  display_title?: string | null;
  path: string;
  status: string | null;
  conclusion: string | null;
  created_at: string;
  html_url: string;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function toPull(p: RestPull): PullRequest {
  return {
    number: p.number,
    title: p.title,
    body: p.body ?? "",
    headRef: p.head.ref,
    headSha: p.head.sha,
    baseRef: p.base.ref,
    draft: p.draft,
    state: p.merged_at ? "merged" : p.state,
    author: p.user?.login ?? "",
    mergeable: p.mergeable ?? null,
    mergeableState: p.mergeable_state ?? "unknown",
    labels: p.labels.map((l) => l.name),
    createdAt: p.created_at,
    updatedAt: p.updated_at,
    mergedAt: p.merged_at,
    mergeCommitSha: p.merge_commit_sha,
    htmlUrl: p.html_url,
  };
}

function toComment(c: RestComment): Comment {
  return {
    id: c.id,
    body: c.body ?? "",
    author: c.user?.login ?? "",
    createdAt: c.created_at,
  };
}

function toRun(r: RestRun): WorkflowRun {
  const status: WorkflowRun["status"] =
    r.status === "completed" || r.status === "in_progress"
      ? r.status
      : "queued";
  return {
    id: r.id,
    status,
    conclusion: r.conclusion,
    createdAt: r.created_at,
    htmlUrl: r.html_url,
  };
}

type CheckVerdict = "ok" | "failed" | "pending" | "ignore";

function checkRunVerdict(run: RestCheckRun): CheckVerdict {
  if (run.status !== "completed") return "pending";
  switch (run.conclusion) {
    case "success":
    case "neutral":
    case "skipped":
      return "ok";
    case "failure":
    case "timed_out":
    case "cancelled":
    case "action_required":
    case "startup_failure":
      return "failed";
    case "stale":
      return "ignore";
    default:
      return "pending";
  }
}

function statusVerdict(status: RestStatus): CheckVerdict {
  if (status.state === "success") return "ok";
  if (status.state === "failure" || status.state === "error") return "failed";
  return "pending";
}

const isActionsJob = (run: RestCheckRun): boolean =>
  run.app?.slug === "github-actions" &&
  ACTIONS_JOB_RE.test(run.details_url ?? "");

function actionsIds(
  run: RestCheckRun,
): { runId: number; jobId: number } | null {
  const m = (run.details_url ?? "").match(ACTIONS_JOB_RE);
  return m ? { runId: Number(m[1]), jobId: Number(m[2]) } : null;
}

const isoSeconds = (d: Date): string =>
  d.toISOString().replace(/\.\d{3}Z$/, "Z");

/** extra reads of an open PR while GitHub is still computing `mergeable` */
const MERGEABLE_RETRIES = 4;

export class GitHubForge implements Forge {
  private readonly token: string;
  private readonly apiBase: string;
  private readonly pollMs: number;
  private readonly pollAttempts: number;
  private readonly now: () => Date;

  constructor(opts: GitHubForgeOptions) {
    if (!opts.token) throw new Error("GitHubForge needs a token");
    this.token = opts.token;
    this.apiBase = (opts.apiBase ?? "https://api.github.com").replace(
      /\/$/,
      "",
    );
    this.pollMs = opts.pollMs ?? 2000;
    this.pollAttempts = opts.pollAttempts ?? 10;
    this.now = opts.now ?? (() => new Date());
  }

  // ── transport ─────────────────────────────────────────────────────────────

  private headers(): Record<string, string> {
    return {
      authorization: `Bearer ${this.token}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "pm-hub",
    };
  }

  private async rest<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    return fetchJson<T>(`${this.apiBase}${path}`, {
      method,
      headers: {
        ...this.headers(),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  private async restOrNull<T>(
    path: string,
    statuses: number[] = [404],
  ): Promise<T | null> {
    try {
      return await this.rest<T>("GET", path);
    } catch (err) {
      if (err instanceof HttpError && statuses.includes(err.status))
        return null;
      throw err;
    }
  }

  private async paginate<T>(
    path: string,
    params: Record<string, string> = {},
  ): Promise<T[]> {
    const out: T[] = [];
    for (let page = 1; ; page++) {
      const qs = new URLSearchParams({
        ...params,
        per_page: String(PAGE),
        page: String(page),
      });
      const items = await this.rest<T[]>("GET", `${path}?${qs}`);
      out.push(...items);
      if (items.length < PAGE) return out;
    }
  }

  private async graphql<T>(
    query: string,
    variables: Record<string, unknown>,
  ): Promise<T> {
    const res = await fetchJson<{ data?: T; errors?: { message: string }[] }>(
      `${this.apiBase}/graphql`,
      {
        method: "POST",
        headers: { ...this.headers(), "content-type": "application/json" },
        body: JSON.stringify({ query, variables }),
      },
    );
    if (res.errors?.length) {
      throw new Error(
        `GitHub GraphQL: ${res.errors.map((e) => e.message).join("; ")}`,
      );
    }
    if (!res.data) throw new Error("GitHub GraphQL: empty response");
    return res.data;
  }

  private async pullNodeId(repo: RepoRef, number: number): Promise<string> {
    const p = await this.rest<RestPull>(
      "GET",
      `/repos/${repo}/pulls/${number}`,
    );
    return p.node_id;
  }

  // ── branches ──────────────────────────────────────────────────────────────

  async getBranchSha(repo: RepoRef, branch: string): Promise<string | null> {
    const b = await this.restOrNull<{ commit: { sha: string } }>(
      `/repos/${repo}/branches/${encodeURIComponent(branch)}`,
    );
    return b?.commit.sha ?? null;
  }

  async compare(
    repo: RepoRef,
    base: string,
    head: string,
  ): Promise<{ aheadBy: number; behindBy: number }> {
    const c = await this.rest<{ ahead_by: number; behind_by: number }>(
      "GET",
      `/repos/${repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`,
    );
    return { aheadBy: c.ahead_by, behindBy: c.behind_by };
  }

  async createBranch(
    repo: RepoRef,
    branch: string,
    sha: string,
  ): Promise<void> {
    await this.rest("POST", `/repos/${repo}/git/refs`, {
      ref: `refs/heads/${branch}`,
      sha,
    });
  }

  async deleteBranch(repo: RepoRef, branch: string): Promise<void> {
    try {
      await this.rest<null>(
        "DELETE",
        `/repos/${repo}/git/refs/heads/${branch}`,
      );
    } catch (err) {
      // 422 "Reference does not exist" / 404: already gone, which is the goal
      if (
        err instanceof HttpError &&
        (err.status === 422 || err.status === 404)
      )
        return;
      throw err;
    }
  }

  // ── pull requests ─────────────────────────────────────────────────────────

  async listOpenPulls(
    repo: RepoRef,
    opts: { base?: string; head?: string } = {},
  ): Promise<PullRequest[]> {
    const owner = repo.split("/")[0] ?? "";
    const params: Record<string, string> = {
      state: "open",
      sort: "created",
      direction: "asc",
    };
    if (opts.base) params.base = opts.base;
    if (opts.head) params.head = `${owner}:${opts.head}`;
    const listed = await this.paginate<RestPull>(
      `/repos/${repo}/pulls`,
      params,
    );
    // the list endpoint omits mergeable_state; only GET /pulls/{n} computes it
    const detailed = await Promise.all(
      listed.map((p) => this.getPull(repo, p.number)),
    );
    return detailed.filter((p): p is PullRequest => p !== null);
  }

  async listMergedPulls(
    repo: RepoRef,
    base: string,
    since: string,
  ): Promise<PullRequest[]> {
    const sinceQ = since.replace(/\.\d{3}Z$/, "Z").replace(/Z$/, "+00:00");
    const q = `is:pr is:merged base:${base} repo:${repo} merged:>=${sinceQ}`;
    const qs = new URLSearchParams({
      q,
      sort: "updated",
      order: "desc",
      per_page: "100",
    });
    const res = await this.rest<{ items: { number: number }[] }>(
      "GET",
      `/search/issues?${qs}`,
    );
    const pulls = await Promise.all(
      res.items.slice(0, 100).map((i) => this.getPull(repo, i.number)),
    );
    return pulls
      .filter((p): p is PullRequest => p !== null && p.mergedAt !== null)
      .sort((a, b) => (b.mergedAt ?? "").localeCompare(a.mergedAt ?? ""));
  }

  async getPull(repo: RepoRef, number: number): Promise<PullRequest | null> {
    // GitHub computes mergeability in the background: the first read of an
    // open PR after a push or a merge into its base says `mergeable: null`
    // / "unknown". Ask again a few times rather than hand rules a non-answer.
    for (let attempt = 0; ; attempt++) {
      const p = await this.restOrNull<RestPull>(
        `/repos/${repo}/pulls/${number}`,
      );
      if (!p) return null;
      const settled = p.state !== "open" || (p.mergeable ?? null) !== null;
      if (settled || attempt >= MERGEABLE_RETRIES) return toPull(p);
      await new Promise((r) => setTimeout(r, this.pollMs));
    }
  }

  async createPull(
    repo: RepoRef,
    input: CreatePullInput,
  ): Promise<PullRequest> {
    const p = await this.rest<RestPull>("POST", `/repos/${repo}/pulls`, input);
    return toPull(p);
  }

  async updatePull(
    repo: RepoRef,
    number: number,
    patch: { title?: string; body?: string },
  ): Promise<void> {
    await this.rest<RestPull>("PATCH", `/repos/${repo}/pulls/${number}`, patch);
  }

  async retargetPull(
    repo: RepoRef,
    number: number,
    base: string,
  ): Promise<void> {
    await this.rest("PATCH", `/repos/${repo}/pulls/${number}`, { base });
  }

  async markReady(repo: RepoRef, number: number): Promise<void> {
    const id = await this.pullNodeId(repo, number);
    await this.graphql(
      `mutation MarkReady($id: ID!) {
        markPullRequestReadyForReview(input: { pullRequestId: $id }) {
          pullRequest { isDraft }
        }
      }`,
      { id },
    );
  }

  async closePull(repo: RepoRef, number: number): Promise<void> {
    await this.rest("PATCH", `/repos/${repo}/pulls/${number}`, {
      state: "closed",
    });
  }

  async mergePull(
    repo: RepoRef,
    number: number,
    opts: { method: MergeMethod; sha: string },
  ): Promise<MergeResult> {
    try {
      const res = await this.rest<{
        sha: string;
        merged: boolean;
        message: string;
      }>("PUT", `/repos/${repo}/pulls/${number}/merge`, {
        merge_method: opts.method,
        sha: opts.sha,
      });
      return { merged: res.merged, sha: res.sha, message: res.message };
    } catch (err) {
      // 405 not mergeable · 409 head sha moved · 422 validation — all refusals
      if (err instanceof HttpError && [405, 409, 422].includes(err.status)) {
        const parsed = err.json() as { message?: string } | null;
        return { merged: false, message: parsed?.message ?? err.body };
      }
      throw err;
    }
  }

  async enableAutoMerge(
    repo: RepoRef,
    number: number,
    method: MergeMethod,
  ): Promise<void> {
    const id = await this.pullNodeId(repo, number);
    await this.graphql(
      `mutation EnableAutoMerge($id: ID!, $method: PullRequestMergeMethod!) {
        enablePullRequestAutoMerge(input: { pullRequestId: $id, mergeMethod: $method }) {
          pullRequest { id }
        }
      }`,
      { id, method: method.toUpperCase() },
    );
  }

  async listPullFiles(repo: RepoRef, number: number): Promise<string[]> {
    const files = await this.paginate<{ filename: string }>(
      `/repos/${repo}/pulls/${number}/files`,
    );
    return files.map((f) => f.filename);
  }

  async listPullChanges(repo: RepoRef, number: number): Promise<PullChange[]> {
    const files = await this.paginate<{
      filename: string;
      previous_filename?: string;
    }>(`/repos/${repo}/pulls/${number}/files`);
    // GitHub caps this endpoint at 3,000 files. Exactly 3,000 is ambiguous.
    if (files.length >= 3000)
      throw new Error(`PR #${number}: changed-file list may be truncated`);
    return files.map((f) => ({
      path: f.filename,
      ...(f.previous_filename ? { previousPath: f.previous_filename } : {}),
    }));
  }

  async getRevisionTree(
    repo: RepoRef,
    sha: string,
  ): Promise<RevisionTreeEntry[]> {
    const commit = await this.rest<{ sha: string; tree: { sha: string } }>(
      "GET",
      `/repos/${repo}/git/commits/${encodeURIComponent(sha)}`,
    );
    if (commit.sha !== sha)
      throw new Error("Revision tree requires an exact commit SHA");
    const tree = await this.rest<{
      truncated: boolean;
      tree: RevisionTreeEntry[];
    }>(
      "GET",
      `/repos/${repo}/git/trees/${encodeURIComponent(commit.tree.sha)}?recursive=1`,
    );
    if (tree.truncated !== false || !Array.isArray(tree.tree))
      throw new Error(
        `Commit ${sha}: incomplete tree cannot establish production inclusion`,
      );
    return tree.tree;
  }

  async listPullComments(repo: RepoRef, number: number): Promise<Comment[]> {
    const comments = await this.paginate<RestComment>(
      `/repos/${repo}/issues/${number}/comments`,
    );
    return comments.map(toComment);
  }

  async addPullComment(
    repo: RepoRef,
    number: number,
    body: string,
  ): Promise<Comment> {
    const c = await this.rest<RestComment>(
      "POST",
      `/repos/${repo}/issues/${number}/comments`,
      {
        body,
      },
    );
    return toComment(c);
  }

  // ── checks ────────────────────────────────────────────────────────────────

  private async checkRuns(repo: RepoRef, sha: string): Promise<RestCheckRun[]> {
    const res = await this.rest<{ check_runs: RestCheckRun[] }>(
      "GET",
      `/repos/${repo}/commits/${sha}/check-runs?per_page=${PAGE}`,
    );
    return res.check_runs;
  }

  private async jobLogTail(
    repo: RepoRef,
    jobId: number,
  ): Promise<string | undefined> {
    try {
      const text = await fetchText(
        `${this.apiBase}/repos/${repo}/actions/jobs/${jobId}/logs`,
        {
          headers: this.headers(),
        },
      );
      return text.trimEnd().split("\n").slice(-LOG_TAIL_LINES).join("\n");
    } catch {
      return undefined;
    }
  }

  /** Legacy commit statuses (third-party CI). Needs the app's "Commit
   *  statuses: read"; without it GitHub answers 403, which must not take the
   *  whole check down — Actions report through check-runs, read separately. */
  private async combinedStatuses(
    repo: RepoRef,
    sha: string,
  ): Promise<RestStatus[]> {
    try {
      const combined = await this.rest<{ statuses: RestStatus[] }>(
        "GET",
        `/repos/${repo}/commits/${sha}/status`,
      );
      return combined.statuses;
    } catch (err) {
      if (
        err instanceof HttpError &&
        (err.status === 403 || err.status === 404)
      )
        return [];
      throw err;
    }
  }

  async getChecks(repo: RepoRef, sha: string): Promise<CheckSummary> {
    const [runs, statuses] = await Promise.all([
      this.checkRuns(repo, sha),
      this.combinedStatuses(repo, sha),
    ]);
    let failed = false;
    let pending = false;
    let any = false;
    const failedJobs: FailedJob[] = [];
    for (const run of runs) {
      const verdict = checkRunVerdict(run);
      if (verdict === "ignore") continue;
      any = true;
      if (verdict === "pending") pending = true;
      if (verdict !== "failed") continue;
      failed = true;
      const job: FailedJob = {
        name: run.name,
        url: run.html_url ?? run.details_url ?? "",
      };
      const ids = isActionsJob(run) ? actionsIds(run) : null;
      if (ids) {
        const tail = await this.jobLogTail(repo, ids.jobId);
        if (tail !== undefined) job.logTail = tail;
      }
      failedJobs.push(job);
    }
    for (const status of statuses) {
      any = true;
      const verdict = statusVerdict(status);
      if (verdict === "pending") pending = true;
      if (verdict !== "failed") continue;
      failed = true;
      failedJobs.push({ name: status.context, url: status.target_url ?? "" });
    }
    const status: CheckSummary["status"] = failed
      ? "failure"
      : pending
        ? "pending"
        : any
          ? "success"
          : "none";
    return { status, failedJobs };
  }

  async rerunFailedJobs(repo: RepoRef, sha: string): Promise<void> {
    const runs = await this.checkRuns(repo, sha);
    const runIds = new Set<number>();
    for (const run of runs) {
      if (checkRunVerdict(run) !== "failed" || !isActionsJob(run)) continue;
      const ids = actionsIds(run);
      if (ids) runIds.add(ids.runId);
    }
    for (const runId of runIds) {
      await this.rest<null>(
        "POST",
        `/repos/${repo}/actions/runs/${runId}/rerun-failed-jobs`,
      );
    }
  }

  // ── workflows ─────────────────────────────────────────────────────────────

  async dispatchWorkflow(
    hubRepo: RepoRef,
    workflowFile: string,
    ref: string,
    inputs: Record<string, string>,
  ): Promise<WorkflowRun> {
    const marker = randomUUID();
    const firedAt = this.now();
    await this.rest<null>(
      "POST",
      `/repos/${hubRepo}/actions/workflows/${encodeURIComponent(workflowFile)}/dispatches`,
      { ref, inputs: { ...inputs, marker } },
    );
    const floor = new Date(firedAt.getTime() - DISPATCH_SKEW_MS);
    const qs = new URLSearchParams({
      event: "workflow_dispatch",
      created: `>=${isoSeconds(floor)}`,
      per_page: "50",
    });
    for (let attempt = 0; attempt < this.pollAttempts; attempt++) {
      if (attempt > 0) await sleep(this.pollMs);
      const res = await this.rest<{ workflow_runs: RestRun[] }>(
        "GET",
        `/repos/${hubRepo}/actions/runs?${qs}`,
      );
      const candidates = res.workflow_runs
        .filter(
          (r) => r.path.endsWith(`/${workflowFile}`) || r.path === workflowFile,
        )
        .filter((r) => Date.parse(r.created_at) >= floor.getTime())
        .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
      const mine = candidates.find(
        (r) => r.name === marker || r.display_title === marker,
      );
      if (mine) return toRun(mine);
      // when the workflow echoes markers (run-name), a run that isn't ours is
      // someone else's dispatch — keep waiting for ours instead of taking it
      const echoes = candidates.some(
        (r) =>
          UUID_RE.test(r.name ?? "") || UUID_RE.test(r.display_title ?? ""),
      );
      if (!echoes && candidates[0]) return toRun(candidates[0]);
    }
    throw new Error(
      `workflow_dispatch of ${workflowFile} on ${hubRepo} was accepted but no run appeared within ${Math.round((this.pollAttempts * this.pollMs) / 1000)}s`,
    );
  }

  async getWorkflowRun(
    hubRepo: RepoRef,
    runId: number,
  ): Promise<WorkflowRun | null> {
    const r = await this.restOrNull<RestRun>(
      `/repos/${hubRepo}/actions/runs/${runId}`,
    );
    return r ? toRun(r) : null;
  }
}
