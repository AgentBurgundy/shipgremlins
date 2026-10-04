import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { isIP } from "node:net";
import { readConnections } from "../setup/connections.ts";
import {
  createOAuthStore,
  validToken,
  type OAuthState,
  type SavedConnection,
} from "./storage.ts";
import {
  OAuthConnectionError,
  type OAuthConnection,
  type OAuthProvider,
  type OAuthStatus,
  type OAuthCredential,
  type CredentialRequest,
} from "./types.ts";
export * from "./types.ts";

export const OAUTH_BROKER = "https://shipgremlins.ai";
const TTL = 10 * 60_000;
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown, maximum = 200): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= maximum &&
  ![...value].some(
    (character) =>
      character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
  );
const identifier = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9_-]{1,200}$/.test(value);
function dashboardUrl(value: string): string {
  try {
    const url = new URL(value);
    if (
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    )
      throw new Error();
    if (url.protocol === "https:") return url.href;
    if (url.protocol !== "http:") throw new Error();
    if (["localhost", "[::1]"].includes(url.hostname)) return url.href;
    if (isIP(url.hostname) !== 4) throw new Error();
    const [a = -1, b = -1] = url.hostname.split(".").map(Number);
    if (
      a === 127 ||
      a === 10 ||
      (a === 192 && b === 168) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 100 && b >= 64 && b <= 127)
    )
      return url.href;
  } catch {
    /* Only local HTTP or explicit HTTPS dashboard addresses are allowed. */
  }
  throw new OAuthConnectionError(
    "Use your dashboard's local or HTTPS address.",
  );
}
export function sealOAuthEnvelope(
  provider: OAuthProvider,
  value: unknown,
  key: Buffer,
): string {
  const iv = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(`shipgremlins-${provider}-v1`));
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(value)),
    cipher.final(),
  ]);
  return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString(
    "base64url",
  );
}
function openEnvelope(
  provider: OAuthProvider,
  value: string,
  key: string,
): unknown {
  if (!/^[A-Za-z0-9_-]{40,32000}$/.test(value)) throw new Error();
  const bytes = Buffer.from(value, "base64url"),
    decipher = createDecipheriv(
      "aes-256-gcm",
      Buffer.from(key, "base64url"),
      bytes.subarray(0, 12),
    );
  decipher.setAAD(Buffer.from(`shipgremlins-${provider}-v1`));
  decipher.setAuthTag(bytes.subarray(12, 28));
  return JSON.parse(
    Buffer.concat([
      decipher.update(bytes.subarray(28)),
      decipher.final(),
    ]).toString("utf8"),
  );
}
export interface ConnectionOptions {
  root: string;
  session?: string;
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  now?: () => number;
}

