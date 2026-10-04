import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeProject } from "../services/fakes.ts";
import {
  CRONS_END,
  CRONS_START,
  checkCrons,
  cronEntries,
  extractCronsBlock,
  runCrons,
  scheduleBlock,
  writeCronsBlock,
} from "./crons.ts";

const game = makeProject({
  config: { name: "game", verified: "2026-10-01" },
  areas: [
    { key: "core", schedule: "0 13 * * 1-5" },
    { key: "ui", schedule: "0 14 * * 1-5" },
    { key: "paused", schedule: "0 15 * * 1-5", enabled: false },
  ],
});
const draft = makeProject({
  config: { name: "draft", verified: null },
  areas: [{ key: "core", schedule: "0 9 * * 1-5" }],
});
const shop = makeProject({
  config: { name: "shop", verified: "2026-10-02" },
  areas: [{ key: "core", schedule: "0 13 * * 1-5" }],
});

const GENERATED_COMMENT = [
  "# generated: do not edit — `npx tsx src/cli.ts crons write` rewrites this",
  "# block from projects/*/areas.json; hub CI runs `crons --check` on drift.",
];

const YAML = `name: pm-agent
on:
  schedule:
    ${CRONS_START}
    - cron: "0 1 * * *" # stale
    ${CRONS_END}
  workflow_dispatch:
    inputs:
      project:
        required: true
jobs: {}
`;

describe("cronEntries", () => {
  it("lists enabled areas of verified projects only, project then area order", () => {
    expect(cronEntries([shop, draft, game])).toEqual([
      { project: "game", area: "core", cron: "0 13 * * 1-5" },
      { project: "game", area: "ui", cron: "0 14 * * 1-5" },
      { project: "shop", area: "core", cron: "0 13 * * 1-5" },
    ]);
  });
});

describe("scheduleBlock", () => {
  it("emits one cron item per distinct cron, naming every project/area on it", () => {
    expect(scheduleBlock(cronEntries([game, shop]))).toBe(
      [
        ...GENERATED_COMMENT,
        '- cron: "0 13 * * 1-5" # game/core, shop/core',
        '- cron: "0 14 * * 1-5" # game/ui',
      ].join("\n"),
    );
  });

  it("emits a placeholder cron when nothing is verified (GitHub refuses an empty schedule)", () => {
    expect(scheduleBlock(cronEntries([draft]))).toBe(
      [
        ...GENERATED_COMMENT,
        '- cron: "0 13 * * 1-5" # placeholder until the first project passes `hub doctor`',
      ].join("\n"),
    );
  });
});

describe("extractCronsBlock / checkCrons / writeCronsBlock", () => {
  it("extracts the lines between the markers with their indent", () => {
    expect(extractCronsBlock(YAML)).toEqual({
      indent: "    ",
      lines: ['- cron: "0 1 * * *" # stale'],
    });
    expect(extractCronsBlock("no markers here")).toBeNull();
  });

  it("checkCrons reports drift and agreement", () => {
    const entries = cronEntries([game]);
    expect(checkCrons(YAML, entries).ok).toBe(false);
    const fresh = writeCronsBlock(YAML, entries);
    expect(checkCrons(fresh, entries).ok).toBe(true);
  });

  it("writeCronsBlock replaces only the block and keeps the marker indent", () => {
    const out = writeCronsBlock(YAML, cronEntries([game]));
    expect(out).toContain(
      [
        `    ${CRONS_START}`,
        ...GENERATED_COMMENT.map((l) => `    ${l}`),
        '    - cron: "0 13 * * 1-5" # game/core',
        '    - cron: "0 14 * * 1-5" # game/ui',
        `    ${CRONS_END}`,
        "",
      ].join("\n"),
    );
    expect(out).not.toContain("stale");
    expect(out.startsWith("name: pm-agent\n")).toBe(true);
    expect(out.endsWith("jobs: {}\n")).toBe(true);
  });

  it("writeCronsBlock is idempotent", () => {
    const once = writeCronsBlock(YAML, cronEntries([game]));
    expect(writeCronsBlock(once, cronEntries([game]))).toBe(once);
  });

  it("writeCronsBlock throws when the markers are missing", () => {
    expect(() => writeCronsBlock("on: push", [])).toThrow(
      /generated-crons-start/,
    );
  });
});

describe("runCrons (CLI)", () => {
  let root: string;
  const out: string[] = [];
  const err: string[] = [];
  const io = {
    log: (l: string) => out.push(l),
    error: (l: string) => err.push(l),
  };

  function seedProject(
    name: string,
    verified: string | null,
    cron: string,
  ): void {
    const dir = join(root, "projects", name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "project.json"),
      JSON.stringify({
        repo: `owner/${name}`,
        branches: {
          production: "main",
          staging: "staging",
          integration: "pm-staging",
        },
        vercel: {
          projectId: "prj",
          teamId: null,
          bypassSecret: "VERCEL_BYPASS_X",
        },
        database: "none",
        slackWebhookSecret: "SLACK_WEBHOOK_X",
        runnerLabel: null,
        mergeMethod: "squash",
        commands: {
          install: "npm ci",
          test: "npm test",
          lint: null,
          typecheck: null,
        },
        verified,
      }),
    );
    writeFileSync(
      join(dir, "areas.json"),
      JSON.stringify({
        areas: {
          core: {
            name: "Core",
            paths: ["app/"],
            sharedTouchpoints: [],
            linearProjectId: "lin",
            label: "pm:core",
            wipLimit: 1,
            metric: "/",
            schedule: cron,
            enabled: true,
          },
        },
      }),
    );
    writeFileSync(
      join(dir, "tiers.json"),
      JSON.stringify({
        ownerOnlyPrefixes: [],
        hubOwnerOnly: [],
        alwaysFree: [],
        guardTests: [],
        testFileMarkers: [],
      }),
    );
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "pm-hub-crons-"));
    out.length = 0;
    err.length = 0;
    seedProject("game", "2026-10-01", "0 13 * * 1-5");
    seedProject("draft", null, "0 9 * * 1-5");
    mkdirSync(join(root, ".github", "workflows"), { recursive: true });
    writeFileSync(join(root, ".github", "workflows", "pm-agent.yml"), YAML);
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("--json prints the entries", async () => {
    expect(await runCrons(root, ["--json"], io)).toBe(0);
    expect(JSON.parse(out.join("\n"))).toEqual([
      { project: "game", area: "core", cron: "0 13 * * 1-5" },
    ]);
  });

  it("default prints the schedule block", async () => {
    expect(await runCrons(root, [], io)).toBe(0);
    expect(out.join("\n")).toContain('- cron: "0 13 * * 1-5" # game/core');
  });

  it("--check exits 1 on drift, write fixes it, --check then exits 0", async () => {
    expect(await runCrons(root, ["--check"], io)).toBe(1);
    expect(err.join("\n")).toContain("drift");
    expect(await runCrons(root, ["write"], io)).toBe(0);
    const yaml = readFileSync(
      join(root, ".github", "workflows", "pm-agent.yml"),
      "utf8",
    );
    expect(yaml).toContain('- cron: "0 13 * * 1-5" # game/core');
    expect(await runCrons(root, ["--check"], io)).toBe(0);
  });

  it("--check exits 1 when pm-agent.yml is missing", async () => {
    rmSync(join(root, ".github"), { recursive: true });
    expect(await runCrons(root, ["--check"], io)).toBe(1);
    expect(err.join("\n")).toContain("pm-agent.yml");
  });
});
