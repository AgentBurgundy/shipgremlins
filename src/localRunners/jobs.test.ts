import { realpathSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { initializeSetup } from "../setup/files.ts";
import type { LinearTicket } from "../services/types.ts";
import { createJobPreparation, scheduledThisMinute } from "./jobs.ts";
import type { LocalJob } from "./types.ts";
import { SourceControlError } from "../sourceControl/types.ts";
import { LocalJobDeferredError } from "./engine.ts";
import { OAuthConnectionError } from "../oauthConnection/types.ts";

let root: string;
const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
const ticket: LinearTicket = {
  id: "ticket-id",
  identifier: "APP-12",
  title: "Fix form",
  description: "Reproduce with test account",
  labels: ["pm:core", "pm-approved"],
  projectId: "linear-project",
  stateType: "unstarted",
  priority: 1,
  createdAt: "2026-10-01T00:00:00Z",
  updatedAt: "2026-10-01T00:00:00Z",
  url: "https://linear.app/example/APP-12",
};
const job: LocalJob = {
  id: "job-test",
  runId: 1,
  type: "developer",
  project: "app",
  ticket: "APP-12",
  status: "queued",
  createdAt: "2026-10-04T00:00:00Z",
};
const env = {
  GITHUB_TOKEN: "source-token",
  GITLAB_TOKEN: "gitlab-token",
  LINEAR_API_KEY: "linear-token",
  VERCEL_TOKEN: "vercel-token",
  CLAUDE_CODE_OAUTH_TOKEN: "claude-token",
  SHIPGREMLINS_ATTESTATION_KEY: "never-copy-signing-key",
  NODE_OPTIONS: "never-copy-options",
};
function edit(
  file: string,
  mutate: (raw: {
    verified: string | null;
    workflow?: unknown;
    verification?: unknown;
    environments?: unknown;
    branches?: { production: string; staging: string; integration: string };
    provider?: string;
    serverUrl?: string;
    repo: string;
    vercel: {
      projectId: string;
      teamId?: string | null;
      bypassSecret?: string;
    };
    areas: {
      core: { enabled: boolean; linearProjectId: string; schedule: string };
    };
  }) => void,
) {
  const path = join(root, "projects", "app", file);
  const raw = JSON.parse(readFileSync(path, "utf8"));
  mutate(raw);
  writeFileSync(path, JSON.stringify(raw));
}
beforeEach(() => {
  root = mkdtempSync(join(realpathSync(tmpdir()), "gremlins-jobs-"));
  initializeSetup(root, packageRoot, { project: "app", repo: "owner/app" });
  edit("project.json", (raw) => {
    raw.verified = "2026-10-04";
    raw.vercel = {
      projectId: "prj_test",
      teamId: null,
      bypassSecret: "VERCEL_BYPASS_APP",
    };
    raw.branches = {
      production: "main",
      staging: "staging",
      integration: "pm-staging",
    };
    delete raw.workflow;
    delete raw.verification;
    delete raw.environments;
  });
  edit("areas.json", (raw) => {
    raw.areas.core.enabled = true;
    raw.areas.core.linearProjectId = "linear-project";
    raw.areas.core.schedule = "0 9 * * *";
  });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
function setup(value: LinearTicket | null = ticket) {
  const getTicket = vi.fn(async () => value);
  const listTickets = vi.fn(async () => (value ? [value] : []));
  return {
    getTicket,
    ...createJobPreparation({
      root,
      env,
      linear: () => ({ getTicket, listTickets }),
      preview: async () => "https://app-preview.vercel.app",
      now: () => new Date("2026-10-04T09:00:45Z"),
    }),
  };
}
describe("local job preparation", () => {
  it("reviews repositories and targets the chosen branch without hosting or browser credentials", async () => {
    edit("project.json", (raw) => {
      raw.workflow = { kind: "pull-request", baseBranch: "release/current" };
      raw.verification = { mode: "repository" };
      raw.environments = {
        unused: {
          kind: "vercel",
          role: "preview",
          projectId: "prj_unused",
          bypassSecret: "UNUSED_BYPASS",
        },
      };
    });
    const resolveCredential = vi.fn(async () => {
      throw new Error("Hosting must not be used");
    });
    const resolveEnvironment = vi.fn(async () => {
      throw new Error("Hosting must not be used");
    });
    const prepared = createJobPreparation({
      root,
      env: { ...env, VERCEL_TOKEN: undefined },
      vercelConnection: { resolveCredential },
      resolveEnvironment,
      linear: () => ({
        getTicket: async () => ticket,
        listTickets: async () => [],
      }),
    });
    const payload = await prepared.prepareJob(job);
    expect(payload.branch).toBe("release/current");
    expect(payload.delivery?.base).toBe("release/current");
    expect(payload.browserVerification).toBe(false);
    expect(payload.prompt).toContain("Verification mode: repository");
    expect(payload.prompt).not.toContain("Use Playwright MCP");
    expect(payload.credentials).not.toHaveProperty("GREMLINS_PREVIEW_BYPASS");
    expect(payload.credentials).not.toHaveProperty("VERCEL_TOKEN");
    expect(resolveCredential).not.toHaveBeenCalled();
    expect(resolveEnvironment).not.toHaveBeenCalled();
    const pm = await prepared.prepareJob({
      ...job,
      type: "pm",
      area: "core",
      ticket: undefined,
    });
    expect(pm.prompt).toContain("file references and test output");
    expect(pm.delivery).toBeUndefined();
  });
  it("resolves only the selected browser environment and separates its baseline from the coding branch", async () => {
    edit("project.json", (raw) => {
      raw.workflow = { kind: "pull-request", baseBranch: "main" };
      raw.verification = { mode: "browser", environment: "qa" };
      raw.environments = {
        qa: {
          kind: "railway",
          role: "staging",
          projectId: "project",
          environmentId: "stage",
          serviceId: "web",
          branch: "develop",
          tokenSecret: "RAILWAY_QA",
        },
        unused: { kind: "vercel", role: "preview", projectId: "prj_unused" },
      };
    });
    const resolveEnvironment = vi.fn(async () => ({
      url: "https://qa.example.com",
      provider: "railway" as const,
      branch: "develop",
    }));
    const prepared = createJobPreparation({
      root,
      env: {
        ...env,
        VERCEL_TOKEN: undefined,
        RAILWAY_QA: "controller-only-token",
      },
      resolveEnvironment,
      linear: () => ({
        getTicket: async () => ticket,
        listTickets: async () => [],
      }),
    });
    const coding = await prepared.prepareJob(job);
    expect(coding.browserVerification).toBe(true);
    expect(coding.branch).toBe("main");
    expect(coding.delivery?.base).toBe("main");
    expect(coding.prompt).toContain("Deployed baseline branch: develop");
    expect(coding.prompt).toContain("not proof of an unmerged candidate");
    expect(JSON.stringify(coding)).not.toContain("controller-only-token");
    expect(coding.credentials).not.toHaveProperty("GREMLINS_PREVIEW_BYPASS");
    const pm = await prepared.prepareJob({
      ...job,
      type: "pm",
      area: "core",
      ticket: undefined,
    });
    expect(pm.branch).toBe("develop");
    expect(resolveEnvironment).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "railway", branch: "develop" }),
      expect.objectContaining({ branch: "develop" }),
    );
  });
  it("rejects preview credentials that alias another project's hosting credential", async () => {
    initializeSetup(root, packageRoot, {
      project: "infra",
      repo: "org/infra",
      settings: {
        verification: { mode: "repository" },
        environments: {
          stage: {
            kind: "railway",
            role: "staging",
            projectId: "project",
            environmentId: "stage",
            serviceId: "api",
            tokenSecret: "VERCEL_BYPASS_APP",
          },
        },
      },
    });
    await expect(setup().prepareJob(job)).rejects.toThrow(
      "aliases a controller hosting credential",
    );
  });
  it("uses the connected source token only after preparation and reserves a publication-safe lease", async () => {
    const acquireLease = vi.fn(async () => ({
      token: "official-oauth-token",
      method: "oauth" as const,
    }));
    const prepared = createJobPreparation({
      root,
      env: { ...env, GITHUB_TOKEN: undefined },
      sourceControl: { acquireLease },
      linear: () => ({
        getTicket: async () => ticket,
        listTickets: async () => [ticket],
      }),
      preview: async () => {
        expect(acquireLease).not.toHaveBeenCalled();
        return "https://preview.vercel.app";
      },
    });
    const payload = await prepared.prepareJob(job);
    expect(acquireLease).toHaveBeenCalledWith({
      jobId: job.id,
      provider: "github",
      repository: "owner/app",
      serverUrl: undefined,
      minutes: 50,
      write: true,
    });
    expect(payload.credentials?.GITHUB_TOKEN).toBe("official-oauth-token");
    expect(JSON.stringify(payload)).not.toContain("source-token");
    expect(payload.prompt).not.toContain("official-oauth-token");
  });

  it.each(["refresh_blocked", "busy"])(
    "turns %s into a queue admission delay",
    async (code) => {
      const prepared = createJobPreparation({
        root,
        env,
        sourceControl: {
          acquireLease: async () => {
            throw new SourceControlError(
              "private provider response",
              code,
              409,
            );
          },
        },
        linear: () => ({
          getTicket: async () => ticket,
          listTickets: async () => [ticket],
        }),
        preview: async () => "https://preview.vercel.app",
      });
      await expect(prepared.prepareJob(job)).rejects.toBeInstanceOf(
        LocalJobDeferredError,
      );
      await expect(prepared.prepareJob(job)).rejects.not.toThrow(
        "private provider response",
      );
    },
  );

  it("does not acquire a source lease for failed project preparation", async () => {
    const acquireLease = vi.fn(async () => ({
      token: "unused",
      method: "oauth" as const,
    }));
    const prepared = createJobPreparation({
      root,
      env,
      sourceControl: { acquireLease },
      linear: () => ({
        getTicket: async () => ticket,
        listTickets: async () => [ticket],
      }),
      preview: async () => null,
    });
    await expect(prepared.prepareJob(job)).rejects.toThrow(
      "No ready integration preview",
    );
    expect(acquireLease).not.toHaveBeenCalled();
  });

  it("rechecks approval at launch and supplies only this job's credentials", async () => {
    writeFileSync(
      join(root, ".env"),
      "VERCEL_BYPASS_APP=preview-secret\nUNRELATED_KEY=never-copy\n",
    );
    const prepared = setup();
    await prepared.validate(job);
    const payload = await prepared.prepareJob(job);
    expect(prepared.getTicket).toHaveBeenCalledTimes(2);
    expect(payload.repoUrl).toBe("https://github.com/owner/app.git");
    expect(payload.credentials).toEqual({
      GITHUB_TOKEN: env.GITHUB_TOKEN,
      LINEAR_API_KEY: env.LINEAR_API_KEY,
      CLAUDE_CODE_OAUTH_TOKEN: env.CLAUDE_CODE_OAUTH_TOKEN,
      GREMLINS_PREVIEW_BYPASS: "preview-secret",
    });
    expect(payload.prompt).toContain("DRAFT pull request");
    expect(payload.prompt).toContain("Never merge");
    expect(JSON.stringify(payload)).not.toContain("never-copy");
  });
  it("uses OAuth credentials for tickets and preview without exporting the Vercel token", async () => {
    const linearCredential = {
      token: "linear-oauth",
      authorization: "Bearer linear-oauth",
      method: "oauth" as const,
    };
    const releaseLease = vi.fn(async () => {});
    const acquireLease = vi.fn(async () => linearCredential);
    const linear = vi.fn(() => ({
      getTicket: async () => ticket,
      listTickets: async () => [ticket],
    }));
    const vercelResolve = vi.fn(async () => ({
      token: "vercel-oauth",
      authorization: "Bearer vercel-oauth",
      method: "oauth" as const,
    }));
    const prepared = createJobPreparation({
      root,
      env: { ...env, LINEAR_API_KEY: undefined, VERCEL_TOKEN: undefined },
      linear,
      linearConnection: {
        resolveCredential: async () => linearCredential,
        acquireLease,
        releaseLease,
      },
      vercelConnection: { resolveCredential: vercelResolve },
      preview: async (_project, token) => {
        expect(token).toBe("vercel-oauth");
        return "https://preview.vercel.app";
      },
    });
    const payload = await prepared.prepareJob(job);
    expect(linear).toHaveBeenCalledWith("Bearer linear-oauth");
    expect(acquireLease).toHaveBeenCalledWith({ jobId: job.id, minutes: 50 });
    expect(vercelResolve).toHaveBeenCalledWith({
      projectId: "prj_test",
      teamId: null,
      minValidityMs: 5 * 60_000,
    });
    expect(payload.credentials?.LINEAR_API_KEY).toBe("linear-oauth");
    expect(payload.prompt).toContain("Authorization: Bearer");
    expect(JSON.stringify(payload)).not.toContain("vercel-oauth");
    expect(releaseLease).not.toHaveBeenCalled();
    await prepared.releaseJobResources(job.id);
    expect(releaseLease).toHaveBeenCalledWith(job.id);
  });
  it("defers Linear refresh conflicts and releases acquired resources when later admission fails", async () => {
    const releaseLease = vi.fn(async () => {});
    const prepared = createJobPreparation({
      root,
      env,
      linearConnection: {
        resolveCredential: async () => {
          throw new OAuthConnectionError(
            "private upstream",
            "refresh_blocked",
            409,
          );
        },
        acquireLease: async () => {
          throw new Error("not reached");
        },
        releaseLease,
      },
    });
    await expect(prepared.prepareJob(job)).rejects.toBeInstanceOf(
      LocalJobDeferredError,
    );
    expect(releaseLease).toHaveBeenCalledWith(job.id);
  });
  it.each([
    { labels: ["pm:core"] },
    { labels: ["pm:core", "pm-approved", "pm-needs-human"] },
    { labels: ["pm:core", "pm-approved", "pm-proposal"] },
    { projectId: "other-project" },
    { stateType: "completed" },
  ])("rejects a ticket outside approved scope %j", async (override) => {
    await expect(
      setup({ ...ticket, ...override }).prepareJob(job),
    ).rejects.toThrow("must be open, approved");
  });
  it("keeps scheduled PMs paused while permitting explicit one-off PM and approved Coding runs", async () => {
    edit("areas.json", (raw) => {
      raw.areas.core.enabled = false;
    });
    await expect(
      setup().validate({ type: "pm", project: "app", area: "core" }),
    ).rejects.toThrow("enabled PM area");
    const manual = setup();
    expect(
      await manual.validate({
        type: "pm",
        project: "app",
        area: "core",
        runOnce: true,
      }),
    ).toMatchObject({
      area: { enabled: false },
      linearBinding: { connectionId: "default" },
    });
    expect(
      await manual.prepareJob({
        ...job,
        type: "pm",
        area: "core",
        runOnce: true,
      }),
    ).toMatchObject({ kind: "pm" });
    expect(await manual.validate({ ...job, runOnce: true })).toMatchObject({
      ticket: { id: ticket.id },
      area: { enabled: false },
    });
    expect(await manual.prepareJob({ ...job, runOnce: true })).toMatchObject({
      kind: "developer",
    });
    expect(await manual.scheduledJobs()).toEqual([]);
    expect(
      JSON.parse(readFileSync(join(root, "projects/app/areas.json"), "utf8"))
        .areas.core.enabled,
    ).toBe(false);
    edit("project.json", (raw) => {
      raw.verified = null;
    });
    await expect(setup().validate(job)).rejects.toThrow("doctor");
  });
  it("does not let Run once bypass missing mapping, mandate, or AI credentials", async () => {
    const input = {
      type: "pm" as const,
      project: "app",
      area: "core",
      runOnce: true,
    };
    edit("areas.json", (raw) => {
      raw.areas.core.linearProjectId = "PASTE_LINEAR_PROJECT_ID";
    });
    await expect(setup().validate(input)).rejects.toThrow("Map this PM");
    edit("areas.json", (raw) => {
      raw.areas.core.linearProjectId = ticket.projectId!;
    });
    writeFileSync(join(root, "projects/app/core/mandate.md"), "  ");
    await expect(setup().validate(input)).rejects.toThrow("mandate");
    writeFileSync(
      join(root, "projects/app/core/mandate.md"),
      "Test account security.",
    );
    const missingAi = createJobPreparation({
      root,
      env: { ...env, CLAUDE_CODE_OAUTH_TOKEN: "" },
    });
    await expect(missingAi.validate(input)).rejects.toThrow("Claude Code");
  });
  it("checks manual PM mapping ownership and pins its workspace again before launch", async () => {
    const projectPath = join(root, "projects/app/project.json");
    const raw = JSON.parse(readFileSync(projectPath, "utf8"));
    raw.linear = { teamId: "11111111-1111-4111-8111-111111111111" };
    writeFileSync(projectPath, JSON.stringify(raw));
    const credential = {
      token: "scoped-linear",
      authorization: "Bearer scoped-linear",
      method: "oauth" as const,
      workspaceId: "22222222-2222-4222-8222-222222222222",
    };
    const acquireLease = vi.fn(async () => credential);
    const releaseLease = vi.fn(async () => {});
    const getProject = vi.fn(async () => ({
      id: "linear-project",
      name: "Core",
      url: "https://linear.app/example/project/core",
      teamIds: [raw.linear.teamId],
    }));
    const sourceAcquire = vi.fn(async () => ({
      token: "source",
      method: "token" as const,
    }));
    const prepared = createJobPreparation({
      root,
      env,
      linearConnection: {
        resolveCredential: async () => credential,
        acquireLease,
        releaseLease,
      },
      linear: () => ({
        getTicket: async () => ticket,
        listTickets: async () => [],
        getProject,
      }),
      sourceControl: { acquireLease: sourceAcquire },
      preview: async () => "https://preview.example.com",
    });
    const input = {
      type: "pm" as const,
      project: "app",
      area: "core",
      runOnce: true,
    };
    const validated = await prepared.validate(input);
    expect(validated.linearBinding).toEqual({
      connectionId: "default",
      workspaceId: credential.workspaceId,
    });
    const queued = { ...job, ...input, linearBinding: validated.linearBinding };
    getProject.mockResolvedValueOnce({
      id: "linear-project",
      name: "Wrong team",
      url: "https://linear.app/example/project/core",
      teamIds: ["other-team"],
    });
    await expect(prepared.prepareJob(queued)).rejects.toThrow("another team");
    expect(acquireLease).toHaveBeenCalledWith({
      jobId: job.id,
      minutes: 50,
      workspaceId: credential.workspaceId,
    });
    expect(releaseLease).toHaveBeenCalledWith(job.id);
    expect(sourceAcquire).not.toHaveBeenCalled();
    getProject.mockResolvedValueOnce({
      id: "linear-project",
      name: "Wrong team",
      url: "https://linear.app/example/project/core",
      teamIds: ["other-team"],
    });
    await expect(prepared.validate(input)).rejects.toThrow("another team");
  });
  it("uses GitLab nested namespaces without requiring GitHub credentials", async () => {
    edit("project.json", (raw) => {
      raw.provider = "gitlab";
      raw.serverUrl = "https://gitlab.example.com";
      raw.repo = "group/subgroup/app";
    });
    const payload = await setup().prepareJob(job);
    expect(payload.repoUrl).toBe(
      "https://gitlab.example.com/group/subgroup/app.git",
    );
    expect(payload.credentials?.GITHUB_TOKEN).toBeUndefined();
    expect(payload.credentials?.GITLAB_TOKEN).toBe(env.GITLAB_TOKEN);
  });
  it("produces stable schedule identities and one approved-ticket identity across polls", async () => {
    const scheduler = setup();
    const first = await scheduler.scheduledJobs();
    expect(first).toEqual(await scheduler.scheduledJobs());
    expect(first.map((input) => input.idempotencyKey)).toEqual([
      "pm:app:core:2026-10-04T09:00",
      "developer:app:ticket-id",
    ]);
    edit("areas.json", (raw) => {
      raw.areas.core.enabled = false;
    });
    expect(await scheduler.scheduledJobs()).toEqual([]);
  });
});

it("evaluates cron in UTC, including ranges/steps and invalid input", () => {
  const now = new Date("2026-10-05T09:30:12Z");
  expect(scheduledThisMinute("*/15 9-17 * * 1-5", now)).toBe(true);
  expect(scheduledThisMinute("31 9 * * *", now)).toBe(false);
  expect(scheduledThisMinute("not a cron", now)).toBe(false);
  expect(scheduledThisMinute("99 99 * * *", now)).toBe(false);
});
