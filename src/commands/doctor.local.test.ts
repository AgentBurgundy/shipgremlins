import { describe, expect, it } from "vitest";
import { doctorChecks } from "./doctor.ts";
import type { Project } from "../config.ts";
import { SourceControlError } from "../sourceControl/types.ts";
import { OAuthConnectionError } from "../oauthConnection/types.ts";

describe("GitLab local provider verification", () => {
  it("uses the chosen server, encodes a nested namespace and slash-containing branches", async () => {
    const calls: { url: string; headers: Headers }[] = [];
    const project = {
      config: {
        provider: "gitlab",
        repo: "group/subgroup/app",
        serverUrl: "https://gitlab.example.com",
        branches: {
          production: "main",
          staging: "release/staging",
          integration: "pm-staging",
        },
        vercel: {
          projectId: "prj_demo",
          teamId: null,
          bypassSecret: "VERCEL_BYPASS_DEMO",
        },
        slackWebhookSecret: "SLACK_OPTIONAL",
      },
      areas: [],
    } as unknown as Project;
    const checks = await doctorChecks(project, {
      env: {
        GITLAB_TOKEN: "source-secret",
        VERCEL_TOKEN: "hosting-secret",
        LINEAR_API_KEY: "linear-secret",
        VERCEL_BYPASS_DEMO: "bypass-secret",
      },
      today: () => "2026-10-04",
      fetch: async (url, init) => {
        calls.push({ url, headers: new Headers(init?.headers) });
        return new Response(
          JSON.stringify(
            url.includes("/deployments?")
              ? { deployments: [{ meta: { gitlabCommitRef: "pm-staging" } }] }
              : {},
          ),
          { status: 200 },
        );
      },
    });
    expect(checks.every((check) => check.ok)).toBe(true);
    expect(
      calls
        .filter((call) => call.url.startsWith("https://gitlab.example.com"))
        .map((call) => call.url),
    ).toEqual([
      "https://gitlab.example.com/api/v4/projects/group%2Fsubgroup%2Fapp",
      "https://gitlab.example.com/api/v4/projects/group%2Fsubgroup%2Fapp/repository/branches/main",
      "https://gitlab.example.com/api/v4/projects/group%2Fsubgroup%2Fapp/repository/branches/release%2Fstaging",
      "https://gitlab.example.com/api/v4/projects/group%2Fsubgroup%2Fapp/repository/branches/pm-staging",
    ]);
    expect(calls.some((call) => call.url.includes("api.github.com"))).toBe(
      false,
    );
    expect(JSON.stringify(checks)).not.toContain("source-secret");
  });
});

describe("official source connections in doctor", () => {
  const project = {
    config: {
      provider: "github",
      repo: "owner/app",
      branches: {
        production: "main",
        staging: "staging",
        integration: "pm-staging",
      },
      vercel: { projectId: "prj_app", teamId: null, bypassSecret: "BYPASS" },
    },
    areas: [],
  } as unknown as Project;

  it("uses the official connection instead of a stale environment token and never prints it", async () => {
    const calls: { url: string; headers: Headers }[] = [];
    const checks = await doctorChecks(project, {
      env: { GITHUB_TOKEN: "stale-pat", BYPASS: "bypass" },
      today: () => "2026-10-04",
      sourceControl: {
        resolveCredential: async (input) => {
          expect(input).toEqual({
            provider: "github",
            repository: "owner/app",
            serverUrl: undefined,
            minValidityMs: 300000,
            write: true,
          });
          return { token: "connected-oauth-secret", method: "oauth" };
        },
      },
      fetch: async (url, init) => {
        calls.push({ url, headers: new Headers(init?.headers) });
        return Response.json({});
      },
    });
    expect(checks.find((check) => check.name === "GITHUB_TOKEN")).toMatchObject(
      { ok: true, detail: "connected with the official app" },
    );
    expect(
      calls
        .filter((call) => call.url.startsWith("https://api.github.com"))
        .every(
          (call) =>
            call.headers.get("authorization") ===
            "Bearer connected-oauth-secret",
        ),
    ).toBe(true);
    expect(JSON.stringify(checks)).not.toContain("connected-oauth-secret");
  });

  it.each(["refresh_blocked", "revoked"])(
    "reports %s safely and does not silently use a saved PAT",
    async (code) => {
      const calls: string[] = [];
      const checks = await doctorChecks(project, {
        env: { GITHUB_TOKEN: "stale-pat", BYPASS: "bypass" },
        today: () => "2026-10-04",
        sourceControl: {
          resolveCredential: async () => {
            throw new SourceControlError("private provider credential", code);
          },
        },
        fetch: async (url) => {
          calls.push(url);
          return Response.json({});
        },
      });
      expect(checks.find((check) => check.name === "GITHUB_TOKEN")?.ok).toBe(
        false,
      );
      expect(
        calls.some((url) => url.startsWith("https://api.github.com")),
      ).toBe(false);
      expect(JSON.stringify(checks)).not.toContain(
        "private provider credential",
      );
    },
  );
});

