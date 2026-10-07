import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { isIP } from "node:net";
import { join } from "node:path";
import { safeOAuthPath } from "../oauthConnection/storage.ts";
import { writePrivate } from "../remoteWorkers/storage.ts";
import { withDashboardAuthLock } from "./lock.ts";

type ErrorCode =
  | "auth_required"
  | "auth_invalid_password"
  | "auth_csrf"
  | "auth_transport"
  | "auth_setup_required"
  | "auth_already_configured"
  | "auth_rate_limited"
  | "auth_input"
  | "auth_storage";
export class DashboardAuthError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "DashboardAuthError";
  }
}
export interface AuthTransport {
  origin: string;
  secure: boolean;
  lan: boolean;
}
const normalizeIp = (value: string) => value.replace(/^::ffff:/, "");
const loopback = (value: string) =>
  value === "::1" || (isIP(value) === 4 && value.startsWith("127."));
function privateIp(value: string): boolean {
  const [a = 0, b = 0] = value.split(".").map(Number);
  return (
    isIP(value) === 4 &&
    (a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127))
  );
}
/** Trust the configured HTTPS proxy only on a local connection, never forwarded headers. */
export function dashboardAuthTransport(
  req: IncomingMessage,
  origin: string,
  publicOrigin: string | undefined,
  networkHosts: readonly string[],
): AuthTransport {
  const peer = normalizeIp(req.socket.remoteAddress ?? ""),
    url = new URL(origin);
  const secure =
    loopback(peer) &&
    (origin === publicOrigin ||
      (url.protocol === "http:" && loopback(url.hostname)));
  const lan =
    !publicOrigin &&
    url.protocol === "http:" &&
    privateIp(url.hostname) &&
    networkHosts.includes(url.hostname) &&
    (privateIp(peer) || loopback(peer));
  return { origin, secure, lan };
}

interface Password {
  salt: string;
  digest: string;
}
interface Session {
  hash: string;
  csrf: string;
  origin: string;
  createdAt: number;
  expiresAt: number;
  remembered: boolean;
}
interface State {
  schema: 1;
  generation: string;
  password?: Password;
  allowInsecureLan: boolean;
  sessions: Session[];
  attempts: number[];
}
export interface DashboardAuthStatus {
  configured: boolean;
  authenticated: boolean;
  mode: "cookie" | "bootstrap" | null;
  secureTransport: boolean;
  canSetup: boolean;
  canAllowInsecureLan: boolean;
  allowInsecureLan: boolean;
  transportMessage: string;
  csrfToken?: string;
  expiresAt?: string;
  remembered?: boolean;
}
const token = () => randomBytes(32).toString("hex");
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const hex = (value: unknown, length = 64): value is string =>
  typeof value === "string" && new RegExp(`^[a-f0-9]{${length}}$`).test(value);
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const same = (a: string, b: string) =>
  Buffer.byteLength(a) === Buffer.byteLength(b) &&
  timingSafeEqual(Buffer.from(a), Buffer.from(b));
const failure = () =>
  new DashboardAuthError(
    "auth_storage",
    "Dashboard sign-in storage is unavailable. Check the server's private configuration directory.",
    503,
  );
const unauthenticated = () =>
  new DashboardAuthError("auth_required", "Sign in to continue.", 401);
const wrongPassword = () =>
  new DashboardAuthError(
    "auth_invalid_password",
    "The password is incorrect.",
    401,
  );
const throttled = () =>
  new DashboardAuthError(
    "auth_rate_limited",
    "Too many sign-in attempts. Wait a minute before trying again.",
    429,
  );
let activeHashes = 0;
const derivePassword = (password: string, salt: string) =>
  new Promise<Buffer>((resolve, reject) => {
    scrypt(
      password,
      Buffer.from(salt, "hex"),
      64,
      { N: 2 ** 17, r: 8, p: 1, maxmem: 256 * 1024 ** 2 },
      (error, result) => (error ? reject(error) : resolve(result)),
    );
  });

