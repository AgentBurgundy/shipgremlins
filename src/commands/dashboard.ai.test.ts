import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDashboardServer } from "./dashboard.ts";
import { initializeSetup } from "../setup/files.ts";
import { loadProject } from "../config.ts";
import type { AiRoutingView } from "../ai/routing.ts";
import { readConnections } from "../setup/connections.ts";
import type { LocalRunners } from "../localRunners/engine.ts";
import type { SourceControl } from "../sourceControl/types.ts";
import type { CodexLoginStatus } from "../setup/codexLogin.ts";

const roots: string[] = [],
  servers: Server[] = [];
const session = "a".repeat(64);
const claude = "sk-ant-oat01-" + "synthetic_0-A".repeat(16);
const codex = JSON.stringify({
  auth_mode: "chatgpt",
  OPENAI_API_KEY: null,
  tokens: {
    id_token: "private-id-token",
    access_token: "private-access-token",
    refresh_token: "private-refresh-token",
    account_id: "account-private",
  },
});
const privateValues = [
  claude,
  codex,
  "private-id-token",
  "private-access-token",
  "private-refresh-token",
  "account-private",
];
type AiView = {
  provider: "claude" | "codex";
  model?: string;
  configured: boolean;
  providers: Array<{ id: string; label: string; configured: boolean }>;
};
const assertPrivate = (value: unknown) => {
  const serialized = JSON.stringify(value);
  for (const secret of privateValues) expect(serialized).not.toContain(secret);
  expect(serialized).not.toContain('"tokens"');
};
afterEach(async () => {
  for (const server of servers.splice(0))
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});
async function fixture() {
  vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", undefined);
  vi.stubEnv("CODEX_AUTH_JSON", undefined);
  const root = mkdtempSync(join(realpathSync(tmpdir()), "gremlins-ai-http-"));
  roots.push(root);
  initializeSetup(root, process.cwd(), { project: "app", repo: "owner/app" });
  const start = vi.fn(),
    models = {
      list: vi.fn(async (provider: "claude" | "codex") => ({
        provider,
        models: [
          {
            id: provider === "claude" ? "sonnet" : "synthetic-coder",
            label: "Synthetic model",
          },
        ],
        source: "supported" as const,
        availability: "not-verified" as const,
        message: "Synthetic supported catalog.",
      })),
    },
    login = {
      status: vi.fn(async (): Promise<CodexLoginStatus> => ({
        status: "idle",
      })),
      start: vi.fn(async (): Promise<CodexLoginStatus> => ({
        status: "pending",
        verificationUrl: "https://auth.openai.com/codex/device",
        userCode: "ABCD-1234",
        expiresAt: "2030-01-01T00:00:00.000Z",
      })),
      cancel: vi.fn(async (): Promise<CodexLoginStatus> => ({
        status: "canceled",
      })),
      prepare: vi.fn(async () => ({ CODEX_AUTH_JSON: codex })),
      close: vi.fn(async () => {}),
    };
  const runners = {
    start,
    stop: async () => {},
    jobs: async () => [],
    status: async () => ({ runners: [], jobs: [] }),
    withConfigurationMutation: async <T>(
      _target: unknown,
      operation: () => T | Promise<T>,
    ) => operation(),
  } as unknown as LocalRunners;
  const server = createDashboardServer(root, process.cwd(), session, [], {
    background: false,
    codexLogin: login,
    aiModels: models,
    runners,
    sourceControl: { status: async () => [] } as unknown as SourceControl,
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = (
    path = "/api/ai",
    input?: unknown,
    method = input === undefined ? "GET" : "POST",
    auth = true,
  ) =>
    fetch(origin + path, {
      method,
      headers: {
        ...(auth ? { Authorization: `Bearer ${session}` } : {}),
        "Content-Type": "application/json",
      },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }),
    });
  const ai = async () => (await (await call()).json()) as AiView;
  return { root, origin, call, ai, login, start, models };
}

