import { afterEach, describe, expect, it } from "vitest";
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  rmSync,
  mkdirSync,
  symlinkSync,
  statSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { readConnections, saveConnections } from "./connections.ts";

const directories: string[] = [];
function temporary(): string {
  const directory = mkdtempSync(
    join(realpathSync(tmpdir()), "sg-connections-test-"),
  );
  directories.push(directory);
  return directory;
}
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe("dashboard connection storage", () => {
  it("preserves unrelated dotenv content, comments and multiline values while replacing old tokens", () => {
    const root = temporary();
    const untouched =
      '# custom settings\r\nNODE_OPTIONS="--require ./example.cjs"\r\nPRIVATE_KEY="first\nGITHUB_TOKEN=not-a-real-assignment\nlast"\r\nOTHER=value # keep me\r\n';
    writeFileSync(
      join(root, ".env"),
      `${untouched}export GITHUB_TOKEN='old-token'\r\nGITHUB_TOKEN=duplicate\r\nLINEAR_API_KEY='keep-linear'\r\n`,
    );
    saveConnections(root, {
      GITHUB_TOKEN: "ghp-new",
      LINEAR_API_KEY: "   ",
      VERCEL_TOKEN: "vercel#value",
    });
    const source = readFileSync(join(root, ".env"), "utf8");
    expect(source).toContain(untouched);
    expect(source).not.toContain("old-token");
    expect(source).not.toContain("duplicate");
    expect(parseEnv(source)).toMatchObject({
      GITHUB_TOKEN: "ghp-new",
      LINEAR_API_KEY: "keep-linear",
      VERCEL_TOKEN: "vercel#value",
      NODE_OPTIONS: "--require ./example.cjs",
    });
    expect(readConnections(root)).toEqual({
      GITHUB_TOKEN: "ghp-new",
      LINEAR_API_KEY: "keep-linear",
      VERCEL_TOKEN: "vercel#value",
    });
  });

  it("creates private configuration files and returns only allowlisted credentials", () => {
    const root = join(temporary(), "new-config");
    expect(readConnections(root)).toEqual({});
    saveConnections(root, {
      GITHUB_TOKEN: "ghp_example",
      CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-test",
    });
    expect(readConnections(root)).toEqual({
      GITHUB_TOKEN: "ghp_example",
      CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-test",
    });
    if (process.platform !== "win32")
      expect(statSync(join(root, ".env")).mode & 0o777).toBe(0o600);
  });

  it.each([
    { NODE_OPTIONS: "--require malware" },
    { GITHUB_TOKEN: "abc\nVERCEL_TOKEN=injected" },
    { GITHUB_TOKEN: "'quoted'" },
    { VERCEL_TOKEN: "a".repeat(8193) },
    { LINEAR_API_KEY: true },
  ])(
    "rejects unknown keys and unsafe values without modifying files",
    (values) => {
      const root = temporary();
      writeFileSync(join(root, ".env"), "OTHER=preserved\n");
      expect(() => saveConnections(root, values)).toThrow();
      expect(readFileSync(join(root, ".env"), "utf8")).toBe(
        "OTHER=preserved\n",
      );
    },
  );

  it("refuses junction destinations and preserves the external file", () => {
    const root = temporary();
    const external = temporary();
    writeFileSync(join(external, ".env"), "GITHUB_TOKEN=secret-external\n");
    symlinkSync(external, join(root, "linked"), "junction");
    expect(() => readConnections(join(root, "linked"))).toThrow(
      "Saved connections could not be read",
    );
    expect(() =>
      saveConnections(join(root, "linked"), { GITHUB_TOKEN: "new" }),
    ).toThrow("Connections could not be saved");
    expect(readFileSync(join(external, ".env"), "utf8")).toBe(
      "GITHUB_TOKEN=secret-external\n",
    );
  });

  it("returns sanitized file errors without exposing credential content", () => {
    const root = temporary();
    mkdirSync(join(root, ".env"));
    expect(() =>
      saveConnections(root, { GITHUB_TOKEN: "never-print-this" }),
    ).toThrow("Connections could not be saved");
    expect(() => readConnections(root)).toThrow(
      "Saved connections could not be read",
    );
  });

  it("refuses dangling symlink destinations without replacing the link", () => {
    const root = temporary();
    const missing = join(root, "missing-directory");
    // Junction creation works without elevated Windows symbolic-link privileges.
    symlinkSync(missing, join(root, "linked"), "junction");
    expect(() => readConnections(join(root, "linked"))).toThrow(
      "Saved connections could not be read",
    );
    expect(() =>
      saveConnections(join(root, "linked"), { GITHUB_TOKEN: "secret" }),
    ).toThrow("Connections could not be saved");
  });
});
