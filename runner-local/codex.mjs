import {
  constants,
  closeSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const object = (value) =>
  !!value && typeof value === "object" && !Array.isArray(value);
const modelName = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;
export function validateAiSelection(value) {
  if (value === undefined) return { provider: "claude" };
  if (
    !object(value) ||
    !["claude", "codex"].includes(value.provider) ||
    Object.keys(value).some((key) => !["provider", "model"].includes(key)) ||
    (value.model !== undefined &&
      (typeof value.model !== "string" || !modelName.test(value.model)))
  )
    throw new Error("Choose a supported AI provider and model.");
  return {
    provider: value.provider,
    ...(value.model ? { model: value.model } : {}),
  };
}

function authValue(raw) {
  if (typeof raw !== "string" || Buffer.byteLength(raw) > 65536)
    throw new Error("A private Codex ChatGPT connection is required.");
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("A private Codex ChatGPT connection is required.");
  }
  if (
    !object(value) ||
    value.auth_mode !== "chatgpt" ||
    value.OPENAI_API_KEY ||
    !object(value.tokens) ||
    !["id_token", "access_token"].every(
      (key) =>
        typeof value.tokens[key] === "string" &&
        value.tokens[key].length > 0 &&
        value.tokens[key].length <= 30000 &&
        !/[\r\n\0]/.test(value.tokens[key]),
    ) ||
    (value.tokens.account_id != null &&
      (typeof value.tokens.account_id !== "string" ||
        !/^[A-Za-z0-9_-]{1,200}$/.test(value.tokens.account_id)))
  )
    throw new Error(
      "Use a Codex ChatGPT connection; API billing is not enabled.",
    );
  return value;
}
export function codexSecretValues(raw) {
  const value = authValue(raw);
  return [
    raw,
    ...["id_token", "access_token", "refresh_token"]
      .map((key) => value.tokens[key])
      .filter((value) => typeof value === "string" && value),
  ];
}
export function codexWorkerAuth(raw, now = () => new Date()) {
  const value = authValue(raw);
  // Only the trusted controller refresh helper owns the rotating refresh token.
  return JSON.stringify({
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens: {
      id_token: value.tokens.id_token,
      access_token: value.tokens.access_token,
      refresh_token: "",
      ...(value.tokens.account_id
        ? { account_id: value.tokens.account_id }
        : {}),
    },
    last_refresh: now().toISOString(),
  });
}
const toml = (value) => JSON.stringify(value);

// Codex forwards output-schema as strict JSON Schema without making optional
// properties nullable. Keep that wire representation out of domain reports.
const dictionary = (schema) =>
  object(schema) &&
  schema.type === "object" &&
  !schema.properties &&
  object(schema.additionalProperties);
const nullable = (schema) =>
  schema?.type === "null" ||
  (Array.isArray(schema?.type) && schema.type.includes("null")) ||
  schema?.enum?.includes(null) ||
  schema?.const === null ||
  [...(schema?.anyOf ?? []), ...(schema?.oneOf ?? [])].some(nullable);
