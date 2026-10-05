import { describe, expect, it, vi } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { resolveEnvironment, type HostingOptions } from "./index.ts";
import { parseGoogleServiceAccount } from "./credentials.ts";
import type { EnvironmentTarget } from "../projectCapabilities.ts";

const railway: EnvironmentTarget = {
  kind: "railway",
  role: "preview",
  projectId: "project-id",
  environmentId: "environment-id",
  serviceId: "service-id",
};
const cloud: EnvironmentTarget = {
  kind: "cloud-run",
  role: "staging",
  projectId: "example-project",
  region: "us-central1",
  service: "example-app",
};
const vercel: EnvironmentTarget = {
  kind: "vercel",
  role: "preview",
  projectId: "prj_example",
};
const hash = "a".repeat(40);
const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });
function railwayData() {
  return {
    data: {
      service: { id: "service-id", projectId: "project-id" },
      environments: { edges: [{ node: { id: "environment-id" } }] },
      projectToken: {
        projectId: "project-id",
        environmentId: "environment-id",
      },
      serviceInstance: {
        latestDeployment: {
          id: "deployment-id",
          status: "SUCCESS",
          meta: { branch: "develop", commitHash: hash },
        },
      },
      domains: {
        serviceDomains: [{ domain: "preview.up.railway.app" }],
        customDomains: [] as unknown[],
      },
    },
  };
}
function cloudData() {
  return {
    name: "projects/example-project/locations/us-central1/services/example-app",
    generation: "5",
    observedGeneration: "5",
    reconciling: false,
    terminalCondition: { state: "CONDITION_SUCCEEDED" },
    latestCreatedRevision: "example-app-00005",
    latestReadyRevision: "example-app-00005",
    uri: "https://example-app-123.us-central1.run.app",
    ingress: "INGRESS_TRAFFIC_ALL",
    trafficStatuses: [{ revision: "example-app-00005", percent: 100 }],
  };
}
function options(
  body: unknown,
  env: HostingOptions["env"] = { RAILWAY_TOKEN: "private-railway-token" },
) {
  return { env, branch: "develop", fetch: vi.fn(async () => response(body)) };
}
const key = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ type: "pkcs8", format: "pem" })
  .toString();
const googleKey = () => ({
  type: "service_account",
  project_id: "key-project",
  client_email: "robot@key-project.iam.gserviceaccount.com",
  private_key: key,
  token_uri: "https://oauth2.googleapis.com/token",
});

