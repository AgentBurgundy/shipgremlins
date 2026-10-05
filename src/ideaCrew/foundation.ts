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
import { projectRuntimeKey } from "../projectIdentity.ts";
import { baseBranch, effectiveVerification } from "../projectCapabilities.ts";
import { assertNoSymlinks, validateName } from "../setup/files.ts";
import { LABELS } from "../dispatcher/notes.ts";
import {
  readRepository,
  type RepositorySnapshot,
} from "../projectOnboarding/repository.ts";
import type { SourceControl } from "../sourceControl/types.ts";
import type { LinearApi } from "../services/linear.ts";
import type { LocalJob, LocalJobInput } from "../localRunners/types.ts";
import type { IdeaCrew } from "./index.ts";
import { IdeaCrewError } from "./plan.ts";
import { readPrivate, dead } from "../projectOnboarding/store.ts";

const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const busy = new Set<string>();
/** Match immutable Linear identity across the foundation and ordinary Coding entry points. */
export function sameCodingTicket(job: LocalJob, input: LocalJobInput): boolean {
  if (
    job.type !== "developer" ||
    input.type !== "developer" ||
    job.project !== input.project ||
    job.projectInstanceId !== input.projectInstanceId
  )
    return false;
  const previous = job.linearBinding,
    current = input.linearBinding;
  if (
    !previous?.ticketId ||
    !current?.ticketId ||
    previous.ticketId !== current.ticketId
  )
    return false;
  return previous.workspaceId && current.workspaceId
    ? previous.workspaceId === current.workspaceId
    : previous.connectionId === current.connectionId;
}
interface FoundationState {
  schema: 1;
  binding: string;
  reviewRevision: string;
  ticket?: {
    id: string;
    identifier?: string;
    url?: string;
    mapping: string;
    description: string;
  };
  attempt: number;
  jobId?: string;
  inspected?: { sha: string; branch: string; at: string; hasApp: boolean };
}
function binding(project: Project) {
  return digest({
    instance: project.config.instanceId,
    idea: project.config.ideaPlanId,
    repo: project.config.repo,
    provider: project.config.provider ?? "github",
    server: project.config.serverUrl,
    branch: baseBranch(project.config),
  });
}
function statePath(root: string, project: Project) {
  validateName(project.config.name, "project");
  const file = join(
    root,
    ".run",
    "foundation",
    `${projectRuntimeKey(project.config)}.json`,
  );
  assertNoSymlinks(file);
  if (
    existsSync(file) &&
    (!lstatSync(file).isFile() ||
      lstatSync(file).nlink !== 1 ||
      lstatSync(file).size > 128 * 1024)
  )
    throw new IdeaCrewError(
      "The saved foundation build cannot be read safely.",
      409,
    );
  return file;
}
function readState(
  root: string,
  project: Project,
): FoundationState | undefined {
  const file = statePath(root, project);
  if (!existsSync(file)) return;
  const saved = JSON.parse(readFileSync(file, "utf8")) as FoundationState;
  if (
    saved.schema !== 1 ||
    saved.binding !== binding(project) ||
    !Number.isInteger(saved.attempt) ||
    saved.attempt < 0
  )
    throw new IdeaCrewError(
      "The project destination changed after foundation setup. Restore its original settings before resuming the build.",
      409,
    );
  return saved;
}
function writeState(root: string, project: Project, state: FoundationState) {
  const file = statePath(root, project);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const fd = openSync(temporary, "wx", 0o600);
    try {
      writeFileSync(fd, JSON.stringify(state, null, 2) + "\n");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, file);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}

/** A cached source observation, not a claim that the application has passed runtime tests. */
export function foundationNeeded(root: string, project: Project): boolean {
  if (!project.config.ideaPlanId) return false;
  try {
    return readState(root, project)?.inspected?.hasApp !== true;
  } catch {
    return true;
  }
}

