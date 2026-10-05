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
import { normalizeConnectionId } from "./profileId.ts";

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
  /** Retired named IDs cannot be rebound to another account by a stale request. */
  deleted?: true;
  label?: string;
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
  if (
    value.deleted !== undefined &&
    (value.deleted !== true ||
      value.label !== undefined ||
      value.connection !== undefined ||
      value.pending !== undefined)
  )
    throw new Error();
  if (
    value.label !== undefined &&
    (typeof value.label !== "string" ||
      !value.label.trim() ||
      value.label.length > 100 ||
      [...value.label].some(
        (character) =>
          character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
      ))
  )
    throw new Error();
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
export function safeOAuthPath(file: string): string {
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
const safePath = safeOAuthPath;
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
export function createOAuthStore(
  root: string,
  provider: OAuthProvider,
  connectionId?: string,
) {
  if (!["linear", "vercel"].includes(provider))
    throw new OAuthConnectionError("Invalid OAuth provider.");
  const id = normalizeConnectionId(connectionId);
  const directory = join(
    resolve(root),
    ".run",
    "oauth",
    provider,
    ...(id === "default" ? [] : ["connections", id]),
  );
  const stateFile = join(directory, "connection.enc"),
    keyFile = join(directory, "key"),
    lockFile = join(directory, "state.lock");
  const aad = Buffer.from(
    `shipgremlins-${provider}-storage-v1${id === "default" ? "" : `:${id}`}`,
  );
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
    let deniedAttempts = 0;
    const lockToken = randomBytes(16).toString("hex");
    const notWritable = () =>
      new OAuthConnectionError("OAuth state is not writable.", "storage_error");
    async function release(owned: Awaited<ReturnType<typeof open>>) {
      const identity = await owned.stat().catch(() => undefined);
      await owned.close();
      try {
        const info = await lstat(safePath(lockFile));
        if (
          identity &&
          info.isFile() &&
          info.nlink === 1 &&
          info.ino === identity.ino &&
          info.dev === identity.dev
        )
          await unlink(lockFile);
      } catch {
        // Never remove a replacement or unsafe lock to recover a failed release.
      }
    }
    for (let attempt = 0; attempt < 200; attempt++) {
      try {
        handle = await open(safePath(lockFile), "wx", 0o600);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (
          process.platform === "win32" &&
          (code === "EPERM" || code === "EACCES") &&
          deniedAttempts < 8
        ) {
          // Windows can deny CREATE_NEW while the previous lock is delete-pending.
          // Retry only acquisition; never infer ownership or delete on this error.
          const delay = Math.min(25 * 2 ** deniedAttempts++, 200);
          await new Promise((done) => setTimeout(done, delay));
          continue;
        }
        if (code !== "EEXIST") throw notWritable();
        try {
          const info = await lstat(safePath(lockFile));
          if (!info.isFile() || info.nlink !== 1 || info.size > 1024)
            throw notWritable();
          const content = await readFile(lockFile, "utf8");
          const lock = JSON.parse(content) as {
            pid?: number;
          };
          let dead = false;
          try {
            if (!Number.isSafeInteger(lock.pid) || lock.pid! < 1)
              throw new Error();
            process.kill(lock.pid!, 0);
          } catch (error) {
            dead = (error as NodeJS.ErrnoException).code === "ESRCH";
          }
          if (dead && info.mtimeMs < Date.now() - 1000) {
            const current = await lstat(safePath(lockFile));
            if (
              current.isFile() &&
              current.nlink === 1 &&
              current.ino === info.ino &&
              current.dev === info.dev &&
              (await readFile(lockFile, "utf8")) === content
            ) {
              await unlink(lockFile);
              continue;
            }
          }
        } catch (error) {
          if (error instanceof OAuthConnectionError) throw error;
          /* Another writer can release its lock during inspection. */
        }
        await new Promise((done) => setTimeout(done, 50));
        continue;
      }
      try {
        await handle.writeFile(
          JSON.stringify({ pid: process.pid, token: lockToken }),
        );
      } catch {
        await release(handle).catch(() => {});
        throw notWritable();
      }
      break;
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
      await release(handle);
    }
  }
  return { read, locked };
}
