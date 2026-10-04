import { randomBytes } from "node:crypto";
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

export const CONNECTIONS = [
  {
    name: "GITHUB_TOKEN",
    label: "GitHub",
    description: "Repository access and GitHub Actions.",
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
    name: "CLAUDE_CODE_OAUTH_TOKEN",
    label: "Claude Code",
    description:
      "Claude agent credentials; configure Actions secrets separately.",
  },
] as const;

const allowed = new Set<string>(CONNECTIONS.map(({ name }) => name));
const MAX_ENV_BYTES = 512 * 1024;

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
          allowed.has(entry[0]) &&
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
    if (!allowed.has(name)) throw new Error("Unsupported connection name.");
    if (typeof raw !== "string")
      throw new Error("Connection values must be text.");
    const value = raw.trim();
    if (!value) continue;
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
    writeFileSync(temporary, content, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
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
