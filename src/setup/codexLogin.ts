import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  aiCredentials,
  codexAccountAuth,
  codexWorkerAuth,
  normalizeCodexAuth,
  parseAiSelection,
  resolveAiSelection,
  saveCodexRefreshOrigin,
  type AiSelection,
} from "../ai/provider.ts";
import { createDockerRunners, type DockerRun } from "../localRunners/docker.ts";
import { writePrivate } from "../remoteWorkers/storage.ts";
import { assertNoSymlinks } from "./files.ts";
import { readConnections, saveConnections } from "./connections.ts";

export interface CodexLoginStatus {
  status:
    | "idle"
    | "starting"
    | "pending"
    | "complete"
    | "failed"
    | "expired"
    | "canceled";
  verificationUrl?: string;
  userCode?: string;
  expiresAt?: string;
  message?: string;
}
export class CodexLoginError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "CodexLoginError";
  }
}
const SAFE_FAILURE =
  "Codex account sign-in or refresh could not finish. Check Docker and reconnect your ChatGPT account, then try again.";
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const runDocker: DockerRun = (args, options = {}) =>
  new Promise((complete) => {
    const child = spawn("docker", args, {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const output: Buffer[] = [];
    let size = 0,
      ended = false;
    const done = (code: number) => {
      if (ended) return;
      ended = true;
      clearTimeout(timer);
      complete({
        code,
        stdout: Buffer.concat(output).toString("utf8"),
        stderr: "",
      });
    };
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      done(1);
    }, options.timeoutMs ?? 30_000);
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > (options.maxBytes ?? 70_000)) {
        child.kill("SIGTERM");
        done(1);
      } else output.push(chunk);
    });
    child.stderr.on("data", () => {});
    child.on("error", () => done(1));
    child.on("close", (code) => done(code ?? 1));
    child.stdin.on("error", () => {});
    child.stdin.end(options.stdin ?? "");
  });
function publicStatus(input: unknown): CodexLoginStatus {
  if (
    !object(input) ||
    ![
      "starting",
      "pending",
      "complete",
      "failed",
      "expired",
      "canceled",
      "idle",
    ].includes(String(input.status))
  )
    throw Error();
  const state = input.status as CodexLoginStatus["status"];
  if (state === "pending") {
    if (
      input.verificationUrl !== "https://auth.openai.com/codex/device" ||
      typeof input.userCode !== "string" ||
      !/^[A-Z0-9-]{4,32}$/.test(input.userCode) ||
      typeof input.expiresAt !== "string" ||
      !Number.isFinite(Date.parse(input.expiresAt))
    )
      throw Error();
    return {
      status: state,
      verificationUrl: input.verificationUrl,
      userCode: input.userCode,
      expiresAt: input.expiresAt,
      message:
        "Open the sign-in page and enter the code to connect your ChatGPT account.",
    };
  }
  const messages = {
    idle: "Connect your ChatGPT account to use Codex.",
    starting: "Starting the trusted Codex account helper…",
    complete: "Codex is connected with your ChatGPT account.",
    failed: SAFE_FAILURE,
    expired: "The sign-in code expired. Start a new Codex sign-in.",
    canceled: "Codex sign-in was canceled.",
  };
  return { status: state, message: messages[state] };
}
const readHelperFile = (name: string, file: "status.json" | "auth.json") => [
  "exec",
  name,
  "node",
  "--input-type=module",
  "-e",
  `import{lstatSync,readFileSync}from'node:fs';const p='/auth/${file}',s=lstatSync(p);if(!s.isFile()||s.isSymbolicLink()||s.size>65536)process.exit(1);process.stdout.write(readFileSync(p));`,
];

