import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { loadProject, type Project } from "../config.ts";
import {
  createDockerPlanner,
  PlannerExecutionError,
  type PlannerExecutor,
} from "../pmPlanner/docker.ts";
import { createPmKnowledge } from "../pmKnowledge/index.ts";
import { createProjectKnowledge } from "../projectKnowledge/index.ts";
import { projectRuntimeKey } from "../projectIdentity.ts";
import { readConnections } from "../setup/connections.ts";
import { assertNoSymlinks, validateName } from "../setup/files.ts";
import { redactHistory } from "../storage/activity.ts";
import {
  GRUMBLINS_SCHEMA,
  GRUMBLINS_SYSTEM,
  PROFILE_PROPERTIES,
  GrumblinError,
  validateGrumblinProfileSnapshot,
  type GrumblinProfile,
  type GrumblinProfileSnapshot,
} from "./schema.ts";
export {
  GRUMBLINS_SCHEMA,
  GrumblinError,
  validateGrumblinProfileSnapshot,
} from "./schema.ts";
export type { GrumblinProfile, GrumblinProfileSnapshot } from "./schema.ts";

export interface GrumblinsState {
  project: string;
  projectInstanceId?: string;
  revision: string;
  contextRevision: string;
  profiles: GrumblinProfile[];
  simulation: true;
  stale: boolean;
  generatedAt?: string;
  contextSummary?: string;
  focus?: string;
}
interface Saved extends Omit<GrumblinsState, "stale"> {
  schema: 1;
  identity: string;
  generatedAt: string;
  contextSummary: string;
}
export interface GrumblinsOptions {
  root: string;
  packageRoot: string;
  execute?: PlannerExecutor;
  env?: NodeJS.ProcessEnv;
  /** A host/test may shorten, never extend, the three minute generation limit. */
  timeoutMs?: number;
}
const busy = new Set<string>();
const digest = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const record = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);
function safeText(value: unknown, max: number): value is string {
  return (
    typeof value === "string" &&
    Boolean(value.trim()) &&
    value.length <= max &&
    !/\p{Cc}/u.test(value.replace(/[\r\n\t]/g, ""))
  );
}
const profileOnly = (snapshot: GrumblinProfileSnapshot): GrumblinProfile =>
  Object.fromEntries(
    ["id", ...Object.keys(PROFILE_PROPERTIES)].map((key) => [
      key,
      snapshot[key as keyof GrumblinProfileSnapshot],
    ]),
  ) as unknown as GrumblinProfile;

