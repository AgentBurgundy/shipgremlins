import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { validateDelivery } from "../../runner-local/delivery.mjs";

export interface DockerJobPayload {
  kind: "verify" | "pm" | "developer";
  nonce?: string;
  repoUrl?: string;
  branch?: string;
  provider?: "github" | "gitlab";
  prompt?: string;
  /** Browser tools remain available; repository mode does not require screenshots. */
  browserVerification?: boolean;
  credentials?: Record<string, string>;
  commands?: Partial<
    Record<"install" | "test" | "lint" | "typecheck" | "build", string | null>
  >;
  memory?: Record<string, string>;
  delivery?: {
    ticket: string;
    title: string;
    base: string;
    branch: string;
    repo: string;
  };
}
export type LocalJobPayload = DockerJobPayload;
export interface DockerJobInspection {
  exists: boolean;
  running: boolean;
  status: string;
  exitCode?: number;
  image?: string;
  workerId?: string;
}
export interface DockerArtifacts {
  result: Record<string, unknown> | null;
  files: Array<{ name: string; size: number; sha256?: string; png?: boolean }>;
}
export interface DockerRunOptions {
  stdin?: string;
  timeoutMs?: number;
  maxBytes?: number;
  onOutput?: (line: string) => void;
}
export type DockerRun = (
  args: string[],
  options?: DockerRunOptions,
) => Promise<{ code: number; stdout: string; stderr: string }>;
export interface DockerRunners {
  preflight(): Promise<{
    available: boolean;
    message: string;
    os?: string;
    architecture?: string;
  }>;
  ensureImage(progress?: (message: string) => void): Promise<string>;
  startJob(input: {
    id: string;
    workerId: string;
    payload: DockerJobPayload;
  }): Promise<{ id: string; name: string; image: string }>;
  inspectJob(id: string): Promise<DockerJobInspection>;
  logs(id: string): Promise<string>;
  artifacts(id: string): Promise<DockerArtifacts>;
  readArtifact(id: string, name: string): Promise<Buffer>;
  removeJob(id: string): Promise<void>;
}

const MANAGED = "io.shipgremlins.managed";
const JOB = "io.shipgremlins.job";
const WORKER = "io.shipgremlins.worker";
const validId = /^[a-z0-9][a-z0-9-]{0,62}$/;
const validImage = /^shipgremlins-local:[a-f0-9]{16}$/;
const credentialNames = new Set([
  "GITHUB_TOKEN",
  "GITLAB_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "LINEAR_API_KEY",
  "GREMLINS_PREVIEW_BYPASS",
  "GREMLINS_PREVIEW_DATABASE_URL",
]);
function idValue(id: string): string {
  if (!validId.test(id)) throw new Error("Invalid local job identifier.");
  return id;
}
function name(id: string) {
  return `gremlins-job-${idValue(id)}`;
}
function volume(id: string) {
  return `gremlins-output-${idValue(id)}`;
}
function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function redact(text: string, secrets: string[] = []): string {
  let result = text;
  for (const secret of secrets)
    if (secret) result = result.split(secret).join("[REDACTED]");
  return stripVTControlCharacters(
    result.replace(
      /(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|glpat-[A-Za-z0-9_-]+|glrt-[A-Za-z0-9_-]+|sk-ant-[A-Za-z0-9_-]+)/g,
      "[REDACTED]",
    ),
  );
}

const runDocker: DockerRun = async (args, options = {}) =>
  new Promise((done, reject) => {
    const child = spawn("docker", args, {
      shell: false,
      windowsHide: true,
      stdio: [options.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let limited = false;
    let settled = false;
    const max = options.maxBytes ?? 1024 * 1024;
    const timer = setTimeout(() => {
      limited = true;
      child.kill();
    }, options.timeoutMs ?? 30_000);
    const capture = (kind: "stdout" | "stderr", chunk: Buffer) => {
      const value = chunk.toString("utf8");
      if (kind === "stdout") stdout = (stdout + value).slice(-max);
      else stderr = (stderr + value).slice(-max);
      options.onOutput?.(value);
    };
    child.stdout?.on("data", (chunk: Buffer) => capture("stdout", chunk));
    child.stderr?.on("data", (chunk: Buffer) => capture("stderr", chunk));
    child.once("error", () => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        reject(
          new Error(
            "Docker could not start. Install Docker Desktop or Docker Engine and make sure it is running.",
          ),
        );
      }
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        if (limited)
          reject(
            new Error("Docker operation timed out. Check Docker and retry."),
          );
        else done({ code: code ?? 1, stdout, stderr });
      }
    });
    child.stdin?.on("error", () => {});
    if (options.stdin !== undefined) child.stdin?.end(options.stdin);
  });

