import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HubConfig, ProjectConfig } from "./config.ts";
import { resolveRunsOn, launchNeeded, launchOutputs, main } from "./runners.ts";

const hub = (mode: HubConfig["runners"]["mode"]): HubConfig => ({
  hubRepo: "owner/pm-hub",
  runners: { mode, label: "pm" },
  gce: {
    project: "gcp-proj",
    zone: "us-central1-a",
    image: "pm-runner",
    machineType: "e2-standard-4",
    spot: false,
  },
});

const project = (runnerLabel: string | null): ProjectConfig => ({
  name: "game",
  repo: "owner/game",
  branches: {
    production: "main",
    staging: "staging",
    integration: "pm-staging",
  },
  vercel: {
    projectId: "prj_1",
    teamId: null,
    bypassSecret: "VERCEL_BYPASS_GAME",
  },
  database: "none",
  slackWebhookSecret: "SLACK_WEBHOOK_GAME",
  runnerLabel,
  mergeMethod: "squash",
  commands: {
    install: "npm ci",
    test: "npm test",
    lint: null,
    typecheck: null,
  },
  verified: null,
  signIn: null,
});

describe("resolveRunsOn", () => {
  it("self-hosted mode uses the hub label", () => {
    expect(resolveRunsOn(hub("self-hosted"), null, "pm-1")).toBe(
      '["self-hosted","pm"]',
    );
    expect(resolveRunsOn(hub("self-hosted"), project(null), "pm-1")).toBe(
      '["self-hosted","pm"]',
    );
  });

  it("a project's runnerLabel overrides the hub label", () => {
    expect(resolveRunsOn(hub("self-hosted"), project("big-box"), "pm-1")).toBe(
      '["self-hosted","big-box"]',
    );
  });

  it("gce mode targets the per-run label only", () => {
    expect(resolveRunsOn(hub("gce"), project("big-box"), "pm-42")).toBe(
      '["pm-42"]',
    );
  });

  it("the result is a JSON array fromJSON() can take", () => {
    const parsed: unknown = JSON.parse(
      resolveRunsOn(hub("self-hosted"), null, "x"),
    );
    expect(Array.isArray(parsed)).toBe(true);
  });
});

describe("launchNeeded", () => {
  it("is true only in gce mode", () => {
    expect(launchNeeded(hub("self-hosted"))).toBe(false);
    expect(launchNeeded(hub("gce"))).toBe(true);
  });
});

describe("launchOutputs", () => {
  it("carries everything the launch and teardown jobs read", () => {
    const out = launchOutputs(hub("gce"), null, "pm-7");
    expect(out).toEqual({
      runsOn: '["pm-7"]',
      launch: "true",
      runLabel: "pm-7",
      vmName: "pm-7",
      gcpProject: "gcp-proj",
      zone: "us-central1-a",
      image: "pm-runner",
      machineType: "e2-standard-4",
      spot: "false",
    });
  });
});

describe("main (the launch job's command)", () => {
  function fixture(mode: HubConfig["runners"]["mode"]): string {
    const root = mkdtempSync(join(tmpdir(), "pm-hub-runners-"));
    writeFileSync(
      join(root, "hub.json"),
      JSON.stringify({
        hubRepo: "o/h",
        runners: { mode, label: "pm" },
        gce: hub(mode).gce,
      }),
    );
    const dir = join(root, "projects", "game");
    mkdirSync(dir, { recursive: true });
    const p = project("box");
    writeFileSync(join(dir, "project.json"), JSON.stringify(p));
    writeFileSync(
      join(dir, "areas.json"),
      JSON.stringify({
        areas: {
          core: {
            name: "Core",
            paths: ["app/"],
            sharedTouchpoints: [],
            linearProjectId: "lp",
            label: "pm:core",
            wipLimit: 2,
            metric: "/play",
            schedule: "0 13 * * 1-5",
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
    return root;
  }

  it("prints key=value lines for $GITHUB_OUTPUT", () => {
    const text = main(
      ["resolve", "--run-label", "pm-9", "--project", "game"],
      fixture("self-hosted"),
    );
    const lines = Object.fromEntries(
      text.split("\n").map((l) => l.split(/=(.*)/s).slice(0, 2)),
    );
    expect(lines.runsOn).toBe('["self-hosted","box"]');
    expect(lines.launch).toBe("false");
    expect(lines.vmName).toBe("pm-9");
  });

  it("works without a project (pm-dispatch has none)", () => {
    const text = main(["resolve", "--run-label", "pm-9"], fixture("gce"));
    expect(text).toContain('runsOn=["pm-9"]');
    expect(text).toContain("launch=true");
  });

  it("refuses a missing --run-label or an unknown command", () => {
    expect(() => main(["resolve"], fixture("gce"))).toThrow(/--run-label/);
    expect(() => main(["nope"], fixture("gce"))).toThrow(/usage/);
  });
});
