import { describe, expect, it, vi } from "vitest";
import { GitLabForge } from "./gitlab.ts";
const SHA = "a".repeat(40),
  repo = "group/subgroup/app";
const mr = {
  iid: 7,
  title: "Draft: Fix",
  description: "scope",
  source_branch: "gremlins/job-one",
  target_branch: "pm-staging",
  sha: SHA,
  state: "opened",
  draft: true,
  detailed_merge_status: "mergeable",
  author: { username: "gremlin" },
  labels: [],
  web_url: "https://gitlab.com/group/subgroup/app/-/merge_requests/7",
  changes_count: "1",
};
describe("GitLab delivery forge", () => {
  it("closes a superseded merge request without deleting its branch or merging", async () => {
    const fetcher = vi.fn(async () => Response.json(mr));
    await new GitLabForge({ token: "test-token", fetch: fetcher }).closePull(
      repo,
      7,
    );
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(
      "https://gitlab.com/api/v4/projects/group%2Fsubgroup%2Fapp/merge_requests/7",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ state_event: "close" }),
      }),
    );
  });
  it("retargets only the selected merge request target branch", async () => {
    const fetcher = vi.fn(async () => Response.json(mr));
    await new GitLabForge({ token: "test-token", fetch: fetcher }).retargetPull(
      repo,
      7,
      "pm-staging",
    );
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(
      "https://gitlab.com/api/v4/projects/group%2Fsubgroup%2Fapp/merge_requests/7",
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({ target_branch: "pm-staging" }),
      }),
    );
  });
  it("creates an immutable sync snapshot using a full commit revision", async () => {
    const fetcher = vi.fn(async () =>
      Response.json({ name: "gremlins/staging-sync" }),
    );
    const forge = new GitLabForge({ token: "test-token", fetch: fetcher });
    await forge.createBranch(repo, "gremlins/staging-sync", SHA);
    expect(fetcher).toHaveBeenCalledWith(
      "https://gitlab.com/api/v4/projects/group%2Fsubgroup%2Fapp/repository/branches",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ branch: "gremlins/staging-sync", ref: SHA }),
      }),
    );
    await expect(
      forge.createBranch(repo, "gremlins/staging-sync", "main"),
    ).rejects.toThrow("full commit SHA");
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it("encodes subgroup paths and uses OAuth Bearer without redirects", async () => {
    const fetcher = vi.fn(
      async (_input: Parameters<typeof fetch>[0], _init?: RequestInit) =>
        Response.json(mr),
    );
    const forge = new GitLabForge({ token: "private-token", fetch: fetcher });
    expect(await forge.getPull(repo, 7)).toMatchObject({
      headSha: SHA,
      headRef: "gremlins/job-one",
      author: "gremlin",
      draft: true,
    });
    expect(fetcher.mock.calls[0]?.[0]).toBe(
      "https://gitlab.com/api/v4/projects/group%2Fsubgroup%2Fapp/merge_requests/7",
    );
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
      redirect: "error",
      headers: { authorization: "Bearer private-token" },
    });
  });
  it("merges the exact reviewed head and never asks for unguarded auto-merge", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const forge = new GitLabForge({
      token: "secret",
      fetch: async (input, init) => {
        calls.push({ url: String(input), init });
        return Response.json({
          ...mr,
          state: "merged",
          merge_commit_sha: "b".repeat(40),
        });
      },
    });
    expect(
      await forge.mergePull(repo, 7, { sha: SHA, method: "squash" }),
    ).toMatchObject({ merged: true });
    expect(calls[0]!.url).toContain(
      "group%2Fsubgroup%2Fapp/merge_requests/7/merge",
    );
    expect(calls[0]!.init).toMatchObject({
      method: "PUT",
      redirect: "error",
      headers: { authorization: "Bearer secret" },
    });
    expect(JSON.parse(String(calls[0]!.init?.body))).toMatchObject({
      sha: SHA,
      squash: true,
    });
    await expect(forge.enableAutoMerge(repo, 7, "squash")).rejects.toThrow(
      "not enabled",
    );
  });
  it("refuses truncated file evidence", async () => {
    const forge = new GitLabForge({
      token: "secret",
      fetch: async () => Response.json({ ...mr, changes_count: "1000+" }),
    });
    await expect(forge.listPullFiles(repo, 7)).rejects.toThrow("truncated");
  });
  it("includes both sides of renames in exact file evidence", async () => {
    const forge = new GitLabForge({
      token: "secret",
      fetch: async (input) =>
        String(input).includes("/diffs?")
          ? Response.json(
              [{ old_path: "old.ts", new_path: "new.ts", renamed_file: true }],
              { headers: { "x-next-page": "" } },
            )
          : Response.json(mr),
    });
    expect(await forge.listPullFiles(repo, 7)).toEqual(["new.ts", "old.ts"]);
  });
  it.each(["manual", "skipped", "failed"])(
    "does not call a %s job successful",
    async (status) => {
      const forge = new GitLabForge({
        token: "secret",
        fetch: async (input) => {
          const url = String(input);
          return Response.json(
            url.includes("/statuses?")
              ? []
              : url.includes("/jobs?")
                ? [{ id: 1, name: "test", status, allow_failure: true }]
                : url.includes("/pipelines?")
                  ? [{ id: 2 }]
                  : { id: 2, sha: SHA, status: "success" },
          );
        },
      });
      expect((await forge.getChecks(repo, SHA)).status).toBe(
        status === "failed" ? "failure" : "pending",
      );
    },
  );
  it("does not reflect private response bodies or credential-bearing parse errors", async () => {
    const forge = new GitLabForge({
      token: "super-secret",
      fetch: async () =>
        new Response("private account token super-secret", { status: 200 }),
    });
    await expect(forge.getPull(repo, 7)).rejects.toThrow("malformed JSON");
  });
});