export function foundationSummary(
  root: string,
  project: Project,
  jobs: LocalJob[] = [],
) {
  if (!project.config.ideaPlanId) return undefined;
  try {
    const state = readState(root, project),
      job = jobs.find((job) => job.id === state?.jobId);
    const needed = state?.inspected?.hasApp !== true;
    return {
      needed,
      stage: !needed
        ? "ready"
        : job?.status === "queued"
          ? "queued"
          : job?.status === "running"
            ? "building"
            : job?.status === "succeeded"
              ? "review-code"
              : job
                ? "failed"
                : "review",
    };
  } catch {
    return { needed: true, stage: "failed" };
  }
}

export function snapshotHasApp(snapshot: RepositorySnapshot): boolean {
  const manifest = snapshot.files.find((file) => file.path === "package.json");
  if (!manifest) return false;
  try {
    const pkg = JSON.parse(manifest.content);
    return (
      typeof pkg.scripts?.start === "string" &&
      pkg.scripts.start.trim().length > 0 &&
      typeof pkg.scripts?.test === "string" &&
      pkg.scripts.test.trim().length > 0 &&
      snapshot.paths.some(
        (path) =>
          /\.(?:[cm]?js|jsx|tsx?|html|vue|svelte)$/.test(path) &&
          !/(^|\/)(?:tests?|__tests__|node_modules)\/|\.(?:test|spec)\./.test(
            path,
          ),
      ) &&
      snapshot.paths.some((path) =>
        /(?:^|\/)(?:tests?|__tests__)\/|\.(?:test|spec)\.[cm]?[jt]sx?$/.test(
          path,
        ),
      )
    );
  } catch {
    return false;
  }
}

export interface FoundationOptions {
  root: string;
  ideaCrew: Pick<IdeaCrew, "get">;
  sourceControl: Pick<SourceControl, "resolveCredential">;
  fetch?: typeof fetch;
  inspect?: (project: Project) => Promise<RepositorySnapshot>;
  provision: (project: string) => Promise<void>;
  verify: (project: string) => Promise<void>;
  preflight: (project: string) => Promise<void>;
  linear: (
    project: Project,
  ) => Promise<Pick<LinearApi, "getTicket" | "createTicket" | "ensureLabels">>;
  enqueue: (input: LocalJobInput) => Promise<LocalJob>;
  jobs: () => Promise<LocalJob[]>;
  job: (id: string) => Promise<LocalJob | null>;
}

