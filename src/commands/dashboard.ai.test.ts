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
  return { root, origin, call, ai, login, start };
}

describe("dashboard AI provider HTTP contract", () => {
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
