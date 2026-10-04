import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, parse, relative, resolve } from "node:path";
import { loadHub, loadProject, type HubConfig } from "../config.ts";
import { fillTemplate, templateVars } from "../commands/addProject.ts";

const PORTABLE_NAME = /^[a-z][a-z0-9-]{0,62}$/;
const RESERVED_NAME = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export function validateName(value: string, kind: string): void {
  if (!PORTABLE_NAME.test(value) || RESERVED_NAME.test(value)) {
    const suggestion = /^[A-Za-z][A-Za-z0-9.-]{0,62}$/.test(value)
      ? value.toLowerCase().replace(/\.+/g, "-")
      : "";
    const example =
      PORTABLE_NAME.test(suggestion) && !RESERVED_NAME.test(suggestion)
        ? suggestion
        : kind === "area"
          ? "core"
          : kind === "runner label"
            ? "pm"
            : "my-app";
    const flag = kind === "runner label" ? "runner-label" : kind;
    throw new Error(
      `${kind} must be portable lowercase kebab-case (1–63 characters). Use --${flag} ${example}. This is a local identifier, not a domain or URL.`,
    );
  }
}

/** Public distribution examples are not proof that an operator chose this hub. */
export function isExampleHub(root: string): boolean {
  try {
    const raw = JSON.parse(
      readFileSync(join(root, "hub.json"), "utf8"),
    ) as Record<string, unknown>;
    return (
      typeof raw.$comment === "string" &&
      raw.$comment.startsWith("Generic public example.")
    );
  } catch {
    return false;
  }
}

export function validateRepo(value: string): void {
  if (
    !REPO.test(value) ||
    value.split("/").some((part) => part === "." || part === "..")
  ) {
    throw new Error(
      "repository must be owner/name, without URLs, credentials, or parent segments",
    );
  }
}

/** Explicit destinations may be absolute; parent traversal and symlinks are rejected. */
export function setupDirectory(root: string, input: string): string {
  if (!input || input.includes("\0") || input.split(/[\\/]/).includes("..")) {
    throw new Error("--dir must name a directory without parent traversal");
  }
  const target = resolve(root, input);
  assertNoSymlinks(target);
  if (existsSync(target) && !lstatSync(target).isDirectory()) {
    throw new Error("--dir must name a directory");
  }
  return target;
}

export function assertNoSymlinks(target: string): void {
  let current = resolve(target);
  while (current !== parse(current).root) {
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) {
      throw new Error("setup refuses symbolic links in its destination path");
    }
    current = dirname(current);
  }
}

export const COMMON_SECRETS = [
  "GITHUB_TOKEN",
  "APP_ID",
  "APP_PRIVATE_KEY",
  "LINEAR_API_KEY",
  "VERCEL_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "SHIPGREMLINS_ATTESTATION_KEY",
  "SHIPGREMLINS_ATTESTATION_PUBLIC_KEY",
  "SHIPGREMLINS_VERIFICATION_FILE",
] as const;

export function environmentTemplate(names: string[]): string {
  const unique = [...new Set([...COMMON_SECRETS, ...names])];
  if (unique.some((name) => !/^[A-Z][A-Z0-9_]*$/.test(name))) {
    throw new Error(
      "secret references must be environment-variable names, never values",
    );
  }
  return [
    "# ShipGremlins connection names only. No credentials are generated or copied.",
    "# Copy to .env locally; keep values in your secret manager or CI settings.",
    "# Dashboard connection keys load automatically. For other settings use shipgremlins --env-file .env.",
    "# GITHUB_TOKEN is needed locally; CI creates a short-lived token from APP_ID/APP_PRIVATE_KEY.",
    "# ATTESTATION_KEY belongs only in the trusted signing job. The dispatcher uses ATTESTATION_PUBLIC_KEY.",
    ...unique.map((name) => `${name}=`),
    "",
  ].join("\n");
}

export interface InitInput {
  hubRepo?: string;
  project: string;
  repo: string;
  area?: string;
  runner?: "self-hosted" | "gce";
  runnerLabel?: string;
  today?: string;
}

export interface InitResult {
  directory: string;
  created: string[];
  preserved: string[];
  secretNames: string[];
  next: string[];
}

