import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { Project } from "../config.ts";
import type { Forge, PullRequest } from "../forge/types.ts";
import type { LocalJob, LocalJobInput } from "../localRunners/types.ts";
import {
  effectiveWorkflow,
  effectiveVerification,
} from "../projectCapabilities.ts";
import { projectRuntimeKey } from "../projectIdentity.ts";
import { assertNoSymlinks } from "../setup/files.ts";
import type { ReviewDeployment } from "./types.ts";

const SHA = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/;
const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
function gitIdentity(project: Project) {
  return {
    identity: projectRuntimeKey(project.config),
    provider: project.config.provider,
    server: project.config.serverUrl,
    repo: project.config.repo,
    branches: project.config.branches,
    workflow: effectiveWorkflow(project.config),
  };
}
export function stagingSyncScope(project: Project): string {
  return digest({ ...gitIdentity(project), commands: project.config.commands });
}
/** v0.21 scopes included browser settings. Only reproducible old scopes are trusted. */
function compatibleLegacyScopes(project: Project): Set<string> {
  const configurations = [
    project.config,
    ...Object.entries(project.config.environments ?? {})
      .filter(([, target]) => target.role !== "production")
      .map(([environment]) => ({
        ...project.config,
        verification: { mode: "browser" as const, environment },
      })),
  ];
  if (configurations.length > 33)
    throw new Error("Too many prior environment identities to inspect safely.");
  return new Set(
    configurations.map((config) =>
      digest({
        ...gitIdentity(project),
        verification: effectiveVerification(config),
        commands: project.config.commands,
      }),
    ),
  );
}
export interface StagingSyncStatus {
  phase:
    | "disabled"
    | "checking"
    | "current"
    | "waiting-checks"
    | "waiting-merge"
    | "repairing"
    | "waiting-deployment"
    | "blocked";
  message: string;
  checkedAt?: string;
  stagingSha?: string;
  integrationSha?: string;
  pullUrl?: string;
}
export interface SyncRepairIntent {
  key: string;
  stagingSha: string;
  integrationSha: string;
  attempt: number;
  jobId?: string;
  /** Preserves a proven v0.21 queue key after moving to the stable Git scope. */
  legacyScope?: string;
}
interface State {
  schema: 1;
  scope: string;
  status: StagingSyncStatus;
  repairs: SyncRepairIntent[];
  checkedMerge?: { key: string; ok: boolean; at: string };
  deploymentVerification?: string;
}
export interface StagingSyncOptions {
  root: string;
  project: Project;
  currentProject: () => Project;
  forge: () => Promise<Forge>;
  checkMerge: (integrationSha: string, headSha: string) => Promise<boolean>;
  deployment: () => Promise<ReviewDeployment>;
  jobs?: () => Promise<LocalJob[]>;
  enqueue?: (input: LocalJobInput) => Promise<LocalJob>;
  now?: () => Date;
}

