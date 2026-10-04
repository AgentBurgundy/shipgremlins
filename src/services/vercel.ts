// Vercel over its REST API with fetch only: the newest preview deployment of
// a branch and its stable branch alias.

import { fetchJson, HttpError } from "../http.ts";
import type { Deployment, VercelClient } from "./types.ts";

export interface VercelApiOptions {
  token: string;
  apiBase?: string;
}

interface ListedDeployment {
  uid: string;
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

  constructor(opts: VercelApiOptions) {
    if (!opts.token) throw new Error("VercelApi needs a token");
    this.token = opts.token;
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

  async latestDeployment(
    projectId: string,
    teamId: string | null,
    branch: string,
  ): Promise<Deployment | null> {
    const res = await this.get<{ deployments: ListedDeployment[] }>(
      "/v6/deployments",
      {
        projectId,
        teamId,
        target: "preview",
        limit: "20",
      },
    );
    const createdMs = (d: ListedDeployment): number =>
      d.created ?? d.createdAt ?? 0;
    const match = res.deployments
      .filter(
        (d) => (d.meta?.githubCommitRef ?? d.meta?.gitlabCommitRef) === branch,
      )
      .sort((a, b) => createdMs(b) - createdMs(a))[0];
    if (!match) return null;
    return {
      id: match.uid,
      state: match.state ?? match.readyState ?? "",
      url: match.url,
      sha: match.meta?.githubCommitSha ?? match.meta?.gitlabCommitSha ?? "",
      branch,
      createdAt: new Date(createdMs(match)).toISOString(),
    };
  }

  async branchUrl(
    projectId: string,
    teamId: string | null,
    branch: string,
  ): Promise<string | null> {
    const dep = await this.latestDeployment(projectId, teamId, branch);
    if (!dep) return null;
    const needle = `-git-${branchSlug(branch)}-`;
    try {
      const detail = await this.get<{ alias?: string[] }>(
        `/v13/deployments/${dep.id}`,
        {
          teamId,
        },
      );
      const alias = (detail.alias ?? []).find((a) => a.includes(needle));
      if (alias) return `https://${alias}`;
    } catch (err) {
      if (!(err instanceof HttpError)) throw err;
    }
    return `https://${dep.url}`;
  }
}
