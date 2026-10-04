// The one place the real clients are built from the environment. Nothing
// under src/dispatcher/ reads process.env; src/cli.ts calls this.

import { GitHubForge } from "../forge/github.ts";
import { LinearApi } from "./linear.ts";
import { SlackWebhook } from "./slack.ts";
import type { LinearClient, SlackClient, VercelClient } from "./types.ts";
import { VercelApi } from "./vercel.ts";

export interface Clients {
  forge: GitHubForge;
  linear: LinearClient;
  vercel: VercelClient;
  slack: SlackClient;
}

const REQUIRED = {
  GITHUB_TOKEN:
    "a GitHub token (the app installation token in CI, a PAT locally)",
  LINEAR_API_KEY: "a Linear API key",
  VERCEL_TOKEN: "a Vercel access token",
} as const;

function need(env: NodeJS.ProcessEnv, name: keyof typeof REQUIRED): string {
  const value = env[name];
  if (!value) {
    throw new Error(`Missing environment variable ${name} — ${REQUIRED[name]}`);
  }
  return value;
}

export function clientsFromEnv(env: NodeJS.ProcessEnv): Clients {
  const forge = new GitHubForge({ token: need(env, "GITHUB_TOKEN") });
  const linear = new LinearApi({ apiKey: need(env, "LINEAR_API_KEY") });
  const vercel = new VercelApi({ token: need(env, "VERCEL_TOKEN") });
  return { forge, linear, vercel, slack: new SlackWebhook() };
}
