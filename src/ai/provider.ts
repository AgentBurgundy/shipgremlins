import { existsSync, readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { readConnections } from "../setup/connections.ts";
import { assertNoSymlinks } from "../setup/files.ts";
import { writePrivate } from "../remoteWorkers/storage.ts";
import { readAiRouting, type AiRoutingTarget } from "./routing.ts";

export type AiProvider = "claude" | "codex";
export interface AiSelection {
  provider: AiProvider;
  model?: string;
}
export class AiProviderError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "AiProviderError";
  }
}
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const AUTH_MESSAGE =
  "Connect Codex with your ChatGPT account, or import its managed auth.json file (maximum 64 KiB). API-key and external-token logins are not supported here.";

/** Project only known ChatGPT account fields; never preserve arbitrary auth-file settings. */
export function normalizeCodexAuth(
  raw: string,
  options: { requireRefresh?: boolean } = {},
): string {
  try {
    if (typeof raw !== "string" || Buffer.byteLength(raw) > 65536)
      throw Error();
    const value: unknown = JSON.parse(raw);
    if (
      !object(value) ||
      value.auth_mode !== "chatgpt" ||
      !object(value.tokens)
    )
      throw Error();
    if (value.OPENAI_API_KEY !== undefined && value.OPENAI_API_KEY !== null)
      throw Error();
    const tokens = value.tokens;
    const token = (key: string, required: boolean) => {
      const item = tokens[key];
      if (
        typeof item !== "string" ||
        item.length > 16384 ||
        (required && !item) ||
        /[^A-Za-z0-9._~+/-]/.test(item.replace(/=+$/, ""))
      )
        throw Error();
      return item;
    };
    const id_token = token("id_token", true),
      access_token = token("access_token", true),
      refresh_token = token("refresh_token", options.requireRefresh !== false);
    if (
      typeof tokens.account_id !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(tokens.account_id) ||
      (value.last_refresh !== undefined &&
        value.last_refresh !== null &&
        (typeof value.last_refresh !== "string" ||
          !Number.isFinite(Date.parse(value.last_refresh))))
    )
      throw Error();
    return JSON.stringify({
      auth_mode: "chatgpt",
      OPENAI_API_KEY: null,
      tokens: {
        id_token,
        access_token,
        refresh_token,
        account_id: tokens.account_id,
      },
      ...(typeof value.last_refresh === "string"
        ? { last_refresh: new Date(value.last_refresh).toISOString() }
        : {}),
    });
  } catch {
    throw new AiProviderError(AUTH_MESSAGE);
  }
}

/** Model-capable workers cannot rotate the controller's refresh token. */
export function codexWorkerAuth(raw: string): string {
  const auth = JSON.parse(normalizeCodexAuth(raw));
  auth.tokens.refresh_token = "";
  auth.last_refresh = new Date().toISOString();
  return JSON.stringify(auth);
}

/** Include component tokens because agents may echo a token without the enclosing JSON. */
export function aiSecretValues(env: NodeJS.ProcessEnv): string[] {
  const values = [env.CLAUDE_CODE_OAUTH_TOKEN, env.CODEX_AUTH_JSON].filter(
    (value): value is string => typeof value === "string" && !!value,
  );
  if (env.CODEX_AUTH_JSON && Buffer.byteLength(env.CODEX_AUTH_JSON) <= 65536) {
    try {
      const auth: unknown = JSON.parse(env.CODEX_AUTH_JSON);
      if (object(auth) && object(auth.tokens))
        for (const name of ["id_token", "access_token", "refresh_token"])
          if (typeof auth.tokens[name] === "string" && auth.tokens[name])
            values.push(auth.tokens[name]);
    } catch {
      // Malformed input is still redacted as a whole and never makes credentials available.
    }
  }
  return [...new Set(values)];
}
const selectionFile = (root: string) =>
  join(resolve(root), ".run", "ai", "selection.json");
