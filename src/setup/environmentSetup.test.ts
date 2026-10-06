import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { initializeSetup } from "./files.ts";
import { readEditableConfig, saveEditableConfig } from "./configEditor.ts";
import {
  createEnvironmentSetup,
  type EnvironmentSetupOptions,
} from "./environmentSetup.ts";
import { effectiveVerification } from "../projectCapabilities.ts";
import { loadProject } from "../config.ts";
import { VercelSetupError } from "../vercelSetup/types.ts";
import { LocalRunnerError } from "../localRunners/engine.ts";
import type { EnvironmentVerification } from "./environmentAccess.ts";
import type {
  VercelTarget,
  VercelProject,
  VercelCandidate,
} from "../vercelSetup/types.ts";

let root: string;
const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
const target: VercelTarget = {
  kind: "vercel",
  role: "preview",
  projectId: "prj_app",
  connectionId: "default",
  branch: "pm-staging",
};
const matched: VercelProject = {
  id: "prj_app",
  name: "app-preview",
  repository: "owner/app",
  provider: "github",
  matchesRepository: true,
  productionBranch: "main",
  customEnvironments: [],
};
const config = () => readEditableConfig(root, "projects/app/project.json");
type FixtureConfig = {
  environments: Record<string, Record<string, unknown>>;
  verification: { mode: string; environment: string };
  branches: { production: string; staging: string; integration: string };
  verified: null;
  description: string;
  instanceId: string;
};
const edit = (update: (raw: FixtureConfig) => void) => {
  const file = config();
  const raw = JSON.parse(file.content);
  update(raw);
  saveEditableConfig(root, {
    path: file.path,
    revision: file.revision,
    content: JSON.stringify(raw, null, 2) + "\n",
  });
};
const useTarget = (value: unknown) =>
  edit((raw) => {
    raw.environments = { preview: value as Record<string, unknown> };
    raw.verification = { mode: "browser", environment: "preview" };
  });
