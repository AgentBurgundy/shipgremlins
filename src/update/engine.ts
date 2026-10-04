import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, join, parse, resolve } from "node:path";
import {
  readActiveRuntime,
  releasePackageRoot,
  runtimeLocation,
  validateRuntimePackage,
  type ActiveRuntimePointer,
  type RuntimeRelease,
} from "../../bin/runtime.mjs";

const OFFICIAL = "AgentBurgundy/shipgremlins";
const SHA = /^[a-f0-9]{40}$/;
const MAX_REMOTE_BYTES = 128 * 1024;
const RELEASE_VERSION =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/;

export interface UpdateStatus {
  phase: "idle" | "checking" | "available" | "installing" | "ready" | "error";
  currentVersion: string;
  currentSha?: string;
  installedVersion: string;
  installedSha?: string;
  latestVersion?: string;
  latestSha?: string;
  checkedAt?: string;
  message: string;
  restartRequired: boolean;
  canRollback: boolean;
}

export interface RunOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
}
export interface RunResult {
  code: number;
  stdout?: string;
  stderr?: string;
}
export type UpdateRunner = (
  command: string,
  args: string[],
  options: RunOptions,
) => Promise<RunResult>;

export interface UpdaterOptions {
  packageRoot: string;
  bootstrapRoot?: string;
  configurationRoot: string;
  home?: string;
  env?: NodeJS.ProcessEnv;
  fetch?: typeof globalThis.fetch;
  run?: UpdateRunner;
}

export interface Updater {
  status(): UpdateStatus;
  check(): Promise<UpdateStatus>;
  apply(): Promise<UpdateStatus>;
  rollback(): Promise<UpdateStatus>;
}

export class UpdateError extends Error {
  constructor(
    message: string,
    public readonly status = 400,
  ) {
    super(message);
    this.name = "UpdateError";
  }
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function version(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 128 &&
    RELEASE_VERSION.test(value)
  );
}

/** Semver ordering including prereleases; build metadata does not affect order. */
function compareVersions(left: string, right: string): number {
  const a = RELEASE_VERSION.exec(left)!;
  const b = RELEASE_VERSION.exec(right)!;
  for (let index = 1; index <= 3; index++) {
    const difference = Number(a[index]) - Number(b[index]);
    if (difference) return Math.sign(difference);
  }
  if (a[4] === b[4]) return 0;
  if (!a[4]) return 1;
  if (!b[4]) return -1;
  const aa = a[4].split(".");
  const bb = b[4].split(".");
  for (let index = 0; index < Math.max(aa.length, bb.length); index++) {
    const x = aa[index];
    const y = bb[index];
    if (x === y) continue;
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    if (nx && ny) return Math.sign(Number(x) - Number(y));
    if (nx !== ny) return nx ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

function assertNodeEngine(value: unknown): void {
  if (typeof value !== "string")
    throw new UpdateError(
      "The release does not declare a supported Node.js requirement.",
    );
  const match = /^>=\s*(\d+)\.(\d+)(?:\.(\d+))?$/.exec(value);
  if (!match)
    throw new UpdateError(
      "This release needs a newer updater to verify its Node.js requirement. Upgrade the global CLI manually.",
    );
  const minimum = `${match[1]}.${match[2]}.${match[3] ?? "0"}`;
  if (compareVersions(process.versions.node, minimum) < 0)
    throw new UpdateError(
      `Install Node.js ${minimum} or newer before updating ShipGremlins.`,
    );
}

function assertNoLinks(target: string): void {
  let path = resolve(target);
  for (;;) {
    try {
      if (lstatSync(path).isSymbolicLink())
        throw new UpdateError(
          "The runtime directory cannot contain symbolic links or junctions.",
        );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (path === parse(path).root) return;
    path = dirname(path);
  }
}

function privateDirectory(path: string): void {
  assertNoLinks(path);
  mkdirSync(path, { recursive: true, mode: 0o700 });
  assertNoLinks(path);
}

function readJson(file: string, limit = MAX_REMOTE_BYTES): unknown {
  const info = lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > limit)
    throw new UpdateError("Runtime metadata is missing or invalid.");
  return JSON.parse(readFileSync(file, "utf8"));
}

function manifest(packageRoot: string): {
  version: string;
  sha?: string;
  node: unknown;
} {
  const raw = readJson(join(packageRoot, "package.json"));
  if (!object(raw) || raw.name !== "shipgremlins" || !version(raw.version))
    throw new UpdateError(
      "The installed ShipGremlins package metadata is invalid.",
    );
  return {
    version: raw.version,
    ...(typeof raw.gitHead === "string" && SHA.test(raw.gitHead)
      ? { sha: raw.gitHead }
      : {}),
    node: object(raw.engines) ? raw.engines.node : undefined,
  };
}

/** Only standard OS paths reach child processes, never dashboard/provider tokens. */
function childEnvironment(
  source: NodeJS.ProcessEnv,
  work: string,
): NodeJS.ProcessEnv {
  const allowed = new Set([
    "path",
    "systemroot",
    "windir",
    "comspec",
    "pathext",
    "temp",
    "tmp",
    "tmpdir",
  ]);
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source))
    if (allowed.has(key.toLowerCase()) && value !== undefined) env[key] = value;
  const privateHome = join(work, ".home");
  privateDirectory(privateHome);
  const npmConfig = join(work, ".npmrc-update");
  const npmGlobalConfig = join(work, ".npmrc-global-update");
  const gitConfig = join(work, ".gitconfig-update");
  if (!existsSync(npmConfig))
    writeFileSync(npmConfig, "", { mode: 0o600, flag: "wx" });
  if (!existsSync(npmGlobalConfig))
    writeFileSync(npmGlobalConfig, "", { mode: 0o600, flag: "wx" });
  if (!existsSync(gitConfig))
    writeFileSync(gitConfig, "", { mode: 0o600, flag: "wx" });
  return {
    ...env,
    HOME: privateHome,
    USERPROFILE: privateHome,
    APPDATA: join(privateHome, "AppData", "Roaming"),
    LOCALAPPDATA: join(privateHome, "AppData", "Local"),
    CI: "1",
    NO_COLOR: "1",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: gitConfig,
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "never",
    NPM_CONFIG_USERCONFIG: npmConfig,
    NPM_CONFIG_GLOBALCONFIG: npmGlobalConfig,
    NPM_CONFIG_CACHE: join(work, ".npm-cache"),
    NPM_CONFIG_UPDATE_NOTIFIER: "false",
  };
}

