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
} from "node:fs";
import { join, dirname, resolve, parse } from "node:path";
import { CronExpressionParser } from "cron-parser";
import { loadProject } from "../config.ts";
import { ID_RE } from "../telemetry/config.ts";
import { readEditableConfig, saveEditableConfig } from "./configEditor.ts";
import { validateName } from "./files.ts";
import type {
  LinearApi,
  LinearTeam,
  LinearProjectResource,
} from "../services/linear.ts";

export type LinearProvisioningClient = Pick<
  LinearApi,
  | "organization"
  | "getTeam"
  | "getProject"
  | "createTeam"
  | "createProject"
  | "resources"
>;
export interface LinearMappingStatus {
  status: "ready" | "needs-connection" | "error" | "skipped";
  message?: string;
  teamId?: string;
  teamName?: string;
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
  team: {
    id: string;
    name: string;
    key: string;
    created: boolean;
    reuse: boolean;
  };
  areas: Record<string, { id: string; created: boolean }>;
  error?: boolean;
}
const UUID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const missingId = (value: string) => value === "PASTE_LINEAR_PROJECT_ID";
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
  safe(file);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n", {
      flag: "wx",
      mode: 0o600,
    });
    safe(file);
    renameSync(temporary, file);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

export function createLinearProvisioning(options: {
  root: string;
  client: () => Promise<LinearProvisioningClient>;
}) {
  const { root } = options;
  const directory = join(root, ".run", "linear", "provisioning");
  function statePath(project: string) {
    validateName(project, "project");
    return safe(join(directory, `${project}.json`));
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
        !object(raw.team) ||
        typeof raw.team.id !== "string" ||
        !UUID.test(raw.team.id) ||
        typeof raw.team.name !== "string" ||
        typeof raw.team.key !== "string" ||
        typeof raw.team.created !== "boolean" ||
        typeof raw.team.reuse !== "boolean" ||
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
  function status(project: string): LinearMappingStatus {
    const config = loadProject(root, project);
    const state = read(project);
    const team = config.config.linear;
    const ready =
      !!team && config.areas.every((area) => !missingId(area.linearProjectId));
    return {
      status: ready ? "ready" : state?.error ? "error" : "skipped",
      ...(team ? { teamId: team.teamId, teamName: team.teamName } : {}),
      ...(!ready
        ? {
            message: state?.error
              ? "Linear setup is incomplete. Retry to resume the saved operation."
              : "Connect Linear and set up this app's team when ready.",
          }
        : {}),
    };
  }
  async function provision(
    project: string,
    input: { teamId?: string } = {},
  ): Promise<LinearMappingStatus> {
    return locked(project, async () => {
      let state = read(project);
      const config = loadProject(root, project);
      if (input.teamId !== undefined && !UUID.test(input.teamId))
        throw new LinearProvisioningError(
          "Choose a Linear team UUID from this workspace.",
        );
      const client = await options.client();
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
        if (state && selected && state.team.id !== selected)
          throw new LinearProvisioningError(
            "A different team is already reserved for this app. Existing projects and mappings were preserved.",
            409,
          );
        const legacy: LinearProjectResource[] = [];
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
        let team: LinearTeam | null = null;
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
            team: {
              id,
              name: team?.name ?? project,
              key,
              created: !!team,
              reuse: !!team,
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
        team ??= await client.getTeam(state.team.id);
        if (!team) {
          if (state.team.created || state.team.reuse)
            throw new LinearProvisioningError(
              "The saved Linear team is unavailable. Restore access instead of creating a replacement.",
              409,
            );
          team = await client.createTeam({
            id: state.team.id,
            key: state.team.key,
            name: state.team.name,
            description: `ShipGremlins app: ${project}. Each PM mandate has its own project.`,
          });
        }
        if (team.id !== state.team.id) throw new Error();
        state.team.created = true;
        state.team.name = team.name;
        atomic(statePath(project), state);
        edit(project, "project.json", (value) => {
          const existing = value.linear;
          if (object(existing) && existing.teamId !== team!.id)
            throw new LinearProvisioningError(
              "Team mapping changed during setup. Refresh before retrying.",
              409,
            );
          value.linear = {
            teamId: team!.id,
            teamName: team!.name,
            workspaceId: workspace.id,
          };
        });
        for (const area of config.areas) {
          if (!missingId(area.linearProjectId)) continue;
          let intent = Object.hasOwn(state.areas, area.key)
            ? state.areas[area.key]
            : undefined;
          if (!intent) {
            intent = { id: randomUUID(), created: false };
            state.areas[area.key] = intent;
            atomic(statePath(project), state);
          }
          let remote = await client.getProject(intent.id);
          if (!remote) {
            if (intent.created)
              throw new LinearProvisioningError(
                "A provisioned PM project is unavailable. Restore access before retrying.",
                409,
              );
            const mandateFile = safe(join(config.dir, area.key, "mandate.md"));
            const content =
              area.mandate ??
              (existsSync(mandateFile) &&
              lstatSync(mandateFile).size <= 64 * 1024
                ? readFileSync(mandateFile, "utf8").slice(0, 12000)
                : `PM mandate for ${project}: ${area.name}. Review the local mandate before enabling this PM.`);
            await client.createProject({
              id: intent.id,
              teamId: team.id,
              name: area.name,
              description: `ShipGremlins ${project} / ${area.key}`,
              content,
            });
            remote = await client.getProject(intent.id);
          }
          if (!remote || !remote.teamIds.includes(team.id)) throw new Error();
          intent.created = true;
          atomic(statePath(project), state);
          edit(project, "areas.json", (value) => {
            if (!object(value.areas) || !object(value.areas[area.key]))
              throw new LinearProvisioningError(
                "PM configuration changed during setup. Refresh and retry.",
                409,
              );
            const saved = value.areas[area.key] as Record<string, unknown>;
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
        return status(project);
      } catch (error) {
        if (state) {
          state.error = true;
          atomic(statePath(project), state);
        }
        if (error instanceof LinearProvisioningError) throw error;
        throw new LinearProvisioningError(
          "Linear setup did not finish. Check workspace permissions and team limits, then retry. Saved resource IDs prevent duplicate creation.",
          502,
        );
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
      "paths",
      "sharedTouchpoints",
      "metric",
      "schedule",
      "wipLimit",
      "linearProjectId",
      "mixpanelReportId",
    ];
    if (
      Object.keys(input).some((key) => !allowed.includes(key)) ||
      typeof input.key !== "string" ||
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
    const schedule = input.schedule ?? "0 13 * * 1-5";
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
          await options.client()
        ).getProject(String(input.linearProjectId));
        if (
          !remote ||
          (config.config.linear &&
            !remote.teamIds.includes(config.config.linear.teamId))
        )
          throw new LinearProvisioningError(
            "The selected Linear project is unavailable or belongs to another team.",
          );
      }
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
          name: input.name,
          mandate: input.mandate,
          paths: input.paths ?? [],
          sharedTouchpoints: input.sharedTouchpoints ?? [],
          linearProjectId: input.linearProjectId ?? "PASTE_LINEAR_PROJECT_ID",
          label: `pm:${input.key}`,
          wipLimit: input.wipLimit ?? 3,
          metric: input.metric ?? "/",
          schedule,
          enabled: false,
          ...(input.mixpanelReportId === undefined
            ? {}
            : { mixpanelReportId: input.mixpanelReportId }),
        };
      });
    });
  }
  return {
    status,
    provision,
    addArea,
    resources: async () => (await options.client()).resources(),
  };
}
