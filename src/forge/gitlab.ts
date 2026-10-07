import type {
  CheckSummary,
  Comment,
  CreatePullInput,
  Forge,
  MergeMethod,
  MergeResult,
  PullChange,
  PullRequest,
  RevisionTreeEntry,
  WorkflowRun,
} from "./types.ts";

type Row = Record<string, unknown>;
const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const object = (v: unknown): v is Row =>
  !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown) => (typeof v === "string" ? v : "");
const id = (v: number) => {
  if (!Number.isSafeInteger(v) || v < 1)
    throw new Error("Use a valid GitLab resource ID.");
  return String(v);
};
const revision = (v: string) => {
  if (!SHA.test(v))
    throw new Error("GitLab provenance requires a full commit SHA.");
  return v;
};
class GitLabError extends Error {
  constructor(readonly status: number) {
    super(
      `GitLab request failed (${status}); check repository access and retry.`,
    );
  }
}

/** Repository operations only. Local workers do not require a GitLab CI workspace. */
export class GitLabForge implements Forge {
  private readonly base: string;
  private readonly transport: typeof fetch;
  constructor(
    private readonly options: {
      token: string;
      serverUrl?: string;
      fetch?: typeof fetch;
    },
  ) {
    const url = new URL(options.serverUrl ?? "https://gitlab.com");
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !["", "/"].includes(url.pathname) ||
      !options.token ||
      /[\r\n\0]/.test(options.token)
    )
      throw new Error("Use a GitLab HTTPS origin and a saved credential.");
    this.base = `${url.origin}/api/v4`;
    this.transport = options.fetch ?? fetch;
  }
  private project(repo: string) {
    if (
      !/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+$/.test(repo) ||
      repo.split("/").some((p) => [".", ".."].includes(p))
    )
      throw new Error("Use a valid GitLab project path.");
    return `/projects/${encodeURIComponent(repo)}`;
  }
  private async request(
    path: string,
    method = "GET",
    body?: unknown,
  ): Promise<{ value: unknown; next: string | null }> {
    let response: Response;
    try {
      response = await this.transport(this.base + path, {
        method,
        redirect: "error",
        signal: AbortSignal.timeout(30000),
        headers: {
          authorization: `Bearer ${this.options.token}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new Error(
        "GitLab could not be reached; no provider response or credential was logged.",
      );
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new GitLabError(response.status);
    }
    const length = Number(response.headers.get("content-length") ?? "0");
    if (length > 16 * 1024 * 1024) {
      await response.body?.cancel();
      throw new Error("GitLab response exceeds the safe read limit.");
    }
    const text = await response.text();
    if (Buffer.byteLength(text) > 16 * 1024 * 1024)
      throw new Error("GitLab response exceeds the safe read limit.");
    let value: unknown;
    try {
      value = text ? JSON.parse(text) : null;
    } catch {
      throw new Error(
        "GitLab returned malformed JSON; no provider response was logged.",
      );
    }
    return {
      value,
      next: response.headers.get("x-next-page"),
    };
  }
  private async one(path: string): Promise<Row | null> {
    try {
      const { value } = await this.request(path);
      if (!object(value))
        throw new Error("GitLab returned an invalid resource.");
      return value;
    } catch (error) {
      if (error instanceof GitLabError && error.status === 404) return null;
      throw error;
    }
  }
  private async pages(
    path: string,
    params: Record<string, string> = {},
  ): Promise<Row[]> {
    const out: Row[] = [];
    for (let page = 1; page <= 1000; page++) {
      const { value, next } = await this.request(
        `${path}?${new URLSearchParams({ ...params, per_page: "100", page: String(page) })}`,
      );
      if (!Array.isArray(value) || !value.every(object))
        throw new Error("GitLab returned an invalid page.");
      out.push(...value);
      if (next === "" || (next === null && value.length < 100)) return out;
      if (next !== null && next !== String(page + 1))
        throw new Error("GitLab pagination is incomplete.");
    }
    throw new Error(
      "GitLab result is too large to prove complete; narrow the operation.",
    );
  }
  private pull(row: Row): PullRequest {
    const author = object(row.author) ? str(row.author.username) : "";
    const status = str(row.detailed_merge_status || row.merge_status);
    return {
      number: Number(row.iid),
      title: str(row.title),
      body: str(row.description),
      headRef: str(row.source_branch),
      headSha: str(row.sha),
      baseRef: str(row.target_branch),
      draft: row.draft === true || row.work_in_progress === true,
      state:
        row.state === "merged"
          ? "merged"
          : row.state === "opened"
            ? "open"
            : "closed",
      author,
      mergeable:
        status === "mergeable"
          ? true
          : ["checking", "unchecked", "preparing", ""].includes(status)
            ? null
            : false,
      mergeableState:
        status === "mergeable"
          ? "clean"
          : status === "conflict"
            ? "dirty"
            : ["checking", "unchecked", "preparing", ""].includes(status)
              ? "unknown"
              : "blocked",
      labels: Array.isArray(row.labels)
        ? row.labels.filter((s): s is string => typeof s === "string")
        : [],
      createdAt: str(row.created_at),
      updatedAt: str(row.updated_at),
      mergedAt: typeof row.merged_at === "string" ? row.merged_at : null,
      mergeCommitSha:
        typeof row.merge_commit_sha === "string"
          ? row.merge_commit_sha
          : typeof row.squash_commit_sha === "string"
            ? row.squash_commit_sha
            : null,
      htmlUrl: str(row.web_url),
    };
  }
  async getBranchSha(repo: string, branch: string) {
    const value = await this.one(
      `${this.project(repo)}/repository/branches/${encodeURIComponent(branch)}`,
    );
    return value && object(value.commit) ? str(value.commit.id) || null : null;
  }
  async createBranch(repo: string, branch: string, sha: string): Promise<void> {
    revision(sha);
    await this.request(`${this.project(repo)}/repository/branches`, "POST", {
      branch,
      ref: sha,
    });
  }
  async compare(repo: string, base: string, head: string) {
    if (base === head) return { aheadBy: 0, behindBy: 0 };
    const prefix = this.project(repo);
    const compare = async (from: string, to: string) => {
      const v = await this.one(
        `${prefix}/repository/compare?${new URLSearchParams({ from, to })}`,
      );
      if (!v || v.compare_timeout === true || !Array.isArray(v.commits))
        throw new Error(
          "GitLab comparison is incomplete; ancestry was not proven.",
        );
      return v.commits.length;
    };
    const [aheadBy, behindBy] = await Promise.all([
      compare(base, head),
      compare(head, base),
    ]);
    return { aheadBy, behindBy };
  }
  async deleteBranch(repo: string, branch: string) {
    try {
      await this.request(
        `${this.project(repo)}/repository/branches/${encodeURIComponent(branch)}`,
        "DELETE",
      );
    } catch (error) {
      if (!(error instanceof GitLabError && error.status === 404)) throw error;
    }
  }
  async listOpenPulls(
    repo: string,
    opts: { base?: string; head?: string } = {},
  ) {
    return (
      await this.pages(`${this.project(repo)}/merge_requests`, {
        state: "opened",
        scope: "all",
        ...(opts.base ? { target_branch: opts.base } : {}),
        ...(opts.head ? { source_branch: opts.head } : {}),
      })
    ).map((row) => this.pull(row));
  }
  async listMergedPulls(repo: string, base: string, since: string) {
    return (
      await this.pages(`${this.project(repo)}/merge_requests`, {
        state: "merged",
        scope: "all",
        target_branch: base,
        updated_after: since,
        order_by: "updated_at",
        sort: "desc",
      })
    )
      .map((row) => this.pull(row))
      .filter((p) => p.mergedAt && p.mergedAt >= since)
      .sort((a, b) => (b.mergedAt ?? "").localeCompare(a.mergedAt ?? ""));
  }
  async getPull(repo: string, number: number) {
    const row = await this.one(
      `${this.project(repo)}/merge_requests/${id(number)}`,
    );
    return row ? this.pull(row) : null;
  }
  async createPull(repo: string, input: CreatePullInput) {
    const { value } = await this.request(
      `${this.project(repo)}/merge_requests`,
      "POST",
      {
        source_branch: input.head,
        target_branch: input.base,
        title:
          input.draft && !/^Draft:/i.test(input.title)
            ? `Draft: ${input.title}`
            : input.title,
        description: input.body,
      },
    );
    if (!object(value))
      throw new Error("GitLab did not return the created merge request.");
    return this.pull(value);
  }
  async updatePull(
    repo: string,
    number: number,
    patch: { title?: string; body?: string },
  ) {
    await this.request(
      `${this.project(repo)}/merge_requests/${id(number)}`,
      "PUT",
      {
        ...(patch.title === undefined ? {} : { title: patch.title }),
        ...(patch.body === undefined ? {} : { description: patch.body }),
      },
    );
  }
  async markReady(repo: string, number: number) {
    const pull = await this.getPull(repo, number);
    if (!pull) throw new Error("GitLab merge request is unavailable.");
    await this.updatePull(repo, number, {
      title: pull.title.replace(/^(?:Draft:|WIP:)\s*/i, ""),
    });
  }
  async mergePull(
    repo: string,
    number: number,
    opts: { method: MergeMethod; sha: string },
  ): Promise<MergeResult> {
    revision(opts.sha);
    if (opts.method === "rebase")
      return {
        merged: false,
        message:
          "GitLab merge strategy is configured on the project; use merge or squash.",
      };
    try {
      const { value } = await this.request(
        `${this.project(repo)}/merge_requests/${id(number)}/merge`,
        "PUT",
        {
          sha: opts.sha,
          squash: opts.method === "squash",
          should_remove_source_branch: true,
        },
      );
      if (!object(value)) throw new Error("Invalid merge response.");
      const p = this.pull(value);
      return {
        merged: p.state === "merged",
        ...(p.mergeCommitSha ? { sha: p.mergeCommitSha } : {}),
      };
    } catch (error) {
      if (
        error instanceof GitLabError &&
        [405, 406, 409, 422].includes(error.status)
      )
        return {
          merged: false,
          message:
            "GitLab refused this exact-head merge; recheck approval, conflicts and checks.",
        };
      throw error;
    }
  }
  async enableAutoMerge(
    _repo: string,
    _number: number,
    _method: MergeMethod,
  ): Promise<void> {
    throw new Error(
      "GitLab automatic merge is not enabled by this adapter. Use the guarded exact-head merge operation.",
    );
  }
  async listPullChanges(repo: string, number: number): Promise<PullChange[]> {
    const detail = await this.one(
      `${this.project(repo)}/merge_requests/${id(number)}`,
    );
    if (
      !detail ||
      typeof detail.changes_count !== "string" ||
      !/^\d+$/.test(detail.changes_count)
    )
      throw new Error("GitLab changed-file count is unavailable or truncated.");
    const rows = await this.pages(
      `${this.project(repo)}/merge_requests/${id(number)}/diffs`,
    );
    if (
      rows.length !== Number(detail.changes_count) ||
      rows.some(
        (row) =>
          !str(row.new_path) || !str(row.old_path) || row.too_large === true,
      )
    )
      throw new Error(
        "GitLab diff is incomplete; delivery inclusion cannot be proven.",
      );
    return rows.map((row) => ({
      path: str(row.new_path),
      ...(row.renamed_file === true ? { previousPath: str(row.old_path) } : {}),
    }));
  }
  async listPullFiles(repo: string, number: number) {
    const changes = await this.listPullChanges(repo, number);
    return [
      ...new Set(
        changes.flatMap((c) =>
          c.previousPath ? [c.path, c.previousPath] : [c.path],
        ),
      ),
    ];
  }
  async getRevisionTree(
    repo: string,
    sha: string,
  ): Promise<RevisionTreeEntry[]> {
    revision(sha);
    const commit = await this.one(
      `${this.project(repo)}/repository/commits/${sha}`,
    );
    if (commit?.id !== sha)
      throw new Error("GitLab tree must resolve the exact commit.");
    return (
      await this.pages(`${this.project(repo)}/repository/tree`, {
        ref: sha,
        recursive: "true",
      })
    ).map((row) => {
      if (
        !SHA.test(str(row.id)) ||
        !str(row.path) ||
        !str(row.mode) ||
        !["blob", "tree", "commit"].includes(str(row.type))
      )
        throw new Error("GitLab returned an invalid revision tree.");
      return {
        path: str(row.path),
        sha: str(row.id),
        mode: str(row.mode),
        type: str(row.type),
      };
    });
  }
  private comment(row: Row): Comment {
    return {
      id: Number(row.id),
      body: str(row.body),
      author: object(row.author) ? str(row.author.username) : "",
      createdAt: str(row.created_at),
    };
  }
  async listPullComments(repo: string, number: number) {
    return (
      await this.pages(
        `${this.project(repo)}/merge_requests/${id(number)}/notes`,
        { order_by: "created_at", sort: "asc" },
      )
    )
      .filter((row) => row.system !== true)
      .map((row) => this.comment(row));
  }
  async addPullComment(repo: string, number: number, body: string) {
    const { value } = await this.request(
      `${this.project(repo)}/merge_requests/${id(number)}/notes`,
      "POST",
      { body },
    );
    if (!object(value))
      throw new Error("GitLab did not return the saved comment.");
    return this.comment(value);
  }
  private async pipeline(repo: string, sha: string) {
    revision(sha);
    return (
      (
        await this.pages(`${this.project(repo)}/pipelines`, {
          sha,
          order_by: "id",
          sort: "desc",
        })
      )[0] ?? null
    );
  }
  async getChecks(repo: string, sha: string): Promise<CheckSummary> {
    const pipeline = await this.pipeline(repo, sha);
    if (!pipeline) return { status: "none", failedJobs: [] };
    const detail = await this.one(
      `${this.project(repo)}/pipelines/${id(Number(pipeline.id))}`,
    );
    if (detail?.sha !== sha)
      throw new Error("GitLab pipeline does not match the requested revision.");
    const jobs = await this.pages(
      `${this.project(repo)}/pipelines/${id(Number(pipeline.id))}/jobs`,
      { include_retried: "false" },
    );
    const external = await this.pages(
      `${this.project(repo)}/repository/commits/${sha}/statuses`,
      { all: "false" },
    );
    const checks = [...jobs, ...external];
    const failed = checks.filter((row) =>
      ["failed", "canceled"].includes(str(row.status)),
    );
    return {
      status:
        failed.length || ["failed", "canceled"].includes(str(detail.status))
          ? "failure"
          : !checks.length
            ? "none"
            : detail.status === "success" &&
                checks.every((row) => row.status === "success")
              ? "success"
              : "pending",
      failedJobs: failed.map((row) => ({
        name: str(row.name),
        url: str(row.web_url || row.target_url),
      })),
    };
  }
  async rerunFailedJobs(repo: string, sha: string) {
    const pipeline = await this.pipeline(repo, sha);
    if (pipeline)
      await this.request(
        `${this.project(repo)}/pipelines/${id(Number(pipeline.id))}/retry`,
        "POST",
      );
  }
  async dispatchWorkflow(
    _repo: string,
    _workflow: string,
    _ref: string,
    _inputs: Record<string, string>,
  ): Promise<WorkflowRun> {
    throw new Error(
      "Use local Docker workers for GitLab projects; GitHub Actions workflow dispatch is not portable to GitLab CI.",
    );
  }
  async getWorkflowRun(
    repo: string,
    runId: number,
  ): Promise<WorkflowRun | null> {
    const row = await this.one(`${this.project(repo)}/pipelines/${id(runId)}`);
    if (!row) return null;
    const status = str(row.status);
    return {
      id: Number(row.id),
      status: ["success", "failed", "canceled", "skipped"].includes(status)
        ? "completed"
        : status === "running"
          ? "in_progress"
          : "queued",
      conclusion:
        status === "success"
          ? "success"
          : status === "failed"
            ? "failure"
            : status === "canceled"
              ? "cancelled"
              : null,
      createdAt: str(row.created_at),
      htmlUrl: str(row.web_url),
    };
  }
}
