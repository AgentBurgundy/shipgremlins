import { describe, expect, it } from "vitest";
import { doctorChecks } from "./doctor.ts";
import type { Project } from "../config.ts";

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
