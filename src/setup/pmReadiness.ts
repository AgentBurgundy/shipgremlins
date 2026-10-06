import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CronExpressionParser } from "cron-parser";
import {
  loadProject,
  codingPickupEnabled,
  type AreaConfig,
  type Project,
} from "../config.ts";
import { effectiveVerification } from "../projectCapabilities.ts";
import type { LocalWorker } from "../localRunners/types.ts";
import type { SourceStatus } from "../sourceControl/types.ts";
import type { OAuthStatus } from "../oauthConnection/types.ts";
import { assertNoSymlinks, validateName } from "./files.ts";
import { readEditableConfig, saveEditableConfig } from "./configEditor.ts";

export type ReadinessAction =
  | "source"
  | "ai"
  | "linear"
  | "mapping"
  | "verify"
  | "worker"
  | "mandate"
  | "config";
export interface ReadinessBlocker {
  id: string;
  message: string;
  action: ReadinessAction;
}
export interface ReadinessStep extends ReadinessBlocker {
  label: string;
  ready: boolean;
}
export interface ReadinessContext {
  env: NodeJS.ProcessEnv;
  sourceConnections: SourceStatus[];
  serviceConnections: Array<OAuthStatus & { id?: string }>;
  workers: LocalWorker[];
  /** The execution adapter's current project scope and connection policy. */
  canRunWorker?: (remoteId: string | undefined, project: string) => boolean;
  localMode: boolean;
}
export class PmControlError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly blockers: ReadinessBlocker[] = [],
  ) {
    super(message);
    this.name = "PmControlError";
  }
}
export function hasPmMapping(area: AreaConfig): boolean {
  return (
    Boolean(area.linearProjectId.trim()) &&
    !/^(?:PASTE_|CHANGE_|<)/i.test(area.linearProjectId)
  );
}
/** Read only the configured mandate, never arbitrary paths or credential files. */
export function hasPmMandate(project: Project, area: AreaConfig): boolean {
  if (area.mandate !== undefined) return Boolean(area.mandate.trim());
  try {
    validateName(area.key, "area");
    const file = join(project.dir, area.key, "mandate.md");
    assertNoSymlinks(file);
    const stat = lstatSync(file);
    return (
      stat.isFile() &&
      stat.nlink === 1 &&
      stat.size <= 64 * 1024 &&
      Boolean(readFileSync(file, "utf8").trim())
    );
  } catch {
    return false;
  }
}
function validSchedule(schedule: string) {
  try {
    if (schedule.trim().split(/\s+/).length !== 5) return false;
    CronExpressionParser.parse(schedule, { tz: "UTC" });
    return true;
  } catch {
    return false;
  }
}
export function inspectPmReadiness(
  project: Project,
  context: ReadinessContext,
) {
  const config = project.config;
  const provider = config.provider ?? "github";
  const server =
    config.serverUrl ??
    (provider === "gitlab" ? "https://gitlab.com" : "https://github.com");
  const source = context.sourceConnections.find(
    (item) =>
      item.provider === provider &&
      item.serverUrl.replace(/\/$/, "") === server.replace(/\/$/, "") &&
      item.method === "oauth",
  );
  const sourceReady = source
    ? source.connected && !source.needsReconnect
    : Boolean(
        context.env[
          provider === "gitlab" ? "GITLAB_TOKEN" : "GITHUB_TOKEN"
        ]?.trim(),
      );
  const serviceReady = (
    provider: "linear" | "vercel",
    id = "default",
    workspaceId?: string,
  ) => {
    const selected = context.serviceConnections.find(
      (item) => item.provider === provider && (item.id ?? "default") === id,
    );
    if (selected?.method === "oauth")
      return (
        selected.connected &&
        !selected.needsReconnect &&
        (!workspaceId ||
          !selected.workspace?.id ||
          selected.workspace.id === workspaceId)
      );
    if (id !== "default") return false;
    return (
      Boolean(
        context.env[
          provider === "linear" ? "LINEAR_API_KEY" : "VERCEL_TOKEN"
        ]?.trim(),
      ) || Boolean(selected?.connected && !selected.needsReconnect)
    );
  };
  const steps: ReadinessStep[] = [];
  const add = (
    id: string,
    label: string,
    ready: boolean,
    action: ReadinessAction,
    missing: string,
    complete: string,
  ) =>
    steps.push({
      id,
      label,
      ready,
      action,
      message: ready ? complete : missing,
    });
  add(
    "configuration",
    "Project settings",
    context.localMode,
    "config",
    "Select local Docker workers in workspace settings before running this crew.",
    "Project uses local Docker workers.",
  );
  add(
    "source_connection",
    "Source control",
    sourceReady,
    "source",
    "Connect the source account that can access this repository, then verify the project.",
    "Source credentials are saved; project verification checks repository access.",
  );
  add(
    "ai_connection",
    "AI connection",
    Boolean(context.env.CLAUDE_CODE_OAUTH_TOKEN?.trim()),
    "ai",
    "Save a Claude Code connection in Connections before running a gremlin.",
    "Claude Code connection is saved.",
  );
  add(
    "linear_connection",
    "Linear account",
    serviceReady(
      "linear",
      config.linear?.connectionId,
      config.linear?.workspaceId,
    ),
    "linear",
    "Connect this project's selected Linear account or restore its workspace access.",
    "The selected Linear account is connected.",
  );
  const verification = effectiveVerification(config);
  if (verification.mode === "browser") {
    const target = verification.target;
    let ready = true;
    if (target.kind === "vercel")
      ready =
        serviceReady("vercel", target.connectionId) &&
        (!target.bypassSecret ||
          Boolean(context.env[target.bypassSecret]?.trim()));
    if (target.kind === "railway")
      ready = Boolean(
        context.env[target.tokenSecret ?? "RAILWAY_TOKEN"]?.trim(),
      );
    if (target.kind === "cloud-run" && target.credentialsSecret)
      ready = Boolean(context.env[target.credentialsSecret]?.trim());
    if (config.signIn)
      ready &&= Boolean(context.env[config.signIn.databaseUrlSecret]?.trim());
    add(
      "browser_connections",
      "Browser environment",
      ready,
      "config",
      "Save the selected browser environment's credentials and test sign-in settings, then verify connections.",
      "Selected browser environment credentials are configured.",
    );
  }
  const workerReady = context.workers.some((worker) => {
    if (
      !worker.verifiedAt ||
      worker.paused ||
      !["ready", "busy"].includes(worker.status)
    )
      return false;
    try {
      // A busy eligible worker can queue more work. A remote verification stamp
      // alone says nothing about its current heartbeat or this project's scope.
      return (
        context.canRunWorker?.(worker.remoteId, config.name) ?? !worker.remoteId
      );
    } catch {
      return false;
    }
  });
  add(
    "verification",
    "Verify connections",
    Boolean(config.verified),
    "verify",
    "Run Verify connections for this project before enabling automation or starting a job.",
    "Project passed its last connection verification.",
  );
  add(
    "worker",
    "Verified worker",
    workerReady,
    "worker",
    "Create or resume a Docker worker and wait for its browser check to pass. Remote workers must be online and enrolled for this project. Busy eligible workers can queue another job.",
    "A verified worker is available for this project; a busy worker queues jobs.",
  );
  const common = steps
    .filter((step) => !step.ready)
    .map(({ id, message, action }) => ({ id, message, action }));
  const areas = project.areas.map((area) => {
    const blockers = [...common];
    if (!hasPmMapping(area))
      blockers.push({
        id: "linear_mapping",
        action: "mapping",
        message:
          "Map this PM to a Linear project in Edit project → Linear mappings.",
      });
    if (!hasPmMandate(project, area))
      blockers.push({
        id: "mandate",
        action: "mandate",
        message:
          "Open this PM's Product brief, write and save its mandate, then review it before running.",
      });
    blockers.sort(
      (a, b) =>
        Number(["verification", "worker"].includes(a.id)) -
        Number(["verification", "worker"].includes(b.id)),
    );
    const scheduleReady = validSchedule(area.schedule);
    const enableBlockers = blockers.filter((item) => item.id !== "worker");
    if (!scheduleReady)
      enableBlockers.push({
        id: "schedule",
        action: "config",
        message:
          "Set a valid five-field UTC schedule for this PM before enabling automation.",
      });
    return {
      key: area.key,
      enabled: area.enabled,
      codingEnabled: codingPickupEnabled(area),
      configured: blockers.every((item) =>
        ["verification", "worker"].includes(item.id),
      ),
      canRun: blockers.length === 0,
      canEnable: enableBlockers.length === 0,
      blockers,
      enableBlockers,
      coding: {
        canEnable: blockers.filter((item) => item.id !== "worker").length === 0,
        enableBlockers: blockers.filter((item) => item.id !== "worker"),
      },
    };
  });
  add(
    "linear_mapping",
    "PM project mapping",
    project.areas.some(hasPmMapping),
    "mapping",
    "Choose a Linear project for at least one PM in Edit project → Linear mappings.",
    "At least one PM has a Linear project mapping.",
  );
  add(
    "mandate",
    "PM mandate",
    project.areas.some((area) => hasPmMandate(project, area)),
    "mandate",
    "Create a PM and review its mandate before the first run.",
    "At least one PM has a mandate to follow.",
  );
  steps.sort(
    (a, b) =>
      Number(["verification", "worker"].includes(a.id)) -
      Number(["verification", "worker"].includes(b.id)),
  );
  return {
    configured: steps
      .filter((step) => !["verification", "worker"].includes(step.id))
      .every((step) => step.ready),
    verified: Boolean(config.verified),
    workerReady,
    canRun: areas.some((area) => area.canRun),
    canEnable: areas.some((area) => area.canEnable),
    steps,
    blockers: steps
      .filter((step) => !step.ready)
      .map(({ id, message, action }) => ({ id, message, action })),
    areas,
  };
}
export async function setPmAutomation(
  root: string,
  projectName: string,
  areaKey: string,
  input: {
    enabled: boolean;
    codingEnabled?: boolean;
    revision: string;
    projectRevision: string;
  },
  options: {
    context: () => Promise<ReadinessContext>;
    validate?: () => Promise<void>;
  },
) {
  validateName(projectName, "project");
  validateName(areaKey, "area");
  if (
    !input ||
    typeof input.enabled !== "boolean" ||
    (input.codingEnabled !== undefined &&
      typeof input.codingEnabled !== "boolean") ||
    typeof input.revision !== "string" ||
    !/^[a-f0-9]{64}$/.test(input.revision) ||
    typeof input.projectRevision !== "string" ||
    !/^[a-f0-9]{64}$/.test(input.projectRevision)
  )
    throw new PmControlError(
      "Provide the current project and PM revisions and an enabled boolean.",
    );
  const projectDocument = readEditableConfig(
      root,
      `projects/${projectName}/project.json`,
    ),
    areasDocument = readEditableConfig(
      root,
      `projects/${projectName}/areas.json`,
    );
  const conflict = () =>
    new PmControlError(
      "Project or PM settings changed. Refresh the PM list and review the current settings before trying again.",
      409,
    );
  if (
    projectDocument.revision !== input.projectRevision ||
    areasDocument.revision !== input.revision
  )
    throw conflict();
  const project = loadProject(root, projectName),
    area = project.areas.find((item) => item.key === areaKey);
  if (!area)
    throw new PmControlError(
      "Choose an existing PM before changing its automation.",
      404,
    );
  const codingEnabled = input.codingEnabled ?? codingPickupEnabled(area);
  const enablingPm = input.enabled && !area.enabled;
  const enablingCoding = codingEnabled && !codingPickupEnabled(area);
  const context = await options.context().catch((error) => {
    if (enablingPm || enablingCoding) throw error;
    // Pausing must remain possible when a saved connection or worker needs repair.
    return {
      env: {},
      sourceConnections: [],
      serviceConnections: [],
      workers: [],
      localMode: true,
    } satisfies ReadinessContext;
  });
  if (enablingPm || enablingCoding) {
    const readiness = inspectPmReadiness(project, context).areas.find(
      (item) => item.key === areaKey,
    )!;
    const blockers = enablingPm
      ? readiness.enableBlockers
      : readiness.coding.enableBlockers;
    if (blockers.length)
      throw new PmControlError(
        blockers.map((item) => item.message).join(" "),
        409,
        blockers,
      );
    await options.validate?.();
  }
  if (
    readEditableConfig(root, projectDocument.path).revision !==
      projectDocument.revision ||
    readEditableConfig(root, areasDocument.path).revision !==
      areasDocument.revision
  )
    throw conflict();
  const value = JSON.parse(areasDocument.content);
  value.areas[areaKey].enabled = input.enabled;
  value.areas[areaKey].codingEnabled = codingEnabled;
  const saved =
    area.enabled === input.enabled && area.codingEnabled === codingEnabled
      ? { revision: areasDocument.revision }
      : saveEditableConfig(root, {
          path: areasDocument.path,
          revision: areasDocument.revision,
          content: JSON.stringify(value, null, 2) + "\n",
        });
  return {
    ok: true,
    enabled: input.enabled,
    codingEnabled,
    revision: saved.revision,
    areasRevision: saved.revision,
    projectRevision: projectDocument.revision,
    area: { key: areaKey, enabled: input.enabled, codingEnabled },
    readiness: inspectPmReadiness(loadProject(root, projectName), context),
  };
}
