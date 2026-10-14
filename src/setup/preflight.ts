import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { loadHub, loadProject } from "../config.ts";
import { telemetrySecrets } from "../telemetry/config.ts";
import { isExampleHub, validateName } from "./files.ts";
import type { SourceStatus } from "../sourceControl/types.ts";
import type { OAuthStatus } from "../oauthConnection/types.ts";
import {
  effectiveVerification,
  effectiveWorkflow,
} from "../projectCapabilities.ts";

export type Tool = "git" | "npm" | "docker" | "claude" | "gcloud";
export interface ToolResult {
  available: boolean;
  version?: string;
}
export interface SetupCheck {
  id: string;
  status: "pass" | "warn" | "fail";
  detail: string;
}
export interface SetupReport {
  version: 1;
  directory: string;
  ready: boolean;
  checks: SetupCheck[];
  secrets: { name: string; present: boolean }[];
  capabilities: {
    name: string;
    status: "implemented" | "planned";
    detail: string;
  }[];
}
export interface PreflightDeps {
  env: NodeJS.ProcessEnv;
  nodeVersion?: string;
  probe?: (tool: Tool) => ToolResult;
  sourceConnections?: Pick<
    SourceStatus,
    "provider" | "serverUrl" | "connected" | "method" | "needsReconnect"
  >[];
  oauthConnections?: (Pick<
    OAuthStatus,
    "provider" | "connected" | "method" | "needsReconnect"
  > & { id?: string; connectionId?: string })[];
}

