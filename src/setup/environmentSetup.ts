import {
  mkdirSync,
  openSync,
  closeSync,
  writeFileSync,
  unlinkSync,
  existsSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { loadProject, listProjectNames } from "../config.ts";
import { projectRuntimeKey } from "../projectIdentity.ts";
import {
  effectiveVerification,
  inspectionBranch,
  parseProjectCapabilities,
  validConnectionId,
  validBranch,
} from "../projectCapabilities.ts";
import { readEditableConfig, saveEditableConfig } from "./configEditor.ts";
import { writePrivate } from "../remoteWorkers/storage.ts";
import { safeOAuthPath } from "../oauthConnection/storage.ts";
import { dead, readPrivate, validProject } from "../vercelSetup/store.ts";
import { VercelSetupError } from "../vercelSetup/types.ts";
import { LocalRunnerError } from "../localRunners/engine.ts";
import type {
  VercelDiscoverInput,
  VercelSetupState,
  VercelTarget,
  VercelProject,
  VercelInventory,
  VercelCandidate,
} from "../vercelSetup/types.ts";
import type { EnvironmentVerification } from "./environmentAccess.ts";

export type EnvironmentSetupStep =
  "find_preview" | "save_environment" | "connect_access" | "test_access";
export type EnvironmentSetupAction =
  | "choose_preview"
  | "connect_vercel"
  | "edit_login"
  | "manage_credentials"
  | "retry";
export interface EnvironmentSetupChoice {
  connectionId: string;
  teamId?: string | null;
  projectId: string;
  name: string;
  rootDirectory?: string;
  branch: string;
  target?: VercelTarget;
}
export interface EnvironmentSetupState {
  status: "preparing" | "needs_input" | "ready" | "failed";
  step: EnvironmentSetupStep;
  message: string;
  action?: EnvironmentSetupAction;
  /** The account that needs authorization, when action is connect_vercel. */
  connectionId?: string;
  configurationRevision: string;
  updatedAt: string;
  choices?: EnvironmentSetupChoice[];
}
export interface EnvironmentSetupOptions {
  root: string;
  vercelSetup: {
    discover(
      name: string,
      input?: VercelDiscoverInput,
    ): Promise<VercelSetupState>;
    status(name: string): Promise<VercelSetupState>;
  };
  vercelAccess: {
    connect(
      name: string,
      input: { configurationRevision: string; repair?: boolean },
    ): Promise<unknown>;
  };
  environmentAccess: {
    verify(name: string): Promise<EnvironmentVerification>;
    status(name: string): EnvironmentVerification;
    idle(): Promise<void>;
  };
  connectionIds(): string[] | Promise<string[]>;
  configurationMutation(
    name: string,
    operation: () => Promise<void>,
  ): Promise<void>;
  recordConfigured?(
    name: string,
    input: { previousConfigurationRevision: string; profile: "hosted" },
  ): Promise<unknown>;
  /** Complete connection checks after the real browser probe, then stamp readiness. */
  verifyReadiness?(name: string): Promise<string>;
}
export class EnvironmentSetupError extends Error {
  constructor(
    message: string,
    public readonly status = 400,
  ) {
    super(message);
    this.name = "EnvironmentSetupError";
  }
}
type Stored = EnvironmentSetupState & { schema: 1; pid?: number };
const active = new Map<string, Promise<void>>();
const revision = /^[a-f0-9]{64}$/;
const resource = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/.test(value);
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const scope = (target: VercelTarget) =>
  JSON.stringify([
    target.connectionId ?? "default",
    target.teamId ?? null,
    target.projectId,
    target.branch,
    target.customEnvironmentId,
  ]);
function target(value: unknown): VercelTarget {
  try {
    const parsed = parseProjectCapabilities({
      environments: { test: value },
      verification: { mode: "browser", environment: "test" },
    }).environments!.test!;
    if (parsed.kind !== "vercel" || parsed.role === "production") throw Error();
    return parsed;
  } catch {
    throw new EnvironmentSetupError(
      "Choose a valid nonproduction Vercel preview.",
    );
  }
}
const publicTarget = (value: VercelTarget): VercelTarget => ({
  kind: "vercel",
  role: "preview",
  projectId: value.projectId,
  connectionId: value.connectionId ?? "default",
  ...(value.teamId !== undefined ? { teamId: value.teamId } : {}),
  ...(value.branch ? { branch: value.branch } : {}),
  ...(value.customEnvironmentId
    ? { customEnvironmentId: value.customEnvironmentId }
    : {}),
});

// These errors are constructed by the controller, never from a provider's body.
function trustedVercelFailure(error: unknown) {
  if (
    !(error instanceof VercelSetupError) ||
    ![
      "vercel_setup",
      "connection",
      "connection_changed",
      "provider_rejected",
      "provider_request",
      "provider_response",
      "credential_changed",
      "access_unconfirmed",
      "access_pending",
      "access_storage",
      "ambiguous_access",
      "preview_required",
      "preview_mismatch",
      "stale",
      "busy",
      "unconfirmed",
    ].includes(error.code) ||
    !error.message ||
    error.message.length > 1000 ||
    /[\p{Cc}\p{Cf}]/u.test(error.message)
  )
    return undefined;
  const review =
    ["preview_required", "preview_mismatch"].includes(error.code) ||
    error.status === 404;
  const connection =
    [401, 403].includes(error.status) || error.code === "connection";
  return {
    status: "needs_input" as const,
    message: error.message,
    action: (review
      ? "choose_preview"
      : connection
        ? "connect_vercel"
        : "retry") as EnvironmentSetupAction,
  };
}

export function createEnvironmentSetup(options: EnvironmentSetupOptions) {
  const root = resolve(options.root);
  let closed = false;
  const document = (name: string) => {
    validProject(name);
    return readEditableConfig(root, `projects/${name}/project.json`);
  };
  const identity = (name: string) =>
    projectRuntimeKey(loadProject(root, name).config);
  const key = (name: string) => `${root}\0${identity(name)}`;
  const file = (name: string) =>
    safeOAuthPath(
      join(root, ".run", "environment-setup", `${identity(name)}.json`),
    );
  function read(name: string): Stored | undefined {
    const raw = readPrivate(file(name), 64 * 1024);
    if (raw === undefined) return undefined;
    try {
      const state = JSON.parse(raw) as Stored;
      if (
        state.schema !== 1 ||
        !revision.test(state.configurationRevision) ||
        !["preparing", "needs_input", "ready", "failed"].includes(
          state.status,
        ) ||
        ![
          "find_preview",
          "save_environment",
          "connect_access",
          "test_access",
        ].includes(state.step) ||
        typeof state.message !== "string" ||
        state.message.length > 1000 ||
        !Number.isFinite(Date.parse(state.updatedAt)) ||
        (state.pid !== undefined &&
          (!Number.isSafeInteger(state.pid) || state.pid < 1)) ||
        (state.action !== undefined &&
          ![
            "choose_preview",
            "connect_vercel",
            "edit_login",
            "manage_credentials",
            "retry",
          ].includes(state.action)) ||
        (state.connectionId !== undefined &&
          !validConnectionId(state.connectionId)) ||
        (state.choices !== undefined &&
          (!Array.isArray(state.choices) || state.choices.length > 40))
      )
        throw Error();
      return state;
    } catch {
      throw new EnvironmentSetupError(
        "Environment setup history could not be read safely. Check configuration storage before retrying.",
        503,
      );
    }
  }
  function status(name: string): EnvironmentSetupState | undefined {
    const current = read(name);
    if (!current) return undefined;
    const { schema: _schema, pid: _pid, ...visible } = current;
    const currentRevision = document(name).revision;
    if (current.configurationRevision !== currentRevision)
      return {
        ...visible,
        status: "needs_input",
        configurationRevision: currentRevision,
        action: "retry",
        message:
          "Project settings changed. Continue setup with the current saved settings.",
        choices: undefined,
        connectionId: undefined,
      };
    if (
      current.status === "preparing" &&
      !active.has(key(name)) &&
      (!current.pid || current.pid === process.pid || dead(current.pid))
    )
      return {
        ...visible,
        status: "failed",
        action: "retry",
        message:
          "Environment setup was interrupted. Retry to continue from the saved settings.",
      };
    if (
      current.status === "ready" &&
      options.environmentAccess.status(name).status !== "passed"
    )
      return {
        ...visible,
        status: "needs_input",
        action: "retry",
        message:
          "The environment needs another access check before it is ready.",
      };
    return visible;
  }
  function busy(name?: string): boolean {
    if (name) {
      validProject(name);
      if (
        !existsSync(safeOAuthPath(join(root, "projects", name, "project.json")))
      )
        return false;
      const state = read(name);
      return (
        active.has(key(name)) ||
        !!(
          state?.status === "preparing" &&
          state.pid &&
          state.pid !== process.pid &&
          !dead(state.pid)
        )
      );
    }
    return (
      [...active.keys()].some((value) => value.startsWith(`${root}\0`)) ||
      listProjectNames(root).some((name) => busy(name))
    );
  }
  async function prepare(
    name: string,
    input: {
      configurationRevision: string;
      target?: VercelTarget;
      force?: boolean;
    },
  ) {
    if (closed)
      throw new EnvironmentSetupError(
        "The controller is stopping. Retry after it restarts.",
        503,
      );
    if (
      !object(input) ||
      Object.keys(input).some(
        (key) => !["configurationRevision", "target", "force"].includes(key),
      ) ||
      !revision.test(input.configurationRevision) ||
      (input.force !== undefined && typeof input.force !== "boolean")
    )
      throw new EnvironmentSetupError(
        "Refresh the current project settings before setting up its environment.",
      );
    const initial = document(name),
      initialProject = loadProject(root, name),
      instance = identity(name),
      operationKey = key(name),
      stateFile = file(name),
      lock = stateFile + ".lock";
    if (busy(name)) return status(name)!;
    if (initial.revision !== input.configurationRevision)
      throw new EnvironmentSetupError(
        "Project settings changed. Reload before preparing the environment.",
        409,
      );
    const explicit =
      input.target === undefined ? undefined : target(input.target);
    const rawInitial = JSON.parse(initial.content),
      rawBranches = object(rawInitial.branches) ? rawInitial.branches : {};
    const configuredIntegration =
      validBranch(rawBranches.integration) &&
      rawBranches.integration !== initialProject.config.branches.production
        ? rawBranches.integration
        : undefined;
    const verification = effectiveVerification(initialProject.config),
      branch =
        explicit?.branch ??
        (verification.mode === "browser" &&
        verification.target.kind === "vercel"
          ? inspectionBranch(initialProject.config)
          : (configuredIntegration ??
            (initialProject.config.branches.integration !==
            initialProject.config.branches.production
              ? initialProject.config.branches.integration
              : "pm-staging")));
    let expected = initial.revision;
    let activeConnectionId =
      explicit?.connectionId ??
      (verification.mode === "browser" && verification.target.kind === "vercel"
        ? (verification.target.connectionId ?? "default")
        : undefined);
    let state: EnvironmentSetupState = {
      status: "preparing",
      step: "find_preview",
      message: "Finding the right test preview for this app…",
      configurationRevision: expected,
      updatedAt: new Date().toISOString(),
    };
    const save = (change: Partial<EnvironmentSetupState>) => {
      state = {
        ...state,
        ...change,
        configurationRevision: expected,
        updatedAt: new Date().toISOString(),
      };
      writePrivate(
        stateFile,
        JSON.stringify({
          ...state,
          schema: 1,
          ...(state.status === "preparing" ? { pid: process.pid } : {}),
        }),
      );
    };
    const current = () => {
      if (
        closed ||
        identity(name) !== instance ||
        document(name).revision !== expected
      )
        throw new EnvironmentSetupError(
          "Project settings changed. Retry with the current saved environment.",
          409,
        );
      return loadProject(root, name);
    };
    const stop = (
      message: string,
      action: EnvironmentSetupAction,
      choices?: EnvironmentSetupChoice[],
      connectionId?: string,
    ) =>
      save({
        status: "needs_input",
        message,
        action,
        choices,
        connectionId: action === "connect_vercel" ? connectionId : undefined,
      });
    safeOAuthPath(lock);
    mkdirSync(dirname(lock), { recursive: true, mode: 0o700 });
    const previousLock = readPrivate(lock, 1024);
    if (previousLock !== undefined) {
      const previous = JSON.parse(previousLock);
      if (
        !Number.isSafeInteger(previous.pid) ||
        previous.pid < 1 ||
        !dead(previous.pid)
      )
        throw new EnvironmentSetupError(
          "Environment setup is already running. Wait for its result.",
          409,
        );
      if (readPrivate(lock, 1024) !== previousLock)
        throw new EnvironmentSetupError(
          "Environment setup changed. Retry shortly.",
          409,
        );
      unlinkSync(lock);
    }
    const fd = openSync(lock, "wx", 0o600);
    try {
      writeFileSync(fd, JSON.stringify({ pid: process.pid }));
    } finally {
      closeSync(fd);
    }
    try {
      save({});
    } catch (error) {
      unlinkSync(lock);
      throw error;
    }
    const task = Promise.resolve()
      .then(async () => {
        const sameSaved =
          verification.mode === "browser" &&
          verification.target.kind === "vercel"
            ? verification.target
            : undefined;
        if (
          !explicit &&
          !input.force &&
          options.environmentAccess.status(name).status === "passed"
        ) {
          save({
            status: "ready",
            step: "test_access",
            message: "Your test environment is ready.",
          });
          return;
        }
        if (!explicit && verification.mode === "browser" && !sameSaved) {
          stop(
            "This app already uses another test environment. Keep it, or explicitly choose a Vercel preview.",
            "choose_preview",
          );
          return;
        }
        let chosen = explicit ?? sameSaved;
        const matches = (project: VercelProject) =>
          resource(project.id) &&
          resource(project.name) &&
          project.matchesRepository &&
          project.repository?.toLowerCase() ===
            initialProject.config.repo.toLowerCase() &&
          project.provider === (initialProject.config.provider ?? "github");
        const newest = (
          inventory: VercelInventory,
          customEnvironmentId?: string,
        ) =>
          inventory.deployments
            .filter(
              (candidate) =>
                candidate.branch === branch &&
                candidate.environment !== "production" &&
                candidate.customEnvironmentId === customEnvironmentId,
            )
            .sort((a, b) => b.createdAt - a.createdAt)[0];
        const discover = async (
          connectionId: string,
          projectId?: string,
          teamId?: string | null,
        ) => {
          current();
          activeConnectionId = connectionId;
          const result = await options.vercelSetup.discover(name, {
            connectionId,
            ...(projectId ? { projectId } : {}),
            ...(teamId !== undefined ? { teamId } : {}),
          });
          current();
          if (
            result.status !== "discovered" ||
            result.stale ||
            !result.inventory
          )
            throw Error("discovery incomplete");
          return result.inventory;
        };
        const readyTarget = (
          inventory: VercelInventory,
          candidate: VercelCandidate | undefined,
        ) => {
          if (
            !inventory.selectedProject ||
            !matches(inventory.selectedProject) ||
            inventory.selectedProject.productionBranch === branch ||
            inventory.truncated ||
            !candidate?.selectable ||
            candidate.state !== "READY" ||
            !candidate.target
          )
            return undefined;
          const selected = target(publicTarget(candidate.target));
          if (
            selected.projectId !== inventory.selectedProject.id ||
            (selected.connectionId ?? "default") !== inventory.connectionId ||
            (selected.teamId ?? null) !== (inventory.teamId ?? null) ||
            selected.branch !== branch ||
            selected.customEnvironmentId !== candidate.customEnvironmentId
          )
            return undefined;
          return selected;
        };
        if (explicit && (!sameSaved || scope(explicit) !== scope(sameSaved))) {
          const inventory = await discover(
            explicit.connectionId ?? "default",
            explicit.projectId,
            explicit.teamId,
          );
          const candidate = newest(inventory, explicit.customEnvironmentId);
          const selectedTarget = readyTarget(inventory, candidate);
          if (
            !selectedTarget ||
            selectedTarget.projectId !== explicit.projectId
          ) {
            stop(
              "The selected project has no current ready preview for this app's inspection branch. Review its preview or prepare one with test data.",
              "choose_preview",
            );
            return;
          }
          chosen = {
            ...selectedTarget,
            ...(explicit.access ? { access: explicit.access } : {}),
            ...(explicit.bypassSecret
              ? { bypassSecret: explicit.bypassSecret }
              : {}),
          };
        } else if (!chosen) {
          const connections = [...new Set(await options.connectionIds())];
          current();
          if (!connections.length) {
            stop(
              "Connect Vercel so the gremlins can find this app's test preview.",
              "connect_vercel",
            );
            return;
          }
          if (
            connections.length > 8 ||
            connections.some((id) => !validConnectionId(id))
          ) {
            stop(
              "Choose the Vercel account for this app to narrow the search.",
              "choose_preview",
            );
            return;
          }
          const found: Array<{
            project: VercelProject;
            inventory: VercelInventory;
          }> = [];
          let incomplete = false;
          let discoveryFailure:
            | {
                connectionId: string;
                trusted?: NonNullable<ReturnType<typeof trustedVercelFailure>>;
              }
            | undefined;
          for (const connectionId of connections) {
            try {
              const inventory = await discover(connectionId);
              incomplete ||= inventory.truncated;
              for (const project of inventory.projects.filter(matches))
                if (
                  !found.some(
                    (row) =>
                      row.project.id === project.id &&
                      row.inventory.teamId === inventory.teamId,
                  )
                )
                  found.push({ project, inventory });
            } catch (error) {
              current();
              incomplete = true;
              const trusted = trustedVercelFailure(error);
              if (!discoveryFailure || (!discoveryFailure.trusted && trusted))
                discoveryFailure = { connectionId, trusted };
            }
          }
          const choices: EnvironmentSetupChoice[] = found
            .slice(0, 40)
            .map(({ project, inventory }) => ({
              connectionId: inventory.connectionId,
              ...(inventory.teamId !== undefined
                ? { teamId: inventory.teamId }
                : {}),
              projectId: project.id,
              name: project.name,
              ...(project.rootDirectory
                ? {
                    rootDirectory: project.rootDirectory
                      .replace(/[\p{Cc}\p{Cf}]/gu, "")
                      .slice(0, 300),
                  }
                : {}),
              branch,
            }));
          if (incomplete || found.length !== 1) {
            // Give a bounded ambiguous match a one-click, verified target choice.
            for (const choice of choices.slice(0, 8)) {
              try {
                const inventory = await discover(
                  choice.connectionId,
                  choice.projectId,
                  choice.teamId,
                );
                const selected = readyTarget(inventory, newest(inventory));
                if (selected && selected.projectId === choice.projectId)
                  choice.target = selected;
              } catch {
                current();
              }
            }
            stop(
              discoveryFailure?.trusted?.message ??
                (incomplete
                  ? "Some Vercel accounts could not be checked completely. Choose the correct project or reconnect the account."
                  : found.length
                    ? "More than one Vercel project matches this repository. Choose the app you want to test."
                    : "No connected Vercel project matches this repository. Choose an account or prepare a test preview."),
              discoveryFailure?.trusted?.action ??
                (discoveryFailure ? "connect_vercel" : "choose_preview"),
              choices,
              discoveryFailure?.connectionId,
            );
            return;
          }
          const only = choices[0]!,
            inventory = await discover(
              only.connectionId,
              only.projectId,
              only.teamId,
            ),
            candidate = newest(inventory);
          const selectedTarget = readyTarget(inventory, candidate);
          if (!selectedTarget || selectedTarget.projectId !== only.projectId) {
            stop(
              "This app has no current ready preview for its inspection branch. Prepare a preview with test data, then continue here.",
              "choose_preview",
              choices,
            );
            return;
          }
          chosen = selectedTarget;
        }
        if (!chosen) throw Error();
        activeConnectionId = chosen.connectionId ?? "default";
        // Preserve the saved app login when a provider-only choice has no new login fields.
        if (
          verification.mode === "browser" &&
          !Object.hasOwn(chosen, "access") &&
          verification.target.access
        )
          chosen = { ...chosen, access: verification.target.access };
        if (
          sameSaved &&
          scope(chosen) === scope(sameSaved) &&
          !Object.hasOwn(chosen, "bypassSecret") &&
          sameSaved.bypassSecret
        )
          chosen = { ...chosen, bypassSecret: sameSaved.bypassSecret };
        if (
          !sameSaved ||
          JSON.stringify(chosen) !== JSON.stringify(sameSaved)
        ) {
          save({
            step: "save_environment",
            message: "Saving the selected test environment…",
          });
          await options.configurationMutation(name, async () => {
            current();
            const file = document(name),
              raw = JSON.parse(file.content);
            const environments = object(raw.environments)
              ? raw.environments
              : {};
            let environment =
              verification.mode === "browser" && sameSaved
                ? verification.environment
                : "pm-test";
            if (!sameSaved && Object.hasOwn(environments, environment)) {
              let index = 2;
              while (Object.hasOwn(environments, `pm-test-${index}`)) index++;
              environment = `pm-test-${index}`;
            }
            raw.environments = { ...environments, [environment]: chosen };
            raw.verification = { mode: "browser", environment };
            raw.verified = null;
            saveEditableConfig(root, {
              path: file.path,
              revision: expected,
              content: JSON.stringify(raw, null, 2) + "\n",
            });
            const previousConfigurationRevision = expected;
            expected = document(name).revision;
            await options.recordConfigured?.(name, {
              previousConfigurationRevision,
              profile: "hosted",
            });
          });
          current();
        }
        const connect = async (repair = false) => {
          save({
            step: "connect_access",
            message: repair
              ? "Repairing preview access before one more check…"
              : "Connecting private preview access…",
          });
          await options.configurationMutation(name, async () => {
            current();
            const before = document(name),
              beforeRaw = JSON.parse(before.content);
            let failure: { error: unknown } | undefined;
            try {
              await options.vercelAccess.connect(name, {
                configurationRevision: expected,
                ...(repair ? { repair: true } : {}),
              });
            } catch (error) {
              failure = { error };
            }
            if (identity(name) !== instance)
              throw new EnvironmentSetupError(
                "The project changed during setup. Retry with the current project.",
                409,
              );
            const after = document(name),
              afterRaw = JSON.parse(after.content);
            // Access may change only the selected target's credential reference and verification stamp.
            const strip = (raw: Record<string, unknown>) => {
              delete raw.verified;
              const config = effectiveVerification(
                loadProject(root, name).config,
              );
              const selected =
                config.mode === "browser" && object(raw.environments)
                  ? raw.environments[config.environment]
                  : undefined;
              if (object(selected)) delete selected.bypassSecret;
              else if (object(raw.vercel)) delete raw.vercel.bypassSecret;
              return JSON.stringify(raw);
            };
            if (strip(beforeRaw) !== strip(afterRaw))
              throw new EnvironmentSetupError(
                "Project settings changed during setup. Retry with the current saved environment.",
                409,
              );
            expected = after.revision;
            if (before.revision !== after.revision)
              await options.recordConfigured?.(name, {
                previousConfigurationRevision: before.revision,
                profile: "hosted",
              });
            if (failure) throw failure.error;
          });
          current();
        };
        try {
          await connect();
        } catch (error) {
          // Only a confirmed, nonpending legacy receipt may defer to the local
          // verifier. Unknown provider metadata and incomplete mints stay blocked.
          if (
            !(error instanceof VercelSetupError) ||
            error.status !== 409 ||
            error.code !== "access_unconfirmed" ||
            error.recovery !== "verify_legacy_credential"
          )
            throw error;
        }
        for (let attempt = 0; attempt < 2; attempt++) {
          save({
            step: "test_access",
            message: attempt
              ? "Checking the repaired preview and app sign-in…"
              : "Opening the app and checking its saved test login…",
          });
          current();
          await options.environmentAccess.verify(name);
          await options.environmentAccess.idle();
          current();
          const result = options.environmentAccess.status(name);
          if (result.status === "passed") {
            const readyMessage = await options.verifyReadiness?.(name);
            if (readyMessage) expected = document(name).revision;
            save({
              status: "ready",
              message: readyMessage ?? "Your test environment is ready.",
              action: undefined,
              choices: undefined,
            });
            return;
          }
          const code = result.diagnosis?.code;
          if (
            attempt === 0 &&
            [
              "vercel_protection",
              "preview_credential_rejected",
              "preview_credential_missing",
            ].includes(code ?? "")
          ) {
            await connect(true);
            continue;
          }
          const action = result.diagnosis?.action;
          stop(
            action === "edit_login"
              ? "The preview opens, but the app login needs attention. Review the access check below."
              : action === "manage_credentials" ||
                  code === "preview_credential_rejected"
                ? "Update the saved test or preview credentials, then continue setup."
                : "The environment still needs attention. Review the access check below and retry when it is resolved.",
            action === "edit_login"
              ? "edit_login"
              : action === "manage_credentials" ||
                  code === "preview_credential_rejected"
                ? "manage_credentials"
                : "retry",
          );
          return;
        }
      })
      .catch((error) => {
        const trusted = trustedVercelFailure(error);
        const inUse = error instanceof LocalRunnerError && error.status === 409;
        const stale =
          error instanceof EnvironmentSetupError && error.status === 409;
        const action =
          trusted?.action ??
          (stale || inUse
            ? "retry"
            : state.step === "find_preview" || state.step === "connect_access"
              ? "connect_vercel"
              : "retry");
        save({
          status:
            trusted?.status ?? (stale || inUse ? "needs_input" : "failed"),
          action,
          connectionId:
            action === "connect_vercel" ? activeConnectionId : undefined,
          message:
            trusted?.message ??
            (inUse
              ? "Active or queued jobs are using these settings. Wait for them to finish, or cancel queued work, then retry environment setup."
              : stale
                ? "Project settings changed. Continue setup with the current saved settings."
                : state.step === "connect_access"
                  ? "Preview access could not be connected. Check the saved Vercel account and project access, then retry."
                  : "Environment setup could not finish. Check the current setup step and retry."),
          choices: undefined,
        });
      })
      .finally(() => {
        active.delete(operationKey);
        try {
          if (readPrivate(lock, 1024) === JSON.stringify({ pid: process.pid }))
            unlinkSync(lock);
        } catch {
          /* Preserve an unexpected lock replacement. */
        }
      });
    active.set(operationKey, task);
    return status(name)!;
  }
  return {
    prepare,
    status,
    busy,
    async idle() {
      await Promise.all(
        [...active]
          .filter(([name]) => name.startsWith(`${root}\0`))
          .map(([, task]) => task),
      );
    },
    async close() {
      closed = true;
      await this.idle();
    },
  };
}
