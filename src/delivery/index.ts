import { createHash, randomBytes } from "node:crypto";
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
import { join } from "node:path";
import { matchesPrefix, type Project } from "../config.ts";
import type { Forge, PullRequest, CheckSummary } from "../forge/types.ts";
import type { LinearClient, LinearTicket } from "../services/types.ts";
import {
  ticketScopeHash,
  type CompletionManifest,
} from "../lifecycle/manifest.ts";
import { assertNoSymlinks, validateName } from "../setup/files.ts";
import { LABELS } from "../dispatcher/notes.ts";
import {
  effectiveVerification,
  effectiveWorkflow,
} from "../projectCapabilities.ts";
import type { PromoteOpts, Verdict } from "../dispatcher/promote.ts";
import {
  candidateEvidenceError,
  type CandidateVerification,
  type CandidateVerificationResult,
} from "../dispatcher/verification.ts";
import type {
  DeliveryRecord,
  PmReviewManifest,
  PmReviewPlan,
  ReviewDeployment,
  ReviewIngestion,
} from "./types.ts";
export type * from "./types.ts";

const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export function deliveryConfiguration(project: Project, area: string): string {
  const workflow = effectiveWorkflow(project.config);
  return hash({
    provider: project.config.provider ?? "github",
    server: project.config.serverUrl,
    repo: project.config.repo,
    branches: project.config.branches,
    linear: project.config.linear,
    commands: project.config.commands,
    verification: effectiveVerification(project.config),
    workflow: workflow.kind === "promotion" ? { kind: "promotion" } : workflow,
    signIn: project.config.signIn,
    tiers: project.tiers,
    area: { ...project.areas.find((a) => a.key === area), enabled: undefined },
  });
}
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const validText = (v: unknown, max = 20000): v is string =>
  typeof v === "string" && !!v.trim() && v.length <= max && !v.includes("\0");
/** Only explicit owner-approved acceptance criteria become the required review set. */
export function acceptanceCriteria(description: string): string[] {
  const section = description.match(
    /(?:^|\n)#{1,6}\s+(?:\d+[.)]\s*)?Acceptance criteria(?: and verification)?\s*\r?\n([\s\S]*?)(?=\n#{1,6}\s|$)/i,
  )?.[1];
  if (!section) return [];
  const criteria = section
    .split(/\r?\n/)
    .map((line) =>
      line.match(/^\s*(?:[-*]|\d+[.)])\s+(?:\[[ xX]\]\s*)?(.+)$/)?.[1]?.trim(),
    )
    .filter((line): line is string => !!line);
  return criteria.length <= 50 && criteria.every((line) => line.length <= 4000)
    ? [...new Set(criteria)]
    : [];
}
function deployment(value: ReviewDeployment) {
  if (
    !value ||
    value.state !== "READY" ||
    !SHA.test(value.sha) ||
    !validText(value.id, 200) ||
    !validText(value.provider, 40) ||
    !validText(value.branch, 200)
  )
    throw new Error("An exact ready deployment is required for PM review.");
  const url = new URL(value.url);
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error("Use a credential-free deployment URL.");
}
export function parsePmReviewManifest(value: unknown): PmReviewManifest {
  if (
    !object(value) ||
    value.schema !== 1 ||
    ![
      value.planId,
      value.jobId,
      value.project,
      value.area,
      value.deploymentId,
    ].every((v) => validText(v, 200)) ||
    !SHA.test(String(value.testedSha)) ||
    !Array.isArray(value.deliveries) ||
    !value.deliveries.length ||
    value.deliveries.length > 100 ||
    Buffer.byteLength(JSON.stringify(value)) > 256 * 1024
  )
    throw new Error(
      "PM review must identify its plan, job, exact deployment and deliveries.",
    );
  const seen = new Set<string>();
  for (const row of value.deliveries) {
    if (
      !object(row) ||
      !validText(row.id, 100) ||
      seen.has(row.id) ||
      !["passed", "failed", "blocked"].includes(String(row.status)) ||
      !Array.isArray(row.assertions) ||
      !row.assertions.length ||
      row.assertions.length > 100 ||
      !Array.isArray(row.screenshots) ||
      row.screenshots.length > 50
    )
      throw new Error(
        "PM review needs unique deliveries and explicit acceptance assertions.",
      );
    seen.add(row.id);
    if (
      row.assertions.some(
        (a: unknown) =>
          !object(a) ||
          !validText(a.criterion, 4000) ||
          !["passed", "failed", "blocked"].includes(String(a.status)) ||
          !validText(a.receiptId, 200),
      )
    )
      throw new Error(
        "Every assertion needs a criterion, result and actual receipt reference.",
      );
    if (
      row.screenshots.some(
        (a: unknown) =>
          !object(a) ||
          !validText(a.name, 200) ||
          !/^[A-Za-z0-9_./ -]+$/.test(a.name) ||
          a.name.split("/").some((p) => !p || p === "." || p === "..") ||
          !/\.(png|webp|jpe?g)$/i.test(a.name) ||
          !/^[a-f0-9]{64}$/.test(String(a.sha256)),
      )
    )
      throw new Error(
        "Every screenshot needs a safe artifact path and SHA-256 digest.",
      );
    if (
      row.status === "passed" &&
      (!row.screenshots.length ||
        row.assertions.some(
          (a: unknown) => !object(a) || a.status !== "passed",
        ))
    )
      throw new Error(
        "A passing review needs screenshots and all assertions passed.",
      );
  }
  return structuredClone(value) as unknown as PmReviewManifest;
}

