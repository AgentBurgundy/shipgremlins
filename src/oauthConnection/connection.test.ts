import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLinearConnection } from "../linearConnection/index.ts";
import { createVercelConnection } from "../vercelConnection/index.ts";
import { sealOAuthEnvelope } from "./connection.ts";
import { createOAuthStore } from "./storage.ts";
import type { OAuthProvider } from "./types.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function root() {
  const value = mkdtempSync(join(realpathSync(tmpdir()), "gremlins-oauth-"));
  roots.push(value);
  return value;
}
function fixture(
  provider: OAuthProvider = "linear",
  environment: NodeJS.ProcessEnv = {},
) {
  const directory = root();
  let time = Date.now();
  let post: {
    key: string;
    nonce: string;
    codeChallenge?: string;
    returnUrl: string;
  };
  let failRefresh = "",
    identityFail = 0,
    projectFailure = 0,
    brokerFailure = false;
  let scope: unknown = "read write",
    refreshScope: unknown = "read write";
  let refreshes = 0;
  const calls: Array<{
    url: string;
    init: RequestInit;
    body: Record<string, unknown>;
  }> = [];
  const fetcher = (async (
    url: string | URL | Request,
    init: RequestInit = {},
  ) => {
    const target = String(url);
    const body = String(init.body ?? "").startsWith("{")
      ? (JSON.parse(String(init.body)) as Record<string, unknown>)
      : Object.fromEntries(new URLSearchParams(String(init.body ?? "")));
    calls.push({ url: target, init, body });
    const result = (data: unknown, status = 200) =>
      new Response(JSON.stringify(data), { status });
    if (target.endsWith(`/api/${provider}/status`))
      return result({ available: !brokerFailure });
    if (target.endsWith(`/api/${provider}/connect`)) {
      post = body as typeof post;
      return result({
        url: `https://shipgremlins.ai/api/${provider}/authorize?request=opaque`,
        clientId: "linear-client-id",
        redirectUri: `https://shipgremlins.ai/api/${provider}/callback`,
      });
    }
    if (target === "https://api.linear.app/oauth/token") {
      if (body.grant_type === "refresh_token") {
        refreshes++;
        if (failRefresh === "network")
          throw new Error("must-not-echo-refresh-secret");
        if (failRefresh)
          return result(
            {
              error: "invalid_grant",
              error_description: "must-not-echo-refresh-secret",
            },
            400,
          );
        return result({
          access_token: "linear-refreshed-secret",
          refresh_token: "rotated-refresh-secret",
          expires_in: 86400,
          scope: refreshScope,
          token_type: "Bearer",
        });
      }
      expect(body).not.toHaveProperty("client_secret");
      expect(
        createHash("sha256")
          .update(String(body.code_verifier))
          .digest("base64url"),
      ).toBe(post.codeChallenge);
      expect(body.redirect_uri).toBe(
        "https://shipgremlins.ai/api/linear/callback",
      );
      return result({
        access_token: "linear-access-secret",
        refresh_token: "linear-refresh-secret",
        expires_in: 86400,
        scope,
        token_type: "Bearer",
      });
    }
    if (target === "https://api.linear.app/graphql")
      return identityFail
        ? result(
            { errors: [{ message: "must-not-echo-access-secret" }] },
            identityFail,
          )
        : result({
            data: {
              viewer: { id: "user-uuid", name: "A User" },
              organization: { id: "org-uuid", name: "Gremlin Lab" },
            },
          });
    if (target.startsWith("https://api.vercel.com/v2/teams/"))
      return result({ id: "team_123", name: "Gremlin Hosting" });
    if (target.startsWith("https://api.vercel.com/v2/user"))
      return result({ user: { id: "user_123", name: "A User" } });
    if (target.startsWith("https://api.vercel.com/v9/projects/prj_"))
      return projectFailure
        ? result(
            {
              error: {
                code: "forbidden",
                message: "must-not-echo-access-secret",
              },
            },
            projectFailure,
          )
        : result({ id: "prj_123", name: "gremlin-app" });
    if (target.startsWith("https://api.vercel.com/v9/projects?"))
      return result({ projects: [] });
    throw new Error(`Unexpected fixture URL ${target}`);
  }) as typeof fetch;
  const options = {
    root: directory,
    session: "dashboard-session",
    env: environment,
    fetch: fetcher,
    now: () => time,
  };
  const factory =
    provider === "linear" ? createLinearConnection : createVercelConnection;
  const connection = factory(options);
  const payload = () => ({
    nonce: post.nonce,
    expires: time + 600_000,
    ...(provider === "linear"
      ? { code: "linear-authorization-code" }
      : {
          connection: {
            accessToken: "vercel-access-secret",
            teamId: "team_123",
            userId: "user_123",
            configurationId: "icfg_123",
          },
        }),
  });
  const envelope = () =>
    sealOAuthEnvelope(provider, payload(), Buffer.from(post.key, "base64url"));
  async function connect() {
    await connection.connect("http://192.168.1.12:4311/");
    return connection.complete(envelope());
  }
  return {
    root: directory,
    connection,
    options,
    calls,
    connect,
    envelope,
    payload,
    post: () => post,
    setTime: (value: number) => (time = value),
    advance: (value: number) => (time += value),
    time: () => time,
    refreshes: () => refreshes,
    failRefresh: (value: string) => (failRefresh = value),
    identityFail: (value = 503) => (identityFail = value),
    setScope: (value: unknown) => (scope = value),
    setRefreshScope: (value: unknown) => (refreshScope = value),
    projectFailure: (value: number) => (projectFailure = value),
    brokerFailure: () => (brokerFailure = true),
  };
}

