// In-memory forge for dispatcher tests. Seed state with the seed* methods,
// run a rule, then assert on the public arrays (merged, dispatched, …) and
// on comments(). Behaviour mirrors GitHub closely enough for the rules:
// mergeable follows mergeableState, merging closes the PR and moves the base
// branch, markReady flips draft, dispatchWorkflow records and creates a run.

import type {
  CheckSummary,
  Comment,
  CreatePullInput,
  Forge,
  MergeMethod,
  MergeResult,
  PullRequest,
  PullChange,
  RevisionTreeEntry,
  RepoRef,
  WorkflowRun,
} from "./types.ts";

let nextId = 1000;
const sha = (): string =>
  (nextId++).toString(16).padStart(8, "0") + "deadbeefcafe0000000000000000";

export interface SeedPull extends Partial<
  Omit<PullRequest, "number" | "headSha" | "author">
> {
  number?: number;
  headSha?: string;
  author?: string;
}

export class FakeForge implements Forge {
  readonly botLogin: string;
  readonly hubRepo: string;
  /** PR numbers merged, in order */
  readonly merged: number[] = [];
  /** PR numbers marked ready, in order */
  readonly readied: number[] = [];
  /** PR numbers auto-merge was enabled on */
  readonly autoMerged: number[] = [];
  /** every workflow_dispatch, in order */
  readonly dispatched: {
    workflowFile: string;
    ref: string;
    inputs: Record<string, string>;
    runId: number;
  }[] = [];
  /** shas whose failed jobs were re-run */
  readonly reruns: string[] = [];
  readonly deletedBranches: string[] = [];
  /** set to make the next mergePull refuse with this message (GitHub 405 style) */
  nextMergeRefusal: string | null = null;

  private branches = new Map<string, string>(); // `${repo}#${branch}` → sha
  private revisionTrees = new Map<string, RevisionTreeEntry[]>();
  private pullChanges = new Map<string, PullChange[]>();
  private pulls = new Map<string, PullRequest>(); // `${repo}#${n}`
  private pullFiles = new Map<string, string[]>();
  private pullComments = new Map<string, Comment[]>();
  private checks = new Map<string, CheckSummary>(); // `${repo}#${sha}`
  private runs = new Map<number, WorkflowRun>();
  private compares = new Map<string, { aheadBy: number; behindBy: number }>();
  private pullNo = 1;
  private commentId = 1;
  private runNo = 1;
  private clock: () => Date;

  constructor(
    opts: { botLogin?: string; hubRepo?: string; now?: () => Date } = {},
  ) {
    this.botLogin = opts.botLogin ?? "pm-hub[bot]";
    this.hubRepo = opts.hubRepo ?? "owner/pm-hub";
    this.clock = opts.now ?? (() => new Date("2026-10-02T12:00:00Z"));
  }

