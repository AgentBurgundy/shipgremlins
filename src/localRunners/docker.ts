import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { validateDelivery } from "../../runner-local/delivery.mjs";
import { validateReviewPlan } from "../../runner-local/review-receipts.mjs";
import { validateGrumblinPayload } from "../../runner-local/grumblin-runtime.mjs";
import { browserOrigin } from "../../runner-local/browser-access.mjs";
import { validateCommitIdentity } from "../../runner-local/runtime.mjs";
import { validateSyncRepairPayload } from "../../runner-local/sync-repair.mjs";
import {
  createTestEnvironments,
  parseDockerTarget,
  type DockerEnvironmentTarget,
  type TestEnvironmentInput,
  type TestEnvironment,
} from "../testEnvironments/index.ts";

export interface DockerJobPayload {
  kind: "verify" | "pm" | "developer";
  nonce?: string;
  repoUrl?: string;
  branch?: string;
  provider?: "github" | "gitlab";
  commitIdentity?: { name: string; email: string };
  prompt?: string;
  /** Browser tools remain available; repository mode does not require screenshots. */
  browserVerification?: boolean;
  /** Controller-resolved URL used to scope private Playwright preview access. */
  browserTarget?: string;
  pmMode?: "discovery" | "exploration" | "grumblin";
  grumblin?: import("../grumblins/schema.ts").GrumblinProfileSnapshot;
  grumblinTarget?: { url: string; role: "preview" | "staging" };
  maxRuntimeMinutes?: number;
  /** Internal remaining execution budget after trusted environment preparation. */
  remainingRuntimeMs?: number;
  project?: string;
  remoteLease?: boolean;
  remoteLeaseDeadline?: number;
  reviewPlan?: import("../delivery/types.ts").PmReviewPlan;
  expectedCommitSha?: string;
  /** Trusted controller intent for a conflict repair; never accepted from the queue API. */
  syncRepair?: { stagingSha: string };
  testEnvironment?: {
    target: DockerEnvironmentTarget;
    env?: Record<string, string>;
  };
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
    acceptanceCriteria: string[];
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
export interface DockerReview {
  proof: Buffer;
  result: { ok: true; kind: "pm"; nonce: string; commitSha: string };
  files: DockerArtifacts["files"];
}
export interface DockerRunOptions {
  stdin?: string;
  stdinBuffer?: Buffer;
  env?: Record<string, string>;
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
  stopJob(id: string): Promise<void>;
  cleanupEnvironment?(id: string): Promise<void>;
  reconcileEnvironments?(activeJobIds: string[]): Promise<void>;
  smokeEnvironment?(
    input: TestEnvironmentInput,
    verify?: (environment: TestEnvironment) => Promise<void>,
  ): Promise<TestEnvironment>;
  refreshLease?(id: string, ttlMs: number): Promise<void>;
  prepareWorker?(workerId: string, remoteId?: string): Promise<void>;
  canRun?(remoteId: string | undefined, project?: string): boolean;
  verifyReview?(
    id: string,
    plan: import("../delivery/types.ts").PmReviewPlan,
    options?: { bypass?: string; remoteLease?: boolean },
  ): Promise<DockerReview>;
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
function reviewName(id: string) {
  return `gremlins-review-${idValue(id)}`;
}
function reviewVolume(id: string) {
  return `gremlins-review-output-${idValue(id)}`;
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
      stdio: [
        options.stdin === undefined && options.stdinBuffer === undefined
          ? "ignore"
          : "pipe",
        "pipe",
        "pipe",
      ],
      ...(options.env ? { env: { ...process.env, ...options.env } } : {}),
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
    if (options.stdin !== undefined || options.stdinBuffer !== undefined)
      child.stdin?.end(options.stdinBuffer ?? options.stdin);
  });

export function validatePayload(payload: DockerJobPayload): string {
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
          "commitIdentity",
          "prompt",
          "browserVerification",
          "browserTarget",
          "pmMode",
          "grumblin",
          "grumblinTarget",
          "maxRuntimeMinutes",
          "remainingRuntimeMs",
          "project",
          "remoteLease",
          "remoteLeaseDeadline",
          "reviewPlan",
          "expectedCommitSha",
          "syncRepair",
          "testEnvironment",
          "credentials",
          "commands",
          "memory",
          "delivery",
        ].includes(key),
    )
  )
    throw new Error("Invalid local job payload.");
  if (payload.browserTarget !== undefined) {
    if (
      payload.browserVerification === false ||
      payload.kind === "verify" ||
      payload.pmMode === "discovery" ||
      typeof payload.browserTarget !== "string" ||
      payload.browserTarget.length > 8192
    )
      throw new Error("Invalid selected browser environment.");
    browserOrigin(payload.browserTarget);
  }
  if (payload.kind === "developer" || payload.commitIdentity !== undefined)
    validateCommitIdentity(payload.commitIdentity, payload.provider);
  validateSyncRepairPayload({ ...payload });
  if (
    payload.expectedCommitSha !== undefined &&
    !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(payload.expectedCommitSha)
  )
    throw new Error("Invalid pinned source revision.");
  if (payload.testEnvironment !== undefined) {
    if (
      !record(payload.testEnvironment) ||
      Object.keys(payload.testEnvironment).some(
        (k) => !["target", "env"].includes(k),
      ) ||
      payload.kind === "verify" ||
      payload.pmMode === "discovery" ||
      payload.reviewPlan ||
      !payload.expectedCommitSha
    )
      throw new Error(
        "Managed app environments require a pinned normal job, without promotion review.",
      );
    parseDockerTarget(payload.testEnvironment.target);
    const resolved = payload.testEnvironment.env ?? {};
    if (
      !record(resolved) ||
      JSON.stringify(Object.keys(resolved).sort()) !==
        JSON.stringify(
          Object.keys(payload.testEnvironment.target.env ?? {}).sort(),
        ) ||
      Object.values(resolved).some(
        (v) =>
          typeof v !== "string" || !v || v.length > 16384 || /[\r\n\0]/.test(v),
      )
    )
      throw new Error(
        "Supply the dedicated app inputs declared by its Docker recipe.",
      );
  }
  if (
    payload.project !== undefined &&
    !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(payload.project)
  )
    throw new Error("Invalid job project.");
  if (
    payload.remoteLease !== undefined &&
    typeof payload.remoteLease !== "boolean"
  )
    throw new Error("Invalid remote lease.");
  if (
    payload.remoteLeaseDeadline !== undefined &&
    (!payload.remoteLease || !Number.isSafeInteger(payload.remoteLeaseDeadline))
  )
    throw new Error("Invalid remote lease deadline.");
  if (payload.reviewPlan !== undefined) {
    if (
      payload.kind !== "pm" ||
      payload.pmMode ||
      payload.browserVerification !== true ||
      payload.reviewPlan.jobId !== payload.nonce
    )
      throw new Error(
        "Delivery review requires its admitted browser PM patrol.",
      );
    validateReviewPlan(payload.reviewPlan);
  }
  if (
    payload.maxRuntimeMinutes !== undefined &&
    (!Number.isInteger(payload.maxRuntimeMinutes) ||
      payload.maxRuntimeMinutes < 1 ||
      payload.maxRuntimeMinutes > 45)
  )
    throw new Error("Job runtime limit must be between 1 and 45 minutes.");
  if (
    payload.remainingRuntimeMs !== undefined &&
    (!Number.isSafeInteger(payload.remainingRuntimeMs) ||
      payload.remainingRuntimeMs <= 0 ||
      payload.remainingRuntimeMs > (payload.maxRuntimeMinutes ?? 45) * 60_000)
  )
    throw new Error("Invalid remaining job runtime budget.");
  if (
    payload.browserVerification !== undefined &&
    typeof payload.browserVerification !== "boolean"
  )
    throw new Error("Invalid browser verification mode.");
  if (
    payload.pmMode !== undefined &&
    (payload.kind !== "pm" ||
      !["discovery", "exploration", "grumblin"].includes(payload.pmMode))
  )
    throw new Error("Invalid PM mode.");
  validateGrumblinPayload(payload);
  if (payload.pmMode === "exploration" && payload.delivery)
    throw new Error("Product exploration cannot publish code changes.");
  if (
    payload.pmMode === "discovery" &&
    (payload.browserVerification !== false ||
      payload.delivery ||
      Object.values(payload.commands ?? {}).some(Boolean) ||
      Object.keys(payload.credentials ?? {}).some(
        (key) =>
          !["GITHUB_TOKEN", "GITLAB_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"].includes(
            key,
          ),
      ))
  )
    throw new Error(
      "Discovery accepts only source and Claude credentials and cannot run project commands or publish changes.",
    );
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
      Buffer.byteLength(payload.prompt, "utf8") > 512 * 1024
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
        (!credentialNames.has(key) &&
          !/^GREMLINS_TEST_(USERNAME|PASSWORD)_[1-8]$/.test(key)) ||
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
  environmentNamespace?: string;
}): DockerRunners {
  const run = options.run ?? runDocker;
  const directory = join(resolve(options.packageRoot), "runner-local");
  const secrets = new Map<string, string[]>();
  let building: Promise<string> | undefined;
  const environments = createTestEnvironments({
    run,
    ensureImage: () => api.ensureImage(),
    namespace: options.environmentNamespace,
  });
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
    review = false,
  ): Promise<Record<string, unknown> | null> {
    const container = review ? reviewName(id) : name(id);
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
      (review && labels["io.shipgremlins.review"] !== "true") ||
      typeof labels[WORKER] !== "string"
    )
      throw new Error(
        "Refusing to access a container not owned by this local job.",
      );
    return data;
  }
  async function ownedVolume(id: string, review = false): Promise<boolean> {
    const response = await run([
      "volume",
      "inspect",
      "--format",
      "{{json .}}",
      review ? reviewVolume(id) : volume(id),
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
      data.Name !== (review ? reviewVolume(id) : volume(id)) ||
      labels[MANAGED] !== "true" ||
      labels[JOB] !== id ||
      (review && labels["io.shipgremlins.review"] !== "true")
    )
      throw new Error(
        "Refusing to access an output volume not owned by this local job.",
      );
    return true;
  }
  async function helper(
    id: string,
    extra: string[],
    maxBytes?: number,
    review = false,
  ) {
    const data = await inspectOwned(id, review);
    if (!data || !(await ownedVolume(id, review)))
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
        ...(review ? ["--env", "GREMLINS_TRUSTED_REVIEW=1"] : []),
        "--mount",
        `type=volume,source=${review ? reviewVolume(id) : volume(id)},target=/output,readonly`,
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
      validatePayload(input.payload);
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
      const preparationStarted = Date.now();
      const budgetMs =
        input.payload.remainingRuntimeMs ??
        (input.payload.maxRuntimeMinutes ?? 45) * 60_000;
      const image = await api.ensureImage();
      const environment = input.payload.testEnvironment
        ? await environments.start({
            jobId: input.id,
            target: input.payload.testEnvironment.target,
            env: input.payload.testEnvironment.env,
            source: {
              repoUrl: input.payload.repoUrl!,
              provider: input.payload.provider!,
              commitSha: input.payload.expectedCommitSha!,
              token:
                input.payload.credentials?.[
                  input.payload.provider === "gitlab"
                    ? "GITLAB_TOKEN"
                    : "GITHUB_TOKEN"
                ] ?? "",
            },
          })
        : undefined;
      try {
        // App secrets/recipe are controller-only. The agent receives only its private URL and pinned source SHA.
        const delivered = { ...input.payload };
        delete delivered.testEnvironment;
        const remainingRuntime = () =>
          budgetMs - Math.max(0, Date.now() - preparationStarted);
        if (remainingRuntime() <= 0) {
          if (environment) await environments.cleanup(input.id);
          throw new Error(
            "Application preparation exhausted the job runtime budget. Increase the project limit or use a prebuilt image, then retry.",
          );
        }
        delivered.maxRuntimeMinutes = input.payload.maxRuntimeMinutes ?? 45;
        if (environment) {
          delivered.browserTarget = environment.url;
          delivered.prompt += `\n\nManaged test app: ${environment.url}. This disposable app is the admitted baseline; it is not proof of unmerged changes. Use Playwright against this URL. Image: ${environment.imageId}.`;
        }
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
        if (created.code !== 0) {
          await environments.cleanup(input.id);
          throw new Error("Could not create the isolated local job container.");
        }
        secrets.set(
          input.id,
          Object.values(input.payload.credentials ?? {}).filter(Boolean),
        );
        try {
          if (environment) {
            const connected = await run([
              "network",
              "connect",
              environment.network,
              container,
            ]);
            if (connected.code !== 0) throw new Error();
          }
          const started = await run(["start", container]);
          if (started.code !== 0) throw new Error();
          if (input.payload.remoteLease) {
            const ttlMs = Math.min(
              120000,
              (input.payload.remoteLeaseDeadline ?? Date.now() + 30000) -
                Date.now(),
            );
            if (ttlMs < 1000)
              throw new Error("Remote lease expired before launch.");
            const lease = await run(
              [
                "exec",
                "--interactive",
                "--user",
                "0",
                container,
                "node",
                "/opt/gremlins/lease.mjs",
                "renew",
              ],
              { stdin: JSON.stringify({ ttlMs }), timeoutMs: 15000 },
            );
            if (lease.code !== 0) throw new Error();
          }
          delivered.remainingRuntimeMs = remainingRuntime();
          const payload = validatePayload(delivered);
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
          await environments.cleanup(input.id).catch(() => {});
          throw new Error(
            "The local job could not receive its payload. Credentials were not written to host files or Docker configuration.",
          );
        }
        return { id: input.id, name: container, image };
      } catch (error) {
        if (environment) await environments.cleanup(input.id).catch(() => {});
        throw error;
      }
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
      const result = value as unknown as DockerArtifacts;
      const trusted = await inspectOwned(id, true);
      if (
        trusted &&
        record(trusted.State) &&
        trusted.State.Running === false &&
        trusted.State.ExitCode === 0
      ) {
        const review = JSON.parse(
          await helper(id, [], 1024 * 1024, true),
        ) as DockerArtifacts;
        result.files.push(
          ...review.files.filter(
            (file) =>
              file.name === "pm-review-proof.json" ||
              file.name.startsWith("review-screenshots/"),
          ),
        );
      }
      return result;
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
      const review =
        artifact === "pm-review-proof.json" ||
        artifact.startsWith("review-screenshots/");
      const base64 = await helper(
        id,
        ["read", artifact],
        15 * 1024 * 1024,
        review,
      );
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(base64.trim()))
        throw new Error("Invalid artifact data.");
      const bytes = Buffer.from(base64.trim(), "base64");
      if (bytes.length > 10 * 1024 * 1024)
        throw new Error("Artifact is too large.");
      return bytes;
    },
    async stopJob(id) {
      for (const review of [false, true]) {
        const data = await inspectOwned(id, review);
        if (!data || !record(data.State) || data.State.Running !== true)
          continue;
        if (
          (
            await run(
              ["stop", "--time", "20", review ? reviewName(id) : name(id)],
              { timeoutMs: 30_000 },
            )
          ).code !== 0
        )
          throw new Error(
            "The owned job could not be stopped; cancellation remains pending.",
          );
      }
      await environments.cleanup(id);
    },
    cleanupEnvironment: (id) => environments.cleanup(id),
    reconcileEnvironments: (ids) => environments.reconcile(ids),
    smokeEnvironment: (input, verify) => environments.smoke(input, verify),
    async refreshLease(id, ttlMs) {
      if (!Number.isInteger(ttlMs) || ttlMs < 1000 || ttlMs > 120000)
        throw new Error("Invalid remote lease duration.");
      for (const review of [false, true]) {
        const data = await inspectOwned(id, review);
        if (!data || !record(data.State) || data.State.Running !== true)
          continue;
        const renewed = await run(
          [
            "exec",
            "--interactive",
            "--user",
            "0",
            review ? reviewName(id) : name(id),
            "node",
            "/opt/gremlins/lease.mjs",
            "renew",
          ],
          { stdin: JSON.stringify({ ttlMs }), timeoutMs: 15000 },
        );
        if (renewed.code !== 0)
          throw new Error("The remote job lease could not be renewed.");
      }
    },
    async verifyReview(id, plan, reviewOptions = {}) {
      validateReviewPlan(plan);
      if (plan.jobId !== id)
        throw new Error("Review plan belongs to another job.");
      const original = await inspectOwned(id);
      if (
        !original ||
        !record(original.State) ||
        original.State.Running !== false ||
        original.State.ExitCode !== 0 ||
        !(await ownedVolume(id))
      )
        throw new Error(
          "Stop and finish the model job before independent review.",
        );
      const planHash = createHash("sha256")
        .update(JSON.stringify(plan))
        .digest("hex");
      let trusted = await inspectOwned(id, true);
      if (trusted) {
        const config = trusted.Config as { Labels: Record<string, string> };
        if (config.Labels["io.shipgremlins.review-plan"] !== planHash)
          throw new Error("Independent review belongs to another plan.");
      } else {
        if (await ownedVolume(id, true))
          throw new Error(
            "An unfinished independent review needs operator reconciliation.",
          );
        const image = await api.ensureImage(),
          originalConfig = original.Config as {
            Labels: Record<string, string>;
          };
        const created = await run([
          "volume",
          "create",
          "--label",
          `${MANAGED}=true`,
          "--label",
          `${JOB}=${id}`,
          "--label",
          "io.shipgremlins.review=true",
          reviewVolume(id),
        ]);
        if (created.code !== 0)
          throw new Error("Could not create independent review storage.");
        const args = [
          "create",
          "--name",
          reviewName(id),
          "--restart=no",
          "--label",
          `${MANAGED}=true`,
          "--label",
          `${JOB}=${id}`,
          "--label",
          `${WORKER}=${originalConfig.Labels[WORKER]}`,
          "--label",
          "io.shipgremlins.review=true",
          "--label",
          `io.shipgremlins.review-plan=${planHash}`,
          "--user",
          "1000:1000",
          "--cap-drop",
          "ALL",
          "--security-opt",
          "no-new-privileges",
          "--pids-limit",
          "256",
          "--memory",
          "2g",
          "--cpus",
          "1",
          "--shm-size",
          "512m",
          "--mount",
          `type=volume,source=${volume(id)},target=/input,readonly`,
          "--mount",
          `type=volume,source=${reviewVolume(id)},target=/output`,
          "--entrypoint",
          "node",
          image,
          "/opt/gremlins/review-job.mjs",
        ];
        if (
          (await run(args)).code !== 0 ||
          (await run(["start", reviewName(id)])).code !== 0
        )
          throw new Error("Could not start independent browser review.");
        if (reviewOptions.remoteLease) await api.refreshLease!(id, 120000);
        const received = await run(
          [
            "exec",
            "--interactive",
            "--user",
            "1000:1000",
            reviewName(id),
            "node",
            "/opt/gremlins/receive-job.mjs",
          ],
          {
            stdin: JSON.stringify({
              kind: "pm",
              plan,
              bypass: reviewOptions.bypass,
              remoteLease: !!reviewOptions.remoteLease,
            }),
            timeoutMs: 30000,
          },
        );
        if (received.code !== 0) {
          await api.stopJob(id);
          throw new Error("Independent review input could not be received.");
        }
      }
      trusted = await inspectOwned(id, true);
      if (record(trusted?.State) && trusted.State.Running === true) {
        const waited = await run(["wait", reviewName(id)], {
          timeoutMs: 11 * 60 * 1000,
        });
        if (waited.code !== 0) {
          await api.stopJob(id);
          throw new Error("Independent review timed out.");
        }
      }
      trusted = await inspectOwned(id, true);
      if (
        !record(trusted?.State) ||
        trusted.State.Running !== false ||
        trusted.State.ExitCode !== 0
      )
        throw new Error(
          "Independent browser review failed; promotion remains blocked.",
        );
      const artifacts = JSON.parse(
        await helper(id, [], 1024 * 1024, true),
      ) as DockerArtifacts;
      const proof = await api.readArtifact(id, "pm-review-proof.json");
      if (proof.length > 1024 * 1024)
        throw new Error("Independent review proof is too large.");
      return {
        proof,
        result: {
          ok: true,
          kind: "pm",
          nonce: id,
          commitSha: plan.deployment.sha,
        },
        files: artifacts.files,
      };
    },
    async removeJob(id) {
      for (const review of [true, false]) {
        const data = await inspectOwned(id, review);
        if (data && record(data.State) && data.State.Running === true)
          throw new Error(
            "A running job must finish before it can be removed.",
          );
        if (
          data &&
          (await run(["rm", review ? reviewName(id) : name(id)])).code !== 0
        )
          throw new Error("The job container could not be removed.");
        if (await ownedVolume(id, review))
          if (
            (
              await run([
                "volume",
                "rm",
                review ? reviewVolume(id) : volume(id),
              ])
            ).code !== 0
          )
            throw new Error("The job output volume could not be removed.");
      }
      secrets.delete(id);
      await environments.cleanup(id);
    },
  };
  return api;
}
