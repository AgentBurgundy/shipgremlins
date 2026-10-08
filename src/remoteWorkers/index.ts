import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { readFileSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { loadProject } from "../config.ts";
import { isDeepStrictEqual, stripVTControlCharacters } from "node:util";
import { publicActivityLogs } from "../storage/activity.ts";
import { safeOAuthPath } from "../oauthConnection/storage.ts";
import {
  validatePayload,
  type DockerJobPayload,
  type DockerRunners,
  type DockerArtifacts,
} from "../localRunners/docker.ts";
import {
  createPrivateStore,
  writePrivate,
  RemoteWorkerError,
  validRemoteArtifactName,
} from "./storage.ts";
export { RemoteWorkerError } from "./storage.ts";

const ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
const PROJECT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const TOKEN = /^[a-f0-9]{64}$/;
const LEASE_MS = 120000;
interface Worker {
  id: string;
  name: string;
  projects: string[];
  projectInstances?: Record<string, string>;
  tokenHash: string;
  enrollmentHash?: string;
  enrollmentExpiresAt?: number;
  createdAt: number;
  lastSeenAt?: number;
  revokedAt?: number;
  platform?: string;
  architecture?: string;
  logicalId?: string;
  accessProtocol?: 1;
}
interface Job {
  id: string;
  workerId: string;
  remoteId: string;
  payload: DockerJobPayload;
  lease: string;
  createdAt: number;
  leasedAt?: number;
  expiresAt?: number;
  canceled?: boolean;
  status: "assigned" | "running" | "exited";
  exitCode?: number;
  logs: string;
  result: Record<string, unknown> | null;
  files: DockerArtifacts["files"];
  trustedReview?: { planHash: string; commitSha: string };
  requiresAccessCleanup?: true;
  retired?: true;
}
interface State {
  schema: 1;
  workers: Worker[];
  jobs: Record<string, Job>;
}
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
function same(value: string, expected: string) {
  return (
    TOKEN.test(value) &&
    TOKEN.test(expected) &&
    timingSafeEqual(Buffer.from(value, "hex"), Buffer.from(expected, "hex"))
  );
}
function identifier(value: unknown): string {
  if (typeof value !== "string" || !ID.test(value))
    throw new RemoteWorkerError("Invalid remote job identifier.");
  return value;
}
function sanitize(text: string, secrets: string[]) {
  let output = text;
  for (const value of secrets) {
    if (!value) continue;
    for (const variant of new Set([
      value,
      encodeURIComponent(value),
      JSON.stringify(value).slice(1, -1),
    ]))
      output = output.split(variant).join("[REDACTED]");
  }
  return stripVTControlCharacters(output).replace(
    /(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|glpat-[A-Za-z0-9_-]+|sk-ant-[A-Za-z0-9_-]+)/g,
    "[REDACTED]",
  );
}

export function createRemoteWorkers(options: {
  root: string;
  clock?: () => number;
}) {
  const clock = options.clock ?? Date.now;
  const projectInstance = (project: string) =>
    existsSync(join(options.root, "projects", project, "project.json"))
      ? loadProject(options.root, project).config.instanceId
      : undefined;
  const ownsProject = (worker: Worker, project: string) =>
    worker.projects.includes(project) &&
    worker.projectInstances?.[project] === projectInstance(project);
  const store = createPrivateStore<State>(options.root, () => ({
    schema: 1,
    workers: [],
    jobs: {},
  }));
  function authenticate(state: State, token: string) {
    if (!TOKEN.test(token))
      throw new RemoteWorkerError(
        "Remote worker authentication is required.",
        401,
      );
    const worker = state.workers.find((w) => same(hash(token), w.tokenHash));
    if (!worker || worker.revokedAt)
      throw new RemoteWorkerError(
        "Remote worker authentication is invalid or revoked.",
        401,
      );
    return worker;
  }
  function expire(job: Job) {
    if (job.status === "exited") return;
    if (
      (job.expiresAt && clock() > job.expiresAt + 15000) ||
      (!job.leasedAt && clock() > job.createdAt + 5 * 60000)
    ) {
      job.status = "exited";
      job.exitCode = 124;
      job.result = {
        ok: false,
        kind: job.payload.kind,
        error:
          "Remote worker lease expired. Inspect the retained run before submitting new work.",
      };
      job.payload = {
        kind: job.payload.kind,
        nonce: job.payload.nonce,
        project: job.payload.project,
      };
    }
  }
  const getJob = (state: State, id: string) => state.jobs[identifier(id)];
  function authorizedJob(
    state: State,
    token: string,
    id: string,
    lease: string,
  ) {
    const worker = authenticate(state, token),
      job = getJob(state, id);
    if (
      !job ||
      job.remoteId !== worker.id ||
      !TOKEN.test(lease) ||
      !same(lease, job.lease)
    )
      throw new RemoteWorkerError(
        "This job lease does not belong to this worker.",
        403,
      );
    expire(job);
    if (job.status === "exited")
      throw new RemoteWorkerError("This job lease has ended.", 409);
    return { worker, job };
  }
  const filePath = (id: string, name: string) => {
    identifier(id);
    if (!validRemoteArtifactName(name))
      throw new RemoteWorkerError("Invalid artifact name.");
    return safeOAuthPath(join(store.directory, "artifacts", id, name));
  };
  const api = {
    status() {
      const state = store.read();
      return {
        workers: state.workers.map(
          ({
            id,
            name,
            projects,
            createdAt,
            lastSeenAt,
            revokedAt,
            platform,
            architecture,
            logicalId,
            accessProtocol,
            enrollmentExpiresAt,
            tokenHash,
          }) => ({
            id,
            name,
            projects,
            createdAt,
            lastSeenAt,
            revoked: !!revokedAt,
            platform,
            architecture,
            logicalId,
            accessProtocol,
            capability: "docker" as const,
            enrolled: !!tokenHash,
            online:
              !!tokenHash &&
              !revokedAt &&
              !!lastSeenAt &&
              clock() - lastSeenAt < 60000,
            enrollmentExpiresAt,
          }),
        ),
      };
    },
    createEnrollment(input: { name: string; projects: string[] }) {
      if (
        !input ||
        typeof input.name !== "string" ||
        !/^[A-Za-z0-9 -]{1,80}$/.test(input.name) ||
        !Array.isArray(input.projects) ||
        !input.projects.length ||
        input.projects.length > 100 ||
        input.projects.some((p) => typeof p !== "string" || !PROJECT.test(p))
      )
        throw new RemoteWorkerError(
          "Choose a worker name and at least one valid project.",
        );
      return store.change((state) => {
        if (state.workers.filter((w) => !w.revokedAt).length >= 20)
          throw new RemoteWorkerError(
            "Revoke an unused remote worker before enrolling another.",
            409,
          );
        const code = randomBytes(32).toString("hex"),
          worker: Worker = {
            id: `remote-${randomUUID()}`,
            name: input.name,
            projects: [...new Set(input.projects)],
            projectInstances: Object.fromEntries(
              input.projects.flatMap((project) => {
                const instance = projectInstance(project);
                return instance ? [[project, instance]] : [];
              }),
            ),
            tokenHash: "",
            enrollmentHash: hash(code),
            enrollmentExpiresAt: clock() + 600000,
            createdAt: clock(),
          };
        state.workers.push(worker);
        return {
          id: worker.id,
          code,
          expiresAt: worker.enrollmentExpiresAt,
          projects: worker.projects,
        };
      });
    },
    revoke(id: string) {
      return store.change((state) => {
        const worker = state.workers.find((w) => w.id === identifier(id));
        if (!worker)
          throw new RemoteWorkerError("Remote worker not found.", 404);
        worker.revokedAt = clock();
        delete worker.enrollmentHash;
        for (const job of Object.values(state.jobs))
          if (job.remoteId === id && job.status !== "exited")
            job.canceled = true;
        return { ok: true };
      });
    },
    enroll(input: unknown) {
      if (
        !isRecord(input) ||
        typeof input.code !== "string" ||
        !TOKEN.test(input.code) ||
        !["linux", "darwin", "win32"].includes(String(input.platform)) ||
        !["x64", "arm64"].includes(String(input.architecture))
      )
        throw new RemoteWorkerError(
          "Choose a valid one-time enrollment code and Docker worker.",
        );
      return store.change((state) => {
        const worker = state.workers.find(
          (w) =>
            w.enrollmentHash &&
            same(hash(String(input.code)), w.enrollmentHash),
        );
        if (
          !worker ||
          worker.revokedAt ||
          !worker.enrollmentExpiresAt ||
          worker.enrollmentExpiresAt <= clock()
        )
          throw new RemoteWorkerError(
            "Enrollment code expired or was already used.",
            401,
          );
        const token = randomBytes(32).toString("hex");
        worker.tokenHash = hash(token);
        delete worker.enrollmentHash;
        delete worker.enrollmentExpiresAt;
        worker.lastSeenAt = clock();
        worker.platform = String(input.platform);
        worker.architecture = String(input.architecture);
        return {
          id: worker.id,
          token,
          name: worker.name,
          projects: worker.projects,
        };
      });
    },
    poll(token: string, capabilities?: unknown) {
      return store.change((state) => {
        const worker = authenticate(state, token);
        worker.lastSeenAt = clock();
        worker.accessProtocol =
          isRecord(capabilities) && capabilities.accessProtocol === 1
            ? 1
            : undefined;
        const job = Object.values(state.jobs).find(
          (j) => j.remoteId === worker.id && j.status !== "exited",
        );
        if (!job) return { job: null };
        expire(job);
        if (job.status === "exited") return { job: null };
        if (job.canceled)
          return { job: { id: job.id, lease: job.lease, cancel: true } };
        job.leasedAt ??= clock();
        job.expiresAt = clock() + LEASE_MS;
        job.status = "running";
        return {
          job: {
            id: job.id,
            workerId: job.workerId,
            lease: job.lease,
            expiresAt: job.expiresAt,
            ttlMs: LEASE_MS,
            payload: { ...job.payload, remoteLease: true },
          },
        };
      });
    },
    report(token: string, input: unknown) {
      if (
        !isRecord(input) ||
        typeof input.id !== "string" ||
        typeof input.lease !== "string" ||
        typeof input.running !== "boolean" ||
        typeof input.logs !== "string" ||
        Buffer.byteLength(input.logs) > 1024 * 1024
      )
        throw new RemoteWorkerError("Invalid remote job report.");
      return store.change((state) => {
        const { worker, job } = authorizedJob(
          state,
          token,
          String(input.id),
          String(input.lease),
        );
        worker.lastSeenAt = clock();
        const secrets = [
          ...Object.values(job.payload.credentials ?? {}),
          ...Object.values(job.payload.testEnvironment?.env ?? {}),
        ];
        job.logs = publicActivityLogs(sanitize(String(input.logs), secrets))
          .join("\n")
          .slice(-1024 * 1024);
        if (input.running === false) {
          if (
            !Number.isInteger(input.exitCode) ||
            Number(input.exitCode) < 0 ||
            Number(input.exitCode) > 255 ||
            !(input.result === null || isRecord(input.result))
          )
            throw new RemoteWorkerError("Invalid terminal job report.");
          const result = JSON.stringify(input.result);
          if (Buffer.byteLength(result) > 256 * 1024)
            throw new RemoteWorkerError("Remote result is too large.");
          job.result = JSON.parse(sanitize(result, secrets));
          if (input.review !== undefined) {
            const plan = job.payload.reviewPlan;
            if (
              !plan ||
              !isRecord(input.review) ||
              input.review.planHash !== hash(JSON.stringify(plan)) ||
              input.review.commitSha !== plan.deployment.sha ||
              !job.files.some((file) => file.name === "pm-review-proof.json")
            )
              throw new RemoteWorkerError(
                "Independent review does not match its assigned plan.",
              );
            job.trustedReview = {
              planHash: String(input.review.planHash),
              commitSha: String(input.review.commitSha),
            };
          }
          job.exitCode = Number(input.exitCode);
          job.status = "exited";
          job.payload = {
            kind: job.payload.kind,
            nonce: job.payload.nonce,
            project: job.payload.project,
          };
        }
        return { ok: true, cancel: !!job.canceled };
      });
    },
    artifact(token: string, input: unknown) {
      if (
        !isRecord(input) ||
        typeof input.id !== "string" ||
        typeof input.lease !== "string" ||
        typeof input.name !== "string" ||
        typeof input.content !== "string" ||
        input.content.length > 14 * 1024 * 1024 ||
        input.content.length % 4 !== 0 ||
        !/^[A-Za-z0-9+/]*={0,2}$/.test(input.content)
      )
        throw new RemoteWorkerError("Invalid remote artifact.");
      return store.change((state) => {
        const { job } = authorizedJob(
          state,
          token,
          String(input.id),
          String(input.lease),
        );
        let content = Buffer.from(String(input.content), "base64");
        if (content.length > 10 * 1024 * 1024)
          throw new RemoteWorkerError("Remote artifact is too large.");
        const name = String(input.name),
          path = filePath(job.id, name);
        if (name === "usage.json" && content.length > 4096)
          throw new RemoteWorkerError("Remote usage metadata is too large.");
        const protectedReview =
          name === "pm-review-proof.json" ||
          name.startsWith("review-screenshots/");
        if (
          name === "pm-review-request.json" ||
          name.split("/").some((part) => part.startsWith(".")) ||
          protectedReview !== Boolean(input.trustedReview) ||
          (protectedReview && !job.payload.reviewPlan)
        )
          throw new RemoteWorkerError(
            "Private or unauthenticated review artifacts cannot be uploaded.",
          );
        if (
          name !== "usage.json" &&
          !job.files.some((f) => f.name === name) &&
          job.files.filter((file) => file.name !== "usage.json").length >= 40
        )
          throw new RemoteWorkerError("Remote artifact limit reached.");
        if (
          name !== "usage.json" &&
          job.files
            .filter((f) => f.name !== name && f.name !== "usage.json")
            .reduce((total, f) => total + f.size, 0) +
            content.length >
            32 * 1024 * 1024
        )
          throw new RemoteWorkerError("Remote artifact total is too large.");
        if (!/\.(png|jpe?g|webp)$/i.test(name))
          content = Buffer.from(
            sanitize(content.toString("utf8"), [
              ...Object.values(job.payload.credentials ?? {}),
              ...Object.values(job.payload.testEnvironment?.env ?? {}),
            ]),
          );
        writePrivate(path, content);
        const png = content
          .subarray(0, 8)
          .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
        job.files = job.files.filter((f) => f.name !== name);
        job.files.push({
          name,
          size: content.length,
          sha256: createHash("sha256").update(content).digest("hex"),
          png,
        });
        return { ok: true };
      });
    },
    adapter(local: DockerRunners): DockerRunners {
      const routing = new Map<string, string>();
      const remoteJob = (id: string) => getJob(store.read(), id);
      return {
        ...local,
        async prepareWorker(workerId, remoteId) {
          if (!remoteId) {
            await local.ensureImage();
            return;
          }
          store.change((state) => {
            const worker = state.workers.find((w) => w.id === remoteId);
            if (!worker || worker.revokedAt || !worker.tokenHash)
              throw new RemoteWorkerError(
                "Enroll this remote worker before launching jobs.",
                409,
              );
            worker.logicalId = workerId;
          });
          routing.set(workerId, remoteId);
        },
        canRun(remoteId, project) {
          if (!remoteId) return true;
          const worker = store.read().workers.find((w) => w.id === remoteId);
          return (
            !!worker &&
            !worker.revokedAt &&
            !!worker.tokenHash &&
            !!worker.lastSeenAt &&
            clock() - worker.lastSeenAt < 60000 &&
            (!project || ownsProject(worker, project))
          );
        },
        canCheckAccess(remoteId, project) {
          if (!remoteId) return true;
          const worker = store.read().workers.find((w) => w.id === remoteId);
          return (
            !!worker &&
            worker.accessProtocol === 1 &&
            !worker.revokedAt &&
            !!worker.tokenHash &&
            !!worker.lastSeenAt &&
            clock() - worker.lastSeenAt < 60000 &&
            (!project || ownsProject(worker, project))
          );
        },
        async startJob(input) {
          const remoteId = routing.get(input.workerId);
          if (!remoteId) return local.startJob(input);
          validatePayload(input.payload);
          return store.change((state) => {
            const worker = state.workers.find((w) => w.id === remoteId);
            if (
              !worker ||
              worker.revokedAt ||
              !worker.tokenHash ||
              ((input.payload.kind !== "verify" || input.payload.accessProbe) &&
                (!input.payload.project ||
                  !ownsProject(worker, input.payload.project)))
            )
              throw new RemoteWorkerError(
                "This remote worker cannot accept work for this project.",
                403,
              );
            if (
              (input.payload.accessProbe || input.payload.testAccess) &&
              worker.accessProtocol !== 1
            )
              throw new RemoteWorkerError(
                "Update this agent service before testing managed sign-in. Its current version does not support private access verification.",
                409,
              );
            const existing = getJob(state, input.id);
            if (existing && !existing.retired) {
              if (
                existing.workerId !== input.workerId ||
                existing.remoteId !== remoteId ||
                ((existing.payload.pmMode === "grumblin" ||
                  input.payload.pmMode === "grumblin") &&
                  (existing.payload.pmMode !== input.payload.pmMode ||
                    !isDeepStrictEqual(
                      existing.payload.grumblin,
                      input.payload.grumblin,
                    ) ||
                    !isDeepStrictEqual(
                      existing.payload.grumblinTarget,
                      input.payload.grumblinTarget,
                    )))
              )
                throw new RemoteWorkerError(
                  "Remote job is already assigned.",
                  409,
                );
              return {
                id: existing.id,
                name: existing.id,
                image: "remote-docker",
              };
            }
            if (
              Object.values(state.jobs).some(
                (j) => j.remoteId === remoteId && j.status !== "exited",
              )
            )
              throw new RemoteWorkerError("This remote worker is busy.", 409);
            state.jobs[input.id] = {
              id: identifier(input.id),
              workerId: identifier(input.workerId),
              remoteId,
              payload: input.payload,
              ...(input.payload.accessProbe || input.payload.testAccess
                ? { requiresAccessCleanup: true as const }
                : {}),
              lease: randomBytes(32).toString("hex"),
              createdAt: clock(),
              status: "assigned",
              logs: "",
              result: null,
              files: [],
            };
            return { id: input.id, name: input.id, image: "remote-docker" };
          });
        },
        async inspectJob(id) {
          if (!remoteJob(id)) return local.inspectJob(id);
          return store.change((state) => {
            const job = state.jobs[id]!;
            expire(job);
            return {
              exists: !job.retired,
              running: job.status !== "exited",
              status: job.status === "exited" ? "exited" : "running",
              exitCode: job.exitCode,
              workerId: job.workerId,
              image: "remote-docker",
            };
          });
        },
        async stopJob(id) {
          if (!remoteJob(id)) return local.stopJob(id);
          store.change((state) => {
            const job = state.jobs[id]!;
            if (job.retired) return;
            job.canceled = true;
            if (!job.leasedAt) {
              job.status = "exited";
              job.exitCode = 130;
              job.result = {
                ok: false,
                kind: job.payload.kind,
                error: "Canceled before remote launch.",
                ...(job.requiresAccessCleanup
                  ? { cleanupConfirmed: true }
                  : {}),
              };
            }
          });
        },
        async logs(id) {
          const job = remoteJob(id);
          return job ? job.logs : local.logs(id);
        },
        async artifacts(id) {
          const job = remoteJob(id);
          if (!job) return local.artifacts(id);
          return {
            result: job.result,
            files: job.status === "exited" ? job.files : [],
          };
        },
        async readArtifact(id, name) {
          const job = remoteJob(id);
          if (!job) return local.readArtifact(id, name);
          if (
            job.status !== "exited" ||
            !job.files.some((f) => f.name === name)
          )
            throw new RemoteWorkerError("Remote artifact is unavailable.", 404);
          const file = filePath(id, name);
          if (!existsSync(file))
            throw new RemoteWorkerError("Remote artifact is unavailable.", 404);
          const bytes = readFileSync(file);
          if (bytes.length > 10 * 1024 * 1024)
            throw new RemoteWorkerError("Remote artifact is too large.");
          return bytes;
        },
        async removeJob(id) {
          if (!remoteJob(id)) return local.removeJob(id);
          store.change((state) => {
            const job = state.jobs[id]!;
            if (job.status !== "exited")
              throw new RemoteWorkerError(
                "Stop the remote job before removing it.",
                409,
              );
            if (
              job.requiresAccessCleanup &&
              job.result?.cleanupConfirmed !== true
            )
              throw new RemoteWorkerError(
                "The agent service has not confirmed private-browser cleanup. Its test account remains reserved.",
                409,
              );
            for (const file of job.files) {
              const path = filePath(id, file.name);
              if (existsSync(path)) unlinkSync(path);
            }
            if (job.requiresAccessCleanup) {
              // Persist routing and confirmed cleanup across controller restart and
              // sequential account probes using the same reserved worker/job ID.
              job.retired = true;
              job.files = [];
              job.logs = "";
              job.result = { cleanupConfirmed: true };
            } else delete state.jobs[id];
          });
        },
        requiresAccessCleanup(id) {
          const job = remoteJob(id);
          return job
            ? !!job.requiresAccessCleanup &&
                job.result?.cleanupConfirmed !== true
            : (local.requiresAccessCleanup?.(id) ?? false);
        },
        async cleanupEnvironment(id) {
          const job = remoteJob(id);
          if (!job) {
            await local.cleanupEnvironment?.(id);
            return;
          }
          if (
            job.requiresAccessCleanup &&
            job.result?.cleanupConfirmed !== true
          )
            throw new RemoteWorkerError(
              "The agent service has not confirmed private-browser cleanup. Its test account remains reserved.",
              409,
            );
        },
        async verifyReview(id, plan, reviewOptions) {
          const job = remoteJob(id);
          if (!job) {
            if (!local.verifyReview)
              throw new RemoteWorkerError(
                "Independent replay is unavailable.",
                503,
              );
            return local.verifyReview(id, plan, reviewOptions);
          }
          if (
            job.status !== "exited" ||
            !job.trustedReview ||
            job.trustedReview.planHash !== hash(JSON.stringify(plan)) ||
            job.trustedReview.commitSha !== plan.deployment.sha
          )
            throw new RemoteWorkerError(
              "This remote run has no independent browser review for this plan.",
              409,
            );
          const proof = readFileSync(filePath(id, "pm-review-proof.json"));
          if (proof.length > 1024 * 1024)
            throw new RemoteWorkerError("Independent review is too large.");
          return {
            proof,
            result: {
              ok: true,
              kind: "pm",
              nonce: id,
              commitSha: plan.deployment.sha,
            },
            files: job.files.filter(
              (file) =>
                file.name === "pm-review-proof.json" ||
                file.name.startsWith("review-screenshots/"),
            ),
          };
        },
      };
    },
    async handleRequest(
      request: IncomingMessage,
      response: ServerResponse,
    ): Promise<boolean> {
      const path = (request.url ?? "").split("?")[0] ?? "";
      if (!path.startsWith("/api/remote/worker/")) return false;
      const send = (status: number, value: unknown) => {
        response.writeHead(status, {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        });
        response.end(JSON.stringify(value));
      };
      try {
        if (
          request.method !== "POST" ||
          request.headers["content-type"]?.split(";")[0] !== "application/json"
        )
          throw new RemoteWorkerError(
            "Use a JSON POST for worker requests.",
            405,
          );
        const token =
          request.headers.authorization?.match(
            /^Bearer ([a-f0-9]{64})$/,
          )?.[1] ?? "";
        if (
          ![
            "/api/remote/worker/enroll",
            "/api/remote/worker/poll",
            "/api/remote/worker/report",
            "/api/remote/worker/artifact",
          ].includes(path)
        )
          throw new RemoteWorkerError("Worker route not found.", 404);
        if (path !== "/api/remote/worker/enroll")
          authenticate(store.read(), token);
        let body = "";
        for await (const chunk of request) {
          body += chunk.toString("utf8");
          if (
            Buffer.byteLength(body) >
            (path.endsWith("/artifact") ? 15 * 1024 * 1024 : 2 * 1024 * 1024)
          )
            throw new RemoteWorkerError("Worker request is too large.", 413);
        }
        let input: unknown;
        try {
          input = JSON.parse(body);
        } catch {
          throw new RemoteWorkerError("Invalid worker JSON request.");
        }
        const result =
          path === "/api/remote/worker/enroll"
            ? api.enroll(input)
            : path === "/api/remote/worker/poll"
              ? api.poll(token, input)
              : path === "/api/remote/worker/report"
                ? api.report(token, input)
                : path === "/api/remote/worker/artifact"
                  ? api.artifact(token, input)
                  : null;
        if (result === null)
          throw new RemoteWorkerError("Worker route not found.", 404);
        send(200, result);
      } catch (error) {
        send(error instanceof RemoteWorkerError ? error.status : 503, {
          error:
            error instanceof RemoteWorkerError
              ? error.message
              : "Remote worker request could not be completed.",
        });
      }
      return true;
    },
  };
  return api;
}
export type RemoteWorkers = ReturnType<typeof createRemoteWorkers>;
