// Loads hub.json and projects/<name>/{project,areas,tiers}.json and validates
// them by hand (no schema library): every field the dispatcher or a workflow
// reads is checked here, so a typo in config fails hub CI, not a 3am run.

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parsePmCharter, type PmCharter } from "./pmCharter.ts";
import { parseExecutionLimits, type ExecutionLimits } from "./execution.ts";
import {
  ID_RE,
  parseTelemetry,
  type TelemetryConfig,
} from "./telemetry/config.ts";
import {
  parseProjectCapabilities,
  validateWorkerSecretReferences,
  validBranch,
  validConnectionId,
  type ProjectCapabilities,
} from "./projectCapabilities.ts";

export interface HubConfig {
  runners: { mode: "local" | "self-hosted" | "gce"; label: string };
  gce: {
    project: string;
    zone: string;
    image: string;
    machineType: string;
    spot: boolean;
  };
  /** "owner/pm-hub" — where developer.yml is dispatched */
  hubRepo: string;
}

export interface ProjectConfig extends ProjectCapabilities {
  /** Controller-issued incarnation when a deleted project name is reused. */
  instanceId?: string;
  /** Reviewed idea plan that created this project, used for resumable onboarding. */
  ideaPlanId?: string;
  execution?: ExecutionLimits;
  /** The Linear team for this app; existing area project IDs remain authoritative. */
  linear?: {
    teamId?: string;
    workspaceId?: string;
    teamName?: string;
    connectionId?: string;
  };
  telemetry?: TelemetryConfig;
  name: string;
  repo: string;
  /** Omitted in older configurations, where GitHub is the default. */
  provider?: "github" | "gitlab";
  serverUrl?: string;
  branches: { production: string; staging: string; integration: string };
  /** Legacy Vercel configuration. New projects use named environments. */
  vercel?: {
    projectId: string;
    teamId: string | null;
    bypassSecret: string;
    connectionId?: string;
  };
  database: "neon-vercel-integration" | "none";
  slackWebhookSecret: string;
  runnerLabel: string | null;
  mergeMethod: "merge" | "squash" | "rebase";
  commands: {
    install: string;
    test: string;
    lint: string | null;
    typecheck: string | null;
    /** Optional for compatibility; configure for applications with a build step. */
    build?: string | null;
  };
  /** date `hub doctor` last passed; crons are only generated when set */
  verified: string | null;
  /** How the PM signs in on the preview, or null when the app needs no
   *  sign-in. `neon-auth-otp`: `hub signin-code` seeds a one-time code for
   *  `email` in the preview database's neon_auth.verification table (the
   *  project's own test recipe) and the PM types it on `path`. The database
   *  URL comes from the hub secret NAMED here — the preview branch, never
   *  production. */
  signIn: {
    kind: "neon-auth-otp";
    email: string;
    path: string;
    databaseUrlSecret: string;
  } | null;
}

export interface AreaConfig {
  /** Controller-issued identity for a fresh PM that reuses a deleted key. */
  instanceId?: string;
  /** A dashboard-authored mandate, in addition to the versioned mandate.md. */
  mandate?: string;
  /** Structured owner product brief, kept separate from learned observations. */
  charter?: PmCharter;
  /** Optional saved Mixpanel Insights report, scoped to this project's connection. */
  mixpanelReportId?: string;
  key: string;
  name: string;
  /** prefixes inside the target repo this area owns */
  paths: string[];
  sharedTouchpoints: string[];
  linearProjectId: string;
  /** Linear label that marks this area's tickets, e.g. "pm:core" */
  label: string;
  wipLimit: number;
  /** A metric, event name, or product route; charter.metricDefinition explains measurement. */
  metric: string;
  /** 5-field cron in UTC; weekdays by convention */
  schedule: string;
  enabled: boolean;
  memoryBranch: string;
}

export interface TiersConfig {
  ownerOnlyPrefixes: string[];
  hubOwnerOnly: string[];
  alwaysFree: string[];
  guardTests: string[];
  testFileMarkers: string[];
}

