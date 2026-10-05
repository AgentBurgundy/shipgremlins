import { randomUUID } from "node:crypto";
import type { ProjectConfig } from "../config.ts";
import {
  createLinearConnection,
  type LinearConnection,
} from "../linearConnection/index.ts";
import {
  createVercelConnection,
  type VercelConnection,
} from "../vercelConnection/index.ts";
import {
  promotionVercel,
  effectiveVerification,
} from "../projectCapabilities.ts";
import { GitHubForge } from "../forge/github.ts";
import { LinearApi } from "./linear.ts";
import { VercelApi } from "./vercel.ts";
import { SlackWebhook } from "./slack.ts";
import type { Clients } from "./index.ts";

export interface ProjectClientOptions {
  root: string;
  env: NodeJS.ProcessEnv;
  linearConnectionFor?: (
    id?: string,
  ) => Pick<LinearConnection, "acquireLease" | "releaseLease">;
  vercelConnectionFor?: (
    id?: string,
  ) => Pick<VercelConnection, "resolveCredential">;
}

/** Keep the selected account reserved for the whole command, without changing process.env. */
export async function withLinearCredential<T>(
  options: ProjectClientOptions,
  config: ProjectConfig | undefined,
  action: (authorization: string) => Promise<T>,
): Promise<T> {
  const account =
    options.linearConnectionFor?.(config?.linear?.connectionId) ??
    createLinearConnection({
      root: options.root,
      env: options.env,
      connectionId: config?.linear?.connectionId,
    });
  const jobId = `command-${randomUUID()}`;
  try {
    const credential = await account.acquireLease({
      jobId,
      minutes: 50,
      ...(config?.linear?.workspaceId
        ? { workspaceId: config.linear.workspaceId }
        : {}),
    });
    return await action(credential.authorization);
  } finally {
    await account.releaseLease(jobId);
  }
}

/** Legacy dispatcher clients are constructed separately for each configured project. */
export async function withProjectClients<T>(
  options: ProjectClientOptions,
  config: ProjectConfig,
  action: (clients: Clients) => Promise<T>,
): Promise<T> {
  return withLinearCredential(options, config, async (authorization) => {
    const github = options.env.GITHUB_TOKEN;
    if (!github)
      throw new Error("Missing GITHUB_TOKEN for this legacy CI command.");
    const verification = effectiveVerification(config);
    const target =
      promotionVercel(config) ??
      (verification.mode === "browser" && verification.target.kind === "vercel"
        ? verification.target
        : undefined);
    // Repository-only completion audits do not need a hosting connection.
    const unavailable = async (): Promise<never> => {
      throw new Error("This project has no selected Vercel environment.");
    };
    let vercel: Clients["vercel"] = {
      latestDeployment: unavailable,
      branchUrl: unavailable,
    };
    if (target) {
      const account =
        options.vercelConnectionFor?.(target.connectionId) ??
        createVercelConnection({
          root: options.root,
          env: options.env,
          connectionId: target.connectionId,
        });
      const credential = await account.resolveCredential({
        projectId: target.projectId,
        teamId: target.teamId,
        minValidityMs: 5 * 60_000,
      });
      const api = new VercelApi({ token: credential.token });
      vercel = {
        latestDeployment: (projectId, teamId, branch) =>
          api.latestDeployment(
            projectId,
            teamId ?? credential.teamId ?? null,
            branch,
          ),
        branchUrl: (projectId, teamId, branch) =>
          api.branchUrl(projectId, teamId ?? credential.teamId ?? null, branch),
      };
    }
    return action({
      forge: new GitHubForge({ token: github }),
      linear: new LinearApi({ apiKey: authorization }),
      vercel,
      slack: new SlackWebhook(),
    });
  });
}
