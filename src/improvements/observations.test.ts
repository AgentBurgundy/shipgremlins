import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initializeSetup } from "../setup/files.ts";
import { loadProject } from "../config.ts";
import type { LocalJob } from "../localRunners/types.ts";
import { grumblinFixture } from "../grumblins/runtime-test-support.ts";
import { createObservations } from "./observations.ts";
import { parseImprovementReport } from "./report.ts";

let root: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "improvement-observations-")));
  initializeSetup(root, process.cwd(), { project: "app", repo: "owner/app" });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
function fixture() {
  const project = loadProject(root, "app"),
    area = project.areas[0]!;
  const profile = grumblinFixture({
    projectInstanceId: project.config.instanceId,
  });
  const job: LocalJob = {
    id: "journey-one",
    runId: 1,
    type: "pm",
    pmMode: "grumblin",
    grumblin: profile,
    project: "app",
    projectInstanceId: project.config.instanceId,
    area: area.key,
    discoveryRevision: "c".repeat(64),
    status: "succeeded",
    createdAt: "2026-10-05T00:00:00Z",
  };
  const report = {
    schemaVersion: 1,
    summary: "The actual save preserved entered data after a failed request.",
    opportunities: [
      {
        key: "recovery",
        title: "Offer a clearer recovery path",
        problem: "The existing error message gives no next action.",
        evidence: [
          {
            kind: "browser",
            detail: "The error appears after Save.",
            artifact: "screenshots/step-01.png",
          },
        ],
        alternatives: ["Retry in place", "Keep editing with inline status"],
        hypotheses: [
          "A clear retry may reduce abandonment; this is not measured customer demand.",
        ],
        smallestExperiment: "Add retry beside the existing save error.",
        successMeasure: "The same entered values save after retry.",
        ticketIdentifiers: ["APP-1"],
      },
    ],
    journey: {
      goal: profile.goal,
      outcome: "partial",
      reportedClicks: 3,
      steps: [
        { action: "Press Save", observation: "Error preserved entered data." },
      ],
      wins: ["Values survived."],
      friction: ["Recovery unclear."],
      screenshots: ["screenshots/step-01.png"],
      environment: "Preview at observed commit; not production.",
    },
  };
  const input = {
    project,
    area,
    job,
    commitSha: "b".repeat(40),
    branch: "main",
    documents: [{ name: "DISCOVERY.md", content: "Actual observed evidence." }],
    files: [
      "screenshots/step-01.png",
      "DISCOVERY.md",
      "improvement-report.json",
    ],
    report: JSON.stringify(report),
  };
  return { project, job, report, input, store: createObservations({ root }) };
}
describe("retained product evidence", () => {
  it("keeps independent run baselines, owner context and profile provenance across restart", () => {
    const f = fixture();
    f.store.retain(f.input);
    f.store.retain({ ...f.input, report: undefined }); // Completion replay cannot erase the original.
    f.store.retain({
      ...f.input,
      job: { ...f.job, id: "journey-two", runId: 2 },
      commitSha: "d".repeat(40),
      report: JSON.stringify({
        ...f.report,
        summary: "Second run observed the implemented recovery.",
      }),
    });
    const records = createObservations({ root }).list(f.project);
    expect(records).toHaveLength(2);
    expect(records[1]).toMatchObject({
      ownerRevision: "c".repeat(64),
      jobId: f.job.id,
      reportStatus: "available",
      grumblin: { id: f.job.grumblin!.id, simulation: true },
      report: { journey: { reportedClicks: 3 } },
    });
    expect(records[0]!.commitSha).not.toBe(records[1]!.commitSha);
    expect(() =>
      f.store.retain({ ...f.input, commitSha: "f".repeat(40) }),
    ).toThrow("identity changed");
  });
  it("keeps missing and invalid reports honest and never fabricates artifact evidence", () => {
    const f = fixture();
    f.store.retain({ ...f.input, report: undefined });
    f.store.retain({
      ...f.input,
      job: { ...f.job, id: "bad-report", runId: 2 },
      report: JSON.stringify({
        ...f.report,
        journey: { ...f.report.journey, screenshots: ["not-produced.png"] },
      }),
    });
    const records = f.store.list(f.project);
    expect(records.map((item) => item.reportStatus)).toEqual([
      "invalid",
      "not-produced",
    ]);
    expect(records.every((item) => item.report === undefined)).toBe(true);
    expect(records[0]!.documents).toEqual(f.input.documents);
    expect(() =>
      parseImprovementReport(
        {
          ...f.report,
          journey: { ...f.report.journey, screenshots: ["../private.png"] },
        },
        new Set(["../private.png"]),
      ),
    ).toThrow("unavailable artifact");
    expect(
      parseImprovementReport(
        {
          schemaVersion: 1,
          summary: "No supported opportunity found.",
          opportunities: [],
        },
        new Set(),
      ),
    ).toEqual({
      schemaVersion: 1,
      summary: "No supported opportunity found.",
      opportunities: [],
    });
  });
  it("rejects another project incarnation or malformed owner revision", () => {
    const f = fixture();
    expect(() =>
      f.store.retain({
        ...f.input,
        job: { ...f.job, projectInstanceId: "different-instance" },
      }),
    ).toThrow("do not belong");
    expect(() =>
      f.store.retain({
        ...f.input,
        job: { ...f.job, discoveryRevision: "unbounded-context" },
      }),
    ).toThrow("do not belong");
    f.store.retain(f.input);
    expect(
      f.store.list({
        ...f.project,
        config: {
          ...f.project.config,
          instanceId: "11111111-1111-4111-8111-111111111111",
        },
      }),
    ).toEqual([]);
  });
});
