import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createSourceStore, type SavedConnection } from "./store.ts";

const faults = vi.hoisted(() => ({
  mode: "" as "" | "empty" | "partial" | "replacement",
  closed: false,
}));
vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...fs,
    open: async (...args: Parameters<typeof fs.open>) => {
      const handle = await fs.open(...args);
      if (String(args[0]).endsWith("state.lock") && faults.mode) {
        const mode = faults.mode;
        faults.mode = "";
        const write = handle.writeFile.bind(handle),
          close = handle.close.bind(handle);
        handle.close = async () => {
          faults.closed = true;
          await close();
        };
        handle.writeFile = async () => {
          if (mode === "partial") await write('{"pid":');
          if (mode === "replacement") {
            await fs.unlink(args[0]);
            await fs.writeFile(args[0], "another owner", {
              flag: "wx",
              mode: 0o600,
            });
          }
          throw Object.assign(new Error("private disk path from host"), {
            code: "ENOSPC",
          });
        };
      }
      return handle;
    },
  };
});
const roots: string[] = [];
function fixture() {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "sg-source-lock-"));
  roots.push(root);
  const directory = join(root, ".run/source-control");
  return {
    root,
    store: createSourceStore(root),
    directory,
    lock: join(directory, "state.lock"),
  };
}
afterEach(() => {
  faults.mode = "";
  faults.closed = false;
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
const connection: SavedConnection = {
  provider: "github",
  serverUrl: "https://github.com",
  clientId: "test-client",
  accessToken: "synthetic-retained-access",
  refreshToken: "synthetic-retained-refresh",
  account: { id: "1", login: "test-owner" },
  leases: [],
};
it.each(["empty", "partial"] as const)(
  "cleans its owned %s lock after ENOSPC and preserves saved credentials for a later retry",
  async (mode) => {
    const f = fixture();
    await f.store.locked(async (state, save) => {
      state.connections.github = structuredClone(connection);
      await save(state);
    });
    const encrypted = readFileSync(join(f.directory, "connections.enc")),
      key = readFileSync(join(f.directory, "key"));
    faults.mode = mode;
    const callback = vi.fn(async () => {});
    await expect(f.store.locked(callback)).rejects.toMatchObject({
      code: "storage_error",
      message: "Source connection state is not writable.",
    });
    expect(callback).not.toHaveBeenCalled();
    expect(faults.closed).toBe(true);
    expect(existsSync(f.lock)).toBe(false);
    expect(readFileSync(join(f.directory, "connections.enc"))).toEqual(
      encrypted,
    );
    expect(readFileSync(join(f.directory, "key"))).toEqual(key);
    const restarted = createSourceStore(f.root);
    await restarted.locked(async (state, save) => {
      expect(state.connections.github).toEqual(connection);
      state.connections.github!.leases.push({
        jobId: "job-retry",
        expiresAt: Date.now() + 60000,
      });
      await save(state);
    });
    expect((await restarted.read()).connections.github?.leases).toHaveLength(1);
    expect(existsSync(f.lock)).toBe(false);
  },
);
it("closes a failed initializer without unlinking a replacement lock", async () => {
  const f = fixture();
  faults.mode = "replacement";
  await expect(f.store.locked(async () => {})).rejects.toMatchObject({
    code: "storage_error",
  });
  expect(faults.closed).toBe(true);
  expect(readFileSync(f.lock, "utf8")).toBe("another owner");
});
it("does not remove another writer's replacement during normal release", async () => {
  const f = fixture();
  await f.store.locked(async () => {
    unlinkSync(f.lock);
    writeFileSync(f.lock, "replacement", { flag: "wx", mode: 0o600 });
  });
  expect(readFileSync(f.lock, "utf8")).toBe("replacement");
});
