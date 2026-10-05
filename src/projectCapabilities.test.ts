import { describe, expect, it } from "vitest";
import { makeProject } from "./services/fakes.ts";
import {
  baseBranch,
  effectiveVerification,
  effectiveWorkflow,
  parseProjectCapabilities,
  projectSecretNames,
  promotionVercel,
  supportsLegacyCI,
  validateWorkerSecretReferences,
  validBranch,
} from "./projectCapabilities.ts";

describe("project capabilities", () => {
  it("supports disposable browser apps but never grants Docker promotion proof", () => {
    const raw = {
      workflow: { kind: "pull-request", baseBranch: "main" },
      verification: { mode: "browser", environment: "local" },
      environments: {
        local: {
          kind: "docker",
          role: "preview",
          recipe: {
            kind: "dockerfile",
            dockerfile: "Dockerfile",
            context: ".",
          },
          port: 3000,
          env: { APP_KEY: "APP_TEST_KEY" },
          access: {
            kind: "password",
            loginPath: "/login",
            usernameSelector: "#user",
            passwordSelector: "#password",
            submitSelector: "button",
            successSelector: "#signed-in",
            accounts: [
              {
                name: "Tester",
                usernameSecret: "TEST_USER",
                passwordSecret: "TEST_PASSWORD",
              },
            ],
          },
        },
      },
    };
    const config = {
      ...makeProject().config,
      ...parseProjectCapabilities(raw),
      vercel: undefined,
    };
    expect(effectiveVerification(config)).toMatchObject({
      mode: "browser",
      target: { kind: "docker" },
    });
    expect(projectSecretNames(config)).toEqual([
      "TEST_USER",
      "TEST_PASSWORD",
      "APP_TEST_KEY",
    ]);
    expect(promotionVercel(config)).toBeNull();
    expect(() =>
      parseProjectCapabilities({
        ...raw,
        workflow: { kind: "promotion", candidateEnvironment: "local" },
      }),
    ).toThrow("nonproduction Vercel or Railway");
    config.environments!.host = {
      kind: "railway",
      role: "preview",
      projectId: "p",
      environmentId: "e",
      serviceId: "s",
      tokenSecret: "APP_TEST_KEY",
    };
    expect(() => validateWorkerSecretReferences(config)).toThrow(
      "dedicated test",
    );
  });
  it("requires a distinct nonproduction provider target for candidate verification", () => {
    const raw = {
      workflow: { kind: "promotion", candidateEnvironment: "candidate" },
      verification: { mode: "browser", environment: "integration" },
      environments: {
        integration: {
          kind: "railway",
          role: "preview",
          projectId: "project",
          environmentId: "integration",
          serviceId: "web",
        },
        candidate: {
          kind: "railway",
          role: "preview",
          projectId: "project",
          environmentId: "candidate",
          serviceId: "web",
        },
      },
    };
    expect(parseProjectCapabilities(raw).workflow).toEqual({
      kind: "promotion",
      candidateEnvironment: "candidate",
    });
    raw.environments.candidate.role = "production";
    expect(() => parseProjectCapabilities(raw)).toThrow("nonproduction");
    raw.environments.candidate.role = "preview";
    raw.environments.candidate.environmentId = "integration";
    expect(() => parseProjectCapabilities(raw)).toThrow(
      "separate service instances",
    );
  });
  it("does not allow controller or custom hosting credentials into browser jobs", () => {
    const config = makeProject().config;
    config.vercel = {
      projectId: "prj_test",
      teamId: null,
      bypassSecret: "VERCEL_TOKEN",
    };
    expect(() => validateWorkerSecretReferences(config)).toThrow(
      /dedicated test/,
    );
    config.vercel.bypassSecret = "HOSTING_TEAM_TWO";
    config.environments = {
      test: {
        kind: "railway",
        role: "preview",
        projectId: "p",
        environmentId: "e",
        serviceId: "s",
        tokenSecret: "HOSTING_TEAM_TWO",
      },
    };
    expect(() => validateWorkerSecretReferences(config)).toThrow(
      /dedicated test/,
    );
  });
  it("preserves the existing Vercel promotion workflow", () => {
    const config = makeProject().config;
    expect(effectiveWorkflow(config)).toEqual({ kind: "promotion" });
    expect(baseBranch(config)).toBe("pm-staging");
    expect(effectiveVerification(config)).toMatchObject({
      mode: "browser",
      environment: "integration",
      target: { kind: "vercel", role: "preview" },
    });
    expect(promotionVercel(config)?.projectId).toBe(config.vercel?.projectId);
    expect(supportsLegacyCI(config)).toBe(true);
  });

  it("selects one browser target independently of hosting, branches and other environments", () => {
    const capabilities = parseProjectCapabilities({
      workflow: { kind: "pull-request", baseBranch: "develop" },
      verification: { mode: "browser", environment: "homelab" },
      environments: {
        homelab: {
          kind: "url",
          role: "staging",
          url: "http://192.168.1.3:8080/app",
        },
        prod: {
          kind: "cloud-run",
          role: "production",
          projectId: "my-gcp-project",
          region: "us-central1",
          service: "app",
        },
        preview: {
          kind: "railway",
          role: "preview",
          projectId: "project",
          environmentId: "test",
          serviceId: "api",
          tokenSecret: "RAILWAY_TEAM_TWO",
          tokenType: "project",
        },
      },
    });
    const config = { ...makeProject().config, ...capabilities };
    expect(baseBranch(config)).toBe("develop");
    expect(effectiveVerification(config)).toMatchObject({
      environment: "homelab",
      target: { kind: "url" },
    });
    expect(promotionVercel(config)).toBeNull();
    expect(supportsLegacyCI(config)).toBe(false);
    expect(projectSecretNames(config)).toEqual(
      expect.arrayContaining(["RAILWAY_TEAM_TWO", "GCP_SERVICE_ACCOUNT_JSON"]),
    );
  });

  it("repository mode overrides a preserved legacy deployment without silently deleting it", () => {
    const config = {
      ...makeProject().config,
      ...parseProjectCapabilities({
        workflow: { kind: "pull-request", baseBranch: "main" },
        verification: { mode: "repository" },
      }),
    };
    expect(effectiveVerification(config)).toEqual({ mode: "repository" });
    expect(config.vercel).toBeDefined();
    expect(promotionVercel(config)).toBeNull();
  });

  it.each([
    {
      environments: {
        prod: { kind: "url", role: "production", url: "https://prod.example" },
      },
      verification: { mode: "browser", environment: "prod" },
    },
    {
      environments: {
        preview: { kind: "url", role: "preview", url: "https://test.example" },
      },
      verification: { mode: "browser", environment: "missing" },
    },
    {
      environments: {
        preview: { kind: "url", role: "preview", url: "https://test.example" },
      },
    },
    {
      environments: {
        preview: {
          kind: "vercel",
          role: "preview",
          projectId: "prj",
          bypassSecret: "NODE_OPTIONS",
        },
      },
      verification: { mode: "repository" },
    },
    {
      environments: {
        preview: {
          kind: "railway",
          role: "preview",
          projectId: "p",
          environmentId: "e",
          serviceId: "s",
          token: "secret-value",
        },
      },
      verification: { mode: "repository" },
    },
    {
      environments: {
        preview: {
          kind: "cloud-run",
          role: "preview",
          projectId: "p",
          region: "r",
          service: "../../other",
          credentialsSecret: "GCP_JSON",
        },
      },
      verification: { mode: "repository" },
    },
    {
      environments: {
        preview: {
          kind: "url",
          role: "preview",
          url: "https://user:secret@example.com",
        },
      },
      verification: { mode: "repository" },
    },
    {
      environments: {
        preview: {
          kind: "url",
          role: "preview",
          url: "https://example.com/?token=secret",
        },
      },
      verification: { mode: "repository" },
    },
    {
      environments: {
        preview: { kind: "url", role: "preview", url: "file:///etc/passwd" },
      },
      verification: { mode: "repository" },
    },
    JSON.parse(
      '{"environments":{"__proto__":{"kind":"url","role":"preview","url":"https://example.com"}},"verification":{"mode":"repository"}}',
    ),
  ])("rejects unsafe or ambiguous environment configuration %#", (raw) => {
    expect(() => parseProjectCapabilities(raw)).toThrow();
  });

  it("runtime selection also refuses production after an in-memory config change", () => {
    const config = makeProject().config;
    config.environments = {
      prod: { kind: "url", role: "production", url: "https://example.com" },
    };
    config.verification = { mode: "browser", environment: "prod" };
    expect(() => effectiveVerification(config)).toThrow(/preview or staging/);
  });

  it.each([
    "--help",
    "origin/main..evil",
    "bad branch",
    "refs/foo.lock",
    "a/@{0}",
    "a\\b",
    "a//b",
    "a/.hidden",
  ])("rejects unsafe base branch %s", (branch) => {
    expect(validBranch(branch)).toBe(false);
    expect(() =>
      parseProjectCapabilities({
        workflow: { kind: "pull-request", baseBranch: branch },
      }),
    ).toThrow(/baseBranch/);
  });
});
