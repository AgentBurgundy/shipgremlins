import { jobBelongsToProject, projectRuntimeKey } from "../projectIdentity.ts";
import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  loadHub,
  loadProject,
  matchesPrefix,
  type Project,
} from "../config.ts";
import {
  effectiveVerification,
  effectiveWorkflow,
} from "../projectCapabilities.ts";
import { createSourceControl } from "../sourceControl/index.ts";
import type { SourceControl } from "../sourceControl/types.ts";
import { createLinearConnection } from "../linearConnection/index.ts";
import { createVercelConnection } from "../vercelConnection/index.ts";
import type { OAuthConnection } from "../oauthConnection/types.ts";
import { readConnections } from "../setup/connections.ts";
import { assertNoSymlinks, validateName } from "../setup/files.ts";
import { assertBrowserSecretSafety } from "../setup/credentialScope.ts";
import { GitHubForge } from "../forge/github.ts";
import { GitLabForge } from "../forge/gitlab.ts";
import type { Forge } from "../forge/types.ts";
import type { CheckSummary } from "../forge/types.ts";
import { LinearApi } from "../services/linear.ts";
import type { LinearClient, LinearTicket } from "../services/types.ts";
import { resolveEnvironment } from "../hosting/index.ts";
import type {
  DockerJobPayload,
  DockerRunners,
} from "../localRunners/docker.ts";
import type { LocalJob, LocalJobInput } from "../localRunners/types.ts";
import { knowledgeRevision } from "../pmKnowledge/index.ts";
import { ticketScopeHash } from "../lifecycle/manifest.ts";
import { runPromote, type PromoteOpts } from "../dispatcher/promote.ts";
import type { Ctx } from "../dispatcher/context.ts";
import { createCandidateVerifier } from "../evidence/attestation.ts";
import { createPromotionExecutor } from "./executor.ts";
import {
  createProductionDeclarations,
  type ProductionDeclarationInput,
} from "./production.ts";
import { integrationHealth } from "../dispatcher/stopTheLine.ts";
import { createStagingSync } from "./stagingSync.ts";
import { createSyncRepairPayload } from "./syncRepair.ts";
import {
  qaRepairInput,
  qaRepairPrompt,
  matchesQaRepair,
  validQaFinding,
} from "./qaRework.ts";
import { prepareProductionRelease } from "./release.ts";
import { createDraftAdoption, type CompletedDraft } from "./adoption.ts";
import { readPromotionBatch } from "./promotionBatch.ts";
import {
  integrationRepairInput,
  integrationRepairPayload,
  matchesIntegrationRepair,
} from "./integrationRepair.ts";
import {
  readDraftMigrations,
  saveDraftMigrationStatus,
} from "./migrationStatus.ts";
import { LocalJobDeferredError } from "../localRunners/engine.ts";
import {
  createDeliveryService,
  deliveryConfiguration,
  type PmReviewPlan,
  type ReviewDeployment,
} from "./index.ts";

