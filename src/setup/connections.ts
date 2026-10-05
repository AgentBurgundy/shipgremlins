import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseEnv } from "node:util";
import { assertNoSymlinks } from "./files.ts";
import { TELEMETRY_SECRET_RE, telemetrySecrets } from "../telemetry/config.ts";
import { listProjectNames, loadProject } from "../config.ts";
import {
  effectiveVerification,
  validProjectSecretName,
  type EnvironmentTarget,
} from "../projectCapabilities.ts";
import { parseGoogleServiceAccount } from "../hosting/credentials.ts";

export const CONNECTIONS = [
  {
    name: "GITLAB_TOKEN",
    label: "GitLab",
    description:
      "Source repositories and merge requests for local Docker jobs.",
  },
  {
    name: "GITHUB_TOKEN",
    label: "GitHub",
    description: "Source repositories and pull requests for local Docker jobs.",
  },
  {
    name: "LINEAR_API_KEY",
    label: "Linear",
    description: "Approved tickets and delivery status.",
  },
  {
    name: "VERCEL_TOKEN",
    label: "Vercel",
    description: "Preview deployments and app environments.",
  },
  {
    name: "RAILWAY_TOKEN",
    label: "Railway",
    description:
      "Read deployment readiness and app domains. Use an account/workspace token, or select project token in the target.",
  },
  {
    name: "GCP_SERVICE_ACCOUNT_JSON",
    label: "Google Cloud Run",
    description:
      "Service-account JSON with Cloud Run Viewer access. Leave blank to use controller Application Default Credentials.",
    format: "json",
  },
  {
    name: "CLAUDE_CODE_OAUTH_TOKEN",
    label: "Claude Code",
    description:
      "Claude agent credentials, passed privately to each local job.",
  },
] as const;

const allowed = new Set<string>(CONNECTIONS.map(({ name }) => name));

export interface ProjectConnectionUsage {
  project: string;
  group: "hosting" | "preview" | "sign-in" | "notifications" | "telemetry";
  provider:
    | "vercel"
    | "railway"
    | "cloud-run"
    | "neon"
    | "slack"
    | "sentry"
    | "datadog"
    | "mixpanel";
  purpose:
    | "deployment-access"
    | "preview-bypass"
    | "test-sign-in"
    | "slack-override"
    | "telemetry-read";
  label: string;
  description: string;
  optional: boolean;
  targetName?: string;
  targetType?: "vercel" | "railway" | "cloud-run";
}
export interface ProjectConnectionDescriptor extends Omit<
  ProjectConnectionUsage,
  "project" | "targetName" | "targetType"
> {
  /** Stable storage reference; render the friendly label as the primary text. */
  name: string;
  format?: "json";
  /** Present only when all usages belong to one project. */
  project?: string;
  usages: ProjectConnectionUsage[];
}

