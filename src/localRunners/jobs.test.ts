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
    provider?: string;
    serverUrl?: string;
    repo: string;
    vercel: { projectId: string };
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
    raw.vercel.projectId = "prj_test";
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
      VERCEL_TOKEN: env.VERCEL_TOKEN,
      CLAUDE_CODE_OAUTH_TOKEN: env.CLAUDE_CODE_OAUTH_TOKEN,
      GREMLINS_PREVIEW_BYPASS: "preview-secret",
    });
    expect(payload.prompt).toContain("DRAFT pull request");
    expect(payload.prompt).toContain("Never merge");
    expect(JSON.stringify(payload)).not.toContain("never-copy");
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
  it("requires a reviewed enabled area and verified project before a manual PM job", async () => {
    edit("areas.json", (raw) => {
      raw.areas.core.enabled = false;
    });
    await expect(
      setup().validate({ type: "pm", project: "app", area: "core" }),
    ).rejects.toThrow("enabled PM area");
    edit("project.json", (raw) => {
      raw.verified = null;
    });
    await expect(setup().validate(job)).rejects.toThrow("doctor");
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
