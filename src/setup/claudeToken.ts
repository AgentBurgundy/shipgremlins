const MAX_RAW_LENGTH = 16 * 1024;
const MAX_TOKEN_LENGTH = 8192;
const MESSAGE =
  "Paste only the Claude Code token from claude setup-token (maximum 8192 characters). Remove extra commands, terminal output, and invisible characters.";

/** This message is safe to show in the dashboard; it never contains pasted input. */
export class ClaudeTokenError extends Error {
  constructor() {
    super(MESSAGE);
    this.name = "ClaudeTokenError";
  }
}

function unquote(value: string): string {
  if (value.startsWith('"') || value.startsWith("'")) {
    if (value.length < 2 || value.at(-1) !== value[0])
      throw new ClaudeTokenError();
    return value.slice(1, -1).trim();
  }
  return value;
}

/**
 * Interpret a few clipboard formats as text, never as executable shell syntax.
 * Only recognized Claude tokens can have terminal wrapping joined together.
 */
export function normalizeClaudeToken(raw: string): string {
  if (
    typeof raw !== "string" ||
    raw.length > MAX_RAW_LENGTH ||
    [...raw].some((character) => {
      const code = character.charCodeAt(0);
      return code > 126 || (code < 32 && ![9, 10, 13].includes(code));
    })
  )
    throw new ClaudeTokenError();
  let value = raw.trim();
  if (!value) return "";

  // CMD commonly quotes the entire assignment: set "NAME=value".
  const cmd = /^set[\t ]+"(CLAUDE_CODE_OAUTH_TOKEN[\t ]*=[\s\S]*)"$/.exec(
    value,
  );
  if (cmd) value = cmd[1]!;
  const assignment =
    /^(?:(?:export|set)[\t ]+|\$env:)?CLAUDE_CODE_OAUTH_TOKEN[\t ]*=[\t ]*/.exec(
      value,
    );
  if (assignment) value = value.slice(assignment[0].length).trim();
  value = unquote(value);
  if (!value) throw new ClaudeTokenError();

  // Reject wrong-key assignments instead of storing them as an opaque token.
  // Trailing '=' padding on an otherwise opaque bearer token remains supported.
  if (/^[A-Za-z_][A-Za-z0-9_]*[\t ]*=+[^=]/.test(value))
    throw new ClaudeTokenError();

  const compact = value.replace(/[\t\r\n ]/g, "");
  const claude = /^sk-ant-[A-Za-z0-9_-]+$/.test(compact);
  if (compact.includes("sk-ant-", compact.indexOf("sk-ant-") + 7))
    throw new ClaudeTokenError();
  if (claude) value = compact;

  // The bearer-token alphabet preserves ordinary opaque tokens and JWT/base64
  // forms, while excluding shell operators, prose, quoting, and escape syntax.
  if (value.length > MAX_TOKEN_LENGTH || !/^[A-Za-z0-9._~+/-]+=*$/.test(value))
    throw new ClaudeTokenError();
  return value;
}
