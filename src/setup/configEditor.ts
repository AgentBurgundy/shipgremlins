import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, parse, resolve } from "node:path";
import { ConfigError, loadHub, loadProject } from "../config.ts";

export const MAX_CONFIG_BYTES = 64 * 1024;
const PROJECT_NAME = /^[a-z][a-z0-9-]{0,62}$/;
const RESERVED_NAME = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i;
const PROJECT_FILES = ["project.json", "areas.json", "tiers.json"] as const;
type ErrorCode =
  | "invalid_path"
  | "not_found"
  | "invalid_config"
  | "too_large"
  | "conflict"
  | "unsafe_path"
  | "io_error";

/** Messages are safe for an API response: never include submitted JSON or values. */
export class ConfigEditorError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly status: number = 400,
  ) {
    super(message);
    this.name = "ConfigEditorError";
  }
}

export interface EditableConfig {
  path: string;
  label: string;
}

export interface ConfigDocument {
  path: string;
  content: string;
  revision: string;
}

function isProjectName(value: string): boolean {
  return PROJECT_NAME.test(value) && !RESERVED_NAME.test(value);
}

function allowedPath(input: unknown): string {
  if (input === "hub.json") return input;
  if (typeof input === "string") {
    const parts = input.split("/");
    if (
      parts.length === 3 &&
      parts[0] === "projects" &&
      isProjectName(parts[1]!) &&
      PROJECT_FILES.some((file) => file === parts[2])
    )
      return input;
  }
  throw new ConfigEditorError(
    "invalid_path",
    "Choose hub.json or an existing project's project.json, areas.json, or tiers.json.",
  );
}

function statIfPresent(file: string): Stats | undefined {
  try {
    return lstatSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** lstat also detects dangling links; existsSync would miss those. */
function assertNoLinks(target: string): void {
  let current = resolve(target);
  for (;;) {
    if (statIfPresent(current)?.isSymbolicLink())
      throw new ConfigEditorError(
        "unsafe_path",
        "Configuration paths cannot contain symbolic links or junctions.",
      );
    if (current === parse(current).root) break;
    current = dirname(current);
  }
}

function configLocation(root: string, input: unknown): string {
  const path = allowedPath(input);
  const target = resolve(root, ...path.split("/"));
  assertNoLinks(target);
  const info = statIfPresent(target);
  if (!info)
    throw new ConfigEditorError(
      "not_found",
      "This configuration file no longer exists. Refresh the file list.",
      404,
    );
  if (!info.isFile() || info.nlink !== 1)
    throw new ConfigEditorError(
      "unsafe_path",
      "Configuration must be a regular file without links.",
    );
  return target;
}

function digest(content: Buffer | string): string {
  return createHash("sha256").update(content).digest("hex");
}

function safely<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    if (error instanceof ConfigEditorError) throw error;
    throw new ConfigEditorError(
      "io_error",
      "Configuration could not be accessed. Check file permissions and try again.",
      500,
    );
  }
}

export function listEditableConfigs(root: string): EditableConfig[] {
  return safely(() => {
    assertNoLinks(root);
    if (!statIfPresent(root)) return [];
    const result: EditableConfig[] = [];
    const add = (path: string, label: string) => {
      try {
        configLocation(root, path);
        result.push({ path, label });
      } catch (error) {
        if (
          !(error instanceof ConfigEditorError) ||
          !["not_found", "unsafe_path"].includes(error.code)
        )
          throw error;
      }
    };
    add("hub.json", "Hub & runners");
    const projects = join(root, "projects");
    const info = statIfPresent(projects);
    if (!info || info.isSymbolicLink() || !info.isDirectory()) return result;
    for (const entry of readdirSync(projects, { withFileTypes: true }).sort(
      (a, b) => a.name.localeCompare(b.name),
    )) {
      if (!entry.isDirectory() || !isProjectName(entry.name)) continue;
      for (const file of PROJECT_FILES)
        add(`projects/${entry.name}/${file}`, `${entry.name} / ${file}`);
    }
    return result;
  });
}

export function readEditableConfig(
  root: string,
  input: string,
): ConfigDocument {
  return safely(() => {
    const path = allowedPath(input);
    const target = configLocation(root, path);
    // O_NOFOLLOW adds protection against file replacement between lstat and open
    // on POSIX. Windows paths are checked with lstat before and after opening.
    const fd = openSync(
      target,
      constants.O_RDONLY |
        (process.platform === "win32" ? 0 : constants.O_NOFOLLOW),
    );
    try {
      const opened = fstatSync(fd);
      configLocation(root, path);
      const current = lstatSync(target);
      if (
        !opened.isFile() ||
        opened.nlink !== 1 ||
        opened.dev !== current.dev ||
        opened.ino !== current.ino
      )
        throw new ConfigEditorError(
          "unsafe_path",
          "The configuration file changed while opening. Refresh and try again.",
        );
      if (opened.size > MAX_CONFIG_BYTES)
        throw new ConfigEditorError(
          "too_large",
          "Configuration files must be 64 KB or smaller.",
        );
      const bytes = readFileSync(fd);
      if (bytes.length > MAX_CONFIG_BYTES)
        throw new ConfigEditorError(
          "too_large",
          "Configuration files must be 64 KB or smaller.",
        );
      return { path, content: bytes.toString("utf8"), revision: digest(bytes) };
    } finally {
      closeSync(fd);
    }
  });
}