export interface Project {
  config: ProjectConfig;
  areas: AreaConfig[];
  tiers: TiersConfig;
  dir: string;
}

export class ConfigError extends Error {
  constructor(
    public readonly file: string,
    message: string,
  ) {
    super(`${file}: ${message}`);
    this.name = "ConfigError";
  }
}

function readJson(file: string): unknown {
  if (!existsSync(file)) throw new ConfigError(file, "missing");
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    throw new ConfigError(file, `invalid JSON — ${(err as Error).message}`);
  }
}

function need<T>(
  file: string,
  obj: Record<string, unknown>,
  key: string,
  check: (v: unknown) => v is T,
  what: string,
): T {
  const v = obj[key];
  if (!check(v)) throw new ConfigError(file, `"${key}" must be ${what}`);
  return v;
}

const isString = (v: unknown): v is string =>
  typeof v === "string" && v.length > 0;
const isStringOrNull = (v: unknown): v is string | null =>
  v === null || isString(v);
const isStringArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((s) => typeof s === "string");
const isBool = (v: unknown): v is boolean => typeof v === "boolean";
const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const isPosInt = (v: unknown): v is number =>
  Number.isInteger(v) && (v as number) > 0;
const oneOf =
  <T extends string>(...vals: T[]) =>
  (v: unknown): v is T =>
    typeof v === "string" && (vals as string[]).includes(v);

const CRON_RE = /^(\S+\s+){4}\S+$/;
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export function validSourceRepository(
  value: unknown,
  provider: string = "github",
): value is string {
  return (
    typeof value === "string" &&
    (provider === "gitlab"
      ? /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+$/
      : REPO_RE
    ).test(value) &&
    !value.split("/").some((part) => part === "." || part === "..")
  );
}

export function validSourceServer(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      url.pathname === "/"
    );
  } catch {
    return false;
  }
}

export function loadHub(root: string): HubConfig {
  const file = join(root, "hub.json");
  const raw = readJson(file);
  if (!isObj(raw)) throw new ConfigError(file, "must be an object");
  const runners = need(file, raw, "runners", isObj, "an object");
  const local = runners.mode === "local";
  const gce =
    local && raw.gce === undefined
      ? {
          project: "",
          zone: "us-central1-a",
          image: "pm-runner",
          machineType: "e2-standard-4",
          spot: false,
        }
      : need(file, raw, "gce", isObj, "an object");
  return {
    hubRepo:
      local && raw.hubRepo === undefined
        ? "local/shipgremlins"
        : need(
            file,
            raw,
            "hubRepo",
            (v): v is string => isString(v) && REPO_RE.test(v),
            '"owner/name"',
          ),
    runners: {
      mode: need(
        file,
        runners,
        "mode",
        oneOf("local", "self-hosted", "gce"),
        '"local", "self-hosted" or "gce"',
      ),
      label:
        local && runners.label === undefined
          ? "local"
          : need(file, runners, "label", isString, "a label"),
    },
    gce: {
      project: typeof gce.project === "string" ? gce.project : "",
      zone: need(file, gce, "zone", isString, "a zone"),
      image: need(file, gce, "image", isString, "an image name"),
      machineType: need(file, gce, "machineType", isString, "a machine type"),
      spot: need(file, gce, "spot", isBool, "true or false"),
    },
  };
}

const SECRET_NAME_RE = /^[A-Z][A-Z0-9_]*$/;

function parseSignIn(pf: string, raw: unknown): ProjectConfig["signIn"] {
  if (raw === undefined || raw === null) return null;
  if (!isObj(raw))
    throw new ConfigError(pf, '"signIn" must be an object or null');
  const kind = need(
    pf,
    raw,
    "kind",
    oneOf("neon-auth-otp"),
    '"neon-auth-otp" (the only sign-in recipe so far)',
  );
  const email = need(
    pf,
    raw,
    "email",
    (v): v is string => isString(v) && /^[^@\s]+@[^@\s]+$/.test(v),
    "the test account's email",
  );
  const path = need(
    pf,
    raw,
    "path",
    (v): v is string => isString(v) && v.startsWith("/"),
    'the sign-in route, e.g. "/sign-in"',
  );
  const databaseUrlSecret = need(
    pf,
    raw,
    "databaseUrlSecret",
    (v): v is string => isString(v) && SECRET_NAME_RE.test(v),
    "the NAME of a hub secret holding the PREVIEW database URL, never a value",
  );
  return { kind, email, path, databaseUrlSecret };
}

