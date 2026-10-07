import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { initializeSetup } from "../setup/files.ts";
import * as connections from "../setup/connections.ts";
import { readEditableConfig } from "../setup/configEditor.ts";
import { effectiveVerification } from "../projectCapabilities.ts";
import { loadProject } from "../config.ts";
import type { OAuthCredential } from "../oauthConnection/types.ts";
import { createVercelAccess } from "./access.ts";

const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
const TOKEN = "private-provider-token",
  SECRET = "private-new-bypass",
  FOREIGN = "other-tools-secret";
let root: string;
let services: ReturnType<typeof createVercelAccess>[];
const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });
const configPath = () => join(root, "projects/app/project.json");
const config = () => JSON.parse(readFileSync(configPath(), "utf8"));
const revision = () =>
  readEditableConfig(root, "projects/app/project.json").revision;
function change(edit: (value: ReturnType<typeof config>) => void) {
  const value = config();
  edit(value);
  writeFileSync(configPath(), JSON.stringify(value, null, 2) + "\n");
}
function ref() {
  const verification = effectiveVerification(loadProject(root, "app").config);
  if (verification.mode !== "browser" || verification.target.kind !== "vercel")
    throw new Error("fixture target");
  return verification.target.bypassSecret!;
}
function journals() {
  const directory = join(root, ".run/vercel-access");
  return readdirSync(directory)
    .filter((file) => file.endsWith(".json"))
    .map((file) => ({
      file: join(directory, file),
      text: readFileSync(join(directory, file), "utf8"),
    }));
}
function legacyJournal(state: "connected" | "sent" = "connected") {
  const existing = journals()[0]!,
    journal = JSON.parse(existing.text),
    legacyScope = "a".repeat(64),
    reference = `VERCEL_BYPASS_${legacyScope.toUpperCase()}`,
    path = join(root, ".run/vercel-access", `${legacyScope}.json`);
  change((value) => {
    value.environments.preview.bypassSecret = reference;
  });
  connections.saveConnections(root, { [reference]: SECRET });
  renameSync(existing.file, path);
  writeFileSync(
    path,
    JSON.stringify({
      ...journal,
      state,
      scope: legacyScope,
      secretName: reference,
      configurationRevision: revision(),
    }),
  );
  return reference;
}
beforeEach(() => {
  root = mkdtempSync(join(realpathSync(tmpdir()), "gremlins-vercel-access-"));
  services = [];
  initializeSetup(root, packageRoot, {
    project: "app",
    repo: "owner/app",
    settings: {
      workflow: { kind: "pull-request", baseBranch: "main" },
      verification: { mode: "browser", environment: "preview" },
      environments: {
        preview: {
          kind: "vercel",
          role: "preview",
          projectId: "prj_app",
          teamId: "team_test",
          connectionId: "test",
          branch: "pm-staging",
        },
        production: {
          kind: "url",
          role: "production",
          url: "https://example.com",
        },
      },
    },
  });
});
afterEach(async () => {
  await Promise.allSettled(services.map((service) => service.close()));
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});
function fixture(oauth = false, inferTeam = false) {
  const data: Record<string, unknown> = {
    id: "prj_app",
    name: "app",
    accountId: "team_test",
    link: { type: "github", org: "owner", repo: "app", repoId: 123 },
    ssoProtection: { deploymentType: "preview" },
    passwordProtection: null,
    trustedIps: null,
    protectionBypass: {
      [FOREIGN]: { scope: "automation-bypass", note: "Another tool" },
    },
    env: [{ key: "SECRET", value: "raw-provider-env-do-not-store" }],
  };
  let credential: OAuthCredential = {
    token: TOKEN,
    authorization: `Bearer ${TOKEN}`,
    method: oauth ? "oauth" : "token",
    teamId: "team_test",
    ...(oauth ? { configurationId: "icfg_ours" } : {}),
  };
  const resolveCredential = vi.fn(async () => credential);
  const calls: { url: URL; method: string; body: Record<string, unknown> }[] =
    [];
  let losePatch = false,
    hideCreated = false,
    omitBypassOnRead = false,
    patchStatus = 200;
  let patchError: Record<string, unknown> | undefined;
  let afterPatch: (() => void) | undefined;
  let beforeGet: (() => Promise<void> | void) | undefined;
  let nextGetStatus = 200;
  const fetcher = vi.fn(
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input)),
        method = init?.method ?? "GET",
        body = JSON.parse(String(init?.body ?? "{}"));
      calls.push({ url, method, body });
      expect(url.origin).toBe("https://api.vercel.com");
      expect(url.searchParams.get("teamId")).toBe(
        inferTeam && calls.length === 1 ? null : "team_test",
      );
      expect(init?.redirect).toBe("error");
      expect(init?.headers).toMatchObject({ authorization: `Bearer ${TOKEN}` });
      if (method === "GET") {
        expect(url.pathname).toBe("/v9/projects/prj_app");
        await beforeGet?.();
        if (omitBypassOnRead) {
          const { protectionBypass: _omitted, ...visible } = data;
          return response(visible, nextGetStatus);
        }
        return response(data, nextGetStatus);
      }
      expect(method).toBe("PATCH");
      expect(url.pathname).toBe("/v1/projects/prj_app/protection-bypass");
      expect(body).toEqual({
        generate: {
          note: expect.stringMatching(
            /^ShipGremlins preview access [a-f0-9]{32}$/,
          ),
        },
      });
      if (patchStatus !== 200)
        return response(
          { error: patchError ?? { message: `${SECRET} ${TOKEN}` } },
          patchStatus,
        );
      if (!hideCreated) {
        const entries = data.protectionBypass as Record<string, unknown>;
        entries[SECRET] = oauth
          ? {
              scope: "integration-automation-bypass",
              configurationId: "icfg_ours",
              integrationId: "oac_ours",
              createdAt: Date.now(),
              createdBy: "user_test",
            }
          : {
              scope: "automation-bypass",
              note: (body.generate as { note: string }).note,
              createdAt: Date.now(),
              createdBy: "user_test",
            };
      }
      afterPatch?.();
      if (losePatch) throw new Error(`network lost ${SECRET} ${TOKEN}`);
      return response({ protectionBypass: data.protectionBypass });
    },
  );
  const factory = vi.fn((id?: string) => {
    expect(id).toBe("test");
    return { resolveCredential };
  });
  const create = () => {
    const service = createVercelAccess({
      root,
      vercelConnectionFor: factory,
      fetch: fetcher as typeof fetch,
    });
    services.push(service);
    return service;
  };
  return {
    create,
    data,
    calls,
    fetcher,
    resolveCredential,
    patchCalls: () => calls.filter((call) => call.method === "PATCH"),
    lose: () => {
      losePatch = true;
    },
    hide: () => {
      hideCreated = true;
    },
    status: (value: number) => {
      patchStatus = value;
    },
    reject: (error: Record<string, unknown>, status = 400) => {
      patchStatus = status;
      patchError = error;
    },
    omitBypassOnRead: () => {
      omitBypassOnRead = true;
    },
    getStatus: (value: number) => {
      nextGetStatus = value;
    },
    afterPatch: (fn: () => void) => {
      afterPatch = fn;
    },
    beforeGet: (fn: () => Promise<void> | void) => {
      beforeGet = fn;
    },
    credential: (value: Partial<OAuthCredential>) => {
      credential = { ...credential, ...value };
    },
  };
}

