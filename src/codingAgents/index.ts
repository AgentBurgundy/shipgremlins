import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { codingPickupEnabled, loadProject, type Project } from "../config.ts";
import {
  parseAiSelection,
  resolveAiSelection,
  type AiSelection,
} from "../ai/provider.ts";
import { projectAiTarget, readAiRouting } from "../ai/routing.ts";
import { safeOAuthPath } from "../oauthConnection/storage.ts";
import { writePrivate } from "../remoteWorkers/storage.ts";
import {
  readEditableConfig,
  ConfigEditorError,
} from "../setup/configEditor.ts";
import {
  ResourceDeletionError,
  withProjectLifecycleLock,
} from "../setup/resourceDeletion.ts";

export interface CodingAgent {
  key: string;
  instanceId: string;
  name: string;
  enabled: boolean;
  areas: string[];
  maxConcurrent: number;
  ai?: AiSelection;
}
export interface CodingAgentsView {
  revision: string;
  agents: CodingAgent[];
  legacy: boolean;
}
export class CodingAgentError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "CodingAgentError";
  }
}
const NAME = /^[a-z][a-z0-9-]{0,62}$/;
const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const MAX_AGENTS = 20;
const MAX_BYTES = 128 * 1024;
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const only = (value: Record<string, unknown>, keys: string[]) =>
  Object.keys(value).every((key) => keys.includes(key));
const validName = (value: unknown): value is string =>
  typeof value === "string" && NAME.test(value) && !RESERVED.test(value);
const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const invalid = () =>
  new CodingAgentError(
    "Choose up to 20 valid coding agents, unique identities, current PM assignments and a concurrency limit from 1 to 4.",
  );
const conflict = () =>
  new CodingAgentError(
    "Coding agents or their project/PM settings changed. Refresh before saving or starting work.",
    409,
  );
const unsafe = () =>
  new CodingAgentError(
    "Coding agents could not be read safely. Restore their protected configuration before continuing.",
    503,
  );
type Identity = { name: string; instanceId?: string };
type AreaIdentity = { key: string; instanceId?: string };
interface LegacySnapshot {
  agent: CodingAgent;
  area: AreaIdentity;
}
interface SavedAgents {
  version: 1;
  project: Identity;
  generation: string;
  agents: CodingAgent[];
  areaInstances: Record<string, string | null>;
  retiredInstances: string[];
  compatibility: {
    savedAt: string;
    agents: LegacySnapshot[];
    maintenanceAi?: AiSelection;
  };
}
const identity = (project: Project): Identity => ({
  name: project.config.name,
  ...(project.config.instanceId
    ? { instanceId: project.config.instanceId }
    : {}),
});
const areaIdentity = (area: AreaIdentity): AreaIdentity => ({
  key: area.key,
  ...(area.instanceId ? { instanceId: area.instanceId } : {}),
});
const file = (root: string, name: string) =>
  join(resolve(root), "projects", name, "coders.json");
