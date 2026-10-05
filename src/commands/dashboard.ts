import { randomBytes, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { isIPv4, type AddressInfo } from "node:net";
import {
  hostname,
  networkInterfaces,
  type NetworkInterfaceInfo,
} from "node:os";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  listProjectNames,
  loadHub,
  loadProject,
  validSourceRepository,
  validSourceServer,
} from "../config.ts";
import { telemetrySecrets } from "../telemetry/config.ts";
import {
  CONNECTIONS,
  readConnections,
  saveConnections,
  projectConnections as projectConnectionDefinitions,
} from "../setup/connections.ts";
import { assertNoSymlinks } from "../setup/files.ts";
import {
  ConfigEditorError,
  listEditableConfigs,
  readEditableConfig,
  saveEditableConfig,
} from "../setup/configEditor.ts";
import { canOpenFolders, openDashboardFolder } from "../setup/openFolder.ts";
import { parseFlags, type Io } from "./crons.ts";
import { runSetup } from "./setup.ts";
import { createUpdater, type Updater } from "../update/index.ts";
import {
  createLocalRunners,
  LocalRunnerError,
  type LocalRunners,
} from "../localRunners/engine.ts";
import {
  createDockerRunners,
  type DockerRunners,
} from "../localRunners/docker.ts";
import { createJobPreparation } from "../localRunners/jobs.ts";
import type { LocalJobInput, WorkerAction } from "../localRunners/types.ts";
import {
  doctorChecks,
  stampVerified,
  verificationSnapshot,
  VerificationConflictError,
} from "./doctor.ts";
import { createSlackConnect } from "../slack/connection.ts";
import { createSourceControl } from "../sourceControl/index.ts";
import {
  effectiveVerification,
  effectiveWorkflow,
} from "../projectCapabilities.ts";
import {
  createLinearConnection,
  type LinearConnection,
} from "../linearConnection/index.ts";
import {
  createVercelConnection,
  type VercelConnection,
} from "../vercelConnection/index.ts";
import { OAuthConnectionError } from "../oauthConnection/types.ts";
import { LinearApi } from "../services/linear.ts";
import {
  createLinearProvisioning,
  LinearProvisioningError,
  type LinearMappingStatus,
} from "../setup/linearProvisioning.ts";
import {
  SourceControlError,
  type SourceControl,
  type SourceStatus,
} from "../sourceControl/types.ts";
import {
  createActivityStore,
  parseActivityLogs,
  type ActivityStore,
} from "../storage/activity.ts";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webp": "image/webp",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};
const MAX_BODY = 32 * 1024;

/** Advertise private LAN/Tailscale IPv4 interfaces, never public or loopback addresses. */
export function lanAddresses(
  interfaces: Record<
    string,
    NetworkInterfaceInfo[] | undefined
  > = networkInterfaces(),
): string[] {
  return [
    ...new Set(
      Object.values(interfaces)
        .flatMap((entries) => entries ?? [])
        .filter(
          (entry) =>
            !entry.internal && entry.family === "IPv4" && isIPv4(entry.address),
        )
        .map((entry) => entry.address)
        .filter((address) => {
          const [first, second] = address.split(".").map(Number);
          return (
            first === 10 ||
            (first === 172 && second! >= 16 && second! <= 31) ||
            (first === 192 && second === 168) ||
            (first === 100 && second! >= 64 && second! <= 127)
          );
        }),
    ),
  ].sort();
}

class RequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
async function body(
  req: IncomingMessage,
  limit = MAX_BODY,
): Promise<Record<string, unknown>> {
  if (
    !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(
      req.headers["content-type"] ?? "",
    )
  )
    throw new RequestError(415, "Use application/json.");
  if (Number(req.headers["content-length"] ?? 0) > limit)
    throw new RequestError(413, "Request is too large.");
  const chunks = await new Promise<Buffer[]>((accept, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const cleanup = () => {
      req.removeListener("data", onData);
      req.removeListener("end", onEnd);
      req.removeListener("error", onError);
    };
    const onError = () => {
      cleanup();
      reject(new RequestError(400, "Request could not be read."));
    };
    const onEnd = () => {
      cleanup();
      accept(chunks);
    };
    const onData = (bytes: Buffer) => {
      size += bytes.length;
      if (size > limit) {
        cleanup();
        req.resume();
        reject(new RequestError(413, "Request is too large."));
      } else chunks.push(bytes);
    };
    req.on("data", onData);
    req.once("end", onEnd);
    req.once("error", onError);
  });
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!record(value)) throw new Error();
    return value;
  } catch {
    throw new RequestError(400, "Expected a JSON object.");
  }
}

export interface DashboardOptions {
  updater?: Updater;
  restart?: () => void;
  runners?: LocalRunners;
  docker?: DockerRunners;
  jobs?: ReturnType<typeof createJobPreparation>;
  shutdown?: () => void;
  background?: boolean;
  slack?: ReturnType<typeof createSlackConnect>;
  activityStore?: ActivityStore;
  sourceControl?: SourceControl;
  linearConnection?: LinearConnection;
  vercelConnection?: VercelConnection;
  linearProvisioning?: ReturnType<typeof createLinearProvisioning>;
}