export function createOAuthConnection(
  provider: OAuthProvider,
  options: ConnectionOptions,
): OAuthConnection {
  const store = createOAuthStore(options.root, provider),
    now = options.now ?? Date.now,
    fetcher = options.fetch ?? fetch;
  const env = options.env ?? process.env;
  const sessionHash = createHash("sha256")
    .update(options.session ?? "controller")
    .digest("hex");
  const label = provider === "linear" ? "Linear" : "Vercel";
  const manualKey = provider === "linear" ? "LINEAR_API_KEY" : "VERCEL_TOKEN";
  const callback = `${OAUTH_BROKER}/api/${provider}/callback`;
  let availability: { value: boolean; checked: number } | undefined;
  async function request(
    url: string,
    init: RequestInit = {},
    timeout = 12_000,
  ) {
    try {
      const response = await fetcher(url, {
        ...init,
        redirect: "error",
        signal: AbortSignal.timeout(timeout),
      });
      const reader = response.body?.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      if (reader)
        for (;;) {
          const item = await reader.read();
          if (item.done) break;
          size += item.value.length;
          if (size > 1024 * 1024) {
            await reader.cancel();
            throw new Error();
          }
          chunks.push(item.value);
        }
      const raw = Buffer.concat(chunks).toString("utf8");
      return {
        status: response.status,
        data: raw ? (JSON.parse(raw) as unknown) : null,
      };
    } catch {
      throw new OAuthConnectionError(
        `${label} could not be reached. Try again shortly.`,
        "provider_unavailable",
        503,
      );
    }
  }
  async function available() {
    if (availability && availability.checked > now() - 5 * 60_000)
      return availability.value;
    let value = false;
    try {
      const result = await request(
        `${OAUTH_BROKER}/api/${provider}/status`,
        {},
        3_000,
      );
      value =
        result.status === 200 &&
        object(result.data) &&
        result.data.available === true;
    } catch {
      /* Saved tokens and advanced API keys keep working without the setup broker. */
    }
    availability = { value, checked: now() };
    return value;
  }
  function manual() {
    const value = env[manualKey] ?? readConnections(options.root)[manualKey];
    return validToken(value) ? value : undefined;
  }
  function publicStatus(
    connection: SavedConnection | undefined,
    enabled: boolean,
  ): OAuthStatus {
    const fallback = !connection && !!manual();
    const needsReconnect =
      !!connection?.needsReconnect ||
      !!(
        connection?.expiresAt &&
        connection.expiresAt <= now() &&
        !connection.refreshToken
      );
    return {
      provider,
      available: enabled,
      connected: connection ? !needsReconnect : fallback,
      method: connection ? "oauth" : fallback ? "token" : "none",
      ...(connection
        ? {
            workspace: {
              id: connection.workspace.id,
              name: connection.workspace.name,
            },
            account: {
              id: connection.account.id,
              name: connection.account.name,
            },
            ...(connection.expiresAt
              ? { expiresAt: new Date(connection.expiresAt).toISOString() }
              : {}),
            ...(needsReconnect ? { needsReconnect: true } : {}),
          }
        : {}),
      ...(needsReconnect
        ? {
            message: `Reconnect ${label} to restore access. Your manual token is not used while an OAuth connection is saved.`,
          }
        : fallback
          ? { message: "Using the manually configured API token." }
          : !enabled
            ? {
                message: `${label} OAuth setup is temporarily unavailable. A manually configured API token still works.`,
              }
            : {}),
    };
  }
  function busy(connection: SavedConnection | undefined) {
    return !!connection?.leases.some((lease) => lease.expiresAt > now());
  }
  function requireIdle(connection: SavedConnection | undefined) {
    if (busy(connection))
      throw new OAuthConnectionError(
        `Wait for active jobs to finish before changing or refreshing ${label}.`,
        "refresh_blocked",
        409,
      );
  }
  function applyLinearTokens(connection: SavedConnection, data: unknown) {
    if (
      !object(data) ||
      !validToken(data.access_token) ||
      !validToken(data.refresh_token) ||
      typeof data.expires_in !== "number" ||
      !Number.isFinite(data.expires_in) ||
      data.expires_in < 60 ||
      data.expires_in > 31 * 24 * 3600 ||
      (typeof data.token_type === "string" &&
        data.token_type.toLowerCase() !== "bearer")
    )
      throw new OAuthConnectionError(
        "Linear returned invalid credentials. Connect again.",
        "invalid_response",
        502,
      );
    const scopes = Array.isArray(data.scope)
      ? data.scope
      : typeof data.scope === "string"
        ? data.scope.split(/[ ,]+/)
        : data.scope === undefined
          ? connection.scopes
          : undefined;
    if (
      !scopes?.includes("read") ||
      !scopes.includes("write") ||
      scopes.some((scope) => typeof scope !== "string")
    )
      throw new OAuthConnectionError(
        "Authorize Linear read and write access so ShipGremlins can manage teams, projects, and tickets.",
        "scope_required",
        403,
      );
    connection.accessToken = data.access_token;
    connection.refreshToken = data.refresh_token;
    connection.expiresAt = now() + data.expires_in * 1000;
    connection.scopes = scopes;
    delete connection.refreshStartedAt;
    delete connection.needsReconnect;
    delete connection.verifiedAt;
  }
  async function linearToken(values: Record<string, string>) {
    return request("https://api.linear.app/oauth/token", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: new URLSearchParams(values).toString(),
    });
  }
  async function verifyLinear(connection: SavedConnection) {
    const identity = await request("https://api.linear.app/graphql", {
      method: "POST",
      headers: {
        authorization: `Bearer ${connection.accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        query:
          "query ShipGremlinsConnection { viewer { id name } organization { id name } }",
      }),
    });
    const user =
      object(identity.data) && object(identity.data.data)
        ? identity.data.data.viewer
        : null;
    const workspace =
      object(identity.data) && object(identity.data.data)
        ? identity.data.data.organization
        : null;
    if ([401, 403].includes(identity.status))
      throw new OAuthConnectionError(
        "Linear access was revoked or denied. Connect again.",
        "reconnect_required",
        401,
      );
    if (
      identity.status !== 200 ||
      !object(user) ||
      !identifier(user.id) ||
      !text(user.name) ||
      !object(workspace) ||
      !identifier(workspace.id) ||
      !text(workspace.name)
    )
      throw new OAuthConnectionError(
        "The Linear workspace could not be verified. Retry shortly.",
        "identity_failed",
        503,
      );
    if (connection.workspace.id && connection.workspace.id !== workspace.id)
      throw new OAuthConnectionError(
        "The Linear workspace changed. Connect again.",
        "reconnect_required",
        401,
      );
    connection.account = { id: user.id, name: user.name };
    connection.workspace = { id: workspace.id, name: workspace.name };
    connection.verifiedAt = now();
  }
  async function refresh(
    state: OAuthState,
    save: (state: OAuthState) => Promise<void>,
    minimum: number,
  ) {
    const connection = state.connection!;
    if (connection.needsReconnect)
      throw new OAuthConnectionError(
        `Reconnect ${label} to restore access.`,
        "reconnect_required",
        401,
      );
    if (
      !connection.expiresAt ||
      (!connection.refreshStartedAt && connection.expiresAt - now() >= minimum)
    )
      return;
    requireIdle(connection);
    if (
      provider !== "linear" ||
      !connection.refreshToken ||
      !connection.clientId ||
      (connection.refreshStartedAt &&
        now() - connection.refreshStartedAt > 29 * 60_000)
    ) {
      connection.needsReconnect = true;
      await save(state);
      throw new OAuthConnectionError(
        `Reconnect ${label} to renew access.`,
        "reconnect_required",
        401,
      );
    }
    // Linear explicitly allows retrying this rotating refresh token for 30 minutes.
    connection.refreshStartedAt ??= now();
    await save(state);
    const response = await linearToken({
      grant_type: "refresh_token",
      client_id: connection.clientId,
      refresh_token: connection.refreshToken,
    });
    if (response.status !== 200) {
      if ([400, 401, 403].includes(response.status)) {
        connection.needsReconnect = true;
        await save(state);
        throw new OAuthConnectionError(
          "Linear access was revoked or expired. Connect again.",
          "reconnect_required",
          401,
        );
      }
      throw new OAuthConnectionError(
        "Linear could not renew access. Retry shortly.",
        "provider_unavailable",
        503,
      );
    }
    try {
      applyLinearTokens(connection, response.data);
    } catch (error) {
      connection.needsReconnect = true;
      await save(state);
      throw error;
    }
    await save(state);
  }
  async function vercelRequest(connection: SavedConnection, path: string) {
    const url = new URL(`https://api.vercel.com${path}`);
    if (connection.teamId) url.searchParams.set("teamId", connection.teamId);
    const response = await request(url.href, {
      headers: { authorization: `Bearer ${connection.accessToken}` },
    });
    if (
      response.status === 401 ||
      (response.status === 403 &&
        object(response.data) &&
        object(response.data.error) &&
        response.data.error.code === "integration_configuration_disabled")
    )
      throw new OAuthConnectionError(
        "The Vercel installation is disabled or revoked. Connect again.",
        "reconnect_required",
        401,
      );
    if (response.status !== 200)
      throw new OAuthConnectionError(
        "Vercel access was denied. Select this project in the integration and check its permissions.",
        "project_forbidden",
        403,
      );
    return response.data;
  }
  async function checkProject(
    connection: SavedConnection,
    input: CredentialRequest,
  ) {
    if (provider !== "vercel") return;
    if (input.teamId != null && input.teamId !== (connection.teamId ?? null))
      throw new OAuthConnectionError(
        "This Vercel connection belongs to a different account or team. Connect the matching Vercel team.",
        "team_mismatch",
        403,
      );
    if (input.projectId !== undefined) {
      if (!identifier(input.projectId))
        throw new OAuthConnectionError("Invalid Vercel project identifier.");
      const data = await vercelRequest(
        connection,
        `/v9/projects/${encodeURIComponent(input.projectId)}`,
      );
      if (
        !object(data) ||
        !identifier(data.id) ||
        (data.id !== input.projectId && data.name !== input.projectId)
      )
        throw new OAuthConnectionError(
          "Vercel did not return the selected project.",
          "project_forbidden",
          403,
        );
    }
  }
  async function credential(
    input: CredentialRequest = {},
    jobId?: string,
    minutes?: number,
  ): Promise<OAuthCredential> {
    if (jobId && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(jobId))
      throw new OAuthConnectionError("Invalid job identifier.");
    const minimum = jobId
      ? Math.max(50, Math.min(60, minutes ?? 50)) * 60_000
      : (input.minValidityMs ?? 5 * 60_000);
    if (!Number.isFinite(minimum) || minimum < 0 || minimum > 60 * 60_000)
      throw new OAuthConnectionError("Invalid credential validity window.");
    return store.locked(async (state, save) => {
      if (!state.connection) {
        const value = manual();
        if (!value)
          throw new OAuthConnectionError(
            `Connect ${label} in the dashboard first.`,
            "not_connected",
            400,
          );
        return {
          token: value,
          authorization: provider === "linear" ? value : `Bearer ${value}`,
          method: "token",
        };
      }
      const connection = state.connection;
      connection.leases = connection.leases.filter(
        (lease) => lease.expiresAt > now(),
      );
      try {
        await refresh(state, save, minimum);
        if (
          provider === "linear" &&
          (!connection.verifiedAt || connection.verifiedAt < now() - 5 * 60_000)
        ) {
          await verifyLinear(connection);
          await save(state);
        }
        await checkProject(connection, input);
        if (connection.expiresAt && connection.expiresAt - now() < minimum) {
          await refresh(state, save, minimum);
          if (connection.expiresAt - now() < minimum)
            throw new OAuthConnectionError(
              `${label} did not issue credentials valid for the whole job. Retry shortly.`,
              "refresh_blocked",
              409,
            );
        }
      } catch (error) {
        if (
          error instanceof OAuthConnectionError &&
          error.code === "reconnect_required"
        ) {
          connection.needsReconnect = true;
          await save(state);
        }
        throw error;
      }
      if (jobId) {
        connection.leases = connection.leases.filter(
          (lease) => lease.jobId !== jobId,
        );
        connection.leases.push({ jobId, expiresAt: now() + minimum });
        await save(state);
      }
      return {
        token: connection.accessToken,
        authorization: `Bearer ${connection.accessToken}`,
        method: "oauth",
        ...(connection.expiresAt
          ? { expiresAt: new Date(connection.expiresAt).toISOString() }
          : {}),
        ...(provider === "vercel" ? { teamId: connection.teamId ?? null } : {}),
      };
    });
  }
  const api: OAuthConnection = {
    async status(options) {
      return publicStatus(
        (await store.read()).connection,
        options?.checkAvailability === false
          ? (availability?.value ?? false)
          : await available(),
      );
    },
    async connect(returnUrl) {
      const target = dashboardUrl(returnUrl);
      return store.locked(async (state, save) => {
        requireIdle(state.connection);
        const key = randomBytes(32).toString("base64url"),
          nonce = randomBytes(24).toString("base64url"),
          verifier = randomBytes(48).toString("base64url");
        const response = await request(
          `${OAUTH_BROKER}/api/${provider}/connect`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              key,
              nonce,
              returnUrl: target,
              ...(provider === "linear"
                ? {
                    codeChallenge: createHash("sha256")
                      .update(verifier)
                      .digest("base64url"),
                  }
                : {}),
            }),
          },
        );
        const data = response.data;
        if (response.status !== 200 || !object(data) || !text(data.url, 8000))
          throw new OAuthConnectionError(
            `${label} OAuth setup is not available. Try again shortly or use an API token.`,
            "app_unavailable",
            503,
          );
        let url: URL;
        try {
          url = new URL(data.url);
        } catch {
          throw new OAuthConnectionError(
            "Invalid OAuth setup response.",
            "invalid_response",
            502,
          );
        }
        if (
          url.origin !== OAUTH_BROKER ||
          url.pathname !== `/api/${provider}/authorize` ||
          url.username ||
          url.password ||
          url.hash ||
          (data.redirectUri !== undefined && data.redirectUri !== callback) ||
          (provider === "linear" && !identifier(data.clientId))
        )
          throw new OAuthConnectionError(
            "The OAuth setup response could not be verified.",
            "invalid_response",
            502,
          );
        state.pending = {
          key,
          nonce,
          sessionHash,
          expiresAt: now() + TTL,
          redirectUri: callback,
          ...(provider === "linear"
            ? { verifier, clientId: data.clientId as string }
            : {}),
        };
        await save(state);
        availability = { value: true, checked: now() };
        return { url: url.href };
      });
    },
    async complete(envelope) {
      return store.locked(async (state, save) => {
        const pending = state.pending;
        if (
          !pending ||
          pending.expiresAt <= now() ||
          pending.sessionHash !== sessionHash
        )
          throw new OAuthConnectionError(
            `This ${label} setup link expired or belongs to another dashboard session. Connect again.`,
            "invalid_session",
            403,
          );
        requireIdle(state.connection);
        let data: unknown;
        try {
          data = openEnvelope(provider, envelope, pending.key);
        } catch {
          throw new OAuthConnectionError(
            `${label} setup could not be verified. Connect again.`,
            "invalid_envelope",
            400,
          );
        }
        if (
          !object(data) ||
          data.nonce !== pending.nonce ||
          typeof data.expires !== "number" ||
          data.expires < now() ||
          data.expires > now() + TTL
        )
          throw new OAuthConnectionError(
            `${label} setup could not be verified. Connect again.`,
            "invalid_envelope",
            400,
          );
        if (data.error) {
          delete state.pending;
          await save(state);
          throw new OAuthConnectionError(
            `${label} setup was canceled. Your existing connection is unchanged.`,
            "access_denied",
            400,
          );
        }
        let connection: SavedConnection = {
          accessToken: "",
          workspace: { id: "", name: "" },
          account: { id: "", name: "" },
          leases: [],
          // OAuth2 may omit scope when it equals the fixed authorization request.
          ...(provider === "linear" ? { scopes: ["read", "write"] } : {}),
        };
        if (provider === "linear") {
          if (!validToken(data.code) || !pending.verifier || !pending.clientId)
            throw new OAuthConnectionError(
              "Linear returned an invalid authorization code.",
              "invalid_response",
              502,
            );
          if (pending.received) {
            connection = pending.received;
          } else {
            if (pending.exchanging)
              throw new OAuthConnectionError(
                "This Linear authorization was already exchanged. Connect again.",
                "code_used",
                400,
              );
            pending.exchanging = true;
            await save(state);
            const response = await linearToken({
              grant_type: "authorization_code",
              client_id: pending.clientId,
              redirect_uri: pending.redirectUri,
              code_verifier: pending.verifier,
              code: data.code,
            });
            if (response.status !== 200)
              throw new OAuthConnectionError(
                "Linear could not finish authorization. Connect again.",
                "authorization_failed",
                400,
              );
            applyLinearTokens(connection, response.data);
            connection.clientId = pending.clientId;
            // A transient identity lookup must not consume the one-use code twice.
            pending.received = connection;
            await save(state);
          }
          await verifyLinear(connection);
        } else {
          const saved = data.connection;
          if (
            !object(saved) ||
            !validToken(saved.accessToken) ||
            !identifier(saved.userId) ||
            !identifier(saved.configurationId) ||
            !(saved.teamId === null || identifier(saved.teamId))
          )
            throw new OAuthConnectionError(
              "Vercel returned invalid installation credentials.",
              "invalid_response",
              502,
            );
          connection.accessToken = saved.accessToken;
          connection.teamId = saved.teamId;
          connection.configurationId = saved.configurationId;
          const identity = await vercelRequest(
            connection,
            saved.teamId
              ? `/v2/teams/${encodeURIComponent(saved.teamId)}`
              : "/v2/user",
          );
          const entity = saved.teamId
            ? identity
            : object(identity)
              ? identity.user
              : null;
          if (
            !object(entity) ||
            entity.id !== (saved.teamId ?? saved.userId) ||
            !text(entity.name ?? entity.slug ?? entity.username)
          )
            throw new OAuthConnectionError(
              "The Vercel account could not be verified.",
              "identity_failed",
              403,
            );
          connection.workspace = {
            id: entity.id as string,
            name: (entity.name ?? entity.slug ?? entity.username) as string,
          };
          connection.account = { id: saved.userId, name: "Integration member" };
          // A successful projects read verifies that this is an integration credential.
          const projects = await vercelRequest(
            connection,
            "/v9/projects?limit=1",
          );
          if (!object(projects) || !Array.isArray(projects.projects))
            throw new OAuthConnectionError(
              "Vercel project read access could not be verified.",
              "scope_required",
              403,
            );
        }
        state.connection = connection;
        delete state.pending;
        await save(state);
        return publicStatus(connection, true);
      });
    },
    async disconnect() {
      return store.locked(async (state, save) => {
        requireIdle(state.connection);
        // Removing this machine's credentials must not uninstall other machines' integration.
        delete state.connection;
        delete state.pending;
        await save(state);
        return publicStatus(undefined, availability?.value ?? false);
      });
    },
    resolveCredential: (input) => credential(input),
    acquireLease: (input) => credential(input, input.jobId, input.minutes),
    async releaseLease(jobId) {
      if (!(await store.read()).connection) return;
      await store.locked(async (state, save) => {
        if (!state.connection) return;
        const filtered = state.connection.leases.filter(
          (lease) => lease.jobId !== jobId && lease.expiresAt > now(),
        );
        if (filtered.length === state.connection.leases.length) return;
        state.connection.leases = filtered;
        await save(state);
      });
    },
  };
  return api;
}
