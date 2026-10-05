import type { ProjectConfig } from "./config.ts";
import { validConnectionId } from "./oauthConnection/profileId.ts";
export { validConnectionId } from "./oauthConnection/profileId.ts";

export type ProjectWorkflow =
  | { kind: "pull-request"; baseBranch: string }
  | { kind: "promotion"; candidateEnvironment?: string };
export type ProjectVerification =
  { mode: "repository" } | { mode: "browser"; environment: string };

/** Accounts are connections; these are resource identities, never credentials. */
export type EnvironmentTarget = {
  role: "preview" | "staging" | "production";
} & (
  | { kind: "url"; url: string }
  | {
      kind: "vercel";
      projectId: string;
      teamId?: string | null;
      connectionId?: string;
      bypassSecret?: string;
      branch?: string;
    }
  | {
      kind: "railway";
      projectId: string;
      environmentId: string;
      serviceId: string;
      tokenSecret?: string;
      tokenType?: "account" | "project";
      branch?: string;
    }
  | {
      kind: "cloud-run";
      projectId: string;
      region: string;
      service: string;
      credentialsSecret?: string;
    }
);

export interface ProjectCapabilities {
  workflow?: ProjectWorkflow;
  verification?: ProjectVerification;
  environments?: Record<string, EnvironmentTarget>;
}

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function keys(value: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key)))
    throw new Error(
      "Project capabilities contain an unsupported field. Store credentials in Connections, using secret names in configuration.",
    );
}
function resource(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/.test(value)
  );
}
export function validBranch(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 200 &&
    /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value) &&
    !value.startsWith("-") &&
    !value.startsWith("/") &&
    !value.endsWith("/") &&
    !value.endsWith(".") &&
    !value.includes("..") &&
    !value.includes("@{") &&
    value !== "@" &&
    !value
      .split("/")
      .some((part) => !part || part.startsWith(".") || part.endsWith(".lock"))
  );
}
export function validEnvironmentUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2048) return false;
  try {
    const url = new URL(value);
    return (
      ["https:", "http:"].includes(url.protocol) &&
      !!url.hostname &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  } catch {
    return false;
  }
}
export function validProjectSecretName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[A-Z][A-Z0-9_]{0,127}$/.test(value) &&
    !/^(SHIPGREMLINS_|NODE_|LD_|DYLD_|PATH$|HOME$|APP_PRIVATE_KEY$)/.test(value)
  );
}
const CONTROLLER_SECRETS = new Set([
  "GITHUB_TOKEN",
  "GITLAB_TOKEN",
  "LINEAR_API_KEY",
  "VERCEL_TOKEN",
  "RAILWAY_TOKEN",
  "GCP_SERVICE_ACCOUNT_JSON",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_API_KEY",
]);
export function validWorkerSecretName(value: unknown): value is string {
  return validProjectSecretName(value) && !CONTROLLER_SECRETS.has(value);
}
function optionalSecret(value: unknown): void {
  if (value !== undefined && !validProjectSecretName(value))
    throw new Error(
      "Environment credential references must be SECRET NAMES, never credential values or process settings.",
    );
}
function parseTarget(value: unknown): EnvironmentTarget {
  if (
    !object(value) ||
    !["preview", "staging", "production"].includes(String(value.role))
  )
    throw new Error(
      "Each environment needs a preview, staging, or production role.",
    );
  const common = ["kind", "role"];
  switch (value.kind) {
    case "url":
      keys(value, [...common, "url"]);
      if (!validEnvironmentUrl(value.url))
        throw new Error(
          "Environment URL must be HTTP or HTTPS without credentials, query parameters, or a fragment.",
        );
      break;
    case "vercel":
      keys(value, [
        ...common,
        "projectId",
        "teamId",
        "connectionId",
        "bypassSecret",
        "branch",
      ]);
      if (
        !resource(value.projectId) ||
        (value.teamId != null && !resource(value.teamId))
      )
        throw new Error(
          "Vercel environment requires a projectId and an optional teamId.",
        );
      optionalSecret(value.bypassSecret);
      if (
        value.connectionId !== undefined &&
        !validConnectionId(value.connectionId)
      )
        throw new Error("Vercel connectionId must name a saved account.");
      if (
        value.bypassSecret !== undefined &&
        !validWorkerSecretName(value.bypassSecret)
      )
        throw new Error(
          "Preview access must reference a dedicated test credential, not a controller connection.",
        );
      break;
    case "railway":
      keys(value, [
        ...common,
        "projectId",
        "environmentId",
        "serviceId",
        "tokenSecret",
        "tokenType",
        "branch",
      ]);
      if (
        ![value.projectId, value.environmentId, value.serviceId].every(resource)
      )
        throw new Error(
          "Railway environment requires projectId, environmentId, and serviceId.",
        );
      optionalSecret(value.tokenSecret);
      if (
        typeof value.tokenSecret === "string" &&
        CONTROLLER_SECRETS.has(value.tokenSecret) &&
        value.tokenSecret !== "RAILWAY_TOKEN"
      )
        throw new Error("Railway must use its own connection credential.");
      if (
        value.tokenType !== undefined &&
        !["account", "project"].includes(String(value.tokenType))
      )
        throw new Error("Railway tokenType must be account or project.");
      break;
    case "cloud-run":
      keys(value, [
        ...common,
        "projectId",
        "region",
        "service",
        "credentialsSecret",
      ]);
      if (![value.projectId, value.region, value.service].every(resource))
        throw new Error(
          "Cloud Run environment requires projectId, region, and service.",
        );
      optionalSecret(value.credentialsSecret);
      if (
        typeof value.credentialsSecret === "string" &&
        CONTROLLER_SECRETS.has(value.credentialsSecret) &&
        value.credentialsSecret !== "GCP_SERVICE_ACCOUNT_JSON"
      )
        throw new Error(
          "Cloud Run must use its own Google connection credential.",
        );
      break;
    default:
      throw new Error(
        "Environment kind must be url, vercel, railway, or cloud-run.",
      );
  }
  if (value.branch !== undefined && !validBranch(value.branch))
    throw new Error("Environment branch must be a valid Git branch.");
  return structuredClone(value) as EnvironmentTarget;
}