function validatePayload(payload: DockerJobPayload): string {
  if (
    !record(payload) ||
    !["verify", "pm", "developer"].includes(payload.kind) ||
    Object.keys(payload).some(
      (key) =>
        ![
          "kind",
          "nonce",
          "repoUrl",
          "branch",
          "provider",
          "prompt",
          "browserVerification",
          "credentials",
          "commands",
          "memory",
          "delivery",
        ].includes(key),
    )
  )
    throw new Error("Invalid local job payload.");
  if (
    payload.browserVerification !== undefined &&
    typeof payload.browserVerification !== "boolean"
  )
    throw new Error("Invalid browser verification mode.");
  if (payload.kind === "verify") {
    if (
      typeof payload.nonce !== "string" ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(payload.nonce)
    )
      throw new Error("Verification requires a job nonce.");
    if (payload.credentials && Object.keys(payload.credentials).length)
      throw new Error("Browser verification does not accept credentials.");
  } else {
    let url: URL;
    try {
      url = new URL(payload.repoUrl ?? "");
    } catch {
      throw new Error("Use a credential-free HTTPS repository URL.");
    }
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error("Use a credential-free HTTPS repository URL.");
    if (
      typeof payload.branch !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(payload.branch) ||
      payload.branch.includes("..")
    )
      throw new Error("A valid project branch is required.");
    if (
      typeof payload.prompt !== "string" ||
      !payload.prompt.trim() ||
      payload.prompt.length > 200000
    )
      throw new Error("An agent prompt is required.");
    if (!["github", "gitlab"].includes(payload.provider ?? ""))
      throw new Error("Choose a supported source provider.");
  }
  if (payload.credentials !== undefined) {
    if (!record(payload.credentials))
      throw new Error("Invalid job credentials.");
    for (const [key, value] of Object.entries(payload.credentials))
      if (
        !credentialNames.has(key) ||
        typeof value !== "string" ||
        value.length > 16384 ||
        [...value].some((character) => character.charCodeAt(0) < 32)
      )
        throw new Error("Unsupported job credential.");
  }
  if (payload.kind === "developer") {
    validateDelivery(payload.delivery);
    if (!payload.commands?.test?.trim())
      throw new Error("Developer jobs require a configured test command.");
  }
  const source = JSON.stringify(payload);
  if (Buffer.byteLength(source) > 1024 * 1024)
    throw new Error("Job payload is too large.");
  return source;
}

