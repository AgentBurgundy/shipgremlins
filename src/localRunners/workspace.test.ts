import { afterEach, describe, expect, it, vi } from "vitest";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  createRunnerWorkspaceStorage,
  MIN_WORKSPACE_FREE_BYTES,
  RunnerWorkspaceError,
} from "./workspace.ts";
import type { DockerRun } from "./docker.ts";

const ownership = vi.hoisted(() => ({ uid: 1000, permissions: 0o700 }));
const ioFailure = vi.hoisted(() => ({ operation: "", code: "" }));
vi.mock("node:fs", async (load) => {
  const actual = await load<typeof import("node:fs")>();
  const fail = (operation: string) => {
    if (ioFailure.operation === operation)
      throw Object.assign(new Error("private path and TOP_SECRET details"), {
        code: ioFailure.code,
      });
  };
  return {
    ...actual,
    mkdirSync: (...args: Parameters<typeof actual.mkdirSync>) => {
      fail("mkdir");
      return actual.mkdirSync(...args);
    },
    readFileSync: (...args: Parameters<typeof actual.readFileSync>) => {
      fail("read");
      return actual.readFileSync(...args);
    },
    writeFileSync: (...args: Parameters<typeof actual.writeFileSync>) => {
      fail("write");
      return actual.writeFileSync(...args);
    },
    lstatSync: (path: string) => {
      const info = actual.lstatSync(path);
      // Exercise Linux ownership validation on all CI hosts, including Windows.
      return Object.assign(Object.create(Object.getPrototypeOf(info)), info, {
        uid: ownership.uid,
        mode: info.isDirectory()
          ? (info.mode & ~0o777) | ownership.permissions
          : info.mode,
      });
    },
  };
});

const roots: string[] = [];
afterEach(() => {
  ownership.uid = 1000;
  ownership.permissions = 0o700;
  ioFailure.operation = "";
  ioFailure.code = "";
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "gremlins-workspace-"));
  roots.push(root);
  const directory = join(root, "workspaces");
  mkdirSync(directory, { mode: 0o700 });
  const run = vi.fn<DockerRun>(async (args) => {
    if (args[0] === "context")
      return {
        code: 0,
        stdout: JSON.stringify("unix:///var/run/docker.sock"),
        stderr: "",
      };
    const mount = args[args.indexOf("--mount") + 1]!;
    const source = mount.split("source=")[1]!.split(",")[0]!;
    return {
      code: 0,
      stdout: readFileSync(join(source, basename(args.at(-1)!)), "utf8"),
      stderr: "",
    };
  });
  const freeBytes = vi.fn(() => MIN_WORKSPACE_FREE_BYTES * 2);
  const options = {
    configurationRoot: root,
    run,
    platform: "linux" as const,
    uid: 1000,
    env: {},
    freeBytes,
  };
  const configure = (value: unknown = { workspaceRoot: directory }) =>
    writeFileSync(join(root, "runner-storage.json"), JSON.stringify(value));
  return { root, directory, run, freeBytes, options, configure };
}

