import { afterEach, describe, expect, it } from "vitest";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createSourceControl,
  SourceControlError,
  type SourceProvider,
} from "./index.ts";

const roots: string[] = [];
const temporary = () => {
  const value = mkdtempSync(join(tmpdir(), "gremlins-source-test-"));
  roots.push(value);
  return value;
};
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function fixture(provider: SourceProvider = "github") {
  const root = temporary();
  let clock = Date.parse("2026-10-04T10:00:00Z"),
    authorized = false,
    error = "",
    revoked = false,
    counter = 0,
    refreshes = 0,
    listingPages = false,
    wrongVerification = false,
    notInstalled = false,
    lookupDelay = 0;
  let installationPermissions = { contents: "write", pull_requests: "write" };
  let access = "",
    refresh = "";
  const calls: Array<{ url: string; body: URLSearchParams; headers: Headers }> =
    [];
  const origin =
    provider === "github" ? "https://github.com" : "https://gitlab.com";
  const repository = {
    id: 9,
    full_name: "example/app",
    path_with_namespace: "example/app",
    default_branch: "main",
    private: true,
    visibility: "private",
    permissions: { push: true, project_access: { access_level: 40 } },
  };
  const fetcher = (async (
    input: URL | string | Request,
    init?: RequestInit,
  ) => {
    const url = String(input),
      path = new URL(url).pathname,
      body = new URLSearchParams(String(init?.body ?? "")),
      headers = new Headers(init?.headers);
    calls.push({ url, body, headers });
    const response = (value: unknown, status = 200) =>
      new Response(JSON.stringify(value), {
        status,
        headers: { "content-type": "application/json" },
      });
    if (path.endsWith("/device/code") || path.endsWith("/authorize_device"))
      return response({
        device_code: "private-device-code",
        user_code: "ABCD-EFGH",
        verification_uri: wrongVerification
          ? "https://attacker.example/login/device"
          : origin +
            (provider === "github" ? "/login/device" : "/oauth/device"),
        expires_in: 900,
        interval: 5,
      });
    if (path.endsWith("/access_token") || path.endsWith("/oauth/token")) {
      if (error) {
        const value = error;
        error = "";
        return response({ error: value });
      }
      if (body.get("grant_type") === "refresh_token") {
        refreshes++;
        if (body.get("refresh_token") !== refresh)
          return response({ error: "bad_refresh_token" });
      } else if (!authorized)
        return response({ error: "authorization_pending" });
      counter++;
      access = `private-access-${counter}`;
      refresh = `private-refresh-${counter}`;
      return response({
        access_token: access,
        refresh_token: refresh,
        token_type: "bearer",
        expires_in: 7200,
        refresh_token_expires_in: 86400,
      });
    }
    if (revoked || headers.get("authorization") !== `Bearer ${access}`)
      return response({ message: "private internal detail" }, 401);
    if (path.endsWith("/user"))
      return response({
        id: 77,
        login: "gremlin-user",
        username: "gremlin-user",
        name: "Gremlin User",
      });
    if (path === "/user/installations")
      return response({
        installations: [{ id: 123, permissions: installationPermissions }],
      });
    if (path === "/user/installations/123/repositories")
      return response({
        repositories: listingPages
          ? Array.from({ length: 100 }, (_, i) => ({
              ...repository,
              id: i + 1,
              full_name: `example/app-${i}`,
            }))
          : notInstalled
            ? []
            : [repository],
      });
    if (
      path === "/repos/example/app" ||
      path === "/api/v4/projects/example%2Fapp"
    ) {
      clock += lookupDelay;
      lookupDelay = 0;
      return response(repository);
    }
    if (path === "/api/v4/projects") return response([repository]);
    return response({ message: "not found" }, 404);
  }) as typeof fetch;
  const env = {
    SHIPGREMLINS_GITHUB_CLIENT_ID: "Iv1.test-client",
    SHIPGREMLINS_GITLAB_CLIENT_ID: "test-gitlab-client",
    GITHUB_TOKEN: "manual-fallback-token",
    GITLAB_TOKEN: "manual-fallback-token",
  };
  const options = {
    root,
    session: "session-a",
    env,
    fetch: fetcher,
    now: () => clock,
  };
  const api = createSourceControl(options);
  const advance = (ms: number) => {
    clock += ms;
  };
  const connect = async () => {
    const flow = await api.connect({ provider });
    authorized = true;
    advance(5000);
    expect(await api.poll(flow.id)).toMatchObject({ status: "connected" });
    return flow;
  };
  return {
    root,
    api,
    options,
    calls,
    connect,
    advance,
    provider,
    setError: (value: string) => {
      error = value;
    },
    authorize: () => {
      authorized = true;
    },
    revoke: () => {
      revoked = true;
    },
    refreshes: () => refreshes,
    access: () => access,
    largeList: () => {
      listingPages = true;
    },
    badVerification: () => {
      wrongVerification = true;
    },
    excludeRepository: () => {
      notInstalled = true;
    },
    readonlyApp: () => {
      installationPermissions = { contents: "read", pull_requests: "read" };
    },
    delayLookup: (ms: number) => {
      lookupDelay = ms;
    },
    clock: () => clock,
  };
}

