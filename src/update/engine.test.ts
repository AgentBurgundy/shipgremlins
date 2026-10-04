import { afterEach, describe, expect, it, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  readActiveRuntime,
  releasePackageRoot,
  runtimeLocation,
} from "../../bin/runtime.mjs";
import {
  createUpdater,
  UpdateError,
  type RunOptions,
  type UpdateRunner,
} from "./engine.ts";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const roots: string[] = [];

function write(file: string, content: string): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

function packageFixture(path: string, version = "1.0.0"): void {
  write(
    join(path, "package.json"),
    JSON.stringify({
      name: "shipgremlins",
      version,
      engines: { node: ">=22.12.0" },
    }),
  );
  for (const file of [
    "bin/shipgremlins.mjs",
    "bin/runtime.mjs",
    "src/cli.ts",
    "dashboard/index.html",
  ])
    write(join(path, file), "// test fixture");
  write(
    join(path, "node_modules", "tsx", "package.json"),
    JSON.stringify({ name: "tsx", exports: "./loader.mjs" }),
  );
  write(join(path, "node_modules", "tsx", "loader.mjs"), "// test loader");
}

function fixture() {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "sg-update-test-"));
  roots.push(root);
  const packageRoot = join(root, "global package with spaces");
  const configurationRoot = join(root, "config");
  const home = join(root, "home");
  mkdirSync(home);
  packageFixture(packageRoot);
  write(
    join(configurationRoot, "hub.json"),
    '{"hubRepo":"example/private"}\r\n',
  );
  write(join(configurationRoot, ".env"), "GITHUB_TOKEN=secret-token\n");
  write(
    join(configurationRoot, "projects", "demo", "areas.json"),
    '{"areas":{"core":{"enabled":true}}}',
  );
  const target = { version: "1.1.0", sha: SHA_A, node: ">=22.12.0" };
  const calls: { command: string; args: string[]; options: RunOptions }[] = [];
  const fetcher = vi.fn<typeof globalThis.fetch>(async (url) => {
    const href = String(url);
    if (
      href ===
      "https://api.github.com/repos/AgentBurgundy/shipgremlins/git/ref/heads/main"
    )
      return Response.json({ object: { sha: target.sha } });
    if (
      href ===
      `https://raw.githubusercontent.com/AgentBurgundy/shipgremlins/${target.sha}/package.json`
    )
      return Response.json({
        name: "shipgremlins",
        version: target.version,
        engines: { node: target.node },
      });
    if (
      href ===
      `https://api.github.com/repos/AgentBurgundy/shipgremlins/actions/workflows/hub-ci.yml/runs?head_sha=${target.sha}&event=push&branch=main&per_page=1`
    )
      return Response.json({
        workflow_runs: [
          {
            head_sha: target.sha,
            head_branch: "main",
            event: "push",
            status: "completed",
            conclusion: "success",
          },
        ],
      });
    throw new Error("Unexpected remote URL");
  });
  const runner: UpdateRunner = async (command, args, options) => {
    calls.push({ command, args, options });
    if (args.includes("install")) {
      packageFixture(
        join(options.cwd, "node_modules", "shipgremlins"),
        target.version,
      );
      return { code: 0 };
    }
    if (args.includes("--version")) {
      const pkg = JSON.parse(
        readFileSync(join(dirname(dirname(args[0]!)), "package.json"), "utf8"),
      );
      return { code: 0, stdout: `ShipGremlins ${pkg.version}\n` };
    }
    return { code: 0, stdout: "help or validation passed" };
  };
  const env = {
    ...process.env,
    GITHUB_TOKEN: "never-leak-github",
    LINEAR_API_KEY: "never-leak-linear",
    NODE_OPTIONS: "--require malicious.js",
    SHIPGREMLINS_HOME: "other-config",
    SHIPGREMLINS_SESSION: "private-session",
    npm_config_registry: "https://token@private.example",
    NPM_TOKEN: "never-leak-npm",
  };
  const options = {
    packageRoot,
    configurationRoot,
    home,
    env,
    fetch: fetcher,
    run: runner,
  };
  return {
    ...options,
    root,
    target,
    calls,
    options,
    updater: createUpdater(options),
    base: runtimeLocation(packageRoot, home),
  };
}