function disjointBranches(branches) {
  return branches.every((left, i) =>
    branches.slice(i + 1).every((right) =>
      Object.entries(left.properties ?? {}).some(([key, value]) => {
        const other = right.properties?.[key];
        const a = Object.hasOwn(value, "const") ? [value.const] : value.enum;
        const b =
          other && (Object.hasOwn(other, "const") ? [other.const] : other.enum);
        return (
          left.required?.includes(key) &&
          right.required?.includes(key) &&
          Array.isArray(a) &&
          Array.isArray(b) &&
          a.every((item) => !b.includes(item))
        );
      }),
    ),
  );
}
function strictOutputSchema(schema, depth = 0) {
  if (!object(schema) || depth > 128)
    throw new Error("Invalid Codex output schema.");
  if (
    schema.additionalProperties === true ||
    (schema.properties && object(schema.additionalProperties)) ||
    (schema.oneOf && schema.anyOf)
  )
    throw new Error(
      "Codex output schema cannot preserve this object or union shape.",
    );
  if (dictionary(schema)) {
    return {
      type: "array",
      maxItems: Math.min(schema.maxProperties ?? 128, 128),
      ...(schema.minProperties === undefined
        ? {}
        : { minItems: schema.minProperties }),
      items: {
        type: "object",
        additionalProperties: false,
        required: ["key", "value"],
        properties: {
          key: { type: "string", ...(schema.propertyNames ?? {}) },
          value: strictOutputSchema(schema.additionalProperties, depth + 1),
        },
      },
    };
  }
  const result = { ...schema };
  if (Object.hasOwn(result, "const")) {
    result.enum = [result.const];
    delete result.const;
  }
  if (
    result.type === undefined &&
    Array.isArray(result.enum) &&
    result.enum.every((value) => typeof value === "string")
  )
    result.type = "string";
  // Strict Structured Outputs does not support uniqueItems. Validate the
  // original domain constraint after restoring the wire representation.
  delete result.uniqueItems;
  if (result.oneOf) {
    if (!disjointBranches(result.oneOf))
      throw new Error("Codex output unions require disjoint discriminators.");
    result.anyOf = result.oneOf;
    delete result.oneOf;
  }
  if (result.anyOf)
    result.anyOf = result.anyOf.map((item) =>
      strictOutputSchema(item, depth + 1),
    );
  for (const key of ["$defs", "definitions"])
    if (result[key])
      result[key] = Object.fromEntries(
        Object.entries(result[key]).map(([name, item]) => [
          name,
          strictOutputSchema(item, depth + 1),
        ]),
      );
  if (result.items) result.items = strictOutputSchema(result.items, depth + 1);
  if (result.type === "object" || result.properties) {
    const required = new Set(result.required ?? []);
    result.properties = Object.fromEntries(
      Object.entries(result.properties ?? {}).map(([key, value]) => {
        const normalized = strictOutputSchema(value, depth + 1);
        return [
          key,
          required.has(key) || nullable(value)
            ? normalized
            : { anyOf: [normalized, { type: "null" }] },
        ];
      }),
    );
    result.required = Object.keys(result.properties);
    result.additionalProperties = false;
  }
  return result;
}
function dereference(schema, root) {
  if (!schema?.$ref) return schema;
  if (!schema.$ref.startsWith("#/"))
    throw new Error("Only local output schema references are supported.");
  let value = root;
  for (const key of schema.$ref.slice(2).split("/"))
    value = value?.[key.replaceAll("~1", "/").replaceAll("~0", "~")];
  if (!object(value)) throw new Error("Invalid output schema reference.");
  return value;
}
function matchesBranch(value, schema, root) {
  schema = dereference(schema, root);
  if (Object.hasOwn(schema, "const") && value !== schema.const) return false;
  if (schema.enum && !schema.enum.includes(value)) return false;
  if (schema.type) {
    const type =
      value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
    if (
      !(Array.isArray(schema.type) ? schema.type : [schema.type]).includes(
        type,
      ) &&
      !(schema.type === "integer" && Number.isInteger(value)) &&
      !(dictionary(schema) && Array.isArray(value))
    )
      return false;
  }
  if (object(value)) {
    if (schema.required?.some((key) => !Object.hasOwn(value, key)))
      return false;
    for (const [key, child] of Object.entries(schema.properties ?? {}))
      if (
        Object.hasOwn(value, key) &&
        (Object.hasOwn(child, "const") || child.enum) &&
        !matchesBranch(value[key], child, root)
      )
        return false;
  }
  return true;
}
function jsonIdentity(value, depth = 0) {
  if (depth > 128)
    throw new Error("Codex output exceeds the schema depth limit.");
  if (Array.isArray(value))
    return `[${value.map((item) => jsonIdentity(item, depth + 1)).join(",")}]`;
  if (object(value))
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${jsonIdentity(value[key], depth + 1)}`,
      )
      .join(",")}}`;
  return JSON.stringify(value);
}
function restoreOutput(value, original, root = original, depth = 0) {
  if (depth > 128)
    throw new Error("Codex output exceeds the schema depth limit.");
  const schema = dereference(original, root);
  const union = schema.anyOf ?? schema.oneOf;
  if (union) {
    const candidates = union.filter((branch) =>
      matchesBranch(value, branch, root),
    );
    if (!candidates.length || (schema.oneOf && candidates.length !== 1))
      throw new Error("Codex output does not match its schema union.");
    return restoreOutput(value, candidates[0], root, depth + 1);
  }
  if (dictionary(schema)) {
    if (
      !Array.isArray(value) ||
      value.length > Math.min(schema.maxProperties ?? 128, 128) ||
      value.length < (schema.minProperties ?? 0)
    )
      throw new Error("Codex output dictionary exceeds its bounds.");
    const entries = [],
      keys = new Set();
    for (const entry of value) {
      const key = entry?.key;
      if (
        !object(entry) ||
        Object.keys(entry).length !== 2 ||
        !Object.hasOwn(entry, "value") ||
        typeof key !== "string" ||
        ["__proto__", "prototype", "constructor"].includes(key) ||
        keys.has(key) ||
        (schema.propertyNames?.pattern &&
          !new RegExp(schema.propertyNames.pattern).test(key))
      )
        throw new Error(
          "Codex output dictionary has an invalid or repeated key.",
        );
      keys.add(key);
      entries.push([
        key,
        restoreOutput(
          entry.value,
          schema.additionalProperties,
          root,
          depth + 1,
        ),
      ]);
    }
    return Object.fromEntries(entries);
  }
  if (Array.isArray(value) && schema.items) {
    if (
      value.length < (schema.minItems ?? 0) ||
      value.length > (schema.maxItems ?? Infinity)
    )
      throw new Error("Codex output array exceeds its bounds.");
    const restored = value.map((item) =>
      restoreOutput(item, schema.items, root, depth + 1),
    );
    if (
      schema.uniqueItems === true &&
      new Set(restored.map((item) => jsonIdentity(item))).size !==
        restored.length
    )
      throw new Error("Codex output array must contain unique items.");
    return restored;
  }
  if (object(value) && schema.properties) {
    const required = new Set(schema.required ?? []);
    return Object.fromEntries(
      Object.entries(value).flatMap(([key, item]) => {
        const child = schema.properties[key];
        if (!child) return [[key, item]];
        if (
          item === null &&
          !required.has(key) &&
          !nullable(dereference(child, root))
        )
          return [];
        return [[key, restoreOutput(item, child, root, depth + 1)]];
      }),
    );
  }
  return value;
}
export const CODEX_TOOL_HOST_MESSAGE =
  "The Codex tool host could not start. Update ShipGremlins and the runner, verify the runner again, then start a new run. This run did not complete.";

