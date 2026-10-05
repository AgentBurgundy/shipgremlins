import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { isDeepStrictEqual, stripVTControlCharacters } from "node:util";
import { validateGrumblinProfileSnapshot } from "../../runner-local/grumblin-profile.mjs";
import { loadProject, type AreaConfig, type Project } from "../config.ts";
import { assertNoSymlinks, validateName } from "../setup/files.ts";
import { readConnections } from "../setup/connections.ts";
import { redactHistory } from "../storage/activity.ts";
import type { LocalJob } from "../localRunners/types.ts";
import type { DockerRunners } from "../localRunners/docker.ts";
import { PM_KNOWLEDGE_FILES, PM_KNOWLEDGE_MAX_BYTES } from "./prompts.ts";
import { baseBranch, inspectionBranch } from "../projectCapabilities.ts";
import { jobBelongsToProject } from "../projectIdentity.ts";

type Document = { name: string; content: string };
interface Snapshot {
  schema: 1;
  project: string;
  area: string;
  revision: string;
  documents: Document[];
  provenance: {
    jobId: string;
    runId: number;
    commitSha: string;
    repository: string;
    branch: string;
    completedAt: string;
    grumblin?: LocalJob["grumblin"];
  };
}
const canonical = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.entries(value)
            .filter(([, item]) => item !== undefined)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([key, item]) => [key, canonical(item)]),
        )
      : value;