export function parseAiSelection(input: unknown): AiSelection {
  if (
    !object(input) ||
    Object.keys(input).some((key) => !["provider", "model"].includes(key)) ||
    !["claude", "codex"].includes(String(input.provider)) ||
    (input.model !== undefined &&
      (typeof input.model !== "string" ||
        !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/.test(input.model)))
  )
    throw new AiProviderError(
      "Choose Claude Code or Codex and an optional model ID.",
    );
  return {
    provider: input.provider as AiProvider,
    ...(input.model ? { model: String(input.model) } : {}),
  };
}
export function readAiSelection(root: string): AiSelection | undefined {
  const file = selectionFile(root);
  try {
    assertNoSymlinks(file);
    if (!existsSync(file)) return undefined;
    if (!statSync(file).isFile() || statSync(file).size > 2048) throw Error();
    return parseAiSelection(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    throw new AiProviderError(
      "The saved AI provider selection could not be read. Choose a provider again in Connections.",
      503,
    );
  }
}
export function saveAiSelection(root: string, input: unknown): AiSelection {
  const value = parseAiSelection(input);
  writePrivate(selectionFile(root), JSON.stringify(value));
  return value;
}
const configured = (provider: AiProvider, values: NodeJS.ProcessEnv) => {
  if (provider === "claude") return !!values.CLAUDE_CODE_OAUTH_TOKEN?.trim();
  try {
    normalizeCodexAuth(values.CODEX_AUTH_JSON ?? "");
    return true;
  } catch {
    return false;
  }
};
const authFingerprint = (raw: string) =>
  createHash("sha256").update(normalizeCodexAuth(raw)).digest("hex");
const originFile = (root: string) =>
  join(resolve(root), ".run", "ai", "codex-origin.json");
function credentials(root: string, env: NodeJS.ProcessEnv) {
  const stored = readConnections(root),
    values = { ...stored, ...env };
  // Exported credentials keep precedence. An unchanged exported seed may use its
  // refreshed descendant, but changing the seed deliberately selects the new account.
  if (env.CODEX_AUTH_JSON && stored.CODEX_AUTH_JSON) {
    try {
      const file = originFile(root);
      assertNoSymlinks(file);
      if (
        existsSync(file) &&
        statSync(file).isFile() &&
        statSync(file).size <= 1024
      ) {
        const saved: unknown = JSON.parse(readFileSync(file, "utf8"));
        if (
          object(saved) &&
          saved.seed === authFingerprint(env.CODEX_AUTH_JSON) &&
          saved.cache === authFingerprint(stored.CODEX_AUTH_JSON)
        )
          values.CODEX_AUTH_JSON = stored.CODEX_AUTH_JSON;
      }
    } catch {
      /* A missing or mismatching lineage never overrides explicit environment input. */
    }
  }
  return values;
}
/** Called only by the trusted refresh helper, never with model-written auth files. */
export function saveCodexRefreshOrigin(
  root: string,
  seed: string | undefined,
  refreshed: string,
): void {
  writePrivate(
    originFile(root),
    JSON.stringify({
      seed: seed ? authFingerprint(seed) : null,
      cache: authFingerprint(refreshed),
    }),
  );
}
export function codexAccountAuth(root: string, env: NodeJS.ProcessEnv): string {
  return normalizeCodexAuth(credentials(root, env).CODEX_AUTH_JSON ?? "");
}
export function resolveWorkspaceAiSelection(
  root: string,
  env: NodeJS.ProcessEnv,
): AiSelection {
  const saved = readAiSelection(root);
  if (saved) return saved;
  const values = credentials(root, env);
  return {
    provider:
      !configured("claude", values) && configured("codex", values)
        ? "codex"
        : "claude",
  };
}
export function resolveAiSelection(
  root: string,
  env: NodeJS.ProcessEnv,
  scope?: AiRoutingTarget,
): AiSelection {
  if (!scope) return resolveWorkspaceAiSelection(root, env);
  const { source: _source, ...selected } = readAiRouting(root, scope, env)
    .effective[scope.role];
  return selected;
}
export function aiCredentialNames(provider: AiProvider): string[] {
  return provider === "codex"
    ? ["CODEX_AUTH_JSON"]
    : ["CLAUDE_CODE_OAUTH_TOKEN"];
}
export function hasAiCredentials(
  root: string,
  env: NodeJS.ProcessEnv,
  selected?: AiSelection,
): boolean {
  return configured(
    (selected ? parseAiSelection(selected) : resolveAiSelection(root, env))
      .provider,
    credentials(root, env),
  );
}
export function aiCredentials(
  root: string,
  env: NodeJS.ProcessEnv,
  selected?: AiSelection,
): Record<string, string> {
  const provider = (
      selected ? parseAiSelection(selected) : resolveAiSelection(root, env)
    ).provider,
    values = credentials(root, env);
  if (!configured(provider, values))
    throw new AiProviderError(
      `Connect ${provider === "codex" ? "Codex with your ChatGPT account" : "Claude Code"} in Connections before running your crew.`,
      409,
    );
  return provider === "codex"
    ? { CODEX_AUTH_JSON: codexWorkerAuth(values.CODEX_AUTH_JSON!) }
    : { CLAUDE_CODE_OAUTH_TOKEN: values.CLAUDE_CODE_OAUTH_TOKEN! };
}
export function selectedAiCredential(
  root: string,
  env: NodeJS.ProcessEnv,
  selected?: AiSelection,
): { ai: AiSelection; credential: string } | undefined {
  const ai = selected
    ? parseAiSelection(selected)
    : resolveAiSelection(root, env);
  if (!hasAiCredentials(root, env, ai)) return undefined;
  return {
    ai,
    credential: aiCredentials(root, env, ai)[
      aiCredentialNames(ai.provider)[0]!
    ]!,
  };
}
export function aiStatus(
  root: string,
  env: NodeJS.ProcessEnv,
  selection?: AiSelection,
) {
  const selected = selection
      ? parseAiSelection(selection)
      : resolveAiSelection(root, env),
    values = credentials(root, env);
  return {
    ...selected,
    configured: configured(selected.provider, values),
    providers: {
      claude: {
        label: "Claude Code",
        configured: configured("claude", values),
      },
      codex: {
        label: "Codex · ChatGPT account",
        configured: configured("codex", values),
      },
    },
  };
}
