import type { ProjectConfig } from "../config.ts";
import { validBranch, validEnvironmentUrl } from "../projectCapabilities.ts";
import { SHA } from "../projectOnboarding/repository.ts";
import {
  VercelSetupError,
  type VercelCandidate,
  type VercelInventory,
  type VercelProject,
} from "./types.ts";

export const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
export const resource = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/.test(value);
const text = (value: unknown, max = 200) =>
  typeof value === "string"
    ? value.replace(/[\p{Cc}\p{Cf}]/gu, "").slice(0, max)
    : "";
export function projectSummary(
  value: unknown,
  config: ProjectConfig,
): VercelProject | undefined {
  const data = record(value),
    link = record(data.link);
  if (!resource(data.id) || !resource(data.name)) return undefined;
  const provider = ["github", "github-limited"].includes(String(link.type))
    ? "github"
    : link.type === "gitlab"
      ? "gitlab"
      : undefined;
  let repository =
    provider === "github"
      ? `${link.org ?? ""}/${link.repo ?? ""}`
      : provider === "gitlab"
        ? `${link.projectNamespace ?? ""}/${link.projectName ?? ""}`
        : undefined;
  if (repository && !/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+$/.test(repository))
    repository = undefined;
  const sourceOrigin =
    config.serverUrl ??
    (config.provider === "gitlab"
      ? "https://gitlab.com"
      : "https://github.com");
  let linkedOrigin =
    provider === "github" ? "https://github.com" : "https://gitlab.com";
  if (provider === "gitlab" && typeof link.projectUrl === "string") {
    try {
      linkedOrigin = new URL(link.projectUrl).origin;
    } catch {
      linkedOrigin = "";
    }
  }
  const repositoryId = String(
    provider === "gitlab" ? (link.projectId ?? "") : (link.repoId ?? ""),
  );
  return {
    id: data.id,
    name: data.name,
    ...(repository ? { repository } : {}),
    ...(provider ? { provider } : {}),
    ...(/^\d{1,20}$/.test(repositoryId) ? { repositoryId } : {}),
    matchesRepository:
      !!repository &&
      provider === (config.provider ?? "github") &&
      linkedOrigin === new URL(sourceOrigin).origin &&
      repository.toLowerCase() === config.repo.toLowerCase(),
    ...(validBranch(link.productionBranch)
      ? { productionBranch: link.productionBranch }
      : {}),
    ...(typeof data.rootDirectory === "string"
      ? { rootDirectory: text(data.rootDirectory, 300) }
      : {}),
    customEnvironments: (Array.isArray(data.customEnvironments)
      ? data.customEnvironments
      : []
    )
      .slice(0, 50)
      .flatMap((raw) => {
        const environment = record(raw);
        return resource(environment.id) &&
          resource(environment.slug) &&
          !["production", "preview", "development"].includes(
            environment.slug.toLowerCase(),
          )
          ? [{ id: environment.id, slug: environment.slug }]
          : [];
      }),
  };
}
export function deploymentSummary(
  value: unknown,
  inventory: VercelInventory,
): VercelCandidate | undefined {
  const data = record(value),
    meta = record(data.meta),
    source = record(data.gitSource),
    project = inventory.selectedProject;
  const id = data.uid ?? data.id;
  if (
    !resource(id) ||
    !project ||
    (data.projectId !== undefined && data.projectId !== project.id)
  )
    return undefined;
  const branch = meta.githubCommitRef ?? meta.gitlabCommitRef ?? source.ref;
  const sha = meta.githubCommitSha ?? meta.gitlabCommitSha ?? source.sha;
  const custom = record(data.customEnvironment).id ?? data.customEnvironmentId;
  const customEnvironmentId = resource(custom) ? custom : undefined;
  const environment =
    data.target === "production"
      ? "production"
      : customEnvironmentId
        ? "custom"
        : "preview";
  const knownEnvironment = customEnvironmentId
    ? project.customEnvironments.some(
        (entry) => entry.id === customEnvironmentId,
      )
    : [null, undefined, "preview"].includes(
        data.target as null | undefined | string,
      );
  const rawUrl =
    typeof data.url === "string" ? `https://${data.url}` : undefined;
  const url =
    rawUrl && validEnvironmentUrl(rawUrl) && new URL(rawUrl).pathname === "/"
      ? rawUrl
      : undefined;
  const state = [
    "READY",
    "BUILDING",
    "ERROR",
    "CANCELED",
    "QUEUED",
    "INITIALIZING",
    "BLOCKED",
  ].includes(String(data.readyState ?? data.state))
    ? String(data.readyState ?? data.state)
    : "UNKNOWN";
  let reason: string | undefined;
  if (environment === "production")
    reason = "Production deployments cannot be selected for PM testing.";
  else if (!knownEnvironment)
    reason = "The deployment environment could not be matched safely.";
  else if (!project.matchesRepository)
    reason =
      "This Vercel project is linked to a different or unrecognized repository.";
  else if (!validBranch(branch))
    reason = "The deployment has no verified Git branch.";
  else if (typeof sha !== "string" || !SHA.test(sha))
    reason = "The deployment has no verified Git commit.";
  else if (state !== "READY")
    reason = "Wait until the latest deployment is ready.";
  else if (!url) reason = "The deployment has no valid preview URL.";
  const target =
    !reason && validBranch(branch)
      ? {
          kind: "vercel" as const,
          role: "preview" as const,
          connectionId: inventory.connectionId,
          projectId: project.id,
          ...(inventory.teamId !== undefined
            ? { teamId: inventory.teamId }
            : {}),
          branch,
          ...(customEnvironmentId ? { customEnvironmentId } : {}),
        }
      : undefined;
  return {
    id,
    state,
    environment,
    ...(validBranch(branch) ? { branch } : {}),
    ...(typeof sha === "string" && SHA.test(sha) ? { sha } : {}),
    ...(url ? { url } : {}),
    ...(customEnvironmentId ? { customEnvironmentId } : {}),
    createdAt:
      typeof (data.createdAt ?? data.created) === "number" &&
      Number.isFinite(data.createdAt ?? data.created)
        ? Number(data.createdAt ?? data.created)
        : 0,
    selectable: !!target,
    ...(reason ? { reason } : {}),
    ...(target ? { target } : {}),
  };
}
export function createVercelApi(
  fetcher: typeof fetch,
  token: string,
  teamId: string | null | undefined,
  signal: AbortSignal,
) {
  if (!token || token.length > 16_384 || /[\s\p{Cc}]/u.test(token))
    throw new VercelSetupError("Reconnect the selected Vercel account.", 401);
  return async (
    path: string,
    params: Record<string, string> = {},
    body?: unknown,
  ) => {
    const url = new URL(path, "https://api.vercel.com");
    if (url.origin !== "https://api.vercel.com")
      throw new VercelSetupError("Unsupported Vercel endpoint.");
    if (teamId) url.searchParams.set("teamId", teamId);
    for (const [key, value] of Object.entries(params))
      url.searchParams.set(key, value);
    try {
      const response = await fetcher(url.href, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        redirect: "error",
        signal,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new VercelSetupError(
          body !== undefined && response.status === 403
            ? "Vercel denied deployment creation. Reconnect an account with deployment write access to this project, or save a Vercel token with that permission in Connections."
            : [401, 403].includes(response.status)
              ? "Vercel denied access. Check the selected account, team and project permissions."
              : response.status === 404
                ? "Vercel could not find that project or deployment in this account."
                : "Vercel could not complete this request. Check its dashboard before retrying.",
          [400, 401, 403, 404, 422, 429].includes(response.status)
            ? response.status
            : 502,
          body !== undefined &&
            [400, 401, 403, 404, 422, 429].includes(response.status)
            ? "provider_rejected"
            : "provider_request",
        );
      }
      const reader = response.body?.getReader();
      if (!reader) throw new Error();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.length;
          if (size > 1_048_576) throw new Error();
          chunks.push(part.value);
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
      return record(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    } catch (error) {
      if (error instanceof VercelSetupError) throw error;
      throw new VercelSetupError(
        "Vercel did not return a usable response. Check its dashboard before retrying.",
        502,
        "provider_response",
      );
    }
  };
}
export type VercelApi = ReturnType<typeof createVercelApi>;
export async function paginated(
  api: VercelApi,
  path: string,
  field: string,
  params: Record<string, string> = {},
) {
  const values: unknown[] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  for (let page = 0; page < 5; page++) {
    const data = await api(path, {
      ...params,
      limit: "100",
      ...(cursor ? { until: cursor } : {}),
    });
    if (!Array.isArray(data[field]))
      throw new VercelSetupError("Vercel returned an unexpected listing.", 502);
    values.push(...data[field].slice(0, 100));
    const next = record(data.pagination).next;
    if (next === null || next === undefined)
      return { values, truncated: data[field].length > 100 };
    cursor = String(next);
    if (!/^\d{1,16}$/.test(cursor) || cursors.has(cursor))
      return { values, truncated: true };
    cursors.add(cursor);
  }
  return { values, truncated: true };
}
