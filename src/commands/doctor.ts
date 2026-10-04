// `hub doctor <name>` — checks the add-project checklist against the live
// APIs and, when everything passes, stamps `verified` into project.json so
// `hub crons` starts generating this project's PM schedules.

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadProject, type Project } from "../config.ts";
import type { Io } from "./crons.ts";
import type { FetchLike } from "./metric.ts";

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface DoctorDeps {
  env: NodeJS.ProcessEnv;
  fetch: FetchLike;
  today: () => string;
}

const GITHUB = "https://api.github.com";
const VERCEL = "https://api.vercel.com";
const LINEAR = "https://api.linear.app/graphql";

async function probe(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit,
): Promise<{ ok: boolean; status: number; body: unknown }> {
  try {
    const res = await fetchImpl(url, init);
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    return { ok: res.ok, status: res.status, body };
  } catch (err) {
    return { ok: false, status: 0, body: (err as Error).message };
  }
}

const bearer = (token: string): Record<string, string> => ({
  authorization: `Bearer ${token}`,
  accept: "application/json",
});

export async function doctorChecks(
  project: Project,
  deps: DoctorDeps,
): Promise<DoctorCheck[]> {
  const { config, areas } = project;
  const checks: DoctorCheck[] = [];
  const add = (name: string, ok: boolean, detail: string): void => {
    checks.push({ name, ok, detail });
  };

  const placeholders = [
    ["vercel.projectId", config.vercel.projectId],
    ...areas.map(
      (a) => [`areas.${a.key}.linearProjectId`, a.linearProjectId] as const,
    ),
  ].filter(([, v]) => v.startsWith("PASTE_"));
  add(
    "no placeholders",
    placeholders.length === 0,
    placeholders.length === 0
      ? "project.json and areas.json are filled in"
      : `still the template value: ${placeholders.map(([k]) => k).join(", ")}`,
  );

  const gh = deps.env.GITHUB_TOKEN;
  add(
    "GITHUB_TOKEN",
    !!gh,
    gh ? "set" : "not set — export a token that can read the target repo",
  );
  if (gh) {
    const repo = await probe(deps.fetch, `${GITHUB}/repos/${config.repo}`, {
      headers: bearer(gh),
    });
    add(
      "repo reachable",
      repo.ok,
      repo.ok ? config.repo : `GET /repos/${config.repo} → ${repo.status}`,
    );
    for (const [role, branch] of Object.entries(config.branches)) {
      const r = await probe(
        deps.fetch,
        `${GITHUB}/repos/${config.repo}/branches/${branch}`,
        {
          headers: bearer(gh),
        },
      );
      add(
        `branch ${role}`,
        r.ok,
        r.ok
          ? branch
          : `${branch} not found (${r.status}) — create it from ${config.branches.production}`,
      );
    }
  }

  const vt = deps.env.VERCEL_TOKEN;
  add("VERCEL_TOKEN", !!vt, vt ? "set" : "not set");
  if (vt) {
    const team = config.vercel.teamId
      ? `?teamId=${encodeURIComponent(config.vercel.teamId)}`
      : "";
    const proj = await probe(
      deps.fetch,
      `${VERCEL}/v9/projects/${config.vercel.projectId}${team}`,
      {
        headers: bearer(vt),
      },
    );
    add(
      "Vercel project",
      proj.ok,
      proj.ok
        ? config.vercel.projectId
        : `GET /v9/projects/${config.vercel.projectId} → ${proj.status}`,
    );
    const q = new URLSearchParams({
      projectId: config.vercel.projectId,
      target: "preview",
      limit: "20",
    });
    if (config.vercel.teamId) q.set("teamId", config.vercel.teamId);
    const deps6 = await probe(
      deps.fetch,
      `${VERCEL}/v6/deployments?${q.toString()}`,
      {
        headers: bearer(vt),
      },
    );
    const list = (
      deps6.body as { deployments?: { meta?: Record<string, string> }[] } | null
    )?.deployments;
    const hit = Array.isArray(list)
      ? list.some(
          (d) => d.meta?.githubCommitRef === config.branches.integration,
        )
      : false;
    add(
      `deployment for ${config.branches.integration}`,
      deps6.ok && hit,
      deps6.ok
        ? hit
          ? "found"
          : `none of the last 20 preview deployments is for ${config.branches.integration} — push the branch once with "build all branches" on`
        : `GET /v6/deployments → ${deps6.status}`,
    );
  }

  const lk = deps.env.LINEAR_API_KEY;
  add("LINEAR_API_KEY", !!lk, lk ? "set" : "not set");
  if (lk) {
    for (const area of areas) {
      const r = await probe(deps.fetch, LINEAR, {
        method: "POST",
        headers: { authorization: lk, "content-type": "application/json" },
        body: JSON.stringify({
          query: "query($id: String!) { project(id: $id) { id name } }",
          variables: { id: area.linearProjectId },
        }),
      });
      const name = (r.body as { data?: { project?: { name?: string } } } | null)
        ?.data?.project?.name;
      add(
        `Linear project (${area.key})`,
        r.ok && !!name,
        name ??
          `project id ${area.linearProjectId} did not resolve (${r.status})`,
      );
    }
  }

  for (const secret of [
    config.slackWebhookSecret,
    config.vercel.bypassSecret,
  ]) {
    const set = !!deps.env[secret];
    add(
      `secret ${secret}`,
      set,
      set
        ? "set"
        : "not set in this environment — add it to the hub's Actions secrets",
    );
  }
  return checks;
}

export function renderTable(checks: DoctorCheck[]): string {
  const width = Math.max(...checks.map((c) => c.name.length));
  return checks
    .map(
      (c) => `${c.ok ? "PASS" : "FAIL"}  ${c.name.padEnd(width)}  ${c.detail}`,
    )
    .join("\n");
}

/** rewrites project.json with `verified` set, keeping every other key and order */
export function stampVerified(dir: string, date: string): void {
  const file = join(dir, "project.json");
  const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  raw.verified = date;
  writeFileSync(file, JSON.stringify(raw, null, 2) + "\n");
}

export async function runDoctor(
  root: string,
  args: string[],
  io: Io,
  deps: DoctorDeps = {
    env: process.env,
    fetch,
    today: () => new Date().toISOString().slice(0, 10),
  },
): Promise<number> {
  const name = args[0];
  if (!name || name.startsWith("-")) {
    io.error("usage: gremlins doctor <name>");
    return 1;
  }
  const project = loadProject(root, name);
  const checks = await doctorChecks(project, deps);
  io.log(renderTable(checks));
  const failed = checks.filter((c) => !c.ok);
  if (failed.length > 0) {
    io.error(
      `${failed.length} check(s) failed — fix them and run \`gremlins doctor ${name}\` again; for local .env credentials use \`gremlins --env-file .env doctor ${name}\``,
    );
    return 1;
  }
  const date = deps.today();
  stampVerified(project.dir, date);
  io.log(
    `all checks passed — projects/${name}/project.json now has "verified": "${date}"`,
  );
  io.log(
    "Run `npx tsx src/cli.ts crons write` and commit to enable this project's PM schedules.",
  );
  return 0;
}
