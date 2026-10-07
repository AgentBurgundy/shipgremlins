import { randomBytes } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { loadProject } from "../config.ts";
import type { OAuthCredential } from "../oauthConnection/types.ts";
import { effectiveVerification } from "../projectCapabilities.ts";
import { assertNoSymlinks } from "../setup/files.ts";
import { readConnections, saveConnections } from "../setup/connections.ts";
import {
  readEditableConfig,
  saveEditableConfig,
} from "../setup/configEditor.ts";
import { dead, digest, readPrivate, validProject } from "./store.ts";
import { projectSummary, record, resource } from "./provider.ts";
import { VercelSetupError, type VercelSetupOptions } from "./types.ts";

export interface VercelAccessResult {
  status: "connected" | "not_required";
  message: string;
}
type Journal = {
  schema: 1;
  scope: string;
  note: string;
  secretName: string;
  previousRevision: string;
  configurationRevision: string;
  state: "prepared" | "sent" | "connected" | "manual_required";
};
const active = new Map<
  string,
  {
    promise: Promise<VercelAccessResult>;
    controller: AbortController;
  }
>();
const revision = /^[a-f0-9]{64}$/;
const token = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= 8192 &&
  !/[\s"'`\\\p{Cc}\p{Cf}]/u.test(value);
const conflict = () =>
  new VercelSetupError(
    "Project settings changed. Refresh the saved preview before connecting Vercel access.",
    409,
    "stale",
  );
const ambiguous = () =>
  new VercelSetupError(
    "Vercel access creation may already have completed. Retry to recover its saved automation bypass; if it remains unavailable, check this project's Protection Bypass for Automation in Vercel. No additional secret will be created automatically.",
    409,
    "access_pending",
  );
const connected = (): VercelAccessResult => ({
  status: "connected",
  message:
    "Vercel preview access is connected. Deployment Protection remains enabled. Test access to verify this preview and its app sign-in.",
});
const manualAccessRequired = () =>
  new VercelSetupError(
    "Vercel requires a native integration to create automation bypasses. This connection can still discover projects and create test previews. Add a dedicated Protection Bypass for Automation secret in Connections, then test preview access.",
    400,
    "access_manual_required",
  );

async function nativeIntegrationRequired(response: Response): Promise<boolean> {
  // Match one provider refusal, never return or retain its body or diagnostics.
  const reader = response.body?.getReader();
  if (!reader) return false;
  try {
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.length;
      if (size > 16_384) return false;
      chunks.push(part.value);
    }
    const error = record(
      record(JSON.parse(Buffer.concat(chunks).toString("utf8"))).error,
    );
    return (
      error.code === "bad_request" &&
      error.message === "Only native integrations can create automation bypass."
    );
  } catch {
    return false;
  } finally {
    await reader.cancel().catch(() => {});
  }
}