  // ── seeding ───────────────────────────────────────────────────────────────
  seedRevisionTree(
    repo: RepoRef,
    sha: string,
    tree: RevisionTreeEntry[],
  ): void {
    this.revisionTrees.set(`${repo}#${sha}`, tree);
  }
  seedPullChanges(repo: RepoRef, number: number, changes: PullChange[]): void {
    this.pullChanges.set(`${repo}#${number}`, changes);
  }
  async getRevisionTree(
    repo: RepoRef,
    sha: string,
  ): Promise<RevisionTreeEntry[]> {
    const tree = this.revisionTrees.get(`${repo}#${sha}`);
    if (!tree) throw new Error(`no revision tree for ${sha}`);
    return tree;
  }
  async listPullChanges(repo: RepoRef, number: number): Promise<PullChange[]> {
    return (
      this.pullChanges.get(`${repo}#${number}`) ??
      (this.pullFiles.get(`${repo}#${number}`) ?? []).map((path) => ({ path }))
    );
  }
  seedBranch(repo: RepoRef, branch: string, at: string = sha()): string {
    this.branches.set(`${repo}#${branch}`, at);
    return at;
  }
  /** what compare(repo, base, head) answers; defaults to 0/0 */
  seedCompare(
    repo: RepoRef,
    base: string,
    head: string,
    v: { aheadBy: number; behindBy: number },
  ): void {
    this.compares.set(`${repo}#${base}..${head}`, v);
  }
  seedPull(repo: RepoRef, p: SeedPull, files: string[] = []): PullRequest {
    const number = p.number ?? this.pullNo++;
    if (p.number && p.number >= this.pullNo) this.pullNo = p.number + 1;
    const now = this.clock().toISOString();
    const pr: PullRequest = {
      number,
      title: p.title ?? `PR ${number}`,
      body: p.body ?? "",
      headRef: p.headRef ?? `pm/t-${number}`,
      headSha: p.headSha ?? sha(),
      baseRef: p.baseRef ?? "pm-staging",
      draft: p.draft ?? true,
      state: p.state ?? "open",
      author: p.author ?? this.botLogin,
      mergeable: p.mergeable ?? (p.mergeableState === "dirty" ? false : true),
      mergeableState: p.mergeableState ?? "clean",
      labels: p.labels ?? [],
      createdAt: p.createdAt ?? now,
      updatedAt: p.updatedAt ?? now,
      mergedAt: p.mergedAt ?? null,
      mergeCommitSha: p.mergeCommitSha ?? null,
      htmlUrl: `https://github.com/${repo}/pull/${number}`,
    };
    this.pulls.set(`${repo}#${number}`, pr);
    this.pullFiles.set(`${repo}#${number}`, files);
    if (!this.pullComments.has(`${repo}#${number}`))
      this.pullComments.set(`${repo}#${number}`, []);
    this.branches.set(`${repo}#${pr.headRef}`, pr.headSha);
    return pr;
  }
  seedComment(
    repo: RepoRef,
    number: number,
    body: string,
    author = this.botLogin,
    createdAt?: string,
  ): Comment {
    const c: Comment = {
      id: this.commentId++,
      body,
      author,
      createdAt: createdAt ?? this.clock().toISOString(),
    };
    const list = this.pullComments.get(`${repo}#${number}`) ?? [];
    list.push(c);
    this.pullComments.set(`${repo}#${number}`, list);
    return c;
  }
  seedChecks(repo: RepoRef, at: string, summary: CheckSummary): void {
    this.checks.set(`${repo}#${at}`, summary);
  }
  seedRun(run: Partial<WorkflowRun> & { id: number }): WorkflowRun {
    const r: WorkflowRun = {
      id: run.id,
      status: run.status ?? "completed",
      conclusion: run.conclusion ?? "success",
      createdAt: run.createdAt ?? this.clock().toISOString(),
      htmlUrl:
        run.htmlUrl ??
        `https://github.com/${this.hubRepo}/actions/runs/${run.id}`,
    };
    this.runs.set(run.id, r);
    if (run.id >= this.runNo) this.runNo = run.id + 1;
    return r;
  }
  /** mutate a seeded PR (e.g. set mergeableState after a rebase) */
  patchPull(repo: RepoRef, number: number, patch: Partial<PullRequest>): void {
    const pr = this.pulls.get(`${repo}#${number}`);
    if (!pr) throw new Error(`no PR ${repo}#${number}`);
    Object.assign(pr, patch);
    if (patch.mergeableState) pr.mergeable = patch.mergeableState !== "dirty";
  }
  /** read back comments on a PR (synchronous, for assertions) */
  comments(repo: RepoRef, number: number): string[] {
    return (this.pullComments.get(`${repo}#${number}`) ?? []).map(
      (c) => c.body,
    );
  }
  pull(repo: RepoRef, number: number): PullRequest {
    const pr = this.pulls.get(`${repo}#${number}`);
    if (!pr) throw new Error(`no PR ${repo}#${number}`);
    return pr;
  }
  branch(repo: RepoRef, name: string): string | null {
    return this.branches.get(`${repo}#${name}`) ?? null;
  }

