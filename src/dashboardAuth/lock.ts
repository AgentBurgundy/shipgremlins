import {
  closeSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { safeOAuthPath } from "../oauthConnection/storage.ts";

function exclusive(file: string): () => void {
  const fd = openSync(file, "wx", 0o600);
  const created = fstatSync(fd, { bigint: true });
  const release = () => {
    try {
      const current = lstatSync(file, { bigint: true, throwIfNoEntry: false });
      if (
        current?.isFile() &&
        current.nlink === 1n &&
        current.dev === created.dev &&
        current.ino === created.ino
      )
        unlinkSync(file);
    } finally {
      closeSync(fd);
    }
  };
  try {
    writeFileSync(fd, JSON.stringify({ pid: process.pid }));
  } catch (error) {
    try {
      release();
    } catch {
      /* Preserve the original initialization failure. */
    }
    throw error;
  }
  return release;
}
const exists = (path: string) => !!lstatSync(path, { throwIfNoEntry: false });
function deadOwner(file: string): boolean {
  const info = lstatSync(file, { throwIfNoEntry: false });
  if (!info?.isFile() || info.nlink !== 1 || info.size > 100) return false;
  try {
    const owner = JSON.parse(readFileSync(file, "utf8"));
    if (!Number.isSafeInteger(owner.pid) || owner.pid < 1) return false;
    try {
      process.kill(owner.pid, 0);
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ESRCH";
    }
  } catch {
    /* Malformed or inaccessible locks require operator repair. */
  }
  return false;
}
/** Synchronous cross-process read/modify/write, with serialized dead-owner reclamation. */
export function withDashboardAuthLock<T>(
  directory: string,
  action: () => T,
): T {
  safeOAuthPath(directory);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const lock = safeOAuthPath(join(directory, "write.lock")),
    guard = safeOAuthPath(join(directory, "reclaim.lock"));
  const busy = () => new Error("Dashboard authentication store is busy.");
  if (exists(guard)) throw busy();
  let release: () => void;
  try {
    release = exclusive(lock);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    // A second reclaimer cannot remove a first writer's replacement lock.
    // Writers check this guard again after exclusive creation, before touching state.
    const releaseGuard = exclusive(guard);
    try {
      if (deadOwner(lock)) unlinkSync(lock);
    } finally {
      releaseGuard();
    }
    if (exists(guard)) throw busy();
    release = exclusive(lock);
  }
  try {
    if (exists(guard)) throw busy();
    return action();
  } finally {
    release();
  }
}
