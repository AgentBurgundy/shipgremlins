import { afterEach, describe, expect, it } from "vitest";
import {
  copyFileSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { initializeSetup } from "../setup/files.ts";
import { createOAuthConnection, sealOAuthEnvelope } from "./connection.ts";
import { createOAuthStore, type SavedConnection } from "./storage.ts";
import {
  createConnectionProfile,
  listConnectionIds,
  listConnectionProfiles,
  normalizeConnectionId,
  updateConnectionProfileLabel,
  validConnectionId,
  deleteConnectionProfile,
} from "./profiles.ts";
import type { OAuthProvider } from "./types.ts";

const roots: string[] = [];
function root() {
  const value = mkdtempSync(join(realpathSync(tmpdir()), "gremlins-profiles-"));
  roots.push(value);
  return value;
}
afterEach(() => {
  for (const value of roots.splice(0))
    rmSync(value, { recursive: true, force: true });
});
const now = Date.now();

function project(directory: string, values: Record<string, unknown>) {
  initializeSetup(
    directory,
    fileURLToPath(new URL("../../", import.meta.url)),
    { project: "shop", repo: "owner/shop", hubRepo: "owner/hub" },
  );
  const file = join(directory, "projects/shop/project.json");
  writeFileSync(
    file,
    JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), ...values }),
  );
}
async function seed(
  directory: string,
  provider: OAuthProvider,
  id: string,
  workspace = "workspace-a",
) {
  if (id !== "default")
    await createConnectionProfile(directory, {
      provider,
      id,
      label: `Account ${id}`,
    });
  const connection: SavedConnection = {
    accessToken: `secret-${id}`,
    workspace: { id: workspace, name: workspace },
    account: { id: "user-a", name: "User A" },
    leases: [],
    verifiedAt: now,
    expiresAt: now + 86400000,
    ...(provider === "vercel" ? { teamId: workspace } : {}),
  };
  await createOAuthStore(directory, provider, id).locked(
    async (state, save) => {
      state.connection = connection;
      await save(state);
    },
  );
}
function factory(
  directory: string,
  provider: OAuthProvider,
  id = "default",
  fetcher?: typeof fetch,
) {
  return createOAuthConnection(provider, {
    root: directory,
    connectionId: id,
    env: {
      LINEAR_API_KEY: "global-linear-secret",
      VERCEL_TOKEN: "global-vercel-secret",
    },
    now: () => now,
    fetch:
      fetcher ??
      ((async () => {
        throw new Error("Unexpected network access");
      }) as typeof fetch),
  });
}