function projectState(root: string, name: string) {
  if (!validName(name)) throw invalid();
  try {
    const revisions = ["project.json", "areas.json", "tiers.json"].map(
      (path) => readEditableConfig(root, `projects/${name}/${path}`).revision,
    );
    const project = loadProject(root, name);
    return { project, revision: hash(revisions) };
  } catch (error) {
    if (error instanceof ConfigEditorError && error.status === 404)
      throw new CodingAgentError(
        "This project no longer exists. Refresh the project list.",
        404,
      );
    throw unsafe();
  }
}
function parseAgent(value: unknown, allowMissingId = false): CodingAgent {
  if (
    !object(value) ||
    !only(value, [
      "key",
      "instanceId",
      "name",
      "enabled",
      "areas",
      "maxConcurrent",
      "ai",
    ]) ||
    !validName(value.key) ||
    (!(allowMissingId && value.instanceId === undefined) &&
      !(typeof value.instanceId === "string" && UUID.test(value.instanceId))) ||
    typeof value.name !== "string" ||
    value.name !== value.name.trim() ||
    !value.name ||
    value.name.length > 100 ||
    [...value.name].some(
      (c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127,
    ) ||
    typeof value.enabled !== "boolean" ||
    !Array.isArray(value.areas) ||
    value.areas.length > 100 ||
    value.areas.some((area) => !validName(area)) ||
    new Set(value.areas).size !== value.areas.length ||
    (value.enabled && !value.areas.length) ||
    !Number.isInteger(value.maxConcurrent) ||
    Number(value.maxConcurrent) < 1 ||
    Number(value.maxConcurrent) > 4
  )
    throw invalid();
  let ai: AiSelection | undefined;
  try {
    if (value.ai !== undefined) ai = parseAiSelection(value.ai);
  } catch {
    throw invalid();
  }
  return {
    key: value.key,
    instanceId:
      typeof value.instanceId === "string"
        ? value.instanceId.toLowerCase()
        : "",
    name: value.name,
    enabled: value.enabled,
    areas: [...value.areas] as string[],
    maxConcurrent: Number(value.maxConcurrent),
    ...(ai ? { ai } : {}),
  };
}
function parseAgents(value: unknown, allowMissingId = false): CodingAgent[] {
  if (!Array.isArray(value) || value.length > MAX_AGENTS) throw invalid();
  const agents = value.map((agent) => parseAgent(agent, allowMissingId));
  if (
    new Set(agents.map((a) => a.key)).size !== agents.length ||
    new Set(agents.filter((a) => a.instanceId).map((a) => a.instanceId))
      .size !== agents.filter((a) => a.instanceId).length
  )
    throw invalid();
  return agents;
}
function privateJson(path: string): unknown {
  safeOAuthPath(path);
  const before = lstatSync(path);
  if (!before.isFile() || before.nlink !== 1 || before.size > MAX_BYTES)
    throw unsafe();
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fstatSync(fd);
    safeOAuthPath(path);
    const current = lstatSync(path);
    if (
      !opened.isFile() ||
      opened.nlink !== 1 ||
      opened.size > MAX_BYTES ||
      opened.dev !== current.dev ||
      opened.ino !== current.ino ||
      (process.platform !== "win32" && (opened.mode & 0o077) !== 0)
    )
      throw unsafe();
    return JSON.parse(readFileSync(fd, "utf8"));
  } finally {
    closeSync(fd);
  }
}
function readSaved(root: string, project: Project): SavedAgents | undefined {
  const path = file(root, project.config.name);
  try {
    safeOAuthPath(path);
    if (!lstatSync(path, { throwIfNoEntry: false })) return undefined;
    const value = privateJson(path);
    if (
      !object(value) ||
      !only(value, [
        "version",
        "project",
        "generation",
        "agents",
        "areaInstances",
        "retiredInstances",
        "compatibility",
      ]) ||
      value.version !== 1 ||
      JSON.stringify(value.project) !== JSON.stringify(identity(project)) ||
      typeof value.generation !== "string" ||
      !/^[a-f0-9]{64}$/.test(value.generation) ||
      !object(value.areaInstances) ||
      Object.keys(value.areaInstances).length > 2000 ||
      Object.entries(value.areaInstances).some(
        ([key, id]) =>
          !validName(key) ||
          !(id === null || (typeof id === "string" && UUID.test(id))),
      ) ||
      !Array.isArray(value.retiredInstances) ||
      value.retiredInstances.length > 1024 ||
      value.retiredInstances.some(
        (id) => typeof id !== "string" || !UUID.test(id),
      ) ||
      new Set(value.retiredInstances).size !== value.retiredInstances.length ||
      !object(value.compatibility) ||
      !only(value.compatibility, ["savedAt", "agents", "maintenanceAi"]) ||
      typeof value.compatibility.savedAt !== "string" ||
      !Number.isFinite(Date.parse(value.compatibility.savedAt)) ||
      new Date(value.compatibility.savedAt).toISOString() !==
        value.compatibility.savedAt ||
      !Array.isArray(value.compatibility.agents) ||
      value.compatibility.agents.length > MAX_AGENTS
    )
      throw unsafe();
    const agents = parseAgents(value.agents);
    if (
      agents.some((agent) =>
        (value.retiredInstances as string[]).includes(agent.instanceId),
      )
    )
      throw unsafe();
    if (
      agents.some((agent) =>
        agent.areas.some(
          (area) => !Object.hasOwn(value.areaInstances as object, area),
        ),
      )
    )
      throw unsafe();
    const compatibility = value.compatibility.agents.map(
      (entry): LegacySnapshot => {
        if (
          !object(entry) ||
          !only(entry, ["agent", "area"]) ||
          !object(entry.area) ||
          !only(entry.area, ["key", "instanceId"]) ||
          !validName(entry.area.key) ||
          (entry.area.instanceId !== undefined &&
            !(
              typeof entry.area.instanceId === "string" &&
              UUID.test(entry.area.instanceId)
            ))
        )
          throw unsafe();
        const agent = parseAgent(entry.agent);
        if (
          agent.areas.length !== 1 ||
          agent.areas[0] !== entry.area.key ||
          !agent.ai
        )
          throw unsafe();
        return {
          agent,
          area: areaIdentity(entry.area as unknown as AreaIdentity),
        };
      },
    );
    parseAgents(compatibility.map((entry) => entry.agent));
    return {
      version: 1,
      project: identity(project),
      generation: value.generation,
      agents,
      areaInstances: value.areaInstances as SavedAgents["areaInstances"],
      retiredInstances: value.retiredInstances as string[],
      compatibility: {
        savedAt: value.compatibility.savedAt,
        agents: compatibility,
        ...(value.compatibility.maintenanceAi !== undefined
          ? {
              maintenanceAi: parseAiSelection(
                value.compatibility.maintenanceAi,
              ),
            }
          : {}),
      },
    };
  } catch {
    throw unsafe();
  }
}
function legacyAgents(root: string, project: Project): LegacySnapshot[] {
  if (project.areas.length > MAX_AGENTS)
    throw new CodingAgentError(
      "This legacy project has more than 20 PM-linked coders. Review its coding assignments before migration.",
      409,
    );
  return project.areas.map((area) => {
    const bytes = Buffer.from(
      hash(["legacy-coder", identity(project), areaIdentity(area)]).slice(
        0,
        32,
      ),
      "hex",
    );
    bytes[6] = (bytes[6]! & 15) | 80;
    bytes[8] = (bytes[8]! & 63) | 128;
    const hex = bytes.toString("hex");
    const selection = readAiRouting(
      root,
      projectAiTarget(project, "coder", area),
    ).effective.coder;
    return {
      area: areaIdentity(area),
      agent: {
        key: area.key,
        instanceId: `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`,
        name: `${
          [...area.name]
            .filter(
              (character) =>
                character.charCodeAt(0) >= 32 &&
                character.charCodeAt(0) !== 127,
            )
            .join("")
            .trim()
            .slice(0, 94) || area.key
        } coder`,
        enabled: codingPickupEnabled(area),
        areas: [area.key],
        maxConcurrent: Math.min(4, Math.max(1, area.wipLimit)),
        ai: {
          provider: selection.provider,
          ...(selection.model ? { model: selection.model } : {}),
        },
      },
    };
  });
}
function readState(root: string, name: string) {
  const state = projectState(root, name),
    saved = readSaved(root, state.project);
  const agents =
    saved?.agents ??
    legacyAgents(root, state.project).map((entry) => entry.agent);
  const view: CodingAgentsView = {
    revision: hash([
      identity(state.project),
      state.revision,
      saved?.generation ?? null,
      agents,
    ]),
    agents: structuredClone(agents),
    legacy: !saved,
  };
  return { ...state, saved, view };
}
/** Reading an unmigrated project never creates files or enables new work. */
export function readCodingAgents(root: string, name: string): CodingAgentsView {
  return readState(root, name).view;
}
function mutate<T>(root: string, name: string, action: () => T): T {
  if (!validName(name)) throw invalid();
  try {
    return withProjectLifecycleLock(root, { project: name }, action);
  } catch (error) {
    if (error instanceof CodingAgentError) throw error;
    if (error instanceof ResourceDeletionError)
      throw new CodingAgentError(error.message, error.status);
    throw unsafe();
  }
}
function persist(
  root: string,
  state: ReturnType<typeof readState>,
  agents: CodingAgent[],
  initialize = false,
) {
  parseAgents(agents);
  const current = projectState(root, state.project.config.name);
  if (current.revision !== state.revision) throw conflict();
  const areas = new Map(current.project.areas.map((area) => [area.key, area]));
  if (agents.some((agent) => agent.areas.some((area) => !areas.has(area))))
    throw invalid();
  const areaInstances = Object.fromEntries(
    [...new Set(agents.flatMap((agent) => agent.areas))].map((key) => [
      key,
      areas.get(key)!.instanceId ?? null,
    ]),
  );
  const saved: SavedAgents = {
    version: 1,
    project: identity(current.project),
    generation: randomBytes(32).toString("hex"),
    agents,
    areaInstances,
    retiredInstances: [
      ...new Set([
        ...(state.saved?.retiredInstances ?? []),
        ...state.view.agents
          .filter(
            (old) =>
              !agents.some(
                (agent) =>
                  agent.key === old.key && agent.instanceId === old.instanceId,
              ),
          )
          .map((agent) => agent.instanceId),
      ]),
    ],
    compatibility: state.saved?.compatibility ?? {
      savedAt: new Date().toISOString(),
      agents: initialize ? [] : legacyAgents(root, current.project),
      ...(!initialize
        ? {
            maintenanceAi: resolveAiSelection(
              root,
              process.env,
              projectAiTarget(current.project, "coder"),
            ),
          }
        : {}),
    },
  };
  if (saved.retiredInstances.length > 1024) throw invalid();
  const content = JSON.stringify(saved, null, 2) + "\n";
  if (Buffer.byteLength(content) > MAX_BYTES) throw invalid();
  // Recheck the original file before replacement: linked and malformed stores
  // cannot be repaired by silently overwriting a different protected object.
  if (
    hash(readSaved(root, current.project) ?? null) !== hash(state.saved ?? null)
  )
    throw conflict();
  writePrivate(file(root, current.project.config.name), content);
  return readState(root, current.project.config.name).view;
}
/** Readiness is checked by the controller before it authorizes an enabled profile. */
function preview(root: string, name: string, input: unknown) {
  if (
    !object(input) ||
    !only(input, ["revision", "agents"]) ||
    typeof input.revision !== "string" ||
    !/^[a-f0-9]{64}$/.test(input.revision)
  )
    throw invalid();
  const submitted = parseAgents(input.agents, true);
  const state = readState(root, name);
  if (state.view.revision !== input.revision) throw conflict();
  const areas = new Set(state.project.areas.map((area) => area.key));
  const agents = submitted.map((agent) => {
    const previous = state.view.agents.find((item) => item.key === agent.key);
    if (previous && previous.instanceId !== agent.instanceId) throw conflict();
    if (agent.areas.some((area) => !areas.has(area))) throw invalid();
    if (
      !previous &&
      agent.instanceId &&
      (state.saved?.retiredInstances.includes(agent.instanceId) ||
        state.view.agents.some((item) => item.instanceId === agent.instanceId))
    )
      throw conflict();
    return {
      ...agent,
      instanceId: previous?.instanceId ?? (agent.instanceId || randomUUID()),
    };
  });
  parseAgents(agents);
  return { state, agents };
}
/** Validate a proposed write without persisting it, for controller readiness checks. */
export function previewCodingAgents(
  root: string,
  name: string,
  input: unknown,
): CodingAgentsView {
  const { state, agents } = preview(root, name, input);
  return { ...state.view, agents };
}
export function saveCodingAgents(
  root: string,
  name: string,
  input: unknown,
): CodingAgentsView {
  return mutate(root, name, () => {
    const { state, agents } = preview(root, name, input);
    return persist(root, state, agents);
  });
}
/** Freeze legacy ownership before adopting another PM; subsequent reads are idempotent. */
export function ensureCodingAgents(
  root: string,
  name: string,
): CodingAgentsView {
  return mutate(root, name, () => {
    const state = readState(root, name);
    return state.saved ? state.view : persist(root, state, state.view.agents);
  });
}
/** New projects start with no coding agents. Never overwrite an existing document. */
export function initializeCodingAgents(
  root: string,
  name: string,
): CodingAgentsView {
  return mutate(root, name, () => {
    const state = readState(root, name);
    return state.saved ? state.view : persist(root, state, [], true);
  });
}
/** Pure staging helper for the existing deletion/restore transaction and journal. */
export function pausedCodingAgentsDocument(
  root: string,
  name: string,
  areaKey: string,
): string | undefined {
  if (!validName(areaKey)) throw invalid();
  const project = projectState(root, name).project,
    saved = readSaved(root, project);
  if (
    !saved ||
    !saved.agents.some(
      (agent) => agent.enabled && agent.areas.includes(areaKey),
    )
  )
    return undefined;
  const content =
    JSON.stringify(
      {
        ...saved,
        generation: randomBytes(32).toString("hex"),
        agents: saved.agents.map((agent) =>
          agent.areas.includes(areaKey) ? { ...agent, enabled: false } : agent,
        ),
      },
      null,
      2,
    ) + "\n";
  if (Buffer.byteLength(content) > MAX_BYTES) throw invalid();
  return content;
}
function currentState(root: string, project: Project) {
  const state = readState(root, project.config.name);
  if (
    hash([project.config, project.areas, project.tiers]) !==
    hash([state.project.config, state.project.areas, state.project.tiers])
  )
    throw conflict();
  return state;
}
const assigned = (
  state: ReturnType<typeof readState>,
  agent: CodingAgent,
  key: string,
) => {
  const area = state.project.areas.find((area) => area.key === key);
  return (
    !!area &&
    agent.areas.includes(key) &&
    (!state.saved ||
      state.saved.areaInstances[key] === (area.instanceId ?? null))
  );
};
export function codingAgentsForArea(
  root: string,
  project: Project,
  areaKey: string,
): CodingAgent[] {
  const state = currentState(root, project);
  return state.view.agents.filter(
    (agent) => agent.enabled && assigned(state, agent, areaKey),
  );
}
/** Assignment repair is relevant even when a coding agent is paused. */
export function codingAgentOwnsArea(
  root: string,
  project: Project,
  agent: CodingAgent,
  areaKey: string,
): boolean {
  const state = currentState(root, project);
  const canonical = state.view.agents.find(
    (item) => item.key === agent.key && item.instanceId === agent.instanceId,
  );
  return !!canonical && assigned(state, canonical, areaKey);
}
export interface CodingAgentJob {
  type: string;
  project?: string;
  projectInstanceId?: string;
  area?: string;
  coderKey?: string;
  coderInstanceId?: string;
  id?: string;
  status?: string;
  createdAt?: string;
  developerKind?: string;
}
const historical = (job: CodingAgentJob, cutoff: number) =>
  /^job-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(job.id ?? "") &&
  ["queued", "running"].includes(job.status ?? "") &&
  Number.isFinite(Date.parse(job.createdAt ?? "")) &&
  new Date(job.createdAt!).toISOString() === job.createdAt &&
  Date.parse(job.createdAt!) < cutoff;
