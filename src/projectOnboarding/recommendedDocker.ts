import { isDeepStrictEqual } from "node:util";
import { loadProject, type Project } from "../config.ts";
import {
  effectiveVerification,
  inspectionBranch,
} from "../projectCapabilities.ts";
import {
  readEditableConfig,
  saveEditableConfig,
} from "../setup/configEditor.ts";
import {
  parseDockerTarget,
  type DockerEnvironmentTarget,
} from "../testEnvironments/recipe.ts";
import { crewSourceIdentity } from "./crewContext.ts";
import {
  digest,
  type StoredOnboarding,
  type createOnboardingStore,
} from "./store.ts";
import { ProjectOnboardingError } from "./types.ts";

export interface RecommendedDockerStatus {
  status: "ready" | "blocked" | "configured";
  message: string;
  blockers: string[];
  environment?: string;
  target?: DockerEnvironmentTarget;
}
export interface PrepareDockerInput {
  revision: string;
  configurationRevision: string;
}

/** A source suggestion is not a verified environment or permission to start a PM. */
export function recommendedDocker(
  state: StoredOnboarding | undefined,
  project: Project,
): RecommendedDockerStatus {
  const blocked = (message: string): RecommendedDockerStatus => ({
    status: "blocked",
    message,
    blockers: [message],
  });
  const report = state?.report;
  if (!state || !report || state.status !== "analyzed" || state.operation)
    return blocked(
      "Finish repository analysis before preparing its suggested Docker environment.",
    );
  const sourceMatches = state.recommendationSourceRevision
    ? state.recommendationSourceRevision ===
      digest(JSON.stringify(crewSourceIdentity(project)))
    : !project.config.serverUrl &&
      report.repository.repo === project.config.repo &&
      report.repository.provider === (project.config.provider ?? "github") &&
      report.repository.branch === inspectionBranch(project.config);
  if (!sourceMatches)
    return blocked(
      "The repository or inspection branch changed. Analyze the current source before using this recipe.",
    );
  if (report.recommendation !== "docker" || !report.docker)
    return blocked(
      "This source report does not recommend a Docker environment. Choose its suggested hosting setup instead.",
    );
  if (report.proposedFiles.length)
    return blocked(
      "Merge the proposed setup files and analyze the updated repository before preparing Docker.",
    );
  if (report.missingInputs.some((input) => input.required))
    return blocked(
      "This Docker recipe still needs required setup inputs. Complete those inputs before testing it.",
    );
  if (
    report.docker.recipe.kind !== "dockerfile" ||
    !report.repository.filesRead.includes(report.docker.recipe.dockerfile)
  )
    return blocked(
      "The suggested Dockerfile must already exist in the inspected repository. Analyze its runnable recipe first.",
    );
  const access = report.projectSetup?.appAccess;
  if (
    access?.kind !== "public" ||
    !access.evidence.length ||
    access.evidence.some(
      (item) => !report.repository.filesRead.includes(item.path),
    )
  )
    return blocked(
      "Review the app's sign-in requirements and configure dedicated test access before preparing this recipe.",
    );
  let target: DockerEnvironmentTarget;
  try {
    target = parseDockerTarget({
      ...report.docker,
      kind: "docker",
      role: "preview",
      access: { kind: "public" },
    });
  } catch {
    return blocked(
      "This Docker suggestion is no longer supported. Analyze the repository again before applying it.",
    );
  }
  const verification = effectiveVerification(project.config);
  if (verification.mode === "browser") {
    if (isDeepStrictEqual(verification.target, target))
      return {
        status: "configured",
        blockers: [],
        target,
        environment: verification.environment,
        message:
          "The suggested Docker environment is saved. Test it in the browser before the PM relies on it.",
      };
    return blocked(
      "A different browser environment is already selected. Its settings are preserved; change environments explicitly in Settings.",
    );
  }
  const environments = project.config.environments ?? {};
  let environment = "pm-test";
  for (
    let suffix = 2;
    Object.hasOwn(environments, environment) &&
    !isDeepStrictEqual(environments[environment], target);
    suffix++
  ) {
    if (suffix > 32)
      return blocked(
        "Choose an existing test environment in Settings before adding another one.",
      );
    environment = `pm-test-${suffix}`;
  }
  return {
    status: "ready",
    blockers: [],
    environment,
    target,
    message:
      "Use the repository's existing Docker recipe to create an isolated test app and check it in the browser. No PM starts automatically.",
  };
}

