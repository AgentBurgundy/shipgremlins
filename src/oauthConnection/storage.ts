import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  mkdir,
  readFile,
  writeFile,
  rename,
  unlink,
  open,
  lstat,
} from "node:fs/promises";
import { lstatSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { OAuthConnectionError, type OAuthProvider } from "./types.ts";

export interface SavedConnection {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  clientId?: string;
  refreshStartedAt?: number;
  verifiedAt?: number;
  needsReconnect?: boolean;
  scopes?: string[];
  workspace: { id: string; name: string };
  account: { id: string; name: string };
  teamId?: string | null;
  configurationId?: string;
  leases: Array<{ jobId: string; expiresAt: number }>;
}
export interface PendingConnection {
  key: string;
  nonce: string;
  sessionHash: string;
  expiresAt: number;
  verifier?: string;
  clientId?: string;
  redirectUri: string;
  exchanging?: boolean;
  received?: SavedConnection;
}
export interface OAuthState {
  schema: 1;
  connection?: SavedConnection;
  pending?: PendingConnection;
}
const execFileAsync = promisify(execFile);
let ownerSid: Promise<string> | undefined;
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
export const validToken = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= 16384 &&
  !/[\s\0]/.test(value);
const identity = (value: unknown) =>
  object(value) &&
  typeof value.id === "string" &&
  value.id.length <= 200 &&
  typeof value.name === "string" &&
  value.name.length <= 200;
function validate(value: unknown): OAuthState {
  if (!object(value) || value.schema !== 1) throw new Error();
  const connection = value.connection,
    pending = value.pending;
  if (
    connection !== undefined &&
    (!object(connection) ||
      !validToken(connection.accessToken) ||
      !identity(connection.workspace) ||
      !identity(connection.account) ||
      !Array.isArray(connection.leases) ||
      connection.leases.length > 1000 ||
      connection.leases.some(
        (lease) =>
          !object(lease) ||
          typeof lease.jobId !== "string" ||
          typeof lease.expiresAt !== "number",
      ))
  )
    throw new Error();
  if (
    pending !== undefined &&
    (!object(pending) ||
      typeof pending.key !== "string" ||
      !/^[A-Za-z0-9_-]{43}$/.test(pending.key) ||
      typeof pending.nonce !== "string" ||
      typeof pending.sessionHash !== "string" ||
      typeof pending.expiresAt !== "number" ||
      typeof pending.redirectUri !== "string")
  )
    throw new Error();
  return value as unknown as OAuthState;
}
function safePath(file: string): string {
  for (let current = resolve(file); ;) {
    if (lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink())
      throw new OAuthConnectionError(
        "OAuth connection paths cannot contain symbolic links.",
        "storage_error",
      );
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return file;
}
async function privateFile(file: string, content: Buffer | string) {
  const temporary = `${file}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    safePath(file);
    await writeFile(temporary, "", { flag: "wx", mode: 0o600 });
    if (process.platform === "win32") {
      ownerSid ??= execFileAsync("whoami.exe", ["/user", "/fo", "csv", "/nh"], {
        windowsHide: true,
        timeout: 5000,
        maxBuffer: 16_384,
      }).then(({ stdout }) => {
        const sid = stdout.match(/S-1-(?:\d+-)+\d+/)?.[0];
        if (!sid) throw new Error();
        return sid;
      });
      await execFileAsync(
        "icacls.exe",
        [temporary, "/inheritance:r", "/grant:r", `*${await ownerSid}:(F)`],
        { windowsHide: true, timeout: 5000, maxBuffer: 16_384 },
      );
    }
    await writeFile(temporary, content, { mode: 0o600 });
    safePath(file);
    await rename(temporary, file);
  } catch {
    throw new OAuthConnectionError(
      "OAuth credentials could not be saved privately. Check configuration folder permissions.",
      "storage_error",
    );
  } finally {
    await unlink(temporary).catch(() => {});
  }
}
/** Tokens remain local; the separate key must accompany encrypted state in backups. */
export function createOAuthStore(root: string, provider: OAuthProvider) {
  if (!["linear", "vercel"].includes(provider))
    throw new OAuthConnectionError("Invalid OAuth provider.");
  const directory = join(resolve(root), ".run", "oauth", provider);
  const stateFile = join(directory, "connection.enc"),
    keyFile = join(directory, "key"),
    lockFile = join(directory, "state.lock");
  const aad = Buffer.from(`shipgremlins-${provider}-storage-v1`);
  async function encryptionKey(create = false) {
    try {
      const value = await readFile(safePath(keyFile));
      if (value.length !== 32) throw new Error();
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (!create) throw new Error();
      const value = randomBytes(32);
      await privateFile(keyFile, value);
      return value;
    }
  }
  async function read(): Promise<OAuthState> {
    try {
      const info = await lstat(safePath(stateFile));
      if (!info.isFile() || info.size > 512 * 1024) throw new Error();
      const bytes = await readFile(stateFile);
      const decipher = createDecipheriv(
        "aes-256-gcm",
        await encryptionKey(),
        bytes.subarray(0, 12),
      );
      decipher.setAAD(aad);
      decipher.setAuthTag(bytes.subarray(12, 28));
      return validate(
        JSON.parse(
          Buffer.concat([
            decipher.update(bytes.subarray(28)),
            decipher.final(),
          ]).toString("utf8"),
        ),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return { schema: 1 };
      throw new OAuthConnectionError(
        "Saved OAuth credentials could not be read. Restore this provider's OAuth folder and encryption key from backup.",
        "storage_error",
      );
    }
  }
  async function save(value: OAuthState) {
    validate(value);
    const iv = randomBytes(12),
      cipher = createCipheriv("aes-256-gcm", await encryptionKey(true), iv);
    cipher.setAAD(aad);
    const bytes = Buffer.concat([
      cipher.update(JSON.stringify(value)),
      cipher.final(),
    ]);
    await privateFile(
      stateFile,
      Buffer.concat([iv, cipher.getAuthTag(), bytes]),
    );
  }
  async function locked<T>(
    operation: (
      state: OAuthState,
      save: (state: OAuthState) => Promise<void>,
    ) => Promise<T>,
  ): Promise<T> {
    safePath(lockFile);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    for (let attempt = 0; attempt < 200; attempt++) {
      try {
        handle = await open(safePath(lockFile), "wx", 0o600);
        await handle.writeFile(JSON.stringify({ pid: process.pid }));
        break;
      } catch (error) {
        if (handle) {
          await handle.close().catch(() => {});
          await unlink(lockFile).catch(() => {});
          handle = undefined;
        }
        if ((error as NodeJS.ErrnoException).code !== "EEXIST")
          throw new OAuthConnectionError(
            "OAuth state is not writable.",
            "storage_error",
          );
        try {
          const info = await lstat(safePath(lockFile));
          const lock = JSON.parse(await readFile(lockFile, "utf8")) as {
            pid?: number;
          };
          let alive = true;
          try {
            if (!Number.isSafeInteger(lock.pid)) throw new Error();
            process.kill(lock.pid!, 0);
          } catch (error) {
            alive = (error as NodeJS.ErrnoException).code === "EPERM";
          }
          if (
            (!alive && info.mtimeMs < Date.now() - 1000) ||
            info.mtimeMs < Date.now() - 20 * 60_000
          ) {
            await unlink(lockFile);
            continue;
          }
        } catch {
          /* Another writer can release its lock during inspection. */
        }
        await new Promise((done) => setTimeout(done, 50));
      }
    }
    if (!handle)
      throw new OAuthConnectionError(
        "Another process is updating this connection. Retry shortly.",
        "busy",
        409,
      );
    try {
      return await operation(await read(), save);
    } finally {
      await handle.close();
      await unlink(lockFile).catch(() => {});
    }
  }
  return { read, locked };
}
