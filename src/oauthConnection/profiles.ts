import { readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { listProjectNames, loadProject } from "../config.ts";
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
      if (state.deleted)
        throw new OAuthConnectionError(
          "That saved account ID was deleted. Choose a new ID so old project or job references cannot select a different account.",
          "profile_exists",
          409,
        );
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

/** Caller must hold the controller's global configuration-mutation guard. */
export async function deleteConnectionProfile(
  root: string,
  input: { provider: OAuthProvider; id: string },
): Promise<{ ok: true; provider: OAuthProvider; id: string }> {
  validProvider(input.provider);
  const id = normalizeConnectionId(input.id);
  if (id === "default")
    throw new OAuthConnectionError(
      "The default account cannot be deleted. Use Disconnect or clear its saved API token instead.",
      "default_profile",
      409,
    );
  return createOAuthStore(root, input.provider, id).locked(
    async (state, save) => {
      if (state.deleted) return { ok: true, provider: input.provider, id };
      if (state.label === undefined)
        throw new OAuthConnectionError(
          "This saved connection no longer exists.",
          "profile_not_found",
          404,
        );
      if (
        state.connection?.leases.some((lease) => lease.expiresAt > Date.now())
      )
        throw new OAuthConnectionError(
          "Wait for jobs using this account to finish before deleting it.",
          "refresh_blocked",
          409,
        );
      let referenced = false;
      try {
        safeOAuthPath(join(root, "projects"));
        for (const name of listProjectNames(root)) {
          for (const file of ["project.json", "areas.json", "tiers.json"])
            safeOAuthPath(join(root, "projects", name, file));
          const { config } = loadProject(root, name);
          referenced ||=
            input.provider === "linear"
              ? config.linear?.connectionId === id
              : config.vercel?.connectionId === id ||
                Object.values(config.environments ?? {}).some(
                  (target) =>
                    target.kind === "vercel" && target.connectionId === id,
                );
        }
      } catch {
        throw new OAuthConnectionError(
          "Project references could not be checked safely. Repair the project configuration before deleting saved accounts.",
          "profile_in_use",
          409,
        );
      }
      if (referenced)
        throw new OAuthConnectionError(
          "This saved account is selected by a project. Choose another account in that project's settings before deleting it.",
          "profile_in_use",
          409,
        );
      // One atomic encrypted replacement removes label, tokens and pending OAuth state.
      // Keep a token-free tombstone so stale references cannot bind to a reused ID.
      await save({ schema: 1, deleted: true });
      return { ok: true, provider: input.provider, id };
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
