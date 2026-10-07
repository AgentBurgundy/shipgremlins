import { randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statfsSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";
import type { DockerRun } from "./docker.ts";

export class RunnerWorkspaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunnerWorkspaceError";
  }
}

/** Leave room for dependency installation; this is admission control, not a quota. */
export const MIN_WORKSPACE_FREE_BYTES = 5 * 1024 ** 3;
const OWNER = 1000;
const ID = /^[a-z0-9][a-z0-9-]{0,62}$/;

function filesystem<T>(action: () => T): T {
  try {
    return action();
  } catch (error) {
    if (error instanceof RunnerWorkspaceError) throw error;
    const code = (error as NodeJS.ErrnoException)?.code;
    throw new RunnerWorkspaceError(
      code === "ENOSPC" || code === "EDQUOT"
        ? "Runner storage is full or its quota is exhausted. Free space on its storage drive before starting another job. Retained work was not deleted."
        : code === "EROFS"
          ? "Runner storage is read-only. Restore a writable storage mount before starting another job. Retained work was not deleted."
          : code === "EACCES" || code === "EPERM"
            ? "Runner storage cannot be read or written. Check that the controller runs as UID 1000 and its storage directories have permissions 0700. Existing files were left unchanged."
            : code === "ENOENT" || code === "ENOTDIR"
              ? "Runner storage disappeared or is no longer a directory. Restore its storage mount before starting another job."
              : "Runner storage could not be inspected or prepared. Check the storage drive and its permissions before starting another job. Existing files were left unchanged.",
    );
  }
}