beforeEach(() => {
  root = mkdtempSync(
    join(realpathSync(tmpdir()), "gremlins-environment-setup-"),
  );
  initializeSetup(root, packageRoot, {
    project: "app",
    repo: "owner/app",
    createInitialPm: false,
  });
  edit((raw) => {
    raw.branches = {
      production: "main",
      staging: "staging",
      integration: "pm-staging",
    };
  });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
function harness() {
  let verification: EnvironmentVerification = {
    status: "untested",
    message: "Not checked",
  };
  let projects = [matched];
  let deploymentState = "READY";
  let deploymentBranch = "pm-staging";
  let results: EnvironmentVerification[] = [];
  let afterDiscover: (() => void) | undefined;
  let connectFailure = false;
  let extraConfigChange = false;
  const discover = vi.fn<EnvironmentSetupOptions["vercelSetup"]["discover"]>(
    async (_name, input = {}) => {
      afterDiscover?.();
      const selected = projects.find(
        (project) => project.id === input.projectId,
      );
      const candidate: VercelCandidate = {
        id: "dpl_new",
        state: deploymentState,
        environment: "preview",
        branch: deploymentBranch,
        sha: "a".repeat(40),
        createdAt: 20,
        selectable: deploymentState === "READY",
        ...(deploymentState === "READY"
          ? {
              target: {
                ...target,
                branch: deploymentBranch,
                connectionId: input.connectionId ?? "default",
                projectId: input.projectId ?? target.projectId,
              },
            }
          : {}),
      };
      return {
        project: "app",
        status: "discovered",
        revision: "a".repeat(64),
        configurationRevision: config().revision,
        stale: false,
        message: "provider message must not be copied",
        updatedAt: new Date().toISOString(),
        inventory: {
          connectionId: input.connectionId ?? "default",
          projects,
          selectedProject: selected,
          deployments: selected
            ? [
                candidate,
                {
                  ...candidate,
                  id: "dpl_old",
                  state: "READY",
                  createdAt: 10,
                  selectable: true,
                  target,
                },
              ]
            : [],
          truncated: false,
        },
      };
    },
  );
  const connect = vi.fn<EnvironmentSetupOptions["vercelAccess"]["connect"]>(
    async () => {
      if (connectFailure) throw Error("private-provider-token");
      edit((raw) => {
        const environment = raw.verification.environment;
        raw.environments[environment]!.bypassSecret = "TEST_PREVIEW_ACCESS";
        raw.verified = null;
        if (extraConfigChange) raw.description = "another owner edit";
      });
    },
  );
  const verify = vi.fn(async () => {
    verification = results.shift() ?? { status: "passed", message: "Verified" };
    return verification;
  });
  const recordConfigured = vi.fn(async () => {});
  const options: EnvironmentSetupOptions = {
    root,
    vercelSetup: {
      discover,
      status: async () => {
        throw Error("not needed");
      },
    },
    vercelAccess: { connect },
    environmentAccess: {
      verify,
      status: () => verification,
      idle: async () => {},
    },
    connectionIds: () => ["default"],
    configurationMutation: async (_name, operation) => operation(),
    recordConfigured,
  };
  const service = createEnvironmentSetup(options);
  return {
    service,
    options,
    discover,
    connect,
    verify,
    recordConfigured,
    setProjects: (value: VercelProject[]) => {
      projects = value;
    },
    pending: () => {
      deploymentState = "BUILDING";
    },
    branch: (value: string) => {
      deploymentBranch = value;
    },
    results: (value: EnvironmentVerification[]) => {
      results = value;
    },
    passed: () => {
      verification = { status: "passed", message: "Verified" };
    },
    onDiscover: (action: () => void) => {
      afterDiscover = action;
    },
    failConnect: () => {
      connectFailure = true;
    },
    unrelatedChange: () => {
      extraConfigChange = true;
    },
  };
}
async function run(
  h: ReturnType<typeof harness>,
  input: Partial<Parameters<typeof h.service.prepare>[1]> = {},
) {
  const response = await h.service.prepare("app", {
    configurationRevision: config().revision,
    ...input,
  });
  await h.service.idle();
  return { response, state: h.service.status("app") };
}
const protectedFailure: EnvironmentVerification = {
  status: "failed",
  message: "private-page-content",
  diagnosis: {
    code: "preview_credential_rejected",
    title: "Rejected",
    detail: "Private",
    action: "manage_credentials",
  },
};

describe("automatic environment preparation", () => {
  it("is not busy for a new project that has not been created yet", () => {
    expect(harness().service.busy("new-app")).toBe(false);
  });
  it("uses the conventional pm-staging preview when repository-only branches all default to main", async () => {
    edit((raw) => {
      raw.branches = {
        production: "main",
        integration: "main",
        staging: "main",
      };
    });
    const h = harness();
    expect((await run(h)).state?.status).toBe("ready");
    expect(
      effectiveVerification(loadProject(root, "app").config),
    ).toMatchObject({ target: { branch: "pm-staging" } });
  });
  it("accepts an explicitly selected safe preview branch instead of the old inspection branch", async () => {
    useTarget(target);
    const h = harness();
    h.branch("owner-test");
    expect(
      (await run(h, { target: { ...target, branch: "owner-test" } })).state
        ?.status,
    ).toBe("ready");
    expect(
      effectiveVerification(loadProject(root, "app").config),
    ).toMatchObject({ target: { branch: "owner-test" } });
  });
  it("does not choose arbitrary PR previews or the provider's production branch", async () => {
    const h = harness();
    h.branch("gremlins/job-another");
    expect((await run(h)).state).toMatchObject({
      status: "needs_input",
      action: "choose_preview",
    });
    expect(h.connect).not.toHaveBeenCalled();
    const other = harness();
    other.setProjects([{ ...matched, productionBranch: "pm-staging" }]);
    expect((await run(other)).state).toMatchObject({
      status: "needs_input",
      action: "choose_preview",
    });
    expect(other.connect).not.toHaveBeenCalled();
  });
  it("finds a unique repository preview, saves with CAS, connects access and verifies without creating a deployment", async () => {
    const h = harness();
    const initial = config().revision;
    const { response, state } = await run(h);
    expect(response.status).toBe("preparing");
    expect(state).toMatchObject({
      status: "ready",
      step: "test_access",
      configurationRevision: config().revision,
    });
    const selected = effectiveVerification(loadProject(root, "app").config);
    expect(selected).toMatchObject({
      mode: "browser",
      target: { ...target, bypassSecret: "TEST_PREVIEW_ACCESS" },
    });
    expect(h.discover).toHaveBeenCalledTimes(2);
    expect(h.connect).toHaveBeenCalledOnce();
    expect(h.verify).toHaveBeenCalledOnce();
    expect(h.recordConfigured).toHaveBeenCalledWith("app", {
      previousConfigurationRevision: initial,
      profile: "hosted",
    });
    expect(createEnvironmentSetup(h.options).status("app")).toMatchObject({
      status: "ready",
    });
  });
  it("reuses the saved Vercel target and retains its private login references", async () => {
    const access = {
      kind: "password",
      loginPath: "/sign-in/password",
      usernameSelector: "#email",
      passwordSelector: "#password",
      submitSelector: "button",
      successSelector: "#account",
      accounts: [
        {
          name: "Tester",
          usernameSecret: "TEST_EMAIL",
          passwordSecret: "TEST_PASSWORD",
        },
      ],
    };
    useTarget({ ...target, access });
    const h = harness();
    await run(h, { target });
    expect(h.discover).not.toHaveBeenCalled();
    expect(
      effectiveVerification(loadProject(root, "app").config),
    ).toMatchObject({ target: { access } });
    expect(h.verify).toHaveBeenCalledOnce();
  });
  it("does not replace an existing URL or Docker environment implicitly", async () => {
    useTarget({ kind: "url", role: "staging", url: "https://app.test" });
    const before = config().content;
    const h = harness();
    const { state } = await run(h);
    expect(state).toMatchObject({
      status: "needs_input",
      action: "choose_preview",
    });
    expect(config().content).toBe(before);
    expect(h.discover).not.toHaveBeenCalled();
    expect(h.connect).not.toHaveBeenCalled();
  });
  it("requires a choice for multiple exact repository projects and excludes unrelated projects", async () => {
    const h = harness();
    h.setProjects([
      matched,
      { ...matched, id: "prj_other", name: "other-app" },
      {
        ...matched,
        id: "prj_wrong",
        name: "unrelated",
        matchesRepository: false,
        repository: "owner/unrelated",
      },
    ]);
    const before = config().content;
    const { state } = await run(h);
    expect(state).toMatchObject({
      status: "needs_input",
      action: "choose_preview",
    });
    expect(state?.choices?.map((choice) => choice.projectId)).toEqual([
      "prj_app",
      "prj_other",
    ]);
    expect(config().content).toBe(before);
    expect(h.connect).not.toHaveBeenCalled();
  });
  it("never falls back to an old ready deployment while the newest branch deployment builds", async () => {
    const h = harness();
    h.pending();
    const { state } = await run(h);
    expect(state).toMatchObject({
      status: "needs_input",
      action: "choose_preview",
    });
    expect(h.connect).not.toHaveBeenCalled();
    expect(h.verify).not.toHaveBeenCalled();
  });
  it("does not silently choose from the remaining accounts when one account cannot be checked", async () => {
    const h = harness();
    h.options.connectionIds = () => ["default", "second"];
    const original = h.discover.getMockImplementation()!;
    h.discover.mockImplementation(async (name, input) => {
      if (input?.connectionId === "second") throw Error("private-token");
      return original(name, input);
    });
    const { state } = await run(h);
    expect(state).toMatchObject({
      status: "needs_input",
      action: "connect_vercel",
    });
    expect(h.connect).not.toHaveBeenCalled();
    expect(JSON.stringify(state)).not.toContain("private-token");
  });
  it("has a current-evidence fast path and supports explicit retesting", async () => {
    useTarget(target);
    const h = harness();
    h.passed();
    expect((await run(h)).state?.status).toBe("ready");
    expect(h.verify).not.toHaveBeenCalled();
    expect(h.connect).not.toHaveBeenCalled();
    await run(h, { force: true });
    expect(h.verify).toHaveBeenCalledOnce();
  });
  it("repairs once after actual protection rejection and retests once", async () => {
    useTarget(target);
    const h = harness();
    h.results([protectedFailure, { status: "passed", message: "Verified" }]);
    expect((await run(h)).state?.status).toBe("ready");
    expect(h.connect).toHaveBeenCalledTimes(2);
    expect(h.connect.mock.calls[1]?.[1]).toMatchObject({ repair: true });
    expect(h.verify).toHaveBeenCalledTimes(2);
  });
  it("checks a precisely identified missing legacy credential before one repair and retest", async () => {
    useTarget({ ...target, bypassSecret: "VERCEL_BYPASS_" + "A".repeat(64) });
    const h = harness();
    const order: string[] = [];
    const connect = h.connect.getMockImplementation()!;
    h.connect.mockImplementation(async (name, input) => {
      order.push(input.repair ? "repair" : "connect");
      if (!input.repair)
        throw new VercelSetupError(
          "The previous preview credential could not be reconciled. Test the saved environment before repairing its access.",
          409,
          "access_unconfirmed",
          "verify_legacy_credential",
        );
      return connect(name, input);
    });
    h.results([
      {
        status: "failed",
        message: "Missing",
        diagnosis: {
          code: "preview_credential_missing",
          title: "Missing",
          detail: "Missing",
          action: "connect_preview",
        },
      },
      { status: "passed", message: "Verified" },
    ]);
    const verify = h.verify.getMockImplementation()!;
    h.verify.mockImplementation(async () => {
      order.push("verify");
      return verify();
    });
    expect((await run(h)).state?.status).toBe("ready");
    expect(order).toEqual(["connect", "verify", "repair", "verify"]);
    expect(h.connect.mock.calls[1]?.[1]).toMatchObject({
      configurationRevision: expect.any(String),
      repair: true,
    });
  });
  it.each(["passed", "login_failed"])(
    "does not mint a legacy replacement after a %s check",
    async (outcome) => {
      useTarget(target);
      const h = harness();
      h.connect.mockRejectedValue(
        new VercelSetupError(
          "Test the saved environment before repairing its access.",
          409,
          "access_unconfirmed",
          "verify_legacy_credential",
        ),
      );
      if (outcome === "login_failed")
        h.results([
          {
            status: "failed",
            message: "Login needs attention",
            diagnosis: {
              code: "selector_not_found",
              title: "Missing",
              detail: "Missing",
              action: "edit_login",
              field: "usernameSelector",
              matchCount: 0,
            },
          },
        ]);
      expect((await run(h)).state?.status).toBe(
        outcome === "passed" ? "ready" : "needs_input",
      );
      expect(h.verify).toHaveBeenCalledOnce();
      expect(h.connect).toHaveBeenCalledOnce();
    },
  );
  it("does not probe pending legacy mint operations even with a misleading recovery field", async () => {
    useTarget(target);
    const h = harness();
    h.connect.mockRejectedValue(
      new VercelSetupError(
        "The previous access request is still pending.",
        409,
        "access_pending",
        "verify_legacy_credential",
      ),
    );
    expect((await run(h)).state).toMatchObject({
      status: "needs_input",
      action: "retry",
    });
    expect(h.verify).not.toHaveBeenCalled();
    expect(h.connect).toHaveBeenCalledOnce();
  });
  it("stops after one unsuccessful repair with safe credential guidance", async () => {
    useTarget(target);
    const h = harness();
    h.results([protectedFailure, protectedFailure]);
    const { state } = await run(h);
    expect(state).toMatchObject({
      status: "needs_input",
      action: "manage_credentials",
    });
    expect(h.connect).toHaveBeenCalledTimes(2);
    expect(h.verify).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(state)).not.toContain("private-page-content");
  });
  it("never repairs preview access for a login selector failure", async () => {
    useTarget(target);
    const h = harness();
    h.results([
      {
        status: "failed",
        message: "bad selector",
        diagnosis: {
          code: "selector_not_found",
          title: "Missing",
          detail: "Missing",
          field: "usernameSelector",
          matchCount: 0,
          action: "edit_login",
        },
      },
    ]);
    expect((await run(h)).state).toMatchObject({
      status: "needs_input",
      action: "edit_login",
    });
    expect(h.connect).toHaveBeenCalledOnce();
    expect(h.verify).toHaveBeenCalledOnce();
  });
  it("preserves the safe permission reason after access saved its credential reference", async () => {
    useTarget(target);
    const h = harness();
    const message =
      "Vercel denied access to Deployment Protection settings. Reconnect the selected account with project administration access, or use an authorized Vercel token.";
    const connect = h.connect.getMockImplementation()!;
    h.connect.mockImplementation(async (name, input) => {
      await connect(name, input);
      throw new VercelSetupError(message, 403, "provider_rejected");
    });
    const before = config().revision;
    const { state } = await run(h);
    expect(state).toMatchObject({
      status: "needs_input",
      action: "connect_vercel",
      message,
      configurationRevision: config().revision,
    });
    expect(config().revision).not.toBe(before);
    expect(h.verify).not.toHaveBeenCalled();
    expect(h.recordConfigured).toHaveBeenCalledWith("app", {
      previousConfigurationRevision: before,
      profile: "hosted",
    });
  });
  it.each([
    [
      "credential_changed",
      "Preview credentials changed while access was being repaired. Test the newer credentials before retrying.",
    ],
    [
      "access_unconfirmed",
      "Vercel did not return enough bypass metadata to repair access safely. Check this account's project administration access, then retry.",
    ],
    [
      "access_pending",
      "Vercel access creation may already have completed. Retry to recover its saved automation bypass; if it remains unavailable, check this project's Protection Bypass for Automation in Vercel. No additional secret will be created automatically.",
    ],
  ])(
    "retains %s guidance without suggesting another connection or repair",
    async (code, message) => {
      useTarget(target);
      const h = harness();
      h.connect.mockRejectedValue(new VercelSetupError(message, 409, code));
      expect((await run(h)).state).toMatchObject({
        status: "needs_input",
        action: "retry",
        message,
      });
      expect(h.connect).toHaveBeenCalledOnce();
      expect(h.verify).not.toHaveBeenCalled();
    },
  );
  it("preserves trusted discovery permission failures without choosing another account", async () => {
    const h = harness();
    const message =
      "Vercel denied access. Check the selected account, team and project permissions.";
    h.discover.mockRejectedValue(
      new VercelSetupError(message, 403, "provider_request"),
    );
    expect((await run(h)).state).toMatchObject({
      status: "needs_input",
      action: "connect_vercel",
      message,
    });
    expect(h.connect).not.toHaveBeenCalled();
  });
  it("explains a runner configuration lock without blaming the Vercel connection", async () => {
    useTarget(target);
    const h = harness();
    h.options.configurationMutation = async () => {
      throw new LocalRunnerError("private job detail", 409);
    };
    const { state } = await run(h);
    expect(state).toMatchObject({ status: "needs_input", action: "retry" });
    expect(state?.message).toContain("Active or queued jobs");
    expect(state?.message).not.toContain("private job detail");
    expect(h.connect).not.toHaveBeenCalled();
    expect(h.verify).not.toHaveBeenCalled();
  });
  it("does not reflect unrecognized provider error codes or bodies", async () => {
    useTarget(target);
    const h = harness();
    h.connect.mockRejectedValue(
      new VercelSetupError("private-provider-token", 403, "raw_provider_error"),
    );
    const { state } = await run(h);
    expect(state?.status).toBe("failed");
    expect(JSON.stringify(state)).not.toContain("private-provider-token");
  });
  it("rejects stale requests and detects unrelated config edits during discovery and access", async () => {
    const h = harness();
    await expect(
      h.service.prepare("app", { configurationRevision: "a".repeat(64) }),
    ).rejects.toMatchObject({ status: 409 });
    h.onDiscover(() =>
      edit((raw) => {
        raw.description = "Owner edit";
      }),
    );
    expect((await run(h)).state).toMatchObject({
      status: "needs_input",
      action: "retry",
    });
    expect(h.connect).not.toHaveBeenCalled();
    const next = harness();
    useTarget(target);
    next.unrelatedChange();
    expect((await run(next)).state).toMatchObject({
      status: "needs_input",
      action: "retry",
    });
    expect(next.verify).not.toHaveBeenCalled();
  });
  it("isolates recreated project incarnations and never writes their target from an older operation", async () => {
    const h = harness();
    h.onDiscover(() => {
      const raw = JSON.parse(config().content);
      raw.instanceId = randomUUID();
      writeFileSync(
        join(root, "projects/app/project.json"),
        JSON.stringify(raw),
      );
    });
    await run(h);
    expect(h.service.status("app")).toBeUndefined();
    expect(h.connect).not.toHaveBeenCalled();
    expect(effectiveVerification(loadProject(root, "app").config).mode).toBe(
      "repository",
    );
  });
  it("returns current progress on duplicate clicks and keeps all provider failures private", async () => {
    const h = harness();
    let release: () => void = () => {};
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = h.discover.getMockImplementation()!;
    h.discover.mockImplementation(async (name, input) => {
      await pending;
      return original(name, input);
    });
    const revision = config().revision;
    await h.service.prepare("app", { configurationRevision: revision });
    expect(
      (await h.service.prepare("app", { configurationRevision: revision }))
        .status,
    ).toBe("preparing");
    release();
    await h.service.idle();
    expect(h.connect).toHaveBeenCalledOnce();
    const failed = harness();
    failed.failConnect();
    expect((await run(failed, { force: true })).state).toMatchObject({
      status: "failed",
      action: "connect_vercel",
    });
    expect(JSON.stringify(failed.service.status("app"))).not.toContain(
      "private-provider-token",
    );
  });
});
