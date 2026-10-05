import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { loadProject } from "../config.ts";
import { createSourceControl } from "../sourceControl/index.ts";
import {
  CONNECTIONS,
  projectConnections,
  readConnections,
} from "../setup/connections.ts";
import { readEditableConfig } from "../setup/configEditor.ts";
import { createDockerPlanner } from "../pmPlanner/docker.ts";
import {
  inspectionBranch,
  parseProjectCapabilities,
} from "../projectCapabilities.ts";
import {
  SETUP_SCHEMA,
  SETUP_SYSTEM,
  validateSetupAnalysis,
} from "./analysis.ts";
import {
  containsSecret,
  readRepository,
  resolveRepositoryHead,
} from "./repository.ts";
import { publishSetupDraft } from "./publish.ts";
import {
  createOnboardingStore,
  dead,
  digest,
  validProject,
  type StoredOnboarding,
} from "./store.ts";
import {
  ProjectOnboardingError,
  type OnboardingState,
  type ProjectOnboardingOptions,
  type ApplyProfileInput,
} from "./types.ts";
export * from "./types.ts";
export { resolveRepositoryHead } from "./repository.ts";

const active = new Map<
  string,
  { controller: AbortController; promise: Promise<void>; publishing: boolean }
>();
function bounded<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () =>
      reject(
        new ProjectOnboardingError(
          "Setup timed out or was canceled. Retry explicitly; existing output was preserved.",
          408,
        ),
      );
    if (signal.aborted) {
      abort();
      work.catch(() => {});
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
    work
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}
export function createProjectOnboarding(options: ProjectOnboardingOptions) {
  const root = resolve(options.root),
    store = createOnboardingStore(root);
  const fetcher = options.fetch ?? fetch,
    execute =
      options.execute ??
      createDockerPlanner({ packageRoot: options.packageRoot });
  const env = () => ({
    ...readConnections(root),
    ...(options.env ?? process.env),
  });
  const source = () =>
    options.sourceControl ??
    createSourceControl({ root, env: env(), fetch: fetcher });
  const key = (project: string) => `${root}\0${project}`;
  const config = (project: string) => {
    validProject(project);
    loadProject(root, project);
    return readEditableConfig(root, `projects/${project}/project.json`)
      .revision;
  };
  const revision = (state: StoredOnboarding) => digest(JSON.stringify(state));
  const initial = (
    project: string,
    configurationRevision: string,
  ): StoredOnboarding => ({
    schema: 1,
    project,
    configurationRevision,
    status: "idle",
    stage: "idle",
    message:
      "Analyze this repository or choose an existing test URL. No environment has been verified.",
    updatedAt: new Date(0).toISOString(),
  });
  async function status(project: string): Promise<OnboardingState> {
    const configurationRevision = config(project);
    let state = store.read(project) ?? initial(project, configurationRevision);
    if (state.operation && dead(state.operation.pid)) {
      // Setup leases are identifiable after a crash; never leave a recovered operation
      // holding provider refresh until its original lease expiry.
      await source().releaseLease?.(`job-setup-source-${state.operation.id}`);
      state = await store.change(project, (current) => {
        const next = current ?? state;
        if (next.operation && dead(next.operation.pid)) {
          delete next.operation;
          next.status = "interrupted";
          next.stage = "interrupted";
          next.message =
            "Setup was interrupted when its controller stopped. Retry explicitly; an existing setup draft branch will be checked before any publication.";
          next.updatedAt = new Date().toISOString();
        }
        return { state: next, result: next };
      });
    }
    return {
      project,
      revision: revision(state),
      configurationRevision,
      status: state.status,
      stage: state.stage,
      message:
        state.status === "idle" &&
        !state.report &&
        !env().CLAUDE_CODE_OAUTH_TOKEN?.trim()
          ? "Connect Claude Code in Connections to ask the Setup Gremlin to analyze this repository, or choose an existing test URL below without AI."
          : state.message,
      updatedAt: state.updatedAt,
      stale: state.configurationRevision !== configurationRevision,
      ...(state.report ? { report: state.report } : {}),
      ...(state.setupPull ? { setupPull: state.setupPull } : {}),
      ...(state.appliedProfile ? { appliedProfile: state.appliedProfile } : {}),
    };
  }
  const busy = (project?: string) => {
    if (project) {
      const operation = store.read(project)?.operation;
      return (
        !!active.get(key(project)) || (!!operation && !dead(operation.pid))
      );
    }
    return (
      [...active.keys()].some((k) => k.startsWith(root + "\0")) ||
      store
        .list()
        .some((state) => state.operation && !dead(state.operation.pid))
    );
  };
  async function begin(
    project: string,
    expected: string | undefined,
    publishing: boolean,
  ) {
    const current = await status(project);
    if (busy(project))
      throw new ProjectOnboardingError(
        "Setup is already running for this project.",
        409,
        "busy",
      );
    if ([...active.keys()].filter((k) => k.startsWith(root + "\0")).length >= 2)
      throw new ProjectOnboardingError(
        "Two setup operations are already running. Retry when one finishes.",
        409,
        "busy",
      );
    if (expected !== undefined && expected !== current.revision)
      throw new ProjectOnboardingError(
        "Setup changed. Reload its latest report before continuing.",
        409,
        "conflict",
      );
    const id = randomBytes(16).toString("hex");
    const state = await store.change(project, (previous) => {
      const next = previous ?? initial(project, current.configurationRevision);
      if (revision(next) !== current.revision || next.operation)
        throw new ProjectOnboardingError(
          "Setup changed. Reload before continuing.",
          409,
        );
      if (publishing && (!next.report || current.stale))
        throw new ProjectOnboardingError(
          "Analyze the current project settings before publishing its setup draft.",
          409,
        );
      next.status = publishing ? "publishing" : "analyzing";
      next.stage = publishing ? "publishing-draft" : "reading-repository";
      next.message = publishing
        ? "Checking the reviewed setup files and preparing a draft pull request."
        : "Reading bounded source files at an exact repository commit. No app scripts are executed.";
      next.operation = { id, pid: process.pid };
      next.updatedAt = new Date().toISOString();
      if (!publishing)
        next.configurationRevision = current.configurationRevision;
      return { state: next, result: next };
    });
    return { id, state };
  }
  async function update(
    project: string,
    id: string,
    action: (state: StoredOnboarding) => void,
  ) {
    await store.change(project, (state) => {
      if (!state || state.operation?.id !== id)
        throw new ProjectOnboardingError(
          "Setup operation was superseded.",
          409,
        );
      action(state);
      state.updatedAt = new Date().toISOString();
      return { state, result: undefined };
    });
  }
  async function launch(
    project: string,
    input: { revision?: string },
    publishing: boolean,
  ) {
    const saved = env();
    if (
      !publishing &&
      (!saved.CLAUDE_CODE_OAUTH_TOKEN?.trim() ||
        /[\r\n\0]/.test(saved.CLAUDE_CODE_OAUTH_TOKEN))
    )
      throw new ProjectOnboardingError(
        "Connect Claude Code in Connections before asking the Setup Gremlin to analyze this repository.",
        400,
        "claude_missing",
      );
    const { id, state } = await begin(project, input.revision, publishing);
    const provider = source(),
      leaseId = `job-setup-source-${id}`;
    const leased = !!provider.acquireLease && !!provider.releaseLease;
    const controller = new AbortController();
    const timeout = Math.max(10, Math.min(options.timeoutMs ?? 240000, 300000));
    const signal = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(timeout),
    ]);
    // The task yields before reading credentials, allowing its in-flight identity to be registered.
    const promise = Promise.resolve()
      .then(async () => {
        const projectConfig = loadProject(root, project);
        const request = {
          provider: projectConfig.config.provider ?? "github",
          serverUrl: projectConfig.config.serverUrl,
          repository: projectConfig.config.repo,
          write: publishing,
        };
        const acquiring = (
          leased
            ? provider.acquireLease!({
                ...request,
                jobId: leaseId,
                minutes: 50,
              })
            : provider.resolveCredential({
                ...request,
                minValidityMs: 6 * 60000,
              })
        ).then(async (credential) => {
          // An acquisition can complete after cancellation while waiting for the
          // shared OAuth refresh lock. Release that late lease as well.
          if (leased && signal.aborted) {
            await provider.releaseLease!(leaseId);
            throw new ProjectOnboardingError(
              "Setup was canceled before source access was ready.",
              408,
            );
          }
          return credential;
        });
        const credential = await bounded(acquiring, signal);
        const secretNames = new Set(
          [...CONNECTIONS, ...projectConnections(root)].map(
            (connection) => connection.name,
          ),
        );
        const secrets = [
          ...Object.values(readConnections(root)),
          ...[...secretNames].map((name) => saved[name]),
          credential.token,
        ].filter((v): v is string => typeof v === "string" && !!v);
        if (publishing) {
          const report = state.report!;
          const head = await bounded(
            resolveRepositoryHead({
              project: projectConfig,
              credential,
              fetch: fetcher,
              signal,
              branch: report.repository.branch,
            }),
            signal,
          );
          if (head.sha !== report.repository.sha)
            throw new ProjectOnboardingError(
              "The repository branch changed after analysis. Reanalyze before publishing setup files.",
              409,
              "stale_repository",
            );
          if (containsSecret(JSON.stringify(report), secrets))
            throw new ProjectOnboardingError(
              "Setup output contains sensitive material. Reanalyze; nothing was published.",
              422,
            );
          if (config(project) !== state.configurationRevision)
            throw new ProjectOnboardingError(
              "Project settings changed. Reanalyze before publishing.",
              409,
            );
          const pull = await bounded(
            publishSetupDraft(
              projectConfig,
              report,
              credential.token,
              fetcher,
              signal,
            ),
            signal,
          );
          await update(project, id, (next) => {
            next.setupPull = pull;
            next.status = "analyzed";
            next.stage = "draft-published";
            next.message =
              "A draft setup pull request is ready for review. Merge its setup files, then reanalyze and test the environment; nothing was auto-merged.";
            delete next.operation;
          });
        } else {
          const snapshot = await bounded(
            readRepository(
              projectConfig,
              credential.token,
              fetcher,
              signal,
              secrets,
            ),
            signal,
          );
          await update(project, id, (next) => {
            next.stage = "analyzing-files";
            next.message = `Claude is analyzing ${snapshot.files.length} safe source files. This is analysis, not environment verification.`;
          });
          const result = await bounded(
            execute({
              credential: saved.CLAUDE_CODE_OAUTH_TOKEN!,
              system: SETUP_SYSTEM,
              schema: SETUP_SCHEMA,
              signal,
              prompt: JSON.stringify({
                project,
                repository: snapshot.repository,
                paths: snapshot.paths,
                files: snapshot.files,
              }),
            }),
            signal,
          );
          if (signal.aborted)
            throw new ProjectOnboardingError(
              "Setup analysis timed out or was canceled. Retry when ready.",
              408,
            );
          const report = validateSetupAnalysis(result, snapshot, secrets);
          if (config(project) !== state.configurationRevision)
            throw new ProjectOnboardingError(
              "Project settings changed during analysis. Retry to analyze the current configuration.",
              409,
            );
          await update(project, id, (next) => {
            next.report = report;
            delete next.setupPull;
            delete next.appliedProfile;
            next.status = "analyzed";
            next.stage = "review-report";
            next.message =
              "Analysis is ready for review. Choose a setup path and supply missing inputs; the application has not been verified.";
            delete next.operation;
          });
        }
      })
      .catch(async (error) => {
        const message =
          error instanceof ProjectOnboardingError
            ? error.message
            : signal.aborted
              ? "Setup timed out or was canceled. Retry explicitly; existing output was preserved."
              : publishing
                ? "Setup publication could not finish. Retry to reconcile the existing draft branch; no branch will be overwritten."
                : "Setup analysis could not finish. Check source access, Claude Code and Docker, then retry. No project configuration was changed.";
        await update(project, id, (next) => {
          next.status = "failed";
          next.stage = "failed";
          next.message = message;
          delete next.operation;
        }).catch(() => {});
      })
      .finally(async () => {
        if (leased) await provider.releaseLease!(leaseId).catch(() => {});
        if (active.get(key(project))?.controller === controller)
          active.delete(key(project));
      });
    active.set(key(project), { controller, promise, publishing });
    return status(project);
  }
  async function apply(
    project: string,
    input: {
      revision: string;
      configurationRevision: string;
      profile: "hosted" | "docker";
      target: ApplyProfileInput["target"];
    },
  ) {
    if (!options.applyProfile)
      throw new ProjectOnboardingError(
        "Environment configuration is unavailable in this controller.",
        503,
      );
    const current = await status(project);
    if (busy(project))
      throw new ProjectOnboardingError(
        "Wait for the current setup operation before applying an environment.",
        409,
      );
    if (
      input.revision !== current.revision ||
      input.configurationRevision !== current.configurationRevision
    )
      throw new ProjectOnboardingError(
        "Project setup changed. Reload before applying an environment.",
        409,
      );
    if (
      !["hosted", "docker"].includes(input.profile) ||
      (input.target.kind === "docker") !== (input.profile === "docker") ||
      input.target.role === "production"
    )
      throw new ProjectOnboardingError(
        "Choose a matching nonproduction environment profile.",
      );
    const target = parseProjectCapabilities({
      environments: { setup: input.target },
      verification: { mode: "browser", environment: "setup" },
    }).environments!.setup!;
    const { id } = await begin(project, current.revision, false);
    try {
      await options.applyProfile({
        project,
        configurationRevision: current.configurationRevision,
        profile: input.profile,
        target,
        ...(current.report ? { report: current.report } : {}),
      });
      await update(project, id, (next) => {
        next.configurationRevision = config(project);
        next.appliedProfile = input.profile;
        next.status = current.report ? "analyzed" : "idle";
        next.stage = "environment-saved";
        next.message =
          "Environment settings saved. Run the environment test before PMs rely on this setup.";
        delete next.operation;
      });
    } catch (error) {
      await update(project, id, (next) => {
        next.status = "failed";
        next.stage = "failed";
        next.message =
          "Environment settings could not be applied. Reload the current configuration before retrying.";
        delete next.operation;
      });
      throw error;
    }
    return status(project);
  }
  return {
    status,
    busy,
    apply,
    async recordConfigured(
      project: string,
      input: {
        previousConfigurationRevision: string;
        profile: "hosted" | "docker";
      },
    ) {
      const currentRevision = config(project),
        projectConfig = loadProject(root, project);
      await store.change(project, (previous) => {
        const state = previous ?? initial(project, currentRevision);
        // Only our successful environment-only CAS may advance this report's config
        // baseline. Other edits or a newly selected inspection branch remain stale.
        if (
          !state.operation &&
          (!state.report ||
            (state.configurationRevision ===
              input.previousConfigurationRevision &&
              state.report.repository.repo === projectConfig.config.repo &&
              state.report.repository.provider ===
                (projectConfig.config.provider ?? "github") &&
              state.report.repository.branch ===
                inspectionBranch(projectConfig.config)))
        ) {
          state.configurationRevision = currentRevision;
          state.appliedProfile = input.profile;
          state.updatedAt = new Date().toISOString();
        }
        return { state, result: undefined };
      });
      return status(project);
    },
    discover: (project: string, input: { revision?: string } = {}) =>
      launch(project, input, false),
    prepareSetupPr: (project: string, input: { revision: string }) =>
      launch(project, input, true),
    async cancel(project: string, input: { revision: string }) {
      const current = await status(project),
        task = active.get(key(project));
      if (current.revision !== input.revision)
        throw new ProjectOnboardingError(
          "Setup changed. Reload before canceling.",
          409,
        );
      if (!task || task.publishing)
        throw new ProjectOnboardingError(
          "Only this controller's running analysis can be canceled; publishing must finish or reconcile.",
          409,
        );
      task.controller.abort();
      return status(project);
    },
    async idle() {
      await Promise.all(
        [...active.entries()]
          .filter(([k]) => k.startsWith(root + "\0"))
          .map(([, task]) => task.promise),
      );
    },
    async close() {
      for (const [k, task] of active)
        if (k.startsWith(root + "\0") && !task.publishing)
          task.controller.abort();
      await this.idle();
    },
  };
}
export type ProjectOnboarding = ReturnType<typeof createProjectOnboarding>;