/** Pure configuration metadata. Never read, include, or inspect credential values. */
export function projectConnections(
  root: string,
): ProjectConnectionDescriptor[] {
  const references: Array<
    ProjectConnectionUsage & { name: string; format?: "json" }
  > = [];
  for (const project of listProjectNames(root).sort()) {
    try {
      const { config } = loadProject(root, project);
      const verification = effectiveVerification(config);
      const addTarget = (
        target: EnvironmentTarget,
        targetName: string,
        active: boolean,
      ) => {
        const context = { project, targetName };
        if (target.kind === "vercel" && target.bypassSecret) {
          references.push({
            ...context,
            name: target.bypassSecret,
            group: "preview",
            provider: "vercel",
            targetType: "vercel",
            purpose: "preview-bypass",
            label: "Vercel preview access",
            description:
              "Lets the browser enter a protected Vercel test deployment. Use a dedicated preview bypass credential.",
            optional: !active,
          });
        } else if (target.kind === "railway") {
          references.push({
            ...context,
            name: target.tokenSecret ?? "RAILWAY_TOKEN",
            group: "hosting",
            provider: "railway",
            targetType: "railway",
            purpose: "deployment-access",
            label: "Railway environment",
            description:
              target.tokenType === "project"
                ? "Project token for the selected Railway environment. Deployment checks stay on the controller."
                : "Account or workspace token for Railway deployment readiness and app domains. Kept on the controller.",
            optional: !active,
          });
        } else if (target.kind === "cloud-run") {
          references.push({
            ...context,
            name: target.credentialsSecret ?? "GCP_SERVICE_ACCOUNT_JSON",
            group: "hosting",
            provider: "cloud-run",
            targetType: "cloud-run",
            purpose: "deployment-access",
            format: "json",
            label: "Google Cloud Run access",
            description: target.credentialsSecret
              ? "Google service-account JSON for this Cloud Run environment. Kept on the controller."
              : "Optional service-account JSON. Without it, deployment checks use the controller's Application Default Credentials.",
            optional: !active || !target.credentialsSecret,
          });
        }
      };
      for (const [targetName, target] of Object.entries(
        config.environments ?? {},
      ).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
        addTarget(
          target,
          targetName,
          verification.mode === "browser" &&
            verification.environment === targetName,
        );
      if (config.vercel)
        addTarget(
          { kind: "vercel", role: "preview", ...config.vercel },
          "Legacy preview",
          !config.verification,
        );
      if (config.signIn)
        references.push({
          project,
          name: config.signIn.databaseUrlSecret,
          group: "sign-in",
          provider: "neon",
          purpose: "test-sign-in",
          label: "Test sign-in database",
          description:
            "Preview database connection used to sign in as the configured test account. Use a dedicated test database.",
          optional: verification.mode !== "browser",
        });
      references.push({
        project,
        name: config.slackWebhookSecret,
        group: "notifications",
        provider: "slack",
        purpose: "slack-override",
        label: "Slack report override",
        description:
          "Optional app-specific webhook that overrides the connected Slack channel for this project's reports.",
        optional: true,
      });
      for (const secret of telemetrySecrets(config.telemetry)) {
        const provider =
          config.telemetry?.sentry?.tokenSecret === secret.name
            ? "sentry"
            : [
                  config.telemetry?.datadog?.apiKeySecret,
                  config.telemetry?.datadog?.appKeySecret,
                ].includes(secret.name)
              ? "datadog"
              : "mixpanel";
        references.push({
          project,
          ...secret,
          provider,
          group: "telemetry",
          purpose: "telemetry-read",
          optional: false,
        });
      }
    } catch {
      // The dashboard reports malformed projects separately; never surface raw JSON.
    }
  }
  const groups = new Map<
    string,
    { format?: "json"; usages: ProjectConnectionUsage[] }
  >();
  for (const { name, format, ...usage } of references) {
    if (!validProjectSecretName(name)) continue;
    const entry = groups.get(name) ?? { usages: [] };
    if (format === "json") entry.format = "json";
    if (
      !entry.usages.some(
        (existing) => JSON.stringify(existing) === JSON.stringify(usage),
      )
    )
      entry.usages.push(usage);
    groups.set(name, entry);
  }
  const priority: Record<ProjectConnectionUsage["group"], number> = {
    hosting: 0,
    preview: 1,
    "sign-in": 2,
    telemetry: 3,
    notifications: 4,
  };
  return [...groups]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, { format, usages }]) => {
      usages.sort(
        (a, b) =>
          priority[a.group] - priority[b.group] ||
          Number(a.optional) - Number(b.optional) ||
          (JSON.stringify(a) < JSON.stringify(b)
            ? -1
            : JSON.stringify(a) > JSON.stringify(b)
              ? 1
              : 0),
      );
      const first = usages[0]!;
      return {
        name,
        label: first.label,
        description: first.description,
        group: first.group,
        provider: first.provider,
        purpose: first.purpose,
        optional: usages.every((usage) => usage.optional),
        ...(format ? { format } : {}),
        ...(usages.every((usage) => usage.project === first.project)
          ? { project: first.project }
          : {}),
        usages,
      };
    });
}
const isAllowed = (name: string, root: string): boolean =>
  allowed.has(name) ||
  TELEMETRY_SECRET_RE.test(name) ||
  projectConnections(root).some((entry) => entry.name === name);
const MAX_ENV_BYTES = 512 * 1024;
let ownerSid: string | undefined;

function protectWindowsFile(file: string): void {
  if (process.platform !== "win32") return;
  ownerSid ??= execFileSync("whoami.exe", ["/user", "/fo", "csv", "/nh"], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 5000,
    maxBuffer: 16_384,
  }).match(/S-1-(?:\d+-)+\d+/)?.[0];
  if (!ownerSid) throw new Error();
  execFileSync(
    "icacls.exe",
    [file, "/inheritance:r", "/grant:r", `*${ownerSid}:(F)`],
    {
      windowsHide: true,
      timeout: 5000,
      maxBuffer: 16_384,
      stdio: "ignore",
    },
  );
}