function configurationSnapshot(root: string): string[] {
  return ["hub.json", ".env", "projects/demo/areas.json"].map((path) =>
    readFileSync(join(root, path), "utf8"),
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe("staged runtime updater", () => {
  it("keeps polling active while a previously discovered release waits for its CI check", async () => {
    const f = fixture();
    await f.updater.check();
    const fetcher = f.fetch.getMockImplementation()!;
    let finish!: () => void;
    const waiting = new Promise<void>((done) => {
      finish = done;
    });
    f.fetch.mockImplementation(async (url, init) => {
      if (String(url).includes("/actions/workflows/")) await waiting;
      return fetcher(url, init);
    });
    const applying = f.updater.apply();
    expect(f.updater.status().phase).toBe("installing");
    expect(f.calls).toHaveLength(0);
    finish();
    expect((await applying).phase).toBe("ready");
  });

  it("checks official HTTPS metadata then activates only a pinned, healthy isolated installation", async () => {
    const f = fixture();
    const before = configurationSnapshot(f.configurationRoot);
    expect(await f.updater.check()).toMatchObject({
      phase: "available",
      currentVersion: "1.0.0",
      latestVersion: "1.1.0",
      latestSha: SHA_A,
      restartRequired: false,
    });
    const status = await f.updater.apply();
    expect(status).toMatchObject({
      phase: "ready",
      currentVersion: "1.0.0",
      installedVersion: "1.1.0",
      installedSha: SHA_A,
      restartRequired: true,
      canRollback: true,
    });
    expect(status.checkedAt).toMatch(/^\d{4}-/);
    expect(readActiveRuntime(f.packageRoot, f.home)).toEqual({
      schema: 1,
      active: { sha: SHA_A, version: "1.1.0" },
      previous: { bootstrap: true, version: "1.0.0" },
    });
    const install = f.calls.find((call) => call.args.includes("install"))!;
    expect(install.command).toBe(process.execPath);
    expect(install.args).toContain(
      `git+https://github.com/AgentBurgundy/shipgremlins.git#${SHA_A}`,
    );
    expect(install.args).toEqual(
      expect.arrayContaining(["--omit=dev", "--no-audit", "--no-fund"]),
    );
    expect(install.options.cwd).toContain(join(f.base, "staging"));
    expect(f.calls.some((call) => call.options.cwd === f.packageRoot)).toBe(
      false,
    );
    expect(
      f.calls.filter((call) => call.args.includes("validate")),
    ).toHaveLength(2);
    expect(
      f.calls.find((call) => call.args.includes("validate"))?.args,
    ).toEqual(
      expect.arrayContaining(["--home", f.configurationRoot, "validate"]),
    );
    expect(configurationSnapshot(f.configurationRoot)).toEqual(before);
    expect(
      JSON.parse(readFileSync(join(f.packageRoot, "package.json"), "utf8"))
        .version,
    ).toBe("1.0.0");
    expect(existsSync(join(f.base, "update.lock"))).toBe(false);
    for (const call of f.calls) {
      for (const key of Object.keys(call.options.env))
        expect(key).not.toMatch(
          /^(?:SHIPGREMLINS_|NODE_OPTIONS|GITHUB_TOKEN|LINEAR_API_KEY|NPM_TOKEN|npm_config_registry)/,
        );
      expect(JSON.stringify(call.options.env)).not.toMatch(
        /never-leak|private-session|malicious/,
      );
      expect(call.options.env.NPM_CONFIG_USERCONFIG).not.toBe(
        call.options.env.NPM_CONFIG_GLOBALCONFIG,
      );
    }
    expect(f.fetch).toHaveBeenCalledTimes(3);
  });

  it("rolls the first managed update back to the untouched bootstrap after compatibility checks", async () => {
    const f = fixture();
    const before = configurationSnapshot(f.configurationRoot);
    await f.updater.apply();
    const calls = f.calls.length;
    expect(await f.updater.rollback()).toMatchObject({
      phase: "ready",
      installedVersion: "1.0.0",
      restartRequired: false,
      canRollback: true,
    });
    expect(readActiveRuntime(f.packageRoot, f.home)).toEqual({
      schema: 1,
      active: { bootstrap: true, version: "1.0.0" },
      previous: { sha: SHA_A, version: "1.1.0" },
    });
    expect(
      f.calls.slice(calls).some((call) => call.args.includes("validate")),
    ).toBe(true);
    expect(existsSync(releasePackageRoot(f.base, SHA_A))).toBe(true);
    expect(configurationSnapshot(f.configurationRoot)).toEqual(before);
  });

  it("supports updates without changing an existing Git checkout or uncommitted files", async () => {
    const f = fixture();
    write(join(f.packageRoot, ".git", "HEAD"), "ref: refs/heads/local\n");
    write(join(f.packageRoot, "uncommitted.txt"), "personal work\n");
    expect((await f.updater.apply()).phase).toBe("ready");
    expect(readFileSync(join(f.packageRoot, ".git", "HEAD"), "utf8")).toBe(
      "ref: refs/heads/local\n",
    );
    expect(readFileSync(join(f.packageRoot, "uncommitted.txt"), "utf8")).toBe(
      "personal work\n",
    );
    expect(f.calls.flatMap((call) => call.args)).not.toEqual(
      expect.arrayContaining(["git", "pull"]),
    );
  });

  it.each(["1.0.0", "0.9.0", "1.0.0-beta.1"])(
    "does not reinstall or downgrade an untracked %s release",
    async (version) => {
      const f = fixture();
      f.target.version = version;
      expect((await f.updater.apply()).phase).toBe("idle");
      expect(f.calls).toHaveLength(0);
      expect(readActiveRuntime(f.packageRoot, f.home)).toBeNull();
    },
  );

  it("allows a newer commit at the same version when the installed SHA is known", async () => {
    const f = fixture();
    await f.updater.apply();
    const firstRelease = releasePackageRoot(f.base, SHA_A);
    const running = createUpdater({
      ...f.options,
      packageRoot: firstRelease,
      bootstrapRoot: f.packageRoot,
    });
    expect(running.status()).toMatchObject({
      currentVersion: "1.1.0",
      currentSha: SHA_A,
      restartRequired: false,
    });
    f.target.sha = SHA_B;
    expect((await running.check()).phase).toBe("available");
    expect((await running.apply()).phase).toBe("ready");
    expect(readActiveRuntime(f.packageRoot, f.home)?.previous).toEqual({
      sha: SHA_A,
      version: "1.1.0",
    });
    expect(existsSync(firstRelease)).toBe(true);
    expect(existsSync(releasePackageRoot(f.base, SHA_B))).toBe(true);
  });

  it("uses the original bootstrap pointer namespace after the launcher starts a managed runtime", async () => {
    const f = fixture();
    await f.updater.apply();
    const active = createUpdater({
      ...f.options,
      packageRoot: releasePackageRoot(f.base, SHA_A),
      env: { ...f.env, SHIPGREMLINS_BOOTSTRAP_ROOT: f.packageRoot },
    });
    expect(active.status()).toMatchObject({
      currentVersion: "1.1.0",
      installedSha: SHA_A,
      canRollback: true,
      restartRequired: false,
    });
    expect((await active.rollback()).phase).toBe("ready");
    expect(readActiveRuntime(f.packageRoot, f.home)?.active).toEqual({
      bootstrap: true,
      version: "1.0.0",
    });
    expect(active.status().restartRequired).toBe(true);
  });

  it.each([
    { status: "in_progress", conclusion: null },
    { status: "completed", conclusion: "failure" },
    { status: "completed", conclusion: "success", head_sha: SHA_B },
  ])(
    "refuses activation until the pinned commit's main-branch CI succeeds: %o",
    async (checks) => {
      const f = fixture();
      const fetcher: typeof fetch = async (url, init) =>
        String(url).includes("/actions/workflows/")
          ? Response.json({
              workflow_runs: [
                {
                  head_sha: SHA_A,
                  head_branch: "main",
                  event: "push",
                  ...checks,
                },
              ],
            })
          : f.fetch(url, init);
      expect(
        await createUpdater({ ...f.options, fetch: fetcher }).apply(),
      ).toMatchObject({
        phase: "error",
        message: expect.stringContaining("checks are pending or failed"),
      });
      expect(f.calls).toHaveLength(0);
      expect(readActiveRuntime(f.packageRoot, f.home)).toBeNull();
    },
  );

  it.each(["install", "--version", "--help", "validate"])(
    "preserves active runtime and all configuration after %s fails, without exposing child output",
    async (failCommand) => {
      const f = fixture();
      const before = configurationSnapshot(f.configurationRoot);
      const run: UpdateRunner = async (command, args, options) =>
        args.includes(failCommand)
          ? {
              code: 1,
              stdout: "GITHUB_TOKEN=never-print-child",
              stderr: "private log",
            }
          : f.run(command, args, options);
      const updater = createUpdater({ ...f.options, run });
      const result = await updater.apply();
      expect(result.phase).toBe("error");
      expect(JSON.stringify(result)).not.toMatch(
        /never-print-child|private log/,
      );
      expect(readActiveRuntime(f.packageRoot, f.home)).toBeNull();
      expect(configurationSnapshot(f.configurationRoot)).toEqual(before);
      expect(existsSync(join(f.base, "update.lock"))).toBe(false);
    },
  );

  it("leaves an installed pointer unchanged if rollback is incompatible with current configuration", async () => {
    const f = fixture();
    await f.updater.apply();
    const before = readFileSync(join(f.base, "active.json"), "utf8");
    const run: UpdateRunner = async (command, args, options) =>
      args.includes("validate") ? { code: 1 } : f.run(command, args, options);
    expect((await createUpdater({ ...f.options, run }).rollback()).phase).toBe(
      "error",
    );
    expect(readFileSync(join(f.base, "active.json"), "utf8")).toBe(before);
  });

  it("rejects incompatible Node requirements before installing", async () => {
    const f = fixture();
    f.target.node = ">=999.0.0";
    expect(await f.updater.apply()).toMatchObject({
      phase: "error",
      message: expect.stringContaining("Node.js 999.0.0"),
    });
    expect(f.calls).toHaveLength(0);
  });

  it.each([
    "../outside",
    "git+https://bad.example",
    "A".repeat(40),
    "a".repeat(41),
  ])("rejects an invalid remote commit: %s", async (sha) => {
    const f = fixture();
    f.target.sha = sha;
    expect((await f.updater.apply()).phase).toBe("error");
    expect(f.calls).toHaveLength(0);
  });

  it("bounds remote metadata and sanitizes transport errors", async () => {
    const f = fixture();
    const big = createUpdater({
      ...f.options,
      fetch: async () => new Response("x".repeat(128 * 1024 + 1)),
    });
    expect(await big.check()).toMatchObject({
      phase: "error",
      message: expect.stringContaining("oversized"),
    });
    const broken = createUpdater({
      ...f.options,
      fetch: async () => {
        throw new Error("secret transport details");
      },
    });
    const status = await broken.check();
    expect(status.phase).toBe("error");
    expect(status.message).not.toContain("secret transport");
  });

  it("rejects simultaneous installs in the same updater and a separate dashboard process", async () => {
    const f = fixture();
    let release: (() => void) | undefined;
    let started: (() => void) | undefined;
    const pending = new Promise<void>((done) => {
      release = done;
    });
    const installing = new Promise<void>((done) => {
      started = done;
    });
    const first = createUpdater({
      ...f.options,
      run: async (command, args, options) => {
        if (args.includes("install")) {
          started!();
          await pending;
        }
        return f.run(command, args, options);
      },
    });
    const apply = first.apply();
    await installing;
    expect(first.status().phase).toBe("installing");
    await expect(first.apply()).rejects.toMatchObject({ status: 409 });
    await expect(createUpdater(f.options).apply()).rejects.toBeInstanceOf(
      UpdateError,
    );
    release!();
    expect((await apply).phase).toBe("ready");
  });

  it("recovers a dead older lock but does not erase it or any old release", async () => {
    const f = fixture();
    write(
      join(f.base, "update.lock"),
      JSON.stringify({
        pid: 2147483647,
        id: "old",
        startedAt: Date.now() - 60_000,
      }),
    );
    expect((await f.updater.apply()).phase).toBe("ready");
    expect(
      readdirSync(f.base).some((name) => name.startsWith("update.lock.stale-")),
    ).toBe(true);
  });

  it("does not replace a corrupt active pointer", async () => {
    const f = fixture();
    write(join(f.base, "active.json"), '{"active":"secret-invalid"}');
    const before = readFileSync(join(f.base, "active.json"), "utf8");
    expect((await f.updater.apply()).phase).toBe("error");
    expect(readFileSync(join(f.base, "active.json"), "utf8")).toBe(before);
    expect(f.calls).toHaveLength(0);
  });

  it("refuses linked runtime storage instead of writing outside its isolated directory", async () => {
    const f = fixture();
    const outside = join(f.root, "outside");
    mkdirSync(outside);
    mkdirSync(dirname(f.base), { recursive: true });
    symlinkSync(outside, f.base, "junction");
    expect((await f.updater.apply()).phase).toBe("error");
    expect(readdirSync(outside)).toEqual([]);
  });
});