export function loadProject(root: string, name: string): Project {
  const dir = join(root, "projects", name);
  const pf = join(dir, "project.json");
  const raw = readJson(pf);
  if (!isObj(raw)) throw new ConfigError(pf, "must be an object");
  let capabilities: ProjectCapabilities;
  try {
    capabilities = parseProjectCapabilities(raw);
  } catch (error) {
    throw new ConfigError(pf, (error as Error).message);
  }
  const workflow =
    capabilities.workflow ??
    (raw.vercel === undefined
      ? { kind: "pull-request" as const, baseBranch: "main" }
      : { kind: "promotion" as const });
  const branches =
    workflow.kind === "pull-request"
      ? {
          production: workflow.baseBranch,
          staging: workflow.baseBranch,
          integration: workflow.baseBranch,
        }
      : need(pf, raw, "branches", isObj, "an object");
  const vercel =
    raw.vercel === undefined
      ? undefined
      : need(pf, raw, "vercel", isObj, "an object");
  const commands = need(pf, raw, "commands", isObj, "an object");
  let telemetry: TelemetryConfig | undefined;
  let execution: ExecutionLimits | undefined;
  try {
    telemetry = parseTelemetry(raw.telemetry);
    execution = parseExecutionLimits(raw.execution);
  } catch (error) {
    throw new ConfigError(pf, (error as Error).message);
  }
  const config: ProjectConfig = {
    ...(raw.ideaPlanId === undefined
      ? {}
      : {
          ideaPlanId: need(
            pf,
            raw,
            "ideaPlanId",
            (value): value is string =>
              typeof value === "string" &&
              /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
                value,
              ),
            "a reviewed idea plan UUID",
          ),
        }),
    ...(raw.instanceId === undefined
      ? {}
      : {
          instanceId: need(
            pf,
            raw,
            "instanceId",
            (value): value is string =>
              typeof value === "string" &&
              /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value),
            "a controller-issued project identity",
          ),
        }),
    ...capabilities,
    ...(raw.vercel === undefined && capabilities.workflow === undefined
      ? { workflow }
      : {}),
    ...(telemetry ? { telemetry } : {}),
    ...(execution ? { execution } : {}),
    name,
    provider:
      raw.provider === undefined
        ? "github"
        : need(
            pf,
            raw,
            "provider",
            oneOf("github", "gitlab"),
            '"github" or "gitlab"',
          ),
    ...(raw.serverUrl === undefined
      ? {}
      : {
          serverUrl: need(
            pf,
            raw,
            "serverUrl",
            validSourceServer,
            "an HTTPS server origin without credentials or a path",
          ),
        }),
    repo: need(
      pf,
      raw,
      "repo",
      (v): v is string =>
        validSourceRepository(
          v,
          typeof raw.provider === "string" ? raw.provider : "github",
        ),
      '"owner/name"',
    ),
    branches: {
      production: need(
        pf,
        branches,
        "production",
        validBranch,
        "a valid branch",
      ),
      staging: need(pf, branches, "staging", validBranch, "a valid branch"),
      integration: need(
        pf,
        branches,
        "integration",
        validBranch,
        "a valid branch",
      ),
    },
    ...(vercel
      ? {
          vercel: {
            ...(vercel.connectionId === undefined
              ? {}
              : {
                  connectionId: need(
                    pf,
                    vercel,
                    "connectionId",
                    validConnectionId,
                    "a saved account ID",
                  ),
                }),
            projectId: need(
              pf,
              vercel,
              "projectId",
              isString,
              "a Vercel project id",
            ),
            teamId: need(
              pf,
              vercel,
              "teamId",
              isStringOrNull,
              "a team id or null",
            ),
            bypassSecret: need(
              pf,
              vercel,
              "bypassSecret",
              isString,
              "the NAME of a hub secret",
            ),
          },
        }
      : {}),
    database:
      raw.database === undefined
        ? "none"
        : need(
            pf,
            raw,
            "database",
            oneOf("neon-vercel-integration", "none"),
            '"neon-vercel-integration" or "none"',
          ),
    slackWebhookSecret: need(
      pf,
      raw,
      "slackWebhookSecret",
      isString,
      "the NAME of a hub secret",
    ),
    runnerLabel: need(
      pf,
      raw,
      "runnerLabel",
      isStringOrNull,
      "a label or null",
    ),
    mergeMethod: need(
      pf,
      raw,
      "mergeMethod",
      oneOf("merge", "squash", "rebase"),
      '"merge", "squash" or "rebase"',
    ),
    commands: {
      install: need(pf, commands, "install", isString, "a command"),
      test: need(pf, commands, "test", isString, "a command"),
      lint: need(pf, commands, "lint", isStringOrNull, "a command or null"),
      typecheck: need(
        pf,
        commands,
        "typecheck",
        isStringOrNull,
        "a command or null",
      ),
      build:
        commands.build === undefined
          ? null
          : need(pf, commands, "build", isStringOrNull, "a command or null"),
    },
    verified: need(pf, raw, "verified", isStringOrNull, "a date or null"),
    signIn: parseSignIn(pf, raw.signIn),
    ...(raw.linear === undefined
      ? {}
      : { linear: parseLinearMapping(pf, raw.linear) }),
  };
  const set = new Set(Object.values(config.branches));
  if (workflow.kind === "promotion" && set.size !== 3)
    throw new ConfigError(
      pf,
      "production, staging and integration branches must differ",
    );
  for (const k of ["bypassSecret", "slackWebhookSecret"] as const) {
    const v =
      k === "bypassSecret"
        ? config.vercel?.bypassSecret
        : config.slackWebhookSecret;
    if (v === undefined) continue;
    if (!/^[A-Z][A-Z0-9_]*$/.test(v))
      throw new ConfigError(
        pf,
        `"${k}" must be a SECRET NAME like SLACK_WEBHOOK_${name.toUpperCase()}, never a value`,
      );
  }
  try {
    validateWorkerSecretReferences(config);
  } catch (error) {
    throw new ConfigError(pf, (error as Error).message);
  }

  const af = join(dir, "areas.json");
  const rawAreas = readJson(af);
  if (!isObj(rawAreas) || !isObj(rawAreas.areas))
    throw new ConfigError(af, 'must be { "areas": { <key>: {...} } }');
  const areas: AreaConfig[] = [];
  for (const [key, a] of Object.entries(rawAreas.areas)) {
    if (!isObj(a)) throw new ConfigError(af, `area "${key}" must be an object`);
    if (!/^[a-z][a-z0-9-]*$/.test(key))
      throw new ConfigError(
        af,
        `area key "${key}" must be lowercase kebab-case`,
      );
    const label = need(af, a, "label", isString, "a Linear label");
    if (label !== `pm:${key}`)
      throw new ConfigError(af, `area "${key}" label must be "pm:${key}"`);
    let charter: PmCharter | undefined;
    if (a.charter !== undefined) {
      try {
        charter = parsePmCharter(a.charter);
      } catch {
        throw new ConfigError(af, "PM charter fields are invalid or too large");
      }
    }
    const instanceId =
      a.instanceId === undefined
        ? config.instanceId
        : need(
            af,
            a,
            "instanceId",
            (v): v is string =>
              typeof v === "string" &&
              /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(
                v,
              ),
            "a controller-issued PM instance UUID",
          );
    areas.push({
      ...(instanceId ? { instanceId } : {}),
      ...(charter ? { charter } : {}),
      ...(a.mixpanelReportId === undefined
        ? {}
        : {
            mixpanelReportId: need(
              af,
              a,
              "mixpanelReportId",
              (v): v is string =>
                isString(v) && ID_RE.test(v) && !!telemetry?.mixpanel,
              "a positive numeric report ID string with telemetry.mixpanel configured",
            ),
          }),
      key,
      ...(a.mandate === undefined
        ? {}
        : {
            mandate: need(
              af,
              a,
              "mandate",
              (v): v is string => isString(v) && v.length <= 12000,
              "a mandate of 1–12000 characters",
            ),
          }),
      name: need(af, a, "name", isString, "a name"),
      paths: need(af, a, "paths", isStringArray, "an array of path prefixes"),
      sharedTouchpoints: need(
        af,
        a,
        "sharedTouchpoints",
        isStringArray,
        "an array",
      ),
      linearProjectId: need(
        af,
        a,
        "linearProjectId",
        isString,
        "a Linear project id",
      ),
      label,
      wipLimit: need(af, a, "wipLimit", isPosInt, "a positive integer"),
      metric: need(
        af,
        a,
        "metric",
        isString,
        "a metric, event name, or product route",
      ),
      schedule: need(
        af,
        a,
        "schedule",
        (v): v is string => isString(v) && CRON_RE.test(v),
        "a 5-field cron",
      ),
      enabled: need(af, a, "enabled", isBool, "true or false"),
      memoryBranch: `pm/${name}/${key}${instanceId ? `/${instanceId}` : ""}`,
    });
  }

  const tf = join(dir, "tiers.json");
  const rawTiers = readJson(tf);
  if (!isObj(rawTiers)) throw new ConfigError(tf, "must be an object");
  const tiers: TiersConfig = {
    ownerOnlyPrefixes: need(
      tf,
      rawTiers,
      "ownerOnlyPrefixes",
      isStringArray,
      "an array",
    ),
    hubOwnerOnly: need(tf, rawTiers, "hubOwnerOnly", isStringArray, "an array"),
    alwaysFree: need(tf, rawTiers, "alwaysFree", isStringArray, "an array"),
    guardTests: need(tf, rawTiers, "guardTests", isStringArray, "an array"),
    testFileMarkers: need(
      tf,
      rawTiers,
      "testFileMarkers",
      isStringArray,
      "an array",
    ),
  };

  return { config, areas, tiers, dir };
}

