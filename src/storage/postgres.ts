import { spawn, execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
  unlinkSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import type { PoolConfig } from "pg";
import { assertNoSymlinks } from "../setup/files.ts";

export const POSTGRES_IMAGE =
  "postgres:17.11-bookworm@sha256:639ab7ceb90e13123085b741fb31ef493fba25463002f6da665352e7b534b652";
export type StorageDocker = (
  args: string[],
  options?: { stdin?: string; timeoutMs?: number },
) => Promise<{ code: number; stdout: string; stderr: string }>;
export interface StorageStatus {
  configured: boolean;
  ready: boolean;
  mode: "managed" | "external" | "unconfigured";
  message: string;
}
type Configuration =
  | { schema: 1; mode: "managed"; id: string; password: string }
  | { schema: 1; mode: "external"; url: string };
const OWNER = "io.shipgremlins.storage";
const MANAGED = "io.shipgremlins.managed";
const execFileAsync = promisify(execFile);
const runDocker: StorageDocker = (args, options = {}) =>
  new Promise((done, reject) => {
    const child = spawn("docker", args, {
      shell: false,
      windowsHide: true,
      stdio: [options.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    let stdout = "",
      stderr = "",
      timeout = false;
    const timer = setTimeout(() => {
      timeout = true;
      child.kill();
    }, options.timeoutMs ?? 30000);
    child.stdout?.on("data", (chunk) => {
      stdout = (stdout + chunk.toString()).slice(-256 * 1024);
    });
    child.stderr?.on("data", (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-256 * 1024);
    });
    child.once("error", () => {
      clearTimeout(timer);
      reject(
        new Error(
          "Docker is unavailable. Start Docker to restore local run history.",
        ),
      );
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (timeout)
        reject(new Error("Database setup timed out. Check Docker and retry."));
      else done({ code: code ?? 1, stdout, stderr });
    });
    child.stdin?.on("error", () => {});
    child.stdin?.end(options.stdin);
  });

function validateExternal(value: string): string {
  try {
    const url = new URL(value);
    if (
      !["postgres:", "postgresql:"].includes(url.protocol) ||
      !url.hostname ||
      value.length > 8192 ||
      /[\r\n\0]/.test(value)
    )
      throw new Error();
    return value;
  } catch {
    throw new Error(
      "Use an explicit PostgreSQL connection URL for external history storage.",
    );
  }
}

async function writePrivate(file: string, value: Configuration): Promise<void> {
  assertNoSymlinks(file);
  mkdirSync(join(file, ".."), { recursive: true, mode: 0o700 });
  const temp = file + "." + randomBytes(8).toString("hex") + ".tmp";
  try {
    writeFileSync(temp, "", { flag: "wx", mode: 0o600 });
    if (process.platform === "win32") {
      const { stdout } = await execFileAsync(
        "whoami.exe",
        ["/user", "/fo", "csv", "/nh"],
        { windowsHide: true },
      );
      const sid = stdout.match(/S-1-(?:\d+-)+\d+/)?.[0];
      if (!sid) throw new Error();
      await execFileAsync(
        "icacls.exe",
        [temp, "/inheritance:r", "/grant:r", `*${sid}:(F)`],
        { windowsHide: true },
      );
    }
    writeFileSync(temp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
    assertNoSymlinks(file);
    renameSync(temp, file);
  } catch {
    throw new Error(
      "Database credentials could not be saved privately. Check configuration folder permissions.",
    );
  } finally {
    if (existsSync(temp)) unlinkSync(temp);
  }
}

export function createPostgres(options: {
  root: string;
  externalDatabaseUrl?: string;
  run?: StorageDocker;
  wait?: (ms: number) => Promise<void>;
}) {
  const root = resolve(options.root);
  const id = createHash("sha256")
    .update(process.platform === "win32" ? root.toLowerCase() : root)
    .digest("hex")
    .slice(0, 16);
  const file = join(root, ".run", "storage", "postgres.json");
  const container = `gremlins-postgres-${id}`,
    volume = `gremlins-postgres-data-${id}`;
  const run = options.run ?? runDocker;
  const wait =
    options.wait ?? ((ms) => new Promise((done) => setTimeout(done, ms)));
  let ready = false,
    pending: Promise<PoolConfig> | undefined;
  const read = (): Configuration | null => {
    assertNoSymlinks(file);
    if (!existsSync(file)) return null;
    try {
      if (lstatSync(file).size > 16384) throw new Error();
      const value = JSON.parse(readFileSync(file, "utf8")) as Configuration;
      if (value.schema !== 1) throw new Error();
      if (
        value.mode === "managed" &&
        value.id === id &&
        /^[a-f0-9]{64}$/.test(value.password)
      )
        return value;
      if (value.mode === "external") {
        validateExternal(value.url);
        return value;
      }
    } catch {
      /* Never expose a stored connection string in diagnostics. */
    }
    throw new Error(
      "Local history configuration is invalid. Restore .run/storage/postgres.json from backup; database volumes were preserved.",
    );
  };
  async function checked(args: string[], stdin?: string, timeoutMs?: number) {
    const result = await run(args, { stdin, timeoutMs });
    if (result.code !== 0)
      throw new Error(
        "PostgreSQL could not start. Check Docker and retry; existing history was preserved.",
      );
    return result.stdout;
  }
  async function inspect(
    kind: "container" | "volume",
  ): Promise<Record<string, unknown> | null> {
    const result = await run(
      kind === "container"
        ? ["inspect", "--format", "{{json .}}", container]
        : ["volume", "inspect", "--format", "{{json .}}", volume],
    );
    if (result.code !== 0) {
      if (/no such (object|container|volume)/i.test(result.stderr)) return null;
      throw new Error(
        "Docker could not inspect the history database. Start Docker and retry.",
      );
    }
    let value: Record<string, unknown>;
    try {
      value = JSON.parse(result.stdout) as Record<string, unknown>;
    } catch {
      throw new Error("Docker returned invalid history database information.");
    }
    const config = value.Config as
      { Labels?: Record<string, string> } | undefined;
    const labels = (kind === "container" ? config?.Labels : value.Labels) as
      Record<string, string> | undefined;
    if (
      value.Name !== (kind === "container" ? "/" + container : volume) ||
      labels?.[OWNER] !== id ||
      labels?.[MANAGED] !== "true"
    )
      throw new Error(
        "Refusing to use a database container or volume owned by another application.",
      );
    return value;
  }
  async function initialize(): Promise<PoolConfig> {
    let config = read();
    if (options.externalDatabaseUrl !== undefined) {
      const url = validateExternal(options.externalDatabaseUrl);
      if (config?.mode === "managed")
        throw new Error(
          "Managed history already exists. Migrate the database explicitly before changing storage.",
        );
      if (config?.mode === "external" && config.url !== url)
        throw new Error(
          "External history is already configured. Migrate it explicitly before changing storage.",
        );
      config = { schema: 1, mode: "external", url };
      await writePrivate(file, config);
    }
    if (!config) {
      config = {
        schema: 1,
        mode: "managed",
        id,
        password: randomBytes(32).toString("hex"),
      };
      await writePrivate(file, config);
    }
    if (config.mode === "external")
      return {
        connectionString: config.url,
        connectionTimeoutMillis: 5000,
        max: 3,
      };
    let instance = await inspect("container");
    if (!instance) {
      const existing = await inspect("volume");
      if (!existing)
        await checked([
          "volume",
          "create",
          "--label",
          `${OWNER}=${id}`,
          "--label",
          `${MANAGED}=true`,
          volume,
        ]);
      await checked(["pull", POSTGRES_IMAGE], undefined, 10 * 60000);
      await checked([
        "create",
        "--name",
        container,
        "--label",
        `${OWNER}=${id}`,
        "--label",
        `${MANAGED}=true`,
        "--restart",
        "unless-stopped",
        "--publish",
        "127.0.0.1::5432",
        "--memory",
        "768m",
        "--cpus",
        "1",
        "--pids-limit",
        "128",
        "--shm-size",
        "128m",
        "--security-opt",
        "no-new-privileges",
        "--mount",
        `type=volume,source=${volume},target=/var/lib/postgresql/data`,
        "--env",
        "POSTGRES_USER=gremlins",
        "--env",
        "POSTGRES_DB=gremlins",
        "--env",
        "POSTGRES_PASSWORD_FILE=/run/gremlins-password",
        "--entrypoint",
        "/bin/sh",
        POSTGRES_IMAGE,
        "-c",
        'i=0; while [ ! -f /run/gremlins-password ]; do i=$((i+1)); [ "$i" -lt 60 ] || exit 1; sleep 1; done; exec /usr/local/bin/docker-entrypoint.sh postgres',
      ]);
      instance = await inspect("container");
    }
    // Ownership and loopback binding must still hold after a restart.
    const host = instance?.HostConfig as
      | {
          PortBindings?: Record<string, Array<{ HostIp: string }>>;
          Privileged?: boolean;
          Binds?: unknown[];
        }
      | undefined;
    if (
      host?.Privileged ||
      host?.Binds?.length ||
      host?.PortBindings?.["5432/tcp"]?.some(
        (binding) => binding.HostIp !== "127.0.0.1",
      ) ||
      !host?.PortBindings?.["5432/tcp"]?.length
    )
      throw new Error(
        "The managed database is not bound safely to this computer. Existing history was preserved.",
      );
    const state = instance?.State as { Running?: boolean } | undefined;
    if (!state?.Running) await checked(["start", container]);
    await checked(
      [
        "exec",
        "--interactive",
        "--user",
        "0:0",
        container,
        "/bin/sh",
        "-c",
        "umask 077; cat > /run/gremlins-password.pending; mv /run/gremlins-password.pending /run/gremlins-password",
      ],
      config.password,
    );
    for (let attempt = 0; attempt < 60; attempt++) {
      const health = await run([
        "exec",
        container,
        "pg_isready",
        "--host",
        "127.0.0.1",
        "--username",
        "gremlins",
        "--dbname",
        "gremlins",
      ]);
      if (health.code === 0) {
        const current = await inspect("container");
        const networks = current?.NetworkSettings as
          | {
              Ports?: Record<
                string,
                Array<{ HostIp: string; HostPort: string }>
              >;
            }
          | undefined;
        const binding = networks?.Ports?.["5432/tcp"]?.find(
          (item) => item.HostIp === "127.0.0.1",
        );
        const port = Number(binding?.HostPort);
        if (!Number.isInteger(port) || port < 1 || port > 65535)
          throw new Error(
            "The database loopback port could not be identified.",
          );
        return {
          host: "127.0.0.1",
          port,
          user: "gremlins",
          database: "gremlins",
          password: config.password,
          connectionTimeoutMillis: 5000,
          max: 3,
        };
      }
      await wait(1000);
    }
    throw new Error(
      "PostgreSQL is still starting. Retry shortly; database history was preserved.",
    );
  }
  async function lockedInitialize(): Promise<PoolConfig> {
    const lock = join(root, ".run", "storage", "provision.lock");
    assertNoSymlinks(lock);
    mkdirSync(join(lock, ".."), { recursive: true, mode: 0o700 });
    let handle: number | undefined;
    for (let attempt = 0; attempt < 180; attempt++) {
      try {
        handle = openSync(lock, "wx", 0o600);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST")
          throw new Error("The history configuration folder is not writable.");
        if (lstatSync(lock).mtimeMs < Date.now() - 20 * 60_000) {
          unlinkSync(lock);
          continue;
        }
        await wait(1000);
      }
    }
    if (handle === undefined)
      throw new Error(
        "Another process is preparing PostgreSQL. Retry after it finishes.",
      );
    try {
      return await initialize();
    } finally {
      closeSync(handle);
      if (existsSync(lock)) unlinkSync(lock);
    }
  }
  return {
    configured: () =>
      Boolean(options.externalDatabaseUrl !== undefined || read()),
    async ensure(): Promise<PoolConfig> {
      if (!pending)
        pending = lockedInitialize().catch((error) => {
          pending = undefined;
          throw error;
        });
      return pending;
    },
    markReady(value: boolean) {
      ready = value;
      if (!value) pending = undefined;
    },
    status(): StorageStatus {
      const config = read();
      const mode =
        config?.mode ??
        (options.externalDatabaseUrl ? "external" : "unconfigured");
      return {
        configured: mode !== "unconfigured",
        ready,
        mode,
        message: ready
          ? "Run history is stored in PostgreSQL."
          : mode === "unconfigured"
            ? "PostgreSQL will be prepared when you create a local worker."
            : "Run history is configured. Connect to check availability.",
      };
    },
  };
}
