import { randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  openSync,
  closeSync,
  fsyncSync,
  mkdtempSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { join, dirname, resolve, parse, basename } from "node:path";
import { tmpdir } from "node:os";
import { CronExpressionParser } from "cron-parser";
import { loadProject, isPmVerificationRequirement } from "../config.ts";
import { projectRuntimeKey } from "../projectIdentity.ts";
import { validConnectionId } from "../projectCapabilities.ts";
import { ID_RE } from "../telemetry/config.ts";
import {
  readEditableConfig,
  saveEditableConfig,
  MAX_CONFIG_BYTES,
} from "./configEditor.ts";
import { validateName } from "./files.ts";
import {
  assertResourceAvailable,
  preparePmRecreation,
  completePmRecreation,
} from "./resourceDeletion.ts";
import { buildLinearProjectContent } from "./linearProjectContent.ts";
import { LABELS } from "../dispatcher/notes.ts";
import { parsePmCharter, type PmCharter } from "../pmCharter.ts";
import {
  LinearApiError,
  type LinearApi,
  type LinearTeam,
  type LinearProjectResource,
} from "../services/linear.ts";

export type LinearProvisioningClient = Pick<
  LinearApi,
  | "organization"
  | "getTeam"
  | "getProject"
  | "createTeam"
  | "createProject"
  | "updateProject"
  | "resources"
> &
  Partial<Pick<LinearApi, "ensureLabels">>;
export interface LinearMappingStatus {
  status: "ready" | "needs-connection" | "error" | "skipped";
  message?: string;
  teamId?: string;
  teamName?: string;
  connectionId?: string;
  workspaceId?: string;
}
export class LinearProvisioningError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "LinearProvisioningError";
  }
}
interface Intent {
  schema: 1;
  workspaceId: string;
  connectionId?: string;
  team: {
    id: string;
    name: string;
    key: string;
    created: boolean;
    reuse: boolean;
    /** Missing on old journals: an unconfirmed creation must then be treated as ambiguous. */
    creation?: "not-started" | "pending" | "rejected";
  };
  areas: Record<
    string,
    {
      id: string;
      created: boolean;
      instanceId?: string;
      /** Present only when this controller reserved the ID for creation. */
      managedBrief?: { version: 1; applied: boolean };
    }
  >;
  error?: boolean;
}
export interface LinearMappingRepair {
  projectRevision: string;
  areasRevision: string;
  teamId: string;
  areaProjects: Record<string, string | null>;
  connectionId?: string;
}
type RepairFile = {
  name: "project" | "areas" | "journal";
  before: string | null;
  after: string;
};
interface RepairTransaction {
  schema: 1;
  id: string;
  phase: "pending" | "committed";
  files: RepairFile[];
}
const UUID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const missingId = (value: string) => value === "PASTE_LINEAR_PROJECT_ID";
const rejectedIcon = (error: unknown) =>
  error instanceof LinearApiError &&
  error.category === "validation" &&
  error.fields.length === 1 &&
  error.fields[0] === "icon";
const refusedTeamCreation = (error: unknown) =>
  error instanceof LinearApiError &&
  ["auth", "permission", "rate-limit", "limit", "validation"].includes(
    error.category,
  );
