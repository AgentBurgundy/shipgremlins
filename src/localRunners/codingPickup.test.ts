import { afterEach, expect, it } from "vitest";
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { initializeSetup } from "../setup/files.ts";
import { loadProject } from "../config.ts";
import type { LinearTicket } from "../services/types.ts";
import type { LocalJob } from "./types.ts";
import { createCodingPickup } from "./codingPickup.ts";

const roots: string[] = [];
const WORKSPACE = "44444444-4444-4444-8444-444444444444";
type FixtureConfig = {
  instanceId?: string;
  repo: string;
  linear: { connectionId: string; workspaceId?: string };
  areas: {
    core: {
      instanceId?: string;
      label: string;
      linearProjectId: string;
      enabled: boolean;
      codingEnabled: boolean;
      wipLimit: number;
    };
  };
};
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
const issue: LinearTicket = {
  id: "ec208d86-eb6d-48fd-a39b-dbb1c4a6f0e8",
  identifier: "SHI-2",
  projectId: "960b31c4-f408-4fae-8321-e51120f204ea",
  title: "Private ticket title is not retained",
  description: "Private ticket body is not retained",
  labels: ["pm:core", "pm-approved"],
  stateType: "backlog",
  priority: 1,
  createdAt: "2026-10-08T00:00:00Z",
  updatedAt: "2026-10-08T00:00:00Z",
  url: "https://linear.app/example/SHI-2",
};
function fixture() {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "sg-coding-pickup-"));
  roots.push(root);
  initializeSetup(root, fileURLToPath(new URL("../..", import.meta.url)), {
    project: "app",
    repo: "owner/app",
  });
  function edit(file: string, change: (value: FixtureConfig) => void) {
    const path = join(root, "projects/app", file);
    const value = JSON.parse(readFileSync(path, "utf8"));
    change(value);
    writeFileSync(path, JSON.stringify(value));
  }
  edit("project.json", (value) => {
    value.instanceId = "11111111-1111-4111-8111-111111111111";
    value.linear = { connectionId: "account-a", workspaceId: WORKSPACE };
  });
  edit("areas.json", (value) => {
    Object.assign(value.areas.core, {
      instanceId: "22222222-2222-4222-8222-222222222222",
      label: "pm:core",
      linearProjectId: issue.projectId,
      enabled: true,
      codingEnabled: true,
    });
  });
  const project = loadProject(root, "app"),
    area = project.areas[0]!;
  let time = Date.parse("2026-10-16T14:00:00Z");
  const cache = createCodingPickup(root, { now: () => new Date(time) });
  const failed: LocalJob = {
    id: "job-44f5671e-c00e-41d8-990e-113fb9578864",
    runId: 17,
    type: "developer",
    project: "app",
    projectInstanceId: project.config.instanceId,
    area: area.key,
    ticket: issue.identifier,
    status: "failed",
    createdAt: "2026-10-08T00:21:00Z",
    message: "Private provider response is not retained",
    linearBinding: {
      connectionId: "account-a",
      workspaceId: WORKSPACE,
      ticketId: issue.id,
    },
  };
  const scope = { connectionId: "account-a", workspaceId: WORKSPACE };
  const observe = (tickets = [issue]) => {
    const observation = cache.begin(loadProject(root, "app"));
    cache.observe(observation, area, tickets, scope);
    return observation;
  };
  return {
    root,
    project,
    area,
    cache,
    failed,
    scope,
    observe,
    edit,
    advance: (ms: number) => {
      time += ms;
    },
  };
}

it("reports SHI-2's observed failed coding run without retaining private ticket or provider content", () => {
  const f = fixture();
  expect(f.cache.read("app", [f.failed])).toEqual({
    state: "checking",
    needsReview: [],
  });
  f.observe();
  const view = f.cache.read("app", [f.failed]);
  expect(view).toEqual({
    state: "current",
    observedAt: "2026-10-16T14:00:00.000Z",
    needsReview: [
      {
        ticketId: issue.id,
        identifier: "SHI-2",
        area: "core",
        jobId: f.failed.id,
        runId: 17,
        status: "failed",
        reason: "previous-failed",
        href: `/activity?run=${f.failed.id}`,
      },
    ],
  });
  expect(JSON.stringify(view)).not.toContain("Private");
});

