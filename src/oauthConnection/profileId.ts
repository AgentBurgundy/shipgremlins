import { OAuthConnectionError } from "./types.ts";

export function validConnectionId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[a-z][a-z0-9-]{0,62}$/.test(value) &&
    !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/.test(value)
  );
}

export function normalizeConnectionId(value?: string): string {
  const id = value ?? "default";
  if (!validConnectionId(id))
    throw new OAuthConnectionError(
      "Use a connection ID starting with a lowercase letter, followed by letters, numbers, or hyphens.",
    );
  return id;
}