function assertConnectionPath(file: string): void {
  assertNoSymlinks(file);
  // existsSync follows links, so also catch a dangling .env link or ancestor.
  let current = resolve(file);
  for (;;) {
    if (lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink())
      throw new Error("Connection paths cannot contain symbolic links.");
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

function readSource(root: string): string {
  const file = join(resolve(root), ".env");
  assertConnectionPath(file);
  if (!existsSync(file)) return "";
  const source = readFileSync(file, "utf8");
  if (Buffer.byteLength(source) > MAX_ENV_BYTES)
    throw new Error("Connection file is too large.");
  return source;
}

/** Never import arbitrary .env keys into the CLI process. */
export function readConnections(root: string): Record<string, string> {
  try {
    const parsed = parseEnv(readSource(root));
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, string] =>
          isAllowed(entry[0], root) &&
          typeof entry[1] === "string" &&
          entry[1].length > 0,
      ),
    );
  } catch {
    throw new Error(
      "Saved connections could not be read. Check the configuration directory and .env file permissions.",
    );
  }
}

/** Retain unrelated dotenv content, including multiline quoted values and comments. */
function replaceValues(
  source: string,
  updates: Record<string, string>,
): string {
  const remaining = new Set(Object.keys(updates));
  let output = "";
  let start = 0;
  while (start < source.length) {
    let end = source.indexOf("\n", start);
    if (end < 0) end = source.length;
    else end += 1;
    const firstLine = source.slice(start, end);
    const assignment =
      /^[\t ]*(?:export[\t ]+)?([A-Za-z_][A-Za-z0-9_]*)[\t ]*=[\t ]*/.exec(
        firstLine,
      );
    if (assignment) {
      const valueStart = start + assignment[0].length;
      const quote = source[valueStart];
      if (quote === '"' || quote === "'" || quote === "`") {
        const closing = source.indexOf(quote, valueStart + 1);
        if (closing >= end) {
          const newline = source.indexOf("\n", closing);
          end = newline < 0 ? source.length : newline + 1;
        }
      }
      const key = assignment[1]!;
      if (Object.hasOwn(updates, key)) {
        if (remaining.delete(key)) output += `${key}='${updates[key]}'\n`;
        start = end;
        continue;
      }
    }
    output += source.slice(start, end);
    start = end;
  }
  if (remaining.size && output && !output.endsWith("\n")) output += "\n";
  for (const key of remaining) output += `${key}='${updates[key]}'\n`;

  // Refuse ambiguous/malformed quoting instead of risking an unrelated setting.
  const before = parseEnv(source);
  const after = parseEnv(output);
  const expected = { ...before, ...updates };
  if (
    Object.keys(after).length !== Object.keys(expected).length ||
    Object.entries(expected).some(([key, value]) => after[key] !== value)
  )
    throw new Error("Connection file needs repair before it can be updated.");
  return output;
}

/** Save allowlisted tokens atomically; blanks preserve existing credentials. */
export function saveConnections(root: string, input: unknown): void {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("Expected a connection values object.");
  const updates: Record<string, string> = {};
  for (const [name, raw] of Object.entries(input)) {
    if (!isAllowed(name, root)) throw new Error("Unsupported connection name.");
    if (typeof raw !== "string")
      throw new Error("Connection values must be text.");
    let value = raw.trim();
    if (!value) continue;
    const google =
      name === "GCP_SERVICE_ACCOUNT_JSON" ||
      projectConnections(root).some(
        (entry) => entry.name === name && entry.format === "json",
      );
    if (google) {
      // Canonical JSON contains escaped PEM newlines, not dotenv line breaks. Projected
      // fields contain no apostrophes, so single-quoted dotenv preserves backslashes.
      value = JSON.stringify(parseGoogleServiceAccount(value));
      if (value.includes("'"))
        throw new Error(
          "Google service-account JSON could not be stored safely.",
        );
      updates[name] = value;
      continue;
    }
    if (
      value.length > 8192 ||
      /[\s"'`\\]/.test(value) ||
      [...value].some(
        (character) =>
          character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
      )
    )
      throw new Error(
        "Tokens must be single-line values without quotes or whitespace (maximum 8192 characters).",
      );
    updates[name] = value;
  }
  if (!Object.keys(updates).length) return;
  let temporary: string | undefined;
  try {
    const directory = resolve(root);
    const file = join(directory, ".env");
    const content = replaceValues(readSource(directory), updates);
    assertConnectionPath(file);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    assertConnectionPath(file);
    temporary = join(directory, `.env.${randomBytes(12).toString("hex")}.tmp`);
    writeFileSync(temporary, "", {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    protectWindowsFile(temporary);
    writeFileSync(temporary, content, { encoding: "utf8", mode: 0o600 });
    assertConnectionPath(file);
    renameSync(temporary, file);
    temporary = undefined;
  } catch {
    throw new Error(
      "Connections could not be saved. Check .env formatting, directory permissions, and symbolic links.",
    );
  } finally {
    if (temporary) {
      try {
        unlinkSync(temporary);
      } catch {
        /* Preserve the original error. */
      }
    }
  }
}