describe("dashboard AI provider HTTP contract", () => {
  it("reports the actual project setup provider independently from workspace and PM routes without exposing credentials", async () => {
    const f = await fixture();
    await f.call("/api/connections", {
      values: { CLAUDE_CODE_OAUTH_TOKEN: claude },
    });
    await f.call("/api/ai", { provider: "claude" });
    const before = (await (
      await f.call("/api/projects/app/ai")
    ).json()) as AiRoutingView;
    expect(
      (
        await f.call(
          "/api/projects/app/ai",
          {
            revision: before.revision,
            default: { provider: "codex", model: "synthetic-coder" },
            pm: { provider: "claude" },
          },
          "PUT",
        )
      ).status,
    ).toBe(200);
    const status = async () =>
      (await (await f.call("/api/status")).json()) as {
        ai: AiView;
        projects: Array<{ setupAi: Omit<AiView, "providers"> }>;
      };
    const missing = await status();
    expect(missing.ai).toMatchObject({ provider: "claude", configured: true });
    expect(missing.projects[0]!.setupAi).toEqual({
      provider: "codex",
      model: "synthetic-coder",
      configured: false,
    });
    assertPrivate(missing);
    await f.call("/api/connections", { values: { CODEX_AUTH_JSON: codex } });
    const connected = await status();
    expect(connected.projects[0]!.setupAi).toEqual({
      provider: "codex",
      model: "synthetic-coder",
      configured: true,
    });
    assertPrivate(connected);
    expect(f.models.list).not.toHaveBeenCalled();
    expect(f.login.prepare).not.toHaveBeenCalled();
  });
  it("returns safe model catalog choices only for an authenticated exact provider query", async () => {
    const f = await fixture();
    expect(
      (await f.call("/api/ai/models?provider=codex", undefined, "GET", false))
        .status,
    ).toBe(401);
    const response = await f.call("/api/ai/models?provider=codex");
    expect(response.status).toBe(200);
    const value = await response.json();
    expect(value).toMatchObject({
      provider: "codex",
      models: [{ id: "synthetic-coder", label: "Synthetic model" }],
      source: "supported",
      availability: "not-verified",
    });
    assertPrivate(value);
    expect(f.models.list).toHaveBeenCalledExactlyOnceWith("codex");
    for (const path of [
      "/api/ai/models",
      "/api/ai/models?provider=other",
      "/api/ai/models?provider=claude&provider=codex",
      "/api/ai/models?provider=codex&token=private-access-token",
    ])
      expect((await f.call(path)).status).toBe(400);
    expect(
      (await f.call("/api/ai/models?provider=codex", {}, "POST")).status,
    ).toBe(405);
    expect(f.models.list).toHaveBeenCalledTimes(1);
  });
  it("keeps both providers connected and routes project PM and coding work independently", async () => {
    const f = await fixture();
    await f.call("/api/connections", {
      values: { CLAUDE_CODE_OAUTH_TOKEN: claude, CODEX_AUTH_JSON: codex },
    });
    await f.call("/api/ai", { provider: "claude" });
    const before = (await (
      await f.call("/api/projects/app/ai")
    ).json()) as AiRoutingView;
    expect(before.effective.coder).toMatchObject({
      provider: "claude",
      source: "workspace",
      configured: true,
    });
    const saved = await f.call(
      "/api/projects/app/ai",
      {
        revision: before.revision,
        pm: { provider: "claude", model: "sonnet" },
        coder: { provider: "codex" },
      },
      "PUT",
    );
    expect(saved.status).toBe(200);
    const view = (await saved.json()) as AiRoutingView;
    expect(view.effective.pm).toMatchObject({
      provider: "claude",
      model: "sonnet",
      source: "project-role",
      configured: true,
    });
    expect(view.effective.coder).toMatchObject({
      provider: "codex",
      source: "project-role",
      configured: true,
    });
    expect((await f.ai()).provider).toBe("claude");
    assertPrivate(view);
    expect(readConnections(f.root)).toMatchObject({
      CLAUDE_CODE_OAUTH_TOKEN: claude,
      CODEX_AUTH_JSON: codex,
    });
  });
  it("supports an individual PM and its coder, clears inheritance, and rejects stale parent revisions", async () => {
    const f = await fixture();
    const area = loadProject(f.root, "app").areas[0]!.key;
    const path = `/api/projects/app/pms/${area}/ai`;
    const first = (await (await f.call(path)).json()) as AiRoutingView;
    const override = await f.call(
      path,
      {
        revision: first.revision,
        pm: { provider: "codex" },
        coder: { provider: "claude", model: "haiku" },
      },
      "PUT",
    );
    expect(override.status).toBe(200);
    const view = (await override.json()) as AiRoutingView;
    expect(view.effective.pm).toMatchObject({
      provider: "codex",
      source: "pm-role",
      configured: false,
    });
    expect(view.effective.coder).toMatchObject({
      provider: "claude",
      model: "haiku",
      source: "pm-role",
    });
    const project = (await (
      await f.call("/api/projects/app/ai")
    ).json()) as AiRoutingView;
    expect(
      (
        await f.call(
          "/api/projects/app/ai",
          {
            revision: project.revision,
            default: { provider: "claude", model: "sonnet" },
          },
          "PUT",
        )
      ).status,
    ).toBe(200);
    expect(
      (await f.call(path, { revision: view.revision, pm: null }, "PUT")).status,
    ).toBe(409);
    const fresh = (await (await f.call(path)).json()) as AiRoutingView;
    const cleared = await f.call(
      path,
      { revision: fresh.revision, pm: null },
      "PUT",
    );
    const inherited = (await cleared.json()) as AiRoutingView;
    expect(inherited.effective.pm).toMatchObject({
      provider: "claude",
      model: "sonnet",
      source: "project-default",
    });
    expect(inherited.overrides.coder).toEqual({
      provider: "claude",
      model: "haiku",
    });
  });
  it("does not substitute a connected provider for an unconnected project choice", async () => {
    const f = await fixture();
    await f.call("/api/connections", {
      values: { CLAUDE_CODE_OAUTH_TOKEN: claude },
    });
    const view = (await (
      await f.call("/api/projects/app/ai")
    ).json()) as AiRoutingView;
    const response = await f.call(
      "/api/projects/app/ai",
      { revision: view.revision, coder: { provider: "codex" } },
      "PUT",
    );
    expect(response.status).toBe(200);
    expect(
      ((await response.json()) as AiRoutingView).effective.coder,
    ).toMatchObject({ provider: "codex", configured: false });
  });
  it("protects scoped routes and rejects unsupported models, credential material and unknown fields", async () => {
    const f = await fixture();
    expect(
      (await f.call("/api/projects/app/ai", undefined, "GET", false)).status,
    ).toBe(401);
    await f.call("/api/connections", { values: { CODEX_AUTH_JSON: codex } });
    const view = (await (
      await f.call("/api/projects/app/ai")
    ).json()) as AiRoutingView;
    for (const input of [
      { revision: view.revision, coder: { provider: "other" } },
      {
        revision: view.revision,
        coder: { provider: "codex", model: "private-access-token" },
      },
      { revision: view.revision, coder: { provider: "codex", token: codex } },
      { revision: view.revision, credential: codex },
    ]) {
      const response = await f.call("/api/projects/app/ai", input, "PUT");
      expect(response.status).toBe(400);
      assertPrivate(await response.json());
    }
    expect(
      ((await (await f.call("/api/projects/app/ai")).json()) as AiRoutingView)
        .revision,
    ).toBe(view.revision);
  });
  it("rejects missing targets, query parameters, unsupported methods and PM-level project defaults", async () => {
    const f = await fixture();
    expect((await f.call("/api/projects/missing/ai")).status).toBe(404);
    expect((await f.call("/api/projects/app/pms/missing/ai")).status).toBe(404);
    expect((await f.call("/api/projects/app/ai?model=secret")).status).toBe(
      400,
    );
    expect((await f.call("/api/projects/app/ai", {}, "POST")).status).toBe(405);
    const area = loadProject(f.root, "app").areas[0]!.key,
      path = `/api/projects/app/pms/${area}/ai`;
    const view = (await (await f.call(path)).json()) as AiRoutingView;
    expect(
      (
        await f.call(
          path,
          { revision: view.revision, default: { provider: "codex" } },
          "PUT",
        )
      ).status,
    ).toBe(400);
  });
  it("requires authentication before reading or mutating provider and device sign-in", async () => {
    const f = await fixture();
    for (const [path, input, method] of [
      ["/api/ai", undefined, "GET"],
      ["/api/ai", { provider: "codex" }, "POST"],
      ["/api/ai/codex/login", undefined, "GET"],
      ["/api/ai/codex/login", {}, "POST"],
      ["/api/ai/codex/login", {}, "DELETE"],
    ] as const)
      expect((await f.call(path, input, method, false)).status).toBe(401);
    expect(f.login.status).not.toHaveBeenCalled();
    expect(f.login.start).not.toHaveBeenCalled();
    expect(f.login.cancel).not.toHaveBeenCalled();
    expect(await f.ai()).toEqual({
      provider: "claude",
      configured: false,
      providers: [
        { id: "claude", label: "Claude Code", configured: false },
        { id: "codex", label: "Codex · ChatGPT account", configured: false },
      ],
    });
  });
  it("persists explicit unconnected Codex without falling back to a saved Claude connection", async () => {
    const f = await fixture();
    expect(
      (
        await f.call("/api/connections", {
          values: { CLAUDE_CODE_OAUTH_TOKEN: claude },
        })
      ).status,
    ).toBe(200);
    expect(await f.ai()).toMatchObject({
      provider: "claude",
      configured: true,
    });
    const selected = await f.call("/api/ai", { provider: "codex" });
    expect(selected.status).toBe(200);
    const result = (await selected.json()) as AiView;
    expect(result).toMatchObject({ provider: "codex", configured: false });
    expect(result.providers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "claude", configured: true }),
        expect.objectContaining({ id: "codex", configured: false }),
      ]),
    );
    expect(await f.ai()).toMatchObject({
      provider: "codex",
      configured: false,
    });
    expect(
      JSON.parse(readFileSync(join(f.root, ".run/ai/selection.json"), "utf8")),
    ).toEqual({ provider: "codex" });
    assertPrivate(result);
  });
  it("imports Codex ChatGPT access privately and returns safe selected status from both endpoints", async () => {
    const f = await fixture();
    await f.call("/api/ai", { provider: "codex", model: "gpt-5.4" });
    const response = await f.call("/api/connections", {
      values: { CODEX_AUTH_JSON: codex },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(JSON.parse(readConnections(f.root).CODEX_AUTH_JSON!)).toMatchObject({
      auth_mode: "chatgpt",
      tokens: { access_token: "private-access-token" },
    });
    const ai = await f.ai();
    expect(ai).toMatchObject({
      provider: "codex",
      model: "gpt-5.4",
      configured: true,
    });
    const statusResponse = await f.call("/api/status");
    expect(statusResponse.status).toBe(200);
    const status = (await statusResponse.json()) as {
      ai: AiView;
      projects: object[];
      connections: Array<{ name: string; configured: boolean; saved: boolean }>;
    };
    expect(status.ai).toEqual(ai);
    expect(status.projects).toHaveLength(1);
    expect(status.connections).toContainEqual(
      expect.objectContaining({
        name: "CODEX_AUTH_JSON",
        configured: true,
        saved: true,
      }),
    );
    assertPrivate(ai);
    assertPrivate(status);
  });
  it("resets a model by omission and switches providers without carrying the previous model", async () => {
    const f = await fixture();
    expect(
      await (
        await f.call("/api/ai", { provider: "codex", model: "gpt-5.4" })
      ).json(),
    ).toMatchObject({ provider: "codex", model: "gpt-5.4" });
    expect(
      await (await f.call("/api/ai", { provider: "codex" })).json(),
    ).not.toHaveProperty("model");
    await f.call("/api/ai", { provider: "codex", model: "gpt-5.4" });
    const switched = await (
      await f.call("/api/ai", { provider: "claude" })
    ).json();
    expect(switched).toMatchObject({ provider: "claude" });
    expect(switched).not.toHaveProperty("model");
    expect(await f.ai()).toEqual(switched);
  });
  it("rejects unsupported AI shapes, methods and queries without mutating or reflecting inputs", async () => {
    const f = await fixture();
    await f.call("/api/ai", { provider: "codex" });
    for (const input of [
      null,
      [],
      {},
      { provider: "other" },
      { provider: "codex", token: "private-access-token" },
      { provider: "codex", model: "" },
      { provider: "codex", model: 5 },
      { provider: "codex", model: "bad model private-access-token" },
      { provider: "codex", model: "x".repeat(101) },
    ]) {
      const response = await f.call("/api/ai", input);
      expect(response.status).toBe(400);
      assertPrivate(await response.json());
    }
    for (const method of ["PUT", "DELETE", "PATCH"])
      expect((await f.call("/api/ai", undefined, method)).status).toBe(405);
    for (const method of ["GET", "POST"])
      expect(
        (
          await f.call(
            "/api/ai?token=private-access-token",
            method === "POST" ? { provider: "claude" } : undefined,
            method,
          )
        ).status,
      ).toBe(400);
    expect(await f.ai()).toMatchObject({
      provider: "codex",
      configured: false,
    });
  });
  it("rejects credentials disguised as model IDs and sanitizes corrupt persisted selections", async () => {
    const f = await fixture();
    await f.call("/api/connections", { values: { CODEX_AUTH_JSON: codex } });
    for (const model of [
      "private-access-token",
      "private-refresh-token",
      "private-id-token",
    ]) {
      const response = await f.call("/api/ai", { provider: "codex", model });
      expect(response.status).toBe(400);
      assertPrivate(await response.json());
    }
    await f.call("/api/ai", { provider: "codex" });
    writeFileSync(
      join(f.root, ".run/ai/selection.json"),
      '{"provider":"private-access-token"}',
    );
    const response = await f.call();
    expect(response.status).toBe(503);
    assertPrivate(await response.json());
  });
  it("rejects API-key and oversized auth imports without changing existing saved access", async () => {
    const f = await fixture();
    await f.call("/api/connections", { values: { CODEX_AUTH_JSON: codex } });
    const saved = readConnections(f.root).CODEX_AUTH_JSON;
    for (const value of [
      '{"OPENAI_API_KEY":"private-access-token"}',
      "not-json-private-access-token",
      "x".repeat(65537),
    ]) {
      const response = await f.call("/api/connections", {
        values: { CODEX_AUTH_JSON: value },
      });
      expect(response.status).toBe(400);
      assertPrivate(await response.json());
      expect(readConnections(f.root).CODEX_AUTH_JSON).toBe(saved);
    }
  });
  it("exposes only the helper's safe status and permits GET, explicit start and no-body cancellation", async () => {
    const f = await fixture();
    expect(await (await f.call("/api/ai/codex/login")).json()).toEqual({
      status: "idle",
    });
    const pending = await f.call("/api/ai/codex/login", {});
    expect(pending.status).toBe(200);
    expect(await pending.json()).toEqual({
      status: "pending",
      verificationUrl: "https://auth.openai.com/codex/device",
      userCode: "ABCD-1234",
      expiresAt: "2030-01-01T00:00:00.000Z",
    });
    expect(f.login.start).toHaveBeenCalledOnce();
    expect(f.login.start).toHaveBeenCalledWith();
    const canceled = await f.call("/api/ai/codex/login", undefined, "DELETE");
    expect(canceled.status).toBe(200);
    expect(await canceled.json()).toEqual({ status: "canceled" });
    expect(f.login.cancel).toHaveBeenCalledOnce();
    expect(f.login.cancel).toHaveBeenCalledWith();
    const explicitCancel = await f.call("/api/ai/codex/login", {}, "DELETE");
    expect(explicitCancel.status).toBe(200);
    assertPrivate(await explicitCancel.json());
  });
  it("rejects device credential payloads, unsupported methods and queries before invoking the helper", async () => {
    const f = await fixture();
    for (const method of ["POST", "DELETE"]) {
      for (const input of [
        { auth: codex },
        { provider: "codex" },
        { token: "private-access-token" },
        null,
        [],
      ]) {
        const response = await f.call("/api/ai/codex/login", input, method);
        expect(response.status).toBe(400);
        assertPrivate(await response.json());
      }
    }
    for (const method of ["GET", "POST", "DELETE"])
      expect(
        (
          await f.call(
            "/api/ai/codex/login?token=private-access-token",
            method === "GET" ? undefined : {},
            method,
          )
        ).status,
      ).toBe(400);
    for (const method of ["PUT", "PATCH"])
      expect((await f.call("/api/ai/codex/login", {}, method)).status).toBe(
        405,
      );
    expect(f.login.status).not.toHaveBeenCalled();
    expect(f.login.start).not.toHaveBeenCalled();
    expect(f.login.cancel).not.toHaveBeenCalled();
  });
  it("sanitizes unexpected helper errors without reflecting credentials", async () => {
    const f = await fixture();
    f.login.status.mockRejectedValueOnce(new Error(codex));
    f.login.start.mockRejectedValueOnce(new Error("private-access-token"));
    f.login.cancel.mockRejectedValueOnce(new Error("private-refresh-token"));
    for (const [input, method] of [
      [undefined, "GET"],
      [{}, "POST"],
      [{}, "DELETE"],
    ] as const) {
      const response = await f.call("/api/ai/codex/login", input, method);
      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({
        error:
          "Dashboard request failed. Check your local configuration files and permissions.",
      });
    }
  });
  it("cancels a device session when Codex credentials are cleared while preserving explicit provider intent", async () => {
    const f = await fixture();
    await f.call("/api/ai", { provider: "codex" });
    await f.call("/api/connections", {
      values: { CODEX_AUTH_JSON: codex, CLAUDE_CODE_OAUTH_TOKEN: claude },
    });
    f.login.cancel.mockClear();
    const response = await f.call("/api/connections/clear", {
      names: ["CODEX_AUTH_JSON"],
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(f.login.cancel).toHaveBeenCalledOnce();
    expect(readConnections(f.root).CODEX_AUTH_JSON).toBeUndefined();
    expect(readConnections(f.root).CLAUDE_CODE_OAUTH_TOKEN).toBe(claude);
    expect(await f.ai()).toMatchObject({
      provider: "codex",
      configured: false,
    });
    assertPrivate(await f.ai());
  });
  it("uses ordinary browser cookie and CSRF protections for AI provider changes", async () => {
    const f = await fixture();
    const setup = await fetch(f.origin + "/api/auth/setup", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${session}`,
        Origin: f.origin,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        password: "a fifteen character passphrase",
        remember: false,
      }),
    });
    expect(setup.status).toBe(200);
    const state = (await setup.json()) as { csrfToken: string },
      cookie = setup.headers.get("set-cookie")!.split(";")[0]!;
    expect(
      (await fetch(f.origin + "/api/ai", { headers: { Cookie: cookie } }))
        .status,
    ).toBe(200);
    const request = (csrf = false) =>
      fetch(f.origin + "/api/ai", {
        method: "POST",
        headers: {
          Cookie: cookie,
          Origin: f.origin,
          "Content-Type": "application/json",
          ...(csrf ? { "X-CSRF-Token": state.csrfToken } : {}),
        },
        body: JSON.stringify({ provider: "codex" }),
      });
    expect((await request()).status).toBe(403);
    expect((await request(true)).status).toBe(200);
    expect(await f.ai()).toMatchObject({
      provider: "codex",
      configured: false,
    });
  });
});
