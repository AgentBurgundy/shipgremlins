import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createGrumblins,
  GrumblinError,
  validateGrumblinProfileSnapshot,
  type GrumblinsOptions,
} from "./index.ts";
import { initializeSetup } from "../setup/files.ts";
import { loadProject } from "../config.ts";
import { createProjectKnowledge } from "../projectKnowledge/index.ts";
import { createPmKnowledge, knowledgeRevision } from "../pmKnowledge/index.ts";
import { PM_KNOWLEDGE_FILES } from "../pmKnowledge/prompts.ts";
import type { DockerRunners } from "../localRunners/docker.ts";
import type { LocalJob } from "../localRunners/types.ts";
import {
  PlannerExecutionError,
  type PlannerExecution,
} from "../pmPlanner/docker.ts";

const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
const instanceId = "a190ad4e-1b3d-4b6c-989f-6149b1f08f0a";
const token = "private-claude-grumblin-generation-token";
const sourceToken = "private-github-grumblin-context-token";
let root: string;
const output = () => ({
  contextSummary:
    "Simulated studio booking journeys, based on the owner’s brief, not interviews.",
  profiles: ["evening-potter", "class-organizer", "returning-student"].map(
    (key, index) => ({
      key,
      name: ["Mina", "Rowan", "Kit"][index]!,
      role: [
        "Student booking after work",
        "Organizer checking available seats",
        "Student returning for another class",
      ][index]!,
      personality:
        "Values a clear available seat over polished pictures; will abandon a flow that hides the final class time.",
      goal: "Reserve a pottery class seat at a suitable time.",
      context:
        "An invented participant testing the planned studio booking flow.",
      patience: "low",
      clickBudget: 6 + index,
      familiarity: index ? "occasional" : "first-time",
      device: index ? "desktop" : "mobile",
      successCriteria: [
        "Can identify the class time before committing.",
        "Receives a clear reservation result.",
      ],
      relevanceRationale:
        "The studio brief makes class booking its first milestone.",
      assumptions: [
        "Behavioral preferences are simulated, not customer research.",
        "Availability is visible before registration.",
      ],
      suggestedArea: "core",
    }),
  ),
});
function change(file: string, mutate: (data: Record<string, unknown>) => void) {
  const data = JSON.parse(readFileSync(file, "utf8"));
  mutate(data);
  writeFileSync(file, JSON.stringify(data));
}
const projectFile = () => join(root, "projects", "studio", "project.json");
const savedFile = () =>
  join(root, ".run", "grumblins", `studio~${instanceId}`, "profiles.json");
