import { createHash, randomBytes } from "node:crypto";
import {
  constants,
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { safeOAuthPath } from "../oauthConnection/storage.ts";
import { writePrivate } from "../remoteWorkers/storage.ts";
import {
  parseAiSelection,
  resolveWorkspaceAiSelection,
  type AiSelection,
} from "./provider.ts";

export type AiRoutingRole = "setup" | "pm" | "coder";
export interface AiRoutingScope {
  project: { name: string; instanceId?: string };
  area?: { key: string; instanceId?: string };
  role?: AiRoutingRole;
}
export type AiRoutingTarget = AiRoutingScope & { role: AiRoutingRole };
export function projectAiTarget(
  project: { config: { name: string; instanceId?: string } },
  role: AiRoutingRole,
  area?: { key: string; instanceId?: string },
): AiRoutingTarget {
  return {
    project: {
      name: project.config.name,
      ...(project.config.instanceId
        ? { instanceId: project.config.instanceId }
        : {}),
    },
    ...(area
      ? {
          area: {
            key: area.key,
            ...(area.instanceId ? { instanceId: area.instanceId } : {}),
          },
        }
      : {}),
    role,
  };
}
export type AiRoutingSource =
  "workspace" | "project-default" | "project-role" | "pm-role";
export interface EffectiveAiSelection extends AiSelection {
  source: AiRoutingSource;
}
export interface AiRoutingOverrides {
  default?: AiSelection;
  pm?: AiSelection;
  coder?: AiSelection;
}
export interface AiRoutingView {
  revision: string;
  overrides: AiRoutingOverrides;
  effective: Record<AiRoutingRole, EffectiveAiSelection>;
}
export class AiRoutingError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "AiRoutingError";
  }
}
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const only = (value: Record<string, unknown>, keys: string[]) =>
  Object.keys(value).every((key) => keys.includes(key));
const invalid = () =>
  new AiRoutingError(
    "Choose a valid project or PM and a supported AI provider/model.",
  );
const storageError = () =>
  new AiRoutingError(
    "Saved AI routes could not be read safely. Restore the protected routing settings before continuing.",
    503,
  );
function normalizedScope(value: AiRoutingScope) {
  if (
    !object(value) ||
    !only(value, ["project", "area", "role"]) ||
    !object(value.project) ||
    !only(value.project, ["name", "instanceId"]) ||
    typeof value.project.name !== "string" ||
    !/^[a-z][a-z0-9-]{0,62}$/.test(value.project.name) ||
    (value.role !== undefined && !["setup", "pm", "coder"].includes(value.role))
  )
    throw invalid();
  const incarnation = (id: unknown) =>
    id === undefined ||
    (typeof id === "string" &&
      /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id));
  if (
    !incarnation(value.project.instanceId) ||
    (value.area !== undefined &&
      (!object(value.area) ||
        !only(value.area, ["key", "instanceId"]) ||
        typeof value.area.key !== "string" ||
        !/^[a-z][a-z0-9-]{0,62}$/.test(value.area.key) ||
        !incarnation(value.area.instanceId)))
  )
    throw invalid();
  return {
    project: {
      name: value.project.name,
      ...(value.project.instanceId
        ? { instanceId: value.project.instanceId }
        : {}),
    },
    ...(value.area
      ? {
          area: {
            key: value.area.key,
            ...(value.area.instanceId
              ? { instanceId: value.area.instanceId }
              : {}),
          },
        }
      : {}),
  };
}
type Scope = ReturnType<typeof normalizedScope>;
interface SavedRoute {
  version: 1;
  scope: Scope;
  generation: string;
  overrides: AiRoutingOverrides;
}
const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const directory = (root: string) => join(resolve(root), ".run", "ai", "routes");
const file = (root: string, scope: Scope) =>
  join(directory(root), hash(scope) + ".json");
