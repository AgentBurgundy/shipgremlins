import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadProject } from "../config.ts";
import { parsePmCharter } from "../pmCharter.ts";
import { initializeSetup } from "./files.ts";
import { readPmBrief, savePmBrief } from "./pmBrief.ts";
import { buildLinearProjectContent } from "./linearProjectContent.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "gremlins-brief-")));
  roots.push(root);
  initializeSetup(root, process.cwd(), { project: "demo", repo: "org/app" });
  const file = join(root, "projects/demo/areas.json");
  const areas = JSON.parse(readFileSync(file, "utf8"));
  Object.assign(areas.areas.core, {
    enabled: true,
    operatorNote: "preserve",
    mandate: "Review the import experience.",
    linearProjectId: "saved-project",
  });
  areas.areas.other = { ...areas.areas.core, name: "Other", label: "pm:other" };
  writeFileSync(file, JSON.stringify(areas));
  return { root, file, areas };
}
describe("owner PM brief", () => {
  it("sets, preserves and clears a testing requirement without altering neighboring PMs", () => {
    const f = fixture();
    const original = readPmBrief(f.root, "demo", "core");
    expect(original.brief.verificationRequirement).toBeNull();
    const required = savePmBrief(f.root, "demo", "core", {
      revision: original.revision,
      brief: { verificationRequirement: "browser" },
    });
    expect(required.brief.verificationRequirement).toBe("browser");
    const edited = savePmBrief(f.root, "demo", "core", {
      revision: required.revision,
      brief: { metric: "/import" },
    });
    expect(edited.brief.verificationRequirement).toBe("browser");
    const inherited = savePmBrief(f.root, "demo", "core", {
      revision: edited.revision,
      brief: { verificationRequirement: null },
    });
    expect(inherited.brief.verificationRequirement).toBeNull();
    const raw = JSON.parse(readFileSync(f.file, "utf8"));
    expect(raw.areas.core).not.toHaveProperty("verificationRequirement");
    expect(raw.areas.other).toEqual(f.areas.areas.other);
  });
  it("sets, preserves, and clears a PM batch override independently of its scope and neighbors", () => {
    const f = fixture();
    const original = readPmBrief(f.root, "demo", "core");
    const withOverride = savePmBrief(f.root, "demo", "core", {
      revision: original.revision,
      brief: { promotionBatchSize: 25 },
    });
    expect(withOverride.brief.promotionBatchSize).toBe(25);
    const unchanged = savePmBrief(f.root, "demo", "core", {
      revision: withOverride.revision,
      brief: { metric: "/import" },
    });
    expect(unchanged.brief.promotionBatchSize).toBe(25);
    const inherited = savePmBrief(f.root, "demo", "core", {
      revision: unchanged.revision,
      brief: { promotionBatchSize: null },
    });
    expect(inherited.brief.promotionBatchSize).toBeNull();
    const raw = JSON.parse(readFileSync(f.file, "utf8"));
    expect(raw.areas.core).not.toHaveProperty("promotionBatchSize");
    expect(raw.areas.other).toEqual(f.areas.areas.other);
    expect(raw.areas.core.mandate).toBe(original.brief.mandate);
  });
  it("saves the intended PM with concurrency protection and preserves mappings, automation, and other PMs", () => {
    const f = fixture();
    const original = readPmBrief(f.root, "demo", "core");
    const charter = {
      ambition: "Imports should finish without support.",
      users: ["An operator on a phone"],
      expectedToBuild: ["Resumable imports"],
      metricDefinition:
        "Successful imports / started imports; measure when events exist.",
      nonGoals: ["Changing account billing"],
      guardrails: ["Use synthetic CSVs"],
      standingPriorities: ["Prevent silent data loss"],
    };
    const saved = savePmBrief(f.root, "demo", "core", {
      revision: original.revision,
      brief: { charter, name: "Import Gremlin", paths: ["src/imports/"] },
    });
    expect(saved.brief.charter).toEqual(charter);
    expect(saved.brief.mandate).toBe(original.brief.mandate);
    expect(saved.revision).not.toBe(original.revision);
    const raw = JSON.parse(readFileSync(f.file, "utf8"));
    expect(raw.areas.other).toEqual(f.areas.areas.other);
    expect(raw.areas.core).toMatchObject({
      enabled: true,
      label: "pm:core",
      linearProjectId: "saved-project",
      operatorNote: "preserve",
    });
    expect(() =>
      savePmBrief(f.root, "demo", "core", {
        revision: original.revision,
        brief: { name: "Stale" },
      }),
    ).toThrow("changed");
    expect(readPmBrief(f.root, "demo", "core").brief.name).toBe(
      "Import Gremlin",
    );
    const project = loadProject(f.root, "demo");
    expect(
      buildLinearProjectContent(
        project,
        project.areas[0]!,
        original.brief.mandate,
      ).content,
    ).toContain("Resumable imports");
  });
  it.each([
    { verificationRequirement: "automatic" },
    { verificationRequirement: true },
    { verificationRequirement: "" },
    { enabled: false },
    { linearProjectId: "other" },
    { label: "pm:other" },
    { charter: { selfApprove: true } },
    { charter: { users: "all" } },
    { charter: { goal: "x".repeat(4001) } },
    { charter: { goal: "bad\u001btext" } },
    { paths: ["../../secret"] },
    { sharedTouchpoints: ["C:\\private"] },
    { schedule: "not cron" },
    { wipLimit: 0 },
    { promotionBatchSize: 0 },
    { promotionBatchSize: 101 },
    { promotionBatchSize: 1.5 },
    { promotionBatchSize: "10" },
    { mandate: "" },
  ])(
    "rejects invalid or authority-changing fields without writing: %j",
    (brief) => {
      const f = fixture();
      const before = readFileSync(f.file, "utf8");
      const revision = readPmBrief(f.root, "demo", "core").revision;
      expect(() =>
        savePmBrief(f.root, "demo", "core", { revision, brief }),
      ).toThrow();
      expect(readFileSync(f.file, "utf8")).toBe(before);
    },
  );
  it("supports legacy mandates without rewriting their files and clears only explicitly emptied charter fields", () => {
    const f = fixture();
    delete f.areas.areas.core.mandate;
    f.areas.areas.core.charter = {
      ambition: "Old",
      guardrails: ["Test accounts"],
    };
    writeFileSync(f.file, JSON.stringify(f.areas));
    const location = join(f.root, "projects/demo/core/mandate.md");
    writeFileSync(location, "Owner's versioned charter");
    const read = readPmBrief(f.root, "demo", "core");
    expect(read.brief.mandate).toBe("Owner's versioned charter");
    savePmBrief(f.root, "demo", "core", {
      revision: read.revision,
      brief: { charter: {} },
    });
    expect(readPmBrief(f.root, "demo", "core").brief.charter).toEqual({});
    expect(readFileSync(location, "utf8")).toBe("Owner's versioned charter");
  });
  it("validates charter content from raw configuration and refuses unrelated paths", () => {
    const f = fixture();
    f.areas.areas.core.charter = { unexpected: "wrong" };
    writeFileSync(f.file, JSON.stringify(f.areas));
    expect(() => loadProject(f.root, "demo")).toThrow("PM charter");
    expect(() => readPmBrief(f.root, "../private", "core")).toThrow();
    expect(() => readPmBrief(f.root, "demo", "../private")).toThrow();
  });
  it("bounds the combined charter and normalizes empty, repeated list entries", () => {
    expect(
      parsePmCharter({ goal: "  ", users: ["Phone", "Phone", ""] }),
    ).toEqual({ users: ["Phone"] });
    expect(() => parsePmCharter({ users: Array(21).fill("One") })).toThrow();
    expect(() =>
      parsePmCharter({
        users: Array(20).fill("x".repeat(1000)),
        guardrails: Array(20).fill("y".repeat(1000)),
      }),
    ).toThrow();
  });
});
