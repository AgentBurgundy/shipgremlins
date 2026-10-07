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
import { withDashboardAuthLock } from "./lock.ts";

const control = vi.hoisted(() => ({ failWrite: false }));
vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return {
    ...fs,
    writeFileSync: (...args: Parameters<typeof fs.writeFileSync>) => {
      if (control.failWrite && typeof args[0] === "number") {
        control.failWrite = false;
        fs.writeFileSync(args[0], "partial");
        throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
      }
      return fs.writeFileSync(...args);
    },
  };
});
const roots: string[] = [];
function root() {
  const path = mkdtempSync(join(realpathSync(tmpdir()), "sg-auth-lock-"));
  roots.push(path);
  return path;
}
afterEach(() => {
  control.failWrite = false;
  vi.restoreAllMocks();
  for (const path of roots.splice(0))
    rmSync(path, { recursive: true, force: true });
});
it("removes only its own partial lock after ENOSPC and allows a later successful transaction", () => {
  const path = root();
  control.failWrite = true;
  expect(() => withDashboardAuthLock(path, () => "never")).toThrow("disk full");
  expect(existsSync(join(path, "write.lock"))).toBe(false);
  expect(withDashboardAuthLock(path, () => "recovered")).toBe("recovered");
});
it("does not remove a replacement lock when releasing its original descriptor", () => {
  const path = root();
  withDashboardAuthLock(path, () => {
    unlinkSync(join(path, "write.lock"));
    writeFileSync(join(path, "write.lock"), "replacement");
  });
  expect(readFileSync(join(path, "write.lock"), "utf8")).toBe("replacement");
});
it("serializes dead-owner reclamation and preserves live or malformed locks", () => {
  const path = root(),
    lock = join(path, "write.lock");
  writeFileSync(lock, JSON.stringify({ pid: 2147483647 }));
  vi.spyOn(process, "kill").mockImplementation(() => {
    throw Object.assign(new Error(), { code: "ESRCH" });
  });
  expect(withDashboardAuthLock(path, () => "reclaimed")).toBe("reclaimed");
  expect(existsSync(join(path, "reclaim.lock"))).toBe(false);
  writeFileSync(lock, "unknown owner");
  expect(() => withDashboardAuthLock(path, () => "never")).toThrow();
  expect(readFileSync(lock, "utf8")).toBe("unknown owner");
  writeFileSync(join(path, "reclaim.lock"), "another reclaimer");
  expect(() => withDashboardAuthLock(path, () => "never")).toThrow();
  expect(readFileSync(join(path, "reclaim.lock"), "utf8")).toBe(
    "another reclaimer",
  );
});
it("cleans a partial reclaim guard without deleting the old lock", () => {
  const path = root(),
    lock = join(path, "write.lock");
  writeFileSync(lock, "old lock");
  control.failWrite = true;
  expect(() => withDashboardAuthLock(path, () => "never")).toThrow("disk full");
  expect(existsSync(join(path, "reclaim.lock"))).toBe(false);
  expect(readFileSync(lock, "utf8")).toBe("old lock");
});
