import { createHash } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createDashboardAuth,
  DashboardAuthError,
  dashboardAuthTransport,
  type AuthTransport,
  type DashboardAuthStatus,
} from "./index.ts";

const roots: string[] = [];
const bearer = "a".repeat(64),
  password = "a long original password",
  nextPassword = "a different long password";
const local: AuthTransport = {
  origin: "http://127.0.0.1:4311",
  secure: true,
  lan: false,
};
const lan: AuthTransport = {
  origin: "http://192.168.1.3:4311",
  secure: false,
  lan: true,
};
const secure: AuthTransport = {
  origin: "https://gremlins.example",
  secure: true,
  lan: false,
};
const fastHash = async (value: string, salt: string) =>
  createHash("sha512").update(value).update(salt).digest();
function request(
  method: string,
  transport: AuthTransport,
  headers: Record<string, string> = {},
) {
  return {
    method,
    headers: {
      origin: transport.origin,
      "content-type": "application/json",
      ...headers,
    },
  } as IncomingMessage;
}
function fixture(realHash = false) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "sg-auth-test-"));
  roots.push(root);
  let now = 1_800_000_000_000;
  const derive = vi.fn(fastHash);
  const options = {
    root,
    bootstrap: bearer,
    clock: () => now,
    ...(realHash ? {} : { derive }),
  };
  const auth = createDashboardAuth(options);
  async function call(
    path: string,
    value: Record<string, unknown> = {},
    headers: Record<string, string> = {},
    transport = local,
    instance = auth,
  ) {
    let data: DashboardAuthStatus | undefined, cookie: string | undefined;
    const res = {
      setHeader(name: string, value: string) {
        if (name === "Set-Cookie") cookie = value;
      },
      writeHead() {},
      end(raw: string) {
        data = JSON.parse(raw);
      },
    } as unknown as ServerResponse;
    await instance.handle(
      request(path === "session" ? "GET" : "POST", transport, headers),
      res,
      `/api/auth/${path}`,
      transport,
      async () => value,
    );
    return { data: data!, cookie };
  }
  async function setup(transport = local, remember = true) {
    const result = await call(
      "setup",
      {
        password,
        remember,
        ...(transport.lan ? { allowInsecureLan: true } : {}),
      },
      { authorization: `Bearer ${bearer}` },
      transport,
    );
    return {
      ...result,
      headers: {
        cookie: result.cookie!.split(";")[0]!,
        "x-csrf-token": result.data.csrfToken!,
      },
    };
  }
  return {
    root,
    options,
    auth,
    call,
    setup,
    derive,
    advance(ms: number) {
      now += ms;
    },
  };
}
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe("dashboard browser authentication", () => {
  it("requires the existing owner bearer to establish a password and persists only password/session hashes", async () => {
    const f = fixture(true);
    expect((await f.call("session")).data).toMatchObject({
      configured: false,
      authenticated: false,
      canSetup: false,
    });
    await expect(
      f.call("setup", { password, remember: true }),
    ).rejects.toMatchObject({ code: "auth_required" });
    const owner = await f.call(
      "session",
      {},
      { authorization: `Bearer ${bearer}` },
    );
    expect(owner.data).toMatchObject({
      authenticated: true,
      mode: "bootstrap",
      canSetup: true,
    });
    const ready = await f.setup();
    expect(ready.data).toMatchObject({
      configured: true,
      authenticated: true,
      mode: "cookie",
      remembered: true,
    });
    expect(ready.cookie).toContain("HttpOnly; SameSite=Lax; Max-Age=2592000");
    expect(ready.cookie).not.toContain("; Secure");
    const raw = readFileSync(join(f.root, ".auth/dashboard.json"), "utf8");
    for (const secret of [
      password,
      bearer,
      ready.headers.cookie.split("=")[1]!,
    ])
      expect(raw).not.toContain(secret);
    expect(JSON.stringify(ready.data)).not.toContain(
      ready.headers.cookie.split("=")[1]!,
    );
    const restarted = createDashboardAuth(f.options);
    expect(
      (await f.call("session", {}, ready.headers, local, restarted)).data
        .authenticated,
    ).toBe(true);
    await expect(
      f.call(
        "setup",
        { password, remember: true },
        { authorization: `Bearer ${bearer}` },
      ),
    ).rejects.toMatchObject({ code: "auth_already_configured" });
    const login = await f.call("login", { password, remember: false });
    expect(login.cookie).not.toContain("Max-Age");
    expect(login.data.remembered).toBe(false);
  });
  it("keeps bootstrap APIs separate, enforces cookie CSRF, rejects duplicate cookies and does not fall back after a bad bearer", async () => {
    const f = fixture(),
      ready = await f.setup();
    expect(
      f.auth.require(
        request("POST", local, {
          authorization: `Bearer ${bearer}`,
          origin: "",
        }),
        local,
      ).mode,
    ).toBe("bootstrap");
    expect(
      f.auth.require(request("POST", local, ready.headers), local).mode,
    ).toBe("cookie");
    for (const headers of [
      { ...ready.headers, origin: "" },
      { ...ready.headers, origin: "null" },
      { ...ready.headers, origin: "https://evil.example" },
      { ...ready.headers, "x-csrf-token": "wrong" },
    ])
      expect(() =>
        f.auth.require(request("POST", local, headers), local),
      ).toThrow(DashboardAuthError);
    expect(() =>
      f.auth.require(
        request("GET", local, {
          ...ready.headers,
          authorization: "Bearer incorrect",
        }),
        local,
      ),
    ).toThrow("Sign in");
    expect(
      (
        await f.call(
          "session",
          {},
          { cookie: `${ready.headers.cookie}; ${ready.headers.cookie}` },
        )
      ).data.authenticated,
    ).toBe(false);
    expect(
      (
        await f.call("session", {}, ready.headers, {
          ...local,
          origin: "http://127.0.0.1:9999",
        })
      ).data.authenticated,
    ).toBe(false);
  });
  it("keeps owner-authorized private LAN opt-in explicit and never admits public HTTP", async () => {
    const f = fixture();
    await expect(
      f.call(
        "setup",
        { password, remember: true },
        { authorization: `Bearer ${bearer}` },
        lan,
      ),
    ).rejects.toMatchObject({ code: "auth_transport" });
    await expect(
      f.call(
        "login",
        { password, remember: true, allowInsecureLan: true },
        {},
        lan,
      ),
    ).rejects.toMatchObject({ code: "auth_input" });
    const ready = await f.setup(lan);
    expect(ready.data).toMatchObject({
      secureTransport: false,
      allowInsecureLan: true,
      mode: "cookie",
    });
    expect(ready.data.transportMessage).toContain("not encrypted");
    expect(
      (await f.call("login", { password, remember: true }, {}, lan)).data
        .authenticated,
    ).toBe(true);
    const disabledLan = { ...lan, lan: false };
    expect(
      (await f.call("session", {}, ready.headers, disabledLan)).data
        .authenticated,
    ).toBe(false);
    await expect(
      f.call("login", { password, remember: true }, {}, disabledLan),
    ).rejects.toMatchObject({ code: "auth_transport" });
    await expect(
      f.call(
        "login",
        { password, remember: true },
        {},
        { origin: "http://public.example", secure: false, lan: false },
      ),
    ).rejects.toMatchObject({ code: "auth_transport" });
  });
  it("uses host-scoped Secure cookies on HTTPS and expires short and remembered sessions server-side", async () => {
    const f = fixture(),
      ready = await f.setup(secure, false);
    expect(ready.cookie).toMatch(/^__Host-shipgremlins-session=/);
    expect(ready.cookie).toContain("; Secure");
    expect(ready.cookie).not.toContain("Domain=");
    f.advance(8 * 3600_000);
    expect(
      (await f.call("session", {}, ready.headers, secure)).data.authenticated,
    ).toBe(false);
    const login = await f.call(
      "login",
      { password, remember: true },
      {},
      secure,
    );
    const cookie = login.cookie!.split(";")[0]!;
    f.advance(30 * 86400_000);
    expect(
      (await f.call("session", {}, { cookie }, secure)).data.authenticated,
    ).toBe(false);
  });
  it("revokes the current browser durably on logout without deleting other remembered sessions", async () => {
    const f = fixture(),
      first = await f.setup(),
      second = await f.call("login", { password, remember: true });
    const signedOut = await f.call("logout", {}, first.headers);
    expect(signedOut.data.authenticated).toBe(false);
    expect(signedOut.cookie).toContain("Max-Age=0");
    const restarted = createDashboardAuth(f.options);
    expect(
      (await f.call("session", {}, first.headers, local, restarted)).data
        .authenticated,
    ).toBe(false);
    expect(
      (
        await f.call(
          "session",
          {},
          { cookie: second.cookie!.split(";")[0]! },
          local,
          restarted,
        )
      ).data.authenticated,
    ).toBe(true);
  });
  it.each(["logout-all", "password"])(
    "%s revokes existing devices and defeats an in-flight old-generation login",
    async (action) => {
      const f = fixture(),
        ready = await f.setup();
      let release!: () => void;
      f.derive.mockImplementationOnce(async (value, salt) => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return fastHash(value, salt);
      });
      const inFlight = f.call("login", { password, remember: true });
      const rejection = expect(inFlight).rejects.toMatchObject({
        code: "auth_required",
      });
      await vi.waitFor(() => expect(release).toBeTypeOf("function"));
      const result = await f.call(
        action,
        action === "password"
          ? {
              currentPassword: password,
              password: nextPassword,
              remember: true,
            }
          : {},
        ready.headers,
      );
      release();
      await rejection;
      const restarted = createDashboardAuth(f.options);
      expect(
        (await f.call("session", {}, ready.headers, local, restarted)).data
          .authenticated,
      ).toBe(false);
      if (action === "password") {
        expect(result.data.mode).toBe("cookie");
        await expect(
          f.call("login", { password, remember: true }),
        ).rejects.toMatchObject({ code: "auth_invalid_password" });
        expect(
          (await f.call("login", { password: nextPassword, remember: true }))
            .data.authenticated,
        ).toBe(true);
      } else expect(result.data.authenticated).toBe(false);
    },
  );
  it("bounds expensive attempts across restarts and rejects oversized passwords before hashing", async () => {
    const f = fixture();
    await f.setup();
    f.derive.mockClear();
    await expect(
      f.call("login", { password: "x".repeat(1025), remember: true }),
    ).rejects.toMatchObject({ code: "auth_invalid_password" });
    expect(f.derive).not.toHaveBeenCalled();
    for (let i = 0; i < 10; i++)
      await expect(
        f.call(
          "login",
          { password: "wrong", remember: false },
          {},
          local,
          createDashboardAuth(f.options),
        ),
      ).rejects.toMatchObject({ code: "auth_invalid_password" });
    await expect(
      f.call("login", { password, remember: true }),
    ).rejects.toMatchObject({ code: "auth_rate_limited" });
    expect(f.derive).toHaveBeenCalledTimes(10);
    f.advance(60_001);
    expect(
      (await f.call("login", { password, remember: true })).data.authenticated,
    ).toBe(true);
  });
  it("allows only one first-password setup to commit and keeps the winning credential", async () => {
    const f = fixture();
    let release!: () => void;
    f.derive.mockImplementationOnce(async (value, salt) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return fastHash(value, salt);
    });
    const delayed = f.call(
      "setup",
      { password, remember: true },
      { authorization: `Bearer ${bearer}` },
    );
    const rejection = expect(delayed).rejects.toMatchObject({
      code: "auth_already_configured",
    });
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    await f.call(
      "setup",
      { password: nextPassword, remember: true },
      { authorization: `Bearer ${bearer}` },
      local,
      createDashboardAuth(f.options),
    );
    release();
    await rejection;
    await expect(
      f.call("login", { password, remember: true }),
    ).rejects.toMatchObject({ code: "auth_invalid_password" });
    expect(
      (await f.call("login", { password: nextPassword, remember: true })).data
        .authenticated,
    ).toBe(true);
  });
  it("CLI password reset invalidates a pending login and requires owner bootstrap again", async () => {
    const f = fixture(),
      ready = await f.setup(lan);
    let release!: () => void;
    f.derive.mockImplementationOnce(async (value, salt) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return fastHash(value, salt);
    });
    const delayed = f.call("login", { password, remember: true }, {}, lan);
    const rejection = expect(delayed).rejects.toMatchObject({
      code: "auth_required",
    });
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    createDashboardAuth(f.options).resetPassword();
    release();
    await rejection;
    expect(
      (await f.call("session", {}, ready.headers, lan)).data,
    ).toMatchObject({
      configured: false,
      authenticated: false,
      allowInsecureLan: false,
    });
    await expect(
      f.call("setup", { password, remember: true }),
    ).rejects.toMatchObject({ code: "auth_required" });
  });
  it("admits no more than two concurrent hashes", async () => {
    const f = fixture();
    await f.setup();
    const release: Array<() => void> = [];
    f.derive.mockImplementation(async (value, salt) => {
      await new Promise<void>((resolve) => release.push(resolve));
      return fastHash(value, salt);
    });
    const first = f.call("login", { password, remember: true }),
      second = f.call("login", { password, remember: true });
    await vi.waitFor(() => expect(release).toHaveLength(2));
    await expect(
      f.call("login", { password, remember: true }),
    ).rejects.toMatchObject({ code: "auth_rate_limited" });
    release.forEach((done) => done());
    await Promise.all([first, second]);
  });
  it("fails closed on corrupt/private state or a live concurrent writer without leaking raw storage data", async () => {
    const f = fixture(),
      ready = await f.setup();
    writeFileSync(
      join(f.root, ".auth/write.lock"),
      JSON.stringify({ pid: process.pid }),
    );
    await expect(f.call("logout-all", {}, ready.headers)).rejects.toMatchObject(
      { code: "auth_storage" },
    );
    writeFileSync(
      join(f.root, ".auth/dashboard.json"),
      "sensitive corrupted state",
    );
    await expect(f.call("session")).rejects.toMatchObject({
      code: "auth_storage",
    });
    await expect(f.call("session")).rejects.not.toThrow("sensitive");
  });
});