export function createDockerRunners(options: {
  packageRoot: string;
  run?: DockerRun;
}): DockerRunners {
  const run = options.run ?? runDocker;
  const directory = join(resolve(options.packageRoot), "runner-local");
  const secrets = new Map<string, string[]>();
  let building: Promise<string> | undefined;
  const imageTag = () => {
    const hash = createHash("sha256");
    const files = readdirSync(directory)
      .filter(
        (file) =>
          [
            "Dockerfile",
            ".dockerignore",
            "package.json",
            "package-lock.json",
          ].includes(file) || /\.(mjs|sh)$/.test(file),
      )
      .sort();
    for (const file of files) {
      hash.update(file);
      hash.update(readFileSync(join(directory, file)));
    }
    return `shipgremlins-local:${hash.digest("hex").slice(0, 16)}`;
  };
  async function inspectOwned(
    id: string,
  ): Promise<Record<string, unknown> | null> {
    const container = name(id);
    const response = await run([
      "inspect",
      "--format",
      "{{json .}}",
      container,
    ]);
    if (response.code !== 0) {
      if (/no such (object|container)/i.test(response.stderr)) return null;
      throw new Error(
        "The local job could not be inspected. Make sure Docker is running.",
      );
    }
    let data: unknown;
    try {
      data = JSON.parse(response.stdout);
    } catch {
      throw new Error("Docker returned invalid job information.");
    }
    const config = record(data) && record(data.Config) ? data.Config : {};
    const labels = record(config.Labels) ? config.Labels : {};
    if (
      !record(data) ||
      data.Name !== `/${container}` ||
      labels[MANAGED] !== "true" ||
      labels[JOB] !== id ||
      typeof labels[WORKER] !== "string"
    )
      throw new Error(
        "Refusing to access a container not owned by this local job.",
      );
    return data;
  }
  async function ownedVolume(id: string): Promise<boolean> {
    const response = await run([
      "volume",
      "inspect",
      "--format",
      "{{json .}}",
      volume(id),
    ]);
    if (response.code !== 0) {
      if (/no such volume/i.test(response.stderr)) return false;
      throw new Error("The job output volume could not be inspected.");
    }
    let data: unknown;
    try {
      data = JSON.parse(response.stdout);
    } catch {
      throw new Error("Invalid Docker volume information.");
    }
    const labels = record(data) && record(data.Labels) ? data.Labels : {};
    if (
      !record(data) ||
      data.Name !== volume(id) ||
      labels[MANAGED] !== "true" ||
      labels[JOB] !== id
    )
      throw new Error(
        "Refusing to access an output volume not owned by this local job.",
      );
    return true;
  }
  async function helper(id: string, extra: string[], maxBytes?: number) {
    const data = await inspectOwned(id);
    if (!data || !(await ownedVolume(id)))
      throw new Error("Job artifacts are unavailable.");
    if (record(data.State) && data.State.Running === true)
      throw new Error("Artifacts become available after the job finishes.");
    const config = data.Config as Record<string, unknown>;
    if (typeof config.Image !== "string" || !validImage.test(config.Image))
      throw new Error("The job image is not a managed local runtime.");
    const response = await run(
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
        `type=volume,source=${volume(id)},target=/output,readonly`,
        "--entrypoint",
        "node",
        config.Image,
        "/opt/gremlins/artifacts.mjs",
        ...extra,
      ],
      { maxBytes },
    );
    if (response.code !== 0)
      throw new Error("Job artifacts could not be read.");
    return response.stdout;
  }
  const api: DockerRunners = {
    async preflight() {
      try {
        const response = await run(
          ["version", "--format", "{{json .Server}}"],
          { timeoutMs: 10_000 },
        );
        if (response.code !== 0)
          return {
            available: false,
            message: "Start Docker Desktop or Docker Engine, then retry.",
          };
        const info = JSON.parse(response.stdout) as {
          Os?: string;
          Arch?: string;
        };
        if (info.Os !== "linux")
          return {
            available: false,
            message: "Switch Docker Desktop to Linux containers.",
            os: info.Os,
            architecture: info.Arch,
          };
        if (!["amd64", "arm64"].includes(info.Arch ?? ""))
          return {
            available: false,
            message: "Local workers require amd64 or arm64 Linux Docker.",
            os: info.Os,
            architecture: info.Arch,
          };
        return {
          available: true,
          message: "Docker is ready for local workers.",
          os: info.Os,
          architecture: info.Arch,
        };
      } catch {
        return {
          available: false,
          message:
            "Install and start Docker Desktop or Docker Engine, then retry.",
        };
      }
    },
    async ensureImage(progress) {
      if (building) return building;
      building = (async () => {
        const tag = imageTag();
        const existing = await run(["image", "inspect", tag]);
        if (existing.code === 0) return tag;
        progress?.(
          "Building your local browser and AI worker image. The first build can take several minutes.",
        );
        let last = 0;
        const built = await run(["build", "--tag", tag, directory], {
          timeoutMs: 30 * 60_000,
          onOutput: (output) => {
            if (Date.now() - last > 1500) {
              last = Date.now();
              const line = output.trim().split(/\r?\n/).at(-1);
              if (line) progress?.(redact(line).slice(0, 200));
            }
          },
        });
        if (built.code !== 0)
          throw new Error(
            "The local worker image could not be built. Check Docker internet access and available disk space, then retry.",
          );
        progress?.("Local worker image is ready.");
        return tag;
      })();
      try {
        return await building;
      } finally {
        building = undefined;
      }
    },
    async startJob(input) {
      idValue(input.id);
      idValue(input.workerId);
      const payload = validatePayload(input.payload);
      const existing = await inspectOwned(input.id);
      if (existing) {
        const config = existing.Config as {
          Image: string;
          Labels: Record<string, string>;
        };
        if (config.Labels[WORKER] !== input.workerId)
          throw new Error("This job belongs to another worker.");
        return { id: input.id, name: name(input.id), image: config.Image };
      }
      const image = await api.ensureImage();
      if (!(await ownedVolume(input.id))) {
        const created = await run([
          "volume",
          "create",
          "--label",
          `${MANAGED}=true`,
          "--label",
          `${JOB}=${input.id}`,
          volume(input.id),
        ]);
        if (created.code !== 0)
          throw new Error("Could not create the local job output volume.");
      }
      const container = name(input.id);
      const created = await run([
        "create",
        "--name",
        container,
        "--label",
        `${MANAGED}=true`,
        "--label",
        `${JOB}=${input.id}`,
        "--label",
        `${WORKER}=${input.workerId}`,
        "--restart",
        "no",
        "--init",
        "--add-host",
        "host.docker.internal:host-gateway",
        "--user",
        "1000:1000",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--pids-limit",
        "512",
        "--memory",
        "4g",
        "--cpus",
        "2",
        "--shm-size",
        "1g",
        "--env",
        `GREMLINS_JOB_ID=${input.id}`,
        "--mount",
        `type=volume,source=${volume(input.id)},target=/output`,
        image,
      ]);
      if (created.code !== 0)
        throw new Error("Could not create the isolated local job container.");
      secrets.set(
        input.id,
        Object.values(input.payload.credentials ?? {}).filter(Boolean),
      );
      try {
        const started = await run(["start", container]);
        if (started.code !== 0) throw new Error();
        const accepted = await run(
          [
            "exec",
            "--interactive",
            "--user",
            "1000:1000",
            container,
            "node",
            "/opt/gremlins/receive-job.mjs",
          ],
          { stdin: payload, timeoutMs: 30_000 },
        );
        if (accepted.code !== 0) throw new Error();
      } catch {
        await run(["stop", "--time", "10", container]).catch(() => {});
        throw new Error(
          "The local job could not receive its payload. Credentials were not written to host files or Docker configuration.",
        );
      }
      return { id: input.id, name: container, image };
    },
    async inspectJob(id) {
      const data = await inspectOwned(id);
      if (!data) return { exists: false, running: false, status: "missing" };
      const state = record(data.State) ? data.State : {};
      const config = data.Config as {
        Image: string;
        Labels: Record<string, string>;
      };
      return {
        exists: true,
        running: state.Running === true,
        status: typeof state.Status === "string" ? state.Status : "unknown",
        ...(typeof state.ExitCode === "number"
          ? { exitCode: state.ExitCode }
          : {}),
        image: config.Image,
        workerId: config.Labels[WORKER],
      };
    },
    async logs(id) {
      if (!(await inspectOwned(id)))
        throw new Error(
          "The job container is unavailable. Read retained run history instead.",
        );
      const output = await run(["logs", "--tail", "2000", name(id)]);
      if (output.code !== 0) throw new Error("Local job logs are unavailable.");
      return redact(output.stdout + output.stderr, secrets.get(id));
    },
    async artifacts(id) {
      let value: unknown;
      try {
        value = JSON.parse(await helper(id, []));
      } catch {
        throw new Error("Local job artifacts are unavailable.");
      }
      if (
        !record(value) ||
        !Array.isArray(value.files) ||
        !(value.result === null || record(value.result))
      )
        throw new Error("Invalid job artifact metadata.");
      return value as unknown as DockerArtifacts;
    },
    async readArtifact(id, artifact) {
      if (
        typeof artifact !== "string" ||
        artifact.length > 240 ||
        !/^[A-Za-z0-9_./ -]+$/.test(artifact) ||
        artifact
          .split("/")
          .some((part) => !part || part === "." || part === "..")
      )
        throw new Error("Invalid artifact name.");
      const base64 = await helper(id, ["read", artifact], 15 * 1024 * 1024);
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(base64.trim()))
        throw new Error("Invalid artifact data.");
      const bytes = Buffer.from(base64.trim(), "base64");
      if (bytes.length > 10 * 1024 * 1024)
        throw new Error("Artifact is too large.");
      return bytes;
    },
    async removeJob(id) {
      const data = await inspectOwned(id);
      if (data && record(data.State) && data.State.Running === true)
        throw new Error("A running job must finish before it can be removed.");
      if (data && (await run(["rm", name(id)])).code !== 0)
        throw new Error("The job container could not be removed.");
      if (await ownedVolume(id))
        if ((await run(["volume", "rm", volume(id)])).code !== 0)
          throw new Error("The job output volume could not be removed.");
      secrets.delete(id);
    },
  };
  return api;
}
