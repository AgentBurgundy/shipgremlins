import { createHash, randomBytes } from "node:crypto";
import { SOURCE_APPS } from "./apps.ts";
import {
  createSourceStore,
  type SavedConnection,
  type SourceState,
} from "./store.ts";
import { readConnections } from "../setup/connections.ts";
import { validSourceRepository, validSourceServer } from "../config.ts";
import {
  SourceControlError,
  type SourceControl,
  type SourceTarget,
  type SourceProvider,
  type SourceStatus,
  type SourceRepository,
  type SourceCredential,
} from "./types.ts";
export * from "./types.ts";

const defaults = { github: "https://github.com", gitlab: "https://gitlab.com" };
const MAX_REPOSITORIES = 2000;
const token = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= 16384 &&
  !/[\s\0]/.test(value);
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const number = (value: unknown, min: number, max: number): value is number =>
  typeof value === "number" &&
  Number.isFinite(value) &&
  value >= min &&
  value <= max;
const requiredString = (value: unknown, max = 200): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= max;
function target(input: SourceTarget) {
  if (!input || !["github", "gitlab"].includes(input.provider))
    throw new SourceControlError("Choose GitHub or GitLab.");
  const serverUrl = input.serverUrl ?? defaults[input.provider];
  if (
    !validSourceServer(serverUrl) ||
    (input.provider === "github" &&
      new URL(serverUrl).origin !== defaults.github)
  )
    throw new SourceControlError(
      "Use the provider HTTPS origin. GitHub.com and GitLab HTTPS instances are supported.",
    );
  return { provider: input.provider, serverUrl: new URL(serverUrl).origin };
}
const key = (input: { provider: SourceProvider; serverUrl: string }) =>
  `${input.provider}:${input.serverUrl}`;
function cleanText(value: unknown, max = 200): string {
  return typeof value === "string"
    ? [...value]
        .filter(
          (character) =>
            character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127,
        )
        .join("")
        .slice(0, max)
    : "";
}

