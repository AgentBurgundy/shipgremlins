import { afterEach, describe, expect, it, vi } from "vitest";
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { doctorChecks, runDoctor } from "./doctor.ts";
import { loadProject, type Project } from "../config.ts";
import { initializeSetup } from "../setup/files.ts";
import { SourceControlError } from "../sourceControl/types.ts";
import { OAuthConnectionError } from "../oauthConnection/types.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe("workspace browser credential safety", () => {
  it.each(["project.json", "areas.json", "tiers.json"])(
    "does not verify settings changed in %s while CLI checks are in flight",
    async (filename) => {
      const root = mkdtempSync(
        join(realpathSync(tmpdir()), "gremlins-doctor-race-"),
      );
      roots.push(root);
      initializeSetup(root, fileURLToPath(new URL("../..", import.meta.url)), {
        project: "demo",
        repo: "org/demo",
      });
      const areaPath = join(root, "projects/demo/areas.json");
      const areas = JSON.parse(readFileSync(areaPath, "utf8"));
      areas.areas.core.linearProjectId = "linear-project";
      writeFileSync(areaPath, JSON.stringify(areas));
      const file = join(root, "projects/demo", filename);
      const original = readFileSync(file, "utf8");
      let changed: string | undefined;
      const output: string[] = [];
      const result = await runDoctor(
        root,
        ["demo"],
        {
          log: (text) => output.push(text),
          error: (text) => output.push(text),
        },
        {
          env: { GITHUB_TOKEN: "source", LINEAR_API_KEY: "linear" },
          today: () => "2026-10-05",
          fetch: async () => {
            if (!changed) {
              const value = JSON.parse(original);
              if (filename === "project.json")
                value.commands.test = "npm run test:updated";
              else if (filename === "areas.json")
                value.areas.core.schedule = "0 14 * * 1-5";
              else value.alwaysFree = ["new-docs/"];
              changed = JSON.stringify(value);
              writeFileSync(file, changed);
            }
            return Response.json({
              data: { project: { name: "Test project" } },
            });
          },
        },
      );
      expect(result).toBe(1);
      expect(output.join("\n")).toContain(
        "settings changed during verification",
      );
      expect(loadProject(root, "demo").config.verified).toBeNull();
      expect(readFileSync(file, "utf8")).toBe(changed);
    },
  );
  it.each(["hosting", "telemetry"])(
    "blocks a cross-project %s credential before doctor makes any network request",
    async (kind) => {
      const root = mkdtempSync(
        join(realpathSync(tmpdir()), "gremlins-doctor-scope-"),
      );
      roots.push(root);
      const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
      const secret =
        kind === "hosting" ? "RAILWAY_ACCOUNT_A" : "SENTRY_AUTH_TOKEN_A";
      initializeSetup(root, packageRoot, {
        project: "browser",
        repo: "org/browser",
        settings: {
          verification: { mode: "browser", environment: "qa" },
          environments: {
            qa: {
              kind: "vercel",
              role: "preview",
              projectId: "prj_qa",
              bypassSecret: secret,
            },
          },
        },
      });
      initializeSetup(root, packageRoot, {
        project: "infra",
        repo: "org/infra",
        settings:
          kind === "hosting"
            ? {
                verification: { mode: "repository" },
                environments: {
                  stage: {
                    kind: "railway",
                    role: "staging",
                    projectId: "project",
                    environmentId: "stage",
                    serviceId: "api",
                    tokenSecret: secret,
                  },
                },
              }
            : undefined,
      });
      if (kind === "telemetry") {
        const path = join(root, "projects/infra/project.json");
        const config = JSON.parse(readFileSync(path, "utf8"));
        config.telemetry = {
          sentry: {
            host: "sentry.io",
            organization: "org",
            project: "infra",
            environment: "staging",
            tokenSecret: secret,
          },
        };
        writeFileSync(path, JSON.stringify(config));
      }
      const fetcher = vi.fn(async () => Response.json({}));
      const resolver = vi.fn(async () => ({
        provider: "vercel" as const,
        url: "https://qa.example.com",
      }));
      const deps = {
        root,
        env: {
          GITHUB_TOKEN: "source",
          LINEAR_API_KEY: "linear",
          [secret]: "never-send-controller-secret",
        },
        today: () => "2026-10-05",
        fetch: fetcher,
        resolveEnvironment: resolver,
      };
      const checks = await doctorChecks(loadProject(root, "browser"), deps);
      expect(checks).toEqual([
        expect.objectContaining({
          name: "browser credential safety",
          ok: false,
        }),
      ]);
      const output: string[] = [];
      expect(
        await runDoctor(
          root,
          ["browser"],
          {
            log: (text) => output.push(text),
            error: (text) => output.push(text),
          },
          { ...deps, root: undefined },
        ),
      ).toBe(1);
      expect(fetcher).not.toHaveBeenCalled();
      expect(resolver).not.toHaveBeenCalled();
      expect(JSON.stringify({ checks, output })).not.toContain(
        "never-send-controller-secret",
      );
      expect(loadProject(root, "browser").config.verified).toBeNull();
    },
  );
});