describe("named encrypted service connections", () => {
  it.each(["linear", "vercel"] as const)(
    "deletes unused %s profiles locally, retires their ID, and preserves other accounts",
    async (provider) => {
      const directory = root();
      await seed(directory, provider, "client");
      await seed(directory, provider, "other");
      const before = readFileSync(
        join(
          directory,
          `.run/oauth/${provider}/connections/other/connection.enc`,
        ),
      );
      await expect(
        deleteConnectionProfile(directory, { provider, id: "client" }),
      ).resolves.toEqual({ ok: true, provider, id: "client" });
      expect(await listConnectionIds(directory, provider)).toEqual([
        "default",
        "other",
      ]);
      expect(
        await createOAuthStore(directory, provider, "client").read(),
      ).toEqual({ schema: 1, deleted: true });
      expect(
        readFileSync(
          join(
            directory,
            `.run/oauth/${provider}/connections/other/connection.enc`,
          ),
        ),
      ).toEqual(before);
      await expect(
        factory(directory, provider, "client").resolveCredential(),
      ).rejects.toMatchObject({ code: "profile_not_found" });
      await expect(
        createConnectionProfile(directory, {
          provider,
          id: "client",
          label: "Rebound account",
        }),
      ).rejects.toMatchObject({ code: "profile_exists" });
      await expect(
        deleteConnectionProfile(directory, { provider, id: "client" }),
      ).resolves.toMatchObject({ ok: true });
    },
  );

  it("blocks default deletion and active leased credentials without changing stored state", async () => {
    const directory = root();
    await seed(directory, "linear", "client");
    await createOAuthStore(directory, "linear", "client").locked(
      async (state, save) => {
        state.connection!.leases = [
          { jobId: "job-active", expiresAt: Date.now() + 60000 },
        ];
        await save(state);
      },
    );
    const file = join(
        directory,
        ".run/oauth/linear/connections/client/connection.enc",
      ),
      before = readFileSync(file);
    await expect(
      deleteConnectionProfile(directory, { provider: "linear", id: "client" }),
    ).rejects.toMatchObject({ code: "refresh_blocked", status: 409 });
    expect(readFileSync(file)).toEqual(before);
    await expect(
      deleteConnectionProfile(directory, { provider: "linear", id: "default" }),
    ).rejects.toMatchObject({ code: "default_profile", status: 409 });
  });

  it.each([
    ["linear", { linear: { connectionId: "client" } }],
    [
      "vercel",
      {
        vercel: {
          connectionId: "client",
          projectId: "prj_shop",
          teamId: null,
          bypassSecret: "VERCEL_BYPASS_SHOP",
        },
      },
    ],
    [
      "vercel",
      {
        environments: {
          candidate: {
            kind: "vercel",
            role: "preview",
            connectionId: "client",
            projectId: "prj_shop",
          },
        },
      },
    ],
  ] as const)(
    "blocks %s references in project configuration, including inactive and legacy environments",
    async (provider, values) => {
      const directory = root();
      await seed(directory, provider, "client");
      project(directory, values);
      await expect(
        deleteConnectionProfile(directory, { provider, id: "client" }),
      ).rejects.toMatchObject({
        code: "profile_in_use",
        status: 409,
        message: expect.stringContaining("selected by a project"),
      });
      expect(
        (await createOAuthStore(directory, provider, "client").read())
          .connection?.accessToken,
      ).toBe("secret-client");
    },
  );

  it("fails closed when another project's references cannot be classified", async () => {
    const directory = root();
    await seed(directory, "linear", "client");
    project(directory, {});
    writeFileSync(
      join(directory, "projects/shop/project.json"),
      "malformed synthetic configuration",
    );
    await expect(
      deleteConnectionProfile(directory, { provider: "linear", id: "client" }),
    ).rejects.toMatchObject({ code: "profile_in_use" });
    expect(
      (await createOAuthStore(directory, "linear", "client").read()).connection
        ?.accessToken,
    ).toBe("secret-client");
  });
  it("validates portable exact IDs before using filesystem paths", () => {
    for (const id of ["default", "work", "client-2", "a".repeat(63)])
      expect(validConnectionId(id)).toBe(true);
    for (const id of [
      "",
      "../work",
      "Work",
      "a/b",
      "a\\b",
      "con",
      "nul",
      "com1",
      "lpt9",
      "1work",
      "a".repeat(64),
      "work.",
      "work ",
      "work:stream",
    ]) {
      expect(validConnectionId(id)).toBe(false);
      expect(() => normalizeConnectionId(id)).toThrow();
    }
    expect(normalizeConnectionId()).toBe("default");
  });
  it("lists defaults without creating or reading global credentials", async () => {
    const directory = root();
    expect(await listConnectionIds(directory, "linear")).toEqual(["default"]);
    expect(await listConnectionProfiles(directory)).toEqual([
      { provider: "linear", id: "default", label: "Default Linear" },
      { provider: "vercel", id: "default", label: "Default Vercel" },
    ]);
  });
  it("stores labels encrypted and returns only safe profile metadata", async () => {
    const directory = root();
    await seed(directory, "linear", "client");
    const bytes = readFileSync(
      join(directory, ".run/oauth/linear/connections/client/connection.enc"),
    );
    expect(bytes.includes(Buffer.from("Account client"))).toBe(false);
    expect(bytes.includes(Buffer.from("secret-client"))).toBe(false);
    expect(await listConnectionProfiles(directory, "linear")).toEqual([
      { provider: "linear", id: "default", label: "Default Linear" },
      { provider: "linear", id: "client", label: "Account client" },
    ]);
    await updateConnectionProfileLabel(directory, {
      provider: "linear",
      id: "client",
      label: "Client workspace",
    });
    expect(
      (await createOAuthStore(directory, "linear", "client").read()).connection
        ?.accessToken,
    ).toBe("secret-client");
    await expect(
      createConnectionProfile(directory, {
        provider: "linear",
        id: "client",
        label: "Replacement",
      }),
    ).rejects.toMatchObject({ status: 409 });
  });
  it.each(["linear", "vercel"] as const)(
    "keeps %s legacy paths/fallback, but named and missing accounts fail closed",
    async (provider) => {
      const directory = root();
      expect(
        await factory(directory, provider).resolveCredential(),
      ).toMatchObject({ method: "token", token: `global-${provider}-secret` });
      await createConnectionProfile(directory, {
        provider,
        id: "second",
        label: "Second",
      });
      expect(
        await factory(directory, provider, "second").status({
          checkAvailability: false,
        }),
      ).toMatchObject({ method: "none", connected: false });
      await expect(
        factory(directory, provider, "second").resolveCredential(),
      ).rejects.toMatchObject({ code: "not_connected" });
      await expect(
        factory(directory, provider, "missing").status({
          checkAvailability: false,
        }),
      ).rejects.toMatchObject({ code: "profile_not_found" });
      await expect(
        factory(directory, provider, "missing").connect(
          "http://127.0.0.1:4311/",
        ),
      ).rejects.toMatchObject({ code: "profile_not_found" });
      await expect(
        factory(directory, provider, "missing").resolveCredential(),
      ).rejects.toMatchObject({ code: "profile_not_found" });
      await seed(directory, provider, "default");
      expect(
        readFileSync(join(directory, `.run/oauth/${provider}/connection.enc`))
          .length,
      ).toBeGreaterThan(28);
      expect(
        await factory(directory, provider).resolveCredential(),
      ).toMatchObject({ token: "secret-default", method: "oauth" });
    },
  );
  it.each(["linear", "vercel"] as const)(
    "isolates %s leases and preserves disconnected profiles",
    async (provider) => {
      const directory = root();
      await seed(directory, provider, "alpha");
      await seed(directory, provider, "beta");
      const alpha = factory(directory, provider, "alpha"),
        beta = factory(directory, provider, "beta");
      await alpha.acquireLease({ jobId: "job-123" });
      await beta.acquireLease({ jobId: "job-123" });
      await alpha.releaseLease("job-123");
      await alpha.disconnect();
      await expect(beta.disconnect()).rejects.toMatchObject({
        code: "refresh_blocked",
      });
      expect(
        (await createOAuthStore(directory, provider, "beta").read()).connection
          ?.leases,
      ).toHaveLength(1);
      expect(await listConnectionIds(directory, provider)).toEqual([
        "default",
        "alpha",
        "beta",
      ]);
      expect(
        (await listConnectionProfiles(directory, provider)).find(
          (item) => item.id === "alpha",
        )?.label,
      ).toBe("Account alpha");
      expect(await alpha.status({ checkAvailability: false })).toMatchObject({
        connected: false,
        method: "none",
      });
      for (const id of await listConnectionIds(directory, provider))
        await factory(directory, provider, id).releaseLease("job-123");
      await beta.disconnect();
    },
  );
  it("rejects a copied encrypted state even when its encryption key was copied too", async () => {
    const directory = root();
    await seed(directory, "linear", "alpha");
    await seed(directory, "linear", "beta");
    const base = join(directory, ".run/oauth/linear/connections");
    for (const name of ["key", "connection.enc"])
      copyFileSync(join(base, "alpha", name), join(base, "beta", name));
    await expect(
      factory(directory, "linear", "beta").status({ checkAvailability: false }),
    ).rejects.toMatchObject({ code: "storage_error" });
  });
  it("refuses symbolic-link profile directories without reading external state", async () => {
    const directory = root(),
      other = root();
    await seed(directory, "linear", "alpha");
    symlinkSync(
      other,
      join(directory, ".run/oauth/linear/connections/linked"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await expect(listConnectionIds(directory, "linear")).rejects.toMatchObject({
      code: "storage_error",
    });
    await expect(
      factory(directory, "linear", "linked").status({
        checkAvailability: false,
      }),
    ).rejects.toMatchObject({ code: "storage_error" });
  });
  it("pins Linear OAuth credentials to the project workspace before provider calls", async () => {
    const directory = root();
    await seed(directory, "linear", "client");
    const connection = factory(directory, "linear", "client");
    await expect(
      connection.acquireLease({ jobId: "job-a", workspaceId: "workspace-b" }),
    ).rejects.toMatchObject({ code: "workspace_mismatch" });
    expect(
      (await createOAuthStore(directory, "linear", "client").read()).connection
        ?.leases,
    ).toEqual([]);
    expect(
      await connection.resolveCredential({ workspaceId: "workspace-a" }),
    ).toMatchObject({ workspaceId: "workspace-a", token: "secret-client" });
  });
  it("verifies a manually configured Linear token before honoring a workspace pin", async () => {
    const directory = root();
    const fetcher = (async (_url, init) => {
      expect(new Headers(init?.headers).get("authorization")).toBe(
        "global-linear-secret",
      );
      return new Response(
        JSON.stringify({
          data: {
            viewer: { id: "user-a", name: "User A" },
            organization: { id: "workspace-a", name: "Workspace A" },
          },
        }),
      );
    }) as typeof fetch;
    const connection = factory(directory, "linear", "default", fetcher);
    await expect(
      connection.resolveCredential({ workspaceId: "workspace-b" }),
    ).rejects.toMatchObject({ code: "workspace_mismatch" });
    expect(
      await connection.resolveCredential({ workspaceId: "workspace-a" }),
    ).toMatchObject({ method: "token", workspaceId: "workspace-a" });
  });
  it("binds OAuth completion to the selected pending profile and leaves other profiles intact", async () => {
    const directory = root();
    const posts: Array<{ key: string; nonce: string }> = [];
    const fetcher = (async (url, init) => {
      const target = String(url);
      let data: unknown;
      if (target.endsWith("/api/vercel/connect")) {
        posts.push(JSON.parse(String(init?.body)));
        data = {
          url: "https://shipgremlins.ai/api/vercel/authorize?request=test",
        };
      } else if (target.startsWith("https://api.vercel.com/v2/teams/"))
        data = { id: "team-a", name: "Team A" };
      else if (target.startsWith("https://api.vercel.com/v9/projects?"))
        data = { projects: [] };
      else throw new Error("Unexpected provider request");
      return new Response(JSON.stringify(data));
    }) as typeof fetch;
    await createConnectionProfile(directory, {
      provider: "vercel",
      id: "alpha",
      label: "Alpha",
    });
    await createConnectionProfile(directory, {
      provider: "vercel",
      id: "beta",
      label: "Beta",
    });
    const alpha = factory(directory, "vercel", "alpha", fetcher),
      beta = factory(directory, "vercel", "beta", fetcher);
    await alpha.connect("http://127.0.0.1:4311/");
    await beta.connect("http://127.0.0.1:4311/");
    const post = posts[0]!;
    const envelope = sealOAuthEnvelope(
      "vercel",
      {
        nonce: post.nonce,
        expires: now + 600000,
        connection: {
          accessToken: "alpha-install-secret",
          teamId: "team-a",
          userId: "user-a",
          configurationId: "install-a",
        },
      },
      Buffer.from(post.key, "base64url"),
    );
    await expect(beta.complete(envelope)).rejects.toMatchObject({
      code: "invalid_envelope",
    });
    expect(
      (await createOAuthStore(directory, "vercel", "beta").read()).pending,
    ).toBeDefined();
    expect(await alpha.complete(envelope)).toMatchObject({
      connected: true,
      workspace: { id: "team-a" },
    });
    expect(await beta.status({ checkAvailability: false })).toMatchObject({
      connected: false,
    });
    expect(
      (await createOAuthStore(directory, "vercel", "alpha").read()).label,
    ).toBe("Alpha");
  });
});
