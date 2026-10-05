import { Buffer } from "node:buffer";
import { TextDecoder } from "node:util";
import { lstatSync } from "node:fs";
export const DISCOVERY_FILES = [
  "discovery.md",
  "features.md",
  "queue.md",
  "memory.md",
];
export function discoveryArguments() {
  const properties = Object.fromEntries(
    DISCOVERY_FILES.map((name) => [
      name,
      { type: "string", minLength: 1, maxLength: 65536 },
    ]),
  );
  return [
    "--tools",
    "Read,Glob,Grep",
    "--allowedTools",
    "Read",
    "Glob",
    "Grep",
    "--permission-mode",
    "dontAsk",
    "--safe-mode",
    "--restricted",
    "--disable-slash-commands",
    "--setting-sources",
    "",
    "--no-chrome",
    "--json-schema",
    JSON.stringify({
      type: "object",
      additionalProperties: false,
      required: ["summary", "documents"],
      properties: {
        summary: { type: "string", minLength: 1, maxLength: 4000 },
        documents: {
          type: "object",
          additionalProperties: false,
          required: DISCOVERY_FILES,
          properties,
        },
      },
    }),
  ];
}
export function discoveryResult(output) {
  let result;
  for (const line of output.split(/\r?\n/)) {
    try {
      const record = JSON.parse(line);
      if (record.type === "result" && !record.is_error)
        result = record.structured_output;
    } catch {
      /* Ignore non-JSON progress; only structured results qualify. */
    }
  }
  if (
    !result ||
    typeof result.summary !== "string" ||
    !result.summary.trim() ||
    result.summary.length > 4000 ||
    !result.documents ||
    typeof result.documents !== "object" ||
    Array.isArray(result.documents) ||
    Object.keys(result.documents).length !== DISCOVERY_FILES.length ||
    Object.keys(result).some((key) => !["summary", "documents"].includes(key))
  )
    throw new Error(
      "Discovery did not return its four structured knowledge documents.",
    );
  for (const name of DISCOVERY_FILES) {
    const value = result.documents[name];
    if (
      typeof value !== "string" ||
      !value.trim() ||
      Buffer.byteLength(value) > 65536 ||
      value.includes("\0")
    )
      throw new Error("Discovery knowledge is missing, empty, or too large.");
  }
  return result;
}

/** Sanitize model-written patrol artifacts with the credentials actually leased to this run. */
export function sanitizeKnowledge(directory, redact) {
  for (const name of DISCOVERY_FILES) {
    const path = join(directory, name);
    if (!existsSync(path)) continue;
    if (lstatSync(path).isSymbolicLink())
      throw new Error("Knowledge output cannot be a symlink.");
    const fd = openSync(path, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0));
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > 65536)
        throw new Error(
          "Knowledge output must be bounded regular Markdown files.",
        );
      const content = new TextDecoder("utf8", { fatal: true }).decode(
        readFileSync(fd),
      );
      const safe = redact(content);
      if (Buffer.byteLength(safe) > 65536)
        throw new Error("Sanitized knowledge output is too large.");
      ftruncateSync(fd, 0);
      writeSync(fd, safe, 0, "utf8");
    } finally {
      closeSync(fd);
    }
  }
}
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  ftruncateSync,
  openSync,
  readFileSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
