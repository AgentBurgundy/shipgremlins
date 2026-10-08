import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  readFileSync,
  mkdirSync,
  unlinkSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";
import { safeOAuthPath } from "../oauthConnection/storage.ts";
import { writePrivate } from "../remoteWorkers/storage.ts";
import type { DockerRun } from "./docker.ts";
import {
  parseTestAccess,
  resolveTestAccess,
  type TestAccess,
} from "../testAccess.ts";

export interface ManagedTestAccess {
  version: 1;
  identityId: string;
  generation: string;
  leaseGeneration: string;
  access: TestAccess;
}
export interface ManagedBrowserConnection {
  version: 1;
  endpoint: string;
  token: string;
  receipt: Record<string, unknown>;
}
const failureMessages: Record<string, string> = {
  invalid_access:
    "The saved login flow is invalid. Reconnect the test account in this project's Test access.",
  environment_unreachable:
    "The runner could not open the test app. Check its deployment and Docker network access in project setup.",
  external_redirect:
    "Sign-in left the selected app origin. This flow needs a supported SSO connection; the gremlin did not receive signed-in access.",
  selector_unusable:
    "A saved login step no longer matches the app. Review the detected login flow in Test access; your account is still saved.",
  credentials_rejected:
    "The app rejected sign-in. Reconnect the dedicated test account and check the app's allowed preview origins in Test access.",
  authentication_unproven:
    "Sign-in could not be proved. Review the login flow in Test access before relying on signed-in testing.",
  public_confirmation:
    "The saved signed-in marker also appears publicly. Review the detected login flow; authenticated access has not been proved.",
  identity_mismatch:
    "The signed-in account or workspace did not match the configured test identity. Review the account in Test access.",
  session_expired:
    "The test session expired during this run. Reconnect the test account in Test access; incomplete journeys remain unverified.",
  receiving_context_failed:
    "The PM browser did not receive the verified session. Check the selected runner and retry Test access.",
  helper_unavailable:
    "The private test browser became unavailable. Check the selected runner and retry Test access.",
  storage_redaction_limit:
    "The app's browser storage exceeded the private browser's redaction budget. Reduce cached data for the dedicated test account, then retry Test access. No browser content was shared with the gremlin.",
  browser_unavailable:
    "The runner could not start its private test browser. Check Docker and available memory, then retry Test access.",
  invalid_evidence:
    "The browser did not return matching access evidence. No signed-in readiness was recorded; retry Test access on a healthy runner.",
  login_unverified:
    "The runner could not finish verifying sign-in. Open this project's Test access to inspect the blocked step.",
  cleanup_pending:
    "Private browser cleanup is pending. The test account remains reserved until the runner confirms cleanup; check the agent service before retrying.",
  runner_lease_expired:
    "The runner lost contact while checking sign-in. Reconnect the agent service and retry Test access.",
};
export const managedAccessFailureMessage = (code: unknown) =>
  typeof code === "string" && Object.hasOwn(failureMessages, code)
    ? failureMessages[code]
    : undefined;
export class ManagedAccessError extends Error {
  constructor(
    public readonly code: string,
    message = managedAccessFailureMessage(code) ??
      "The test account could not sign in. Open this project's Test access to reconnect it; no PM was started.",
  ) {
    super(message);
    this.name = "ManagedAccessError";
  }
}
const managed = "io.shipgremlins.managed";
const jobLabel = "io.shipgremlins.job";
const accessLabel = "io.shipgremlins.access";
const identifier = /^[a-z0-9][a-z0-9-]{0,62}$/;
const opaque = /^[A-Za-z0-9_-]{1,128}$/;
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);

export function validateManagedTestAccess(value: unknown): ManagedTestAccess {
  if (
    !object(value) ||
    value.version !== 1 ||
    Object.keys(value).some(
      (k) =>
        ![
          "version",
          "identityId",
          "generation",
          "leaseGeneration",
          "access",
        ].includes(k),
    ) ||
    ![value.identityId, value.generation, value.leaseGeneration].every(
      (v) => typeof v === "string" && opaque.test(v),
    )
  )
    throw new Error("Invalid managed test access.");
  const access = parseTestAccess(value.access);
  if (!access || (access.kind === "password" && access.accounts.length !== 1))
    throw new Error("Each browser run requires one allocated test identity.");
  return {
    version: 1,
    identityId: value.identityId as string,
    generation: value.generation as string,
    leaseGeneration: value.leaseGeneration as string,
    access,
  };
}
export function validateManagedBrowserConnection(
  value: unknown,
): ManagedBrowserConnection {
  if (
    !object(value) ||
    value.version !== 1 ||
    Object.keys(value).some(
      (k) => !["version", "endpoint", "token", "receipt"].includes(k),
    ) ||
    typeof value.endpoint !== "string" ||
    typeof value.token !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.token) ||
    !object(value.receipt)
  )
    throw new Error("Invalid managed browser connection.");
  const url = new URL(value.endpoint);
  if (
    url.protocol !== "http:" ||
    !/^gremlins-auth-[a-z0-9-]+$/.test(url.hostname) ||
    url.port !== "4719" ||
    url.pathname !== "/mcp" ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  )
    throw new Error("Invalid private browser endpoint.");
  return value as unknown as ManagedBrowserConnection;
}