/** Pure validation shared by setup, dashboard saves, and the on-disk loader. */
export function parseProjectCapabilities(
  raw: Record<string, unknown>,
): ProjectCapabilities {
  const result: ProjectCapabilities = {};
  if (raw.workflow !== undefined) {
    if (!object(raw.workflow)) throw new Error("workflow must be an object.");
    if (raw.workflow.kind === "pull-request") {
      keys(raw.workflow, ["kind", "baseBranch"]);
      if (!validBranch(raw.workflow.baseBranch))
        throw new Error("Pull-request workflow requires a valid baseBranch.");
      result.workflow = {
        kind: "pull-request",
        baseBranch: raw.workflow.baseBranch,
      };
    } else if (raw.workflow.kind === "promotion") {
      keys(raw.workflow, ["kind", "candidateEnvironment"]);
      if (
        raw.workflow.candidateEnvironment !== undefined &&
        (typeof raw.workflow.candidateEnvironment !== "string" ||
          !/^[a-z][a-z0-9-]{0,62}$/.test(raw.workflow.candidateEnvironment))
      )
        throw new Error(
          "Candidate environment must name an existing nonproduction target.",
        );
      result.workflow = {
        kind: "promotion",
        ...(raw.workflow.candidateEnvironment !== undefined
          ? {
              candidateEnvironment: raw.workflow.candidateEnvironment as string,
            }
          : {}),
      };
    } else throw new Error("workflow.kind must be pull-request or promotion.");
  }
  if (raw.environments !== undefined) {
    if (!object(raw.environments) || Object.keys(raw.environments).length > 16)
      throw new Error(
        "environments must be an object with at most 16 named targets.",
      );
    const entries = Object.entries(raw.environments).map(([name, value]) => {
      if (
        !/^[a-z][a-z0-9-]{0,62}$/.test(name) ||
        ["constructor", "prototype"].includes(name)
      )
        throw new Error("Environment names must use lowercase kebab-case.");
      return [name, parseTarget(value)] as const;
    });
    result.environments = Object.fromEntries(entries);
  }
  if (raw.verification !== undefined) {
    if (!object(raw.verification))
      throw new Error("verification must be an object.");
    if (raw.verification.mode === "repository") {
      keys(raw.verification, ["mode"]);
      result.verification = { mode: "repository" };
    } else if (raw.verification.mode === "browser") {
      keys(raw.verification, ["mode", "environment"]);
      const name = raw.verification.environment;
      if (
        typeof name !== "string" ||
        !result.environments ||
        !Object.hasOwn(result.environments, name)
      )
        throw new Error(
          "Browser verification must select an existing named environment.",
        );
      if (result.environments[name]!.role === "production")
        throw new Error(
          "Browser verification must use a preview or staging environment, never production.",
        );
      result.verification = { mode: "browser", environment: name };
    } else throw new Error("verification.mode must be repository or browser.");
  } else if (result.environments && Object.keys(result.environments).length) {
    throw new Error(
      "Choose repository verification or select a named browser environment.",
    );
  }
  if (
    result.workflow?.kind === "promotion" &&
    result.workflow.candidateEnvironment
  ) {
    const name = result.workflow.candidateEnvironment,
      target = result.environments?.[name];
    if (
      !target ||
      target.role === "production" ||
      !["railway", "vercel"].includes(target.kind)
    )
      throw new Error(
        "Candidate environment must be a named nonproduction Vercel or Railway target.",
      );
    const inspection =
      result.verification?.mode === "browser"
        ? result.environments?.[result.verification.environment]
        : undefined;
    if (
      result.verification?.mode === "browser" &&
      name === result.verification.environment
    )
      throw new Error(
        "Choose a candidate environment separate from integration.",
      );
    if (
      target.kind === "railway" &&
      inspection?.kind === "railway" &&
      target.environmentId === inspection.environmentId &&
      target.serviceId === inspection.serviceId
    )
      throw new Error(
        "Railway candidate and integration targets must use separate service instances.",
      );
  }
  return result;
}

