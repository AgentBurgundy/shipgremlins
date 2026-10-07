import { randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { Project } from "../config.ts";
import type { Forge, PullRequest, CheckSummary } from "../forge/types.ts";
import type { LocalJob } from "../localRunners/types.ts";
import type { ChangeSummary } from "../improvements/index.ts";
import type { LinearTicket } from "../services/types.ts";
import { jobBelongsToProject, projectRuntimeKey } from "../projectIdentity.ts";
import { effectiveWorkflow } from "../projectCapabilities.ts";
import { assertNoSymlinks } from "../setup/files.ts";
import { LABELS } from "../dispatcher/notes.ts";
import { ticketScopeHash } from "../lifecycle/manifest.ts";
import { acceptanceCriteria, deliveryConfiguration } from "./index.ts";
import type { DeliveryRecord } from "./types.ts";
import { saveDraftMigrationStatus } from "./migrationStatus.ts";

const SHA = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
export interface CompletedDraft {
  job: LocalJob;
  /** Controller-retained completed output, already filtered to this repository/incarnation. */
  change: ChangeSummary;
}
export interface DraftMigration {
  schema: 1;
  kind: "completed-draft-migration";
  jobId: string;
  projectInstance: string;
  repository: string;
  configuration: string;
  area: string;
  pullNumber: number;
  originalHeadSha: string;
  headSha: string;
  fromBranch: string;
  toBranch: string;
  scopeHash: string;
  ticket: LinearTicket;
  approvedAt: string;
  approvedBy: string;
  checks: NonNullable<DeliveryRecord["checks"]>;
}
export interface DraftAdoptionResult {
  jobId: string;
  phase: "adopted" | "blocked" | "waiting" | "busy";
  message: string;
}
export interface DraftAdoptionOptions {
  root: string;
  project: Project;
  currentProject: () => Project;
  forge: Forge;
  ticket: (id: string) => Promise<LinearTicket | null>;
  checkHead: (sha: string) => Promise<CheckSummary>;
  registered: (jobId: string) => boolean;
  register: (migration: DraftMigration) => Promise<unknown>;
  now?: () => Date;
}

/** Adopt only known native output. A new approval receipt is separate from historical coding admission. */
export function createDraftAdoption(options: DraftAdoptionOptions) {
  const project = structuredClone(options.project),
    forge = options.forge,
    { repo, branches } = project.config;
  const directory = join(
    options.root,
    ".run",
    "delivery",
    projectRuntimeKey(project.config),
    "migrations",
  );
  const now = () => (options.now?.() ?? new Date()).toISOString();
  const enabled = (p: Project) =>
    effectiveWorkflow(p.config).kind === "promotion" &&
    !!p.config.verified &&
    new Set(Object.values(p.config.branches)).size === 3;
  const configuration = (area: string) => deliveryConfiguration(project, area);
  const current = (area: string) => {
    const value = options.currentProject();
    return (
      enabled(value) &&
      jobIdentity(value) === jobIdentity(project) &&
      deliveryConfiguration(value, area) === configuration(area)
    );
  };
  const jobIdentity = (p: Project) => projectRuntimeKey(p.config);
  function sourceUrl(value: string, number: number) {
    const origin = new URL(
      project.config.serverUrl ??
        (project.config.provider === "gitlab"
          ? "https://gitlab.com"
          : "https://github.com"),
    );
    const url = new URL(value);
    return (
      url.origin === origin.origin &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.pathname ===
        `/${repo}${project.config.provider === "gitlab" ? "/-/merge_requests/" : "/pull/"}${number}`
    );
  }
  function eligible({ job, change }: CompletedDraft) {
    return (
      enabled(project) &&
      jobBelongsToProject(project.config, job) &&
      /^job-[a-z0-9-]{1,58}$/.test(job.id) &&
      job.type === "developer" &&
      (job.developerKind === undefined || job.developerKind === "build") &&
      job.status === "succeeded" &&
      !job.cancelRequestedAt &&
      !!job.area &&
      project.areas.some((a) => a.key === job.area) &&
      !!job.ticket &&
      !!job.linearBinding?.ticketId &&
      job.linearBinding.connectionId ===
        (project.config.linear?.connectionId ?? "default") &&
      job.linearBinding.workspaceId === project.config.linear?.workspaceId &&
      change.jobId === job.id &&
      change.runId === job.runId &&
      change.status === "succeeded" &&
      change.area === job.area &&
      change.ticket === job.ticket &&
      change.ticketId === job.linearBinding.ticketId &&
      !change.noChanges &&
      change.pullRequests.length === 1 &&
      Number.isSafeInteger(change.pullRequests[0]!.number) &&
      change.pullRequests[0]!.number > 0 &&
      sourceUrl(change.pullRequests[0]!.url, change.pullRequests[0]!.number) &&
      SHA.test(change.checks?.headSha ?? "") &&
      !!project.config.commands.test?.trim()
    );
  }
  function approved(
    job: LocalJob,
    ticket: LinearTicket | null,
  ): ticket is LinearTicket {
    const area = project.areas.find((a) => a.key === job.area);
    return (
      !!ticket &&
      !!area &&
      ticket.id === job.linearBinding?.ticketId &&
      ticket.identifier === job.ticket &&
      !!project.config.linear?.teamId &&
      ticket.teamId === project.config.linear.teamId &&
      !!area.linearProjectId &&
      ticket.projectId === area.linearProjectId &&
      ticket.labels.includes(area.label) &&
      ticket.labels.includes(LABELS.approved) &&
      ![LABELS.proposal, LABELS.needsHuman].some((label) =>
        ticket.labels.includes(label),
      ) &&
      !["completed", "canceled"].includes(ticket.stateType) &&
      acceptanceCriteria(ticket.description).length > 0
    );
  }
  function validPull(
    pull: PullRequest | null,
    job: LocalJob,
    number: number,
  ): pull is PullRequest {
    return (
      !!pull &&
      pull.number === number &&
      pull.state === "open" &&
      pull.headRef === `gremlins/${job.id}` &&
      SHA.test(pull.headSha) &&
      [branches.production, branches.integration].includes(pull.baseRef) &&
      sourceUrl(pull.htmlUrl, number)
    );
  }
  function acquire(lock: string): number | null {
    assertNoSymlinks(lock);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    try {
      const fd = openSync(lock, "wx", 0o600);
      writeFileSync(fd, String(process.pid));
      return fd;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const stat = lstatSync(lock);
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > 100) return null;
      const pid = Number(readFileSync(lock, "utf8"));
      if (!Number.isSafeInteger(pid) || pid < 1) return null;
      try {
        process.kill(pid, 0);
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === "ESRCH") {
          unlinkSync(lock);
          return acquire(lock);
        }
      }
      return null;
    }
  }
  function save(value: DraftMigration) {
    const file = join(directory, `${value.jobId}.json`);
    assertNoSymlinks(file);
    if (existsSync(file)) {
      const stat = lstatSync(file);
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > 256 * 1024)
        throw new Error("Invalid migration receipt.");
      const previous = JSON.parse(readFileSync(file, "utf8")) as DraftMigration;
      if (
        previous.schema !== 1 ||
        previous.kind !== value.kind ||
        previous.jobId !== value.jobId ||
        previous.projectInstance !== value.projectInstance ||
        previous.configuration !== value.configuration ||
        previous.headSha !== value.headSha ||
        previous.scopeHash !== value.scopeHash ||
        previous.pullNumber !== value.pullNumber ||
        previous.toBranch !== value.toBranch ||
        previous.originalHeadSha !== value.originalHeadSha ||
        previous.repository !== value.repository
      )
        throw new Error(
          "Migration evidence changed; preserve the original receipt.",
        );
      return previous;
    }
    const temp = join(directory, `.${randomBytes(12).toString("hex")}.tmp`);
    writeFileSync(temp, JSON.stringify(value), { flag: "wx", mode: 0o600 });
    renameSync(temp, file);
    return value;
  }
  async function adopt(
    completed: CompletedDraft,
  ): Promise<DraftAdoptionResult> {
    const { job, change } = completed;
    const result = (phase: DraftAdoptionResult["phase"], message: string) => {
      const value = { jobId: job.id, phase, message };
      if (jobBelongsToProject(project.config, job)) {
        try {
          saveDraftMigrationStatus(options.root, project, {
            ...value,
            checkedAt: now(),
          });
        } catch {
          /* Status persistence never changes the migration's admission decision. */
        }
      }
      return value;
    };
    let fd: number | null = null,
      lock: string | undefined;
    try {
      if (!eligible(completed) || !current(job.area!))
        return result(
          "blocked",
          "This draft lacks a completed native job and matching project, PM, repository or Linear binding.",
        );
      lock = join(directory, `${job.id}.lock`);
      fd = acquire(lock);
      if (fd === null)
        return result(
          "busy",
          "Another controller is checking this completed draft.",
        );
      if (options.registered(job.id))
        return result(
          "adopted",
          "This draft already belongs to the automated delivery pipeline.",
        );
      const number = change.pullRequests[0]!.number;
      const ticket = structuredClone(
        await options.ticket(job.linearBinding!.ticketId!),
      );
      if (!approved(job, ticket))
        return result(
          "blocked",
          "Restore the owning PM's approved ticket and acceptance criteria before importing this draft.",
        );
      const pull = structuredClone(await forge.getPull(repo, number));
      if (!validPull(pull, job, number))
        return result(
          "blocked",
          "The retained draft no longer matches its native coding branch and configured repository.",
        );
      const head = pull.headSha,
        original = change.checks!.headSha;
      if (head !== original) {
        const ancestry = await forge.compare(repo, original, head);
        let preserved = ancestry.behindBy === 0 && ancestry.aheadBy > 0;
        if (!preserved && forge.getRevisionTree) {
          const trees = await Promise.all([
            forge.getRevisionTree(repo, original),
            forge.getRevisionTree(repo, head),
          ]);
          const canonical = (tree: (typeof trees)[number]) =>
            JSON.stringify(
              tree
                .map((entry) => [entry.path, entry.sha, entry.mode, entry.type])
                .sort((a, b) => a[0]!.localeCompare(b[0]!)),
            );
          preserved =
            trees.every((tree) => tree.length > 0) &&
            canonical(trees[0]!) === canonical(trees[1]!);
        }
        if (!preserved)
          return result(
            "blocked",
            "The current draft no longer contains the original completed coding revision.",
          );
      }
      const providerChecks = await forge.getChecks(repo, head);
      if (!["success", "none"].includes(providerChecks.status))
        return result(
          providerChecks.status === "pending" ? "waiting" : "blocked",
          "Wait for the draft's provider checks to pass before importing it.",
        );
      if ((await options.checkHead(head)).status !== "success")
        return result(
          "blocked",
          "The current draft must pass configured checks on its exact revision before importing it.",
        );
      const unchanged = async () => {
        const latestTicket = await options.ticket(job.linearBinding!.ticketId!);
        const latest = await forge.getPull(repo, number);
        return (
          current(job.area!) &&
          approved(job, latestTicket) &&
          ticketScopeHash(latestTicket) === ticketScopeHash(ticket) &&
          validPull(latest, job, number) &&
          latest.headSha === head &&
          latest.author === pull.author
        );
      };
      if (!(await unchanged()))
        return result(
          "blocked",
          "Project settings, ticket approval or the draft changed while checking. No delivery was admitted.",
        );
      const checks = await forge.getChecks(repo, head);
      if (!["success", "none"].includes(checks.status))
        return result(
          "waiting",
          "Provider checks changed while preparing the draft. Wait for them to pass.",
        );
      if (!current(job.area!))
        return result(
          "blocked",
          "Project settings changed while preparing the draft.",
        );
      const migration = save({
        schema: 1,
        kind: "completed-draft-migration",
        jobId: job.id,
        projectInstance: jobIdentity(project),
        repository: repo,
        configuration: configuration(job.area!),
        area: job.area!,
        pullNumber: number,
        originalHeadSha: original,
        headSha: head,
        fromBranch: pull.baseRef,
        toBranch: branches.integration,
        scopeHash: ticketScopeHash(ticket),
        ticket: structuredClone(ticket),
        approvedAt: now(),
        approvedBy:
          "controller-observed Linear pm-approved label at workflow migration",
        checks: {
          headSha: head,
          commands: Object.entries(project.config.commands)
            .filter(([, command]) => !!command)
            .map(([name]) => name),
          completedAt: now(),
        },
      });
      if (pull.baseRef !== branches.integration) {
        if (!forge.retargetPull)
          return result(
            "blocked",
            "This source provider cannot retarget completed drafts yet.",
          );
        await forge.retargetPull(repo, number, branches.integration);
      }
      if (!(await unchanged()))
        return result(
          "blocked",
          "The draft or approval changed after retargeting. Existing work is preserved and delivery remains paused.",
        );
      const retargeted = await forge.getPull(repo, number);
      if (
        !retargeted ||
        retargeted.baseRef !== branches.integration ||
        retargeted.headSha !== head ||
        !current(job.area!)
      )
        return result(
          "blocked",
          "The provider has not confirmed this exact draft targets integration.",
        );
      await options.register(migration);
      return result(
        "adopted",
        "Completed draft imported with fresh approval and checks. Integration and owning-PM QA are next.",
      );
    } catch {
      return result(
        "blocked",
        "Could not safely import this completed draft. Existing work and migration evidence were preserved; retry after checking its provider and configuration.",
      );
    } finally {
      if (fd !== null && lock) {
        closeSync(fd);
        unlinkSync(lock);
      }
    }
  }
  return { adopt };
}
