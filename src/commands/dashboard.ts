import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { projectRuntimeKey } from "../projectIdentity.ts";
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
import {
  CONNECTIONS,
  readConnections,
  saveConnections,
  clearConnections,
  ConnectionSaveError,
  projectConnections as projectConnectionDefinitions,
} from "../setup/connections.ts";
import { assertNoSymlinks } from "../setup/files.ts";
import {
  createProjectOnboarding,
  ProjectOnboardingError,
  type ProjectOnboarding,
} from "../projectOnboarding/index.ts";
import {
  createEnvironmentAccess,
  EnvironmentAccessError,
} from "../setup/environmentAccess.ts";
import {
  createEnvironmentGuide,
  compactVercelGuideContext,
} from "../setup/environmentGuide.ts";
import { createVercelSetup, VercelSetupError } from "../vercelSetup/index.ts";
import type {
  VercelDiscoverInput,
  VercelPrepareInput,
  VercelDeployInput,
} from "../vercelSetup/types.ts";
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
import {
  createJobPreparation,
  JobReadinessError,
} from "../localRunners/jobs.ts";
import {
  inspectPmReadiness,
  hasPmMapping,
  setPmAutomation,
  PmControlError,
  type ReadinessContext,
} from "../setup/pmReadiness.ts";
import {
  createPmPlanner,
  PmPlannerError,
  type PmPlanner,
} from "../pmPlanner/index.ts";
import {
  createIdeaCrew,
  IdeaCrewError,
  type IdeaCrew,
} from "../ideaCrew/index.ts";
import {
  createFoundation,
  foundationNeeded,
  foundationSummary,
  sameCodingTicket,
} from "../ideaCrew/foundation.ts";
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
  validConnectionId,
  parseProjectCapabilities,
} from "../projectCapabilities.ts";
import {
  createLinearConnection,
  type LinearConnection,
} from "../linearConnection/index.ts";
import {
  createVercelConnection,
  type VercelConnection,
} from "../vercelConnection/index.ts";
import {
  OAuthConnectionError,
  type OAuthProvider,
} from "../oauthConnection/types.ts";
import {
  listConnectionProfiles,
  createConnectionProfile,
  deleteConnectionProfile,
} from "../oauthConnection/profiles.ts";
import {
  createResourceDeletion,
  ResourceDeletionError,
  type ConfigurationMutation,
  type ResourceTarget,
} from "../setup/resourceDeletion.ts";
import { LinearApi } from "../services/linear.ts";
import {
  createLinearProvisioning,
  LinearProvisioningError,
  type LinearMappingStatus,
  type LinearMappingRepair,
} from "../setup/linearProvisioning.ts";
import {
  SourceControlError,
  type SourceControl,
  type SourceStatus,
} from "../sourceControl/types.ts";
import {
  createActivityStore,
  parseActivityLogs,
  publicActivityLogs,
  summarizeActivity,
  type ActivityStore,
  type ActivityEvent,
} from "../storage/activity.ts";
import {
  createDashboardOutputReader,
  dashboardOutputDeadline,
} from "./dashboardOutput.ts";
import { createPmKnowledge } from "../pmKnowledge/index.ts";
import { readPmBrief, savePmBrief, PmBriefError } from "../setup/pmBrief.ts";
import {
  createProjectKnowledge,
  ProjectKnowledgeError,
} from "../projectKnowledge/index.ts";
import {
  projectOperations,
  saveExecution,
} from "../projectKnowledge/operations.ts";
import { createProjectReview } from "../projectKnowledge/review.ts";
import {
  readSetupSuggestions,
  applySetupSuggestions,
} from "../projectKnowledge/setup.ts";
import { createDeliveryController } from "../delivery/controller.ts";
import {
  createAutomaticPromotions,
  type AutomaticPromotion,
} from "../delivery/automatic.ts";
import {
  createRemoteWorkers,
  RemoteWorkerError,
} from "../remoteWorkers/index.ts";

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
const HTML_ROUTES = new Set([
  "/",
  "/overview",
  "/connections",
  "/projects",
  "/runners",
  "/activity",
  "/settings",
  "/inbox",
]);

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
  /** Explicit HTTPS reverse-proxy origin; never inferred from forwarded headers. */
  publicUrl?: string;
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
  linearConnectionFor?: (connectionId?: string) => LinearConnection;
  vercelConnectionFor?: (connectionId?: string) => VercelConnection;
  linearProvisioning?: ReturnType<typeof createLinearProvisioning>;
  pmPlanner?: PmPlanner;
  ideaCrew?: IdeaCrew;
  foundation?: ReturnType<typeof createFoundation>;
  projectOnboarding?: ProjectOnboarding;
  environmentAccess?: ReturnType<typeof createEnvironmentAccess>;
  vercelSetup?: ReturnType<typeof createVercelSetup>;
  environmentGuide?: ReturnType<typeof createEnvironmentGuide>;
  delivery?: ReturnType<typeof createDeliveryController>;
  remote?: ReturnType<typeof createRemoteWorkers>;
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
  let publicOrigin: URL | undefined;
  if (options.publicUrl) {
    try {
      publicOrigin = new URL(options.publicUrl);
    } catch {
      throw new Error(
        "Use an HTTPS dashboard origin without a path or credentials.",
      );
    }
    if (
      publicOrigin.protocol !== "https:" ||
      publicOrigin.username ||
      publicOrigin.password ||
      publicOrigin.pathname !== "/" ||
      publicOrigin.search ||
      publicOrigin.hash
    )
      throw new Error(
        "Use an HTTPS dashboard origin without a path or credentials.",
      );
  }
  // Update checks are explicit; opening the static page never makes a network request.
  let updater = options.updater;
  const updates = () =>
    (updater ??= createUpdater({ configurationRoot: root, packageRoot }));
  let updateRunning = false;
  let updateFailure = "";
  const remote = options.remote ?? createRemoteWorkers({ root });
  const activeProjectOperations = new Map<string, number>();
  let configurationMutation = false;
  let activeMutationRequests = 0;
  function trackProject(name: string): () => void {
    activeProjectOperations.set(
      name,
      (activeProjectOperations.get(name) ?? 0) + 1,
    );
    return () => {
      const remaining = (activeProjectOperations.get(name) ?? 1) - 1;
      if (remaining) activeProjectOperations.set(name, remaining);
      else activeProjectOperations.delete(name);
    };
  }
  async function withProjectOperation<T>(
    name: string,
    action: () => Promise<T>,
  ): Promise<T> {
    const finish = trackProject(name);
    try {
      return await action();
    } finally {
      finish();
    }
  }
  const localDocker =
    options.docker ??
    createDockerRunners({ packageRoot, environmentNamespace: root });
  const docker = remote.adapter(localDocker);
  const sourceControl =
    options.sourceControl ?? createSourceControl({ root, session });
  const linearConnection =
    options.linearConnection ?? createLinearConnection({ root, session });
  const vercelConnection =
    options.vercelConnection ?? createVercelConnection({ root, session });
  const linearAccounts = new Map<string, LinearConnection>([
    ["default", linearConnection],
  ]);
  const vercelAccounts = new Map<string, VercelConnection>([
    ["default", vercelConnection],
  ]);
  function selectedConnection(provider: OAuthProvider, id = "default") {
    if (!validConnectionId(id))
      throw new OAuthConnectionError("Choose a valid saved account ID.");
    const accounts = provider === "linear" ? linearAccounts : vercelAccounts;
    let connection = accounts.get(id);
    if (!connection) {
      connection =
        provider === "linear"
          ? (options.linearConnectionFor?.(id) ??
            createLinearConnection({ root, session, connectionId: id }))
          : (options.vercelConnectionFor?.(id) ??
            createVercelConnection({ root, session, connectionId: id }));
      accounts.set(id, connection);
    }
    return connection;
  }
  const linearConnectionFor = (id?: string) => selectedConnection("linear", id);
  const vercelConnectionFor = (id?: string) => selectedConnection("vercel", id);
  const projectOnboarding =
    options.projectOnboarding ??
    createProjectOnboarding({ root, packageRoot, sourceControl });
  const environmentAccess =
    options.environmentAccess ??
    createEnvironmentAccess({
      root,
      packageRoot,
      sourceControl,
      vercelConnectionFor,
      docker: localDocker,
    });
  const vercelSetup =
    options.vercelSetup ??
    createVercelSetup({
      root,
      packageRoot,
      sourceControl,
      vercelConnectionFor,
    });
  const environmentGuide =
    options.environmentGuide ??
    createEnvironmentGuide({
      root,
      packageRoot,
      context: async (name) => {
        const setup = await projectOnboarding.status(name);
        return {
          vercel: compactVercelGuideContext(await vercelSetup.status(name)),
          environment: effectiveVerification(loadProject(root, name).config),
          browserCheck: environmentAccess.status(name),
          ...(setup.report
            ? {
                analysis: {
                  stale: setup.stale,
                  summary: setup.report.summary,
                  stack: setup.report.stack,
                  missingInputs: setup.report.missingInputs,
                  warnings: setup.report.warnings,
                },
              }
            : {}),
        };
      },
    });
  async function onboardingState(name: string) {
    const state = await projectOnboarding.status(name);
    const project = loadProject(root, name),
      verification = effectiveVerification(project.config);
    return {
      ...state,
      ...(project.config.ideaPlanId
        ? { foundation: await foundation.status(name) }
        : {}),
      environment:
        verification.mode === "browser"
          ? {
              name: verification.environment,
              profile:
                verification.target.kind === "docker" ? "docker" : "hosted",
              target: verification.target,
              verification: environmentAccess.status(name),
              legacySignIn: project.config.signIn ?? null,
            }
          : null,
    };
  }
  const setupBusy = (name?: string) =>
    projectOnboarding.busy(name) ||
    environmentAccess.busy(name) ||
    vercelSetup.busy(name) ||
    environmentGuide.busy(name);
  async function requireProfile(provider: OAuthProvider, id: string) {
    if (
      !validConnectionId(id) ||
      !(await listConnectionProfiles(root, provider)).some(
        (profile) => profile.id === id,
      )
    )
      throw new OAuthConnectionError(
        "The selected saved account is missing. Add or reconnect it before continuing.",
        "missing_connection",
        409,
      );
  }
  const serviceStatuses = async (checkAvailability = false) =>
    Promise.all(
      (await listConnectionProfiles(root)).map(async (profile) => ({
        ...(await selectedConnection(profile.provider, profile.id).status({
          checkAvailability,
        })),
        ...profile,
      })),
    );
  const linearProvisioning =
    options.linearProvisioning ??
    createLinearProvisioning({
      root,
      client: async (project, explicitConnection) => {
        const mapping =
          project && explicitConnection === undefined
            ? loadProject(root, project).config.linear
            : undefined;
        return new LinearApi({
          apiKey: (
            await linearConnectionFor(
              explicitConnection ?? mapping?.connectionId,
            ).resolveCredential({
              minValidityMs: 5 * 60_000,
              ...(explicitConnection === undefined && mapping?.workspaceId
                ? { workspaceId: mapping.workspaceId }
                : {}),
            })
          ).authorization,
        });
      },
    });
  async function provisionLinear(
    project: string,
    teamId?: string,
    areaKey?: string,
  ): Promise<LinearMappingStatus> {
    const finish = trackProject(project);
    try {
      const status = await linearConnectionFor(
        loadProject(root, project).config.linear?.connectionId,
      ).status({
        checkAvailability: false,
      });
      if (!status.connected)
        return {
          status: "needs-connection",
          message:
            "App and PM settings are saved. Connect Linear, then retry Linear setup.",
        };
      return await linearProvisioning.provision(project, {
        teamId,
        ...(areaKey ? { areaKey } : {}),
      });
    } catch (error) {
      return {
        status: "error",
        message:
          error instanceof LinearProvisioningError
            ? error.message
            : "Linear setup did not finish. Saved settings were preserved; reconnect Linear and retry.",
      };
    } finally {
      finish();
    }
  }
  const delivery =
    options.delivery ??
    createDeliveryController({
      root,
      sourceControl,
      linearConnectionFor,
      vercelConnectionFor,
      docker: localDocker,
    });
  const preparation =
    options.jobs ??
    createJobPreparation({
      root,
      sourceControl,
      linearConnection,
      vercelConnection,
      linearConnectionFor,
      vercelConnectionFor,
      beforePm: delivery.beforePm,
      beforeDeveloper: delivery.beforeDeveloper,
    });
  const pmPlanner =
    options.pmPlanner ?? createPmPlanner({ root, packageRoot, sourceControl });
  const ideaCrew =
    options.ideaCrew ??
    createIdeaCrew({
      root,
      packageRoot,
      sourceControl,
      addArea: linearProvisioning.addArea,
    });
  const slack = options.slack ?? createSlackConnect({ root, session });
  const activityStore = options.activityStore ?? createActivityStore({ root });
  const outputRead = createDashboardOutputReader();
  const knowledge = createPmKnowledge({ root });
  const projectKnowledge = createProjectKnowledge({ root });
  const projectReview = createProjectReview({
    root,
    client: async (project) =>
      new LinearApi({
        apiKey: (
          await linearConnectionFor(
            project.config.linear?.connectionId,
          ).resolveCredential({
            minValidityMs: 5 * 60_000,
            ...(project.config.linear?.workspaceId
              ? { workspaceId: project.config.linear.workspaceId }
              : {}),
          })
        ).authorization,
      }),
  });
  const deliveryOperations = new Map<
    string,
    { phase: "running" | "idle" | "error"; message: string; rows?: unknown[] }
  >();
  const productionReports = new Map<string, unknown[]>();
  const automaticPromotions = createAutomaticPromotions({ root });
  function continuePromotions(name: string) {
    if (configurationMutation) return;
    let key = name;
    try {
      const project = loadProject(root, name);
      key = projectRuntimeKey(project.config);
      if (deliveryOperations.get(key)?.phase === "running") return;
      if (!project.config.verified) return;
      for (const item of automaticPromotions.pending()) {
        if (item.project !== name) continue;
        const hasVerified =
          project.areas.some((area) => area.key === item.area) &&
          delivery
            .deliveryStatus(name)
            .deliveries.some(
              (record) =>
                record.area === item.area && record.status === "verified",
            );
        const token = automaticPromotions.claim(item);
        if (!token) return;
        if (!hasVerified) {
          automaticPromotions.finish(item, token);
          continue;
        }
        preparePromotion(name, item.area, { item, token });
        return;
      }
    } catch {
      deliveryOperations.set(key, {
        phase: "error",
        message:
          "Automatic promotion could not resume. Existing verified deliveries are preserved. Review Delivery and retry Prepare promotion; check controller storage if this persists.",
      });
    }
  }
  function deliveryView(name: string) {
    const project = loadProject(root, name),
      document = readEditableConfig(root, `projects/${name}/project.json`),
      raw = JSON.parse(document.content),
      verification = effectiveVerification(project.config);
    return {
      ...delivery.deliveryStatus(name),
      candidateSetup: {
        revision: document.revision,
        selected: raw.workflow?.candidateEnvironment ?? "",
        needsSelection:
          verification.mode === "browser" &&
          verification.target.kind === "railway" &&
          !raw.workflow?.candidateEnvironment,
        environments: Object.entries(project.config.environments ?? {})
          .filter(
            ([, target]) =>
              target.role !== "production" &&
              ["railway", "vercel"].includes(target.kind),
          )
          .map(([name, target]) => ({
            name,
            provider: target.kind,
            role: target.role,
          })),
      },
      operation: deliveryOperations.get(projectRuntimeKey(project.config)) ?? {
        phase: "idle",
        message: "",
      },
      productionReports:
        productionReports.get(projectRuntimeKey(project.config)) ?? [],
    };
  }
  function preparePromotion(
    name: string,
    area?: string,
    automatic?: { item: AutomaticPromotion; token: string },
  ) {
    const key = projectRuntimeKey(loadProject(root, name).config);
    if (deliveryOperations.get(key)?.phase === "running")
      throw new RequestError(
        409,
        "A delivery operation is already running for this project.",
      );
    deliveryOperations.set(key, {
      phase: "running",
      message:
        "Preparing a selective candidate and running its checks in Docker. No staging PR is opened without matching candidate evidence.",
    });
    void delivery
      .preparePromotion(name, { area, docker: localDocker })
      .then((rows) => {
        deliveryOperations.set(key, {
          phase: "idle",
          message: rows.map((row) => row.text).join("\n"),
          rows,
        });
      })
      .catch(() => {
        deliveryOperations.set(key, {
          phase: "error",
          message:
            "Promotion could not finish. Check source access, worker Docker, deployment metadata and trusted candidate verification. Existing deliveries remain available for review.",
        });
      })
      .finally(() => {
        if (automatic) {
          try {
            automaticPromotions.finish(automatic.item, automatic.token);
          } catch {
            deliveryOperations.set(key, {
              phase: "error",
              message:
                "Promotion finished, but its automatic continuation could not be recorded. Existing delivery evidence is preserved; check controller storage before retrying.",
            });
            return;
          }
        }
        continuePromotions(name);
      });
  }
  function advanceIntegration(name: string) {
    const key = projectRuntimeKey(loadProject(root, name).config);
    if (deliveryOperations.get(key)?.phase === "running")
      throw new RequestError(
        409,
        "A delivery operation is already running for this project.",
      );
    deliveryOperations.set(key, {
      phase: "running",
      message:
        "Checking the approved implementation and integration health. Eligible work may merge into integration; staging and production remain owner-controlled.",
    });
    void delivery
      .advanceIntegration(name)
      .then((record) => {
        deliveryOperations.set(key, {
          phase: "idle",
          message:
            record?.message ??
            "Integration check finished. Review each delivery's status for remaining blockers.",
        });
      })
      .catch(() => {
        deliveryOperations.set(key, {
          phase: "error",
          message:
            "Integration advancement could not finish. Check source access, configured checks and deployment health. Existing drafts remain available for review.",
        });
      })
      .finally(() => continuePromotions(name));
  }
  let productionBusy = false;
  async function reconcileDeliveries() {
    if (productionBusy || configurationMutation) return;
    productionBusy = true;
    try {
      for (const name of listProjectNames(root)) {
        if (configurationMutation) break;
        try {
          const key = projectRuntimeKey(loadProject(root, name).config);
          const status = delivery.deliveryStatus(name);
          if (!status.enabled || !loadProject(root, name).config.verified)
            continue;
          continuePromotions(name);
          if (
            status.deliveries.some(
              (item) => item.status === "awaiting-merge",
            ) &&
            loadProject(root, name).config.verified &&
            deliveryOperations.get(key)?.phase !== "running"
          )
            advanceIntegration(name);
          if (status.declarations.length)
            productionReports.set(
              key,
              await withProjectOperation(name, () =>
                delivery.reconcileProduction(name),
              ),
            );
        } catch {
          /*Each project keeps its durable scope. One unavailable provider must not stop other projects.*/
        }
      }
    } finally {
      productionBusy = false;
    }
  }
  const cleanOutput = (lines: string[]) => {
    let secrets: string[] = [];
    try {
      secrets = Object.values(readConnections(root));
    } catch {
      // Workers already redact their injected credentials before writing logs.
    }
    return publicActivityLogs(lines, secrets);
  };
  const liveLogs = (id: string) =>
    outputRead(
      `logs:${id}`,
      async () => cleanOutput(await runners().logs(id)),
      1500,
    );
  let manager: LocalRunners | undefined = options.runners;
  const runners = () =>
    (manager ??= createLocalRunners({
      root,
      packageRoot,
      docker,
      activityStore,
      ...preparation,
      admissionBlocker: projectKnowledge.admissionBlocker,
      reconcileCompletedJob: async (job, result, worker) => {
        await delivery.completeJob(job, result, worker);
        if (job.type === "pm" && !job.pmMode && job.project && job.area) {
          const verified = delivery
            .deliveryStatus(job.project)
            .deliveries.filter(
              (item) =>
                item.area === job.area &&
                item.status === "verified" &&
                item.review,
            )
            .map((item) => ({ id: item.id, review: item.review!.manifestHash }))
            .sort((a, b) => a.id.localeCompare(b.id));
          if (verified.length) {
            const key = createHash("sha256")
              .update(JSON.stringify(verified))
              .digest("hex");
            automaticPromotions.enqueue(job.project, job.area, key);
            continuePromotions(job.project);
          }
        }
      },
      beforeLaunch: () => activityStore.ensure(),
      releaseJobResources: preparation.releaseJobResources,
    }));
  const foundation =
    options.foundation ??
    createFoundation({
      root,
      ideaCrew,
      sourceControl,
      jobs: () => runners().jobs(),
      job: (id) => runners().job(id),
      preflight: async (name) => {
        if (loadHub(root).runners.mode !== "local")
          throw new IdeaCrewError(
            "Choose local runners in Settings before building the foundation.",
            409,
          );
        if (
          !{
            ...readConnections(root),
            ...process.env,
          }.CLAUDE_CODE_OAUTH_TOKEN?.trim()
        )
          throw new IdeaCrewError(
            "Connect Claude Code in Connections before building the foundation.",
            409,
          );
        const workers = (await runners().status()).runners;
        if (
          !workers.some(
            (worker) =>
              worker.verifiedAt &&
              !worker.paused &&
              ["ready", "busy"].includes(worker.status) &&
              (docker.canRun?.(worker.remoteId, name) ?? !worker.remoteId),
          )
        )
          throw new IdeaCrewError(
            "Add and verify a runner in Runners, then return to build the foundation.",
            409,
          );
      },
      provision: async (name) => {
        const result = await provisionLinear(name);
        if (result.status !== "ready")
          throw new IdeaCrewError(
            result.message ?? "Connect Linear before building the foundation.",
            409,
          );
      },
      verify: async (name) => {
        const project = loadProject(root, name),
          snapshot = verificationSnapshot(project.dir);
        const checks = await doctorChecks(project, {
          root,
          env: { ...readConnections(root), ...process.env },
          fetch,
          today: () => new Date().toISOString().slice(0, 10),
          sourceControl,
          linearConnection,
          vercelConnection,
          linearConnectionFor,
          vercelConnectionFor,
        });
        const failed = checks.filter((check) => !check.ok);
        if (failed.length)
          throw new IdeaCrewError(
            `Foundation setup needs attention: ${failed.map((check) => check.detail).join(" ")}`,
            409,
          );
        stampVerified(
          project.dir,
          new Date().toISOString().slice(0, 10),
          snapshot,
        );
      },
      linear: async (project) =>
        new LinearApi({
          apiKey: (
            await linearConnectionFor(
              project.config.linear?.connectionId,
            ).resolveCredential({
              workspaceId: project.config.linear?.workspaceId,
              minValidityMs: 5 * 60_000,
            })
          ).authorization,
        }),
      enqueue: async (input) => {
        const validated = await preparation.validate(input);
        input.linearBinding = validated.linearBinding;
        input.projectInstanceId = validated.project.config.instanceId;
        const existing = (await runners().jobs()).find(
          (job) =>
            sameCodingTicket(job, input) &&
            ["queued", "running", "succeeded"].includes(job.status),
        );
        if (existing) return existing;
        const job = await runners().enqueue(input);
        runners().start();
        return job;
      },
    });
  async function resourceBlockers(target: ResourceTarget): Promise<string[]> {
    const blockers: string[] = [];
    if (setupBusy(target.project))
      blockers.push(
        "Repository setup or an environment test is still running. Wait for it to finish before removing this configuration.",
      );
    if (activeProjectOperations.has(target.project))
      blockers.push(
        "Project setup, editing, or provider work is still running. Wait for it to finish.",
      );
    if (
      [...deliveryOperations.entries()].some(
        ([key, operation]) =>
          (key === target.project || key.startsWith(target.project + "~")) &&
          operation.phase === "running",
      ) ||
      automaticPromotions
        .pending()
        .some(
          (item) =>
            item.project === target.project &&
            (!target.area || item.area === target.area),
        )
    )
      blockers.push(
        "A promotion is running or awaiting reconciliation. Finish its delivery work before removing this configuration.",
      );
    if (
      (await runners().jobs()).some(
        (job) =>
          job.project === target.project &&
          (!target.area || job.area === target.area) &&
          ["queued", "running"].includes(job.status),
      )
    )
      blockers.push(
        "This configuration has queued, running, or recoverable jobs. Cancel queued jobs and resolve active work first.",
      );
    return blockers;
  }
  const withConfigurationMutation: ConfigurationMutation = async (
    target,
    operation,
  ) => {
    if (
      configurationMutation ||
      activeMutationRequests ||
      activeProjectOperations.size ||
      setupBusy(target.project) ||
      (!target.project && automaticPromotions.pending().length > 0) ||
      [...deliveryOperations.values()].some((item) => item.phase === "running")
    )
      throw new RequestError(
        409,
        "Configuration or provider work is in progress. Wait for it to finish and retry.",
      );
    configurationMutation = true;
    try {
      return await runners().withConfigurationMutation(target, operation);
    } finally {
      configurationMutation = false;
    }
  };
  const resourceDeletion = createResourceDeletion({
    root,
    withConfigurationMutation,
    blockers: resourceBlockers,
  });
  let remoteSyncBusy = false;
  async function syncRemoteWorkers() {
    if (remoteSyncBusy) return;
    remoteSyncBusy = true;
    try {
      for (const worker of remote
        .status()
        .workers.filter(
          (worker) => worker.enrolled && !worker.revoked && !worker.logicalId,
        )) {
        await runners().addRemote(worker.id, worker.name);
        runners().start();
      }
    } catch {
      /*Enrollment remains saved; the owner can free capacity and retry.*/
    } finally {
      remoteSyncBusy = false;
    }
  }
  async function readinessContext(
    sources?: SourceStatus[],
    services?: Awaited<ReturnType<typeof serviceStatuses>>,
  ): Promise<ReadinessContext> {
    let localMode = false;
    try {
      localMode = loadHub(root).runners.mode === "local";
    } catch {
      /* Setup page explains the missing configuration. */
    }
    const [sourceConnections, serviceConnections, workers] = await Promise.all([
      sources ?? sourceControl.status(),
      services ?? serviceStatuses(),
      Promise.resolve()
        .then(() => runners().status())
        .then((status) => status.runners)
        .catch(() => []),
    ]);
    return {
      env: { ...readConnections(root), ...process.env },
      sourceConnections,
      serviceConnections,
      workers,
      canRunWorker: (remoteId, project) =>
        docker.canRun?.(remoteId, project) ?? !remoteId,
      localMode,
    };
  }
  function projectReadiness(name: string, context: ReadinessContext) {
    const projectDocument = readEditableConfig(
        root,
        `projects/${name}/project.json`,
      ),
      areasDocument = readEditableConfig(root, `projects/${name}/areas.json`);
    const readiness = inspectPmReadiness(loadProject(root, name), context);
    return {
      projectRevision: projectDocument.revision,
      areasRevision: areasDocument.revision,
      readiness: {
        ...readiness,
        areas: readiness.areas.map((area) => {
          const blockers = area.blockers.filter((item) =>
            [
              "configuration",
              "source_connection",
              "ai_connection",
              "worker",
              "mandate",
            ].includes(item.id),
          );
          return {
            ...area,
            discovery: { canRun: blockers.length === 0, blockers },
          };
        }),
      },
    };
  }
  let dockerState: Awaited<ReturnType<DockerRunners["preflight"]>> | undefined;
  let dockerCheckedAt = 0;
  async function runnerStatus() {
    if (!dockerState || Date.now() - dockerCheckedAt > 15_000) {
      dockerState = await docker.preflight();
      dockerCheckedAt = Date.now();
    }
    const saved = readConnections(root);
    const sources = await sourceControl.status();
    const serviceConnections = await serviceStatuses();
    const blockedSources = new Set<string>();
    const required = new Set(["CLAUDE_CODE_OAUTH_TOKEN"]);
    function requireService(provider: OAuthProvider, id = "default") {
      const connection = serviceConnections.find(
        (item) => item.provider === provider && item.id === id,
      );
      if (connection?.connected && !connection.needsReconnect) return;
      const key =
        id === "default"
          ? provider === "linear"
            ? "LINEAR_API_KEY"
            : "VERCEL_TOKEN"
          : `${provider === "linear" ? "Linear" : "Vercel"} account: ${id}`;
      required.add(key);
      if (id !== "default" || connection?.method === "oauth")
        blockedSources.add(key);
    }
    if (!listProjectNames(root).length) requireService("linear");
    for (const name of listProjectNames(root)) {
      try {
        const project = loadProject(root, name);
        requireService("linear", project.config.linear?.connectionId);
        const verification = effectiveVerification(project.config);
        if (verification.mode === "browser") {
          const target = verification.target;
          if (target.kind === "vercel") {
            requireService("vercel", target.connectionId);
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
    let finishProjectRequest: (() => void) | undefined;
    let countedMutation = false;
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
      const proxyHost = publicOrigin?.host === host;
      const origin = proxyHost ? publicOrigin!.origin : `http://${host}`;
      if (
        (!proxyHost &&
          ![...hosts].some(
            (allowed) => host === `${allowed}:${address?.port}`,
          )) ||
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
      if (url.pathname.startsWith("/api/remote/worker/")) {
        if (await remote.handleRequest(req, res)) {
          void syncRemoteWorkers();
          return;
        }
        throw new RequestError(404, "Unknown remote worker action.");
      }
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
        const scopedProject =
          /^\/api\/projects\/([a-z][a-z0-9-]{0,62})(?:\/|$)/.exec(url.pathname);
        const resourceDelete =
          req.method === "DELETE" &&
          /^\/api\/projects\/[a-z][a-z0-9-]{0,62}(?:\/pms\/[a-z][a-z0-9-]{0,62})?$/.test(
            url.pathname,
          );
        const destructiveConfiguration =
          resourceDelete ||
          (url.pathname === "/api/projects" && req.method === "POST") ||
          (/^\/api\/idea-plans\/[a-f0-9-]+\/create$/.test(url.pathname) &&
            req.method === "POST") ||
          /^\/api\/deleted\/[a-f0-9-]+\/restore$/.test(url.pathname) ||
          url.pathname === "/api/connections/clear" ||
          (url.pathname === "/api/service-connections" &&
            req.method === "DELETE");
        if (req.method !== "GET" && req.method !== "HEAD") {
          if (configurationMutation)
            throw new RequestError(
              409,
              "Configuration is being removed or restored. Wait for it to finish and retry.",
            );
          if (!destructiveConfiguration) {
            activeMutationRequests++;
            countedMutation = true;
          }
        }
        if (
          scopedProject &&
          req.method !== "GET" &&
          req.method !== "HEAD" &&
          !resourceDelete
        )
          finishProjectRequest = trackProject(scopedProject[1]!);
        const deleteTarget =
          /^\/api\/projects\/([a-z][a-z0-9-]{0,62})(?:\/pms\/([a-z][a-z0-9-]{0,62}))?(\/deletion)?$/.exec(
            url.pathname,
          );
        if (deleteTarget && (deleteTarget[3] || req.method === "DELETE")) {
          if (url.search)
            throw new RequestError(
              400,
              "Deletion requests do not accept query parameters.",
            );
          const target = {
            project: deleteTarget[1]!,
            ...(deleteTarget[2] ? { area: deleteTarget[2] } : {}),
          };
          if (deleteTarget[3] && req.method === "GET")
            json(res, 200, await resourceDeletion.preview(target));
          else if (!deleteTarget[3] && req.method === "DELETE") {
            const input = await body(req);
            if (
              Object.keys(input).length !== 2 ||
              typeof input.revision !== "string" ||
              typeof input.confirm !== "string"
            )
              throw new RequestError(
                400,
                "Provide the reviewed revision and exact confirmation identifier.",
              );
            json(
              res,
              200,
              await resourceDeletion.remove({
                ...target,
                revision: input.revision,
                confirmation: input.confirm,
              }),
            );
          } else
            throw new RequestError(
              405,
              "Use GET to review deletion and DELETE to confirm it.",
            );
          return;
        }
        const recovery = /^\/api\/deleted(?:\/([a-f0-9-]+)(\/restore)?)?$/.exec(
          url.pathname,
        );
        if (recovery) {
          if (url.search)
            throw new RequestError(
              400,
              "Recovery requests do not accept query parameters.",
            );
          if (!recovery[1] && req.method === "GET")
            json(res, 200, { recoveries: resourceDeletion.listRecoveries() });
          else if (recovery[1] && !recovery[2] && req.method === "GET")
            json(res, 200, await resourceDeletion.previewRestore(recovery[1]));
          else if (recovery[1] && recovery[2] && req.method === "POST") {
            const input = await body(req);
            if (
              Object.keys(input).length !== 2 ||
              typeof input.revision !== "string" ||
              typeof input.confirm !== "string"
            )
              throw new RequestError(
                400,
                "Provide the reviewed revision and exact confirmation identifier.",
              );
            json(
              res,
              200,
              await resourceDeletion.restore({
                id: recovery[1],
                revision: input.revision,
                confirmation: input.confirm,
              }),
            );
          } else
            throw new RequestError(
              405,
              "Use GET to review recovery and POST to restore it.",
            );
          return;
        }
        if (
          url.pathname === "/api/source-control" ||
          url.pathname.startsWith("/api/source-control/")
        ) {
          try {
            const match =
              /^\/api\/source-control(?:\/(github|gitlab)(?:\/(connect|poll|repositories|owners))?)?$/.exec(
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
              action === "owners" &&
              req.method === "GET"
            ) {
              if (
                [...url.searchParams.keys()].some((key) => key !== "serverUrl")
              )
                throw new RequestError(400, "Use a source server only.");
              if (!sourceControl.repositoryOwners)
                throw new RequestError(
                  503,
                  "Repository creation is unavailable on this controller.",
                );
              json(
                res,
                200,
                await sourceControl.repositoryOwners({
                  provider,
                  ...(url.searchParams.has("serverUrl")
                    ? { serverUrl: url.searchParams.get("serverUrl")! }
                    : {}),
                }),
              );
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
        if (url.pathname === "/api/service-connections") {
          try {
            if (url.search)
              throw new RequestError(
                400,
                "Saved account requests do not accept query parameters.",
              );
            if (req.method === "GET")
              json(res, 200, { connections: await serviceStatuses() });
            else if (req.method === "POST") {
              const input = await body(req);
              if (
                Object.keys(input).some(
                  (key) => !["provider", "id", "label"].includes(key),
                ) ||
                !["linear", "vercel"].includes(String(input.provider)) ||
                !validConnectionId(input.id) ||
                typeof input.label !== "string"
              )
                throw new RequestError(
                  400,
                  "Provide a provider, saved account ID, and display name.",
                );
              const profile = await createConnectionProfile(root, {
                provider: input.provider as OAuthProvider,
                id: input.id,
                label: input.label,
              });
              json(res, 200, {
                ...(await selectedConnection(
                  profile.provider,
                  profile.id,
                ).status({ checkAvailability: false })),
                ...profile,
              });
            } else if (req.method === "DELETE") {
              const input = await body(req);
              if (
                Object.keys(input).length !== 2 ||
                !["linear", "vercel"].includes(String(input.provider)) ||
                !validConnectionId(input.id)
              )
                throw new RequestError(
                  400,
                  "Provide the provider and saved account ID to remove.",
                );
              json(
                res,
                200,
                await withConfigurationMutation({}, () =>
                  deleteConnectionProfile(root, {
                    provider: input.provider as OAuthProvider,
                    id: input.id as string,
                  }),
                ),
              );
            } else
              throw new RequestError(
                405,
                "Use GET, POST or DELETE for saved accounts.",
              );
          } catch (error) {
            if (
              error instanceof RequestError ||
              error instanceof LocalRunnerError
            )
              throw error;
            if (error instanceof OAuthConnectionError)
              throw new RequestError(error.status, error.message);
            throw new RequestError(
              400,
              "Saved accounts could not be loaded or changed. Check the account name and local configuration.",
            );
          }
          return;
        }
        const serviceAction =
          /^\/api\/(linear|vercel)(?:\/(connect|complete|resources))?$/.exec(
            url.pathname,
          );
        if (serviceAction) {
          const action = serviceAction[2];
          try {
            if (
              [...url.searchParams.keys()].some(
                (key) => key !== "connection",
              ) ||
              url.searchParams.getAll("connection").length > 1
            )
              throw new RequestError(400, "Use one saved connection ID.");
            const connectionId =
              url.searchParams.get("connection") ?? "default";
            await requireProfile(
              serviceAction[1] as OAuthProvider,
              connectionId,
            );
            const connection = selectedConnection(
              serviceAction[1] as OAuthProvider,
              connectionId,
            );
            if (req.method === "GET" && !action)
              json(res, 200, await connection.status());
            else if (
              req.method === "GET" &&
              action === "resources" &&
              serviceAction[1] === "linear"
            )
              json(
                res,
                200,
                await linearProvisioning.resources(undefined, connectionId),
              );
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
          if (setupBusy())
            throw new RequestError(
              409,
              "Wait for repository setup and environment tests to finish before stopping this controller.",
            );
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
        if (url.pathname === "/api/remote/status") {
          if (req.method !== "GET")
            throw new RequestError(405, "Use GET for remote worker status.");
          void syncRemoteWorkers();
          json(res, 200, remote.status());
          return;
        }
        if (url.pathname === "/api/remote/enrollments") {
          if (req.method !== "POST")
            throw new RequestError(405, "Use POST to enroll a worker.");
          const input = await body(req),
            names = listProjectNames(root);
          if (
            Object.keys(input).some(
              (key) => !["name", "projects"].includes(key),
            ) ||
            typeof input.name !== "string" ||
            !Array.isArray(input.projects) ||
            input.projects.some(
              (name) => typeof name !== "string" || !names.includes(name),
            )
          )
            throw new RequestError(
              400,
              "Choose a worker name and projects from this instance.",
            );
          json(
            res,
            201,
            remote.createEnrollment({
              name: input.name,
              projects: input.projects as string[],
            }),
          );
          return;
        }
        const revokeRemote =
          /^\/api\/remote\/(remote-[a-f0-9-]+)\/revoke$/.exec(url.pathname);
        if (revokeRemote) {
          if (req.method !== "POST" || Object.keys(await body(req)).length)
            throw new RequestError(
              400,
              "Use POST with an empty object to revoke this worker.",
            );
          const worker = remote
            .status()
            .workers.find((worker) => worker.id === revokeRemote[1]);
          const result = remote.revoke(revokeRemote[1]!);
          if (worker?.logicalId)
            await runners().action(worker.logicalId, "pause");
          json(res, 200, result);
          return;
        }
        const deliveryRoute =
          /^\/api\/projects\/([a-z][a-z0-9-]*)\/delivery(?:\/(promote|production|states|advance|environment))?$/.exec(
            url.pathname,
          );
        if (deliveryRoute) {
          const name = deliveryRoute[1]!,
            action = deliveryRoute[2];
          if (req.method === "GET" && !action)
            json(res, 200, deliveryView(name));
          else if (req.method === "POST" && action === "environment") {
            const input = await body(req),
              project = loadProject(root, name);
            if (
              Object.keys(input).some(
                (key) => !["revision", "environment"].includes(key),
              ) ||
              typeof input.environment !== "string" ||
              typeof input.revision !== "string" ||
              effectiveWorkflow(project.config).kind !== "promotion"
            )
              throw new RequestError(
                400,
                "Choose an existing candidate environment and the current project revision.",
              );
            const target = project.config.environments?.[input.environment],
              verification = effectiveVerification(project.config);
            if (
              !target ||
              target.role === "production" ||
              !["railway", "vercel"].includes(target.kind)
            )
              throw new RequestError(
                400,
                "Use a non-production Vercel or Railway target with exact deployment metadata.",
              );
            if (
              target.kind === "railway" &&
              verification.mode === "browser" &&
              verification.target.kind === "railway" &&
              target.projectId === verification.target.projectId &&
              target.environmentId === verification.target.environmentId &&
              target.serviceId === verification.target.serviceId
            )
              throw new RequestError(
                400,
                "Use a separate Railway candidate service or environment so release testing cannot replace pm-staging.",
              );
            const document = readEditableConfig(
                root,
                `projects/${name}/project.json`,
              ),
              raw = JSON.parse(document.content);
            raw.workflow = {
              ...raw.workflow,
              kind: "promotion",
              candidateEnvironment: input.environment,
            };
            try {
              saveEditableConfig(root, {
                path: document.path,
                revision: input.revision,
                content: JSON.stringify(raw, null, 2) + "\n",
              });
            } catch (error) {
              if (error instanceof ConfigEditorError)
                throw new RequestError(error.status, error.message);
              throw error;
            }
            json(res, 200, deliveryView(name));
          } else if (req.method === "GET" && action === "states") {
            const project = loadProject(root, name),
              mapping = project.config.linear;
            if (!mapping?.teamId)
              throw new RequestError(
                409,
                "Choose this project's Linear team before tracking production.",
              );
            const auth = await linearConnectionFor(
              mapping.connectionId,
            ).resolveCredential({
              workspaceId: mapping.workspaceId,
              minValidityMs: 60_000,
            });
            const states = await new LinearApi({
              apiKey: auth.authorization,
            }).listWorkflowStates(mapping.teamId);
            json(res, 200, {
              states: states.filter(
                (state) =>
                  state.type === "completed" && state.teamId === mapping.teamId,
              ),
            });
          } else if (req.method === "POST" && action === "promote") {
            const input = await body(req);
            if (
              Object.keys(input).some((key) => key !== "area") ||
              (input.area !== undefined && typeof input.area !== "string")
            )
              throw new RequestError(
                400,
                "Choose an owning PM area or all verified deliveries.",
              );
            const current = delivery.deliveryStatus(name);
            if (
              !current.enabled ||
              !current.deliveries.some(
                (item) =>
                  item.status === "verified" &&
                  (!input.area || item.area === input.area),
              )
            )
              throw new RequestError(
                409,
                "No matching verified deliveries are ready to package. Run the owning PM after its integration deployment is ready.",
              );
            preparePromotion(name, input.area as string | undefined);
            json(res, 202, deliveryView(name));
          } else if (req.method === "POST" && action === "advance") {
            if (Object.keys(await body(req)).length)
              throw new RequestError(
                400,
                "Use an empty object to check integration delivery.",
              );
            advanceIntegration(name);
            json(res, 202, deliveryView(name));
          } else if (req.method === "POST" && action === "production") {
            const input = await body(req);
            if (
              Object.keys(input).some(
                (key) =>
                  ![
                    "revision",
                    "deliveryIds",
                    "productionPr",
                    "completedStateId",
                    "scopeComplete",
                  ].includes(key),
              ) ||
              input.scopeComplete !== true
            )
              throw new RequestError(
                400,
                "Review and confirm the complete delivery scope before tracking production.",
              );
            try {
              await delivery.declareProduction(
                name,
                input as unknown as Parameters<
                  typeof delivery.declareProduction
                >[1],
              );
            } catch {
              throw new RequestError(
                409,
                "Production scope was not saved. Refresh deliveries, select every deliverable for the ticket, choose its completed state and the staging-to-production PR, then review again.",
              );
            }
            void reconcileDeliveries();
            json(res, 202, deliveryView(name));
          } else
            throw new RequestError(405, "Choose a supported delivery action.");
          return;
        }
        const setupSuggestions =
          /^\/api\/projects\/([a-z][a-z0-9-]*)\/pms\/([a-z][a-z0-9-]*)\/setup-suggestions$/.exec(
            url.pathname,
          );
        if (setupSuggestions) {
          if (req.method === "GET")
            json(
              res,
              200,
              readSetupSuggestions(
                root,
                setupSuggestions[1]!,
                setupSuggestions[2]!,
              ),
            );
          else if (req.method === "POST") {
            try {
              json(
                res,
                200,
                applySetupSuggestions(
                  root,
                  setupSuggestions[1]!,
                  setupSuggestions[2]!,
                  await body(req),
                ),
              );
            } catch (error) {
              if (error instanceof ConfigEditorError)
                throw new RequestError(error.status, error.message);
              throw error;
            }
          } else
            throw new RequestError(
              405,
              "Use GET to review or POST to apply setup suggestions.",
            );
          return;
        }
        const reviewAction =
          /^\/api\/projects\/([a-z][a-z0-9-]*)\/review(?:\/([A-Za-z0-9-]+)\/approve)?$/.exec(
            url.pathname,
          );
        if (reviewAction) {
          if (req.method === "GET" && !reviewAction[2])
            json(res, 200, await projectReview.list(reviewAction[1]!));
          else if (req.method === "POST" && reviewAction[2]) {
            const input = await body(req);
            if (Object.keys(input).some((key) => key !== "revision"))
              throw new RequestError(400, "Use the reviewed ticket revision.");
            json(
              res,
              200,
              await projectReview.approve(
                reviewAction[1]!,
                reviewAction[2],
                input.revision,
              ),
            );
          } else
            throw new RequestError(405, "Choose a supported review action.");
          return;
        }
        if (url.pathname === "/api/operations") {
          if (req.method !== "GET")
            throw new RequestError(405, "Use GET for the review inbox.");
          const [jobs, context, runnerState] = await Promise.all([
            runners().jobs(),
            readinessContext(),
            runners().status(),
          ]);
          json(res, 200, {
            projects: listProjectNames(root).map((name) => {
              try {
                return projectOperations(
                  root,
                  name,
                  jobs,
                  context,
                  runnerState.execution,
                  delivery.deliveryStatus(name).deliveries,
                );
              } catch {
                return {
                  project: name,
                  unavailable: true,
                  inbox: [
                    {
                      id: "setup:configuration",
                      kind: "setup",
                      title: `${name} needs configuration repair`,
                      detail:
                        "This project's saved settings or delivery records could not be read. Other projects remain available; existing files have been preserved.",
                      action: {
                        label: "Open configuration",
                        href: "/settings",
                      },
                    },
                  ],
                };
              }
            }),
          });
          return;
        }
        const projectOps =
          /^\/api\/projects\/([a-z][a-z0-9-]*)\/(operations|execution|decisions)(?:\/([a-f0-9-]+))?$/.exec(
            url.pathname,
          );
        if (projectOps) {
          const name = projectOps[1]!,
            action = projectOps[2]!;
          if (
            action === "operations" &&
            req.method === "GET" &&
            !projectOps[3]
          ) {
            const [jobs, context, runnerState] = await Promise.all([
              runners().jobs(),
              readinessContext(),
              runners().status(),
            ]);
            json(
              res,
              200,
              projectOperations(
                root,
                name,
                jobs,
                context,
                runnerState.execution,
                delivery.deliveryStatus(name).deliveries,
              ),
            );
          } else if (
            action === "execution" &&
            req.method === "POST" &&
            !projectOps[3]
          ) {
            const input = await body(req);
            try {
              json(res, 200, { ok: true, ...saveExecution(root, name, input) });
            } catch (error) {
              if (error instanceof ConfigEditorError)
                throw new RequestError(error.status, error.message);
              throw new RequestError(
                400,
                "Check run limits: concurrency 1–4, daily runs 1–1000, daily runtime 1–10080 minutes, and job duration 1–45 minutes.",
              );
            }
          } else if (
            action === "decisions" &&
            req.method === "POST" &&
            !projectOps[3]
          ) {
            const input = await body(req);
            if (
              Object.keys(input).some(
                (key) => !["text", "revision"].includes(key),
              )
            )
              throw new RequestError(400, "Use text and the current revision.");
            json(res, 200, projectKnowledge.add(name, input));
          } else if (
            action === "decisions" &&
            req.method === "DELETE" &&
            projectOps[3]
          ) {
            const input = await body(req);
            if (Object.keys(input).some((key) => key !== "revision"))
              throw new RequestError(400, "Use the current revision.");
            json(
              res,
              200,
              projectKnowledge.remove(name, projectOps[3], input.revision),
            );
          } else
            throw new RequestError(
              405,
              "Choose a supported project operation.",
            );
          return;
        }
        const cancelJob = /^\/api\/jobs\/(job-[a-f0-9-]+)\/cancel$/.exec(
          url.pathname,
        );
        if (cancelJob) {
          if (req.method !== "POST")
            throw new RequestError(405, "Use POST to cancel a run.");
          if (Object.keys(await body(req)).length)
            throw new RequestError(400, "Cancel takes an empty JSON object.");
          json(res, 202, { job: await runners().cancel(cancelJob[1]!) });
          runners().start();
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
            const historyRead = outputRead(
              `runs:${limit}:${before ?? ""}`,
              () =>
                activityStore.listRuns({
                  limit,
                  ...(before ? { beforeRunId: Number(before) } : {}),
                }),
              150,
            );
            const live = (await runners().jobs()).filter(
              (job) => !before || job.runId < Number(before),
            );
            const saved = await historyRead;
            const history = saved.value ?? [];
            const historyAvailable =
              saved.available && !saved.failed && !saved.pending;
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
              (key) =>
                !["type", "project", "area", "ticket", "pmMode"].includes(key),
            ) ||
            !["pm", "developer"].includes(String(input.type)) ||
            typeof input.project !== "string" ||
            (input.area !== undefined && typeof input.area !== "string") ||
            (input.ticket !== undefined && typeof input.ticket !== "string") ||
            (input.pmMode !== undefined &&
              (input.type !== "pm" ||
                !["discovery", "exploration"].includes(String(input.pmMode)) ||
                input.ticket !== undefined))
          )
            throw new RequestError(
              400,
              "Choose a project and a PM area or coding run. A specific approved Linear ticket is optional.",
            );
          const jobInput = input as unknown as LocalJobInput;
          jobInput.runOnce = true;
          if (jobInput.type === "pm") {
            const project = loadProject(root, jobInput.project!);
            if (
              jobInput.pmMode !== "exploration" &&
              foundationNeeded(root, project)
            )
              throw new RequestError(
                409,
                "Build the foundation first. Open this project's Environment page to review and start its first coding run. PMs can explore after application code is merged.",
              );
            const selectedArea = project.areas.find(
              (area) => area.key === jobInput.area,
            );
            if (jobInput.pmMode !== "discovery") {
              const before = projectReadiness(
                jobInput.project!,
                await readinessContext(),
              ).readiness.areas.find((area) => area.key === jobInput.area);
              if (!before)
                throw new RequestError(
                  400,
                  "Choose an existing PM before starting its run.",
                );
              const blockers = before.blockers.filter(
                (item) => !["linear_mapping", "verification"].includes(item.id),
              );
              if (blockers.length)
                throw new RequestError(
                  409,
                  blockers.map((item) => item.message).join(" "),
                );
            }
            if (
              jobInput.pmMode !== "discovery" &&
              selectedArea &&
              !hasPmMapping(selectedArea)
            ) {
              const mapping = await provisionLinear(
                jobInput.project!,
                undefined,
                selectedArea.key,
              );
              if (mapping.status !== "ready")
                throw new RequestError(
                  409,
                  mapping.message ?? "Connect Linear before running this PM.",
                );
            }
            if (jobInput.pmMode !== "discovery") {
              const current = loadProject(root, jobInput.project!);
              if (!current.config.verified) {
                const snapshot = verificationSnapshot(current.dir);
                const checks = await doctorChecks(current, {
                  root,
                  env: { ...readConnections(root), ...process.env },
                  fetch,
                  today: () => new Date().toISOString().slice(0, 10),
                  sourceControl,
                  linearConnection,
                  vercelConnection,
                  linearConnectionFor,
                  vercelConnectionFor,
                });
                const failed = checks.filter((check) => !check.ok);
                if (failed.length)
                  throw new RequestError(
                    409,
                    `PM setup needs attention: ${failed.map((check) => check.detail).join(" ")}`,
                  );
                stampVerified(
                  current.dir,
                  new Date().toISOString().slice(0, 10),
                  snapshot,
                );
              }
            }
            const ready = projectReadiness(
              jobInput.project!,
              await readinessContext(),
            ).readiness.areas.find((area) => area.key === jobInput.area);
            if (!ready)
              throw new RequestError(
                400,
                "Choose an existing PM before starting its run.",
              );
            const selectedReadiness =
              jobInput.pmMode === "discovery" ? ready.discovery : ready;
            if (!selectedReadiness.canRun)
              throw new RequestError(
                409,
                selectedReadiness.blockers
                  .map((item) => item.message)
                  .join(" "),
              );
          }
          let validated: Awaited<ReturnType<typeof preparation.validate>>;
          try {
            if (jobInput.type === "developer" && !jobInput.ticket?.trim()) {
              Object.assign(
                jobInput,
                await preparation.selectDeveloperTicket(
                  jobInput,
                  await runners().jobs(),
                ),
              );
            }
            validated = await preparation.validate(jobInput);
          } catch (error) {
            throw new RequestError(
              400,
              error instanceof JobReadinessError
                ? error.message
                : "This job is not ready. Verify the project, review its PM mapping and mandate, and check the selected connections and ticket approval.",
            );
          }
          jobInput.linearBinding = validated.linearBinding;
          jobInput.projectInstanceId = validated.project.config.instanceId;
          if (jobInput.type === "pm")
            jobInput.discoveryRevision = validated.discoveryRevision;
          if (validated.ticket) {
            jobInput.area = validated.area.key;
            jobInput.ticket = validated.ticket.identifier;
            const previous = (await runners().jobs()).filter((job) => {
              if (
                job.type !== "developer" ||
                job.project !== jobInput.project ||
                job.projectInstanceId !== jobInput.projectInstanceId
              )
                return false;
              const oldBinding = job.linearBinding,
                currentBinding = jobInput.linearBinding;
              // Identifiers such as ENG-123 can belong to unrelated workspaces.
              // Older jobs without immutable identity retain the conservative guard.
              if (!oldBinding?.ticketId || !currentBinding?.ticketId)
                return job.ticket === jobInput.ticket;
              if (oldBinding.ticketId !== currentBinding.ticketId) return false;
              if (oldBinding.workspaceId && currentBinding.workspaceId)
                return oldBinding.workspaceId === currentBinding.workspaceId;
              return oldBinding.connectionId === currentBinding.connectionId;
            });
            if (
              previous.some((job) =>
                ["queued", "running", "succeeded"].includes(job.status),
              )
            )
              throw new RequestError(
                409,
                "This ticket already has active or completed work. Review its job and draft PR/MR before requesting another implementation.",
              );
            jobInput.idempotencyKey = `developer:${jobInput.project}:${jobInput.projectInstanceId ? jobInput.projectInstanceId + ":" : ""}${validated.ticket.id}${previous.length ? `:retry:${randomBytes(8).toString("hex")}` : ""}`;
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
          const found = await outputRead(
            `job:${id}`,
            () => runners().job(id),
            1500,
          );
          if (!found.available)
            throw new RequestError(
              503,
              "Run details are temporarily unavailable. Retry shortly; the job continues.",
            );
          const job = found.value;
          if (!job) throw new RequestError(404, "Unknown gremlin run.");
          if (jobOutput[2] === "activity" && !jobOutput[3]) {
            // Start independent sources together. A recovering PostgreSQL must
            // not delay Docker output that is already available.
            const historyRead = outputRead(
              `activity:${id}`,
              () => activityStore.activity(id),
              150,
            );
            const current = await liveLogs(id);
            const persisted = await historyRead;
            const live = parseActivityLogs(current.value ?? []);
            const lifecycle: ActivityEvent = {
              id: `lifecycle:${job.status}`,
              type: ["succeeded", "failed", "canceled"].includes(job.status)
                ? "result"
                : "progress",
              timestamp: job.finishedAt ?? job.startedAt ?? job.createdAt,
              title: `Run ${job.status}`,
              detail: cleanOutput([
                job.message ||
                  (job.status === "queued"
                    ? "Waiting for an available verified worker."
                    : job.status === "running"
                      ? "Preparing or running this job. Public tool calls and updates appear as they are received."
                      : "This run has finished."),
              ]).join("\n"),
              ...(job.status === "canceled"
                ? {}
                : {
                    status:
                      job.status === "failed"
                        ? "failed"
                        : job.status === "succeeded"
                          ? "succeeded"
                          : "running",
                  }),
            };
            const events = [
              ...new Map(
                [...(persisted.value?.events ?? []), lifecycle, ...live].map(
                  (event) => [event.id, event],
                ),
              ).values(),
            ].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
            const partial =
              current.pending ||
              current.failed ||
              persisted.pending ||
              persisted.failed;
            json(res, 200, {
              ...summarizeActivity(events),
              ...(partial
                ? {
                    partial: true,
                    message:
                      "Showing available activity. Some output is still loading; this does not stop the job.",
                  }
                : {}),
            });
          } else if (jobOutput[2] === "logs" && !jobOutput[3]) {
            const current = await liveLogs(id);
            if (!current.available)
              throw new RequestError(
                503,
                "Job output is temporarily unavailable. Retry shortly; activity and the job continue independently.",
              );
            json(res, 200, {
              lines: current.value,
              ...(current.pending || current.failed
                ? {
                    partial: true,
                    message:
                      "Showing the last available output while the next read completes.",
                  }
                : {}),
            });
          } else if (!jobOutput[3]) {
            if (job.status === "queued" || job.status === "running") {
              json(res, 200, { files: [], pending: true });
              return;
            }
            const current = await outputRead(
              `artifacts:${id}`,
              () => runners().artifacts(id),
              1500,
            );
            if (!current.available)
              throw new RequestError(
                503,
                "Artifacts are still loading. Retry shortly; logs and activity are available independently.",
              );
            const files = current.value ?? [];
            json(res, 200, {
              files: files.map((file) => ({
                ...file,
                url: `/api/jobs/${id}/artifacts/${encodeURIComponent(file.name)}`,
              })),
              ...(current.pending || current.failed ? { partial: true } : {}),
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
            let content: Buffer;
            try {
              content = await dashboardOutputDeadline(
                () => runners().readArtifact(id, name),
                5000,
              );
            } catch {
              throw new RequestError(
                503,
                "This artifact is temporarily unavailable. Retry the download shortly; logs and activity remain independent.",
              );
            }
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
          if (action !== "check" && setupBusy())
            throw new RequestError(
              409,
              "Wait for repository setup and environment tests to finish before updating or restarting this controller.",
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
          const serviceConnections = await serviceStatuses();
          const readiness = await readinessContext(
            sourceConnections,
            serviceConnections,
          );
          const foundationJobs = await runners()
            .jobs()
            .catch(() => []);
          const configWarnings: string[] = [];
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
              const snapshot = projectReadiness(name, readiness);
              return {
                name,
                repo: project.config.repo,
                instanceId: project.config.instanceId,
                ideaPlanId: project.config.ideaPlanId,
                foundation: foundationSummary(root, project, foundationJobs),
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
                telemetry: project.config.telemetry ?? {},
                branches: project.config.branches,
                verified: project.config.verified,
                linear: linearProvisioning.status(name),
                ...snapshot,
                areas: project.areas.map(
                  ({
                    key,
                    name: areaName,
                    enabled,
                    linearProjectId,
                    mandate,
                    charter,
                    paths,
                    sharedTouchpoints,
                    metric,
                    schedule,
                    wipLimit,
                    mixpanelReportId,
                  }) => ({
                    key,
                    name: areaName,
                    enabled,
                    linearProjectId,
                    mandate,
                    charter,
                    paths,
                    sharedTouchpoints,
                    metric,
                    schedule,
                    wipLimit,
                    mixpanelReportId,
                    readiness: snapshot.readiness.areas.find(
                      (item) => item.key === key,
                    ),
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
                [...CONNECTIONS, ...projectConnectionDefinitions(root)].map(
                  (connection) => [connection.name, connection],
                ),
              ).values(),
            ].map((connection) => ({
              ...connection,
              configured: Boolean(
                saved[connection.name] || process.env[connection.name],
              ),
              saved: Boolean(saved[connection.name]),
              inherited: Boolean(process.env[connection.name]),
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
        if (url.pathname === "/api/connections/clear") {
          if (req.method !== "POST")
            throw new RequestError(405, "Use POST to clear saved credentials.");
          if (url.search)
            throw new RequestError(
              400,
              "Credential removal does not accept query parameters.",
            );
          const input = await body(req);
          if (Object.keys(input).length !== 1 || !Object.hasOwn(input, "names"))
            throw new RequestError(
              400,
              "Provide the saved credential names to clear.",
            );
          await withConfigurationMutation({}, () =>
            clearConnections(root, input.names),
          );
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
          } catch (error) {
            throw new RequestError(
              400,
              error instanceof ConnectionSaveError
                ? error.message
                : "Connections were not saved. The configuration store could not be updated; check its location in Settings. Existing credentials were preserved.",
            );
          }
          json(res, 200, { ok: true });
          return;
        }
        const vercelSetupRoute =
          /^\/api\/projects\/([a-z][a-z0-9-]{0,62})\/onboarding\/vercel(?:\/(discover|prepare|deploy|chat))?$/.exec(
            url.pathname,
          );
        if (vercelSetupRoute) {
          const name = vercelSetupRoute[1]!,
            action = vercelSetupRoute[2];
          if (url.search)
            throw new RequestError(
              400,
              "Vercel setup requests do not accept query parameters.",
            );
          if (!listProjectNames(root).includes(name))
            throw new RequestError(404, "Project not found.");
          if (!action) {
            if (req.method !== "GET")
              throw new RequestError(405, "Use GET for Vercel setup.");
            json(res, 200, await vercelSetup.status(name));
          } else {
            if (req.method !== "POST")
              throw new RequestError(405, "Use POST for Vercel setup actions.");
            if (updateRunning || setupBusy(name))
              throw new RequestError(
                409,
                "Wait for the current update or setup operation to finish.",
              );
            const input = await body(req);
            const allowed =
              action === "discover"
                ? ["connectionId", "teamId", "projectId", "revision"]
                : action === "prepare"
                  ? ["revision", "branch", "baseBranch", "customEnvironmentId"]
                  : action === "deploy"
                    ? ["revision", "confirmTestData"]
                    : ["message"];
            if (
              Object.keys(input).some((key) => !allowed.includes(key)) ||
              Object.entries(input).some(([key, value]) =>
                key === "confirmTestData"
                  ? value !== true
                  : key === "teamId" && value === null
                    ? false
                    : typeof value !== "string",
              )
            )
              throw new RequestError(
                400,
                "Provide only the supported Vercel setup fields.",
              );
            if (
              (action === "prepare" || action === "deploy") &&
              typeof input.revision !== "string"
            )
              throw new RequestError(
                400,
                "Review the latest Vercel setup before continuing.",
              );
            if (action === "discover") {
              if (typeof input.connectionId === "string")
                await requireProfile("vercel", input.connectionId);
              json(
                res,
                200,
                await vercelSetup.discover(name, input as VercelDiscoverInput),
              );
            } else if (action === "prepare") {
              json(
                res,
                200,
                await vercelSetup.prepare(
                  name,
                  input as unknown as VercelPrepareInput,
                ),
              );
            } else if (action === "deploy") {
              if (input.confirmTestData !== true)
                throw new RequestError(
                  400,
                  "Confirm this preview uses test services and data before creating it.",
                );
              json(
                res,
                200,
                await vercelSetup.deploy(
                  name,
                  input as unknown as VercelDeployInput,
                ),
              );
            } else
              json(res, 200, await environmentGuide.ask(name, input.message));
          }
          return;
        }
        const foundationRoute =
          /^\/api\/projects\/([a-z][a-z0-9-]{0,62})\/foundation(?:\/(build|inspect))?$/.exec(
            url.pathname,
          );
        if (foundationRoute) {
          const name = foundationRoute[1]!,
            action = foundationRoute[2];
          if (url.search)
            throw new RequestError(
              400,
              "Foundation requests do not accept query parameters.",
            );
          if (!listProjectNames(root).includes(name))
            throw new RequestError(404, "Project not found.");
          try {
            if (!action) {
              if (req.method !== "GET")
                throw new RequestError(
                  405,
                  "Use GET to review the foundation build.",
                );
              json(res, 200, await foundation.status(name));
            } else {
              if (req.method !== "POST")
                throw new RequestError(405, "Use POST for foundation actions.");
              if (updateRunning || setupBusy(name))
                throw new RequestError(
                  409,
                  "Wait for active setup work before starting the foundation.",
                );
              const input = await body(req);
              if (action === "inspect") {
                if (Object.keys(input).length)
                  throw new RequestError(
                    400,
                    "Repository inspection takes an empty object.",
                  );
                json(res, 200, await foundation.inspect(name));
              } else {
                if (
                  Object.keys(input).some(
                    (key) => !["revision", "retryJobId"].includes(key),
                  ) ||
                  typeof input.revision !== "string" ||
                  (input.retryJobId !== undefined &&
                    typeof input.retryJobId !== "string")
                )
                  throw new RequestError(
                    400,
                    "Review the foundation brief and provide its current revision.",
                  );
                json(
                  res,
                  202,
                  await foundation.start(
                    name,
                    input as { revision: string; retryJobId?: string },
                  ),
                );
              }
            }
          } catch (error) {
            if (error instanceof RequestError) throw error;
            throw new RequestError(
              error instanceof IdeaCrewError ? error.status : 503,
              error instanceof IdeaCrewError
                ? error.message
                : "Foundation setup stopped. Your reviewed plan and completed setup steps are saved. Refresh and retry to resume.",
            );
          }
          return;
        }
        const onboardingRoute =
          /^\/api\/projects\/([a-z][a-z0-9-]{0,62})\/onboarding(?:\/(discover|configure|verify|setup-pr|cancel|screenshot))?$/.exec(
            url.pathname,
          );
        if (onboardingRoute) {
          const name = onboardingRoute[1]!,
            action = onboardingRoute[2];
          if (url.search)
            throw new RequestError(
              400,
              "Setup requests do not accept query parameters.",
            );
          if (!listProjectNames(root).includes(name))
            throw new RequestError(404, "Project not found.");
          if (!action) {
            if (req.method !== "GET")
              throw new RequestError(405, "Use GET for project setup.");
            json(res, 200, await onboardingState(name));
          } else if (action === "screenshot") {
            if (req.method !== "GET")
              throw new RequestError(
                405,
                "Use GET for the environment screenshot.",
              );
            const png = environmentAccess.screenshot(name);
            res.writeHead(200, {
              "Content-Type": "image/png",
              "Content-Length": png.length,
            });
            res.end(png);
          } else {
            if (req.method !== "POST")
              throw new RequestError(405, "Use POST for setup actions.");
            if (updateRunning)
              throw new RequestError(
                409,
                "Wait for the controller update before starting setup work.",
              );
            const input = await body(req);
            if (action === "configure") {
              if (
                Object.keys(input).some(
                  (key) =>
                    ![
                      "configurationRevision",
                      "profile",
                      "environment",
                      "target",
                    ].includes(key),
                ) ||
                typeof input.configurationRevision !== "string" ||
                !["hosted", "docker"].includes(String(input.profile)) ||
                (input.environment !== undefined &&
                  (typeof input.environment !== "string" ||
                    !/^[a-z][a-z0-9-]{0,62}$/.test(input.environment))) ||
                (input.target !== undefined && !record(input.target)) ||
                (!input.target && !input.environment)
              )
                throw new RequestError(
                  400,
                  "Choose an environment profile and target with the current configuration revision.",
                );
              if (setupBusy(name))
                throw new RequestError(
                  409,
                  "Wait for this project's setup or environment test before changing its environment.",
                );
              await runners().withConfigurationMutation(
                { project: name },
                async () => {
                  const file = `projects/${name}/project.json`,
                    current = readEditableConfig(root, file);
                  if (current.revision !== input.configurationRevision)
                    throw new RequestError(
                      409,
                      "Project settings changed. Reload before saving this environment.",
                    );
                  const raw = JSON.parse(current.content) as Record<
                    string,
                    unknown
                  >;
                  const existing = record(raw.environments)
                    ? raw.environments
                    : {};
                  // Reuse a current target only when the owner selected it explicitly.
                  const environment =
                    typeof input.environment === "string"
                      ? input.environment
                      : "pm-test";
                  const selected = input.target ?? existing[environment];
                  let capabilities;
                  try {
                    capabilities = parseProjectCapabilities({
                      ...raw,
                      environments: { ...existing, [environment]: selected },
                      verification: { mode: "browser", environment },
                    });
                  } catch {
                    throw new RequestError(
                      400,
                      "Choose a valid nonproduction environment, recipe and secret references.",
                    );
                  }
                  const target = capabilities.environments![environment]!;
                  if (
                    (target.kind === "docker") !==
                      (input.profile === "docker") ||
                    target.role === "production"
                  )
                    throw new RequestError(
                      400,
                      "Choose a matching nonproduction environment profile.",
                    );
                  if (target.kind === "vercel" && target.connectionId)
                    await requireProfile("vercel", target.connectionId);
                  // No analyzed values or provider credentials are silently copied into configuration.
                  raw.environments = capabilities.environments;
                  raw.verification = { mode: "browser", environment };
                  raw.verified = null;
                  saveEditableConfig(root, {
                    path: file,
                    content: JSON.stringify(raw, null, 2) + "\n",
                    revision: current.revision,
                  });
                  await projectOnboarding.recordConfigured(name, {
                    previousConfigurationRevision: current.revision,
                    profile: input.profile as "hosted" | "docker",
                  });
                },
              );
              json(res, 200, await onboardingState(name));
            } else {
              if (
                Object.keys(input).some((key) => key !== "revision") ||
                (input.revision !== undefined &&
                  typeof input.revision !== "string")
              )
                throw new RequestError(
                  400,
                  "Provide only an optional setup revision.",
                );
              if (action === "discover") {
                if (
                  environmentAccess.busy(name) ||
                  vercelSetup.busy(name) ||
                  environmentGuide.busy(name)
                )
                  throw new RequestError(
                    409,
                    "Wait for the environment test before analyzing this project.",
                  );
                await projectOnboarding.discover(name, {
                  revision: input.revision as string | undefined,
                });
              } else if (action === "setup-pr") {
                if (typeof input.revision !== "string")
                  throw new RequestError(
                    400,
                    "Review the latest setup files before publishing their draft.",
                  );
                if (
                  environmentAccess.busy(name) ||
                  vercelSetup.busy(name) ||
                  environmentGuide.busy(name)
                )
                  throw new RequestError(
                    409,
                    "Wait for the environment test before publishing setup files.",
                  );
                await projectOnboarding.prepareSetupPr(name, {
                  revision: input.revision,
                });
              } else if (action === "cancel") {
                await projectOnboarding.cancel(name, {
                  revision:
                    typeof input.revision === "string"
                      ? input.revision
                      : (await projectOnboarding.status(name)).revision,
                });
              } else {
                if (
                  projectOnboarding.busy(name) ||
                  vercelSetup.busy(name) ||
                  environmentGuide.busy(name)
                )
                  throw new RequestError(
                    409,
                    "Wait for repository setup before testing this environment.",
                  );
                await environmentAccess.verify(name);
              }
              json(res, 202, await onboardingState(name));
            }
          }
          return;
        }
        if (url.pathname === "/api/idea-plans") {
          if (req.method !== "POST")
            throw new RequestError(
              405,
              "Use POST to plan a crew from an idea.",
            );
          const input = await body(req, 64 * 1024);
          if (Object.keys(input).length !== 1 || typeof input.idea !== "string")
            throw new RequestError(400, "Provide the app idea only.");
          const controller = new AbortController();
          const abort = () => {
            if (!res.writableEnded) controller.abort();
          };
          req.once("aborted", abort);
          res.once("close", abort);
          try {
            json(res, 200, await ideaCrew.plan(input.idea, controller.signal));
          } catch (error) {
            throw new RequestError(
              error instanceof IdeaCrewError ? error.status : 500,
              error instanceof IdeaCrewError
                ? error.message
                : "Crew planning could not finish.",
            );
          } finally {
            req.removeListener("aborted", abort);
            res.removeListener("close", abort);
          }
          return;
        }
        const ideaRoute = /^\/api\/idea-plans\/([a-f0-9-]+)(\/create)?$/.exec(
          url.pathname,
        );
        if (ideaRoute) {
          try {
            if (!ideaRoute[2]) {
              if (req.method !== "GET")
                throw new RequestError(
                  405,
                  "Use GET to recover a saved crew plan.",
                );
              json(res, 200, ideaCrew.get(ideaRoute[1]!));
            } else {
              if (req.method !== "POST")
                throw new RequestError(
                  405,
                  "Use POST to create the reviewed crew.",
                );
              const input = await body(req);
              const {
                linearMode = "later",
                linearTeamId,
                ...destination
              } = input;
              if (
                !["create", "reuse", "later"].includes(String(linearMode)) ||
                (linearTeamId !== undefined &&
                  (typeof linearTeamId !== "string" ||
                    !/^[a-f0-9-]{36}$/i.test(linearTeamId))) ||
                (linearMode === "reuse" && !linearTeamId)
              )
                throw new RequestError(
                  400,
                  "Choose how to set up the app's Linear team.",
                );
              if (
                typeof destination.project !== "string" ||
                !/^[a-z][a-z0-9-]{0,62}$/.test(destination.project)
              )
                throw new RequestError(400, "Choose a lowercase project ID.");
              const created = await withConfigurationMutation(
                { project: destination.project },
                () => ideaCrew.create(ideaRoute[1]!, destination),
              );
              activeMutationRequests++;
              countedMutation = true;
              const linear =
                linearMode === "later"
                  ? {
                      status: "skipped",
                      message: "Connect Linear when ready for ticketed work.",
                    }
                  : await provisionLinear(
                      created.project,
                      typeof linearTeamId === "string"
                        ? linearTeamId
                        : undefined,
                    );
              json(res, 200, { ...created, linear });
            }
          } catch (error) {
            if (error instanceof RequestError) throw error;
            throw new RequestError(
              error instanceof IdeaCrewError ? error.status : 500,
              error instanceof IdeaCrewError
                ? error.message
                : "Crew creation could not finish. Retry the saved plan to resume.",
            );
          }
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
                  "linear",
                  "workflow",
                  "verification",
                  "environments",
                  "commands",
                  "branches",
                  "telemetry",
                  "onboarding",
                ].includes(key),
            ) ||
            typeof input.project !== "string" ||
            typeof input.repo !== "string" ||
            (input.onboarding !== undefined &&
              typeof input.onboarding !== "boolean") ||
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
          if (input.linear !== undefined) {
            const value = input.linear;
            if (
              !value ||
              typeof value !== "object" ||
              Array.isArray(value) ||
              Object.keys(value).some((key) => key !== "connectionId") ||
              !validConnectionId(
                (value as Record<string, unknown>).connectionId,
              )
            )
              throw new RequestError(
                400,
                "Initial Linear settings accept a saved connectionId. Choose a team using the Linear setup controls.",
              );
            try {
              await requireProfile(
                "linear",
                (value as { connectionId: string }).connectionId,
              );
            } catch {
              throw new RequestError(
                400,
                "Choose an existing saved Linear account before adding this project.",
              );
            }
          }
          if (
            input.environments &&
            typeof input.environments === "object" &&
            !Array.isArray(input.environments)
          )
            for (const target of Object.values(input.environments)) {
              if (
                target &&
                typeof target === "object" &&
                target.kind === "vercel" &&
                target.connectionId !== undefined
              ) {
                try {
                  await requireProfile("vercel", target.connectionId);
                } catch {
                  throw new RequestError(
                    400,
                    "Choose an existing saved Vercel account before adding this project.",
                  );
                }
              }
            }
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
          const existed = listProjectNames(root).includes(input.project);
          const output: string[] = [];
          const code = await withConfigurationMutation(
            { project: input.project },
            () =>
              runSetup(
                root,
                args,
                { log: (line) => output.push(line), error: () => {} },
                {
                  env: {},
                  templatesRoot: packageRoot,
                  ...(input.onboarding === true
                    ? { createInitialPm: false }
                    : {}),
                  projectSettings: Object.fromEntries(
                    [
                      "workflow",
                      "verification",
                      "environments",
                      "commands",
                      "branches",
                      "telemetry",
                      "linear",
                    ]
                      .filter((key) => input[key] !== undefined)
                      .map((key) => [key, input[key]]),
                  ),
                },
              ),
          );
          // The creation transaction excluded its own request from the global
          // mutation count. Keep later provider provisioning guarded as usual.
          activeMutationRequests++;
          countedMutation = true;
          if (code !== 0)
            throw new RequestError(
              400,
              "Project setup could not finish. Check the project ID, source repository, and existing configuration with gremlins setup init --help.",
            );
          const linear =
            input.linearMode === "later" || input.onboarding === true
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
          let onboarding;
          if (input.onboarding === true && !existed) {
            try {
              onboarding = await projectOnboarding.discover(input.project);
            } catch {
              onboarding = await projectOnboarding.status(input.project);
            }
          }
          json(res, 200, {
            ok: true,
            result: JSON.parse(output.join("\n")),
            linear,
            ...(onboarding ? { onboarding } : {}),
          });
          return;
        }
        const pmDocument =
          /^\/api\/projects\/([a-z][a-z0-9-]{0,62})\/pms\/([a-z][a-z0-9-]{0,62})\/(brief|knowledge)$/.exec(
            url.pathname,
          );
        if (pmDocument) {
          const [, project, area, document] = pmDocument;
          try {
            if (document === "knowledge") {
              if (req.method !== "GET")
                throw new RequestError(405, "Use GET for PM knowledge.");
              json(
                res,
                200,
                knowledge.read(project!, area!, await runners().jobs()),
              );
            } else if (req.method === "GET") {
              json(res, 200, readPmBrief(root, project!, area!));
            } else if (req.method === "POST") {
              const input = await body(req, 128 * 1024);
              if (
                Object.keys(input).some(
                  (key) => !["revision", "brief"].includes(key),
                )
              )
                throw new RequestError(
                  400,
                  "Provide the current revision and PM brief.",
                );
              json(
                res,
                200,
                savePmBrief(
                  root,
                  project!,
                  area!,
                  input as Parameters<typeof savePmBrief>[3],
                ),
              );
            } else
              throw new RequestError(405, "Use GET or POST for the PM brief.");
          } catch (error) {
            if (error instanceof RequestError) throw error;
            if (
              error instanceof PmBriefError ||
              error instanceof ConfigEditorError
            )
              throw new RequestError(error.status, error.message);
            throw new RequestError(
              400,
              "PM details could not be loaded or saved. Check the project and PM configuration; existing knowledge was preserved.",
            );
          }
          return;
        }
        const pmReadiness =
          /^\/api\/projects\/([a-z][a-z0-9-]{0,62})\/readiness$/.exec(
            url.pathname,
          );
        if (pmReadiness) {
          if (req.method !== "GET")
            throw new RequestError(405, "Use GET for project readiness.");
          json(res, 200, {
            project: pmReadiness[1],
            ...projectReadiness(pmReadiness[1]!, await readinessContext()),
          });
          return;
        }
        const pmStatus =
          /^\/api\/projects\/([a-z][a-z0-9-]{0,62})\/areas\/([a-z][a-z0-9-]{0,62})\/status$/.exec(
            url.pathname,
          );
        if (pmStatus) {
          if (req.method !== "POST")
            throw new RequestError(
              405,
              "Use POST to enable or pause PM automation.",
            );
          const input = await body(req);
          if (
            Object.keys(input).some(
              (key) =>
                !["enabled", "revision", "projectRevision"].includes(key),
            )
          )
            throw new RequestError(
              400,
              "Provide enabled and the current project/PM revisions.",
            );
          try {
            json(
              res,
              200,
              await setPmAutomation(
                root,
                pmStatus[1]!,
                pmStatus[2]!,
                input as {
                  enabled: boolean;
                  revision: string;
                  projectRevision: string;
                },
                {
                  context: readinessContext,
                  validate: async () => {
                    await preparation.validate({
                      type: "pm",
                      project: pmStatus[1],
                      area: pmStatus[2],
                      runOnce: true,
                    });
                  },
                },
              ),
            );
          } catch (error) {
            if (
              error instanceof PmControlError ||
              error instanceof ConfigEditorError
            )
              throw new RequestError(error.status, error.message);
            if (error instanceof JobReadinessError)
              throw new RequestError(409, error.message);
            throw new RequestError(
              400,
              "PM automation could not be changed. Refresh its readiness and check the selected connections.",
            );
          }
          return;
        }
        const pmPlan =
          /^\/api\/projects\/([a-z][a-z0-9-]{0,62})\/pm-plan$/.exec(
            url.pathname,
          );
        if (pmPlan) {
          if (req.method !== "POST")
            throw new RequestError(
              405,
              "Use POST to draft a PM from its mandate.",
            );
          const input = await body(req, 64 * 1024);
          if (
            Object.keys(input).length !== 1 ||
            typeof input.mandate !== "string"
          )
            throw new RequestError(
              400,
              "Provide the PM mandate to generate a draft.",
            );
          const controller = new AbortController();
          const abort = () => {
            if (!res.writableEnded) controller.abort();
          };
          req.once("aborted", abort);
          res.once("close", abort);
          try {
            json(
              res,
              200,
              await pmPlanner.plan({
                project: pmPlan[1]!,
                mandate: input.mandate,
                signal: controller.signal,
              }),
            );
          } catch (error) {
            throw new RequestError(
              error instanceof PmPlannerError ? error.status : 500,
              error instanceof PmPlannerError
                ? error.message
                : "The PM draft could not be generated. Your mandate and existing PMs were preserved.",
            );
          } finally {
            req.removeListener("aborted", abort);
            res.removeListener("close", abort);
          }
          return;
        }
        const mappingRepair =
          /^\/api\/projects\/([a-z][a-z0-9-]{0,62})\/linear\/mappings$/.exec(
            url.pathname,
          );
        if (mappingRepair) {
          if (req.method !== "POST")
            throw new RequestError(405, "Use POST to repair Linear mappings.");
          const input = await body(req);
          try {
            json(
              res,
              200,
              await linearProvisioning.repairMappings(
                mappingRepair[1]!,
                input as unknown as LinearMappingRepair,
              ),
            );
          } catch (error) {
            throw new RequestError(
              error instanceof LinearProvisioningError ? error.status : 500,
              error instanceof LinearProvisioningError
                ? error.message
                : "Linear mappings could not be saved. Existing local state was preserved.",
            );
          }
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
          const input = await body(
            req,
            projectMapping[2] === "areas" ? 128 * 1024 : MAX_BODY,
          );
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
              if (
                typeof input.key !== "string" ||
                !/^[a-z][a-z0-9-]{0,62}$/.test(input.key)
              )
                throw new RequestError(
                  400,
                  "Choose a lowercase PM ID using letters, numbers, and hyphens.",
                );
              await runners().withConfigurationMutation(
                { project, area: input.key },
                () => linearProvisioning.addArea(project, input),
              );
            } catch (error) {
              if (error instanceof RequestError) throw error;
              if (
                error instanceof LinearProvisioningError ||
                error instanceof LocalRunnerError
              )
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
            linearConnectionFor,
            vercelConnectionFor,
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
          join(
            directory,
            HTML_ROUTES.has(pathname) ||
              /^\/projects\/[a-z][a-z0-9-]{0,62}$/.test(pathname)
              ? "index.html"
              : pathname.slice(1),
          ),
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
        error instanceof RequestError ||
        error instanceof LocalRunnerError ||
        error instanceof ProjectKnowledgeError ||
        error instanceof ResourceDeletionError ||
        error instanceof ProjectOnboardingError ||
        error instanceof VercelSetupError ||
        error instanceof OAuthConnectionError ||
        error instanceof EnvironmentAccessError ||
        error instanceof ConfigEditorError ||
        error instanceof RemoteWorkerError
          ? error.status
          : error instanceof ConnectionSaveError
            ? 400
            : 500;
      const message =
        error instanceof RequestError ||
        error instanceof LocalRunnerError ||
        error instanceof ProjectKnowledgeError ||
        error instanceof ResourceDeletionError ||
        error instanceof ProjectOnboardingError ||
        error instanceof VercelSetupError ||
        error instanceof OAuthConnectionError ||
        error instanceof EnvironmentAccessError ||
        error instanceof ConfigEditorError ||
        error instanceof ConnectionSaveError ||
        error instanceof RemoteWorkerError
          ? error.message
          : "Dashboard request failed. Check your local configuration files and permissions.";
      if (!res.headersSent) json(res, status, { error: message });
      else res.end();
    } finally {
      finishProjectRequest?.();
      if (countedMutation) activeMutationRequests--;
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.once("listening", () => {
    void syncRemoteWorkers();
    for (const name of listProjectNames(root)) continuePromotions(name);
    if (
      options.runners ||
      existsSync(join(root, ".run", "local-runners", "state.json"))
    )
      runners().start();
  });
  const deliveryTimer = setInterval(() => void reconcileDeliveries(), 60_000);
  deliveryTimer.unref();
  server.once("close", () => {
    clearInterval(deliveryTimer);
    void Promise.allSettled([
      projectOnboarding.close(),
      environmentAccess.close(),
      vercelSetup.close(),
      environmentGuide.close(),
      Promise.resolve(manager?.stop()),
    ]).finally(() => activityStore.close());
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
    publicUrl: process.env.SHIPGREMLINS_DASHBOARD_URL,
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
      if (process.env.SHIPGREMLINS_DASHBOARD_URL)
        io.log(
          `HTTPS proxy dashboard: ${new URL(process.env.SHIPGREMLINS_DASHBOARD_URL).origin}/#session=${session}`,
        );
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
