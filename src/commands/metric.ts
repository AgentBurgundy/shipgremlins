// `gremlins metric --project <p> --area <a>` — a configured Mixpanel Insights
// report, or the area's existing Vercel 7/28-day counts. Optional failures
// produce an unavailable result and exit 0 so the PM reports missing evidence.

import { loadProject, type AreaConfig, type ProjectConfig } from "../config.ts";
import { parseFlags, type Io } from "./crons.ts";
import { readMixpanel } from "../telemetry/read.ts";
import { effectiveVerification } from "../projectCapabilities.ts";
import {
  createVercelConnection,
  type VercelConnection,
} from "../vercelConnection/index.ts";

function metricTarget(project: ProjectConfig) {
  // A production Vercel environment is an explicit analytics destination only.
  const production = Object.values(project.environments ?? {}).find(
    (target) => target.role === "production" && target.kind === "vercel",
  );
  if (production?.kind === "vercel") return production;
  const verification = effectiveVerification(project);
  if (verification.mode === "browser" && verification.target.kind === "vercel")
    return verification.target;
  return project.vercel;
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export const UNAVAILABLE = "unavailable";
const DAY = 86_400_000;

export function statsUrl(
  project: ProjectConfig,
  area: AreaConfig,
  days: number,
  now: Date,
): string {
  const to = now.toISOString();
  const from = new Date(now.getTime() - days * DAY).toISOString();
  const key = area.metric.startsWith("/") ? "path" : "event";
  const target = metricTarget(project);
  if (!target) throw new Error("This project has no Vercel analytics target.");
  const q = new URLSearchParams({
    projectId: target.projectId,
    teamId: target.teamId ?? "",
    environment: "production",
    from,
    to,
    filter: JSON.stringify({ [key]: { values: [area.metric] } }),
  });
  return `https://api.vercel.com/v1/web-analytics/stats?${q.toString()}`;
}

/** best-effort: the first plausible total in an undocumented payload */
export function extractCount(body: unknown): number | null {
  const candidates: unknown[] = [];
  const obj = (v: unknown): Record<string, unknown> | null =>
    typeof v === "object" && v !== null && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : null;
  const top = obj(body);
  if (!top) return null;
  const data =
    obj(top.data) ?? (Array.isArray(top.data) ? obj(top.data[0]) : null);
  for (const o of [top, data]) {
    if (!o) continue;
    for (const k of ["total", "count", "events", "visitors", "views"])
      candidates.push(o[k]);
  }
  const n = candidates.find((v) => typeof v === "number" && Number.isFinite(v));
  return typeof n === "number" ? n : null;
}

export async function readMetric(
  project: ProjectConfig,
  area: AreaConfig,
  opts: {
    env: NodeJS.ProcessEnv;
    fetch: FetchLike;
    now?: () => Date;
    vercelConnectionFor?: (
      id?: string,
    ) => Pick<VercelConnection, "resolveCredential">;
  },
): Promise<{ d7: number; d28: number } | null> {
  const target = metricTarget(project);
  if (!target) return null;
  let token: string | undefined;
  let teamId = target.teamId;
  try {
    if (opts.vercelConnectionFor) {
      const credential = await opts
        .vercelConnectionFor(target.connectionId)
        .resolveCredential({
          projectId: target.projectId,
          teamId,
          minValidityMs: 5 * 60_000,
        });
      token = credential.token;
      teamId ??= credential.teamId;
    } else if (!target.connectionId || target.connectionId === "default")
      token = opts.env.VERCEL_TOKEN;
  } catch {
    return null;
  }
  if (!token || !teamId) return null;
  const now = (opts.now ?? (() => new Date()))();
  const one = async (days: number): Promise<number | null> => {
    try {
      const url = new URL(statsUrl(project, area, days, now));
      url.searchParams.set("teamId", teamId);
      const res = await opts.fetch(url.toString(), {
        headers: { authorization: `Bearer ${token}` },
      });
      if (!res.ok) return null;
      return extractCount(await res.json());
    } catch {
      return null;
    }
  };
  const [d7, d28] = await Promise.all([one(7), one(28)]);
  if (d7 === null || d28 === null) return null;
  return { d7, d28 };
}

export async function runMetric(
  root: string,
  args: string[],
  io: Io,
  deps: { env: NodeJS.ProcessEnv; fetch: FetchLike } = {
    env: process.env,
    fetch,
  },
): Promise<number> {
  const { values } = parseFlags(args);
  const projectName = values.project;
  const areaKey = values.area;
  if (typeof projectName !== "string" || typeof areaKey !== "string") {
    io.error("usage: gremlins metric --project <name> --area <key>");
    return 1;
  }
  const project = loadProject(root, projectName);
  const area = project.areas.find((a) => a.key === areaKey);
  if (!area) {
    io.error(`project ${projectName} has no area "${areaKey}"`);
    return 1;
  }
  if (area.mixpanelReportId) {
    io.log(
      JSON.stringify(await readMixpanel(project.config, area, deps), null, 2),
    );
    return 0;
  }
  const counts = await readMetric(project.config, area, {
    ...deps,
    vercelConnectionFor: (connectionId) =>
      createVercelConnection({
        root,
        env: deps.env,
        fetch: deps.fetch as typeof fetch,
        connectionId,
      }),
  });
  io.log(
    counts
      ? `${area.metric}: 7d ${counts.d7} · 28d ${counts.d28} (Vercel Analytics, production)`
      : UNAVAILABLE,
  );
  return 0;
}
