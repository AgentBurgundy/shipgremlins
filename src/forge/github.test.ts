import { afterEach, describe, expect, it, vi } from "vitest";
import { GitHubForge } from "./github.ts";

const REPO = "owner/game";
const HUB = "owner/pm-hub";

type Call = { method: string; url: URL; body: unknown; headers: Headers };
type Route = {
  method: string;
  re: RegExp;
  handler: (url: URL, body: unknown, call: Call) => Response | unknown;
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Stub global fetch with a route table; returns the recorded calls. */
function stubGitHub(routes: Route[]): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init: RequestInit = {}) => {
      const url = new URL(input);
      const method = (init.method ?? "GET").toUpperCase();
      const body = typeof init.body === "string" ? JSON.parse(init.body) : null;
      const call: Call = {
        method,
        url,
        body,
        headers: new Headers(init.headers),
      };
      calls.push(call);
      const route = routes.find(
        (r) => r.method === method && r.re.test(url.pathname + url.search),
      );
      if (!route) return json({ message: `unrouted ${method} ${url}` }, 404);
      const out = route.handler(url, body, call);
      return out instanceof Response ? out : json(out);
    }),
  );
  return calls;
}

const restPull = (over: Record<string, unknown> = {}) => ({
  number: 7,
  node_id: "PR_node7",
  title: "feat: thing",
  body: "does a thing",
  head: { ref: "pm/game-12", sha: "a".repeat(40) },
  base: { ref: "pm-staging" },
  draft: true,
  state: "open",
  user: { login: "pm-hub[bot]" },
  mergeable: true,
  mergeable_state: "clean",
  labels: [{ name: "x" }],
  created_at: "2026-10-02T10:00:00Z",
  updated_at: "2026-10-02T11:00:00Z",
  merged_at: null,
  merge_commit_sha: null,
  html_url: "https://github.com/owner/game/pull/7",
  ...over,
});

