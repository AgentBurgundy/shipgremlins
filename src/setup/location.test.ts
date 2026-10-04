import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  configurationRoot,
  detectHubRepository,
  githubRepository,
} from "./location.ts";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "gremlins-location-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("global CLI configuration", () => {
  it("uses persistent user configuration outside a hub checkout", () => {
    expect(configurationRoot(root, undefined, root)).toBe(
      join(root, ".shipgremlins"),
    );
  });
  it("finds the nearest hub from a subdirectory, even if its configuration needs repair", () => {
    const nested = join(root, "hub", "projects", "app");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(root, "hub.json"), "{}");
    writeFileSync(join(root, "hub", "hub.json"), "invalid");
    expect(configurationRoot(nested)).toBe(join(root, "hub"));
    expect(configurationRoot(nested, "custom")).toBe(join(nested, "custom"));
  });
  it("detects an HTTPS Git origin for a new configuration without contacting GitHub", () => {
    execFileSync("git", ["init", root], { stdio: "ignore" });
    execFileSync("git", [
      "-C",
      root,
      "remote",
      "add",
      "origin",
      "https://github.com/example/operations.git",
    ]);
    expect(detectHubRepository(join(root, "new", "config"))).toBe(
      "example/operations",
    );
  });
  it.each([
    "https://github.com/example/hub.git",
    "git@github.com:example/hub.git",
    "ssh://git@github.com/example/hub.git",
  ])("accepts GitHub origin %s", (remote) => {
    expect(githubRepository(remote)).toBe("example/hub");
  });
  it.each([
    "https://secret@github.com/example/hub.git",
    "https://github.com.example.com/example/hub",
    "https://gitlab.com/example/hub.git",
    "https://github.com/example/hub?token=secret",
    "https://github.com/example/..",
    "file:///somewhere/hub",
  ])("does not infer an unsafe or unsupported origin %s", (remote) => {
    expect(githubRepository(remote)).toBeUndefined();
  });
});