/** Only this repository-free account helper may write refreshed controller auth. */
export function createCodexLogin(options: {
  root: string;
  packageRoot: string;
  env?: () => NodeJS.ProcessEnv;
  run?: DockerRun;
  ensureImage?: () => Promise<string>;
  now?: () => number;
}) {
  const root = resolve(options.root),
    run = options.run ?? runDocker;
  const ensureImage =
    options.ensureImage ??
    (() =>
      createDockerRunners({
        packageRoot: options.packageRoot,
      }).ensureImage());
  const now = options.now ?? Date.now;
  const owner = createHash("sha256").update(root).digest("hex");
  const directory = join(root, ".run", "ai"),
    lock = join(directory, "codex.lock"),
    stateFile = join(directory, "codex-login.json");
  type Operation = {
    name: string;
    mode: "login" | "refresh";
    task: Promise<void>;
    canceled: boolean;
    controller: AbortController;
  };
  let current: CodexLoginStatus = { status: "idle" },
    active: Operation | undefined,
    launching:
      { mode: Operation["mode"]; promise: Promise<Operation> } | undefined,
    closed = false;
  function values() {
    return options.env?.() ?? process.env;
  }
  const credentialVersion = () =>
    createHash("sha256")
      .update(
        JSON.stringify({
          stored: readConnections(root).CODEX_AUTH_JSON ?? null,
          env: values().CODEX_AUTH_JSON ?? null,
        }),
      )
      .digest("hex");
  function save(state: CodexLoginStatus) {
    current = publicStatus(state);
    writePrivate(stateFile, JSON.stringify(current));
  }
  function readState() {
    assertNoSymlinks(stateFile);
    if (!existsSync(stateFile)) return current;
    try {
      if (statSync(stateFile).size > 4096) throw Error();
      return publicStatus(JSON.parse(readFileSync(stateFile, "utf8")));
    } catch {
      return publicStatus({ status: "failed" });
    }
  }
  async function remove(name: string) {
    if (!/^gremlins-codex-[a-f0-9-]{36}$/.test(name)) throw Error();
    const listed = await run(
      ["ps", "--all", "--filter", `name=^/${name}$`, "--format", "{{.Names}}"],
      { maxBytes: 1024 },
    );
    if (listed.code !== 0)
      throw new CodexLoginError(
        "The Codex account helper cleanup could not be checked. Restore Docker before retrying.",
        503,
      );
    if (!listed.stdout.trim()) return;
    if (listed.stdout.trim() !== name) throw Error();
    const inspected = await run(
      [
        "inspect",
        "--format",
        '{{ index .Config.Labels "io.shipgremlins.codex-owner" }}',
        name,
      ],
      { maxBytes: 1024 },
    );
    if (inspected.code === 0 && inspected.stdout.trim() === owner) {
      if ((await run(["rm", "--force", name], { maxBytes: 1024 })).code !== 0)
        throw new CodexLoginError(
          "The Codex account helper could not be removed. Check Docker before retrying.",
          503,
        );
    } else if (inspected.code === 0)
      throw new CodexLoginError(
        "The Codex account helper belongs to another workspace.",
        409,
      );
  }
  async function acquire(name: string) {
    assertNoSymlinks(lock);
    mkdirSync(dirname(lock), { recursive: true, mode: 0o700 });
    if (existsSync(lock)) {
      try {
        const previous = JSON.parse(readFileSync(lock, "utf8"));
        if (
          !Number.isSafeInteger(previous.pid) ||
          previous.pid < 1 ||
          typeof previous.name !== "string"
        )
          throw Error();
        try {
          process.kill(previous.pid, 0);
          throw new CodexLoginError(
            "Another Codex account operation is running. Wait for it to finish.",
            409,
          );
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
        }
        await remove(previous.name);
        unlinkSync(lock);
      } catch (error) {
        if (error instanceof CodexLoginError) throw error;
        throw new CodexLoginError(
          "The Codex account operation lock needs attention. Restart the controller before reconnecting.",
          409,
        );
      }
    }
    try {
      writeFileSync(lock, JSON.stringify({ pid: process.pid, name }), {
        flag: "wx",
        mode: 0o600,
      });
    } catch {
      throw new CodexLoginError(
        "Another Codex account operation is running. Wait for it to finish.",
        409,
      );
    }
  }
  async function launchOperation(
    mode: "login" | "refresh",
  ): Promise<Operation> {
    if (closed)
      throw new CodexLoginError(
        "The controller is stopping. Retry after it restarts.",
        503,
      );
    if (active) {
      if (mode === "refresh" && active.mode === "refresh") return active;
      throw new CodexLoginError(
        "A Codex account operation is already running. Finish or cancel it first.",
        409,
      );
    }
    const name = `gremlins-codex-${randomUUID()}`,
      seed = mode === "refresh" ? codexAccountAuth(root, values()) : undefined;
    const version = credentialVersion();
    await acquire(name);
    const operation = {
      name,
      mode,
      canceled: false,
      task: Promise.resolve(),
      controller: new AbortController(),
    };
    active = operation;
    try {
      save({ status: "starting" });
    } catch (error) {
      active = undefined;
      unlinkSync(lock);
      throw error;
    }
    operation.task = Promise.resolve()
      .then(async () => {
        if (operation.canceled || closed) return;
        const signal = operation.controller.signal;
        let cancelImage: () => void = () => {};
        const canceled = new Promise<never>((_, reject) => {
          cancelImage = () =>
            reject(
              new CodexLoginError(
                "Codex account preparation was canceled.",
                409,
              ),
            );
          signal.addEventListener("abort", cancelImage, { once: true });
        });
        let image: string;
        try {
          // Image construction may be shared with normal jobs. Stop waiting for
          // it without stopping their build or admitting a late helper launch.
          image = await Promise.race([ensureImage(), canceled]);
        } finally {
          signal.removeEventListener("abort", cancelImage);
        }
        if (!/^shipgremlins-local:[a-f0-9]{16}$/.test(image)) throw Error();
        if (operation.canceled || closed) return;
        const created = await run(
          [
            "create",
            "--name",
            name,
            "--label",
            `io.shipgremlins.codex-owner=${owner}`,
            "--user",
            "1000:1000",
            "--read-only",
            "--cap-drop=ALL",
            "--security-opt=no-new-privileges",
            "--pids-limit=64",
            "--memory=512m",
            "--cpus=1",
            "--restart=no",
            "--tmpfs",
            "/auth:rw,nosuid,nodev,noexec,size=4m,uid=1000,gid=1000,mode=0700",
            "--tmpfs",
            "/tmp:rw,nosuid,nodev,noexec,size=16m,uid=1000,gid=1000",
            "--entrypoint",
            "node",
            image,
            "-e",
            "setInterval(()=>{},1000)",
          ],
          { maxBytes: 1024 },
        );
        if (created.code !== 0 || operation.canceled || closed) throw Error();
        if ((await run(["start", name], { maxBytes: 1024 })).code !== 0)
          throw Error();
        const execution = await run(
          ["exec", "-i", name, "node", "/opt/gremlins/codex-login.mjs"],
          {
            stdin: JSON.stringify({ mode, ...(seed ? { auth: seed } : {}) }),
            timeoutMs: mode === "login" ? 16 * 60_000 : 90_000,
            maxBytes: 1024,
          },
        );
        if (operation.canceled || closed) return;
        const publicRead = await run(readHelperFile(name, "status.json"), {
          maxBytes: 4096,
        });
        const state = publicStatus(JSON.parse(publicRead.stdout));
        if (execution.code !== 0 || state.status !== "complete") {
          save(state.status === "expired" ? state : { status: "failed" });
          throw new CodexLoginError(SAFE_FAILURE, 409);
        }
        const received = await run(readHelperFile(name, "auth.json"), {
          maxBytes: 65536,
        });
        if (received.code !== 0) throw Error();
        const auth = normalizeCodexAuth(received.stdout);
        if (
          mode === "refresh" &&
          JSON.parse(seed!).tokens.account_id !==
            JSON.parse(auth).tokens.account_id
        )
          throw new CodexLoginError(
            "The refreshed Codex session belongs to a different ChatGPT account. Reconnect before continuing.",
            409,
          );
        if (credentialVersion() !== version)
          throw new CodexLoginError(
            "The Codex connection changed during sign-in. Retry with the current connection.",
            409,
          );
        saveCodexRefreshOrigin(root, values().CODEX_AUTH_JSON, auth);
        saveConnections(root, { CODEX_AUTH_JSON: auth });
        save({ status: "complete" });
      })
      .catch((error: unknown) => {
        if (!operation.canceled && !closed && current.status !== "expired")
          save({ status: "failed" });
        if (mode === "refresh" && !operation.canceled)
          throw error instanceof CodexLoginError
            ? error
            : new CodexLoginError(SAFE_FAILURE, 409);
      })
      .finally(async () => {
        let removed = false;
        let cleanupFailure: unknown;
        try {
          await remove(name);
          removed = true;
        } catch (error) {
          cleanupFailure = error;
          if (!closed) save({ status: "failed" });
        }
        if (removed && existsSync(lock)) {
          try {
            if (JSON.parse(readFileSync(lock, "utf8")).name === name)
              unlinkSync(lock);
          } catch {
            /* A mismatching lock stays closed. */
          }
        }
        if (active === operation) active = undefined;
        if (cleanupFailure && mode === "refresh")
          throw new CodexLoginError(
            "The Codex account helper could not be removed. Restore Docker before running another Codex job.",
            503,
          );
      });
    return operation;
  }
  function launch(mode: Operation["mode"]): Promise<Operation> {
    if (launching) {
      if (launching.mode === mode) return launching.promise;
      return Promise.reject(
        new CodexLoginError(
          "A Codex account operation is already starting. Finish or cancel it first.",
          409,
        ),
      );
    }
    // Reserve the launch synchronously: acquire() yields before active is set,
    // so otherwise two calls in the same turn contend for our own durable lock.
    const pending = { mode, promise: launchOperation(mode) };
    launching = pending;
    void pending.promise
      .finally(() => {
        if (launching === pending) launching = undefined;
      })
      .catch(() => {});
    return pending.promise;
  }
  return {
    async status(): Promise<CodexLoginStatus> {
      if (!active) {
        const saved = readState();
        if (["starting", "pending"].includes(saved.status))
          return publicStatus({ status: "failed" });
        return saved;
      }
      try {
        const read = await run(readHelperFile(active.name, "status.json"), {
          maxBytes: 4096,
          timeoutMs: 5000,
        });
        if (read.code === 0) {
          const state = publicStatus(JSON.parse(read.stdout));
          if (
            state.status === "pending" &&
            Date.parse(state.expiresAt!) <= now()
          )
            return publicStatus({ status: "expired" });
          if (state.status !== "complete") current = state;
        }
      } catch {
        /* The helper may still be starting; expose only safe controller state. */
      }
      return current;
    },
    async start(): Promise<CodexLoginStatus> {
      if (active) return this.status();
      await launch("login");
      return this.status();
    },
    async cancel(): Promise<CodexLoginStatus> {
      const operation =
        active ?? (await launching?.promise.catch(() => undefined));
      if (operation) {
        operation.canceled = true;
        operation.controller.abort();
        await remove(operation.name);
        await operation.task.catch(() => {});
      }
      save({ status: "canceled" });
      return current;
    },
    async prepare(selection?: AiSelection): Promise<Record<string, string>> {
      const ai = selection
        ? parseAiSelection(selection)
        : resolveAiSelection(root, values());
      if (ai.provider !== "codex") return aiCredentials(root, values(), ai);
      const operation = await launch("refresh");
      await operation.task;
      if (operation.canceled || closed)
        throw new CodexLoginError(
          "Codex account preparation was canceled. Start a fresh run when the connection is ready.",
          409,
        );
      return {
        CODEX_AUTH_JSON: codexWorkerAuth(codexAccountAuth(root, values())),
      };
    },
    async close() {
      closed = true;
      const operation =
        active ?? (await launching?.promise.catch(() => undefined));
      if (operation) {
        operation.canceled = true;
        operation.controller.abort();
        await remove(operation.name);
        await operation.task.catch(() => {});
      }
    },
  };
}