/** Commands are fixed, bounded and read-only. Tool output is reduced to a version, never echoed. */
export function probeTool(tool: Tool): ToolResult {
  const allowed: readonly string[] = [
    "git",
    "npm",
    "docker",
    "claude",
    "gcloud",
  ];
  if (!allowed.includes(tool)) return { available: false };
  const result = spawnSync(tool, ["--version"], {
    timeout: 5000,
    maxBuffer: 16_384,
    windowsHide: true,
    shell: process.platform === "win32",
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error || result.status !== 0) return { available: false };
  const version = result.stdout.match(/\b\d+\.\d+(?:\.\d+)?\b/)?.[0];
  return { available: true, ...(version ? { version } : {}) };
}

export function inspectSetup(
  root: string,
  deps: PreflightDeps,
  selectedProject?: string,
): SetupReport {
  if (selectedProject) validateName(selectedProject, "project");
  const checks: SetupCheck[] = [];
  const secretNames = new Set<string>();
  const oauthAccounts = new Map<
    string,
    { provider: "linear" | "vercel"; id: string }
  >();
  const requireAccount = (provider: "linear" | "vercel", id = "default") =>
    oauthAccounts.set(`${provider}:${id}`, { provider, id });
  let requiresPromotion = false;
  const add = (
    id: string,
    status: SetupCheck["status"],
    detail: string,
  ): void => {
    checks.push({ id, status, detail });
  };
  const nodeVersion = deps.nodeVersion ?? process.versions.node;
  const parsed = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(nodeVersion);
  const major = Number(parsed?.[1]);
  const minor = Number(parsed?.[2]);
  const supportedNode = major > 22 || (major === 22 && minor >= 12);
  add(
    "node",
    parsed && supportedNode ? "pass" : "fail",
    `Node.js ${parsed ? `${major}.${minor}.${parsed[3]}` : "unknown"}; version 22.12 or newer is required.`,
  );
  const probe = deps.probe ?? probeTool;
  for (const tool of ["git", "npm", "docker", "claude"] as const) {
    const result = probe(tool);
    const required = tool === "git" || tool === "npm" || tool === "docker";
    add(
      tool,
      result.available ? "pass" : required ? "fail" : "warn",
      result.available
        ? `${tool} installed${result.version ? ` (${result.version})` : ""}.`
        : `${tool} unavailable${tool === "docker" ? "; required for local workers; start Docker Engine or Docker Desktop (Linux containers)" : required ? "; required for local checkout/setup" : "; installed inside the worker image, optional on this machine"}.`,
    );
  }
  try {
    const hub = loadHub(root);
    add("hub", "pass", "hub.json is valid.");
    if (hub.runners.mode !== "local" && isExampleHub(root))
      add(
        "hub-repository",
        "warn",
        "hub.json is a public example. Setup reuses its saved repository and checks it against Git origin. If you forked the project, set hubRepo to your fork before initializing. --repo is the app repository.",
      );
    if (hub.runners.mode === "gce") {
      const gcloud = probe("gcloud");
      add(
        "gce-config",
        hub.gce.project ? "pass" : "fail",
        hub.gce.project
          ? "GCP project configured; cloud permissions are checked by the runner workflow."
          : "Set gce.project in hub.json before using GCE runners.",
      );
      add(
        "gcloud",
        gcloud.available ? "pass" : "warn",
        gcloud.available
          ? "gcloud installed; cloud authorization not checked."
          : "gcloud unavailable locally; required on the GCE provisioning host.",
      );
    }
    add(
      "runner-enrollment",
      "warn",
      hub.runners.mode === "local"
        ? "Create a local Docker worker in the dashboard. Ready requires a real Chromium screenshot check; no CI registration is needed."
        : "Runner registration and capacity need live verification; local configuration does not prove an online worker.",
    );
  } catch {
    add(
      "hub",
      "fail",
      "hub.json is missing or invalid. Run gremlins setup init --project my-app --repo your-org/my-app, or repair the existing file.",
    );
  }
  const projectsDir = join(root, "projects");
  const names = selectedProject
    ? [selectedProject]
    : existsSync(projectsDir)
      ? readdirSync(projectsDir, { withFileTypes: true })
          .filter((item) => item.isDirectory() && !item.name.startsWith("_"))
          .map((item) => item.name)
          .sort()
      : [];
  if (names.length === 0)
    add(
      "projects",
      "fail",
      "No projects configured. Open gremlins setup or run gremlins setup init --project my-app --repo your-org/my-app. Use a lowercase project ID such as my-app, not a domain.",
    );
  if (names.length === 0) requireAccount("linear");
  if (
    names.length === 0 &&
    !deps.sourceConnections?.some(
      (source) =>
        source.method === "oauth" && source.connected && !source.needsReconnect,
    )
  )
    secretNames.add("GITHUB_TOKEN");
  for (const name of names) {
    try {
      validateName(name, "project");
      const project = loadProject(root, name);
      requireAccount("linear", project.config.linear?.connectionId);
      const verification = effectiveVerification(project.config);
      requiresPromotion ||=
        effectiveWorkflow(project.config).kind === "promotion";
      const provider = project.config.provider ?? "github";
      const serverUrl =
        provider === "github"
          ? "https://github.com"
          : (project.config.serverUrl ?? "https://gitlab.com");
      const oauth = deps.sourceConnections?.find(
        (connection) =>
          connection.provider === provider &&
          connection.serverUrl.replace(/\/$/, "") ===
            serverUrl.replace(/\/$/, "") &&
          connection.method === "oauth",
      );
      if (oauth)
        add(
          `source:${name}`,
          oauth.connected && !oauth.needsReconnect ? "pass" : "fail",
          oauth.connected && !oauth.needsReconnect
            ? "Official source-control connection is saved; doctor checks live repository access."
            : "Reconnect source control in the dashboard; the saved app authorization needs attention.",
        );
      else
        secretNames.add(
          provider === "gitlab" ? "GITLAB_TOKEN" : "GITHUB_TOKEN",
        );
      add(`project:${name}`, "pass", "Project configuration is valid.");
      if (verification.mode === "browser") {
        const target = verification.target;
        if (target.kind === "vercel") {
          requireAccount("vercel", target.connectionId);
          if (target.bypassSecret) secretNames.add(target.bypassSecret);
        }
        if (target.kind === "railway")
          secretNames.add(target.tokenSecret ?? "RAILWAY_TOKEN");
        if (target.kind === "cloud-run") {
          if (target.credentialsSecret || deps.env.GCP_SERVICE_ACCOUNT_JSON)
            secretNames.add(
              target.credentialsSecret ?? "GCP_SERVICE_ACCOUNT_JSON",
            );
          else
            add(
              `cloud-run:${name}`,
              "warn",
              "Cloud Run uses controller application-default credentials; doctor checks access to the selected service.",
            );
        }
      }
      for (const secret of telemetrySecrets(project.config.telemetry))
        secretNames.add(secret.name);
      if (verification.mode === "browser" && project.config.signIn)
        secretNames.add(project.config.signIn.databaseUrlSecret);
      const placeholders =
        (verification.mode === "browser" &&
          Object.values(verification.target).some(
            (value) => typeof value === "string" && value.startsWith("PASTE_"),
          )) ||
        project.areas.some(
          (area) => area.enabled && area.linearProjectId.startsWith("PASTE_"),
        );
      add(
        `connections:${name}`,
        placeholders ? "fail" : "pass",
        placeholders
          ? "Replace selected environment/Linear placeholders in project.json and areas.json."
          : `Provider IDs configured; run gremlins doctor ${name} for live validation.`,
      );
      add(
        `verified:${name}`,
        project.config.verified ? "pass" : "warn",
        project.config.verified
          ? "Project previously passed doctor; rerun after connection or branch changes."
          : `Run gremlins doctor ${name} after configuring provider credentials and branches.`,
      );
      add(
        `agents:${name}`,
        project.areas.some((area) => area.enabled) ? "pass" : "warn",
        project.areas.some((area) => area.enabled)
          ? "At least one PM is enabled. Local mode follows its UTC schedule while the controller runs; CI mode uses gremlins crons."
          : "PMs are disabled until you review their mandates and enable their areas.",
      );
    } catch {
      add(
        `project:${/^[a-z][a-z0-9-]*$/.test(name) ? name : "invalid-name"}`,
        "fail",
        "Project configuration is missing or invalid; fix it before continuing.",
      );
    }
  }
  for (const { provider, id } of oauthAccounts.values()) {
    const secretName =
      provider === "linear" ? "LINEAR_API_KEY" : "VERCEL_TOKEN";
    const connection = deps.oauthConnections?.find(
      (item) =>
        item.provider === provider &&
        (item.connectionId ?? item.id ?? "default") === id &&
        item.method === "oauth",
    );
    if (connection)
      add(
        `oauth:${provider}${id === "default" ? "" : `:${id}`}`,
        connection.connected && !connection.needsReconnect ? "pass" : "fail",
        connection.connected && !connection.needsReconnect
          ? `${provider === "linear" ? "Linear" : "Vercel"} OAuth is saved; doctor checks live project access.`
          : `Reconnect ${provider === "linear" ? "Linear" : "Vercel"} in the dashboard. The saved OAuth connection needs attention.`,
      );
    else if (id !== "default")
      add(
        `oauth:${provider}:${id}`,
        "fail",
        `Connect the selected ${provider === "linear" ? "Linear" : "Vercel"} account (${id}) in the dashboard. A workspace token does not replace a named account.`,
      );
    else secretNames.add(secretName);
  }
  // Legacy config accepts loose secret references; reject them before any output or lookup.
  const secrets = [...secretNames]
    .filter((name) => /^[A-Z][A-Z0-9_]*$/.test(name))
    .sort()
    .map((name) => ({ name, present: Boolean(deps.env[name]?.trim()) }));
  if (secrets.length !== secretNames.size)
    add(
      "secret-names",
      "fail",
      "Project secret references must be environment-variable names, never credential values.",
    );
  const missing = secrets.filter((secret) => !secret.present);
  add(
    "connections",
    missing.length ? "fail" : "pass",
    missing.length
      ? `Missing environment variables: ${missing.map((secret) => secret.name).join(", ")}.`
      : "Local connection variables are present; credentials have not been sent to providers.",
  );
  if (missing.length)
    add(
      "env-loading",
      "warn",
      "Save supported tokens through gremlins setup. For additional settings or another environment file, run gremlins --env-file .env setup --check. Existing exported environment variables take precedence.",
    );
  const ai = Boolean(deps.env.CLAUDE_CODE_OAUTH_TOKEN?.trim());
  add(
    "ai-runtime",
    ai ? "pass" : "warn",
    ai
      ? "Claude runner credential is present; validity is not checked."
      : "Save CLAUDE_CODE_OAUTH_TOKEN in dashboard Connections for local Claude workers. Other model providers are planned.",
  );
  const evidenceConfigured =
    Boolean(deps.env.SHIPGREMLINS_VERIFICATION_FILE?.trim()) &&
    Boolean(deps.env.SHIPGREMLINS_ATTESTATION_PUBLIC_KEY?.trim());
  if (requiresPromotion)
    add(
      "promotion-evidence",
      "pass",
      evidenceConfigured
        ? "Attestation public key and evidence-file path configured; key and evidence validity are checked against the exact candidate at promotion."
        : "PM browser verification and candidate build checks prepare a combined staging draft. Owner review controls staging and production merges. External candidate attestation is optional.",
    );
  return {
    version: 1,
    directory: root,
    ready: !checks.some((check) => check.status === "fail"),
    checks,
    secrets,
    capabilities: [
      {
        name: "Local Docker workers + GitHub/GitLab + optional browser environments",
        status: "implemented",
        detail:
          "Local queue, UTC schedules, approved-ticket jobs, browser verification and artifacts. Source providers need no CI runner registration. Each project requires live doctor checks.",
      },
      {
        name: "Self-hosted and GCE runners",
        status: "implemented",
        detail:
          "Existing GitHub runner workflows; enrollment, image build, and cloud permissions require operator setup.",
      },
      {
        name: "Vercel, Railway, Cloud Run, and direct test URLs",
        status: "implemented",
        detail:
          "Selected preview/staging environment adapters run on the controller. Credentials and live access still need project-specific verification. GitLab CI enrollment is not implemented.",
      },
      {
        name: "Dashboard connection management",
        status: "implemented",
        detail:
          "Local dashboard stores connection tokens and supplies job-scoped credentials to Docker workers. Saved tokens still need live verification. Legacy CI secrets are configured separately.",
      },
    ],
  };
}
