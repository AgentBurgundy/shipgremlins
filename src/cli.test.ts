import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildCheck, main } from "./cli.ts";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "gremlins-gates-"));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

function record(name: string): string {
  return `node -e "require('fs').appendFileSync('gates.txt','${name}\\n')"`;
}

describe("promotion command checks", () => {
  it("does not give application build commands the verifier signing key or evidence path", async () => {
    vi.stubEnv("SHIPGREMLINS_ATTESTATION_KEY", "controller-only-secret");
    vi.stubEnv("SHIPGREMLINS_VERIFICATION_FILE", "controller-only-evidence");
    const check = buildCheck({
      install:
        "node -e \"require('fs').writeFileSync('env.json',JSON.stringify({hasKey:!!process.env.SHIPGREMLINS_ATTESTATION_KEY,hasEvidence:!!process.env.SHIPGREMLINS_VERIFICATION_FILE}))\"",
      test: 'node -e "process.exit(0)"',
      lint: null,
      typecheck: null,
    });
    expect((await check(root)).ok).toBe(true);
    expect(JSON.parse(readFileSync(join(root, "env.json"), "utf8"))).toEqual({
      hasKey: false,
      hasEvidence: false,
    });
  });
  it("requires lint and the configured application build alongside install, typecheck, and tests", async () => {
    const check = buildCheck({
      install: record("install"),
      lint: record("lint"),
      typecheck: record("typecheck"),
      test: record("test"),
      build: record("build"),
    });
    expect(await check(root)).toEqual({ ok: true, output: "" });
    expect(readFileSync(join(root, "gates.txt"), "utf8")).toBe(
      "install\nlint\ntypecheck\ntest\nbuild\n",
    );
  });

  it("blocks subsequent tests and build if lint fails", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const check = buildCheck({
      install: record("install"),
      lint: 'node -e "process.exit(2)"',
      typecheck: record("typecheck"),
      test: record("test"),
      build: record("build"),
    });
    expect((await check(root)).ok).toBe(false);
    expect(readFileSync(join(root, "gates.txt"), "utf8")).toBe("install\n");
  });

  it("remains compatible with applications without optional build/type/lint commands", async () => {
    const check = buildCheck({
      install: record("install"),
      test: record("test"),
      lint: null,
      typecheck: null,
    });
    expect((await check(root)).ok).toBe(true);
    expect(readFileSync(join(root, "gates.txt"), "utf8")).toBe(
      "install\ntest\n",
    );
  });

  it("exposes setup help without loading provider clients or credentials", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    expect(await main(["setup", "--help"])).toBe(0);
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("ShipGremlins setup"),
    );
  });

  it("rejects ticket audits without a project before reading credentials", async () => {
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    expect(await main(["tickets", "audit"])).toBe(1);
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("--project NAME"),
    );
  });
});