export function createGrumblins(options: GrumblinsOptions) {
  const execute =
    options.execute ??
    createDockerPlanner({ packageRoot: options.packageRoot });
  const credentials = () => ({
    ...readConnections(options.root),
    ...(options.env ?? process.env),
  });
  const secrets = () =>
    Object.entries(credentials())
      .filter(
        ([key, value]) =>
          value && /TOKEN|SECRET|KEY|PASSWORD|CREDENTIAL/.test(key),
      )
      .map(([, value]) => value!);
  const redact = (value: string) => redactHistory(value, secrets());
  const pmKnowledge = createPmKnowledge({ root: options.root, secrets });
  const projectKnowledge = createProjectKnowledge({
    root: options.root,
    secrets,
  });
  function project(name: string) {
    try {
      validateName(name, "project");
      const dir = join(options.root, "projects", name);
      for (const file of [
        dir,
        join(dir, "project.json"),
        join(dir, "areas.json"),
        join(dir, "tiers.json"),
      ])
        assertNoSymlinks(file);
      const current = loadProject(options.root, name),
        info = lstatSync(current.dir);
      const identity = digest({
        name,
        instanceId: current.config.instanceId ?? null,
        repo: current.config.repo,
        provider: current.config.provider ?? "github",
        server: current.config.serverUrl ?? null,
        ...(current.config.instanceId
          ? {}
          : { directory: [info.dev, info.ino, info.birthtimeMs] }),
      });
      const key =
        projectRuntimeKey(current.config) +
        (current.config.instanceId ? "" : `~legacy-${identity.slice(0, 16)}`);
      const file = join(
        options.root,
        ".run",
        "grumblins",
        key,
        "profiles.json",
      );
      assertNoSymlinks(file);
      return { current, identity, file };
    } catch {
      throw new GrumblinError(
        "This project is unavailable or cannot be read safely. Refresh the project before generating Grumblins.",
        409,
      );
    }
  }
  function context(current: Project, includeKnowledge: boolean) {
    let remaining = 64000,
      truncated = false;
    const take = (text: string, maximum: number) => {
      const clean = redact(text),
        length = Math.max(0, Math.min(maximum, remaining));
      remaining -= Math.min(length, clean.length);
      if (clean.length > length) truncated = true;
      return clean.slice(0, length);
    };
    const directions = current.areas.map((area) => {
      const mandateFile = join(current.dir, area.key, "mandate.md");
      assertNoSymlinks(mandateFile);
      let mandate = "";
      if (existsSync(mandateFile)) {
        const info = lstatSync(mandateFile);
        if (!info.isFile() || info.nlink !== 1 || info.size > 65536)
          throw new GrumblinError(
            "A PM mandate cannot be read safely. Repair it before generating Grumblins.",
            409,
          );
        mandate = readFileSync(mandateFile, "utf8");
      }
      return {
        key: area.key,
        instanceId: area.instanceId ?? null,
        name: area.name,
        charter: area.charter ?? {},
        mandate: [area.mandate ?? "", mandate].filter(Boolean).join("\n"),
        paths: area.paths,
        sharedTouchpoints: area.sharedTouchpoints,
      };
    });
    const decisions = projectKnowledge.read(current.config.name).decisions;
    // Routine new observations do not change owner purpose or invalidate the
    // other profiles after the first simulation. Owner edits do.
    const contextRevision = digest({
      project: {
        name: current.config.name,
        instanceId: current.config.instanceId ?? null,
        repo: current.config.repo,
        provider: current.config.provider,
        serverUrl: current.config.serverUrl,
        branches: current.config.branches,
        workflow: current.config.workflow,
        verification: current.config.verification,
      },
      directions,
      decisions,
    });
    if (!includeKnowledge) return { contextRevision };
    const areaCount = Math.max(1, Math.min(20, current.areas.length));
    const ownerDecisions: string[] = [];
    let decisionBudget = 12000;
    for (const decision of decisions.slice(-20).reverse()) {
      // Preserve selected owner decisions whole so truncation cannot remove a
      // restriction from the end of a decision and reverse its meaning.
      if (decision.text.length > decisionBudget) break;
      ownerDecisions.push(take(decision.text, decision.text.length));
      decisionBudget -= decision.text.length;
    }
    const ownerDirection = directions.slice(0, 20).map((area) => ({
      key: area.key,
      name: take(area.name, 100),
      charter: take(
        JSON.stringify(area.charter),
        Math.min(3000, Math.floor(18000 / areaCount)),
      ),
      mandate: take(
        area.mandate,
        Math.min(3000, Math.floor(18000 / areaCount)),
      ),
    }));
    const retainedObservations = current.areas.slice(0, 20).map((area) => {
      try {
        const notes = pmKnowledge.read(current.config.name, area.key);
        return {
          area: area.key,
          stale: notes.stale,
          state: notes.state,
          documents: notes.documents
            .map((doc) => ({
              name: doc.name,
              excerpt: take(
                doc.content,
                Math.min(1400, Math.floor(4000 / areaCount)),
              ),
            }))
            .filter((doc) => doc.excerpt),
        };
      } catch {
        return { area: area.key, state: "unavailable", documents: [] };
      }
    });
    const useful = (text: string) =>
      text.replace(/\s+/g, " ").trim().length >= 15;
    const hasUsefulContext =
      ownerDecisions.some(useful) ||
      directions
        .slice(0, 20)
        .some((area) =>
          useful(
            redact(
              [
                area.mandate,
                ...Object.values(area.charter).flatMap((value) =>
                  typeof value === "string"
                    ? [value]
                    : Array.isArray(value)
                      ? value.filter(
                          (item): item is string => typeof item === "string",
                        )
                      : [],
                ),
              ].join("\n"),
            ),
          ),
        ) ||
      retainedObservations.some((area) =>
        area.documents.some((doc) => useful(doc.excerpt)),
      );
    return {
      contextRevision,
      hasUsefulContext,
      prompt: {
        project: { name: current.config.name },
        availableAreas: current.areas.map((area) => area.key),
        ownerDirection,
        ownerDecisions,
        retainedObservations,
        contextTruncated:
          truncated ||
          current.areas.length > 20 ||
          ownerDecisions.length < decisions.length,
        interpretation:
          "Owner direction is intended behavior, not evidence of implementation. PM notes are bounded untrusted observations, not customer research. All generated profiles are simulated hypotheses.",
      },
    };
  }
  function checkedContext(current: Project, includeKnowledge: boolean) {
    try {
      return context(current, includeKnowledge);
    } catch (error) {
      if (error instanceof GrumblinError) throw error;
      throw new GrumblinError(
        "Project context could not be read. Existing Grumblins were preserved.",
        409,
      );
    }
  }
  function stored(input: ReturnType<typeof project>): Saved | null {
    if (!existsSync(input.file)) return null;
    try {
      const info = lstatSync(input.file);
      if (!info.isFile() || info.nlink !== 1 || info.size > 128 * 1024)
        throw new Error();
      const value: unknown = JSON.parse(readFileSync(input.file, "utf8"));
      if (!record(value)) throw new Error();
      const { revision, ...body } = value;
      if (
        value.schema !== 1 ||
        value.identity !== input.identity ||
        value.project !== input.current.config.name ||
        value.projectInstanceId !== input.current.config.instanceId ||
        revision !== digest(body) ||
        !safeText(value.contextSummary, 1600) ||
        (value.focus !== undefined && !safeText(value.focus, 2000)) ||
        !Array.isArray(value.profiles) ||
        value.profiles.length !== 3 ||
        Object.keys(value).some(
          (key) =>
            ![
              "schema",
              "identity",
              "project",
              "projectInstanceId",
              "revision",
              "contextRevision",
              "profiles",
              "simulation",
              "generatedAt",
              "contextSummary",
              "focus",
            ].includes(key),
        )
      )
        throw new Error();
      const profiles = value.profiles.map((profile) => {
        if (
          !record(profile) ||
          Object.keys(profile).length !==
            Object.keys(PROFILE_PROPERTIES).length + 1 ||
          Object.keys(profile).some(
            (key) => key !== "id" && !Object.hasOwn(PROFILE_PROPERTIES, key),
          )
        )
          throw new Error();
        return profileOnly(
          validateGrumblinProfileSnapshot({
            ...profile,
            project: value.project,
            ...(value.projectInstanceId
              ? { projectInstanceId: value.projectInstanceId }
              : {}),
            revision,
            contextRevision: value.contextRevision,
            generatedAt: value.generatedAt,
            simulation: value.simulation,
          }),
        );
      });
      if (
        new Set(profiles.map((p) => p.id)).size !== 3 ||
        new Set(profiles.map((p) => p.key)).size !== 3 ||
        redact(JSON.stringify(value)) !== JSON.stringify(value)
      )
        throw new Error();
      return { ...value, profiles } as unknown as Saved;
    } catch {
      throw new GrumblinError(
        "Saved Grumblins need repair. Their existing data was preserved; generate a fresh set to replace it.",
        409,
      );
    }
  }
  function present(
    input: ReturnType<typeof project>,
    saved: Saved | null,
    contextRevision: string,
  ): GrumblinsState {
    if (!saved)
      return {
        project: input.current.config.name,
        ...(input.current.config.instanceId
          ? { projectInstanceId: input.current.config.instanceId }
          : {}),
        revision: digest({
          identity: input.identity,
          contextRevision,
          empty: true,
        }),
        contextRevision,
        profiles: [],
        simulation: true,
        stale: false,
      };
    const { schema: _schema, identity: _identity, ...output } = saved;
    return { ...output, stale: saved.contextRevision !== contextRevision };
  }
  function read(name: string): GrumblinsState {
    const input = project(name),
      source = checkedContext(input.current, false);
    return present(input, stored(input), source.contextRevision);
  }
  function lock(file: string): () => void {
    assertNoSymlinks(file);
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    let fd: number;
    try {
      fd = openSync(file, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const info = lstatSync(file);
      if (!info.isFile() || info.nlink !== 1 || info.size > 100)
        throw new GrumblinError(
          "Grumblin generation is locked. Existing profiles were preserved.",
          409,
        );
      const pid = Number(readFileSync(file, "utf8"));
      let dead = false;
      if (Number.isSafeInteger(pid) && pid > 0)
        try {
          process.kill(pid, 0);
        } catch (cause) {
          dead = (cause as NodeJS.ErrnoException).code === "ESRCH";
        }
      if (!dead)
        throw new GrumblinError(
          "Grumblins are already being generated for this project. Wait or cancel that request first.",
          409,
        );
      unlinkSync(file);
      fd = openSync(file, "wx", 0o600);
    }
    writeFileSync(fd, String(process.pid));
    return () => {
      closeSync(fd);
      if (existsSync(file)) unlinkSync(file);
    };
  }
  function write(file: string, value: Saved) {
    assertNoSymlinks(file);
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      const fd = openSync(temporary, "wx", 0o600);
      try {
        writeFileSync(fd, JSON.stringify(value, null, 2) + "\n");
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(temporary, file);
    } finally {
      if (existsSync(temporary)) unlinkSync(temporary);
    }
  }
  async function generate({
    project: name,
    focus,
    signal,
  }: {
    project: string;
    focus?: string;
    signal?: AbortSignal;
  }): Promise<GrumblinsState> {
    if (
      focus !== undefined &&
      (!safeText(focus, 2000) || redact(focus) !== focus)
    )
      throw new GrumblinError(
        "Describe the focus in 1–2000 characters without credentials or private customer data.",
      );
    const first = project(name),
      lockKey = `${resolve(options.root)}:${name}`;
    if (busy.has(lockKey))
      throw new GrumblinError(
        "Grumblins are already being generated for this project.",
        409,
      );
    const credential = credentials().CLAUDE_CODE_OAUTH_TOKEN;
    if (!credential)
      throw new GrumblinError(
        "Connect Claude Code in Connections before generating Grumblins.",
      );
    const duration = Number.isFinite(options.timeoutMs)
      ? Math.max(1, Math.min(options.timeoutMs!, 180000))
      : 180000;
    const bounded = AbortSignal.any([
      AbortSignal.timeout(duration),
      ...(signal ? [signal] : []),
    ]);
    let unlock: (() => void) | undefined;
    busy.add(lockKey);
    try {
      bounded.throwIfAborted();
      unlock = lock(join(dirname(first.file), "generation.lock"));
      const source = checkedContext(first.current, true);
      if (!source.hasUsefulContext && (focus?.trim().length ?? 0) < 15)
        throw new GrumblinError(
          "Tell us what this app does and who it helps in the focus field (at least 15 characters), or save a PM product brief first.",
        );
      const output = await new Promise<unknown>((accept, reject) => {
        const abort = () =>
          reject(
            new GrumblinError(
              "Grumblin generation stopped. Existing profiles were preserved.",
              408,
            ),
          );
        bounded.addEventListener("abort", abort, { once: true });
        execute({
          credential,
          system: GRUMBLINS_SYSTEM,
          schema: GRUMBLINS_SCHEMA,
          prompt: JSON.stringify({
            ...source.prompt,
            ...(focus ? { focus } : {}),
          }),
          signal: bounded,
        })
          .then(accept, reject)
          .finally(() => bounded.removeEventListener("abort", abort));
      });
      bounded.throwIfAborted();
      const encoded = JSON.stringify(output);
      if (
        !encoded ||
        Buffer.byteLength(encoded) > 65536 ||
        redact(encoded) !== encoded ||
        !record(output) ||
        Object.keys(output).length !== 2 ||
        !safeText(output.contextSummary, 1600) ||
        !Array.isArray(output.profiles) ||
        output.profiles.length !== 3
      )
        throw new GrumblinError(
          "Claude did not return three valid simulated profiles. Try generating again.",
          422,
        );
      const generatedAt = new Date().toISOString();
      const profiles = output.profiles.map((draft) => {
        if (
          !record(draft) ||
          Object.keys(draft).length !==
            Object.keys(PROFILE_PROPERTIES).length ||
          Object.keys(draft).some(
            (key) => !Object.hasOwn(PROFILE_PROPERTIES, key),
          )
        )
          throw new GrumblinError(
            "A generated profile was incomplete. Try generating again.",
            422,
          );
        const profile = profileOnly(
          validateGrumblinProfileSnapshot({
            ...draft,
            id: randomUUID(),
            project: name,
            revision: "0".repeat(64),
            contextRevision: source.contextRevision,
            generatedAt,
            simulation: true,
          }),
        );
        if (
          first.current.areas.length
            ? !first.current.areas.some(
                (area) => area.key === profile.suggestedArea,
              )
            : profile.suggestedArea !== null
        )
          throw new GrumblinError(
            "A Grumblin suggested a PM that does not belong to this project. Generate a fresh set.",
            422,
          );
        return profile;
      });
      if (
        new Set(profiles.map((p) => p.key)).size !== 3 ||
        new Set(profiles.map((p) => p.name.toLowerCase())).size !== 3
      )
        throw new GrumblinError(
          "Grumblins must have three distinct identities. Generate a fresh set.",
          422,
        );
      const latest = project(name),
        latestContext = checkedContext(latest.current, false);
      if (
        latest.identity !== first.identity ||
        latestContext.contextRevision !== source.contextRevision
      )
        throw new GrumblinError(
          "Project direction changed while Grumblins were being generated. Existing profiles were preserved; generate again for the current project.",
          409,
        );
      bounded.throwIfAborted();
      const body = {
        schema: 1 as const,
        identity: first.identity,
        project: name,
        ...(first.current.config.instanceId
          ? { projectInstanceId: first.current.config.instanceId }
          : {}),
        contextRevision: source.contextRevision,
        profiles,
        generatedAt,
        contextSummary: output.contextSummary,
        simulation: true as const,
        ...(focus ? { focus } : {}),
      };
      const saved: Saved = { ...body, revision: digest(body) };
      write(first.file, saved);
      return present(first, saved, source.contextRevision);
    } catch (error) {
      if (error instanceof GrumblinError) throw error;
      if (error instanceof PlannerExecutionError)
        throw new GrumblinError(error.message, 503);
      throw new GrumblinError(
        bounded.aborted
          ? "Grumblin generation stopped. Existing profiles were preserved."
          : "Grumblin generation could not finish. Check Claude Code and Docker, then retry. Existing profiles were preserved.",
        bounded.aborted ? 408 : 503,
      );
    } finally {
      try {
        unlock?.();
      } finally {
        busy.delete(lockKey);
      }
    }
  }
  function profile(
    name: string,
    id: string,
    revision: string,
  ): GrumblinProfileSnapshot {
    const current = read(name);
    if (current.stale || current.revision !== revision)
      throw new GrumblinError(
        "Project direction or the Grumblin roster changed. Review a fresh set before starting a run.",
        409,
      );
    const selected = current.profiles.find((item) => item.id === id);
    if (!selected || !current.generatedAt)
      throw new GrumblinError(
        "Choose a saved Grumblin from this project.",
        404,
      );
    return validateGrumblinProfileSnapshot({
      ...selected,
      project: name,
      ...(current.projectInstanceId
        ? { projectInstanceId: current.projectInstanceId }
        : {}),
      revision: current.revision,
      contextRevision: current.contextRevision,
      generatedAt: current.generatedAt,
      simulation: true,
    });
  }
  return { read, generate, profile };
}
