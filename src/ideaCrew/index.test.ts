import { afterEach, describe, expect, it, vi } from "vitest";
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createIdeaCrew } from "./index.ts";
import { validateCrewPlan } from "./plan.ts";
import { samplePlan } from "./test-support.ts";
import { loadProject } from "../config.ts";
import { createProjectKnowledge } from "../projectKnowledge/index.ts";
import { createLinearProvisioning } from "../setup/linearProvisioning.ts";
import type { PlannerExecutor } from "../pmPlanner/docker.ts";

const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
const roots: string[] = [];
const idea =
  "Build a booking app for a pottery studio. Students reserve seats; owners manage classes. No payments yet.";
const target = {
  project: "studio",
  repo: "owner/studio",
  provider: "github",
  connectionId: "default",
};
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function fixture(
  input: { empty?: boolean; gitlab?: boolean; execute?: PlannerExecutor } = {},
) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "gremlins-idea-crew-"));
  roots.push(root);
  let content: string | undefined;
  let branches = input.empty ? [] : [{ name: "main" }];
  let loseResponse = false;
  const source = {
    resolveCredential: vi.fn(async () => ({
      token: "source-token-private",
      method: "token" as const,
    })),
  };
  const execute = vi.fn(input.execute ?? (async () => samplePlan()));
  const fetcher = vi.fn(
    async (url: string | URL | Request, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      if ((init?.method ?? "GET") !== "GET") {
        const payload = JSON.parse(String(init?.body));
        content = input.gitlab
          ? Buffer.from(payload.actions[0].content).toString("base64")
          : payload.content;
        branches = [{ name: "main" }];
        if (loseResponse) {
          loseResponse = false;
          throw new Error("Connection lost after successful write.");
        }
        return Response.json({
          commit: { sha: "a".repeat(40) },
          id: "a".repeat(40),
        });
      }
      if (path.endsWith("/branches")) return Response.json(branches);
      if (path.endsWith("/README.md"))
        return content
          ? Response.json({ encoding: "base64", content })
          : new Response(null, { status: 404 });
      return Response.json({ default_branch: "main" });
    },
  ) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
  const options = {
    root,
    packageRoot,
    env: { CLAUDE_CODE_OAUTH_TOKEN: "claude-token-private" },
    sourceControl: source,
    fetch: fetcher,
    execute,
  };
  return {
    root,
    options,
    service: createIdeaCrew(options),
    source,
    execute,
    fetcher,
    loseNextWrite: () => {
      loseResponse = true;
    },
    replaceReadme: () => {
      content = Buffer.from("Owner edited README").toString("base64");
    },
  };
}
describe("idea crew planning", () => {
  it("plans without a repository or provider access and recovers the same reviewed plan", async () => {
    const f = fixture();
    const draft = await f.service.plan(idea);
    expect(f.source.resolveCredential).not.toHaveBeenCalled();
    expect(f.fetcher).not.toHaveBeenCalled();
    expect(existsSync(join(f.root, "projects"))).toBe(false);
    expect(f.service.get(draft.id)).toMatchObject({
      ...draft,
      complete: false,
    });
    expect(f.execute.mock.calls[0]?.[0].prompt).not.toContain(
      "claude-token-private",
    );
  });
  it("rejects cyclic, forward, duplicate, or missing foundation dependencies", () => {
    for (const mutate of [
      (p: ReturnType<typeof samplePlan>) => {
        p.crew[0]!.dependsOn = ["schedule"];
      },
      (p: ReturnType<typeof samplePlan>) => {
        p.crew[1]!.key = "foundation";
      },
      (p: ReturnType<typeof samplePlan>) => {
        p.crew[1]!.dependsOn = [];
      },
      (p: ReturnType<typeof samplePlan>) => {
        p.crew[0]!.key = "billing";
      },
    ]) {
      const plan = samplePlan();
      mutate(plan);
      expect(() => validateCrewPlan(plan)).toThrow();
    }
  });
  it("rejects secret-bearing inputs and outputs before persisting a draft", async () => {
    const f = fixture();
    await expect(
      f.service.plan(`${idea} claude-token-private`),
    ).rejects.toThrow("credentials");
    expect(f.execute).not.toHaveBeenCalled();
    const g = fixture({
      execute: async () => ({
        ...samplePlan(),
        summary: "claude-token-private",
      }),
    });
    await expect(g.service.plan(idea)).rejects.toThrow("credentials");
    expect(existsSync(join(g.root, ".run", "idea-crew"))).toBe(false);
  });
  it("cancellation discards even a late model response", async () => {
    const abort = new AbortController();
    const f = fixture({
      execute: async () => {
        abort.abort();
        return samplePlan();
      },
    });
    await expect(f.service.plan(idea, abort.signal)).rejects.toThrow("stopped");
    expect(existsSync(join(f.root, ".run", "idea-crew"))).toBe(false);
  });
  it("rejects a plan that cannot fit PM brief storage before any source writes", async () => {
    const f = fixture({
      execute: async () => {
        const plan = samplePlan();
        plan.firstMilestone = "界".repeat(1000);
        plan.users = Array.from(
          { length: 6 },
          (_, i) => `${i}${"界".repeat(299)}`,
        );
        plan.nonGoals = [...plan.users];
        plan.crew[0]!.mission = "界".repeat(1000);
        plan.crew[0]!.firstTask = "界".repeat(1000);
        plan.crew[0]!.acceptanceCriteria = [...plan.users];
        return plan;
      },
    });
    await expect(f.service.plan(idea)).rejects.toThrow("too large");
    expect(f.fetcher).not.toHaveBeenCalled();
    expect(existsSync(join(f.root, ".run", "idea-crew"))).toBe(false);
  });
});
describe("creating an idea crew", () => {
  it("creates the complete crew and shared direction once while preserving existing source", async () => {
    const f = fixture(),
      draft = await f.service.plan(idea);
    const result = await f.service.create(draft.id, {
      ...target,
      revision: draft.revision,
    });
    expect(result.crew).toHaveLength(2);
    const project = loadProject(f.root, "studio");
    expect(project.areas.map((area) => area.key)).toEqual([
      "foundation",
      "schedule",
    ]);
    expect(
      project.areas.every((area) => !area.enabled && area.wipLimit === 1),
    ).toBe(true);
    expect(project.areas[1]!.mandate).toContain("Dependencies: foundation");
    expect(project.config.commands.install).toContain("if [ -f package.json ]");
    expect(project.config.commands.test).toBe("npm test");
    expect(project.config.verified).toBeNull();
    expect(
      f.fetcher.mock.calls.every(([, init]) => !init || init.method === "GET"),
    ).toBe(true);
    expect(
      await f.service.create(draft.id, { ...target, revision: draft.revision }),
    ).toEqual(result);
    expect(
      createProjectKnowledge({ root: f.root }).read("studio").decisions,
    ).toHaveLength(1);
  });
  it.each([false, true])(
    "initializes a genuinely empty repository and recovers a lost acknowledgment (GitLab=%s)",
    async (gitlab) => {
      const f = fixture({ empty: true, gitlab }),
        draft = await f.service.plan(idea);
      f.loseNextWrite();
      const input = {
        ...target,
        provider: gitlab ? "gitlab" : "github",
        revision: draft.revision,
      };
      await expect(f.service.create(draft.id, input)).rejects.toThrow("resume");
      expect(existsSync(join(f.root, "projects", "studio"))).toBe(false);
      const result = await createIdeaCrew(f.options).create(draft.id, input);
      expect(result.initializedRepository).toBe(true);
      expect(
        f.fetcher.mock.calls.filter(([, init]) => init?.method !== "GET"),
      ).toHaveLength(1);
    },
  );
  it("does not overwrite a README changed after an interrupted initialization", async () => {
    const f = fixture({ empty: true }),
      draft = await f.service.plan(idea);
    f.loseNextWrite();
    await expect(
      f.service.create(draft.id, { ...target, revision: draft.revision }),
    ).rejects.toThrow();
    f.replaceReadme();
    await expect(
      f.service.create(draft.id, { ...target, revision: draft.revision }),
    ).rejects.toThrow("changed");
    expect(
      f.fetcher.mock.calls.filter(([, init]) => init?.method !== "GET"),
    ).toHaveLength(1);
  });
  it("resumes a partially created crew without duplicate PMs", async () => {
    const f = fixture(),
      draft = await f.service.plan(idea);
    const local = createLinearProvisioning({
      root: f.root,
      client: async () => {
        throw new Error("No remote writes");
      },
    });
    let fail = true;
    const interrupted = createIdeaCrew({
      ...f.options,
      addArea: async (project, area) => {
        if (area.key === "schedule" && fail) {
          fail = false;
          throw new Error("Disk unavailable");
        }
        await local.addArea(project, area);
      },
    });
    await expect(
      interrupted.create(draft.id, { ...target, revision: draft.revision }),
    ).rejects.toThrow("resume");
    expect(loadProject(f.root, "studio").areas).toHaveLength(1);
    await f.service.create(draft.id, { ...target, revision: draft.revision });
    expect(loadProject(f.root, "studio").areas).toHaveLength(2);
  });
  it("rejects changed review revisions, destinations, existing projects and tampered saved plans", async () => {
    const f = fixture(),
      draft = await f.service.plan(idea);
    await expect(
      f.service.create(draft.id, { ...target, revision: "old" }),
    ).rejects.toThrow("current");
    expect(f.source.resolveCredential).not.toHaveBeenCalled();
    await f.service.create(draft.id, { ...target, revision: draft.revision });
    await expect(
      f.service.create(draft.id, {
        ...target,
        project: "different",
        revision: draft.revision,
      }),
    ).rejects.toThrow("another destination");
    const second = await f.service.plan(idea);
    await expect(
      f.service.create(second.id, { ...target, revision: second.revision }),
    ).rejects.toThrow("already exists");
    const path = join(f.root, ".run", "idea-crew", `${draft.id}.json`);
    const saved = JSON.parse(readFileSync(path, "utf8"));
    saved.plan.summary = "Edited without a new review.";
    writeFileSync(path, JSON.stringify(saved));
    expect(() => f.service.get(draft.id)).toThrow("changed");
  });
  it("fails on provider errors without creating local PMs", async () => {
    const f = fixture(),
      draft = await f.service.plan(idea);
    f.source.resolveCredential.mockRejectedValueOnce(
      new Error("private provider response"),
    );
    await expect(
      f.service.create(draft.id, { ...target, revision: draft.revision }),
    ).rejects.toThrow("Check source access");
    expect(existsSync(join(f.root, "projects"))).toBe(false);
  });
});