  // ── Forge ─────────────────────────────────────────────────────────────────
  async getBranchSha(repo: RepoRef, branch: string): Promise<string | null> {
    return this.branches.get(`${repo}#${branch}`) ?? null;
  }
  async compare(repo: RepoRef, base: string, head: string) {
    return (
      this.compares.get(`${repo}#${base}..${head}`) ?? {
        aheadBy: 0,
        behindBy: 0,
      }
    );
  }
  async deleteBranch(repo: RepoRef, branch: string): Promise<void> {
    this.branches.delete(`${repo}#${branch}`);
    this.deletedBranches.push(branch);
  }
  async listOpenPulls(
    repo: RepoRef,
    opts: { base?: string; head?: string } = {},
  ): Promise<PullRequest[]> {
    return [...this.pulls.entries()]
      .filter(([k]) => k.startsWith(`${repo}#`))
      .map(([, p]) => p)
      .filter((p) => p.state === "open")
      .filter((p) => !opts.base || p.baseRef === opts.base)
      .filter((p) => !opts.head || p.headRef === opts.head)
      .sort((a, b) => a.number - b.number);
  }
  async listMergedPulls(
    repo: RepoRef,
    base: string,
    since: string,
  ): Promise<PullRequest[]> {
    return [...this.pulls.entries()]
      .filter(([k]) => k.startsWith(`${repo}#`))
      .map(([, p]) => p)
      .filter(
        (p) =>
          p.state === "merged" &&
          p.baseRef === base &&
          (p.mergedAt ?? "") >= since,
      )
      .sort((a, b) => (b.mergedAt ?? "").localeCompare(a.mergedAt ?? ""));
  }
  async getPull(repo: RepoRef, number: number): Promise<PullRequest | null> {
    return this.pulls.get(`${repo}#${number}`) ?? null;
  }
  async createPull(
    repo: RepoRef,
    input: CreatePullInput,
  ): Promise<PullRequest> {
    const headSha = this.branches.get(`${repo}#${input.head}`) ?? sha();
    return this.seedPull(repo, {
      ...input,
      headRef: input.head,
      baseRef: input.base,
      headSha,
    });
  }
  async updatePull(
    repo: RepoRef,
    number: number,
    patch: { title?: string; body?: string },
  ): Promise<void> {
    this.patchPull(repo, number, patch);
  }
  async markReady(repo: RepoRef, number: number): Promise<void> {
    this.patchPull(repo, number, { draft: false });
    this.readied.push(number);
  }
  async mergePull(
    repo: RepoRef,
    number: number,
    opts: { method: MergeMethod; sha: string },
  ): Promise<MergeResult> {
    const pr = this.pull(repo, number);
    if (this.nextMergeRefusal) {
      const message = this.nextMergeRefusal;
      this.nextMergeRefusal = null;
      return { merged: false, message };
    }
    if (pr.headSha !== opts.sha)
      return {
        merged: false,
        message: "Head branch was modified. Review and try the merge again.",
      };
    if (pr.mergeableState === "dirty")
      return { merged: false, message: "Pull Request is not mergeable" };
    if (pr.draft)
      return { merged: false, message: "Pull request is in draft state" };
    const mergeSha = sha();
    Object.assign(pr, {
      state: "merged",
      mergedAt: this.clock().toISOString(),
      mergeCommitSha: mergeSha,
    });
    this.branches.set(`${repo}#${pr.baseRef}`, mergeSha);
    this.merged.push(number);
    return { merged: true, sha: mergeSha };
  }
  async enableAutoMerge(
    _repo: RepoRef,
    number: number,
    _method: MergeMethod,
  ): Promise<void> {
    this.autoMerged.push(number);
  }
  async listPullFiles(repo: RepoRef, number: number): Promise<string[]> {
    return this.pullFiles.get(`${repo}#${number}`) ?? [];
  }
  async listPullComments(repo: RepoRef, number: number): Promise<Comment[]> {
    return [...(this.pullComments.get(`${repo}#${number}`) ?? [])];
  }
  async addPullComment(
    repo: RepoRef,
    number: number,
    body: string,
  ): Promise<Comment> {
    return this.seedComment(repo, number, body);
  }
  async getChecks(repo: RepoRef, at: string): Promise<CheckSummary> {
    return (
      this.checks.get(`${repo}#${at}`) ?? { status: "none", failedJobs: [] }
    );
  }
  async rerunFailedJobs(_repo: RepoRef, at: string): Promise<void> {
    this.reruns.push(at);
  }
  async dispatchWorkflow(
    _hubRepo: RepoRef,
    workflowFile: string,
    ref: string,
    inputs: Record<string, string>,
  ): Promise<WorkflowRun> {
    const run = this.seedRun({
      id: this.runNo++,
      status: "queued",
      conclusion: null,
    });
    this.dispatched.push({ workflowFile, ref, inputs, runId: run.id });
    return run;
  }
  async getWorkflowRun(
    _hubRepo: RepoRef,
    runId: number,
  ): Promise<WorkflowRun | null> {
    return this.runs.get(runId) ?? null;
  }
}
