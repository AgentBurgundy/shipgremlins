// `hub doctor <name>` — checks the add-project checklist against the live
// APIs and, when everything passes, stamps `verified` into project.json so
// `hub crons` starts generating this project's PM schedules.

import { readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { loadProject, type Project } from "../config.ts";
import type { Io } from "./crons.ts";
import type { FetchLike } from "./metric.ts";
import { readLogs, readMixpanel } from "../telemetry/read.ts";
import { createSourceControl } from "../sourceControl/index.ts";
import {
  SourceControlError,
  type SourceControl,
} from "../sourceControl/types.ts";
import {
  createLinearConnection,
  type LinearConnection,
} from "../linearConnection/index.ts";
import {
  createVercelConnection,
  type VercelConnection,
} from "../vercelConnection/index.ts";
import { OAuthConnectionError } from "../oauthConnection/types.ts";
import {
  effectiveVerification,
  effectiveWorkflow,
  inspectionBranch,
} from "../projectCapabilities.ts";
import { resolveEnvironment } from "../hosting/index.ts";
import { controllerPreviewFetch } from "../hosting/controllerProbe.ts";
import { assertBrowserSecretSafety } from "../setup/credentialScope.ts";
import { assertNoSymlinks } from "../setup/files.ts";
import { environmentVerificationStatus } from "../setup/environmentAccess.ts";

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface DoctorDeps {
  /** Real CLI/dashboard calls supply the full workspace for cross-project credential checks. */
  root?: string;
  env: NodeJS.ProcessEnv;
  fetch: FetchLike;
  today: () => string;
  sourceControl?: Pick<SourceControl, "resolveCredential">;
  linearConnection?: Pick<LinearConnection, "resolveCredential">;
  linearConnectionFor?: (
    connectionId?: string,
  ) => Pick<LinearConnection, "resolveCredential">;
  vercelConnection?: Pick<VercelConnection, "resolveCredential">;
  vercelConnectionFor?: (
    connectionId?: string,
  ) => Pick<VercelConnection, "resolveCredential">;
  resolveEnvironment?: typeof resolveEnvironment;
}

const GITHUB = "https://api.github.com";
const LINEAR = "https://api.linear.app/graphql";

async function probe(
  fetchImpl: FetchLike,
  url: string,
  init: RequestInit,
): Promise<{ ok: boolean; status: number; body: unknown }> {
  try {
    const res = await fetchImpl(url, {
      ...init,
      signal: init.signal ?? AbortSignal.timeout(10_000),
      redirect: "error",
    });
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

async function reachable(
  url: string,
  fetcher: FetchLike,
  bypass?: string,
): Promise<boolean> {
  const first = new URL(url);
  const signal = AbortSignal.timeout(10_000);
  let current = first;
  for (let redirects = 0; redirects <= 3; redirects++) {
    if (
      !["http:", "https:"].includes(current.protocol) ||
      current.username ||
      current.password ||
      (first.protocol === "https:" && current.protocol !== "https:")
    )
      return false;
    const headers: Record<string, string> = {};
    if (bypass && current.origin === first.origin)
      headers["x-vercel-protection-bypass"] = bypass;
    const probeFetch =
      fetcher === globalThis.fetch ? controllerPreviewFetch : fetcher;
    const response = await probeFetch(current.href, {
      method: "GET",
      redirect: "manual",
      signal,
      headers,
    });
    await response.body?.cancel();
    if (response.ok) return true;
    if (![301, 302, 303, 307, 308].includes(response.status)) return false;
    const location = response.headers.get("location");
    if (!location || redirects === 3) return false;
    current = new URL(location, current);
  }
  return false;
}

export async function doctorChecks(
  project: Project,
  deps: DoctorDeps,
): Promise<DoctorCheck[]> {
  const { config, areas } = project;
  const verification = effectiveVerification(config);
  const workflow = effectiveWorkflow(config);
  const checks: DoctorCheck[] = [];
  const add = (name: string, ok: boolean, detail: string): void => {
    checks.push({ name, ok, detail });
  };

  try {
    assertBrowserSecretSafety(config, deps.root);
  } catch {
    add(
      "browser credential safety",
      false,
      "Preview and sign-in credentials must be separate from every project's hosting and telemetry connections. Check configuration and use dedicated browser credentials.",
    );
    return checks;
  }

  const placeholders = [
    ...(verification.mode === "browser" && verification.target.kind === "vercel"
      ? [["verification.projectId", verification.target.projectId] as const]
      : []),
    ...areas
      .filter((a) => a.enabled !== false)
      .map(
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

  const gitlab = config.provider === "gitlab";
  const tokenName = gitlab ? "GITLAB_TOKEN" : "GITHUB_TOKEN";
  let gh = deps.env[tokenName];
  let sourceDetail = gh
    ? "set"
    : "not set — connect source control in gremlins setup or save an advanced token";
  if (deps.sourceControl) {
    try {
      const credential = await deps.sourceControl.resolveCredential({
        provider: gitlab ? "gitlab" : "github",
        repository: config.repo,
        serverUrl: config.serverUrl,
        minValidityMs: 5 * 60_000,
        write: true,
      });
      gh = credential.token;
      sourceDetail =
        credential.method === "oauth"
          ? "connected with the official app"
          : "advanced token configured";
    } catch (error) {
      gh = undefined;
      sourceDetail =
        error instanceof SourceControlError &&
        ["refresh_blocked", "busy"].includes(error.code)
          ? "waiting for active jobs before refreshing; retry verification when they finish"
          : "source access could not be verified — reconnect the provider or check repository access in gremlins setup";
    }
  }
  const repoApi = gitlab
    ? `${(config.serverUrl ?? "https://gitlab.com").replace(/\/$/, "")}/api/v4/projects/${encodeURIComponent(config.repo)}`
    : `${GITHUB}/repos/${config.repo}`;
  add(tokenName, !!gh, sourceDetail);
  if (gh) {
    const repo = await probe(deps.fetch, repoApi, {
      headers: bearer(gh),
    });
    add(
      "repo reachable",
      repo.ok,
      repo.ok ? config.repo : `GET /repos/${config.repo} → ${repo.status}`,
    );
    const branches =
      workflow.kind === "pull-request"
        ? [["base", workflow.baseBranch]]
        : Object.entries(config.branches);
    if (
      verification.mode === "browser" &&
      !branches.some(([, branch]) => branch === inspectionBranch(config))
    )
      branches.push(["verification", inspectionBranch(config)]);
    for (const [role, branch] of branches as Array<[string, string]>) {
      const r = await probe(
        deps.fetch,
        `${repoApi}/${gitlab ? "repository/" : ""}branches/${encodeURIComponent(branch)}`,
        {
          headers: bearer(gh),
        },
      );
      add(
        `branch ${role}`,
        r.ok,
        r.ok
          ? branch
          : `${branch} not found (${r.status}) — choose an existing branch in project settings`,
      );
    }
  }

  if (verification.mode === "browser") {
    try {
      if (verification.target.kind === "docker") {
        const check = deps.root
          ? environmentVerificationStatus(deps.root, project, deps.env)
          : undefined;
        add(
          "browser environment",
          check?.status === "passed",
          check?.status === "passed"
            ? "Docker environment passed its browser setup test. Each run starts and checks a fresh isolated app."
            : "Open this project's Environment page and Test environment before running PMs. Docker and required test inputs must be available on its worker.",
        );
      } else {
        const environment = await (
          deps.resolveEnvironment ?? resolveEnvironment
        )(verification.target, {
          env: deps.env,
          fetch: deps.fetch,
          vercelConnection: deps.vercelConnection,
          vercelConnectionFor:
            deps.vercelConnectionFor ??
            (deps.root
              ? (connectionId) =>
                  ((!connectionId || connectionId === "default") &&
                    deps.vercelConnection) ||
                  createVercelConnection({
                    root: deps.root!,
                    env: deps.env,
                    fetch: deps.fetch as typeof fetch,
                    connectionId,
                  })
              : undefined),
          branch: inspectionBranch(config),
        });
        const bypass =
          verification.target.kind === "vercel" &&
          verification.target.bypassSecret
            ? deps.env[verification.target.bypassSecret]
            : undefined;
        const available = await reachable(environment.url, deps.fetch, bypass);
        add(
          "browser environment",
          available,
          available
            ? `Selected ${verification.target.kind} environment responds over HTTP; the worker still verifies browser behavior.`
            : "The selected environment did not respond successfully. Check its access settings, protection bypass, and network reachability.",
        );
      }
    } catch {
      add(
        "browser environment",
        false,
        "The selected environment is not ready or accessible. Check its settings and controller credentials.",
      );
    }
  } else
    add(
      "verification mode",
      true,
      "Repository review: code, documentation, and tests; no hosted application required.",
    );

  let lk = deps.env.LINEAR_API_KEY;
  let linearDetail = lk ? "set" : "not set — connect Linear in gremlins setup";
  if (
    deps.linearConnection ||
    deps.linearConnectionFor ||
    config.linear?.connectionId
  ) {
    try {
      const connectionId = config.linear?.connectionId;
      const connection =
        deps.linearConnectionFor?.(connectionId) ??
        (!connectionId || connectionId === "default"
          ? deps.linearConnection
          : undefined) ??
        (deps.root
          ? createLinearConnection({
              root: deps.root,
              env: deps.env,
              fetch: deps.fetch as typeof fetch,
              connectionId,
            })
          : undefined);
      if (!connection)
        throw new Error("The selected Linear account is unavailable.");
      const credential = await connection.resolveCredential({
        minValidityMs: 5 * 60_000,
        workspaceId: config.linear?.workspaceId,
      });
      lk = credential.authorization;
      linearDetail =
        credential.method === "oauth"
          ? "connected with Linear OAuth"
          : "advanced API key configured";
    } catch (error) {
      lk = undefined;
      linearDetail =
        error instanceof OAuthConnectionError &&
        ["refresh_blocked", "busy"].includes(error.code)
          ? "waiting for active jobs before refreshing; retry verification when they finish"
          : "Linear access could not be verified — reconnect Linear in gremlins setup";
    }
  }
  add("LINEAR_API_KEY", !!lk, linearDetail);
  if (lk) {
    for (const area of areas) {
      if (area.enabled === false && area.linearProjectId.startsWith("PASTE_"))
        continue;
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

  const browserSecrets =
    verification.mode === "browser"
      ? [
          verification.target.kind === "vercel"
            ? verification.target.bypassSecret
            : undefined,
          config.signIn?.databaseUrlSecret,
        ].filter((secret): secret is string => !!secret)
      : [];
  for (const secret of browserSecrets) {
    const set = !!deps.env[secret];
    add(
      `secret ${secret}`,
      set,
      set
        ? "set"
        : "not set in this environment — configure this project's connection on the controller",
    );
  }
  const signals = await readLogs(config, deps, { limit: 1, hours: 1 });
  for (const signal of signals.filter(
    (signal) => signal.status !== "not-configured",
  ))
    add(
      `${signal.provider} ${signal.kind}`,
      signal.status === "ok",
      signal.detail ??
        "Project-scoped read succeeded (an empty result is valid).",
    );
  if (config.telemetry?.mixpanel) {
    const reports = areas.filter((area) => area.mixpanelReportId);
    if (!reports.length)
      add(
        "Mixpanel reports",
        false,
        "Set mixpanelReportId on at least one area.",
      );
    for (const area of reports) {
      const signal = await readMixpanel(config, area, deps);
      add(
        `Mixpanel (${area.key})`,
        signal.status === "ok",
        signal.detail ?? "Configured Insights report is readable.",
      );
    }
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

const VERIFICATION_FILES = [
  "project.json",
  "areas.json",
  "tiers.json",
] as const;
export type VerificationSnapshot = Record<
  (typeof VERIFICATION_FILES)[number],
  string
>;
export class VerificationConflictError extends Error {
  constructor() {
    super(
      "Project settings changed during verification. Run verification again before starting jobs.",
    );
    this.name = "VerificationConflictError";
  }
}

export function verificationSnapshot(dir: string): VerificationSnapshot {
  return Object.fromEntries(
    VERIFICATION_FILES.map((name) => {
      const path = join(dir, name);
      assertNoSymlinks(path);
      return [
        name,
        createHash("sha256").update(readFileSync(path)).digest("hex"),
      ];
    }),
  ) as VerificationSnapshot;
}

function assertVerificationSnapshot(
  dir: string,
  expected?: VerificationSnapshot,
): void {
  if (!expected) return;
  try {
    const current = verificationSnapshot(dir);
    if (VERIFICATION_FILES.every((name) => current[name] === expected[name]))
      return;
  } catch {
    /* Deleted or replaced files also invalidate the checked snapshot. */
  }
  throw new VerificationConflictError();
}

/** Atomically stamps only the same project, area, and policy bytes that were checked. */
export function stampVerified(
  dir: string,
  date: string,
  expected?: VerificationSnapshot,
): void {
  assertVerificationSnapshot(dir, expected);
  const file = join(dir, "project.json");
  assertNoSymlinks(file);
  const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  raw.verified = date;
  const temporary = join(dir, `.verification-${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, JSON.stringify(raw, null, 2) + "\n", {
      flag: "wx",
      mode: 0o600,
    });
    assertVerificationSnapshot(dir, expected);
    renameSync(temporary, file);
  } finally {
    try {
      unlinkSync(temporary);
    } catch {
      /* Already renamed or never created. */
    }
  }
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
  const snapshot = verificationSnapshot(project.dir);
  const sourceControl =
    deps.sourceControl ??
    createSourceControl({
      root,
      env: deps.env,
      fetch: (url, init) =>
        deps.fetch(
          typeof url === "string"
            ? url
            : url instanceof URL
              ? url.href
              : url.url,
          init,
        ),
    });
  const connectionOptions = {
    root,
    env: deps.env,
    fetch: ((url: string | URL | Request, init?: RequestInit) =>
      deps.fetch(
        typeof url === "string" ? url : url instanceof URL ? url.href : url.url,
        init,
      )) as typeof fetch,
  };
  const linearConnection =
    deps.linearConnection ?? createLinearConnection(connectionOptions);
  const vercelConnection =
    deps.vercelConnection ?? createVercelConnection(connectionOptions);
  const checks = await doctorChecks(project, {
    ...deps,
    root,
    sourceControl,
    linearConnection,
    vercelConnection,
  });
  io.log(renderTable(checks));
  const failed = checks.filter((c) => !c.ok);
  if (failed.length > 0) {
    io.error(
      `${failed.length} check(s) failed — fix them and run \`gremlins doctor ${name}\` again; for local .env credentials use \`gremlins --env-file .env doctor ${name}\``,
    );
    return 1;
  }
  const date = deps.today();
  try {
    stampVerified(project.dir, date, snapshot);
  } catch (error) {
    if (!(error instanceof VerificationConflictError)) throw error;
    io.error(error.message);
    return 1;
  }
  io.log(
    `all checks passed — projects/${name}/project.json now has "verified": "${date}"`,
  );
  io.log(
    "Review and enable the PM area, then create a Docker worker in gremlins setup. Existing CI workspaces use gremlins crons write.",
  );
  return 0;
}