/** Resolve the npm JavaScript entry point, avoiding .cmd and shell quoting. */
function npmCli(env: NodeJS.ProcessEnv): string {
  const nodeDirectory = dirname(realpathSync(process.execPath));
  const paths =
    Object.entries(env)
      .find(([key]) => key.toLowerCase() === "path")?.[1]
      ?.split(delimiter) ?? [];
  const candidates = [
    ...(env.npm_execpath && basename(env.npm_execpath) === "npm-cli.js"
      ? [env.npm_execpath]
      : []),
    join(nodeDirectory, "node_modules", "npm", "bin", "npm-cli.js"),
    join(
      nodeDirectory,
      "..",
      "lib",
      "node_modules",
      "npm",
      "bin",
      "npm-cli.js",
    ),
    ...paths
      .filter(Boolean)
      .flatMap((path) => [
        join(path, "node_modules", "npm", "bin", "npm-cli.js"),
        join(path, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
        join(path, "npm"),
      ]),
  ];
  for (const candidate of candidates) {
    try {
      const actual = realpathSync(candidate);
      if (basename(actual) === "npm-cli.js" && lstatSync(actual).isFile())
        return actual;
    } catch {
      /* Try the next platform-specific npm location. */
    }
  }
  throw new UpdateError(
    "npm could not be found beside Node.js or on PATH. Install Node.js with npm and retry.",
  );
}

const runChild: UpdateRunner = (command, args, options) =>
  new Promise((done) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      windowsHide: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let settled = false;
    let output = "";
    let size = 0;
    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      done({ code, stdout: output });
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(1);
    }, options.timeoutMs);
    const collect = (data: Buffer, keep: boolean) => {
      size += data.length;
      if (size > 256 * 1024) {
        child.kill();
        finish(1);
      } else if (keep) output += data.toString("utf8");
    };
    child.stdout.on("data", (data: Buffer) => collect(data, true));
    child.stderr.on("data", (data: Buffer) => collect(data, false));
    child.once("error", () => finish(1));
    child.once("close", (code) => finish(code ?? 1));
  });

