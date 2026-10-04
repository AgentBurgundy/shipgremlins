import { describe, expect, it, vi } from "vitest";
import { runUpdate } from "./update.ts";
import type { UpdateStatus } from "../update/index.ts";

function fixture(phase: UpdateStatus["phase"] = "ready") {
  const result: UpdateStatus = {
    phase,
    currentVersion: "0.2.2",
    installedVersion: "0.2.3",
    latestVersion: "0.2.3",
    message: "Update staged.",
    restartRequired: true,
    canRollback: true,
  };
  const updater = {
    status: () => result,
    check: vi.fn(async () => result),
    apply: vi.fn(async () => result),
    rollback: vi.fn(async () => result),
  };
  const io = { log: vi.fn(), error: vi.fn() };
  return { updater, io, result };
}

describe("update command", () => {
  it("installs by default and explains how to use the staged runtime", async () => {
    const { updater, io } = fixture();
    expect(await runUpdate("configuration", "package", [], io, updater)).toBe(
      0,
    );
    expect(updater.apply).toHaveBeenCalledOnce();
    expect(updater.rollback).not.toHaveBeenCalled();
    expect(io.log.mock.calls.flat().join("\n")).toContain(
      "Restart the dashboard",
    );
  });

  it("checks without applying and emits clean JSON for automation", async () => {
    const { updater, io, result } = fixture();
    expect(
      await runUpdate(
        "configuration",
        "package",
        ["--check", "--json"],
        io,
        updater,
      ),
    ).toBe(0);
    expect(updater.check).toHaveBeenCalledOnce();
    expect(updater.apply).not.toHaveBeenCalled();
    expect(io.log).toHaveBeenCalledExactlyOnceWith(JSON.stringify(result));
  });

  it("rolls back only when explicitly requested", async () => {
    const { updater, io } = fixture();
    expect(
      await runUpdate("configuration", "package", ["--rollback"], io, updater),
    ).toBe(0);
    expect(updater.rollback).toHaveBeenCalledOnce();
    expect(updater.apply).not.toHaveBeenCalled();
  });

  it.each([
    ["--check", "--rollback"],
    ["--check=false"],
    ["--repo", "attacker/repository"],
    ["main"],
  ])(
    "rejects invalid arguments %j before changing anything",
    async (...args) => {
      const { updater, io } = fixture();
      expect(
        await runUpdate("configuration", "package", args, io, updater),
      ).toBe(1);
      expect(updater.check).not.toHaveBeenCalled();
      expect(updater.apply).not.toHaveBeenCalled();
      expect(updater.rollback).not.toHaveBeenCalled();
    },
  );

  it("returns a nonzero exit code for a failed compatibility check", async () => {
    const { updater, io } = fixture("error");
    expect(await runUpdate("configuration", "package", [], io, updater)).toBe(
      1,
    );
  });
});
