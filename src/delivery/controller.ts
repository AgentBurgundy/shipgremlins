import { projectRuntimeKey } from "../projectIdentity.ts";
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
import { loadHub, loadProject, type Project } from "../config.ts";
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
}
export interface CandidateHandoff {
  project: string;
  repo: string;
  author: string;
  area: string;
  areaInstanceId?: string;
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
  const localLedger = (project: Project) =>
    createDeliveryService({
      root: options.root,
      project,
      forge: {} as Forge,
      now,
    });
  function candidateHandoffs(project: Project): CandidateHandoff[] {
    const values: CandidateHandoff[] = [];
    for (const area of project.areas) {
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
  function saveCandidate(project: Project, value: CandidateHandoff) {
    validateName(value.area, "area");
    const areaInstanceId = project.areas.find(
      (area) => area.key === value.area,
    )?.instanceId;
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
  async function beforeDeveloper(
    job: LocalJob,
    payload: DockerJobPayload,
    ticket: LinearTicket,
  ): Promise<DockerJobPayload> {
    const project = projectFor(job.project!);
    if (!enabled(project)) return payload;
    if (
      !job.area ||
      !payload.delivery ||
      payload.delivery.branch !== `gremlins/${job.id}` ||
      payload.delivery.base !== project.config.branches.integration
    )
      throw new Error(
        "Promotion coding must target its exact integration branch and owning PM.",
      );
    const snapshot: Admission = {
      schema: 1,
      jobId: job.id,
      area: job.area,
      project: project.config.name,
      repository: project.config.repo,
      configuration: configHash(project, job.area),
      ticket: structuredClone(ticket),
      scopeHash: ticketScopeHash(ticket),
      approvedAt: now().toISOString(),
    };
    const existing = admission(job);
    if (existing) {
      if (
        existing.configuration !== snapshot.configuration ||
        existing.scopeHash !== snapshot.scopeHash
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
  async function beforePm(
    job: LocalJob,
    payload: DockerJobPayload,
  ): Promise<DockerJobPayload> {
    const project = projectFor(job.project!);
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
    let plan: PmReviewPlan | null;
    try {
      plan = await ledger.prepareReview({
        area: job.area,
        jobId: job.id,
        deployment: await deployment(project),
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
      if (result.noChanges === true) return;
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
      verifyCandidate: async (candidate) => {
        const area = candidate.releaseBranch.split("/")[1];
        if (!area || !project.areas.some((a) => a.key === area))
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
      return await promote(name, { ...executor, area: input.area });
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
    beforeDeveloper,
    beforePm,
    pendingReviews,
    completeJob,
    promote,
    preparePromotion,
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
        deliveries: localLedger(project).list(),
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