it.each(["queued", "running", "succeeded"] as const)(
  "immediately hides an older failed hold when a current explicit retry is %s",
  (status) => {
    const f = fixture();
    f.observe();
    const retry = { ...f.failed, id: "job-retry", runId: 18, status };
    expect(f.cache.read("app", [f.failed, retry]).needsReview).toEqual([]);
    expect(f.cache.read("app", [f.failed]).needsReview).toHaveLength(1);
  },
);
it("uses the newest exact-ticket failure and does not let an unrelated same-identifier run hide it", () => {
  const f = fixture();
  f.observe();
  const canceled = {
    ...f.failed,
    id: "job-canceled",
    runId: 19,
    status: "canceled" as const,
  };
  const unrelated = {
    ...f.failed,
    id: "job-unrelated",
    runId: 20,
    status: "running" as const,
    linearBinding: { ...f.failed.linearBinding!, ticketId: "different-uuid" },
  };
  expect(
    f.cache.read("app", [f.failed, canceled, unrelated]).needsReview,
  ).toMatchObject([
    {
      jobId: canceled.id,
      runId: 19,
      status: "canceled",
      reason: "previous-canceled",
    },
  ]);
});
it("matches exact workspace identity across connection aliases and otherwise requires the selected connection", () => {
  const f = fixture();
  f.observe();
  const wrongWorkspace = {
    ...f.failed,
    linearBinding: { ...f.failed.linearBinding!, workspaceId: "different" },
  };
  expect(f.cache.read("app", [wrongWorkspace]).needsReview).toEqual([]);
  const sameWorkspace = {
    ...f.failed,
    linearBinding: {
      ...f.failed.linearBinding!,
      connectionId: "another-alias",
    },
  };
  expect(f.cache.read("app", [sameWorkspace]).needsReview).toHaveLength(1);
  const withoutWorkspace = {
    ...f.failed,
    linearBinding: { connectionId: "account-a", ticketId: issue.id },
  };
  expect(f.cache.read("app", [withoutWorkspace]).needsReview).toHaveLength(1);
  expect(
    f.cache.read("app", [
      {
        ...withoutWorkspace,
        linearBinding: {
          ...withoutWorkspace.linearBinding,
          connectionId: "different",
        },
      },
    ]).needsReview,
  ).toEqual([]);
});
it("matches a conservative legacy identifier only within the same project incarnation", () => {
  const f = fixture();
  f.observe();
  const legacy = { ...f.failed, linearBinding: undefined };
  expect(f.cache.read("app", [legacy]).needsReview).toHaveLength(1);
  expect(
    f.cache.read("app", [{ ...legacy, projectInstanceId: undefined }])
      .needsReview,
  ).toEqual([]);
  expect(
    f.cache.read("app", [{ ...legacy, project: "other" }]).needsReview,
  ).toEqual([]);
  expect(f.cache.read("app", [{ ...legacy, type: "pm" }]).needsReview).toEqual(
    [],
  );
});
it.each([
  [
    "project.json",
    (value: FixtureConfig) => {
      value.instanceId = "33333333-3333-4333-8333-333333333333";
    },
  ],
  [
    "project.json",
    (value: FixtureConfig) => {
      value.linear.connectionId = "account-b";
    },
  ],
  [
    "project.json",
    (value: FixtureConfig) => {
      value.repo = "other/app";
    },
  ],
  [
    "areas.json",
    (value: FixtureConfig) => {
      value.areas.core.linearProjectId = "new-project";
    },
  ],
  [
    "areas.json",
    (value: FixtureConfig) => {
      value.areas.core.instanceId = "33333333-3333-4333-8333-333333333333";
    },
  ],
  [
    "areas.json",
    (value: FixtureConfig) => {
      value.areas.core.wipLimit = 2;
    },
  ],
] as const)(
  "invalidates observed holds after changed %s configuration",
  (file, change) => {
    const f = fixture();
    f.observe();
    f.edit(file, change);
    expect(f.cache.read("app", [f.failed])).toEqual({
      state: "checking",
      needsReview: [],
    });
  },
);
it("expires observations and does not present stale or future-dated counts as current", () => {
  const f = fixture();
  f.observe();
  f.advance(120_001);
  expect(f.cache.read("app", [f.failed])).toEqual({
    state: "checking",
    needsReview: [],
  });
  f.observe();
  f.advance(-1);
  expect(f.cache.read("app", [f.failed])).toEqual({
    state: "checking",
    needsReview: [],
  });
});
it("marks failed or oversized reads unavailable and never substitutes an empty current queue", () => {
  const f = fixture();
  const observation = f.observe();
  f.cache.unavailable(observation, f.area);
  expect(f.cache.read("app", [f.failed])).toEqual({
    state: "unavailable",
    needsReview: [],
  });
  f.observe(
    Array.from({ length: 501 }, (_, index) => ({
      ...issue,
      id: `issue-${index}`,
    })),
  );
  expect(f.cache.read("app", [f.failed]).state).toBe("unavailable");
  f.observe([]);
  expect(f.cache.read("app", [f.failed])).toMatchObject({
    state: "current",
    needsReview: [],
  });
});
it("does not allow an earlier asynchronous pass to replace a later observation", () => {
  const f = fixture();
  const previous = f.observe();
  f.observe([]);
  f.cache.observe(previous, f.area, [issue], f.scope);
  f.cache.unavailable(previous);
  expect(f.cache.read("app", [f.failed])).toMatchObject({
    state: "current",
    needsReview: [],
  });
});
