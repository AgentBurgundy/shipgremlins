import { describe, expect, it } from "vitest";
import { ClaudeTokenError, normalizeClaudeToken } from "./claudeToken.ts";

const token = `sk-ant-oat01-${"Az1_b-C9".repeat(18)}`;

describe("normalizeClaudeToken", () => {
  it.each([
    token,
    ` \r\n${token}\r\n\t`,
    `"${token}"`,
    `'${token}'`,
    `CLAUDE_CODE_OAUTH_TOKEN=${token}`,
    `CLAUDE_CODE_OAUTH_TOKEN = '${token}'`,
    `export CLAUDE_CODE_OAUTH_TOKEN="${token}"`,
    `$env:CLAUDE_CODE_OAUTH_TOKEN = '${token}'`,
    `set CLAUDE_CODE_OAUTH_TOKEN=${token}`,
    `set "CLAUDE_CODE_OAUTH_TOKEN=${token}"`,
    `${token.slice(0, 70)}\r\n${token.slice(70)}`,
    `${token.slice(0, 70)}  \t${token.slice(70)}`,
    `export CLAUDE_CODE_OAUTH_TOKEN='${token.slice(0, 70)}\n${token.slice(70)}'`,
  ])(
    "normalizes a synthetic Claude clipboard format without changing its token",
    (raw) => {
      expect(normalizeClaudeToken(raw)).toBe(token);
    },
  );

  it.each([
    "opaque-token_123",
    "sk-ant-test",
    "opaque.jwt.signature",
    "YWJjZA==",
    "a+b/c~d_e-f.1=",
    "a".repeat(8192),
  ])("keeps an ordinary bare opaque credential", (value) => {
    expect(normalizeClaudeToken(value)).toBe(value);
  });

  it.each(["", " ", "\r\n\t "])("keeps blank input a no-op", (value) => {
    expect(normalizeClaudeToken(value)).toBe("");
  });

  it.each([
    `OTHER_TOKEN=${token}`,
    `export OTHER_TOKEN=${token}`,
    `$env:OTHER_TOKEN='${token}'`,
    "CLAUDE_CODE_OAUTH_TOKEN=",
    'CLAUDE_CODE_OAUTH_TOKEN=""',
    "''",
    `"${token}'`,
    `"${token}`,
    `${token}"`,
    "'\"opaque-token\"'",
    `\`${token}\``,
    `Bearer ${token}`,
    `Your OAuth token:\n${token}`,
    `${token}\n${token}`,
    `${token}${token}`,
    `CLAUDE_CODE_OAUTH_TOKEN=${token}\nOTHER=unexpected`,
    `export CLAUDE_CODE_OAUTH_TOKEN=${token}; echo unsafe`,
    `$env:CLAUDE_CODE_OAUTH_TOKEN="${token}"; whoami`,
    "$(echo unsafe)",
    "opaque\\nescaped",
    "opaque\ntoken",
    "opaque token",
    `${token}\u200b`,
    `\uFEFF${token}`,
    `${token}\u00a0`,
    `${token}\u202e`,
    `${token}\0`,
    `${token}\x1b[0m`,
    `${token}\x7f`,
    "nonascii-é",
    "a".repeat(8193),
    " ".repeat(16 * 1024 + 1),
  ])("rejects ambiguous or unsafe pasted input without echoing it", (raw) => {
    expect(() => normalizeClaudeToken(raw)).toThrow(ClaudeTokenError);
    try {
      normalizeClaudeToken(raw);
    } catch (error) {
      expect(error).toBeInstanceOf(ClaudeTokenError);
      expect((error as Error).message).toBe(new ClaudeTokenError().message);
      expect((error as Error).message).not.toContain(token);
      expect((error as Error).stack).not.toContain(token);
    }
  });
});
