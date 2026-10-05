import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSourceControl } from "./index.ts";
import { repositoryOwners } from "./repositoryCreation.ts";
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function fixture(gitlab = false, organization = false) {
  const root = mkdtempSync(
    join(realpathSync(tmpdir()), "gremlins-create-repo-"),
  );
  roots.push(root);
  const owner = organization ? "team" : "owner";
  let repository: Record<string, unknown> | undefined,
    lost = false,
    denied = false,
    account = 1;
  const calls: {
    path: string;
    method: string;
    body?: Record<string, unknown>;
  }[] = [];
  const fetcher = vi.fn(
    async (url: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("authorization")).toBe(
        "Bearer synthetic-token",
      );
      const path = new URL(String(url)).pathname.replace(/^\/api\/v4/, "");
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ path, method, body });
      if (method === "POST") {
        if (denied)
          return Response.json(
            { message: "private diagnostic" },
            { status: 403 },
          );
        repository = {
          id: 42,
          full_name: `${owner}/studio`,
          path_with_namespace: `${owner}/studio`,
          description: body.description,
          private: body.private,
          visibility: body.visibility,
          default_branch: null,
          permissions: { push: true },
        };
        if (lost) {
          lost = false;
          throw new Error("Lost acknowledgment");
        }
        return Response.json(repository, { status: 201 });
      }
      if (path === "/user")
        return Response.json({
          id: account,
          login: "owner",
          username: "owner",
        });
      if (path.startsWith("/users/") || path.startsWith("/namespaces/"))
        return Response.json({
          id: organization ? 2 : 1,
          login: owner,
          full_path: owner,
          type: organization ? "Organization" : "User",
        });
      return repository
        ? Response.json(repository)
        : Response.json({}, { status: 404 });
    },
  );
  const service = createSourceControl({
    root,
    env: gitlab
      ? { GITLAB_TOKEN: "synthetic-token" }
      : { GITHUB_TOKEN: "synthetic-token" },
    fetch: fetcher,
  });
  const input = {
    provider: gitlab ? ("gitlab" as const) : ("github" as const),
    ...(gitlab ? { serverUrl: "https://gitlab.example.com" } : {}),
    ownerId: organization ? "2" : "1",
    accountId: "1",
    repository: `${owner}/studio`,
    visibility: "private" as "private" | "public",
    creationId: "11111111-1111-4111-8111-111111111111",
  };
  return {
    service,
    input,
    calls,
    lost: () => {
      lost = true;
    },
    denied: () => {
      denied = true;
    },
    changeAccount: () => {
      account = 99;
    },
    existing: (patch = {}) => {
      repository = {
        id: 42,
        full_name: `${owner}/studio`,
        path_with_namespace: `${owner}/studio`,
        private: true,
        visibility: "private",
        description: "An unrelated app",
        ...patch,
      };
    },
  };
}
describe("new repositories", () => {
  it.each([
    [false, false],
    [false, true],
    [true, false],
    [true, true],
  ])(
    "creates a private repository with the reviewed owner (GitLab %s, group %s)",
    async (gitlab, group) => {
      const f = fixture(gitlab, group);
      const repo = await f.service.createRepository!(f.input);
      expect(repo).toMatchObject({
        id: "42",
        private: true,
        fullName: f.input.repository,
      });
      const post = f.calls.find((call) => call.method === "POST")!;
      expect(post.path).toBe(
        gitlab ? "/projects" : group ? "/orgs/team/repos" : "/user/repos",
      );
      expect(post.body).toMatchObject(
        gitlab
          ? {
              visibility: "private",
              namespace_id: group ? 2 : 1,
              initialize_with_readme: false,
            }
          : { private: true, auto_init: false },
      );
      expect(JSON.stringify(post.body)).not.toContain("synthetic-token");
    },
  );
  it.each([false, true])(
    "requires an explicit public selection (GitLab %s)",
    async (gitlab) => {
      const f = fixture(gitlab);
      await f.service.createRepository!({ ...f.input, visibility: "public" });
      expect(
        f.calls.find((call) => call.method === "POST")!.body,
      ).toMatchObject(gitlab ? { visibility: "public" } : { private: false });
    },
  );
  it.each([false, true])(
    "recovers a lost create acknowledgment without a second write (GitLab %s)",
    async (gitlab) => {
      const f = fixture(gitlab);
      f.lost();
      await expect(f.service.createRepository!(f.input)).rejects.toThrow(
        "retry",
      );
      await expect(f.service.createRepository!(f.input)).resolves.toMatchObject(
        { id: "42" },
      );
      expect(f.calls.filter((call) => call.method === "POST")).toHaveLength(1);
    },
  );
  it("refuses to adopt an existing repository or overwrite its visibility", async () => {
    const f = fixture();
    f.existing();
    await expect(f.service.createRepository!(f.input)).rejects.toThrow(
      "not adopted",
    );
    expect(f.calls.some((call) => call.method !== "GET")).toBe(false);
    f.existing({
      description: `Created with ShipGremlins. Setup: ${f.input.creationId}`,
      private: false,
    });
    await expect(f.service.createRepository!(f.input)).rejects.toThrow(
      "visibility",
    );
  });
  it("binds source account and owner, and reports permissions without provider diagnostics", async () => {
    const f = fixture();
    f.changeAccount();
    await expect(f.service.createRepository!(f.input)).rejects.toThrow(
      "account changed",
    );
    expect(f.calls.some((call) => call.method === "POST")).toBe(false);
    const g = fixture();
    g.denied();
    await expect(g.service.createRepository!(g.input)).rejects.toThrow(
      "Repository creation (write)",
    );
    await expect(
      g.service.createRepository!({ ...g.input, ownerId: "90" }),
    ).rejects.toThrow("reviewed destination");
    const h = fixture();
    await expect(
      h.service.createRepository!({
        ...h.input,
        visibility: "PUBLIC" as "public",
      }),
    ).rejects.toThrow("visibility");
    expect(h.calls).toHaveLength(0);
  });
  it("lists personal and organization owners without treating missing org permission as missing personal access", async () => {
    const request = vi.fn(async (path: string) => ({
      status: path === "/user" ? 200 : 403,
      data: { id: 1, login: "owner" },
    }));
    expect(await repositoryOwners("github", request)).toEqual({
      accountId: "1",
      owners: [{ id: "1", path: "owner", name: "owner" }],
      truncated: false,
    });
  });
});