function maintenance(project: Project, ai: AiSelection): CodingAgent {
  const hex = hash(["legacy-maintenance", identity(project)]).slice(0, 32);
  return {
    key: "legacy-maintenance",
    instanceId: `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20)}`,
    name: "Legacy integration maintenance",
    enabled: false,
    areas: [],
    maxConcurrent: 1,
    ai: structuredClone(ai),
  };
}
/** Only controller-stored pre-migration queued/running jobs may use a legacy snapshot. */
export function resolveCodingAgent(
  root: string,
  project: Project,
  job: CodingAgentJob,
): CodingAgent {
  const state = currentState(root, project);
  if (
    job.type !== "developer" ||
    job.project !== project.config.name ||
    job.projectInstanceId !== project.config.instanceId
  )
    throw conflict();
  if (job.coderKey !== undefined || job.coderInstanceId !== undefined) {
    const agent = state.view.agents.find(
      (agent) =>
        agent.key === job.coderKey && agent.instanceId === job.coderInstanceId,
    );
    if (!job.area || !agent || !assigned(state, agent, job.area))
      throw conflict();
    return structuredClone(agent);
  }
  if (!state.saved) {
    if (
      !job.area &&
      job.developerKind === "sync" &&
      historical(job, Date.now())
    )
      return maintenance(
        project,
        resolveAiSelection(
          root,
          process.env,
          projectAiTarget(project, "coder"),
        ),
      );
    const agent = state.view.agents.find((agent) =>
      agent.areas.includes(job.area!),
    );
    if (!agent) throw conflict();
    return structuredClone(agent);
  }
  const cutoff = Date.parse(state.saved.compatibility.savedAt);
  if (!historical(job, cutoff)) throw conflict();
  if (!job.area) {
    if (
      job.developerKind !== "sync" ||
      !state.saved.compatibility.maintenanceAi
    )
      throw conflict();
    return maintenance(project, state.saved.compatibility.maintenanceAi);
  }
  const area = state.project.areas.find((area) => area.key === job.area);
  const snapshot = state.saved.compatibility.agents.find(
    (entry) =>
      entry.area.key === job.area && entry.area.instanceId === area?.instanceId,
  );
  if (!area || !snapshot) throw conflict();
  const canonical = state.saved.agents.find(
    (agent) =>
      agent.key === snapshot.agent.key &&
      agent.instanceId === snapshot.agent.instanceId,
  );
  if (
    state.saved.retiredInstances.includes(snapshot.agent.instanceId) ||
    !canonical ||
    !assigned(state, canonical, job.area)
  )
    throw conflict();
  return structuredClone({ ...snapshot.agent, enabled: canonical.enabled });
}
export function effectiveCodingAi(
  root: string,
  project: Project,
  agent: CodingAgent,
  env: NodeJS.ProcessEnv,
  job?: CodingAgentJob,
): AiSelection {
  const state = currentState(root, project);
  if (job) {
    const selected = resolveCodingAgent(root, project, job);
    if (selected.key !== agent.key || selected.instanceId !== agent.instanceId)
      throw conflict();
  }
  if (job && !state.saved && !job.area && job.developerKind === "sync") {
    const snapshot = resolveCodingAgent(root, project, job);
    if (snapshot.instanceId !== agent.instanceId) throw conflict();
    return resolveAiSelection(root, env, projectAiTarget(project, "coder"));
  }
  if (
    job &&
    state.saved &&
    job.coderKey === undefined &&
    job.coderInstanceId === undefined
  ) {
    const snapshot = resolveCodingAgent(root, project, job);
    if (
      snapshot.key !== agent.key ||
      snapshot.instanceId !== agent.instanceId ||
      !snapshot.ai
    )
      throw conflict();
    return structuredClone(snapshot.ai);
  }
  if (!state.saved) {
    const canonical = state.view.agents.find(
      (item) => item.key === agent.key && item.instanceId === agent.instanceId,
    );
    const area = project.areas.find((area) => area.key === canonical?.areas[0]);
    if (!canonical || !area) throw conflict();
    return resolveAiSelection(
      root,
      env,
      projectAiTarget(project, "coder", area),
    );
  }
  const canonical =
    state.view.agents.find(
      (item) => item.key === agent.key && item.instanceId === agent.instanceId,
    ) ??
    state.saved.compatibility.agents.find(
      (entry) =>
        entry.agent.key === agent.key &&
        entry.agent.instanceId === agent.instanceId,
    )?.agent;
  if (!canonical) throw conflict();
  return canonical.ai
    ? structuredClone(canonical.ai)
    : resolveAiSelection(root, env, projectAiTarget(project, "coder"));
}
