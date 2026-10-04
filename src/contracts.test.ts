// The prompts and the workflows quote strings that src/dispatcher/notes.ts
// defines. This test fails when they drift. A prompt or workflow that does
// not exist yet is skipped so the hub passes before every task lands.

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as notes from "./dispatcher/notes.ts";
import { loadHub } from "./config.ts";
import { CRONS_END, CRONS_START } from "./commands/crons.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const read = (rel: string): string | null =>
  existsSync(join(ROOT, rel)) ? readFileSync(join(ROOT, rel), "utf8") : null;

const PM = read("prompts/pm.md");
const DEVELOPER = read("prompts/developer.md");
const DEVELOPER_YML = read(".github/workflows/developer.yml");
const PM_AGENT_YML = read(".github/workflows/pm-agent.yml");
const PM_DISPATCH_YML = read(".github/workflows/pm-dispatch.yml");
const HUB_CI_YML = read(".github/workflows/hub-ci.yml");

const when = (text: string | null) => (text === null ? it.skip : it);

/** the keys declared under the first `inputs:` of a workflow_dispatch block */
export function declaredInputs(yaml: string): string[] {
  const lines = yaml.split("\n");
  const start = lines.findIndex((l) => /^\s*inputs:\s*$/.test(l));
  if (start < 0) return [];
  const indent = lines[start]!.match(/^\s*/)![0].length;
  const keys: string[] = [];
  let keyIndent: number | null = null;
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === "" || line.trim().startsWith("#")) continue;
    const own = line.match(/^\s*/)![0].length;
    if (own <= indent) break;
    keyIndent ??= own;
    const m = line.match(/^\s*([A-Za-z_][\w-]*):/);
    if (own === keyIndent && m) keys.push(m[1]!);
  }
  return keys;
}

describe("hub.json", () => {
  it("loads", () => {
    const hub = loadHub(ROOT);
    expect(hub.hubRepo).toMatch(/^[\w.-]+\/[\w.-]+$/);
    expect(["self-hosted", "gce"]).toContain(hub.runners.mode);
  });
});

describe("prompts quote notes.ts verbatim", () => {
  const labels = Object.values(notes.LABELS);
  const both = `${PM ?? ""}\n${DEVELOPER ?? ""}`;

  when(DEVELOPER)(
    "developer.md names the claim and the PR-opened comment",
    () => {
      expect(DEVELOPER).toContain(notes.CLAIMED_PREFIX);
      expect(DEVELOPER).toContain(notes.PR_OPENED_PREFIX);
    },
  );

  when(PM)("pm.md names the two test verdicts", () => {
    expect(PM).toContain(notes.VERIFIED_PREFIX);
    expect(PM).toContain(notes.FAILED_PREFIX);
  });

  when(PM)("pm.md names the dispatcher's merge receipt it reads back", () => {
    expect(PM).toContain(notes.MERGED_PREFIX);
  });

  when(PM && DEVELOPER)("every Linear label appears in a prompt", () => {
    for (const label of labels) expect(both, label).toContain(label);
  });

  when(PM && DEVELOPER)(
    "the prompts carry no GitLab or Railway vocabulary",
    () => {
      for (const word of [
        "GitLab",
        "Railway",
        "Mixpanel",
        "Sentry",
        "glab ",
        "merge request",
      ])
        expect(both, word).not.toContain(word);
    },
  );
});

describe("workflow inputs", () => {
  when(DEVELOPER_YML)("developer.yml declares the dispatcher's inputs", () => {
    expect(declaredInputs(DEVELOPER_YML!)).toEqual(
      expect.arrayContaining([
        "project",
        "ticket",
        "attempt",
        "kind",
        "branch",
        "pr",
        "marker",
      ]),
    );
  });

  when(PM_AGENT_YML)("pm-agent.yml declares project, area and marker", () => {
    expect(declaredInputs(PM_AGENT_YML!)).toEqual(
      expect.arrayContaining(["project", "area", "marker"]),
    );
  });

  when(PM_AGENT_YML)("pm-agent.yml carries the generated-crons markers", () => {
    expect(PM_AGENT_YML).toContain(CRONS_START);
    expect(PM_AGENT_YML).toContain(CRONS_END);
  });

  when(PM_DISPATCH_YML)("pm-dispatch.yml runs hourly and by hand", () => {
    expect(PM_DISPATCH_YML).toMatch(/cron:\s*["']17 \* \* \* \*["']/);
    expect(PM_DISPATCH_YML).toContain("workflow_dispatch");
  });

  when(HUB_CI_YML)("hub-ci.yml runs the hub's own gates", () => {
    for (const step of [
      "npm ci",
      "npm run format:check",
      "npm run typecheck",
      "npm test",
      "npx tsx src/cli.ts validate",
      "npx tsx src/cli.ts crons --check",
    ])
      expect(HUB_CI_YML, step).toContain(step);
    expect(HUB_CI_YML).toContain("ubuntu-latest");
  });
});

describe("declaredInputs", () => {
  it("reads the keys directly under inputs:", () => {
    const yaml = `on:
  workflow_dispatch:
    inputs:
      project:
        required: true
        type: string
      # a comment
      ticket:
        required: true
  schedule:
    - cron: "0 1 * * *"
jobs: {}
`;
    expect(declaredInputs(yaml)).toEqual(["project", "ticket"]);
    expect(declaredInputs("on: push")).toEqual([]);
  });
});