/** Browser and agent have no shared filesystem. Only the restricted, per-run gateway crosses this boundary. */
export function createManagedBrowsers(run: DockerRun, namespace: string) {
  const scope = createHash("sha256")
    .update(namespace)
    .digest("hex")
    .slice(0, 12);
  const directory = safeOAuthPath(join(namespace, ".run", "managed-browsers"));
  const manifestPath = (id: string) => {
    if (!identifier.test(id)) throw new Error("Invalid browser job.");
    return safeOAuthPath(join(directory, `${id}.json`));
  };
  const pendingPath = (id: string) =>
    safeOAuthPath(manifestPath(id).replace(/\.json$/, ".pending"));
  function manifest(id: string):
    | {
        token: string;
        controlToken: string;
        network: string;
        connection: ManagedBrowserConnection;
      }
    | undefined {
    const path = manifestPath(id);
    if (!existsSync(path)) return undefined;
    const bytes = readFileSync(path);
    if (bytes.length > 16384)
      throw new Error("Private browser metadata is invalid.");
    const value = JSON.parse(bytes.toString());
    if (
      !object(value) ||
      !/^[a-f0-9]{64}$/.test(String(value.controlToken)) ||
      typeof value.network !== "string" ||
      !/^[a-zA-Z0-9_.-]{1,128}$/.test(value.network)
    )
      throw new Error("Private browser metadata is invalid.");
    const connection = validateManagedBrowserConnection(value.connection);
    return {
      token: connection.token,
      controlToken: String(value.controlToken),
      network: value.network,
      connection,
    };
  }
  const running = new Map<string, Promise<unknown>>();
  const name = (id: string) => {
    if (!identifier.test(id)) throw new Error("Invalid browser job.");
    return `gremlins-auth-${id}`;
  };
  const networkName = (id: string) => `gremlins-access-${scope}-${id}`;
  async function inspect(id: string) {
    const result = await run(["inspect", "--format", "{{json .}}", name(id)], {
      timeoutMs: 10000,
      maxBytes: 65536,
    });
    if (result.code !== 0) {
      if (/No such (?:object|container)/i.test(result.stderr)) return undefined;
      throw new Error("Private browser availability could not be checked.");
    }
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(result.stdout);
    } catch {
      throw new Error("Private browser ownership could not be checked.");
    }
    const config = object(data.Config) ? data.Config : {},
      labels = object(config.Labels) ? config.Labels : {};
    if (
      labels[managed] !== "true" ||
      labels[jobLabel] !== id ||
      labels[accessLabel] !== scope
    )
      throw new Error("Refusing to access an unowned browser helper.");
    return data;
  }
  async function removeNetwork(id: string) {
    const target = networkName(id);
    const result = await run(
      ["network", "inspect", "--format", "{{json .Labels}}", target],
      { timeoutMs: 10000, maxBytes: 4096 },
    );
    if (result.code !== 0) {
      if (/not found|No such network/i.test(result.stderr)) return;
      throw new Error("Private browser network could not be checked.");
    }
    let labels;
    try {
      labels = JSON.parse(result.stdout);
    } catch {
      throw new Error("Browser network ownership could not be checked.");
    }
    if (
      labels?.[managed] !== "true" ||
      labels?.[jobLabel] !== id ||
      labels?.[accessLabel] !== scope
    )
      throw new Error("Refusing to remove an unowned browser network.");
    const removed = await run(["network", "rm", target], {
      timeoutMs: 15000,
      maxBytes: 4096,
    });
    if (removed.code !== 0)
      throw new Error("Private browser network cleanup is pending.");
  }
  async function cleanup(id: string, removeOwnNetwork = true) {
    if (await inspect(id)) {
      const removed = await run(["rm", "--force", name(id)], {
        timeoutMs: 20000,
        maxBytes: 4096,
      });
      if (removed.code !== 0)
        throw new Error(
          "Private browser cleanup is pending; the account remains reserved.",
        );
    }
    if (removeOwnNetwork) await removeNetwork(id);
    const path = manifestPath(id);
    if (existsSync(path)) unlinkSync(path);
    const pending = pendingPath(id);
    if (existsSync(pending)) unlinkSync(pending);
  }
  async function status(
    id: string,
    token: string,
    path = "/ready",
    ttlMs?: number,
  ) {
    const result = await run(
      [
        "exec",
        "--interactive",
        name(id),
        "node",
        "/opt/gremlins/access-status.mjs",
      ],
      {
        stdin: JSON.stringify({
          endpoint: "http://127.0.0.1:4719",
          token,
          path,
          ...(ttlMs === undefined ? {} : { ttlMs }),
        }),
        timeoutMs: 15000,
        maxBytes: 4 * 1024 * 1024,
      },
    );
    if (result.code !== 0) return undefined;
    try {
      const parsed = JSON.parse(result.stdout);
      return object(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  }
  return {
    cleanup,
    manifest,
    requiresCleanup: (id: string) =>
      existsSync(manifestPath(id)) || existsSync(pendingPath(id)),
    async reconcile(active: string[]) {
      const result = await run([
        "ps",
        "--all",
        "--filter",
        `label=${accessLabel}=${scope}`,
        "--format",
        `{{.Label "${jobLabel}"}}`,
      ]);
      if (result.code !== 0)
        throw new Error("Private browsers could not be reconciled.");
      const candidates = new Set(
        result.stdout
          .trim()
          .split(/\r?\n/)
          .filter((id) => identifier.test(id)),
      );
      if (existsSync(directory))
        for (const file of readdirSync(directory)) {
          const id = file.replace(/\.(json|pending)$/, "");
          if (id !== file && identifier.test(id)) candidates.add(id);
        }
      return [...candidates].filter((id) => !active.includes(id));
    },
    async start(input: {
      id: string;
      image: string;
      url: string;
      metadata: ManagedTestAccess;
      credentials: Record<string, string>;
      network?: string;
      maxRuntimeMs: number;
      leaseTtlMs?: number;
      leaseDeadline?: () => number;
      probeOnly?: boolean;
    }) {
      const metadata = validateManagedTestAccess(input.metadata),
        container = name(input.id),
        token = randomBytes(32).toString("hex"),
        controlToken = randomBytes(32).toString("hex");
      if (!/^shipgremlins-local:[a-f0-9]{16}$/.test(input.image))
        throw new Error("Invalid browser runtime image.");
      if (await inspect(input.id))
        throw new ManagedAccessError(
          "cleanup_pending",
          "The previous private browser must be reconciled before this account can run again.",
        );
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      writePrivate(
        pendingPath(input.id),
        JSON.stringify({ version: 1, id: input.id }),
      );
      const network = input.network ?? networkName(input.id);
      if (!input.network) {
        // A previous interrupted operation can leave a network, but never adopt an unowned one.
        await removeNetwork(input.id);
        const created = await run([
          "network",
          "create",
          "--label",
          `${managed}=true`,
          "--label",
          `${jobLabel}=${input.id}`,
          "--label",
          `${accessLabel}=${scope}`,
          network,
        ]);
        if (created.code !== 0)
          throw new ManagedAccessError("browser_unavailable");
      }
      try {
        const created = await run([
          "create",
          "--interactive",
          "--name",
          container,
          "--label",
          `${managed}=true`,
          "--label",
          `${jobLabel}=${input.id}`,
          "--label",
          `${accessLabel}=${scope}`,
          "--network",
          network,
          "--add-host",
          "host.docker.internal:host-gateway",
          "--restart=no",
          "--init",
          "--read-only",
          "--user",
          "1000:1000",
          "--cap-drop=ALL",
          "--security-opt=no-new-privileges",
          "--memory=1g",
          "--cpus=1",
          "--pids-limit=256",
          "--shm-size=256m",
          "--tmpfs",
          "/tmp:rw,nosuid,nodev,mode=1777,size=268435456",
          "--tmpfs",
          "/work:rw,nosuid,nodev,uid=1000,gid=1000,mode=0700,size=67108864",
          "--entrypoint",
          "node",
          input.image,
          "/opt/gremlins/access-helper.mjs",
        ]);
        if (created.code !== 0)
          throw new ManagedAccessError("browser_unavailable");
        const credentialValues: Record<string, string | undefined> = {
          ...input.credentials,
        };
        if (metadata.access.kind === "password") {
          credentialValues[metadata.access.accounts[0]!.usernameSecret] =
            input.credentials.GREMLINS_TEST_USERNAME_1;
          credentialValues[metadata.access.accounts[0]!.passwordSecret] =
            input.credentials.GREMLINS_TEST_PASSWORD_1;
        }
        const access = resolveTestAccess(metadata.access, credentialValues);
        const task = run(["start", "--attach", "--interactive", container], {
          stdin: JSON.stringify({
            version: 1,
            url: input.url,
            access,
            bypass: input.credentials.GREMLINS_PREVIEW_BYPASS ?? "",
            identityId: metadata.identityId,
            generation: metadata.generation,
            leaseGeneration: metadata.leaseGeneration,
            token,
            controlToken,
            maxRuntimeMs: input.maxRuntimeMs,
            ...(input.leaseTtlMs === undefined
              ? {}
              : { leaseTtlMs: input.leaseTtlMs }),
            ...(input.probeOnly ? { probeOnly: true } : {}),
          }),
          timeoutMs: input.maxRuntimeMs + 30000,
          maxBytes: 65536,
        }).catch(() => undefined);
        running.set(input.id, task);
        void task.finally(() => {
          if (running.get(input.id) === task) running.delete(input.id);
        });
        const deadline = Date.now() + Math.min(input.maxRuntimeMs, 180000);
        let renewedAt = Date.now();
        while (Date.now() < deadline) {
          if (input.leaseDeadline && Date.now() - renewedAt >= 15000) {
            const ttlMs = Math.min(120000, input.leaseDeadline() - Date.now());
            if (ttlMs < 1000)
              throw new ManagedAccessError(
                "runner_lease_expired",
                "The runner lost contact while checking sign-in. Reconnect the runner and try again.",
              );
            const renewed = await status(
              input.id,
              controlToken,
              "/lease",
              ttlMs,
            );
            if (!renewed?.ok)
              throw new ManagedAccessError("runner_lease_expired");
            renewedAt = Date.now();
          }
          const result = await status(input.id, token);
          if (result?.status === "failed") {
            const failure = object(result.failure) ? result.failure : {};
            const code =
              typeof failure.code === "string" &&
              /^[a-z_]{1,64}$/.test(failure.code)
                ? failure.code
                : "login_unverified";
            throw new ManagedAccessError(code);
          }
          if (
            result?.status === "ready" &&
            result.ok === true &&
            object(result.receipt)
          ) {
            const receipt = result.receipt;
            if (
              receipt.identityId !== metadata.identityId ||
              receipt.generation !== metadata.generation ||
              receipt.leaseGeneration !== metadata.leaseGeneration ||
              receipt.origin !== new URL(input.url).origin ||
              !object(receipt.proof) ||
              receipt.proof.receivingContext !== true ||
              (metadata.access.kind === "public" &&
                receipt.proof.public !== true) ||
              (metadata.access.kind === "password" &&
                (receipt.proof.signedOut !== true ||
                  receipt.proof.signedIn !== true ||
                  receipt.proof.protectedRoute !== true))
            )
              throw new ManagedAccessError("invalid_evidence");
            const connection = {
              version: 1 as const,
              endpoint: `http://${container}:4719/mcp`,
              token,
              receipt,
            };
            mkdirSync(directory, { recursive: true, mode: 0o700 });
            writePrivate(
              manifestPath(input.id),
              JSON.stringify({ connection, controlToken, network }),
            );
            return { network, connection, checks: result.checks };
          }
          if (!running.has(input.id))
            throw new ManagedAccessError("browser_unavailable");
          await new Promise((resolve) => setTimeout(resolve, 300));
        }
        throw new ManagedAccessError("login_unverified");
      } catch (error) {
        try {
          await cleanup(input.id);
        } catch {
          throw new ManagedAccessError("cleanup_pending");
        }
        throw error;
      }
    },
    async refreshLease(id: string, ttlMs: number) {
      const value = manifest(id);
      if (!value || !(await inspect(id))) return;
      if (!Number.isInteger(ttlMs) || ttlMs < 1000 || ttlMs > 120000)
        throw new Error("Invalid private browser lease.");
      const result = await status(id, value.controlToken, "/lease", ttlMs);
      if (!result?.ok)
        throw new Error("Private browser lease could not be renewed.");
    },
  };
}
