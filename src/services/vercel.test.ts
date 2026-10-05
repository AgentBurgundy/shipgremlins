import { afterEach, describe, expect, it, vi } from "vitest";
import { VercelApi } from "./vercel.ts";

type Call = { url: URL; headers: Headers };

const dep = (over: Record<string, unknown> = {}) => ({
  uid: "dpl_1",
  projectId: "prj_1",
  ownerId: "team_1",
  name: "game",
  url: "game-abc123-team.vercel.app",
  state: "READY",
  created: Date.parse("2026-10-02T11:00:00Z"),
  meta: { githubCommitRef: "pm-staging", githubCommitSha: "f".repeat(40) },
  ...over,
});

function stubVercel(
  deployments: unknown[],
  detail?: (id: string) => unknown,
): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init: RequestInit = {}) => {
      const url = new URL(input);
      calls.push({ url, headers: new Headers(init.headers) });
      let body: unknown;
      if (url.pathname === "/v6/deployments") body = { deployments };
      else if (url.pathname.startsWith("/v13/deployments/")) {
        const id = url.pathname.split("/").pop()!;
        const extra = detail?.(id);
        if (extra === null)
          return new Response(JSON.stringify({ error: {} }), { status: 404 });
        body = {
          ...(deployments.find(
            (item) => (item as { uid: string }).uid === id,
          ) as object),
          id,
          ...(extra as object),
        };
      } else return new Response("nope", { status: 404 });
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }),
  );
  return calls;
}

const client = () => new VercelApi({ token: "vc_test" });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("latestDeployment", () => {
  it("recognizes GitLab branch and commit metadata", async () => {
    stubVercel([
      dep({
        meta: {
          gitlabCommitRef: "pm-staging",
          gitlabCommitSha: "e".repeat(40),
        },
      }),
    ]);
    await expect(
      client().latestDeployment("prj_1", null, "pm-staging"),
    ).resolves.toMatchObject({ branch: "pm-staging", sha: "e".repeat(40) });
  });
  it("lists v6 preview deployments for the project+team and picks the newest for the branch", async () => {
    const calls = stubVercel([
      dep({
        uid: "dpl_old",
        created: Date.parse("2026-10-02T09:00:00Z"),
        state: "ERROR",
      }),
      dep({
        uid: "dpl_other",
        meta: { githubCommitRef: "pm/game-12", githubCommitSha: "1" },
      }),
      dep({ uid: "dpl_new", created: Date.parse("2026-10-02T11:00:00Z") }),
    ]);
    const d = await client().latestDeployment("prj_1", "team_1", "pm-staging");
    expect(d).toEqual({
      id: "dpl_new",
      state: "READY",
      url: "game-abc123-team.vercel.app",
      sha: "f".repeat(40),
      branch: "pm-staging",
      createdAt: "2026-10-02T11:00:00.000Z",
    });
    const q = calls[0]!.url;
    expect(q.origin + q.pathname).toBe("https://api.vercel.com/v6/deployments");
    expect(q.searchParams.get("projectId")).toBe("prj_1");
    expect(q.searchParams.get("teamId")).toBe("team_1");
    expect(q.searchParams.get("branch")).toBe("pm-staging");
    expect(q.searchParams.get("target")).toBe("preview");
    expect(q.searchParams.get("limit")).toBe("100");
    expect(calls[0]!.headers.get("authorization")).toBe("Bearer vc_test");
  });

  it("omits teamId when null and returns null when no deployment matches the branch", async () => {
    const calls = stubVercel([
      dep({ meta: { githubCommitRef: "main", githubCommitSha: "1" } }),
    ]);
    await expect(
      client().latestDeployment("prj_1", null, "pm-staging"),
    ).resolves.toBeNull();
    expect(calls[0]!.url.searchParams.has("teamId")).toBe(false);
  });

  it("falls back to readyState and createdAt when the list uses those names", async () => {
    stubVercel([
      dep({
        state: undefined,
        readyState: "BUILDING",
        created: undefined,
        createdAt: Date.parse("2026-10-02T10:30:00Z"),
      }),
    ]);
    await expect(
      client().latestDeployment("prj_1", null, "pm-staging"),
    ).resolves.toMatchObject({
      state: "BUILDING",
      createdAt: "2026-10-02T10:30:00.000Z",
    });
  });
});