describe("hosting environment resolution", () => {
  it("accepts an explicit URL without contacting a provider or requiring credentials", async () => {
    const opts = options({});
    expect(
      await resolveEnvironment(
        { kind: "url", role: "staging", url: "http://app.internal:3000/demo" },
        opts,
      ),
    ).toEqual({ provider: "url", url: "http://app.internal:3000/demo" });
    expect(opts.fetch).not.toHaveBeenCalled();
  });
  it.each([
    "https://user:secret@example.com",
    "https://example.com/?token=secret",
    "file:///etc/passwd",
  ])("rejects credential-bearing and non-web explicit URLs", async (url) => {
    await expect(
      resolveEnvironment({ kind: "url", role: "preview", url }, options({})),
    ).rejects.toMatchObject({ code: "not_ready" });
  });
  it("rejects production targets before any request", async () => {
    const opts = options({});
    await expect(
      resolveEnvironment({ ...railway, role: "production" }, opts),
    ).rejects.toMatchObject({ code: "invalid" });
    expect(opts.fetch).not.toHaveBeenCalled();
  });
  it("resolves scoped Railway readiness, domain and commit with controller-only credentials", async () => {
    const opts = options(railwayData());
    const result = await resolveEnvironment(railway, opts);
    expect(result).toEqual({
      provider: "railway",
      url: "https://preview.up.railway.app",
      deploymentId: "deployment-id",
      commitSha: hash,
      branch: "develop",
    });
    expect(JSON.stringify(result)).not.toContain("private-railway-token");
    const [url, init] = (opts.fetch.mock.calls as unknown[][])[0]!;
    expect(url).toBe("https://backboard.railway.com/graphql/v2");
    expect(init).toMatchObject({
      redirect: "error",
      method: "POST",
      headers: { Authorization: "Bearer private-railway-token" },
    });
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.variables).toEqual({
      projectId: "project-id",
      environmentId: "environment-id",
      serviceId: "service-id",
    });
    expect(body.query).not.toContain("mutation");
  });
  it("uses an explicit named Railway project token and checks its environment scope", async () => {
    const opts = options(railwayData(), {
      RAILWAY_TOKEN: "wrong-shared-account",
      RAILWAY_APP: "scoped-token",
    });
    await resolveEnvironment(
      { ...railway, tokenSecret: "RAILWAY_APP", tokenType: "project" },
      opts,
    );
    const init = (opts.fetch.mock.calls as unknown[][])[0]![1] as RequestInit;
    expect(init.headers).toEqual({
      "Content-Type": "application/json",
      "Project-Access-Token": "scoped-token",
    });
    const bad = railwayData();
    bad.data.projectToken.environmentId = "production";
    await expect(
      resolveEnvironment({ ...railway, tokenType: "project" }, options(bad)),
    ).rejects.toMatchObject({ code: "forbidden" });
  });
  it.each(["environment", "service", "project", "status", "branch"])(
    "fails closed on Railway %s mismatch",
    async (field) => {
      const data = railwayData();
      if (field === "environment") data.data.environments.edges = [];
      if (field === "service") data.data.service.id = "other";
      if (field === "project") data.data.service.projectId = "other";
      if (field === "status")
        data.data.serviceInstance.latestDeployment.status = "BUILDING";
      if (field === "branch")
        data.data.serviceInstance.latestDeployment.meta.branch = "main";
      await expect(
        resolveEnvironment(railway, options(data)),
      ).rejects.toThrow();
    },
  );
  it("accepts only verified Railway custom domains when no service domain exists", async () => {
    const data = railwayData();
    data.data.domains.serviceDomains = [];
    data.data.domains.customDomains = [
      {
        domain: "staging.example.com",
        status: {
          certificateStatus: "PENDING",
          dnsRecords: [{ status: "VALID" }],
        },
      },
    ];
    await expect(
      resolveEnvironment(railway, options(data)),
    ).rejects.toMatchObject({ code: "not_ready" });
    data.data.domains.customDomains = [
      {
        domain: "staging.example.com",
        status: {
          certificateStatus: "ISSUED",
          dnsRecords: [{ status: "VALID" }],
        },
      },
    ];
    expect((await resolveEnvironment(railway, options(data))).url).toBe(
      "https://staging.example.com",
    );
  });
  it("does not expose upstream errors or retry authentication with a different token type", async () => {
    const opts = options({
      errors: [{ message: "private-railway-token upstream-stack" }],
    });
    await expect(resolveEnvironment(railway, opts)).rejects.toThrow(
      "Check the token type",
    );
    expect(opts.fetch).toHaveBeenCalledTimes(1);
  });
  it("resolves Cloud Run only after the current generation is ready, using ADC when no saved key exists", async () => {
    const opts = {
      ...options(cloudData(), {}),
      googleAccessToken: vi.fn(async () => "google-private-token"),
    };
    expect(await resolveEnvironment(cloud, opts)).toEqual({
      provider: "cloud-run",
      url: cloudData().uri,
      deploymentId: "example-app-00005",
    });
    expect(opts.googleAccessToken).toHaveBeenCalledWith(
      undefined,
      expect.any(AbortSignal),
    );
    const [url, init] = (opts.fetch.mock.calls as unknown[][])[0]!;
    expect(url).toBe(
      "https://run.googleapis.com/v2/projects/example-project/locations/us-central1/services/example-app",
    );
    expect(init).toMatchObject({
      headers: { Authorization: "Bearer google-private-token" },
      redirect: "error",
    });
  });
  it("projects validated named Google credentials before requesting an access token", async () => {
    const opts = {
      ...options(cloudData(), {
        GCP_OTHER: JSON.stringify({ ...googleKey(), unknown: "discard-me" }),
      }),
      googleAccessToken: vi.fn(async () => "token"),
    };
    await resolveEnvironment(
      { ...cloud, credentialsSecret: "GCP_OTHER" },
      opts,
    );
    expect((opts.googleAccessToken.mock.calls as unknown[][])[0]?.[0]).toEqual(
      googleKey(),
    );
  });
  it("does not silently fall back to ADC when an explicit named credential is missing", async () => {
    const auth = vi.fn(async () => "token");
    await expect(
      resolveEnvironment(
        { ...cloud, credentialsSecret: "GCP_MISSING" },
        { ...options(cloudData(), {}), googleAccessToken: auth },
      ),
    ).rejects.toMatchObject({ code: "credentials" });
    expect(auth).not.toHaveBeenCalled();
  });
  it("accepts a one-letter Cloud Run service name", async () => {
    const data = {
      ...cloudData(),
      name: "projects/example-project/locations/us-central1/services/a",
    };
    const result = await resolveEnvironment(
      { ...cloud, service: "a" },
      { ...options(data, {}), googleAccessToken: async () => "token" },
    );
    expect(result.provider).toBe("cloud-run");
  });
  it.each([
    { reconciling: true },
    { terminalCondition: { state: "CONDITION_FAILED" } },
    { observedGeneration: "4" },
    { latestReadyRevision: "old" },
    { defaultUriDisabled: true },
    { ingress: "INGRESS_TRAFFIC_INTERNAL_ONLY" },
    { iapEnabled: true },
    {
      name: "projects/example-project/locations/us-central1/services/other-app",
    },
    { uri: "https://attacker.example.com" },
  ])(
    "rejects unready, inaccessible or mismatched Cloud Run responses",
    async (change) => {
      await expect(
        resolveEnvironment(cloud, {
          ...options({ ...cloudData(), ...change }, {}),
          googleAccessToken: async () => "token",
        }),
      ).rejects.toThrow();
    },
  );
  it("does not claim a single Cloud Run deployment when traffic is split", async () => {
    const result = await resolveEnvironment(cloud, {
      ...options({
        ...cloudData(),
        trafficStatuses: [
          { revision: "one", percent: 50 },
          { revision: "two", percent: 50 },
        ],
      }),
      googleAccessToken: async () => "token",
    });
    expect(result.deploymentId).toBeUndefined();
    expect(result.commitSha).toBeUndefined();
  });
  it("bounds stalled Google authentication and sanitizes its failure", async () => {
    await expect(
      resolveEnvironment(cloud, {
        ...options({}),
        timeoutMs: 10,
        googleAccessToken: () => new Promise(() => {}),
      }),
    ).rejects.toThrow("Google Cloud authentication failed");
  });
  it.each([401, 403, 429, 500])(
    "sanitizes hosting HTTP %s failures",
    async (status) => {
      const fetch = vi.fn(async () =>
        response({ message: "do-not-print-this-secret" }, status),
      );
      const error = await resolveEnvironment(railway, {
        ...options({}),
        fetch,
      }).catch((error: Error) => error);
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).not.toContain("do-not-print-this-secret");
    },
  );
  it("rejects oversized upstream data", async () => {
    await expect(
      resolveEnvironment(railway, {
        ...options({}),
        fetch: async () => new Response("x".repeat(1_048_577)),
      }),
    ).rejects.toMatchObject({ code: "unavailable" });
  });
  it("resolves the newest ready Vercel branch deployment using the connected team", async () => {
    const resolveCredential = vi.fn(async () => ({
      token: "oauth-token",
      authorization: "Bearer oauth-token",
      method: "oauth" as const,
      teamId: "team_connected",
    }));
    const fetch = vi.fn(async (url: string) =>
      url.includes("/v6/")
        ? response({
            deployments: [
              {
                uid: "dpl_one",
                state: "READY",
                createdAt: 2,
                meta: { githubCommitRef: "develop" },
              },
              {
                uid: "dpl_prod",
                state: "READY",
                target: "production",
                createdAt: 3,
                meta: { githubCommitRef: "develop" },
              },
            ],
          })
        : response({
            id: "dpl_one",
            readyState: "READY",
            projectId: "prj_example",
            url: "preview.vercel.app",
            meta: { githubCommitSha: hash },
          }),
    );
    expect(
      await resolveEnvironment(
        { ...vercel, branch: "develop" },
        {
          env: { VERCEL_TOKEN: "ignored" },
          branch: "main",
          fetch,
          vercelConnection: { resolveCredential },
        },
      ),
    ).toEqual({
      provider: "vercel",
      deploymentId: "dpl_one",
      url: "https://preview.vercel.app",
      commitSha: hash,
      branch: "develop",
    });
    expect(
      fetch.mock.calls.every(
        ([url]) => new URL(url).searchParams.get("teamId") === "team_connected",
      ),
    ).toBe(true);
  });
  it("never falls back to a PAT when the selected Vercel OAuth connection is revoked", async () => {
    const opts = options({}, { VERCEL_TOKEN: "legacy-pat" });
    await expect(
      resolveEnvironment(vercel, {
        ...opts,
        vercelConnection: {
          resolveCredential: async () => {
            throw new Error("revoked-token");
          },
        },
      }),
    ).rejects.toMatchObject({ code: "credentials" });
    expect(opts.fetch).not.toHaveBeenCalled();
  });
  it("does not verify an older successful deployment while a newer branch deployment builds", async () => {
    await expect(
      resolveEnvironment(
        vercel,
        options(
          {
            deployments: [
              {
                uid: "older",
                state: "READY",
                created: 1,
                meta: { githubCommitRef: "develop" },
              },
              {
                uid: "newer",
                state: "BUILDING",
                created: 2,
                meta: { githubCommitRef: "develop" },
              },
            ],
          },
          { VERCEL_TOKEN: "token" },
        ),
      ),
    ).rejects.toMatchObject({ code: "not_ready" });
  });
});

describe("Google credential validation", () => {
  it.each([
    "123456789-compute@developer.gserviceaccount.com",
    "example-project@appspot.gserviceaccount.com",
  ])(
    "accepts official default service-account email formats",
    (client_email) => {
      expect(
        parseGoogleServiceAccount(
          JSON.stringify({ ...googleKey(), client_email }),
        ).client_email,
      ).toBe(client_email);
    },
  );
  it("accepts a service-account key and discards arbitrary extra fields", () => {
    expect(
      parseGoogleServiceAccount(
        JSON.stringify({ ...googleKey(), executable: "never-run" }),
      ),
    ).toEqual(googleKey());
  });
  it.each([
    { type: "external_account" },
    { token_uri: "https://attacker.example/token" },
    { universe_domain: "attacker.example" },
    { private_key: "secret-invalid-key" },
    { client_email: "attacker@example.com" },
  ])(
    "rejects unsafe or invalid externally supplied credential configurations",
    (change) => {
      expect(() =>
        parseGoogleServiceAccount(
          JSON.stringify({ ...googleKey(), ...change }),
        ),
      ).toThrow("Enter a valid Google service-account JSON");
    },
  );
});
