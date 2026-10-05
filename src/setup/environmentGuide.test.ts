import { afterEach, describe, expect, it, vi } from "vitest";
import {
  mkdtempSync,
  realpathSync,
  rmSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { initializeSetup } from "./files.ts";
import {
  createEnvironmentGuide,
  compactVercelGuideContext,
} from "./environmentGuide.ts";
import type { VercelSetupState } from "../vercelSetup/types.ts";
import {
  PlannerExecutionError,
  type PlannerExecutor,
} from "../pmPlanner/docker.ts";

const roots: string[] = [];
const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function fixture(
  execute: PlannerExecutor = vi.fn(async () => ({
    answer: "Choose your staging branch, then use Test environment.",
  })),
  env: NodeJS.ProcessEnv = {
    CLAUDE_CODE_OAUTH_TOKEN: "test-claude-private-credential",
  },
  context: () => Promise<unknown> = async () => ({
    status: "discovered",
    branch: "pm-staging",
  }),
) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "gremlins-guide-"));
  roots.push(root);
  initializeSetup(root, packageRoot, {
    project: "app",
    repo: "owner/app",
    createInitialPm: false,
  });
  const guide = createEnvironmentGuide({
    root,
    packageRoot,
    execute,
    env,
    context,
    timeoutMs: 1000,
  });
  return { guide, execute, root };
}
describe("Setup Gremlin environment conversation", () => {
  it("keeps real account inventories within context bounds and labels omitted deployments", async () => {
    const context: VercelSetupState = {
      project: "app",
      revision: "a".repeat(64),
      configurationRevision: "b".repeat(64),
      message: "Discovered environments",
      updatedAt: new Date().toISOString(),
      stale: false,
      status: "discovered",
      inventory: {
        connectionId: "default",
        truncated: false,
        projects: Array.from({ length: 31 }, (_, i) => ({
          id: `prj_${i}`,
          name: `app-${i}`,
          matchesRepository: i === 30,
          customEnvironments: [],
        })),
        deployments: Array.from({ length: 390 }, (_, i) => ({
          id: `dpl_${i}`,
          branch: i === 389 ? "pm-staging" : `feature-${i}`,
          createdAt: 390 - i,
          state: "READY",
          environment: "preview",
          selectable: true,
          url: `https://preview-${i}.vercel.app`,
          sha: "a".repeat(40),
        })),
      },
    };
    const compact = compactVercelGuideContext(context);
    expect(compact.inventory!.deployments).toHaveLength(24);
    expect(compact.inventory!.deployments[0]!.branch).toBe("pm-staging");
    expect(compact.inventory!.projects[0]!.id).toBe("prj_30");
    expect(compact.inventory).toMatchObject({
      omittedDeployments: 366,
      omittedProjects: 11,
      conversationExcerpt: true,
    });
    expect(JSON.stringify(compact).length).toBeLessThan(20000);
    const f = fixture(undefined, undefined, async () => compact);
    await expect(
      f.guide.ask("app", "Which test environment should I use?"),
    ).resolves.toHaveProperty("answer");
  });
  it("grounds answers in discovered facts, carries a bounded conversation and never changes config", async () => {
    const f = fixture();
    const file = join(f.root, "projects/app/project.json"),
      before = readFileSync(file, "utf8");
    await expect(
      f.guide.ask("app", "How do I let my PM sign in?"),
    ).resolves.toEqual({
      answer: "Choose your staging branch, then use Test environment.",
    });
    await f.guide.ask("app", "What about deployment protection?");
    const calls = vi.mocked(f.execute).mock.calls;
    const prompt = JSON.parse(calls[1]![0].prompt);
    expect(prompt.observed.branch).toBe("pm-staging");
    expect(prompt.conversation).toHaveLength(2);
    expect(calls[0]![0].system).toContain("you cannot");
    expect(calls[0]![0].prompt).not.toContain("test-claude-private-credential");
    expect(readFileSync(file, "utf8")).toBe(before);
    await f.guide.close();
  });
  it("keeps the newest failed build instead of filling context with older ready builds", () => {
    const context: VercelSetupState = {
      project: "app",
      revision: "a".repeat(64),
      configurationRevision: "b".repeat(64),
      status: "discovered",
      message: "Discovered environments",
      updatedAt: new Date().toISOString(),
      stale: false,
      inventory: {
        connectionId: "default",
        truncated: false,
        projects: [],
        deployments: [
          ...Array.from({ length: 30 }, (_, i) => ({
            id: `dpl_${i}`,
            branch: "pm-staging",
            environment: "preview" as const,
            createdAt: i,
            state: i === 29 ? "ERROR" : "READY",
            selectable: false,
          })),
          {
            id: "dpl_other",
            branch: "staging",
            environment: "preview",
            createdAt: 1,
            state: "READY",
            selectable: true,
          },
        ],
      },
    };
    const compact = compactVercelGuideContext(context);
    expect(compact.inventory!.deployments.map(({ id }) => id)).toEqual([
      "dpl_29",
      "dpl_other",
    ]);
    expect(compact.inventory!.deployments[0]!.state).toBe("ERROR");
    expect(compact.inventory).toMatchObject({ omittedDeployments: 29 });
  });
  it("requires Claude only for free text and rejects secrets before model execution", async () => {
    const missing = fixture(undefined, {});
    await expect(missing.guide.ask("app", "Help")).rejects.toThrow(
      "Finding and creating Vercel previews works without AI",
    );
    expect(missing.execute).not.toHaveBeenCalled();
    const f = fixture();
    await expect(
      f.guide.ask("app", "Here is test-claude-private-credential"),
    ).rejects.toThrow("Keep credentials out of chat");
    expect(f.execute).not.toHaveBeenCalled();
  });
  it("does not treat non-secret environment values as credentials", async () => {
    const f = fixture(
      vi.fn(async () => ({ answer: "Use a preview instead of production." })),
      {
        CLAUDE_CODE_OAUTH_TOKEN: "test-claude-private-credential",
        NODE_ENV: "production",
      },
    );
    await expect(
      f.guide.ask("app", "Is production separate?"),
    ).resolves.toHaveProperty("answer");
  });
  it("rejects leaked output and unbounded provider context", async () => {
    const f = fixture(
      vi.fn(async () => ({ answer: "token test-claude-private-credential" })),
    );
    await expect(f.guide.ask("app", "Help")).rejects.toThrow("safe answer");
    const huge = fixture(undefined, undefined, async () => ({
      report: "x".repeat(100001),
    }));
    await expect(huge.guide.ask("app", "Help")).rejects.toThrow(
      "shared safely",
    );
    expect(huge.execute).not.toHaveBeenCalled();
  });
  it("preserves safe diagnostic categories and rejects config changes mid-answer", async () => {
    const error = fixture(async () => {
      throw new PlannerExecutionError("authentication");
    });
    await expect(error.guide.ask("app", "Help")).rejects.toThrow(
      "rejected its saved credential",
    );
    const f = fixture(async () => {
      const file = join(f.root, "projects/app/project.json");
      writeFileSync(file, readFileSync(file, "utf8") + "\n");
      return { answer: "Old answer" };
    });
    await expect(f.guide.ask("app", "Help")).rejects.toThrow(
      "settings changed",
    );
  });
  it("blocks overlapping requests and aborts on shutdown", async () => {
    const f = fixture(() => new Promise(() => {}));
    const result = f.guide.ask("app", "Help");
    const rejected = expect(result).rejects.toThrow("canceled or timed out");
    expect(f.guide.busy("app")).toBe(true);
    await expect(f.guide.ask("app", "Again")).rejects.toThrow(
      "Wait for it to finish",
    );
    await f.guide.close();
    await rejected;
    expect(f.guide.busy()).toBe(false);
  });
});
