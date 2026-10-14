import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DockerRun } from "../localRunners/docker.ts";
import { createCodexLogin } from "./codexLogin.ts";
import {
  clearConnections,
  readConnections,
  saveConnections,
} from "./connections.ts";

const roots: string[] = [];
const auth = (label: string, account = "account-123") =>
  JSON.stringify({
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens: {
      id_token: `id-${label}`,
      access_token: `access-${label}`,
      refresh_token: `refresh-${label}`,
      account_id: account,
    },
    last_refresh: "2026-10-10T00:00:00.000Z",
  });
const settle = async () => {
  for (let count = 0; count < 30; count++) await Promise.resolve();
};
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(
    join(realpathSync(tmpdir()), "gremlins-codex-lifecycle-"),
  );
  roots.push(root);
  let container = "",
    owner = "",
    cache = auth("helper-result"),
    completed = false;
  let release: (value: {
    code: number;
    stdout: string;
    stderr: string;
  }) => void = () => {};
  let holdAuth = false,
    releaseAuth: (value: {
      code: number;
      stdout: string;
      stderr: string;
    }) => void = () => {};
  const run = vi.fn<DockerRun>(async (args) => {
    if (args[0] === "create") {
      container = args[args.indexOf("--name") + 1]!;
      owner = args[args.indexOf("--label") + 1]!.split("=")[1]!;
    }
    if (args[0] === "ps") return { code: 0, stdout: container, stderr: "" };
    if (args[0] === "inspect") return { code: 0, stdout: owner, stderr: "" };
    if (args[0] === "rm") {
      container = "";
      release({ code: 1, stdout: "", stderr: "" });
    }
    if (args[0] === "exec" && args[1] === "-i")
      return new Promise((resolve) => {
        release = resolve;
      });
    if (args[0] === "exec") {
      if (args.at(-1)!.includes("status.json"))
        return {
          code: 0,
          stdout: JSON.stringify(
            completed
              ? { status: "complete" }
              : {
                  status: "pending",
                  verificationUrl: "https://auth.openai.com/codex/device",
                  userCode: "ABCD-1234",
                  expiresAt: new Date(Date.now() + 900000).toISOString(),
                },
          ),
          stderr: "",
        };
      if (holdAuth)
        return new Promise((resolve) => {
          releaseAuth = resolve;
        });
      return { code: 0, stdout: cache, stderr: "" };
    }
    return { code: 0, stdout: "", stderr: "" };
  });
  const service = createCodexLogin({
    root,
    packageRoot: root,
    run,
    env: () => ({}),
    ensureImage: async () => `shipgremlins-local:${"a".repeat(16)}`,
  });
  return {
    root,
    service,
    run,
    complete(raw = cache) {
      cache = raw;
      completed = true;
      release({ code: 0, stdout: "", stderr: "" });
    },
    holdAuth() {
      holdAuth = true;
    },
    releaseAuth() {
      releaseAuth({ code: 0, stdout: cache, stderr: "" });
    },
  };
}

describe("Codex connection replacement and removal during account operations", () => {
  it("does not resurrect a cleared canonical connection after an in-flight refresh", async () => {
    const f = fixture();
    saveConnections(f.root, { CODEX_AUTH_JSON: auth("original") });
    const pending = f.service.prepare(),
      rejected = expect(pending).rejects.toThrow(/connection changed/);
    await settle();
    clearConnections(f.root, ["CODEX_AUTH_JSON"]);
    f.complete();
    await rejected;
    expect(readConnections(f.root).CODEX_AUTH_JSON).toBeUndefined();
    expect(await f.service.status()).toMatchObject({ status: "failed" });
    expect(existsSync(join(f.root, ".run", "ai", "codex.lock"))).toBe(false);
  });
  it("checks credential replacement after receiving the private refreshed file, not just before the helper exits", async () => {
    const f = fixture();
    saveConnections(f.root, { CODEX_AUTH_JSON: auth("original") });
    f.holdAuth();
    const pending = f.service.prepare(),
      rejected = expect(pending).rejects.toThrow(/connection changed/);
    await settle();
    f.complete();
    await settle();
    saveConnections(f.root, { CODEX_AUTH_JSON: auth("operator-replacement") });
    f.releaseAuth();
    await rejected;
    expect(readConnections(f.root).CODEX_AUTH_JSON).toBe(
      auth("operator-replacement"),
    );
  });
  it("does not overwrite a newly imported connection when a prior device login completes", async () => {
    const f = fixture();
    await f.service.start();
    await settle();
    saveConnections(f.root, { CODEX_AUTH_JSON: auth("operator-replacement") });
    f.complete();
    await settle();
    expect(readConnections(f.root).CODEX_AUTH_JSON).toBe(
      auth("operator-replacement"),
    );
    expect(await f.service.status()).toMatchObject({ status: "failed" });
    await f.service.close();
  });
  it("cancels a first-time login before clearing and ignores its late successful result", async () => {
    const f = fixture();
    await f.service.start();
    await settle();
    await f.service.cancel();
    clearConnections(f.root, ["CODEX_AUTH_JSON"]);
    f.complete();
    await settle();
    expect(readConnections(f.root).CODEX_AUTH_JSON).toBeUndefined();
    expect(await f.service.status()).toMatchObject({ status: "canceled" });
    expect(
      f.run.mock.calls.some(
        ([args]) =>
          args[0] === "exec" &&
          args[1] !== "-i" &&
          args.at(-1)!.includes("auth.json"),
      ),
    ).toBe(false);
  });
  it("rejects a trusted refresh that unexpectedly changes ChatGPT accounts", async () => {
    const f = fixture();
    saveConnections(f.root, { CODEX_AUTH_JSON: auth("original") });
    const pending = f.service.prepare(),
      rejected = expect(pending).rejects.toThrow(/different ChatGPT account/);
    await settle();
    f.complete(auth("wrong-account", "account-456"));
    await rejected;
    expect(readConnections(f.root).CODEX_AUTH_JSON).toBe(auth("original"));
  });
});
