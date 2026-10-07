import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";
import { loadProject, type Project } from "../config.ts";
import { projectRuntimeKey, jobBelongsToProject } from "../projectIdentity.ts";
import { baseBranch, effectiveWorkflow } from "../projectCapabilities.ts";
import { assertNoSymlinks, validateName } from "../setup/files.ts";
import type { LocalJob, LocalJobInput } from "../localRunners/types.ts";
import type { LinearTicket } from "../services/types.ts";
import type { GrumblinProfileSnapshot } from "../grumblins/schema.ts";
import type { DeliveryRecord } from "../delivery/types.ts";
import { acceptanceCriteria } from "../delivery/index.ts";
import { ticketScopeHash } from "../lifecycle/manifest.ts";
import { usesEpicApproval } from "../epics.ts";
import {
  createObservations,
  readPrivateJson,
  writePrivateJson,
} from "./observations.ts";

const ID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const active = (job: LocalJob | undefined) =>
  !!job && ["queued", "running"].includes(job.status);
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
export class ImprovementError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "ImprovementError";
  }
}
interface PlanStep {
  ticketId: string;
  identifier: string;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  area: string;
  areaInstanceId?: string;
  revision: string;
  scopeHash: string;
  dependsOn: string[];
  approvedAt?: string;
  jobId?: string;
  integratedAt?: string;
}
interface Mission {
  id: string;
  clientRequestId?: string;
  project: string;
  projectInstanceId?: string;
  repository: string;
  provider: string;
  area: string;
  areaInstanceId?: string;
  outcome: string;
  createdAt: string;
  updatedAt: string;
  paused: boolean;
  message?: string;
  investigation: { jobId?: string };
  plan?: {
    approvedAt: string;
    baseBranch: string;
    connectionId: string;
    workspaceId?: string;
    steps: PlanStep[];
  };
  followups: {
    id: string;
    profile: GrumblinProfileSnapshot;
    jobId?: string;
    createdAt: string;
  }[];
}
interface State {
  schemaVersion: 1;
  missions: Mission[];
}
export interface ReviewCandidate {
  id: string;
  identifier: string;
  title: string;
  description: string;
  revision: string;
  area?: string;
  canApprove: boolean;
  priority?: number;
  labels: string[];
  url?: string;
  acceptanceCriteria?: string[];
}
export interface ChangeSummary {
  jobId: string;
  runId: number;
  area?: string;
  ticket?: string;
  ticketId?: string;
  /** Validated queue binding; display identifiers alone never identify a ticket. */
  linearBinding?: LocalJob["linearBinding"];
  status: LocalJob["status"];
  message: string;
  activityUrl: string;
  createdAt: string;
  finishedAt?: string;
  pullRequests: {
    number: number;
    url: string;
    title?: string;
    state?: "open" | "merged" | "closed" | "unknown";
    draft?: boolean;
    currentHeadSha?: string;
  }[];
  noChanges?: boolean;
  checks?: { headSha: string; commands: string[]; completedAt: string };
  delivery?: DeliveryRecord;
}
export interface ImprovementOptions {
  root: string;
  now?: () => Date;
  jobs: () => Promise<LocalJob[]>;
  enqueue: (input: LocalJobInput) => Promise<LocalJob>;
  candidates: (project: string) => Promise<{ items: ReviewCandidate[] }>;
  approve: (
    project: string,
    ticketId: string,
    revision: string,
  ) => Promise<unknown>;
  ticket: (project: Project, ticketId: string) => Promise<LinearTicket | null>;
  deliveries: (project: string) => DeliveryRecord[];
  merged?: (project: Project, change: ChangeSummary) => Promise<boolean>;
  refreshChanges?: (
    project: Project,
    changes: ChangeSummary[],
  ) => Promise<ChangeSummary[]>;
  profile: (
    project: string,
    id: string,
    revision: string,
  ) => GrumblinProfileSnapshot;
}
function directory(root: string, project: Project) {
  return join(root, ".run", "improvements", projectRuntimeKey(project.config));
}
function readState(root: string, project: Project): State {
  const file = join(directory(root, project), "missions.json");
  assertNoSymlinks(file);
  if (!existsSync(file)) return { schemaVersion: 1, missions: [] };
  const state = readPrivateJson(file) as State;
  if (
    state.schemaVersion !== 1 ||
    !Array.isArray(state.missions) ||
    state.missions.length > 30 ||
    state.missions.some(
      (m) =>
        !ID.test(m.id) ||
        m.project !== project.config.name ||
        m.projectInstanceId !== project.config.instanceId ||
        m.repository !== project.config.repo ||
        m.provider !== (project.config.provider ?? "github") ||
        typeof m.outcome !== "string" ||
        !m.outcome.trim() ||
        m.outcome.length > 4000 ||
        !Array.isArray(m.followups) ||
        m.followups.length > 12 ||
        (m.plan &&
          (!Array.isArray(m.plan.steps) ||
            m.plan.steps.length > 6 ||
            m.plan.steps.some(
              (s) =>
                !ID.test(s.ticketId) ||
                !Array.isArray(s.dependsOn) ||
                !Array.isArray(s.acceptanceCriteria),
            ))),
    )
  )
    throw new ImprovementError(
      "Saved improvement missions need repair or belong to changed project settings. Existing work was preserved.",
      409,
    );
  return state;
}
/** Applies equally to manual launches and scheduled pickup; display identifiers never grant scope. */
export function missionCodingBlocker(
  root: string,
  name: string,
  ticketId: string,
  ticket?: LinearTicket,
): string | undefined {
  const project = loadProject(root, name);
  let state: State;
  try {
    state = readState(root, project);
  } catch {
    return "Improvement mission state needs repair before coding can continue.";
  }
  for (const mission of state.missions) {
    const plan = mission.plan,
      step = plan?.steps.find((item) => item.ticketId === ticketId);
    if (!plan || !step) continue;
    if (plan.baseBranch !== baseBranch(project.config))
      return "This improvement plan's coding base changed. Review its prerequisites against the new base.";
    if (mission.paused)
      return "This improvement mission is paused. Resume it before starting another coding step.";
    if (
      !ticket ||
      ticket.id !== ticketId ||
      ticketScopeHash(ticket) !== step.scopeHash
    )
      return "This mission's approved ticket scope changed. Review the exact plan before coding.";
    if (!step.approvedAt)
      return "This improvement plan is still recording its exact owner approval.";
    if (
      plan.connectionId !==
        (project.config.linear?.connectionId ?? "default") ||
      plan.workspaceId !== project.config.linear?.workspaceId
    )
      return "This improvement plan's Linear account changed. Review its original approved scope.";
    const owner = project.areas.find((area) => area.key === step.area);
    if (!owner || owner.instanceId !== step.areaInstanceId)
      return "The owning PM changed. Review this improvement plan.";
    if (
      step.dependsOn.some(
        (id) => !plan.steps.find((item) => item.ticketId === id)?.integratedAt,
      )
    )
      return "Waiting for this improvement plan's prerequisite changes to merge into the coding base.";
  }
  return undefined;
}
export function createImprovements(options: ImprovementOptions) {
  const now = () => (options.now?.() ?? new Date()).toISOString();
  const observations = createObservations({ root: options.root });
  const selected = (name: string) => {
    validateName(name, "project");
    return loadProject(options.root, name);
  };
  const revision = (mission: Mission) => hash(mission);
  async function locked<T>(
    name: string,
    action: (project: Project, state: State, save: () => void) => Promise<T>,
  ): Promise<T> {
    const project = selected(name),
      dir = directory(options.root, project),
      lock = join(dir, "missions.lock");
    assertNoSymlinks(lock);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    let fd: number | undefined;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        fd = openSync(lock, "wx", 0o600);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        let dead = false;
        try {
          const pid = Number(readFileSync(lock, "utf8"));
          if (Number.isSafeInteger(pid) && pid > 0) {
            try {
              process.kill(pid, 0);
            } catch (cause) {
              dead = (cause as NodeJS.ErrnoException).code === "ESRCH";
            }
          }
        } catch {
          /* Preserve an ambiguous owner. */
        }
        if (!dead)
          throw new ImprovementError(
            "An improvement is already being updated. Retry shortly.",
            409,
          );
        unlinkSync(lock);
      }
    }
    if (fd === undefined)
      throw new ImprovementError("Improvement storage is busy.", 409);
    writeFileSync(fd, String(process.pid));
    try {
      const state = readState(options.root, project);
      return await action(project, state, () => {
        const current = selected(name);
        if (
          current.config.instanceId !== project.config.instanceId ||
          current.config.repo !== project.config.repo
        )
          throw new ImprovementError(
            "This project changed while the mission was being updated.",
            409,
          );
        writePrivateJson(join(dir, "missions.json"), state);
      });
    } finally {
      closeSync(fd);
      unlinkSync(lock);
    }
  }
  function find(state: State, id: string): Mission {
    if (!ID.test(id))
      throw new ImprovementError("Choose an existing improvement mission.");
    const mission = state.missions.find((item) => item.id === id);
    if (!mission)
      throw new ImprovementError(
        "This improvement mission is unavailable.",
        404,
      );
    return mission;
  }
  const key = (mission: Mission, suffix: string) =>
    "mission:" + mission.id + ":" + suffix;
  function missionJobs(project: Project, all: LocalJob[]) {
    return all.filter((job) => jobBelongsToProject(project.config, job));
  }
  function findJob(
    mission: Mission,
    jobs: LocalJob[],
    suffix: string,
    id?: string,
  ) {
    return (
      jobs.find((job) => job.id === id) ??
      jobs.find((job) => job.idempotencyKey === key(mission, suffix))
    );
  }
  function changes(project: Project, jobs: LocalJob[]): ChangeSummary[] {
    const dir = join(directory(options.root, project), "changes");
    assertNoSymlinks(dir);
    const retained = new Map<string, ChangeSummary>();
    if (existsSync(dir))
      for (const file of readdirSync(dir).filter((name) =>
        /^[a-z0-9-]{1,100}\.json$/.test(name),
      )) {
        const value = readPrivateJson(join(dir, file)) as {
          projectInstanceId?: string;
          repository: string;
          change: ChangeSummary;
        };
        if (
          value.repository !== project.config.repo ||
          value.projectInstanceId !== project.config.instanceId
        )
          continue;
        retained.set(value.change.jobId, value.change);
      }
    let deliveries: DeliveryRecord[] = [];
    try {
      deliveries = options.deliveries(project.config.name);
    } catch {
      /* Retained drafts remain reviewable while delivery settings need repair. */
    }
    for (const job of jobs.filter(
      (item) => item.type === "developer" && item.developerKind !== "sync",
    )) {
      const known = retained.get(job.id);
      retained.set(job.id, {
        jobId: job.id,
        runId: job.runId,
        area: job.area,
        ticket: job.ticket,
        ticketId: job.linearBinding?.ticketId,
        linearBinding: job.linearBinding,
        status: job.status,
        message: job.message ?? "",
        activityUrl: "/activity?run=" + encodeURIComponent(job.id),
        createdAt: job.createdAt,
        finishedAt: job.finishedAt,
        pullRequests: known?.pullRequests ?? [],
        ...(known?.checks ? { checks: known.checks } : {}),
        ...(known?.noChanges ? { noChanges: true } : {}),
      });
    }
    for (const delivery of deliveries) {
      const change = retained.get(delivery.jobId);
      if (change) {
        change.delivery = delivery;
        if (!change.pullRequests.length)
          change.pullRequests.push({
            number: delivery.implementation.number,
            url: delivery.implementation.url,
            title: delivery.ticket.title,
          });
      }
    }
    return [...retained.values()].sort((a, b) => b.runId - a.runId);
  }
  function view(
    mission: Mission,
    project: Project,
    jobs: LocalJob[],
    allChanges: ChangeSummary[],
  ) {
    const investigation = findJob(
      mission,
      jobs,
      "investigate",
      mission.investigation.jobId,
    );
    const steps =
      mission.plan?.steps.map((step) => {
        const job = findJob(mission, jobs, "code:" + step.ticketId, step.jobId);
        return {
          ...step,
          ...(job
            ? { jobId: job.id, runId: job.runId, status: job.status }
            : { status: "waiting" }),
        };
      }) ?? [];
    const followups = mission.followups.map((item) => {
      const job = findJob(mission, jobs, "followup:" + item.id, item.jobId);
      return {
        id: item.id,
        profile: item.profile,
        createdAt: item.createdAt,
        ...(job ? { jobId: job.id, runId: job.runId, status: job.status } : {}),
      };
    });
    let status:
      | "investigating"
      | "needs-review"
      | "building"
      | "review-changes"
      | "following-up"
      | "blocked"
      | "paused" = "needs-review";
    let message =
      "Review the evidence and choose a bounded improvement to approve.";
    if (mission.paused) {
      status = "paused";
      message =
        "Future mission steps are paused. Running jobs continue; queued steps recheck the pause before starting.";
    } else if (mission.message) {
      status = "blocked";
      message = mission.message;
    } else if (
      followups.some(
        (item) => item.status === "queued" || item.status === "running",
      )
    ) {
      status = "following-up";
      message =
        "The selected Grumblin is checking the actual configured app. Compare only matching environments and revisions.";
    } else if (
      steps.some(
        (item) => item.status === "queued" || item.status === "running",
      )
    ) {
      status = "building";
      message =
        "Coding is working on the exact approved plan. Production remains owner-controlled.";
    } else if (active(investigation)) {
      status = "investigating";
      message =
        "The PM is investigating this outcome in your existing application.";
    } else if (
      steps.some(
        (item) => item.status === "failed" || item.status === "canceled",
      )
    ) {
      status = "blocked";
      message =
        "A coding attempt stopped. Review its evidence before explicitly retrying that ticket.";
    } else if (
      steps.length &&
      steps.every((item) => item.status === "succeeded")
    ) {
      status = "review-changes";
      message =
        effectiveWorkflow(project.config).kind === "promotion"
          ? "Coding finished. Your PMs test the deployed changes, send failures back to coders, and collect passing work into promotion PRs."
          : "Coding finished. Review the actual changes and verification; a successful run alone does not prove the outcome.";
    } else if (steps.length) {
      status = "blocked";
      message =
        "Waiting for prerequisite changes to merge into the coding base before the next plan step.";
    } else if (!investigation || investigation.status !== "succeeded") {
      status = "blocked";
      message =
        "The investigation has not completed. Review its run or retry preparation; a failed model run is never repeated automatically.";
    }
    const linked = new Set(steps.map((step) => step.jobId).filter(Boolean));
    return {
      id: mission.id,
      project: mission.project,
      area: mission.area,
      outcome: mission.outcome,
      createdAt: mission.createdAt,
      updatedAt: mission.updatedAt,
      revision: revision(mission),
      status,
      message,
      investigation: investigation
        ? {
            jobId: investigation.id,
            runId: investigation.runId,
            status: investigation.status,
          }
        : {},
      ...(mission.plan
        ? { plan: { approvedAt: mission.plan.approvedAt, steps } }
        : {}),
      followups,
      changes: allChanges.filter((change) => linked.has(change.jobId)),
    };
  }
  async function list(name: string) {
    const project = selected(name),
      state = readState(options.root, project),
      jobs = missionJobs(project, await options.jobs()),
      allChanges = options.refreshChanges
        ? await options.refreshChanges(project, changes(project, jobs))
        : changes(project, jobs);
    return {
      workflow: effectiveWorkflow(project.config),
      missions: state.missions
        .map((item) => view(item, project, jobs, allChanges))
        .reverse(),
      areas: project.areas.map(({ key, name }) => ({ key, name })),
      changes: allChanges,
    };
  }
  async function detail(name: string, id: string) {
    const project = selected(name),
      state = readState(options.root, project),
      mission = find(state, id),
      jobs = missionJobs(project, await options.jobs()),
      allChanges = options.refreshChanges
        ? await options.refreshChanges(project, changes(project, jobs))
        : changes(project, jobs);
    const retained = observations.list(project, 500);
    const linkedJobs = new Set([
      mission.investigation.jobId,
      ...mission.followups.map((item) => item.jobId),
    ]);
    const linked = retained.filter((item) => linkedJobs.has(item.jobId));
    const identifiers = new Set(
      linked.flatMap(
        (item) =>
          item.report?.opportunities.flatMap(
            (opportunity) => opportunity.ticketIdentifiers,
          ) ?? [],
      ),
    );
    let candidates: (ReviewCandidate & {
        related: boolean;
        acceptanceCriteria: string[];
      })[] = [],
      candidateError: string | undefined;
    try {
      candidates = (await options.candidates(name)).items
        .filter((item) => item.area === mission.area && item.canApprove)
        .map((item) => ({
          ...item,
          related: identifiers.has(item.identifier),
          acceptanceCriteria:
            item.acceptanceCriteria ?? acceptanceCriteria(item.description),
        }))
        .sort(
          (a, b) =>
            Number(b.related) - Number(a.related) ||
            (a.priority || 5) - (b.priority || 5),
        );
    } catch {
      candidateError =
        "Linear proposals could not be loaded. Check this project's selected Linear connection; saved mission evidence is preserved.";
    }
    const profileIds = new Set(
      mission.followups.map((item) => item.profile.id),
    );
    const baselines = retained.filter(
      (item) =>
        item.grumblin &&
        profileIds.has(item.grumblin.id) &&
        !linkedJobs.has(item.jobId),
    );
    return {
      mission: view(mission, project, jobs, allChanges),
      approvalPolicy: usesEpicApproval(project) ? "epic" : "ticket",
      candidates,
      observations: linked,
      baselines: baselines.slice(0, 20),
      changes: allChanges,
      ...(candidateError ? { candidateError } : {}),
    };
  }
  async function create(
    name: string,
    input: { outcome: unknown; area?: unknown; clientRequestId?: unknown },
  ) {
    if (
      typeof input.outcome !== "string" ||
      !input.outcome.trim() ||
      input.outcome.length > 4000 ||
      (input.clientRequestId !== undefined &&
        (typeof input.clientRequestId !== "string" ||
          !ID.test(input.clientRequestId)))
    )
      throw new ImprovementError(
        "Describe one desired user outcome in 1–4,000 characters.",
      );
    const outcome = input.outcome.trim();
    const id = await locked(name, async (project, state, save) => {
      const area =
        input.area === undefined && project.areas.length === 1
          ? project.areas[0]
          : project.areas.find((item) => item.key === input.area);
      if (!area)
        throw new ImprovementError(
          "Choose the PM responsible for this outcome.",
        );
      const existing = state.missions.find(
        (item) =>
          (input.clientRequestId &&
            item.clientRequestId === input.clientRequestId) ||
          (!item.paused &&
            item.area === area.key &&
            item.areaInstanceId === area.instanceId &&
            item.outcome === outcome),
      );
      if (existing) {
        if (
          existing.outcome !== outcome ||
          existing.area !== area.key ||
          existing.areaInstanceId !== area.instanceId
        )
          throw new ImprovementError(
            "This request already belongs to a different improvement.",
            409,
          );
        return existing.id;
      }
      if (state.missions.length >= 30)
        throw new ImprovementError(
          "This project has reached its retained mission limit. Existing missions are preserved.",
          409,
        );
      const mission: Mission = {
        id: randomUUID(),
        ...(typeof input.clientRequestId === "string"
          ? { clientRequestId: input.clientRequestId }
          : {}),
        project: name,
        projectInstanceId: project.config.instanceId,
        repository: project.config.repo,
        provider: project.config.provider ?? "github",
        area: area.key,
        areaInstanceId: area.instanceId,
        outcome,
        createdAt: now(),
        updatedAt: now(),
        paused: false,
        investigation: {},
        followups: [],
      };
      state.missions.push(mission);
      save();
      return mission.id;
    });
    await advance(name, id);
    return (await detail(name, id)).mission;
  }
  async function advance(name: string, id: string) {
    await locked(name, async (project, state, save) => {
      const mission = find(state, id);
      if (mission.paused) return;
      const before = JSON.stringify(mission);
      const area = project.areas.find((item) => item.key === mission.area);
      let jobs = missionJobs(project, await options.jobs());
      const adopt = async (
        suffix: string,
        input: LocalJobInput,
        storedId?: string,
      ) => {
        const previous = findJob(mission, jobs, suffix, storedId);
        if (previous) return previous;
        const queued = await options.enqueue({
          ...input,
          project: name,
          projectInstanceId: project.config.instanceId,
          runOnce: true,
          idempotencyKey: key(mission, suffix),
        });
        jobs = [...jobs, queued];
        return queued;
      };
      try {
        if (!area || area.instanceId !== mission.areaInstanceId)
          throw new ImprovementError(
            "This mission's PM changed. Its original evidence was preserved.",
            409,
          );
        if (!mission.plan) {
          const investigation = await adopt(
            "investigate",
            { type: "pm", area: mission.area, pmMode: "exploration" },
            mission.investigation.jobId,
          );
          mission.investigation.jobId = investigation.id;
        } else {
          const plan = mission.plan;
          if (plan.baseBranch !== baseBranch(project.config))
            throw new ImprovementError(
              "This mission's coding base changed. Review prerequisites against the current branch.",
              409,
            );
          if (
            plan.connectionId !==
              (project.config.linear?.connectionId ?? "default") ||
            plan.workspaceId !== project.config.linear?.workspaceId
          )
            throw new ImprovementError(
              "This mission's Linear account changed. Review its original approved plan.",
              409,
            );
          const allChanges = changes(project, jobs);
          for (const step of plan.steps) {
            const ticket = await options.ticket(project, step.ticketId);
            if (!ticket || ticketScopeHash(ticket) !== step.scopeHash)
              throw new ImprovementError(
                "An approved ticket changed. Review its new scope before continuing the mission.",
                409,
              );
            const labels = new Set(
              ticket.labels.map((label) => label.toLowerCase()),
            );
            if (!step.approvedAt) {
              // The explicit owner's saved intent predates any provider mutation.
              // Recover a lost approval response without granting a changed scope.
              if (!labels.has("pm-approved") || labels.has("pm-proposal")) {
                const current = (await options.candidates(name)).items.find(
                  (item) => item.id === step.ticketId && item.canApprove,
                );
                if (
                  !current ||
                  current.title !== step.title ||
                  current.description !== step.description
                )
                  throw new ImprovementError(
                    "The approved proposal changed during approval recovery. Review its exact scope.",
                    409,
                  );
                await options.approve(name, step.ticketId, current.revision);
              }
              const approved = await options.ticket(project, step.ticketId);
              if (
                !approved ||
                ticketScopeHash(approved) !== step.scopeHash ||
                !approved.labels.some(
                  (label) => label.toLowerCase() === "pm-approved",
                ) ||
                approved.labels.some(
                  (label) => label.toLowerCase() === "pm-proposal",
                )
              )
                throw new ImprovementError(
                  "Exact ticket approval could not be confirmed. Existing work was preserved.",
                  409,
                );
              step.approvedAt = now();
              mission.updatedAt = now();
              save();
            }
            const owned = findJob(
              mission,
              jobs,
              "code:" + step.ticketId,
              step.jobId,
            );
            const matchingAttempt = [...jobs]
              .sort((a, b) => b.runId - a.runId)
              .find(
                (job) =>
                  job.type === "developer" &&
                  job.linearBinding?.ticketId === step.ticketId &&
                  (job.linearBinding.workspaceId && plan.workspaceId
                    ? job.linearBinding.workspaceId === plan.workspaceId
                    : job.linearBinding.connectionId === plan.connectionId) &&
                  ["queued", "running", "succeeded"].includes(job.status),
              );
            if (
              matchingAttempt &&
              matchingAttempt.id !== owned?.id &&
              !(
                Date.parse(matchingAttempt.createdAt) >=
                Date.parse(plan.approvedAt)
              )
            )
              throw new ImprovementError(
                "An existing coding attempt predates this plan's approved scope. Review that change before starting or adopting another attempt.",
                409,
              );
            const existing = matchingAttempt ?? owned;
            if (existing) {
              step.jobId = existing.id;
              const change = allChanges.find(
                (item) => item.jobId === existing.id,
              );
              if (
                plan.steps.some((next) =>
                  next.dependsOn.includes(step.ticketId),
                )
              ) {
                if (
                  change &&
                  options.merged &&
                  (await options.merged(project, change))
                )
                  step.integratedAt ??= now();
                else delete step.integratedAt;
              }
              continue;
            }
            if (
              step.dependsOn.some(
                (dependency) =>
                  !plan.steps.find((item) => item.ticketId === dependency)
                    ?.integratedAt,
              )
            )
              continue;
            mission.updatedAt = now();
            save();
            const queued = await adopt(
              "code:" + step.ticketId,
              { type: "developer", area: step.area, ticket: step.identifier },
              step.jobId,
            );
            step.jobId = queued.id;
          }
        }
        for (const followup of mission.followups) {
          const queued = await adopt(
            "followup:" + followup.id,
            {
              type: "pm",
              area: mission.area,
              pmMode: "grumblin",
              grumblin: followup.profile,
            },
            followup.jobId,
          );
          followup.jobId = queued.id;
        }
        delete mission.message;
      } catch (error) {
        mission.message =
          error instanceof Error
            ? error.message.slice(0, 1000)
            : "Mission preparation could not finish. Review its saved state and retry.";
      }
      if (JSON.stringify(mission) !== before) {
        mission.updatedAt = now();
        save();
      }
    });
    return (await list(name)).missions.find((mission) => mission.id === id)!;
  }
  async function plan(
    name: string,
    id: string,
    input: { revision: unknown; steps: unknown },
  ) {
    await locked(name, async (project, state, save) => {
      if (usesEpicApproval(project))
        throw new ImprovementError(
          "Approve this mission's epic in the project's Epic review. The owning PM will prepare child tickets, and coding pickup will implement them under that approval. An epic is not an individual coding ticket.",
          409,
        );
      const mission = find(state, id);
      if (
        revision(mission) !== input.revision ||
        mission.plan ||
        mission.paused
      )
        throw new ImprovementError(
          "This mission changed or already has an approved plan. Refresh before approving.",
          409,
        );
      if (
        !Array.isArray(input.steps) ||
        !input.steps.length ||
        input.steps.length > 6
      )
        throw new ImprovementError(
          "Choose one to six independently testable tickets for this bounded plan.",
        );
      const candidates = (await options.candidates(name)).items;
      const steps: PlanStep[] = [];
      for (const raw of input.steps) {
        if (
          !object(raw) ||
          typeof raw.ticketId !== "string" ||
          !ID.test(raw.ticketId) ||
          typeof raw.revision !== "string" ||
          !Array.isArray(raw.dependsOn) ||
          raw.dependsOn.some(
            (value) => typeof value !== "string" || !ID.test(value),
          ) ||
          Object.keys(raw).some(
            (key) => !["ticketId", "revision", "dependsOn"].includes(key),
          )
        )
          throw new ImprovementError(
            "Review exact ticket revisions and dependency IDs.",
          );
        const candidate = candidates.find(
          (item) =>
            item.id === raw.ticketId &&
            item.revision === raw.revision &&
            item.canApprove,
        );
        const area = project.areas.find((item) => item.key === candidate?.area);
        const ticket =
          candidate && (await options.ticket(project, candidate.id));
        if (
          !candidate ||
          !area ||
          !ticket ||
          ticket.id !== candidate.id ||
          ticket.identifier !== candidate.identifier ||
          ticket.title !== candidate.title ||
          ticket.description !== candidate.description ||
          ticket.projectId !== area.linearProjectId ||
          (project.config.linear?.teamId &&
            ticket.teamId !== project.config.linear.teamId) ||
          !acceptanceCriteria(ticket.description).length
        )
          throw new ImprovementError(
            "A proposal changed or lacks finite acceptance criteria. Refresh and review the exact scope.",
            409,
          );
        steps.push({
          ticketId: ticket.id,
          identifier: ticket.identifier,
          title: ticket.title,
          description: ticket.description,
          acceptanceCriteria: acceptanceCriteria(ticket.description),
          area: area.key,
          areaInstanceId: area.instanceId,
          revision: candidate.revision,
          scopeHash: ticketScopeHash(ticket),
          dependsOn: [...new Set(raw.dependsOn as string[])],
        });
      }
      if (new Set(steps.map((step) => step.ticketId)).size !== steps.length)
        throw new ImprovementError("Select each ticket only once.");
      const seen = new Set<string>();
      // Explicit topological order makes prerequisites reviewable and cannot cycle.
      for (const step of steps) {
        if (step.dependsOn.some((dependency) => !seen.has(dependency)))
          throw new ImprovementError(
            "Put prerequisite tickets first; every dependency must be an earlier selected ticket.",
          );
        seen.add(step.ticketId);
      }
      mission.plan = {
        approvedAt: now(),
        baseBranch: baseBranch(project.config),
        connectionId: project.config.linear?.connectionId ?? "default",
        workspaceId: project.config.linear?.workspaceId,
        steps,
      };
      mission.updatedAt = now();
      delete mission.message;
      save();
    });
    return advance(name, id);
  }
  async function followup(
    name: string,
    id: string,
    input: { profileId: unknown; profileRevision: unknown },
  ) {
    if (
      typeof input.profileId !== "string" ||
      typeof input.profileRevision !== "string"
    )
      throw new ImprovementError("Choose a current saved Grumblin profile.");
    await locked(name, async (_project, state, save) => {
      const mission = find(state, id);
      if (mission.paused)
        throw new ImprovementError(
          "Resume the mission before starting a followup.",
          409,
        );
      const profile = options.profile(
        name,
        input.profileId as string,
        input.profileRevision as string,
      );
      const jobs = await options.jobs();
      if (
        mission.followups.some(
          (item) =>
            item.profile.id === profile.id &&
            (!item.jobId || active(jobs.find((job) => job.id === item.jobId))),
        )
      )
        return;
      if (mission.followups.length >= 12)
        throw new ImprovementError(
          "This mission already has twelve retained followups. Existing evidence is preserved.",
          409,
        );
      mission.followups.push({ id: randomUUID(), profile, createdAt: now() });
      mission.updatedAt = now();
      save();
    });
    return advance(name, id);
  }
  async function pause(
    name: string,
    id: string,
    expected: unknown,
    paused = true,
  ) {
    await locked(name, async (_project, state, save) => {
      const mission = find(state, id);
      if (revision(mission) !== expected)
        throw new ImprovementError(
          "The mission changed. Refresh before changing its pause state.",
          409,
        );
      mission.paused = paused;
      mission.updatedAt = now();
      save();
    });
    return (await list(name)).missions.find((mission) => mission.id === id)!;
  }
  function context(project: Project, job: LocalJob): string {
    const state = readState(options.root, project);
    const mission = state.missions.find(
      (item) =>
        job.idempotencyKey?.startsWith(key(item, "")) ||
        item.investigation.jobId === job.id ||
        item.plan?.steps.some((step) => step.jobId === job.id) ||
        item.followups.some((followup) => followup.jobId === job.id),
    );
    const reports = observations.list(project, 60);
    const previousJourneys = job.grumblin
      ? reports
          .filter(
            (item) =>
              item.grumblin?.id === job.grumblin!.id && item.report?.journey,
          )
          .slice(0, 3)
          .map((item) => ({
            jobId: item.jobId,
            runId: item.runId,
            commitSha: item.commitSha,
            createdAt: item.createdAt,
            profileRevision: item.grumblin!.revision,
            journey: item.report!.journey,
          }))
      : [];
    if (!mission && !previousJourneys.length) return "";
    return (
      "\nOWNER-AUTHORIZED IMPROVEMENT MISSION\nThis is task scope, not permission to bypass the current owner charter, approval, runtime or publication rules. Investigate the requested outcome in the real existing product; preserve its architecture, actual data flows, existing features and design conventions. Explore competing ways to solve the whole user job. Never replace the app with a mock or invent a customer need. Only the owner approves exact build scope. Retain useful findings in improvement-report.json and the knowledge documents.\n" +
      JSON.stringify({
        ...(mission
          ? {
              missionId: mission.id,
              outcome: mission.outcome,
              area: mission.area,
              approvedPlan: mission.plan
                ? mission.plan.steps.map(
                    ({ ticketId, identifier, title, dependsOn }) => ({
                      ticketId,
                      identifier,
                      title,
                      dependsOn,
                    }),
                  )
                : null,
            }
          : {}),
        previousJourneys,
      }) +
      "\nPrior journey counts and opinions are reported simulation evidence, not certified metrics or customer research. Cite each actual run, note changed profile/environment/commit, and never invent a baseline."
    );
  }
  function captureResult(job: LocalJob, result: Record<string, unknown>) {
    if (
      job.type !== "developer" ||
      job.developerKind === "sync" ||
      !job.project ||
      result.ok !== true ||
      result.kind !== "developer" ||
      result.nonce !== job.id
    )
      return;
    const project = selected(job.project);
    if (!jobBelongsToProject(project.config, job)) return;
    try {
      if (result.noChanges === true) {
        const change: ChangeSummary = {
          jobId: job.id,
          runId: job.runId,
          area: job.area,
          ticket: job.ticket,
          ticketId: job.linearBinding?.ticketId,
          linearBinding: job.linearBinding,
          status: "succeeded",
          message: "The run produced no code changes or draft.",
          activityUrl: "/activity?run=" + encodeURIComponent(job.id),
          createdAt: job.createdAt,
          finishedAt: job.finishedAt ?? now(),
          pullRequests: [],
          noChanges: true,
        };
        writePrivateJson(
          join(directory(options.root, project), "changes", job.id + ".json"),
          {
            projectInstanceId: project.config.instanceId,
            repository: project.config.repo,
            change,
          },
        );
        return;
      }
      if (
        typeof result.prUrl !== "string" ||
        typeof result.headSha !== "string" ||
        !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(result.headSha)
      )
        return;
      const origin = new URL(
        project.config.serverUrl ??
          (project.config.provider === "gitlab"
            ? "https://gitlab.com"
            : "https://github.com"),
      );
      const url = new URL(result.prUrl),
        prefix =
          "/" +
          project.config.repo +
          (project.config.provider === "gitlab"
            ? "/-/merge_requests/"
            : "/pull/");
      const number = Number(url.pathname.slice(prefix.length));
      if (
        url.origin !== origin.origin ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        !url.pathname.startsWith(prefix) ||
        !Number.isSafeInteger(number) ||
        number < 1
      )
        return;
      const change: ChangeSummary = {
        jobId: job.id,
        runId: job.runId,
        area: job.area,
        ticket: job.ticket,
        ticketId: job.linearBinding?.ticketId,
        linearBinding: job.linearBinding,
        status: "succeeded",
        message:
          effectiveWorkflow(project.config).kind === "promotion"
            ? "Coding checks finished. The controller is preparing this change for PM QA."
            : "A tested draft is ready for owner review.",
        activityUrl: "/activity?run=" + encodeURIComponent(job.id),
        createdAt: job.createdAt,
        finishedAt: job.finishedAt ?? now(),
        pullRequests: [{ number, url: url.href, title: job.ticket }],
        checks: {
          headSha: result.headSha,
          commands: Array.isArray(result.checks)
            ? result.checks.filter(
                (item): item is string =>
                  typeof item === "string" &&
                  ["install", "test", "lint", "typecheck", "build"].includes(
                    item,
                  ),
              )
            : [],
          completedAt: job.finishedAt ?? now(),
        },
      };
      writePrivateJson(
        join(directory(options.root, project), "changes", job.id + ".json"),
        {
          projectInstanceId: project.config.instanceId,
          repository: project.config.repo,
          change,
        },
      );
    } catch {
      /* Optional retained presentation never changes an actual coding outcome. */
    }
  }
  function firstReviewableChange(project: Project) {
    let change: ChangeSummary | undefined;
    try {
      change = changes(project, []).find((item) => item.pullRequests.length);
    } catch {
      return undefined;
    }
    return change
      ? {
          jobId: change.jobId,
          url: change.pullRequests[0]!.url,
          title: change.pullRequests[0]!.title,
        }
      : undefined;
  }
  async function reconcile(name: string) {
    const project = selected(name),
      state = readState(options.root, project);
    for (const mission of state.missions.filter((item) => !item.paused)) {
      try {
        await advance(name, mission.id);
      } catch {
        // One busy or damaged mission must not prevent sibling work or delivery review.
      }
    }
  }
  return {
    list,
    detail,
    create,
    advance,
    plan,
    followup,
    pause,
    context,
    captureResult,
    firstReviewableChange,
    hasMissions(project: Project) {
      try {
        return readState(options.root, project).missions.length > 0;
      } catch {
        // Keep the mission repair view reachable instead of replacing saved work
        // with the new-project introduction when its journal cannot be read.
        return true;
      }
    },
    reconcile,
  };
}
