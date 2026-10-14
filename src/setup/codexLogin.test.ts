import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DockerRun } from "../localRunners/docker.ts";
import { readConnections, saveConnections } from "./connections.ts";
import { createCodexLogin } from "./codexLogin.ts";

const roots: string[] = [];
const auth = (suffix = "seed") =>
  JSON.stringify({
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens: {
      id_token: `id-${suffix}`,
      access_token: `access-${suffix}`,
      refresh_token: `refresh-${suffix}`,
      account_id: "account-123",
    },
    last_refresh: "2026-10-10T00:00:00.000Z",
  });
afterEach(() => {
  for (const directory of roots.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
const settle = async () => {
  for (let count = 0; count < 25; count++) await Promise.resolve();
};
function fixture(exported: NodeJS.ProcessEnv = {}) {
  const root = mkdtempSync(join(tmpdir(), "gremlins-codex-login-"));
  roots.push(root);
  let owner = "",
    container = "",
    publicState: object = {},
    cache = "",
    executions = 0;
  let finishExecution: (result: {
    code: number;
    stdout: string;
    stderr: string;
  }) => void = () => {};
  const inputs: object[] = [];
  const ensureImage = vi.fn(async () => `shipgremlins-local:${"a".repeat(16)}`);
  const run = vi.fn<DockerRun>(async (args, options) => {
    if (args[0] === "create") {
      container = args[args.indexOf("--name") + 1]!;
      owner = args[args.indexOf("--label") + 1]!.split("=")[1]!;
      return { code: 0, stdout: container, stderr: "" };
    }
    if (args[0] === "ps") return { code: 0, stdout: container, stderr: "" };
    if (args[0] === "inspect")
      return { code: container ? 0 : 1, stdout: owner, stderr: "" };
    if (args[0] === "rm") {
      container = "";
      finishExecution({
        code: 1,
        stdout: "",
        stderr: "refresh-seed-secret-error",
      });
      return { code: 0, stdout: "", stderr: "" };
    }
    if (args[0] === "exec" && args[1] === "-i") {
      executions++;
      inputs.push(JSON.parse(options!.stdin!));
      publicState = {
        status: "pending",
        verificationUrl: "https://auth.openai.com/codex/device",
        userCode: "ABCD-1234",
        expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
        message: "untrusted-account-email@example.test",
      };
      return new Promise((resolve) => {
        finishExecution = resolve;
      });
    }
    if (args[0] === "exec")
      return {
        code: 0,
        stdout: args.at(-1)!.includes("status.json")
          ? JSON.stringify(publicState)
          : cache,
        stderr: "",
      };
    return { code: 0, stdout: "", stderr: "" };
  });
  const service = createCodexLogin({
    root,
    packageRoot: root,
    run,
    ensureImage,
    env: () => exported,
  });
  const finish = (raw = auth("updated"), ok = true) => {
    cache = raw;
    publicState = {
      status: ok ? "complete" : "failed",
      message: "never-return-helper-message",
    };
    finishExecution({
      code: ok ? 0 : 1,
      stdout: "",
      stderr: "secret-runtime-diagnostic",
    });
  };
  return {
    root,
    service,
    run,
    finish,
    inputs,
    ensureImage,
    get executions() {
      return executions;
    },
  };
}
describe("trusted Codex account helper", () => {
  it("starts a repository-free device login, exposes only the code, then persists auth privately and removes the helper", async () => {
    const f = fixture();
    await f.service.start();
    await settle();
    const pending = await f.service.status();
    expect(pending).toMatchObject({
      status: "pending",
      verificationUrl: "https://auth.openai.com/codex/device",
      userCode: "ABCD-1234",
    });
    expect(JSON.stringify(pending)).not.toMatch(/email|token|account-123/);
    expect(f.inputs).toEqual([{ mode: "login" }]);
    const create = f.run.mock.calls.find(([args]) => args[0] === "create")![0];
    expect(create).toContain("--read-only");
    expect(create).not.toContain("--volume");
    expect(create.join(" ")).not.toMatch(
      /docker.sock|--privileged|--network=host/,
    );
    f.finish();
    await settle();
    expect(await f.service.status()).toMatchObject({ status: "complete" });
    expect(readConnections(f.root).CODEX_AUTH_JSON).toBe(auth("updated"));
    expect(existsSync(join(f.root, ".run", "ai", "codex.lock"))).toBe(false);
    expect(f.run.mock.calls.some(([args]) => args[0] === "rm")).toBe(true);
    expect(f.run.mock.calls.some(([args]) => args[0] === "logs")).toBe(false);
    expect(
      f.run.mock.calls
        .filter(([, options]) => options?.stdin)
        .every(([args]) => args[0] === "exec"),
    ).toBe(true);
    await f.service.close();
  });
  it("serializes concurrent refreshes, retains the updated cache, and returns access-only job snapshots", async () => {
    const f = fixture();
    saveConnections(f.root, { CODEX_AUTH_JSON: auth() });
    const first = f.service.prepare();
    await settle();
    const second = f.service.prepare();
    await settle();
    expect(f.executions).toBe(1);
    expect(f.inputs[0]).toEqual({ mode: "refresh", auth: auth() });
    f.finish();
    const [one, two] = await Promise.all([first, second]);
    expect(JSON.parse(one.CODEX_AUTH_JSON!).tokens).toMatchObject({
      access_token: "access-updated",
      refresh_token: "",
    });
    expect(JSON.parse(two.CODEX_AUTH_JSON!).tokens.refresh_token).toBe("");
    expect(readConnections(f.root).CODEX_AUTH_JSON).toBe(auth("updated"));
    const next = f.service.prepare();
    await settle();
    expect(f.inputs[1]).toEqual({ mode: "refresh", auth: auth("updated") });
    f.finish(auth("newer"));
    await next;
    expect(readConnections(f.root).CODEX_AUTH_JSON).toBe(auth("newer"));
    await f.service.close();
  });
  it("joins refresh launches started by Promise.all in the same turn without yielding", async () => {
    const f = fixture();
    saveConnections(f.root, { CODEX_AUTH_JSON: auth() });
    const pending = Promise.all([
      f.service.prepare(),
      f.service.prepare(),
      f.service.prepare(),
    ]);
    await settle();
    expect(f.executions).toBe(1);
    f.finish();
    const credentials = await pending;
    expect(credentials).toHaveLength(3);
    for (const value of credentials)
      expect(JSON.parse(value.CODEX_AUTH_JSON!).tokens).toMatchObject({
        access_token: "access-updated",
        refresh_token: "",
      });
    expect(readConnections(f.root).CODEX_AUTH_JSON).toBe(auth("updated"));
    expect(existsSync(join(f.root, ".run", "ai", "codex.lock"))).toBe(false);
    await f.service.close();
  });
  it("cancels a refresh while its same-turn launch is still acquiring the lock", async () => {
    const f = fixture();
    saveConnections(f.root, { CODEX_AUTH_JSON: auth() });
    const pending = f.service.prepare(),
      rejected = expect(pending).rejects.toThrow(/preparation was canceled/);
    await f.service.cancel();
    await rejected;
    expect(readConnections(f.root).CODEX_AUTH_JSON).toBe(auth());
    expect(existsSync(join(f.root, ".run", "ai", "codex.lock"))).toBe(false);
    await f.service.close();
  });
  it("cancels promptly during image preparation and never creates a helper when that shared build later resolves", async () => {
    const f = fixture();
    let completeImage: (image: string) => void = () => {};
    f.ensureImage.mockImplementation(
      () =>
        new Promise((resolve) => {
          completeImage = resolve;
        }),
    );
    await f.service.start();
    await settle();
    expect(f.ensureImage).toHaveBeenCalledOnce();
    expect(await f.service.cancel()).toMatchObject({ status: "canceled" });
    expect(existsSync(join(f.root, ".run", "ai", "codex.lock"))).toBe(false);
    completeImage(`shipgremlins-local:${"a".repeat(16)}`);
    await settle();
    expect(f.run.mock.calls.some(([args]) => args[0] === "create")).toBe(false);
    expect(readConnections(f.root).CODEX_AUTH_JSON).toBeUndefined();
    expect(await f.service.status()).toMatchObject({ status: "canceled" });
    await f.service.close();
  });
  it("does not overwrite a connection changed during helper refresh", async () => {
    const f = fixture();
    saveConnections(f.root, { CODEX_AUTH_JSON: auth() });
    const pending = f.service.prepare();
    const rejected = expect(pending).rejects.toThrow(/connection changed/);
    await settle();
    saveConnections(f.root, { CODEX_AUTH_JSON: auth("operator") });
    f.finish();
    await rejected;
    expect(readConnections(f.root).CODEX_AUTH_JSON).toBe(auth("operator"));
    expect(await f.service.status()).toMatchObject({ status: "failed" });
  });
  it("cancels a pending device login without saving credentials and rejects launches after shutdown", async () => {
    const f = fixture();
    await f.service.start();
    await settle();
    expect(await f.service.cancel()).toMatchObject({ status: "canceled" });
    expect(readConnections(f.root).CODEX_AUTH_JSON).toBeUndefined();
    expect(existsSync(join(f.root, ".run", "ai", "codex.lock"))).toBe(false);
    await f.service.close();
    await expect(f.service.start()).rejects.toThrow(/controller is stopping/);
  });
  it("rejects untrusted auth output and keeps prior credentials without exposing diagnostic contents", async () => {
    const f = fixture();
    saveConnections(f.root, { CODEX_AUTH_JSON: auth() });
    const pending = f.service.prepare();
    const rejected = expect(pending).rejects.toThrow(/could not finish/);
    await settle();
    f.finish(
      JSON.stringify({
        auth_mode: "apikey",
        OPENAI_API_KEY: "malicious-model-output",
      }),
    );
    await rejected;
    expect(readConnections(f.root).CODEX_AUTH_JSON).toBe(auth());
    expect(JSON.stringify(await f.service.status())).not.toMatch(
      /malicious|secret-runtime|never-return/,
    );
  });
  it("keeps the durable lock when Docker cleanup cannot be verified", async () => {
    const f = fixture();
    await f.service.start();
    await settle();
    f.run.mockImplementationOnce(async () => ({
      code: 1,
      stdout: "",
      stderr: "private-diagnostic",
    }));
    await expect(f.service.cancel()).rejects.toThrow(
      /cleanup could not be checked/,
    );
    expect(existsSync(join(f.root, ".run", "ai", "codex.lock"))).toBe(true);
    await f.service.close();
  });
  it("uses the refreshed descendant of an unchanged exported cache and honors an intentional exported replacement", async () => {
    const env = { CODEX_AUTH_JSON: auth() },
      f = fixture(env);
    const first = f.service.prepare();
    await settle();
    f.finish();
    await first;
    const second = f.service.prepare();
    await settle();
    expect(f.inputs[1]).toEqual({ mode: "refresh", auth: auth("updated") });
    f.finish(auth("newer"));
    await second;
    env.CODEX_AUTH_JSON = auth("operator");
    const replacement = f.service.prepare();
    await settle();
    expect(f.inputs[2]).toEqual({ mode: "refresh", auth: auth("operator") });
    f.finish(auth("replacement-refreshed"));
    await replacement;
    expect(readConnections(f.root).CODEX_AUTH_JSON).toBe(
      auth("replacement-refreshed"),
    );
    await f.service.close();
  });
  it("prevents a second controller service from using the same refresh stream concurrently", async () => {
    const f = fixture();
    await f.service.start();
    await settle();
    const other = createCodexLogin({
      root: f.root,
      packageRoot: f.root,
      run: f.run,
      ensureImage: async () => `shipgremlins-local:${"a".repeat(16)}`,
      env: () => ({}),
    });
    await expect(other.start()).rejects.toThrow(
      /Another Codex account operation/,
    );
    expect(f.executions).toBe(1);
    await f.service.cancel();
    await other.close();
  });
  it("does not admit canceled refresh credentials into a new job", async () => {
    const f = fixture();
    saveConnections(f.root, { CODEX_AUTH_JSON: auth() });
    const pending = f.service.prepare();
    const rejected = expect(pending).rejects.toThrow(
      /preparation was canceled/,
    );
    await settle();
    await f.service.cancel();
    await rejected;
    expect(readConnections(f.root).CODEX_AUTH_JSON).toBe(auth());
  });
});