describe("Vercel preview access", () => {
  it("creates a scoped bypass, saves only its reference in config, and retains unrelated settings", async () => {
    const before = config(),
      rev = revision(),
      f = fixture();
    const result = await f
      .create()
      .connect("app", { configurationRevision: rev });
    expect(result.status).toBe("connected");
    expect(f.patchCalls()).toHaveLength(1);
    expect(connections.readConnections(root)[ref()]).toBe(SECRET);
    expect(config()).toEqual({
      ...before,
      verified: null,
      environments: {
        ...before.environments,
        preview: { ...before.environments.preview, bypassSecret: ref() },
      },
    });
    expect(f.resolveCredential).toHaveBeenCalledWith({
      projectId: "prj_app",
      teamId: "team_test",
      minValidityMs: 120000,
    });
    const publicText = JSON.stringify({
      result,
      config: config(),
      journals: journals(),
    });
    for (const secret of [
      SECRET,
      TOKEN,
      FOREIGN,
      "raw-provider-env-do-not-store",
    ])
      expect(publicText).not.toContain(secret);
    expect(JSON.parse(journals()[0]!.text).state).toBe("connected");
    await f.create().connect("app", { configurationRevision: rev });
    expect(f.patchCalls()).toHaveLength(1);
  });

  it("does not change configuration or generate a bypass when protection is explicitly absent", async () => {
    const before = readFileSync(configPath(), "utf8"),
      f = fixture();
    f.data.ssoProtection = null;
    expect(
      await f.create().connect("app", { configurationRevision: revision() }),
    ).toMatchObject({ status: "not_required" });
    expect(f.patchCalls()).toHaveLength(0);
    expect(readFileSync(configPath(), "utf8")).toBe(before);
    expect(ref()).toBeUndefined();
    expect(connections.readConnections(root)).toEqual({});
  });

  it.each([
    "missing fields",
    "password protection",
    "unknown protection",
    "custom environment",
  ])("does not claim public access from %s", async (kind) => {
    const f = fixture();
    f.data.ssoProtection = null;
    if (kind === "missing fields") delete f.data.passwordProtection;
    if (kind === "password protection") f.data.passwordProtection = {};
    if (kind === "unknown protection")
      f.data.passport = { connectorId: "cn_test", deploymentType: "preview" };
    if (kind === "custom environment") {
      f.data.customEnvironments = [{ id: "env_custom", slug: "staging" }];
      change((value) => {
        value.environments.preview.customEnvironmentId = "env_custom";
      });
    }
    expect(
      await f.create().connect("app", { configurationRevision: revision() }),
    ).toMatchObject({ status: "connected" });
    expect(f.patchCalls()).toHaveLength(1);
  });

  it("keeps an existing owner-saved bypass and avoids rotation", async () => {
    change((value) => {
      value.environments.preview.bypassSecret = "EXISTING_PREVIEW_ACCESS";
    });
    connections.saveConnections(root, {
      EXISTING_PREVIEW_ACCESS: "owner-bypass",
    });
    const before = revision(),
      f = fixture();
    expect(
      await f.create().connect("app", { configurationRevision: before }),
    ).toMatchObject({ status: "connected" });
    expect(ref()).toBe("EXISTING_PREVIEW_ACCESS");
    expect(revision()).toBe(before);
    expect(f.patchCalls()).toHaveLength(0);
  });

  it.each([false, true])(
    "recovers a rotated owned bypass without creating another (repair=%s)",
    async (repair) => {
      const f = fixture();
      await f.create().connect("app", { configurationRevision: revision() });
      const reference = ref(),
        rev = revision(),
        entries = f.data.protectionBypass as Record<string, unknown>;
      entries["rotated-owned-bypass"] = entries[SECRET];
      delete entries[SECRET];
      await f.create().connect("app", { configurationRevision: rev, repair });
      expect(connections.readConnections(root)[reference]).toBe(
        "rotated-owned-bypass",
      );
      expect(ref()).toBe(reference);
      expect(revision()).toBe(rev);
      expect(f.patchCalls()).toHaveLength(1);
      expect(JSON.stringify(journals())).not.toContain("rotated-owned-bypass");
    },
  );

  it("keeps managed bypass ownership when app login selectors or accounts change", async () => {
    change((value) => {
      value.environments.preview.access = {
        kind: "password",
        loginPath: "/login",
        usernameSelector: "#email",
        passwordSelector: "#password",
        submitSelector: "button",
        successSelector: "#account",
        accounts: [
          {
            name: "Reader",
            usernameSecret: "TEST_USER",
            passwordSecret: "TEST_PASSWORD",
          },
        ],
      };
    });
    const f = fixture();
    await f.create().connect("app", { configurationRevision: revision() });
    const reference = ref(),
      entries = f.data.protectionBypass as Record<string, unknown>;
    change((value) => {
      value.environments.preview.access.successSelector = "#updated-account";
      value.environments.preview.access.accounts[0].usernameSecret =
        "UPDATED_TEST_USER";
    });
    entries["rotated-after-login-edit"] = entries[SECRET];
    delete entries[SECRET];
    await f.create().connect("app", { configurationRevision: revision() });
    expect(ref()).toBe(reference);
    expect(connections.readConnections(root)[reference]).toBe(
      "rotated-after-login-edit",
    );
    expect(journals()).toHaveLength(1);
    expect(f.patchCalls()).toHaveLength(1);
  });

  it.each([false, true])(
    "migrates an authenticated owned legacy receipt without minting (OAuth=%s)",
    async (oauth) => {
      const f = fixture(oauth);
      await f.create().connect("app", { configurationRevision: revision() });
      const legacy = legacyJournal(),
        entries = f.data.protectionBypass as Record<string, unknown>;
      entries["rotated-legacy-bypass"] = entries[SECRET];
      delete entries[SECRET];
      await f.create().connect("app", { configurationRevision: revision() });
      expect(ref()).not.toBe(legacy);
      expect(connections.readConnections(root)[ref()]).toBe(
        "rotated-legacy-bypass",
      );
      expect(journals()).toHaveLength(2);
      expect(f.patchCalls()).toHaveLength(1);
      delete entries["rotated-legacy-bypass"];
      await f.create().connect("app", { configurationRevision: revision() });
      expect(f.patchCalls()).toHaveLength(2);
      expect(connections.readConnections(root)[ref()]).toBe(SECRET);
    },
  );

  it("does not infer legacy ownership from a stored reference when its remote entry is absent", async () => {
    const f = fixture();
    await f.create().connect("app", { configurationRevision: revision() });
    const legacy = legacyJournal();
    delete (f.data.protectionBypass as Record<string, unknown>)[SECRET];
    await f.create().connect("app", { configurationRevision: revision() });
    expect(ref()).toBe(legacy);
    expect(f.patchCalls()).toHaveLength(1);
    connections.clearConnections(root, [legacy]);
    await expect(
      f.create().connect("app", { configurationRevision: revision() }),
    ).rejects.toMatchObject({
      code: "access_unconfirmed",
      status: 409,
      recovery: "verify_legacy_credential",
    });
    expect(f.patchCalls()).toHaveLength(1);
    await f
      .create()
      .connect("app", { configurationRevision: revision(), repair: true });
    expect(ref()).not.toBe(legacy);
    expect(f.patchCalls()).toHaveLength(2);
  });

  it("never duplicates an unconfirmed legacy operation even during diagnosed repair", async () => {
    const f = fixture();
    await f.create().connect("app", { configurationRevision: revision() });
    const legacy = legacyJournal("sent");
    delete (f.data.protectionBypass as Record<string, unknown>)[SECRET];
    await expect(
      f
        .create()
        .connect("app", { configurationRevision: revision(), repair: true }),
    ).rejects.toMatchObject({ code: "access_pending", recovery: undefined });
    expect(ref()).toBe(legacy);
    expect(f.patchCalls()).toHaveLength(1);
    expect(journals()).toHaveLength(1);
  });

  it.each([undefined, null, []])(
    "does not offer legacy diagnosis recovery with incomplete bypass metadata %j",
    async (metadata) => {
      const f = fixture();
      await f.create().connect("app", { configurationRevision: revision() });
      const legacy = legacyJournal();
      connections.clearConnections(root, [legacy]);
      f.data.protectionBypass = metadata;
      const before = journals(),
        rev = revision();
      await expect(
        f.create().connect("app", { configurationRevision: rev }),
      ).rejects.toMatchObject({
        code: "access_unconfirmed",
        recovery: undefined,
      });
      expect(journals()).toEqual(before);
      expect(revision()).toBe(rev);
      expect(f.patchCalls()).toHaveLength(1);
    },
  );

  it.each([false, true])(
    "recreates a confirmed missing owned bypass once with the same binding (repair=%s)",
    async (repair) => {
      const f = fixture();
      await f.create().connect("app", { configurationRevision: revision() });
      const reference = ref(),
        rev = revision(),
        originalJournal = JSON.parse(journals()[0]!.text),
        entries = f.data.protectionBypass as Record<string, unknown>,
        foreign = structuredClone(entries[FOREIGN]);
      delete entries[SECRET];
      await f.create().connect("app", { configurationRevision: rev, repair });
      await f.create().connect("app", { configurationRevision: rev, repair });
      expect(ref()).toBe(reference);
      expect(revision()).toBe(rev);
      expect(connections.readConnections(root)[reference]).toBe(SECRET);
      expect(f.patchCalls()).toHaveLength(2);
      expect(entries[FOREIGN]).toEqual(foreign);
      expect(JSON.parse(journals()[0]!.text)).toMatchObject({
        state: "connected",
        secretName: reference,
        note: expect.not.stringMatching(originalJournal.note),
      });
    },
  );

  it("repairs an owner-saved binding only when diagnosed and preserves its stored value", async () => {
    change((value) => {
      value.environments.preview.bypassSecret = "EXISTING_PREVIEW_ACCESS";
    });
    connections.saveConnections(root, {
      EXISTING_PREVIEW_ACCESS: "owner-bypass",
    });
    const f = fixture();
    await f.create().connect("app", {
      configurationRevision: revision(),
      repair: true,
    });
    expect(ref()).toMatch(/^VERCEL_BYPASS_[A-F0-9]{64}$/);
    expect(connections.readConnections(root)[ref()]).toBe(SECRET);
    expect(readFileSync(join(root, ".env"), "utf8")).toContain("owner-bypass");
    expect(f.patchCalls()).toHaveLength(1);
    expect(f.data.protectionBypass).toHaveProperty(FOREIGN);
  });

  it.each([false, true])(
    "restores a missing managed local credential (remote removed=%s)",
    async (removed) => {
      const f = fixture();
      await f.create().connect("app", { configurationRevision: revision() });
      const reference = ref(),
        rev = revision();
      connections.clearConnections(root, [reference]);
      if (removed)
        delete (f.data.protectionBypass as Record<string, unknown>)[SECRET];
      await f.create().connect("app", { configurationRevision: rev });
      expect(ref()).toBe(reference);
      expect(revision()).toBe(rev);
      expect(connections.readConnections(root)[reference]).toBe(SECRET);
      expect(f.patchCalls()).toHaveLength(removed ? 2 : 1);
    },
  );

  it.each(["GET", "PATCH"])(
    "does not overwrite a credential changed during repair %s",
    async (phase) => {
      const f = fixture();
      await f.create().connect("app", { configurationRevision: revision() });
      const reference = ref(),
        entries = f.data.protectionBypass as Record<string, unknown>;
      delete entries[SECRET];
      const update = () =>
        connections.saveConnections(root, { [reference]: "newer-owner-value" });
      if (phase === "GET") f.beforeGet(update);
      else f.afterPatch(update);
      await expect(
        f
          .create()
          .connect("app", { configurationRevision: revision(), repair: true }),
      ).rejects.toMatchObject({ status: 409, code: "credential_changed" });
      expect(connections.readConnections(root)[reference]).toBe(
        "newer-owner-value",
      );
      expect(f.patchCalls()).toHaveLength(phase === "GET" ? 1 : 2);
      expect(JSON.parse(journals()[0]!.text).state).toBe(
        phase === "GET" ? "connected" : "sent",
      );
    },
  );

  it.each([false, true])(
    "does not infer missing owned credentials from omitted metadata (repair=%s)",
    async (repair) => {
      const f = fixture();
      await f.create().connect("app", { configurationRevision: revision() });
      const rev = revision(),
        before = journals();
      delete f.data.protectionBypass;
      await expect(
        f.create().connect("app", { configurationRevision: rev, repair }),
      ).rejects.toMatchObject({ status: 409, code: "access_unconfirmed" });
      expect(f.patchCalls()).toHaveLength(1);
      expect(revision()).toBe(rev);
      expect(journals()).toEqual(before);
      expect(connections.readConnections(root)[ref()]).toBe(SECRET);
    },
  );

  it("does not repeat a repair whose generated bypass cannot yet be reconciled", async () => {
    const f = fixture();
    await f.create().connect("app", { configurationRevision: revision() });
    delete (f.data.protectionBypass as Record<string, unknown>)[SECRET];
    f.hide();
    for (let i = 0; i < 2; i++)
      await expect(
        f
          .create()
          .connect("app", { configurationRevision: revision(), repair: true }),
      ).rejects.toMatchObject({ code: "access_pending" });
    expect(f.patchCalls()).toHaveLength(2);
    expect(JSON.parse(journals()[0]!.text).state).toBe("sent");
    expect(connections.readConnections(root)[ref()]).toBe(SECRET);
  });

  it.each(["true", 1, null, {}])(
    "rejects nonboolean repair option %j",
    async (repair) => {
      const f = fixture();
      await expect(
        f.create().connect("app", {
          configurationRevision: revision(),
          repair,
        } as unknown as Parameters<
          ReturnType<typeof createVercelAccess>["connect"]
        >[1]),
      ).rejects.toMatchObject({ status: 400 });
      expect(f.fetcher).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    "recovers a lost response after restart without a duplicate bypass (OAuth=%s)",
    async (oauth) => {
      const f = fixture(oauth),
        rev = revision();
      f.lose();
      await expect(
        f.create().connect("app", { configurationRevision: rev }),
      ).rejects.toMatchObject({ status: 502, code: "provider_response" });
      expect(connections.readConnections(root)[ref()]).toBeUndefined();
      expect(
        await f.create().connect("app", { configurationRevision: rev }),
      ).toMatchObject({ status: "connected" });
      await f.create().connect("app", { configurationRevision: rev });
      expect(f.patchCalls()).toHaveLength(1);
      expect(connections.readConnections(root)[ref()]).toBe(SECRET);
    },
  );

  it("reuses a unique existing installation-owned OAuth bypass and ignores foreign entries", async () => {
    const f = fixture(true);
    (f.data.protectionBypass as Record<string, unknown>)["old-own-secret"] = {
      scope: "integration-automation-bypass",
      configurationId: "icfg_ours",
      integrationId: "oac_ours",
    };
    (f.data.protectionBypass as Record<string, unknown>)[
      "foreign-integration-secret"
    ] = {
      scope: "integration-automation-bypass",
      configurationId: "icfg_foreign",
      integrationId: "oac_other",
    };
    await f.create().connect("app", { configurationRevision: revision() });
    expect(connections.readConnections(root)[ref()]).toBe("old-own-secret");
    expect(f.patchCalls()).toHaveLength(0);
  });

  it("refuses multiple existing bypasses for the saved OAuth installation before any mutation", async () => {
    const f = fixture(true),
      rev = revision();
    for (const key of ["own-secret-one", "own-secret-two"])
      (f.data.protectionBypass as Record<string, unknown>)[key] = {
        scope: "integration-automation-bypass",
        configurationId: "icfg_ours",
        integrationId: "oac_ours",
      };
    await expect(
      f.create().connect("app", { configurationRevision: rev }),
    ).rejects.toMatchObject({ code: "ambiguous_access" });
    expect(f.patchCalls()).toHaveLength(0);
    expect(revision()).toBe(rev);
  });

  it("does not use or create an OAuth bypass when the installation identity is unavailable", async () => {
    const f = fixture(true),
      rev = revision();
    f.credential({ configurationId: undefined });
    await expect(
      f.create().connect("app", { configurationRevision: rev }),
    ).rejects.toMatchObject({ code: "connection", status: 401 });
    expect(f.fetcher).not.toHaveBeenCalled();
    expect(revision()).toBe(rev);
  });

  it("rejects an invalid secret without persisting or returning it", async () => {
    const f = fixture(true),
      rev = revision(),
      invalid = "invalid secret with spaces";
    (f.data.protectionBypass as Record<string, unknown>)[invalid] = {
      scope: "integration-automation-bypass",
      configurationId: "icfg_ours",
      integrationId: "oac_ours",
    };
    await expect(
      f.create().connect("app", { configurationRevision: rev }),
    ).rejects.toMatchObject({
      code: "provider_response",
      message: expect.not.stringContaining(invalid),
    });
    expect(f.patchCalls()).toHaveLength(0);
    expect(revision()).toBe(rev);
  });

  it("does not mint again when a lost response cannot yet be reconciled", async () => {
    const f = fixture(true),
      rev = revision();
    f.hide();
    f.lose();
    await expect(
      f.create().connect("app", { configurationRevision: rev }),
    ).rejects.toMatchObject({ status: 502 });
    (f.data.protectionBypass as Record<string, unknown>)["other-new-secret"] = {
      scope: "integration-automation-bypass",
      configurationId: "icfg_foreign",
      integrationId: "oac_other",
    };
    for (let i = 0; i < 2; i++)
      await expect(
        f.create().connect("app", { configurationRevision: rev }),
      ).rejects.toMatchObject({ status: 409, code: "access_pending" });
    expect(f.patchCalls()).toHaveLength(1);
    expect(connections.readConnections(root)[ref()]).toBeUndefined();
  });

  it("refuses ambiguous matching OAuth additions rather than choosing a secret", async () => {
    const f = fixture(true);
    f.afterPatch(() => {
      (f.data.protectionBypass as Record<string, unknown>)[
        "another-new-secret"
      ] = {
        scope: "integration-automation-bypass",
        configurationId: "icfg_ours",
        integrationId: "oac_ours",
      };
    });
    const rev = revision();
    await expect(
      f.create().connect("app", { configurationRevision: rev }),
    ).rejects.toMatchObject({ code: "ambiguous_access" });
    await expect(
      f.create().connect("app", { configurationRevision: rev }),
    ).rejects.toMatchObject({ code: "ambiguous_access" });
    expect(f.patchCalls()).toHaveLength(1);
    expect(connections.readConnections(root)[ref()]).toBeUndefined();
  });

  it("persists the native-integration restriction without exposing diagnostics or retrying creation", async () => {
    const f = fixture(true),
      rev = revision();
    f.omitBypassOnRead();
    f.reject({
      code: "bad_request",
      message: "Only native integrations can create automation bypass.",
      diagnostic: `${SECRET} ${TOKEN}`,
    });
    for (let attempt = 0; attempt < 3; attempt++) {
      const error = await f
        .create()
        .connect("app", { configurationRevision: rev })
        .catch((error: unknown) => error);
      expect(error).toMatchObject({
        code: "access_manual_required",
        status: 400,
        message: expect.stringContaining(
          "Add a dedicated Protection Bypass for Automation secret",
        ),
      });
      expect(String(error)).not.toContain(SECRET);
      expect(String(error)).not.toContain(TOKEN);
    }
    expect(f.patchCalls()).toHaveLength(1);
    expect(JSON.parse(journals()[0]!.text).state).toBe("manual_required");
    expect(JSON.stringify(journals())).not.toContain(SECRET);
    expect(JSON.stringify(journals())).not.toContain(TOKEN);
    expect(ref()).toMatch(/^VERCEL_BYPASS_[A-F0-9]{64}$/);
    expect(connections.readConnections(root)[ref()]).toBeUndefined();
  });

  it("accepts a one-time owner-supplied secret at the reserved reference for browser verification", async () => {
    const f = fixture(true);
    f.omitBypassOnRead();
    f.reject({
      code: "bad_request",
      message: "Only native integrations can create automation bypass.",
    });
    await expect(
      f.create().connect("app", { configurationRevision: revision() }),
    ).rejects.toMatchObject({ code: "access_manual_required" });
    const reference = ref(),
      rev = revision(),
      receipt = journals();
    connections.saveConnections(root, {
      [reference]: "owner-provided-dedicated-secret",
    });
    expect(
      await f.create().connect("app", { configurationRevision: rev }),
    ).toMatchObject({
      status: "connected",
      message: expect.stringContaining("Test access to verify"),
    });
    expect(config().verified).toBeNull();
    expect(revision()).toBe(rev);
    expect(journals()).toEqual(receipt);
    expect(connections.readConnections(root)[reference]).toBe(
      "owner-provided-dedicated-secret",
    );
    // A subsequent real browser rejection must prompt for the right secret,
    // never repeat an unsupported API operation or replace the supplied value.
    await expect(
      f.create().connect("app", { configurationRevision: rev, repair: true }),
    ).rejects.toMatchObject({ code: "access_manual_required" });
    expect(f.patchCalls()).toHaveLength(1);
    expect(connections.readConnections(root)[reference]).toBe(
      "owner-provided-dedicated-secret",
    );
  });

  it.each([
    [
      false,
      "bad_request",
      "Only native integrations can create automation bypass.",
      "",
    ],
    [
      true,
      "unknown_code",
      "Only native integrations can create automation bypass.",
      "",
    ],
    [
      true,
      "bad_request",
      `Only native integrations can create automation bypass. ${TOKEN}`,
      "",
    ],
    [
      true,
      "bad_request",
      "Only native integrations can create automation bypass.",
      "x".repeat(17_000),
    ],
  ] as const)(
    "does not infer an integration restriction from unrelated or oversized errors (OAuth=%s, code=%s)",
    async (oauth, code, message, details) => {
      const f = fixture(oauth);
      f.reject({ code, message, details });
      await expect(
        f.create().connect("app", { configurationRevision: revision() }),
      ).rejects.toMatchObject({ code: "provider_rejected", status: 400 });
      expect(JSON.parse(journals()[0]!.text).state).toBe("prepared");
      expect(JSON.stringify(journals())).not.toContain(TOKEN);
    },
  );

  it("allows a definite rejected prepared operation to retry when project metadata is filtered", async () => {
    const f = fixture(true),
      rev = revision();
    f.omitBypassOnRead();
    f.status(403);
    await expect(
      f.create().connect("app", { configurationRevision: rev }),
    ).rejects.toMatchObject({ code: "provider_rejected" });
    expect(JSON.parse(journals()[0]!.text).state).toBe("prepared");
    expect(connections.readConnections(root)[ref()]).toBeUndefined();
    f.status(200);
    expect(
      await f.create().connect("app", { configurationRevision: rev }),
    ).toMatchObject({ status: "connected" });
    expect(f.patchCalls()).toHaveLength(2);
    expect(connections.readConnections(root)[ref()]).toBe(SECRET);
    // This exception applies only to definitely unsent/rejected work, not
    // ongoing reconciliation of a managed connected credential.
    await expect(
      f
        .create()
        .connect("app", { configurationRevision: revision(), repair: true }),
    ).rejects.toMatchObject({ code: "access_unconfirmed" });
    expect(f.patchCalls()).toHaveLength(2);
  });

  it("does not retry an uncertain sent operation when OAuth project metadata is filtered", async () => {
    const f = fixture(true),
      rev = revision();
    f.omitBypassOnRead();
    f.lose();
    await expect(
      f.create().connect("app", { configurationRevision: rev }),
    ).rejects.toMatchObject({ status: 502 });
    expect(JSON.parse(journals()[0]!.text).state).toBe("sent");
    await expect(
      f.create().connect("app", { configurationRevision: rev }),
    ).rejects.toMatchObject({ code: "access_unconfirmed" });
    expect(f.patchCalls()).toHaveLength(1);
  });

  it("sanitizes permission failures and allows a definite rejected PATCH to be retried", async () => {
    const f = fixture(),
      rev = revision();
    f.status(403);
    await expect(
      f.create().connect("app", { configurationRevision: rev }),
    ).rejects.toMatchObject({
      status: 403,
      code: "provider_rejected",
      message: expect.stringContaining("administration access"),
    });
    expect(JSON.stringify(journals())).not.toContain(SECRET);
    f.status(200);
    await f.create().connect("app", { configurationRevision: rev });
    expect(f.patchCalls()).toHaveLength(2);
  });

  it("does not reset an uncertain successful PATCH after a reconciliation GET is denied", async () => {
    const f = fixture(),
      rev = revision();
    f.hide();
    f.afterPatch(() => f.getStatus(403));
    await expect(
      f.create().connect("app", { configurationRevision: rev }),
    ).rejects.toMatchObject({ status: 403 });
    f.getStatus(200);
    await expect(
      f.create().connect("app", { configurationRevision: rev }),
    ).rejects.toMatchObject({ code: "access_pending" });
    expect(f.patchCalls()).toHaveLength(1);
  });

  it.each(["wrong revision", "changed config", "recreated project"])(
    "rejects stale access intent: %s",
    async (kind) => {
      const f = fixture(),
        rev = revision();
      if (kind !== "wrong revision")
        f.beforeGet(() =>
          change((value) => {
            if (kind === "recreated project") value.instanceId = randomUUID();
            else value.commands.build = "npm run build";
          }),
        );
      await expect(
        f.create().connect("app", {
          configurationRevision:
            kind === "wrong revision" ? "a".repeat(64) : rev,
        }),
      ).rejects.toMatchObject({ status: 409, code: "stale" });
      expect(f.patchCalls()).toHaveLength(0);
      expect(ref()).toBeUndefined();
    },
  );

  it("does not store a secret after a concurrent config edit while PATCH is in flight", async () => {
    const f = fixture(),
      rev = revision();
    f.afterPatch(() =>
      change((value) => {
        value.commands.build = "npm run build";
      }),
    );
    await expect(
      f.create().connect("app", { configurationRevision: rev }),
    ).rejects.toMatchObject({ code: "stale" });
    expect(connections.readConnections(root)[ref()]).toBeUndefined();
    await f.create().connect("app", { configurationRevision: revision() });
    expect(f.patchCalls()).toHaveLength(1);
    expect(connections.readConnections(root)[ref()]).toBe(SECRET);
  });

  it("resolves an omitted token team from the verified project owner before creating access", async () => {
    change((value) => {
      delete value.environments.preview.teamId;
    });
    const f = fixture(false, true);
    f.credential({ teamId: undefined });
    const service = f.create();
    await expect(
      service.connect("app", { configurationRevision: revision() }),
    ).resolves.toMatchObject({ status: "connected" });
    expect(f.calls[0]!.url.searchParams.has("teamId")).toBe(false);
    expect(f.patchCalls()).toHaveLength(1);
    expect(f.patchCalls()[0]!.url.searchParams.get("teamId")).toBe("team_test");
    expect(connections.readConnections(root)[ref()]).toBe(SECRET);
  });

  it.each(["repo", "project"])(
    "does not infer team ownership for a mismatched %s",
    async (kind) => {
      change((value) => {
        delete value.environments.preview.teamId;
      });
      const f = fixture(false, true);
      f.credential({ teamId: undefined });
      if (kind === "repo")
        f.data.link = { type: "github", org: "unrelated", repo: "app" };
      else f.data.id = "prj_other";
      await expect(
        f.create().connect("app", { configurationRevision: revision() }),
      ).rejects.toMatchObject({ code: "preview_mismatch" });
      expect(f.patchCalls()).toHaveLength(0);
      expect(ref()).toBeUndefined();
    },
  );

  it.each(["repo", "project", "account", "credential team"])(
    "rejects mismatched provider scope: %s",
    async (kind) => {
      const f = fixture();
      if (kind === "repo")
        f.data.link = { type: "github", org: "unrelated", repo: "app" };
      if (kind === "project") f.data.id = "prj_other";
      if (kind === "account") f.data.accountId = "team_other";
      if (kind === "credential team") f.credential({ teamId: "team_other" });
      await expect(
        f.create().connect("app", { configurationRevision: revision() }),
      ).rejects.toMatchObject({
        status: kind === "credential team" ? 403 : 409,
      });
      expect(f.patchCalls()).toHaveLength(0);
      expect(ref()).toBeUndefined();
    },
  );

  it.each(["before mutation", "after mutation"])(
    "rejects changed OAuth installation %s",
    async (when) => {
      const f = fixture(true);
      if (when === "before mutation")
        f.beforeGet(() => f.credential({ configurationId: "icfg_other" }));
      else f.afterPatch(() => f.credential({ configurationId: "icfg_other" }));
      await expect(
        f.create().connect("app", { configurationRevision: revision() }),
      ).rejects.toMatchObject({ code: "connection_changed" });
      expect(f.patchCalls()).toHaveLength(when === "before mutation" ? 0 : 1);
      expect(connections.readConnections(root)[ref()]).toBeUndefined();
    },
  );

  it("recovers after local secret storage failure without exposing it or rotating it", async () => {
    const f = fixture(),
      rev = revision();
    const save = vi
      .spyOn(connections, "saveConnections")
      .mockImplementationOnce(() => {
        throw new Error(`${SECRET} write failed`);
      });
    await expect(
      f.create().connect("app", { configurationRevision: rev }),
    ).rejects.toMatchObject({
      status: 503,
      code: "access_storage",
      message: expect.not.stringContaining(SECRET),
    });
    save.mockRestore();
    await f.create().connect("app", { configurationRevision: rev });
    expect(f.patchCalls()).toHaveLength(1);
    expect(connections.readConnections(root)[ref()]).toBe(SECRET);
  });

  it("uses a different secret reference when the local project incarnation changes", async () => {
    const f = fixture();
    await f.create().connect("app", { configurationRevision: revision() });
    const oldRef = ref();
    change((value) => {
      value.instanceId = randomUUID();
      delete value.environments.preview.bypassSecret;
    });
    await f.create().connect("app", { configurationRevision: revision() });
    expect(ref()).not.toBe(oldRef);
    expect(f.patchCalls()).toHaveLength(2);
    expect(journals()).toHaveLength(2);
  });

  it("rejects extra caller-supplied targets and credentials", async () => {
    const f = fixture();
    await expect(
      f.create().connect("app", {
        configurationRevision: revision(),
        token: SECRET,
      } as { configurationRevision: string }),
    ).rejects.toMatchObject({ status: 400 });
    expect(f.fetcher).not.toHaveBeenCalled();
  });

  it.each(["repository", "url", "production", "unknown custom environment"])(
    "refuses an unsuitable saved environment: %s",
    async (kind) => {
      const f = fixture();
      change((value) => {
        if (kind === "repository") value.verification = { mode: "repository" };
        if (kind === "url")
          value.environments.preview = {
            kind: "url",
            role: "preview",
            url: "https://example.com",
          };
        if (kind === "production")
          value.environments.preview.role = "production";
        if (kind === "unknown custom environment")
          value.environments.preview.customEnvironmentId = "env_gone";
      });
      await expect(
        f.create().connect("app", { configurationRevision: revision() }),
      ).rejects.toBeDefined();
      expect(f.patchCalls()).toHaveLength(0);
    },
  );

  it("fails closed on a corrupted recovery journal", async () => {
    const f = fixture(),
      rev = revision();
    f.hide();
    f.lose();
    await expect(
      f.create().connect("app", { configurationRevision: rev }),
    ).rejects.toMatchObject({ status: 502 });
    writeFileSync(journals()[0]!.file, `{"unexpected":"${SECRET}"}`);
    await expect(
      f.create().connect("app", { configurationRevision: revision() }),
    ).rejects.toMatchObject({
      status: 503,
      message: expect.not.stringContaining(SECRET),
    });
    expect(f.patchCalls()).toHaveLength(1);
  });

  it("keeps only one in-flight action across service instances", async () => {
    const f = fixture(),
      one = f.create(),
      two = f.create(),
      rev = revision();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.beforeGet(() => pending);
    const first = one.connect("app", { configurationRevision: rev });
    await vi.waitFor(() => expect(f.fetcher).toHaveBeenCalledOnce());
    expect(one.busy("app")).toBe(true);
    expect(two.busy()).toBe(true);
    await expect(
      two.connect("app", { configurationRevision: rev }),
    ).rejects.toMatchObject({ status: 409, code: "busy" });
    release();
    await first;
    expect(one.busy()).toBe(false);
    expect(f.patchCalls()).toHaveLength(1);
  });

  it("close aborts a pending credential lookup and refuses new actions", async () => {
    const f = fixture(),
      service = f.create();
    f.resolveCredential.mockImplementation(
      () => new Promise<OAuthCredential>(() => {}),
    );
    const pending = service.connect("app", {
      configurationRevision: revision(),
    });
    const failure = expect(pending).rejects.toMatchObject({ status: 401 });
    await vi.waitFor(() => expect(f.resolveCredential).toHaveBeenCalledOnce());
    await service.close();
    await failure;
    expect(service.busy()).toBe(false);
    expect(f.fetcher).not.toHaveBeenCalled();
    await expect(
      service.connect("app", { configurationRevision: revision() }),
    ).rejects.toMatchObject({ status: 503 });
  });
});