function parseJson(content: string): unknown {
  try {
    return JSON.parse(content);
  } catch {
    throw new ConfigEditorError(
      "invalid_config",
      "Invalid JSON. Check commas, quotes, and brackets before saving.",
    );
  }
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validationMessage(error: ConfigError): string {
  const reason = error.message.slice(error.file.length + 2);
  // The shared loader mentions area keys and labels in some diagnostics. Do not
  // echo user-controlled names: explain those requirements in fixed language.
  if (reason.startsWith("area "))
    return "Each area must be an object with a lowercase kebab-case key and a matching pm:KEY label.";
  if (reason.startsWith('"bypassSecret"'))
    return '"bypassSecret" must be a SECRET NAME, never a credential value.';
  if (reason.startsWith('"slackWebhookSecret"'))
    return '"slackWebhookSecret" must be a SECRET NAME, never a credential value.';
  // All other shared-loader diagnostics describe fixed field names and types.
  return reason;
}

function validateDocuments(documents: ConfigDocument[], path: string): void {
  const project = path === "hub.json" ? undefined : path.split("/")[1]!;
  for (const document of documents) {
    const raw = parseJson(document.content);
    if (document.path.endsWith("/project.json") && object(raw)) {
      if (raw.name !== undefined && raw.name !== project)
        throw new ConfigEditorError(
          "invalid_config",
          '"name" must match this project directory. Rename projects outside the editor.',
        );
    }
    if (
      document.path.endsWith("/areas.json") &&
      object(raw) &&
      object(raw.areas)
    ) {
      if (Object.keys(raw.areas).some((key) => !/^[a-z][a-z0-9-]*$/.test(key)))
        throw new ConfigEditorError(
          "invalid_config",
          "Area keys must use lowercase kebab-case.",
        );
    }
  }

  // The loaders are the single source of schema validation. Give them a private
  // disposable tree containing only these JSON documents, never the live .env.
  const temporaryParent = realpathSync(tmpdir());
  const staging = mkdtempSync(join(temporaryParent, "shipgremlins-config-"));
  try {
    for (const document of documents) {
      const destination = join(staging, ...document.path.split("/"));
      mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
      writeFileSync(destination, document.content, { mode: 0o600, flag: "wx" });
    }
    if (project) loadProject(staging, project);
    else loadHub(staging);
  } catch (error) {
    if (error instanceof ConfigError)
      throw new ConfigEditorError("invalid_config", validationMessage(error));
    throw error;
  } finally {
    // Only remove the freshly allocated directory, never a configured root.
    if (
      dirname(staging) === temporaryParent &&
      basename(staging).startsWith("shipgremlins-config-")
    )
      rmSync(staging, { recursive: true, force: true });
  }
}

/** Synchronous validation + compare-and-replace serializes this server's saves. */
export function saveEditableConfig(
  root: string,
  input: { path: string; content: string; revision: string },
): { revision: string } {
  return safely(() => {
    const path = allowedPath(input?.path);
    if (typeof input.content !== "string")
      throw new ConfigEditorError(
        "invalid_config",
        "Configuration must be JSON text.",
      );
    if (Buffer.byteLength(input.content, "utf8") > MAX_CONFIG_BYTES)
      throw new ConfigEditorError(
        "too_large",
        "Configuration files must be 64 KB or smaller.",
      );
    if (
      typeof input.revision !== "string" ||
      !/^[a-f0-9]{64}$/.test(input.revision)
    )
      throw new ConfigEditorError(
        "conflict",
        "Refresh the file before saving. A current revision is required.",
        409,
      );
    const original = readEditableConfig(root, path);
    if (original.revision !== input.revision)
      throw new ConfigEditorError(
        "conflict",
        "This file changed since you opened it. Keep your draft and reload the latest file.",
        409,
      );
    const relatedPaths =
      path === "hub.json"
        ? [path]
        : PROJECT_FILES.map((file) => `projects/${path.split("/")[1]}/${file}`);
    const originals = relatedPaths.map((related) =>
      related === path ? original : readEditableConfig(root, related),
    );
    validateDocuments(
      originals.map((document) =>
        document.path === path
          ? { ...document, content: input.content }
          : document,
      ),
      path,
    );
    const target = configLocation(root, path);
    const temporary = join(
      dirname(target),
      `.shipgremlins-config-${randomUUID()}.tmp`,
    );
    let temporaryCreated = false;
    try {
      const fd = openSync(temporary, "wx", 0o600);
      temporaryCreated = true;
      try {
        writeFileSync(fd, input.content, "utf8");
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      for (const document of originals) {
        if (
          readEditableConfig(root, document.path).revision !== document.revision
        )
          throw new ConfigEditorError(
            "conflict",
            "Configuration changed while saving. Keep your draft and reload the latest file.",
            409,
          );
      }
      configLocation(root, path);
      renameSync(temporary, target);
      temporaryCreated = false;
      return { revision: digest(input.content) };
    } finally {
      if (temporaryCreated) unlinkSync(temporary);
    }
  });
}
