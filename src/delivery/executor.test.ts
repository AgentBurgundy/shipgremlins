import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeProject } from "../services/fakes.ts";
import {
  candidateIdentity,
  createPromotionExecutor,
  type PromotionRun,
} from "./executor.ts";
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
describe("isolated promotion executor", () => {
  it("never runs checks as root even when the controller is root", () => {
    expect(candidateIdentity(0, 0)).toEqual({ uid: 1000, gid: 1000 });
    expect(candidateIdentity()).toEqual({ uid: 1000, gid: 1000 });
    expect(candidateIdentity(1200, 1201)).toEqual({ uid: 1200, gid: 1201 });
  });
  it("keeps credentials in controller Git environment and commands inside a read-only mounted container", async () => {
    const root = realpathSync(
      mkdtempSync(join(tmpdir(), "gremlins-promotion-")),
    );
    roots.push(root);
    const calls: {
      command: string;
      args: string[];
      options: Parameters<PromotionRun>[2];
    }[] = [];
    const run: PromotionRun = async (command, args, options) => {
      calls.push({ command, args, options });
      return { code: 0, out: "passed", err: "" };
    };
    const executor = await createPromotionExecutor({
      root,
      project: makeProject(),
      token: "source-secret",
      docker: {
        ensureImage: async () => "shipgremlins-local:aaaaaaaaaaaaaaaa",
      },
      run,
    });
    expect(await executor.check(executor.checkoutDir)).toMatchObject({
      ok: true,
    });
    expect(calls.map((c) => c.command)).toEqual(["git", "docker"]);
    expect(calls[0]!.options.env?.GIT_CONFIG_VALUE_0).toContain(
      "Authorization: Basic ",
    );
    expect(JSON.stringify(calls[0]!.args)).not.toContain("source-secret");
    expect(calls[1]!.args).toContain("--read-only");
    expect(calls[1]!.args).toContain("timeout");
    expect(calls[1]!.args).toContain("--kill-after=10s");
    expect(calls[1]!.args).toContain("15m");
    expect(
      calls[1]!.args.some((a) => a.endsWith("target=/source,readonly")),
    ).toBe(true);
    expect(calls[1]!.options.env).toBeUndefined();
    expect(calls[1]!.options.input).toContain("npm test");
    expect(JSON.stringify(calls[1])).not.toContain("source-secret");
    await expect(executor.git.run(["status"], root)).rejects.toThrow("escaped");
  });
  it("does not force-delete a timed-out container without its ownership label", async () => {
    const root = realpathSync(
      mkdtempSync(join(tmpdir(), "gremlins-promotion-timeout-")),
    );
    roots.push(root);
    const calls: string[][] = [];
    const run: PromotionRun = async (command, args) => {
      if (command === "docker") {
        calls.push(args);
        return { code: args[0] === "run" ? 124 : 0, out: "false", err: "" };
      }
      return { code: 0, out: "", err: "" };
    };
    const executor = await createPromotionExecutor({
      root,
      project: makeProject(),
      token: "token",
      docker: {
        ensureImage: async () => "shipgremlins-local:aaaaaaaaaaaaaaaa",
      },
      run,
    });
    expect((await executor.check(executor.checkoutDir)).ok).toBe(false);
    expect(calls.some((args) => args[0] === "rm")).toBe(false);
  });
});