export class CodexToolHostError extends Error {
  constructor() {
    super(CODEX_TOOL_HOST_MESSAGE);
    this.name = "CodexToolHostError";
  }
}

/** Only native startup errors qualify; model prose and MCP content are not proof. */
export function codexToolHostUnavailable(record) {
  return (
    record?.type === "item.completed" &&
    record.item?.type === "error" &&
    typeof record.item.message === "string" &&
    /code[- ]mode (?:is unavailable because|host is disabled|host executable (?:was )?not found)/i.test(
      record.item.message,
    )
  );
}

const disabled = [
  "apps",
  "plugins",
  "hooks",
  "codex_hooks",
  "plugin_hooks",
  "multi_agent",
  "multi_agent_mode",
  "multi_agent_v2",
  "collab",
  "connectors",
  "browser_use",
  "computer_use",
  "in_app_browser",
  "js_repl",
  "memories",
  "memory_tool",
  "skill_mcp_dependency_install",
  "skill_env_var_dependency_prompt",
  "remote_control",
  "workspace_dependencies",
  "image_generation",
  "goals",
  "default_mode_request_user_input",
];

/** The controller supplies every capability. Source .codex config and hooks are never trusted. */
export function prepareCodexInvocation({
  selection = { provider: "codex" },
  authJson,
  cwd,
  directory = tmpdir(),
  mcpServers = {},
  restricted = false,
  readonlyRoots,
  schema,
  env = process.env,
  now = () => new Date(),
}) {
  const ai = validateAiSelection(selection);
  if (ai.provider !== "codex" || typeof cwd !== "string" || !cwd)
    throw new Error("Invalid Codex invocation.");
  if (!object(mcpServers) || (restricted && Object.keys(mcpServers).length))
    throw new Error("Restricted Codex tasks cannot add tools.");
  const auth = codexWorkerAuth(authJson, now);
  const parent = resolve(directory);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const home = mkdtempSync(join(parent, "gremlins-codex-"));
  try {
    const taskCwd = restricted ? join(home, "task") : resolve(cwd);
    const outputPath = join(home, "last-message.txt");
    const schemaPath = join(home, "output-schema.json");
    mkdirSync(taskCwd, { recursive: true, mode: 0o700 });
    const servers = { ...mcpServers };
    if (readonlyRoots) {
      if (
        !restricted ||
        !object(readonlyRoots) ||
        Object.keys(readonlyRoots).some(
          (key) => !["repository", "memory"].includes(key),
        ) ||
        ![readonlyRoots.repository, readonlyRoots.memory].every(
          (value) => typeof value === "string" && value,
        )
      )
        throw new Error("Invalid read-only discovery roots.");
      servers.readonly = {
        command: process.execPath,
        args: [
          join(dirname(fileURLToPath(import.meta.url)), "codex-readonly.mjs"),
          resolve(readonlyRoots.repository),
          resolve(readonlyRoots.memory),
        ],
      };
    }
    const features = Object.fromEntries(disabled.map((name) => [name, false]));
    // Code Mode is a transport for the admitted tools, not an extra source of
    // capabilities. Keep its native host available for programmatic tool calls.
    Object.assign(features, {
      code_mode: true,
      code_mode_host: true,
      skip_host_skill_discovery: true,
    });
    if (restricted)
      Object.assign(features, {
        shell_tool: false,
        unified_exec: false,
        experimental_use_unified_exec_tool: false,
        apply_patch_freeform: false,
        view_image: false,
        tool_search: false,
        search_tool: false,
      });
    const lines = [
      'model_provider = "openai"',
      'forced_login_method = "chatgpt"',
      'cli_auth_credentials_store = "file"',
      'approval_policy = "never"',
      'web_search = "disabled"',
      "project_doc_max_bytes = 0",
      "project_doc_fallback_filenames = []",
      `sandbox_mode = ${toml(restricted ? "read-only" : "danger-full-access")}`,
      "[tools.experimental_request_user_input]",
      "enabled = false",
      "[skills]",
      "include_instructions = false",
      "[skills.bundled]",
      "enabled = false",
      "[features]",
      ...Object.entries(features).map(([key, value]) => `${key} = ${value}`),
      `[projects.${toml(taskCwd)}]`,
      'trust_level = "untrusted"',
    ];
    for (const [name, server] of Object.entries(servers)) {
      if (
        !/^[a-z][a-z0-9_-]{0,39}$/.test(name) ||
        !object(server) ||
        Object.keys(server).some((key) => !["command", "args"].includes(key)) ||
        typeof server.command !== "string" ||
        !server.command ||
        /[\r\n\0]/.test(server.command) ||
        !Array.isArray(server.args) ||
        server.args.length > 40 ||
        server.args.some(
          (value) =>
            typeof value !== "string" ||
            value.length > 4000 ||
            /[\r\n\0]/.test(value),
        )
      )
        throw new Error("Invalid trusted Codex MCP server.");
      lines.push(
        `[mcp_servers.${name}]`,
        `command = ${toml(server.command)}`,
        `args = ${toml(server.args)}`,
        "required = true",
        "startup_timeout_sec = 30",
        "tool_timeout_sec = 120",
      );
      if (name === "readonly")
        lines.push(
          'enabled_tools = ["read_file", "list_files", "search_files"]',
        );
    }
    writeFileSync(join(home, "auth.json"), auth, { mode: 0o600, flag: "wx" });
    writeFileSync(join(home, "config.toml"), lines.join("\n") + "\n", {
      mode: 0o600,
      flag: "wx",
    });
    const args = [
      "exec",
      "--strict-config",
      "--json",
      "--ephemeral",
      "--ignore-rules",
      "--color",
      "never",
      "--skip-git-repo-check",
      "--cd",
      taskCwd,
      "--output-last-message",
      outputPath,
    ];
    if (schema !== undefined) {
      if (!object(schema) || Buffer.byteLength(JSON.stringify(schema)) > 65536)
        throw new Error("Invalid Codex output schema.");
      const strict = JSON.stringify(strictOutputSchema(schema));
      if (Buffer.byteLength(strict) > 65536)
        throw new Error("Invalid Codex output schema.");
      writeFileSync(schemaPath, strict, {
        mode: 0o600,
        flag: "wx",
      });
      args.push("--output-schema", schemaPath);
    }
    if (ai.model) args.push("--model", ai.model);
    args.push("-");
    const execution = { ...env, CODEX_HOME: home };
    for (const key of Object.keys(execution))
      if (
        (/^(OPENAI|CODEX)_/.test(key) && key !== "CODEX_HOME") ||
        /^(ANTHROPIC_|CLAUDE_CODE_)/.test(key)
      )
        delete execution[key];
    return {
      command: "codex",
      args,
      env: execution,
      home,
      outputPath,
      readResult() {
        if (lstatSync(outputPath).isSymbolicLink())
          throw new Error("Codex final response cannot be a link.");
        const fd = openSync(
          outputPath,
          constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
        );
        try {
          const stat = fstatSync(fd);
          if (
            !stat.isFile() ||
            stat.nlink !== 1 ||
            stat.size < 1 ||
            stat.size > 1024 * 1024
          )
            throw new Error("Codex did not return a bounded final response.");
          const text = new TextDecoder("utf-8", { fatal: true }).decode(
            readFileSync(fd),
          );
          if (!text.trim() || text.includes("\0"))
            throw new Error("Codex did not return a valid final response.");
          return schema === undefined
            ? text
            : JSON.stringify(restoreOutput(JSON.parse(text), schema));
        } finally {
          closeSync(fd);
        }
      },
      cleanup() {
        const within = relative(parent, home);
        if (
          !within ||
          within.startsWith("..") ||
          resolve(parent, within) !== home
        )
          throw new Error("Invalid isolated Codex directory.");
        rmSync(home, { recursive: true, force: true });
      },
    };
  } catch (error) {
    rmSync(home, { recursive: true, force: true });
    throw error;
  }
}