function writeJournal(file: string, value: Journal) {
  assertNoSymlinks(file);
  const temporary = `${file}.${randomBytes(12).toString("hex")}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(temporary, "wx", 0o600);
    writeFileSync(fd, JSON.stringify(value));
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    assertNoSymlinks(file);
    renameSync(temporary, file);
    if (process.platform !== "win32") {
      const directory = openSync(dirname(file), "r");
      try {
        fsyncSync(directory);
      } finally {
        closeSync(directory);
      }
    }
  } finally {
    if (fd !== undefined) closeSync(fd);
    try {
      unlinkSync(temporary);
    } catch {
      /* Already renamed, or never created. */
    }
  }
}
function readJournal(file: string, scope: string): Journal | undefined {
  const raw = readPrivate(file, 8192);
  if (raw === undefined) return;
  const value = JSON.parse(raw) as Journal;
  if (
    value?.schema !== 1 ||
    value.scope !== scope ||
    Object.keys(value).sort().join() !==
      [
        "schema",
        "scope",
        "note",
        "secretName",
        "previousRevision",
        "configurationRevision",
        "state",
      ]
        .sort()
        .join() ||
    !/^ShipGremlins preview access [a-f0-9]{32}$/.test(value.note) ||
    value.secretName !== `VERCEL_BYPASS_${scope.toUpperCase()}` ||
    !revision.test(value.previousRevision) ||
    !revision.test(value.configurationRevision) ||
    !["prepared", "sent", "connected", "manual_required"].includes(value.state)
  )
    throw new Error();
  return value;
}
function ownSecret(
  data: Record<string, unknown>,
  journal: Journal,
  configurationId?: string,
): string | undefined {
  const matches = Object.entries(record(data.protectionBypass)).filter(
    ([, metadata]) => {
      const entry = record(metadata);
      return (
        (entry.scope === "automation-bypass" && entry.note === journal.note) ||
        (configurationId &&
          entry.scope === "integration-automation-bypass" &&
          entry.configurationId === configurationId &&
          resource(entry.integrationId))
      );
    },
  );
  if (matches.length > 1)
    throw new VercelSetupError(
      "More than one automation bypass matches this setup. Review this project's bypass entries in Vercel before retrying.",
      409,
      "ambiguous_access",
    );
  if (!matches.length) return;
  if (!token(matches[0]![0]))
    throw new VercelSetupError(
      "Vercel returned an unusable automation bypass. Review this project's protection settings before retrying.",
      502,
      "provider_response",
    );
  return matches[0]![0];
}

/** Only this action's nonsecret receipt is retained; provider responses are never stored. */
export function createVercelAccess(
  options: Pick<VercelSetupOptions, "root" | "vercelConnectionFor" | "fetch">,
) {
  const root = resolve(options.root),
    directory = join(root, ".run", "vercel-access"),
    fetcher = options.fetch ?? fetch;
  let closed = false;
  const key = (name: string) => `${root}\0${name}`;
  function lockBusy(name: string) {
    const raw = readPrivate(join(directory, `${name}.lock`), 1024);
    if (!raw) return false;
    const owner = JSON.parse(raw);
    if (
      !Number.isSafeInteger(owner.pid) ||
      owner.pid < 1 ||
      !/^[a-f0-9]{32}$/.test(owner.nonce)
    )
      throw new Error();
    return !dead(owner.pid);
  }
  function acquire(name: string) {
    const path = join(directory, `${name}.lock`);
    assertNoSymlinks(path);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const old = readPrivate(path, 1024);
    if (old && !lockBusy(name) && readPrivate(path, 1024) === old)
      unlinkSync(path);
    let fd: number;
    try {
      fd = openSync(path, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST")
        throw new VercelSetupError(
          "Vercel preview access is already being connected. Retry shortly.",
          409,
          "busy",
        );
      throw error;
    }
    const text = JSON.stringify({
      pid: process.pid,
      nonce: randomBytes(16).toString("hex"),
    });
    try {
      writeFileSync(fd, text);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    return () => {
      if (readPrivate(path, 1024) === text) unlinkSync(path);
    };
  }
  function snapshot(name: string) {
    validProject(name);
    const project = loadProject(root, name),
      file = readEditableConfig(root, `projects/${name}/project.json`),
      verification = effectiveVerification(project.config);
    if (
      verification.mode !== "browser" ||
      verification.target.kind !== "vercel" ||
      verification.target.role === "production"
    )
      throw new VercelSetupError(
        "Save a nonproduction Vercel browser environment before connecting preview access.",
        400,
        "preview_required",
      );
    return { project, file, verification, target: verification.target };
  }
  async function connect(
    name: string,
    input: { configurationRevision: string; repair?: boolean },
  ): Promise<VercelAccessResult> {
    if (
      !input ||
      typeof input !== "object" ||
      Array.isArray(input) ||
      Object.keys(input).some(
        (key) => !["configurationRevision", "repair"].includes(key),
      ) ||
      (input.repair !== undefined && typeof input.repair !== "boolean") ||
      !revision.test(input.configurationRevision)
    )
      throw new VercelSetupError(
        "Refresh and review the saved preview configuration before connecting access.",
        400,
      );
    validProject(name);
    if (closed)
      throw new VercelSetupError(
        "The controller is stopping. Retry after it restarts.",
        503,
      );
    if (active.has(key(name)))
      throw new VercelSetupError(
        "Vercel preview access is already being connected.",
        409,
        "busy",
      );
    const controller = new AbortController();
    const promise = Promise.resolve()
      .then(async (): Promise<VercelAccessResult> => {
        let unlock: (() => void) | undefined;
        try {
          unlock = acquire(name);
          const initial = snapshot(name),
            connectionId = initial.target.connectionId ?? "default";
          let guardedReference = initial.target.bypassSecret;
          let guardedValue = guardedReference
            ? readConnections(root)[guardedReference]
            : undefined;
          const signal = AbortSignal.any([
            controller.signal,
            AbortSignal.timeout(90_000),
          ]);
          const resolveCredential = async (): Promise<OAuthCredential> => {
            let abort: (() => void) | undefined;
            try {
              signal.throwIfAborted();
              return await Promise.race([
                options.vercelConnectionFor(connectionId).resolveCredential({
                  projectId: initial.target.projectId,
                  teamId: initial.target.teamId,
                  minValidityMs: 120_000,
                }),
                new Promise<never>((_, reject) => {
                  abort = () => reject(new Error());
                  signal.addEventListener("abort", abort, { once: true });
                  if (signal.aborted) abort();
                }),
              ]);
            } catch {
              throw new VercelSetupError(
                "Reconnect the selected Vercel account with access to this project and team.",
                401,
                "connection",
              );
            } finally {
              if (abort) signal.removeEventListener("abort", abort);
            }
          };
          const credential = await resolveCredential();
          signal.throwIfAborted();
          if (
            !token(credential.token) ||
            (initial.target.teamId !== undefined &&
              credential.teamId !== undefined &&
              initial.target.teamId !== credential.teamId)
          )
            throw new VercelSetupError(
              "The selected Vercel account does not match this preview's team. Reconnect the matching account.",
              403,
              "connection",
            );
          let teamId =
            initial.target.teamId === undefined
              ? credential.teamId
              : initial.target.teamId;
          const configurationId =
            credential.method === "oauth"
              ? credential.configurationId
              : undefined;
          if (
            credential.method === "oauth" &&
            (!configurationId || !resource(configurationId))
          )
            throw new VercelSetupError(
              "Reconnect the selected Vercel account so its installation can be identified before creating preview access.",
              401,
              "connection",
            );
          const api = async (method: "GET" | "PATCH", body?: unknown) => {
            const path =
              method === "GET"
                ? `/v9/projects/${encodeURIComponent(initial.target.projectId)}`
                : `/v1/projects/${encodeURIComponent(initial.target.projectId)}/protection-bypass`;
            const url = new URL(path, "https://api.vercel.com");
            if (teamId) url.searchParams.set("teamId", teamId);
            let response: Response;
            try {
              response = await fetcher(url, {
                method,
                redirect: "error",
                signal,
                headers: {
                  authorization: `Bearer ${credential.token}`,
                  ...(body ? { "content-type": "application/json" } : {}),
                },
                ...(body ? { body: JSON.stringify(body) } : {}),
              });
            } catch {
              throw new VercelSetupError(
                "Vercel did not confirm preview access. Retry to reconcile the existing setup before creating anything else.",
                502,
                "provider_response",
              );
            }
            if (!response.ok) {
              if (
                method === "PATCH" &&
                credential.method === "oauth" &&
                response.status === 400 &&
                (await nativeIntegrationRequired(response))
              )
                throw manualAccessRequired();
              await response.body?.cancel().catch(() => {});
              throw new VercelSetupError(
                [401, 403].includes(response.status)
                  ? "Vercel denied access to Deployment Protection settings. Reconnect the selected account with project administration access, or use an authorized Vercel token."
                  : response.status === 404
                    ? "The saved Vercel project is unavailable in this account and team. Review the selected preview."
                    : "Vercel could not complete preview access setup. Retry after checking this project's protection settings.",
                [400, 401, 403, 404, 422, 429].includes(response.status)
                  ? response.status
                  : 502,
                [400, 401, 403, 404, 422, 429].includes(response.status)
                  ? "provider_rejected"
                  : "provider_response",
              );
            }
            try {
              const reader = response.body?.getReader();
              if (!reader) throw new Error();
              const chunks: Uint8Array[] = [];
              let size = 0;
              try {
                for (;;) {
                  const part = await reader.read();
                  if (part.done) break;
                  size += part.value.length;
                  if (size > 1_048_576) throw new Error();
                  chunks.push(part.value);
                }
              } finally {
                await reader.cancel().catch(() => {});
              }
              const parsed: unknown = JSON.parse(
                Buffer.concat(chunks).toString("utf8"),
              );
              if (
                !parsed ||
                typeof parsed !== "object" ||
                Array.isArray(parsed)
              )
                throw new Error();
              return record(parsed);
            } catch {
              throw new VercelSetupError(
                "Vercel returned an unusable preview access response. Retry to reconcile the existing setup.",
                502,
                "provider_response",
              );
            }
          };
          const readProject = async () => {
            const data = await api("GET"),
              summary = projectSummary(data, initial.project.config);
            if (
              !summary?.matchesRepository ||
              summary.id !== initial.target.projectId ||
              (initial.target.customEnvironmentId &&
                !summary.customEnvironments.some(
                  (environment) =>
                    environment.id === initial.target.customEnvironmentId,
                )) ||
              !resource(data.accountId) ||
              (teamId && data.accountId !== teamId)
            )
              throw new VercelSetupError(
                "The saved preview does not match this repository, Vercel project, and account. Review the preview before connecting access.",
                409,
                "preview_mismatch",
              );
            // A token may omit its default team. The authenticated response for
            // this exact project and repository identifies its owner; never
            // infer a team from a project name or override an explicit team.
            if (!teamId && String(data.accountId).startsWith("team_"))
              teamId = String(data.accountId);
            return data;
          };
          const data = await readProject();
          const {
            bypassSecret: _bypass,
            access: _access,
            ...providerTarget
          } = initial.target;
          const scope = digest(
            JSON.stringify({
              project: name,
              instanceId: initial.project.config.instanceId ?? null,
              repo: initial.project.config.repo,
              provider: initial.project.config.provider ?? "github",
              server: initial.project.config.serverUrl ?? null,
              environment: initial.verification.environment,
              target: providerTarget,
              connectionId,
              configurationId: configurationId ?? null,
              teamId: teamId ?? null,
              accountId: data.accountId,
            }),
          );
          const file = join(directory, `${scope}.json`);
          let journal = readJournal(file, scope);
          // Older receipts included app-login fields in their scope. A reference
          // alone proves no ownership: migrate only a bypass returned by this
          // authenticated, repository-matched provider project.
          const referencedScope = /^VERCEL_BYPASS_([A-F0-9]{64})$/
            .exec(guardedReference ?? "")?.[1]
            ?.toLowerCase();
          const legacy =
            !journal && referencedScope && referencedScope !== scope
              ? readJournal(
                  join(directory, `${referencedScope}.json`),
                  referencedScope,
                )
              : undefined;
          const recoveredLegacy =
            legacy && ownSecret(data, legacy, configurationId)
              ? legacy
              : undefined;
          const checkCurrent = (expected: string) => {
            signal.throwIfAborted();
            const current = snapshot(name);
            if (
              current.file.revision !== expected ||
              current.project.config.instanceId !==
                initial.project.config.instanceId
            )
              throw conflict();
            if (
              guardedReference &&
              current.target.bypassSecret === guardedReference &&
              readConnections(root)[guardedReference] !== guardedValue
            )
              throw new VercelSetupError(
                "Preview credentials changed while access was being repaired. Test the newer credentials before retrying.",
                409,
                "credential_changed",
              );
            return current;
          };
          const checkConnection = async (expected: string) => {
            const current = await resolveCredential();
            checkCurrent(expected);
            if (
              current.method !== credential.method ||
              current.teamId !== credential.teamId ||
              (credential.method === "oauth"
                ? current.configurationId !== configurationId
                : current.token !== credential.token)
            )
              throw new VercelSetupError(
                "The selected Vercel connection changed. Refresh Connections before retrying preview access.",
                409,
                "connection_changed",
              );
          };
          if (
            initial.file.revision !== input.configurationRevision &&
            !(
              journal?.previousRevision === input.configurationRevision &&
              journal.configurationRevision === initial.file.revision &&
              initial.target.bypassSecret === journal.secretName
            )
          )
            throw conflict();
          checkCurrent(initial.file.revision);
          if (journal?.state === "manual_required") {
            // A user may fill the saved reference after this definite refusal.
            // Accept it only as unverified input for the normal browser test;
            // a failed test must return to the one-time access action, not mint.
            if (
              !input.repair &&
              initial.target.bypassSecret &&
              token(guardedValue)
            ) {
              await checkConnection(initial.file.revision);
              return connected();
            }
            throw manualAccessRequired();
          }
          if (legacy && !recoveredLegacy) {
            if (legacy.state === "sent") throw ambiguous();
            if (!input.repair && !token(guardedValue))
              throw new VercelSetupError(
                "The previous preview credential could not be reconciled. Test the saved environment before repairing its access.",
                409,
                "access_unconfirmed",
                data.protectionBypass &&
                  typeof data.protectionBypass === "object" &&
                  !Array.isArray(data.protectionBypass)
                  ? "verify_legacy_credential"
                  : undefined,
              );
          }
          const managed =
            (journal && initial.target.bypassSecret === journal.secretName) ||
            recoveredLegacy;
          // Reconcile our own bindings on every check. Owner-saved bindings
          // are replaced only through the controller's diagnosed repair path.
          if (
            !input.repair &&
            !managed &&
            initial.target.bypassSecret &&
            token(guardedValue)
          )
            return connected();
          if (
            // Optional/filtered provider metadata is unknown, not proof of public access.
            !initial.target.customEnvironmentId &&
            ["ssoProtection", "passwordProtection", "trustedIps"].every(
              (field) => data[field] === null,
            ) &&
            ["protectionConfig", "passport", "trustedSources"].every(
              (field) => data[field] == null,
            )
          )
            return {
              status: "not_required",
              message:
                "This Vercel project reports no Deployment Protection. Test access to check the preview and its app sign-in.",
            };
          const repairing =
            input.repair || managed || journal?.state === "connected";
          // A rejected/not-yet-sent operation can resume its exact saved intent.
          // Missing metadata still proves nothing about sent/completed work or
          // any existing credential that a repair might replace.
          const retryingPrepared =
            journal?.state === "prepared" &&
            initial.target.bypassSecret === journal.secretName &&
            !token(guardedValue);
          if (
            repairing &&
            !retryingPrepared &&
            (!data.protectionBypass ||
              typeof data.protectionBypass !== "object" ||
              Array.isArray(data.protectionBypass))
          )
            throw new VercelSetupError(
              "Vercel did not return enough bypass metadata to repair access safely. Check this account's project administration access, then retry.",
              409,
              "access_unconfirmed",
            );
          const raw = JSON.parse(initial.file.content);
          const secretName =
            journal?.secretName ?? `VERCEL_BYPASS_${scope.toUpperCase()}`;
          if (initial.project.config.verification?.mode === "browser")
            raw.environments[initial.verification.environment].bypassSecret =
              secretName;
          else raw.vercel.bypassSecret = secretName;
          raw.verified = null;
          const content =
            initial.target.bypassSecret === secretName
              ? initial.file.content
              : JSON.stringify(raw, null, 2) + "\n";
          journal = {
            schema: 1,
            scope,
            note:
              journal?.note ??
              recoveredLegacy?.note ??
              `ShipGremlins preview access ${randomBytes(16).toString("hex")}`,
            secretName,
            previousRevision:
              journal?.configurationRevision === initial.file.revision &&
              initial.target.bypassSecret === journal.secretName
                ? journal.previousRevision
                : initial.file.revision,
            configurationRevision: digest(content),
            state: journal?.state ?? recoveredLegacy?.state ?? "prepared",
          };
          // OAuth installations own their integration bypass. Reuse a unique match;
          // manual-token entries require this journal's unguessable note instead.
          let secret = ownSecret(data, journal, configurationId);
          if (repairing && !secret) {
            if (journal.state === "sent") throw ambiguous();
            if (journal.state === "connected")
              // A completed receipt whose entry is now absent can be replaced.
              // Persist a fresh operation note before sending exactly one mint.
              journal = {
                ...journal,
                note: `ShipGremlins preview access ${randomBytes(16).toString("hex")}`,
                state: "prepared",
              };
          }
          // Intent and the exact post-CAS revision survive a crash before secret storage.
          await checkConnection(initial.file.revision);
          writeJournal(file, journal);
          checkCurrent(initial.file.revision);
          if (content !== initial.file.content)
            saveEditableConfig(root, {
              path: initial.file.path,
              revision: initial.file.revision,
              content,
            });
          if (guardedReference !== secretName) {
            guardedReference = secretName;
            guardedValue = readConnections(root)[secretName];
          }
          const configuredRevision = journal.configurationRevision;
          checkCurrent(configuredRevision);
          if (!secret) {
            if (journal.state !== "prepared") throw ambiguous();
            await checkConnection(configuredRevision);
            journal.state = "sent";
            writeJournal(file, journal);
            checkCurrent(configuredRevision);
            let result: Record<string, unknown>;
            try {
              result = await api("PATCH", {
                generate: { note: journal.note },
              });
            } catch (error) {
              if (
                error instanceof VercelSetupError &&
                ["provider_rejected", "access_manual_required"].includes(
                  error.code,
                )
              ) {
                journal.state =
                  error.code === "access_manual_required"
                    ? "manual_required"
                    : "prepared";
                writeJournal(file, journal);
              }
              throw error;
            }
            secret = ownSecret(result, journal, configurationId);
            if (!secret)
              secret = ownSecret(await readProject(), journal, configurationId);
            if (!secret) throw ambiguous();
          }
          await checkConnection(configuredRevision);
          // Config must already allowlist this one reference. Never return the value.
          saveConnections(root, { [secretName]: secret });
          journal.state = "connected";
          writeJournal(file, journal);
          return connected();
        } catch (error) {
          if (error instanceof VercelSetupError) throw error;
          throw new VercelSetupError(
            "Vercel preview access could not be saved safely. Check Connections and configuration-directory permissions, then retry to recover the existing setup.",
            503,
            "access_storage",
          );
        } finally {
          try {
            unlock?.();
          } catch {
            /* Preserve an unsafe lock replacement. */
          }
        }
      })
      .finally(() => {
        active.delete(key(name));
      });
    active.set(key(name), { promise, controller });
    return promise;
  }
  return {
    connect,
    busy(name?: string) {
      try {
        if (name) {
          validProject(name);
          return active.has(key(name)) || lockBusy(name);
        }
        if ([...active.keys()].some((id) => id.startsWith(`${root}\0`)))
          return true;
        assertNoSymlinks(directory);
        return readdirSync(directory)
          .filter((file) => /^[a-z][a-z0-9-]{0,62}\.lock$/.test(file))
          .some((file) => lockBusy(file.slice(0, -5)));
      } catch (error) {
        return (error as NodeJS.ErrnoException).code !== "ENOENT";
      }
    },
    async close() {
      closed = true;
      const tasks = [...active.entries()].filter(([id]) =>
        id.startsWith(`${root}\0`),
      );
      for (const [, task] of tasks) task.controller.abort();
      await Promise.allSettled(tasks.map(([, task]) => task.promise));
    },
  };
}