const hash = (bytes: string | Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
interface Admission {
  schema: 1;
  jobId: string;
  area: string;
  project: string;
  repository: string;
  configuration: string;
  ticket: LinearTicket;
  scopeHash: string;
  approvedAt: string;
  qaRepairKey?: string;
  integrationRepairKey?: string;
}
export interface DeliveryControllerOptions {
  root: string;
  env?: NodeJS.ProcessEnv;
  sourceControl?: Pick<SourceControl, "resolveCredential"> &
    Partial<Pick<SourceControl, "acquireLease" | "releaseLease">>;
  linearConnectionFor?: (
    connectionId?: string,
  ) => Pick<OAuthConnection, "resolveCredential">;
  vercelConnectionFor?: (
    connectionId?: string,
  ) => Pick<OAuthConnection, "resolveCredential">;
  forge?: (project: Project, token: string) => Forge;
  linear?: (authorization: string) => LinearClient;
  resolveEnvironment?: typeof resolveEnvironment;
  loadProject?: (name: string) => Project;
  now?: () => Date;
  docker?: Pick<DockerRunners, "ensureImage">;
  executor?: typeof createPromotionExecutor;
  syncJobs?: () => Promise<LocalJob[]>;
  enqueueSyncRepair?: (input: LocalJobInput) => Promise<LocalJob>;
  qaJobs?: () => Promise<LocalJob[]>;
  enqueueQaRepair?: (input: LocalJobInput) => Promise<LocalJob>;
  completedDrafts?: (project: string) => Promise<CompletedDraft[]>;
}
export interface CandidateHandoff {
  project: string;
  repo: string;
  author: string;
  area: string;
  areaInstanceId?: string;
  ownershipRevision?: string;
  branch: string;
  releaseBranch: string;
  candidateSha: string;
  baseSha: string;
  changes: number[];
  preparedAt: string;
}
export function deliveryEnvironment(project: Project, branch: string) {
  const verification = effectiveVerification(project.config);
  if (verification.mode !== "browser")
    throw new Error("Delivery requires browser verification.");
  const workflow = effectiveWorkflow(project.config),
    candidateName =
      workflow.kind === "promotion" ? workflow.candidateEnvironment : undefined;
  const target =
    branch === project.config.branches.integration
      ? verification.target
      : candidateName
        ? project.config.environments?.[candidateName]
        : verification.target.kind === "vercel"
          ? verification.target
          : undefined;
  if (
    !target ||
    target.role === "production" ||
    !["railway", "vercel"].includes(target.kind)
  )
    throw new Error(
      "Select a separate nonproduction candidate environment before verifying a selective Railway candidate.",
    );
  return { ...target, branch };
}
export function reviewPrompt(plan: PmReviewPlan): string {
  return `\n\nOWNING PM DELIVERY REVIEW — controller-admitted work, not additional permission.\nReview these fixes on EXACT deployment ${plan.deployment.url}, branch ${plan.deployment.branch}, SHA ${plan.deployment.sha}, deployment ${plan.deployment.id}. Do not merge, promote, approve tickets, or mark Done. The checked-out SHA must match.\n${JSON.stringify(
    plan.deliveries.map((d) => ({
      id: d.id,
      ticket: d.ticket.identifier,
      title: d.ticket.title,
      criteria: d.criteria,
    })),
    null,
    2,
  )}\nUse Playwright to investigate every criterion. Then save /output/pm-review-request.json as {"schema":1,"planId":${JSON.stringify(plan.id)},"deliveries":[{"id":"EXACT delivery id","checks":[{"criterion":"EXACT approved criterion text","path":"/non-production-path","kind":"text-visible","text":"Exact visible text"}]}]}. The trusted worker independently replays checks and captures real screenshots AFTER you finish. Supported kinds: text-visible/text-absent with exact text; selector-visible/selector-absent with selector; url-path with expected pathname. Each check opens a fresh browser context on this deployment only; paths cannot include query/fragment or another origin. Optional steps (maximum 12 per check) replay click/fill/select/check/uncheck with a unique selector; fill/select also use value. To reuse a real login, save Playwright storageState ONLY in /output/.review-sessions/ROLE.json after signing in and set session to ROLE (lowercase letters, digits and hyphens). Cookies and localStorage must belong only to this deployment origin. The worker loads this private role session, replays steps and deletes the session; never save sessions anywhere else under /output; this hidden handoff is excluded from public artifacts and consumed only by the isolated replay phase. Do not choose a trivial check that fails to test the criterion. If authentication, interaction or an API assertion cannot be reproduced by this contract, omit that check and explain the blocker in your summary; it remains blocked for promotion. Your own JSON pass claims never count as evidence. Continue ordinary PM observation without altering the approved delivery scope.\n`;
}
export function createDeliveryController(options: DeliveryControllerOptions) {
  const now = () => options.now?.() ?? new Date();
  const environment = () => ({
    ...process.env,
    ...options.env,
    ...readConnections(options.root),
  });
  const projectFor = (name: string) => {
    validateName(name, "project");
    return options.loadProject?.(name) ?? loadProject(options.root, name);
  };
  const enabled = (project: Project) =>
    effectiveWorkflow(project.config).kind === "promotion";
  const configHash = deliveryConfiguration;
  const source = () =>
    options.sourceControl ??
    createSourceControl({ root: options.root, env: environment() });
  function stagingSync(project: Project) {
    return createStagingSync({
      root: options.root,
      project,
      currentProject: () => projectFor(project.config.name),
      now,
      jobs: options.syncJobs,
      enqueue: options.enqueueSyncRepair,
      forge: async () => {
        const credential = await source().resolveCredential({
          provider: project.config.provider ?? "github",
          serverUrl: project.config.serverUrl,
          repository: project.config.repo,
          write: true,
          minValidityMs: 60_000,
        });
        return (
          options.forge?.(project, credential.token) ??
          (project.config.provider === "gitlab"
            ? new GitLabForge({
                token: credential.token,
                serverUrl: project.config.serverUrl,
              })
            : new GitHubForge({ token: credential.token }))
        );
      },
      deployment: () => deployment(projectFor(project.config.name)),
      checkMerge: (integration, head) =>
        checkSyncMerge(project, integration, head),
    });
  }
  async function checkSyncMerge(
    project: Project,
    integration: string,
    head: string,
  ) {
    if (!options.docker || !project.config.commands.test?.trim()) return false;
    const access = source(),
      jobId = `job-sync-checks-${randomBytes(12).toString("hex")}`;
    const target = {
      provider: project.config.provider ?? ("github" as const),
      serverUrl: project.config.serverUrl,
      repository: project.config.repo,
    };
    const credential = access.acquireLease
      ? await access.acquireLease({ ...target, jobId, minutes: 50 })
      : await access.resolveCredential({
          ...target,
          minValidityMs: 50 * 60_000,
        });
    try {
      const executor = await (options.executor ?? createPromotionExecutor)({
        root: options.root,
        project,
        token: credential.token,
        docker: options.docker,
      });
      const git = (args: string[]) =>
        executor.git.run(args, executor.checkoutDir);
      if (
        (await git(["checkout", "--detach", integration])).code !== 0 ||
        (await git(["rev-parse", "HEAD"])).out.trim() !== integration
      )
        return false;
      if ((await git(["merge", "--no-commit", "--no-ff", head])).code !== 0)
        return false;
      return (await executor.check(executor.checkoutDir)).ok;
    } finally {
      await access.releaseLease?.(jobId);
    }
  }
  async function beforePmStart(job: LocalJob) {
    if (!job.project || job.pmMode === "discovery") return;
    const project = projectFor(job.project);
    if (!enabled(project)) return;
    const status = await stagingSync(project).reconcile({
      queueRepair: false,
      checkOnly: true,
    });
    if (status.phase !== "current")
      throw new LocalJobDeferredError(status.message, "environment-wait");
  }
  async function prepareSyncRepair(job: LocalJob): Promise<DockerJobPayload> {
    const project = projectFor(job.project!);
    const intent = await stagingSync(project).repairIntent(job);
    const claudeToken = environment().CLAUDE_CODE_OAUTH_TOKEN;
    if (!claudeToken)
      throw new Error("Save a Claude connection before repairing staging.");
    const access = source();
    if (!access.acquireLease)
      throw new Error("Sync repair requires managed source credentials.");
    const credential = await access.acquireLease({
      jobId: job.id,
      provider: project.config.provider ?? "github",
      serverUrl: project.config.serverUrl,
      repository: project.config.repo,
      write: true,
      minutes: 50,
    });
    // A connection refresh may take time. Recheck durable admission before handing off secrets.
    await stagingSync(projectFor(job.project!)).repairIntent(job);
    return createSyncRepairPayload({
      project,
      job,
      stagingSha: intent.stagingSha,
      integrationSha: intent.integrationSha,
      credential,
      claudeToken,
    });
  }
  const localLedger = (project: Project) =>
    createDeliveryService({
      root: options.root,
      project,
      forge: {} as Forge,
      now,
    });
  function candidateHandoffs(project: Project): CandidateHandoff[] {
    const values: CandidateHandoff[] = [];
    for (const area of [
      ...project.areas.filter((a) => a.key !== "combined"),
      { key: "combined", instanceId: undefined },
    ]) {
      validateName(area.key, "area");
      const file = join(
        options.root,
        ".run",
        "delivery",
        projectRuntimeKey(project.config),
        "candidate-handoffs",
        `${area.key}${area.instanceId ? `-${area.instanceId}` : ""}.json`,
      );
      assertNoSymlinks(file);
      if (!existsSync(file)) continue;
      const stat = lstatSync(file);
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > 16384)
        throw new Error(
          "Candidate handoff requires repair; existing evidence was preserved.",
        );
      const value = JSON.parse(readFileSync(file, "utf8")) as CandidateHandoff;
      if (
        area.key === "combined" &&
        value.ownershipRevision !== combinedOwnership(project)
      )
        continue;
      if (value.areaInstanceId !== area.instanceId) continue;
      if (
        value.project !== project.config.name ||
        value.repo !== project.config.repo ||
        value.area !== area.key ||
        !SHA.test(value.candidateSha) ||
        !SHA.test(value.baseSha) ||
        ![
          value.author,
          value.branch,
          value.releaseBranch,
          value.preparedAt,
        ].every(
          (v) =>
            typeof v === "string" &&
            v.length > 0 &&
            v.length < 500 &&
            !/[\r\n\0]/.test(v),
        ) ||
        !Array.isArray(value.changes) ||
        value.changes.length > 1000 ||
        value.changes.some((n) => !Number.isSafeInteger(n) || n <= 0)
      )
        throw new Error("Candidate handoff no longer matches this repository.");
      values.push({
        project: value.project,
        repo: value.repo,
        author: value.author,
        area: value.area,
        ...(value.ownershipRevision
          ? { ownershipRevision: value.ownershipRevision }
          : {}),
        ...(value.areaInstanceId
          ? { areaInstanceId: value.areaInstanceId }
          : {}),
        branch: value.branch,
        releaseBranch: value.releaseBranch,
        candidateSha: value.candidateSha,
        baseSha: value.baseSha,
        changes: [...value.changes],
        preparedAt: value.preparedAt,
      });
    }
    return values;
  }
  function combinedOwnership(project: Project) {
    return hash(
      JSON.stringify(
        project.areas
          .map((area) => [area.key, configHash(project, area.key)])
          .sort(([a], [b]) => a!.localeCompare(b!)),
      ),
    );
  }
  function saveCandidate(project: Project, value: CandidateHandoff) {
    validateName(value.area, "area");
    const areaInstanceId =
      value.area === "combined"
        ? undefined
        : project.areas.find((area) => area.key === value.area)?.instanceId;
    if (value.area === "combined")
      value.ownershipRevision = combinedOwnership(project);
    const directory = join(
        options.root,
        ".run",
        "delivery",
        projectRuntimeKey(project.config),
        "candidate-handoffs",
      ),
      file = join(
        directory,
        `${value.area}${areaInstanceId ? `-${areaInstanceId}` : ""}.json`,
      );
    assertNoSymlinks(file);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temporary = join(
      directory,
      `.${randomBytes(12).toString("hex")}.tmp`,
    );
    writeFileSync(
      temporary,
      JSON.stringify({
        ...value,
        ...(areaInstanceId ? { areaInstanceId } : {}),
      }),
      {
        flag: "wx",
        mode: 0o600,
      },
    );
    assertNoSymlinks(file);
    renameSync(temporary, file);
  }
  async function clients(
    project: Project,
    write = false,
    resolveChecks?: (sha: string) => Promise<CheckSummary>,
  ) {
    const env = environment();
    const credential = await source().resolveCredential({
      provider: project.config.provider ?? "github",
      serverUrl: project.config.serverUrl,
      repository: project.config.repo,
      write,
      minValidityMs: 60_000,
    });
    const forge =
      options.forge?.(project, credential.token) ??
      (project.config.provider === "gitlab"
        ? new GitLabForge({
            token: credential.token,
            serverUrl: project.config.serverUrl,
          })
        : new GitHubForge({ token: credential.token }));
    const connection =
      options.linearConnectionFor?.(project.config.linear?.connectionId) ??
      createLinearConnection({
        root: options.root,
        env,
        connectionId: project.config.linear?.connectionId,
      });
    const linearCredential = await connection.resolveCredential({
      workspaceId: project.config.linear?.workspaceId,
      minValidityMs: 60_000,
    });
    const linear =
      options.linear?.(linearCredential.authorization) ??
      new LinearApi({ apiKey: linearCredential.authorization });
    return {
      forge,
      linear,
      ledger: createDeliveryService({
        root: options.root,
        project,
        forge,
        linear,
        now,
        resolveChecks: resolveChecks ?? ((sha) => localChecks(project, sha)),
      }),
    };
  }
  const admissionFile = (project: string, jobId: string) => {
    validateName(project, "project");
    if (!/^job-[a-z0-9-]{1,58}$/.test(jobId))
      throw new Error("Invalid delivery job identifier.");
    const file = join(
      options.root,
      ".run",
      "delivery",
      projectRuntimeKey(projectFor(project).config),
      "admissions",
      `${jobId}.json`,
    );
    assertNoSymlinks(file);
    return file;
  };
  function admission(job: LocalJob): Admission | null {
    const file = admissionFile(job.project!, job.id);
    if (!existsSync(file)) return null;
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 256 * 1024)
      throw new Error(
        "Delivery admission is invalid; existing work was preserved.",
      );
    const value = JSON.parse(readFileSync(file, "utf8")) as Admission;
    if (
      value.schema !== 1 ||
      value.jobId !== job.id ||
      value.project !== job.project ||
      value.scopeHash !== ticketScopeHash(value.ticket)
    )
      throw new Error(
        "Delivery admission changed; inspect the original approved scope.",
      );
    return value;
  }
  async function reconcileQaRework(name: string) {
    const project = projectFor(name);
    if (!enabled(project) || !options.qaJobs || !options.enqueueQaRepair)
      return [];
    const { ledger } = await clients(project);
    const results: import("./types.ts").DeliveryRecord[] = [];
    for (const failed of ledger
      .list()
      .filter((r) => r.status === "failed" && r.review?.failures?.length)) {
      const record = await ledger.reserveQaRepair(failed.id);
      if (
        !record?.rework ||
        ["stopped", "awaiting-review"].includes(record.rework.phase)
      )
        continue;
      const current = projectFor(name);
      if (
        current.config.instanceId !== project.config.instanceId ||
        configHash(current, record.area) !== record.configuration
      ) {
        await ledger.noteQaRepair(
          record.rework.key,
          "stopped",
          "The project or owning PM changed. Review the preserved QA findings before starting new coding work.",
        );
        continue;
      }
      const jobs = await options.qaJobs();
      const matching = jobs.filter(
        (j) => j.idempotencyKey === record.rework!.key,
      );
      if (
        matching.length > 1 ||
        (matching[0] && !matchesQaRepair(matching[0], project, record))
      ) {
        await ledger.noteQaRepair(
          record.rework.key,
          "stopped",
          "QA repair job identity changed. Existing work was preserved for inspection.",
        );
        continue;
      }
      let job = matching[0];
      if (!job) {
        if (
          jobs.some(
            (j) =>
              j.project === name &&
              j.type === "developer" &&
              j.ticket === record.ticket.identifier &&
              ["queued", "running"].includes(j.status),
          )
        )
          continue;
        // The intent is durable before queueing. The queue's retained idempotency
        // key recovers a lost response or restart without launching a duplicate.
        job = await options.enqueueQaRepair(qaRepairInput(current, record));
      }
      const saved = ledger.list().find((r) => r.id === record.id);
      if (saved?.rework?.phase === "awaiting-review") {
        results.push(saved);
        continue;
      }
      if (!matchesQaRepair(job, project, record))
        throw new Error("The queue returned a different QA repair job.");
      if (["failed", "canceled", "succeeded"].includes(job.status)) {
        await ledger.noteQaRepair(
          record.rework.key,
          "stopped",
          job.status === "succeeded"
            ? "The coding run ended without a registered repair delivery. Inspect its report before choosing another approach."
            : "The coding repair stopped without a verified result. Inspect its failure or cancellation; automatic duplicate attempts are disabled.",
        );
        continue;
      }
      results.push(await ledger.admitQaRepair(job));
    }
    return results;
  }
  async function reconcileIntegrationRepairs(name: string) {
    const project = projectFor(name);
    if (
      !enabled(project) ||
      !project.config.verified ||
      !options.qaJobs ||
      !options.enqueueQaRepair
    )
      return;
    const { ledger, forge } = await clients(project);
    for (const candidate of ledger
      .list()
      .filter((r) => r.status === "awaiting-merge" && !r.supersededBy)) {
      let record = candidate;
      if (!record.integrationRepair) {
        const pull = await forge.getPull(
          project.config.repo,
          record.implementation.number,
        );
        if (
          !pull ||
          pull.state !== "open" ||
          pull.headSha !== record.implementation.headSha ||
          pull.headRef !== record.implementation.branch ||
          pull.author !== record.implementation.author ||
          pull.baseRef !== project.config.branches.integration
        )
          continue;
        const files = await forge.listPullFiles(
          project.config.repo,
          pull.number,
        );
        if (
          !files.length ||
          files.some((file) => matchesPrefix(file, project.tiers.hubOwnerOnly))
        )
          continue;
        const provider = await forge.getChecks(
          project.config.repo,
          pull.headSha,
        );
        if (provider.status === "pending") continue;
        let kind: "conflict" | "checks";
        if (pull.mergeableState === "dirty") kind = "conflict";
        else if (
          ["failure", "none"].includes(provider.status) &&
          (await localChecks(project, pull.headSha)).status === "failure"
        )
          kind = "checks";
        else continue; // Never ask an agent to fix permission/protection/provider failures.
        const integrationSha = await forge.getBranchSha(
          project.config.repo,
          project.config.branches.integration,
        );
        if (!integrationSha) continue;
        // An unhealthy baseline is not a defect in this ticket's implementation.
        if ((await localChecks(project, integrationSha)).status !== "success")
          continue;
        if (configHash(projectFor(name), record.area) !== record.configuration)
          continue;
        const reserved = await ledger.reserveIntegrationRepair({
          deliveryId: record.id,
          kind,
          integrationSha,
        });
        if (!reserved) continue;
        record = reserved;
      }
      if (["stopped", "replaced"].includes(record.integrationRepair!.phase))
        continue;
      const jobs = await options.qaJobs();
      const matching = jobs.filter(
        (job) => job.idempotencyKey === record.integrationRepair!.key,
      );
      if (
        matching.length > 1 ||
        (matching[0] && !matchesIntegrationRepair(matching[0], project, record))
      ) {
        await ledger.stopIntegrationRepair(
          record.integrationRepair!.key,
          "Pre-merge repair queue identity changed. Preserved drafts need inspection.",
        );
        continue;
      }
      let job = matching[0];
      if (!job) {
        if (
          jobs.some(
            (j) =>
              j.project === name &&
              j.ticket === record.ticket.identifier &&
              j.type === "developer" &&
              ["queued", "running"].includes(j.status),
          )
        )
          continue;
        job = await options.enqueueQaRepair(
          integrationRepairInput(project, record),
        );
      }
      if (ledger.list().find((r) => r.id === record.id)?.supersededBy) continue;
      if (!matchesIntegrationRepair(job, project, record))
        throw new Error("The queue returned a different pre-merge repair.");
      if (["failed", "canceled", "succeeded"].includes(job.status)) {
        await ledger.stopIntegrationRepair(
          record.integrationRepair!.key,
          "The one automatic pre-merge repair stopped without a registered replacement. Inspect its report and preserved draft; no duplicate run will launch.",
        );
        continue;
      }
      try {
        await ledger.admitIntegrationRepair(job);
      } catch {
        await ledger.stopIntegrationRepair(
          record.integrationRepair!.key,
          "The approved ticket, original draft or project changed. Automatic pre-merge repair stopped; existing work is preserved.",
        );
      }
    }
  }
  async function beforeDeveloper(
    job: LocalJob,
    payload: DockerJobPayload,
    ticket: LinearTicket,
  ): Promise<DockerJobPayload> {
    const project = projectFor(job.project!);
    const repairing = job.idempotencyKey?.startsWith("qa-rework:");
    const integrationRepairing = job.idempotencyKey?.startsWith(
      "integration-repair:",
    );
    if (!enabled(project)) {
      if (repairing || integrationRepairing)
        throw new Error("QA repair requires the admitted promotion workflow.");
      return payload;
    }
    if (
      !job.area ||
      !payload.delivery ||
      payload.delivery.branch !== `gremlins/${job.id}` ||
      payload.delivery.base !== project.config.branches.integration
    )
      throw new Error(
        "Promotion coding must target its exact integration branch and owning PM.",
      );
    let repair: import("./types.ts").DeliveryRecord | undefined;
    let integrationRepair: import("./types.ts").DeliveryRecord | undefined;
    if (integrationRepairing) {
      const { ledger } = await clients(project);
      integrationRepair = await ledger.admitIntegrationRepair(job);
      if (
        ticketScopeHash(ticket) !== integrationRepair.scopeHash ||
        ticket.id !== integrationRepair.ticket.id ||
        configHash(projectFor(project.config.name), integrationRepair.area) !==
          integrationRepair.configuration
      )
        throw new Error(
          "The pre-merge repair must retain the exact current approved scope and owning PM.",
        );
      payload = integrationRepairPayload(payload, integrationRepair);
    }
    if (repairing) {
      const { ledger, forge } = await clients(project);
      repair = await ledger.admitQaRepair(job);
      if (
        ticketScopeHash(ticket) !== repair.scopeHash ||
        ticket.id !== repair.ticket.id
      )
        throw new Error(
          "QA repair must retain the same approved ticket scope.",
        );
      const integrationSha = await forge.getBranchSha(
        project.config.repo,
        project.config.branches.integration,
      );
      if (
        !integrationSha ||
        !repair.implementation.mergeSha ||
        (
          await forge.compare(
            project.config.repo,
            repair.implementation.mergeSha,
            integrationSha,
          )
        ).behindBy !== 0
      )
        throw new Error(
          "The current integration branch no longer contains the reviewed implementation.",
        );
      payload = {
        ...payload,
        expectedCommitSha: integrationSha,
        prompt: (payload.prompt ?? "") + qaRepairPrompt(repair),
      };
    }
    if (repair) {
      const current = projectFor(project.config.name);
      if (
        current.config.instanceId !== project.config.instanceId ||
        configHash(current, repair.area) !== repair.configuration
      )
        throw new Error(
          "Project or owning PM changed while preparing QA repair.",
        );
    }
    const snapshot: Admission = {
      schema: 1,
      jobId: job.id,
      area: job.area,
      project: project.config.name,
      repository: project.config.repo,
      configuration: configHash(project, job.area),
      ticket: structuredClone(ticket),
      scopeHash: ticketScopeHash(ticket),
      approvedAt:
        repair?.approvedAt ??
        integrationRepair?.approvedAt ??
        now().toISOString(),
      ...(repair ? { qaRepairKey: repair.rework!.key } : {}),
      ...(integrationRepair
        ? { integrationRepairKey: integrationRepair.integrationRepair!.key }
        : {}),
    };
    const existing = admission(job);
    if (existing) {
      if (
        existing.configuration !== snapshot.configuration ||
        existing.scopeHash !== snapshot.scopeHash ||
        existing.qaRepairKey !== snapshot.qaRepairKey ||
        existing.integrationRepairKey !== snapshot.integrationRepairKey
      )
        throw new Error(
          "The original coding admission changed. Queue a new reviewed attempt.",
        );
      return payload;
    }
    const file = admissionFile(job.project!, job.id),
      directory = join(file, "..");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    // Exclusive creation makes duplicate controllers preserve the first observed scope.
    try {
      writeFileSync(file, JSON.stringify(snapshot), {
        flag: "wx",
        mode: 0o600,
      });
    } catch {
      const saved = admission(job);
      if (
        !saved ||
        saved.scopeHash !== snapshot.scopeHash ||
        saved.configuration !== snapshot.configuration
      )
        throw new Error("Coding approval snapshot could not be saved safely.");
    }
    return payload;
  }
  async function deployment(
    project: Project,
    branch = project.config.branches.integration,
  ): Promise<ReviewDeployment> {
    const verification = effectiveVerification(project.config);
    if (
      verification.mode !== "browser" ||
      !["vercel", "railway"].includes(verification.target.kind)
    )
      throw new Error(
        "Delivery review needs a Vercel or Railway environment that reports its exact deployed Git SHA.",
      );
    assertBrowserSecretSafety(project.config, options.root);
    const target = deliveryEnvironment(project, branch);
    const resolved = await (options.resolveEnvironment ?? resolveEnvironment)(
      target,
      {
        env: environment(),
        branch,
        vercelConnectionFor:
          options.vercelConnectionFor ??
          ((connectionId) =>
            createVercelConnection({
              root: options.root,
              env: environment(),
              connectionId,
            })),
      },
    );
    if (
      !resolved.deploymentId ||
      !resolved.commitSha ||
      !SHA.test(resolved.commitSha) ||
      resolved.branch !== branch
    )
      throw new Error(
        "Hosting has not reported an exact ready deployment for this branch. Wait for deployment or fix branch metadata.",
      );
    return {
      id: resolved.deploymentId,
      url: resolved.url,
      sha: resolved.commitSha,
      branch,
      provider: resolved.provider,
      state: "READY",
    };
  }
  async function pendingReviews(name: string): Promise<LocalJobInput[]> {
    const project = projectFor(name);
    if (!enabled(project) || !project.config.verified) return [];
    if (
      !localLedger(project)
        .list()
        .some((record) =>
          ["awaiting-merge", "awaiting-deployment", "awaiting-review"].includes(
            record.status,
          ),
        )
    )
      return [];
    const target = await deployment(project);
    const { ledger } = await clients(project);
    const candidates = await ledger.reviewCandidates(target);
    return project.areas.flatMap((area): LocalJobInput[] => {
      const records = candidates
        .filter((record) => record.area === area.key)
        .map((record) => ({ id: record.id, scope: record.scopeHash }))
        .sort((a, b) => a.id.localeCompare(b.id));
      if (!records.length) return [];
      const revision = knowledgeRevision(project, area);
      // Hash identifiers instead of embedding the '~' in a project runtime key.
      const key = hash(
        JSON.stringify({
          project: projectRuntimeKey(project.config),
          area: area.key,
          owner: area.instanceId,
          configuration: configHash(project, area.key),
          revision,
          target,
          records,
        }),
      );
      return [
        {
          type: "pm",
          project: name,
          ...(project.config.instanceId
            ? { projectInstanceId: project.config.instanceId }
            : {}),
          area: area.key,
          runOnce: true,
          discoveryRevision: revision,
          idempotencyKey: `delivery-review:${key}`,
        },
      ];
    });
  }
  async function pinPmBaseline(
    job: LocalJob,
    payload: DockerJobPayload,
  ): Promise<DockerJobPayload> {
    const project = projectFor(job.project!);
    if (enabled(project) && job.pmMode !== "discovery") {
      await beforePmStart(job);
      let target: ReviewDeployment;
      try {
        target = await deployment(project);
      } catch {
        throw new LocalJobDeferredError(
          "Waiting for the current PM deployment to become available.",
          "environment-wait",
        );
      }
      const status = stagingSync(project).status();
      if (
        target.sha !== status.integrationSha ||
        target.branch !== payload.branch
      )
        throw new LocalJobDeferredError(
          "The PM test deployment changed during preparation. Waiting for its current revision.",
          "environment-wait",
        );
      payload = {
        ...payload,
        expectedCommitSha: target.sha,
        browserTarget: target.url,
        prompt: payload.browserTarget
          ? payload.prompt?.split(payload.browserTarget).join(target.url)
          : payload.prompt,
      };
    }
    return payload;
  }
  async function beforePm(
    job: LocalJob,
    payload: DockerJobPayload,
  ): Promise<DockerJobPayload> {
    const project = projectFor(job.project!);
    payload = await pinPmBaseline(job, payload);
    if (
      !enabled(project) ||
      job.pmMode ||
      !job.area ||
      !localLedger(project)
        .list()
        .some((r) => r.area === job.area && !r.promotion)
    )
      return payload;
    const { ledger } = await clients(project);
    let reviewDeployment: ReviewDeployment;
    try {
      reviewDeployment = await deployment(project);
    } catch {
      throw new LocalJobDeferredError(
        "Waiting for the current integration deployment before preparing its review.",
        "environment-wait",
      );
    }
    if (
      reviewDeployment.sha !== payload.expectedCommitSha ||
      reviewDeployment.url !== payload.browserTarget
    )
      throw new LocalJobDeferredError(
        "The integration deployment moved during preparation. Waiting to admit one matching checkout and browser deployment.",
        "environment-wait",
      );
    let plan: PmReviewPlan | null;
    try {
      plan = await ledger.prepareReview({
        area: job.area,
        jobId: job.id,
        deployment: reviewDeployment,
      });
    } catch {
      await ledger.reviewUnavailable(job.area);
      if (job.idempotencyKey?.startsWith("delivery-review:"))
        throw new Error(
          "The deployment-triggered review could not admit its exact deployment and checks. Review Delivery before retrying; no verification was performed.",
        );
      return {
        ...payload,
        prompt:
          (payload.prompt ?? "") +
          "\nDelivery verification is waiting for exact integration deployment and successful checks. Continue ordinary PM observation; do not claim delivery verification or promote any change in this run.",
      };
    }
    if (!plan) {
      if (job.idempotencyKey?.startsWith("delivery-review:"))
        throw new Error(
          "The deployment-triggered review no longer has eligible approved deliveries. Review Delivery; this run cannot count as verification.",
        );
      return payload;
    }
    if (
      payload.branch !== plan.deployment.branch ||
      payload.browserVerification !== true
    )
      throw new Error(
        "The owning PM must inspect the exact integration deployment before delivery verification.",
      );
    if (
      payload.expectedCommitSha !== plan.deployment.sha ||
      payload.browserTarget !== plan.deployment.url
    )
      throw new LocalJobDeferredError(
        "The integration deployment moved while its review was being prepared. Waiting to admit one matching checkout and browser deployment.",
        "environment-wait",
      );
    return {
      ...payload,
      reviewPlan: plan,
      browserTarget: plan.deployment.url,
      prompt: (payload.prompt ?? "") + reviewPrompt(plan),
    };
  }
  async function completeJob(
    job: LocalJob,
    result: Record<string, unknown>,
    docker: DockerRunners,
  ): Promise<void> {
    // Sync repair publication is independently inspected by staging reconciliation,
    // never registered as an approved product ticket or promoted to production.
    if (job.developerKind === "sync") return;
    if (!job.project || !["pm", "developer"].includes(job.type) || job.pmMode)
      return;
    const project = projectFor(job.project);
    if (!enabled(project)) return;
    if (
      result.ok !== true ||
      result.nonce !== job.id ||
      result.kind !== job.type
    )
      throw new Error(
        "Delivery reconciliation requires the completed worker's bound result.",
      );
    if (job.type === "developer") {
      if (result.noChanges === true) {
        const captured = admission(job);
        if (captured?.integrationRepairKey)
          await localLedger(project).stopIntegrationRepair(
            captured.integrationRepairKey,
            "The pre-merge repair produced no change. Inspect the preserved draft and report; no automatic duplicate will launch.",
          );
        if (captured?.qaRepairKey)
          await localLedger(project).noteQaRepair(
            captured.qaRepairKey,
            "stopped",
            "The coding repair produced no change. Automatic retries stopped; inspect the failed QA evidence and coding report.",
          );
        return;
      }
      const captured = admission(job);
      if (!captured)
        throw new Error(
          "No original coding approval snapshot exists. Review this draft manually; do not rerun it automatically.",
        );
      if (
        captured.repository !== project.config.repo ||
        captured.configuration !== configHash(project, captured.area)
      )
        throw new Error(
          "Project or owning PM changed during coding. The published draft is preserved for manual reconciliation.",
        );
      const origin = new URL(
        project.config.serverUrl ??
          (project.config.provider === "gitlab"
            ? "https://gitlab.com"
            : "https://github.com"),
      );
      const url = new URL(String(result.prUrl));
      const prefix = `/${project.config.repo}/${project.config.provider === "gitlab" ? "-/merge_requests" : "pull"}/`;
      const number = Number(url.pathname.slice(prefix.length));
      if (
        url.origin !== origin.origin ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        !url.pathname.startsWith(prefix) ||
        !Number.isSafeInteger(number) ||
        number <= 0 ||
        !SHA.test(String(result.headSha))
      )
        throw new Error(
          "The worker did not provide an exact source-provider draft and tested head.",
        );
      const { forge, ledger } = await clients(project);
      const pull = await forge.getPull(project.config.repo, number);
      if (!pull || pull.headSha !== result.headSha)
        throw new Error(
          "The published draft moved after its checks. Review its new head before delivery registration.",
        );
      const providerChecks = await forge.getChecks(
        project.config.repo,
        pull.headSha,
      );
      const independentChecks =
        providerChecks.status === "none"
          ? await localChecks(project, pull.headSha)
          : providerChecks;
      await ledger.register({
        jobId: job.id,
        area: captured.area,
        ticket: captured.ticket,
        pullNumber: number,
        approvedBy: "controller-observed Linear pm-approved label",
        approvedAt: captured.approvedAt,
        ...(captured.qaRepairKey ? { qaRepairKey: captured.qaRepairKey } : {}),
        ...(captured.integrationRepairKey
          ? { integrationRepairKey: captured.integrationRepairKey }
          : {}),
        expectedHeadSha: String(result.headSha),
        ...(independentChecks.status === "success"
          ? {
              checks: {
                headSha: String(result.headSha),
                commands: Object.entries(project.config.commands)
                  .filter(([, command]) => !!command)
                  .map(([key]) => key),
                completedAt: now().toISOString(),
              },
            }
          : {}),
      });
      return;
    }
    const plan = localLedger(project).planForJob(job.id);
    if (!plan) return;
    if (!docker.verifyReview)
      throw new Error(
        "Upgrade the worker to support isolated delivery review. Model-container proof files cannot authorize promotion.",
      );
    const current = await deployment(project);
    if (JSON.stringify(current) !== JSON.stringify(plan.deployment))
      throw new Error(
        "Integration deployment moved before independent review. Queue a new owning-PM patrol.",
      );
    const verification = effectiveVerification(project.config);
    const bypass =
      verification.mode === "browser" &&
      verification.target.kind === "vercel" &&
      verification.target.bypassSecret
        ? environment()[verification.target.bypassSecret]
        : undefined;
    const verified = await docker.verifyReview(job.id, plan, { bypass });
    const bytes = verified.proof;
    if (bytes.length > 1024 * 1024)
      throw new Error("Independent review proof exceeds its bounded size.");
    const proof: unknown = JSON.parse(bytes.toString("utf8"));
    if (
      !object(proof) ||
      !object(proof.receipts) ||
      proof.receipts.jobId !== job.id ||
      proof.receipts.planId !== plan.id ||
      proof.receipts.commitSha !== plan.deployment.sha ||
      !Array.isArray(proof.receipts.receipts)
    )
      throw new Error(
        "PM review receipts belong to another job or deployment.",
      );
    const receipts = proof.receipts.receipts;
    const { ledger } = await clients(project);
    await ledger.ingestReview({
      planId: plan.id,
      manifest: proof.manifest,
      trustedResult: verified.result,
      deployment: await deployment(project),
      verifyAssertion: async ({ receiptId, deliveryId, criterion }) =>
        receipts.filter(
          (r) =>
            object(r) &&
            r.id === receiptId &&
            r.deliveryId === deliveryId &&
            r.criterion === criterion &&
            r.jobId === job.id &&
            r.planId === plan.id &&
            r.status === "passed" &&
            r.testedSha === plan.deployment.sha &&
            r.deploymentId === plan.deployment.id &&
            typeof r.url === "string" &&
            new URL(r.url).origin === new URL(plan.deployment.url).origin,
        ).length === 1,
      verifyArtifact: async ({ name, sha256 }) => {
        if (
          !receipts.some(
            (r) =>
              object(r) &&
              object(r.screenshot) &&
              r.screenshot.name === name &&
              r.screenshot.sha256 === sha256,
          )
        )
          return false;
        const artifact = await docker.readArtifact(job.id, name);
        return (
          artifact.length <= 10 * 1024 * 1024 &&
          artifact
            .subarray(0, 8)
            .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
          hash(artifact) === sha256
        );
      },
      failureEvidence: async ({ receiptId, deliveryId, criterion }) => {
        const found = receipts.filter(
          (r) =>
            object(r) &&
            r.id === receiptId &&
            r.deliveryId === deliveryId &&
            r.criterion === criterion &&
            r.jobId === job.id &&
            r.planId === plan.id &&
            r.status === "failed" &&
            r.testedSha === plan.deployment.sha &&
            r.deploymentId === plan.deployment.id,
        );
        const receipt =
          found.length === 1 && object(found[0]) ? found[0] : null;
        if (
          !receipt ||
          !object(receipt.check) ||
          !object(receipt.screenshot) ||
          typeof receipt.url !== "string"
        )
          return null;
        const check = receipt.check;
        if (
          ![
            "text-visible",
            "text-absent",
            "selector-visible",
            "selector-absent",
            "url-path",
          ].includes(String(check.kind))
        )
          return null;
        const target = String(check.kind).startsWith("text-")
          ? check.text
          : String(check.kind).startsWith("selector-")
            ? check.selector
            : check.expected;
        if (
          typeof target !== "string" ||
          !target ||
          target.length > 1000 ||
          typeof check.path !== "string" ||
          !/^\/(?!\/)/.test(check.path) ||
          /[?#\\]/.test(check.path)
        )
          return null;
        let url: URL;
        try {
          url = new URL(receipt.url);
        } catch {
          return null;
        }
        if (
          url.origin !== new URL(plan.deployment.url).origin ||
          url.username ||
          url.password
        )
          return null;
        url.search = "";
        url.hash = "";
        const finding = {
          criterion,
          receiptId,
          expected: `At ${check.path}, expected ${check.kind}: ${target}. The independently replayed predicate evaluated false.`,
          url: url.href,
          screenshot: receipt.screenshot,
        };
        return validQaFinding(finding) ? finding : null;
      },
    });
  }
  async function promote(name: string, opts: PromoteOpts) {
    const project = projectFor(name);
    if (!enabled(project))
      throw new Error(
        "Choose the promotion workflow before packaging deliveries.",
      );
    const { forge, linear, ledger } = await clients(project, true);
    const authors = [
      ...new Set(
        ledger
          .list()
          .filter((r) => ["verified", "promoted"].includes(r.status))
          .map((r) => r.implementation.author),
      ),
    ];
    if (authors.length !== 1)
      throw new Error(
        "Selective promotion needs verified deliveries from one trusted publishing identity.",
      );
    const ctx: Ctx = {
      project,
      hub: loadHub(options.root),
      forge,
      linear,
      botLogin: authors[0]!,
      now,
      dryRun: false,
      log: () => {},
      vercel: {
        latestDeployment: async () => null,
        branchUrl: async () => null,
      },
      slack: { post: async () => {} },
      resolveChecks: (sha) => localChecks(project, sha),
      resolveDeployment: async (branch, sha) => {
        const d = await deployment(project, branch);
        return d.sha === sha
          ? { ...d, url: new URL(d.url).host, createdAt: now().toISOString() }
          : null;
      },
    };
    const env = environment();
    const publishReviewedCandidate =
      !opts.verifyCandidate &&
      !env.SHIPGREMLINS_VERIFICATION_FILE &&
      !env.SHIPGREMLINS_ATTESTATION_PUBLIC_KEY;
    const verifier =
      opts.verifyCandidate ??
      createCandidateVerifier(ctx, {
        file: env.SHIPGREMLINS_VERIFICATION_FILE,
        key: env.SHIPGREMLINS_ATTESTATION_PUBLIC_KEY,
      });
    const accepted: Array<{
      candidate: Parameters<typeof verifier>[0];
      evidence: Awaited<ReturnType<typeof verifier>>;
    }> = [];
    const rows = await runPromote(ctx, {
      ...opts,
      ...ledger.promotionOptions(),
      publishReviewedCandidate,
      onPublished: async (candidate, pull) => {
        if (publishReviewedCandidate)
          await ledger.recordPromotion({
            deliveryIds: ledger
              .list()
              .filter((record) =>
                candidate.changes.includes(record.implementation.number),
              )
              .map((record) => record.id),
            pullNumber: pull.number,
            candidate,
            reviewedCandidate: true,
            trustedAuthor: ctx.botLogin,
          });
        await opts.onPublished?.(candidate, pull);
      },
      onCandidatePrepared: async (candidate) => {
        const area = candidate.releaseBranch.split("/")[1];
        if (
          !area ||
          (area !== "combined" && !project.areas.some((a) => a.key === area))
        )
          throw new Error("Candidate has no configured owning PM.");
        saveCandidate(project, {
          project: project.config.name,
          repo: project.config.repo,
          author: ctx.botLogin,
          area,
          branch: candidate.branch,
          releaseBranch: candidate.releaseBranch,
          candidateSha: candidate.sha,
          baseSha: candidate.baseSha,
          changes: [...candidate.changes],
          preparedAt: now().toISOString(),
        });
        await opts.onCandidatePrepared?.(candidate);
      },
      verifyCandidate: publishReviewedCandidate
        ? undefined
        : async (candidate) => {
            const evidence = await verifier(candidate);
            if (evidence.ok) accepted.push({ candidate, evidence });
            return evidence;
          },
    });
    for (const captured of accepted) {
      const pull = (
        await forge.listOpenPulls(project.config.repo, {
          base: project.config.branches.staging,
        })
      ).find(
        (p) =>
          p.headRef === captured.candidate.releaseBranch &&
          p.headSha === captured.candidate.sha,
      );
      if (pull)
        await ledger.recordPromotion({
          deliveryIds: ledger
            .list()
            .filter((r) =>
              captured.candidate.changes.includes(r.implementation.number),
            )
            .map((r) => r.id),
          pullNumber: pull.number,
          ...captured,
          trustedAuthor: ctx.botLogin,
        });
    }
    return rows;
  }
  async function contextFor(
    project: Project,
    resolveChecks?: (sha: string) => Promise<CheckSummary>,
  ) {
    const { forge, linear, ledger } = await clients(
      project,
      true,
      resolveChecks,
    );
    const authors = [
      ...new Set(ledger.list().map((r) => r.implementation.author)),
    ];
    if (authors.length !== 1)
      throw new Error(
        "Delivery reconciliation needs one verified publishing identity; review mixed-author deliveries explicitly.",
      );
    const ctx: Ctx = {
      project,
      hub: loadHub(options.root),
      forge,
      linear,
      botLogin: authors[0]!,
      now,
      dryRun: false,
      log: () => {},
      vercel: {
        latestDeployment: async () => null,
        branchUrl: async () => null,
      },
      slack: { post: async () => {} },
      resolveChecks: resolveChecks ?? ((sha) => localChecks(project, sha)),
      resolveDeployment: async (branch, sha) => {
        const d = await deployment(project, branch);
        return d.sha === sha
          ? { ...d, url: new URL(d.url).host, createdAt: now().toISOString() }
          : null;
      },
    };
    return { ctx, ledger };
  }
  const declarationsFor = (project: Project) =>
    createProductionDeclarations({
      root: options.root,
      project,
      ledger: localLedger(project),
      context: async () => (await contextFor(project)).ctx,
      now,
    });
  async function preparePromotion(
    name: string,
    input: { area?: string; docker: Pick<DockerRunners, "ensureImage"> },
  ) {
    const project = projectFor(name);
    if (!enabled(project))
      throw new Error(
        "Selective promotion is not configured for this project.",
      );
    if (input.area && !project.areas.some((a) => a.key === input.area))
      throw new Error("Choose a configured owning PM area.");
    const access = source(),
      jobId = `job-promotion-${randomBytes(12).toString("hex")}`;
    const target = {
      provider: project.config.provider ?? ("github" as const),
      serverUrl: project.config.serverUrl,
      repository: project.config.repo,
      write: true,
    };
    const credential = access.acquireLease
      ? await access.acquireLease({ ...target, jobId, minutes: 50 })
      : await access.resolveCredential({
          ...target,
          minValidityMs: 50 * 60_000,
        });
    try {
      const executor = await (options.executor ?? createPromotionExecutor)({
        root: options.root,
        project,
        token: credential.token,
        docker: input.docker,
      });
      return await promote(name, executor);
    } finally {
      await access.releaseLease?.(jobId);
    }
  }
  async function advanceIntegration(name: string) {
    const project = projectFor(name);
    const pending = localLedger(project)
      .list()
      .filter((r) => r.status === "awaiting-merge");
    if (!enabled(project) || !pending.length) return null;
    const resolved = new Map<string, CheckSummary>();
    const { ctx, ledger } = await contextFor(
      project,
      async (sha) => resolved.get(sha) ?? { status: "none", failedJobs: [] },
    );
    // Builds may take minutes. Never hold the delivery ledger lock while running them.
    let eligible = false;
    for (const record of pending) {
      const sha = record.implementation.headSha;
      const checks = await ctx.forge.getChecks(project.config.repo, sha);
      if (
        checks.status === "success" ||
        (checks.status === "none" && record.checks)
      ) {
        eligible = true;
        continue;
      }
      if (checks.status === "none") {
        const checked = await localChecks(project, sha);
        resolved.set(sha, checked);
        if (checked.status === "success") eligible = true;
      }
    }
    if (eligible) {
      const integrationSha = await ctx.forge.getBranchSha(
        project.config.repo,
        project.config.branches.integration,
      );
      if (
        integrationSha &&
        (await ctx.forge.getChecks(project.config.repo, integrationSha))
          .status === "none"
      )
        resolved.set(
          integrationSha,
          await localChecks(project, integrationSha),
        );
    }
    const latest = projectFor(name);
    if (
      pending.some(
        (record) =>
          configHash(latest, record.area) !== configHash(project, record.area),
      )
    )
      throw new Error(
        "Project delivery settings changed during independent checks. Retry using the current configuration.",
      );
    return ledger.advanceIntegration(
      async () => (await integrationHealth(ctx)).state === "healthy",
    );
  }
  async function reconcileCompletedDrafts(name: string) {
    const project = projectFor(name);
    if (
      !enabled(project) ||
      !project.config.verified ||
      !options.completedDrafts
    )
      return [];
    const registered = new Set(
      localLedger(project)
        .list()
        .map((record) => record.jobId),
    );
    const completed = (await options.completedDrafts(name)).filter(
      (item) => !registered.has(item.job.id),
    );
    if (!completed.length) return [];
    let access: Awaited<ReturnType<typeof clients>>;
    try {
      access = await clients(project, true);
    } catch {
      return completed
        .filter(
          ({ job, change }) =>
            jobBelongsToProject(project.config, job) &&
            job.type === "developer" &&
            (job.developerKind === undefined ||
              job.developerKind === "build") &&
            job.status === "succeeded" &&
            !job.cancelRequestedAt &&
            /^job-[a-z0-9-]{1,58}$/.test(job.id) &&
            change.jobId === job.id &&
            change.status === "succeeded" &&
            change.pullRequests.length > 0 &&
            !change.noChanges,
        )
        .map(({ job }) => {
          const result = {
            jobId: job.id,
            phase: "blocked" as const,
            message:
              "Repository or Linear access is unavailable. Check this project's saved connections. ShipGremlins will retry this draft automatically.",
          };
          try {
            saveDraftMigrationStatus(options.root, project, {
              ...result,
              checkedAt: now().toISOString(),
            });
          } catch {
            /* A status-storage failure cannot expose provider errors or authorize migration. */
          }
          return result;
        });
    }
    const { forge, linear, ledger } = access;
    const adoption = createDraftAdoption({
      root: options.root,
      project,
      currentProject: () => projectFor(name),
      forge,
      now,
      ticket: (id) => linear.getTicket(id),
      checkHead: (sha) => localChecks(project, sha),
      registered: (jobId) =>
        ledger.list().some((record) => record.jobId === jobId),
      register: (migration) => {
        if (
          projectRuntimeKey(projectFor(name).config) !==
            migration.projectInstance ||
          configHash(projectFor(name), migration.area) !==
            migration.configuration
        )
          throw new Error("Draft migration configuration changed.");
        return ledger.register({
          jobId: migration.jobId,
          area: migration.area,
          ticket: migration.ticket,
          pullNumber: migration.pullNumber,
          approvedBy: migration.approvedBy,
          approvedAt: migration.approvedAt,
          checks: migration.checks,
          expectedHeadSha: migration.headSha,
        });
      },
    });
    const results = [];
    for (const item of completed) results.push(await adoption.adopt(item));
    return results;
  }
  async function localChecks(
    project: Project,
    sha: string,
  ): Promise<CheckSummary> {
    if (!SHA.test(sha) || !options.docker)
      return { status: "none", failedJobs: [] };
    const image = await options.docker.ensureImage();
    const commandHash = hash(JSON.stringify(project.config.commands));
    const directory = join(
        options.root,
        ".run",
        "delivery",
        projectRuntimeKey(project.config),
        "checks",
      ),
      file = join(directory, `${sha}-${commandHash}.json`);
    assertNoSymlinks(file);
    if (existsSync(file)) {
      const stat = lstatSync(file);
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > 4096)
        throw new Error(
          "Local check receipt is unsafe; preserve and inspect it.",
        );
      const receipt = JSON.parse(readFileSync(file, "utf8"));
      const age = now().getTime() - Date.parse(receipt.createdAt);
      if (
        receipt.sha === sha &&
        receipt.commandHash === commandHash &&
        receipt.image === image &&
        age >= 0 &&
        age < (receipt.status === "success" ? 24 * 60 * 60_000 : 5 * 60_000) &&
        ["success", "failure"].includes(receipt.status)
      )
        return {
          status: receipt.status,
          failedJobs:
            receipt.status === "failure"
              ? [{ name: "local configured checks", url: "" }]
              : [],
        };
    }
    const access = source(),
      jobId = `job-checks-${randomBytes(12).toString("hex")}`,
      target = {
        provider: project.config.provider ?? ("github" as const),
        serverUrl: project.config.serverUrl,
        repository: project.config.repo,
      };
    const credential = access.acquireLease
      ? await access.acquireLease({ ...target, jobId, minutes: 50 })
      : await access.resolveCredential({
          ...target,
          minValidityMs: 50 * 60_000,
        });
    try {
      const executor = await (options.executor ?? createPromotionExecutor)({
        root: options.root,
        project,
        token: credential.token,
        docker: options.docker,
      });
      const checkedOut = await executor.git.run(
        ["checkout", "--detach", sha],
        executor.checkoutDir,
      );
      const actual = await executor.git.run(
        ["rev-parse", "HEAD"],
        executor.checkoutDir,
      );
      if (
        checkedOut.code !== 0 ||
        actual.code !== 0 ||
        actual.out.trim() !== sha
      )
        throw new Error(
          "Could not check out the exact integration revision for local checks.",
        );
      const checked = await executor.check(executor.checkoutDir);
      const status = checked.ok ? "success" : "failure";
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const temporary = join(
        directory,
        `.${randomBytes(12).toString("hex")}.tmp`,
      );
      writeFileSync(
        temporary,
        JSON.stringify({
          sha,
          commandHash,
          image,
          status,
          createdAt: now().toISOString(),
        }),
        { flag: "wx", mode: 0o600 },
      );
      assertNoSymlinks(file);
      renameSync(temporary, file);
      return {
        status,
        failedJobs: checked.ok
          ? []
          : [{ name: "local configured checks", url: "" }],
      };
    } finally {
      await access.releaseLease?.(jobId);
    }
  }
  return {
    beforePmStart,
    pinPmBaseline,
    prepareSyncRepair,
    reconcileStaging: (name: string) =>
      stagingSync(projectFor(name)).reconcile(),
    beforeDeveloper,
    beforePm,
    pendingReviews,
    completeJob,
    promote,
    preparePromotion,
    reconcileQaRework,
    reconcileIntegrationRepairs,
    reconcileCompletedDrafts,
    promotionBatch: async (name: string) => {
      const project = projectFor(name);
      if (!enabled(project)) return null;
      const credential = await source().resolveCredential({
        provider: project.config.provider ?? "github",
        serverUrl: project.config.serverUrl,
        repository: project.config.repo,
        write: false,
        minValidityMs: 60_000,
      });
      const forge =
        options.forge?.(project, credential.token) ??
        (project.config.provider === "gitlab"
          ? new GitLabForge({
              token: credential.token,
              serverUrl: project.config.serverUrl,
            })
          : new GitHubForge({ token: credential.token }));
      return readPromotionBatch({
        project,
        forge,
        records: localLedger(project).list(),
        now,
      });
    },
    prepareRelease: async (name: string) => {
      const project = projectFor(name);
      const { forge } = await clients(project, true);
      return prepareProductionRelease({
        project,
        forge,
        resolveChecks: (sha) => localChecks(project, sha),
      });
    },
    advanceIntegration,
    declareProduction: (name: string, input: ProductionDeclarationInput) =>
      declarationsFor(projectFor(name)).declare(input),
    reconcileProduction: (name: string) =>
      declarationsFor(projectFor(name)).reconcile(),
    deliveryStatus: (name: string) => {
      const project = projectFor(name);
      return {
        ...declarationsFor(project).status(),
        candidates: candidateHandoffs(project),
        enabled: enabled(project),
        stagingSync: stagingSync(project).status(),
        deliveries: localLedger(project).list(),
        draftMigrations: readDraftMigrations(options.root, project),
        candidateEnvironment:
          effectiveWorkflow(project.config).kind === "promotion"
            ? ((
                effectiveWorkflow(project.config) as {
                  candidateEnvironment?: string;
                }
              ).candidateEnvironment ?? null)
            : null,
        candidateTargets: Object.entries(project.config.environments ?? {})
          .filter(
            ([, target]) =>
              target.role !== "production" &&
              ["railway", "vercel"].includes(target.kind),
          )
          .map(([name, target]) => ({ name, ...target })),
        message: enabled(project)
          ? "Owning-PM review and exact candidate evidence are required; production merge proof alone can complete tickets."
          : "This project uses draft pull requests; selective promotion is not configured.",
      };
    },
  };
}
