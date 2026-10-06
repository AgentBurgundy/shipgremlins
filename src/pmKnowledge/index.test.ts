import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { initializeSetup } from "../setup/files.ts";
import { loadProject } from "../config.ts";
import type { LocalJob } from "../localRunners/types.ts";
import type { DockerRunners } from "../localRunners/docker.ts";
import { createPmKnowledge, knowledgeRevision } from "./index.ts";
import { PM_KNOWLEDGE_FILES } from "./prompts.ts";
import { grumblinFixture } from "../grumblins/runtime-test-support.ts";
let root: string;
beforeEach(() => {
  root = mkdtempSync(join(realpathSync(tmpdir()), "gremlins-knowledge-"));
  initializeSetup(root, fileURLToPath(new URL("../..", import.meta.url)), {
    project: "app",
    repo: "owner/app",
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});
function fixture(runId = 1) {
  const project = loadProject(root, "app"),
    area = project.areas[0]!;
  const job: LocalJob = {
    id: `job-${runId}`,
    runId,
    type: "pm",
    pmMode: "discovery",
    project: "app",
    area: area.key,
    runOnce: true,
    discoveryRevision: knowledgeRevision(project, area),
    status: "succeeded",
    createdAt: "2026-10-05T00:00:00Z",
    finishedAt: "2026-10-05T00:01:00Z",
  };
  const documents = Object.fromEntries(
    PM_KNOWLEDGE_FILES.map((name) => [
      name,
      `# ${name}\nObserved source. secret-unique-credential`,
    ]),
  );
  const result = {
    ok: true,
    kind: "pm",
    pmMode: "discovery",
    nonce: job.id,
    commitSha: "b".repeat(40),
    branch: "main",
  };
  const artifacts = vi.fn(async () => ({
    result,
    files: Object.entries(documents).map(([name, content]) => ({
      name,
      size: Buffer.byteLength(content),
    })),
  }));
  const docker = {
    artifacts,
    readArtifact: vi.fn(async (_id: string, name: string) =>
      Buffer.from(documents[name]!),
    ),
  } as unknown as DockerRunners;
  const store = createPmKnowledge({
    root,
    secrets: () => ["secret-unique-credential"],
  });
  return { job, project, area, documents, result, artifacts, docker, store };
}
describe("PM knowledge retention", () => {
  it("reports investigation progress only from complete knowledge for the current owner revision and identities", async () => {
    const f = fixture();
    expect(f.store.onboardingProgress(f.project)).toEqual({
      investigated: false,
    });
    await f.store.capture(f.job, f.docker);
    expect(
      createPmKnowledge({ root }).onboardingProgress(loadProject(root, "app")),
    ).toEqual({ investigated: true, area: "core" });
    const areaFile = join(f.project.dir, "areas.json"),
      original = readFileSync(areaFile, "utf8"),
      area = JSON.parse(original);
    area.areas.core.mandate = "A changed owner goal";
    writeFileSync(areaFile, JSON.stringify(area));
    expect(f.store.onboardingProgress(loadProject(root, "app"))).toEqual({
      investigated: false,
    });
    writeFileSync(areaFile, original);
    area.areas.core.instanceId = "11111111-1111-4111-8111-111111111111";
    writeFileSync(areaFile, JSON.stringify(area));
    expect(f.store.onboardingProgress(loadProject(root, "app"))).toEqual({
      investigated: false,
    });
    writeFileSync(areaFile, original);
    const projectFile = join(f.project.dir, "project.json"),
      project = JSON.parse(readFileSync(projectFile, "utf8"));
    project.instanceId = "22222222-2222-4222-8222-222222222222";
    writeFileSync(projectFile, JSON.stringify(project));
    expect(f.store.onboardingProgress(loadProject(root, "app"))).toEqual({
      investigated: false,
    });
  });
  it("keeps corrupt knowledge for diagnosis without claiming first-investigation completion", async () => {
    const f = fixture();
    await f.store.capture(f.job, f.docker);
    const file = join(
      root,
      ".run",
      "pm-knowledge",
      "app",
      "core",
      "latest.json",
    );
    writeFileSync(file, "{ damaged snapshot");
    expect(f.store.onboardingProgress(loadProject(root, "app"))).toEqual({
      investigated: false,
    });
    expect(readFileSync(file, "utf8")).toBe("{ damaged snapshot");
  });
  it("requires exact Grumblin worker provenance and all knowledge documents before retaining simulated findings", async () => {
    const f = fixture();
    const grumblin = grumblinFixture({
      projectInstanceId: f.project.config.instanceId,
    });
    const job = { ...f.job, pmMode: "grumblin" as const, grumblin };
    await expect(f.store.capture(job, f.docker)).rejects.toThrow("provenance");
    Object.assign(f.result, {
      pmMode: "grumblin",
      grumblin: { ...grumblin, name: "Forged replacement" },
    });
    await expect(f.store.capture(job, f.docker)).rejects.toThrow("provenance");
    Object.assign(f.result, { grumblin });
    f.artifacts.mockResolvedValueOnce({ result: f.result, files: [] });
    await expect(f.store.capture(job, f.docker)).rejects.toThrow(
      "four bounded",
    );
    await f.store.capture(job, f.docker);
    const status = f.store.read("app", f.area.key);
    expect(status.provenance?.grumblin).toEqual(grumblin);
  });
  it("gives a recreated PM fresh knowledge without erasing the deleted PM's memory", async () => {
    const old = fixture();
    await old.store.capture(old.job, old.docker);
    const oldFile = join(
      root,
      ".run",
      "pm-knowledge",
      "app",
      "core",
      "latest.json",
    );
    const saved = readFileSync(oldFile, "utf8");
    const areaFile = join(old.project.dir, "areas.json");
    const raw = JSON.parse(readFileSync(areaFile, "utf8"));
    const instanceId = "d6c5fa4b-a631-4c17-9d5e-8b9b8c790eea";
    raw.areas.core.instanceId = instanceId;
    writeFileSync(areaFile, JSON.stringify(raw));
    const fresh = fixture(2);
    expect(fresh.store.memory(fresh.project, fresh.area)).toEqual({});
    expect(
      fresh.store.read("app", "core", [{ ...old.job, status: "failed" }]),
    ).toMatchObject({ state: "empty", documents: [] });
    expect(
      fresh.store.read("app", "core", [old.job]).latestRun,
    ).toBeUndefined();
    await expect(fresh.store.capture(old.job, old.docker)).rejects.toThrow(
      "settings changed",
    );
    fresh.documents["memory.md"] = "# Fresh PM memory";
    await fresh.store.capture(fresh.job, fresh.docker);
    expect(fresh.store.read("app", "core").provenance?.runId).toBe(2);
    expect(
      fresh.store.memory(fresh.project, fresh.area)["discovered-memory.md"],
    ).toContain("Fresh PM memory");
    expect(readFileSync(oldFile, "utf8")).toBe(saved);
    expect(
      JSON.parse(
        readFileSync(
          join(
            root,
            ".run",
            "pm-knowledge",
            "app",
            "core",
            instanceId,
            "latest.json",
          ),
          "utf8",
        ),
      ).provenance.runId,
    ).toBe(2);
  });
  it("adopts a complete snapshot, redacts credentials, survives restart, and preserves owner files", async () => {
    const f = fixture(),
      owner = readFileSync(join(f.project.dir, "core", "mandate.md"), "utf8");
    await f.store.capture(f.job, f.docker);
    const result = createPmKnowledge({ root }).read("app", "core");
    expect(result).toMatchObject({
      state: "ready",
      stale: false,
      provenance: {
        jobId: "job-1",
        runId: 1,
        repository: "owner/app",
        branch: "main",
        commitSha: "b".repeat(40),
      },
    });
    expect(result.documents).toHaveLength(4);
    expect(JSON.stringify(result)).not.toContain("secret-unique-credential");
    expect(
      f.store.memory(f.project, f.area)["discovered-features.md"],
    ).toContain("Observed source");
    expect(
      readFileSync(join(f.project.dir, "core", "mandate.md"), "utf8"),
    ).toBe(owner);
  });
  it("keeps newer provenance on older completions and repeated reconciliation", async () => {
    const newer = fixture(2);
    await newer.store.capture(newer.job, newer.docker);
    const old = fixture(1);
    await old.store.capture(old.job, old.docker);
    await newer.store.capture(newer.job, newer.docker);
    expect(old.store.read("app", "core").provenance?.runId).toBe(2);
  });
  it("preserves previous knowledge when output is partial or provenance is wrong", async () => {
    const first = fixture();
    await first.store.capture(first.job, first.docker);
    const next = fixture(2);
    delete next.documents["queue.md"];
    await expect(next.store.capture(next.job, next.docker)).rejects.toThrow(
      "all four",
    );
    next.result.nonce = "other-job";
    await expect(next.store.capture(next.job, next.docker)).rejects.toThrow(
      "provenance",
    );
    next.result.nonce = next.job.id;
    next.result.branch = "production";
    await expect(next.store.capture(next.job, next.docker)).rejects.toThrow(
      "provenance",
    );
    const view = next.store.read("app", "core", [
      { ...next.job, status: "failed" },
    ]);
    expect(view).toMatchObject({ state: "failed", provenance: { runId: 1 } });
    expect(view.documents).toHaveLength(4);
  });
  it("rejects stale admitted settings and excludes stale notes from future prompts", async () => {
    const f = fixture();
    await f.store.capture(f.job, f.docker);
    const path = join(f.project.dir, "areas.json"),
      raw = JSON.parse(readFileSync(path, "utf8"));
    raw.areas.core.mandate = "New scope";
    writeFileSync(path, JSON.stringify(raw));
    await expect(
      f.store.capture({ ...f.job, id: "job-2", runId: 2 }, f.docker),
    ).rejects.toThrow("settings changed");
    const current = loadProject(root, "app");
    expect(f.store.memory(current, current.areas[0]!)).toEqual({});
    expect(f.store.read("app", "core").stale).toBe(true);
  });
  it("ignores legacy patrol output without knowledge, but accepts a complete new patrol snapshot", async () => {
    const f = fixture();
    await expect(
      f.store.capture(
        { ...f.job, pmMode: undefined, discoveryRevision: undefined },
        f.docker,
      ),
    ).resolves.toBeUndefined();
    f.artifacts.mockResolvedValueOnce({ result: f.result, files: [] });
    await f.store.capture({ ...f.job, pmMode: undefined }, f.docker);
    expect(f.store.read("app", "core").state).toBe("empty");
    await f.store.capture({ ...f.job, pmMode: undefined }, f.docker);
    expect(f.store.read("app", "core").state).toBe("ready");
  });
  it("retains product exploration only from matching worker provenance", async () => {
    const f = fixture();
    const exploration = { ...f.job, pmMode: "exploration" as const };
    await expect(f.store.capture(exploration, f.docker)).rejects.toThrow(
      "matching repository provenance",
    );
    f.result.pmMode = "exploration";
    await f.store.capture(exploration, f.docker);
    expect(f.store.read("app", "core").state).toBe("ready");
  });
  it("recovers a dead process lock while leaving live locks intact", async () => {
    const f = fixture(),
      dir = join(root, ".run", "pm-knowledge", "app", "core");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "write.lock"), JSON.stringify({ pid: 12345 }));
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("gone"), { code: "ESRCH" });
    });
    await f.store.capture(f.job, f.docker);
    writeFileSync(
      join(dir, "write.lock"),
      JSON.stringify({ pid: process.pid }),
    );
    vi.mocked(process.kill).mockReturnValue(true);
    await expect(f.store.capture(f.job, f.docker)).rejects.toThrow(
      "being saved",
    );
  });
  it("rejects traversal and symlinked storage without touching the destination", async () => {
    const f = fixture();
    expect(() => f.store.read("../app", "core")).toThrow();
    const outside = join(root, "outside");
    mkdirSync(outside);
    mkdirSync(join(root, ".run"));
    symlinkSync(
      outside,
      join(root, ".run", "pm-knowledge"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await expect(f.store.capture(f.job, f.docker)).rejects.toThrow();
  });
  it("rejects private transcript envelopes and oversized documents", async () => {
    const f = fixture();
    f.documents["memory.md"] = '{"type":"thinking","thinking":"private"}';
    await expect(f.store.capture(f.job, f.docker)).rejects.toThrow(
      "public observations",
    );
    f.documents["memory.md"] = "a".repeat(65537);
    await expect(f.store.capture(f.job, f.docker)).rejects.toThrow("bounded");
  });
});