/** Creates configuration only. Never enrolls a worker, activates a PM, or contacts a provider. */
export function initializeSetup(
  root: string,
  templatesRoot: string,
  input: InitInput,
): InitResult {
  validateName(input.project, "project");
  validateName(input.area ?? "core", "area");
  validateRepo(input.repo);
  if (input.hubRepo !== undefined) validateRepo(input.hubRepo);
  if (input.runnerLabel !== undefined)
    validateName(input.runnerLabel, "runner label");
  const target = setupDirectory(root, ".");
  const area = input.area ?? "core";
  const writes = new Map<string, string>();
  const preserved: string[] = [];
  const plan = (path: string, text: string): void => {
    const absolute = resolve(target, path);
    const rel = relative(target, absolute);
    if (rel.startsWith("..") || isAbsolute(rel))
      throw new Error("invalid setup destination");
    assertNoSymlinks(absolute);
    if (existsSync(absolute)) {
      if (!lstatSync(absolute).isFile())
        throw new Error(`${path} is not a regular file`);
      preserved.push(path);
    } else writes.set(path, text);
  };

  const hubFile = join(target, "hub.json");
  assertNoSymlinks(hubFile);
  if (existsSync(hubFile)) {
    let hub: HubConfig;
    try {
      hub = loadHub(target);
    } catch {
      throw new Error(
        "Existing hub.json is invalid; repair it before setup. No files changed.",
      );
    }
    if (input.hubRepo && hub.hubRepo !== input.hubRepo) {
      throw new Error(
        "Existing hub.json names a different repository. No files changed. Edit its hubRepo to the repository that will run your workflows, then repeat this command; or initialize separately with --dir .run/my-hub --hub-repo your-org/your-hub. --repo names the app under test; --hub-repo names its automation hub.",
      );
    }
    if (
      (input.runner && hub.runners.mode !== input.runner) ||
      (input.runnerLabel && hub.runners.label !== input.runnerLabel)
    ) {
      throw new Error(
        "Existing hub.json has different runner settings. Edit it deliberately; setup never overwrites settings.",
      );
    }
    preserved.push("hub.json");
  } else {
    if (!input.hubRepo)
      throw new Error(
        "No automation repository could be detected. Run setup in your ShipGremlins hub checkout, or use --hub-repo owner/name once for a fresh configuration. This is the repository that stores PM configuration and runs GitHub Actions.",
      );
    const hub: HubConfig = {
      hubRepo: input.hubRepo,
      runners: {
        mode: input.runner ?? "self-hosted",
        label: input.runnerLabel ?? "pm",
      },
      gce: {
        project: "",
        zone: "us-central1-a",
        image: "pm-runner",
        machineType: "e2-standard-4",
        spot: false,
      },
    };
    plan("hub.json", JSON.stringify(hub, null, 2) + "\n");
  }

  const projectPath = join("projects", input.project);
  const projectDir = join(target, projectPath);
  assertNoSymlinks(projectDir);
  let secrets: string[];
  if (existsSync(projectDir)) {
    let project;
    try {
      project = loadProject(target, input.project);
    } catch {
      throw new Error(
        "Existing project is incomplete or invalid; repair it before setup. No files changed.",
      );
    }
    if (
      project.config.repo !== input.repo ||
      !project.areas.some((item) => item.key === area)
    ) {
      throw new Error(
        "Existing project uses a different repository or area. No files changed.",
      );
    }
    preserved.push(projectPath.replace(/\\/g, "/") + "/");
    secrets = [
      project.config.slackWebhookSecret,
      project.config.vercel.bypassSecret,
    ];
    if (project.config.signIn)
      secrets.push(project.config.signIn.databaseUrlSecret);
  } else {
    const vars = templateVars({
      name: input.project,
      repo: input.repo,
      area,
      today: input.today ?? new Date().toISOString().slice(0, 10),
    });
    for (const filename of [
      "project.json",
      "areas.json",
      "tiers.json",
      "mandate.md",
      "features.md",
      "queue.md",
      "memory.md",
    ]) {
      const template = join(templatesRoot, "projects", "_templates", filename);
      if (!existsSync(template))
        throw new Error(
          `Bundled template ${filename} is missing. Reinstall ShipGremlins; no files changed.`,
        );
      let content = fillTemplate(readFileSync(template, "utf8"), vars);
      if (filename === "areas.json") {
        const config = JSON.parse(content) as {
          areas: Record<string, { enabled: boolean }>;
        };
        for (const item of Object.values(config.areas)) item.enabled = false;
        content = JSON.stringify(config, null, 2) + "\n";
      }
      const path = filename.endsWith(".json")
        ? join(projectPath, filename)
        : join(projectPath, area, filename);
      plan(path, content);
    }
    secrets = [`SLACK_WEBHOOK_${vars.NAME}`, `VERCEL_BYPASS_${vars.NAME}`];
  }
  plan(".env.example", environmentTemplate(secrets));
  plan(join(projectPath, ".env.example"), environmentTemplate(secrets));
  plan(
    ".gitignore",
    ".env\n.env.*\n!.env.example\nnode_modules/\n.run/\ntarget/\n*.log\n",
  );

  // Validate every conflict before creating anything. Exclusive writes protect against a race.
  const created: string[] = [];
  try {
    for (const [path, content] of writes) {
      const destination = join(target, path);
      assertNoSymlinks(destination);
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, content, { flag: "wx", mode: 0o600 });
      created.push(path.replace(/\\/g, "/"));
    }
  } catch {
    for (const path of created.reverse()) unlinkSync(join(target, path));
    throw new Error(
      "Setup could not write every file; newly written files were removed. Existing files were preserved.",
    );
  }
  return {
    directory: target,
    created,
    preserved,
    secretNames: [...new Set([...COMMON_SECRETS, ...secrets])],
    next: [
      `Edit projects/${input.project}/project.json: Vercel IDs, branch names, database recipe, and commands for your app.`,
      `Edit projects/${input.project}/areas.json: Linear project ID, ownership paths, and schedule; PMs start disabled.`,
      `Write projects/${input.project}/${area}/mandate.md and configure isolated test accounts.`,
      `Use shipgremlins setup to save supported local connections. Configure GitHub Actions secrets separately. The full variable-name template is projects/${input.project}/.env.example; preserve existing .env values when adding missing names. Use --env-file for additional settings.`,
      `Run shipgremlins setup --check --project ${input.project}. If using a local .env, create/fill it first, then use shipgremlins --env-file .env setup --check --project ${input.project}.`,
      `For live provider checks run shipgremlins --env-file .env doctor ${input.project} (or shipgremlins doctor ${input.project} when credentials are already exported).`,
      "After reviewing the mandate, set its area enabled=true, run shipgremlins crons write in the hub checkout, and review the generated schedule before committing.",
      "GitHub Actions executes the agents. The local site container is an operator guide, not a background scheduler.",
    ],
  };
}
