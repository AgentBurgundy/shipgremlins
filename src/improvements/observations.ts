import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import type { Project, AreaConfig } from "../config.ts";
import type { LocalJob } from "../localRunners/types.ts";
import { projectRuntimeKey } from "../projectIdentity.ts";
import { assertNoSymlinks } from "../setup/files.ts";
import { parseImprovementReport, type ImprovementReport } from "./report.ts";
import type { GrumblinProfileSnapshot } from "../grumblins/schema.ts";

export interface Observation {
  schemaVersion: 1;
  project: string;
  projectInstanceId?: string;
  area: string;
  areaInstanceId?: string;
  ownerRevision?: string;
  jobId: string;
  runId: number;
  kind: "patrol" | "discovery" | "exploration" | "grumblin";
  createdAt: string;
  commitSha: string;
  branch: string;
  reportStatus: "available" | "not-produced" | "invalid";
  report?: ImprovementReport;
  grumblin?: GrumblinProfileSnapshot;
  documents: { name: string; content: string }[];
  artifacts: string[];
}
export function writePrivateJson(file: string, value: unknown): void {
  assertNoSymlinks(file);
  const content = JSON.stringify(value);
  if (Buffer.byteLength(content) > 1024 * 1024)
    throw new Error("Retained product context exceeds its storage bound.");
  const directory = dirname(file);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = join(directory, ".improvement-" + randomUUID() + ".tmp");
  try {
    const fd = openSync(temporary, "wx", 0o600);
    try {
      writeFileSync(fd, content);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    assertNoSymlinks(file);
    renameSync(temporary, file);
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}
export function readPrivateJson(file: string): unknown {
  assertNoSymlinks(file);
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > 1024 * 1024)
    throw new Error("Retained product context cannot be read safely.");
  return JSON.parse(readFileSync(file, "utf8"));
}
export function createObservations({ root }: { root: string }) {
  const directory = (project: Project) =>
    join(
      root,
      ".run",
      "improvements",
      projectRuntimeKey(project.config),
      "observations",
    );
  function retain(input: {
    project: Project;
    area: AreaConfig;
    job: LocalJob;
    commitSha: string;
    branch: string;
    documents: Observation["documents"];
    files: string[];
    report?: string;
  }) {
    const { project, area, job } = input;
    if (
      job.project !== project.config.name ||
      job.projectInstanceId !== project.config.instanceId ||
      job.area !== area.key ||
      (job.discoveryRevision !== undefined &&
        !/^[a-f0-9]{64}$/.test(job.discoveryRevision)) ||
      !/^[a-z0-9-]{1,100}$/.test(job.id) ||
      !Number.isSafeInteger(job.runId) ||
      job.runId < 1
    )
      throw new Error(
        "Product observations do not belong to this project and PM.",
      );
    const file = join(
      directory(project),
      String(job.runId).padStart(12, "0") + "-" + job.id + ".json",
    );
    if (existsSync(file)) {
      const previous = readPrivateJson(file) as Observation;
      if (
        previous.jobId !== job.id ||
        previous.projectInstanceId !== project.config.instanceId ||
        previous.commitSha !== input.commitSha
      )
        throw new Error("Retained observation identity changed.");
      return;
    }
    const record: Observation = {
      schemaVersion: 1,
      project: project.config.name,
      projectInstanceId: project.config.instanceId,
      area: area.key,
      areaInstanceId: area.instanceId,
      ownerRevision: job.discoveryRevision,
      jobId: job.id,
      runId: job.runId,
      kind: job.pmMode ?? "patrol",
      createdAt: job.finishedAt ?? new Date().toISOString(),
      commitSha: input.commitSha,
      branch: input.branch,
      documents: input.documents,
      artifacts: input.files,
      ...(job.grumblin ? { grumblin: job.grumblin } : {}),
      reportStatus: "not-produced",
    };
    if (input.report !== undefined) {
      record.reportStatus = "invalid";
      try {
        if (Buffer.byteLength(input.report) > 64 * 1024)
          throw new Error("Report too large.");
        record.report = parseImprovementReport(
          JSON.parse(input.report),
          new Set(input.files),
        );
        if (record.report.journey && !job.grumblin)
          delete record.report.journey;
        record.reportStatus = "available";
      } catch {
        /* Keep provenance and original knowledge; do not invent a valid report. */
      }
    }
    writePrivateJson(file, record);
  }
  function list(project: Project, limit = 100): Observation[] {
    const path = directory(project);
    assertNoSymlinks(path);
    if (!existsSync(path)) return [];
    return readdirSync(path)
      .filter((name) => /^[0-9]{12,16}-[a-z0-9-]{1,100}\.json$/.test(name))
      .sort()
      .reverse()
      .slice(0, Math.max(1, Math.min(limit, 500)))
      .map((name) => {
        const value = readPrivateJson(join(path, name)) as Observation;
        if (
          value.schemaVersion !== 1 ||
          value.project !== project.config.name ||
          value.projectInstanceId !== project.config.instanceId ||
          (value.ownerRevision !== undefined &&
            !/^[a-f0-9]{64}$/.test(value.ownerRevision)) ||
          !Array.isArray(value.documents) ||
          !Array.isArray(value.artifacts) ||
          !["available", "not-produced", "invalid"].includes(value.reportStatus)
        )
          throw new Error(
            "Retained observation belongs to changed project context.",
          );
        if (value.report)
          value.report = parseImprovementReport(
            value.report,
            new Set(value.artifacts),
          );
        return value;
      });
  }
  return { retain, list };
}
