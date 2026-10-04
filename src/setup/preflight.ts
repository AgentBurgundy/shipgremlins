import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { loadHub, loadProject } from "../config.ts";
import { validateName } from "./files.ts";

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
  const secretNames = new Set([
    "GITHUB_TOKEN",
    "LINEAR_API_KEY",
    "VERCEL_TOKEN",
  ]);
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
    const required = tool === "git" || tool === "npm";
    add(
      tool,
      result.available ? "pass" : required ? "fail" : "warn",
      result.available
        ? `${tool} installed${result.version ? ` (${result.version})` : ""}.`
        : `${tool} unavailable${required ? "; required for local checkout/setup" : tool === "docker" ? "; optional for container hosting" : "; needed on an agent runner, optional on this machine"}.`,
    );
  }
  try {
    const hub = loadHub(root);
    add("hub", "pass", "hub.json is valid.");
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
      "Runner registration and capacity need live verification; local configuration does not prove an online worker.",
    );
  } catch {
    add(
      "hub",
      "fail",
      "hub.json is missing or invalid. Run hub setup init with --hub-repo, or repair the file.",
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
      "No projects configured. Run hub setup init --project NAME --repo owner/app.",
    );
  for (const name of names) {
    try {
      validateName(name, "project");
      const project = loadProject(root, name);
      add(`project:${name}`, "pass", "Project configuration is valid.");
      secretNames.add(project.config.slackWebhookSecret);
      secretNames.add(project.config.vercel.bypassSecret);
      if (project.config.signIn)
        secretNames.add(project.config.signIn.databaseUrlSecret);
      const placeholders =
        project.config.vercel.projectId.startsWith("PASTE_") ||
        project.areas.some((area) => area.linearProjectId.startsWith("PASTE_"));
      add(
        `connections:${name}`,
        placeholders ? "fail" : "pass",
        placeholders
          ? "Replace Vercel/Linear placeholders in project.json and areas.json."
          : "Provider IDs configured; run hub doctor for live validation.",
      );
      add(
        `verified:${name}`,
        project.config.verified ? "pass" : "warn",
        project.config.verified
          ? "Project previously passed doctor; rerun after connection or branch changes."
          : "Run hub doctor after configuring provider credentials and branches.",
      );
      add(
        `agents:${name}`,
        project.areas.some((area) => area.enabled) ? "pass" : "warn",
        project.areas.some((area) => area.enabled)
          ? "At least one PM is enabled; workflow schedules are managed by hub crons."
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
  const ai = Boolean(deps.env.CLAUDE_CODE_OAUTH_TOKEN?.trim());
  add(
    "ai-runtime",
    ai ? "pass" : "warn",
    ai
      ? "Claude runner credential is present; validity is not checked."
      : "Configure CLAUDE_CODE_OAUTH_TOKEN in GitHub Actions for the current Claude runner. Other model providers are planned.",
  );
  const evidenceConfigured =
    Boolean(deps.env.SHIPGREMLINS_VERIFICATION_FILE?.trim()) &&
    Boolean(deps.env.SHIPGREMLINS_ATTESTATION_PUBLIC_KEY?.trim());
  add(
    "promotion-evidence",
    evidenceConfigured ? "pass" : "warn",
    evidenceConfigured
      ? "Attestation public key and evidence-file path configured; key and evidence validity are checked against the exact candidate at promotion."
      : "Promotions require trusted verification: configure SHIPGREMLINS_VERIFICATION_FILE and SHIPGREMLINS_ATTESTATION_PUBLIC_KEY (Ed25519 public PEM). Keep the private key only in the trusted signer.",
  );
  return {
    version: 1,
    directory: root,
    ready: !checks.some((check) => check.status === "fail"),
    checks,
    secrets,
    capabilities: [
      {
        name: "GitHub + Actions + Vercel",
        status: "implemented",
        detail:
          "Existing integration; each project requires live doctor checks and end-to-end verification.",
      },
      {
        name: "Self-hosted and GCE runners",
        status: "implemented",
        detail:
          "Existing GitHub runner workflows; enrollment, image build, and cloud permissions require operator setup.",
      },
      {
        name: "GitLab + CI + Railway",
        status: "planned",
        detail:
          "Adapters and live certification are not implemented. Setup will not create a misleading active configuration.",
      },
      {
        name: "Dashboard connection management",
        status: "planned",
        detail:
          "The local site is a landing page and setup guide; connection secrets remain in environment/CI settings.",
      },
    ],
  };
}
