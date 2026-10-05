import {
  existsSync,
  readFileSync,
  mkdirSync,
  writeFileSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { isIP } from "node:net";
import { createHash } from "node:crypto";
import type {
  DockerJobPayload,
  DockerRunners,
  DockerArtifacts,
} from "../localRunners/docker.ts";
import { safeOAuthPath } from "../oauthConnection/storage.ts";
import {
  RemoteWorkerError,
  writePrivate,
  validRemoteArtifactName,
} from "./storage.ts";

export function controllerUrl(raw: string, allowInsecureLan = false): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new RemoteWorkerError("Choose a valid controller HTTPS origin.");
  }
  if (
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new RemoteWorkerError(
      "Use the controller origin without a path, credentials, or session fragment.",
    );
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const loopback =
    host === "localhost" ||
    host === "::1" ||
    (isIP(host) === 4 && /^127\./.test(host));
  const [first = 0, second = 0] = host.split(".").map(Number);
  const privateIp =
    isIP(host) === 4 &&
    (first === 10 ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168) ||
      (first === 100 && second >= 64 && second <= 127));
  if (
    url.protocol !== "https:" &&
    !(url.protocol === "http:" && (loopback || (allowInsecureLan && privateIp)))
  )
    throw new RemoteWorkerError(
      "Remote workers require HTTPS. Explicit --allow-insecure-lan only permits private or Tailscale IP addresses.",
    );
  return url.origin;
}
interface Active {
  id: string;
  workerId: string;
  lease: string;
  attempted: boolean;
}
export function lockWorkerDirectory(root: string): () => void {
  safeOAuthPath(root);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const path = safeOAuthPath(join(root, "process.lock"));
  if (existsSync(path)) {
    try {
      const owner = JSON.parse(readFileSync(path, "utf8"));
      if (Number.isSafeInteger(owner.pid) && owner.pid > 0) {
        try {
          process.kill(owner.pid, 0);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ESRCH")
            unlinkSync(path);
        }
      }
    } catch {
      /* An unreadable lock must not be claimed. */
    }
  }
  try {
    writeFileSync(path, JSON.stringify({ pid: process.pid }), {
      flag: "wx",
      mode: 0o600,
    });
  } catch {
    throw new RemoteWorkerError(
      "Another worker process is using this worker directory. Stop it or select a different --worker-home.",
      409,
    );
  }
  return () => {
    safeOAuthPath(path);
    if (
      existsSync(path) &&
      JSON.parse(readFileSync(path, "utf8")).pid === process.pid
    )
      unlinkSync(path);
  };
}
interface Saved {
  schema: 1;
  controller: string;
  id: string;
  token: string;
  active?: Active;
}
interface Assignment extends Active {
  cancel?: boolean;
  ttlMs?: number;
  payload?: DockerJobPayload;
}
const tokenPattern = /^[a-f0-9]{64}$/;
const jobPattern = /^[a-z0-9][a-z0-9-]{0,62}$/;
export function selectRemoteArtifacts(
  files: DockerArtifacts["files"],
  trustedNames: ReadonlySet<string>,
) {
  const selected: DockerArtifacts["files"] = [];
  let size = 0,
    omittedTrusted = false;
  const sorted = [
    ...new Map(files.map((file) => [file.name, file])).values(),
  ].sort(
    (a, b) =>
      Number(trustedNames.has(b.name)) - Number(trustedNames.has(a.name)),
  );
  for (const file of sorted) {
    if (
      (file.name === "pm-review-proof.json" ||
        file.name.startsWith("review-screenshots/")) &&
      !trustedNames.has(file.name)
    )
      continue;
    if (
      !validRemoteArtifactName(file.name) ||
      !Number.isSafeInteger(file.size) ||
      file.size < 0 ||
      file.size > 10 * 1024 * 1024 ||
      selected.length >= 40 ||
      size + file.size > 32 * 1024 * 1024
    ) {
      if (trustedNames.has(file.name)) omittedTrusted = true;
      continue;
    }
    selected.push(file);
    size += file.size;
  }
  return { files: selected, omittedTrusted };
}
export function createRemoteWorker(options: {
  root: string;
  controller: string;
  docker: DockerRunners;
  allowInsecureLan?: boolean;
  fetch?: typeof fetch;
  onMessage?: (message: string) => void;
  clock?: () => number;
}) {
  const origin = controllerUrl(options.controller, options.allowInsecureLan),
    file = safeOAuthPath(join(options.root, "remote-worker.json")),
    fetcher = options.fetch ?? fetch,
    clock = options.clock ?? Date.now;
  const read = (): Saved | null => {
    safeOAuthPath(file);
    if (!existsSync(file)) return null;
    try {
      const state = JSON.parse(readFileSync(file, "utf8"));
      if (
        state.schema !== 1 ||
        state.controller !== origin ||
        !tokenPattern.test(state.token) ||
        !/^remote-[a-f0-9-]{36}$/.test(state.id) ||
        (state.active &&
          (!jobPattern.test(state.active.id) ||
            !jobPattern.test(state.active.workerId) ||
            !tokenPattern.test(state.active.lease) ||
            typeof state.active.attempted !== "boolean"))
      )
        throw new Error();
      return state;
    } catch {
      throw new RemoteWorkerError(
        "This worker directory belongs to another controller or has invalid state. Use its original controller or a new worker directory.",
        409,
      );
    }
  };
  const save = (state: Saved) => writePrivate(file, JSON.stringify(state));
  async function request(path: string, body: unknown, token?: string) {
    let response: Response;
    try {
      response = await fetcher(`${origin}/api/remote/worker/${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(body),
        redirect: "error",
        signal: AbortSignal.timeout(30000),
      });
    } catch {
      throw new RemoteWorkerError(
        "The controller could not be reached. Existing work is protected by its expiring lease.",
        503,
      );
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new RemoteWorkerError(
        response.status === 401
          ? "Worker access is invalid or revoked. Enroll with a new code."
          : "The controller rejected this worker request.",
        response.status,
      );
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    if (response.body)
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > 2 * 1024 * 1024)
          throw new RemoteWorkerError(
            "The controller response is too large.",
            502,
          );
        chunks.push(chunk);
      }
    const bytes = Buffer.concat(chunks).toString("utf8");
    try {
      return JSON.parse(bytes);
    } catch {
      throw new RemoteWorkerError("Invalid controller response.", 502);
    }
  }
  async function stop(active: Active) {
    await options.docker.stopJob(active.id);
    const inspect = await options.docker.inspectJob(active.id);
    if (inspect.running)
      throw new RemoteWorkerError(
        "Waiting for the owned job container to stop.",
        409,
      );
    await options.docker.cleanupEnvironment?.(active.id);
  }
  async function renew(job: Assignment, requestAt: number) {
    const remaining =
      Math.min(120000, Number(job.ttlMs)) -
      Math.max(0, clock() - requestAt) -
      10000;
    if (!Number.isFinite(remaining) || remaining < 1000) {
      await stop(job);
      throw new RemoteWorkerError(
        "The job lease expired before work could start.",
        409,
      );
    }
    if (!options.docker.refreshLease)
      throw new RemoteWorkerError(
        "This worker version cannot enforce remote leases. Update ShipGremlins.",
        409,
      );
    await options.docker.refreshLease(job.id, Math.floor(remaining));
  }
  let inStep = false;
  return {
    async enroll(code: string) {
      if (read())
        throw new RemoteWorkerError(
          "This worker is already enrolled. Use a separate worker directory for another slot.",
          409,
        );
      if (!tokenPattern.test(code))
        throw new RemoteWorkerError(
          "Use the one-time code shown by the controller.",
        );
      const result = await request("enroll", {
        code,
        platform: process.platform,
        architecture: process.arch,
      });
      if (
        !tokenPattern.test(result.token) ||
        !/^remote-[a-f0-9-]{36}$/.test(result.id)
      )
        throw new RemoteWorkerError("Invalid enrollment response.", 502);
      save({
        schema: 1,
        controller: origin,
        id: result.id,
        token: result.token,
      });
      return { id: result.id };
    },
    async step() {
      if (inStep) return;
      inStep = true;
      try {
        const state = read();
        if (!state)
          throw new RemoteWorkerError(
            "Enroll this worker with a one-time code first.",
            401,
          );
        const at = clock();
        let response;
        try {
          response = await request("poll", {}, state.token);
        } catch (error) {
          if (
            error instanceof RemoteWorkerError &&
            error.status === 401 &&
            state.active
          )
            await stop(state.active);
          throw error;
        }
        const job = response.job as Assignment | null;
        await options.docker.reconcileEnvironments?.([
          ...(state.active ? [state.active.id] : []),
          ...(job ? [job.id] : []),
        ]);
        if (!job) {
          if (state.active) {
            await stop(state.active);
            delete state.active;
            save(state);
          }
          return;
        }
        if (!jobPattern.test(job.id) || !tokenPattern.test(job.lease))
          throw new RemoteWorkerError("Invalid job assignment.", 502);
        if (
          state.active &&
          (state.active.id !== job.id || state.active.lease !== job.lease)
        ) {
          await stop(state.active);
          throw new RemoteWorkerError(
            "The controller changed an active job lease. Work is stopped for review.",
            409,
          );
        }
        if (job.cancel) {
          if (state.active) await stop(state.active);
          await request(
            "report",
            {
              id: job.id,
              lease: job.lease,
              running: false,
              exitCode: 130,
              logs: "Job canceled by its owner.",
              result: { ok: false, error: "Job canceled by its owner." },
            },
            state.token,
          );
          delete state.active;
          save(state);
          return;
        }
        if (
          !jobPattern.test(job.workerId) ||
          !job.payload ||
          job.payload.remoteLease !== true
        )
          throw new RemoteWorkerError(
            "Invalid isolated Docker job assignment.",
            502,
          );
        state.active ??= {
          id: job.id,
          workerId: job.workerId,
          lease: job.lease,
          attempted: false,
        };
        save(state);
        let inspect = await options.docker.inspectJob(job.id);
        if (!inspect.exists) {
          if (state.active.attempted) {
            await request(
              "report",
              {
                id: job.id,
                lease: job.lease,
                running: false,
                exitCode: 125,
                logs: "An attempted remote launch cannot be found. It will not be repeated automatically.",
                result: {
                  ok: false,
                  kind: job.payload.kind,
                  error:
                    "Remote launch is ambiguous; reconcile before retrying.",
                },
              },
              state.token,
            );
            delete state.active;
            save(state);
            return;
          }
          state.active.attempted = true;
          save(state);
          const launchPayload = {
            ...job.payload,
            remoteLeaseDeadline:
              clock() +
              Math.min(120000, Number(job.ttlMs)) -
              Math.max(0, clock() - at) -
              10000,
          };
          // App builds can outlast a lease. Poll during preparation, then let the
          // Docker adapter enforce the last confirmed deadline before executing AI.
          let renewing: Promise<void> | undefined;
          let revoked = false;
          const heartbeat = setInterval(() => {
            if (renewing || revoked) return;
            renewing = (async () => {
              const started = clock();
              try {
                const current = await request("poll", {}, state.token);
                if (
                  !current.job ||
                  current.job.id !== job.id ||
                  current.job.lease !== job.lease ||
                  current.job.cancel
                ) {
                  revoked = true;
                  launchPayload.remoteLeaseDeadline = 0;
                  return;
                }
                launchPayload.remoteLeaseDeadline =
                  started + Math.min(120000, Number(current.job.ttlMs)) - 10000;
                const running = await options.docker.inspectJob(job.id);
                if (running.running) await renew(current.job, started);
              } catch {
                /* The last confirmed deadline remains in force. */
              }
            })().finally(() => {
              renewing = undefined;
            });
          }, 20000);
          try {
            await options.docker.startJob({
              id: job.id,
              workerId: job.workerId,
              payload: launchPayload,
            });
          } finally {
            clearInterval(heartbeat);
            await renewing;
          }
          if (revoked || launchPayload.remoteLeaseDeadline < clock() + 1000) {
            await stop(job);
            throw new RemoteWorkerError(
              "The job lease ended during environment preparation.",
              409,
            );
          }
          inspect = await options.docker.inspectJob(job.id);
        }
        if (inspect.workerId !== job.workerId)
          throw new RemoteWorkerError(
            "The container does not belong to this worker assignment.",
            403,
          );
        if (inspect.running) {
          const freshAt = clock(),
            fresh = await request("poll", {}, state.token);
          if (
            !fresh.job ||
            fresh.job.id !== job.id ||
            fresh.job.lease !== job.lease ||
            fresh.job.cancel
          ) {
            await stop(job);
            return;
          }
          await renew(fresh.job, freshAt);
        }
        let logs = await options.docker.logs(job.id).catch(() => "");
        if (inspect.running) {
          const reported = await request(
            "report",
            {
              id: job.id,
              lease: job.lease,
              running: true,
              logs: logs.slice(-900000),
            },
            state.token,
          );
          if (reported.cancel) await stop(job);
          return;
        }
        const artifacts: DockerArtifacts = await options.docker
          .artifacts(job.id)
          .catch(() => ({ result: null, files: [] }));
        let review: { planHash: string; commitSha: string } | undefined;
        const trustedNames = new Set<string>();
        if (inspect.exitCode === 0 && job.payload.reviewPlan) {
          let renewing = false;
          const heartbeat = setInterval(() => {
            if (renewing) return;
            renewing = true;
            void (async () => {
              const started = clock();
              try {
                const current = await request("poll", {}, state.token);
                if (
                  !current.job ||
                  current.job.id !== job.id ||
                  current.job.lease !== job.lease ||
                  current.job.cancel
                ) {
                  await stop(job);
                  return;
                }
                await renew(current.job, started);
              } catch (error) {
                if (
                  error instanceof RemoteWorkerError &&
                  [401, 403, 409].includes(error.status)
                )
                  await stop(job);
              }
            })()
              .catch(() => {})
              .finally(() => {
                renewing = false;
              });
          }, 20000);
          try {
            if (!options.docker.verifyReview)
              throw new Error("Independent review unavailable.");
            const trusted = await options.docker.verifyReview(
              job.id,
              job.payload.reviewPlan,
              {
                bypass: job.payload.credentials?.GREMLINS_PREVIEW_BYPASS,
                remoteLease: true,
              },
            );
            for (const file of trusted.files)
              if (
                file.name === "pm-review-proof.json" ||
                file.name.startsWith("review-screenshots/")
              ) {
                trustedNames.add(file.name);
                artifacts.files.push(file);
              }
            review = {
              planHash: createHash("sha256")
                .update(JSON.stringify(job.payload.reviewPlan))
                .digest("hex"),
              commitSha: job.payload.reviewPlan.deployment.sha,
            };
          } catch {
            inspect.exitCode = 1;
            artifacts.result = {
              ok: false,
              kind: job.payload.kind,
              error:
                "Independent browser review could not complete. Promotion remains blocked.",
            };
            logs +=
              "\nIndependent browser review could not complete. Promotion remains blocked.";
          } finally {
            clearInterval(heartbeat);
          }
        }
        const selected = selectRemoteArtifacts(artifacts.files, trustedNames);
        if (selected.omittedTrusted) {
          review = undefined;
          inspect.exitCode = 1;
          artifacts.result = {
            ok: false,
            kind: job.payload.kind,
            error:
              "Independent review evidence exceeds the remote upload quota. Narrow the review and run it again.",
          };
          logs +=
            "\nIndependent review evidence exceeds the remote upload quota; promotion remains blocked.";
        }
        for (const artifact of selected.files) {
          if (
            (artifact.name === "pm-review-proof.json" ||
              artifact.name.startsWith("review-screenshots/")) &&
            !trustedNames.has(artifact.name)
          )
            continue;
          if (
            !validRemoteArtifactName(artifact.name) ||
            artifact.size > 10 * 1024 * 1024
          )
            continue;
          const polled = await request("poll", {}, state.token);
          if (
            !polled.job ||
            polled.job.id !== job.id ||
            polled.job.lease !== job.lease
          )
            throw new RemoteWorkerError(
              "The job lease ended before evidence upload.",
              409,
            );
          const content = await options.docker.readArtifact(
            job.id,
            artifact.name,
          );
          await request(
            "artifact",
            {
              id: job.id,
              lease: job.lease,
              name: artifact.name,
              content: content.toString("base64"),
              ...(trustedNames.has(artifact.name)
                ? { trustedReview: true }
                : {}),
            },
            state.token,
          );
        }
        await request(
          "report",
          {
            id: job.id,
            lease: job.lease,
            running: false,
            exitCode: inspect.exitCode ?? 1,
            logs: logs.slice(-900000),
            result: artifacts.result,
            ...(review ? { review } : {}),
          },
          state.token,
        );
        await options.docker.cleanupEnvironment?.(job.id);
        delete state.active;
        save(state);
      } finally {
        inStep = false;
      }
    },
    async stop() {
      const active = read()?.active;
      if (active) await stop(active);
    },
  };
}
