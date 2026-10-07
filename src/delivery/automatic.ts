import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

export interface AutomaticPromotion {
  project: string;
  area: string;
  /** SHA-256 of verified delivery IDs, review manifests, batch target and staging baseline. */
  key: string;
}
interface Claim {
  key: string;
  pid: number;
  token: string;
}
interface Slot {
  project: string;
  area: string;
  queued?: string;
  running?: Claim;
  finished?: string;
  retryAt?: number;
  retries?: number;
}
interface State {
  schema: 1;
  slots: Slot[];
}
export class AutomaticPromotionError extends Error {
  constructor(
    message: string,
    readonly status = 503,
  ) {
    super(message);
    this.name = "AutomaticPromotionError";
  }
}
const MAX_BYTES = 256 * 1024;
const DIGEST = /^[a-f0-9]{64}$/;
const NAME = /^[a-z][a-z0-9-]{0,62}$/;
const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const digest = (value: unknown): value is string =>
  typeof value === "string" && DIGEST.test(value);
const name = (value: unknown): value is string =>
  typeof value === "string" && NAME.test(value) && !RESERVED.test(value);
const pid = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) > 0;
const only = (value: Record<string, unknown>, keys: string[]) =>
  Object.keys(value).every((key) => keys.includes(key));
function validClaim(value: unknown): value is Claim {
  return (
    object(value) &&
    only(value, ["key", "pid", "token"]) &&
    digest(value.key) &&
    pid(value.pid) &&
    digest(value.token)
  );
}
function validItem(value: AutomaticPromotion) {
  if (!name(value.project) || !name(value.area) || !digest(value.key))
    throw new AutomaticPromotionError(
      "Automatic promotion requires valid project, PM, and verification identifiers.",
      400,
    );
}
function validate(value: unknown): State {
  if (
    !object(value) ||
    !only(value, ["schema", "slots"]) ||
    value.schema !== 1 ||
    !Array.isArray(value.slots) ||
    value.slots.length > 200
  )
    throw new Error();
  const seen = new Set<string>();
  for (const slot of value.slots) {
    if (
      !object(slot) ||
      !only(slot, [
        "project",
        "area",
        "queued",
        "running",
        "finished",
        "retryAt",
        "retries",
      ]) ||
      !name(slot.project) ||
      !name(slot.area) ||
      (slot.queued !== undefined && !digest(slot.queued)) ||
      (slot.finished !== undefined && !digest(slot.finished)) ||
      (slot.running !== undefined && !validClaim(slot.running)) ||
      (slot.retryAt !== undefined &&
        (!Number.isSafeInteger(slot.retryAt) || Number(slot.retryAt) < 0)) ||
      (slot.retries !== undefined &&
        (!Number.isSafeInteger(slot.retries) ||
          Number(slot.retries) < 0 ||
          Number(slot.retries) > 10)) ||
      (!slot.queued && !slot.running && !slot.finished) ||
      (slot.running && slot.queued === slot.running.key)
    )
      throw new Error();
    const identity = `${slot.project}/${slot.area}`;
    if (seen.has(identity)) throw new Error();
    seen.add(identity);
  }
  return value as unknown as State;
}
function safePath(file: string) {
  for (let current = resolve(file); ; current = dirname(current)) {
    if (lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink())
      throw new Error();
    if (dirname(current) === current) break;
  }
}
function safeFile(file: string, maxBytes: number) {
  safePath(file);
  const info = lstatSync(file, { throwIfNoEntry: false });
  if (info && (!info.isFile() || info.nlink !== 1 || info.size > maxBytes))
    throw new Error();
  return info;
}
function readBounded(file: string, maximum: number): string | undefined {
  const expected = safeFile(file, maximum);
  if (!expected) return undefined;
  const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = fstatSync(fd);
    if (
      !info.isFile() ||
      info.nlink !== 1 ||
      info.size > maximum ||
      info.ino !== expected.ino ||
      info.dev !== expected.dev
    )
      throw new Error();
    const content = readFileSync(fd);
    if (content.length > maximum) throw new Error();
    return content.toString("utf8");
  } finally {
    closeSync(fd);
  }
}
function ownerIsDead(owner: number) {
  try {
    process.kill(owner, 0);
    return false;
  } catch (error) {
    // Permission errors or a reused PID are not proof that the owner exited.
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}
let ownerSid: string | undefined;
function protect(file: string) {
  if (process.platform !== "win32") return;
  ownerSid ??= execFileSync("whoami.exe", ["/user", "/fo", "csv", "/nh"], {
    windowsHide: true,
    timeout: 5000,
    encoding: "utf8",
  }).match(/S-1-(?:\d+-)+\d+/)?.[0];
  if (!ownerSid) throw new Error();
  execFileSync(
    "icacls.exe",
    [file, "/inheritance:r", "/grant:r", `*${ownerSid}:(F)`],
    { windowsHide: true, timeout: 5000, stdio: "ignore" },
  );
}

/** Durable latest-intent queue. No delivery or provider mutations happen here. */
export function createAutomaticPromotions({
  root,
  now = Date.now,
}: {
  root: string;
  now?: () => number;
}) {
  const directory = join(resolve(root), ".run", "delivery"),
    file = join(directory, "automatic.json"),
    lock = join(directory, "automatic.lock");
  function read(): State {
    try {
      const content = readBounded(file, MAX_BYTES);
      return content === undefined
        ? { schema: 1, slots: [] }
        : validate(JSON.parse(content));
    } catch {
      throw new AutomaticPromotionError(
        "Automatic promotion state cannot be read safely. Existing data was preserved; restore its saved backup before retrying.",
      );
    }
  }
  function change<R>(action: (state: State) => R): R {
    let handle: number | undefined;
    let lockIdentity: { ino: number; dev: number } | undefined;
    const lockToken = randomBytes(32).toString("hex"),
      temporary = join(directory, `.automatic-${lockToken}.tmp`);
    try {
      safePath(directory);
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const existing = readBounded(lock, 1024);
      if (existing !== undefined) {
        const owner: unknown = JSON.parse(existing);
        if (!object(owner) || !pid(owner.pid) || !digest(owner.token))
          throw new AutomaticPromotionError(
            "Automatic promotion storage has an unreadable lock. Check the controller process before repairing it.",
            409,
          );
        if (ownerIsDead(owner.pid)) {
          // Re-read just before removing: another process may have recovered it.
          if (readBounded(lock, 1024) === existing) unlinkSync(lock);
        }
      }
      try {
        handle = openSync(lock, "wx", 0o600);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        throw new AutomaticPromotionError(
          "Automatic promotion state is busy. Retry shortly.",
          409,
        );
      }
      lockIdentity = fstatSync(handle);
      protect(lock);
      writeFileSync(
        handle,
        JSON.stringify({ pid: process.pid, token: lockToken }),
      );
      fsyncSync(handle);
      const state = read(),
        before = JSON.stringify(state),
        result = action(state),
        serialized = JSON.stringify(validate(state)) + "\n";
      if (Buffer.byteLength(serialized, "utf8") > MAX_BYTES) throw new Error();
      if (serialized !== before + "\n") {
        safePath(temporary);
        const fd = openSync(temporary, "wx", 0o600);
        try {
          protect(temporary);
          writeFileSync(fd, serialized);
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
        safeFile(file, MAX_BYTES);
        renameSync(temporary, file);
        if (process.platform !== "win32") {
          const parent = openSync(directory, "r");
          try {
            fsyncSync(parent);
          } finally {
            closeSync(parent);
          }
        }
      }
      return result;
    } catch (error) {
      if (error instanceof AutomaticPromotionError) throw error;
      throw new AutomaticPromotionError(
        "Automatic promotion state could not be saved safely. Check configuration directory permissions; existing intents were preserved.",
      );
    } finally {
      if (handle !== undefined) {
        closeSync(handle);
        // Never delete a lock that another controller owns.
        try {
          const info = safeFile(lock, 1024);
          if (
            info &&
            info.ino === lockIdentity?.ino &&
            info.dev === lockIdentity.dev
          ) {
            const content = readBounded(lock, 1024);
            if (
              content === "" ||
              content === JSON.stringify({ pid: process.pid, token: lockToken })
            )
              unlinkSync(lock);
          }
        } catch {
          // An unsafe replacement stays closed; do not hide the original error.
        }
      }
      if (lstatSync(temporary, { throwIfNoEntry: false }))
        unlinkSync(temporary);
    }
  }
  function enqueue(project: string, area: string, key: string): void {
    validItem({ project, area, key });
    change((state) => {
      let slot = state.slots.find(
        (s) => s.project === project && s.area === area,
      );
      if (!slot) {
        if (state.slots.length >= 200)
          throw new AutomaticPromotionError(
            "Automatic promotion storage has reached its 200 project/PM limit. Existing intents were preserved.",
            409,
          );
        slot = { project, area, queued: key };
        state.slots.push(slot);
      } else if (
        key !== slot.queued &&
        key !== slot.running?.key &&
        key !== slot.finished
      ) {
        // A newer verification snapshot supersedes work that has not started.
        slot.queued = key;
        delete slot.retryAt;
        delete slot.retries;
      }
    });
  }
  function pending({
    readyOnly = false,
  }: { readyOnly?: boolean } = {}): AutomaticPromotion[] {
    return read().slots.flatMap((slot) => {
      if (readyOnly && slot.retryAt && slot.retryAt > now()) return [];
      const key = slot.running?.key ?? slot.queued;
      return key ? [{ project: slot.project, area: slot.area, key }] : [];
    });
  }
  function claim(item: AutomaticPromotion): string | null {
    validItem(item);
    return change((state) => {
      const slot = state.slots.find(
        (s) => s.project === item.project && s.area === item.area,
      );
      if (!slot) return null;
      if (slot.retryAt && slot.retryAt > now()) return null;
      if (slot.running) {
        if (slot.running.key !== item.key || !ownerIsDead(slot.running.pid))
          return null;
      } else if (slot.queued !== item.key) return null;
      const token = randomBytes(32).toString("hex");
      slot.running = { key: item.key, token, pid: process.pid };
      if (slot.queued === item.key) delete slot.queued;
      return token;
    });
  }
  function finish(
    item: AutomaticPromotion,
    token: string,
    { retry = false }: { retry?: boolean } = {},
  ): void {
    validItem(item);
    if (!digest(token)) return;
    change((state) => {
      const slot = state.slots.find(
        (s) => s.project === item.project && s.area === item.area,
      );
      if (
        slot?.running?.key !== item.key ||
        slot.running.token !== token ||
        slot.running.pid !== process.pid
      )
        return;
      delete slot.running;
      if (retry && (!slot.queued || slot.queued === item.key)) {
        slot.queued = item.key;
        slot.retries = Math.min(10, (slot.retries ?? 0) + 1);
        slot.retryAt =
          now() + Math.min(30 * 60_000, 60_000 * 2 ** (slot.retries - 1));
      } else {
        slot.finished = item.key;
        delete slot.retryAt;
        delete slot.retries;
      }
    });
  }
  return { enqueue, pending, claim, finish };
}