describe("selected project capabilities in doctor", () => {
  const project = (
    verification: unknown = { mode: "repository" },
    environments: unknown = {},
  ): Project =>
    ({
      config: {
        repo: "org/app",
        workflow: { kind: "pull-request", baseBranch: "main" },
        verification,
        environments,
        branches: { production: "main", staging: "main", integration: "main" },
      },
      areas: [],
    }) as unknown as Project;
  it("checks only the chosen repository branch and ignores unused hosting connections", async () => {
    const fetcher = vi.fn(async () => Response.json({}));
    const resolveCredential = vi.fn(async () => {
      throw new Error("Not required");
    });
    const checks = await doctorChecks(project(), {
      env: { GITHUB_TOKEN: "source", LINEAR_API_KEY: "linear" },
      today: () => "2026-10-05",
      fetch: fetcher,
      vercelConnection: { resolveCredential },
    });
    expect(checks.every((check) => check.ok)).toBe(true);
    expect(fetcher.mock.calls).toHaveLength(2);
    expect(resolveCredential).not.toHaveBeenCalled();
    expect(
      checks
        .filter((check) => check.name.startsWith("branch "))
        .map((check) => check.name),
    ).toEqual(["branch base"]);
  });
  it("requires an HTTP response for direct URLs and stops bounded redirect loops", async () => {
    let requests = 0;
    const checks = await doctorChecks(
      project(
        { mode: "browser", environment: "qa" },
        { qa: { kind: "url", role: "staging", url: "http://localhost:4567/" } },
      ),
      {
        env: { GITHUB_TOKEN: "source", LINEAR_API_KEY: "linear" },
        today: () => "2026-10-05",
        fetch: async (url) => {
          if (url.startsWith("http://localhost")) {
            requests++;
            return new Response(null, {
              status: 302,
              headers: { location: "/loop" },
            });
          }
          return Response.json({});
        },
      },
    );
    expect(requests).toBe(4);
    expect(
      checks.find((check) => check.name === "browser environment")?.ok,
    ).toBe(false);
  });
  it.each(["http", "https"])(
    "preserves the original %s Docker alias for an injected probe",
    async (protocol) => {
      const fetcher = vi.fn(async () => Response.json({}));
      const checks = await doctorChecks(
        project(
          { mode: "browser", environment: "local" },
          {
            local: {
              kind: "url",
              role: "staging",
              url: `${protocol}://host.docker.internal:4567/health`,
            },
          },
        ),
        {
          env: { GITHUB_TOKEN: "source", LINEAR_API_KEY: "linear" },
          today: () => "2026-10-05",
          fetch: fetcher,
        },
      );
      expect(checks.every((check) => check.ok)).toBe(true);
      expect(fetcher).toHaveBeenCalledWith(
        `${protocol}://host.docker.internal:4567/health`,
        expect.objectContaining({ headers: {}, redirect: "manual" }),
      );
    },
  );
  it("checks the selected deployed branch and never forwards preview bypass on cross-origin redirects", async () => {
    const calls: Array<{ url: string; headers: Headers }> = [];
    const target = project(
      { mode: "browser", environment: "qa" },
      {
        qa: {
          kind: "vercel",
          role: "preview",
          projectId: "prj_qa",
          branch: "develop",
          bypassSecret: "QA_BYPASS",
        },
      },
    );
    const checks = await doctorChecks(target, {
      env: {
        GITHUB_TOKEN: "source",
        LINEAR_API_KEY: "linear",
        QA_BYPASS: "private-bypass",
      },
      today: () => "2026-10-05",
      resolveEnvironment: async () => ({
        provider: "vercel",
        url: "https://qa.example.com/",
      }),
      fetch: async (url, init) => {
        calls.push({ url, headers: new Headers(init?.headers) });
        return url === "https://qa.example.com/"
          ? new Response(null, {
              status: 302,
              headers: { location: "https://login.example.com/" },
            })
          : Response.json({});
      },
    });
    expect(checks.every((check) => check.ok)).toBe(true);
    expect(calls.some((call) => call.url.endsWith("/branches/develop"))).toBe(
      true,
    );
    expect(
      calls
        .find((call) => call.url === "https://qa.example.com/")
        ?.headers.get("x-vercel-protection-bypass"),
    ).toBe("private-bypass");
    expect(
      calls
        .find((call) => call.url === "https://login.example.com/")
        ?.headers.has("x-vercel-protection-bypass"),
    ).toBe(false);
    expect(JSON.stringify(checks)).not.toContain("private-bypass");
  });
});

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
              ? {
                  deployments: [
                    {
                      uid: "dpl_test",
                      readyState: "READY",
                      meta: { gitlabCommitRef: "pm-staging" },
                    },
                  ],
                }
              : url.includes("/v13/deployments/")
                ? {
                    readyState: "READY",
                    url: "preview.example.com",
                    projectId: "prj_demo",
                  }
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
            teamId: null,
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
              ? {
                  deployments: [
                    {
                      uid: "dpl_test",
                      readyState: "READY",
                      meta: { githubCommitRef: "pm-staging" },
                    },
                  ],
                }
              : url.includes("/v13/deployments/")
                ? {
                    readyState: "READY",
                    url: "preview.example.com",
                    projectId: "prj_app",
                  }
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
