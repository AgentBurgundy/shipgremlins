import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initializeSetup } from "./files.ts";
import { createAutomaticPreparation } from "./automaticPreparation.ts";
import type { ReadinessContext } from "./pmReadiness.ts";
import type { LocalJob } from "../localRunners/types.ts";
import type { Project } from "../config.ts";
import { loadProject } from "../config.ts";
import { createAutomationDiagnostics } from "./automationDiagnostics.ts";
import {
  initializeCodingAgents,
  readCodingAgents,
  saveCodingAgents,
} from "../codingAgents/index.ts";
import {
  projectAiTarget,
  readAiRouting,
  saveAiRouting,
} from "../ai/routing.ts";
let root: string;
const ready: ReadinessContext = {
  env: {
    GITHUB_TOKEN: "source",
    CLAUDE_CODE_OAUTH_TOKEN: "ai",
    LINEAR_API_KEY: "linear",
  },
  sourceConnections: [],
  serviceConnections: [],
  localMode: true,
  workers: [
    {
      id: "worker-one",
      name: "Local",
      status: "ready",
      paused: false,
      busy: false,
      createdAt: "2026-10-14",
      verifiedAt: "2026-10-14",
    },
  ],
};
function edit(
  name: string,
  file: string,
  update: (raw: {
    areas: Record<
      string,
      {
        enabled: boolean;
        codingEnabled: boolean;
        linearProjectId: string;
        label: string;
      }
    >;
    verified?: string;
    instanceId?: string;
    workflow?: { kind: string; baseBranch: string };
    automationPaused?: boolean;
  }) => void,
) {
  const path = join(root, `projects/${name}/${file}.json`);
  const raw = JSON.parse(readFileSync(path, "utf8"));
  update(raw);
  writeFileSync(path, JSON.stringify(raw));
}
beforeEach(() => {
  root = mkdtempSync(join(realpathSync(tmpdir()), "gremlins-automatic-setup-"));
  initializeSetup(root, process.cwd(), { project: "app", repo: "owner/app" });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
function fixture() {
  let context = ready,
    now = 0;
  let jobs: LocalJob[] = [];
  const provision = vi.fn(async (name: string, area: string) => {
    edit(name, "areas", (raw) => {
      raw.areas[area]!.linearProjectId = "mapped-project";
    });
    return true;
  });
  const verify = vi.fn(async (project: Project) => {
    edit(project.config.name, "project", (raw) => {
      raw.verified = "2026-10-14";
    });
  });
  const run = createAutomaticPreparation({
    root,
    context: async () => context,
    jobs: async () => jobs,
    provision,
    verify,
    now: () => now,
  });
  return {
    run,
    provision,
    verify,
    context: (value: ReadinessContext) => {
      context = value;
    },
    jobs: (value: LocalJob[]) => {
      jobs = value;
    },
    advance: () => {
      now += 5 * 60_000;
    },
  };
}
describe("automatic project preparation", () => {
  function independentCoder(provider: "claude" | "codex") {
    edit("app", "project", (raw) => {
      raw.workflow = { kind: "pull-request", baseBranch: "main" };
    });
    edit("app", "areas", (raw) => {
      raw.areas.core!.enabled = false;
      raw.areas.core!.codingEnabled = false;
    });
    initializeCodingAgents(root, "app");
    saveCodingAgents(root, "app", {
      revision: readCodingAgents(root, "app").revision,
      agents: [
        {
          key: "builder",
          name: "Builder",
          enabled: true,
          areas: ["core"],
          maxConcurrent: 1,
          ai: { provider },
        },
      ],
    });
    const project = loadProject(root, "app"),
      scope = projectAiTarget(project, "pm", project.areas[0]);
    saveAiRouting(
      root,
      scope,
      {
        revision: readAiRouting(root, scope, {}).revision,
        pm: { provider: "codex" },
      },
      {},
    );
  }
  it("prepares an enabled coder independently while its PM and disconnected PM provider remain paused", async () => {
    independentCoder("claude");
    const f = fixture();
    await f.run();
    expect(f.provision).toHaveBeenCalledExactlyOnceWith("app", "core");
    expect(f.verify).toHaveBeenCalledOnce();
    expect(loadProject(root, "app").areas[0]).toMatchObject({
      enabled: false,
      codingEnabled: false,
    });
    expect(readCodingAgents(root, "app").agents[0]!.enabled).toBe(true);
    expect(loadProject(root, "app").config.verified).toBe("2026-10-14");
  });
  it("does not use a connected PM account as fallback for a disconnected coder or bypass master pause", async () => {
    independentCoder("codex");
    const f = fixture();
    await f.run();
    expect(f.provision).not.toHaveBeenCalled();
    expect(f.verify).not.toHaveBeenCalled();
    const current = readCodingAgents(root, "app");
    saveCodingAgents(root, "app", {
      revision: current.revision,
      agents: current.agents.map((agent) => ({
        ...agent,
        ai: { provider: "claude" },
      })),
    });
    edit("app", "project", (raw) => {
      raw.automationPaused = true;
    });
    await f.run();
    expect(f.provision).not.toHaveBeenCalled();
    expect(f.verify).not.toHaveBeenCalled();
  });
  it("prepares enabled mappings then verifies once, preserving paused mandates", async () => {
    edit("app", "areas", (raw) => {
      raw.areas.later = {
        ...raw.areas.core!,
        label: "pm:later",
        enabled: false,
        codingEnabled: false,
      };
    });
    const f = fixture();
    await f.run();
    await f.run();
    expect(f.provision).toHaveBeenCalledExactlyOnceWith("app", "core");
    expect(f.verify).toHaveBeenCalledOnce();
    expect(
      JSON.parse(readFileSync(join(root, "projects/app/areas.json"), "utf8"))
        .areas.later.linearProjectId,
    ).toBe("PASTE_LINEAR_PROJECT_ID");
  });
  it("waits for actual connection/worker readiness and retries when it recovers", async () => {
    const f = fixture();
    f.context({ ...ready, workers: [] });
    await f.run();
    expect(f.provision).not.toHaveBeenCalled();
    f.context(ready);
    await f.run();
    expect(f.verify).toHaveBeenCalledOnce();
  });
  it("bounds unavailable-provider retries and isolates malformed projects", async () => {
    initializeSetup(root, process.cwd(), {
      project: "broken",
      repo: "owner/broken",
    });
    writeFileSync(join(root, "projects/broken/project.json"), "broken");
    const f = fixture();
    f.provision.mockResolvedValue(false);
    await f.run();
    await f.run();
    expect(f.provision).toHaveBeenCalledOnce();
    expect(f.verify).not.toHaveBeenCalled();
    f.advance();
    await f.run();
    expect(f.provision).toHaveBeenCalledTimes(2);
  });
  it("avoids changing settings used by active work and does not enable a paused crew", async () => {
    const f = fixture();
    f.jobs([
      {
        id: "job-one",
        runId: 1,
        type: "pm",
        project: "app",
        area: "core",
        status: "running",
        createdAt: "2026-10-14",
      },
    ]);
    await f.run();
    expect(f.provision).not.toHaveBeenCalled();
    f.jobs([]);
    edit("app", "areas", (raw) => {
      raw.areas.core!.enabled = raw.areas.core!.codingEnabled = false;
    });
    await f.run();
    expect(f.verify).not.toHaveBeenCalled();
  });
  it("does not verify a replacement project after a remote mapping request", async () => {
    const f = fixture();
    f.provision.mockImplementation(async () => {
      edit("app", "areas", (raw) => {
        raw.areas.core!.linearProjectId = "mapped-project";
      });
      edit("app", "project", (raw) => {
        raw.instanceId = "a0e1ad1b-7a44-4d88-8bbc-22308cd17790";
      });
      return true;
    });
    await f.run();
    expect(f.verify).not.toHaveBeenCalled();
  });
  it("retains a verification diagnostic when the verifier returns without a verified stamp", async () => {
    const f = fixture();
    f.verify.mockImplementation(async () => {});
    await f.run();
    const project = loadProject(root, "app");
    const diagnostics = createAutomationDiagnostics(root);
    expect(project.config.verified).toBeNull();
    expect(diagnostics.list(project)).toMatchObject([
      { code: "verification", nextRetryAt: "1970-01-01T00:05:00.000Z" },
    ]);
    await f.run();
    expect(f.verify).toHaveBeenCalledOnce();
    f.advance();
    f.verify.mockImplementation(async (current) => {
      edit(current.config.name, "project", (raw) => {
        raw.verified = "2026-10-14";
      });
    });
    await f.run();
    expect(diagnostics.list(loadProject(root, "app"))).toEqual([]);
  });
  it("does not report a replacement project's verification as success for the original incarnation", async () => {
    const f = fixture();
    f.verify.mockImplementation(async () => {
      edit("app", "project", (raw) => {
        raw.instanceId = "a0e1ad1b-7a44-4d88-8bbc-22308cd17790";
        raw.verified = "2026-10-14";
      });
    });
    await f.run();
    expect(
      createAutomationDiagnostics(root).list(loadProject(root, "app")),
    ).toEqual([]);
  });
  it("persists a safe global-readiness failure for each active loadable project and survives restart", async () => {
    initializeSetup(root, process.cwd(), {
      project: "second",
      repo: "owner/second",
    });
    initializeSetup(root, process.cwd(), {
      project: "broken",
      repo: "owner/broken",
    });
    writeFileSync(join(root, "projects/broken/project.json"), "invalid");
    const provision = vi.fn(async () => true),
      verify = vi.fn(async () => {});
    const run = createAutomaticPreparation({
      root,
      context: async () => {
        throw Error("Bearer private-provider-credential");
      },
      jobs: async () => [],
      provision,
      verify,
      now: () => 0,
    });
    await run();
    for (const name of ["app", "second"]) {
      const diagnostics = createAutomationDiagnostics(root).list(
        loadProject(root, name),
      );
      expect(diagnostics).toMatchObject([{ code: "setup" }]);
      expect(JSON.stringify(diagnostics)).not.toContain(
        "private-provider-credential",
      );
    }
    expect(provision).not.toHaveBeenCalled();
    expect(verify).not.toHaveBeenCalled();
  });
});