function provisioningFailure(error: unknown, step: string) {
  let guidance = "Retry to resume this step.";
  let status = 502;
  if (error instanceof LinearApiError) {
    switch (error.category) {
      case "auth":
        guidance =
          "Linear sign-in expired or was revoked. Reconnect this account, then retry.";
        status = 401;
        break;
      case "permission":
        guidance =
          step === "preparing issue labels"
            ? "Allow the selected connection to read and create issue labels in this team, then retry."
            : "Linear denied this operation. Check this account's access to the selected team and its permission to create projects, then retry.";
        status = 403;
        break;
      case "rate-limit":
        guidance = "Linear is limiting API requests. Wait briefly, then retry.";
        status = 429;
        break;
      case "limit":
        guidance =
          "Linear reported a workspace resource limit. Free capacity or reuse an existing team or project, then retry.";
        break;
      case "validation":
        guidance = `Linear rejected the setup details${error.fields.length ? ` (${error.fields.join(", ")})` : ""}. Correct those fields and retry.`;
        break;
      case "unavailable":
        guidance = "Linear is temporarily unavailable. Retry shortly.";
        break;
    }
  }
  return new LinearProvisioningError(
    `Linear setup stopped while ${step}. ${guidance} Saved resource IDs prevent duplicate creation.`,
    status,
  );
}
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
function safe(path: string) {
  let cursor = resolve(path);
  for (;;) {
    try {
      const stat = lstatSync(cursor);
      if (
        stat.isSymbolicLink() ||
        (cursor === resolve(path) && stat.isFile() && stat.nlink !== 1)
      )
        throw new Error();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT")
        throw new LinearProvisioningError(
          "Linear mapping paths must be regular files without links.",
        );
    }
    if (cursor === parse(cursor).root) break;
    cursor = dirname(cursor);
  }
  return path;
}
function atomic(file: string, value: unknown) {
  atomicText(file, JSON.stringify(value, null, 2) + "\n");
}
function atomicText(file: string, content: string) {
  safe(file);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const fd = openSync(temporary, "wx", 0o600);
    try {
      writeFileSync(fd, content);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    safe(file);
    renameSync(temporary, file);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

export function createLinearProvisioning(options: {
  root: string;
  /** Project-aware credential selection; omitted for the default resource picker. */
  client: (
    project?: string,
    connectionId?: string,
  ) => Promise<LinearProvisioningClient>;
  /** Local file adapter for deterministic transaction-failure tests. */
  mappingWrite?: (file: string, content: string) => void;
}) {
  const { root } = options;
  const directory = join(root, ".run", "linear", "provisioning");
  function runtimeKey(project: string) {
    validateName(project, "project");
    // Mapping repair must also work when old Linear IDs fail typed validation.
    // Only the immutable, controller-issued identity selects its journal.
    const raw = JSON.parse(
      readEditableConfig(root, `projects/${project}/project.json`).content,
    );
    if (
      raw.instanceId !== undefined &&
      (typeof raw.instanceId !== "string" || !UUID.test(raw.instanceId))
    )
      throw new LinearProvisioningError(
        "Project identity is invalid. Preserve its configuration and restore the original identity before repairing mappings.",
        409,
      );
    return projectRuntimeKey({ name: project, instanceId: raw.instanceId });
  }
  function statePath(project: string) {
    validateName(project, "project");
    return safe(join(directory, `${runtimeKey(project)}.json`));
  }
  const repairPath = (project: string) => {
    validateName(project, "project");
    return safe(join(directory, `${runtimeKey(project)}.repair.json`));
  };
  const repairFilePath = (project: string, name: RepairFile["name"]) =>
    name === "journal"
      ? statePath(project)
      : safe(
          join(
            root,
            "projects",
            project,
            `${name === "project" ? "project" : "areas"}.json`,
          ),
        );
  function contents(file: string): string | null {
    safe(file);
    return existsSync(file) ? readFileSync(file, "utf8") : null;
  }
  function finishRepair(project: string, transaction: RepairTransaction) {
    const destination = safe(
      join(directory, `${project}.repair-${transaction.id}.json`),
    );
    if (existsSync(destination))
      throw new LinearProvisioningError(
        "The mapping recovery archive already exists. Preserve both journals and resolve the duplicate before retrying.",
        409,
      );
    renameSync(repairPath(project), destination);
  }
  function recoverRepair(project: string) {
    const path = repairPath(project);
    if (!existsSync(path)) return;
    let transaction: RepairTransaction;
    try {
      if (lstatSync(path).size > 600 * 1024) throw new Error();
      const value = JSON.parse(readFileSync(path, "utf8"));
      if (
        !object(value) ||
        value.schema !== 1 ||
        typeof value.id !== "string" ||
        !UUID.test(value.id) ||
        !["pending", "committed"].includes(String(value.phase)) ||
        !Array.isArray(value.files) ||
        value.files.length !== 3
      )
        throw new Error();
      const names = new Set<string>();
      for (const entry of value.files) {
        if (
          !object(entry) ||
          !["project", "areas", "journal"].includes(String(entry.name)) ||
          names.has(String(entry.name)) ||
          typeof entry.after !== "string" ||
          Buffer.byteLength(entry.after) > 128 * 1024 ||
          (typeof entry.before !== "string" &&
            !(entry.before === null && entry.name === "journal")) ||
          (typeof entry.before === "string" &&
            Buffer.byteLength(entry.before) > 128 * 1024)
        )
          throw new Error();
        names.add(String(entry.name));
      }
      transaction = value as unknown as RepairTransaction;
      if (transaction.phase === "pending") {
        for (const entry of transaction.files) {
          const current = contents(repairFilePath(project, entry.name));
          if (current !== entry.before && current !== entry.after)
            throw new Error();
        }
        // Restore project.json last so its old verification cannot authorize partial mappings.
        for (const entry of [...transaction.files].reverse()) {
          const target = repairFilePath(project, entry.name);
          if (contents(target) === entry.before) continue;
          if (entry.before === null) unlinkSync(target);
          else atomicText(target, entry.before);
        }
      }
      finishRepair(project, transaction);
    } catch {
      throw new LinearProvisioningError(
        "A previous mapping repair needs recovery. Its original files are preserved in the local repair journal; resolve concurrent file edits before retrying.",
        409,
      );
    }
  }
  function read(project: string): Intent | null {
    const file = statePath(project);
    if (!existsSync(file)) return null;
    try {
      if (lstatSync(file).size > 128 * 1024) throw new Error();
      const raw: unknown = JSON.parse(readFileSync(file, "utf8"));
      if (
        !object(raw) ||
        raw.schema !== 1 ||
        typeof raw.workspaceId !== "string" ||
        !UUID.test(raw.workspaceId) ||
        (raw.connectionId !== undefined &&
          !validConnectionId(raw.connectionId)) ||
        !object(raw.team) ||
        typeof raw.team.id !== "string" ||
        !UUID.test(raw.team.id) ||
        typeof raw.team.name !== "string" ||
        typeof raw.team.key !== "string" ||
        typeof raw.team.created !== "boolean" ||
        typeof raw.team.reuse !== "boolean" ||
        (raw.team.creation !== undefined &&
          !["not-started", "pending", "rejected"].includes(
            String(raw.team.creation),
          )) ||
        !object(raw.areas)
      )
        throw new Error();
      for (const [key, value] of Object.entries(raw.areas)) {
        validateName(key, "area");
        if (
          !object(value) ||
          typeof value.id !== "string" ||
          !UUID.test(value.id) ||
          typeof value.created !== "boolean"
        )
          throw new Error();
        if (
          value.instanceId !== undefined &&
          (typeof value.instanceId !== "string" || !UUID.test(value.instanceId))
        )
          throw new Error();
        if (
          value.managedBrief !== undefined &&
          (!object(value.managedBrief) ||
            value.managedBrief.version !== 1 ||
            typeof value.managedBrief.applied !== "boolean")
        )
          throw new Error();
      }
      return raw as unknown as Intent;
    } catch {
      throw new LinearProvisioningError(
        "Saved Linear provisioning state needs repair. Preserve it and restore from backup; no new resources were created.",
        409,
      );
    }
  }
  async function locked<T>(
    project: string,
    action: () => Promise<T>,
  ): Promise<T> {
    statePath(project);
    safe(directory);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const lock = safe(join(directory, `${project}.lock`));
    let fd: number;
    try {
      fd = openSync(lock, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      // Only recover a lock whose same-machine owner is conclusively gone.
      try {
        const pid = Number(readFileSync(lock, "utf8"));
        if (!Number.isSafeInteger(pid) || pid < 1) throw new Error();
        try {
          process.kill(pid, 0);
        } catch (probe) {
          if ((probe as NodeJS.ErrnoException).code === "ESRCH") {
            unlinkSync(lock);
            return locked(project, action);
          }
        }
      } catch {
        /* Ambiguous lock remains intact. */
      }
      throw new LinearProvisioningError(
        "Linear setup is already running. Wait for it to finish and retry.",
        409,
      );
    }
    try {
      writeFileSync(fd, String(process.pid));
      recoverRepair(project);
      return await action();
    } finally {
      closeSync(fd);
      unlinkSync(lock);
    }
  }
  function edit(
    project: string,
    file: "project.json" | "areas.json",
    update: (value: Record<string, unknown>) => void,
  ) {
    const document = readEditableConfig(root, `projects/${project}/${file}`);
    const value = JSON.parse(document.content) as Record<string, unknown>;
    update(value);
    saveEditableConfig(root, {
      path: document.path,
      content: JSON.stringify(value, null, 2) + "\n",
      revision: document.revision,
    });
  }
  function status(project: string, areaKey?: string): LinearMappingStatus {
    if (existsSync(repairPath(project)))
      return {
        status: "error",
        message:
          "A mapping repair was interrupted. Save the mapping again to recover its preserved local transaction.",
      };
    const config = loadProject(root, project);
    const state = read(project);
    const team = config.config.linear;
    if (
      state &&
      ((state.connectionId !== undefined &&
        state.connectionId !== (team?.connectionId ?? "default")) ||
        (team?.workspaceId && state.workspaceId !== team.workspaceId) ||
        (team?.teamId && state.team.id !== team.teamId) ||
        config.areas.some(
          (area) =>
            !missingId(area.linearProjectId) &&
            Object.hasOwn(state.areas, area.key) &&
            state.areas[area.key]!.instanceId === area.instanceId &&
            state.areas[area.key]!.id !== area.linearProjectId,
        ))
    )
      return {
        status: "error",
        teamId: team?.teamId,
        teamName: team?.teamName,
        connectionId: team?.connectionId,
        workspaceId: team?.workspaceId,
        message:
          "Linear mappings and the saved setup journal differ. Use Edit project to repair the account, team, and PM mappings together.",
      };
    const ready =
      !!team?.teamId &&
      config.areas
        .filter((area) => !areaKey || area.key === areaKey)
        .every(
          (area) =>
            !missingId(area.linearProjectId) &&
            !(
              state?.areas[area.key]?.id === area.linearProjectId &&
              state.areas[area.key]?.instanceId === area.instanceId &&
              state.areas[area.key]?.managedBrief?.applied === false
            ),
        );
    return {
      status: state?.error ? "error" : ready ? "ready" : "skipped",
      ...(team
        ? {
            teamId: team.teamId,
            teamName: team.teamName,
            connectionId: team.connectionId,
            workspaceId: team.workspaceId,
          }
        : {}),
      ...(!ready || state?.error
        ? {
            message: state?.error
              ? "Linear setup is incomplete. Retry to resume the saved operation."
              : "Connect Linear and set up this app's team when ready.",
          }
        : {}),
    };
  }
  async function repairMappings(project: string, input: LinearMappingRepair) {
    if (
      !object(input) ||
      Object.keys(input).some(
        (key) =>
          ![
            "projectRevision",
            "areasRevision",
            "teamId",
            "areaProjects",
            "connectionId",
          ].includes(key),
      ) ||
      typeof input.projectRevision !== "string" ||
      !/^[a-f0-9]{64}$/.test(input.projectRevision) ||
      typeof input.areasRevision !== "string" ||
      !/^[a-f0-9]{64}$/.test(input.areasRevision) ||
      typeof input.teamId !== "string" ||
      !UUID.test(input.teamId) ||
      (input.connectionId !== undefined &&
        !validConnectionId(input.connectionId)) ||
      !object(input.areaProjects)
    )
      throw new LinearProvisioningError(
        "Provide the current project and PM revisions, an existing Linear team, and every PM's project selection.",
      );
    return locked(project, async () => {
      const projectDocument = readEditableConfig(
        root,
        `projects/${project}/project.json`,
      );
      const areaDocument = readEditableConfig(
        root,
        `projects/${project}/areas.json`,
      );
      const tiersDocument = readEditableConfig(
        root,
        `projects/${project}/tiers.json`,
      );
      const conflict = () =>
        new LinearProvisioningError(
          "Project or PM settings changed. Reload both files and review your selections before saving again.",
          409,
        );
      if (
        projectDocument.revision !== input.projectRevision ||
        areaDocument.revision !== input.areasRevision
      )
        throw conflict();
      const projectValue: unknown = JSON.parse(projectDocument.content),
        areaValue: unknown = JSON.parse(areaDocument.content);
      if (
        !object(projectValue) ||
        !object(areaValue) ||
        !object(areaValue.areas)
      )
        throw new LinearProvisioningError(
          "Repair the project's JSON structure before changing Linear mappings.",
        );
      const keys = Object.keys(areaValue.areas);
      if (
        Object.keys(input.areaProjects).length !== keys.length ||
        keys.some((key) => !Object.hasOwn(input.areaProjects, key))
      )
        throw new LinearProvisioningError(
          "Select a Linear project or Unmapped for every current PM. Reload if the PM list changed.",
        );
      const selectedIds = new Set<string>();
      for (const key of keys) {
        validateName(key, "area");
        const id = input.areaProjects[key];
        if (
          !object(areaValue.areas[key]) ||
          (id !== null && (typeof id !== "string" || !UUID.test(id)))
        )
          throw new LinearProvisioningError(
            "Each PM selection must be an existing Linear project UUID or Unmapped.",
          );
        if (id !== null) {
          if (selectedIds.has(id!.toLowerCase()))
            throw new LinearProvisioningError(
              "Choose a different Linear project for each PM; duplicate mappings are not allowed.",
            );
          selectedIds.add(id!.toLowerCase());
        }
      }
      const previousState = read(project);
      const journalBefore = contents(statePath(project));
      const selectedConnection =
        input.connectionId ??
        (object(projectValue.linear) &&
        typeof projectValue.linear.connectionId === "string"
          ? projectValue.linear.connectionId
          : "default");
      if (!validConnectionId(selectedConnection))
        throw new LinearProvisioningError(
          "Choose a saved Linear account before repairing mappings.",
        );
      const client = await options.client(project, selectedConnection);
      const workspace = await client.organization();
      const team = await client.getTeam(input.teamId);
      if (
        !UUID.test(workspace.id) ||
        !team ||
        team.id.toLowerCase() !== input.teamId.toLowerCase()
      )
        throw new LinearProvisioningError(
          "The selected Linear team is unavailable in the connected workspace.",
        );
      const nextState: Intent = {
        ...previousState,
        schema: 1,
        workspaceId: workspace.id,
        connectionId: selectedConnection,
        team: {
          ...previousState?.team,
          id: team.id,
          name: team.name,
          key: team.key,
          created: true,
          reuse: true,
        },
        areas: { ...previousState?.areas },
      };
      delete nextState.team.creation;
      for (const key of keys) {
        const chosen = input.areaProjects[key];
        const value = areaValue.areas[key] as Record<string, unknown>;
        if (chosen === null) {
          value.linearProjectId = "PASTE_LINEAR_PROJECT_ID";
          value.enabled = false;
          if (value.codingEnabled !== undefined) value.codingEnabled = false;
          nextState.areas[key] = {
            ...previousState?.areas[key],
            id: randomUUID(),
            created: false,
          };
        } else {
          const resource = await client.getProject(chosen!);
          if (
            !resource ||
            resource.id.toLowerCase() !== chosen!.toLowerCase() ||
            !resource.teamIds.some(
              (id) => id.toLowerCase() === team.id.toLowerCase(),
            )
          )
            throw new LinearProvisioningError(
              "Every selected PM project must be accessible and belong to the selected Linear team.",
            );
          value.linearProjectId = resource.id;
          nextState.areas[key] = {
            ...previousState?.areas[key],
            id: resource.id,
            created: true,
          };
        }
        // An explicit selection is reuse, never permission to edit that remote project.
        delete nextState.areas[key]!.managedBrief;
        if (typeof value.instanceId === "string")
          nextState.areas[key]!.instanceId = value.instanceId;
        else delete nextState.areas[key]!.instanceId;
      }
      projectValue.linear = {
        ...(object(projectValue.linear) ? projectValue.linear : {}),
        teamId: team.id,
        teamName: team.name,
        workspaceId: workspace.id,
        connectionId: selectedConnection,
      };
      projectValue.verified = null;
      delete nextState.error;
      const nextProject = JSON.stringify(projectValue, null, 2) + "\n",
        nextAreas = JSON.stringify(areaValue, null, 2) + "\n",
        nextJournal = JSON.stringify(nextState, null, 2) + "\n";
      if (
        [nextProject, nextAreas].some(
          (content) => Buffer.byteLength(content) > MAX_CONFIG_BYTES,
        ) ||
        Buffer.byteLength(nextJournal) > 128 * 1024
      )
        throw new LinearProvisioningError(
          "The repaired configuration exceeds its file-size limit. No mappings were changed.",
        );
      const temporaryParent = realpathSync(tmpdir());
      const stage = mkdtempSync(
        join(temporaryParent, "gremlins-linear-repair-"),
      );
      try {
        const stagedProject = join(stage, "projects", project);
        mkdirSync(stagedProject, { recursive: true, mode: 0o700 });
        for (const [name, content] of [
          ["project.json", nextProject],
          ["areas.json", nextAreas],
          ["tiers.json", tiersDocument.content],
        ])
          writeFileSync(join(stagedProject, name!), content!, { mode: 0o600 });
        loadProject(stage, project);
      } catch {
        throw new LinearProvisioningError(
          "The repaired mapping does not pass project validation. Check the project and PM settings; nothing was saved.",
        );
      } finally {
        if (
          dirname(stage) === temporaryParent &&
          basename(stage).startsWith("gremlins-linear-repair-")
        )
          rmSync(stage, { recursive: true, force: true });
      }
      for (const document of [projectDocument, areaDocument, tiersDocument])
        if (
          readEditableConfig(root, document.path).revision !== document.revision
        )
          throw conflict();
      if (contents(statePath(project)) !== journalBefore) throw conflict();
      const transaction: RepairTransaction = {
        schema: 1,
        id: randomUUID(),
        phase: "pending",
        files: [
          {
            name: "project",
            before: projectDocument.content,
            after: nextProject,
          },
          { name: "areas", before: areaDocument.content, after: nextAreas },
          { name: "journal", before: journalBefore, after: nextJournal },
        ],
      };
      try {
        atomic(repairPath(project), transaction);
        for (const entry of transaction.files) {
          const target = repairFilePath(project, entry.name);
          if (contents(target) !== entry.before) throw conflict();
          (options.mappingWrite ?? atomicText)(target, entry.after);
        }
        transaction.phase = "committed";
        atomic(repairPath(project), transaction);
        finishRepair(project, transaction);
      } catch (error) {
        recoverRepair(project);
        if (error instanceof LinearProvisioningError) throw error;
        throw new LinearProvisioningError(
          "Mapping repair could not be saved. Original local files were restored; no Linear resources were created or deleted.",
          500,
        );
      }
      const savedProject = readEditableConfig(root, projectDocument.path),
        savedAreas = readEditableConfig(root, areaDocument.path);
      return {
        ok: true,
        projectRevision: savedProject.revision,
        areasRevision: savedAreas.revision,
        team: { id: team.id, name: team.name },
        project: savedProject,
        areas: savedAreas,
        linear: status(project),
        message:
          "Linear mappings saved. Unmapped PMs are disabled. Verify the project before running jobs.",
      };
    }).catch((error) => {
      if (error instanceof LinearProvisioningError) throw error;
      throw new LinearProvisioningError(
        "Linear mappings could not be validated or saved. Check the connection and local configuration; no remote resources were created or deleted.",
        502,
      );
    });
  }
  async function provision(
    project: string,
    input: { teamId?: string; areaKey?: string } = {},
  ): Promise<LinearMappingStatus> {
    return locked(project, async () => {
      let state = read(project);
      const config = loadProject(root, project);
      const sourceRevisions = ["project.json", "areas.json"].map((file) =>
        readEditableConfig(root, `projects/${project}/${file}`),
      );
      const selectedAreas = config.areas.filter(
        (area) => !input.areaKey || area.key === input.areaKey,
      );
      if (input.areaKey && !selectedAreas.length)
        throw new LinearProvisioningError(
          "Choose an existing PM before preparing Linear.",
        );
      const connectionId = config.config.linear?.connectionId ?? "default";
      if (state?.connectionId && state.connectionId !== connectionId)
        throw new LinearProvisioningError(
          "The saved Linear setup belongs to another account. Use Edit project to repair its team and PM mappings together.",
          409,
        );
      if (input.teamId !== undefined && !UUID.test(input.teamId))
        throw new LinearProvisioningError(
          "Choose a Linear team UUID from this workspace.",
        );
      const client = await options.client(project);
      let step = "checking the Linear workspace";
      try {
        const workspace = await client.organization();
        if (!UUID.test(workspace.id)) throw new Error();
        if (
          (state && state.workspaceId !== workspace.id) ||
          (config.config.linear?.workspaceId &&
            config.config.linear.workspaceId !== workspace.id)
        )
          throw new LinearProvisioningError(
            "This app belongs to a different Linear workspace. Reconnect its original workspace; existing mappings were preserved.",
            409,
          );
        const selected = input.teamId ?? config.config.linear?.teamId;
        let team: LinearTeam | null = null;
        if (state && selected && state.team.id !== selected) {
          const unmapped =
            input.teamId !== undefined &&
            !config.config.linear?.teamId &&
            config.areas.every((area) => missingId(area.linearProjectId)) &&
            !Object.keys(state.areas).length;
          const unused =
            state.team.reuse ||
            (!state.team.created &&
              ["not-started", "rejected"].includes(state.team.creation ?? ""));
          if (!unmapped || !unused)
            throw new LinearProvisioningError(
              state.team.created || state.team.reuse || !unmapped
                ? "This app is already linked to a different team. Use Edit project → Linear mappings to change its team and PM mappings together; existing resources were preserved."
                : "An earlier creation for a different team is not confirmed. Retry the original setup before changing teams, or recover its saved IDs in Edit project → Linear mappings. The reservation is kept to avoid duplicate teams.",
              409,
            );
          // A definite refusal can still accompany a partial response. Reconcile
          // the exact ID before abandoning it; transport failures never get here.
          if (!state.team.reuse) {
            step = "checking the previous team reservation";
            const previous = await client.getTeam(state.team.id);
            if (previous) {
              state.team.created = true;
              state.team.name = previous.name;
              delete state.team.creation;
              atomic(statePath(project), state);
              throw new LinearProvisioningError(
                "The earlier setup created a different team. Retry its setup or change its mappings in Edit project; the existing team was preserved.",
                409,
              );
            }
          }
          step = "checking the selected team";
          team = await client.getTeam(selected);
          if (!team || team.id !== selected)
            throw new LinearProvisioningError(
              "The selected Linear team is unavailable to this connection. The previous reservation was preserved.",
              409,
            );
          if (
            sourceRevisions.some(
              (source) =>
                readEditableConfig(root, source.path).revision !==
                source.revision,
            )
          )
            throw new LinearProvisioningError(
              "Project or PM settings changed while checking teams. Refresh before retrying; the previous reservation was preserved.",
              409,
            );
          // Retain the abandoned choice for recovery, without deleting or moving
          // any Linear resource. The project lock protects this journal transition.
          const archive = safe(
            join(
              directory,
              "history",
              runtimeKey(project),
              `team-${state.team.id}.json`,
            ),
          );
          if (!existsSync(archive))
            atomic(archive, { schema: 1, project, intent: state });
          state.team = {
            id: team.id,
            name: team.name,
            key: team.key,
            created: true,
            reuse: true,
          };
          atomic(statePath(project), state);
        }
        const legacy: LinearProjectResource[] = [];
        step = "checking existing PM projects";
        for (const area of config.areas)
          if (!missingId(area.linearProjectId)) {
            const resource = await client.getProject(area.linearProjectId);
            if (!resource)
              throw new LinearProvisioningError(
                "An existing Linear project is unavailable. Restore access or repair its mapping before provisioning.",
                409,
              );
            legacy.push(resource);
          }
        if (!state) {
          let reuse = selected;
          if (!reuse && legacy.length) {
            const common = legacy[0]!.teamIds.filter((id) =>
              legacy.every((resource) => resource.teamIds.includes(id)),
            );
            if (common.length !== 1)
              throw new LinearProvisioningError(
                "Choose an existing team shared by all mapped PM projects. Existing projects will not be moved.",
                409,
              );
            reuse = common[0];
          }
          if (reuse) {
            step = "checking the selected team";
            team = await client.getTeam(reuse);
            if (!team)
              throw new LinearProvisioningError(
                "The selected Linear team is unavailable to this connection.",
              );
          }
          const id = team?.id ?? randomUUID();
          let key =
            team?.key ??
            `${
              project
                .replace(/[^a-z]/g, "")
                .slice(0, 4)
                .toUpperCase() || "SG"
            }${id.replaceAll("-", "").slice(0, 4).toUpperCase()}`;
          if (!team) {
            step = "finding an available team key";
            const used = new Set(
              (await client.resources()).teams.map((existing) =>
                existing.key.toUpperCase(),
              ),
            );
            const base = key;
            for (let suffix = 1; used.has(key) && suffix < 100; suffix++)
              key = `${base.slice(0, 6)}${suffix}`;
            if (used.has(key))
              throw new LinearProvisioningError(
                "No unused Linear team key could be selected. Reuse an existing team instead.",
                409,
              );
          }
          state = {
            schema: 1,
            workspaceId: workspace.id,
            connectionId,
            team: {
              id,
              name: team?.name ?? project,
              key,
              created: !!team,
              reuse: !!team,
              ...(!team ? { creation: "not-started" as const } : {}),
            },
            areas: {},
          };
          atomic(statePath(project), state);
        }
        if (
          legacy.some((resource) => !resource.teamIds.includes(state!.team.id))
        )
          throw new LinearProvisioningError(
            "The chosen team does not contain every existing PM project. Existing projects will not be moved.",
            409,
          );
        step = "checking the saved team";
        team ??= await client.getTeam(state.team.id);
        if (!team) {
          if (state.team.created || state.team.reuse)
            throw new LinearProvisioningError(
              "The saved Linear team is unavailable. Restore access instead of creating a replacement.",
              409,
            );
          step = "creating the Linear team";
          const priorUnambiguous = ["not-started", "rejected"].includes(
            state.team.creation ?? "",
          );
          state.team.creation = "pending";
          atomic(statePath(project), state);
          try {
            team = await client.createTeam({
              id: state.team.id,
              key: state.team.key,
              name: state.team.name,
              description: `ShipGremlins app: ${project}. Each PM mandate has its own project.`,
            });
          } catch (error) {
            if (priorUnambiguous && refusedTeamCreation(error)) {
              state.team.creation = "rejected";
              atomic(statePath(project), state);
            }
            throw error;
          }
        }
        if (team.id !== state.team.id) throw new Error();
        state.team.created = true;
        delete state.team.creation;
        state.connectionId = connectionId;
        state.team.name = team.name;
        step = "saving the team mapping";
        atomic(statePath(project), state);
        edit(project, "project.json", (value) => {
          const existing = value.linear;
          if (
            object(existing) &&
            existing.teamId !== undefined &&
            existing.teamId !== team!.id
          )
            throw new LinearProvisioningError(
              "Team mapping changed during setup. Refresh before retrying.",
              409,
            );
          value.linear = {
            ...(object(existing) ? existing : {}),
            teamId: team!.id,
            teamName: team!.name,
            workspaceId: workspace.id,
          };
        });
        for (const area of selectedAreas) {
          if (client.ensureLabels) {
            step = "preparing issue labels";
            await client.ensureLabels(team.id, [area.label, LABELS.proposal]);
          }
          let intent = Object.hasOwn(state.areas, area.key)
            ? state.areas[area.key]
            : undefined;
          if (intent && intent.instanceId !== area.instanceId) {
            // Keep old remote IDs and metadata for recovery, but never let an old
            // PM generation supply a replacement's provisioning intent.
            const archive = safe(
              join(
                directory,
                "history",
                project,
                `${area.key}-${intent.instanceId ?? "legacy"}-${intent.id}.json`,
              ),
            );
            if (!existsSync(archive))
              atomic(archive, { schema: 1, project, area: area.key, intent });
            delete state.areas[area.key];
            atomic(statePath(project), state);
            intent = undefined;
          }
          if (
            !missingId(area.linearProjectId) &&
            !(
              intent?.id === area.linearProjectId &&
              intent.managedBrief &&
              !intent.managedBrief.applied
            )
          )
            continue;
          if (!intent) {
            intent = {
              id: randomUUID(),
              created: false,
              ...(area.instanceId ? { instanceId: area.instanceId } : {}),
            };
            state.areas[area.key] = intent;
            atomic(statePath(project), state);
          }
          const mandateFile = safe(join(config.dir, area.key, "mandate.md"));
          const mandateStat = existsSync(mandateFile)
            ? lstatSync(mandateFile)
            : null;
          const mandate =
            area.mandate ??
            (mandateStat?.isFile() && mandateStat.size <= 64 * 1024
              ? readFileSync(mandateFile, "utf8")
              : "");
          const brief = buildLinearProjectContent(config, area, mandate);
          let omitIcon = false;
          step = "checking the reserved PM project";
          let remote = await client.getProject(intent.id);
          if (!remote) {
            if (intent.created)
              throw new LinearProvisioningError(
                "A provisioned PM project is unavailable. Restore access before retrying.",
                409,
              );
            // Persist ownership before the remote mutation so a lost response can
            // reconcile this exact ID. Historical/reused projects lack this proof.
            intent.managedBrief = { version: 1, applied: false };
            atomic(statePath(project), state);
            step = "creating the PM project";
            const input = {
              id: intent.id,
              teamId: team.id,
              name: area.name,
              ...brief,
            };
            try {
              await client.createProject(input);
            } catch (error) {
              if (!rejectedIcon(error)) throw error;
              // Decoration must not block setup. Reconcile the reserved ID before
              // one retry, and never retry permission, transport or other input errors.
              remote = await client.getProject(intent.id);
              if (!remote) {
                const { icon: _icon, ...withoutIcon } = input;
                await client.createProject(withoutIcon);
              }
              omitIcon = true;
            }
            step = "confirming the PM project";
            remote = await client.getProject(intent.id);
          }
          if (!remote || !remote.teamIds.includes(team.id)) throw new Error();
          if (intent.managedBrief && !intent.managedBrief.applied) {
            // Only fill absent metadata during recovery. A human may have edited
            // the new project while the first response was lost; keep those edits.
            const missing: Partial<typeof brief> = {};
            for (const field of [
              "description",
              "content",
              "icon",
              "color",
            ] as const) {
              if (field === "icon" && omitIcon) continue;
              if (!remote[field]?.trim()) missing[field] = brief[field];
            }
            if (Object.keys(missing).length) {
              step = "saving the PM project brief";
              try {
                await client.updateProject(intent.id, missing);
              } catch (error) {
                if (!missing.icon || !rejectedIcon(error)) throw error;
                delete missing.icon;
                // Re-read after the rejected mutation so newer human edits win.
                const latest = await client.getProject(intent.id);
                if (!latest || !latest.teamIds.includes(team.id)) throw error;
                for (const field of [
                  "description",
                  "content",
                  "color",
                ] as const)
                  if (latest[field]?.trim()) delete missing[field];
                if (Object.keys(missing).length)
                  await client.updateProject(intent.id, missing);
              }
            }
            intent.managedBrief.applied = true;
          }
          intent.created = true;
          atomic(statePath(project), state);
          step = "saving the PM project mapping";
          edit(project, "areas.json", (value) => {
            if (!object(value.areas) || !object(value.areas[area.key]))
              throw new LinearProvisioningError(
                "PM configuration changed during setup. Refresh and retry.",
                409,
              );
            const saved = value.areas[area.key] as Record<string, unknown>;
            if (saved.instanceId !== area.instanceId)
              throw new LinearProvisioningError(
                "This PM was recreated during setup. Retry using its current identity; saved mappings were preserved.",
                409,
              );
            if (
              saved.linearProjectId !== intent!.id &&
              saved.linearProjectId !== "PASTE_LINEAR_PROJECT_ID"
            )
              throw new LinearProvisioningError(
                "This PM was mapped elsewhere during setup. Its current mapping was preserved.",
                409,
              );
            saved.linearProjectId = intent!.id;
          });
        }
        delete state.error;
        atomic(statePath(project), state);
        return status(project, input.areaKey);
      } catch (error) {
        if (state) {
          state.error = true;
          atomic(statePath(project), state);
        }
        if (error instanceof LinearProvisioningError) throw error;
        throw provisioningFailure(error, step);
      }
    });
  }
  async function addArea(
    project: string,
    input: Record<string, unknown>,
  ): Promise<void> {
    const allowed = [
      "key",
      "name",
      "mandate",
      "charter",
      "verificationRequirement",
      "paths",
      "sharedTouchpoints",
      "metric",
      "schedule",
      "wipLimit",
      "linearProjectId",
      "mixpanelReportId",
      "codingEnabled",
      "enabled",
    ];
    if (
      Object.keys(input).some((key) => !allowed.includes(key)) ||
      typeof input.key !== "string" ||
      (input.codingEnabled !== undefined &&
        typeof input.codingEnabled !== "boolean") ||
      (input.enabled !== undefined && typeof input.enabled !== "boolean") ||
      typeof input.name !== "string" ||
      !input.name.trim() ||
      input.name.length > 100 ||
      typeof input.mandate !== "string" ||
      !input.mandate.trim() ||
      input.mandate.length > 12000
    )
      throw new LinearProvisioningError(
        "Provide a PM key, name (1–100 characters), and mandate (1–12000 characters).",
      );
    validateName(input.key, "area");
    if (
      input.verificationRequirement !== undefined &&
      !isPmVerificationRequirement(input.verificationRequirement)
    )
      throw new LinearProvisioningError(
        "Choose browser walkthrough required, repository checks sufficient, or leave the testing requirement unset.",
      );
    assertResourceAvailable(options.root, project);
    let charter: PmCharter | undefined;
    if (input.charter !== undefined) {
      try {
        charter = parsePmCharter(input.charter);
      } catch {
        throw new LinearProvisioningError(
          "Check the PM product brief: supported text and list fields must fit the displayed limits.",
        );
      }
    }
    if (
      input.mixpanelReportId !== undefined &&
      (typeof input.mixpanelReportId !== "string" ||
        !ID_RE.test(input.mixpanelReportId))
    )
      throw new LinearProvisioningError(
        "Use a positive numeric Mixpanel saved-report ID, or leave it empty.",
      );
    const strings = (value: unknown) =>
      Array.isArray(value) &&
      value.length <= 100 &&
      value.every(
        (item) =>
          typeof item === "string" &&
          item.length <= 500 &&
          !item.includes("\0") &&
          !item.split(/[\\/]/).includes(".."),
      );
    if (
      (input.paths !== undefined && !strings(input.paths)) ||
      (input.sharedTouchpoints !== undefined &&
        !strings(input.sharedTouchpoints)) ||
      (input.metric !== undefined &&
        (typeof input.metric !== "string" ||
          !input.metric ||
          input.metric.length > 200)) ||
      (input.wipLimit !== undefined &&
        (!Number.isInteger(input.wipLimit) ||
          Number(input.wipLimit) < 1 ||
          Number(input.wipLimit) > 20)) ||
      (input.linearProjectId !== undefined &&
        (typeof input.linearProjectId !== "string" ||
          !UUID.test(input.linearProjectId)))
    )
      throw new LinearProvisioningError(
        "Check ownership paths, metric, WIP limit (1–20), and optional Linear project UUID.",
      );
    const schedule = input.schedule ?? "0 13 * * *";
    try {
      if (
        typeof schedule !== "string" ||
        schedule.length > 100 ||
        schedule.trim().split(/\s+/).length !== 5
      )
        throw new Error();
      CronExpressionParser.parse(schedule, { tz: "UTC" });
    } catch {
      throw new LinearProvisioningError(
        "Use a valid five-field cron schedule in UTC.",
      );
    }
    await locked(project, async () => {
      const config = loadProject(root, project);
      if (
        input.mixpanelReportId !== undefined &&
        !config.config.telemetry?.mixpanel
      )
        throw new LinearProvisioningError(
          "Configure Mixpanel for this project before assigning a PM saved-report ID.",
        );
      if (config.areas.some((area) => area.key === input.key))
        throw new LinearProvisioningError(
          "That PM key already exists. Use Retry Linear setup for an incomplete mapping.",
          409,
        );
      if (input.linearProjectId) {
        const remote = await (
          await options.client(project)
        ).getProject(String(input.linearProjectId));
        if (
          !remote ||
          (config.config.linear?.teamId &&
            !remote.teamIds.includes(config.config.linear.teamId))
        )
          throw new LinearProvisioningError(
            "The selected Linear project is unavailable or belongs to another team.",
          );
      }
      const instanceId = preparePmRecreation(root, project, String(input.key));
      if (instanceId)
        edit(project, "project.json", (value) => {
          value.verified = null;
        });
      edit(project, "areas.json", (value) => {
        if (
          !object(value.areas) ||
          Object.hasOwn(value.areas, String(input.key))
        )
          throw new LinearProvisioningError(
            "PM configuration changed. Refresh before adding the PM.",
            409,
          );
        value.areas[String(input.key)] = {
          ...(instanceId ? { instanceId } : {}),
          name: input.name,
          mandate: input.mandate,
          ...(input.verificationRequirement === undefined
            ? {}
            : { verificationRequirement: input.verificationRequirement }),
          ...(charter ? { charter } : {}),
          paths: input.paths ?? [],
          sharedTouchpoints: input.sharedTouchpoints ?? [],
          linearProjectId: input.linearProjectId ?? "PASTE_LINEAR_PROJECT_ID",
          label: `pm:${input.key}`,
          wipLimit: input.wipLimit ?? 3,
          metric: input.metric ?? "/",
          schedule,
          enabled: instanceId ? false : (input.enabled ?? true),
          codingEnabled: instanceId ? false : (input.codingEnabled ?? true),
          ...(input.mixpanelReportId === undefined
            ? {}
            : { mixpanelReportId: input.mixpanelReportId }),
        };
      });
      if (instanceId)
        completePmRecreation(root, project, String(input.key), instanceId);
    });
  }
  return {
    status,
    provision,
    addArea,
    repairMappings,
    resources: async (project?: string, connectionId?: string) =>
      (await options.client(project, connectionId)).resources(),
  };
}
