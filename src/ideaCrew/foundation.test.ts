import { afterEach, describe, expect, it, vi } from "vitest";
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createIdeaCrew } from "./index.ts";
import {
  createFoundation,
  foundationNeeded,
  snapshotHasApp,
} from "./foundation.ts";
import { samplePlan } from "./test-support.ts";
import { loadProject } from "../config.ts";
import { createJobPreparation } from "../localRunners/jobs.ts";
import type { LinearTicket } from "../services/types.ts";
import type { LocalJob, LocalJobInput } from "../localRunners/types.ts";
import type { RepositorySnapshot } from "../projectOnboarding/repository.ts";

const roots: string[] = [];
const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
const team = "11111111-1111-4111-8111-111111111111",
  linearProject = "22222222-2222-4222-8222-222222222222",
  workspace = "33333333-3333-4333-8333-333333333333";
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
const sourceSnapshot = (app = false): RepositorySnapshot => ({
  repository: {
    provider: "github",
    repo: "owner/studio",
    branch: "main",
    sha: "a".repeat(40),
    filesRead: app
      ? ["package.json", "src/app.js", "test/app.test.js"]
      : ["README.md"],
    truncated: false,
  },
  paths: app
    ? ["package.json", "src/app.js", "test/app.test.js"]
    : ["README.md"],
  files: app
    ? [
        {
          path: "package.json",
          content: JSON.stringify({
            scripts: { start: "node src/app.js", test: "node --test" },
          }),
        },
      ]
    : [{ path: "README.md", content: "Brief only" }],
});
async function fixture() {
  const root = mkdtempSync(
    join(realpathSync(tmpdir()), "gremlins-foundation-"),
  );
  roots.push(root);
  const sourceControl = {
    resolveCredential: vi.fn(async () => ({
      token: "synthetic-source",
      method: "token" as const,
    })),
  };
  const crew = createIdeaCrew({
    root,
    packageRoot,
    sourceControl,
    env: { CLAUDE_CODE_OAUTH_TOKEN: "synthetic-claude" },
    execute: async () => samplePlan(),
    fetch: async (url) =>
      Response.json(
        String(url).includes("branches?")
          ? [{ name: "main" }]
          : { default_branch: "main" },
      ),
  });
  const draft = await crew.plan(
    "Build a booking app for pottery students to reserve seats in classes.",
  );
  await crew.create(draft.id, {
    revision: draft.revision,
    project: "studio",
    repo: "owner/studio",
  });
  const edit = (
    file: string,
    change: (value: Record<string, unknown>) => void,
  ) => {
    const path = join(root, "projects", "studio", file),
      value = JSON.parse(readFileSync(path, "utf8"));
    change(value);
    writeFileSync(path, JSON.stringify(value, null, 2));
  };
  const jobs: LocalJob[] = [],
    tickets = new Map<string, LinearTicket>();
  let source = sourceSnapshot(),
    loseTicket = false,
    loseQueue = false;
  const provision = vi.fn(async () => {
    edit("project.json", (value) => {
      value.linear = {
        teamId: team,
        connectionId: "default",
        workspaceId: workspace,
      };
    });
    const path = join(root, "projects", "studio", "areas.json"),
      areas = JSON.parse(readFileSync(path, "utf8"));
    for (const area of Object.values(areas.areas) as Array<
      Record<string, unknown>
    >)
      area.linearProjectId = linearProject;
    writeFileSync(path, JSON.stringify(areas, null, 2));
  });
  const createTicket = vi.fn(
    async (input: {
      id?: string;
      teamId?: string;
      projectId: string;
      title: string;
      description: string;
      labels: string[];
      priority?: number;
    }) => {
      const ticket: LinearTicket = {
        ...input,
        id: input.id!,
        teamId: input.teamId,
        identifier: "STU-1",
        stateType: "unstarted",
        priority: input.priority ?? 0,
        url: "https://linear.app/studio/issue/STU-1",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      tickets.set(ticket.id, ticket);
      if (loseTicket) {
        loseTicket = false;
        throw new Error("Response lost");
      }
      return ticket;
    },
  );
  const ensureLabels = vi.fn(async () => {}),
    preflight = vi.fn(async () => {}),
    verify = vi.fn(async () => {});
  const enqueue = vi.fn(async (input: LocalJobInput) => {
    const existing = jobs.find(
      (job) => job.idempotencyKey === input.idempotencyKey,
    );
    if (existing) return existing;
    const job: LocalJob = {
      ...input,
      id: `job-00000000-0000-4000-8000-${String(jobs.length + 1).padStart(12, "0")}`,
      runId: jobs.length + 1,
      status: "queued",
      createdAt: new Date().toISOString(),
    };
    jobs.push(job);
    if (loseQueue) {
      loseQueue = false;
      throw new Error("Queue response lost");
    }
    return job;
  });
  const options = {
    root,
    ideaCrew: crew,
    sourceControl,
    inspect: vi.fn(async () => source),
    provision,
    verify,
    preflight,
    linear: async () => ({
      getTicket: async (id: string) => tickets.get(id) ?? null,
      createTicket,
      ensureLabels,
    }),
    enqueue,
    jobs: async () => jobs,
    job: async (id: string) => jobs.find((job) => job.id === id) ?? null,
  };
  return {
    root,
    options,
    service: createFoundation(options),
    provision,
    createTicket,
    ensureLabels,
    preflight,
    verify,
    enqueue,
    jobs,
    tickets,
    edit,
    setApp: () => {
      source = sourceSnapshot(true);
    },
    loseTicket: () => {
      loseTicket = true;
    },
    loseQueue: () => {
      loseQueue = true;
    },
  };
}

describe("foundation build", () => {
  it("reviews a saved idea without writes, then provisions one approved ticket and a coding job without PM analysis", async () => {
    const f = await fixture(),
      review = await f.service.status("studio");
    expect(review.stage).toBe("review");
    expect(review.buildBrief).toContain("meaningful npm test");
    expect(f.provision).not.toHaveBeenCalled();
    expect(f.createTicket).not.toHaveBeenCalled();
    const result = await f.service.start("studio", {
      revision: review.revision,
    });
    expect(result.stage).toBe("queued");
    expect(f.ensureLabels).toHaveBeenCalledWith(team, [
      "pm:foundation",
      "pm-approved",
    ]);
    expect(f.createTicket).toHaveBeenCalledWith(
      expect.objectContaining({
        id: expect.any(String),
        teamId: team,
        projectId: linearProject,
        labels: ["pm:foundation", "pm-approved"],
      }),
    );
    expect(f.jobs).toHaveLength(1);
    expect(f.jobs[0]).toMatchObject({
      type: "developer",
      area: "foundation",
      runOnce: true,
      ticket: "STU-1",
    });
    expect(
      loadProject(f.root, "studio").areas.every((area) => !area.enabled),
    ).toBe(true);
    expect(foundationNeeded(f.root, loadProject(f.root, "studio"))).toBe(true);
  });
  it("rejects stale scope before provider writes and keeps the review bound to owner edits", async () => {
    const f = await fixture(),
      review = await f.service.status("studio");
    await expect(
      f.service.start("studio", { revision: "stale" }),
    ).rejects.toThrow("brief changed");
    f.edit("project.json", (project) => {
      project.repo = "owner/changed";
    });
    await expect(
      f.service.start("studio", { revision: review.revision }),
    ).rejects.toThrow("Finish creating");
    expect(f.createTicket).not.toHaveBeenCalled();
  });
  it("recovers a lost ticket response by its reserved UUID after restart", async () => {
    const f = await fixture(),
      review = await f.service.status("studio");
    f.loseTicket();
    await expect(
      f.service.start("studio", { revision: review.revision }),
    ).rejects.toThrow("Response lost");
    const restarted = createFoundation(f.options);
    expect(
      (await restarted.start("studio", { revision: review.revision })).stage,
    ).toBe("queued");
    expect(f.createTicket).toHaveBeenCalledTimes(1);
    expect(f.tickets.size).toBe(1);
  });
  it("recovers a lost queue response and repeated clicks without duplicate work", async () => {
    const f = await fixture(),
      review = await f.service.status("studio");
    f.loseQueue();
    await expect(
      f.service.start("studio", { revision: review.revision }),
    ).rejects.toThrow("Queue response lost");
    const restarted = createFoundation(f.options);
    expect(
      (await restarted.start("studio", { revision: review.revision })).stage,
    ).toBe("queued");
    await restarted.start("studio", { revision: review.revision });
    expect(f.enqueue).toHaveBeenCalledTimes(1);
    expect(f.createTicket).toHaveBeenCalledTimes(1);
  });
  it.each(["queued", "running", "succeeded"] as const)(
    "adopts %s work started through the ordinary Coding entry point",
    async (jobStatus) => {
      const f = await fixture(),
        review = await f.service.status("studio");
      f.enqueue.mockRejectedValueOnce(new Error("Queue was unavailable"));
      await expect(
        f.service.start("studio", { revision: review.revision }),
      ).rejects.toThrow("Queue was unavailable");
      const ticket = [...f.tickets.values()][0]!;
      const ordinary: LocalJob = {
        type: "developer",
        project: "studio",
        projectInstanceId: loadProject(f.root, "studio").config.instanceId,
        area: "foundation",
        ticket: ticket.identifier,
        id: "job-44444444-4444-4444-8444-444444444444",
        runId: 40,
        status: jobStatus,
        createdAt: new Date().toISOString(),
        idempotencyKey: `developer:studio:${ticket.id}`,
        linearBinding: {
          connectionId: "default",
          workspaceId: workspace,
          ticketId: ticket.id,
        },
      };
      f.jobs.push(ordinary);
      const result = await createFoundation(f.options).start("studio", {
        revision: review.revision,
      });
      expect(result.job?.id).toBe(ordinary.id);
      expect(result.stage).toBe(
        jobStatus === "succeeded"
          ? "review-code"
          : jobStatus === "running"
            ? "building"
            : "queued",
      );
      expect(f.enqueue).toHaveBeenCalledTimes(1);
      expect(f.createTicket).toHaveBeenCalledTimes(1);
    },
  );
  it("does not adopt an ordinary coding job from a different workspace or project incarnation", async () => {
    const f = await fixture(),
      review = await f.service.status("studio");
    f.enqueue.mockRejectedValueOnce(new Error("Queue was unavailable"));
    await f.service
      .start("studio", { revision: review.revision })
      .catch(() => {});
    const ticket = [...f.tickets.values()][0]!;
    const unrelated: LocalJob = {
      type: "developer",
      project: "studio",
      projectInstanceId: loadProject(f.root, "studio").config.instanceId,
      ticket: ticket.identifier,
      id: "job-44444444-4444-4444-8444-444444444444",
      runId: 40,
      status: "succeeded",
      createdAt: new Date().toISOString(),
      linearBinding: {
        connectionId: "default",
        workspaceId: "different-workspace",
        ticketId: ticket.id,
      },
    };
    f.jobs.push(unrelated, {
      ...unrelated,
      id: "job-55555555-5555-4555-8555-555555555555",
      projectInstanceId: "99999999-9999-4999-8999-999999999999",
      linearBinding: { ...unrelated.linearBinding!, workspaceId: workspace },
    });
    expect((await f.service.status("studio")).stage).toBe("review");
    const result = await f.service.start("studio", {
      revision: review.revision,
    });
    expect(result.stage).toBe("queued");
    expect(result.job?.id).not.toBe(unrelated.id);
    expect(f.enqueue).toHaveBeenCalledTimes(2);
  });
  it("requires an explicit retry for failed work and reuses its ticket", async () => {
    const f = await fixture(),
      review = await f.service.status("studio");
    await f.service.start("studio", { revision: review.revision });
    f.jobs[0]!.status = "failed";
    await f.service.start("studio", { revision: review.revision });
    expect(f.jobs).toHaveLength(1);
    await f.service.start("studio", {
      revision: review.revision,
      retryJobId: f.jobs[0]!.id,
    });
    expect(f.jobs).toHaveLength(2);
    expect(f.createTicket).toHaveBeenCalledTimes(1);
  });
  it("does not reapprove a ticket whose approval the owner removed", async () => {
    const f = await fixture(),
      review = await f.service.status("studio");
    f.loseTicket();
    await f.service
      .start("studio", { revision: review.revision })
      .catch(() => {});
    [...f.tickets.values()][0]!.labels = ["pm:foundation"];
    await expect(
      f.service.start("studio", { revision: review.revision }),
    ).rejects.toThrow("no longer approved");
    expect(f.enqueue).not.toHaveBeenCalled();
    expect(f.createTicket).toHaveBeenCalledTimes(1);
  });
  it("accepts case variants of the existing approved and area labels", async () => {
    const f = await fixture(),
      review = await f.service.status("studio");
    f.loseTicket();
    await f.service
      .start("studio", { revision: review.revision })
      .catch(() => {});
    [...f.tickets.values()][0]!.labels = ["PM:Foundation", "PM-Approved"];
    expect(
      (await f.service.start("studio", { revision: review.revision })).stage,
    ).toBe("queued");
    expect(f.createTicket).toHaveBeenCalledTimes(1);
  });
  it("blocks a repository discovery or patrol on an idea that only has a brief", async () => {
    const f = await fixture(),
      jobs = createJobPreparation({ root: f.root });
    for (const pmMode of [undefined, "discovery"] as const)
      await expect(
        jobs.validate({
          type: "pm",
          project: "studio",
          area: "foundation",
          runOnce: true,
          pmMode,
        }),
      ).rejects.toThrow("Build the foundation first");
  });
  it("does not recreate a known ticket that became inaccessible or was deleted", async () => {
    const f = await fixture(),
      review = await f.service.status("studio");
    f.options.enqueue.mockRejectedValueOnce(new Error("No queue access"));
    await f.service
      .start("studio", { revision: review.revision })
      .catch(() => {});
    f.tickets.clear();
    await expect(
      f.service.start("studio", { revision: review.revision }),
    ).rejects.toThrow("no replacement was created");
    expect(f.createTicket).toHaveBeenCalledTimes(1);
  });
  it("requires source on the base branch before permitting PMs or environment setup", async () => {
    const f = await fixture(),
      review = await f.service.status("studio");
    await f.service.start("studio", { revision: review.revision });
    f.jobs[0]!.status = "succeeded";
    expect((await f.service.status("studio")).stage).toBe("review-code");
    expect((await f.service.inspect("studio")).stage).toBe("review-code");
    expect(foundationNeeded(f.root, loadProject(f.root, "studio"))).toBe(true);
    f.setApp();
    expect((await f.service.inspect("studio")).stage).toBe("ready");
    expect(foundationNeeded(f.root, loadProject(f.root, "studio"))).toBe(false);
  });
  it("recognizes an app built outside the dashboard without creating another ticket", async () => {
    const f = await fixture();
    f.setApp();
    const review = await f.service.status("studio");
    expect(
      (await f.service.start("studio", { revision: review.revision })).stage,
    ).toBe("ready");
    expect(f.provision).not.toHaveBeenCalled();
    expect(f.enqueue).not.toHaveBeenCalled();
  });
  it("keeps a completed foundation ready after its original PM or idea draft is removed", async () => {
    const f = await fixture();
    f.setApp();
    await f.service.inspect("studio");
    f.edit("areas.json", (value) => {
      delete (value.areas as Record<string, unknown>).foundation;
    });
    vi.spyOn(f.options.ideaCrew, "get").mockImplementation(() => {
      throw new Error("The old idea draft is unavailable");
    });
    expect((await f.service.status("studio")).stage).toBe("ready");
    expect((await f.service.inspect("studio")).stage).toBe("ready");
    expect(
      (await f.service.start("studio", { revision: "outdated" })).stage,
    ).toBe("ready");
    expect(f.enqueue).not.toHaveBeenCalled();
  });
  it("does not mistake a README or package scripts without source and tests for an application", () => {
    expect(snapshotHasApp(sourceSnapshot())).toBe(false);
    const snapshot = sourceSnapshot(true);
    snapshot.paths = ["package.json", "README.md"];
    expect(snapshotHasApp(snapshot)).toBe(false);
  });
  it("inspects the implementation base branch even when PMs inspect a staging branch", async () => {
    const f = await fixture();
    f.edit("project.json", (value) => {
      value.workflow = { kind: "promotion" };
      value.branches = {
        integration: "develop",
        staging: "staging",
        production: "main",
      };
      value.verification = { mode: "browser", environment: "staging" };
      value.environments = {
        staging: {
          kind: "vercel",
          role: "staging",
          projectId: "prj_preview",
          branch: "staging",
        },
      };
    });
    const fetcher = vi.fn(async (url: string | URL | Request) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith("/commits/develop"))
        return Response.json({ sha: "a".repeat(40) });
      if (path.includes("/git/trees/"))
        return Response.json({
          tree: ["package.json", "src/app.js", "test/app.test.js"].map(
            (path, index) => ({
              path,
              type: "blob",
              mode: "100644",
              sha: String(index + 1).repeat(40),
            }),
          ),
        });
      if (path.includes("/git/blobs/"))
        return Response.json({
          encoding: "base64",
          content: Buffer.from(
            path.endsWith("1".repeat(40))
              ? JSON.stringify({
                  scripts: { start: "node src/app.js", test: "node --test" },
                })
              : "// Synthetic source file",
          ).toString("base64"),
        });
      throw new Error(`Unexpected source request: ${path}`);
    });
    const service = createFoundation({
      ...f.options,
      inspect: undefined,
      fetch: fetcher,
    });
    expect((await service.inspect("studio")).stage).toBe("ready");
    expect(
      fetcher.mock.calls.some(([url]) =>
        String(url).includes("/commits/staging"),
      ),
    ).toBe(false);
  });
  it("does not unlock a missing base branch using code from the provider default branch", async () => {
    const f = await fixture();
    f.edit("project.json", (value) => {
      value.workflow = { kind: "pull-request", baseBranch: "missing-base" };
    });
    const fetcher = vi.fn(async (url: string | URL | Request) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith("/commits/missing-base"))
        return new Response("not found", { status: 404 });
      if (path.endsWith("/commits/main"))
        return Response.json({ sha: "a".repeat(40) });
      if (path.includes("/git/trees/"))
        return Response.json({
          tree: ["package.json", "src/app.js", "test/app.test.js"].map(
            (path, index) => ({
              path,
              type: "blob",
              mode: "100644",
              sha: String(index + 1).repeat(40),
            }),
          ),
        });
      if (path.includes("/git/blobs/"))
        return Response.json({
          encoding: "base64",
          content: Buffer.from(
            path.endsWith("1".repeat(40))
              ? JSON.stringify({
                  scripts: { start: "node src/app.js", test: "node --test" },
                })
              : "// Synthetic source file",
          ).toString("base64"),
        });
      return Response.json({ default_branch: "main" });
    });
    const service = createFoundation({
      ...f.options,
      inspect: undefined,
      fetch: fetcher,
    });
    await expect(service.inspect("studio")).rejects.toThrow(
      "configured base branch",
    );
    expect(foundationNeeded(f.root, loadProject(f.root, "studio"))).toBe(true);
    expect(f.enqueue).not.toHaveBeenCalled();
  });
});