function mandate(project: Project, area: AreaConfig): string {
  const file = join(project.dir, area.key, "mandate.md");
  assertNoSymlinks(file);
  if (!existsSync(file)) return "";
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > 64 * 1024)
    throw new Error("The PM mandate file cannot be read safely.");
  return readFileSync(file, "utf8");
}
/** Bind observations to owner configuration, not a mutable display name alone. */
export function knowledgeRevision(project: Project, area: AreaConfig): string {
  return createHash("sha256")
    .update(
      JSON.stringify(
        canonical({
          config: { ...project.config, verified: undefined },
          area: { ...area, enabled: undefined },
          mandate: mandate(project, area),
        }),
      ),
    )
    .digest("hex");
}
export function createPmKnowledge(options: {
  root: string;
  secrets?: () => string[];
}) {
  const selected = (name: string, key: string) => {
    validateName(name, "project");
    validateName(key, "area");
    const project = loadProject(options.root, name),
      area = project.areas.find((item) => item.key === key);
    if (!area) throw new Error("Choose an existing PM.");
    return { project, area };
  };
  const fileFor = (project: string, area: string, instanceId?: string) => {
    validateName(project, "project");
    validateName(area, "area");
    if (
      instanceId !== undefined &&
      !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(instanceId)
    )
      throw new Error("Choose a valid PM instance.");
    const file = join(
      options.root,
      ".run",
      "pm-knowledge",
      project,
      area,
      ...(instanceId ? [instanceId] : []),
      "latest.json",
    );
    assertNoSymlinks(file);
    return file;
  };
  function readSnapshot(
    project: string,
    area: string,
    instanceId?: string,
  ): Snapshot | null {
    const file = fileFor(project, area, instanceId);
    if (!existsSync(file)) return null;
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 1024 * 1024)
      throw new Error(
        "Saved PM knowledge needs repair; existing files were preserved.",
      );
    const value = JSON.parse(readFileSync(file, "utf8")) as Snapshot;
    if (
      value.schema !== 1 ||
      value.project !== project ||
      value.area !== area ||
      !/^[a-f0-9]{64}$/.test(value.revision) ||
      !Number.isSafeInteger(value.provenance?.runId) ||
      !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(
        value.provenance?.commitSha ?? "",
      ) ||
      !Array.isArray(value.documents) ||
      value.documents.length !== PM_KNOWLEDGE_FILES.length ||
      value.documents.some(
        (item, index) =>
          item.name !== PM_KNOWLEDGE_FILES[index] ||
          typeof item.content !== "string" ||
          Buffer.byteLength(item.content) > PM_KNOWLEDGE_MAX_BYTES,
      )
    )
      throw new Error(
        "Saved PM knowledge needs repair; existing files were preserved.",
      );
    return value;
  }
  function read(project: string, area: string, jobs: LocalJob[] = []) {
    const current = selected(project, area),
      saved = readSnapshot(project, area, current.area.instanceId);
    const latest = jobs
      .filter(
        (job) =>
          job.type === "pm" &&
          job.pmMode === "discovery" &&
          jobBelongsToProject(current.project.config, job) &&
          job.area === area &&
          (!current.area.instanceId ||
            job.discoveryRevision ===
              knowledgeRevision(current.project, current.area)),
      )
      .sort((a, b) => b.runId - a.runId)[0];
    return {
      project,
      area,
      state:
        latest && ["queued", "running"].includes(latest.status)
          ? "refreshing"
          : latest &&
              ["failed", "canceled"].includes(latest.status) &&
              (!saved || latest.runId > saved.provenance.runId)
            ? "failed"
            : saved
              ? "ready"
              : "empty",
      stale: Boolean(
        saved &&
        saved.revision !== knowledgeRevision(current.project, current.area),
      ),
      documents: saved?.documents ?? [],
      ...(saved
        ? {
            provenance: saved.provenance,
            summary: saved.documents[0]!.content.slice(0, 600),
          }
        : {}),
      ...(latest
        ? {
            latestRun: {
              id: latest.id,
              runId: latest.runId,
              status: latest.status,
              message: latest.message,
            },
          }
        : {}),
    };
  }
  function memory(project: Project, area: AreaConfig): Record<string, string> {
    const saved = readSnapshot(
      basename(project.dir),
      area.key,
      area.instanceId,
    );
    if (!saved || saved.revision !== knowledgeRevision(project, area))
      return {};
    return Object.fromEntries(
      saved.documents.map((document) => [
        `discovered-${document.name}`,
        document.content,
      ]),
    );
  }
  async function capture(job: LocalJob, docker: DockerRunners): Promise<void> {
    if (
      job.type !== "pm" ||
      !job.project ||
      !job.area ||
      !job.discoveryRevision
    ) {
      if (job.pmMode === "discovery" || job.pmMode === "grumblin")
        throw new Error(
          "Only an admitted discovery job can update PM knowledge.",
        );
      return;
    }
    const current = selected(job.project, job.area);
    if (job.pmMode === "grumblin") {
      const profile = validateGrumblinProfileSnapshot(job.grumblin);
      if (
        profile.project !== job.project ||
        profile.projectInstanceId !== current.project.config.instanceId
      )
        throw new Error(
          "Grumblin knowledge belongs to another project. Previous knowledge was preserved.",
        );
    }
    const artifacts = await docker.artifacts(job.id),
      result = artifacts.result;
    if (
      job.pmMode !== "discovery" &&
      job.pmMode !== "grumblin" &&
      !artifacts.files.some((file) =>
        PM_KNOWLEDGE_FILES.includes(
          file.name as (typeof PM_KNOWLEDGE_FILES)[number],
        ),
      )
    )
      return;
    if (
      knowledgeRevision(current.project, current.area) !== job.discoveryRevision
    )
      throw new Error(
        "PM settings changed during discovery. Previous knowledge was preserved; review the brief and run discovery again.",
      );
    if (
      result?.ok !== true ||
      result.kind !== "pm" ||
      (job.pmMode !== undefined && result.pmMode !== job.pmMode) ||
      (job.pmMode === "grumblin" &&
        !isDeepStrictEqual(result.grumblin, job.grumblin)) ||
      result.nonce !== job.id ||
      typeof result.commitSha !== "string" ||
      !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(result.commitSha) ||
      typeof result.branch !== "string" ||
      result.branch !==
        (job.pmMode === "discovery"
          ? baseBranch(current.project.config)
          : inspectionBranch(current.project.config))
    )
      throw new Error(
        "Discovery did not produce matching repository provenance. Previous knowledge was preserved.",
      );
    let secrets: string[];
    try {
      secrets =
        options.secrets?.() ?? Object.values(readConnections(options.root));
    } catch {
      throw new Error(
        "Saved credentials could not be checked before storing PM knowledge.",
      );
    }
    const documents: Document[] = [];
    for (const name of PM_KNOWLEDGE_FILES) {
      const metadata = artifacts.files.find((file) => file.name === name);
      if (
        !metadata ||
        metadata.size < 1 ||
        metadata.size > PM_KNOWLEDGE_MAX_BYTES
      )
        throw new Error(
          "Discovery must produce all four bounded knowledge documents. Previous knowledge was preserved.",
        );
      const bytes = await docker.readArtifact(job.id, name);
      if (bytes.length < 1 || bytes.length > PM_KNOWLEDGE_MAX_BYTES)
        throw new Error("Discovery output is too large or empty.");
      const content = redactHistory(
        stripVTControlCharacters(
          new TextDecoder("utf8", { fatal: true }).decode(bytes),
        ),
        secrets,
        // eslint-disable-next-line no-control-regex -- Public Markdown keeps tabs/newlines only.
      ).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
      if (
        !content.trim() ||
        /"type"\s*:\s*"(?:thinking|redacted_thinking)"|"reasoning_content"\s*:/.test(
          content,
        )
      )
        throw new Error(
          "Discovery must contain public observations, not model transcript data.",
        );
      documents.push({ name, content });
    }
    const file = fileFor(job.project, job.area, current.area.instanceId),
      directory = dirname(file);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    assertNoSymlinks(file);
    const lock = join(directory, "write.lock");
    assertNoSymlinks(lock);
    let handle: number;
    try {
      handle = openSync(lock, "wx", 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const stat = lstatSync(lock);
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > 128)
        throw new Error(
          "PM knowledge is locked; existing files were preserved.",
        );
      let stale = false;
      try {
        const { pid } = JSON.parse(readFileSync(lock, "utf8")) as {
          pid?: number;
        };
        if (Number.isSafeInteger(pid) && Number(pid) > 0) {
          try {
            process.kill(pid!, 0);
          } catch (cause) {
            stale = (cause as NodeJS.ErrnoException).code === "ESRCH";
          }
        }
      } catch {
        stale = Date.now() - stat.mtimeMs > 30_000;
      }
      if (!stale)
        throw new Error(
          "PM knowledge is being saved; retry after the current controller operation.",
        );
      unlinkSync(lock);
      handle = openSync(lock, "wx", 0o600);
    }
    writeFileSync(handle, JSON.stringify({ pid: process.pid }));
    let temporary: string | undefined;
    try {
      const fresh = selected(job.project, job.area);
      if (
        knowledgeRevision(fresh.project, fresh.area) !== job.discoveryRevision
      )
        throw new Error(
          "PM settings changed during discovery. Previous knowledge was preserved.",
        );
      const previous = readSnapshot(
        job.project,
        job.area,
        fresh.area.instanceId,
      );
      if (previous && previous.provenance.runId >= job.runId) return;
      const snapshot: Snapshot = {
        schema: 1,
        project: job.project,
        area: job.area,
        revision: job.discoveryRevision,
        documents,
        provenance: {
          jobId: job.id,
          runId: job.runId,
          commitSha: result.commitSha,
          repository: fresh.project.config.repo,
          branch: result.branch,
          completedAt: job.finishedAt ?? new Date().toISOString(),
          ...(job.grumblin
            ? { grumblin: validateGrumblinProfileSnapshot(job.grumblin) }
            : {}),
        },
      };
      temporary = join(
        directory,
        `.knowledge-${randomBytes(12).toString("hex")}.tmp`,
      );
      const descriptor = openSync(temporary, "wx", 0o600);
      try {
        writeFileSync(descriptor, JSON.stringify(snapshot) + "\n");
        fsyncSync(descriptor);
      } finally {
        closeSync(descriptor);
      }
      assertNoSymlinks(file);
      renameSync(temporary, file);
      temporary = undefined;
    } finally {
      closeSync(handle);
      unlinkSync(lock);
      if (temporary) unlinkSync(temporary);
    }
  }
  return { read, memory, capture };
}
