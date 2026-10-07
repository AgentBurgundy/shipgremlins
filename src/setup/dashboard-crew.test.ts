import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

type Job = {
  id: string;
  project: string;
  projectInstanceId?: string | null;
  area?: string;
  status: string;
  type?: string;
  runId?: number;
  createdAt?: string;
  updatedAt?: string;
  failure?: { category: string };
  grumblin?: { name: string };
};
type Project = {
  name: string;
  instanceId?: string | null;
  areas: { key: string; name?: string; enabled?: boolean; schedule?: string }[];
  readiness?: { areas: { key: string; canRun: boolean }[] };
};
type Model = {
  recent(jobs: Job[]): Job[];
  scoped(project: Project, jobs: Job[]): Job[];
  crew(
    projects: Project[],
    jobs: Job[],
  ): {
    project: Project;
    area: Project["areas"][number];
    job?: Job;
    href: string;
    state: string;
  }[];
  statusLabel(job: Job): string;
  jobName(job: Job, projects: Project[]): string;
  destinations(
    projects: Project[],
    jobs: Job[],
  ): { name: string; href: string; context: string }[];
};
function model(): Model {
  const window = {} as { dashboardCrewModel: Model };
  runInNewContext(
    readFileSync(
      new URL("../../dashboard/crew-console.js", import.meta.url),
      "utf8",
    ),
    { window },
  );
  return window.dashboardCrewModel;
}
const project = (): Project => ({
  name: "shop",
  instanceId: "new-instance",
  areas: [
    {
      key: "checkout",
      name: "Checkout Gremlin",
      enabled: true,
      schedule: "0 9 * * *",
    },
  ],
});
const job = (overrides: Partial<Job> = {}): Job => ({
  id: "current",
  project: "shop",
  projectInstanceId: "new-instance",
  area: "checkout",
  status: "running",
  type: "pm",
  runId: 2,
  createdAt: "2026-10-07T20:00:00Z",
  ...overrides,
});

describe("dashboard crew model", () => {
  it("isolates a recreated project from old, legacy, and other project jobs", () => {
    const input = [
      job(),
      job({ id: "old", projectInstanceId: "old-instance" }),
      job({ id: "legacy", projectInstanceId: undefined }),
      job({ id: "other", project: "elsewhere" }),
    ];
    expect(
      model()
        .scoped(project(), input)
        .map((item) => item.id),
    ).toEqual(["current"]);
    expect(model().crew([project()], input)[0]?.job?.id).toBe("current");
    expect(
      model()
        .scoped({ ...project(), instanceId: undefined }, input)
        .map((item) => item.id),
    ).toEqual(["legacy"]);
  });
  it("keeps a running PM ahead of newer queue and completion records without treating coding as PM work", () => {
    const input = [
      job({ id: "coding", type: "developer", runId: 7 }),
      job({ id: "done", status: "succeeded", runId: 6 }),
      job({ id: "queued", status: "queued", runId: 5 }),
      job(),
    ];
    const item = model().crew([project()], input)[0]!;
    expect(item.job?.id).toBe("current");
    expect(item.state).toBe("Working");
    expect(
      model().crew(
        [project()],
        input.filter((entry) => entry.id !== "current"),
      )[0]?.job?.id,
    ).toBe("queued");
  });
  it("sorts by recorded activity time with run ID as tie breaker without mutating caller history", () => {
    const input = [
      job({ id: "created", runId: 10 }),
      job({ id: "updated", runId: 1, updatedAt: "2026-10-07T20:02:00Z" }),
      job({ id: "tie", runId: 12 }),
    ];
    expect(
      model()
        .recent(input)
        .map((item) => item.id),
    ).toEqual(["updated", "tie", "created"]);
    expect(input.map((item) => item.id)).toEqual(["created", "updated", "tie"]);
  });
  it("reports environmental waits and completion without inventing product verification", () => {
    expect(
      model().statusLabel(
        job({ status: "queued", failure: { category: "environment-wait" } }),
      ),
    ).toBe("Waiting for environment");
    expect(model().statusLabel(job({ status: "succeeded" }))).toBe(
      "Run finished",
    );
    expect(model().statusLabel(job({ status: "failed" }))).toBe("Stopped");
    expect(model().statusLabel(job({ status: "canceled" }))).toBe("Canceled");
    expect(
      model().crew([project()], [job({ status: "succeeded" })])[0]?.state,
    ).toBe("Scheduled");
    expect(
      model().crew(
        [{ ...project(), areas: [{ key: "checkout", enabled: false }] }],
        [],
      )[0]?.state,
    ).toBe("On demand");
  });
  it("does not label an enabled PM as runnable when saved readiness is blocked", () => {
    const blocked: Project = {
      ...project(),
      readiness: { areas: [{ key: "checkout", canRun: false }] },
    };
    expect(model().crew([blocked], [job({ status: "failed" })])[0]?.state).toBe(
      "Needs setup",
    );
    expect(model().crew([blocked], [job()])[0]?.state).toBe("Working");
  });
  it("uses the matching instance to resolve names and distinguishes simulation and coding runs", () => {
    expect(model().jobName(job(), [project()])).toBe("Checkout Gremlin");
    expect(
      model().jobName(job({ projectInstanceId: "deleted" }), [project()]),
    ).toBe("checkout");
    expect(
      model().jobName(job({ grumblin: { name: "Impatient shopper" } }), [
        project(),
      ]),
    ).toBe("Impatient shopper");
    expect(model().jobName(job({ type: "developer" }), [project()])).toBe(
      "Coding Gremlin",
    );
  });
  it("builds searchable route destinations from configured projects and areas with safe URL encoding", () => {
    const configured: Project = {
      name: "store / demo",
      areas: [{ key: "checkout & account", name: "Moss" }],
    };
    const destinations = model().destinations(
      [configured],
      [job({ area: "removed-pm" })],
    );
    expect(destinations.find((item) => item.name === "Moss")).toEqual({
      name: "Moss",
      href: "/projects/store%20%2F%20demo?pm=checkout%20%26%20account",
      context: "store / demo",
    });
    expect(
      destinations.filter((item) => item.context === "store / demo"),
    ).toHaveLength(1);
    expect(destinations.find((item) => item.name === "Activity")?.href).toBe(
      "/activity",
    );
    expect(destinations.some((item) => item.name === "removed-pm")).toBe(false);
  });
});