/** Called only by an explicit setup action, within the controller's configuration lock. */
export async function prepareRecommendedDocker(options: {
  root: string;
  store: ReturnType<typeof createOnboardingStore>;
  project: string;
  input: PrepareDockerInput;
  checkHead: (project: Project, branch: string) => Promise<string>;
}) {
  const { root, store, project: name, input } = options;
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).some(
      (key) => !["revision", "configurationRevision"].includes(key),
    ) ||
    ![input.revision, input.configurationRevision].every(
      (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value),
    )
  )
    throw new ProjectOnboardingError(
      "Use the current source report and project revision to prepare Docker.",
      400,
      "invalid_confirmation",
    );
  const state = store.read(name),
    selected = loadProject(root, name),
    document = readEditableConfig(root, `projects/${name}/project.json`);
  const conflict = () =>
    new ProjectOnboardingError(
      "Project setup changed. Refresh before preparing its Docker environment.",
      409,
      "conflict",
    );
  if (
    !state ||
    digest(JSON.stringify(state)) !== input.revision ||
    document.revision !== input.configurationRevision
  )
    throw conflict();
  const proposed = recommendedDocker(state, selected);
  if (proposed.status === "blocked")
    throw new ProjectOnboardingError(
      proposed.message,
      409,
      "recipe_unavailable",
    );
  const report = state.report!;
  if (
    (await options.checkHead(selected, report.repository.branch)) !==
    report.repository.sha
  )
    throw new ProjectOnboardingError(
      "The repository changed after analysis. Analyze the current commit before applying this Docker recipe.",
      409,
      "stale_repository",
    );
  const raw = JSON.parse(document.content),
    target = proposed.target!,
    environment = proposed.environment!;
  raw.environments = { ...raw.environments, [environment]: target };
  raw.verification = { mode: "browser", environment };
  // Browser mode may inspect a different integration branch than initial source discovery.
  const targetBranch = inspectionBranch({
    ...selected.config,
    environments: raw.environments,
    verification: raw.verification,
  });
  if (
    targetBranch !== report.repository.branch &&
    (await options.checkHead(selected, targetBranch)) !== report.repository.sha
  )
    throw new ProjectOnboardingError(
      "The PM test branch differs from the inspected recipe. Bring that branch up to date and analyze it before preparing Docker.",
      409,
      "stale_repository",
    );
  await store.change(name, (current) => {
    if (
      !current ||
      digest(JSON.stringify(current)) !== input.revision ||
      readEditableConfig(root, document.path).revision !== document.revision
    )
      throw conflict();
    const latest = recommendedDocker(current, loadProject(root, name));
    if (
      latest.status === "blocked" ||
      !isDeepStrictEqual(latest.target, target) ||
      latest.environment !== environment
    )
      throw conflict();
    // Repeated access tests must not clear an otherwise unchanged verification stamp.
    if (proposed.status !== "configured") {
      raw.verified = null;
      saveEditableConfig(root, {
        path: document.path,
        revision: document.revision,
        content: JSON.stringify(raw, null, 2) + "\n",
      });
    }
    current.configurationRevision = readEditableConfig(
      root,
      document.path,
    ).revision;
    current.appliedProfile = "docker";
    current.stage = "environment-saved";
    current.message =
      "Suggested Docker environment saved. Browser testing must pass before PM patrols can use it.";
    current.updatedAt = new Date().toISOString();
    return { state: current, result: undefined };
  });
}
