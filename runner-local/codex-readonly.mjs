import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const MAX_FILE = 256 * 1024;
const excluded =
  /^(?:\.git|\.codex|\.env(?:\..*)?|node_modules|\.next|\.cache|auth\.json)$/i;
const validObject = (value) =>
  !!value && typeof value === "object" && !Array.isArray(value);
const rootProperty = { type: "string", enum: ["repository", "memory"] };
export const READONLY_TOOLS = [
  {
    name: "read_file",
    description:
      "Read a bounded UTF-8 source or memory file. Cannot execute commands or follow links.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["root", "path"],
      properties: {
        root: rootProperty,
        path: { type: "string", minLength: 1, maxLength: 500 },
      },
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    },
  },
  {
    name: "list_files",
    description:
      "List bounded source or memory file paths. Cannot follow links.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["root"],
      properties: {
        root: rootProperty,
        prefix: { type: "string", maxLength: 500 },
      },
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    },
  },
  {
    name: "search_files",
    description:
      "Find a literal text string in bounded source or memory files. This is not a shell or regular expression.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["root", "query"],
      properties: {
        root: rootProperty,
        query: { type: "string", minLength: 1, maxLength: 200 },
        prefix: { type: "string", maxLength: 500 },
      },
    },
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    },
  },
];
export function createReadonlyTools(roots) {
  const selected = {};
  for (const key of ["repository", "memory"]) {
    const root = resolve(roots[key]);
    if (!lstatSync(root).isDirectory() || realpathSync(root) !== root)
      throw new Error("Invalid read-only root.");
    selected[key] = root;
  }
  function safe(root, value = "") {
    if (
      typeof value !== "string" ||
      value.length > 500 ||
      isAbsolute(value) ||
      value.includes("\\") ||
      value.includes("\0") ||
      value.split("/").some((part) => part === ".." || excluded.test(part))
    )
      throw new Error(
        "Choose a relative source file inside the selected read-only root.",
      );
    const path = resolve(root, value);
    const rel = relative(root, path);
    if (rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel))
      throw new Error("Read-only path escaped its root.");
    let current = root;
    for (const part of rel.split(sep).filter(Boolean)) {
      current = join(current, part);
      if (!existsSync(current) || lstatSync(current).isSymbolicLink())
        throw new Error(
          "Read-only tools do not follow links or missing paths.",
        );
    }
    return path;
  }
  function files(root, prefix) {
    const start = safe(root, prefix),
      out = [];
    const walk = (directory, depth = 0) => {
      if (depth > 15 || out.length >= 2000) return;
      for (const entry of readdirSync(directory, { withFileTypes: true }).sort(
        (a, b) => a.name.localeCompare(b.name),
      )) {
        if (out.length >= 2000) break;
        if (excluded.test(entry.name) || entry.isSymbolicLink()) continue;
        const path = join(directory, entry.name);
        if (entry.isDirectory()) walk(path, depth + 1);
        else if (entry.isFile())
          out.push(relative(root, path).split(sep).join("/"));
      }
    };
    if (lstatSync(start).isDirectory()) walk(start);
    else out.push(relative(root, start).split(sep).join("/"));
    return out;
  }
  function read(root, path) {
    const file = safe(root, path),
      stat = lstatSync(file);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_FILE)
      throw new Error("Read-only files must be bounded regular UTF-8 text.");
    const text = new TextDecoder("utf-8", { fatal: true }).decode(
      readFileSync(file),
    );
    if (text.includes("\0"))
      throw new Error("Read-only tools cannot inspect binary files.");
    return text;
  }
  return (name, input) => {
    const tool = READONLY_TOOLS.find((tool) => tool.name === name);
    if (
      !tool ||
      !validObject(input) ||
      !selected[input.root] ||
      Object.keys(input).some(
        (key) => !Object.hasOwn(tool.inputSchema.properties, key),
      )
    )
      throw new Error("Unsupported read-only tool request.");
    const root = selected[input.root];
    if (name === "read_file") {
      if (typeof input.path !== "string" || !input.path)
        throw new Error("Choose a source file.");
      return read(root, input.path);
    }
    const names = files(root, input.prefix ?? "");
    if (name === "list_files")
      return JSON.stringify({ files: names, truncated: names.length === 2000 });
    if (
      typeof input.query !== "string" ||
      !input.query ||
      input.query.length > 200
    )
      throw new Error("Choose a bounded literal search string.");
    let bytes = 0;
    const matches = [];
    for (const path of names) {
      let text;
      try {
        text = read(root, path);
      } catch {
        continue;
      }
      bytes += Buffer.byteLength(text);
      if (bytes > 4 * 1024 * 1024) break;
      for (const [line, value] of text.split(/\r?\n/).entries()) {
        if (value.includes(input.query))
          matches.push({ path, line: line + 1, text: value.slice(0, 1000) });
        if (matches.length >= 40) break;
      }
      if (matches.length >= 40) break;
    }
    return JSON.stringify({
      matches,
      truncated: matches.length >= 40 || bytes > 4 * 1024 * 1024,
    });
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const execute = createReadonlyTools({
    repository: process.argv[2],
    memory: process.argv[3],
  });
  let pending = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    pending += chunk;
    if (pending.length > 1024 * 1024) process.exit(1);
    let end;
    while ((end = pending.indexOf("\n")) >= 0) {
      const line = pending.slice(0, end);
      pending = pending.slice(end + 1);
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        process.exitCode = 1;
        continue;
      }
      if (!validObject(message) || !Object.hasOwn(message, "id")) continue;
      let result;
      let error;
      if (message.method === "initialize")
        result = {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "shipgremlins-readonly", version: "1.0.0" },
        };
      else if (message.method === "ping") result = {};
      else if (message.method === "tools/list")
        result = { tools: READONLY_TOOLS };
      else if (message.method === "tools/call") {
        try {
          result = {
            content: [
              {
                type: "text",
                text: execute(message.params?.name, message.params?.arguments),
              },
            ],
          };
        } catch {
          result = {
            isError: true,
            content: [
              {
                type: "text",
                text: "This request exceeds the read-only source capability. Use only bounded relative source reads, listings, and literal searches.",
              },
            ],
          };
        }
      } else
        error = {
          code: -32601,
          message: "Only read-only source tools are available.",
        };
      process.stdout.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          ...(error ? { error } : { result }),
        }) + "\n",
      );
    }
  });
}
