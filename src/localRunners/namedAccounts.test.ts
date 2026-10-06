import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
import { initializeSetup } from "../setup/files.ts";
import { createConnectionProfile } from "../oauthConnection/profiles.ts";
import { createJobPreparation } from "./jobs.ts";
import type { LocalJob } from "./types.ts";
import type { LinearTicket } from "../services/types.ts";
import { doctorChecks } from "../commands/doctor.ts";
import type { CredentialRequest } from "../oauthConnection/types.ts";
import { loadProject } from "../config.ts";
import { inspectSetup } from "../setup/preflight.ts";
import { resolveEnvironment } from "../hosting/index.ts";
import { readMetric } from "../commands/metric.ts";
import {
  withLinearCredential,
  withProjectClients,
} from "../services/projectClients.ts";

let root: string;
const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
const workspace = {
  alpha: "11111111-1111-4111-8111-111111111111",
  beta: "22222222-2222-4222-8222-222222222222",
};
const env = {
  GITHUB_TOKEN: "legacy-source",
  LINEAR_API_KEY: "never-default-linear",
  VERCEL_TOKEN: "never-default-vercel",
  CLAUDE_CODE_OAUTH_TOKEN: "model",
};
// Test fixtures intentionally cover two different JSON document shapes.
function change(
  name: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  action: (data: Record<string, any>) => void,
  file = "project.json",
) {
  const path = join(root, "projects", name, file);
  const data = JSON.parse(readFileSync(path, "utf8"));
  action(data);
  writeFileSync(path, JSON.stringify(data));
}
function issue(name: string): LinearTicket {
  return {
    id: `${name}-issue-id`,
    identifier: "ENG-123",
    title: "Fix form",
    description:
      "## Acceptance criteria\n- The valid form submission persists after reload.",
    labels: ["pm:core", "pm-approved"],
    projectId: `${name}-linear-project`,
    stateType: "unstarted",
    priority: 1,
    createdAt: "2026-10-04T00:00:00Z",
    updatedAt: "2026-10-04T00:00:00Z",
    url: "https://linear.app/example/issue/ENG-123",
  };
}
function job(name: string): LocalJob {
  return {
    id: `job-${name}`,
    runId: 1,
    type: "developer",
    project: name,
    ticket: "ENG-123",
    status: "queued",
    createdAt: "2026-10-04T00:00:00Z",
  };
}
function accounts() {
  const linear = Object.fromEntries(
    Object.entries(workspace).map(([name, workspaceId]) => {
      const credential = {
        token: `${name}-linear-token`,
        authorization: `Bearer ${name}-linear-token`,
        method: "oauth" as const,
        workspaceId,
      };
      return [
        name,
        {
          resolveCredential: vi.fn(async () => credential),
          acquireLease: vi.fn(
            async (
              _input: CredentialRequest & { jobId: string; minutes?: number },
            ) => credential,
          ),
          releaseLease: vi.fn(async (_jobId: string) => {}),
        },
      ];
    }),
  );
  const vercel = Object.fromEntries(
    Object.keys(workspace).map((name) => [
      name,
      {
        resolveCredential: vi.fn(async () => ({
          token: `${name}-vercel-token`,
          authorization: `Bearer ${name}-vercel-token`,
          method: "oauth" as const,
          teamId: `team_${name}`,
        })),
      },
    ]),
  );
  const linearFor = vi.fn((id = "default") => {
    if (!linear[id])
      return {
        resolveCredential: vi.fn(async () => {
          throw new Error("default must not be used");
        }),
        acquireLease: vi.fn(
          async (
            _input: CredentialRequest & { jobId: string; minutes?: number },
          ) => {
            throw new Error("default must not be used");
          },
        ),
        releaseLease: vi.fn(async (_jobId: string) => {}),
      };
    return linear[id]!;
  });
  const vercelFor = vi.fn((id = "default") => {
    if (!vercel[id]) throw new Error("default must not be used");
    return vercel[id]!;
  });
  return { linear, vercel, linearFor, vercelFor };
}
beforeEach(async () => {
  vi.spyOn(globalThis, "fetch").mockRejectedValue(
    new Error(
      "Unexpected provider request in an isolated account-routing test.",
    ),
  );
  root = mkdtempSync(join(realpathSync(tmpdir()), "gremlins-named-routing-"));
  for (const name of ["alpha", "beta"] as const) {
    initializeSetup(root, packageRoot, {
      project: name,
      repo: `owner/${name}`,
    });
    change(name, (data) => {
      data.linear = { connectionId: name, workspaceId: workspace[name] };
      data.verification = { mode: "browser", environment: "qa" };
      data.environments = {
        qa: {
          kind: "vercel",
          role: "preview",
          projectId: `prj_${name}`,
          teamId: `team_${name}`,
          connectionId: name,
        },
      };
      data.verified = "2026-10-04";
    });
    change(
      name,
      (data) => {
        data.areas.core.enabled = true;
        data.areas.core.linearProjectId = `${name}-linear-project`;
        data.areas.core.schedule = "0 9 * * *";
      },
      "areas.json",
    );
    await createConnectionProfile(root, {
      provider: "linear",
      id: name,
      label: name,
    });
  }
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

describe("project account isolation", () => {
  it("routes two projects' issue lookups, leases and previews to their own accounts", async () => {
    const a = accounts();
    const lookedUp: string[] = [];
    const preview = vi.fn(
      async (_project: unknown, _token: string) =>
        "https://preview.example.com",
    );
    const prep = createJobPreparation({
      root,
      env,
      linearConnectionFor: a.linearFor,
      vercelConnectionFor: a.vercelFor,
      preview,
      linear: (authorization) => ({
        getTicket: async () => {
          lookedUp.push(authorization);
          return issue(authorization.includes("alpha") ? "alpha" : "beta");
        },
        listTickets: async () => [],
      }),
    });
    for (const name of ["alpha", "beta"] as const) {
      const request = job(name);
      const validated = await prep.validate(request);
      expect(validated.linearBinding).toEqual({
        connectionId: name,
        workspaceId: workspace[name],
        ticketId: `${name}-issue-id`,
      });
      const payload = await prep.prepareJob({
        ...request,
        linearBinding: validated.linearBinding,
      });
      expect(payload.credentials?.LINEAR_API_KEY).toBe(`${name}-linear-token`);
      expect(JSON.stringify(payload)).not.toContain("vercel-token");
      expect(JSON.stringify(payload)).not.toContain("never-default");
      expect(a.linear[name]!.acquireLease).toHaveBeenCalledWith({
        jobId: request.id,
        minutes: 50,
        workspaceId: workspace[name],
      });
      expect(a.vercel[name]!.resolveCredential).toHaveBeenCalledWith({
        projectId: `prj_${name}`,
        teamId: `team_${name}`,
        minValidityMs: 300000,
      });
      expect(
        preview.mock.calls.find((call) => call[1] === `${name}-vercel-token`),
      ).toBeTruthy();
    }
    expect(lookedUp).toEqual([
      "Bearer alpha-linear-token",
      "Bearer alpha-linear-token",
      "Bearer beta-linear-token",
      "Bearer beta-linear-token",
    ]);
  });
  it("rejects queued issue identifiers after account rebinding, even when both workspaces have ENG-123", async () => {
    const a = accounts();
    const lookup = vi.fn(async () => issue("alpha"));
    const prep = createJobPreparation({
      root,
      env,
      linearConnectionFor: a.linearFor,
      linear: () => ({ getTicket: lookup, listTickets: async () => [] }),
    });
    const validated = await prep.validate(job("alpha"));
    change("alpha", (data) => {
      data.linear = { connectionId: "beta", workspaceId: workspace.beta };
    });
    await expect(
      prep.prepareJob({
        ...job("alpha"),
        linearBinding: validated.linearBinding,
      }),
    ).rejects.toThrow(/account changed/);
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(a.linear.beta!.acquireLease).not.toHaveBeenCalled();
  });
  it("rejects changed ticket UUIDs and legacy queued jobs without a named-account binding", async () => {
    const a = accounts();
    let ticket = issue("alpha");
    const prep = createJobPreparation({
      root,
      env,
      linearConnectionFor: a.linearFor,
      linear: () => ({
        getTicket: async () => ticket,
        listTickets: async () => [],
      }),
    });
    const validated = await prep.validate(job("alpha"));
    ticket = { ...ticket, id: "different-issue" };
    await expect(
      prep.prepareJob({
        ...job("alpha"),
        linearBinding: validated.linearBinding,
      }),
    ).rejects.toThrow(/no longer matches/);
    await expect(prep.prepareJob(job("alpha"))).rejects.toThrow(/predates/);
  });
  it("releases the original profile after a controller restart and config rebind", async () => {
    const a = accounts();
    change("alpha", (data) => {
      data.linear = { connectionId: "beta", workspaceId: workspace.beta };
    });
    const prep = createJobPreparation({
      root,
      env,
      linearConnectionFor: a.linearFor,
    });
    await prep.releaseJobResources("job-original");
    expect(a.linear.alpha!.releaseLease).toHaveBeenCalledWith("job-original");
    expect(a.linear.beta!.releaseLease).toHaveBeenCalledWith("job-original");
    expect(a.linear.alpha!.releaseLease).toHaveBeenCalledTimes(1);
  });
  it("uses each selected account during scheduled approved-ticket discovery", async () => {
    const a = accounts();
    const prep = createJobPreparation({
      root,
      env,
      linearConnectionFor: a.linearFor,
      now: () => new Date("2026-10-04T09:00:00Z"),
      linear: (authorization) => ({
        getTicket: async () => null,
        listTickets: async () => [
          issue(authorization.includes("alpha") ? "alpha" : "beta"),
        ],
      }),
    });
    const jobs = (await prep.scheduledJobs()).filter(
      (job) => job.type === "developer",
    );
    expect(jobs.map((job) => [job.project, job.linearBinding])).toEqual(
      Object.entries(workspace).map(([name, workspaceId]) => [
        name,
        { connectionId: name, workspaceId, ticketId: `${name}-issue-id` },
      ]),
    );
  });
  it("fails closed for an unconnected named profile despite exported default tokens", async () => {
    const prep = createJobPreparation({ root, env });
    await expect(prep.validate(job("alpha"))).rejects.toThrow(
      /connect|account/i,
    );
    const target = loadProject(root, "alpha").config.environments!.qa!;
    const fallback = vi.fn(async () => ({
      token: "must-not-use",
      authorization: "must-not-use",
      method: "token" as const,
    }));
    await expect(
      resolveEnvironment(target, {
        env,
        branch: "main",
        vercelConnection: { resolveCredential: fallback },
      }),
    ).rejects.toThrow(/Vercel connection/);
    expect(fallback).not.toHaveBeenCalled();
  });
  it("preflight requires the selected profile instead of any connected account or default token", () => {
    const status = {
      provider: "linear" as const,
      method: "oauth" as const,
      connected: true,
    };
    const report = inspectSetup(
      root,
      {
        env,
        probe: () => ({ available: true }),
        oauthConnections: [
          { ...status, connectionId: "beta" },
          {
            provider: "vercel",
            method: "oauth",
            connected: true,
            connectionId: "beta",
          },
        ],
      },
      "alpha",
    );
    expect(
      report.checks
        .filter((check) => check.id.startsWith("oauth:"))
        .map((check) => [check.id, check.status]),
    ).toEqual([
      ["oauth:linear:alpha", "fail"],
      ["oauth:vercel:alpha", "fail"],
    ]);
    const ready = inspectSetup(
      root,
      {
        env,
        probe: () => ({ available: true }),
        oauthConnections: [
          { ...status, id: "alpha" },
          { provider: "vercel", method: "oauth", connected: true, id: "alpha" },
        ],
      },
      "alpha",
    );
    expect(
      ready.checks
        .filter((check) => check.id.startsWith("oauth:"))
        .every((check) => check.status === "pass"),
    ).toBe(true);
  });
  it("doctor sends selected Linear authorization and never falls back after resolution failure", async () => {
    const a = accounts();
    const authorization: string[] = [];
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("linear.app"))
        authorization.push(new Headers(init?.headers).get("authorization")!);
      return Response.json({ data: { project: { name: "Mapped PM" } } });
    });
    for (const name of ["alpha", "beta"]) {
      const checks = await doctorChecks(loadProject(root, name), {
        root,
        env,
        today: () => "2026-10-04",
        fetch: fetcher,
        linearConnectionFor: a.linearFor,
        resolveEnvironment: async (target, options) => {
          await options.vercelConnectionFor!(
            (target as { connectionId?: string }).connectionId,
          ).resolveCredential();
          return { provider: "vercel", url: "https://preview.example.com" };
        },
        vercelConnectionFor: a.vercelFor,
      });
      expect(checks.find((check) => check.name === "LINEAR_API_KEY")?.ok).toBe(
        true,
      );
    }
    expect(authorization).toEqual([
      "Bearer alpha-linear-token",
      "Bearer beta-linear-token",
    ]);
    a.linear.alpha!.resolveCredential.mockRejectedValueOnce(
      new Error("revoked"),
    );
    const checks = await doctorChecks(loadProject(root, "alpha"), {
      root,
      env,
      today: () => "2026-10-04",
      fetch: fetcher,
      linearConnectionFor: a.linearFor,
      resolveEnvironment: async () => ({
        provider: "vercel",
        url: "https://preview.example.com",
      }),
    });
    expect(checks.find((check) => check.name === "LINEAR_API_KEY")?.ok).toBe(
      false,
    );
    expect(authorization).toHaveLength(2);
  });
  it("validates safe profile IDs and retains account-only Linear setup before team provisioning", () => {
    expect(loadProject(root, "alpha").config.linear).toEqual({
      connectionId: "alpha",
      workspaceId: workspace.alpha,
    });
    change("alpha", (data) => {
      data.linear.connectionId = "../beta";
    });
    expect(() => loadProject(root, "alpha")).toThrow(/connectionId|linear/i);
    change("alpha", (data) => {
      data.linear.connectionId = "alpha";
      data.environments.qa.connectionId = "CON";
    });
    expect(() => loadProject(root, "alpha")).toThrow(/account|connectionId/i);
  });
  it("analytics use the target account and keep named profiles unavailable without a resolver", async () => {
    const a = accounts();
    const project = loadProject(root, "alpha");
    const fetcher = vi.fn(async (_url: string, _init?: RequestInit) =>
      Response.json({ total: 4 }),
    );
    expect(
      await readMetric(project.config, project.areas[0]!, {
        env,
        fetch: fetcher,
      }),
    ).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
    expect(
      await readMetric(project.config, project.areas[0]!, {
        env,
        fetch: fetcher,
        vercelConnectionFor: a.vercelFor,
      }),
    ).toEqual({ d7: 4, d28: 4 });
    for (const [url, init] of fetcher.mock.calls) {
      expect(new URL(url).searchParams.get("teamId")).toBe("team_alpha");
      expect(new Headers(init?.headers).get("authorization")).toBe(
        "Bearer alpha-vercel-token",
      );
    }
  });
  it("CLI scoped clients reserve and release the selected Linear profile, including command failure", async () => {
    const a = accounts();
    const config = loadProject(root, "alpha").config;
    await expect(
      withLinearCredential(
        { root, env, linearConnectionFor: a.linearFor },
        config,
        async (authorization) => {
          expect(authorization).toBe("Bearer alpha-linear-token");
          throw new Error("command failed");
        },
      ),
    ).rejects.toThrow("command failed");
    const acquired = a.linear.alpha!.acquireLease.mock.calls[0]![0];
    const fetcher = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(Response.json({ deployments: [] }));
    expect(acquired.workspaceId).toBe(workspace.alpha);
    expect(a.linear.alpha!.releaseLease).toHaveBeenCalledWith(acquired.jobId);
    change("alpha", (data) => {
      data.workflow = { kind: "promotion" };
      data.branches = {
        production: "main",
        staging: "staging",
        integration: "pm-staging",
      };
    });
    await withProjectClients(
      {
        root,
        env,
        linearConnectionFor: a.linearFor,
        vercelConnectionFor: a.vercelFor,
      },
      loadProject(root, "alpha").config,
      async (clients) => {
        expect(clients.linear).toBeDefined();
        await clients.vercel.latestDeployment("prj_alpha", null, "main");
      },
    );
    expect(a.vercelFor).toHaveBeenCalledWith("alpha");
    expect(
      new URL(String(fetcher.mock.calls[0]![0])).searchParams.get("teamId"),
    ).toBe("team_alpha");
    expect(
      new Headers(fetcher.mock.calls[0]![1]?.headers).get("authorization"),
    ).toBe("Bearer alpha-vercel-token");
  });
});