function noSymlinks(path: string): void {
  let current = resolve(path);
  for (;;) {
    try {
      if (lstatSync(current).isSymbolicLink())
        throw new RunnerWorkspaceError(
          "Runner storage cannot contain symbolic links. Choose a real directory on the storage drive.",
        );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (current === parse(current).root) return;
    current = dirname(current);
  }
}

function privateDirectory(path: string): void {
  noSymlinks(path);
  const info = lstatSync(path);
  if (
    !info.isDirectory() ||
    info.uid !== OWNER ||
    (info.mode & 0o777) !== 0o700
  )
    throw new RunnerWorkspaceError(
      "Runner storage must be a private directory owned by UID 1000 with permissions 0700. Existing files were left unchanged.",
    );
}

export function createRunnerWorkspaceStorage(options: {
  configurationRoot?: string;
  workspaceRoot?: string;
  run: DockerRun;
  /** Injectable host facts for tests; never accepted from a queued job. */
  platform?: NodeJS.Platform;
  uid?: number;
  env?: NodeJS.ProcessEnv;
  freeBytes?: (path: string) => number;
}) {
  const env = options.env ?? process.env;
  const freeBytes =
    options.freeBytes ??
    ((path: string) => {
      const disk = statfsSync(path);
      return disk.bavail * disk.bsize;
    });

  function configuredRoot(): string | undefined {
    let root = options.workspaceRoot;
    if (root === undefined && options.configurationRoot) {
      const file = join(options.configurationRoot, "runner-storage.json");
      let info;
      try {
        info = lstatSync(file);
      } catch (error) {
        // Absence is the backwards-compatible default, including configuration
        // homes whose ancestors are links. Only opting in adds storage rules.
        if ((error as NodeJS.ErrnoException).code === "ENOENT")
          return undefined;
        throw error;
      }
      noSymlinks(file);
      {
        const source =
          info.isFile() && info.nlink === 1 && info.size <= 4096
            ? readFileSync(file, "utf8")
            : "";
        try {
          const config: unknown = JSON.parse(source);
          if (
            !config ||
            typeof config !== "object" ||
            Array.isArray(config) ||
            Object.keys(config).length !== 1 ||
            !("workspaceRoot" in config) ||
            typeof config.workspaceRoot !== "string"
          )
            throw new Error();
          root = config.workspaceRoot;
        } catch {
          throw new RunnerWorkspaceError(
            'Invalid runner-storage.json. Set only {"workspaceRoot":"/absolute/storage/directory"}, or remove this optional configuration to use Docker storage.',
          );
        }
      }
    }
    if (root === undefined) return undefined;
    if ((options.platform ?? process.platform) !== "linux")
      throw new RunnerWorkspaceError(
        "External runner storage requires a Linux controller and its local Docker Engine. Remove runner-storage.json to use the default Docker storage on this machine.",
      );
    if ((options.uid ?? process.getuid?.()) !== OWNER)
      throw new RunnerWorkspaceError(
        "External runner storage requires the controller or enrolled worker to run as UID 1000, matching its isolated Docker jobs. Use that service account or remove runner-storage.json to use default Docker storage.",
      );
    if (
      !root ||
      !isAbsolute(root) ||
      root.includes(",") ||
      [...root].some((character) => {
        const code = character.charCodeAt(0);
        return code < 32 || code === 127;
      }) ||
      resolve(root) === parse(resolve(root)).root
    )
      throw new RunnerWorkspaceError(
        "Runner workspaceRoot must name a dedicated absolute directory, without commas or control characters.",
      );
    return resolve(root);
  }

  function check(): string | undefined {
    return filesystem(() => {
      const root = configuredRoot();
      if (!root) return undefined;
      noSymlinks(root);
      if (!existsSync(root))
        throw new RunnerWorkspaceError(
          "The runner storage directory is missing. Mount its storage drive and restore the configured directory before starting a job.",
        );
      privateDirectory(root);
      const available = freeBytes(root);
      if (!Number.isFinite(available) || available < MIN_WORKSPACE_FREE_BYTES)
        throw new RunnerWorkspaceError(
          "Runner storage has less than 5 GiB free. Free space on its storage drive before starting another job. Retained work and evidence were not deleted.",
        );
      return root;
    });
  }

  async function requireLocalDocker(): Promise<void> {
    let endpoint = env.DOCKER_HOST;
    if (env.DOCKER_CONTEXT || !endpoint) {
      const result = await options.run([
        "context",
        "inspect",
        ...(env.DOCKER_CONTEXT ? [env.DOCKER_CONTEXT] : []),
        "--format",
        "{{json .Endpoints.docker.Host}}",
      ]);
      try {
        if (result.code !== 0) throw new Error();
        const value: unknown = JSON.parse(result.stdout);
        if (typeof value !== "string") throw new Error();
        endpoint = value;
      } catch {
        throw new RunnerWorkspaceError(
          "Docker's local storage access could not be verified. Select the local Docker Engine before using external runner storage.",
        );
      }
    }
    if (!endpoint?.startsWith("unix:///"))
      throw new RunnerWorkspaceError(
        "External runner storage requires Docker Engine on this Linux machine. Remote Docker hosts are not supported; configure storage on an enrolled worker instead.",
      );
  }

  return {
    check,
    async preflight() {
      if (check()) await requireLocalDocker();
    },
    async prepare(id: string, image: string, review = false) {
      const root = check();
      if (!root) return undefined;
      if (!ID.test(id))
        throw new RunnerWorkspaceError("Invalid workspace job identifier.");
      await requireLocalDocker();
      const path = filesystem(() => {
        const parent = review ? join(root, ".reviews") : root;
        noSymlinks(parent);
        if (!existsSync(parent)) mkdirSync(parent, { mode: 0o700 });
        privateDirectory(parent);
        const path = join(parent, id);
        noSymlinks(path);
        if (!existsSync(path)) mkdirSync(path, { mode: 0o700 });
        privateDirectory(path);
        // A failed launch can retry an empty workspace, but never reuse a checkout,
        // credential payload, or model session retained from an executed job.
        if (readdirSync(path).some((name) => name !== "home"))
          throw new RunnerWorkspaceError(
            "This job already has retained workspace data. Start a new run to preserve the previous work.",
          );
        const home = join(path, "home");
        if (!existsSync(home)) mkdirSync(home, { mode: 0o700 });
        privateDirectory(home);
        if (readdirSync(home).length)
          throw new RunnerWorkspaceError(
            "This job already has retained workspace data. Start a new run to preserve the previous work.",
          );
        return path;
      });
      const nonce = randomUUID();
      const marker = `.shipgremlins-probe-${nonce}`;
      filesystem(() =>
        writeFileSync(join(path, marker), nonce, { flag: "wx", mode: 0o600 }),
      );
      try {
        // A local-looking socket can proxy another daemon. Prove the daemon sees
        // this exact private directory before sending a job or any credentials.
        const probe = await options.run(
          [
            "run",
            "--rm",
            "--network",
            "none",
            "--read-only",
            "--user",
            "1000:1000",
            "--cap-drop",
            "ALL",
            "--security-opt",
            "no-new-privileges",
            "--mount",
            `type=bind,source=${path},target=/workspace,readonly`,
            "--entrypoint",
            "node",
            image,
            "-e",
            'process.stdout.write(require("node:fs").readFileSync(process.argv[1], "utf8"))',
            `/workspace/${marker}`,
          ],
          { timeoutMs: 15000, maxBytes: 1024 },
        );
        if (probe.code !== 0 || probe.stdout !== nonce)
          throw new RunnerWorkspaceError(
            "Docker cannot read this machine's private runner storage. Check the storage mount, UID 1000 permissions and local Docker context before retrying.",
          );
      } finally {
        filesystem(() => unlinkSync(join(path, marker)));
      }
      // Recheck after the probe; a concurrently admitted job may have used space.
      check();
      return `type=bind,source=${path},target=/work`;
    },
  };
}