/** Local controller housekeeping, independent of Linear and the legacy Actions dispatcher. */
export function createStagingSync(options: StagingSyncOptions) {
  const { project } = options,
    { repo, branches } = project.config;
  const scope = stagingSyncScope(project);
  const directory = join(
    options.root,
    ".run",
    "delivery",
    projectRuntimeKey(project.config),
    "staging-sync",
  );
  const file = join(directory, `${scope}.json`),
    lock = join(directory, "operation.lock");
  const now = () => options.now?.() ?? new Date();
  const enabled = () =>
    effectiveWorkflow(options.currentProject().config).kind === "promotion" &&
    !!options.currentProject().config.verified;
  const initial = (): StagingSyncStatus =>
    enabled()
      ? {
          phase: "checking",
          message: `Checking whether ${branches.integration} includes ${branches.staging}.`,
        }
      : {
          phase: "disabled",
          message:
            "Automatic staging sync runs for verified projects using the promotion workflow.",
        };
  const assertCurrent = () => {
    if (!enabled() || stagingSyncScope(options.currentProject()) !== scope)
      throw new Error("Staging sync configuration changed.");
  };
  function read(source = file, expectedScope = scope): State {
    assertNoSymlinks(source);
    if (!existsSync(source))
      return { schema: 1, scope, status: initial(), repairs: [] };
    const stat = lstatSync(source);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 256 * 1024)
      throw new Error("Invalid staging sync state.");
    const value = JSON.parse(readFileSync(source, "utf8")) as State;
    if (
      value.schema !== 1 ||
      value.scope !== expectedScope ||
      !value.status ||
      ![
        "disabled",
        "checking",
        "current",
        "waiting-checks",
        "waiting-merge",
        "repairing",
        "waiting-deployment",
        "blocked",
      ].includes(value.status.phase) ||
      typeof value.status.message !== "string" ||
      value.status.message.length > 2000 ||
      !Array.isArray(value.repairs) ||
      (value.deploymentVerification !== undefined &&
        !/^[a-f0-9]{64}$/.test(value.deploymentVerification)) ||
      new Set(value.repairs.map((r) => r?.key)).size !== value.repairs.length ||
      (value.checkedMerge !== undefined &&
        (!value.checkedMerge ||
          !/^[a-f0-9]{64}$/.test(value.checkedMerge.key) ||
          typeof value.checkedMerge.ok !== "boolean" ||
          !Number.isFinite(Date.parse(value.checkedMerge.at)))) ||
      value.repairs.some(
        (r) =>
          !r ||
          !SHA.test(r.stagingSha) ||
          !SHA.test(r.integrationSha) ||
          ![1, 2].includes(r.attempt) ||
          (r.legacyScope !== undefined &&
            (expectedScope !== scope ||
              !/^[a-f0-9]{64}$/.test(r.legacyScope))) ||
          r.key !==
            repairKey(
              r.stagingSha,
              r.attempt,
              r.legacyScope ?? expectedScope,
            ) ||
          (r.jobId !== undefined && !/^job-[a-f0-9-]{36}$/.test(r.jobId)),
      )
    )
      throw new Error("Invalid staging sync state.");
    return value;
  }
  function save(state: State) {
    assertCurrent();
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    assertNoSymlinks(file);
    const temp = join(directory, `.${randomBytes(12).toString("hex")}.tmp`);
    writeFileSync(temp, JSON.stringify(state), { flag: "wx", mode: 0o600 });
    renameSync(temp, file);
  }
  function update(
    state: State,
    phase: StagingSyncStatus["phase"],
    message: string,
    extra: Partial<StagingSyncStatus> = {},
  ) {
    state.status = {
      ...state.status,
      ...extra,
      phase,
      message,
      checkedAt: now().toISOString(),
    };
    save(state);
    return state.status;
  }
  function status(): StagingSyncStatus {
    if (!enabled()) return initial();
    try {
      const state = read();
      if (
        state.status.phase === "current" &&
        state.deploymentVerification !==
          digest(effectiveVerification(options.currentProject().config))
      )
        return {
          ...state.status,
          phase: "waiting-deployment",
          message:
            "The selected test environment changed. Waiting to check its current integration deployment before PM testing.",
        };
      return state.status;
    } catch {
      return {
        phase: "blocked",
        message:
          "Staging sync state needs repair. Existing work has been preserved.",
      };
    }
  }
  function acquire(): number | null {
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
          return acquire();
        }
      }
      return null;
    }
  }
  function repairKey(sha: string, attempt: number, keyScope = scope) {
    return `staging-sync:${keyScope}:${sha}:${attempt}`;
  }
  async function sameRevisionJobs(staging: string) {
    return ((await options.jobs?.()) ?? []).filter(
      (job) =>
        job.type === "developer" &&
        job.developerKind === "sync" &&
        job.project === project.config.name &&
        job.projectInstanceId === project.config.instanceId &&
        job.ticket === `SYNC-${staging.slice(0, 12)}` &&
        job.idempotencyKey?.startsWith("staging-sync:"),
    );
  }
  function legacyCandidates(
    staging: string,
    integration: string,
    jobs: LocalJob[],
  ): SyncRepairIntent[] {
    const compatible = compatibleLegacyScopes(options.currentProject());
    const files = existsSync(directory)
      ? readdirSync(directory).filter(
          (entry) =>
            /^[a-f0-9]{64}\.json$/.test(entry) && entry !== `${scope}.json`,
        )
      : [];
    if (files.length > 32)
      throw new Error("Too much prior repair history to recover safely.");
    const candidates: SyncRepairIntent[] = [];
    for (const entry of files) {
      const legacyScope = entry.slice(0, -5);
      if (!compatible.has(legacyScope)) continue;
      const previous = read(join(directory, entry), legacyScope);
      for (const intent of previous.repairs) {
        if (
          intent.stagingSha !== staging ||
          intent.integrationSha !== integration ||
          !intent.jobId
        )
          continue;
        const matching = jobs.filter((job) => matchesRepair(job, intent));
        if (matching.length === 1) candidates.push({ ...intent, legacyScope });
      }
    }
    return candidates;
  }
  async function recoverLegacyRepair(
    state: State,
    staging: string,
    integration: string,
  ): Promise<string | null> {
    if (state.repairs.some((r) => r.stagingSha === staging)) return null;
    const jobs = await sameRevisionJobs(staging);
    if (!jobs.length) return null;
    const candidates = legacyCandidates(staging, integration, jobs);
    if (candidates.length !== 1 || jobs.length !== 1)
      return "An existing staging repair belongs to a different or ambiguous controller configuration. Inspect its activity and source PR before continuing; no duplicate repair was launched.";
    // Do not import cached checks or browser readiness from the previous settings.
    state.repairs.push(candidates[0]!);
    delete state.checkedMerge;
    save(state);
    return null;
  }
  // An ephemeral head prevents provider auto-delete settings from deleting staging.
  function snapshotBranch(sha: string) {
    return `gremlins/staging-sync-${scope.slice(0, 12)}-${sha}`;
  }
  async function heads(forge: Forge) {
    const [staging, integration] = await Promise.all([
      forge.getBranchSha(repo, branches.staging),
      forge.getBranchSha(repo, branches.integration),
    ]);
    if (
      !staging ||
      !integration ||
      !SHA.test(staging) ||
      !SHA.test(integration)
    )
      throw new Error("Missing sync branches.");
    return { staging, integration };
  }
  async function unchanged(forge: Forge, staging: string, integration: string) {
    assertCurrent();
    const current = await heads(forge);
    assertCurrent();
    return current.staging === staging && current.integration === integration;
  }
  async function ready(
    state: State,
    forge: Forge,
    staging: string,
    integration: string,
  ) {
    update(
      state,
      "waiting-deployment",
      `Waiting for the ready ${branches.integration} deployment at ${integration.slice(0, 8)}. PMs will wait for this revision.`,
    );
    const verification = digest(
      effectiveVerification(options.currentProject().config),
    );
    let deployed: ReviewDeployment;
    try {
      deployed = await options.deployment();
    } catch {
      return state.status;
    }
    if (
      verification !==
      digest(effectiveVerification(options.currentProject().config))
    )
      return update(
        state,
        "waiting-deployment",
        "The selected test environment changed during its deployment check. Rechecking the current environment before PM testing.",
      );
    if (
      deployed.sha !== integration ||
      deployed.branch !== branches.integration ||
      deployed.state !== "READY"
    )
      return state.status;
    if (!(await unchanged(forge, staging, integration)))
      return update(
        state,
        "checking",
        "A branch changed while its deployment was checked. Rechecking before PM testing.",
      );
    if (
      verification !==
      digest(effectiveVerification(options.currentProject().config))
    )
      return update(
        state,
        "waiting-deployment",
        "The selected test environment changed during its deployment check. Rechecking the current environment before PM testing.",
      );
    state.deploymentVerification = verification;
    return update(
      state,
      "current",
      `${branches.integration} includes ${branches.staging}; its current deployment is ready for PM testing.`,
      { pullUrl: undefined },
    );
  }
  async function checkedMerge(state: State, integration: string, head: string) {
    const key = digest({ integration, head });
    const cached = state.checkedMerge;
    if (
      cached?.key === key &&
      now().getTime() - Date.parse(cached.at) <
        (cached.ok ? 24 * 60 * 60_000 : 5 * 60_000)
    )
      return cached.ok;
    update(
      state,
      "waiting-checks",
      "Running the project's checks on the combined staging and PM changes.",
    );
    const ok = await options.checkMerge(integration, head);
    assertCurrent();
    state.checkedMerge = { key, ok, at: now().toISOString() };
    save(state);
    return ok;
  }
  async function merge(
    state: State,
    forge: Forge,
    pull: PullRequest,
    staging: string,
    integration: string,
    repair = false,
  ) {
    if (
      pull.state !== "open" ||
      pull.baseRef !== branches.integration ||
      (!repair &&
        (pull.headRef !== snapshotBranch(staging) || pull.headSha !== staging))
    )
      return update(
        state,
        "checking",
        "The sync pull request changed. Rechecking its branches before continuing.",
      );
    const checks = await forge.getChecks(repo, pull.headSha);
    if (checks.status === "failure")
      return update(
        state,
        "blocked",
        "The sync branch has failing checks. Automatic synchronization is paused until they pass; the controller will keep checking.",
      );
    if (checks.status === "pending")
      return update(
        state,
        "waiting-checks",
        "Waiting for the sync branch's checks to finish.",
      );
    if (!(await checkedMerge(state, integration, pull.headSha)))
      return update(
        state,
        "blocked",
        "The combined staging and PM changes failed project checks. Existing branches are preserved; checks will retry automatically.",
      );
    if (!(await unchanged(forge, staging, integration)))
      return update(
        state,
        "checking",
        "A branch moved during sync checks. The new revisions will be checked before merging.",
      );
    let fresh = await forge.getPull(repo, pull.number);
    if (
      !fresh ||
      fresh.headSha !== pull.headSha ||
      fresh.baseRef !== pull.baseRef ||
      fresh.headRef !== pull.headRef ||
      fresh.state !== "open"
    )
      return update(
        state,
        "checking",
        "The sync pull request moved during checks. Rechecking before merging.",
      );
    // The controller owns these exact snapshot/repair heads. A draft is a
    // publication detail, not a request for a person or PM to review the sync.
    if (fresh.draft) {
      const readyChecks = await forge.getChecks(repo, pull.headSha);
      if (["failure", "pending"].includes(readyChecks.status))
        return update(
          state,
          "waiting-checks",
          "Checks changed before preparing the automatic sync merge. Waiting for the current results.",
        );
      assertCurrent();
      await forge.markReady(repo, fresh.number);
      fresh = await forge.getPull(repo, fresh.number);
    }
    if (
      !fresh ||
      fresh.headSha !== pull.headSha ||
      fresh.baseRef !== pull.baseRef ||
      fresh.headRef !== pull.headRef ||
      fresh.state !== "open" ||
      fresh.draft ||
      fresh.mergeable !== true ||
      !["clean", "has_hooks"].includes(fresh.mergeableState)
    )
      return update(
        state,
        "waiting-merge",
        "Waiting for branch rules and mergeability. ShipGremlins will retry without bypassing protections.",
      );
    const latestChecks = await forge.getChecks(repo, pull.headSha);
    if (["failure", "pending"].includes(latestChecks.status))
      return update(
        state,
        "waiting-checks",
        "Checks changed before merging. Waiting for the current results.",
      );
    if (!(await unchanged(forge, staging, integration)))
      return update(
        state,
        "checking",
        "A branch changed before merging. Rechecking the new revisions.",
      );
    const result = await forge.mergePull(repo, pull.number, {
      method: "merge",
      sha: pull.headSha,
    });
    if (!result.merged)
      return update(
        state,
        "waiting-merge",
        "The source provider refused the automatic sync merge. Waiting for branch rules and source permissions; the controller will retry without bypassing protections.",
      );
    // Never treat an API merge acknowledgement as proof of ancestry or deployment.
    const current = await heads(forge);
    if (
      (await forge.compare(repo, current.integration, current.staging))
        .aheadBy !== 0
    )
      return update(
        state,
        "checking",
        "Sync merged. Rechecking staging changes before PM testing.",
        { stagingSha: current.staging, integrationSha: current.integration },
      );
    state.status.stagingSha = current.staging;
    state.status.integrationSha = current.integration;
    return ready(state, forge, current.staging, current.integration);
  }
  async function repair(
    state: State,
    forge: Forge,
    staging: string,
    integration: string,
    queue: boolean,
  ) {
    const jobs = (await options.jobs?.()) ?? [];
    const attempts = state.repairs
      .filter((r) => r.stagingSha === staging)
      .sort((a, b) => b.attempt - a.attempt);
    let needsFreshRepair = false;
    // A later completed attempt must not conceal a canceled or invalid earlier
    // admission. Only valid, uncanceled controller work can authorize a merge.
    for (const intent of attempts) {
      const job = jobs.find(
        (j) =>
          j.idempotencyKey === intent.key &&
          j.projectInstanceId === project.config.instanceId,
      );
      if (job && !matchesRepair(job, intent))
        return update(
          state,
          "blocked",
          "The repair job no longer matches its controller admission. Review its original activity; no new job or merge was authorized.",
        );
      if (job?.status === "canceled" || job?.cancelRequestedAt)
        return update(
          state,
          "blocked",
          "The sync repair was canceled. Automatic synchronization is paused for this staging revision to respect the cancellation.",
        );
    }
    for (const intent of attempts) {
      const job = jobs.find(
        (j) =>
          j.idempotencyKey === intent.key &&
          j.projectInstanceId === project.config.instanceId,
      );
      if (job && !intent.jobId) {
        intent.jobId = job.id;
        save(state);
      }
      if (job && ["queued", "running"].includes(job.status))
        return update(
          state,
          "repairing",
          "A Coding Gremlin is resolving the staging conflict on your runner. PM testing will resume after checks and deployment.",
        );
      if (!job && intent.jobId)
        return update(
          state,
          "blocked",
          "The previous sync repair's status is unavailable. Inspect its activity before retrying; no duplicate was started.",
        );
      const jobId = intent.jobId;
      const [resolution] = jobId
        ? await forge.listOpenPulls(repo, {
            base: branches.integration,
            head: `gremlins/${jobId}`,
          })
        : [];
      if (resolution) {
        if (
          resolution.state !== "open" ||
          resolution.baseRef !== branches.integration ||
          resolution.headRef !== `gremlins/${jobId}` ||
          !SHA.test(resolution.headSha)
        )
          return update(
            state,
            "blocked",
            "The repair pull request no longer matches its controller admission. Automatic synchronization is paused; no unrelated pull request was changed.",
          );
        // A repaired head must retain BOTH histories. Squashed/cherry-picked copies are not a sync.
        const [source, base] = await Promise.all([
          forge.compare(repo, resolution.headSha, staging),
          forge.compare(repo, resolution.headSha, integration),
        ]);
        if (
          source.aheadBy !== 0 ||
          base.aheadBy !== 0 ||
          resolution.mergeableState === "dirty"
        ) {
          // A finished attempt may become obsolete as integration advances.
          // Keep its evidence, but let the existing bounded repair budget
          // prepare a replacement from the current immutable branch pair.
          needsFreshRepair = true;
          state.status.pullUrl = resolution.htmlUrl;
          continue;
        }
        state.status.pullUrl = resolution.htmlUrl;
        return merge(state, forge, resolution, staging, integration, true);
      }
    }
    const pending = attempts.find(
      (r) => !r.jobId && !jobs.some((j) => j.idempotencyKey === r.key),
    );
    const lastAttempt = Math.max(0, ...attempts.map((r) => r.attempt));
    if (!pending && lastAttempt >= 2)
      return update(
        state,
        "blocked",
        "Two Coding Gremlin attempts could not complete this staging sync. Automatic repair is paused for this staging revision; its worker output explains the remaining problem. This maintenance does not require PM or promotion review.",
      );
    if (!options.enqueue || !queue)
      return update(
        state,
        "repairing",
        needsFreshRepair
          ? "The completed sync repair no longer covers the current branch histories or still conflicts. The controller will queue its remaining automatic repair attempt."
          : "Staging conflicts with PM changes. The controller will queue a Coding Gremlin to resolve the conflict.",
      );
    const intent = pending ?? {
      key: repairKey(staging, lastAttempt + 1),
      stagingSha: staging,
      integrationSha: integration,
      attempt: lastAttempt + 1,
    };
    if (!pending) {
      state.repairs.push(intent);
      save(state);
    }
    assertCurrent();
    const job = await options.enqueue({
      type: "developer",
      developerKind: "sync",
      project: project.config.name,
      projectInstanceId: project.config.instanceId,
      ticket: `SYNC-${staging.slice(0, 12)}`,
      attempt: intent.attempt,
      branch: branches.integration,
      idempotencyKey: intent.key,
      runOnce: true,
    });
    intent.jobId = job.id;
    return update(
      state,
      "repairing",
      needsFreshRepair
        ? "The controller queued its remaining automatic repair attempt against the current staging and PM branches. Existing repair evidence is preserved."
        : "A Coding Gremlin is queued to resolve the staging conflict on your runner.",
    );
  }
  async function reconcile(
    input: { queueRepair?: boolean; checkOnly?: boolean } = {},
  ): Promise<StagingSyncStatus> {
    if (!enabled()) return initial();
    const fd = acquire();
    if (fd === null) {
      const currentStatus = status();
      if (
        input.checkOnly &&
        !["disabled", "checking", "current"].includes(currentStatus.phase)
      )
        return currentStatus;
      return {
        ...currentStatus,
        phase: "checking",
        message: "Another staging sync is in progress. PM testing will wait.",
      };
    }
    let state: State | undefined;
    try {
      state = read();
      assertCurrent();
      if (
        new Set([branches.staging, branches.integration, branches.production])
          .size !== 3
      )
        return update(
          state,
          "blocked",
          "Choose separate integration, staging and production branches before enabling automatic sync.",
        );
      const previousStatus = { ...state.status };
      if (!input.checkOnly)
        update(
          state,
          "checking",
          `Checking ${branches.staging} → ${branches.integration}.`,
        );
      const forge = await options.forge();
      const { staging, integration } = await heads(forge);
      state.status = {
        ...state.status,
        stagingSha: staging,
        integrationSha: integration,
      };
      if ((await forge.compare(repo, integration, staging)).aheadBy === 0)
        return await ready(state, forge, staging, integration);
      if (input.checkOnly) {
        // Queue eligibility checks must not erase the controller's concrete
        // reason for waiting on this same immutable pair of branch heads.
        if (
          previousStatus.stagingSha === staging &&
          previousStatus.integrationSha === integration &&
          [
            "waiting-checks",
            "waiting-merge",
            "repairing",
            "waiting-deployment",
            "blocked",
          ].includes(previousStatus.phase)
        )
          return previousStatus;
        return update(
          state,
          "checking",
          `Waiting for the controller to bring ${branches.staging} into ${branches.integration} before PM testing.`,
          { pullUrl: undefined },
        );
      }
      const recoveryBlock = await recoverLegacyRepair(
        state,
        staging,
        integration,
      );
      if (recoveryBlock) return update(state, "blocked", recoveryBlock);
      if (state.repairs.some((r) => r.stagingSha === staging))
        return await repair(
          state,
          forge,
          staging,
          integration,
          input.queueRepair !== false,
        );
      const snapshot = snapshotBranch(staging);
      const snapshotSha = await forge.getBranchSha(repo, snapshot);
      if (snapshotSha && snapshotSha !== staging)
        return update(
          state,
          "blocked",
          "The staging snapshot branch was changed outside synchronization. Inspect that branch before retrying; no history was overwritten.",
        );
      if (!snapshotSha) {
        if (!forge.createBranch)
          return update(
            state,
            "blocked",
            "This source provider cannot create safe staging snapshots. Update ShipGremlins before syncing.",
          );
        assertCurrent();
        try {
          await forge.createBranch(repo, snapshot, staging);
        } catch {
          if ((await forge.getBranchSha(repo, snapshot)) !== staging)
            throw new Error("Could not prepare staging snapshot.");
        }
      }
      const [existing] = await forge.listOpenPulls(repo, {
        base: branches.integration,
        head: snapshot,
      });
      assertCurrent();
      const created =
        existing ??
        (await forge.createPull(repo, {
          head: snapshot,
          base: branches.integration,
          title: `sync: ${branches.staging} → ${branches.integration}`,
          draft: false,
          body: `Keeps the PM test branch current with staging at ${staging}. The head is an immutable snapshot so automatic branch cleanup cannot delete staging. ShipGremlins checks the combined changes, preserves both histories with a merge commit, and waits for the exact integration deployment before PM testing.\n\nController scope: ${scope}`,
        }));
      const pull = await forge.getPull(repo, created.number);
      if (!pull)
        return update(
          state,
          "waiting-merge",
          "Waiting for the source provider to report the sync PR.",
        );
      if (
        pull.state !== "open" ||
        pull.headRef !== snapshot ||
        pull.headSha !== staging ||
        pull.baseRef !== branches.integration
      )
        return update(
          state,
          "checking",
          "The sync pull request changed. Rechecking its exact branches before preparing automatic synchronization.",
        );
      state.status.pullUrl = pull.htmlUrl;
      if (
        pull.mergeableState === "behind" &&
        ["pending", "failure"].includes(
          (await forge.getChecks(repo, pull.headSha)).status,
        )
      )
        return await merge(state, forge, pull, staging, integration);
      if (["dirty", "behind"].includes(pull.mergeableState))
        return await repair(
          state,
          forge,
          staging,
          integration,
          input.queueRepair !== false,
        );
      if (
        pull.mergeable === null ||
        ["unknown", "checking"].includes(pull.mergeableState)
      )
        return update(
          state,
          "waiting-merge",
          "Waiting for the source provider to calculate sync mergeability.",
        );
      return await merge(state, forge, pull, staging, integration);
    } catch {
      if (state) {
        try {
          return update(
            state,
            "blocked",
            "Staging sync could not finish. Check source access, configured branches and local Docker checks. Existing work is preserved; the controller will retry.",
          );
        } catch {
          /* Configuration changed; never overwrite its state. */
        }
      }
      return {
        phase: "blocked",
        message:
          "Staging sync could not finish safely. Check project configuration and saved sync state; existing work is preserved.",
      };
    } finally {
      closeSync(fd);
      unlinkSync(lock);
    }
  }
  async function repairIntent(job: LocalJob): Promise<SyncRepairIntent> {
    assertCurrent();
    const state = read();
    let intent = state.repairs.find((r) => r.key === job.idempotencyKey);
    const forge = await options.forge();
    if (!intent) {
      // A queued v0.21 repair can start before the reconciliation timer. Its
      // original durable admission remains sufficient; never fabricate a new one.
      const current = await heads(forge);
      const jobs = await sameRevisionJobs(current.staging);
      if (
        !state.repairs.some((r) => r.stagingSha === current.staging) &&
        jobs.length === 1 &&
        jobs[0]!.id === job.id
      ) {
        const candidates = legacyCandidates(
          current.staging,
          current.integration,
          jobs,
        );
        if (candidates.length === 1) intent = candidates[0];
      }
    }
    if (
      !intent ||
      intent.jobId !== job.id ||
      !matchesRepair(job, intent) ||
      job.cancelRequestedAt ||
      job.status === "canceled"
    )
      throw new Error("This sync repair has no matching controller admission.");
    if (!(await unchanged(forge, intent.stagingSha, intent.integrationSha)))
      throw new Error(
        "The sync repair's source branches moved. Reconcile staging before starting new repair work.",
      );
    return intent;
  }
  function matchesRepair(job: LocalJob, intent: SyncRepairIntent) {
    return (
      (!intent.jobId || intent.jobId === job.id) &&
      job.type === "developer" &&
      job.developerKind === "sync" &&
      job.project === project.config.name &&
      job.projectInstanceId === project.config.instanceId &&
      job.ticket === `SYNC-${intent.stagingSha.slice(0, 12)}` &&
      job.attempt === intent.attempt &&
      job.branch === branches.integration &&
      job.runOnce === true &&
      job.idempotencyKey === intent.key &&
      !job.area &&
      !job.pmMode &&
      !job.linearBinding &&
      !job.grumblin
    );
  }
  return { status, reconcile, repairIntent };
}
