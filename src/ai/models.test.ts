import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  realpathSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readAiModelCatalog } from "../../runner-local/ai-models.mjs";
import { createAiModels } from "./models.ts";
import type { PlannerDockerRun } from "../pmPlanner/docker.ts";
const roots: string[] = [];
const auth = (label = "one") =>
  JSON.stringify({
    auth_mode: "chatgpt",
    tokens: {
      id_token: `synthetic-id-${label}`,
      access_token: `synthetic-access-${label}`,
      refresh_token: "",
      account_id: `account-${label}`,
    },
  });
const canonical = (label = "one") => {
  const value = JSON.parse(auth(label));
  value.tokens.refresh_token = `synthetic-refresh-${label}`;
  return JSON.stringify(value);
};
afterEach(() => {
  vi.useRealTimers();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function directory() {
  const root = mkdtempSync(
    join(realpathSync(tmpdir()), "gremlins-model-catalog-"),
  );
  roots.push(root);
  return root;
}
function fixture(
  options: {
    raw?: string;
    fail?: string;
    timeoutMs?: number;
    image?: () => Promise<string>;
    prepare?: () => Promise<Record<string, string>>;
  } = {},
) {
  const root = directory(),
    env: NodeJS.ProcessEnv = { CODEX_AUTH_JSON: canonical() };
  let owner = "",
    clock = 0;
  const run = vi.fn<PlannerDockerRun>(async (args) => {
    if (args[0] === "create")
      owner = args[args.indexOf("--label") + 1]!.split("=")[1]!;
    return {
      code: args[0] === options.fail ? 1 : 0,
      stdout:
        args[0] === "start"
          ? (options.raw ??
            '{"models":[{"id":"catalog-model","label":"Catalog model"}]}')
          : args[0] === "inspect"
            ? owner
            : "",
      stderr: "private provider error",
    };
  });
  const prepare = vi.fn(
      options.prepare ?? (async () => ({ CODEX_AUTH_JSON: auth() })),
    ),
    image = vi.fn(
      options.image ?? (async () => "shipgremlins-local:0123456789abcdef"),
    );
  const service = createAiModels({
    root,
    packageRoot: root,
    env: () => env,
    run,
    ensureImage: image,
    prepareCodexCredentials: prepare,
    now: () => clock,
    timeoutMs: options.timeoutMs,
  });
  return {
    root,
    env,
    service,
    prepare,
    image,
    run,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}
describe("safe controller AI model catalogs", () => {
  it("uses private access-only stdin and isolated no-repository catalog helpers, then caches and coalesces requests", async () => {
    const f = fixture(),
      values = await Promise.all([
        f.service.list("codex"),
        f.service.list("codex"),
      ]);
    expect(values[0]).toMatchObject({
      provider: "codex",
      source: "provider",
      availability: "not-verified",
      models: [{ id: "catalog-model", label: "Catalog model" }],
    });
    expect(f.prepare).toHaveBeenCalledTimes(1);
    const created = f.run.mock.calls.find(([args]) => args[0] === "create")![0];
    expect(created).toContain("--read-only");
    expect(created).not.toContain("--mount");
    expect(created).not.toContain("--env");
    expect(JSON.stringify(created)).not.toMatch(/synthetic-|account-one/);
    const input = JSON.parse(
      f.run.mock.calls.find(([args]) => args[0] === "start")![1]!.stdin!,
    );
    expect(JSON.parse(input.auth).tokens.refresh_token).toBe("");
    expect(f.run.mock.calls.at(-1)![0].slice(0, 2)).toEqual(["rm", "--force"]);
    values[0]!.models[0]!.label = "mutated";
    expect((await f.service.list("codex")).models[0]!.label).toBe(
      "Catalog model",
    );
    expect(f.prepare).toHaveBeenCalledTimes(1);
  });
  it("invalidates cached models after account replacement and never uses a disconnected account", async () => {
    const f = fixture();
    await f.service.list("codex");
    f.env.CODEX_AUTH_JSON = canonical("two");
    f.prepare.mockResolvedValue({ CODEX_AUTH_JSON: auth("two") });
    await f.service.list("codex");
    expect(f.prepare).toHaveBeenCalledTimes(2);
    delete f.env.CODEX_AUTH_JSON;
    expect(await f.service.list("codex")).toMatchObject({
      models: [],
      source: "supported",
      availability: "not-verified",
    });
    expect(f.prepare).toHaveBeenCalledTimes(2);
  });
  it("discards catalog results when the account changes while the helper is running", async () => {
    const f = fixture();
    let finish: (value: {
      code: number;
      stdout: string;
      stderr: string;
    }) => void = () => {};
    const original = f.run.getMockImplementation()!;
    f.run.mockImplementation((args, options) =>
      args[0] === "start"
        ? new Promise((resolve) => {
            finish = resolve;
          })
        : original(args, options),
    );
    const pending = f.service.list("codex");
    for (let index = 0; index < 20; index++) await Promise.resolve();
    f.env.CODEX_AUTH_JSON = canonical("replacement");
    finish({
      code: 0,
      stdout: '{"models":[{"id":"old-account-model","label":"Old account"}]}',
      stderr: "",
    });
    expect((await pending).models).toEqual([]);
    expect(f.run.mock.calls.at(-1)![0][0]).toBe("rm");
  });
  it("does not resurrect catalog work after credentials are cleared during shared preparation", async () => {
    let finish: (value: Record<string, string>) => void = () => {};
    const f = fixture({
      prepare: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    });
    const pending = f.service.list("codex");
    delete f.env.CODEX_AUTH_JSON;
    finish({ CODEX_AUTH_JSON: auth() });
    expect((await pending).models).toEqual([]);
    expect(f.run).not.toHaveBeenCalled();
  });
  it("retries supported fallback discovery after fifteen seconds when Docker becomes available", async () => {
    const f = fixture({ fail: "start" });
    await f.service.list("claude");
    f.advance(15001);
    await f.service.list("claude");
    expect(f.image).toHaveBeenCalledTimes(2);
  });
  it.each(["create", "start", "rm"])(
    "falls back safely on %s failure without exposing diagnostics",
    async (fail) => {
      const f = fixture({ fail });
      const value = await f.service.list("claude");
      expect(value.source).toBe("supported");
      expect(value.models.map((model) => model.id)).toEqual([
        "sonnet",
        "opus",
        "haiku",
      ]);
      expect(JSON.stringify(value)).not.toMatch(/private|synthetic-/);
    },
  );
  it.each([
    '{"models":[{"id":"catalog-model","label":"synthetic-access-one"}]}',
    '{"models":[{"id":"bad model","label":"Bad"}]}',
    '{"models":[],"credential":"private"}',
    "not JSON",
  ])("rejects unsafe or malformed catalog output", async (raw) => {
    const f = fixture({ raw });
    expect((await f.service.list("codex")).models).toEqual([]);
    expect(f.run.mock.calls.at(-1)![0][0]).toBe("rm");
  });
  it("bounds image waits, retains pending admission, and never launches a late helper", async () => {
    vi.useFakeTimers();
    let finish: (image: string) => void = () => {};
    const f = fixture({
      timeoutMs: 20,
      image: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    });
    const pending = f.service.list("claude");
    await vi.advanceTimersByTimeAsync(21);
    expect((await pending).source).toBe("supported");
    f.advance(300001);
    await f.service.list("claude");
    expect(f.image).toHaveBeenCalledTimes(1);
    finish("shipgremlins-local:0123456789abcdef");
    await vi.advanceTimersByTimeAsync(1);
    expect(f.run).not.toHaveBeenCalled();
    await f.service.close();
  });
  it("times out a shared refresh without canceling it or launching a late catalog helper", async () => {
    vi.useFakeTimers();
    let finish: (value: Record<string, string>) => void = () => {};
    const f = fixture({
      timeoutMs: 20,
      prepare: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    });
    const pending = f.service.list("codex");
    await vi.advanceTimersByTimeAsync(21);
    expect((await pending).models).toEqual([]);
    f.advance(16000);
    await f.service.list("codex");
    expect(f.prepare).toHaveBeenCalledTimes(1);
    finish({ CODEX_AUTH_JSON: auth() });
    await vi.advanceTimersByTimeAsync(1);
    expect(f.run).not.toHaveBeenCalled();
    await f.service.close();
  });
});
function nativeFixture(provider: "codex" | "claude", scenario = "normal") {
  const root = directory(),
    requests: Array<Record<string, unknown>> = [];
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stdin: Object.assign(new EventEmitter(), {
      write: vi.fn((line: string) => {
        const request = JSON.parse(line);
        requests.push(request);
        const emit = (value: object) =>
          queueMicrotask(() =>
            child.stdout.write(JSON.stringify(value) + "\n"),
          );
        if (provider === "claude")
          emit({
            type: "control_response",
            response: {
              request_id: "shipgremlins-model-catalog",
              subtype: "success",
              response: {
                models: [
                  { value: "default", displayName: "Default" },
                  {
                    value: "sonnet",
                    displayName: "Sonnet",
                    description: "Supported alias",
                  },
                  { value: "fable", displayName: "Fable" },
                ],
              },
            },
          });
        else if (request.method === "initialize")
          emit({ id: request.id, result: {} });
        else if (request.method === "model/list")
          emit({
            id: request.id,
            result: {
              data: [
                {
                  model: "catalog-model",
                  displayName:
                    scenario === "secret"
                      ? "synthetic-access-one"
                      : "Catalog model",
                  hidden: false,
                },
                { model: "hidden-model", displayName: "Hidden", hidden: true },
              ],
              nextCursor: null,
            },
          });
      }),
    }),
    kill: vi.fn(() => queueMicrotask(() => child.emit("close", 0))),
  });
  const spawn = vi.fn<
    NonNullable<NonNullable<Parameters<typeof readAiModelCatalog>[1]>["spawn"]>
  >(() => child as unknown as ChildProcessWithoutNullStreams);
  return {
    root,
    child,
    spawn,
    requests,
    execute: () =>
      readAiModelCatalog(
        { provider, ...(provider === "codex" ? { auth: auth() } : {}) },
        { directory: root, spawn },
      ),
  };
}
describe("pinned CLI catalog protocol", () => {
  it("waits for the native process to close before deleting private catalog/auth files", async () => {
    const f = nativeFixture("codex");
    f.child.kill.mockImplementation(() => undefined);
    const pending = f.execute();
    for (let index = 0; index < 10; index++) await Promise.resolve();
    expect(f.child.kill).toHaveBeenCalledWith("SIGTERM");
    expect(readdirSync(f.root).length).toBeGreaterThan(0);
    f.child.emit("close", 0);
    await pending;
    expect(readdirSync(f.root)).toEqual([]);
  });
  it("uses only Codex initialize/model-list RPCs and projects visible wire IDs without auth writeback", async () => {
    const f = nativeFixture("codex");
    expect(await f.execute()).toEqual({
      models: [{ id: "catalog-model", label: "Catalog model" }],
    });
    expect(f.requests.map((value) => value.method)).toEqual([
      "initialize",
      "initialized",
      "model/list",
    ]);
    expect(f.spawn.mock.calls[0]![1]).toEqual([
      "app-server",
      "--strict-config",
      "--listen",
      "stdio://",
    ]);
    expect(f.spawn.mock.calls[0]![2].env).not.toHaveProperty("CODEX_AUTH_JSON");
    expect(readdirSync(f.root)).toEqual([]);
  });
  it("uses Claude SDK initialize with no user/model message or credential and omits Provider default", async () => {
    const f = nativeFixture("claude");
    expect((await f.execute()).models.map((model) => model.id)).toEqual([
      "sonnet",
      "fable",
    ]);
    expect(f.requests).toEqual([
      {
        type: "control_request",
        request_id: "shipgremlins-model-catalog",
        request: { subtype: "initialize" },
      },
    ]);
    expect(f.spawn.mock.calls[0]![2].env).not.toHaveProperty(
      "CLAUDE_CODE_OAUTH_TOKEN",
    );
    expect(f.spawn.mock.calls[0]![1]).toContain("--safe-mode");
    expect(readdirSync(f.root)).toEqual([]);
  });
  it("rejects echoed component tokens and canonical refresh credentials", async () => {
    await expect(nativeFixture("codex", "secret").execute()).rejects.toThrow(
      /unavailable/,
    );
    const fixture = nativeFixture("codex");
    const directory = join(fixture.root, "must-not-create");
    await expect(
      readAiModelCatalog(
        { provider: "codex", auth: canonical() },
        { directory },
      ),
    ).rejects.toThrow(/access-only/);
    expect(existsSync(directory)).toBe(false);
  });
});