async function remoteJson(
  fetcher: typeof globalThis.fetch,
  url: string,
): Promise<unknown> {
  const response = await fetcher(url, {
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
    headers: {
      Accept: "application/vnd.github+json",
      "User-Agent": "ShipGremlins-Updater",
    },
  });
  if (!response.ok || !response.body)
    throw new UpdateError(
      "GitHub could not be reached or is rate-limiting update checks. Try again later.",
    );
  if (Number(response.headers.get("content-length") ?? 0) > MAX_REMOTE_BYTES)
    throw new UpdateError("GitHub returned oversized release metadata.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.length;
      if (bytes > MAX_REMOTE_BYTES) {
        await reader.cancel();
        throw new UpdateError("GitHub returned oversized release metadata.");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new UpdateError("GitHub returned invalid release metadata.");
  }
}

function lock(base: string): () => void {
  privateDirectory(base);
  const file = join(base, "update.lock");
  const id = randomUUID();
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(file, "wx", 0o600);
      try {
        writeFileSync(
          fd,
          JSON.stringify({ pid: process.pid, id, startedAt: Date.now() }),
        );
      } finally {
        closeSync(fd);
      }
      return () => {
        try {
          const existing = readJson(file, 4096);
          if (object(existing) && existing.id === id) unlinkSync(file);
        } catch {
          /* Never remove a lock that this operation no longer owns. */
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let abandoned = false;
      try {
        const previous = readJson(file, 4096);
        if (
          object(previous) &&
          Number.isInteger(previous.pid) &&
          Number(previous.pid) > 0 &&
          typeof previous.startedAt === "number" &&
          Date.now() - previous.startedAt >= 30_000
        ) {
          try {
            process.kill(Number(previous.pid), 0);
          } catch (check) {
            abandoned = (check as NodeJS.ErrnoException).code === "ESRCH";
          }
        }
      } catch {
        /* Invalid or linked locks require manual attention, not deletion. */
      }
      if (!abandoned || attempt > 0)
        throw new UpdateError(
          "Another update is running or an interrupted update is locked. Wait 30 seconds and retry; inspect runtime/update.lock if the problem persists.",
          409,
        );
      renameSync(file, join(base, `update.lock.stale-${randomUUID()}`));
    }
  }
  throw new UpdateError("An update is already running.", 409);
}

function activate(
  base: string,
  next: ActiveRuntimePointer,
  previous: ActiveRuntimePointer | null,
  readPointer: () => ActiveRuntimePointer | null,
): void {
  assertNoLinks(base);
  if (JSON.stringify(readPointer()) !== JSON.stringify(previous))
    throw new UpdateError(
      "The active runtime changed during this update. Check the installed version and retry.",
      409,
    );
  const file = join(base, `.active-${randomUUID()}.tmp`);
  const fd = openSync(file, "wx", 0o600);
  try {
    writeFileSync(fd, JSON.stringify(next, null, 2) + "\n");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(file, join(base, "active.json"));
}

export function createUpdater(options: UpdaterOptions): Updater {
  const sourceEnv = options.env ?? process.env;
  const packageRoot = realpathSync(options.packageRoot);
  const bootstrapRoot = realpathSync(
    options.bootstrapRoot ??
      sourceEnv.SHIPGREMLINS_BOOTSTRAP_ROOT ??
      packageRoot,
  );
  const base = runtimeLocation(bootstrapRoot, options.home ?? homedir());
  const installed = manifest(packageRoot);
  const bootstrap = manifest(bootstrapRoot);
  const fetcher = options.fetch ?? globalThis.fetch;
  const run = options.run ?? runChild;
  let busy = false;
  let latest: { sha: string; version: string; node: unknown } | undefined;
  let state: Pick<UpdateStatus, "phase" | "message" | "checkedAt"> = {
    phase: "idle",
    message: "Check for a new ShipGremlins release.",
  };

  const pointer = () =>
    readActiveRuntime(bootstrapRoot, options.home ?? homedir());
  const releasePath = (entry: RuntimeRelease): string =>
    "bootstrap" in entry ? bootstrapRoot : releasePackageRoot(base, entry.sha);
  const status = (): UpdateStatus => {
    let active: ActiveRuntimePointer | null;
    try {
      active = pointer();
    } catch {
      return {
        ...state,
        phase: "error",
        message: `The saved runtime pointer is invalid. Keep a backup by renaming ${join(base, "active.json")} to active.json.backup, then run gremlins update. The running installation has not been changed.`,
        currentVersion: installed.version,
        installedVersion: installed.version,
        restartRequired: false,
        canRollback: false,
      };
    }
    const runningRelease = [active?.active, active?.previous].find(
      (entry) => entry && resolve(releasePath(entry)) === packageRoot,
    );
    const currentSha =
      runningRelease && "sha" in runningRelease
        ? runningRelease.sha
        : installed.sha;
    const installedSha =
      active?.active && "sha" in active.active
        ? active.active.sha
        : active?.active
          ? bootstrap.sha
          : currentSha;
    return {
      ...state,
      currentVersion: installed.version,
      ...(currentSha ? { currentSha } : {}),
      installedVersion: active?.active.version ?? installed.version,
      ...(installedSha ? { installedSha } : {}),
      ...(latest
        ? { latestVersion: latest.version, latestSha: latest.sha }
        : {}),
      restartRequired: Boolean(
        active && resolve(releasePath(active.active)) !== packageRoot,
      ),
      canRollback: Boolean(active?.previous),
    };
  };

  const discover = async (): Promise<void> => {
    state = {
      ...state,
      phase: "checking",
      message: "Checking the official ShipGremlins repository…",
    };
    latest = undefined;
    const ref = await remoteJson(
      fetcher,
      `https://api.github.com/repos/${OFFICIAL}/git/ref/heads/main`,
    );
    const sha = object(ref) && object(ref.object) ? ref.object.sha : undefined;
    if (typeof sha !== "string" || !SHA.test(sha))
      throw new UpdateError("GitHub returned an invalid release commit.");
    const pkg = await remoteJson(
      fetcher,
      `https://raw.githubusercontent.com/${OFFICIAL}/${sha}/package.json`,
    );
    if (!object(pkg) || pkg.name !== "shipgremlins" || !version(pkg.version))
      throw new UpdateError(
        "GitHub returned an invalid ShipGremlins release manifest.",
      );
    const node = object(pkg.engines) ? pkg.engines.node : undefined;
    assertNodeEngine(node);
    latest = { sha, version: pkg.version, node };
    const installedStatus = status();
    const order = compareVersions(
      pkg.version,
      installedStatus.installedVersion,
    );
    const available =
      order > 0 ||
      (order === 0 &&
        Boolean(installedStatus.installedSha) &&
        sha !== installedStatus.installedSha);
    state = {
      phase: available ? "available" : "idle",
      checkedAt: new Date().toISOString(),
      message: available
        ? `ShipGremlins ${pkg.version} is available.`
        : order < 0
          ? "Your installed version is newer than the official release. Automatic downgrades are disabled."
          : installedStatus.restartRequired
            ? "The update is installed. Restart ShipGremlins when you are ready."
            : "You are running the latest published version.",
    };
  };

  const smoke = async (
    candidate: string,
    release: RuntimeRelease,
    work: string,
  ) => {
    validateRuntimePackage(candidate, release.version);
    assertNodeEngine(manifest(candidate).node);
    const env = childEnvironment(sourceEnv, work);
    const cli = join(candidate, "bin", "shipgremlins.mjs");
    const check = async (args: string[], message: string) => {
      const result = await run(process.execPath, [cli, ...args], {
        cwd: candidate,
        env,
        timeoutMs: 60_000,
      });
      if (result.code !== 0) throw new UpdateError(message);
      return result.stdout ?? "";
    };
    const printed = await check(
      ["--version"],
      "The new runtime failed its version check. The active installation is unchanged.",
    );
    if (printed.trim() !== `ShipGremlins ${release.version}`)
      throw new UpdateError(
        "The candidate runtime version does not match the checked release.",
      );
    await check(
      ["--help"],
      "The new runtime could not start. The active installation is unchanged.",
    );
    if (existsSync(join(options.configurationRoot, "hub.json")))
      await check(
        ["--home", resolve(options.configurationRoot), "validate"],
        "This runtime cannot read your existing configuration. No update was activated and your projects and connections are unchanged.",
      );
  };

  const verifyReleaseChecks = async (sha: string): Promise<void> => {
    const result = await remoteJson(
      fetcher,
      `https://api.github.com/repos/${OFFICIAL}/actions/workflows/hub-ci.yml/runs?head_sha=${sha}&event=push&branch=main&per_page=1`,
    );
    const checks =
      object(result) && Array.isArray(result.workflow_runs)
        ? result.workflow_runs[0]
        : undefined;
    if (
      !object(checks) ||
      checks.head_sha !== sha ||
      checks.head_branch !== "main" ||
      checks.event !== "push" ||
      checks.status !== "completed" ||
      checks.conclusion !== "success"
    )
      throw new UpdateError(
        "This release's checks are pending or failed. Try gremlins update again after the official main-branch CI passes. Your current runtime is unchanged.",
      );
  };

  const execute = async (
    operation: () => Promise<void>,
  ): Promise<UpdateStatus> => {
    if (busy)
      throw new UpdateError("An update operation is already running.", 409);
    busy = true;
    try {
      await operation();
    } catch (error) {
      state = {
        ...state,
        phase: "error",
        message:
          error instanceof UpdateError
            ? error.message
            : "The update could not complete. Check network access and runtime-directory permissions, then retry. The active installation is unchanged.",
      };
      if (error instanceof UpdateError && error.status === 409) throw error;
    } finally {
      busy = false;
    }
    return status();
  };

  return {
    status,
    check: () => execute(discover),
    apply: () =>
      execute(async () => {
        const unlock = lock(base);
        try {
          const before = pointer();
          if (!latest) await discover();
          if (!latest)
            throw new UpdateError("Check for a release before updating.");
          const runningStatus = status();
          const order = compareVersions(
            latest.version,
            runningStatus.installedVersion,
          );
          if (
            order < 0 ||
            (order === 0 &&
              (!runningStatus.installedSha ||
                runningStatus.installedSha === latest.sha))
          ) {
            state = {
              ...state,
              phase: runningStatus.restartRequired ? "ready" : "idle",
              message: runningStatus.restartRequired
                ? "The update is installed. Restart ShipGremlins when you are ready."
                : "No newer release needs installing.",
            };
            return;
          }
          assertNodeEngine(latest.node);
          state = {
            ...state,
            phase: "installing",
            message: "Checking the selected release's CI before installing…",
          };
          await verifyReleaseChecks(latest.sha);
          state = {
            ...state,
            phase: "installing",
            message: `Installing and checking ShipGremlins ${latest.version}. Your running gremlins keep their current runtime.`,
          };
          const stagingRoot = join(base, "staging");
          privateDirectory(stagingRoot);
          const stage = mkdtempSync(join(stagingRoot, "update-"));
          const destination = releasePackageRoot(base, latest.sha);
          const releaseDirectory = dirname(dirname(destination));
          const candidate = join(stage, "node_modules", "shipgremlins");
          if (!existsSync(releaseDirectory)) {
            writeFileSync(
              join(stage, "package.json"),
              JSON.stringify({
                name: "shipgremlins-runtime",
                version: "0.0.0",
                private: true,
              }),
              { mode: 0o600, flag: "wx" },
            );
            const env = childEnvironment(sourceEnv, stage);
            const result = await run(
              process.execPath,
              [
                npmCli(sourceEnv),
                "--prefix",
                stage,
                "install",
                "--omit=dev",
                "--no-audit",
                "--no-fund",
                "--save-exact",
                "--registry=https://registry.npmjs.org",
                `git+https://github.com/${OFFICIAL}.git#${latest.sha}`,
              ],
              { cwd: stage, env, timeoutMs: 15 * 60_000 },
            );
            if (result.code !== 0)
              throw new UpdateError(
                "The new runtime could not be installed. Check npm, Git, and network access, then retry. Your active installation and configuration are unchanged.",
              );
            await smoke(candidate, latest, stage);
            privateDirectory(dirname(releaseDirectory));
            assertNoLinks(releaseDirectory);
            renameSync(stage, releaseDirectory);
          } else {
            assertNoLinks(releaseDirectory);
          }
          // Validate again at its permanent path: moved package-relative imports
          // and npm links must work before the active pointer can change.
          const smokeWork = mkdtempSync(join(stagingRoot, "verify-"));
          await smoke(destination, latest, smokeWork);
          const active = { sha: latest.sha, version: latest.version };
          activate(
            base,
            {
              schema: 1,
              active,
              previous: before?.active ?? {
                bootstrap: true,
                version: bootstrap.version,
              },
            },
            before,
            pointer,
          );
          state = {
            ...state,
            phase: "ready",
            message:
              "Update installed and checked. Restart ShipGremlins when you are ready; existing processes keep running. Projects, connections, and cloud jobs are unchanged.",
          };
        } finally {
          unlock();
        }
      }),
    rollback: () =>
      execute(async () => {
        const unlock = lock(base);
        try {
          const before = pointer();
          if (!before?.previous)
            throw new UpdateError(
              "No previous managed runtime is available. The original global installation is still intact.",
            );
          state = {
            ...state,
            phase: "installing",
            message:
              "Checking the previous runtime against your current configuration…",
          };
          const stagingRoot = join(base, "staging");
          privateDirectory(stagingRoot);
          const work = mkdtempSync(join(stagingRoot, "rollback-"));
          await smoke(releasePath(before.previous), before.previous, work);
          activate(
            base,
            { schema: 1, active: before.previous, previous: before.active },
            before,
            pointer,
          );
          state = {
            ...state,
            phase: "ready",
            message:
              "Previous runtime selected. Restart ShipGremlins when you are ready. Your configuration and running gremlins are unchanged.",
          };
        } finally {
          unlock();
        }
      }),
  };
}