export function createDashboardServer(
  root: string,
  packageRoot: string,
  session: string,
  networkHosts: readonly string[] = [],
  options: DashboardOptions = {},
): Server {
  if (!/^[a-f0-9]{64}$/.test(session))
    throw new Error("Invalid dashboard session.");
  if (networkHosts.some((host) => !isIPv4(host)))
    throw new Error("Dashboard network hosts must be IPv4 addresses.");
  const hosts = new Set(["127.0.0.1", ...networkHosts]);
  // Update checks are explicit; opening the static page never makes a network request.
  let updater = options.updater;
  const updates = () =>
    (updater ??= createUpdater({ configurationRoot: root, packageRoot }));
  let updateRunning = false;
  let updateFailure = "";
  const docker = options.docker ?? createDockerRunners({ packageRoot });
  const sourceControl =
    options.sourceControl ?? createSourceControl({ root, session });
  const linearConnection =
    options.linearConnection ?? createLinearConnection({ root, session });
  const vercelConnection =
    options.vercelConnection ?? createVercelConnection({ root, session });
  const linearProvisioning =
    options.linearProvisioning ??
    createLinearProvisioning({
      root,
      client: async () =>
        new LinearApi({
          apiKey: (
            await linearConnection.resolveCredential({
              minValidityMs: 5 * 60_000,
            })
          ).authorization,
        }),
    });
  async function provisionLinear(
    project: string,
    teamId?: string,
  ): Promise<LinearMappingStatus> {
    try {
      const status = await linearConnection.status({
        checkAvailability: false,
      });
      if (!status.connected)
        return {
          status: "needs-connection",
          message:
            "App and PM settings are saved. Connect Linear, then retry Linear setup.",
        };
      return await linearProvisioning.provision(project, { teamId });
    } catch (error) {
      return {
        status: "error",
        message:
          error instanceof LinearProvisioningError
            ? error.message
            : "Linear setup did not finish. Saved settings were preserved; reconnect Linear and retry.",
      };
    }
  }
  const preparation =
    options.jobs ??
    createJobPreparation({
      root,
      sourceControl,
      linearConnection,
      vercelConnection,
    });
  const slack = options.slack ?? createSlackConnect({ root, session });
  const activityStore = options.activityStore ?? createActivityStore({ root });
  let manager: LocalRunners | undefined = options.runners;
  const runners = () =>
    (manager ??= createLocalRunners({
      root,
      packageRoot,
      docker,
      activityStore,
      ...preparation,
      beforeLaunch: () => activityStore.ensure(),
      releaseJobResources: preparation.releaseJobResources,
    }));
  let dockerState: Awaited<ReturnType<DockerRunners["preflight"]>> | undefined;
  let dockerCheckedAt = 0;
  async function runnerStatus() {
    if (!dockerState || Date.now() - dockerCheckedAt > 15_000) {
      dockerState = await docker.preflight();
      dockerCheckedAt = Date.now();
    }
    const saved = readConnections(root);
    const sources = await sourceControl.status();
    const serviceConnections = await Promise.all([
      linearConnection.status({ checkAvailability: false }),
      vercelConnection.status({ checkAvailability: false }),
    ]);
    const blockedSources = new Set<string>();
    const required = new Set(["CLAUDE_CODE_OAUTH_TOKEN", "LINEAR_API_KEY"]);
    for (const connection of serviceConnections) {
      const name =
        connection.provider === "linear" ? "LINEAR_API_KEY" : "VERCEL_TOKEN";
      if (connection.connected && !connection.needsReconnect)
        required.delete(name);
      else if (connection.method === "oauth") blockedSources.add(name);
    }
    for (const name of listProjectNames(root)) {
      try {
        const project = loadProject(root, name);
        const verification = effectiveVerification(project.config);
        if (verification.mode === "browser") {
          const target = verification.target;
          if (target.kind === "vercel") {
            const connection = serviceConnections.find(
              (item) => item.provider === "vercel",
            );
            if (!connection?.connected || connection.needsReconnect)
              required.add("VERCEL_TOKEN");
            if (target.bypassSecret) required.add(target.bypassSecret);
          }
          if (target.kind === "railway")
            required.add(target.tokenSecret ?? "RAILWAY_TOKEN");
          if (target.kind === "cloud-run" && target.credentialsSecret)
            required.add(target.credentialsSecret);
          if (project.config.signIn)
            required.add(project.config.signIn.databaseUrlSecret);
        }
        const provider = project.config.provider ?? "github";
        const serverUrl =
          project.config.serverUrl ??
          (provider === "gitlab" ? "https://gitlab.com" : "https://github.com");
        const oauth = sources.find(
          (connection) =>
            connection.provider === provider &&
            connection.serverUrl.replace(/\/$/, "") ===
              serverUrl.replace(/\/$/, "") &&
            connection.method === "oauth",
        );
        const sourceKey =
          provider === "gitlab" ? "GITLAB_TOKEN" : "GITHUB_TOKEN";
        if (!oauth || !oauth.connected || oauth.needsReconnect)
          required.add(sourceKey);
        if (oauth && (!oauth.connected || oauth.needsReconnect))
          blockedSources.add(sourceKey);
      } catch {
        /* Status reports broken project config separately. */
      }
    }
    return {
      ...(await runners().status()),
      machine: {
        name: hostname(),
        platform: process.platform,
        docker: dockerState,
      },
      storage: await activityStore.status().catch(() => ({
        configured: false,
        ready: false,
        mode: "unconfigured",
        message:
          "Run history is unavailable. Check the local PostgreSQL service.",
      })),
      credentials: {
        missing: [...required].filter(
          (name) =>
            blockedSources.has(name) || !(saved[name] || process.env[name]),
        ),
        configured: [...required].filter(
          (name) =>
            !blockedSources.has(name) &&
            Boolean(saved[name] || process.env[name]),
        ),
      },
      sourceConnections: sources,
      serviceConnections,
      limitations: [
        "Local workers use Claude Code. Each worker runs one job at a time.",
        "Jobs create draft PRs/MRs to each project's selected base branch; merges and release decisions need review.",
        "Closing the browser is safe. Keep the controller running for schedules and queued jobs.",
      ],
    };
  }
  const updateStatus = () => ({
    ...updates().status(),
    ...(updateFailure
      ? { phase: "error" as const, message: updateFailure }
      : {}),
    canRestart: Boolean(options.restart),
  });
  const server = createServer(async (req, res) => {
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; connect-src 'self'; img-src 'self' blob:; style-src 'self'; font-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    try {
      const address = server.address() as AddressInfo | null;
      const host = req.headers.host ?? "";
      const origin = `http://${host}`;
      if (
        ![...hosts].some((allowed) => host === `${allowed}:${address?.port}`) ||
        (req.headers.origin !== undefined && req.headers.origin !== origin) ||
        (req.headers["sec-fetch-site"] === "cross-site" &&
          !(
            req.method === "GET" &&
            req.url === "/" &&
            req.headers["sec-fetch-mode"] === "navigate"
          ))
      )
        throw new RequestError(
          403,
          "Use a dashboard address printed by the CLI and its matching browser session.",
        );
      const url = new URL(req.url ?? "/", origin);
      if (url.origin !== origin)
        throw new RequestError(403, "Invalid request origin.");
      if (url.pathname.startsWith("/api/")) {
        const supplied = Buffer.from(req.headers.authorization ?? "");
        const expected = Buffer.from(`Bearer ${session}`);
        if (
          supplied.length !== expected.length ||
          !timingSafeEqual(supplied, expected)
        )
          throw new RequestError(
            401,
            "Open the dashboard link printed by your CLI.",
          );
        if (
          url.pathname === "/api/source-control" ||
          url.pathname.startsWith("/api/source-control/")
        ) {
          try {
            const match =
              /^\/api\/source-control(?:\/(github|gitlab)(?:\/(connect|poll|repositories))?)?$/.exec(
                url.pathname,
              );
            if (!match)
              throw new RequestError(404, "Unknown source-control action.");
            const provider = match[1] as "github" | "gitlab" | undefined;
            const action = match[2];
            if (!provider && req.method === "GET" && !url.search) {
              json(res, 200, { connections: await sourceControl.status() });
            } else if (
              provider &&
              action === "repositories" &&
              req.method === "GET"
            ) {
              const search = url.searchParams.get("search") ?? undefined;
              if (
                [...url.searchParams.keys()].some((key) => key !== "search") ||
                (search?.length ?? 0) > 100
              )
                throw new RequestError(400, "Use a short repository search.");
              json(
                res,
                200,
                await sourceControl.repositories({ provider, search }),
              );
            } else if (
              provider &&
              !url.search &&
              req.method === "POST" &&
              action === "connect"
            ) {
              if (Object.keys(await body(req)).length)
                throw new RequestError(
                  400,
                  "Source connection takes an empty JSON object. Official provider addresses are fixed.",
                );
              json(res, 200, await sourceControl.connect({ provider }));
            } else if (
              provider &&
              !url.search &&
              req.method === "POST" &&
              action === "poll"
            ) {
              const input = await body(req);
              if (
                Object.keys(input).length !== 1 ||
                typeof input.id !== "string" ||
                !/^[A-Za-z0-9_-]{1,128}$/.test(input.id)
              )
                throw new RequestError(
                  400,
                  "Provide the pending source connection ID.",
                );
              json(res, 200, await sourceControl.poll(input.id));
            } else if (
              provider &&
              !action &&
              !url.search &&
              req.method === "DELETE"
            ) {
              if (Object.keys(await body(req)).length)
                throw new RequestError(
                  400,
                  "Disconnect takes an empty JSON object.",
                );
              json(res, 200, await sourceControl.disconnect({ provider }));
            } else
              throw new RequestError(
                405,
                "Unsupported source-control request.",
              );
          } catch (error) {
            if (error instanceof RequestError) throw error;
            if (error instanceof SourceControlError)
              throw new RequestError(error.status, error.message);
            throw new RequestError(
              400,
              "Source control could not complete this request. Check the connection and try again.",
            );
          }
          return;
        }
        const serviceAction =
          /^\/api\/(linear|vercel)(?:\/(connect|complete|resources))?$/.exec(
            url.pathname,
          );
        if (serviceAction) {
          const connection =
            serviceAction[1] === "linear" ? linearConnection : vercelConnection;
          const action = serviceAction[2];
          try {
            if (req.method === "GET" && !action)
              json(res, 200, await connection.status());
            else if (
              req.method === "GET" &&
              action === "resources" &&
              serviceAction[1] === "linear"
            )
              json(res, 200, await linearProvisioning.resources());
            else if (req.method === "DELETE" && !action) {
              if (Object.keys(await body(req)).length)
                throw new RequestError(
                  400,
                  "Disconnect takes an empty JSON object.",
                );
              json(res, 200, await connection.disconnect());
            } else if (req.method === "POST" && action === "connect") {
              if (Object.keys(await body(req)).length)
                throw new RequestError(
                  400,
                  "Connection setup takes an empty JSON object.",
                );
              json(res, 200, await connection.connect(`${origin}/`));
            } else if (req.method === "POST" && action === "complete") {
              const value = await body(req);
              if (
                Object.keys(value).length !== 1 ||
                typeof value.envelope !== "string"
              )
                throw new RequestError(
                  400,
                  "Provide the connection setup envelope.",
                );
              json(res, 200, await connection.complete(value.envelope));
            } else
              throw new RequestError(405, "Unsupported connection action.");
          } catch (error) {
            if (error instanceof RequestError) throw error;
            if (
              error instanceof OAuthConnectionError ||
              error instanceof LinearProvisioningError
            )
              throw new RequestError(error.status, error.message);
            throw new RequestError(
              400,
              "The connection request did not finish. Check access and try again.",
            );
          }
          return;
        }
        if (
          url.pathname === "/api/slack" ||
          url.pathname.startsWith("/api/slack/")
        ) {
          try {
            if (url.pathname === "/api/slack" && req.method === "GET") {
              json(res, 200, await slack.status());
            } else if (
              url.pathname === "/api/slack" &&
              req.method === "DELETE"
            ) {
              if (Object.keys(await body(req)).length)
                throw new RequestError(
                  400,
                  "Disconnect takes an empty JSON object.",
                );
              json(res, 200, await slack.disconnect());
            } else if (
              req.method === "POST" &&
              url.pathname === "/api/slack/connect"
            ) {
              if (Object.keys(await body(req)).length)
                throw new RequestError(
                  400,
                  "Slack setup takes an empty JSON object.",
                );
              json(res, 200, await slack.connect(`${origin}/`));
            } else if (
              req.method === "POST" &&
              url.pathname === "/api/slack/complete"
            ) {
              const value = await body(req);
              if (
                Object.keys(value).length !== 1 ||
                typeof value.envelope !== "string"
              )
                throw new RequestError(
                  400,
                  "Provide the Slack setup envelope.",
                );
              json(res, 200, await slack.complete(value.envelope));
            } else if (
              req.method === "POST" &&
              url.pathname === "/api/slack/webhook"
            ) {
              const value = await body(req);
              if (
                Object.keys(value).length !== 1 ||
                typeof value.url !== "string"
              )
                throw new RequestError(400, "Provide a Slack webhook URL.");
              json(res, 200, await slack.webhook(value.url));
            } else throw new RequestError(405, "Unsupported Slack action.");
          } catch (error) {
            if (error instanceof RequestError) throw error;
            throw new RequestError(
              400,
              error instanceof Error ? error.message : "Slack setup failed.",
            );
          }
          return;
        }
        if (url.pathname === "/api/controller" && req.method === "GET") {
          json(res, 200, { background: options.background === true });
          return;
        }
        if (url.pathname === "/api/controller/stop") {
          if (req.method !== "POST")
            throw new RequestError(405, "Use POST to stop the controller.");
          if (!options.background || !options.shutdown)
            throw new RequestError(
              400,
              "Stop this foreground dashboard with Ctrl+C.",
            );
          if (Object.keys(await body(req)).length)
            throw new RequestError(400, "Stop takes an empty object.");
          res.once("finish", options.shutdown);
          json(res, 202, { ok: true });
          return;
        }
        if (url.pathname === "/api/runners") {
          if (req.method === "GET") json(res, 200, await runnerStatus());
          else if (req.method === "POST") {
            if (Object.keys(await body(req)).length)
              throw new RequestError(
                400,
                "Worker creation takes an empty JSON object.",
              );
            const runner = await runners().create();
            runners().start();
            json(res, 202, { runner });
          } else throw new RequestError(405, "Use GET or POST for workers.");
          return;
        }
        const workerAction =
          /^\/api\/runners\/([a-z0-9-]+)\/(verify|pause|resume|repair|remove)$/.exec(
            url.pathname,
          );
        if (workerAction) {
          if (req.method !== "POST")
            throw new RequestError(405, "Use POST for worker actions.");
          if (Object.keys(await body(req)).length)
            throw new RequestError(
              400,
              "Worker actions take an empty JSON object.",
            );
          const runner = await runners().action(
            workerAction[1]!,
            workerAction[2] as WorkerAction,
          );
          runners().start();
          json(res, 202, { ok: true, runner });
          return;
        }
        if (url.pathname === "/api/jobs") {
          if (req.method === "GET") {
            const limit = Math.min(
              100,
              Math.max(1, Number(url.searchParams.get("limit") ?? 100)),
            );
            const before = url.searchParams.get("beforeRunId");
            if (
              !Number.isSafeInteger(limit) ||
              (before !== null && !/^\d{1,16}$/.test(before))
            )
              throw new RequestError(400, "Invalid history pagination.");
            let historyAvailable = true;
            const history = await activityStore
              .listRuns({
                limit,
                ...(before ? { beforeRunId: Number(before) } : {}),
              })
              .catch(() => {
                historyAvailable = false;
                return [];
              });
            const live = (await runners().jobs()).filter(
              (job) => !before || job.runId < Number(before),
            );
            const all = new Map(
              [...history, ...live].map((job) => [job.id, job]),
            );
            const jobs = [...all.values()]
              .sort((a, b) => b.runId - a.runId)
              .slice(0, limit);
            json(res, 200, {
              jobs,
              historyAvailable,
              nextBeforeRunId:
                jobs.length === limit ? jobs.at(-1)!.runId : null,
            });
            return;
          }
          if (req.method !== "POST")
            throw new RequestError(405, "Use POST to queue a job.");
          const input = await body(req);
          if (
            Object.keys(input).some(
              (key) => !["type", "project", "area", "ticket"].includes(key),
            ) ||
            !["pm", "developer"].includes(String(input.type)) ||
            typeof input.project !== "string" ||
            (input.area !== undefined && typeof input.area !== "string") ||
            (input.ticket !== undefined && typeof input.ticket !== "string")
          )
            throw new RequestError(
              400,
              "Choose a project and PM area or approved Linear ticket.",
            );
          const jobInput = input as unknown as LocalJobInput;
          let validated: Awaited<ReturnType<typeof preparation.validate>>;
          try {
            validated = await preparation.validate(jobInput);
          } catch {
            throw new RequestError(
              400,
              "This job is not ready. Check doctor verification, the enabled PM area, credentials and the ticket's approval/project labels.",
            );
          }
          if (validated.ticket) {
            jobInput.area = validated.area.key;
            jobInput.ticket = validated.ticket.identifier;
            const previous = (await runners().jobs()).filter(
              (job) =>
                job.type === "developer" &&
                job.project === jobInput.project &&
                job.ticket === jobInput.ticket,
            );
            if (
              previous.some((job) =>
                ["queued", "running", "succeeded"].includes(job.status),
              )
            )
              throw new RequestError(
                409,
                "This ticket already has active or completed work. Review its job and draft PR/MR before requesting another implementation.",
              );
            jobInput.idempotencyKey = `developer:${jobInput.project}:${validated.ticket.id}${previous.length ? `:retry:${randomBytes(8).toString("hex")}` : ""}`;
          }
          const job = await runners().enqueue(jobInput);
          runners().start();
          json(res, 202, { job });
          return;
        }
        const jobOutput =
          /^\/api\/jobs\/([a-z0-9-]+)\/(logs|artifacts|activity)(?:\/(.+))?$/.exec(
            url.pathname,
          );
        if (jobOutput) {
          if (req.method !== "GET")
            throw new RequestError(405, "Use GET for job output.");
          const id = jobOutput[1]!;
          if (jobOutput[2] === "activity" && !jobOutput[3]) {
            if (!(await runners().job(id)))
              throw new RequestError(404, "Unknown gremlin run.");
            const persisted = await activityStore
              .activity(id)
              .catch(() => ({ events: [], checks: [] }));
            const live = parseActivityLogs(
              await runners()
                .logs(id)
                .catch(() => []),
            );
            const events = [
              ...new Map(
                [...persisted.events, ...live].map((event) => [
                  event.id,
                  event,
                ]),
              ).values(),
            ].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
            json(res, 200, { ...persisted, events });
          } else if (jobOutput[2] === "logs" && !jobOutput[3])
            json(res, 200, { lines: await runners().logs(id) });
          else if (!jobOutput[3]) {
            const files = await runners().artifacts(id);
            json(res, 200, {
              files: files.map((file) => ({
                ...file,
                url: `/api/jobs/${id}/artifacts/${encodeURIComponent(file.name)}`,
              })),
            });
          } else if (jobOutput[2] === "artifacts") {
            let name: string;
            try {
              name = decodeURIComponent(jobOutput[3]);
            } catch {
              throw new RequestError(400, "Invalid artifact name.");
            }
            if (!/\.(png|webp|jpg|jpeg|json|txt|md|log|csv)$/i.test(name))
              throw new RequestError(400, "Unsupported artifact type.");
            const content = await runners().readArtifact(id, name);
            res.writeHead(200, {
              "Content-Type":
                TYPES[extname(name)] ?? "text/plain; charset=utf-8",
              "Content-Length": content.length,
              "Content-Security-Policy": "default-src 'none'; sandbox",
            });
            res.end(content);
          } else throw new RequestError(404, "Unknown job output.");
          return;
        }
        if (url.pathname === "/api/updates") {
          if (req.method !== "GET")
            throw new RequestError(405, "Use GET for update status.");
          json(res, 200, updateStatus());
          return;
        }
        if (url.pathname.startsWith("/api/updates/")) {
          if (req.method !== "POST")
            throw new RequestError(405, "Use POST for update actions.");
          const action = url.pathname.slice("/api/updates/".length);
          if (!["check", "apply", "rollback", "restart"].includes(action))
            throw new RequestError(404, "Unknown update action.");
          if (Object.keys(await body(req)).length)
            throw new RequestError(
              400,
              "Update actions take an empty JSON object.",
            );
          if (updateRunning)
            throw new RequestError(
              409,
              "Another update is running. Wait for it to finish.",
            );
          if (action === "restart") {
            if (!options.restart)
              throw new RequestError(
                400,
                "Stop this dashboard and start it with gremlins setup to use the new runtime.",
              );
            if (!updates().status().restartRequired)
              throw new RequestError(
                409,
                "The dashboard is already using the selected runtime.",
              );
            updateRunning = true;
            res.once("finish", options.restart);
            json(res, 202, { ok: true, restarting: true });
            return;
          }
          updateFailure = "";
          updateRunning = true;
          // Installation can take minutes. Keep the dashboard and its status polling responsive.
          const operation = updates()[action as "check" | "apply" | "rollback"];
          void operation()
            .catch(() => {
              updateFailure =
                "Another update may be running. Wait for it to finish, then check again.";
            })
            .finally(() => {
              updateRunning = false;
            });
          json(res, 202, updateStatus());
          return;
        }
        if (url.pathname === "/api/status") {
          if (req.method !== "GET")
            throw new RequestError(405, "Use GET for status.");
          assertNoSymlinks(root);
          assertNoSymlinks(join(root, "hub.json"));
          const saved = readConnections(root);
          const sourceConnections = await sourceControl.status();
          const serviceConnections = await Promise.all([
            linearConnection.status({ checkAvailability: false }),
            vercelConnection.status({ checkAvailability: false }),
          ]);
          const configWarnings: string[] = [];
          const projectConnections: {
            name: string;
            label: string;
            description: string;
          }[] = [];
          let hubRepo: string | null = null;
          if (existsSync(join(root, "hub.json"))) {
            try {
              const hub = loadHub(root);
              hubRepo = hub.runners.mode === "local" ? null : hub.hubRepo;
            } catch {
              configWarnings.push(
                "hub.json needs repair. Open it in Configuration.",
              );
            }
          }
          assertNoSymlinks(join(root, "projects"));
          const projects = listProjectNames(root).map((name) => {
            assertNoSymlinks(join(root, "projects", name));
            for (const file of ["project.json", "areas.json", "tiers.json"])
              assertNoSymlinks(join(root, "projects", name, file));
            try {
              const project = loadProject(root, name);
              const verification = effectiveVerification(project.config);
              projectConnections.push(
                ...telemetrySecrets(project.config.telemetry).map(
                  (connection) => ({
                    ...connection,
                    label: `${name} · ${connection.label}`,
                  }),
                ),
              );
              return {
                name,
                repo: project.config.repo,
                provider: project.config.provider ?? "github",
                serverUrl: project.config.serverUrl,
                workflow: effectiveWorkflow(project.config),
                verification:
                  verification.mode === "browser"
                    ? { mode: "browser", environment: verification.environment }
                    : { mode: "repository" },
                environments:
                  project.config.environments ??
                  (verification.mode === "browser"
                    ? { [verification.environment]: verification.target }
                    : {}),
                commands: project.config.commands,
                branches: project.config.branches,
                verified: project.config.verified,
                linear: linearProvisioning.status(name),
                areas: project.areas.map(
                  ({
                    key,
                    name: areaName,
                    enabled,
                    linearProjectId,
                    mandate,
                    paths,
                    schedule,
                    wipLimit,
                  }) => ({
                    key,
                    name: areaName,
                    enabled,
                    linearProjectId,
                    mandate,
                    paths,
                    schedule,
                    wipLimit,
                  }),
                ),
              };
            } catch {
              configWarnings.push(
                `Project ${name} needs repair. Open its files in Configuration.`,
              );
              return { name, repo: "Configuration needs repair" };
            }
          });
          json(res, 200, {
            configDirectory: resolve(root),
            installationDirectory: resolve(packageRoot),
            hubRepo,
            configWarnings,
            projects,
            sourceConnections,
            serviceConnections,
            connections: [
              ...new Map(
                [
                  ...CONNECTIONS,
                  ...projectConnections,
                  ...projectConnectionDefinitions(root),
                ].map((connection) => [connection.name, connection]),
              ).values(),
            ].map((connection) => ({
              ...connection,
              configured: Boolean(
                saved[connection.name] || process.env[connection.name],
              ),
            })),
            runtime: {
              agents: hubRepo ? "github-actions" : "local-docker",
              dashboard: "local",
              access: networkHosts.length ? "lan" : "loopback",
              canOpenFolders: canOpenFolders(networkHosts.length > 0),
            },
          });
          return;
        }
        if (url.pathname === "/api/config") {
          try {
            if (req.method === "GET") {
              const path = url.searchParams.get("path");
              json(
                res,
                200,
                path === null
                  ? { files: listEditableConfigs(root) }
                  : readEditableConfig(root, path),
              );
            } else if (req.method === "PUT") {
              const input = await body(req, 128 * 1024);
              if (
                Object.keys(input).some(
                  (key) => !["path", "content", "revision"].includes(key),
                ) ||
                typeof input.path !== "string" ||
                typeof input.content !== "string" ||
                typeof input.revision !== "string"
              )
                throw new RequestError(
                  400,
                  "Expected a configuration path, JSON content, and revision.",
                );
              json(res, 200, {
                ok: true,
                ...saveEditableConfig(root, {
                  path: input.path,
                  content: input.content,
                  revision: input.revision,
                }),
              });
            } else
              throw new RequestError(405, "Use GET or PUT for configuration.");
          } catch (error) {
            if (error instanceof ConfigEditorError)
              throw new RequestError(error.status, error.message);
            throw error;
          }
          return;
        }
        if (url.pathname === "/api/open-folder") {
          if (req.method !== "POST")
            throw new RequestError(405, "Use POST to open a folder.");
          const input = await body(req);
          if (
            Object.keys(input).length !== 1 ||
            typeof input.target !== "string" ||
            !["configuration", "installation"].includes(input.target)
          )
            throw new RequestError(
              400,
              "Choose the configuration or installation folder.",
            );
          if (!canOpenFolders(networkHosts.length > 0))
            throw new RequestError(
              400,
              "This folder lives on the server. Copy its path or use the configuration editor in your browser.",
            );
          try {
            await openDashboardFolder(root, packageRoot, input.target);
          } catch {
            throw new RequestError(
              400,
              "The server could not open its file manager. Copy the folder path instead.",
            );
          }
          json(res, 200, { ok: true });
          return;
        }
        if (url.pathname === "/api/connections") {
          if (req.method !== "POST")
            throw new RequestError(405, "Use POST to save connections.");
          const input = await body(req);
          if (
            Object.keys(input).length !== 1 ||
            !Object.hasOwn(input, "values")
          )
            throw new RequestError(400, "Expected a values object.");
          try {
            saveConnections(root, input.values);
          } catch {
            throw new RequestError(
              400,
              "Connections were not saved. Use supported tokens or valid Google service-account JSON, and check .env permissions and formatting.",
            );
          }
          json(res, 200, { ok: true });
          return;
        }
        if (url.pathname === "/api/projects") {
          if (req.method !== "POST")
            throw new RequestError(405, "Use POST to add a project.");
          const input = await body(req);
          if (
            Object.keys(input).some(
              (key) =>
                ![
                  "project",
                  "repo",
                  "hubRepo",
                  "provider",
                  "serverUrl",
                  "linearMode",
                  "linearTeamId",
                  "workflow",
                  "verification",
                  "environments",
                  "commands",
                  "branches",
                ].includes(key),
            ) ||
            typeof input.project !== "string" ||
            typeof input.repo !== "string" ||
            (input.hubRepo !== undefined &&
              typeof input.hubRepo !== "string") ||
            (input.provider !== undefined &&
              !["github", "gitlab"].includes(String(input.provider))) ||
            (input.serverUrl !== undefined &&
              (input.provider !== "gitlab" ||
                !validSourceServer(input.serverUrl))) ||
            (input.linearMode !== undefined &&
              !["create", "reuse", "later"].includes(
                String(input.linearMode),
              )) ||
            (input.linearTeamId !== undefined &&
              (typeof input.linearTeamId !== "string" ||
                !/^[a-f0-9-]{36}$/i.test(input.linearTeamId))) ||
            (input.linearMode === "reuse" && !input.linearTeamId)
          )
            throw new RequestError(
              400,
              "Expected a project name, source repository, and optional source provider.",
            );
          if (
            !/^[a-z][a-z0-9-]{0,62}$/.test(input.project) ||
            !validSourceRepository(
              input.repo,
              typeof input.provider === "string" ? input.provider : "github",
            ) ||
            (typeof input.hubRepo === "string" &&
              !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(input.hubRepo))
          )
            throw new RequestError(
              400,
              "Use a lowercase project ID and owner/repository names.",
            );
          const provider = (input.provider ?? "github") as "github" | "gitlab";
          const serverUrl =
            typeof input.serverUrl === "string"
              ? input.serverUrl.replace(/\/$/, "")
              : provider === "github"
                ? "https://github.com"
                : "https://gitlab.com";
          const sourceConnections = await sourceControl.status();
          if (
            sourceConnections.some(
              (source: SourceStatus) =>
                source.provider === provider &&
                source.serverUrl.replace(/\/$/, "") === serverUrl &&
                source.method === "oauth",
            )
          ) {
            try {
              await sourceControl.resolveCredential({
                provider,
                serverUrl,
                repository: input.repo,
                minValidityMs: 5 * 60_000,
                write: true,
              });
            } catch (error) {
              throw new RequestError(
                error instanceof SourceControlError &&
                  ["refresh_blocked", "busy"].includes(error.code)
                  ? 409
                  : 400,
                "This repository is not ready for the connected source account. Check app installation and repository access, or wait for active jobs before refreshing.",
              );
            }
          }
          const args = [
            "init",
            "--project",
            input.project,
            "--repo",
            input.repo,
            "--json",
          ];
          if (typeof input.hubRepo === "string")
            args.push("--hub-repo", input.hubRepo);
          if (typeof input.provider === "string")
            args.push("--provider", input.provider);
          if (typeof input.serverUrl === "string")
            args.push("--server-url", input.serverUrl);
          const output: string[] = [];
          const code = await runSetup(
            root,
            args,
            { log: (line) => output.push(line), error: () => {} },
            {
              env: {},
              templatesRoot: packageRoot,
              projectSettings: Object.fromEntries(
                [
                  "workflow",
                  "verification",
                  "environments",
                  "commands",
                  "branches",
                ]
                  .filter((key) => input[key] !== undefined)
                  .map((key) => [key, input[key]]),
              ),
            },
          );
          if (code !== 0)
            throw new RequestError(
              400,
              "Project setup could not finish. Check the project ID, source repository, and existing configuration with gremlins setup init --help.",
            );
          const linear =
            input.linearMode === "later"
              ? {
                  status: "skipped" as const,
                  message: "App saved. Set up its Linear team when ready.",
                }
              : await provisionLinear(
                  input.project,
                  typeof input.linearTeamId === "string"
                    ? input.linearTeamId
                    : undefined,
                );
          json(res, 200, {
            ok: true,
            result: JSON.parse(output.join("\n")),
            linear,
          });
          return;
        }
        const projectMapping =
          /^\/api\/projects\/([a-z][a-z0-9-]{0,62})\/(linear|areas)$/.exec(
            url.pathname,
          );
        if (projectMapping) {
          if (req.method !== "POST")
            throw new RequestError(
              405,
              "Use POST to configure the app's team or add a PM.",
            );
          const project = projectMapping[1]!;
          const input = await body(req);
          if (projectMapping[2] === "linear") {
            if (
              Object.keys(input).some((key) => key !== "teamId") ||
              (input.teamId !== undefined &&
                (typeof input.teamId !== "string" ||
                  !/^[a-f0-9-]{36}$/i.test(input.teamId)))
            )
              throw new RequestError(
                400,
                "Provide an optional existing Linear team UUID.",
              );
            loadProject(root, project);
            json(res, 200, {
              ok: true,
              linear: await provisionLinear(
                project,
                typeof input.teamId === "string" ? input.teamId : undefined,
              ),
            });
          } else {
            try {
              await linearProvisioning.addArea(project, input);
            } catch (error) {
              if (error instanceof LinearProvisioningError)
                throw new RequestError(error.status, error.message);
              throw new RequestError(
                400,
                "PM settings could not be saved. Check the mandate, key, and configuration.",
              );
            }
            const configured = loadProject(root, project).config.linear;
            json(res, 200, {
              ok: true,
              linear: configured
                ? await provisionLinear(project)
                : {
                    status: "skipped",
                    message:
                      "PM saved and disabled. Set up this app's Linear team to create its project.",
                  },
            });
          }
          return;
        }
        const verifyProject =
          /^\/api\/projects\/([a-z][a-z0-9-]{0,62})\/verify$/.exec(
            url.pathname,
          );
        if (verifyProject) {
          if (req.method !== "POST")
            throw new RequestError(405, "Use POST to verify a project.");
          if (Object.keys(await body(req)).length)
            throw new RequestError(
              400,
              "Project verification takes an empty object.",
            );
          const project = loadProject(root, verifyProject[1]!);
          const snapshot = verificationSnapshot(project.dir);
          const checks = await doctorChecks(project, {
            root,
            env: { ...readConnections(root), ...process.env },
            fetch,
            today: () => new Date().toISOString().slice(0, 10),
            sourceControl,
            linearConnection,
            vercelConnection,
          });
          const ok = checks.every((check) => check.ok);
          if (ok) {
            try {
              stampVerified(
                project.dir,
                new Date().toISOString().slice(0, 10),
                snapshot,
              );
            } catch (error) {
              if (!(error instanceof VerificationConflictError)) throw error;
              throw new RequestError(409, error.message);
            }
          }
          json(res, 200, { ok, checks });
          return;
        }
        throw new RequestError(404, "Unknown dashboard endpoint.");
      }
      if (req.method !== "GET" && req.method !== "HEAD")
        throw new RequestError(405, "Use GET or HEAD.");
      try {
        const pathname = decodeURIComponent(url.pathname);
        if (pathname.includes("\\") || pathname.includes("\0"))
          throw new Error();
        const directory = await realpath(join(packageRoot, "dashboard"));
        const file = await realpath(
          join(directory, pathname === "/" ? "index.html" : pathname.slice(1)),
        );
        const rel = relative(directory, file);
        if (
          isAbsolute(rel) ||
          rel === ".." ||
          rel.startsWith(`..${sep}`) ||
          !TYPES[extname(file)] ||
          !(await stat(file)).isFile()
        )
          throw new Error();
        const content = await readFile(file);
        res.writeHead(200, {
          "Content-Type": TYPES[extname(file)]!,
          "Content-Length": content.length,
        });
        res.end(req.method === "HEAD" ? undefined : content);
      } catch {
        throw new RequestError(404, "Not found.");
      }
    } catch (error) {
      const status =
        error instanceof RequestError || error instanceof LocalRunnerError
          ? error.status
          : 500;
      const message =
        error instanceof RequestError || error instanceof LocalRunnerError
          ? error.message
          : "Dashboard request failed. Check your local configuration files and permissions.";
      if (!res.headersSent) json(res, status, { error: message });
      else res.end();
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.once("listening", () => {
    if (
      options.runners ||
      existsSync(join(root, ".run", "local-runners", "state.json"))
    )
      runners().start();
  });
  server.once("close", () => {
    void Promise.resolve(manager?.stop()).finally(() => activityStore.close());
  });
  return server;
}

export function openDashboardBrowser(
  url: string,
  io: Io,
  platform: NodeJS.Platform = process.platform,
  launch: typeof spawn = spawn,
): void {
  const command =
    platform === "win32"
      ? "rundll32.exe"
      : platform === "darwin"
        ? "open"
        : "xdg-open";
  const args =
    platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url];
  let reported = false;
  const fallback = () => {
    if (reported) return;
    reported = true;
    io.log(
      "No browser opened. On another device, restart with gremlins setup --lan, or use an SSH tunnel to the loopback address above.",
    );
  };
  try {
    const child = launch(command, args, {
      stdio: "ignore",
      detached: true,
      windowsHide: true,
    });
    child.once("error", fallback);
    child.once("exit", (code) => {
      if (code !== 0) fallback();
    });
    child.unref();
  } catch {
    fallback();
  }
}

/** Default to loopback; LAN access requires an explicit flag and keeps session authentication. */
export async function runDashboard(
  root: string,
  packageRoot: string,
  args: string[],
  io: Io,
  getLanAddresses: () => string[] = lanAddresses,
): Promise<number> {
  const { values, positionals } = parseFlags(args);
  const usage =
    "Usage: gremlins dashboard [--lan] [--no-open] [--port PORT]\n  --lan: open on your private IPv4 network (default port 4311); prints links for other devices.\n  Default: loopback only, with an available port and automatic browser opening.";
  if (values.help === true || args.includes("-h")) {
    io.log(usage);
    return 0;
  }
  const lan = values.lan === true;
  const port =
    values.port === undefined ? (lan ? 4311 : 0) : Number(values.port);
  if (
    positionals.length ||
    Object.keys(values).some(
      (key) => !["no-open", "port", "lan"].includes(key),
    ) ||
    (values["no-open"] !== undefined && values["no-open"] !== true) ||
    (values.lan !== undefined && values.lan !== true) ||
    values.port === true ||
    !Number.isInteger(port) ||
    port < 0 ||
    port > 65535
  ) {
    io.error(usage);
    return 1;
  }
  const addresses = lan ? getLanAddresses() : [];
  if (lan && !addresses.length) {
    io.error(
      "No private LAN IPv4 address was found. Connect this server to your LAN, or use the default loopback dashboard through an SSH tunnel.",
    );
    return 1;
  }
  const supervised =
    process.env.SHIPGREMLINS_MANAGED_LAUNCH === "1" && Boolean(process.send);
  const restoredSession = process.env.SHIPGREMLINS_DASHBOARD_SESSION;
  const session =
    supervised && restoredSession && /^[a-f0-9]{64}$/.test(restoredSession)
      ? restoredSession
      : randomBytes(32).toString("hex");
  let restartDashboard: (() => void) | undefined;
  let stopDashboard: (() => void) | undefined;
  const background = process.env.SHIPGREMLINS_CONTROLLER_BACKGROUND === "1";
  const controllerFile = join(root, ".run", "controller.json");
  const server = createDashboardServer(root, packageRoot, session, addresses, {
    ...(supervised ? { restart: () => restartDashboard?.() } : {}),
    background,
    shutdown: () => stopDashboard?.(),
  });
  return new Promise<number>((done) => {
    restartDashboard = () => {
      const address = server.address() as AddressInfo | null;
      if (!address || !process.send) return;
      process.send(
        {
          type: "shipgremlins:restart-dashboard",
          port: address.port,
          session,
          configurationRoot: resolve(root),
          lan,
        },
        (error) => {
          if (error) {
            io.error(
              "Automatic restart failed. Stop the dashboard and run gremlins setup again.",
            );
            return;
          }
          server.close(() => done(75));
          server.closeAllConnections();
        },
      );
    };
    const stop = () => {
      server.close(() => done(0));
      // An unfinished browser request must not keep Ctrl+C waiting for its body.
      server.closeAllConnections();
    };
    stopDashboard = stop;
    const cleanup = () => {
      process.removeListener("SIGINT", stop);
      process.removeListener("SIGTERM", stop);
      if (background && existsSync(controllerFile)) {
        try {
          if (
            JSON.parse(readFileSync(controllerFile, "utf8")).session === session
          )
            unlinkSync(controllerFile);
        } catch {
          /* Leave an unreadable state for explicit repair. */
        }
      }
    };
    server.once("error", () => {
      cleanup();
      io.error(
        "Dashboard could not start. Choose another port with --port 4312, or use --port 0 for an available port.",
      );
      done(1);
    });
    server.once("close", cleanup);
    server.listen(port, lan ? "0.0.0.0" : "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      if (background) {
        try {
          assertNoSymlinks(controllerFile);
          mkdirSync(join(root, ".run"), { recursive: true, mode: 0o700 });
          const temporary = `${controllerFile}.${randomBytes(8).toString("hex")}.tmp`;
          writeFileSync(
            temporary,
            JSON.stringify({ port: address.port, session, lan, addresses }),
            { flag: "wx", mode: 0o600 },
          );
          renameSync(temporary, controllerFile);
        } catch {
          io.error("Could not save controller state.");
          stop();
          return;
        }
      }
      const url = `http://127.0.0.1:${address.port}/#session=${session}`;
      if (lan) {
        io.log("Open a LAN link on another device:");
        for (const host of addresses)
          io.log(`  http://${host}:${address.port}/#session=${session}`);
        io.log(
          `LAN mode uses HTTP. Use a trusted network; allow TCP ${address.port} through your server firewall only for that network.`,
        );
      } else io.log(`Your gremlins are waiting: ${url}`);
      io.log(
        `Connections stay on this server in ${join(resolve(root), ".env")}. Keep the session link private. Press Ctrl+C to stop.`,
      );
      if (!lan && !values["no-open"]) openDashboardBrowser(url, io);
    });
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}