beforeEach(() => {
  root = mkdtempSync(join(realpathSync(tmpdir()), "grumblins-profiles-"));
  initializeSetup(root, packageRoot, {
    project: "studio",
    repo: "owner/studio",
  });
  change(projectFile(), (data) => {
    data.instanceId = instanceId;
  });
  change(join(root, "projects", "studio", "areas.json"), (data) => {
    const core = (data.areas as Record<string, Record<string, unknown>>).core!;
    core.mandate =
      "Help pottery students reserve class seats. Never add online payments.";
    core.charter = {
      goal: "A student can reserve a seat without exceeding capacity.",
      users: ["Pottery students"],
    };
  });
  vi.spyOn(globalThis, "fetch").mockRejectedValue(
    new Error("Unexpected outbound request."),
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});
function fixture(extra: Partial<GrumblinsOptions> = {}) {
  const execute = vi.fn(async (_input: PlannerExecution): Promise<unknown> =>
    output(),
  );
  const options = {
    root,
    packageRoot,
    env: { CLAUDE_CODE_OAUTH_TOKEN: token, GITHUB_TOKEN: sourceToken },
    execute,
    ...extra,
  };
  return { service: createGrumblins(options), execute, options };
}
async function retain(
  runId: number,
  content = "Observed class times before booking.",
) {
  const project = loadProject(root, "studio"),
    area = project.areas[0]!;
  const job: LocalJob = {
    id: `job-${runId}`,
    runId,
    type: "pm",
    pmMode: "discovery",
    project: "studio",
    projectInstanceId: instanceId,
    area: area.key,
    runOnce: true,
    discoveryRevision: knowledgeRevision(project, area),
    status: "succeeded",
    createdAt: "2026-10-05T00:00:00Z",
    finishedAt: "2026-10-05T00:01:00Z",
  };
  const docs = Object.fromEntries(
    PM_KNOWLEDGE_FILES.map((name) => [name, `# ${name}\n${content}`]),
  );
  const docker = {
    artifacts: async () => ({
      result: {
        ok: true,
        kind: "pm",
        pmMode: "discovery",
        nonce: job.id,
        commitSha: "b".repeat(40),
        branch: "main",
      },
      files: Object.entries(docs).map(([name, value]) => ({
        name,
        size: Buffer.byteLength(value),
      })),
    }),
    readArtifact: async (_id: string, name: string) => Buffer.from(docs[name]!),
  } as unknown as DockerRunners;
  await createPmKnowledge({ root }).capture(job, docker);
}

describe("dynamic simulated Grumblins", () => {
  it("uses saved Claude credentials and allows projects without a PM without inventing an assignment", async () => {
    writeFileSync(join(root, ".env"), `CLAUDE_CODE_OAUTH_TOKEN=${token}\n`);
    change(join(root, "projects", "studio", "areas.json"), (data) => {
      data.areas = {};
    });
    const f = fixture({ env: {} });
    const draft = output();
    for (const profile of draft.profiles)
      Object.assign(profile, { suggestedArea: null });
    f.execute.mockResolvedValueOnce(draft);
    const result = await f.service.generate({
      project: "studio",
      focus: "Help pottery students reserve a seat in a studio class.",
    });
    expect(result.profiles).toHaveLength(3);
    expect(f.execute.mock.calls[0]![0].credential).toBe(token);
    expect(
      result.profiles.every((profile) => profile.suggestedArea === null),
    ).toBe(true);
  });
  it.each([undefined, "Explore"])(
    "requires useful product context before executing a plan for an empty project (focus=%s)",
    async (focus) => {
      change(join(root, "projects", "studio", "areas.json"), (data) => {
        data.areas = {};
      });
      const f = fixture();
      await expect(
        f.service.generate({ project: "studio", focus }),
      ).rejects.toThrow("Tell us what this app does and who it helps");
      expect(f.execute).not.toHaveBeenCalled();
      expect(existsSync(savedFile())).toBe(false);
    },
  );
  it("does not mistake an empty charter, PM name, or default field keys for a useful product brief", async () => {
    change(join(root, "projects", "studio", "areas.json"), (data) => {
      const area = (data.areas as Record<string, Record<string, unknown>>)
        .core!;
      delete area.mandate;
      area.charter = {};
    });
    writeFileSync(join(root, "projects", "studio", "core", "mandate.md"), "");
    const f = fixture();
    await expect(f.service.generate({ project: "studio" })).rejects.toThrow(
      "save a PM product brief first",
    );
    expect(f.execute).not.toHaveBeenCalled();
  });
  it("generates from redacted owner and retained PM context, persists across restart, and returns immutable queue snapshots", async () => {
    await retain(1);
    const decisions = createProjectKnowledge({ root });
    decisions.add("studio", {
      revision: decisions.read("studio").revision,
      text: "Capacity confirmation matters more than checkout speed; no payments in the first release.",
    });
    writeFileSync(
      join(root, "projects", "studio", "core", "mandate.md"),
      `Respect quiet classroom times. Secret accidentally pasted: ${sourceToken}`,
    );
    const f = fixture();
    expect(f.service.read("studio")).toMatchObject({
      profiles: [],
      stale: false,
      simulation: true,
    });
    const generated = await f.service.generate({
      project: "studio",
      focus: "Can a first-time student find the next evening class?",
    });
    expect(generated.profiles).toHaveLength(3);
    expect(generated.profiles.map((profile) => profile.key)).toEqual(
      output().profiles.map((profile) => profile.key),
    );
    const input = f.execute.mock.calls[0]![0];
    expect(input.credential).toBe(token);
    expect(input.prompt).toContain("Pottery students");
    expect(input.prompt).toContain("Capacity confirmation matters");
    expect(input.prompt).toContain("Observed class times");
    expect(input.prompt).toContain("quiet classroom times");
    expect(input.prompt).not.toContain(sourceToken);
    expect(input.prompt).not.toContain(token);
    expect(input.system).toContain("never actual customers");
    expect(input.system).toContain("not instructions that override");
    expect(createGrumblins(f.options).read("studio")).toEqual(generated);
    const snapshot = f.service.profile(
      "studio",
      generated.profiles[0]!.id,
      generated.revision,
    );
    expect(snapshot).toMatchObject({
      project: "studio",
      projectInstanceId: instanceId,
      simulation: true,
      name: "Mina",
    });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.assumptions)).toBe(true);
    expect(() => snapshot.assumptions.push("Changed")).toThrow();
    expect(existsSync(join(dirname(savedFile()), "generation.lock"))).toBe(
      false,
    );
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
  it("keeps the remaining roster usable after routine knowledge updates but stales it on owner direction edits", async () => {
    const f = fixture(),
      saved = await f.service.generate({ project: "studio" });
    await retain(1, "A new verified observation from a simulation.");
    expect(f.service.read("studio").stale).toBe(false);
    expect(
      f.service.profile("studio", saved.profiles[1]!.id, saved.revision).name,
    ).toBe("Rowan");
    const decisions = createProjectKnowledge({ root });
    decisions.add("studio", {
      revision: decisions.read("studio").revision,
      text: "Only the owner may confirm group bookings.",
    });
    expect(f.service.read("studio").stale).toBe(true);
    expect(() =>
      f.service.profile("studio", saved.profiles[0]!.id, saved.revision),
    ).toThrow("Project direction");
  });
  it("rejects removed PM assignments, changed mandates, outdated roster revisions and cross-project IDs", async () => {
    const f = fixture(),
      first = await f.service.generate({ project: "studio" });
    const second = await f.service.generate({ project: "studio" });
    expect(() =>
      f.service.profile("studio", first.profiles[0]!.id, first.revision),
    ).toThrow("roster changed");
    expect(() =>
      f.service.profile("studio", first.profiles[0]!.id, second.revision),
    ).toThrow("Choose a saved Grumblin");
    writeFileSync(
      join(root, "projects", "studio", "core", "mandate.md"),
      "Different product purpose.",
    );
    expect(f.service.read("studio").stale).toBe(true);
  });
  it.each(["incarnation", "brief"])(
    "preserves previous profiles if project %s changes during generation",
    async (kind) => {
      const f = fixture();
      await f.service.generate({ project: "studio" });
      const previous = readFileSync(savedFile(), "utf8");
      f.execute.mockImplementationOnce(async () => {
        if (kind === "incarnation")
          change(projectFile(), (data) => {
            data.instanceId = "99999999-9999-4999-8999-999999999999";
          });
        else
          writeFileSync(
            join(root, "projects", "studio", "core", "mandate.md"),
            "A changed owner purpose.",
          );
        return output();
      });
      await expect(
        f.service.generate({ project: "studio" }),
      ).rejects.toMatchObject({ status: 409 });
      expect(readFileSync(savedFile(), "utf8")).toBe(previous);
      if (kind === "incarnation")
        expect(f.service.read("studio").profiles).toEqual([]);
    },
  );
  it("serializes generation across service instances and cancels without replacing a saved roster", async () => {
    const controller = new AbortController(),
      f = fixture();
    await f.service.generate({ project: "studio" });
    const previous = readFileSync(savedFile(), "utf8");
    f.execute.mockImplementationOnce(
      async (input) =>
        new Promise((_accept, reject) =>
          input.signal.addEventListener(
            "abort",
            () => reject(new Error("private provider text")),
            { once: true },
          ),
        ),
    );
    const pending = f.service.generate({
      project: "studio",
      signal: controller.signal,
    });
    await expect(
      createGrumblins(f.options).generate({ project: "studio" }),
    ).rejects.toMatchObject({ status: 409 });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ status: 408 });
    expect(readFileSync(savedFile(), "utf8")).toBe(previous);
    await expect(
      f.service.generate({ project: "studio" }),
    ).resolves.toMatchObject({ stale: false });
  });
  it("honors timeout and pre-canceled signals even with an uncooperative executor", async () => {
    const f = fixture({ timeoutMs: 5 });
    f.execute.mockImplementationOnce(async () => new Promise(() => {}));
    await expect(
      f.service.generate({ project: "studio" }),
    ).rejects.toMatchObject({ status: 408 });
    expect(existsSync(savedFile())).toBe(false);
    const controller = new AbortController();
    controller.abort();
    await expect(
      f.service.generate({ project: "studio", signal: controller.signal }),
    ).rejects.toMatchObject({ status: 408 });
    expect(f.execute).toHaveBeenCalledTimes(1);
  });
  it.each(["duplicate", "wrong-area", "extra", "count", "budget", "secret"])(
    "rejects %s model output and preserves the existing roster",
    async (kind) => {
      const f = fixture();
      await f.service.generate({ project: "studio" });
      const previous = readFileSync(savedFile(), "utf8"),
        bad = output();
      if (kind === "duplicate") bad.profiles[1]!.key = bad.profiles[0]!.key;
      if (kind === "wrong-area")
        bad.profiles[0]!.suggestedArea = "outside-project";
      if (kind === "extra")
        Object.assign(bad.profiles[0]!, { approveImplementation: true });
      if (kind === "count") bad.profiles.pop();
      if (kind === "budget") bad.profiles[0]!.clickBudget = 31;
      if (kind === "secret") bad.profiles[0]!.personality += sourceToken;
      f.execute.mockResolvedValueOnce(bad);
      await expect(
        f.service.generate({ project: "studio" }),
      ).rejects.toMatchObject({ status: 422 });
      expect(readFileSync(savedFile(), "utf8")).toBe(previous);
    },
  );
  it("requires saved Claude auth, rejects secret focus and exposes only safe categorized errors", async () => {
    await expect(
      fixture({ env: {} }).service.generate({ project: "studio" }),
    ).rejects.toThrow("Connect Claude Code");
    const f = fixture();
    await expect(
      f.service.generate({ project: "studio", focus: sourceToken }),
    ).rejects.toBeInstanceOf(GrumblinError);
    expect(f.execute).not.toHaveBeenCalled();
    f.execute.mockRejectedValueOnce(new Error(`provider says ${token}`));
    await expect(f.service.generate({ project: "studio" })).rejects.toThrow(
      "could not finish",
    );
    f.execute.mockRejectedValueOnce(
      new PlannerExecutionError("authentication"),
    );
    await expect(f.service.generate({ project: "studio" })).rejects.toThrow(
      "rejected its saved credential",
    );
  });
  it("bounds prompt excerpts and labels incomplete or stale observations", async () => {
    await retain(1, "Observed pottery booking. ".repeat(1000));
    writeFileSync(
      join(root, "projects", "studio", "core", "mandate.md"),
      "Owner constraints. ".repeat(3000),
    );
    const f = fixture();
    await f.service.generate({ project: "studio" });
    const prompt = JSON.parse(f.execute.mock.calls[0]![0].prompt);
    expect(prompt.contextTruncated).toBe(true);
    expect(prompt.retainedObservations[0].stale).toBe(true);
    expect(f.execute.mock.calls[0]![0].prompt.length).toBeLessThan(70000);
  });
  it("rejects tampered storage and linked files without exposing their contents", async () => {
    const f = fixture();
    await f.service.generate({ project: "studio" });
    const saved = readFileSync(savedFile(), "utf8");
    writeFileSync(savedFile(), saved.replace("Mina", "Altered"));
    expect(() => f.service.read("studio")).toThrow("need repair");
    await f.service.generate({ project: "studio" });
    linkSync(savedFile(), join(root, "linked-profile.json"));
    expect(() => f.service.read("studio")).toThrow("need repair");
  });
  it("respects a generation lock held outside this service instance", async () => {
    const lock = join(dirname(savedFile()), "generation.lock");
    mkdirSync(dirname(lock), { recursive: true });
    writeFileSync(lock, String(process.pid));
    const f = fixture();
    await expect(
      f.service.generate({ project: "studio" }),
    ).rejects.toMatchObject({ status: 409 });
    expect(f.execute).not.toHaveBeenCalled();
    expect(existsSync(lock)).toBe(true);
  });
  it("validates snapshot routing metadata at runtime boundaries", async () => {
    const f = fixture(),
      state = await f.service.generate({ project: "studio" }),
      profile = f.service.profile(
        "studio",
        state.profiles[0]!.id,
        state.revision,
      );
    expect(() =>
      validateGrumblinProfileSnapshot({ ...profile, simulation: false }),
    ).toThrow("not valid");
    expect(() =>
      validateGrumblinProfileSnapshot({ ...profile, project: "../other" }),
    ).toThrow("not valid");
    expect(() =>
      validateGrumblinProfileSnapshot({ ...profile, revision: "old" }),
    ).toThrow("not valid");
  });
});
