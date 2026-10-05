import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectConfig } from "../config.ts";
import { withProjectClients } from "./projectClients.ts";

const config: ProjectConfig = {
  name: "app",
  repo: "owner/app",
  branches: {
    production: "main",
    staging: "staging",
    integration: "pm-staging",
  },
  workflow: { kind: "promotion" },
  verification: { mode: "browser", environment: "test" },
  environments: {
    test: {
      kind: "vercel",
      role: "preview",
      projectId: "prj_selected",
      teamId: "team_selected",
      connectionId: "selected",
      customEnvironmentId: "env_selected",
    },
  },
  database: "none",
  slackWebhookSecret: "SLACK_APP",
  runnerLabel: null,
  mergeMethod: "squash",
  commands: {
    install: "npm ci",
    test: "npm test",
    lint: null,
    typecheck: null,
  },
  verified: null,
  signIn: null,
};
function options() {
  const releaseLease = vi.fn(async () => {});
  return {
    root: "unused",
    env: { GITHUB_TOKEN: "test-source" },
    linearConnectionFor: vi.fn(() => ({
      acquireLease: async () => ({
        token: "linear",
        authorization: "Bearer linear",
        method: "oauth" as const,
      }),
      releaseLease,
    })),
    vercelConnectionFor: vi.fn(() => ({
      resolveCredential: vi.fn(async () => ({
        token: "selected-token",
        authorization: "Bearer selected-token",
        method: "oauth" as const,
      })),
    })),
  };
}
afterEach(() => vi.unstubAllGlobals());

describe("project-scoped Vercel clients", () => {
  it("keeps the selected team and custom environment even when the credential has no default team", async () => {
    const fetcher = vi.fn(async (input: string, init?: RequestInit) => {
      const url = new URL(input);
      expect(url.searchParams.get("teamId")).toBe("team_selected");
      expect(new Headers(init?.headers).get("authorization")).toBe(
        "Bearer selected-token",
      );
      const deployment = {
        uid: "dpl_selected",
        id: "dpl_selected",
        projectId: "prj_selected",
        ownerId: "team_selected",
        customEnvironmentId: "env_selected",
        state: "READY",
        url: "app-selected.vercel.app",
        created: 1000,
        meta: {
          githubCommitRef: "pm-staging",
          githubCommitSha: "a".repeat(40),
        },
      };
      if (url.pathname === "/v6/deployments") {
        expect(url.searchParams.has("target")).toBe(false);
        return Response.json({ deployments: [deployment] });
      }
      return Response.json(deployment);
    });
    vi.stubGlobal("fetch", fetcher);
    const selected = options();
    await withProjectClients(selected, config, async (clients) => {
      await expect(
        clients.vercel.latestDeployment("prj_selected", null, "pm-staging"),
      ).resolves.toMatchObject({ id: "dpl_selected" });
      await expect(
        clients.vercel.branchUrl("prj_selected", null, "pm-staging"),
      ).resolves.toBe("https://app-selected.vercel.app");
    });
    expect(selected.vercelConnectionFor).toHaveBeenCalledWith("selected");
    expect(fetcher).toHaveBeenCalledTimes(4);
  });
  it.each([
    ["prj_other", "team_selected"],
    ["prj_selected", "team_other"],
  ])(
    "refuses to reuse selected credentials for another project/team",
    async (projectId, teamId) => {
      const fetcher = vi.fn();
      vi.stubGlobal("fetch", fetcher);
      await expect(
        withProjectClients(options(), config, async (clients) =>
          clients.vercel.latestDeployment(projectId, teamId, "pm-staging"),
        ),
      ).rejects.toThrow("selected project and team");
      expect(fetcher).not.toHaveBeenCalled();
    },
  );
});