export function validateWorkerSecretReferences(config: ProjectConfig): void {
  const targets = Object.values(config.environments ?? {});
  const controllerNames = new Set(
    targets.flatMap((target) =>
      target.kind === "railway"
        ? [target.tokenSecret ?? "RAILWAY_TOKEN"]
        : target.kind === "cloud-run"
          ? [target.credentialsSecret ?? "GCP_SERVICE_ACCOUNT_JSON"]
          : [],
    ),
  );
  const workerNames = [
    config.vercel?.bypassSecret,
    config.signIn?.databaseUrlSecret,
    ...targets.flatMap((target) =>
      target.kind === "vercel" ? [target.bypassSecret] : [],
    ),
  ].filter((name): name is string => name !== undefined);
  if (
    workerNames.some(
      (name) => !validWorkerSecretName(name) || controllerNames.has(name),
    )
  )
    throw new Error(
      "Preview and sign-in access must use dedicated test credentials, never hosting or controller connection credentials.",
    );
}

export function hostingSecretNames(config: ProjectConfig): string[] {
  return Object.values(config.environments ?? {}).flatMap((target) =>
    target.kind === "railway"
      ? [target.tokenSecret ?? "RAILWAY_TOKEN"]
      : target.kind === "cloud-run"
        ? [target.credentialsSecret ?? "GCP_SERVICE_ACCOUNT_JSON"]
        : [],
  );
}

export function effectiveWorkflow(config: ProjectConfig): ProjectWorkflow {
  return (
    config.workflow ??
    (config.vercel
      ? { kind: "promotion" }
      : {
          kind: "pull-request",
          baseBranch: config.branches?.production ?? "main",
        })
  );
}
export function baseBranch(config: ProjectConfig): string {
  const workflow = effectiveWorkflow(config);
  return workflow.kind === "pull-request"
    ? workflow.baseBranch
    : config.branches.integration;
}
/** PMs inspect the deployed baseline; coding jobs still branch from their PR base. */
export function inspectionBranch(config: ProjectConfig): string {
  const verification = effectiveVerification(config);
  return verification.mode === "browser" &&
    ["vercel", "railway"].includes(verification.target.kind) &&
    "branch" in verification.target &&
    verification.target.branch
    ? verification.target.branch
    : baseBranch(config);
}
export function effectiveVerification(
  config: ProjectConfig,
):
  | { mode: "repository" }
  | { mode: "browser"; environment: string; target: EnvironmentTarget } {
  if (config.verification?.mode === "repository") return { mode: "repository" };
  if (config.verification?.mode === "browser") {
    const name = config.verification.environment;
    const target =
      config.environments && Object.hasOwn(config.environments, name)
        ? config.environments[name]
        : undefined;
    if (!target || target.role === "production")
      throw new Error(
        "Select a preview or staging environment before running browser verification.",
      );
    return { mode: "browser", environment: name, target };
  }
  if (config.vercel)
    return {
      mode: "browser",
      environment: "integration",
      target: { kind: "vercel", role: "preview", ...config.vercel },
    };
  return { mode: "repository" };
}
export function projectSecretNames(config: ProjectConfig): string[] {
  const targets = Object.values(config.environments ?? {});
  if (config.vercel)
    targets.push({ role: "preview", kind: "vercel", ...config.vercel });
  return [
    ...new Set(
      targets.flatMap((target) => {
        if (target.kind === "vercel")
          return target.bypassSecret ? [target.bypassSecret] : [];
        if (target.kind === "railway")
          return [target.tokenSecret ?? "RAILWAY_TOKEN"];
        if (target.kind === "cloud-run")
          return [target.credentialsSecret ?? "GCP_SERVICE_ACCOUNT_JSON"];
        return [];
      }),
    ),
  ];
}

/** Legacy promotion evidence is bound to an exact Vercel deployment + commit. */
export function promotionVercel(
  config: ProjectConfig,
): Extract<EnvironmentTarget, { kind: "vercel" }> | null {
  if (effectiveWorkflow(config).kind !== "promotion") return null;
  const verification = effectiveVerification(config);
  return verification.mode === "browser" &&
    verification.target.kind === "vercel"
    ? verification.target
    : null;
}

/** The optional checked-in Actions templates still consume the legacy shape. */
export function supportsLegacyCI(config: ProjectConfig): boolean {
  return (
    !!config.vercel &&
    !config.verification &&
    effectiveWorkflow(config).kind === "promotion"
  );
}