describe("official source OAuth device connections", () => {
  it("requires installed GitHub repository membership and app write permissions for coding", async () => {
    const test = fixture();
    await test.connect();
    test.excludeRepository();
    await expect(
      test.api.resolveCredential({
        provider: "github",
        repository: "example/app",
      }),
    ).rejects.toMatchObject({ code: "repository_not_installed" });
    const readonly = fixture();
    await readonly.connect();
    readonly.readonlyApp();
    await expect(
      readonly.api.acquireLease({
        provider: "github",
        repository: "example/app",
        jobId: "job-code",
        write: true,
      }),
    ).rejects.toMatchObject({ code: "repository_readonly" });
    expect(
      await readonly.api.acquireLease({
        provider: "github",
        repository: "example/app",
        jobId: "job-pm",
        write: false,
      }),
    ).toMatchObject({ method: "oauth" });
  });

  it("rechecks token lifetime after slow repository validation", async () => {
    const test = fixture();
    await test.connect();
    test.advance(70 * 60000);
    test.delayLookup(1000);
    const lease = await test.api.acquireLease({
      provider: "github",
      repository: "example/app",
      jobId: "job-slow",
    });
    expect(test.refreshes()).toBe(1);
    expect(Date.parse(lease.expiresAt!) - test.clock()).toBeGreaterThanOrEqual(
      50 * 60000,
    );
  });

  it("never sends an unbound legacy GitLab token to the public repository picker", async () => {
    const test = fixture("gitlab");
    await expect(
      test.api.repositories({ provider: "gitlab" }),
    ).rejects.toMatchObject({ code: "issuer_required" });
    expect(test.calls).toEqual([]);
    expect(
      (await test.api.status()).find((value) => value.provider === "gitlab"),
    ).toMatchObject({ method: "token", connected: false });
    expect(
      await test.api.acquireLease({
        provider: "gitlab",
        serverUrl: "https://gitlab.example.test",
        repository: "group/app",
        jobId: "job-legacy",
      }),
    ).toMatchObject({ method: "token" });
    expect(test.calls).toEqual([]);
  });

  it("persists revoked OAuth status from repository browsing and refuses unsafe refresh fallback", async () => {
    const test = fixture();
    await test.connect();
    test.revoke();
    await expect(
      test.api.repositories({ provider: "github" }),
    ).rejects.toMatchObject({ code: "reconnect_required" });
    expect(
      (await test.api.status()).find((value) => value.provider === "github"),
    ).toMatchObject({
      method: "oauth",
      needsReconnect: true,
      connected: false,
    });
    const failed = fixture();
    await failed.connect();
    failed.advance(80 * 60000);
    failed.setError("bad_refresh_token");
    await expect(
      failed.api.acquireLease({
        provider: "github",
        repository: "example/app",
        jobId: "job-fail",
      }),
    ).rejects.toMatchObject({ code: "reconnect_required" });
    expect(
      (await failed.api.status()).find((value) => value.provider === "github"),
    ).toMatchObject({ method: "oauth", needsReconnect: true });
  });
  it.each(["github", "gitlab"] as const)(
    "connects %s with a public client and stores only encrypted credentials",
    async (provider) => {
      const test = fixture(provider);
      const flow = await test.connect();
      expect(flow.userCode).toBe("ABCD-EFGH");
      expect(JSON.stringify(flow)).not.toContain("private-device-code");
      const status = (await test.api.status()).find(
        (value) => value.provider === provider,
      )!;
      expect(status).toMatchObject({
        connected: true,
        method: "oauth",
        account: { login: "gremlin-user" },
      });
      expect(JSON.stringify(status)).not.toMatch(
        /private-access|private-refresh|private-device/,
      );
      const stored = readFileSync(
        join(test.root, ".run/source-control/connections.enc"),
      );
      expect(stored.includes(Buffer.from("private-access"))).toBe(false);
      const exported = JSON.stringify(
        await test.api.repositories({ provider }),
      );
      expect(exported).not.toContain("private-access");
      expect(exported).toContain("example/app");
      expect(test.calls.every((call) => !call.body.has("client_secret"))).toBe(
        true,
      );
      expect(
        test.calls
          .filter((call) => call.body.has("grant_type"))[0]
          ?.body.get("grant_type"),
      ).toBe("urn:ietf:params:oauth:grant-type:device_code");
    },
  );

  it("obeys poll intervals and slowdown without exposing provider errors", async () => {
    const test = fixture();
    const flow = await test.api.connect({ provider: "github" });
    expect(await test.api.poll(flow.id)).toEqual({
      status: "pending",
      retryAfterSeconds: 5,
    });
    expect(test.calls).toHaveLength(1);
    test.advance(5000);
    test.setError("slow_down");
    expect(await test.api.poll(flow.id)).toEqual({
      status: "pending",
      retryAfterSeconds: 10,
    });
    test.advance(9000);
    expect(await test.api.poll(flow.id)).toMatchObject({
      status: "pending",
      retryAfterSeconds: 1,
    });
    test.advance(1000);
    test.setError("access_denied");
    expect(await test.api.poll(flow.id)).toEqual({ status: "denied" });
  });

  it("binds pending device authorization to the dashboard session and rejects expired codes", async () => {
    const test = fixture();
    const flow = await test.api.connect({ provider: "github" });
    const other = createSourceControl({
      ...test.options,
      session: "different-session",
    });
    await expect(other.poll(flow.id)).rejects.toMatchObject({
      code: "invalid_session",
    });
    test.advance(901000);
    expect(await test.api.poll(flow.id)).toEqual({ status: "expired" });
  });

  it("rejects an unexpected verification origin before saving pending authorization", async () => {
    const test = fixture();
    test.badVerification();
    await expect(test.api.connect({ provider: "github" })).rejects.toThrow(
      "unexpected verification",
    );
    expect(readdirSync(join(test.root, ".run/source-control"))).not.toContain(
      "connections.enc",
    );
  });

  it.each(["github", "gitlab"] as const)(
    "defers refresh while a %s job lease is active, including doctor refresh requests",
    async (provider) => {
      const test = fixture(provider);
      await test.connect();
      test.advance(69 * 60000);
      const first = await test.api.acquireLease({
        provider,
        repository: "example/app",
        jobId: "job-first",
      });
      expect(first.method).toBe("oauth");
      test.advance(46 * 60000);
      await expect(
        test.api.acquireLease({
          provider,
          repository: "example/app",
          jobId: "job-second",
        }),
      ).rejects.toMatchObject({ code: "refresh_blocked", status: 409 });
      await expect(
        test.api.resolveCredential({
          provider,
          repository: "example/app",
          minValidityMs: 10 * 60000,
        }),
      ).rejects.toMatchObject({ code: "refresh_blocked" });
      await expect(test.api.disconnect({ provider })).rejects.toMatchObject({
        code: "refresh_blocked",
      });
      expect(test.refreshes()).toBe(0);
      await test.api.releaseLease("job-first");
      const second = await test.api.acquireLease({
        provider,
        repository: "example/app",
        jobId: "job-second",
      });
      expect(second.token).not.toBe(first.token);
      expect(test.refreshes()).toBe(1);
    },
  );

  it("serializes refresh across independent controller instances and preserves leases", async () => {
    const test = fixture();
    await test.connect();
    test.advance(80 * 60000);
    const other = createSourceControl(test.options);
    const values = await Promise.all([
      test.api.acquireLease({
        provider: "github",
        repository: "example/app",
        jobId: "job-one",
      }),
      other.acquireLease({
        provider: "github",
        repository: "example/app",
        jobId: "job-two",
      }),
    ]);
    expect(values[0]?.token).toBe(values[1]?.token);
    expect(test.refreshes()).toBe(1);
    await test.api.releaseLease("job-one");
    await other.releaseLease("job-two");
    expect(await test.api.disconnect({ provider: "github" })).toMatchObject({
      method: "token",
    });
  });

  it("never falls back silently to a manual token after OAuth revocation or failed refresh", async () => {
    const test = fixture();
    await test.connect();
    test.revoke();
    await expect(
      test.api.resolveCredential({
        provider: "github",
        repository: "example/app",
      }),
    ).rejects.toMatchObject({ code: "reconnect_required" });
    const status = (await test.api.status()).find(
      (item) => item.provider === "github",
    )!;
    expect(status).toMatchObject({
      method: "oauth",
      connected: false,
      needsReconnect: true,
    });
    await expect(
      test.api.acquireLease({
        provider: "github",
        repository: "example/app",
        jobId: "job-revoked",
      }),
    ).rejects.toMatchObject({ code: "reconnect_required" });
  });

  it("supports old manual-token jobs without making new provider requests", async () => {
    const test = fixture();
    expect(
      await test.api.acquireLease({
        provider: "github",
        repository: "example/app",
        jobId: "job-old",
      }),
    ).toEqual({ token: "manual-fallback-token", method: "token" });
    expect(test.calls).toEqual([]);
  });

  it("bounds repository enumeration even when client search matches nothing", async () => {
    const test = fixture();
    await test.connect();
    test.largeList();
    const before = test.calls.length;
    expect(
      await test.api.repositories({
        provider: "github",
        search: "missing-name",
      }),
    ).toEqual({ repositories: [], truncated: true });
    expect(test.calls.length - before).toBeLessThanOrEqual(25);
  });

  it("rejects arbitrary secret hosts, repository traversal, and tampered ciphertext", async () => {
    const test = fixture();
    await expect(
      test.api.connect({
        provider: "github",
        serverUrl: "https://attacker.test",
      }),
    ).rejects.toThrow("HTTPS origin");
    await expect(
      test.api.acquireLease({
        provider: "github",
        repository: "../app",
        jobId: "job-unsafe",
      }),
    ).rejects.toThrow("owner/repository");
    await test.connect();
    const file = join(test.root, ".run/source-control/connections.enc");
    const bytes = readFileSync(file);
    bytes[bytes.length - 1] = bytes.at(-1)! ^ 1;
    writeFileSync(file, bytes);
    await expect(test.api.status()).rejects.toMatchObject({
      code: "storage_error",
    });
  });

  it("refuses junction or symlink state destinations", async () => {
    const root = temporary(),
      outside = temporary();
    symlinkSync(
      outside,
      join(root, ".run"),
      process.platform === "win32" ? "junction" : "dir",
    );
    const api = createSourceControl({ root });
    await expect(
      api.connect({ provider: "github", clientId: "test-client" }),
    ).rejects.toThrow("symbolic links");
  });

  it("exposes structured safe error codes", () => {
    const error = new SourceControlError(
      "Waiting for current jobs",
      "refresh_blocked",
      409,
    );
    expect(error.name).toBe("SourceControlError");
    expect(error.code).toBe("refresh_blocked");
  });
});