export function createFoundation(options: FoundationOptions) {
  const { root } = options;
  function review(name: string) {
    const project = loadProject(root, name);
    if (!project.config.ideaPlanId)
      throw new IdeaCrewError(
        "This project was not created from an idea.",
        409,
      );
    const draft = options.ideaCrew.get(project.config.ideaPlanId);
    if (
      !draft.complete ||
      draft.project !== name ||
      draft.destination?.repo !== project.config.repo ||
      (draft.destination.provider ?? "github") !==
        (project.config.provider ?? "github") ||
      draft.destination.serverUrl !== project.config.serverUrl
    )
      throw new IdeaCrewError(
        "Finish creating this idea's repository and crew before building its foundation.",
        409,
      );
    const area = project.areas.find((area) => area.key === "foundation");
    if (!area)
      throw new IdeaCrewError(
        "Restore the foundation PM before starting the first build.",
        409,
      );
    const member = draft.plan.crew[0]!;
    const title = `Build the first working version of ${draft.plan.name}`;
    const description = [
      `# ${title}`,
      draft.plan.summary,
      `## First milestone\n${draft.plan.firstMilestone}`,
      `## Foundation assignment\n${member.firstTask}`,
      `## Acceptance criteria\n${member.acceptanceCriteria.map((item) => `- ${item}`).join("\n")}`,
      `## Assumptions to confirm\n${draft.plan.assumptions.map((item) => `- ${item}`).join("\n")}`,
      `## Build requirements\n- Implement one shared Node.js web app and its first complete user journey.\n- Include package.json, a working npm start command, and meaningful npm test checks for the journey.\n- Use synthetic fixtures or a mock adapter when credentials or external services are unavailable.\n- Document local startup and configuration. Include a Dockerfile suitable for a later isolated test environment.\n- Run the checks and record their evidence in the draft pull request.\n- Preserve existing source and owner changes; inspect the repository before editing.`,
      `## Product ownership\n${member.mission}`,
      `## Out of scope\n${draft.plan.nonGoals.map((item) => `- ${item}`).join("\n")}\n- No production deployment, secret creation, or automatic merge.`,
      `Owner approval is limited to this foundation build. Other PM schedules remain paused.\n\n<!-- ShipGremlins foundation: ${draft.id} -->`,
    ].join("\n\n");
    return {
      project,
      draft,
      area,
      title,
      description,
      revision: digest({
        binding: binding(project),
        draft: draft.revision,
        description,
        mandate: area.mandate,
        paths: area.paths,
        charter: area.charter,
      }),
    };
  }
  const key = (project: Project, state: FoundationState) =>
    `foundation:${project.config.ideaPlanId}:${project.config.instanceId ?? project.config.name}:${state.attempt}`;
  async function currentJob(project: Project, state?: FoundationState) {
    if (!state) return null;
    const found = state.jobId ? await options.job(state.jobId) : null;
    const history = await options.jobs(),
      mapping = project.config.linear,
      area = project.areas.find((area) => area.key === "foundation");
    const mappingMatches =
      state.ticket &&
      area &&
      state.ticket.mapping ===
        digest({
          connection: mapping?.connectionId ?? "default",
          workspace: mapping?.workspaceId,
          team: mapping?.teamId,
          project: area.linearProjectId,
        });
    const related = mappingMatches
      ? history
          .filter((job) =>
            sameCodingTicket(job, {
              type: "developer",
              project: project.config.name,
              projectInstanceId: project.config.instanceId,
              linearBinding: {
                connectionId: mapping?.connectionId ?? "default",
                workspaceId: mapping?.workspaceId,
                ticketId: state.ticket!.id,
              },
            }),
          )
          .sort((a, b) => b.runId - a.runId)
      : [];
    return (
      related.find((job) =>
        ["queued", "running", "succeeded"].includes(job.status),
      ) ??
      found ??
      history.find((job) => job.idempotencyKey === key(project, state)) ??
      related[0] ??
      null
    );
  }
  async function status(name: string) {
    const project = loadProject(root, name),
      saved = readState(root, project);
    // Once identity-bound source inspection is complete, Environment no longer
    // depends on retaining the initial planning document or its foundation PM.
    const current = saved?.inspected?.hasApp ? undefined : review(name),
      job = saved?.inspected?.hasApp
        ? await currentJob(project, saved).catch(() => null)
        : await currentJob(project, saved);
    const stage = saved?.inspected?.hasApp
      ? "ready"
      : job?.status === "queued"
        ? "queued"
        : job?.status === "running"
          ? "building"
          : job?.status === "succeeded"
            ? "review-code"
            : job
              ? "failed"
              : "review";
    return {
      stage,
      revision: current?.revision ?? saved!.reviewRevision,
      title: current?.title ?? "Your application has a foundation.",
      summary:
        current?.draft.plan.summary ??
        "Application source and startup/test commands were found on the base branch.",
      milestone: current?.draft.plan.firstMilestone ?? "",
      assignment: current?.draft.plan.crew[0]!.firstTask ?? "",
      acceptanceCriteria: current?.draft.plan.crew[0]!.acceptanceCriteria ?? [],
      nonGoals: current?.draft.plan.nonGoals ?? [],
      brief: current?.area.mandate,
      buildBrief: current?.description ?? "",
      ticket: saved?.ticket?.identifier
        ? { identifier: saved.ticket.identifier, url: saved.ticket.url }
        : undefined,
      job: job
        ? {
            id: job.id,
            runId: job.runId,
            status: job.status,
            message: job.message,
          }
        : undefined,
      inspected: saved?.inspected,
    };
  }
  async function inspect(project: Project) {
    if (options.inspect) return options.inspect(project);
    const credential = await options.sourceControl.resolveCredential({
      provider: project.config.provider ?? "github",
      repository: project.config.repo,
      serverUrl: project.config.serverUrl,
      minValidityMs: 60_000,
    });
    const branch = baseBranch(project.config);
    const snapshot = await readRepository(
      {
        ...project,
        config: {
          ...project.config,
          workflow: { kind: "pull-request", baseBranch: branch },
          verification: { mode: "repository" },
        },
      },
      credential.token,
      options.fetch ?? fetch,
      AbortSignal.timeout(45_000),
      [credential.token],
    );
    if (snapshot.usedDefaultBranch || snapshot.repository.branch !== branch)
      throw new IdeaCrewError(
        "The configured base branch could not be inspected. Check its name and merge the foundation there before checking again.",
        409,
      );
    return snapshot;
  }
  async function observed(project: Project, state: FoundationState) {
    const snapshot = await inspect(project);
    state.inspected = {
      sha: snapshot.repository.sha,
      branch: snapshot.repository.branch,
      at: new Date().toISOString(),
      hasApp: snapshotHasApp(snapshot),
    };
    writeState(root, project, state);
    return state.inspected.hasApp;
  }
  async function locked<T>(name: string, action: () => Promise<T>) {
    const lock = `${resolve(root)}:${name}`;
    if (busy.has(lock))
      throw new IdeaCrewError(
        "Foundation setup is already running. Wait a moment, then refresh.",
        409,
      );
    const path = `${statePath(root, loadProject(root, name))}.lock`;
    const ownership = JSON.stringify({ pid: process.pid, token: randomUUID() });
    let fd: number | undefined;
    busy.add(lock);
    try {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      const previous = readPrivate(path, 1024);
      if (previous) {
        const owner = JSON.parse(previous);
        if (
          Number.isSafeInteger(owner.pid) &&
          owner.pid > 0 &&
          dead(owner.pid) &&
          readPrivate(path, 1024) === previous
        )
          unlinkSync(path);
      }
      try {
        fd = openSync(path, "wx", 0o600);
      } catch {
        throw new IdeaCrewError(
          "Another controller is setting up this foundation. Wait for it to finish, then refresh.",
          409,
        );
      }
      writeFileSync(fd, ownership);
      fsyncSync(fd);
      return await action();
    } finally {
      try {
        if (fd !== undefined) {
          closeSync(fd);
          if (readPrivate(path, 1024) === ownership) unlinkSync(path);
        }
      } finally {
        busy.delete(lock);
      }
    }
  }
  return {
    status,
    needed: (name: string) => foundationNeeded(root, loadProject(root, name)),
    inspect: (name: string) =>
      locked(name, async () => {
        const project = loadProject(root, name),
          previous = readState(root, project);
        const state = previous ?? {
          schema: 1 as const,
          binding: binding(project),
          reviewRevision: review(name).revision,
          attempt: 0,
        };
        await observed(project, state);
        return status(name);
      }),
    start: (name: string, input: { revision: string; retryJobId?: string }) =>
      locked(name, async () => {
        if (readState(root, loadProject(root, name))?.inspected?.hasApp)
          return status(name);
        let current = review(name);
        if (input.revision !== current.revision)
          throw new IdeaCrewError(
            "The foundation brief changed. Review it again before building.",
            409,
          );
        let state = readState(root, current.project);
        if (state?.ticket && state.reviewRevision !== current.revision)
          throw new IdeaCrewError(
            "The approved foundation ticket uses an earlier brief. Review its existing work in Linear before changing the scope.",
            409,
          );
        state ??= {
          schema: 1,
          binding: binding(current.project),
          reviewRevision: current.revision,
          attempt: 0,
        };
        if (!state.ticket) state.reviewRevision = current.revision;
        const job = await currentJob(current.project, state);
        if (job) {
          state.jobId = job.id;
          writeState(root, current.project, state);
          if (
            !["failed", "canceled"].includes(job.status) ||
            input.retryJobId !== job.id
          )
            return status(name);
          state.attempt++;
          delete state.jobId;
        } else if (input.retryJobId)
          throw new IdeaCrewError(
            "That run is no longer the current foundation attempt. Refresh before retrying.",
            409,
          );
        if (state.inspected?.hasApp || (await observed(current.project, state)))
          return status(name);
        if (effectiveVerification(current.project.config).mode !== "repository")
          throw new IdeaCrewError(
            "Use repository checks for the first build; a running test environment is not needed yet.",
            409,
          );
        await options.preflight(name);
        await options.provision(name);
        current = review(name);
        if (input.revision !== current.revision)
          throw new IdeaCrewError(
            "Project or PM scope changed during setup. Refresh the foundation review.",
            409,
          );
        await options.verify(name);
        current = review(name);
        if (input.revision !== current.revision)
          throw new IdeaCrewError(
            "Project or PM scope changed during verification. Review the foundation brief again.",
            409,
          );
        const mapping = current.project.config.linear,
          area = current.area;
        if (
          !mapping?.teamId ||
          !area.linearProjectId ||
          area.linearProjectId.startsWith("PASTE_")
        )
          throw new IdeaCrewError(
            "Connect Linear so the foundation ticket can be tracked.",
            409,
          );
        const mappingKey = digest({
          connection: mapping.connectionId ?? "default",
          workspace: mapping.workspaceId,
          team: mapping.teamId,
          project: area.linearProjectId,
        });
        if (state.ticket && state.ticket.mapping !== mappingKey)
          throw new IdeaCrewError(
            "The Linear destination changed after the ticket was approved. Restore its original mapping to resume.",
            409,
          );
        state.ticket ??= {
          id: randomUUID(),
          mapping: mappingKey,
          description: current.description,
        };
        // Reserve the issue identity before writing to Linear. A lost response is recovered by UUID.
        writeState(root, current.project, state);
        const client = await options.linear(current.project);
        let ticket = await client.getTicket(state.ticket.id);
        if (!ticket) {
          if (state.ticket.identifier)
            throw new IdeaCrewError(
              "The saved foundation ticket is unavailable. Restore access to that issue before resuming; no replacement was created.",
              409,
            );
          await client.ensureLabels(mapping.teamId, [
            area.label,
            LABELS.approved,
          ]);
          ticket = await client.createTicket({
            id: state.ticket.id,
            teamId: mapping.teamId,
            projectId: area.linearProjectId,
            title: current.title,
            description: state.ticket.description,
            labels: [area.label, LABELS.approved],
            priority: 2,
          });
        }
        if (
          ticket.id !== state.ticket.id ||
          ticket.teamId !== mapping.teamId ||
          ticket.projectId !== area.linearProjectId ||
          ticket.description !== state.ticket.description ||
          !ticket.labels.some(
            (label) => label.toLowerCase() === LABELS.approved.toLowerCase(),
          ) ||
          !ticket.labels.some(
            (label) => label.toLowerCase() === area.label.toLowerCase(),
          ) ||
          ["completed", "canceled"].includes(ticket.stateType)
        )
          throw new IdeaCrewError(
            "The foundation ticket changed or is no longer approved. Review it in Linear; no duplicate ticket was created.",
            409,
          );
        state.ticket.identifier = ticket.identifier;
        state.ticket.url = ticket.url;
        writeState(root, current.project, state);
        if (review(name).revision !== input.revision)
          throw new IdeaCrewError(
            "Project or PM scope changed while preparing the ticket. Review the foundation again before starting its coding run.",
            409,
          );
        const queued = await options.enqueue({
          type: "developer",
          project: name,
          projectInstanceId: current.project.config.instanceId,
          area: area.key,
          ticket: ticket.identifier,
          runOnce: true,
          idempotencyKey: key(current.project, state),
        });
        state.jobId = queued.id;
        writeState(root, current.project, state);
        return status(name);
      }),
  };
}
