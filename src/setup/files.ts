import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, parse, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  loadHub,
  loadProject,
  validSourceRepository,
  validSourceServer,
  type HubConfig,
} from "../config.ts";
import { fillTemplate, templateVars } from "../commands/addProject.ts";
import { projectSecretNames } from "../projectCapabilities.ts";
import { telemetrySecrets } from "../telemetry/config.ts";
import { assertResourceAvailable } from "./resourceDeletion.ts";

const PORTABLE_NAME = /^[a-z][a-z0-9-]{0,62}$/;
const RESERVED_NAME = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;

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

export function validateRepo(
  value: string,
  provider: "github" | "gitlab" = "github",
): void {
  if (
    !validSourceRepository(value, provider) ||
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
  "GITLAB_TOKEN",
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
    "# Dashboard connection keys load automatically. For other settings use gremlins --env-file .env.",
    "# Local jobs use GITHUB_TOKEN or GITLAB_TOKEN for the selected source provider.",
    "# APP_ID/APP_PRIVATE_KEY are only for the optional legacy GitHub Actions integration.",
    "# ATTESTATION_KEY belongs only in the trusted signing job. The dispatcher uses ATTESTATION_PUBLIC_KEY.",
    ...unique.map((name) => `${name}=`),
    "",
  ].join("\n");
}

export interface InitInput {
  hubRepo?: string;
  project: string;
  repo: string;
  provider?: "github" | "gitlab";
  serverUrl?: string;
  area?: string;
  runner?: "local" | "self-hosted" | "gce";
  runnerLabel?: string;
  today?: string;
  settings?: Record<string, unknown>;
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
  assertResourceAvailable(root, input.project, input.area ?? "core");
  validateRepo(input.repo, input.provider);
  if (
    input.settings &&
    Object.keys(input.settings).some(
      (key) =>
        ![
          "workflow",
          "verification",
          "environments",
          "branches",
          "commands",
          "telemetry",
          "linear",
        ].includes(key),
    )
  )
    throw new Error(
      "Unsupported project settings. Use workflow, verification, environments, branches, commands, telemetry, and Linear account settings.",
    );
  if (
    input.serverUrl !== undefined &&
    (input.provider !== "gitlab" || !validSourceServer(input.serverUrl))
  )
    throw new Error(
      "--server-url must be an HTTPS GitLab origin without credentials or a path",
    );
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
    const mode = input.runner ?? (input.hubRepo ? "self-hosted" : "local");
    if (mode !== "local" && !input.hubRepo)
      throw new Error(
        "No automation repository could be detected. Run setup in your ShipGremlins hub checkout, or use --hub-repo owner/name once for a fresh configuration. This is the repository that stores PM configuration and runs GitHub Actions.",
      );
    const hub: HubConfig = {
      hubRepo: input.hubRepo ?? "local/shipgremlins",
      runners: {
        mode,
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
    plan(
      "hub.json",
      JSON.stringify(
        { ...hub, ...(mode === "local" ? { hubRepo: undefined } : {}) },
        null,
        2,
      ) + "\n",
    );
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
      (input.provider !== undefined &&
        (project.config.provider ?? "github") !== input.provider) ||
      (input.serverUrl !== undefined &&
        project.config.serverUrl !== input.serverUrl) ||
      !project.areas.some((item) => item.key === area)
    ) {
      throw new Error(
        "Existing project uses a different repository or area. No files changed.",
      );
    }
    preserved.push(projectPath.replace(/\\/g, "/") + "/");
    if (input.settings) {
      const raw = JSON.parse(
        readFileSync(join(projectDir, "project.json"), "utf8"),
      );
      if (
        Object.entries(input.settings).some(
          ([key, value]) => JSON.stringify(raw[key]) !== JSON.stringify(value),
        )
      )
        throw new Error(
          "This project already has different settings. Edit them in the dashboard; setup never overwrites existing configuration.",
        );
    }
    secrets = [
      project.config.slackWebhookSecret,
      ...projectSecretNames(project.config),
      ...telemetrySecrets(project.config.telemetry).map(
        (secret) => secret.name,
      ),
      ...(project.config.signIn
        ? [project.config.signIn.databaseUrlSecret]
        : []),
    ];
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
      if (filename === "project.json") {
        const config = JSON.parse(content) as Record<string, unknown>;
        config.provider = input.provider ?? "github";
        if (input.serverUrl) config.serverUrl = input.serverUrl;
        Object.assign(config, input.settings);
        content = JSON.stringify(config, null, 2) + "\n";
      }
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
    const temporaryParent = realpathSync(tmpdir());
    const staging = mkdtempSync(join(temporaryParent, "gremlins-new-project-"));
    try {
      for (const [path, content] of writes) {
        if (!path.startsWith(projectPath) || !path.endsWith(".json")) continue;
        const file = join(staging, path);
        mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
        writeFileSync(file, content, { flag: "wx", mode: 0o600 });
      }
      const config = loadProject(staging, input.project).config;
      secrets = [
        config.slackWebhookSecret,
        ...projectSecretNames(config),
        ...telemetrySecrets(config.telemetry).map((secret) => secret.name),
        ...(config.signIn ? [config.signIn.databaseUrlSecret] : []),
      ];
    } catch {
      throw new Error(
        "Project settings are invalid. Check workflow, verification environment, and commands. No files changed.",
      );
    } finally {
      if (
        dirname(staging) === temporaryParent &&
        relative(temporaryParent, staging).startsWith("gremlins-new-project-")
      )
        rmSync(staging, { recursive: true, force: true });
    }
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
      `Review projects/${input.project}/project.json: base branch and install/test commands. Repository review needs no hosting provider; optionally choose browser verification and an environment.`,
      `Edit projects/${input.project}/areas.json: Linear project ID, ownership paths, and schedule; PMs start disabled.`,
      `Write projects/${input.project}/${area}/mandate.md and configure isolated test accounts.`,
      `Use gremlins setup to save connections and create a Docker worker on this machine. Use gremlins setup --lan for a server accessed from other devices.`,
      `Run gremlins setup --check --project ${input.project}. If using a local .env, create/fill it first, then use gremlins --env-file .env setup --check --project ${input.project}.`,
      `For live provider checks run gremlins --env-file .env doctor ${input.project} (or gremlins doctor ${input.project} when credentials are already exported).`,
      "After reviewing the mandate, set its area enabled=true. Local workers follow its UTC schedule while the controller is running; existing CI installations still use gremlins crons write.",
      "The default local Docker mode needs no fork, automation repository, GitHub Actions, or GitLab CI. Existing CI runner settings are preserved.",
    ],
  };
}
