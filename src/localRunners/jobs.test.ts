import { realpathSync } from "node:fs";
import * as environmentAccess from "../setup/environmentAccess.ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
import { loadProject } from "../config.ts";
import { grumblinFixture } from "../grumblins/runtime-test-support.ts";
import { validatePayload } from "./docker.ts";
import { projectRuntimeKey } from "../projectIdentity.ts";
import { ticketScopeHash } from "../lifecycle/manifest.ts";
import { baseBranch } from "../projectCapabilities.ts";
import { approveEpic } from "../epics.ts";
import { saveConnections } from "../setup/connections.ts";
import type { TestAccess } from "../testAccess.ts";
import { deliveryConfiguration } from "../delivery/index.ts";
import type { DeliveryRecord } from "../delivery/types.ts";

let root: string;
const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
const ticket: LinearTicket = {
  id: "ticket-id",
  identifier: "APP-12",
  title: "Fix form",
  description:
    "Reproduce with test account\n\n## Acceptance criteria\n- A valid form submission persists after reload.",
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
    instanceId?: string;
    workflow?: unknown;
    verification?: unknown;
    environments?: unknown;
    signIn?: unknown;
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
      core: {
        verificationRequirement?: "browser" | "repository";
        enabled: boolean;
        codingEnabled?: boolean;
        linearProjectId: string;
        schedule: string;
        instanceId?: string;
      };
    };
  }) => void,
) {
  const path = join(root, "projects", "app", file);
  const raw = JSON.parse(readFileSync(path, "utf8"));
  mutate(raw);
  writeFileSync(path, JSON.stringify(raw));
}
beforeEach(() => {
  vi.spyOn(environmentAccess, "environmentVerificationStatus").mockReturnValue({
    status: "passed",
    message: "Synthetic verified environment for admission tests",
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL | Request) => {
      if (String(url) === "https://api.github.com/user")
        return new Response(JSON.stringify({ id: 42, login: "source-user" }));
      throw new Error(
        `Unexpected provider request in job fixture: ${String(url)}`,
      );
    }),
  );
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
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  rmSync(root, { recursive: true, force: true });
});
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
function chooseBrowserAccess(access: TestAccess = { kind: "public" }) {
  edit("project.json", (raw) => {
    raw.verification = { mode: "browser", environment: "integration" };
    raw.environments = {
      integration: { kind: "vercel", role: "preview", ...raw.vercel, access },
    };
  });
}
describe("local job preparation", () => {
  it("keeps browser-required PMs out of repository-only admission, scheduling and queued launch while allowing discovery", async () => {
    edit("project.json", (raw) => {
      raw.workflow = { kind: "pull-request", baseBranch: "main" };
      raw.verification = { mode: "repository" };
      raw.environments = {};
    });
    const prepared = setup();
    const input = {
      type: "pm" as const,
      project: "app",
      area: "core",
      runOnce: true,
    };
    const admitted = await prepared.validate(input);
    edit("areas.json", (raw) => {
      raw.areas.core.verificationRequirement = "browser";
    });
    await expect(prepared.validate(input)).rejects.toThrow(
      "requires a browser walkthrough",
    );
    expect(
      (await prepared.scheduledJobs()).some((entry) => entry.type === "pm"),
    ).toBe(false);
    await expect(
      prepared.prepareJob({
        ...job,
        ...input,
        ticket: undefined,
        discoveryRevision: admitted.discoveryRevision,
      }),
    ).rejects.toThrow("requires a browser walkthrough");
    await expect(
      prepared.validate({ ...input, pmMode: "discovery" }),
    ).resolves.toMatchObject({ area: { key: "core" } });
    edit("areas.json", (raw) => {
      raw.areas.core.verificationRequirement = "repository";
    });
    await expect(prepared.validate(input)).resolves.toMatchObject({
      area: { key: "core" },
    });
    expect(
      (await prepared.scheduledJobs()).some((entry) => entry.type === "pm"),
    ).toBe(true);
    edit("areas.json", (raw) => {
      raw.areas.core.verificationRequirement = "browser";
    });
    chooseBrowserAccess();
    await expect(prepared.validate(input)).resolves.toMatchObject({
      area: { key: "core" },
    });
  });
  it("lets admitted promotion repairs prepare without waiting on their own staging sync", async () => {
    const beforePmStart = vi.fn(async () => {
      throw new LocalJobDeferredError(
        "An admitted repair is active",
        "environment-wait",
      );
    });
    const beforeDeveloper = vi.fn(async (_job, payload) => payload);
    const prepared = createJobPreparation({
      root,
      env,
      beforePmStart,
      beforeDeveloper,
      linear: () => ({
        getTicket: async () => ticket,
        listTickets: async () => [ticket],
      }),
      preview: async () => "https://app-preview.vercel.app",
    });
    await prepared.prepareJob({
      ...job,
      developerKind: "port",
      idempotencyKey: "promotion-repair:admitted",
    });
    expect(beforePmStart).not.toHaveBeenCalled();
    expect(beforeDeveloper).toHaveBeenCalled();
  });
  it.each(["repository", "untested"] as const)(
    "blocks promotion coding at admission and pickup for a %s deployment",
    async (condition) => {
      chooseBrowserAccess();
      if (condition === "repository")
        edit("project.json", (raw) => {
          raw.verification = { mode: "repository" };
        });
      else
        vi.mocked(
          environmentAccess.environmentVerificationStatus,
        ).mockReturnValue({
          status: "untested",
          message: "Test this deployment",
        });
      const prepared = setup();
      await expect(
        prepared.validate({ ...job, runOnce: true }),
      ).rejects.toThrow(/integration deployment/);
      await expect(
        prepared.selectDeveloperTicket(
          { type: "developer", project: "app", runOnce: true },
          [],
        ),
      ).rejects.toThrow(/integration deployment/);
      expect(
        (await prepared.scheduledJobs()).some(
          (input) => input.type === "developer",
        ),
      ).toBe(false);
      expect(prepared.getTicket).not.toHaveBeenCalled();
    },
  );
  it("defers ordinary coding before provider leases while staging is being reconciled", async () => {
    const beforePmStart = vi.fn(async () => {
      throw new LocalJobDeferredError(
        "Staging sync checks are still running.",
        "environment-wait",
      );
    });
    const lookup = vi.fn(async () => ticket);
    const prepared = createJobPreparation({
      root,
      env,
      beforePmStart,
      linear: () => ({ getTicket: lookup, listTickets: async () => [ticket] }),
    });
    await expect(prepared.prepareJob(job)).rejects.toMatchObject({
      category: "environment-wait",
    });
    expect(beforePmStart).toHaveBeenCalledWith(job);
    expect(lookup).not.toHaveBeenCalled();
  });
  it.each(["untested", "testing", "failed"] as const)(
    "admits configured managed browser PMs for a fresh runner check despite historical %s evidence",
    async (status) => {
      chooseBrowserAccess();
      vi.mocked(
        environmentAccess.environmentVerificationStatus,
      ).mockReturnValue({ status, message: "Sign-in has not passed" });
      const prepared = setup();
      const input = {
        type: "pm" as const,
        project: "app",
        area: "core",
        runOnce: true,
      };
      await expect(prepared.validate(input)).resolves.toMatchObject({
        area: { key: "core" },
      });
      await expect(
        prepared.validate({ ...input, pmMode: "discovery" }),
      ).resolves.toMatchObject({ area: { key: "core" } });
    },
  );

  it("gates manual pickup, scheduled pickup and launch on the current parent epic approval", async () => {
    edit("project.json", (raw) => {
      raw.workflow = { kind: "promotion", approvalPolicy: "epic" };
    });
    chooseBrowserAccess();
    const parent: LinearTicket = {
      ...ticket,
      id: "epic-id",
      identifier: "APP-1",
      title: "Reliable forms",
      labels: ["pm:core", "pm-epic", "pm-approved"],
    };
    const child = { ...ticket, parentId: parent.id };
    const prepared = createJobPreparation({
      root,
      env,
      linear: () => ({
        getTicket: async (id) => (id === parent.id ? parent : child),
        listTickets: async () => [child],
      }),
      now: () => new Date("2026-10-04T09:00:45Z"),
    });
    await expect(prepared.validate({ ...job, runOnce: true })).rejects.toThrow(
      /parent epic/,
    );
    expect(
      (await prepared.scheduledJobs()).filter(
        (input) => input.type === "developer",
      ),
    ).toHaveLength(0);
    await expect(
      prepared.selectDeveloperTicket(
        { type: "developer", project: "app", runOnce: true },
        [],
      ),
    ).rejects.toThrow(/No approved tickets/);
    const project = loadProject(root, "app");
    approveEpic(root, project, project.areas[0]!, parent);
    await expect(
      prepared.validate({ ...job, runOnce: true }),
    ).resolves.toMatchObject({ ticket: { id: child.id } });
    expect(
      (await prepared.scheduledJobs()).filter(
        (input) => input.type === "developer",
      ),
    ).toHaveLength(1);
    await expect(
      prepared.selectDeveloperTicket(
        { type: "developer", project: "app", runOnce: true },
        [],
      ),
    ).resolves.toMatchObject({ ticket: child.identifier });
    parent.description += "\nChange billing too.";
    await expect(prepared.prepareJob(job)).rejects.toThrow(/parent epic/);
    expect(
      (await prepared.scheduledJobs()).filter(
        (input) => input.type === "developer",
      ),
    ).toHaveLength(0);
  });
  it("requires an explicit test-login choice for manual and scheduled browser PMs before preview preparation", async () => {
    const beforePmStart = vi.fn(async () => {});
    const prepared = createJobPreparation({ root, env, beforePmStart });
    for (const runOnce of [true, false])
      await expect(
        prepared.validate({
          type: "pm",
          project: "app",
          area: "core",
          runOnce,
        }),
      ).rejects.toThrow("Choose Test login in Environment");
    await expect(
      prepared.prepareJob({
        ...job,
        type: "pm",
        area: "core",
        ticket: undefined,
      }),
    ).rejects.toThrow("Choose Test login in Environment");
    expect(beforePmStart).not.toHaveBeenCalled();
    expect((await setup().scheduledJobs()).map((input) => input.type)).toEqual([
      "developer",
    ]);
  });

  it("allows explicitly public PM coverage and reports authenticated flows as untested", async () => {
    chooseBrowserAccess();
    // A former login recipe must not override the owner's new public-only choice.
    edit("project.json", (raw) => {
      raw.signIn = {
        kind: "neon-auth-otp",
        email: "test@example.test",
        path: "/login",
        databaseUrlSecret: "RETIRED_DATABASE",
      };
    });
    const prepared = setup();
    await expect(
      prepared.validate({
        type: "pm",
        project: "app",
        area: "core",
        runOnce: true,
      }),
    ).resolves.toMatchObject({ area: { key: "core" } });
    expect(
      (await prepared.scheduledJobs()).some((input) => input.type === "pm"),
    ).toBe(true);
    const payload = await prepared.prepareJob({
      ...job,
      type: "pm",
      area: "core",
      ticket: undefined,
    });
    expect(payload.prompt).toContain(
      "owner explicitly selected public-only testing",
    );
    expect(payload.prompt).toContain(
      "does not verify real authentication, account permissions, tenant isolation or billing",
    );
    expect(payload.prompt).not.toContain(
      "No password test account is configured",
    );
    expect(payload.prompt).not.toContain("neon-auth-otp");
    expect(payload.credentials).not.toHaveProperty(
      "GREMLINS_PREVIEW_DATABASE_URL",
    );
  });

  it("rechecks password credentials at admission and immediately before a queued browser PM starts", async () => {
    chooseBrowserAccess({
      kind: "password",
      loginPath: "/login",
      usernameSelector: "#email",
      passwordSelector: "#password",
      submitSelector: "button",
      successSelector: "#account",
      accounts: [
        {
          name: "Member",
          usernameSecret: "TEST_EMAIL",
          passwordSecret: "TEST_PASSWORD",
        },
      ],
    });
    const input = {
      type: "pm" as const,
      project: "app",
      area: "core",
      runOnce: true,
    };
    const prepared = setup();
    await expect(prepared.validate(input)).rejects.toThrow(
      "save the selected test-account",
    );
    expect(
      (await prepared.scheduledJobs()).some((queued) => queued.type === "pm"),
    ).toBe(false);
    saveConnections(root, {
      TEST_EMAIL: "private-user",
      TEST_PASSWORD: "private-password",
    });
    await expect(prepared.validate(input)).resolves.toMatchObject({
      area: { key: "core" },
    });
    const payload = await prepared.prepareJob({
      ...job,
      ...input,
      ticket: undefined,
    });
    expect(payload.credentials?.GREMLINS_TEST_PASSWORD_1).toBe(
      "private-password",
    );
    expect(payload.prompt).not.toContain("private-password");
    writeFileSync(join(root, ".env"), "TEST_EMAIL=private-user\n");
    await expect(
      prepared.prepareJob({ ...job, ...input, ticket: undefined }),
    ).rejects.toThrow("save the selected test-account");
  });

  it("preserves legacy OTP browser login without requiring a second test-access selection", async () => {
    edit("project.json", (raw) => {
      raw.signIn = {
        kind: "neon-auth-otp",
        email: "test@example.test",
        path: "/login",
        databaseUrlSecret: "TEST_DATABASE",
      };
    });
    saveConnections(root, { TEST_DATABASE: "private-database-url" });
    const prepared = setup();
    await expect(
      prepared.validate({
        type: "pm",
        project: "app",
        area: "core",
        runOnce: true,
      }),
    ).resolves.toMatchObject({ area: { key: "core" } });
    const payload = await prepared.prepareJob({
      ...job,
      type: "pm",
      area: "core",
      ticket: undefined,
    });
    expect(payload.prompt).toContain("Use the existing sign-in recipe below");
    expect(payload.credentials?.GREMLINS_PREVIEW_DATABASE_URL).toBe(
      "private-database-url",
    );
    expect(payload.prompt).not.toContain("private-database-url");
  });

  it("reconciles managed preview access before handing credentials to the worker", async () => {
    saveConnections(root, { VERCEL_BYPASS_APP: "obsolete-private-bypass" });
    const heal = vi.fn(async () => {
      edit("project.json", (raw) => {
        raw.vercel.bypassSecret = "VERCEL_BYPASS_REPAIRED";
      });
      saveConnections(root, {
        VERCEL_BYPASS_REPAIRED: "repaired-private-bypass",
      });
    });
    const preparation = createJobPreparation({
      root,
      env,
      linear: () => ({
        getTicket: async () => ticket,
        listTickets: async () => [ticket],
      }),
      preview: async () => "https://app-preview.vercel.app",
      ensurePreviewAccess: heal,
    });
    const payload = await preparation.prepareJob(job);
    expect(heal).toHaveBeenCalledOnce();
    expect(payload.credentials?.GREMLINS_PREVIEW_BYPASS).toBe(
      "repaired-private-bypass",
    );
    expect(payload.prompt).not.toContain("private-bypass");
    expect(payload.browserTarget).toBe("https://app-preview.vercel.app");
  });
  it("enforces persisted mission prerequisites and exact approved scope in manual, scheduled and launch admission", async () => {
    const planned = { ...ticket, id: "11111111-1111-4111-8111-111111111111" };
    const prerequisiteId = "22222222-2222-4222-8222-222222222222";
    const project = loadProject(root, "app"),
      owner = project.areas[0]!;
    const directory = join(
      root,
      ".run/improvements",
      projectRuntimeKey(project.config),
    );
    mkdirSync(directory, { recursive: true });
    const previous = {
      ticketId: prerequisiteId,
      identifier: "APP-11",
      title: "Prepare form storage",
      description: planned.description,
      acceptanceCriteria: ["Storage persists"],
      area: "core",
      areaInstanceId: owner.instanceId,
      revision: "a".repeat(64),
      scopeHash: "b".repeat(64),
      dependsOn: [] as string[],
      approvedAt: "2026-10-04T00:00:00.000Z",
      integratedAt: undefined as string | undefined,
    };
    const mission = {
      id: "33333333-3333-4333-8333-333333333333",
      project: "app",
      projectInstanceId: project.config.instanceId,
      repository: project.config.repo,
      provider: "github",
      area: "core",
      areaInstanceId: owner.instanceId,
      outcome: "Reduce abandoned forms",
      createdAt: "2026-10-04T00:00:00.000Z",
      updatedAt: "2026-10-04T00:00:00.000Z",
      paused: false,
      investigation: {},
      followups: [],
      plan: {
        approvedAt: "2026-10-04T00:00:00.000Z",
        baseBranch: baseBranch(project.config),
        connectionId: "default",
        workspaceId: project.config.linear?.workspaceId,
        steps: [
          previous,
          {
            ...previous,
            ticketId: planned.id,
            identifier: planned.identifier,
            title: planned.title,
            scopeHash: ticketScopeHash(planned),
            dependsOn: [prerequisiteId],
          },
        ],
      },
    };
    const save = () =>
      writeFileSync(
        join(directory, "missions.json"),
        JSON.stringify({ schemaVersion: 1, missions: [mission] }),
      );
    save();
    const prepared = setup(planned);
    await expect(prepared.validate({ ...job, runOnce: true })).rejects.toThrow(
      /prerequisite changes/,
    );
    await expect(prepared.prepareJob(job)).rejects.toThrow(
      /prerequisite changes/,
    );
    expect(
      (await prepared.scheduledJobs()).filter(
        (item) => item.type === "developer",
      ),
    ).toEqual([]);
    await expect(
      prepared.selectDeveloperTicket(
        { type: "developer", project: "app", runOnce: true },
        [],
      ),
    ).rejects.toThrow(/No approved tickets/);
    previous.integratedAt = "2026-10-04T00:01:00.000Z";
    save();
    expect(
      (await prepared.validate({ ...job, runOnce: true })).ticket?.id,
    ).toBe(planned.id);
    expect(
      (await prepared.scheduledJobs()).filter(
        (item) => item.type === "developer",
      ),
    ).toHaveLength(1);
    expect(
      (
        await prepared.selectDeveloperTicket(
          { type: "developer", project: "app", runOnce: true },
          [],
        )
      ).ticket,
    ).toBe(planned.identifier);
    await expect(
      setup({ ...planned, title: "Replace all billing" }).validate({
        ...job,
        runOnce: true,
      }),
    ).rejects.toThrow(/scope|changed/i);
    mission.paused = true;
    save();
    await expect(prepared.validate({ ...job, runOnce: true })).rejects.toThrow(
      /paused/,
    );
    expect(
      (
        await setup({
          ...planned,
          id: "44444444-4444-4444-8444-444444444444",
        }).validate({ ...job, runOnce: true })
      ).ticket?.id,
    ).toBe("44444444-4444-4444-8444-444444444444");
  });
  it.each(["pull-request", "promotion"])(
    "describes the actual draft review policy for %s delivery",
    async (kind) => {
      edit("project.json", (raw) => {
        raw.workflow =
          kind === "promotion" ? { kind } : { kind, baseBranch: "main" };
      });
      const payload = await setup().prepareJob(job);
      if (kind === "promotion") {
        expect(payload.prompt).toContain("owning PM's independent QA");
        expect(payload.prompt).toContain(
          "promotion batch for the owner to merge",
        );
        expect(payload.prompt).not.toContain("Drafts remain for human review.");
      } else
        expect(payload.prompt).toContain("Drafts remain for human review.");
    },
  );
  it.each(["pull-request", "promotion"])(
    "rejects coding without finite criteria in %s delivery",
    async (kind) => {
      edit("project.json", (raw) => {
        raw.workflow =
          kind === "promotion" ? { kind } : { kind, baseBranch: "main" };
      });
      const prepared = setup({
        ...ticket,
        description: "Build something nice",
      });
      await expect(
        prepared.validate({ ...job, runOnce: true }),
      ).rejects.toThrow(/Acceptance criteria/);
      expect(
        (await prepared.scheduledJobs()).some(
          (item) => item.type === "developer",
        ),
      ).toBe(false);
      await expect(
        prepared.selectDeveloperTicket(
          { type: "developer", project: "app", runOnce: true },
          [],
        ),
      ).rejects.toThrow(/acceptance criteria/);
    },
  );
  it.each([
    [true, false, ["pm"]],
    [false, true, ["developer"]],
    [false, false, []],
    [true, true, ["pm", "developer"]],
  ] as const)(
    "schedules patrol=%s independently from coding=%s",
    async (enabled, codingEnabled, types) => {
      chooseBrowserAccess();
      edit("areas.json", (raw) => {
        Object.assign(raw.areas.core, { enabled, codingEnabled });
      });
      const prepared = setup();
      expect((await prepared.scheduledJobs()).map((item) => item.type)).toEqual(
        types,
      );
      if (codingEnabled)
        expect((await prepared.validate(job)).ticket?.id).toBe(ticket.id);
      else
        await expect(prepared.validate(job)).rejects.toThrow(
          /Enable coding pickup/,
        );
      expect(
        (await prepared.validate({ ...job, runOnce: true })).ticket?.id,
      ).toBe(ticket.id);
    },
  );
  it("supplies the full current owner charter and revision while requiring current source conventions", async () => {
    const path = join(root, "projects/app/areas.json"),
      raw = JSON.parse(readFileSync(path, "utf8"));
    raw.areas.core.charter = {
      ambition: "Accessible invoicing",
      users: ["Accountants"],
      expectedToBuild: ["Invoice review"],
      nonGoals: ["No billing provider replacement"],
      guardrails: ["Preserve tenant isolation"],
      standingPriorities: ["Keyboard navigation"],
      goal: "Reduce invoice corrections",
      metricDefinition: "Count reopened invoices",
    };
    writeFileSync(path, JSON.stringify(raw));
    const payload = await setup().prepareJob(job);
    for (const phrase of [
      "Accessible invoicing",
      "No billing provider replacement",
      "Preserve tenant isolation",
      "Keyboard navigation",
      "Count reopened invoices",
    ])
      expect(payload.prompt).toContain(phrase);
    expect(payload.prompt).toMatch(/Snapshot revision: [a-f0-9]{64}/);
    expect(payload.prompt).toContain(
      "recheck architecture and design conventions",
    );
    expect(payload.prompt).toContain("never prove a real integration");
    expect(payload.delivery?.acceptanceCriteria).toEqual([
      "A valid form submission persists after reload.",
    ]);
  });
  it("rejects an owner brief changed during asynchronous coding preparation", async () => {
    const prepared = createJobPreparation({
      root,
      env,
      linear: () => ({
        getTicket: async () => ticket,
        listTickets: async () => [ticket],
      }),
      preview: async () => {
        const file = join(root, "projects/app/areas.json"),
          raw = JSON.parse(readFileSync(file, "utf8"));
        raw.areas.core.charter = { nonGoals: ["Do not change form storage"] };
        writeFileSync(file, JSON.stringify(raw));
        return "https://app-preview.vercel.app";
      },
    });
    await expect(prepared.prepareJob(job)).rejects.toThrow(
      /product brief or project configuration changed/,
    );
  });
  it("resolves a completed issue's immutable identity without admission, mapping repair, or source leases", async () => {
    edit("project.json", (raw) => {
      raw.verified = null;
    });
    edit("areas.json", (raw) => {
      raw.areas.core.enabled = false;
      raw.areas.core.linearProjectId = "PASTE_LINEAR_PROJECT_ID";
    });
    const closed = {
      ...ticket,
      labels: [],
      stateType: "completed",
      projectId: "a-new-mapping",
    };
    const getTicket = vi.fn(async () => closed),
      forbidden = vi.fn(async () => {
        throw new Error("Must remain read-only");
      });
    const preparation = createJobPreparation({
      root,
      env: {},
      linear: () => ({
        getTicket,
        listTickets: forbidden,
        ensureLabels: forbidden,
      }),
      linearConnection: {
        resolveCredential: vi.fn(async () => ({
          token: "read-only",
          authorization: "Bearer read-only",
          method: "oauth" as const,
          workspaceId: "workspace-current",
        })),
        acquireLease: forbidden,
        releaseLease: forbidden,
      },
      sourceControl: { acquireLease: forbidden, resolveCredential: forbidden },
    });
    const before = readFileSync(join(root, "projects/app/areas.json"), "utf8");
    const resolved = await preparation.resolveDeveloperIdentity({
      type: "developer",
      project: "app",
      ticket: " APP-12 ",
      runOnce: true,
    });
    expect(resolved.ticket).toEqual(closed);
    expect(resolved.linearBinding).toEqual({
      connectionId: "default",
      workspaceId: "workspace-current",
      ticketId: "ticket-id",
    });
    expect(getTicket).toHaveBeenCalledWith("APP-12");
    expect(forbidden).not.toHaveBeenCalled();
    expect(readFileSync(join(root, "projects/app/areas.json"), "utf8")).toBe(
      before,
    );
    await expect(
      preparation.validate({
        type: "developer",
        project: "app",
        ticket: "APP-12",
        runOnce: true,
      }),
    ).rejects.toThrow("Verify connections");
  });

  it("does not resolve history against a replacement project created during the Linear lookup", async () => {
    const preparation = createJobPreparation({
      root,
      env,
      linear: () => ({
        getTicket: async () => {
          edit("project.json", (raw) => {
            raw.instanceId = "11111111-1111-4111-8111-111111111111";
          });
          return ticket;
        },
        listTickets: async () => [],
      }),
    });
    await expect(
      preparation.resolveDeveloperIdentity({
        type: "developer",
        project: "app",
        ticket: "APP-12",
      }),
    ).rejects.toThrow("identity or Linear connection changed");
  });

  it("runs a saved Grumblin on the real selected test app without Linear, full-doctor setup, telemetry, or publication", async () => {
    chooseBrowserAccess();
    edit("project.json", (raw) => {
      raw.verified = null;
    });
    edit("areas.json", (raw) => {
      raw.areas.core.enabled = false;
      raw.areas.core.linearProjectId = "PASTE_LINEAR_PROJECT_ID";
    });
    writeFileSync(
      join(root, "projects/app/core/mandate.md"),
      "Make this app approachable.",
    );
    const forbidden = vi.fn(async () => {
      throw new Error("Provider writes must not occur");
    });
    const acquireLease = vi.fn(async () => ({
      token: "read-source",
      method: "token" as const,
    }));
    const prepared = createJobPreparation({
      root,
      env,
      beforePm: forbidden,
      sourceControl: {
        acquireLease,
        resolveCredential: acquireLease,
        releaseLease: vi.fn(async () => {}),
      },
      linearConnection: {
        resolveCredential: forbidden,
        acquireLease: forbidden,
        releaseLease: vi.fn(async () => {}),
      },
      linear: () => {
        throw new Error("No Linear client expected");
      },
      telemetryFetch: forbidden,
      preview: async () => "https://app-preview.vercel.app",
    });
    const project = loadProject(root, "app");
    const input = {
      type: "pm" as const,
      project: "app",
      projectInstanceId: project.config.instanceId,
      area: "core",
      runOnce: true,
      pmMode: "grumblin" as const,
      grumblin: grumblinFixture({
        projectInstanceId: project.config.instanceId,
      }),
    };
    const validated = await prepared.validate(input);
    expect(validated.linearBinding).toBeUndefined();
    const queued = {
      ...job,
      ...input,
      ticket: undefined,
      discoveryRevision: validated.discoveryRevision,
    };
    const payload = await prepared.prepareJob(queued);
    expect(payload).toMatchObject({
      pmMode: "grumblin",
      grumblin: input.grumblin,
      browserVerification: true,
      grumblinTarget: {
        url: "https://app-preview.vercel.app",
        role: "preview",
      },
    });
    expect(() => validatePayload(payload)).not.toThrow();
    expect(Object.keys(payload.credentials!).sort()).toEqual([
      "CLAUDE_CODE_OAUTH_TOKEN",
      "GITHUB_TOKEN",
    ]);
    expect(payload.prompt).toContain("GRUMBLIN WALKTHROUGH");
    expect(payload.prompt).toContain("No Linear reads or writes");
    expect(payload.delivery).toBeUndefined();
    expect(payload.reviewPlan).toBeUndefined();
    expect(acquireLease).toHaveBeenLastCalledWith(
      expect.objectContaining({ write: false }),
    );
    expect(forbidden).not.toHaveBeenCalled();
    for (const invalid of [
      { ...input, grumblin: undefined },
      { ...input, grumblin: grumblinFixture({ project: "other" }) },
      { ...input, runOnce: false },
      { ...input, linearBinding: { connectionId: "default" } },
      { ...input, ticket: "APP-1" },
    ])
      await expect(prepared.validate(invalid)).rejects.toThrow();
    writeFileSync(
      join(root, "projects/app/core/mandate.md"),
      "Changed owner goal.",
    );
    await expect(prepared.prepareJob(queued)).rejects.toThrow(
      "settings changed",
    );
  });
  it("requires an app browser target for Grumblins and does not fall back to repository discovery", async () => {
    edit("project.json", (raw) => {
      raw.workflow = { kind: "pull-request", baseBranch: "main" };
      raw.verification = { mode: "repository" };
    });
    const project = loadProject(root, "app");
    await expect(
      setup().validate({
        type: "pm",
        project: "app",
        area: "core",
        runOnce: true,
        pmMode: "grumblin",
        grumblin: grumblinFixture({
          projectInstanceId: project.config.instanceId,
        }),
      }),
    ).rejects.toThrow("non-production browser environment");
  });
  it("blocks Grumblin walkthroughs until a fresh idea has an application foundation", async () => {
    const path = join(root, "projects/app/project.json");
    const raw = JSON.parse(readFileSync(path, "utf8"));
    raw.ideaPlanId = "aaaaaaaa-bbbb-4ccc-addd-eeeeeeeeeeee";
    writeFileSync(path, JSON.stringify(raw));
    const project = loadProject(root, "app");
    await expect(
      setup().validate({
        type: "pm",
        project: "app",
        area: "core",
        runOnce: true,
        pmMode: "grumblin",
        grumblin: grumblinFixture({
          projectInstanceId: project.config.instanceId,
        }),
      }),
    ).rejects.toThrow("Build the foundation first");
  });
  it("prepares an explicit product exploration with scoped proposals and no delivery review", async () => {
    edit("project.json", (raw) => {
      raw.workflow = { kind: "pull-request", baseBranch: "main" };
      raw.verification = { mode: "repository" };
    });
    const beforePm = vi.fn(async (_job, payload) => payload);
    const prepared = createJobPreparation({
      root,
      env,
      beforePm,
      linear: () => ({
        getTicket: async () => ticket,
        listTickets: async () => [],
      }),
    });
    const input = {
      type: "pm" as const,
      project: "app",
      area: "core",
      runOnce: true,
      pmMode: "exploration" as const,
    };
    const validated = await prepared.validate(input);
    const payload = await prepared.prepareJob({
      ...job,
      ...input,
      ticket: undefined,
      linearBinding: validated.linearBinding,
      discoveryRevision: validated.discoveryRevision,
    });
    expect(payload.pmMode).toBe("exploration");
    expect(payload.prompt).toContain("PRODUCT EXPLORATION");
    expect(payload.prompt).toContain("label");
    expect(payload.credentials?.LINEAR_API_KEY).toBe("linear-token");
    expect(payload.delivery).toBeUndefined();
    expect(beforePm).not.toHaveBeenCalled();
  });
  function queueFixture(
    tickets: LinearTicket[],
    fresh: (value: LinearTicket) => LinearTicket | null = (value) => value,
  ) {
    const listTickets = vi.fn(async () => tickets);
    const getTicket = vi.fn(async (id: string) => {
      const found = tickets.find(
        (value) => value.id === id || value.identifier === id,
      );
      return found ? fresh(found) : null;
    });
    return {
      listTickets,
      getTicket,
      ...createJobPreparation({
        root,
        env,
        linear: () => ({ listTickets, getTicket }),
      }),
    };
  }
  const codingRequest = {
    type: "developer" as const,
    project: "app",
    runOnce: true,
  };
  const queueTicket = (
    id: string,
    over: Partial<LinearTicket> = {},
  ): LinearTicket => ({
    ...ticket,
    id,
    identifier: `APP-${id}`,
    priority: 3,
    ...over,
  });
  it("reuses case-insensitive Linear labels for coding while preserving proposal and dispatch holds", async () => {
    const f = queueFixture([
      queueTicket("1", { labels: ["PM:CORE", "PM-APPROVED", "PM-PROPOSAL"] }),
      queueTicket("2", { labels: ["PM:CORE", "PM-APPROVED", "PM-DISPATCHED"] }),
      queueTicket("3", { labels: ["PM:CORE", "PM-APPROVED"] }),
    ]);
    const selected = await f.selectDeveloperTicket(codingRequest, []);
    expect(selected.ticket).toBe("APP-3");
    expect((await f.validate(selected)).ticket?.id).toBe("3");
  });
  it("finds the highest-priority approved ticket without an identifier and binds its current issue", async () => {
    const f = queueFixture([
      queueTicket("20", { priority: 3 }),
      queueTicket("21", { priority: 1, createdAt: "2026-10-03T00:00:00Z" }),
      queueTicket("22", { priority: 1, createdAt: "2026-10-02T00:00:00Z" }),
    ]);
    const chosen = await f.selectDeveloperTicket(codingRequest, []);
    expect(chosen).toMatchObject({
      ticket: "APP-22",
      area: "core",
      runOnce: true,
      linearBinding: { connectionId: "default", ticketId: "22" },
    });
    expect(f.listTickets).toHaveBeenCalledExactlyOnceWith("linear-project", [
      "pm:core",
      "pm-approved",
    ]);
    expect((await f.validate(chosen)).ticket?.id).toBe("22");
    expect(
      (await f.selectDeveloperTicket({ ...codingRequest, ticket: "   " }, []))
        .ticket,
    ).toBe("APP-22");
  });
  it("skips proposals, owner blockers, completed work and every previously attempted issue", async () => {
    const f = queueFixture([
      queueTicket("1", { labels: ["pm:core", "pm-approved", "pm-proposal"] }),
      queueTicket("2", {
        labels: ["pm:core", "pm-approved", "pm-needs-human"],
      }),
      queueTicket("3", { labels: ["pm:core", "pm-approved", "pm-dispatched"] }),
      queueTicket("4", { labels: ["pm:core", "pm-approved", "pm-verified"] }),
      queueTicket("5", { stateType: "completed" }),
      queueTicket("6"),
      queueTicket("7"),
    ]);
    const previous = {
      ...job,
      ticket: "APP-6",
      status: "failed" as const,
      linearBinding: { connectionId: "default", ticketId: "6" },
    };
    expect(
      (await f.selectDeveloperTicket(codingRequest, [previous])).ticket,
    ).toBe("APP-7");
    expect(f.getTicket).toHaveBeenCalledExactlyOnceWith("7");
  });
  it("rechecks listed approval and continues to the next candidate when it was removed", async () => {
    const f = queueFixture([queueTicket("1"), queueTicket("2")], (value) =>
      value.id === "1"
        ? { ...value, labels: ["pm:core", "pm-proposal"] }
        : value,
    );
    expect((await f.selectDeveloperTicket(codingRequest, [])).ticket).toBe(
      "APP-2",
    );
    expect(f.getTicket.mock.calls.map((call) => call[0])).toEqual(["1", "2"]);
  });
  it("allows paused PMs for one manual run without enabling automation", async () => {
    edit("areas.json", (raw) => {
      raw.areas.core.enabled = false;
    });
    const f = queueFixture([queueTicket("1")]);
    expect((await f.selectDeveloperTicket(codingRequest, [])).area).toBe(
      "core",
    );
    expect(
      JSON.parse(readFileSync(join(root, "projects/app/areas.json"), "utf8"))
        .areas.core.enabled,
    ).toBe(false);
  });
  it("keeps full PM work-in-progress slots out of automatic selection", async () => {
    const f = queueFixture([queueTicket("1")]);
    const area = JSON.parse(
      readFileSync(join(root, "projects/app/areas.json"), "utf8"),
    ).areas.core;
    const previous = Array.from({ length: area.wipLimit }, (_, i) => ({
      ...job,
      id: `active-${i}`,
      area: "core",
      ticket: `APP-${10 + i}`,
      status: "running" as const,
    }));
    await expect(
      f.selectDeveloperTicket(codingRequest, previous),
    ).rejects.toThrow(
      "No approved tickets with finite acceptance criteria are ready",
    );
    expect(f.listTickets).not.toHaveBeenCalled();
  });
  it("does not treat another project incarnation's job as this project's attempted issue", async () => {
    const f = queueFixture([queueTicket("1")]);
    const previous = {
      ...job,
      projectInstanceId: "a1b2c3d4-1111-4222-8333-444444444444",
      ticket: "APP-1",
      status: "succeeded" as const,
      linearBinding: { connectionId: "default", ticketId: "1" },
    };
    expect(
      (await f.selectDeveloperTicket(codingRequest, [previous])).ticket,
    ).toBe("APP-1");
  });
  it("gives a useful empty-queue result instead of requesting an arbitrary ticket", async () => {
    const f = queueFixture([
      queueTicket("1", { labels: ["pm:core", "pm-proposal"] }),
    ]);
    await expect(f.selectDeveloperTicket(codingRequest, [])).rejects.toThrow(
      "Run the PM to investigate and prepare scoped work",
    );
    expect(f.getTicket).not.toHaveBeenCalled();
  });
  it("rejects queued work from a previous project incarnation before resolving a ticket", async () => {
    const prepared = setup();
    edit("project.json", (raw) => {
      raw.instanceId = "a1b2c3d4-1111-2222-3333-444444444444";
    });
    await expect(prepared.prepareJob(job)).rejects.toThrow(
      "project was replaced",
    );
    expect(prepared.getTicket).not.toHaveBeenCalled();
    const jobs = await prepared.scheduledJobs();
    expect(jobs.length).toBeGreaterThan(0);
    expect(
      jobs.every(
        (item) =>
          item.projectInstanceId === "a1b2c3d4-1111-2222-3333-444444444444",
      ),
    ).toBe(true);
  });
  it("pins Docker builds to the admitted checkout and separates app secrets from browser credentials", async () => {
    const target = {
      kind: "docker",
      role: "staging",
      recipe: { kind: "dockerfile", dockerfile: "Dockerfile", context: "." },
      port: 3000,
      env: { APP_KEY: "TEST_APP_KEY" },
      access: {
        kind: "password",
        loginPath: "/login",
        usernameSelector: "#email",
        passwordSelector: "#password",
        submitSelector: "button",
        successSelector: "#home",
        accounts: [
          {
            name: "Member",
            usernameSecret: "TEST_USER",
            passwordSecret: "TEST_PASSWORD",
          },
        ],
      },
    };
    edit("project.json", (raw) => {
      raw.workflow = { kind: "pull-request", baseBranch: "pm-staging" };
      raw.verification = { mode: "browser", environment: "test" };
      raw.environments = { test: target };
    });
    const sha = "a".repeat(40);
    const hostingFetch = vi.fn<typeof fetch>(
      async () => new Response(JSON.stringify({ sha }), { status: 200 }),
    );
    const prepared = createJobPreparation({
      root,
      env: {
        ...env,
        TEST_APP_KEY: "app-only",
        TEST_USER: "test@example.test",
        TEST_PASSWORD: "password with spaces",
      },
      hostingFetch,
      linear: () => ({
        getTicket: async () => ticket,
        listTickets: async () => [ticket],
      }),
    });
    const payload = await prepared.prepareJob(job);
    expect(payload.expectedCommitSha).toBe(sha);
    expect(payload.testEnvironment?.env).toEqual({ APP_KEY: "app-only" });
    expect(payload.credentials).toMatchObject({
      GREMLINS_TEST_USERNAME_1: "test@example.test",
      GREMLINS_TEST_PASSWORD_1: "password with spaces",
    });
    expect(JSON.stringify(payload.credentials)).not.toContain("app-only");
    expect(payload.prompt).toContain("http://app.test:3000");
    expect(payload.prompt).toContain("freshly verified sign-in");
    expect(payload.testAccess).toMatchObject({
      version: 1,
      access: { kind: "password" },
    });
    expect(payload.prompt).not.toContain("GREMLINS_TEST_PASSWORD_1");
    expect(payload.prompt).not.toContain("password with spaces");
    expect(String(hostingFetch.mock.calls[0]?.[0])).toContain("pm-staging");
  });
  it("supplies bounded shared observations and captures approved ticket identity before publication", async () => {
    const beforeDeveloper = vi.fn(
      async (
        _job: LocalJob,
        payload: import("./docker.ts").DockerJobPayload,
        approved: LinearTicket,
      ) => {
        expect(approved.id).toBe(ticket.id);
        expect(approved.labels).toContain("pm-approved");
        return payload;
      },
    );
    const sharedContext = vi.fn(
      () => "Sibling observations: " + "x".repeat(50000),
    );
    const preparation = createJobPreparation({
      root,
      env,
      beforeDeveloper,
      sharedContext,
      linear: () => ({
        getTicket: async () => ticket,
        listTickets: async () => [],
      }),
      preview: async () => "https://app-preview.vercel.app",
    });
    const payload = await preparation.prepareJob(job);
    expect(beforeDeveloper).toHaveBeenCalledOnce();
    expect(sharedContext).toHaveBeenCalledWith(
      expect.objectContaining({ dir: expect.any(String) }),
      expect.objectContaining({ key: "core" }),
      job,
    );
    expect(payload.prompt).toContain("SHARED PROJECT OBSERVATIONS");
    expect(payload.prompt).toContain("[Shared context truncated");
    expect(payload.prompt).not.toContain("x".repeat(25000));
  });
  it("admits code-only discovery before Linear/hosting verification and leases only source plus AI credentials", async () => {
    edit("project.json", (raw) => {
      raw.verified = null;
    });
    edit("areas.json", (raw) => {
      raw.areas.core.enabled = false;
      raw.areas.core.linearProjectId = "PASTE_LINEAR_PROJECT_ID";
    });
    writeFileSync(
      join(root, "projects/app/core/mandate.md"),
      "Owner-only direction: inspect account boundaries.",
    );
    const forbidden = vi.fn(async () => {
      throw new Error("Integration must not be contacted");
    });
    const acquireLease = vi.fn(async () => ({
      token: "source-read-token",
      method: "token" as const,
    }));
    const source = {
      acquireLease,
      resolveCredential: vi.fn(async () => ({
        token: "source-read-token",
        method: "token" as const,
      })),
      releaseLease: vi.fn(async () => {}),
    };
    const preparation = createJobPreparation({
      root,
      env,
      sourceControl: source,
      linearConnection: {
        acquireLease: forbidden,
        resolveCredential: forbidden,
        releaseLease: vi.fn(async () => {}),
      },
      vercelConnection: { resolveCredential: forbidden },
      resolveEnvironment: forbidden,
      telemetryFetch: forbidden,
    });
    const input = {
      type: "pm" as const,
      project: "app",
      area: "core",
      runOnce: true,
      pmMode: "discovery" as const,
    };
    const validated = await preparation.validate(input);
    const queued = {
      ...job,
      ...input,
      ticket: undefined,
      discoveryRevision: validated.discoveryRevision,
    };
    const payload = await preparation.prepareJob(queued);
    expect(payload).toMatchObject({
      kind: "pm",
      pmMode: "discovery",
      browserVerification: false,
      nonce: job.id,
      branch: "main",
    });
    expect(Object.keys(payload.credentials!).sort()).toEqual([
      "CLAUDE_CODE_OAUTH_TOKEN",
      "GITHUB_TOKEN",
    ]);
    expect(payload.prompt).toContain("Owner-only direction");
    expect(payload.prompt).not.toContain("linear-token");
    expect(payload.commands).toBeUndefined();
    expect(payload.delivery).toBeUndefined();
    expect(acquireLease).toHaveBeenCalledWith(
      expect.objectContaining({ write: false, repository: "owner/app" }),
    );
    expect(forbidden).not.toHaveBeenCalled();
    await expect(
      preparation.validate({ ...input, runOnce: false }),
    ).rejects.toThrow("explicit PM run");
    writeFileSync(
      join(root, "projects/app/core/mandate.md"),
      "Different owner scope",
    );
    await expect(preparation.prepareJob(queued)).rejects.toThrow(
      "settings changed",
    );
    expect(acquireLease).toHaveBeenCalledTimes(1);
  });
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
    expect(pm.prompt).toContain("Cite commands, exit codes and actual output");
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
          access: { kind: "public" },
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
    const commitIdentity = {
      name: "source-user",
      email: "42+source-user@users.noreply.github.com",
    };
    const acquireLease = vi.fn(async () => ({
      token: "official-oauth-token",
      method: "oauth" as const,
      commitIdentity,
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
    expect(payload.commitIdentity).toEqual(commitIdentity);
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
    expect(payload.browserTarget).toBe("https://app-preview.vercel.app");
    expect(payload.prompt).toContain("Playwright MCP is already configured");
    expect(payload.prompt).not.toContain("preview-secret");
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
    chooseBrowserAccess();
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
    chooseBrowserAccess();
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
    chooseBrowserAccess();
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
  it.each([false, true])(
    "prepares PM labels in the configured or sole project team before launching (configured: %s)",
    async (configured) => {
      const teamId = "11111111-1111-4111-8111-111111111111";
      const file = join(root, "projects/app/project.json");
      const raw = JSON.parse(readFileSync(file, "utf8"));
      raw.workflow = { kind: "pull-request", baseBranch: "main" };
      raw.verification = { mode: "repository" };
      if (configured) raw.linear = { teamId };
      writeFileSync(file, JSON.stringify(raw));
      const ensureLabels = vi.fn(async () => {});
      const repairProposalAreaLabels = vi.fn(async () => {});
      const prepared = createJobPreparation({
        root,
        env,
        linear: () => ({
          getTicket: async () => ticket,
          listTickets: async () => [],
          getProject: async () => ({
            id: "linear-project",
            name: "Core",
            url: "https://linear.app/core",
            teamIds: configured ? ["another-team", teamId] : [teamId],
          }),
          ensureLabels,
          repairProposalAreaLabels,
        }),
      });
      await prepared.prepareJob({
        ...job,
        type: "pm",
        area: "core",
        ticket: undefined,
      });
      expect(ensureLabels).toHaveBeenCalledExactlyOnceWith(teamId, [
        "pm:core",
        "pm-proposal",
      ]);
      expect(repairProposalAreaLabels).toHaveBeenCalledExactlyOnceWith({
        teamId,
        projectId: "linear-project",
        label: "pm:core",
      });
    },
  );
  it("prepares promotion approval labels and hands ordinary scoped work to coding without an owner step", async () => {
    edit("project.json", (raw) => {
      raw.workflow = { kind: "promotion" };
    });
    chooseBrowserAccess();
    const ensureLabels = vi.fn(async () => {});
    const getTicket = vi.fn(async () => ({
      ...ticket,
      labels: ["pm:core", "pm-tier-b", "pm-approved"],
    }));
    const prepared = createJobPreparation({
      root,
      env,
      preview: async () => "https://app-preview.vercel.app",
      linear: () => ({
        getTicket,
        listTickets: async () => [await getTicket()],
        getProject: async () => ({
          id: "linear-project",
          name: "Core",
          url: "https://linear.app/core",
          teamIds: ["team-1"],
        }),
        ensureLabels,
      }),
    });
    const payload = await prepared.prepareJob({
      ...job,
      type: "pm",
      area: "core",
      ticket: undefined,
    });
    expect(ensureLabels).toHaveBeenCalledExactlyOnceWith("team-1", [
      "pm:core",
      "pm-proposal",
      "pm-approved",
      "pm-epic",
      "pm-tier-a",
      "pm-tier-b",
      "pm-tier-c",
      "pm-needs-human",
    ]);
    for (const instruction of [
      "you may self-approve ordinary implementation tickets",
      'exact Markdown heading "## Acceptance criteria" and a finite bullet list',
      "do not also add pm-proposal",
      "never remove pm-needs-human",
      "Preserve explicit owner review-only instructions",
      "tiers.hubOwnerOnly",
      "Size alone does not require per-ticket human approval",
      "your own area's promotion PR",
      "Do not ask anyone to manage internal PRs",
    ])
      expect(payload.prompt).toContain(instruction);
    expect(payload.prompt).not.toContain("Never self-approve tickets.");
    expect(
      (await prepared.validate({ ...job, runOnce: true })).ticket?.id,
    ).toBe(ticket.id);
    getTicket.mockResolvedValueOnce({
      ...ticket,
      labels: ["pm:core", "pm-tier-b", "pm-approved", "pm-needs-human"],
    });
    await expect(prepared.validate({ ...job, runOnce: true })).rejects.toThrow(
      "needs-human tickets cannot run",
    );
  });
  it("keeps owner ticket approval in explicit direct-PR PM instructions", async () => {
    edit("project.json", (raw) => {
      raw.workflow = { kind: "pull-request", baseBranch: "main" };
      raw.verification = { mode: "repository" };
    });
    const payload = await setup().prepareJob({
      ...job,
      type: "pm",
      area: "core",
      ticket: undefined,
    });
    expect(payload.prompt).toContain("Never self-approve tickets.");
    expect(payload.prompt).not.toContain("you may self-approve");
  });
  it("does not automatically relabel proposals when another app shares the Linear project", async () => {
    chooseBrowserAccess();
    initializeSetup(root, packageRoot, {
      project: "second-app",
      repo: "owner/second",
    });
    const path = join(root, "projects/second-app/areas.json"),
      second = JSON.parse(readFileSync(path, "utf8"));
    second.areas.core.linearProjectId = "linear-project";
    writeFileSync(path, JSON.stringify(second));
    const ensureLabels = vi.fn(async () => {}),
      repairProposalAreaLabels = vi.fn(async () => {});
    const prepared = createJobPreparation({
      root,
      env,
      preview: async () => "https://preview.example.com",
      linear: () => ({
        getTicket: async () => ticket,
        listTickets: async () => [],
        getProject: async () => ({
          id: "linear-project",
          name: "Core",
          url: "https://linear.app/core",
          teamIds: ["team-1"],
        }),
        ensureLabels,
        repairProposalAreaLabels,
      }),
    });
    await prepared.prepareJob({
      ...job,
      type: "pm",
      area: "core",
      ticket: undefined,
    });
    expect(ensureLabels).toHaveBeenCalledOnce();
    expect(repairProposalAreaLabels).not.toHaveBeenCalled();
  });
  it.each(["permission", "ambiguous"])(
    "prevents an unroutable PM launch after a %s label setup failure",
    async (failure) => {
      chooseBrowserAccess();
      const ensureLabels = vi.fn(async () => {
        throw new Error("provider secret must not leak");
      });
      const releaseLease = vi.fn(async () => {});
      const sourceAcquire = vi.fn(async () => ({
        token: "source",
        method: "token" as const,
      }));
      const prepared = createJobPreparation({
        root,
        env,
        preview: async () => "https://preview.example.com",
        linearConnection: {
          resolveCredential: async () => ({
            token: "linear",
            authorization: "linear",
            method: "token" as const,
          }),
          acquireLease: async () => ({
            token: "linear",
            authorization: "linear",
            method: "token" as const,
          }),
          releaseLease,
        },
        sourceControl: { acquireLease: sourceAcquire },
        linear: () => ({
          getTicket: async () => ticket,
          listTickets: async () => [],
          getProject: async () => ({
            id: "linear-project",
            name: "Core",
            url: "https://linear.app/core",
            teamIds:
              failure === "ambiguous" ? ["team-1", "team-2"] : ["team-1"],
          }),
          ensureLabels,
        }),
      });
      await expect(
        prepared.prepareJob({
          ...job,
          type: "pm",
          area: "core",
          ticket: undefined,
        }),
      ).rejects.toThrow(
        failure === "ambiguous"
          ? "Choose this project's Linear team"
          : "permission to read and create issue labels",
      );
      expect(releaseLease).toHaveBeenCalledWith(job.id);
      expect(sourceAcquire).not.toHaveBeenCalled();
      expect(ensureLabels).toHaveBeenCalledTimes(
        failure === "ambiguous" ? 0 : 1,
      );
    },
  );
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
    chooseBrowserAccess();
    const scheduler = setup();
    const first = await scheduler.scheduledJobs();
    expect(first).toEqual(await scheduler.scheduledJobs());
    expect(first.map((input) => input.idempotencyKey)).toEqual([
      "pm:app:core:2026-10-04T09:00",
      "developer:app:ticket-id",
    ]);
    edit("areas.json", (raw) => {
      raw.areas.core.instanceId = "d6c5fa4b-a631-4c17-9d5e-8b9b8c790eea";
    });
    const replaced = await scheduler.scheduledJobs();
    expect(replaced.find((input) => input.type === "pm")?.idempotencyKey).toBe(
      "pm:app:core:d6c5fa4b-a631-4c17-9d5e-8b9b8c790eea:2026-10-04T09:00",
    );
    edit("areas.json", (raw) => {
      raw.areas.core.enabled = false;
    });
    expect(await scheduler.scheduledJobs()).toEqual([]);
  });
  it("ranks approved urgent tickets before older low-priority tickets without changing WIP or identities", async () => {
    const file = join(root, "projects/app/areas.json"),
      areas = JSON.parse(readFileSync(file, "utf8"));
    areas.areas.core.wipLimit = 2;
    writeFileSync(file, JSON.stringify(areas));
    const tickets = [
      {
        ...ticket,
        id: "low",
        identifier: "APP-1",
        priority: 4,
        createdAt: "2025-01-01T00:00:00Z",
      },
      {
        ...ticket,
        id: "urgent",
        identifier: "APP-2",
        priority: 1,
        createdAt: "2026-10-03T00:00:00Z",
      },
      {
        ...ticket,
        id: "none",
        identifier: "APP-3",
        priority: 0,
        createdAt: "2024-01-01T00:00:00Z",
      },
    ];
    const scheduler = createJobPreparation({
      root,
      env,
      linear: () => ({
        getTicket: async () => null,
        listTickets: async () => tickets,
      }),
      now: () => new Date("2026-10-04T09:00:45Z"),
    });
    const jobs = (await scheduler.scheduledJobs()).filter(
      (item) => item.type === "developer",
    );
    expect(jobs.map((item) => item.ticket)).toEqual(["APP-2", "APP-1"]);
    expect(jobs.map((item) => item.idempotencyKey)).toEqual([
      "developer:app:urgent",
      "developer:app:low",
    ]);
  });
  it("reaches a ten-ticket promotion target with two WIP slots without recoding verified tickets", async () => {
    const areasFile = join(root, "projects/app/areas.json");
    const areas = JSON.parse(readFileSync(areasFile, "utf8"));
    areas.areas.core.wipLimit = 2;
    writeFileSync(areasFile, JSON.stringify(areas));
    edit("project.json", (raw) => {
      raw.workflow = { kind: "promotion", promotionBatchSize: 10 };
    });
    const project = loadProject(root, "app"),
      area = project.areas[0]!;
    const tickets = Array.from({ length: 10 }, (_, index) => ({
      ...ticket,
      id: `ticket-${index}`,
      identifier: `APP-${index}`,
      priority: 1,
      createdAt: `2026-10-01T00:${String(index).padStart(2, "0")}:00Z`,
    }));
    const history: LocalJob[] = [];
    const records: DeliveryRecord[] = [];
    const scheduler = createJobPreparation({
      root,
      env,
      linear: () => ({
        getTicket: async (id) => tickets.find((item) => item.id === id) ?? null,
        listTickets: async () => tickets,
      }),
      deliveryRecords: () => records,
      now: () => new Date("2026-10-04T09:00:45Z"),
    });
    for (let round = 0; round < 5; round++) {
      const next = (await scheduler.scheduledJobs(history)).filter(
        (input) => input.type === "developer",
      );
      expect(next.map((input) => input.ticket)).toEqual([
        `APP-${round * 2}`,
        `APP-${round * 2 + 1}`,
      ]);
      for (const input of next) {
        const item = tickets.find(
          (candidate) => candidate.id === input.linearBinding!.ticketId,
        )!;
        const nextJob = {
          ...input,
          id: `job-${item.id}`,
          runId: history.length + 1,
          status: "succeeded" as const,
          createdAt: "2026-10-04T09:00:00Z",
        };
        history.push(nextJob);
        records.push({
          jobId: nextJob.id,
          area: area.key,
          ticket: item,
          scopeHash: ticketScopeHash(item),
          configuration: deliveryConfiguration(project, area.key),
          status: "awaiting-review",
          implementation: { mergeSha: "a".repeat(40) },
        } as unknown as DeliveryRecord);
      }
      expect(
        (await scheduler.scheduledJobs(history)).filter(
          (input) => input.type === "developer",
        ),
      ).toEqual([]);
      for (const record of records) {
        record.status = "verified";
        record.review = {
          verdict: "passed",
          manifestHash: "trusted-review",
        } as DeliveryRecord["review"];
      }
    }
    expect(records).toHaveLength(10);
    expect(
      (await scheduler.scheduledJobs(history)).filter(
        (input) => input.type === "developer",
      ),
    ).toEqual([]);
  });
});

it("evaluates cron in UTC, including ranges/steps and invalid input", () => {
  const now = new Date("2026-10-05T09:30:12Z");
  expect(scheduledThisMinute("*/15 9-17 * * 1-5", now)).toBe(true);
  expect(scheduledThisMinute("31 9 * * *", now)).toBe(false);
  expect(scheduledThisMinute("not a cron", now)).toBe(false);
  expect(scheduledThisMinute("99 99 * * *", now)).toBe(false);
});