describe("branchUrl", () => {
  it("prefers the -git-<branch>- alias from the deployment detail", async () => {
    const calls = stubVercel([dep()], (id) => ({
      id,
      alias: [
        "game-abc123-team.vercel.app",
        "game-git-pm-staging-team.vercel.app",
      ],
    }));
    await expect(
      client().branchUrl("prj_1", "team_1", "pm-staging"),
    ).resolves.toBe("https://game-git-pm-staging-team.vercel.app");
    const detail = calls[1]!.url;
    expect(detail.pathname).toBe("/v13/deployments/dpl_1");
    expect(detail.searchParams.get("teamId")).toBe("team_1");
  });

  it("slugifies the branch when matching the alias", async () => {
    stubVercel(
      [
        dep({
          meta: {
            githubCommitRef: "pm/game-12",
            githubCommitSha: "1".repeat(40),
          },
        }),
      ],
      () => ({
        alias: ["game-git-pm-game-12-team.vercel.app"],
      }),
    );
    await expect(client().branchUrl("prj_1", null, "pm/game-12")).resolves.toBe(
      "https://game-git-pm-game-12-team.vercel.app",
    );
  });

  it("falls back to the deployment url only when confirmed detail has no branch alias", async () => {
    stubVercel([dep()], () => ({ alias: ["game-abc123-team.vercel.app"] }));
    await expect(client().branchUrl("prj_1", null, "pm-staging")).resolves.toBe(
      "https://game-abc123-team.vercel.app",
    );
    vi.unstubAllGlobals();
    stubVercel([dep()], () => null);
    await expect(client().branchUrl("prj_1", null, "pm-staging")).resolves.toBe(
      null,
    );
  });

  it("is null when the branch has no deployment", async () => {
    stubVercel([]);
    await expect(
      client().branchUrl("prj_1", null, "pm-staging"),
    ).resolves.toBeNull();
  });
});

describe("selected environment isolation", () => {
  it("omits the preview filter for a custom environment and selects only its exact deployment", async () => {
    const calls = stubVercel([
      dep({
        uid: "dpl_production",
        target: "production",
        customEnvironmentId: "env_test",
      }),
      dep({ uid: "dpl_other", customEnvironment: { id: "env_other" } }),
      dep({ uid: "dpl_preview" }),
      dep({ uid: "dpl_custom", customEnvironment: { id: "env_test" } }),
    ]);
    const api = new VercelApi({
      token: "vc_test",
      customEnvironmentId: "env_test",
    });
    await expect(
      api.latestDeployment("prj_1", "team_1", "pm-staging"),
    ).resolves.toMatchObject({ id: "dpl_custom", sha: "f".repeat(40) });
    expect(calls[0]!.url.searchParams.has("target")).toBe(false);
    expect(calls[1]!.url.pathname).toBe("/v13/deployments/dpl_custom");
  });
  it("never selects custom or production deployments for ordinary Preview", async () => {
    stubVercel([
      dep({ target: "production" }),
      dep({ customEnvironmentId: "env_test" }),
      dep({ target: "env_test" }),
    ]);
    await expect(
      client().latestDeployment("prj_1", "team_1", "pm-staging"),
    ).resolves.toBeNull();
  });
  it.each([
    { projectId: "prj_other" },
    { projectId: undefined },
    { ownerId: "team_other" },
    { teamId: "team_other" },
    { id: "dpl_other" },
    { target: "production" },
    { customEnvironmentId: "env_other" },
    { meta: { githubCommitRef: "main", githubCommitSha: "f".repeat(40) } },
    { meta: { githubCommitRef: "pm-staging", githubCommitSha: "not-a-sha" } },
    { url: "example.com@production.example.com/path" },
    { url: undefined },
  ])(
    "rejects deployment detail that no longer proves its selected scope: %j",
    async (changed) => {
      stubVercel([dep()], () => changed);
      await expect(
        client().latestDeployment("prj_1", "team_1", "pm-staging"),
      ).resolves.toBeNull();
    },
  );
  it("rechecks the custom environment in detail rather than trusting the list alone", async () => {
    stubVercel([dep({ customEnvironmentId: "env_test" })], () => ({
      customEnvironmentId: "env_other",
    }));
    const api = new VercelApi({
      token: "vc_test",
      customEnvironmentId: "env_test",
    });
    await expect(
      api.latestDeployment("prj_1", "team_1", "pm-staging"),
    ).resolves.toBeNull();
  });
  it("uses the immutable custom deployment URL instead of a shared branch alias", async () => {
    stubVercel([dep({ customEnvironmentId: "env_test" })], () => ({
      alias: ["game-git-pm-staging-team.vercel.app"],
    }));
    const api = new VercelApi({
      token: "vc_test",
      customEnvironmentId: "env_test",
    });
    await expect(api.branchUrl("prj_1", "team_1", "pm-staging")).resolves.toBe(
      "https://game-abc123-team.vercel.app",
    );
  });
  it("keeps a newer failed deployment visible instead of using an older healthy one", async () => {
    stubVercel([
      dep({ uid: "dpl_old", created: 1000 }),
      dep({ uid: "dpl_failed", state: "ERROR", created: 2000 }),
    ]);
    await expect(
      client().latestDeployment("prj_1", "team_1", "pm-staging"),
    ).resolves.toMatchObject({ id: "dpl_failed", state: "ERROR" });
    await expect(
      client().branchUrl("prj_1", "team_1", "pm-staging"),
    ).resolves.toBeNull();
  });
});
