import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GitHubForge } from "./github.ts";
import { GitLabForge } from "./gitlab.ts";
const HUB = "owner/hub",
  REPO = "owner/game",
  SHA = "a".repeat(40),
  HUB_SHA = "b".repeat(40);
afterEach(() => vi.unstubAllGlobals());
function githubWorld() {
  const inputs = {
    project: "game",
    ticket: "GAME-7",
    kind: "ci",
    attempt: "1",
    branch: "pm/game-7",
    pr: "5",
    marker: "11111111-2222-4333-8444-555555555555",
    scope: "c".repeat(64),
  };
  const run = {
    id: 99,
    path: ".github/workflows/developer.yml@main",
    status: "in_progress",
    conclusion: null,
    created_at: "2026-10-02T12:00:00Z",
    html_url: `https://github.com/${HUB}/actions/runs/99`,
    event: "workflow_dispatch",
    head_branch: "main",
    head_sha: HUB_SHA,
    repository: { full_name: HUB },
    head_repository: { full_name: HUB },
  };
  let source = readFileSync(
    new URL("../../.github/workflows/developer.yml", import.meta.url),
    "utf8",
  );
  const job = {
    name: "launch",
    run_id: 99,
    head_sha: HUB_SHA,
    steps: [
      {
        name: `ShipGremlins dispatch inputs: ${JSON.stringify(inputs)}`,
        status: "completed",
        conclusion: "success",
      },
    ],
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const path = new URL(url).pathname;
      if (path.endsWith("/actions/runs/99")) return Response.json(run);
      if (path.endsWith("/attempts/1/jobs"))
        return Response.json({ jobs: [job] });
      const text = path.endsWith("/contents/.github/workflows/developer.yml")
        ? source
        : path.endsWith("/contents/projects/game/project.json")
          ? JSON.stringify({
              repo: REPO,
              instanceId: "current",
              branches: { integration: "pm-staging" },
            })
          : null;
      return text
        ? Response.json({
            encoding: "base64",
            content: Buffer.from(text).toString("base64"),
            size: Buffer.byteLength(text),
          })
        : new Response(null, { status: 404 });
    }),
  );
  return {
    forge: new GitHubForge({ token: "private" }),
    inputs,
    run,
    job,
    source: (value: string) => {
      source = value;
    },
  };
}
describe("authenticated workflow dispatch evidence", () => {
  it("reads exact inputs from server metadata and immutable workflow/project snapshots", async () => {
    const f = githubWorld();
    expect(await f.forge.getWorkflowRunEvidence(HUB, 99)).toMatchObject({
      repository: HUB,
      workflowFile: "developer.yml",
      ref: "main",
      inputs: f.inputs,
      projectRepository: REPO,
      projectInstanceId: "current",
      projectIntegrationBranch: "pm-staging",
    });
    expect(
      (fetch as ReturnType<typeof vi.fn>).mock.calls
        .filter(([url]) => String(url).includes("/contents/"))
        .every(([url]) => String(url).endsWith(`ref=${HUB_SHA}`)),
    ).toBe(true);
  });
  it.each([
    "repository",
    "head repository",
    "event",
    "branch",
    "workflow",
    "sha",
  ])("rejects wrong %s before trusting step names", async (scenario) => {
    const f = githubWorld();
    if (scenario === "repository") f.run.repository.full_name = "wrong/repo";
    if (scenario === "head repository")
      f.run.head_repository.full_name = "fork/repo";
    if (scenario === "event") f.run.event = "push";
    if (scenario === "branch") f.run.head_branch = "feature";
    if (scenario === "workflow") f.run.path = ".github/workflows/untrusted.yml";
    if (scenario === "sha") f.run.head_sha = "short";
    await expect(f.forge.getWorkflowRunEvidence(HUB, 99)).rejects.toThrow();
  });
  it("refuses an old workflow without pre-agent evidence and pinned checkout", async () => {
    const f = githubWorld();
    f.source(
      "name: developer\njobs:\n  run:\n    steps:\n      - uses: actions/checkout@v4\n        with:\n          ref: main\n",
    );
    await expect(f.forge.getWorkflowRunEvidence(HUB, 99)).rejects.toThrow(
      "does not emit trusted dispatch inputs",
    );
  });
  it("waits for successful input recording and rejects malformed server metadata", async () => {
    const f = githubWorld();
    f.job.steps[0]!.status = "queued";
    expect(await f.forge.getWorkflowRunEvidence(HUB, 99)).toBeNull();
    f.job.steps[0]!.status = "completed";
    f.job.steps[0]!.name = "ShipGremlins dispatch inputs: invalid";
    await expect(f.forge.getWorkflowRunEvidence(HUB, 99)).rejects.toThrow(
      "input record is invalid",
    );
  });
});
describe("GitHub exact-revision CI retry acknowledgment", () => {
  function world() {
    const detail = {
      id: 55,
      repository: { full_name: REPO },
      head_sha: SHA,
      run_attempt: 1,
      status: "completed",
    };
    const posts: string[] = [];
    let pending = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const path = new URL(url).pathname;
        if (init?.method === "POST") {
          posts.push(path);
          detail.run_attempt++;
          detail.status = "queued";
          throw new Error("response lost");
        }
        if (path.endsWith("/check-runs"))
          return Response.json({
            check_runs: [
              {
                id: 1,
                name: "tests",
                status: "completed",
                conclusion: "failure",
                app: { slug: "github-actions" },
                details_url: `https://github.com/${REPO}/actions/runs/55/jobs/7`,
              },
              ...(pending
                ? [
                    {
                      id: 2,
                      name: "build",
                      status: "in_progress",
                      conclusion: null,
                    },
                  ]
                : []),
            ],
          });
        if (path.endsWith("/status")) return Response.json({ statuses: [] });
        if (path.endsWith("/actions/runs/55")) return Response.json(detail);
        return new Response(null, { status: 404 });
      }),
    );
    return {
      forge: new GitHubForge({ token: "private" }),
      detail,
      posts,
      pending: () => {
        pending = true;
      },
    };
  }
  it("acknowledges a lost POST by advanced run_attempt and never resends it", async () => {
    const f = world(),
      plan = await f.forge.planFailedJobRerun(REPO, SHA);
    expect(plan).toMatchObject({
      state: "ready",
      targets: [{ runId: 55, attempt: 1, sha: SHA }],
    });
    await expect(
      f.forge.rerunFailedJobTarget(plan.targets[0]!),
    ).rejects.toThrow();
    expect(f.posts).toHaveLength(1);
    expect(await f.forge.getFailedJobRerunEvidence(plan.targets[0]!)).toEqual({
      acknowledged: true,
      pending: true,
    });
    await f.forge.rerunFailedJobTarget(plan.targets[0]!);
    expect(f.posts).toHaveLength(1);
  });
  it("defers mixed pending checks and rejects mismatched revision evidence", async () => {
    const f = world();
    f.pending();
    expect(await f.forge.planFailedJobRerun(REPO, SHA)).toEqual({
      state: "pending",
      targets: [],
    });
    await expect(
      f.forge.rerunFailedJobTarget({
        provider: "github",
        repository: REPO,
        sha: "c".repeat(40),
        runId: 55,
        attempt: 1,
      }),
    ).rejects.toThrow("does not match");
    expect(f.posts).toEqual([]);
  });
});
describe("GitLab exact-revision CI retry acknowledgment", () => {
  it("recognizes replacement jobs in the same pipeline after a lost response without resending", async () => {
    let jobs = [{ id: 7, name: "tests", status: "failed" }],
      requests = 0;
    const forge = new GitLabForge({
      token: "private",
      fetch: async (url, init) => {
        const path = new URL(String(url)).pathname;
        if (init?.method === "POST") {
          requests++;
          jobs = [{ id: 8, name: "tests", status: "pending" }];
          throw new Error("response lost");
        }
        if (path.endsWith("/pipelines"))
          return Response.json([{ id: 55, sha: SHA }]);
        if (path.endsWith("/pipelines/55"))
          return Response.json({
            id: 55,
            sha: SHA,
            status: requests ? "pending" : "failed",
          });
        if (path.endsWith("/jobs")) return Response.json(jobs);
        return new Response(null, { status: 404 });
      },
    });
    const plan = await forge.planFailedJobRerun(REPO, SHA);
    await expect(
      forge.rerunFailedJobTarget(plan.targets[0]!),
    ).rejects.toThrow();
    expect(await forge.getFailedJobRerunEvidence(plan.targets[0]!)).toEqual({
      acknowledged: true,
      pending: true,
    });
    await forge.rerunFailedJobTarget(plan.targets[0]!);
    expect(requests).toBe(1);
  });
});
describe("exact-head diff statistics", () => {
  it("reads GitHub authoritative totals and fails closed when unavailable", async () => {
    const value: Record<string, unknown> = {
      head: { sha: SHA },
      changed_files: 2,
      additions: 10,
      deletions: 3,
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(value)),
    );
    const forge = new GitHubForge({ token: "private" });
    expect(await forge.getPullDiffStats(REPO, 5)).toEqual({
      headSha: SHA,
      files: 2,
      additions: 10,
      deletions: 3,
    });
    delete value.additions;
    await expect(forge.getPullDiffStats(REPO, 5)).rejects.toThrow(
      "unavailable",
    );
  });
  it("counts complete GitLab diffs and rejects collapsed data", async () => {
    let collapsed = false;
    const forge = new GitLabForge({
      token: "private",
      fetch: async (url) =>
        new URL(String(url)).pathname.endsWith("/diffs")
          ? Response.json([
              { diff: "@@ -1 +1,2 @@\n-old\n+new\n+more\n", collapsed },
            ])
          : Response.json({
              iid: 5,
              sha: SHA,
              changes_count: "1",
              source_branch: "pm/game-7",
              target_branch: "pm-staging",
              state: "opened",
              author: { username: "gremlin" },
            }),
    });
    expect(await forge.getPullDiffStats(REPO, 5)).toEqual({
      headSha: SHA,
      files: 1,
      additions: 2,
      deletions: 1,
    });
    collapsed = true;
    await expect(forge.getPullDiffStats(REPO, 5)).rejects.toThrow(
      "unavailable",
    );
  });
});