describe("dashboard transport boundary", () => {
  const req = (peer: string) =>
    ({
      socket: { remoteAddress: peer },
      headers: { "x-forwarded-proto": "https", "x-forwarded-for": "127.0.0.1" },
    }) as unknown as IncomingMessage;
  it("trusts only exact configured HTTPS through a local proxy and local loopback", () => {
    expect(
      dashboardAuthTransport(
        req("::ffff:127.0.0.1"),
        secure.origin,
        secure.origin,
        [],
      ).secure,
    ).toBe(true);
    expect(
      dashboardAuthTransport(
        req("203.0.113.1"),
        secure.origin,
        secure.origin,
        [],
      ).secure,
    ).toBe(false);
    expect(
      dashboardAuthTransport(req("127.0.0.1"), local.origin, undefined, [])
        .secure,
    ).toBe(true);
    expect(
      dashboardAuthTransport(req("192.168.1.8"), local.origin, undefined, [])
        .secure,
    ).toBe(false);
  });
  it("restricts explicit LAN capability to known private hosts and direct private peers, disabled by canonical HTTPS", () => {
    expect(
      dashboardAuthTransport(req("192.168.1.8"), lan.origin, undefined, [
        "192.168.1.3",
      ]).lan,
    ).toBe(true);
    expect(
      dashboardAuthTransport(req("203.0.113.1"), lan.origin, undefined, [
        "192.168.1.3",
      ]).lan,
    ).toBe(false);
    expect(
      dashboardAuthTransport(req("192.168.1.8"), lan.origin, undefined, []).lan,
    ).toBe(false);
    expect(
      dashboardAuthTransport(req("192.168.1.8"), lan.origin, secure.origin, [
        "192.168.1.3",
      ]).lan,
    ).toBe(false);
    expect(
      dashboardAuthTransport(
        req("192.168.1.8"),
        "http://public.example",
        undefined,
        ["public.example"],
      ).lan,
    ).toBe(false);
  });
});
