import { afterEach, describe, expect, it, vi } from "vitest";
import { VercelApi } from "./vercel.ts";

type Call = { url: URL; headers: Headers };

const dep = (over: Record<string, unknown> = {}) => ({
  uid: "dpl_1",
  name: "game",
  url: "game-abc123-team.vercel.app",
  state: "READY",
  created: Date.parse("2026-10-02T11:00:00Z"),
  meta: { githubCommitRef: "pm-staging", githubCommitSha: "f".repeat(40) },
  ...over,
});

function stubVercel(
  deployments: unknown[],
  detail: (id: string) => unknown = () => null,
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
        body = detail(url.pathname.split("/").pop()!);
        if (body === null)
          return new Response(JSON.stringify({ error: {} }), { status: 404 });
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
    expect(q.searchParams.get("target")).toBe("preview");
    expect(q.searchParams.get("limit")).toBe("20");
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
      [dep({ meta: { githubCommitRef: "pm/game-12", githubCommitSha: "1" } })],
      () => ({
        alias: ["game-git-pm-game-12-team.vercel.app"],
      }),
    );
    await expect(client().branchUrl("prj_1", null, "pm/game-12")).resolves.toBe(
      "https://game-git-pm-game-12-team.vercel.app",
    );
  });

  it("falls back to the deployment url when no branch alias exists or the detail 404s", async () => {
    stubVercel([dep()], () => ({ alias: ["game-abc123-team.vercel.app"] }));
    await expect(client().branchUrl("prj_1", null, "pm-staging")).resolves.toBe(
      "https://game-abc123-team.vercel.app",
    );
    vi.unstubAllGlobals();
    stubVercel([dep()]);
    await expect(client().branchUrl("prj_1", null, "pm-staging")).resolves.toBe(
      "https://game-abc123-team.vercel.app",
    );
  });

  it("is null when the branch has no deployment", async () => {
    stubVercel([]);
    await expect(
      client().branchUrl("prj_1", null, "pm-staging"),
    ).resolves.toBeNull();
  });
});