function parseLinearMapping(
  file: string,
  value: unknown,
): NonNullable<ProjectConfig["linear"]> {
  if (!isObj(value)) throw new ConfigError(file, '"linear" must be an object');
  const id = (v: unknown): v is string =>
    typeof v === "string" &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(
      v,
    );
  if (value.teamId === undefined && !validConnectionId(value.connectionId))
    throw new ConfigError(
      file,
      '"linear" needs a teamId or saved connectionId',
    );
  return {
    ...(value.teamId === undefined
      ? {}
      : { teamId: need(file, value, "teamId", id, "a Linear team UUID") }),
    ...(value.connectionId === undefined
      ? {}
      : {
          connectionId: need(
            file,
            value,
            "connectionId",
            validConnectionId,
            "a saved account ID",
          ),
        }),
    ...(value.workspaceId === undefined
      ? {}
      : {
          workspaceId: need(
            file,
            value,
            "workspaceId",
            id,
            "a Linear workspace UUID",
          ),
        }),
    ...(value.teamName === undefined
      ? {}
      : {
          teamName: need(
            file,
            value,
            "teamName",
            (v): v is string => isString(v) && v.length <= 255,
            "a team name of 1–255 characters",
          ),
        }),
  };
}

/** every directory under projects/ except _templates */
export function listProjectNames(root: string): string[] {
  const dir = join(root, "projects");
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith("_"))
    .map((d) => d.name)
    .sort();
}

export function loadAllProjects(root: string): Project[] {
  return listProjectNames(root).map((n) => loadProject(root, n));
}

/** true when `path` starts with any prefix; a prefix containing "*" matches as a glob fragment */
export function matchesPrefix(path: string, prefixes: string[]): boolean {
  return prefixes.some((p) => {
    if (p.includes("*")) {
      const re = new RegExp(
        "^" +
          p
            .split("*")
            .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
            .join(".*"),
      );
      return re.test(path);
    }
    return path.startsWith(p);
  });
}
