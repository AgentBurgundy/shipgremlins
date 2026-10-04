import { afterEach, describe, expect, it, vi } from "vitest";
import { ChildProcess, type spawn } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canOpenFolders, openDashboardFolder } from "./openFolder.ts";

const directories: string[] = [];
function temporary(): string {
  const directory = mkdtempSync(
    join(realpathSync.native(tmpdir()), "sg-open-folder-test-"),
  );
  directories.push(directory);
  return directory;
}
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("dashboard file-manager availability", () => {
  it("allows only local supported desktops", () => {
    expect(canOpenFolders(false, "win32", {})).toBe(true);
    expect(canOpenFolders(false, "darwin", {})).toBe(true);
    expect(canOpenFolders(false, "linux", { DISPLAY: ":0" })).toBe(true);
    expect(
      canOpenFolders(false, "linux", { WAYLAND_DISPLAY: "wayland-0" }),
    ).toBe(true);
    expect(canOpenFolders(false, "linux", { DISPLAY: "  " })).toBe(false);
    expect(canOpenFolders(false, "linux", {})).toBe(false);
    expect(canOpenFolders(false, "freebsd", { DISPLAY: ":0" })).toBe(false);
    for (const platform of ["win32", "darwin", "linux"] as const)
      expect(canOpenFolders(true, platform, { DISPLAY: ":0" })).toBe(false);
  });
});

describe("dashboard folder opening", () => {
  it.each([
    ["win32", "explorer.exe"],
    ["darwin", "open"],
    ["linux", "xdg-open"],
  ] as const)(
    "opens only the selected server-owned folder on %s without a shell",
    async (platform, command) => {
      const root = temporary();
      const installation = join(root, "Global Package - grëmlins");
      const configuration = join(root, "Config with spaces");
      mkdirSync(installation);
      mkdirSync(configuration);
      const launch = vi.fn(() => {
        const child = new ChildProcess();
        queueMicrotask(() => {
          child.emit("spawn");
          child.emit("exit", 0);
        });
        return child;
      });
      for (const [target, expected] of [
        ["configuration", configuration],
        ["installation", installation],
      ] as const) {
        await openDashboardFolder(configuration, installation, target, {
          platform,
          env: { DISPLAY: ":0" },
          launch: launch as unknown as typeof spawn,
        });
        expect(launch).toHaveBeenLastCalledWith(
          command,
          [realpathSync.native(expected)],
          { detached: true, stdio: "ignore", windowsHide: true, shell: false },
        );
      }
    },
  );

  it("resolves an existing installation junction used by a package manager", async () => {
    const root = temporary();
    const installation = join(root, "installation");
    const linked = join(root, "global-link");
    mkdirSync(installation);
    symlinkSync(installation, linked, "junction");
    const launch = vi.fn(() => {
      const child = new ChildProcess();
      queueMicrotask(() => child.emit("exit", 0));
      return child;
    });
    await openDashboardFolder(root, linked, "installation", {
      platform: "win32",
      launch: launch as unknown as typeof spawn,
    });
    expect(launch).toHaveBeenCalledWith(
      "explorer.exe",
      [realpathSync.native(installation)],
      expect.objectContaining({ shell: false }),
    );
  });

  it.each([
    "../../elsewhere",
    "https://example.com",
    "C:\\Windows",
    "configuration --help",
    "",
    null,
    {},
  ])(
    "rejects arbitrary target %j before launching a process",
    async (target) => {
      const launch = vi.fn();
      await expect(
        openDashboardFolder("unused", "unused", target, {
          platform: "win32",
          launch: launch as unknown as typeof spawn,
        }),
      ).rejects.toThrow("Choose configuration or installation");
      expect(launch).not.toHaveBeenCalled();
    },
  );

  it("rejects LAN and headless requests even if callers bypass availability detection", async () => {
    const root = temporary();
    const launch = vi.fn();
    for (const options of [
      { lan: true, platform: "win32" as const },
      { platform: "linux" as const, env: {} },
    ])
      await expect(
        openDashboardFolder(root, root, "configuration", {
          ...options,
          launch: launch as unknown as typeof spawn,
        }),
      ).rejects.toThrow("local dashboard on a desktop");
    expect(launch).not.toHaveBeenCalled();
  });

  it("rejects missing locations, files, and control characters without echoing input", async () => {
    const root = temporary();
    const file = join(root, "private-token-filename");
    writeFileSync(file, "private-contents");
    const launch = vi.fn();
    for (const selected of [
      join(root, "missing-secret-location"),
      file,
      root + "\nsecret",
      "",
    ]) {
      await expect(
        openDashboardFolder(selected, root, "configuration", {
          platform: "win32",
          launch: launch as unknown as typeof spawn,
        }),
      ).rejects.toThrow(
        "The selected directory is not available yet. Complete installation or setup, then try again.",
      );
    }
    expect(launch).not.toHaveBeenCalled();
  });

  it.each([
    "spawn-error",
    "nonzero-exit",
    "synchronous-failure",
    "never-spawns",
  ])("provides generic manual-open guidance on %s", async (failure) => {
    const root = temporary();
    const launch = vi.fn(() => {
      if (failure === "synchronous-failure")
        throw new Error("private-path-and-content");
      const child = new ChildProcess();
      queueMicrotask(() => {
        if (failure === "spawn-error")
          child.emit("error", new Error("private-path-and-content"));
        if (failure === "nonzero-exit") {
          child.emit("spawn");
          child.emit("exit", 3);
        }
      });
      return child;
    });
    await expect(
      openDashboardFolder(root, root, "configuration", {
        platform: "win32",
        launch: launch as unknown as typeof spawn,
        launchTimeoutMs: 5,
      }),
    ).rejects.toThrow(
      "The folder could not be opened. Use the directory path shown in the dashboard to open it manually.",
    );
  });

  it("does not wait indefinitely for a spawned Explorer process to exit", async () => {
    const root = temporary();
    const child = new ChildProcess();
    const unref = vi.spyOn(child, "unref");
    const launch = vi.fn(() => {
      queueMicrotask(() => child.emit("spawn"));
      return child;
    });
    await expect(
      openDashboardFolder(root, root, "configuration", {
        platform: "win32",
        launch: launch as unknown as typeof spawn,
        launchTimeoutMs: 5,
      }),
    ).resolves.toBeUndefined();
    expect(unref).toHaveBeenCalledOnce();
    // A later process error must not become an unhandled EventEmitter error.
    expect(() =>
      child.emit("error", new Error("late launch failure")),
    ).not.toThrow();
  });
});
