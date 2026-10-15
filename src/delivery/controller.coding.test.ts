import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { loadProject } from "../config.ts";
import { readCodingAgents, saveCodingAgents } from "../codingAgents/index.ts";
import {
  projectAiTarget,
  readAiRouting,
  saveAiRouting,
} from "../ai/routing.ts";
import { FakeForge } from "../forge/fake.ts";
import { makeProject, TEST_REPO } from "../services/fakes.ts";
import type { LocalJob, LocalJobInput } from "../localRunners/types.ts";
import { createDeliveryController } from "./controller.ts";
import { createStagingSync, stagingSyncScope } from "./stagingSync.ts";
import { LocalJobDeferredError } from "../localRunners/engine.ts";
import { createJobPreparation } from "../localRunners/jobs.ts";

const roots: string[] = [],
  STAGING = "a".repeat(40),
  INTEGRATION = "b".repeat(40);
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function world() {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "sg-sync-coder-"));
  roots.push(root);
  const seed = makeProject({
      config: { instanceId: randomUUID(), workflow: { kind: "promotion" } },
    }),
    directory = join(root, "projects/game");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "project.json"), JSON.stringify(seed.config));
  writeFileSync(
    join(directory, "areas.json"),
    JSON.stringify({
      areas: Object.fromEntries(seed.areas.map((area) => [area.key, area])),
    }),
  );
  writeFileSync(join(directory, "tiers.json"), JSON.stringify(seed.tiers));
  const project = loadProject(root, "game"),
    scope = projectAiTarget(project, "coder", project.areas[0]!);
  saveAiRouting(root, scope, {
    revision: readAiRouting(root, scope).revision,
    coder: { provider: "claude", model: "old-pm-coder" },
  });
  const projectScope = projectAiTarget(project, "coder");
  saveAiRouting(root, projectScope, {
    revision: readAiRouting(root, projectScope).revision,
    coder: { provider: "claude", model: "old-project-coder" },
  });
  const save = (agents: unknown[]) =>
    saveCodingAgents(root, "game", {
      revision: readCodingAgents(root, "game").revision,
      agents,
    });
  const coders = save([
    {
      key: "alpha",
      name: "Alpha builder",
      enabled: true,
      areas: ["core"],
      maxConcurrent: 2,
      ai: { provider: "claude", model: "alpha-model" },
    },
    {
      key: "beta",
      name: "Beta builder",
      enabled: true,
      areas: ["core"],
      maxConcurrent: 1,
      ai: { provider: "claude", model: "beta-model" },
    },
  ]).agents;
  const alpha = coders[0]!;
  const jobs: LocalJob[] = [
    {
      id: `job-${randomUUID()}`,
      runId: 1,
      type: "developer",
      project: "game",
      projectInstanceId: project.config.instanceId,
      area: "core",
      coderKey: alpha.key,
      coderInstanceId: alpha.instanceId,
      ticket: "APP-1",
      status: "running",
      createdAt: "2026-10-01T00:00:00.000Z",
    },
  ];
  const forge = new FakeForge();
  forge.seedBranch(TEST_REPO, "staging", STAGING);
  forge.seedBranch(TEST_REPO, "pm-staging", INTEGRATION);
  forge.seedBranch(TEST_REPO, "main", "c".repeat(40));
  forge.seedCompare(TEST_REPO, INTEGRATION, STAGING, {
    aheadBy: 2,
    behindBy: 1,
  });
  forge.seedChecks(TEST_REPO, STAGING, { status: "success", failedJobs: [] });
  forge.seedPull(TEST_REPO, {
    headRef: `gremlins/staging-sync-${stagingSyncScope(project).slice(0, 12)}-${STAGING}`,
    headSha: STAGING,
    baseRef: "pm-staging",
    draft: false,
    mergeableState: "dirty",
  });
  const enqueue = vi.fn(async (input: LocalJobInput): Promise<LocalJob> => {
    const job: LocalJob = {
      ...input,
      id: `job-${randomUUID()}`,
      runId: jobs.length + 1,
      status: "queued",
      createdAt: "2026-10-15T00:00:00.000Z",
    };
    jobs.push(job);
    return job;
  });
  const acquireLease = vi.fn(async () => ({
    token: "private-source",
    method: "token" as const,
    commitIdentity: {
      name: "Sync builder",
      email: "42+builder@users.noreply.github.com",
    },
  }));
  const controller = createDeliveryController({
    root,
    env: { CLAUDE_CODE_OAUTH_TOKEN: "private-claude" },
    sourceControl: {
      resolveCredential: async () => ({
        token: "private-source",
        method: "token" as const,
      }),
      acquireLease,
    },
    forge: () => forge,
    syncJobs: async () => jobs,
    enqueueSyncRepair: enqueue,
  });
  return {
    root,
    project,
    forge,
    coders,
    jobs,
    enqueue,
    acquireLease,
    controller,
    save,
  };
}
it("selects an available independent coder for staging maintenance and prepares its selected model without borrowing a PM route", async () => {
  const w = world();
  expect((await w.controller.reconcileStaging("game")).phase).toBe("repairing");
  const job = w.jobs.find((job) => job.developerKind === "sync")!;
  expect(job).toMatchObject({
    area: "core",
    coderKey: "beta",
    coderInstanceId: w.coders[1]!.instanceId,
  });
  const payload = await w.controller.prepareSyncRepair(job);
  expect(payload.ai).toEqual({ provider: "claude", model: "beta-model" });
  expect(payload.syncRepair).toEqual({ stagingSha: STAGING });
  expect(payload.expectedCommitSha).toBe(INTEGRATION);
  expect(w.acquireLease).toHaveBeenCalledOnce();
  expect(w.enqueue).toHaveBeenCalledOnce();
  w.save([]);
  w.save([
    {
      key: "beta",
      name: "Replacement",
      enabled: true,
      areas: ["core"],
      maxConcurrent: 1,
    },
  ]);
  await expect(w.controller.prepareSyncRepair(job)).rejects.toThrow("changed");
  expect(w.acquireLease).toHaveBeenCalledOnce();
});
it("preserves a genuine pre-migration sync job's project coder route without assigning it to a new coding profile", async () => {
  const w = world();
  const legacy = createStagingSync({
    root: w.root,
    project: w.project,
    currentProject: () => loadProject(w.root, "game"),
    forge: async () => w.forge,
    checkMerge: async () => true,
    deployment: async () => {
      throw new Error("Conflict repair does not verify a deployment");
    },
    jobs: async () => w.jobs,
    enqueue: w.enqueue,
  });
  expect((await legacy.reconcile()).phase).toBe("repairing");
  const job = w.jobs.find((job) => job.developerKind === "sync")!;
  job.createdAt = "2026-10-01T00:00:00.000Z";
  expect(job.area).toBeUndefined();
  expect(job.coderKey).toBeUndefined();
  // The private legacy maintenance profile has no public switch. Existing
  // authenticated repairs stay eligible; the engine separately honors master pause.
  expect(
    createJobPreparation({ root: w.root, env: {} }).admissionBlocker(job, []),
  ).toBeUndefined();
  const payload = await w.controller.prepareSyncRepair(job);
  expect(payload.ai).toEqual({
    provider: "claude",
    model: "old-project-coder",
  });
  expect(job.coderKey).toBeUndefined();
  expect(w.acquireLease).toHaveBeenCalledOnce();
});
it("rechecks the same coder's model after source credentials await and never hands changed credentials to a worker", async () => {
  const w = world();
  await w.controller.reconcileStaging("game");
  const job = w.jobs.find((job) => job.developerKind === "sync")!;
  w.acquireLease.mockImplementation(async () => {
    w.save(
      w.coders.map((coder) => ({
        ...coder,
        ...(coder.key === "beta"
          ? { ai: { provider: "claude", model: "changed-after-await" } }
          : {}),
      })),
    );
    return {
      token: "private-source",
      method: "token" as const,
      commitIdentity: {
        name: "Sync builder",
        email: "42+builder@users.noreply.github.com",
      },
    };
  });
  await expect(w.controller.prepareSyncRepair(job)).rejects.toBeInstanceOf(
    LocalJobDeferredError,
  );
  expect(w.enqueue).toHaveBeenCalledOnce();
  const saved = JSON.stringify(
    JSON.parse(readFileSync(join(w.root, "projects/game/coders.json"), "utf8")),
  );
  expect(saved).not.toContain("private-source");
  expect(saved).not.toContain("private-claude");
});
