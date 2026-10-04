import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadHub, loadProject } from "../config.ts";
import { initializeSetup } from "../setup/files.ts";
import { inspectSetup } from "../setup/preflight.ts";
import { runSetup, type SetupDeps } from "./setup.ts";

const templatesRoot = fileURLToPath(new URL("../..", import.meta.url));
let root: string;
let output: string[];
let errors: string[];
const io = {
  log: (value: string) => output.push(value),
  error: (value: string) => errors.push(value),
};
const deps: SetupDeps = {
  env: {},
  templatesRoot,
  nodeVersion: "22.15.0",
  probe: () => ({ available: true, version: "1.2.3" }),
};
const input = {
  project: "demo-app",
  repo: "example/app",
  hubRepo: "example/hub",
  today: "2026-10-04",
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "gremlins-setup-"));
  output = [];
  errors = [];
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("setup initialization", () => {
  it("creates a valid fresh config with disabled PMs and only empty secret names", () => {
    const result = initializeSetup(root, templatesRoot, input);
    expect(result.created).toHaveLength(10);
    expect(loadHub(root).hubRepo).toBe("example/hub");
    const project = loadProject(root, "demo-app");
    expect(project.config.repo).toBe("example/app");
    expect(project.config.verified).toBeNull();
    expect(project.areas[0]!.enabled).toBe(false);
    const env = readFileSync(join(root, ".env.example"), "utf8");
    expect(env).toContain("VERCEL_BYPASS_DEMO_APP=\n");
    expect(
      env
        .split("\n")
        .filter((line) => line && !line.startsWith("#"))
        .every((line) => /^[A-Z][A-Z0-9_]*=$/.test(line)),
    ).toBe(true);
    expect(readFileSync(join(root, ".gitignore"), "utf8")).toContain(".env.*");
  });

  it("reruns preserve owner edits and never copy environment secrets", async () => {
    initializeSetup(root, templatesRoot, input);
    const mandate = join(root, "projects", "demo-app", "core", "mandate.md");
    writeFileSync(mandate, "My custom mandate\n");
    writeFileSync(join(root, ".env"), "GITHUB_TOKEN=private-token\n");
    const before = readFileSync(join(root, "hub.json"), "utf8");
    const code = await runSetup(
      root,
      [
        "init",
        "--project",
        input.project,
        "--repo",
        input.repo,
        "--hub-repo",
        input.hubRepo,
        "--json",
      ],
      io,
      { ...deps, env: { GITHUB_TOKEN: "private-token" } },
    );
    expect(code).toBe(0);
    expect(JSON.parse(output[0]!).created).toEqual([]);
    expect(readFileSync(mandate, "utf8")).toBe("My custom mandate\n");
    expect(readFileSync(join(root, "hub.json"), "utf8")).toBe(before);
    expect(readFileSync(join(root, ".env"), "utf8")).toContain("private-token");
    expect(output.join("\n")).not.toContain("private-token");
    expect(readFileSync(join(root, ".env.example"), "utf8")).not.toContain(
      "private-token",
    );
  });

  it("fails all conflicts before changing any files", () => {
    mkdirSync(join(root, ".env.example"));
    expect(() => initializeSetup(root, templatesRoot, input)).toThrow(
      "not a regular file",
    );
    expect(readdirSync(root)).toEqual([".env.example"]);
  });

  it("never replaces an existing hub or project with a different identity", () => {
    initializeSetup(root, templatesRoot, input);
    expect(() =>
      initializeSetup(root, templatesRoot, {
        ...input,
        hubRepo: "different/hub",
      }),
    ).toThrow("different repository");
    expect(() =>
      initializeSetup(root, templatesRoot, { ...input, repo: "different/app" }),
    ).toThrow("different repository");
    expect(loadHub(root).hubRepo).toBe(input.hubRepo);
    expect(loadProject(root, input.project).config.repo).toBe(input.repo);
  });

  it.each([
    "../escape",
    "..\\escape",
    "bad/name",
    "CON",
    "con",
    "lpt1",
    "has spaces",
  ])("rejects unsafe project name %s without writes", (name) => {
    expect(() =>
      initializeSetup(root, templatesRoot, { ...input, project: name }),
    ).toThrow("kebab-case");
    expect(readdirSync(root)).toEqual([]);
  });

  it.each([
    "../repo",
    "owner/..",
    "owner/.",
    "https://token@github.com/owner/repo",
  ])("rejects unsafe repository %s", (repo) => {
    expect(() =>
      initializeSetup(root, templatesRoot, { ...input, repo }),
    ).toThrow("repository must");
    expect(readdirSync(root)).toEqual([]);
  });

  it("rejects a missing template before writing hub.json", () => {
    expect(() => initializeSetup(root, root, input)).toThrow("template");
    expect(existsSync(join(root, "hub.json"))).toBe(false);
  });

  it("rejects project-directory junctions without writing outside the destination", () => {
    const outside = join(root, "external");
    mkdirSync(outside);
    const target = join(root, "config");
    mkdirSync(join(target, "projects"), { recursive: true });
    symlinkSync(outside, join(target, "projects", "demo-app"), "junction");
    expect(() => initializeSetup(target, templatesRoot, input)).toThrow(
      "symbolic links",
    );
    expect(readdirSync(outside)).toEqual([]);
    expect(existsSync(join(target, "hub.json"))).toBe(false);
  });
});

