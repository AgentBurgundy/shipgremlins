import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readConnections, saveConnections } from "../setup/connections.ts";
import {
  aiCredentials,
  aiSecretValues,
  aiStatus,
  codexWorkerAuth,
  hasAiCredentials,
  normalizeCodexAuth,
  readAiSelection,
  resolveAiSelection,
  saveCodexRefreshOrigin,
  saveAiSelection,
  selectedAiCredential,
} from "./provider.ts";

const roots: string[] = [];
const root = () => {
  const directory = mkdtempSync(join(tmpdir(), "gremlins-ai-"));
  roots.push(directory);
  return directory;
};
const auth = (overrides: object = {}) =>
  JSON.stringify({
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens: {
      id_token: "synthetic-id-token",
      access_token: "synthetic-access-token",
      refresh_token: "synthetic-refresh-token",
      account_id: "account-123",
    },
    last_refresh: "2026-10-10T01:00:00.000Z",
    ...overrides,
  });
afterEach(() => {
  for (const directory of roots.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("workspace AI provider selection", () => {
  it("preserves Claude default, selects Codex only when it alone is connected, and honors an explicit selection", () => {
    const directory = root();
    expect(resolveAiSelection(directory, {})).toEqual({ provider: "claude" });
    expect(hasAiCredentials(directory, {})).toBe(false);
    expect(resolveAiSelection(directory, { CODEX_AUTH_JSON: auth() })).toEqual({
      provider: "codex",
    });
    expect(
      resolveAiSelection(directory, {
        CODEX_AUTH_JSON: auth(),
        CLAUDE_CODE_OAUTH_TOKEN: "claude-token",
      }),
    ).toEqual({ provider: "claude" });
    saveAiSelection(directory, { provider: "claude", model: "sonnet" });
    expect(readAiSelection(directory)).toEqual({
      provider: "claude",
      model: "sonnet",
    });
    expect(hasAiCredentials(directory, { CODEX_AUTH_JSON: auth() })).toBe(
      false,
    );
    expect(
      selectedAiCredential(directory, { CODEX_AUTH_JSON: auth() }),
    ).toBeUndefined();
    expect(() => aiCredentials(directory, { CODEX_AUTH_JSON: auth() })).toThrow(
      /Claude Code/,
    );
  });
  it("passes only the selected provider and strips Codex refresh credentials", () => {
    const directory = root(),
      env = {
        CODEX_AUTH_JSON: auth(),
        CLAUDE_CODE_OAUTH_TOKEN: "claude-token",
        OPENAI_API_KEY: "never-api",
      };
    saveAiSelection(directory, { provider: "codex", model: "gpt-6.1-sol" });
    const selected = selectedAiCredential(directory, env)!;
    expect(selected.ai).toEqual({ provider: "codex", model: "gpt-6.1-sol" });
    expect(Object.keys(aiCredentials(directory, env))).toEqual([
      "CODEX_AUTH_JSON",
    ]);
    expect(
      JSON.parse(aiCredentials(directory, env).CODEX_AUTH_JSON!).tokens,
    ).toEqual(JSON.parse(selected.credential).tokens);
    const scoped = JSON.parse(selected.credential);
    expect(scoped.tokens.refresh_token).toBe("");
    expect(scoped.tokens.access_token).toBe("synthetic-access-token");
    expect(scoped.OPENAI_API_KEY).toBeNull();
    expect(Date.parse(scoped.last_refresh)).toBeGreaterThan(Date.now() - 5000);
    expect(
      normalizeCodexAuth(selected.credential, { requireRefresh: false }),
    ).toBe(selected.credential);
    expect(() => normalizeCodexAuth(selected.credential)).toThrow(
      /ChatGPT account/,
    );
  });
  it("stores compact account auth without unrelated fields, preserves other connections, and returns a secret-free status", () => {
    const directory = root();
    saveConnections(directory, {
      GITHUB_TOKEN: "keep-source",
      CODEX_AUTH_JSON: auth({ unexpected: "drop-me" }),
    });
    expect(readConnections(directory).CODEX_AUTH_JSON).toBe(auth());
    expect(readConnections(directory).GITHUB_TOKEN).toBe("keep-source");
    expect(readFileSync(join(directory, ".env"), "utf8")).not.toContain(
      "drop-me",
    );
    expect(aiStatus(directory, {})).toMatchObject({
      provider: "codex",
      configured: true,
      providers: { codex: { configured: true }, claude: { configured: false } },
    });
    expect(JSON.stringify(aiStatus(directory, {}))).not.toMatch(
      /synthetic-|account-123/,
    );
    expect(
      aiSecretValues({
        CODEX_AUTH_JSON: auth(),
        CLAUDE_CODE_OAUTH_TOKEN: "claude-secret",
      }),
    ).toEqual(
      expect.arrayContaining([
        auth(),
        "synthetic-id-token",
        "synthetic-access-token",
        "synthetic-refresh-token",
        "claude-secret",
      ]),
    );
  });
  it.each([
    "not-json",
    auth({ auth_mode: "apikey", OPENAI_API_KEY: "private-api-key" }),
    auth({ auth_mode: "chatgptAuthTokens" }),
    auth({ OPENAI_API_KEY: "private-api-key" }),
    auth({
      tokens: {
        id_token: "id",
        access_token: "access",
        refresh_token: "refresh",
        account_id: "../wrong",
      },
    }),
    auth({
      tokens: {
        id_token: "id",
        access_token: "with\nnewline",
        refresh_token: "refresh",
        account_id: "account",
      },
    }),
    auth({
      tokens: {
        id_token: "id",
        access_token: "access",
        refresh_token: "",
        account_id: "account",
      },
    }),
    auth({ last_refresh: "invalid" }),
    auth({ oversized: "x".repeat(65537) }),
  ])(
    "rejects incompatible or unsafe caches without leaking the imported text",
    (raw) => {
      const directory = root();
      expect(() =>
        saveConnections(directory, { CODEX_AUTH_JSON: raw }),
      ).toThrow(/managed auth.json/);
      expect(
        hasAiCredentials(directory, {
          CODEX_AUTH_JSON: raw,
          OPENAI_API_KEY: "api-does-not-count",
        }),
      ).toBe(false);
      expect(() => codexWorkerAuth(raw)).toThrow(/ChatGPT account/);
      expect(readConnections(directory)).toEqual({});
    },
  );
  it.each([
    { provider: "openai" },
    { provider: "codex", model: "--unsafe" },
    { provider: "codex", model: "x\nmalicious" },
    { provider: "claude", secret: "wrong" },
  ])("rejects invalid selections", (input) => {
    expect(() => saveAiSelection(root(), input)).toThrow(/Choose Claude Code/);
  });
  it("fails closed on unreadable saved selection rather than silently changing providers", () => {
    const directory = root();
    mkdirSync(join(directory, ".run", "ai"), { recursive: true });
    writeFileSync(join(directory, ".run", "ai", "selection.json"), "{");
    expect(() =>
      resolveAiSelection(directory, { CODEX_AUTH_JSON: auth() }),
    ).toThrow(/could not be read/);
  });
  it("preserves exported Claude precedence and binds Codex refresh descendants to the unchanged exported seed", () => {
    const directory = root();
    const seed = auth(),
      refreshed = auth({
        tokens: {
          id_token: "id-refreshed",
          access_token: "access-refreshed",
          refresh_token: "refresh-refreshed",
          account_id: "account-123",
        },
      });
    saveConnections(directory, {
      CLAUDE_CODE_OAUTH_TOKEN: "saved-claude",
      CODEX_AUTH_JSON: refreshed,
    });
    expect(
      aiCredentials(directory, { CLAUDE_CODE_OAUTH_TOKEN: "exported-claude" }),
    ).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: "exported-claude" });
    saveAiSelection(directory, { provider: "codex" });
    expect(
      JSON.parse(
        aiCredentials(directory, { CODEX_AUTH_JSON: seed }).CODEX_AUTH_JSON!,
      ).tokens.access_token,
    ).toBe("synthetic-access-token");
    saveCodexRefreshOrigin(directory, seed, refreshed);
    expect(
      JSON.parse(
        aiCredentials(directory, { CODEX_AUTH_JSON: seed }).CODEX_AUTH_JSON!,
      ).tokens.access_token,
    ).toBe("access-refreshed");
    const replacement = auth({
      tokens: {
        id_token: "id-new-account",
        access_token: "access-new-account",
        refresh_token: "refresh-new-account",
        account_id: "account-456",
      },
    });
    expect(
      JSON.parse(
        aiCredentials(directory, { CODEX_AUTH_JSON: replacement })
          .CODEX_AUTH_JSON!,
      ).tokens.access_token,
    ).toBe("access-new-account");
    saveConnections(directory, { CODEX_AUTH_JSON: seed });
    expect(
      JSON.parse(
        aiCredentials(directory, { CODEX_AUTH_JSON: seed }).CODEX_AUTH_JSON!,
      ).tokens.access_token,
    ).toBe("synthetic-access-token");
  });
});
