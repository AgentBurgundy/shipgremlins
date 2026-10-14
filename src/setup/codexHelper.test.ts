import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

const auth = JSON.stringify({
  auth_mode: "chatgpt",
  tokens: {
    refresh_token: "private-refresh",
    access_token: "private-access",
    id_token: "private-id",
    account_id: "account-123",
  },
});
async function helper(mode: "login" | "refresh", scenario = "normal") {
  const files = new Map<string, string>(),
    messages: Array<{ method: string; params?: unknown }> = [],
    lines = new EventEmitter();
  const child = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stdin: {
      write: vi.fn((line: string) => {
        const request = JSON.parse(line);
        messages.push(request);
        const respond = (result: object) =>
          queueMicrotask(() =>
            lines.emit("line", JSON.stringify({ id: request.id, result })),
          );
        if (request.method === "initialize") respond({});
        if (request.method === "account/login/start") {
          respond({
            type: "chatgptDeviceCode",
            loginId: "login-123",
            verificationUrl:
              scenario === "bad-url"
                ? "https://phishing.example/codex/device"
                : "https://auth.openai.com/codex/device",
            userCode: "ABCD-1234",
          });
          if (scenario === "instant-complete")
            queueMicrotask(() => {
              files.set("/auth/auth.json", auth);
              lines.emit(
                "line",
                JSON.stringify({
                  method: "account/login/completed",
                  params: { success: true },
                }),
              );
            });
        }
        if (request.method === "account/read") {
          files.set("/auth/auth.json", auth);
          respond({
            account: {
              type: scenario === "api-key" ? "apiKey" : "chatgpt",
              email: "private@example.test",
            },
          });
        }
      }),
    },
    kill: vi.fn(() => queueMicrotask(() => child.emit("close", 0))),
  });
  const spawn = vi.fn(() => child),
    process = {
      stdin: {
        async *[Symbol.asyncIterator]() {
          yield JSON.stringify({
            mode,
            ...(mode === "refresh" ? { auth } : {}),
          });
        },
      },
      env: {
        PATH: "/usr/bin",
        OPENAI_API_KEY: "must-not-inherit",
        CODEX_AUTH_JSON: "must-not-inherit",
      },
      exitCode: 0,
    };
  const source = readFileSync(
    new URL("../../runner-local/codex-login.mjs", import.meta.url),
    "utf8",
  ).replace(/^import .*;\r?\n/gm, "");
  await runInNewContext(`(async()=>{${source}\n})()`, {
    spawn,
    process,
    Buffer,
    createInterface: () => lines,
    mkdirSync: vi.fn(),
    writeFileSync: (file: string, content: string) => files.set(file, content),
    readFileSync: (file: string) => files.get(file),
    lstatSync: (file: string) => ({
      isFile: () => files.has(file),
      isSymbolicLink: () => false,
      size: files.get(file)?.length ?? 0,
    }),
    setTimeout: () => ({ unref() {} }),
    clearTimeout() {},
  });
  return { files, messages, child, spawn, process, lines };
}

describe("Codex account-only helper protocol", () => {
  it("initializes a trusted app server, requests device auth, and never starts a model turn or prints tokens", async () => {
    const h = await helper("login");
    expect(h.messages.map((message) => message.method)).toEqual([
      "initialize",
      "initialized",
      "account/login/start",
    ]);
    expect(h.messages.at(-1)?.params).toEqual({ type: "chatgptDeviceCode" });
    expect(JSON.parse(h.files.get("/auth/status.json")!)).toMatchObject({
      status: "pending",
      userCode: "ABCD-1234",
      verificationUrl: "https://auth.openai.com/codex/device",
    });
    expect(h.spawn).toHaveBeenCalledWith(
      "/opt/gremlins/node_modules/.bin/codex",
      ["app-server", "--listen", "stdio://"],
      expect.objectContaining({
        cwd: "/auth",
        env: { PATH: "/usr/bin", HOME: "/auth", CODEX_HOME: "/auth" },
        stdio: ["pipe", "pipe", "ignore"],
      }),
    );
    expect(h.files.get("/auth/config.toml")).toContain(
      'forced_login_method = "chatgpt"',
    );
    expect(h.files.get("/auth/status.json")).not.toMatch(/private-|email/);
  });
  it("refreshes through account/read without a model request and preserves the updated account cache", async () => {
    const h = await helper("refresh");
    expect(h.messages.map((message) => message.method)).toEqual([
      "initialize",
      "initialized",
      "account/read",
    ]);
    expect(h.messages.at(-1)?.params).toEqual({ refreshToken: true });
    expect(JSON.parse(h.files.get("/auth/status.json")!).status).toBe(
      "complete",
    );
    expect(h.files.get("/auth/auth.json")).toBe(auth);
    expect(h.child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(h.files.get("/auth/status.json")).not.toMatch(/private-|email/);
  });
  it("keeps completion when the login notification arrives before the start response is consumed", async () => {
    const h = await helper("login", "instant-complete");
    expect(JSON.parse(h.files.get("/auth/status.json")!).status).toBe(
      "complete",
    );
  });
  it.each(["bad-url", "api-key"])(
    "fails closed on unexpected account protocol output (%s)",
    async (scenario) => {
      const h = await helper(
        scenario === "api-key" ? "refresh" : "login",
        scenario,
      );
      expect(JSON.parse(h.files.get("/auth/status.json")!).status).toBe(
        "failed",
      );
      expect(h.process.exitCode).toBe(1);
      expect(h.files.get("/auth/status.json")).not.toMatch(
        /private-|phishing|apiKey/,
      );
    },
  );
});