describe("setup status and CLI", () => {
  it.each([
    { version: "22.0.0", status: "fail" },
    { version: "22.11.9", status: "fail" },
    { version: "22.12.0", status: "pass" },
    { version: "v22.12.1", status: "pass" },
    { version: "24.0.0", status: "pass" },
    { version: "unknown", status: "fail" },
  ])(
    "enforces the Node toolchain floor for $version",
    ({ version, status }) => {
      expect(
        inspectSetup(root, { ...deps, nodeVersion: version }).checks.find(
          (check) => check.id === "node",
        )?.status,
      ).toBe(status);
    },
  );
  it("defaults to a read-only status, with --check making failures nonzero", async () => {
    expect(await runSetup(root, [], io, deps)).toBe(0);
    expect(await runSetup(root, ["--check"], io, deps)).toBe(1);
    expect(readdirSync(root)).toEqual([]);
  });

  it("supports an explicit fresh directory and produces usable JSON", async () => {
    expect(
      await runSetup(
        root,
        [
          "init",
          "--dir",
          "fresh",
          "--project",
          input.project,
          "--repo",
          input.repo,
          "--hub-repo",
          input.hubRepo,
          "--json",
        ],
        io,
        deps,
      ),
    ).toBe(0);
    expect(JSON.parse(output[0]!).directory).toBe(join(root, "fresh"));
    expect(loadProject(join(root, "fresh"), input.project).config.repo).toBe(
      input.repo,
    );
    expect(existsSync(join(root, "hub.json"))).toBe(false);
  });

  it("does not misrepresent GitLab/Railway or a static site as implemented", () => {
    const report = inspectSetup(root, deps);
    expect(
      report.capabilities.find((capability) =>
        capability.name.includes("GitLab"),
      )?.status,
    ).toBe("planned");
    expect(
      report.capabilities.find((capability) =>
        capability.name.includes("Dashboard"),
      )?.status,
    ).toBe("planned");
  });

  it("fails on old Node and missing git/npm, but absent optional tools only warn", () => {
    const report = inspectSetup(root, {
      ...deps,
      nodeVersion: "20.10.0",
      probe: () => ({ available: false }),
    });
    for (const tool of ["node", "git", "npm"])
      expect(report.checks.find((check) => check.id === tool)?.status).toBe(
        "fail",
      );
    for (const tool of ["docker", "claude"])
      expect(report.checks.find((check) => check.id === tool)?.status).toBe(
        "warn",
      );
  });

  it("reports secret presence only, even when malformed JSON contains credentials", () => {
    initializeSetup(root, templatesRoot, input);
    const report = inspectSetup(root, {
      ...deps,
      env: {
        GITHUB_TOKEN: "super-secret-value",
        SLACK_WEBHOOK_DEMO_APP: "another-private-value",
      },
    });
    expect(
      report.secrets.find((secret) => secret.name === "GITHUB_TOKEN")?.present,
    ).toBe(true);
    expect(JSON.stringify(report)).not.toMatch(
      /super-secret-value|another-private-value/,
    );
    writeFileSync(join(root, "hub.json"), '{"token":"malformed-secret-value"');
    expect(JSON.stringify(inspectSetup(root, deps))).not.toContain(
      "malformed-secret-value",
    );
  });

  it("can distinguish a configured local installation from provider certification", () => {
    initializeSetup(root, templatesRoot, input);
    const projectFile = join(root, "projects", input.project, "project.json");
    const project = JSON.parse(readFileSync(projectFile, "utf8"));
    project.vercel.projectId = "prj_test";
    writeFileSync(projectFile, JSON.stringify(project));
    const areasFile = join(root, "projects", input.project, "areas.json");
    const areas = JSON.parse(readFileSync(areasFile, "utf8"));
    areas.areas.core.linearProjectId = "linear-project";
    writeFileSync(areasFile, JSON.stringify(areas));
    const env = Object.fromEntries(
      [
        "GITHUB_TOKEN",
        "LINEAR_API_KEY",
        "VERCEL_TOKEN",
        "SLACK_WEBHOOK_DEMO_APP",
        "VERCEL_BYPASS_DEMO_APP",
      ].map((name) => [name, "present-not-validated"]),
    );
    const report = inspectSetup(root, { ...deps, env });
    expect(report.ready).toBe(true);
    expect(
      report.checks.find((check) => check.id === "verified:demo-app")?.status,
    ).toBe("warn");
    expect(
      report.checks.find((check) => check.id === "runner-enrollment")?.status,
    ).toBe("warn");
    expect(JSON.stringify(report)).not.toContain("present-not-validated");
  });

  it("never exposes credential values accidentally stored as legacy secret references", () => {
    initializeSetup(root, templatesRoot, input);
    const path = join(root, "projects", input.project, "project.json");
    const project = JSON.parse(readFileSync(path, "utf8"));
    project.slackWebhookSecret = "https://private.example/secret-value";
    writeFileSync(path, JSON.stringify(project));
    const report = inspectSetup(root, deps);
    expect(report.ready).toBe(false);
    expect(JSON.stringify(report)).not.toContain("secret-value");
  });

  it.each([
    ["init", "--project", "demo", "--repo", "owner/app", "--dir", "../outside"],
    ["init", "--project", "demo", "--repo", "owner/app", "--runner", "random"],
    [
      "init",
      "--project",
      "demo",
      "--repo",
      "owner/app",
      "--token",
      "never-print-me",
    ],
    ["--project", "../escape"],
    ["--repo", "owner/app"],
  ])(
    "rejects unsupported/unsafe arguments without writes: %j",
    async (...args) => {
      expect(await runSetup(root, args, io, deps)).toBe(1);
      expect(readdirSync(root)).toEqual([]);
      expect(errors.join("\n")).not.toContain("never-print-me");
    },
  );
});
