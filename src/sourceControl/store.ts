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
import { join, resolve } from "node:path";
import { assertNoSymlinks } from "../setup/files.ts";
import {
  SourceControlError,
  type DeviceFlow,
  type SourceProvider,
} from "./types.ts";

export interface SavedConnection {
  provider: SourceProvider;
  serverUrl: string;
  clientId: string;
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  refreshExpiresAt?: number;
  account: { id: string; login: string; name?: string };
  needsReconnect?: boolean;
  refreshing?: boolean;
  repositoryId?: string;
  leases: Array<{ jobId: string; expiresAt: number }>;
}
export interface PendingConnection {
  flow: DeviceFlow;
  deviceCode: string;
  clientId: string;
  serverUrl: string;
  sessionHash: string;
  nextPollAt: number;
  repositoryId?: string;
}
export interface SourceState {
  schema: 1;
  connections: Record<string, SavedConnection>;
  pending: Record<string, PendingConnection>;
}
const empty = (): SourceState => ({ schema: 1, connections: {}, pending: {} });
const execFileAsync = promisify(execFile);
let ownerSid: Promise<string> | undefined;
async function privateFile(file: string, content: Buffer | string) {
  const temp = `${file}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    assertNoSymlinks(file);
    await writeFile(temp, "", { flag: "wx", mode: 0o600 });
    if (process.platform === "win32") {
      ownerSid ??= execFileAsync("whoami.exe", ["/user", "/fo", "csv", "/nh"], {
        windowsHide: true,
      }).then(({ stdout }) => {
        const sid = stdout.match(/S-1-(?:\d+-)+\d+/)?.[0];
        if (!sid) throw new Error();
        return sid;
      });
      await execFileAsync(
        "icacls.exe",
        [temp, "/inheritance:r", "/grant:r", `*${await ownerSid}:(F)`],
        { windowsHide: true },
      );
    }
    await writeFile(temp, content, { mode: 0o600 });
    assertNoSymlinks(file);
    await rename(temp, file);
  } catch {
    throw new SourceControlError(
      "Source connection state could not be saved privately. Check configuration folder permissions.",
      "storage_error",
    );
  } finally {
    await unlink(temp).catch(() => {});
  }
}
function safePath(path: string) {
  assertNoSymlinks(path);
  return path;
}
function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function validate(value: unknown): SourceState {
  if (
    !isObject(value) ||
    value.schema !== 1 ||
    !isObject(value.connections) ||
    !isObject(value.pending) ||
    Object.keys(value.connections).length > 50 ||
    Object.keys(value.pending).length > 10
  )
    throw new Error();
  for (const connection of Object.values(value.connections)) {
    if (
      !isObject(connection) ||
      !["github", "gitlab"].includes(String(connection.provider)) ||
      typeof connection.serverUrl !== "string" ||
      typeof connection.clientId !== "string" ||
      typeof connection.accessToken !== "string" ||
      !isObject(connection.account) ||
      typeof connection.account.login !== "string" ||
      !Array.isArray(connection.leases)
    )
      throw new Error();
  }
  return value as unknown as SourceState;
}

export function createSourceStore(root: string) {
  const directory = join(resolve(root), ".run", "source-control");
  const stateFile = join(directory, "connections.enc"),
    keyFile = join(directory, "key"),
    lockFile = join(directory, "state.lock");
  async function key(create = false): Promise<Buffer | null> {
    try {
      const value = await readFile(safePath(keyFile));
      if (value.length !== 32) throw new Error();
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (!create) return null;
      const value = randomBytes(32);
      await privateFile(keyFile, value);
      return value;
    }
  }
  async function read(): Promise<SourceState> {
    try {
      const info = await lstat(safePath(stateFile));
      if (
        !info.isFile() ||
        info.isSymbolicLink() ||
        info.size > 2 * 1024 * 1024
      )
        throw new Error();
      const secret = await key();
      if (!secret) throw new Error();
      const bytes = await readFile(stateFile);
      if (bytes.length < 29) throw new Error();
      const cipher = createDecipheriv(
        "aes-256-gcm",
        secret,
        bytes.subarray(0, 12),
      );
      cipher.setAAD(Buffer.from("shipgremlins-source-v1"));
      cipher.setAuthTag(bytes.subarray(12, 28));
      return validate(
        JSON.parse(
          Buffer.concat([
            cipher.update(bytes.subarray(28)),
            cipher.final(),
          ]).toString("utf8"),
        ),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return empty();
      throw new SourceControlError(
        "Saved source connections could not be read. Restore the source-control folder and encryption key from backup.",
        "storage_error",
      );
    }
  }
  async function save(state: SourceState) {
    const secret = await key(true);
    if (!secret) throw new Error();
    const iv = randomBytes(12),
      cipher = createCipheriv("aes-256-gcm", secret, iv);
    cipher.setAAD(Buffer.from("shipgremlins-source-v1"));
    const encrypted = Buffer.concat([
      cipher.update(JSON.stringify(state)),
      cipher.final(),
    ]);
    await privateFile(
      stateFile,
      Buffer.concat([iv, cipher.getAuthTag(), encrypted]),
    );
  }
  async function locked<T>(
    fn: (
      state: SourceState,
      save: (state: SourceState) => Promise<void>,
    ) => Promise<T>,
  ): Promise<T> {
    safePath(lockFile);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    for (let attempt = 0; attempt < 200; attempt++)
      try {
        handle = await open(lockFile, "wx", 0o600);
        await handle.writeFile(
          JSON.stringify({ pid: process.pid, createdAt: Date.now() }),
        );
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST")
          throw new SourceControlError(
            "Source connection state is not writable.",
            "storage_error",
          );
        try {
          const info = await lstat(safePath(lockFile));
          if (info.isSymbolicLink()) throw new Error();
          const lock = JSON.parse(await readFile(lockFile, "utf8")) as {
            pid?: number;
            createdAt?: number;
          };
          let alive = true;
          try {
            if (!Number.isSafeInteger(lock.pid)) throw new Error();
            process.kill(lock.pid!, 0);
          } catch {
            alive = false;
          }
          if (
            (!alive && info.mtimeMs < Date.now() - 1000) ||
            info.mtimeMs < Date.now() - 20 * 60000
          ) {
            await unlink(lockFile);
            continue;
          }
        } catch {
          /* A concurrent writer can release its lock between reads. */
        }
        await new Promise((done) => setTimeout(done, 50));
      }
    if (!handle)
      throw new SourceControlError(
        "Another process is updating this source connection. Retry shortly.",
        "busy",
        409,
      );
    try {
      return await fn(await read(), save);
    } finally {
      await handle.close();
      await unlink(lockFile).catch(() => {});
    }
  }
  return { read, locked };
}