describe("isolated external runner workspaces", () => {
  it("leaves existing Docker behavior untouched without operator configuration", async () => {
    const f = fixture();
    const storage = createRunnerWorkspaceStorage(f.options);
    expect(storage.check()).toBeUndefined();
    expect(await storage.prepare("job-one", "image")).toBeUndefined();
    expect(f.run).not.toHaveBeenCalled();
    expect(f.freeBytes).not.toHaveBeenCalled();
    expect(readdirSync(f.directory)).toEqual([]);
  });

  it("leaves a linked configuration home alone unless external storage is configured", async () => {
    const f = fixture();
    const alias = join(f.root, "configuration-alias");
    symlinkSync(
      f.root,
      alias,
      process.platform === "win32" ? "junction" : "dir",
    );
    const storage = createRunnerWorkspaceStorage({
      ...f.options,
      configurationRoot: alias,
    });
    expect(storage.check()).toBeUndefined();
    expect(await storage.prepare("job-one", "image")).toBeUndefined();
    expect(f.run).not.toHaveBeenCalled();
    f.configure();
    expect(() => storage.check()).toThrow("symbolic links");
  });

  it("loads persisted operator configuration and proves the daemon sees each isolated directory", async () => {
    const f = fixture();
    f.configure();
    const storage = createRunnerWorkspaceStorage(f.options);
    expect(await storage.prepare("job-one", "image")).toBe(
      `type=bind,source=${join(f.directory, "job-one")},target=/work`,
    );
    expect(await storage.prepare("job-two", "image")).toBe(
      `type=bind,source=${join(f.directory, "job-two")},target=/work`,
    );
    expect(readdirSync(join(f.directory, "job-one"))).toEqual(["home"]);
    const probe = f.run.mock.calls.find(([args]) => args[0] === "run")![0];
    expect(probe).toContain("--read-only");
    expect(probe).toContain("1000:1000");
    expect(probe).toContain("none");
    expect(probe.join(" ")).not.toContain("/output");
    // A retry before execution may reuse a still-empty directory.
    expect(await storage.prepare("job-one", "image")).toContain("job-one");
  });

  it.each(["darwin", "win32"] as const)(
    "fails explicitly for configured %s controllers",
    (platform) => {
      const f = fixture();
      f.configure();
      expect(() =>
        createRunnerWorkspaceStorage({ ...f.options, platform }).check(),
      ).toThrow("requires a Linux controller");
    },
  );

  it("separates independent review from the model's retained workspace", async () => {
    const f = fixture();
    f.configure();
    const storage = createRunnerWorkspaceStorage(f.options);
    await storage.prepare("job-one", "image");
    writeFileSync(join(f.directory, "job-one", "job.ready"), "old execution");
    expect(await storage.prepare("job-one", "image", true)).toBe(
      `type=bind,source=${join(f.directory, ".reviews", "job-one")},target=/work`,
    );
    expect(
      readFileSync(join(f.directory, "job-one", "job.ready"), "utf8"),
    ).toBe("old execution");
    expect(readdirSync(join(f.directory, ".reviews", "job-one"))).toEqual([
      "home",
    ]);
  });

  it.each([
    {},
    { workspaceRoot: "/safe", extra: "unexpected" },
    { workspaceRoot: 12 },
    { workspaceRoot: "relative" },
    { workspaceRoot: "/safe,readonly" },
  ])("rejects invalid operator configuration %j", (config) => {
    const f = fixture();
    f.configure(config);
    expect(() => createRunnerWorkspaceStorage(f.options).check()).toThrow(
      RunnerWorkspaceError,
    );
  });

  it("does not recreate a missing storage directory on another filesystem", async () => {
    const f = fixture();
    const missing = join(f.root, "unmounted", "workspaces");
    f.configure({ workspaceRoot: missing });
    await expect(
      createRunnerWorkspaceStorage(f.options).prepare("job-one", "image"),
    ).rejects.toThrow("Mount its storage drive");
    expect(existsSync(missing)).toBe(false);
    expect(f.run).not.toHaveBeenCalled();
  });

  it.each([
    { uid: 0, permissions: 0o700 },
    { uid: 1000, permissions: 0o755 },
    { uid: 1000, permissions: 0o500 },
    { uid: 1000, permissions: 0o400 },
    { uid: 1000, permissions: 0o000 },
  ])("rejects unsafe storage ownership or permissions %j", (value) => {
    const f = fixture();
    f.configure();
    Object.assign(ownership, value);
    expect(() => createRunnerWorkspaceStorage(f.options).check()).toThrow(
      "UID 1000",
    );
  });

  it.each([0, 1001])(
    "rejects controller UID %i before creating unusable workspaces",
    async (uid) => {
      const f = fixture();
      f.configure();
      await expect(
        createRunnerWorkspaceStorage({ ...f.options, uid }).prepare(
          "job-one",
          "image",
        ),
      ).rejects.toThrow("run as UID 1000");
      expect(f.run).not.toHaveBeenCalled();
      expect(readdirSync(f.directory)).toEqual([]);
    },
  );

  it.each([
    {
      operation: "read",
      code: "EACCES",
      message: "cannot be read or written",
    },
    { operation: "mkdir", code: "EROFS", message: "read-only" },
    {
      operation: "write",
      code: "ENOSPC",
      message: "full or its quota is exhausted",
    },
  ])(
    "reports safe actionable admission failures for $operation/$code",
    async (failure) => {
      const f = fixture();
      f.configure();
      Object.assign(ioFailure, failure);
      const error = await createRunnerWorkspaceStorage(f.options)
        .prepare("job-one", "image")
        .catch((error: unknown) => error);
      expect(error).toBeInstanceOf(RunnerWorkspaceError);
      expect((error as Error).message).toContain(failure.message);
      expect((error as Error).message).not.toContain("TOP_SECRET");
      expect((error as Error).message).not.toContain("private path");
      expect(f.run.mock.calls.some(([args]) => args[0] === "run")).toBe(false);
    },
  );

  it("reports a failed filesystem capacity check without leaking its underlying details", async () => {
    const f = fixture();
    f.configure();
    f.freeBytes.mockImplementation(() => {
      throw Object.assign(new Error("statfs failed for TOP_SECRET"), {
        code: "EIO",
      });
    });
    const error = await createRunnerWorkspaceStorage(f.options)
      .prepare("job-one", "image")
      .catch((error: unknown) => error);
    expect(error).toBeInstanceOf(RunnerWorkspaceError);
    expect((error as Error).message).toContain(
      "could not be inspected or prepared",
    );
    expect((error as Error).message).not.toContain("TOP_SECRET");
    expect(f.run).not.toHaveBeenCalled();
  });

  it("rejects linked storage and per-job paths without touching their target", async () => {
    const f = fixture();
    f.configure();
    const other = join(f.root, "other");
    mkdirSync(other);
    writeFileSync(join(other, "preserved.txt"), "preserved");
    symlinkSync(
      other,
      join(f.directory, "job-one"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await expect(
      createRunnerWorkspaceStorage(f.options).prepare("job-one", "image"),
    ).rejects.toThrow("symbolic links");
    expect(readFileSync(join(other, "preserved.txt"), "utf8")).toBe(
      "preserved",
    );
    expect(f.run.mock.calls.some(([args]) => args[0] === "run")).toBe(false);
  });

  it("blocks low disk before creating a workspace or contacting Docker", async () => {
    const f = fixture();
    f.configure();
    f.freeBytes.mockReturnValue(MIN_WORKSPACE_FREE_BYTES - 1);
    await expect(
      createRunnerWorkspaceStorage(f.options).prepare("job-one", "image"),
    ).rejects.toThrow("less than 5 GiB free");
    expect(readdirSync(f.directory)).toEqual([]);
    expect(f.run).not.toHaveBeenCalled();
  });

  it("rejects remote Docker hosts before bind mounting a host path", async () => {
    const f = fixture();
    f.configure();
    const storage = createRunnerWorkspaceStorage({
      ...f.options,
      env: { DOCKER_HOST: "tcp://remote:2376" },
    });
    await expect(storage.prepare("job-one", "image")).rejects.toThrow(
      "Remote Docker hosts are not supported",
    );
    expect(f.run).not.toHaveBeenCalled();
    expect(readdirSync(f.directory)).toEqual([]);
  });

  it("uses Docker's context override instead of trusting a local DOCKER_HOST", async () => {
    const f = fixture();
    f.configure();
    f.run.mockResolvedValueOnce({
      code: 0,
      stdout: JSON.stringify("ssh://remote"),
      stderr: "",
    });
    const storage = createRunnerWorkspaceStorage({
      ...f.options,
      env: {
        DOCKER_CONTEXT: "remote",
        DOCKER_HOST: "unix:///var/run/docker.sock",
      },
    });
    await expect(storage.prepare("job-one", "image")).rejects.toThrow(
      "Remote Docker hosts are not supported",
    );
    expect(f.run.mock.calls[0]![0]).toContain("remote");
  });

  it("rejects a local-looking socket when the daemon cannot prove access and removes only its probe", async () => {
    const f = fixture();
    f.configure();
    f.run.mockResolvedValueOnce({
      code: 0,
      stdout: JSON.stringify("unix:///proxy.sock"),
      stderr: "",
    });
    f.run.mockResolvedValueOnce({
      code: 0,
      stdout: "different directory",
      stderr: "",
    });
    await expect(
      createRunnerWorkspaceStorage(f.options).prepare("job-one", "image"),
    ).rejects.toThrow("Docker cannot read");
    expect(readdirSync(join(f.directory, "job-one"))).toEqual(["home"]);
  });

  it("preserves retained checkouts and sessions instead of reusing or deleting them", async () => {
    const f = fixture();
    f.configure();
    const storage = createRunnerWorkspaceStorage(f.options);
    await storage.prepare("job-one", "image");
    const retained = join(f.directory, "job-one", "result-to-recover.txt");
    writeFileSync(retained, "unpublished work");
    await expect(storage.prepare("job-one", "image")).rejects.toThrow(
      "retained workspace data",
    );
    expect(readFileSync(retained, "utf8")).toBe("unpublished work");
  });

  it("rechecks available capacity after verifying Docker access", async () => {
    const f = fixture();
    f.configure();
    f.freeBytes
      .mockReturnValueOnce(MIN_WORKSPACE_FREE_BYTES * 2)
      .mockReturnValue(1);
    await expect(
      createRunnerWorkspaceStorage(f.options).prepare("job-one", "image"),
    ).rejects.toThrow("less than 5 GiB free");
    expect(readdirSync(join(f.directory, "job-one"))).toEqual(["home"]);
  });
});
