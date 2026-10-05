import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { safeOAuthPath } from "../oauthConnection/storage.ts";

export class RemoteWorkerError extends Error {
  constructor(
    message: string,
    public readonly status = 400,
  ) {
    super(message);
    this.name = "RemoteWorkerError";
  }
}
export function validRemoteArtifactName(name: string): boolean {
  return (
    name.length <= 300 &&
    name.split("/").length <= 4 &&
    name
      .split("/")
      .every(
        (part) =>
          /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(part) &&
          !part.includes("..") &&
          !part.endsWith(".") &&
          !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
      )
  );
}
let sid: string | undefined;
export function writePrivate(file: string, content: string | Buffer) {
  safeOAuthPath(file);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomBytes(8).toString("hex")}.tmp`;
  try {
    writeFileSync(temporary, "", { flag: "wx", mode: 0o600 });
    if (process.platform === "win32") {
      sid ??= execFileSync("whoami.exe", ["/user", "/fo", "csv", "/nh"], {
        windowsHide: true,
        timeout: 5000,
        encoding: "utf8",
      }).match(/S-1-(?:\d+-)+\d+/)?.[0];
      if (!sid) throw new Error();
      execFileSync(
        "icacls.exe",
        [temporary, "/inheritance:r", "/grant:r", `*${sid}:(F)`],
        { windowsHide: true, timeout: 5000, stdio: "ignore" },
      );
    }
    writeFileSync(temporary, content);
    renameSync(temporary, file);
  } catch {
    throw new RemoteWorkerError(
      "Remote worker storage could not be saved. Check the configuration directory permissions.",
      503,
    );
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}
export function createPrivateStore<T>(root: string, empty: () => T) {
  const directory = safeOAuthPath(join(root, ".run", "remote-workers"));
  const file = join(directory, "registry.enc"),
    keyFile = join(directory, "key"),
    lock = join(directory, "write.lock");
  function key() {
    safeOAuthPath(keyFile);
    if (!existsSync(keyFile)) writePrivate(keyFile, randomBytes(32));
    const bytes = readFileSync(keyFile);
    if (bytes.length !== 32)
      throw new RemoteWorkerError(
        "Remote worker encryption key is invalid. Restore its protected backup.",
        503,
      );
    return bytes;
  }
  function read(): T {
    safeOAuthPath(file);
    if (!existsSync(file)) return empty();
    try {
      const buffer = readFileSync(file);
      if (buffer.length > 64 * 1024 * 1024) throw new Error();
      const decipher = createDecipheriv(
        "aes-256-gcm",
        key(),
        buffer.subarray(0, 12),
      );
      decipher.setAAD(Buffer.from("shipgremlins-remote-registry-v1"));
      decipher.setAuthTag(buffer.subarray(12, 28));
      return JSON.parse(
        Buffer.concat([
          decipher.update(buffer.subarray(28)),
          decipher.final(),
        ]).toString("utf8"),
      ) as T;
    } catch {
      throw new RemoteWorkerError(
        "Remote worker state could not be read. Restore its protected registry and key together.",
        503,
      );
    }
  }
  function change<R>(action: (state: T) => R): R {
    safeOAuthPath(directory);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    safeOAuthPath(lock);
    if (existsSync(lock)) {
      try {
        const owner = JSON.parse(readFileSync(lock, "utf8"));
        if (!Number.isSafeInteger(owner.pid) || owner.pid < 1)
          throw new Error();
        try {
          process.kill(owner.pid, 0);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ESRCH")
            unlinkSync(lock);
        }
      } catch {
        /* An unreadable live lock stays closed. */
      }
    }
    try {
      writeFileSync(lock, JSON.stringify({ pid: process.pid }), {
        flag: "wx",
        mode: 0o600,
      });
    } catch {
      throw new RemoteWorkerError(
        "Remote worker state is busy. Try again shortly.",
        409,
      );
    }
    try {
      const state = read();
      const result = action(state);
      const iv = randomBytes(12),
        cipher = createCipheriv("aes-256-gcm", key(), iv);
      cipher.setAAD(Buffer.from("shipgremlins-remote-registry-v1"));
      const encrypted = Buffer.concat([
        cipher.update(JSON.stringify(state)),
        cipher.final(),
      ]);
      writePrivate(file, Buffer.concat([iv, cipher.getAuthTag(), encrypted]));
      return result;
    } finally {
      unlinkSync(lock);
    }
  }
  return { read, change, directory };
}