/** Durable controller authority: models can propose reviews, but cannot approve their own evidence. */
export function createDeliveryService(options: {
  root: string;
  project: Project;
  forge: Forge;
  linear?: Pick<LinearClient, "getTicket">;
  now?: () => Date;
  resolveChecks?: (sha: string) => Promise<CheckSummary>;
}) {
  const { project, forge } = options,
    name = project.config.name,
    repo = project.config.repo,
    now = () => (options.now?.() ?? new Date()).toISOString();
  validateName(name, "project");
  const directory = join(options.root, ".run", "delivery", name),
    file = join(directory, "state.json"),
    lock = join(directory, "write.lock");
  const config = (area: string) => deliveryConfiguration(project, area);
  const currentOwner = (record: DeliveryRecord) =>
    project.areas.some(
      (area) =>
        area.key === record.area && area.instanceId === record.areaInstanceId,
    );
  interface State {
    schema: 1;
    repository: string;
    records: DeliveryRecord[];
    plans: PmReviewPlan[];
  }
  const read = (): State => {
    assertNoSymlinks(file);
    if (!existsSync(file))
      return { schema: 1, repository: repo, records: [], plans: [] };
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 16 * 1024 * 1024)
      throw new Error(
        "Delivery state requires repair; existing records were preserved.",
      );
    const state = JSON.parse(readFileSync(file, "utf8")) as State;
    if (
      state.schema !== 1 ||
      state.repository !== repo ||
      !Array.isArray(state.records) ||
      !Array.isArray(state.plans) ||
      state.records.some(
        (r) =>
          !r ||
          !validText(r.id, 100) ||
          r.project !== name ||
          r.repository !== repo ||
          (r.areaInstanceId !== undefined &&
            !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(
              r.areaInstanceId,
            )) ||
          !SHA.test(r.implementation?.headSha ?? ""),
      ) ||
      new Set(state.records.map((r) => r.id)).size !== state.records.length
    )
      throw new Error(
        "Delivery state is invalid or belongs to another repository; existing records were preserved.",
      );
    return state;
  };
  async function locked<T>(fn: (state: State) => Promise<T> | T): Promise<T> {
    assertNoSymlinks(file);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    assertNoSymlinks(lock);
    let fd: number;
    try {
      fd = openSync(lock, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const stat = lstatSync(lock);
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > 100)
        throw new Error(
          "Delivery state is locked; existing work was preserved.",
        );
      const pid = Number(readFileSync(lock, "utf8"));
      let dead = false;
      if (Number.isSafeInteger(pid) && pid > 0)
        try {
          process.kill(pid, 0);
        } catch (cause) {
          dead = (cause as NodeJS.ErrnoException).code === "ESRCH";
        }
      if (!dead)
        throw new Error(
          "Another controller is updating delivery state. Retry shortly.",
        );
      unlinkSync(lock);
      fd = openSync(lock, "wx", 0o600);
    }
    writeFileSync(fd, String(process.pid));
    let temp: string | undefined;
    try {
      const state = read(),
        result = await fn(state);
      temp = join(directory, `.state-${randomBytes(12).toString("hex")}.tmp`);
      const out = openSync(temp, "wx", 0o600);
      try {
        writeFileSync(out, JSON.stringify(state) + "\n");
        fsyncSync(out);
      } finally {
        closeSync(out);
      }
      assertNoSymlinks(file);
      renameSync(temp, file);
      temp = undefined;
      return structuredClone(result);
    } finally {
      closeSync(fd);
      unlinkSync(lock);
      if (temp) unlinkSync(temp);
    }
  }
  function promotionWorkflow() {
    const b = project.config.branches;
    if (new Set([b.integration, b.staging, b.production]).size !== 3)
      throw new Error(
        "Delivery promotion requires distinct integration, staging and production branches.",
      );
    return b;
  }
  const checkConfig = (record: DeliveryRecord) => {
    if (!currentOwner(record) || record.configuration !== config(record.area))
      throw new Error(
        "This delivery's project or owning PM changed. Review its original scope before continuing.",
      );
  };
  async function approved(record: DeliveryRecord): Promise<boolean> {
    if (!options.linear) return false;
    const ticket = await options.linear.getTicket(record.ticket.id);
    const area = project.areas.find((a) => a.key === record.area);
    return (
      !!ticket &&
      !!area &&
      ticketScopeHash(ticket) === record.scopeHash &&
      ticket.teamId === record.ticket.teamId &&
      ticket.projectId === area.linearProjectId &&
      ticket.labels.includes(area.label) &&
      ticket.labels.includes(LABELS.approved) &&
      ![LABELS.proposal, LABELS.needsHuman].some((label) =>
        ticket.labels.includes(label),
      ) &&
      !["completed", "canceled"].includes(ticket.stateType)
    );
  }
  async function checksFor(
    sha: string,
    record?: DeliveryRecord,
  ): Promise<CheckSummary> {
    const provider = await forge.getChecks(repo, sha);
    if (provider.status !== "none") return provider;
    const required = Object.entries(project.config.commands)
      .filter(([, command]) => !!command)
      .map(([key]) => key);
    if (
      record?.checks?.headSha === sha &&
      required.includes("test") &&
      required.every((key) => record.checks!.commands.includes(key))
    )
      return { status: "success", failedJobs: [] };
    return options.resolveChecks ? options.resolveChecks(sha) : provider;
  }
  async function register(input: {
    jobId: string;
    area: string;
    ticket: LinearTicket;
    pullNumber: number;
    approvedBy: string;
    approvedAt: string;
    checks?: DeliveryRecord["checks"];
  }) {
    promotionWorkflow();
    const area = project.areas.find((a) => a.key === input.area),
      ticket = input.ticket;
    if (
      !area ||
      !/^job-[a-z0-9-]{1,58}$/.test(input.jobId) ||
      !validText(input.approvedBy, 200) ||
      !Number.isFinite(Date.parse(input.approvedAt)) ||
      Date.parse(input.approvedAt) > Date.parse(now()) ||
      ticket.projectId !== area.linearProjectId ||
      ticket.teamId !== project.config.linear?.teamId ||
      !ticket.teamId ||
      !ticket.labels.includes(area.label) ||
      !ticket.labels.includes(LABELS.approved) ||
      [LABELS.proposal, LABELS.needsHuman].some((l) =>
        ticket.labels.includes(l),
      ) ||
      ["completed", "canceled"].includes(ticket.stateType)
    )
      throw new Error(
        "Register only approved work in this PM's exact Linear project and team.",
      );
    const pull = await forge.getPull(repo, input.pullNumber);
    if (
      !pull ||
      pull.headRef !== `gremlins/${input.jobId}` ||
      pull.baseRef !== project.config.branches.integration ||
      !SHA.test(pull.headSha)
    )
      throw new Error(
        "The implementation must be the job's exact branch targeting integration.",
      );
    return locked((state) => {
      const existing = state.records.find((r) => r.jobId === input.jobId);
      if (existing) {
        checkConfig(existing);
        if (
          existing.scopeHash !== ticketScopeHash(ticket) ||
          existing.implementation.number !== pull.number ||
          existing.implementation.headSha !== pull.headSha
        )
          throw new Error(
            "Delivery registration changed; existing evidence was preserved.",
          );
        return existing;
      }
      const at = now();
      const record: DeliveryRecord = {
        id: input.jobId,
        jobId: input.jobId,
        project: name,
        area: area.key,
        ...(area.instanceId ? { areaInstanceId: area.instanceId } : {}),
        repository: repo,
        configuration: config(area.key),
        ticket: {
          id: ticket.id,
          identifier: ticket.identifier,
          title: ticket.title,
          description: ticket.description,
          projectId: ticket.projectId,
          teamId: ticket.teamId,
        },
        scopeHash: ticketScopeHash(ticket),
        approvedBy: input.approvedBy,
        approvedAt: input.approvedAt,
        implementation: {
          number: pull.number,
          url: pull.htmlUrl,
          branch: pull.headRef,
          headSha: pull.headSha,
          author: pull.author,
        },
        ...(input.checks?.headSha === pull.headSha
          ? { checks: input.checks }
          : {}),
        status: "awaiting-merge",
        message:
          "Implementation recorded. Integration merge and owning-PM deployment review remain required.",
        createdAt: at,
        updatedAt: at,
      };
      state.records.push(record);
      return record;
    });
  }
  async function prepareReview(input: {
    area: string;
    jobId: string;
    deployment: ReviewDeployment;
  }): Promise<PmReviewPlan | null> {
    const branches = promotionWorkflow();
    deployment(input.deployment);
    if (
      input.deployment.branch !== branches.integration ||
      !/^job-[a-z0-9-]{1,58}$/.test(input.jobId)
    )
      throw new Error(
        "The owning PM must review the configured integration deployment.",
      );
    if (
      (await forge.getBranchSha(repo, branches.integration)) !==
      input.deployment.sha
    )
      throw new Error(
        "Integration moved; wait for its exact ready deployment.",
      );
    if ((await checksFor(input.deployment.sha)).status !== "success")
      throw new Error(
        "Integration checks must succeed before PM verification.",
      );
    return locked(async (state) => {
      const existing = state.plans.find((p) => p.jobId === input.jobId);
      if (existing) {
        if (
          existing.area !== input.area ||
          existing.configuration !== config(input.area) ||
          hash(existing.deployment) !== hash(input.deployment)
        )
          throw new Error("PM review admission changed; queue a new patrol.");
        return existing;
      }
      const deliveries: PmReviewPlan["deliveries"] = [];
      for (const record of state.records.filter(
        (r) => currentOwner(r) && r.area === input.area && !r.promotion,
      )) {
        checkConfig(record);
        if (!(await approved(record))) {
          record.status = "blocked";
          record.message =
            "The approved ticket scope or approval changed. Review the owning ticket before delivery verification.";
          continue;
        }
        const criteria = acceptanceCriteria(record.ticket.description);
        if (!criteria.length) {
          record.status = "blocked";
          record.message =
            "Add an explicit Acceptance criteria heading with a finite bullet list to the approved ticket, then queue a new coding delivery. Existing scope is preserved.";
          continue;
        }
        const pull = await forge.getPull(repo, record.implementation.number);
        if (
          !pull ||
          pull.headSha !== record.implementation.headSha ||
          pull.headRef !== record.implementation.branch ||
          pull.baseRef !== branches.integration
        ) {
          record.status = "blocked";
          record.message =
            "Implementation changed after registration; review and register a new delivery.";
          continue;
        }
        if (pull.state !== "merged" || !pull.mergeCommitSha) {
          record.status = "awaiting-merge";
          continue;
        }
        if (
          !SHA.test(pull.mergeCommitSha) ||
          (await forge.compare(repo, pull.mergeCommitSha, input.deployment.sha))
            .behindBy !== 0
        ) {
          record.status = "awaiting-deployment";
          record.message =
            "The integration deployment does not contain this merged implementation.";
          continue;
        }
        record.implementation.mergeSha = pull.mergeCommitSha;
        if (record.status === "verified") continue;
        record.status = "awaiting-review";
        record.message =
          "Awaiting the owning PM's actual acceptance checks and screenshot evidence.";
        record.updatedAt = now();
        deliveries.push({
          id: record.id,
          ticket: record.ticket,
          implementationPr: pull.number,
          mergeSha: pull.mergeCommitSha,
          scopeHash: record.scopeHash,
          criteria,
        });
      }
      if (!deliveries.length) return null;
      if (
        (await forge.getBranchSha(repo, branches.integration)) !==
        input.deployment.sha
      )
        throw new Error(
          "Integration changed during review admission. Retry after deployment.",
        );
      const plan: PmReviewPlan = {
        schema: 1,
        id: randomBytes(24).toString("hex"),
        jobId: input.jobId,
        project: name,
        area: input.area,
        configuration: config(input.area),
        createdAt: now(),
        deployment: input.deployment,
        deliveries,
      };
      state.plans.push(plan);
      return plan;
    });
  }
  async function ingestReview(input: ReviewIngestion) {
    const manifest = parsePmReviewManifest(input.manifest);
    deployment(input.deployment);
    return locked(async (state) => {
      const plan = state.plans.find((p) => p.id === input.planId);
      if (
        !plan ||
        manifest.planId !== plan.id ||
        manifest.jobId !== plan.jobId ||
        manifest.project !== name ||
        manifest.area !== plan.area ||
        plan.configuration !== config(plan.area) ||
        manifest.testedSha !== plan.deployment.sha ||
        manifest.deploymentId !== plan.deployment.id ||
        hash(input.deployment) !== hash(plan.deployment) ||
        input.trustedResult.ok !== true ||
        input.trustedResult.kind !== "pm" ||
        input.trustedResult.nonce !== plan.jobId ||
        input.trustedResult.commitSha !== plan.deployment.sha
      )
        throw new Error(
          "PM review is not bound to the admitted job, current brief and exact deployed revision.",
        );
      if (
        manifest.deliveries.some(
          (row) => !plan.deliveries.some((d) => d.id === row.id),
        )
      )
        throw new Error(
          "PM review contains work outside this owner's admitted deliveries.",
        );
      const updated: DeliveryRecord[] = [];
      for (const admitted of plan.deliveries) {
        const record = state.records.find((r) => r.id === admitted.id)!;
        checkConfig(record);
        if (!(await approved(record)))
          throw new Error(
            "The approved ticket changed before review ingestion; existing evidence was preserved.",
          );
        if (
          record.review?.planId === plan.id &&
          record.review.manifestHash === hash(manifest)
        ) {
          updated.push(record);
          continue;
        }
        const row = manifest.deliveries.find((r) => r.id === record.id);
        let verified = !!row && row.status === "passed";
        if (
          verified &&
          (!admitted.criteria?.length ||
            row!.assertions.length !== admitted.criteria.length ||
            new Set(row!.assertions.map((a) => a.criterion)).size !==
              admitted.criteria.length ||
            admitted.criteria.some(
              (criterion) =>
                !row!.assertions.some((a) => a.criterion === criterion),
            ))
        )
          verified = false;
        const pull = await forge.getPull(repo, record.implementation.number);
        if (
          !pull ||
          pull.state !== "merged" ||
          pull.headSha !== record.implementation.headSha ||
          pull.mergeCommitSha !== admitted.mergeSha
        )
          throw new Error(
            "The implementation changed before review ingestion.",
          );
        if (verified)
          for (const assertion of row!.assertions)
            if (
              !(await input.verifyAssertion({
                jobId: plan.jobId,
                deliveryId: record.id,
                criterion: assertion.criterion,
                receiptId: assertion.receiptId,
                deployment: plan.deployment,
              }))
            )
              verified = false;
        if (verified)
          for (const artifact of row!.screenshots)
            if (
              !(await input.verifyArtifact({ jobId: plan.jobId, ...artifact }))
            )
              verified = false;
        record.status = verified
          ? "verified"
          : row?.status === "failed"
            ? "failed"
            : "blocked";
        record.message = verified
          ? "Owning PM acceptance checks and artifact receipts passed on the exact integration deployment."
          : row?.status === "failed"
            ? "Owning PM found a failing acceptance criterion; fix and reverify before promotion."
            : "Awaiting complete acceptance receipts and screenshot hashes for this exact deployment. Model observations alone do not authorize promotion.";
        record.updatedAt = now();
        record.review = {
          planId: plan.id,
          jobId: plan.jobId,
          testedSha: plan.deployment.sha,
          deployment: plan.deployment,
          at: now(),
          manifestHash: hash(manifest),
          artifacts: row?.screenshots ?? [],
        };
        updated.push(record);
      }
      return updated;
    });
  }
  const promotionOptions = (): Pick<
    PromoteOpts,
    "candidateVerdict" | "local"
  > => ({
    local: true,
    candidateVerdict: async (pull: PullRequest) => {
      const record = read().records.find(
        (r) => currentOwner(r) && r.implementation.number === pull.number,
      );
      if (!record) return null;
      checkConfig(record);
      const matches =
        (await approved(record)) &&
        pull.headSha === record.implementation.headSha &&
        pull.mergeCommitSha === record.implementation.mergeSha &&
        pull.baseRef === project.config.branches.integration;
      return {
        area: record.area,
        verdict: (matches && ["verified", "promoted"].includes(record.status)
          ? "verified"
          : record.status === "failed"
            ? "failed"
            : "untested") as Verdict,
      };
    },
  });
  async function recordPromotion(input: {
    deliveryIds: string[];
    pullNumber: number;
    candidate: CandidateVerification;
    evidence: CandidateVerificationResult;
    trustedAuthor: string;
  }) {
    const branches = promotionWorkflow(),
      pull = await forge.getPull(repo, input.pullNumber);
    if (
      !pull ||
      pull.baseRef !== branches.staging ||
      !pull.headRef.startsWith("pm-release/") ||
      pull.headSha !== input.candidate.sha ||
      pull.headRef !== input.candidate.releaseBranch ||
      candidateEvidenceError(
        input.evidence,
        input.candidate,
        input.trustedAuthor,
      )
    )
      throw new Error(
        "Promotion must target staging from a selective release branch.",
      );
    return locked(async (state) => {
      const selected = state.records.filter((r) =>
        input.deliveryIds.includes(r.id),
      );
      if (
        selected.length !== new Set(input.deliveryIds).size ||
        selected.length !== input.candidate.changes.length ||
        selected.some(
          (r) => !input.candidate.changes.includes(r.implementation.number),
        ) ||
        (await forge.getBranchSha(repo, branches.staging)) !==
          input.candidate.baseSha
      )
        throw new Error(
          "Promotion evidence must cover exactly these deliveries and current staging.",
        );
      const result: DeliveryRecord[] = [];
      for (const deliveryId of input.deliveryIds) {
        const r = state.records.find((x) => x.id === deliveryId);
        if (
          !r ||
          !["verified", "promoted"].includes(r.status) ||
          !r.review ||
          !(await approved(r))
        )
          throw new Error(
            "Only verified deliveries may be attached to a promotion.",
          );
        checkConfig(r);
        r.promotion = {
          number: pull.number,
          url: pull.htmlUrl,
          headSha: pull.headSha,
          branch: pull.headRef,
        };
        r.status = "promoted";
        r.updatedAt = now();
        r.message =
          "Selective promotion awaits staging review; the ticket is not Done.";
        result.push(r);
      }
      return result;
    });
  }
  function completionManifest(input: {
    deliveryIds: string[];
    productionPr: number;
    completedStateId: string;
  }): CompletionManifest {
    promotionWorkflow();
    const all = read().records;
    const records = all.filter((r) => input.deliveryIds.includes(r.id));
    if (
      records.length !== new Set(input.deliveryIds).size ||
      !records.length ||
      records.some(
        (r) => !r.review || !r.promotion || r.status !== "promoted",
      ) ||
      all.some(
        (r) =>
          records.some((selected) => selected.ticket.id === r.ticket.id) &&
          !input.deliveryIds.includes(r.id),
      )
    )
      throw new Error(
        "Production audit requires the finite set of verified promoted deliveries.",
      );
    const grouped = new Map<string, CompletionManifest["tickets"][number]>();
    for (const r of records) {
      checkConfig(r);
      let ticket = grouped.get(r.ticket.id);
      if (!ticket) {
        ticket = {
          ticketId: r.ticket.id,
          projectId: r.ticket.projectId!,
          teamId: r.ticket.teamId!,
          scopeHash: r.scopeHash,
          approvedBy: r.approvedBy,
          approvedAt: r.approvedAt,
          completedStateId: input.completedStateId,
          deliverables: [],
        };
        grouped.set(r.ticket.id, ticket);
      }
      if (ticket.scopeHash !== r.scopeHash)
        throw new Error(
          "Ticket scope changed across deliveries; review completion manually.",
        );
      ticket.deliverables.push({
        implementationPr: r.implementation.number,
        productionPr: input.productionPr,
        implementationBranch: r.implementation.branch,
        implementationHeadSha: r.implementation.headSha,
      });
    }
    return {
      version: 1,
      repo,
      productionBranch: project.config.branches.production,
      tickets: [...grouped.values()],
    };
  }
  async function advanceIntegration(healthy: () => Promise<boolean>) {
    const branches = promotionWorkflow();
    return locked(async (state) => {
      for (const record of state.records.filter(
        (r) => currentOwner(r) && r.status === "awaiting-merge",
      )) {
        checkConfig(record);
        if (!(await approved(record))) {
          record.status = "blocked";
          record.message =
            "Approval or ticket scope changed before integration merge.";
          continue;
        }
        const pull = await forge.getPull(repo, record.implementation.number);
        if (
          !pull ||
          pull.headSha !== record.implementation.headSha ||
          pull.headRef !== record.implementation.branch ||
          pull.baseRef !== branches.integration
        ) {
          record.status = "blocked";
          record.message =
            "Implementation changed before integration merge; review its new head.";
          continue;
        }
        if (pull.state === "merged" && pull.mergeCommitSha) {
          record.implementation.mergeSha = pull.mergeCommitSha;
          record.status = "awaiting-deployment";
          record.message =
            "Merged into integration; wait for the exact deployment and owning PM review.";
          continue;
        }
        if (pull.state !== "open") {
          record.status = "blocked";
          record.message = "Implementation was closed without merging.";
          continue;
        }
        const area = project.areas.find((a) => a.key === record.area)!;
        const files = await forge.listPullFiles(repo, pull.number);
        if (
          !files.length ||
          files.some(
            (f) =>
              matchesPrefix(f, [
                ...project.tiers.ownerOnlyPrefixes,
                ...project.tiers.hubOwnerOnly,
              ]) ||
              !matchesPrefix(f, [
                ...area.paths,
                ...area.sharedTouchpoints,
                ...project.tiers.alwaysFree,
              ]),
          )
        ) {
          record.message =
            "Owner review is required for protected or out-of-mandate files before integration merge.";
          continue;
        }
        if (
          (await checksFor(pull.headSha, record)).status !== "success" ||
          !(await healthy())
        ) {
          record.message =
            "Integration merge waits for successful exact-head checks, healthy integration deployment and clean mergeability.";
          continue;
        }
        // Draft status itself blocks GitLab/GitHub mergeability. Only lift it after
        // approval, ownership, independent checks and deployment health pass.
        if (pull.draft) await forge.markReady(repo, pull.number);
        const fresh = await forge.getPull(repo, pull.number);
        if (
          !fresh ||
          fresh.state !== "open" ||
          fresh.draft ||
          !["clean", "unstable"].includes(fresh.mergeableState) ||
          fresh.headSha !== pull.headSha ||
          fresh.headRef !== record.implementation.branch ||
          fresh.baseRef !== branches.integration ||
          !(await approved(record)) ||
          (await checksFor(pull.headSha, record)).status !== "success"
        ) {
          record.message =
            "Implementation is ready for review; integration merge waits for fresh clean mergeability and unchanged approval/head checks.";
          continue;
        }
        const merged = await forge.mergePull(repo, fresh.number, {
          method: project.config.mergeMethod,
          sha: fresh.headSha,
        });
        if (merged.merged) {
          record.status = "awaiting-deployment";
          record.message =
            "Implementation merged into integration; owning PM verification is still required.";
          record.updatedAt = now();
        } else
          record.message =
            "The source provider refused integration merge. Inspect protections or conflicts before retrying.";
        return record; // One change at a time; the next waits for deployment health.
      }
      return null;
    });
  }
  return {
    register,
    list: () => structuredClone(read().records.filter(currentOwner)),
    planForJob: (jobId: string) =>
      structuredClone(read().plans.find((p) => p.jobId === jobId) ?? null),
    prepareReview,
    ingestReview,
    promotionOptions,
    recordPromotion,
    completionManifest,
    advanceIntegration,
    reviewUnavailable: (area: string) =>
      locked((state) => {
        for (const record of state.records.filter(
          (r) =>
            currentOwner(r) &&
            r.area === area &&
            !r.promotion &&
            r.status !== "verified",
        )) {
          record.message =
            "Delivery review is waiting for successful integration checks and its exact ready deployment. The PM can continue ordinary observation.";
          record.updatedAt = now();
        }
        return null;
      }),
  };
}