function privateJson(path: string): unknown {
  safeOAuthPath(path);
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.size > 8192 ||
      (process.platform !== "win32" && (stat.mode & 0o077) !== 0)
    )
      throw storageError();
    return JSON.parse(readFileSync(fd, "utf8"));
  } finally {
    closeSync(fd);
  }
}
function read(root: string, scope: Scope): SavedRoute | undefined {
  const path = file(root, scope);
  try {
    safeOAuthPath(path);
    if (!existsSync(path)) return undefined;
    const value = privateJson(path);
    if (
      !object(value) ||
      !only(value, ["version", "scope", "generation", "overrides"]) ||
      value.version !== 1 ||
      JSON.stringify(value.scope) !== JSON.stringify(scope) ||
      typeof value.generation !== "string" ||
      !/^[a-f0-9]{32}$/.test(value.generation) ||
      !object(value.overrides) ||
      !only(
        value.overrides,
        scope.area ? ["pm", "coder"] : ["default", "pm", "coder"],
      )
    )
      throw storageError();
    const overrides: AiRoutingOverrides = {};
    for (const role of ["default", "pm", "coder"] as const)
      if (value.overrides[role] !== undefined)
        overrides[role] = parseAiSelection(value.overrides[role]);
    return { version: 1, scope, generation: value.generation, overrides };
  } catch {
    throw storageError();
  }
}
/** Scope identities come from the controller's currently loaded project/area, never arbitrary browser paths. */
export function readAiRouting(
  root: string,
  input: AiRoutingScope,
  env: NodeJS.ProcessEnv = process.env,
): AiRoutingView {
  const scope = normalizedScope(input),
    own = read(root, scope),
    project = scope.area ? read(root, { project: scope.project }) : own,
    workspace = resolveWorkspaceAiSelection(root, env),
    baseline: EffectiveAiSelection = project?.overrides.default
      ? { ...project.overrides.default, source: "project-default" }
      : { ...workspace, source: "workspace" };
  const effective = (role: "pm" | "coder"): EffectiveAiSelection =>
    scope.area && own?.overrides[role]
      ? { ...own.overrides[role], source: "pm-role" }
      : project?.overrides[role]
        ? { ...project.overrides[role], source: "project-role" }
        : { ...baseline };
  return {
    revision: hash([
      scope,
      own?.generation ?? null,
      project?.generation ?? null,
      workspace,
    ]),
    overrides: structuredClone(own?.overrides ?? {}),
    effective: {
      setup: { ...baseline },
      pm: effective("pm"),
      coder: effective("coder"),
    },
  };
}
/** Synchronous private lock makes the revision comparison and mutation atomic across controllers. */
export function saveAiRouting(
  root: string,
  input: AiRoutingScope,
  update: unknown,
  env: NodeJS.ProcessEnv = process.env,
): AiRoutingView {
  const scope = normalizedScope(input);
  if (
    !object(update) ||
    !only(
      update,
      scope.area
        ? ["revision", "pm", "coder"]
        : ["revision", "default", "pm", "coder"],
    ) ||
    typeof update.revision !== "string" ||
    !/^[a-f0-9]{64}$/.test(update.revision)
  )
    throw invalid();
  const changes: Partial<
    Record<"default" | "pm" | "coder", AiSelection | null>
  > = {};
  for (const role of ["default", "pm", "coder"] as const)
    if (Object.hasOwn(update, role))
      changes[role] =
        update[role] === null ? null : parseAiSelection(update[role]);
  const path = directory(root),
    lock = join(path, hash({ project: scope.project }) + ".lock"),
    token = randomBytes(16).toString("hex");
  safeOAuthPath(lock);
  mkdirSync(path, { recursive: true, mode: 0o700 });
  if (existsSync(lock)) {
    try {
      const owner = privateJson(lock);
      if (
        object(owner) &&
        Number.isSafeInteger(owner.pid) &&
        Number(owner.pid) > 0
      ) {
        try {
          process.kill(Number(owner.pid), 0);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ESRCH")
            unlinkSync(lock);
        }
      }
    } catch {
      /* An unreadable lock stays closed. */
    }
  }
  try {
    writeFileSync(lock, JSON.stringify({ pid: process.pid, token }), {
      flag: "wx",
      mode: 0o600,
    });
  } catch {
    throw new AiRoutingError(
      "AI routing settings are being updated. Refresh and retry.",
      409,
    );
  }
  try {
    const current = readAiRouting(root, scope, env);
    if (current.revision !== update.revision)
      throw new AiRoutingError(
        "AI routing settings changed. Refresh before saving your choice.",
        409,
      );
    const overrides = { ...current.overrides };
    for (const role of ["default", "pm", "coder"] as const) {
      if (changes[role] === null) delete overrides[role];
      else if (changes[role]) overrides[role] = changes[role];
    }
    writePrivate(
      file(root, scope),
      JSON.stringify({
        version: 1,
        scope,
        generation: token,
        overrides,
      } satisfies SavedRoute),
    );
    return readAiRouting(root, scope, env);
  } finally {
    try {
      const owner = privateJson(lock);
      if (object(owner) && owner.token === token) unlinkSync(lock);
    } catch {
      /* Never remove a replacement lock. */
    }
  }
}
