import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createOAuthStore, safeOAuthPath } from "./storage.ts";
import { normalizeConnectionId, validConnectionId } from "./profileId.ts";
import { OAuthConnectionError, type OAuthProvider } from "./types.ts";
export { normalizeConnectionId, validConnectionId } from "./profileId.ts";

export interface ConnectionProfile {
  provider: OAuthProvider;
  id: string;
  label: string;
}
function validProvider(provider: OAuthProvider) {
  if (provider !== "linear" && provider !== "vercel")
    throw new OAuthConnectionError("Invalid OAuth provider.");
}
function labelValue(value: string) {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.trim().length > 100 ||
    [...value].some(
      (character) =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
  )
    throw new OAuthConnectionError(
      "Use a connection name between 1 and 100 characters.",
    );
  return value.trim();
}
export async function listConnectionIds(
  root: string,
  provider: OAuthProvider,
): Promise<string[]> {
  validProvider(provider);
  const directory = safeOAuthPath(
    join(resolve(root), ".run", "oauth", provider, "connections"),
  );
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return ["default"];
    throw new OAuthConnectionError(
      "Saved connection profiles could not be listed.",
      "storage_error",
    );
  }
  const ids = ["default"];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!validConnectionId(entry.name) || entry.name === "default") continue;
    safeOAuthPath(join(directory, entry.name));
    if (!entry.isDirectory()) continue;
    const state = await createOAuthStore(root, provider, entry.name).read();
    if (state.label !== undefined) ids.push(entry.name);
  }
  return ids;
}
export async function listConnectionProfiles(
  root: string,
  provider?: OAuthProvider,
): Promise<ConnectionProfile[]> {
  const providers: OAuthProvider[] = provider
    ? [provider]
    : ["linear", "vercel"];
  const result: ConnectionProfile[] = [];
  for (const item of providers) {
    for (const id of await listConnectionIds(root, item)) {
      const state = await createOAuthStore(root, item, id).read();
      result.push({
        provider: item,
        id,
        label:
          state.label ?? `Default ${item === "linear" ? "Linear" : "Vercel"}`,
      });
    }
  }
  return result;
}
export async function createConnectionProfile(
  root: string,
  input: ConnectionProfile,
): Promise<ConnectionProfile> {
  validProvider(input.provider);
  const id = normalizeConnectionId(input.id),
    label = labelValue(input.label);
  if (id === "default")
    throw new OAuthConnectionError(
      "The default connection already exists.",
      "profile_exists",
      409,
    );
  return createOAuthStore(root, input.provider, id).locked(
    async (state, save) => {
      if (state.label !== undefined || state.connection || state.pending)
        throw new OAuthConnectionError(
          "That connection ID already exists. Choose another name.",
          "profile_exists",
          409,
        );
      state.label = label;
      await save(state);
      return { provider: input.provider, id, label };
    },
  );
}
export async function updateConnectionProfileLabel(
  root: string,
  input: ConnectionProfile,
): Promise<ConnectionProfile> {
  validProvider(input.provider);
  const id = normalizeConnectionId(input.id),
    label = labelValue(input.label);
  return createOAuthStore(root, input.provider, id).locked(
    async (state, save) => {
      if (id !== "default" && state.label === undefined)
        throw new OAuthConnectionError(
          "This saved connection no longer exists.",
          "profile_not_found",
          404,
        );
      state.label = label;
      await save(state);
      return { provider: input.provider, id, label };
    },
  );
}