describe("Linear and Vercel dashboard OAuth", () => {
  it("exchanges Linear PKCE locally, persists encrypted credentials, and exposes safe metadata", async () => {
    const f = fixture();
    const status = await f.connect();
    expect(status).toMatchObject({
      provider: "linear",
      method: "oauth",
      connected: true,
      workspace: { name: "Gremlin Lab" },
      account: { name: "A User" },
    });
    expect(JSON.stringify(status)).not.toMatch(
      /secret|authorization-code|verifier/,
    );
    expect(f.post()).not.toHaveProperty("codeVerifier");
    expect(
      await createLinearConnection(f.options).resolveCredential(),
    ).toMatchObject({
      token: "linear-access-secret",
      authorization: "Bearer linear-access-secret",
      method: "oauth",
    });
    const directory = join(f.root, ".run", "oauth", "linear");
    for (const name of readdirSync(directory))
      expect(readFileSync(join(directory, name)).toString()).not.toMatch(
        /linear-access-secret|linear-refresh-secret|linear-authorization-code/,
      );
    if (process.platform !== "win32")
      expect(statSync(join(directory, "key")).mode & 0o777).toBe(0o600);
  });
  it("keeps legacy API keys compatible without contacting either provider", async () => {
    const linear = fixture("linear", { LINEAR_API_KEY: "legacy-linear" });
    const vercel = fixture("vercel", { VERCEL_TOKEN: "legacy-vercel" });
    expect(await linear.connection.resolveCredential()).toEqual({
      token: "legacy-linear",
      authorization: "legacy-linear",
      method: "token",
    });
    expect(await vercel.connection.acquireLease({ jobId: "job-one" })).toEqual({
      token: "legacy-vercel",
      authorization: "Bearer legacy-vercel",
      method: "token",
    });
    expect(linear.calls).toHaveLength(0);
    expect(vercel.calls).toHaveLength(0);
  });
  it("reads setup metadata without calling the hosted broker", async () => {
    const f = fixture();
    expect(
      await f.connection.status({ checkAvailability: false }),
    ).toMatchObject({ connected: false, method: "none" });
    expect(f.calls).toHaveLength(0);
    expect(readdirSync(f.root)).toHaveLength(0);
  });
  it("binds encrypted callback to provider, nonce, session, and expiry", async () => {
    const f = fixture();
    await f.connection.connect("http://127.0.0.1:4311/");
    const key = Buffer.from(f.post().key, "base64url");
    await expect(
      f.connection.complete(sealOAuthEnvelope("vercel", f.payload(), key)),
    ).rejects.toMatchObject({ code: "invalid_envelope" });
    await expect(
      f.connection.complete(
        sealOAuthEnvelope("linear", { ...f.payload(), nonce: "wrong" }, key),
      ),
    ).rejects.toMatchObject({ code: "invalid_envelope" });
    await expect(
      createLinearConnection({
        ...f.options,
        session: "other-dashboard",
      }).complete(f.envelope()),
    ).rejects.toMatchObject({ code: "invalid_session" });
    f.advance(600_001);
    await expect(f.connection.complete(f.envelope())).rejects.toMatchObject({
      code: "invalid_session",
    });
    expect(
      f.calls.filter((call) => call.url.includes("oauth/token")),
    ).toHaveLength(0);
  });
  it("rejects a callback replay and preserves existing connection after consent is canceled", async () => {
    const f = fixture();
    await f.connect();
    await expect(f.connection.complete(f.envelope())).rejects.toMatchObject({
      code: "invalid_session",
    });
    await f.connection.connect("http://10.0.0.8:4311/");
    const value = sealOAuthEnvelope(
      "linear",
      { nonce: f.post().nonce, expires: f.time() + 1000, error: true },
      Buffer.from(f.post().key, "base64url"),
    );
    await expect(f.connection.complete(value)).rejects.toMatchObject({
      code: "access_denied",
    });
    expect((await f.connection.resolveCredential()).token).toBe(
      "linear-access-secret",
    );
  });
  it("rejects unsafe callback return URLs before any network call", async () => {
    const f = fixture();
    for (const url of [
      "file:///tmp/",
      "http://public.example.com/",
      "https://user:password@example.com/",
      "http://127.0.0.1/?token=bad",
      "http://127.0.0.1/#session=bad",
      "http://127.0.0.1/other",
    ])
      await expect(f.connection.connect(url)).rejects.toThrow("dashboard");
    expect(f.calls).toHaveLength(0);
  });
  it("serializes token refresh across separate controller instances", async () => {
    const f = fixture();
    await f.connect();
    f.advance(24 * 3600_000 - 2 * 60_000);
    const second = createLinearConnection(f.options);
    const [a, b] = await Promise.all([
      f.connection.resolveCredential(),
      second.resolveCredential(),
    ]);
    expect(a.token).toBe("linear-refreshed-secret");
    expect(b.token).toBe(a.token);
    expect(f.refreshes()).toBe(1);
    const refresh = f.calls.find(
      (call) => call.body.grant_type === "refresh_token",
    )!;
    expect(refresh.body).not.toHaveProperty("client_secret");
    expect(refresh.body).toMatchObject({
      client_id: "linear-client-id",
      refresh_token: "linear-refresh-secret",
    });
  });
  it("does not rotate a running job's token and defers a new long job", async () => {
    const f = fixture();
    await f.connect();
    f.advance(23 * 3600_000);
    await f.connection.acquireLease({ jobId: "job-one" });
    f.advance(15 * 60_000);
    await expect(
      f.connection.acquireLease({ jobId: "job-two" }),
    ).rejects.toMatchObject({ code: "refresh_blocked", status: 409 });
    await expect(f.connection.disconnect()).rejects.toMatchObject({
      code: "refresh_blocked",
    });
    await expect(
      f.connection.connect("http://127.0.0.1/"),
    ).rejects.toMatchObject({ code: "refresh_blocked" });
    expect(f.refreshes()).toBe(0);
    await f.connection.releaseLease("job-one");
    expect((await f.connection.acquireLease({ jobId: "job-two" })).token).toBe(
      "linear-refreshed-secret",
    );
  });
  it("retries an ambiguous refresh only inside Linear's documented grace period", async () => {
    const f = fixture();
    await f.connect();
    f.advance(24 * 3600_000);
    f.failRefresh("network");
    await expect(f.connection.resolveCredential()).rejects.toMatchObject({
      code: "provider_unavailable",
    });
    f.advance(60_000);
    f.failRefresh("");
    expect((await f.connection.resolveCredential()).token).toBe(
      "linear-refreshed-secret",
    );
    expect(f.refreshes()).toBe(2);
  });
  it("requires reconnect when an ambiguous refresh is older than the grace period", async () => {
    const f = fixture();
    await f.connect();
    f.advance(24 * 3600_000);
    f.failRefresh("network");
    await expect(f.connection.resolveCredential()).rejects.toMatchObject({
      code: "provider_unavailable",
    });
    f.advance(30 * 60_000);
    await expect(f.connection.resolveCredential()).rejects.toMatchObject({
      code: "reconnect_required",
    });
    expect(f.refreshes()).toBe(1);
  });
  it("never silently switches from revoked OAuth to a manual key", async () => {
    const f = fixture("linear", { LINEAR_API_KEY: "legacy-key" });
    await f.connect();
    f.advance(24 * 3600_000);
    f.failRefresh("revoked");
    await expect(f.connection.resolveCredential()).rejects.toMatchObject({
      code: "reconnect_required",
    });
    expect(await f.connection.status()).toMatchObject({
      connected: false,
      method: "oauth",
      needsReconnect: true,
    });
    expect(JSON.stringify(await f.connection.status())).not.toContain(
      "must-not-echo",
    );
    await f.connection.disconnect();
    expect((await f.connection.resolveCredential()).token).toBe("legacy-key");
  });
  it("stores a Vercel integration team and checks selected project access", async () => {
    const f = fixture("vercel");
    expect(await f.connect()).toMatchObject({
      connected: true,
      workspace: { id: "team_123", name: "Gremlin Hosting" },
    });
    expect(
      await f.connection.resolveCredential({
        projectId: "prj_123",
        teamId: "team_123",
      }),
    ).toMatchObject({
      token: "vercel-access-secret",
      authorization: "Bearer vercel-access-secret",
      teamId: "team_123",
    });
    const project = f.calls.find((call) =>
      call.url.includes("/v9/projects/prj_123"),
    )!;
    expect(project.url).toBe(
      "https://api.vercel.com/v9/projects/prj_123?teamId=team_123",
    );
    expect(project.init.headers).toEqual({
      authorization: "Bearer vercel-access-secret",
    });
    await expect(
      f.connection.resolveCredential({ teamId: "team_other" }),
    ).rejects.toMatchObject({ code: "team_mismatch" });
    await expect(
      f.connection.resolveCredential({ projectId: "../user" }),
    ).rejects.toThrow("Invalid Vercel");
  });
  it("reports a revoked Vercel installation without using a manual token", async () => {
    const f = fixture("vercel", { VERCEL_TOKEN: "legacy" });
    await f.connect();
    f.projectFailure(401);
    await expect(
      f.connection.resolveCredential({ projectId: "prj_123" }),
    ).rejects.toMatchObject({ code: "reconnect_required" });
    expect(await f.connection.status()).toMatchObject({
      connected: false,
      needsReconnect: true,
      method: "oauth",
    });
  });
  it("keeps saved OAuth usable while the setup broker is unavailable", async () => {
    const f = fixture();
    await f.connect();
    f.advance(6 * 60_000);
    f.brokerFailure();
    expect(await f.connection.status()).toMatchObject({
      available: false,
      connected: true,
    });
    expect((await f.connection.resolveCredential()).token).toBe(
      "linear-access-secret",
    );
  });
  it("detects tampered ciphertext without exposing stored secrets", async () => {
    const f = fixture();
    await f.connect();
    const file = join(f.root, ".run", "oauth", "linear", "connection.enc");
    const bytes = readFileSync(file);
    bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1;
    writeFileSync(file, bytes);
    await expect(f.connection.resolveCredential()).rejects.toMatchObject({
      code: "storage_error",
    });
  });
  it("rejects symlink or junction state directories", async () => {
    const f = fixture();
    const external = root();
    symlinkSync(
      external,
      join(f.root, ".run"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await expect(
      f.connection.connect("http://127.0.0.1/"),
    ).rejects.toMatchObject({ code: "storage_error" });
    expect(readdirSync(external)).toEqual([]);
  });
  it("retries a transient identity lookup without exchanging its one-use code twice", async () => {
    const f = fixture();
    await f.connect();
    await f.connection.connect("http://127.0.0.1/");
    f.identityFail();
    await expect(f.connection.complete(f.envelope())).rejects.toMatchObject({
      code: "identity_failed",
    });
    expect(
      (await createOAuthStore(f.root, "linear").read()).connection?.accessToken,
    ).toBe("linear-access-secret");
    const exchanges = f.calls.filter(
      (call) => call.body.grant_type === "authorization_code",
    ).length;
    f.identityFail(0);
    expect(await f.connection.complete(f.envelope())).toMatchObject({
      connected: true,
    });
    expect(
      f.calls.filter((call) => call.body.grant_type === "authorization_code"),
    ).toHaveLength(exchanges);
  });
  it.each(["read", null, 42, { read: true }, ["read"]])(
    "rejects insufficient or malformed Linear scope %j before persisting a connection",
    async (scope) => {
      const f = fixture();
      f.setScope(scope);
      await expect(f.connect()).rejects.toMatchObject({
        code: "scope_required",
      });
      expect(
        (await createOAuthStore(f.root, "linear").read()).connection,
      ).toBeUndefined();
    },
  );
  it("accepts omitted Linear scope only as the requested or previously granted scopes", async () => {
    const f = fixture();
    f.setScope(undefined);
    expect(await f.connect()).toMatchObject({
      connected: true,
      method: "oauth",
    });
    expect(
      (await createOAuthStore(f.root, "linear").read()).connection?.scopes,
    ).toEqual(["read", "write"]);
    f.advance(24 * 3600_000);
    f.setRefreshScope(undefined);
    expect((await f.connection.resolveCredential()).token).toBe(
      "linear-refreshed-secret",
    );
    expect(
      (await createOAuthStore(f.root, "linear").read()).connection?.scopes,
    ).toEqual(["read", "write"]);
  });
  it("detects revoked Linear access at its bounded periodic identity check", async () => {
    const f = fixture();
    await f.connect();
    f.advance(6 * 60_000);
    f.identityFail(401);
    await expect(f.connection.resolveCredential()).rejects.toMatchObject({
      code: "reconnect_required",
    });
    expect(await f.connection.status()).toMatchObject({
      connected: false,
      needsReconnect: true,
    });
  });
});
