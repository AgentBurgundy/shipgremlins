import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type { Project } from "../config.ts";
import { projectRuntimeKey } from "../projectIdentity.ts";
import { assertNoSymlinks } from "../setup/files.ts";
import type { DraftAdoptionResult } from "./adoption.ts";

export interface DraftMigrationStatus extends DraftAdoptionResult {
  checkedAt: string;
}
const filename = /^job-[a-z0-9-]{1,58}\.json$/;
const directory = (root: string, project: Project) =>
  join(
    root,
    ".run",
    "delivery",
    projectRuntimeKey(project.config),
    "migration-status",
  );
function files(root: string, project: Project) {
  const dir = directory(root, project);
  assertNoSymlinks(dir);
  return !existsSync(dir)
    ? []
    : readdirSync(dir)
        .filter((name) => filename.test(name))
        .flatMap((name) => {
          const path = join(dir, name);
          // lstat below rejects links without following them; the directory
          // ancestry has already been checked once for this bounded scan.
          try {
            return [{ path, name, stat: lstatSync(path) }];
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
            throw error;
          }
        })
        .filter((file) => file.stat.isFile() && file.stat.nlink === 1)
        .sort(
          (a, b) =>
            b.stat.mtimeMs - a.stat.mtimeMs || a.name.localeCompare(b.name),
        );
}
export function readDraftMigrations(
  root: string,
  project: Project,
): DraftMigrationStatus[] {
  const results: DraftMigrationStatus[] = [];
  for (const file of files(root, project).slice(0, 200)) {
    if (file.stat.size > 4096) continue;
    try {
      const value = JSON.parse(readFileSync(file.path, "utf8"));
      if (
        value.schema !== 1 ||
        value.repository !== project.config.repo ||
        value.provider !== (project.config.provider ?? "github") ||
        value.serverUrl !== (project.config.serverUrl ?? null)
      )
        continue;
      const status = value.status;
      if (
        !status ||
        `${status.jobId}.json` !== file.name ||
        !["adopted", "blocked", "waiting", "busy"].includes(status.phase) ||
        typeof status.message !== "string" ||
        status.message.length > 1000 ||
        /[\r\n\0]/.test(status.message) ||
        !Number.isFinite(Date.parse(status.checkedAt))
      )
        continue;
      results.push({
        jobId: status.jobId,
        phase: status.phase,
        message: status.message,
        checkedAt: status.checkedAt,
      });
    } catch {
      /* A corrupt status never replaces or admits delivery evidence. */
    }
  }
  return results;
}
/** Input is a controller-authored result, never provider/model output. This is a bounded latest-status cache. */
export function saveDraftMigrationStatus(
  root: string,
  project: Project,
  status: DraftMigrationStatus,
) {
  if (!filename.test(`${status.jobId}.json`)) return;
  const dir = directory(root, project),
    target = join(dir, `${status.jobId}.json`);
  assertNoSymlinks(target);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const temporary = join(dir, `.${randomBytes(12).toString("hex")}.tmp`);
  writeFileSync(
    temporary,
    JSON.stringify({
      schema: 1,
      repository: project.config.repo,
      provider: project.config.provider ?? "github",
      serverUrl: project.config.serverUrl ?? null,
      status,
    }),
    { flag: "wx", mode: 0o600 },
  );
  assertNoSymlinks(target);
  renameSync(temporary, target);
  for (const old of files(root, project).slice(200)) {
    try {
      unlinkSync(old.path);
    } catch {
      /* A simultaneous status update will be retained until the next trim. */
    }
  }
}