export function createSourceControl(options: {
  root: string;
  session?: string;
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  now?: () => number;
}): SourceControl {
  const store = createSourceStore(options.root),
    fetcher = options.fetch ?? fetch,
    now = options.now ?? Date.now,
    env = options.env ?? process.env;
  const sessionHash = createHash("sha256")
    .update(options.session ?? "controller")
    .digest("hex");
  const clientId = (input: { provider: SourceProvider; serverUrl: string }) =>
    input.serverUrl === defaults[input.provider]
      ? (env[
          input.provider === "github"
            ? "SHIPGREMLINS_GITHUB_CLIENT_ID"
            : "SHIPGREMLINS_GITLAB_CLIENT_ID"
        ] ?? SOURCE_APPS[input.provider].clientId)
      : "";
  const installationUrl = () => SOURCE_APPS.github.installationUrl;
  const manual = (provider: SourceProvider) => {
    const name = provider === "github" ? "GITHUB_TOKEN" : "GITLAB_TOKEN";
    return env[name] ?? readConnections(options.root)[name];
  };
  function statusOf(
    input: { provider: SourceProvider; serverUrl: string },
    connection?: SavedConnection,
  ): SourceStatus {
    const pat = connection ? undefined : manual(input.provider);
    const connected = Boolean(
      connection &&
      !connection.needsReconnect &&
      !connection.refreshing &&
      (connection.expiresAt === undefined ||
        connection.expiresAt > now() ||
        (connection.refreshToken &&
          (!connection.refreshExpiresAt ||
            connection.refreshExpiresAt > now()))),
    );
    return {
      provider: input.provider,
      serverUrl: input.serverUrl,
      available: Boolean(connection?.clientId || clientId(input)),
      connected: connection
        ? connected
        : Boolean(pat) && input.provider !== "gitlab",
      method: connection ? "oauth" : pat ? "token" : "none",
      ...(connection
        ? {
            account: connection.account,
            ...(connection.expiresAt
              ? { expiresAt: new Date(connection.expiresAt).toISOString() }
              : {}),
            ...(!connected
              ? {
                  needsReconnect: true,
                  message:
                    "Reconnect this source account to continue. Existing manual tokens were not substituted.",
                }
              : {}),
          }
        : {}),
      ...(input.provider === "github"
        ? { installationUrl: installationUrl() }
        : {}),
      ...(!connection && !pat && !clientId(input)
        ? {
            message:
              "The official provider app is not configured yet. An existing personal token can still be used.",
          }
        : {}),
      ...(!connection && pat && input.provider === "gitlab"
        ? {
            message:
              "A manual GitLab token is available for explicitly configured project servers. Connect OAuth to browse GitLab.com repositories.",
          }
        : {}),
    };
  }
  async function request(
    url: string,
    options: RequestInit = {},
  ): Promise<{ status: number; data: unknown; headers: Headers }> {
    let response: Response;
    try {
      response = await fetcher(url, {
        ...options,
        redirect: "error",
        signal: AbortSignal.timeout(12000),
      });
    } catch {
      throw new SourceControlError(
        "The source provider could not be reached. Check the connection and retry.",
        "network_error",
        503,
      );
    }
    const source = await response.text();
    if (Buffer.byteLength(source) > 1024 * 1024)
      throw new SourceControlError(
        "The source provider returned too much data.",
        "invalid_response",
        502,
      );
    let data: unknown;
    try {
      data = JSON.parse(source);
    } catch {
      throw new SourceControlError(
        "The source provider returned an invalid response.",
        "invalid_response",
        502,
      );
    }
    return { status: response.status, data, headers: response.headers };
  }
  const oauth = (
    input: { provider: SourceProvider; serverUrl: string },
    fields: Record<string, string>,
  ) =>
    request(
      input.serverUrl +
        (input.provider === "github"
          ? "/login/oauth/access_token"
          : "/oauth/token"),
      {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams(fields).toString(),
      },
    );
  async function providerApi(
    input: { provider: SourceProvider; serverUrl: string },
    accessToken: string,
    path: string,
  ) {
    const base =
      input.provider === "github"
        ? "https://api.github.com"
        : input.serverUrl + "/api/v4";
    const response = await request(base + path, {
      headers: {
        accept: "application/json",
        authorization: `Bearer ${accessToken}`,
        ...(input.provider === "github"
          ? { "x-github-api-version": "2022-11-28" }
          : {}),
      },
    });
    if (response.status === 401)
      throw new SourceControlError(
        "This source authorization was revoked or expired. Reconnect the account.",
        "reconnect_required",
        401,
      );
    if (response.status === 403 || response.status === 429)
      throw new SourceControlError(
        "The source provider denied access or reached its rate limit. Check app repository access and retry.",
        "provider_denied",
        response.status,
      );
    if (response.status < 200 || response.status >= 300)
      throw new SourceControlError(
        "The selected repository is unavailable to this source connection.",
        "repository_unavailable",
        response.status,
      );
    return response;
  }
  function applyTokens(connection: SavedConnection, data: unknown) {
    if (
      !object(data) ||
      !token(data.access_token) ||
      (data.token_type !== undefined &&
        String(data.token_type).toLowerCase() !== "bearer")
    )
      throw new SourceControlError(
        "The provider did not return a valid access token.",
        "invalid_response",
        502,
      );
    connection.accessToken = data.access_token;
    if (data.expires_in !== undefined) {
      if (!number(data.expires_in, 60, 365 * 86400))
        throw new SourceControlError(
          "The provider returned an invalid token lifetime.",
          "invalid_response",
          502,
        );
      connection.expiresAt = now() + data.expires_in * 1000;
    } else delete connection.expiresAt;
    if (data.refresh_token !== undefined) {
      if (!token(data.refresh_token))
        throw new SourceControlError(
          "The provider returned an invalid refresh token.",
          "invalid_response",
          502,
        );
      connection.refreshToken = data.refresh_token;
    }
    if (data.refresh_token_expires_in !== undefined) {
      if (!number(data.refresh_token_expires_in, 60, 2 * 365 * 86400))
        throw new SourceControlError(
          "The provider returned an invalid refresh lifetime.",
          "invalid_response",
          502,
        );
      connection.refreshExpiresAt =
        now() + data.refresh_token_expires_in * 1000;
    }
    delete connection.needsReconnect;
    delete connection.refreshing;
  }
  async function refreshed(
    state: SourceState,
    connection: SavedConnection,
    save: (state: SourceState) => Promise<void>,
    minimum: number,
  ): Promise<void> {
    connection.leases = connection.leases.filter(
      (lease) => lease.expiresAt > now(),
    );
    if (connection.needsReconnect || connection.refreshing)
      throw new SourceControlError(
        "Reconnect this source account before launching another job.",
        "reconnect_required",
        401,
      );
    if (
      connection.expiresAt === undefined ||
      connection.expiresAt >= now() + minimum
    )
      return;
    if (connection.leases.length)
      throw new SourceControlError(
        "Waiting for active jobs to finish before renewing source access. The queued job will retry automatically.",
        "refresh_blocked",
        409,
      );
    if (
      !connection.refreshToken ||
      (connection.refreshExpiresAt && connection.refreshExpiresAt <= now())
    )
      throw new SourceControlError(
        "Source access cannot be renewed. Reconnect this account.",
        "reconnect_required",
        401,
      );
    connection.refreshing = true;
    await save(state);
    try {
      const result = await oauth(connection, {
        client_id: connection.clientId,
        grant_type: "refresh_token",
        refresh_token: connection.refreshToken,
      });
      if (result.status !== 200 || !object(result.data) || result.data.error)
        throw new Error();
      applyTokens(connection, result.data);
      await save(state);
    } catch {
      connection.needsReconnect = true;
      delete connection.refreshing;
      await save(state);
      throw new SourceControlError(
        "Source access could not be renewed safely. Reconnect the account; existing tokens were not substituted.",
        "reconnect_required",
        401,
      );
    }
    if (
      connection.expiresAt !== undefined &&
      connection.expiresAt < now() + minimum
    )
      throw new SourceControlError(
        "The provider token lifetime is shorter than the job safety window.",
        "token_lifetime",
        409,
      );
  }
  function repo(
    input: { provider: SourceProvider; serverUrl: string },
    value: unknown,
    installationId?: string,
  ): SourceRepository {
    if (!object(value))
      throw new SourceControlError(
        "The provider returned invalid repository information.",
        "invalid_response",
        502,
      );
    const fullName =
      input.provider === "github" ? value.full_name : value.path_with_namespace;
    if (
      !validSourceRepository(fullName, input.provider) ||
      !number(value.id, 1, Number.MAX_SAFE_INTEGER)
    )
      throw new SourceControlError(
        "The provider returned invalid repository information.",
        "invalid_response",
        502,
      );
    const permissions = object(value.permissions) ? value.permissions : {};
    const gitlabPush = [
      permissions.project_access,
      permissions.group_access,
    ].some((access) => object(access) && Number(access.access_level) >= 30);
    return {
      provider: input.provider,
      serverUrl: input.serverUrl,
      id: String(value.id),
      fullName,
      defaultBranch: cleanText(value.default_branch) || "main",
      private:
        input.provider === "github"
          ? value.private === true
          : value.visibility !== "public",
      webUrl: `${input.serverUrl}/${fullName}`,
      canPush:
        input.provider === "github" ? permissions.push === true : gitlabPush,
      ...(installationId ? { installationId } : {}),
    };
  }
  async function checkRepository(
    connection: SavedConnection,
    repository: string,
    write = false,
  ) {
    if (!validSourceRepository(repository, connection.provider))
      throw new SourceControlError("Use a valid owner/repository path.");
    const response = await providerApi(
      connection,
      connection.accessToken,
      connection.provider === "github"
        ? `/repos/${repository}`
        : `/projects/${encodeURIComponent(repository)}`,
    );
    const found = repo(connection, response.data);
    if (
      found.fullName.toLowerCase() !== repository.toLowerCase() ||
      (connection.repositoryId && found.id !== connection.repositoryId)
    )
      throw new SourceControlError(
        "The selected repository does not match this source authorization.",
        "repository_unavailable",
        403,
      );
    if (write && !found.canPush)
      throw new SourceControlError(
        "The connected account cannot write to this repository.",
        "repository_readonly",
        403,
      );
    if (connection.provider === "github") {
      let requests = 0;
      const started = now();
      for (let page = 1; page <= 20; page++) {
        if (++requests > 25 || now() - started > 15000) break;
        const data = (
          await providerApi(
            connection,
            connection.accessToken,
            `/user/installations?per_page=100&page=${page}`,
          )
        ).data;
        if (!object(data) || !Array.isArray(data.installations))
          throw new SourceControlError(
            "GitHub returned invalid installation membership.",
            "invalid_response",
            502,
          );
        for (const installation of data.installations) {
          if (
            !object(installation) ||
            !number(installation.id, 1, Number.MAX_SAFE_INTEGER)
          )
            continue;
          const account = object(installation.account)
            ? installation.account
            : {};
          if (
            typeof account.login === "string" &&
            account.login.toLowerCase() !==
              repository.split("/")[0]!.toLowerCase()
          )
            continue;
          for (let repoPage = 1; repoPage <= 20; repoPage++) {
            if (++requests > 25 || now() - started > 15000) break;
            const listed = (
              await providerApi(
                connection,
                connection.accessToken,
                `/user/installations/${installation.id}/repositories?per_page=100&page=${repoPage}`,
              )
            ).data;
            if (!object(listed) || !Array.isArray(listed.repositories))
              throw new SourceControlError(
                "GitHub returned invalid installation repositories.",
                "invalid_response",
                502,
              );
            if (
              listed.repositories.some(
                (value) =>
                  object(value) &&
                  String(value.id) === found.id &&
                  String(value.full_name).toLowerCase() ===
                    found.fullName.toLowerCase(),
              )
            ) {
              const permissions = object(installation.permissions)
                ? installation.permissions
                : {};
              if (
                write &&
                (permissions.contents !== "write" ||
                  permissions.pull_requests !== "write")
              )
                throw new SourceControlError(
                  "The GitHub App needs Contents and Pull requests write access for coding jobs.",
                  "repository_readonly",
                  403,
                );
              return found;
            }
            if (listed.repositories.length < 100) break;
          }
        }
        if (data.installations.length < 100) break;
      }
      throw new SourceControlError(
        "Select this repository in the ShipGremlins GitHub App installation before using it.",
        "repository_not_installed",
        403,
      );
    }
    return found;
  }
  async function credential(
    input: SourceTarget & {
      repository: string;
      minValidityMs?: number;
      jobId?: string;
      minutes?: number;
      write?: boolean;
    },
  ): Promise<SourceCredential> {
    const destination = target(input);
    if (!validSourceRepository(input.repository, destination.provider))
      throw new SourceControlError("Use a valid owner/repository path.");
    const minimum = input.jobId
      ? Math.max(50, Math.min(60, input.minutes ?? 50)) * 60000
      : Math.max(60000, Math.min(60 * 60000, input.minValidityMs ?? 5 * 60000));
    if (input.jobId && !/^job-[a-z0-9-]{1,100}$/.test(input.jobId))
      throw new SourceControlError("Invalid job identifier.");
    return store.locked(async (state, save) => {
      const connection = state.connections[key(destination)];
      if (!connection) {
        const pat = manual(destination.provider);
        if (!pat || !token(pat))
          throw new SourceControlError(
            "Connect this source provider before running a job.",
            "not_connected",
            401,
          );
        return { token: pat, method: "token" };
      }
      await refreshed(state, connection, save, minimum);
      try {
        await checkRepository(connection, input.repository, input.write);
        // Provider pagination can consume the last seconds of the safety window.
        if (
          connection.expiresAt !== undefined &&
          connection.expiresAt < now() + minimum
        ) {
          await refreshed(state, connection, save, minimum);
          await checkRepository(connection, input.repository, input.write);
          if (connection.expiresAt < now() + minimum)
            throw new SourceControlError(
              "Source access needs renewal before this job can start.",
              "refresh_blocked",
              409,
            );
        }
      } catch (error) {
        if (
          error instanceof SourceControlError &&
          error.code === "reconnect_required"
        ) {
          connection.needsReconnect = true;
          await save(state);
        }
        throw error;
      }
      if (input.jobId) {
        connection.leases = connection.leases.filter(
          (lease) => lease.jobId !== input.jobId,
        );
        connection.leases.push({
          jobId: input.jobId,
          expiresAt: now() + minimum,
        });
        await save(state);
      }
      return {
        token: connection.accessToken,
        method: "oauth",
        ...(connection.expiresAt
          ? { expiresAt: new Date(connection.expiresAt).toISOString() }
          : {}),
      };
    });
  }
  const api: SourceControl = {
    async status() {
      const state = await store.read();
      const destinations = new Map(
        Object.entries(defaults).map(([provider, serverUrl]) => {
          const dest = { provider: provider as SourceProvider, serverUrl };
          return [key(dest), dest];
        }),
      );
      for (const saved of Object.values(state.connections))
        destinations.set(key(saved), saved);
      return [...destinations.values()].map((dest) =>
        statusOf(dest, state.connections[key(dest)]),
      );
    },
    async connect(input) {
      const destination = target(input);
      const id = input.clientId ?? clientId(destination);
      if (!/^[A-Za-z0-9._-]{6,200}$/.test(id))
        throw new SourceControlError(
          "The official provider app is not configured. Set its public client ID first.",
          "app_unavailable",
          503,
        );
      if (
        input.repositoryId !== undefined &&
        !/^[1-9][0-9]{0,18}$/.test(input.repositoryId)
      )
        throw new SourceControlError("Invalid repository identifier.");
      return store.locked(async (state, save) => {
        if (
          state.connections[key(destination)]?.leases.some(
            (lease) => lease.expiresAt > now(),
          )
        )
          throw new SourceControlError(
            "Wait for active jobs to finish before replacing this source connection.",
            "refresh_blocked",
            409,
          );
        const endpoint =
          destination.serverUrl +
          (destination.provider === "github"
            ? "/login/device/code"
            : "/oauth/authorize_device");
        const result = await request(endpoint, {
          method: "POST",
          headers: {
            accept: "application/json",
            "content-type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({
            client_id: id,
            ...(destination.provider === "gitlab"
              ? { scope: "api write_repository" }
              : {}),
          }).toString(),
        });
        const data = result.data;
        if (
          result.status < 200 ||
          result.status >= 300 ||
          !object(data) ||
          data.error
        )
          throw new SourceControlError(
            destination.provider === "gitlab"
              ? "GitLab device authorization is unavailable. Use a public OAuth app on GitLab17.9+ or the advanced token connection."
              : "GitHub device authorization is unavailable. Enable device flow in the GitHub App.",
            "device_unavailable",
            503,
          );
        if (
          !token(data.device_code) ||
          !requiredString(data.user_code, 64) ||
          !requiredString(data.verification_uri, 512) ||
          !number(data.expires_in, 30, 3600) ||
          !number(data.interval ?? 5, 1, 60)
        )
          throw new SourceControlError(
            "The provider returned invalid device authorization details.",
            "invalid_response",
            502,
          );
        const verification = new URL(data.verification_uri);
        if (
          verification.origin !== destination.serverUrl ||
          verification.username ||
          verification.password ||
          verification.hash ||
          verification.pathname !==
            (destination.provider === "github"
              ? "/login/device"
              : "/oauth/device")
        )
          throw new SourceControlError(
            "The provider returned an unexpected verification address.",
            "invalid_response",
            502,
          );
        const flow = {
          id: randomBytes(24).toString("hex"),
          provider: destination.provider,
          userCode: data.user_code,
          verificationUri: verification.href,
          expiresAt: new Date(now() + data.expires_in * 1000).toISOString(),
          intervalSeconds: Number(data.interval ?? 5),
          ...(destination.provider === "github"
            ? { installationUrl: installationUrl() }
            : {}),
        };
        for (const [pendingId, pending] of Object.entries(state.pending))
          if (
            pending.flow.provider === destination.provider ||
            Date.parse(pending.flow.expiresAt) < now()
          )
            delete state.pending[pendingId];
        state.pending[flow.id] = {
          flow,
          deviceCode: data.device_code,
          clientId: id,
          serverUrl: destination.serverUrl,
          sessionHash,
          nextPollAt: now() + flow.intervalSeconds * 1000,
          ...(input.repositoryId ? { repositoryId: input.repositoryId } : {}),
        };
        await save(state);
        return flow;
      });
    },
    async poll(id) {
      if (!/^[a-f0-9]{48}$/.test(id))
        throw new SourceControlError(
          "Invalid source authorization identifier.",
        );
      return store.locked(async (state, save) => {
        const pending = state.pending[id];
        if (!pending || pending.sessionHash !== sessionHash)
          throw new SourceControlError(
            "This authorization belongs to another dashboard session. Start Connect again.",
            "invalid_session",
            403,
          );
        if (Date.parse(pending.flow.expiresAt) <= now()) {
          delete state.pending[id];
          await save(state);
          return { status: "expired" };
        }
        if (now() < pending.nextPollAt)
          return {
            status: "pending",
            retryAfterSeconds: Math.ceil((pending.nextPollAt - now()) / 1000),
          };
        const destination = {
          provider: pending.flow.provider,
          serverUrl: pending.serverUrl,
        };
        if (
          state.connections[key(destination)]?.leases.some(
            (lease) => lease.expiresAt > now(),
          )
        )
          throw new SourceControlError(
            "Wait for active jobs to finish before replacing this source connection.",
            "refresh_blocked",
            409,
          );
        // Persist poll scheduling before the HTTP request so separate processes honor it.
        pending.nextPollAt = now() + pending.flow.intervalSeconds * 1000;
        await save(state);
        const response = await oauth(destination, {
          client_id: pending.clientId,
          device_code: pending.deviceCode,
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          ...(pending.repositoryId
            ? { repository_id: pending.repositoryId }
            : {}),
        });
        const data = response.data;
        if (object(data) && data.error) {
          if (data.error === "authorization_pending")
            return {
              status: "pending",
              retryAfterSeconds: pending.flow.intervalSeconds,
            };
          if (data.error === "slow_down") {
            pending.flow.intervalSeconds = Math.min(
              120,
              pending.flow.intervalSeconds + 5,
            );
            pending.nextPollAt = now() + pending.flow.intervalSeconds * 1000;
            await save(state);
            return {
              status: "pending",
              retryAfterSeconds: pending.flow.intervalSeconds,
            };
          }
          delete state.pending[id];
          await save(state);
          if (["expired_token", "token_expired"].includes(String(data.error)))
            return { status: "expired" };
          if (data.error === "access_denied") return { status: "denied" };
          throw new SourceControlError(
            "The source provider could not finish authorization. Start Connect again.",
            "authorization_failed",
            400,
          );
        }
        if (response.status !== 200)
          throw new SourceControlError(
            "The source provider could not finish authorization.",
            "authorization_failed",
            400,
          );
        const connection: SavedConnection = {
          ...destination,
          clientId: pending.clientId,
          accessToken: "",
          account: { id: "", login: "" },
          leases: [],
          ...(pending.repositoryId
            ? { repositoryId: pending.repositoryId }
            : {}),
        };
        applyTokens(connection, data);
        const user = (
          await providerApi(destination, connection.accessToken, "/user")
        ).data;
        if (
          !object(user) ||
          !number(user.id, 1, Number.MAX_SAFE_INTEGER) ||
          !requiredString(
            destination.provider === "github" ? user.login : user.username,
          )
        )
          throw new SourceControlError(
            "The provider account could not be verified.",
            "invalid_response",
            502,
          );
        connection.account = {
          id: String(user.id),
          login: cleanText(
            destination.provider === "github" ? user.login : user.username,
          ),
          ...(typeof user.name === "string"
            ? { name: cleanText(user.name) }
            : {}),
        };
        const previous = state.connections[key(destination)];
        if (previous?.leases.some((lease) => lease.expiresAt > now()))
          throw new SourceControlError(
            "Wait for active jobs to finish before replacing this source connection.",
            "refresh_blocked",
            409,
          );
        state.connections[key(destination)] = connection;
        delete state.pending[id];
        await save(state);
        return {
          status: "connected",
          connection: statusOf(destination, connection),
        };
      });
    },
    async disconnect(input) {
      const destination = target(input);
      return store.locked(async (state, save) => {
        const connection = state.connections[key(destination)];
        if (connection?.leases.some((lease) => lease.expiresAt > now()))
          throw new SourceControlError(
            "Wait for active jobs to finish before disconnecting this account.",
            "refresh_blocked",
            409,
          );
        delete state.connections[key(destination)];
        for (const [id, pending] of Object.entries(state.pending))
          if (
            pending.flow.provider === destination.provider &&
            pending.serverUrl === destination.serverUrl
          )
            delete state.pending[id];
        await save(state);
        return statusOf(destination);
      });
    },
    async repositories(input) {
      const destination = target(input),
        search = cleanText(input.search, 100).toLowerCase();
      return store.locked(async (state, save) => {
        const connection = state.connections[key(destination)];
        let accessToken: string;
        if (connection) {
          await refreshed(state, connection, save, 60000);
          accessToken = connection.accessToken;
        } else {
          if (
            destination.provider === "gitlab" &&
            input.serverUrl === undefined
          )
            throw new SourceControlError(
              "Choose an explicit GitLab server for a manual token, or connect GitLab OAuth to browse repositories.",
              "issuer_required",
              400,
            );
          const pat = manual(destination.provider);
          if (!pat || !token(pat))
            throw new SourceControlError(
              "Connect this source provider first.",
              "not_connected",
              401,
            );
          accessToken = pat;
        }
        const repositories: SourceRepository[] = [];
        const repositoryApi = async (path: string) => {
          try {
            return await providerApi(destination, accessToken, path);
          } catch (error) {
            if (
              connection &&
              error instanceof SourceControlError &&
              error.code === "reconnect_required"
            ) {
              connection.needsReconnect = true;
              await save(state);
            }
            throw error;
          }
        };
        let truncated = false,
          scanned = 0,
          requests = 0;
        const started = now();
        const add = (item: unknown, installationId?: string) => {
          scanned++;
          const found = repo(destination, item, installationId);
          if (!search || found.fullName.toLowerCase().includes(search))
            repositories.push(found);
        };
        if (destination.provider === "github" && connection) {
          githubPages: for (let page = 1; page <= 20; page++) {
            if (++requests > 25 || now() - started > 15000) {
              truncated = true;
              break;
            }
            const data = (
              await repositoryApi(
                `/user/installations?per_page=100&page=${page}`,
              )
            ).data;
            if (!object(data) || !Array.isArray(data.installations))
              throw new SourceControlError(
                "GitHub returned invalid installations.",
                "invalid_response",
                502,
              );
            for (const item of data.installations) {
              if (!object(item) || !number(item.id, 1, Number.MAX_SAFE_INTEGER))
                continue;
              for (let repoPage = 1; repoPage <= 20; repoPage++) {
                if (++requests > 25 || now() - started > 15000) {
                  truncated = true;
                  break githubPages;
                }
                const listed = (
                  await repositoryApi(
                    `/user/installations/${item.id}/repositories?per_page=100&page=${repoPage}`,
                  )
                ).data;
                if (!object(listed) || !Array.isArray(listed.repositories))
                  throw new SourceControlError(
                    "GitHub returned invalid repositories.",
                    "invalid_response",
                    502,
                  );
                for (const repository of listed.repositories)
                  add(repository, String(item.id));
                if (scanned >= MAX_REPOSITORIES) {
                  truncated = true;
                  break;
                }
                if (listed.repositories.length < 100) break;
                if (repoPage === 20) truncated = true;
              }
              if (scanned >= MAX_REPOSITORIES) break;
            }
            if (scanned >= MAX_REPOSITORIES || data.installations.length < 100)
              break;
            if (page === 20) truncated = true;
          }
        } else {
          for (let page = 1; page <= 20; page++) {
            if (now() - started > 15000) {
              truncated = true;
              break;
            }
            const path =
              destination.provider === "github"
                ? `/user/repos?per_page=100&page=${page}&sort=full_name`
                : `/projects?membership=true&simple=false&per_page=100&page=${page}&order_by=path&sort=asc${search ? "&search=" + encodeURIComponent(search) : ""}`;
            const data = (await repositoryApi(path)).data;
            if (!Array.isArray(data))
              throw new SourceControlError(
                "The provider returned invalid repositories.",
                "invalid_response",
                502,
              );
            for (const value of data) add(value);
            if (data.length < 100) break;
            if (page === 20) truncated = true;
          }
        }
        return {
          repositories: [
            ...new Map(
              repositories.map((item) => [item.fullName, item]),
            ).values(),
          ].slice(0, MAX_REPOSITORIES),
          truncated,
        };
      });
    },
    acquireLease: (input) =>
      credential({ ...input, repository: input.repository }),
    resolveCredential: (input) => credential(input),
    async releaseLease(jobId) {
      if (!/^job-[a-z0-9-]{1,100}$/.test(jobId))
        throw new SourceControlError("Invalid job identifier.");
      await store.locked(async (state, save) => {
        let changed = false;
        for (const connection of Object.values(state.connections)) {
          const leases = connection.leases.filter(
            (lease) => lease.jobId !== jobId && lease.expiresAt > now(),
          );
          if (leases.length !== connection.leases.length) {
            connection.leases = leases;
            changed = true;
          }
        }
        if (changed) await save(state);
      });
    },
  };
  return api;
}
