// Vercel over its REST API with fetch only: the newest preview deployment of
// a branch and its stable branch alias.

import { fetchJson, HttpError } from "../http.ts";
import type { Deployment, VercelClient } from "./types.ts";

export interface VercelApiOptions {
  token: string;
  apiBase?: string;
  /** A saved nonproduction Vercel custom environment, otherwise Preview. */
  customEnvironmentId?: string;
}

interface ListedDeployment {
  uid: string;
  id?: string;
  projectId?: string;
  ownerId?: string;
  teamId?: string;
  target?: string | null;
  customEnvironmentId?: string;
  customEnvironment?: { id?: string } | null;
  gitSource?: { ref?: string; sha?: string };
  alias?: string[];
  url: string;
  state?: string;
  readyState?: string;
  created?: number;
  createdAt?: number;
  meta?: {
    githubCommitRef?: string;
    githubCommitSha?: string;
    gitlabCommitRef?: string;
    gitlabCommitSha?: string;
  };
}

/** Vercel's branch alias slug: `<project>-git-<branch>-<team>` with non-alphanumerics folded to `-` */
const branchSlug = (branch: string): string =>
  branch
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

export class VercelApi implements VercelClient {
  private readonly token: string;
  private readonly apiBase: string;
  private readonly customEnvironmentId?: string;

  constructor(opts: VercelApiOptions) {
    if (!opts.token) throw new Error("VercelApi needs a token");
    this.token = opts.token;
    if (
      opts.customEnvironmentId !== undefined &&
      (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/.test(opts.customEnvironmentId) ||
        ["production", "preview", "development"].includes(
          opts.customEnvironmentId.toLowerCase(),
        ))
    )
      throw new Error("Vercel custom environment must be a resource ID.");
    this.customEnvironmentId = opts.customEnvironmentId;
    this.apiBase = (opts.apiBase ?? "https://api.vercel.com").replace(
      /\/$/,
      "",
    );
  }

  private async get<T>(
    path: string,
    params: Record<string, string | null>,
  ): Promise<T> {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== null) qs.set(k, v);
    const query = qs.toString();
    return fetchJson<T>(`${this.apiBase}${path}${query ? `?${query}` : ""}`, {
      headers: { authorization: `Bearer ${this.token}` },
    });
  }

  private matches(
    deployment: ListedDeployment,
    projectId: string,
    teamId: string | null,
    branch: string,
  ): boolean {
    const environment =
      deployment.customEnvironment?.id ?? deployment.customEnvironmentId;
    return (
      deployment.target !== "production" &&
      (this.customEnvironmentId
        ? environment === this.customEnvironmentId
        : !environment &&
          (deployment.target == null || deployment.target === "preview")) &&
      (deployment.projectId === undefined ||
        deployment.projectId === projectId) &&
      (!teamId ||
        ((!deployment.ownerId || deployment.ownerId === teamId) &&
          (!deployment.teamId || deployment.teamId === teamId))) &&
      (deployment.meta?.githubCommitRef ??
        deployment.meta?.gitlabCommitRef ??
        deployment.gitSource?.ref) === branch
    );
  }

  private async resolve(
    projectId: string,
    teamId: string | null,
    branch: string,
  ): Promise<{ deployment: Deployment; detail: ListedDeployment } | null> {
    const res = await this.get<{ deployments: ListedDeployment[] }>(
      "/v6/deployments",
      {
        projectId,
        teamId,
        branch,
        target: this.customEnvironmentId ? null : "preview",
        limit: "100",
      },
    );
    const createdMs = (d: ListedDeployment): number =>
      d.created ?? d.createdAt ?? 0;
    const match = res.deployments
      .filter((d) => this.matches(d, projectId, teamId, branch))
      .sort((a, b) => createdMs(b) - createdMs(a))[0];
    if (!match) return null;
    const id = match.uid ?? match.id;
    if (!id || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/.test(id)) return null;
    let detail: ListedDeployment;
    try {
      detail = await this.get<ListedDeployment>(
        `/v13/deployments/${encodeURIComponent(id)}`,
        { teamId },
      );
    } catch (error) {
      if (error instanceof HttpError && error.status === 404) return null;
      throw error;
    }
    if (!detail || typeof detail !== "object") return null;
    const sha =
      detail.meta?.githubCommitSha ??
      detail.meta?.gitlabCommitSha ??
      detail.gitSource?.sha ??
      "";
    if (
      detail.projectId !== projectId ||
      (detail.id ?? detail.uid) !== id ||
      !this.matches(detail, projectId, teamId, branch) ||
      typeof detail.url !== "string" ||
      !/^[a-zA-Z0-9](?:[a-zA-Z0-9.-]{0,251}[a-zA-Z0-9])?$/.test(detail.url) ||
      !detail.url.includes(".") ||
      !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(sha)
    )
      return null;
    return {
      detail,
      deployment: {
        id,
        state: detail.readyState ?? detail.state ?? "",
        url: detail.url,
        sha,
        branch,
        createdAt: new Date(
          createdMs(detail) || createdMs(match),
        ).toISOString(),
      },
    };
  }

  async latestDeployment(
    projectId: string,
    teamId: string | null,
    branch: string,
  ): Promise<Deployment | null> {
    return (await this.resolve(projectId, teamId, branch))?.deployment ?? null;
  }

  async branchUrl(
    projectId: string,
    teamId: string | null,
    branch: string,
  ): Promise<string | null> {
    const resolved = await this.resolve(projectId, teamId, branch);
    if (!resolved || resolved.deployment.state !== "READY") return null;
    const { deployment: dep, detail } = resolved;
    // A branch alias can be shared by Preview and a custom environment. The
    // immutable deployment URL keeps that selection unambiguous.
    if (this.customEnvironmentId) return `https://${dep.url}`;
    const needle = `-git-${branchSlug(branch)}-`;
    const alias = (detail.alias ?? []).find(
      (a) =>
        /^[a-zA-Z0-9](?:[a-zA-Z0-9.-]{0,251}[a-zA-Z0-9])?$/.test(a) &&
        a.includes(needle),
    );
    if (alias) return `https://${alias}`;
    return `https://${dep.url}`;
  }
}