function forge(
  over: Partial<ConstructorParameters<typeof GitHubForge>[0]> = {},
) {
  return new GitHubForge({
    token: "ghs_test",
    pollMs: 1,
    now: () => new Date("2026-10-02T12:00:00Z"),
    ...over,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("production provenance reads", () => {
  const sha = "a".repeat(40);
  it("resolves immutable Git trees and retains file mode and blob identities", async () => {
    stubGitHub([
      {
        method: "GET",
        re: /\/git\/commits\//,
        handler: () => ({ sha, tree: { sha: "tree-id" } }),
      },
      {
        method: "GET",
        re: /\/git\/trees\/tree-id\?recursive=1/,
        handler: () => ({
          truncated: false,
          tree: [
            { path: "app.ts", mode: "100644", type: "blob", sha: "blob-id" },
          ],
        }),
      },
    ]);
    expect(await forge().getRevisionTree(REPO, sha)).toEqual([
      { path: "app.ts", mode: "100644", type: "blob", sha: "blob-id" },
    ]);
  });

  it("rejects truncated trees and mutable revision names", async () => {
    stubGitHub([
      {
        method: "GET",
        re: /\/git\/commits\//,
        handler: () => ({ sha, tree: { sha: "tree-id" } }),
      },
      {
        method: "GET",
        re: /\/git\/trees\//,
        handler: () => ({ truncated: true, tree: [] }),
      },
    ]);
    await expect(forge().getRevisionTree(REPO, sha)).rejects.toThrow(
      "incomplete tree",
    );
    await expect(forge().getRevisionTree(REPO, "main")).rejects.toThrow(
      "exact commit SHA",
    );
  });

  it("paginates changed paths and keeps the source path of renames", async () => {
    stubGitHub([
      {
        method: "GET",
        re: /\/pulls\/7\/files\?/,
        handler: (url) =>
          url.searchParams.get("page") === "1"
            ? Array.from({ length: 100 }, (_, n) => ({ filename: `${n}.ts` }))
            : [{ filename: "new.ts", previous_filename: "old.ts" }],
      },
    ]);
    const result = await forge().listPullChanges(REPO, 7);
    expect(result).toHaveLength(101);
    expect(result[100]).toEqual({ path: "new.ts", previousPath: "old.ts" });
  });

  it("refuses the provider's 3000-file limit instead of accepting incomplete scope", async () => {
    stubGitHub([
      {
        method: "GET",
        re: /\/pulls\/7\/files\?/,
        handler: (url) =>
          Number(url.searchParams.get("page")) <= 30
            ? Array.from({ length: 100 }, (_, n) => ({
                filename: `${url.searchParams.get("page")}-${n}.ts`,
              }))
            : [],
      },
    ]);
    await expect(forge().listPullChanges(REPO, 7)).rejects.toThrow(
      "may be truncated",
    );
  });
});

describe("GitHubForge auth + base url", () => {
  it("sends the token and the API version on every call, against apiBase", async () => {
    const calls = stubGitHub([
      {
        method: "GET",
        re: /^\/api\/v3\/repos\/owner\/game\/branches\/main$/,
        handler: () => ({ name: "main", commit: { sha: "b".repeat(40) } }),
      },
    ]);
    const f = forge({ apiBase: "https://ghe.test/api/v3" });
    await expect(f.getBranchSha(REPO, "main")).resolves.toBe("b".repeat(40));
    expect(calls[0]!.url.origin).toBe("https://ghe.test");
    expect(calls[0]!.headers.get("authorization")).toBe("Bearer ghs_test");
    expect(calls[0]!.headers.get("accept")).toContain(
      "application/vnd.github+json",
    );
    expect(calls[0]!.headers.get("x-github-api-version")).toBe("2022-11-28");
  });
});

describe("branches", () => {
  it("getBranchSha returns null on 404 and url-encodes slashes", async () => {
    const calls = stubGitHub([
      {
        method: "GET",
        re: /^\/repos\/owner\/game\/branches\/pm%2Fgame-12$/,
        handler: () => ({ commit: { sha: "c".repeat(40) } }),
      },
    ]);
    const f = forge();
    await expect(f.getBranchSha(REPO, "pm/game-12")).resolves.toBe(
      "c".repeat(40),
    );
    await expect(f.getBranchSha(REPO, "nope")).resolves.toBeNull();
    expect(calls).toHaveLength(2);
    expect(calls[0]!.url.origin).toBe("https://api.github.com");
  });

  it("compare maps ahead_by / behind_by", async () => {
    stubGitHub([
      {
        method: "GET",
        re: /^\/repos\/owner\/game\/compare\/pm-staging\.\.\.staging$/,
        handler: () => ({ ahead_by: 3, behind_by: 1 }),
      },
    ]);
    await expect(
      forge().compare(REPO, "pm-staging", "staging"),
    ).resolves.toEqual({
      aheadBy: 3,
      behindBy: 1,
    });
  });

  it("deleteBranch DELETEs the git ref and tolerates an already-gone branch", async () => {
    const calls = stubGitHub([
      {
        method: "DELETE",
        re: /^\/repos\/owner\/game\/git\/refs\/heads\/pm\/game-12$/,
        handler: () => new Response(null, { status: 204 }),
      },
      {
        method: "DELETE",
        re: /^\/repos\/owner\/game\/git\/refs\/heads\/gone$/,
        handler: () => json({ message: "Reference does not exist" }, 422),
      },
    ]);
    const f = forge();
    await expect(f.deleteBranch(REPO, "pm/game-12")).resolves.toBeUndefined();
    await expect(f.deleteBranch(REPO, "gone")).resolves.toBeUndefined();
    expect(calls).toHaveLength(2);
  });
});

describe("pull requests", () => {
  it("getPull maps the REST shape and returns null on 404", async () => {
    stubGitHub([
      {
        method: "GET",
        re: /^\/repos\/owner\/game\/pulls\/7$/,
        handler: () =>
          restPull({
            merged_at: "2026-10-02T11:30:00Z",
            merge_commit_sha: "m".repeat(40),
            state: "closed",
          }),
      },
    ]);
    const f = forge();
    const pr = await f.getPull(REPO, 7);
    expect(pr).toEqual({
      number: 7,
      title: "feat: thing",
      body: "does a thing",
      headRef: "pm/game-12",
      headSha: "a".repeat(40),
      baseRef: "pm-staging",
      draft: true,
      state: "merged",
      author: "pm-hub[bot]",
      mergeable: true,
      mergeableState: "clean",
      labels: ["x"],
      createdAt: "2026-10-02T10:00:00Z",
      updatedAt: "2026-10-02T11:00:00Z",
      mergedAt: "2026-10-02T11:30:00Z",
      mergeCommitSha: "m".repeat(40),
      htmlUrl: "https://github.com/owner/game/pull/7",
    });
    await expect(f.getPull(REPO, 99)).resolves.toBeNull();
  });

  it("getPull treats a null body and missing mergeable_state as empty / unknown", async () => {
    stubGitHub([
      {
        method: "GET",
        re: /^\/repos\/owner\/game\/pulls\/7$/,
        handler: () =>
          restPull({ body: null, mergeable: null, mergeable_state: undefined }),
      },
    ]);
    const pr = await forge().getPull(REPO, 7);
    expect(pr?.body).toBe("");
    expect(pr?.mergeable).toBeNull();
    expect(pr?.mergeableState).toBe("unknown");
    expect(pr?.state).toBe("open");
  });

  it("listOpenPulls lists with base/head filters and fetches each PR for mergeable_state", async () => {
    const calls = stubGitHub([
      {
        method: "GET",
        re: /^\/repos\/owner\/game\/pulls\?/,
        handler: (url) => {
          if (url.searchParams.get("page") !== "1") return [];
          return [restPull({ number: 7 }), restPull({ number: 8 })];
        },
      },
      {
        method: "GET",
        re: /^\/repos\/owner\/game\/pulls\/\d+$/,
        handler: (url) => {
          const n = Number(url.pathname.split("/").pop());
          return restPull({
            number: n,
            mergeable_state: n === 8 ? "dirty" : "clean",
          });
        },
      },
    ]);
    const pulls = await forge().listOpenPulls(REPO, {
      base: "pm-staging",
      head: "staging",
    });
    expect(pulls.map((p) => [p.number, p.mergeableState])).toEqual([
      [7, "clean"],
      [8, "dirty"],
    ]);
    const list = calls[0]!.url;
    expect(list.searchParams.get("state")).toBe("open");
    expect(list.searchParams.get("base")).toBe("pm-staging");
    expect(list.searchParams.get("head")).toBe("owner:staging");
    expect(list.searchParams.get("per_page")).toBe("100");
  });

  it("listMergedPulls searches is:pr is:merged and returns newest first, capped at 100", async () => {
    const calls = stubGitHub([
      {
        method: "GET",
        re: /^\/search\/issues\?/,
        handler: () => ({
          total_count: 2,
          items: [{ number: 3 }, { number: 4 }],
        }),
      },
      {
        method: "GET",
        re: /^\/repos\/owner\/game\/pulls\/\d+$/,
        handler: (url) => {
          const n = Number(url.pathname.split("/").pop());
          return restPull({
            number: n,
            state: "closed",
            merged_at:
              n === 3 ? "2026-10-01T10:00:00Z" : "2026-10-02T10:00:00Z",
            merge_commit_sha: "m".repeat(40),
          });
        },
      },
    ]);
    const merged = await forge().listMergedPulls(
      REPO,
      "pm-staging",
      "2026-10-01T00:00:00Z",
    );
    expect(merged.map((p) => p.number)).toEqual([4, 3]);
    expect(merged[0]!.state).toBe("merged");
    const q = calls[0]!.url.searchParams.get("q");
    expect(q).toBe(
      "is:pr is:merged base:pm-staging repo:owner/game merged:>=2026-10-01T00:00:00+00:00",
    );
    expect(calls[0]!.url.searchParams.get("per_page")).toBe("100");
  });

  it("createPull POSTs the input and updatePull PATCHes", async () => {
    const calls = stubGitHub([
      {
        method: "POST",
        re: /^\/repos\/owner\/game\/pulls$/,
        handler: (_u, body) =>
          json(restPull({ number: 9, ...(body as object) }), 201),
      },
      {
        method: "PATCH",
        re: /^\/repos\/owner\/game\/pulls\/9$/,
        handler: () => restPull({ number: 9 }),
      },
    ]);
    const f = forge();
    const pr = await f.createPull(REPO, {
      title: "sync: staging → pm-staging",
      head: "staging",
      base: "pm-staging",
      body: "b",
      draft: false,
    });
    expect(pr.number).toBe(9);
    expect(calls[0]!.body).toEqual({
      title: "sync: staging → pm-staging",
      head: "staging",
      base: "pm-staging",
      body: "b",
      draft: false,
    });
    await f.updatePull(REPO, 9, { title: "t2" });
    expect(calls[1]!.method).toBe("PATCH");
    expect(calls[1]!.body).toEqual({ title: "t2" });
  });

  it("markReady and enableAutoMerge go through GraphQL with the PR node id", async () => {
    const calls = stubGitHub([
      {
        method: "GET",
        re: /^\/repos\/owner\/game\/pulls\/7$/,
        handler: () => restPull(),
      },
      {
        method: "POST",
        re: /^\/graphql$/,
        handler: (_u, body) => {
          const q = (body as { query: string }).query;
          if (q.includes("markPullRequestReadyForReview"))
            return {
              data: {
                markPullRequestReadyForReview: {
                  pullRequest: { isDraft: false },
                },
              },
            };
          if (q.includes("enablePullRequestAutoMerge"))
            return {
              data: {
                enablePullRequestAutoMerge: { pullRequest: { id: "PR_node7" } },
              },
            };
          return { errors: [{ message: "unexpected" }] };
        },
      },
    ]);
    const f = forge();
    await f.markReady(REPO, 7);
    await f.enableAutoMerge(REPO, 7, "squash");
    const gql = calls.filter((c) => c.url.pathname === "/graphql");
    expect(gql).toHaveLength(2);
    expect((gql[0]!.body as { variables: unknown }).variables).toEqual({
      id: "PR_node7",
    });
    expect((gql[1]!.body as { variables: unknown }).variables).toEqual({
      id: "PR_node7",
      method: "SQUASH",
    });
  });

  it("surfaces GraphQL errors", async () => {
    stubGitHub([
      {
        method: "GET",
        re: /^\/repos\/owner\/game\/pulls\/7$/,
        handler: () => restPull(),
      },
      {
        method: "POST",
        re: /^\/graphql$/,
        handler: () => ({
          errors: [{ message: "Pull request is not in draft" }],
        }),
      },
    ]);
    await expect(forge().markReady(REPO, 7)).rejects.toThrow(
      "Pull request is not in draft",
    );
  });

  it("mergePull returns the sha on success and maps 405/409 to a refusal", async () => {
    const calls = stubGitHub([
      {
        method: "PUT",
        re: /^\/repos\/owner\/game\/pulls\/7\/merge$/,
        handler: () => ({
          sha: "m".repeat(40),
          merged: true,
          message: "Pull Request successfully merged",
        }),
      },
      {
        method: "PUT",
        re: /^\/repos\/owner\/game\/pulls\/8\/merge$/,
        handler: () => json({ message: "Pull Request is not mergeable" }, 405),
      },
      {
        method: "PUT",
        re: /^\/repos\/owner\/game\/pulls\/9\/merge$/,
        handler: () =>
          json(
            {
              message:
                "Head branch was modified. Review and try the merge again.",
            },
            409,
          ),
      },
    ]);
    const f = forge();
    await expect(
      f.mergePull(REPO, 7, { method: "squash", sha: "a".repeat(40) }),
    ).resolves.toEqual({
      merged: true,
      sha: "m".repeat(40),
      message: "Pull Request successfully merged",
    });
    expect(calls[0]!.body).toEqual({
      merge_method: "squash",
      sha: "a".repeat(40),
    });
    await expect(
      f.mergePull(REPO, 8, { method: "squash", sha: "a".repeat(40) }),
    ).resolves.toEqual({
      merged: false,
      message: "Pull Request is not mergeable",
    });
    await expect(
      f.mergePull(REPO, 9, { method: "merge", sha: "a".repeat(40) }),
    ).resolves.toEqual({
      merged: false,
      message: "Head branch was modified. Review and try the merge again.",
    });
  });

  it("listPullFiles paginates and listPullComments maps issue comments", async () => {
    stubGitHub([
      {
        method: "GET",
        re: /^\/repos\/owner\/game\/pulls\/7\/files\?/,
        handler: (url) => {
          const page = Number(url.searchParams.get("page"));
          if (page === 1)
            return Array.from({ length: 100 }, (_, i) => ({
              filename: `f${i}.ts`,
            }));
          if (page === 2) return [{ filename: "last.ts" }];
          return [];
        },
      },
      {
        method: "GET",
        re: /^\/repos\/owner\/game\/issues\/7\/comments\?/,
        handler: (url) =>
          url.searchParams.get("page") === "1"
            ? [
                {
                  id: 1,
                  body: "🔧 PR opened",
                  user: { login: "pm-hub[bot]" },
                  created_at: "2026-10-02T10:00:00Z",
                },
                {
                  id: 2,
                  body: "@claude fix it",
                  user: { login: "ron" },
                  created_at: "2026-10-02T10:05:00Z",
                },
              ]
            : [],
      },
    ]);
    const f = forge();
    const files = await f.listPullFiles(REPO, 7);
    expect(files).toHaveLength(101);
    expect(files.at(-1)).toBe("last.ts");
    await expect(f.listPullComments(REPO, 7)).resolves.toEqual([
      {
        id: 1,
        body: "🔧 PR opened",
        author: "pm-hub[bot]",
        createdAt: "2026-10-02T10:00:00Z",
      },
      {
        id: 2,
        body: "@claude fix it",
        author: "ron",
        createdAt: "2026-10-02T10:05:00Z",
      },
    ]);
  });

  it("addPullComment POSTs to the issue comments endpoint", async () => {
    const calls = stubGitHub([
      {
        method: "POST",
        re: /^\/repos\/owner\/game\/issues\/7\/comments$/,
        handler: (_u, body) =>
          json(
            {
              id: 55,
              body: (body as { body: string }).body,
              user: { login: "pm-hub[bot]" },
              created_at: "2026-10-02T12:00:00Z",
            },
            201,
          ),
      },
    ]);
    const c = await forge().addPullComment(
      REPO,
      7,
      "🚢 Merged by the dispatcher",
    );
    expect(c).toEqual({
      id: 55,
      body: "🚢 Merged by the dispatcher",
      author: "pm-hub[bot]",
      createdAt: "2026-10-02T12:00:00Z",
    });
    expect(calls[0]!.body).toEqual({ body: "🚢 Merged by the dispatcher" });
  });
});

describe("checks", () => {
  const SHA = "d".repeat(40);
  const checkRun = (over: Record<string, unknown>) => ({
    id: 1,
    name: "test",
    status: "completed",
    conclusion: "success",
    html_url: "https://github.com/owner/game/actions/runs/500/job/9001",
    details_url: "https://github.com/owner/game/actions/runs/500/job/9001",
    app: { slug: "github-actions" },
    ...over,
  });

  function stubChecks(
    check_runs: unknown[],
    statuses: unknown[] = [],
    logs: Record<string, string> = {},
  ) {
    return stubGitHub([
      {
        method: "GET",
        re: new RegExp(`^/repos/owner/game/commits/${SHA}/check-runs`),
        handler: () => ({ total_count: check_runs.length, check_runs }),
      },
      {
        method: "GET",
        re: new RegExp(`^/repos/owner/game/commits/${SHA}/status$`),
        handler: () => ({
          state: statuses.length ? "failure" : "pending",
          statuses,
        }),
      },
      {
        method: "GET",
        re: /^\/repos\/owner\/game\/actions\/jobs\/(\d+)\/logs$/,
        handler: (url) => {
          const id = url.pathname.split("/").at(-2)!;
          const log = logs[id];
          return log === undefined
            ? json({ message: "Not Found" }, 404)
            : new Response(log, { status: 200 });
        },
      },
      {
        method: "POST",
        re: /^\/repos\/owner\/game\/actions\/runs\/\d+\/rerun-failed-jobs$/,
        handler: () => new Response(null, { status: 201 }),
      },
    ]);
  }

  it("none when nothing reported", async () => {
    stubChecks([]);
    await expect(forge().getChecks(REPO, SHA)).resolves.toEqual({
      status: "none",
      failedJobs: [],
    });
  });

  it("ignores a 403 on the legacy status endpoint (app lacks 'Commit statuses: read') and still reads check-runs", async () => {
    stubGitHub([
      {
        method: "GET",
        re: new RegExp(`^/repos/owner/game/commits/${SHA}/check-runs`),
        handler: () => ({ total_count: 1, check_runs: [checkRun({})] }),
      },
      {
        method: "GET",
        re: new RegExp(`^/repos/owner/game/commits/${SHA}/status$`),
        handler: () =>
          json({ message: "Resource not accessible by integration" }, 403),
      },
    ]);
    await expect(forge().getChecks(REPO, SHA)).resolves.toEqual({
      status: "success",
      failedJobs: [],
    });
  });

  it("success when every check run and status passed (neutral/skipped count as passed)", async () => {
    stubChecks(
      [
        checkRun({}),
        checkRun({ id: 2, name: "lint", conclusion: "skipped" }),
        checkRun({ id: 3, conclusion: "neutral" }),
      ],
      [
        {
          context: "vercel",
          state: "success",
          target_url: "https://vercel.com/x",
        },
      ],
    );
    await expect(forge().getChecks(REPO, SHA)).resolves.toEqual({
      status: "success",
      failedJobs: [],
    });
  });

  it("pending when any check is still running, even if others passed", async () => {
    stubChecks([
      checkRun({}),
      checkRun({ id: 2, name: "e2e", status: "in_progress", conclusion: null }),
    ]);
    await expect(forge().getChecks(REPO, SHA)).resolves.toMatchObject({
      status: "pending",
    });
  });

  it("failure beats pending; failed Actions jobs carry the last 60 log lines", async () => {
    const lines =
      Array.from({ length: 80 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
    stubChecks(
      [
        checkRun({ id: 2, name: "unit", conclusion: "failure" }),
        checkRun({ id: 3, name: "e2e", status: "queued", conclusion: null }),
        checkRun({
          id: 4,
          name: "CodeRabbit",
          conclusion: "failure",
          app: { slug: "coderabbitai" },
          details_url: "https://coderabbit.ai/x",
          html_url: "https://github.com/owner/game/runs/4",
        }),
      ],
      [
        {
          context: "ci/legacy",
          state: "failure",
          target_url: "https://ci.test/1",
        },
      ],
      { "9001": lines },
    );
    const res = await forge().getChecks(REPO, SHA);
    expect(res.status).toBe("failure");
    expect(res.failedJobs.map((j) => j.name)).toEqual([
      "unit",
      "CodeRabbit",
      "ci/legacy",
    ]);
    const unit = res.failedJobs[0]!;
    expect(unit.url).toBe(
      "https://github.com/owner/game/actions/runs/500/job/9001",
    );
    expect(unit.logTail!.split("\n")).toHaveLength(60);
    expect(unit.logTail!.startsWith("line 21\n")).toBe(true);
    expect(unit.logTail!.endsWith("line 80")).toBe(true);
    expect(res.failedJobs[1]!.logTail).toBeUndefined();
    expect(res.failedJobs[1]!.url).toBe("https://github.com/owner/game/runs/4");
    expect(res.failedJobs[2]).toEqual({
      name: "ci/legacy",
      url: "https://ci.test/1",
    });
  });

  it("a log fetch that 404s leaves logTail undefined without failing the summary", async () => {
    stubChecks([checkRun({ conclusion: "timed_out" })]);
    const res = await forge().getChecks(REPO, SHA);
    expect(res.status).toBe("failure");
    expect(res.failedJobs[0]!.logTail).toBeUndefined();
  });

  it("rerunFailedJobs re-runs each failed Actions run once and ignores non-Actions checks", async () => {
    const calls = stubChecks([
      checkRun({ id: 1, name: "unit", conclusion: "failure" }),
      checkRun({
        id: 2,
        name: "lint",
        conclusion: "failure",
        details_url: "https://github.com/owner/game/actions/runs/500/job/9002",
      }),
      checkRun({
        id: 3,
        name: "other-wf",
        conclusion: "failure",
        details_url: "https://github.com/owner/game/actions/runs/777/job/9003",
      }),
      checkRun({
        id: 4,
        name: "green",
        conclusion: "success",
        details_url: "https://github.com/owner/game/actions/runs/888/job/9004",
      }),
      checkRun({
        id: 5,
        name: "bot",
        conclusion: "failure",
        app: { slug: "coderabbitai" },
        details_url: "https://x.test",
      }),
    ]);
    await forge().rerunFailedJobs(REPO, SHA);
    const reruns = calls
      .filter((c) => c.method === "POST")
      .map((c) => c.url.pathname);
    expect(reruns).toEqual([
      "/repos/owner/game/actions/runs/500/rerun-failed-jobs",
      "/repos/owner/game/actions/runs/777/rerun-failed-jobs",
    ]);
  });

  it("rerunFailedJobs is a no-op when nothing failed", async () => {
    const calls = stubChecks([checkRun({})]);
    await forge().rerunFailedJobs(REPO, SHA);
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });
});

describe("workflows", () => {
  const run = (over: Record<string, unknown>) => ({
    id: 1,
    name: "developer",
    display_title: "developer",
    path: ".github/workflows/developer.yml",
    status: "queued",
    conclusion: null,
    created_at: "2026-10-02T12:00:01Z",
    html_url: "https://github.com/owner/pm-hub/actions/runs/1",
    event: "workflow_dispatch",
    ...over,
  });

  function stubDispatch(pages: unknown[][]) {
    let poll = 0;
    const calls = stubGitHub([
      {
        method: "POST",
        re: /^\/repos\/owner\/pm-hub\/actions\/workflows\/developer\.yml\/dispatches$/,
        handler: () => new Response(null, { status: 204 }),
      },
      {
        method: "GET",
        re: /^\/repos\/owner\/pm-hub\/actions\/runs\?/,
        handler: () => {
          const page = pages[Math.min(poll, pages.length - 1)] ?? [];
          poll++;
          return { total_count: page.length, workflow_runs: page };
        },
      },
    ]);
    return calls;
  }

  it("dispatchWorkflow sends inputs + a uuid marker and returns the run echoing the marker", async () => {
    let marker = "";
    const calls = stubDispatch([]);
    // the second poll sees the run; the first sees only a stranger's
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    let polls = 0;
    fetchMock.mockImplementation(
      async (input: string, init: RequestInit = {}) => {
        const url = new URL(input);
        const method = (init.method ?? "GET").toUpperCase();
        if (method === "POST") {
          const body = JSON.parse(init.body as string) as {
            ref: string;
            inputs: Record<string, string>;
          };
          marker = body.inputs.marker!;
          calls.push({ method, url, body, headers: new Headers(init.headers) });
          return new Response(null, { status: 204 });
        }
        polls++;
        const runs =
          polls === 1
            ? [
                run({
                  id: 40,
                  name: "11111111-2222-4333-8444-555555555555",
                  display_title: "11111111-2222-4333-8444-555555555555",
                  created_at: "2026-10-02T12:00:02Z",
                }),
              ]
            : [
                run({
                  id: 40,
                  name: "11111111-2222-4333-8444-555555555555",
                  display_title: "11111111-2222-4333-8444-555555555555",
                  created_at: "2026-10-02T12:00:02Z",
                }),
                run({
                  id: 41,
                  name: marker,
                  display_title: marker,
                  created_at: "2026-10-02T12:00:01Z",
                }),
                run({
                  id: 39,
                  name: "pm-agent",
                  path: ".github/workflows/pm-agent.yml",
                  created_at: "2026-10-02T12:00:03Z",
                }),
              ];
        return json({ total_count: runs.length, workflow_runs: runs });
      },
    );
    const res = await forge().dispatchWorkflow(HUB, "developer.yml", "main", {
      project: "game",
      ticket: "GAME-12",
    });
    expect(res).toEqual({
      id: 41,
      status: "queued",
      conclusion: null,
      createdAt: "2026-10-02T12:00:01Z",
      htmlUrl: "https://github.com/owner/pm-hub/actions/runs/1",
    });
    const dispatch = calls.find((c) => c.method === "POST")!;
    const body = dispatch.body as {
      ref: string;
      inputs: Record<string, string>;
    };
    expect(body.ref).toBe("main");
    expect(body.inputs.project).toBe("game");
    expect(body.inputs.ticket).toBe("GAME-12");
    expect(marker).toMatch(/^[0-9a-f-]{36}$/);
    expect(polls).toBe(2);
  });

  it("dispatchWorkflow polls with event=workflow_dispatch and a created floor 10s before the dispatch", async () => {
    const calls = stubDispatch([
      [run({ id: 5, created_at: "2026-10-02T12:00:00Z" })],
    ]);
    const res = await forge().dispatchWorkflow(
      HUB,
      "developer.yml",
      "main",
      {},
    );
    expect(res.id).toBe(5);
    const poll = calls.find((c) => c.method === "GET")!.url;
    expect(poll.searchParams.get("event")).toBe("workflow_dispatch");
    expect(poll.searchParams.get("created")).toBe(">=2026-10-02T11:59:50Z");
  });

  it("without a marker echo it takes the newest run for that file created after the dispatch", async () => {
    stubDispatch([
      [
        run({ id: 5, created_at: "2026-10-02T12:00:01Z" }),
        run({ id: 6, created_at: "2026-10-02T12:00:03Z" }),
        run({
          id: 7,
          created_at: "2026-10-02T12:00:05Z",
          path: ".github/workflows/pm-agent.yml",
        }),
        run({ id: 3, created_at: "2026-10-02T11:59:00Z" }),
      ],
    ]);
    const res = await forge().dispatchWorkflow(
      HUB,
      "developer.yml",
      "main",
      {},
    );
    expect(res.id).toBe(6);
  });

  it("gives up with a clear error when no run appears", async () => {
    const calls = stubDispatch([[]]);
    await expect(
      forge({ pollAttempts: 3 }).dispatchWorkflow(
        HUB,
        "developer.yml",
        "main",
        {},
      ),
    ).rejects.toThrow(/developer\.yml.*no run appeared/);
    expect(calls.filter((c) => c.method === "GET")).toHaveLength(3);
  });

  it("getWorkflowRun maps status and returns null on 404", async () => {
    stubGitHub([
      {
        method: "GET",
        re: /^\/repos\/owner\/pm-hub\/actions\/runs\/41$/,
        handler: () =>
          run({ id: 41, status: "completed", conclusion: "success" }),
      },
      {
        method: "GET",
        re: /^\/repos\/owner\/pm-hub\/actions\/runs\/42$/,
        handler: () => run({ id: 42, status: "waiting" }),
      },
    ]);
    const f = forge();
    await expect(f.getWorkflowRun(HUB, 41)).resolves.toEqual({
      id: 41,
      status: "completed",
      conclusion: "success",
      createdAt: "2026-10-02T12:00:01Z",
      htmlUrl: "https://github.com/owner/pm-hub/actions/runs/1",
    });
    await expect(f.getWorkflowRun(HUB, 42)).resolves.toMatchObject({
      status: "queued",
    });
    await expect(f.getWorkflowRun(HUB, 43)).resolves.toBeNull();
  });
});

describe("getPull while GitHub is still computing mergeability", () => {
  it("re-reads an open PR until `mergeable` is settled instead of returning unknown", async () => {
    let reads = 0;
    const base = {
      number: 5,
      title: "t",
      body: "",
      state: "open",
      draft: true,
      merged: false,
      head: { ref: "pm/x-1", sha: "abc" },
      base: { ref: "pm-staging" },
      user: { login: "pm-hub[bot]" },
      labels: [],
      created_at: "2026-10-01T00:00:00Z",
      updated_at: "2026-10-01T00:00:00Z",
      merged_at: null,
      merge_commit_sha: null,
      html_url: "https://github.com/owner/game/pull/5",
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        reads++;
        const settled = reads >= 3;
        return new Response(
          JSON.stringify({
            ...base,
            mergeable: settled ? false : null,
            mergeable_state: settled ? "dirty" : "unknown",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }),
    );
    const forge = new GitHubForge({ token: "t", pollMs: 1 });
    const pr = await forge.getPull("owner/game", 5);
    expect(reads).toBe(3);
    expect(pr?.mergeableState).toBe("dirty");
    expect(pr?.mergeable).toBe(false);
  });
});
