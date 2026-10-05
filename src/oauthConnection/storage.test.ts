import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rm,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createOAuthStore } from "./storage.ts";

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...original,
    open: vi.fn(original.open),
    unlink: vi.fn(original.unlink),
  };
});
const actual =
  await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
const roots: string[] = [];
const setPlatform = (value: NodeJS.Platform) =>
  Object.defineProperty(process, "platform", { ...platform, value });
const failure = (code: string) =>
  Object.assign(new Error("synthetic-sensitive-path-must-not-be-returned"), {
    code,
  });
const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));
async function fixture() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "gremlins-oauth-lock-")),
  );
  roots.push(root);
  return {
    root,
    lock: join(root, ".run", "oauth", "linear", "state.lock"),
    store: createOAuthStore(root, "linear"),
  };
}
beforeEach(() => {
  vi.mocked(open).mockReset().mockImplementation(actual.open);
  vi.mocked(unlink).mockReset().mockImplementation(actual.unlink);
});
afterEach(async () => {
  Object.defineProperty(process, "platform", platform);
  vi.restoreAllMocks();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

describe("OAuth storage lock contention", () => {
  it("retries Windows access-denied acquisition without deleting or entering a live lock", async () => {
    const f = await fixture();
    setPlatform("win32");
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((done) => (releaseFirst = done));
    let firstEntered!: () => void;
    const entered = new Promise<void>((done) => (firstEntered = done));
    const order: string[] = [];
    const first = f.store.locked(async () => {
      order.push("first entered");
      firstEntered();
      await firstGate;
      order.push("first finished");
    });
    await entered;
    const initial = await readFile(f.lock, "utf8");
    vi.mocked(open)
      .mockRejectedValueOnce(failure("EPERM"))
      .mockRejectedValueOnce(failure("EACCES"));
    const second = createOAuthStore(f.root, "linear").locked(async () => {
      order.push("second entered");
    });
    await pause(150);
    expect(order).toEqual(["first entered"]);
    expect(await readFile(f.lock, "utf8")).toBe(initial);
    expect(unlink).not.toHaveBeenCalled();
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual([
      "first entered",
      "first finished",
      "second entered",
    ]);
    expect(await lstat(f.lock).catch(() => undefined)).toBeUndefined();
  });

  it.each(["EPERM", "EACCES"])(
    "bounds persistent Windows %s failures and retains storage_error",
    async (code) => {
      const { store } = await fixture();
      setPlatform("win32");
      vi.mocked(open).mockRejectedValue(failure(code));
      const operation = vi.fn();
      const error = await store
        .locked(operation)
        .catch((cause: unknown) => cause);
      expect(error).toMatchObject({
        code: "storage_error",
        message: "OAuth state is not writable.",
      });
      expect(String(error)).not.toContain("synthetic-sensitive");
      expect(open).toHaveBeenCalledTimes(9);
      expect(operation).not.toHaveBeenCalled();
      expect(unlink).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["linux", "EACCES"],
    ["darwin", "EPERM"],
    ["win32", "EIO"],
  ] as const)(
    "does not retry unrelated errors on %s (%s)",
    async (os, code) => {
      const { store } = await fixture();
      setPlatform(os);
      vi.mocked(open).mockRejectedValue(failure(code));
      await expect(store.locked(async () => undefined)).rejects.toMatchObject({
        code: "storage_error",
      });
      expect(open).toHaveBeenCalledTimes(1);
      expect(unlink).not.toHaveBeenCalled();
    },
  );

  it("does not retry a lock write error after acquisition and releases only its own file", async () => {
    const { store, lock } = await fixture();
    setPlatform("win32");
    vi.mocked(open).mockImplementationOnce(async (...args) => {
      const handle = await actual.open(...args);
      vi.spyOn(handle, "writeFile").mockRejectedValueOnce(failure("EPERM"));
      return handle;
    });
    const operation = vi.fn();
    await expect(store.locked(operation)).rejects.toMatchObject({
      code: "storage_error",
    });
    expect(open).toHaveBeenCalledTimes(1);
    expect(operation).not.toHaveBeenCalled();
    expect(await lstat(lock).catch(() => undefined)).toBeUndefined();
  });

  it("does not steal an old lock from a live PID merely because twenty minutes elapsed", async () => {
    const { store, lock } = await fixture();
    await mkdir(dirname(lock), { recursive: true });
    const content = JSON.stringify({ pid: process.pid });
    await writeFile(lock, content);
    const old = new Date(Date.now() - 60 * 60_000);
    await utimes(lock, old, old);
    const operation = vi.fn(async () => undefined);
    const waiting = store.locked(operation);
    await pause(150);
    expect(operation).not.toHaveBeenCalled();
    expect(await readFile(lock, "utf8")).toBe(content);
    expect(unlink).not.toHaveBeenCalled();
    await actual.unlink(lock); // The synthetic owner releases its lock.
    await waiting;
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("recovers a stale lock only after its valid owner PID is known to have exited", async () => {
    const { store, lock } = await fixture();
    const child = spawnSync(
      process.execPath,
      ["-e", "console.log(process.pid)"],
      { encoding: "utf8", timeout: 10000, windowsHide: true },
    );
    expect(child.status).toBe(0);
    await mkdir(dirname(lock), { recursive: true });
    await writeFile(lock, JSON.stringify({ pid: Number(child.stdout.trim()) }));
    const old = new Date(Date.now() - 60_000);
    await utimes(lock, old, old);
    const operation = vi.fn(async () => undefined);
    await store.locked(operation);
    expect(operation).toHaveBeenCalledTimes(1);
    expect(await lstat(lock).catch(() => undefined)).toBeUndefined();
  });

  it("rejects a hard-linked lock without removing either link", async () => {
    const { root, store, lock } = await fixture();
    await mkdir(dirname(lock), { recursive: true });
    await writeFile(lock, JSON.stringify({ pid: process.pid }));
    const other = join(root, "other-lock");
    await link(lock, other);
    await expect(store.locked(async () => undefined)).rejects.toMatchObject({
      code: "storage_error",
    });
    expect((await lstat(lock)).nlink).toBe(2);
    expect(unlink).not.toHaveBeenCalled();
  });
});