export function createDashboardAuth(options: {
  root: string;
  bootstrap: string;
  clock?: () => number;
  /** Test seam; never configured by an HTTP request. */
  derive?: (password: string, salt: string) => Promise<Buffer>;
}) {
  const directory = join(options.root, ".auth"),
    file = join(directory, "dashboard.json");
  const clock = options.clock ?? Date.now,
    derive = options.derive ?? derivePassword;
  function read(): State {
    try {
      safeOAuthPath(file);
      const info = lstatSync(file, { throwIfNoEntry: false });
      if (!info)
        return {
          schema: 1,
          generation: "",
          allowInsecureLan: false,
          sessions: [],
          attempts: [],
        };
      if (
        !info.isFile() ||
        info.nlink !== 1 ||
        info.size > 128 * 1024 ||
        (process.platform !== "win32" && (info.mode & 0o077) !== 0)
      )
        throw new Error();
      const value: unknown = JSON.parse(readFileSync(file, "utf8"));
      if (
        !object(value) ||
        value.schema !== 1 ||
        !hex(value.generation) ||
        typeof value.allowInsecureLan !== "boolean" ||
        (value.password !== undefined &&
          (!object(value.password) ||
            !hex(value.password.salt, 32) ||
            !hex(value.password.digest, 128))) ||
        !Array.isArray(value.sessions) ||
        value.sessions.length > 50 ||
        !Array.isArray(value.attempts) ||
        value.attempts.length > 10 ||
        value.attempts.some((at) => !Number.isSafeInteger(at) || at < 0)
      )
        throw new Error();
      if (
        value.password === undefined &&
        (value.sessions.length || value.allowInsecureLan)
      )
        throw new Error();
      for (const session of value.sessions) {
        if (
          !object(session) ||
          !hex(session.hash) ||
          !hex(session.csrf) ||
          typeof session.origin !== "string" ||
          session.origin.length > 300 ||
          !Number.isSafeInteger(session.createdAt) ||
          !Number.isSafeInteger(session.expiresAt) ||
          Number(session.createdAt) < 0 ||
          Number(session.expiresAt) <= Number(session.createdAt) ||
          typeof session.remembered !== "boolean"
        )
          throw new Error();
        const url = new URL(session.origin);
        if (
          !["http:", "https:"].includes(url.protocol) ||
          url.origin !== session.origin
        )
          throw new Error();
      }
      return value as unknown as State;
    } catch {
      throw failure();
    }
  }
  function change<T>(action: (state: State) => T): T {
    try {
      return withDashboardAuthLock(directory, () => {
        const state = read(),
          result = action(state);
        writePrivate(file, JSON.stringify(state));
        return result;
      });
    } catch (error) {
      if (error instanceof DashboardAuthError) throw error;
      throw failure();
    }
  }
  function bootstrap(req: IncomingMessage): boolean {
    if (req.headers.authorization === undefined) return false;
    if (!same(req.headers.authorization, `Bearer ${options.bootstrap}`))
      throw unauthenticated();
    return true;
  }
  function cookieName(transport: AuthTransport) {
    return transport.origin.startsWith("https:")
      ? "__Host-shipgremlins-session"
      : "shipgremlins-session";
  }
  function current(
    req: IncomingMessage,
    transport: AuthTransport,
    state: State,
  ): Session | undefined {
    if (!transport.secure && !(transport.lan && state.allowInsecureLan))
      return undefined;
    const prefix = `${cookieName(transport)}=`,
      cookies = (req.headers.cookie ?? "")
        .split(";")
        .map((part) => part.trim())
        .filter((part) => part.startsWith(prefix));
    if (cookies.length !== 1) return undefined;
    const raw = cookies[0]!.slice(prefix.length);
    if (!hex(raw)) return undefined;
    return state.sessions.find(
      (session) =>
        session.hash === hash(raw) &&
        session.origin === transport.origin &&
        session.expiresAt > clock(),
    );
  }
  function transportAllowed(transport: AuthTransport, state: State) {
    if (!transport.secure && !(transport.lan && state.allowInsecureLan))
      throw new DashboardAuthError(
        "auth_transport",
        "Use HTTPS or a loopback SSH tunnel. Password sign-in over this private LAN requires the owner's explicit setup confirmation.",
        403,
      );
  }
  function origin(req: IncomingMessage, transport: AuthTransport) {
    if (req.headers.origin !== transport.origin)
      throw new DashboardAuthError(
        "auth_csrf",
        "This sign-in action must come from the dashboard's own address. Reload and try again.",
        403,
      );
  }
  function requireAuth(
    req: IncomingMessage,
    transport: AuthTransport,
  ): { mode: "bootstrap" | "cookie"; session?: Session } {
    if (bootstrap(req)) return { mode: "bootstrap" };
    const state = read(),
      session = current(req, transport, state);
    if (!session) throw unauthenticated();
    if (req.method !== "GET" && req.method !== "HEAD") {
      origin(req, transport);
      const csrf = req.headers["x-csrf-token"];
      if (typeof csrf !== "string" || !same(csrf, session.csrf))
        throw new DashboardAuthError(
          "auth_csrf",
          "Your browser's security check expired. Reload the dashboard and try again.",
          403,
        );
      if (
        !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(
          req.headers["content-type"] ?? "",
        )
      )
        throw new DashboardAuthError(
          "auth_input",
          "Use application/json for dashboard changes.",
          415,
        );
    }
    return { mode: "cookie", session };
  }
  function status(
    req: IncomingMessage,
    transport: AuthTransport,
    issued?: Session,
  ): DashboardAuthStatus {
    const state = read(),
      isBootstrap = issued ? false : bootstrap(req),
      session = issued ?? current(req, transport, state);
    return {
      configured: !!state.password,
      authenticated: isBootstrap || !!session,
      mode: isBootstrap ? "bootstrap" : session ? "cookie" : null,
      secureTransport: transport.secure,
      canSetup:
        isBootstrap && !state.password && (transport.secure || transport.lan),
      canAllowInsecureLan: isBootstrap && !state.password && transport.lan,
      allowInsecureLan: transport.lan && state.allowInsecureLan,
      transportMessage: transport.secure
        ? "This address supports protected password sign-in."
        : transport.lan
          ? "This private LAN connection is not encrypted. Passwords and session cookies can be read by someone on the network. Use HTTPS when possible."
          : "Password sign-in requires HTTPS or a loopback SSH tunnel to this server.",
      ...(session && !isBootstrap
        ? {
            csrfToken: session.csrf,
            expiresAt: new Date(session.expiresAt).toISOString(),
            remembered: session.remembered,
          }
        : {}),
    };
  }
  function setCookie(
    res: ServerResponse,
    transport: AuthTransport,
    raw: string,
    remember: boolean,
  ) {
    res.setHeader(
      "Set-Cookie",
      `${cookieName(transport)}=${raw}; Path=/; HttpOnly; SameSite=Lax${transport.origin.startsWith("https:") ? "; Secure" : ""}${raw ? (remember ? "; Max-Age=2592000" : "") : "; Max-Age=0"}`,
    );
  }
  function issue(state: State, transport: AuthTransport, remember: boolean) {
    const raw = token(),
      createdAt = clock(),
      session: Session = {
        hash: hash(raw),
        csrf: token(),
        origin: transport.origin,
        createdAt,
        expiresAt: createdAt + (remember ? 30 * 86400_000 : 8 * 3600_000),
        remembered: remember,
      };
    state.sessions = state.sessions
      .filter((item) => item.expiresAt > createdAt)
      .slice(-49);
    state.sessions.push(session);
    return { raw, session };
  }
  function password(value: unknown): string {
    if (
      typeof value !== "string" ||
      [...value].length < 15 ||
      [...value].length > 256 ||
      Buffer.byteLength(value) > 1024
    )
      throw new DashboardAuthError(
        "auth_input",
        "Use a passphrase with 15–256 characters.",
        400,
      );
    return value;
  }
  function input(
    value: Record<string, unknown>,
    keys: string[],
    remember = false,
  ) {
    if (
      Object.keys(value).some((key) => !keys.includes(key)) ||
      (remember && typeof value.remember !== "boolean")
    )
      throw new DashboardAuthError(
        "auth_input",
        "Provide only the requested sign-in fields.",
        400,
      );
  }
  async function hashPassword(value: string, salt: string): Promise<string> {
    if (activeHashes >= 2) throw throttled();
    activeHashes++;
    try {
      return (await derive(value, salt)).toString("hex");
    } catch (error) {
      if (error instanceof DashboardAuthError) throw error;
      throw failure();
    } finally {
      activeHashes--;
    }
  }
  function admitAttempt(state: State) {
    state.attempts = state.attempts.filter((at) => at > clock() - 60_000);
    if (state.attempts.length >= 10 || activeHashes >= 2) throw throttled();
    state.attempts.push(clock());
  }
  const api = {
    /** Local CLI recovery only. Never exposed as an HTTP action. */
    resetPassword() {
      change((state) => {
        delete state.password;
        state.generation = token();
        state.sessions = [];
        state.attempts = [];
        state.allowInsecureLan = false;
      });
    },
    status,
    require: requireAuth,
    async handle(
      req: IncomingMessage,
      res: ServerResponse,
      path: string,
      transport: AuthTransport,
      body: () => Promise<Record<string, unknown>>,
    ): Promise<boolean> {
      if (!path.startsWith("/api/auth/")) return false;
      const send = (result: DashboardAuthStatus) => {
        res.writeHead(200, {
          "Content-Type": "application/json; charset=utf-8",
        });
        res.end(JSON.stringify(result));
      };
      if (path === "/api/auth/session" && req.method === "GET") {
        send(status(req, transport));
        return true;
      }
      if (
        req.method !== "POST" ||
        !["setup", "login", "logout", "logout-all", "password"].some(
          (action) => path === `/api/auth/${action}`,
        )
      )
        throw new DashboardAuthError(
          "auth_input",
          "Unknown sign-in action.",
          405,
        );
      origin(req, transport);
      const value = await body();
      if (path === "/api/auth/setup") {
        if (!bootstrap(req)) throw unauthenticated();
        input(value, ["password", "remember", "allowInsecureLan"], true);
        if (
          value.allowInsecureLan !== undefined &&
          typeof value.allowInsecureLan !== "boolean"
        )
          throw new DashboardAuthError(
            "auth_input",
            "Confirm whether to allow unencrypted private LAN sign-in.",
            400,
          );
        const initial = read();
        if (initial.password)
          throw new DashboardAuthError(
            "auth_already_configured",
            "A dashboard password is already configured. Sign in with it instead.",
            409,
          );
        if (
          !transport.secure &&
          !(transport.lan && value.allowInsecureLan === true)
        )
          transportAllowed(transport, initial);
        if (value.allowInsecureLan === true && !transport.lan)
          throw new DashboardAuthError(
            "auth_transport",
            "Unencrypted sign-in can only be enabled from a known private LAN address.",
            403,
          );
        const salt = randomBytes(16).toString("hex"),
          digest = await hashPassword(password(value.password), salt);
        const issued = change((state) => {
          if (state.password)
            throw new DashboardAuthError(
              "auth_already_configured",
              "A dashboard password is already configured. Sign in with it instead.",
              409,
            );
          state.password = { salt, digest };
          state.generation = token();
          state.allowInsecureLan = value.allowInsecureLan === true;
          return issue(state, transport, value.remember === true);
        });
        setCookie(res, transport, issued.raw, value.remember === true);
        send(status(req, transport, issued.session));
        return true;
      }
      if (path === "/api/auth/login") {
        input(value, ["password", "remember"], true);
        bootstrap(req); // A malformed explicit bearer must not silently fall back to cookies.
        const initial = read();
        transportAllowed(transport, initial);
        if (!initial.password)
          throw new DashboardAuthError(
            "auth_setup_required",
            "The owner must set the first password using the existing private dashboard link.",
            409,
          );
        if (
          typeof value.password !== "string" ||
          Buffer.byteLength(value.password) > 1024
        )
          throw wrongPassword();
        change((state) => admitAttempt(state));
        const digest = await hashPassword(
          value.password,
          initial.password.salt,
        );
        if (!same(digest, initial.password.digest)) throw wrongPassword();
        const issued = change((state) => {
          if (state.generation !== initial.generation) throw unauthenticated();
          transportAllowed(transport, state);
          return issue(state, transport, value.remember === true);
        });
        setCookie(res, transport, issued.raw, value.remember === true);
        send(status(req, transport, issued.session));
        return true;
      }
      const authenticated = requireAuth(req, transport);
      if (path === "/api/auth/password") {
        input(value, ["currentPassword", "password", "remember"], true);
        const initial = read();
        transportAllowed(transport, initial);
        if (!initial.password)
          throw new DashboardAuthError(
            "auth_setup_required",
            "Set the first dashboard password before changing it.",
            409,
          );
        if (
          typeof value.currentPassword !== "string" ||
          Buffer.byteLength(value.currentPassword) > 1024
        )
          throw wrongPassword();
        const replacement = password(value.password);
        change((state) => admitAttempt(state));
        if (
          !same(
            await hashPassword(value.currentPassword, initial.password.salt),
            initial.password.digest,
          )
        )
          throw wrongPassword();
        const salt = randomBytes(16).toString("hex"),
          digest = await hashPassword(replacement, salt);
        const issued = change((state) => {
          if (
            state.generation !== initial.generation ||
            (authenticated.session && !current(req, transport, state))
          )
            throw unauthenticated();
          state.password = { salt, digest };
          state.generation = token();
          state.sessions = [];
          state.attempts = [];
          return issue(state, transport, value.remember === true);
        });
        setCookie(res, transport, issued.raw, value.remember === true);
        send(status(req, transport, issued.session));
        return true;
      }
      input(value, []);
      if (read().password)
        change((state) => {
          if (path === "/api/auth/logout-all") {
            state.sessions = [];
            state.generation = token();
          } else if (authenticated.session)
            state.sessions = state.sessions.filter(
              (item) => item.hash !== authenticated.session!.hash,
            );
        });
      setCookie(res, transport, "", false);
      send({
        ...status(req, transport),
        authenticated: false,
        mode: null,
        csrfToken: undefined,
        expiresAt: undefined,
        remembered: undefined,
      });
      return true;
    },
  };
  return api;
}