describe("Linear and Vercel OAuth verification", () => {
  const project = {
    config: {
      provider: "github",
      repo: "owner/app",
      branches: {
        production: "main",
        staging: "staging",
        integration: "pm-staging",
      },
      vercel: { projectId: "prj_app", teamId: null, bypassSecret: "BYPASS" },
    },
    areas: [{ key: "core", linearProjectId: "linear-project" }],
  } as unknown as Project;
  it("uses OAuth with no manual keys and inherits the Vercel installation team", async () => {
    const calls: { url: string; headers: Headers }[] = [];
    const checks = await doctorChecks(project, {
      env: { GITHUB_TOKEN: "source", BYPASS: "preview" },
      today: () => "2026-10-04",
      linearConnection: {
        resolveCredential: async () => ({
          token: "linear-private",
          authorization: "Bearer linear-private",
          method: "oauth",
        }),
      },
      vercelConnection: {
        resolveCredential: async (input) => {
          expect(input).toEqual({
            projectId: "prj_app",
            minValidityMs: 300000,
          });
          return {
            token: "vercel-private",
            authorization: "Bearer vercel-private",
            method: "oauth",
            teamId: "team_installation",
          };
        },
      },
      fetch: async (url, init) => {
        calls.push({ url, headers: new Headers(init?.headers) });
        return Response.json(
          url.includes("linear.app")
            ? { data: { project: { id: "linear-project", name: "Core" } } }
            : url.includes("/deployments?")
              ? { deployments: [{ meta: { githubCommitRef: "pm-staging" } }] }
              : {},
        );
      },
    });
    expect(checks.every((check) => check.ok)).toBe(true);
    expect(
      calls
        .filter((call) => call.url.includes("api.vercel.com"))
        .every(
          (call) =>
            new URL(call.url).searchParams.get("teamId") ===
              "team_installation" &&
            call.headers.get("authorization") === "Bearer vercel-private",
        ),
    ).toBe(true);
    expect(
      calls
        .find((call) => call.url.includes("api.linear.app"))
        ?.headers.get("authorization"),
    ).toBe("Bearer linear-private");
    expect(JSON.stringify(checks)).not.toContain("private");
  });
  it.each(["reconnect_required", "refresh_blocked"])(
    "reports %s without using stale manual credentials",
    async (code) => {
      const calls: string[] = [];
      const failed = {
        resolveCredential: async () => {
          throw new OAuthConnectionError("sensitive-provider-response", code);
        },
      };
      const checks = await doctorChecks(project, {
        env: {
          LINEAR_API_KEY: "old-linear",
          VERCEL_TOKEN: "old-vercel",
          BYPASS: "preview",
        },
        today: () => "2026-10-04",
        linearConnection: failed,
        vercelConnection: failed,
        fetch: async (url) => {
          calls.push(url);
          return Response.json({});
        },
      });
      expect(
        checks
          .filter((check) =>
            ["LINEAR_API_KEY", "VERCEL_TOKEN"].includes(check.name),
          )
          .every((check) => !check.ok),
      ).toBe(true);
      expect(calls.some((url) => /api\.(linear|vercel)\./.test(url))).toBe(
        false,
      );
      expect(JSON.stringify(checks)).not.toMatch(
        /sensitive-provider-response|old-linear|old-vercel/,
      );
    },
  );
});
