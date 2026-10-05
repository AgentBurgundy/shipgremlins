import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { loadProject, type Project } from "../config.ts";
import { readEditableConfig } from "../setup/configEditor.ts";
import {
  inspectionBranch,
  validBranch,
  validConnectionId,
} from "../projectCapabilities.ts";
import {
  sourceApi,
  sourceRequest,
  SHA,
} from "../projectOnboarding/repository.ts";
import {
  createVercelSetupStore,
  dead,
  digest,
  validProject,
  type StoredVercelSetup,
} from "./store.ts";
import {
  createVercelApi,
  deploymentSummary,
  paginated,
  projectSummary,
  record,
  resource,
  type VercelApi,
} from "./provider.ts";
import {
  VercelSetupError,
  type VercelSetupOptions,
  type VercelSetupState,
  type VercelDiscoverInput,
  type VercelPrepareInput,
  type VercelDeployInput,
  type VercelInventory,
  type VercelPlan,
} from "./types.ts";
export * from "./types.ts";

const active = new Map<
  string,
  { promise: Promise<VercelSetupState>; controller: AbortController }
>();
const id = () => randomBytes(16).toString("hex");
export function createVercelSetup(options: VercelSetupOptions) {
  const root = resolve(options.root),
    store = createVercelSetupStore(root),
    fetcher = options.fetch ?? fetch;
  let closed = false;
  const key = (project: string) => `${root}\0${project}`;
  const configuration = (project: string) => {
    validProject(project);
    loadProject(root, project);
    return readEditableConfig(root, `projects/${project}/project.json`)
      .revision;
  };
  const initial = (project: string): StoredVercelSetup => ({
    schema: 1,
    project,
    configurationRevision: configuration(project),
    status: "idle",
    message:
      "Find your existing Vercel test environment or prepare a new preview.",
    updatedAt: new Date(0).toISOString(),
  });
  const revision = (state: StoredVercelSetup) => digest(JSON.stringify(state));
  const snapshot = (state: StoredVercelSetup): VercelSetupState => {
    const {
      schema: _schema,
      operation: _operation,
      attempt: _attempt,
      ...visible
    } = state;
    return {
      ...visible,
      revision: revision(state),
      configurationRevision: configuration(state.project),
      stale: state.configurationRevision !== configuration(state.project),
    };
  };
  function busy(project?: string) {
    if (project) {
      const operation = store.read(project)?.operation;
      return active.has(key(project)) || (!!operation && !dead(operation.pid));
    }
    return (
      [...active.keys()].some((value) => value.startsWith(`${root}\0`)) ||
      store
        .list()
        .some((state) => state.operation && !dead(state.operation.pid))
    );
  }
  async function save(
    project: string,
    operation: string,
    change: (state: StoredVercelSetup) => void,
  ) {
    return store.change(project, (current) => {
      if (!current || current.operation?.id !== operation)
        throw new VercelSetupError(
          "This setup operation is no longer current.",
          409,
        );
      change(current);
      current.updatedAt = new Date().toISOString();
      return { state: current, result: current };
    });
  }
  async function run(
    project: string,
    expected: string | undefined,
    kind: StoredVercelSetup["status"],
    action: (
      state: StoredVercelSetup,
      operation: string,
      signal: AbortSignal,
    ) => Promise<void>,
  ) {
    if (closed)
      throw new VercelSetupError(
        "The controller is stopping. Retry after it restarts.",
        503,
      );
    if (active.has(key(project)))
      throw new VercelSetupError(
        "Vercel setup is already running for this project.",
        409,
        "busy",
      );
    const controller = new AbortController(),
      operation = id();
    const promise = Promise.resolve()
      .then(async () => {
        const state = await store.change(project, (current) => {
          const value = current ?? initial(project);
          if (expected !== undefined && expected !== revision(value))
            throw new VercelSetupError(
              "Setup changed. Refresh and review the current plan.",
              409,
              "stale",
            );
          if (value.operation && !dead(value.operation.pid))
            throw new VercelSetupError(
              "Vercel setup is already running.",
              409,
              "busy",
            );
          value.operation = { id: operation, pid: process.pid };
          value.status = kind;
          value.updatedAt = new Date().toISOString();
          return { state: value, result: value };
        });
        try {
          await action(
            state,
            operation,
            AbortSignal.any([controller.signal, AbortSignal.timeout(90_000)]),
          );
        } catch (error) {
          const safe =
            error instanceof VercelSetupError
              ? error
              : new VercelSetupError(
                  "Setup could not complete. Check source access and the selected Vercel connection, then retry.",
                  502,
                );
          await save(project, operation, (value) => {
            value.status = "failed";
            value.message = safe.message;
          }).catch(() => {});
          throw safe;
        } finally {
          await save(project, operation, (value) => {
            delete value.operation;
          }).catch(() => {});
        }
        return snapshot(store.read(project)!);
      })
      .finally(() => {
        active.delete(key(project));
      });
    active.set(key(project), { promise, controller });
    return promise;
  }
  async function apiFor(
    input: Pick<VercelDiscoverInput, "connectionId" | "teamId" | "projectId">,
    signal: AbortSignal,
  ) {
    const connectionId = input.connectionId ?? "default";
    if (
      !validConnectionId(connectionId) ||
      (input.teamId != null && !resource(input.teamId)) ||
      (input.projectId !== undefined && !resource(input.projectId))
    )
      throw new VercelSetupError(
        "Choose a saved Vercel account, team and project.",
      );
    let credential;
    try {
      credential = await options
        .vercelConnectionFor(connectionId)
        .resolveCredential({
          projectId: input.projectId,
          teamId: input.teamId,
          minValidityMs: 120_000,
        });
    } catch {
      throw new VercelSetupError(
        "Reconnect the selected Vercel account or check access to this team and project.",
        401,
        "connection",
      );
    }
    // OAuth connections reject foreign teams; enforce it here too for embedded adapters.
    if (input.teamId && credential.teamId && input.teamId !== credential.teamId)
      throw new VercelSetupError(
        "This Vercel connection belongs to another team. Choose the matching account.",
        403,
      );
    const teamId = input.teamId ?? credential.teamId;
    return {
      api: createVercelApi(fetcher, credential.token, teamId, signal),
      connectionId,
      teamId,
    };
  }
  const selected = (state: StoredVercelSetup) => {
    if (!state.inventory?.selectedProject)
      throw new VercelSetupError("Choose a Vercel project first.");
    return {
      inventory: state.inventory,
      project: state.inventory.selectedProject,
    };
  };
  async function deployments(api: VercelApi, inventory: VercelInventory) {
    const listed = await paginated(api, "/v6/deployments", "deployments", {
      projectId: inventory.selectedProject!.id,
    });
    const candidates = listed.values
      .flatMap((value) => {
        const candidate = deploymentSummary(value, inventory);
        return candidate ? [candidate] : [];
      })
      .sort((a, b) => b.createdAt - a.createdAt);
    const seen = new Set<string>();
    for (const candidate of candidates) {
      if (!candidate.branch || candidate.environment === "production") continue;
      const key = `${candidate.branch}\0${candidate.customEnvironmentId ?? "preview"}`;
      if (seen.has(key)) {
        candidate.selectable = false;
        candidate.reason =
          "A newer deployment exists for this branch and environment. PMs follow the newest deployment.";
        delete candidate.target;
      }
      seen.add(key);
    }
    return { ...listed, deployments: candidates };
  }
  async function discover(project: string, input: VercelDiscoverInput = {}) {
    return run(
      project,
      input.revision,
      "discovering",
      async (state, operation, signal) => {
        if (state.attempt?.deploymentSent && !state.deployment)
          throw new VercelSetupError(
            "A deployment request is still unconfirmed. Use Check deployment before changing the selected project.",
            409,
            "unconfirmed",
          );
        const context = await apiFor(input, signal),
          config = loadProject(root, project).config;
        const listed = await paginated(context.api, "/v9/projects", "projects");
        const projects = listed.values.flatMap((value) => {
          const summary = projectSummary(value, config);
          return summary ? [summary] : [];
        });
        const inventory: VercelInventory = {
          connectionId: context.connectionId,
          ...(context.teamId !== undefined ? { teamId: context.teamId } : {}),
          projects,
          deployments: [],
          truncated: listed.truncated,
        };
        // Never choose among same-repository monorepo projects without an explicit selection.
        if (input.projectId) {
          const detail = projectSummary(
            await context.api(
              `/v9/projects/${encodeURIComponent(input.projectId)}`,
            ),
            config,
          );
          if (!detail || detail.id !== input.projectId)
            throw new VercelSetupError(
              "Vercel returned another project. Choose it again.",
              502,
            );
          inventory.selectedProject = detail;
          const existing = projects.findIndex(
            (entry) => entry.id === detail.id,
          );
          if (existing < 0) projects.push(detail);
          else projects[existing] = detail;
          const found = await deployments(context.api, inventory);
          inventory.deployments = found.deployments;
          inventory.truncated ||= found.truncated;
        }
        await save(project, operation, (value) => {
          value.configurationRevision = configuration(project);
          value.inventory = inventory;
          value.status = "discovered";
          value.message = inventory.selectedProject
            ? "Review the existing deployments or prepare a dedicated PM preview. READY describes deployment health; PM access still needs verification."
            : "Choose the Vercel project for this application. Repository matches are suggestions; check its root directory for monorepos.";
          delete value.plan;
          delete value.deployment;
          delete value.target;
          delete value.attempt;
        });
      },
    );
  }
  async function withSource<T>(
    project: Project,
    operation: string,
    signal: AbortSignal,
    write: boolean,
    action: (token: string) => Promise<T>,
  ) {
    const source = options.sourceControl,
      lease = `job-vercel-setup-${operation}`,
      leased = !!source.acquireLease && !!source.releaseLease;
    const request = {
      provider: project.config.provider ?? "github",
      serverUrl: project.config.serverUrl,
      repository: project.config.repo,
      write,
    };
    try {
      const credential = await (leased
        ? source.acquireLease!({ ...request, jobId: lease, minutes: 5 })
        : source.resolveCredential({ ...request, minValidityMs: 120_000 }));
      signal.throwIfAborted();
      return await action(credential.token);
    } finally {
      if (leased) await source.releaseLease!(lease);
    }
  }
  async function branchHead(
    project: Project,
    branch: string,
    token: string,
    signal: AbortSignal,
  ) {
    const github = (project.config.provider ?? "github") === "github";
    const response = await sourceRequest(
      fetcher,
      `${sourceApi(project)}/${github ? "git/ref/heads/" : "repository/branches/"}${encodeURIComponent(branch)}`,
      token,
      signal,
      "GET",
      undefined,
      true,
    );
    if (response.value === null) return undefined;
    const value = record(response.value),
      commit = record(github ? value.object : value.commit),
      sha = github ? commit.sha : commit.id;
    if (typeof sha !== "string" || !SHA.test(sha))
      throw new VercelSetupError(
        "Source control did not return an exact branch commit.",
        502,
      );
    return sha;
  }
  async function prepare(project: string, input: VercelPrepareInput) {
    return run(
      project,
      input.revision,
      "prepared",
      async (state, operation, signal) => {
        const { inventory, project: chosen } = selected(state),
          config = loadProject(root, project);
        if (state.configurationRevision !== configuration(project))
          throw new VercelSetupError(
            "Project configuration changed. Discover its Vercel environment again.",
            409,
            "stale",
          );
        if (state.attempt?.deploymentSent && !state.deployment)
          throw new VercelSetupError(
            "A deployment request is unconfirmed. Check its result before preparing another plan.",
            409,
            "unconfirmed",
          );
        const context = await apiFor(
          { ...inventory, projectId: chosen.id },
          signal,
        );
        const fresh = projectSummary(
          await context.api(`/v9/projects/${encodeURIComponent(chosen.id)}`),
          config.config,
        );
        if (
          !fresh?.matchesRepository ||
          fresh.id !== chosen.id ||
          !fresh.productionBranch ||
          !fresh.repositoryId
        )
          throw new VercelSetupError(
            "This Vercel project must have a recognized Git link to this repository and a known production branch before previews can be created.",
          );
        const branch = input.branch ?? "pm-staging",
          baseBranch = input.baseBranch ?? inspectionBranch(config.config);
        if (
          !validBranch(branch) ||
          !validBranch(baseBranch) ||
          branch === fresh.productionBranch ||
          branch === config.config.branches.production
        )
          throw new VercelSetupError(
            "Choose a dedicated nonproduction branch such as pm-staging.",
          );
        const custom = input.customEnvironmentId;
        if (
          custom !== undefined &&
          !fresh.customEnvironments.some((value) => value.id === custom)
        )
          throw new VercelSetupError(
            "Choose an existing nonproduction custom environment from this Vercel project.",
          );
        const source = await withSource(
          config,
          operation,
          signal,
          false,
          async (token) => {
            const existing = await branchHead(config, branch, token, signal);
            if (existing) return { sha: existing, createBranch: false };
            const base = await branchHead(config, baseBranch, token, signal);
            if (!base)
              throw new VercelSetupError(
                "The base branch does not exist. Choose an existing branch in this repository.",
              );
            return { sha: base, createBranch: true };
          },
        );
        const target = {
          kind: "vercel" as const,
          role: "preview" as const,
          connectionId: inventory.connectionId,
          projectId: fresh.id,
          ...(inventory.teamId !== undefined
            ? { teamId: inventory.teamId }
            : {}),
          branch,
          ...(custom ? { customEnvironmentId: custom } : {}),
        };
        const plan: VercelPlan = {
          id: id(),
          projectId: fresh.id,
          projectName: fresh.name,
          branch,
          baseBranch,
          ...source,
          ...(custom ? { customEnvironmentId: custom } : {}),
          target,
          configurationRevision: configuration(project),
          createdAt: new Date().toISOString(),
          warnings: [
            "Vercel uses the selected preview or custom environment's existing variables. Confirm these point to test databases, test accounts and safe external services before creating a preview.",
            "Creating a Git branch may also trigger this repository's existing CI and Vercel Git integration.",
            "No production settings, environment variables, domains or deployment protection will be changed.",
            ...(fresh.rootDirectory
              ? [
                  `Check the selected application's root directory: ${fresh.rootDirectory}.`,
                ]
              : []),
          ],
        };
        await save(project, operation, (value) => {
          value.inventory = { ...inventory, selectedProject: fresh };
          value.plan = plan;
          value.status = "prepared";
          value.message =
            "Review the exact branch and commit, then confirm that the environment uses test data.";
          delete value.attempt;
          delete value.deployment;
          delete value.target;
        });
      },
    );
  }
  async function reconcile(
    api: VercelApi,
    inventory: VercelInventory,
    state: StoredVercelSetup,
  ) {
    const found = await deployments(api, inventory),
      plan = state.plan!;
    const matched = found.values.find(
      (value) =>
        record(record(value).meta).shipgremlinsSetupOperation ===
        state.attempt?.id,
    );
    if (matched) return deploymentSummary(matched, inventory);
    // The Git integration may already have deployed our newly created branch.
    if (state.attempt?.branchSent && !state.attempt.deploymentSent)
      return found.deployments.find(
        (value) =>
          value.environment !== "production" &&
          value.branch === plan.branch &&
          value.sha === plan.sha &&
          value.customEnvironmentId === plan.customEnvironmentId &&
          value.createdAt >= Date.parse(plan.createdAt) - 10_000,
      );
    return undefined;
  }
  async function recordDeployment(
    project: string,
    operation: string,
    api: VercelApi,
    inventory: VercelInventory,
    deploymentId: string,
    plan: VercelPlan,
  ) {
    const detail = await api(
      `/v13/deployments/${encodeURIComponent(deploymentId)}`,
    );
    const candidate = deploymentSummary(detail, inventory);
    if (
      !candidate ||
      candidate.id !== deploymentId ||
      detail.projectId !== plan.projectId ||
      candidate.environment === "production" ||
      candidate.branch !== plan.branch ||
      candidate.sha !== plan.sha ||
      candidate.customEnvironmentId !== plan.customEnvironmentId
    )
      throw new VercelSetupError(
        "Vercel's deployment does not match the reviewed preview plan. Inspect it in Vercel; no test target was saved.",
        409,
        "deployment_mismatch",
      );
    await save(project, operation, (value) => {
      value.deployment = candidate;
      value.status =
        candidate.state === "ERROR" ||
        candidate.state === "CANCELED" ||
        candidate.state === "BLOCKED"
          ? "failed"
          : "deployed";
      value.message =
        candidate.state === "READY"
          ? "Your preview is ready. Select it as the test environment, add test sign-in if needed, and verify PM access."
          : `Preview deployment ${candidate.state.toLowerCase()}. Refresh to check its progress.`;
      if (candidate.target) value.target = candidate.target;
      else delete value.target;
    });
  }
  async function deploy(project: string, input: VercelDeployInput) {
    if (input.confirmTestData !== true)
      throw new VercelSetupError(
        "Confirm the selected environment uses test data before deploying.",
      );
    return run(
      project,
      input.revision,
      "deploying",
      async (state, operation, signal) => {
        const { inventory, project: chosen } = selected(state),
          plan = state.plan,
          config = loadProject(root, project);
        if (
          !plan ||
          plan.configurationRevision !== configuration(project) ||
          state.configurationRevision !== configuration(project)
        )
          throw new VercelSetupError(
            "The preview plan is stale. Discover and review a new plan.",
            409,
            "stale",
          );
        const { api } = await apiFor(
          { ...inventory, projectId: chosen.id },
          signal,
        );
        if (state.deployment) {
          await recordDeployment(
            project,
            operation,
            api,
            inventory,
            state.deployment.id,
            plan,
          );
          return;
        }
        const fresh = projectSummary(
          await api(`/v9/projects/${encodeURIComponent(chosen.id)}`),
          config.config,
        );
        if (
          !fresh?.matchesRepository ||
          fresh.id !== chosen.id ||
          fresh.repositoryId !== chosen.repositoryId ||
          fresh.productionBranch !== chosen.productionBranch ||
          fresh.rootDirectory !== chosen.rootDirectory ||
          plan.branch === fresh.productionBranch ||
          (plan.customEnvironmentId &&
            !fresh.customEnvironments.some(
              (value) => value.id === plan.customEnvironmentId,
            ))
        )
          throw new VercelSetupError(
            "Vercel's Git or environment settings changed. Review a new plan before deployment.",
            409,
            "stale",
          );
        let current = state;
        if (!current.attempt)
          current = await save(project, operation, (value) => {
            value.attempt = { id: id(), planId: plan.id };
          });
        const recovered = await reconcile(api, inventory, current);
        if (recovered) {
          await recordDeployment(
            project,
            operation,
            api,
            inventory,
            recovered.id,
            plan,
          );
          return;
        }
        if (current.attempt?.deploymentSent)
          throw new VercelSetupError(
            "Vercel has not confirmed the previous deployment request. Check again later; a second deployment was not created.",
            409,
            "unconfirmed",
          );
        await withSource(
          config,
          operation,
          signal,
          plan.createBranch,
          async (token) => {
            let head = await branchHead(config, plan.branch, token, signal);
            if (head && head !== plan.sha)
              throw new VercelSetupError(
                "The preview branch changed after review. Prepare a new plan.",
                409,
                "stale",
              );
            if (!head) {
              if (!plan.createBranch)
                throw new VercelSetupError(
                  "The reviewed preview branch was removed. Prepare a new plan.",
                  409,
                  "stale",
                );
              const base = await branchHead(
                config,
                plan.baseBranch,
                token,
                signal,
              );
              if (base !== plan.sha)
                throw new VercelSetupError(
                  "The base branch changed after review. Prepare a new plan.",
                  409,
                  "stale",
                );
              if (current.attempt?.branchSent)
                throw new VercelSetupError(
                  "The previous branch creation request is unconfirmed. Inspect the source repository before creating another plan.",
                  409,
                  "unconfirmed",
                );
              current = await save(project, operation, (value) => {
                value.attempt!.branchSent = true;
              });
              const github = (config.config.provider ?? "github") === "github";
              let rejected = false;
              try {
                await sourceRequest(
                  async (url, init) => {
                    const response = await fetcher(url, init);
                    rejected = [400, 401, 403, 404, 422, 429].includes(
                      response.status,
                    );
                    return response;
                  },
                  sourceApi(config) +
                    (github ? "/git/refs" : "/repository/branches"),
                  token,
                  signal,
                  "POST",
                  github
                    ? { ref: `refs/heads/${plan.branch}`, sha: plan.sha }
                    : { branch: plan.branch, ref: plan.sha },
                );
              } catch (error) {
                if (rejected)
                  current = await save(project, operation, (value) => {
                    delete value.attempt!.branchSent;
                  });
                throw error;
              }
              head = await branchHead(config, plan.branch, token, signal);
              if (head !== plan.sha)
                throw new VercelSetupError(
                  "The created branch could not be confirmed at the reviewed commit.",
                  409,
                  "unconfirmed",
                );
            }
          },
        );
        const automatic = await reconcile(api, inventory, current);
        if (automatic) {
          await recordDeployment(
            project,
            operation,
            api,
            inventory,
            automatic.id,
            plan,
          );
          return;
        }
        current = await save(project, operation, (value) => {
          value.attempt!.deploymentSent = true;
        });
        // Omitted target means preview in the Vercel deployment API. The ref cannot be production.
        const gitSource =
          chosen.provider === "gitlab"
            ? {
                type: "gitlab",
                projectId: chosen.repositoryId,
                ref: plan.branch,
                sha: plan.sha,
              }
            : {
                type: "github",
                repoId: chosen.repositoryId,
                ref: plan.branch,
                sha: plan.sha,
              };
        let created;
        try {
          created = await api(
            "/v13/deployments",
            {},
            {
              name: chosen.name,
              project: chosen.id,
              gitSource,
              meta: { shipgremlinsSetupOperation: current.attempt!.id },
              ...(plan.customEnvironmentId
                ? { customEnvironmentSlugOrId: plan.customEnvironmentId }
                : {}),
            },
          );
        } catch (error) {
          if (
            error instanceof VercelSetupError &&
            error.code === "provider_rejected"
          )
            await save(project, operation, (value) => {
              delete value.attempt!.deploymentSent;
            });
          throw error;
        }
        const deploymentId = created.id ?? created.uid;
        if (!resource(deploymentId))
          throw new VercelSetupError(
            "Vercel accepted the request without a usable deployment ID. Check again; no second request will be sent.",
            502,
            "unconfirmed",
          );
        await recordDeployment(
          project,
          operation,
          api,
          inventory,
          deploymentId,
          plan,
        );
      },
    );
  }
  async function status(project: string): Promise<VercelSetupState> {
    const state = store.read(project) ?? initial(project);
    if (state.operation && dead(state.operation.pid))
      await store.change(project, (current) => {
        const value = current!;
        if (value.operation && dead(value.operation.pid)) {
          delete value.operation;
          value.status = "failed";
          value.message =
            "Setup was interrupted. Check the deployment to recover its result safely.";
        }
        return { state: value, result: undefined };
      });
    const current = store.read(project) ?? state;
    if (
      !busy(project) &&
      current.plan &&
      current.inventory?.selectedProject &&
      ((current.attempt?.deploymentSent && !current.deployment) ||
        (current.deployment &&
          ["BUILDING", "INITIALIZING", "QUEUED"].includes(
            current.deployment.state,
          )))
    ) {
      try {
        return await run(
          project,
          undefined,
          current.status,
          async (value, operation, signal) => {
            const { api } = await apiFor(
              { ...value.inventory!, projectId: value.plan!.projectId },
              signal,
            );
            const candidate =
              value.deployment ??
              (await reconcile(api, value.inventory!, value));
            if (candidate)
              await recordDeployment(
                project,
                operation,
                api,
                value.inventory!,
                candidate.id,
                value.plan!,
              );
          },
        );
      } catch {
        return snapshot(store.read(project)!);
      }
    }
    return snapshot(current);
  }
  async function idle() {
    await Promise.allSettled(
      [...active.entries()]
        .filter(([value]) => value.startsWith(`${root}\0`))
        .map(([, value]) => value.promise),
    );
  }
  async function close() {
    closed = true;
    for (const [value, task] of active)
      if (value.startsWith(`${root}\0`)) task.controller.abort();
    await idle();
  }
  return { status, discover, prepare, deploy, busy, idle, close };
}
