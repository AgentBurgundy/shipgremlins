import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

class Element {
  children: Element[] = [];
  listeners = new Map<string, (event: { preventDefault(): void }) => unknown>();
  attributes = new Map<string, string>();
  dataset: Record<string, string> = {};
  textContent = "";
  className = "";
  disabled = false;
  open = false;
  append(...items: Element[]) {
    this.children.push(...items);
  }
  replaceChildren(...items: Element[]) {
    this.children = items;
  }
  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }
  addEventListener(
    name: string,
    fn: (event: { preventDefault(): void }) => unknown,
  ) {
    this.listeners.set(name, fn);
  }
  fire(name: string) {
    return this.listeners.get(name)?.({ preventDefault() {} });
  }
  showModal() {
    this.open = true;
  }
  close() {
    this.open = false;
  }
  focus() {}
}
const walk = (root: Element): Element[] => [
  root,
  ...root.children.flatMap(walk),
];
const project = () => ({
  name: "shop",
  projectRevision: "project-v1",
  areasRevision: "areas-v1",
  areas: [
    {
      key: "core",
      name: "Core",
      enabled: false,
      codingEnabled: undefined as boolean | undefined,
    },
  ],
  readiness: {
    areas: [
      {
        key: "core",
        canRun: true,
        canEnable: true,
        coding: undefined as
          { canEnable: boolean; enableBlockers: object[] } | undefined,
        blockers: [] as { action: string; id: string; message: string }[],
        enableBlockers: [] as { action: string; id: string; message: string }[],
      },
    ],
  },
});
function fixture(
  api = vi.fn(async (_path: string, _body: unknown) => ({
    job: { id: "job-one" },
  })),
) {
  const body = new Element(),
    window = {} as {
      createPmActions: (options: unknown) => {
        run: (project: string, area: string) => Promise<void>;
        explore: (project: string, area: string) => Promise<void>;
        toggle: (
          project: string,
          area: string,
          trigger?: unknown,
          kind?: string,
        ) => Promise<void>;
        isBusy: () => boolean;
      };
    };
  runInNewContext(
    readFileSync(
      new URL("../../dashboard/pm-actions.js", import.meta.url),
      "utf8",
    ),
    { window, document: { body, createElement: () => new Element() } },
  );
  const saved = project(),
    states = new Map<
      string,
      { busy?: boolean; message?: string; error?: boolean }
    >(),
    jobs: unknown[] = [],
    onJob = vi.fn(),
    onChanged = vi.fn(async () => {});
  const actions = window.createPmActions({
    api,
    getProject: (name: string) => (name === "shop" ? saved : null),
    getJobs: () => jobs,
    isLocked: () => false,
    states,
    onState: vi.fn(),
    onChanged,
    onJob,
  });
  return { actions, api, body, saved, states, jobs, onJob, onChanged };
}
describe("direct PM actions", () => {
  it.each(["run", "explore"] as const)(
    "lets %s prepare missing mappings and verify the project through normal admission",
    async (action) => {
      const f = fixture(),
        readiness = f.saved.readiness.areas[0]!;
      readiness.canRun = false;
      readiness.blockers = [
        {
          id: "linear_mapping",
          action: "mapping",
          message: "Mapping missing.",
        },
        {
          id: "verification",
          action: "verify",
          message: "Verification needed.",
        },
      ];
      await f.actions[action]("shop", "core");
      expect(f.api).toHaveBeenCalledWith(
        "/api/jobs",
        {
          type: "pm",
          project: "shop",
          area: "core",
          ...(action === "explore" ? { pmMode: "exploration" } : {}),
        },
        "POST",
        90000,
      );
      expect(f.body.children[0]!.open).toBe(false);
    },
  );
  it("keeps real prerequisites and automation gated while allowing automatic run preparation", async () => {
    const f = fixture(),
      readiness = f.saved.readiness.areas[0]!;
    readiness.canRun = readiness.canEnable = false;
    readiness.blockers = [
      { id: "linear_mapping", action: "mapping", message: "Mapping missing." },
      { id: "worker", action: "worker", message: "Start a worker." },
    ];
    readiness.enableBlockers = [readiness.blockers[0]!];
    await f.actions.run("shop", "core");
    expect(f.api).not.toHaveBeenCalled();
    await f.actions.toggle("shop", "core");
    expect(f.api).not.toHaveBeenCalled();
  });
  it("queues deliberate product exploration without changing automation or the normal patrol request", async () => {
    const f = fixture();
    await f.actions.explore("shop", "core");
    expect(f.api).toHaveBeenCalledExactlyOnceWith(
      "/api/jobs",
      {
        type: "pm",
        project: "shop",
        area: "core",
        pmMode: "exploration",
      },
      "POST",
      90000,
    );
    expect(f.saved.areas[0]!.enabled).toBe(false);
    await f.actions.toggle("shop", "core");
    expect(f.api).toHaveBeenLastCalledWith(
      "/api/projects/shop/areas/core/status",
      {
        enabled: true,
        codingEnabled: false,
        revision: "areas-v1",
        projectRevision: "project-v1",
      },
    );
  });
  it("opens an active patrol when Explore is clicked instead of launching competing PM work", async () => {
    const f = fixture(),
      active = {
        id: "current-patrol",
        type: "pm",
        project: "shop",
        area: "core",
        status: "queued",
      };
    f.jobs.push(active);
    await f.actions.explore("shop", "core");
    expect(f.onJob).toHaveBeenCalledExactlyOnceWith(active);
    expect(f.api).not.toHaveBeenCalled();
  });
  it("keeps exploration intent through its readiness remedies and recheck", async () => {
    const f = fixture();
    f.saved.readiness.areas[0]!.canRun = false;
    f.saved.readiness.areas[0]!.blockers = [
      {
        id: "linear_connection",
        action: "linear",
        message: "Connect Linear first.",
      },
    ];
    await f.actions.explore("shop", "core");
    expect(f.api).not.toHaveBeenCalled();
    expect(
      walk(f.body).some((item) => item.textContent === "Explore product ideas"),
    ).toBe(true);
    expect(
      walk(f.body).find((item) => item.dataset.setupAction === "linear")
        ?.dataset.setupProject,
    ).toBe("shop");
    f.onChanged.mockImplementation(async () => {
      f.saved.readiness.areas[0]!.canRun = true;
    });
    await walk(f.body)
      .find((item) => item.textContent === "Check again")!
      .fire("click");
    expect(f.api).toHaveBeenCalledWith(
      "/api/jobs",
      {
        type: "pm",
        project: "shop",
        area: "core",
        pmMode: "exploration",
      },
      "POST",
      90000,
    );
  });
  it("keeps an accepted run successful when refresh fails and opens it on the next click", async () => {
    const f = fixture();
    f.onChanged.mockRejectedValue(new Error("Dashboard unavailable"));
    await f.actions.explore("shop", "core");
    expect(f.states.get("shop/core")).toMatchObject({
      busy: false,
      message: expect.stringContaining("Run queued"),
    });
    expect(f.states.get("shop/core")?.error).not.toBe(true);
    expect(f.states.get("shop/core")?.message).toContain("could not refresh");
    await f.actions.run("shop", "core");
    expect(f.api).toHaveBeenCalledTimes(1);
    expect(f.onJob).toHaveBeenLastCalledWith({ id: "job-one" });
    expect(f.onChanged).toHaveBeenCalledTimes(1);
  });
  it("preserves confirmed automation success when refreshing its new state fails", async () => {
    const f = fixture();
    f.onChanged.mockRejectedValue(new Error("Dashboard unavailable"));
    await f.actions.toggle("shop", "core");
    expect(f.api).toHaveBeenCalledExactlyOnceWith(
      "/api/projects/shop/areas/core/status",
      {
        enabled: true,
        codingEnabled: false,
        revision: "areas-v1",
        projectRevision: "project-v1",
      },
    );
    expect(f.states.get("shop/core")?.error).not.toBe(true);
    expect(f.states.get("shop/core")?.message).toContain(
      "Scheduled investigations on.",
    );
    expect(f.states.get("shop/core")?.message).toContain(
      "Refresh before changing automation again.",
    );
    expect(f.states.get("shop/core")?.busy).toBe(false);
  });
  it("keeps a failed readiness refresh retryable without creating a job", async () => {
    const f = fixture();
    f.saved.readiness.areas[0]!.canRun = false;
    await f.actions.explore("shop", "core");
    f.onChanged.mockRejectedValue(new Error("Setup status unavailable"));
    const refresh = walk(f.body).find(
      (item) => item.textContent === "Check again",
    )!;
    await refresh.fire("click");
    expect(refresh.textContent).toBe("Check again");
    expect(refresh.disabled).toBe(false);
    expect(f.actions.isBusy()).toBe(false);
    expect(f.api).not.toHaveBeenCalled();
    expect(
      walk(f.body).some(
        (item) => item.textContent === "Setup status unavailable",
      ),
    ).toBe(true);
  });
  it("holds the busy state after acceptance until refresh finishes and allows another run only after completion is observed", async () => {
    const f = fixture();
    let finish!: () => void;
    f.onChanged.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const pending = f.actions.explore("shop", "core");
    await Promise.resolve();
    expect(f.actions.isBusy()).toBe(true);
    await f.actions.run("shop", "core");
    expect(f.api).toHaveBeenCalledTimes(1);
    finish();
    await pending;
    f.jobs.push({
      id: "job-one",
      type: "pm",
      project: "shop",
      area: "core",
      status: "succeeded",
    });
    await f.actions.run("shop", "core");
    expect(f.api).toHaveBeenCalledTimes(2);
    expect(f.api).toHaveBeenLastCalledWith(
      "/api/jobs",
      {
        type: "pm",
        project: "shop",
        area: "core",
      },
      "POST",
      90000,
    );
  });
  it("queues a paused PM directly without changing automation and deduplicates an in-flight click", async () => {
    let resolve!: (value: { job: { id: string } }) => void;
    const api = vi.fn(
      (_path: string, _body: unknown) =>
        new Promise<{ job: { id: string } }>((done) => {
          resolve = done;
        }),
    );
    const f = fixture(api),
      pending = f.actions.run("shop", "core");
    await f.actions.run("shop", "core");
    expect(api).toHaveBeenCalledTimes(1);
    expect(api).toHaveBeenCalledWith(
      "/api/jobs",
      {
        type: "pm",
        project: "shop",
        area: "core",
      },
      "POST",
      90000,
    );
    resolve({ job: { id: "job-one" } });
    await pending;
    expect(f.onJob).toHaveBeenCalledWith({ id: "job-one" });
    expect(f.saved.areas[0]!.enabled).toBe(false);
  });
  it("opens the existing run instead of launching a duplicate", async () => {
    const f = fixture(),
      job = {
        id: "active",
        project: "shop",
        area: "core",
        type: "pm",
        status: "running",
      };
    f.jobs.push(job);
    await f.actions.run("shop", "core");
    expect(f.onJob).toHaveBeenCalledWith(job);
    expect(f.api).not.toHaveBeenCalled();
  });
  it("shows only this PM's blockers with scoped remedy controls", async () => {
    const f = fixture();
    f.saved.readiness.areas[0]!.canRun = false;
    f.saved.readiness.areas[0]!.blockers = [
      { id: "mandate", action: "mandate", message: "Add a mandate." },
    ];
    await f.actions.run("shop", "core");
    expect(f.api).not.toHaveBeenCalled();
    expect(f.body.children[0]!.open).toBe(true);
    expect(
      walk(f.body).find((item) => item.dataset.setupAction === "mandate")
        ?.dataset,
    ).toEqual({
      setupAction: "mandate",
      setupProject: "shop",
      setupArea: "core",
      setupStep: "mandate",
    });
  });
  it("enables with reviewed current revisions and allows pausing even if setup is broken", async () => {
    const f = fixture();
    await f.actions.toggle("shop", "core");
    expect(f.api).toHaveBeenLastCalledWith(
      "/api/projects/shop/areas/core/status",
      {
        enabled: true,
        codingEnabled: false,
        revision: "areas-v1",
        projectRevision: "project-v1",
      },
    );
    f.saved.areas[0]!.enabled = true;
    f.saved.readiness.areas[0]!.canEnable = false;
    await f.actions.toggle("shop", "core");
    expect(f.api).toHaveBeenLastCalledWith(
      "/api/projects/shop/areas/core/status",
      {
        enabled: false,
        codingEnabled: true,
        revision: "areas-v1",
        projectRevision: "project-v1",
      },
    );
  });
  it("does not disable automation setup merely because an on-demand worker is unavailable", async () => {
    const f = fixture();
    f.saved.readiness.areas[0]!.canRun = false;
    await f.actions.toggle("shop", "core");
    expect(f.api).toHaveBeenCalledTimes(1);
  });
  it("changes coding pickup independently and preserves the legacy effective setting when stopping patrols", async () => {
    const f = fixture();
    f.saved.readiness.areas[0]!.canEnable = false;
    f.saved.readiness.areas[0]!.coding = {
      canEnable: true,
      enableBlockers: [],
    };
    await f.actions.toggle("shop", "core", undefined, "coding");
    expect(f.api).toHaveBeenLastCalledWith(
      "/api/projects/shop/areas/core/status",
      {
        enabled: false,
        codingEnabled: true,
        revision: "areas-v1",
        projectRevision: "project-v1",
      },
    );
    f.saved.areas[0]!.enabled = true;
    f.saved.areas[0]!.codingEnabled = undefined;
    await f.actions.toggle("shop", "core");
    expect(f.api).toHaveBeenLastCalledWith(
      "/api/projects/shop/areas/core/status",
      {
        enabled: false,
        codingEnabled: true,
        revision: "areas-v1",
        projectRevision: "project-v1",
      },
    );
    f.saved.areas[0]!.enabled = false;
    f.saved.areas[0]!.codingEnabled = true;
    f.saved.readiness.areas[0]!.coding.canEnable = false;
    await f.actions.toggle("shop", "core", undefined, "coding");
    expect(f.api).toHaveBeenLastCalledWith(
      "/api/projects/shop/areas/core/status",
      {
        enabled: false,
        codingEnabled: false,
        revision: "areas-v1",
        projectRevision: "project-v1",
      },
    );
  });
  it("keeps server conflicts visible without changing the displayed enabled state", async () => {
    const f = fixture(
      vi.fn(async () => {
        throw new Error("Configuration changed. Reload first.");
      }),
    );
    await f.actions.toggle("shop", "core");
    expect(f.states.get("shop/core")).toMatchObject({
      error: true,
      busy: false,
      message: "Configuration changed. Reload first.",
    });
    expect(f.saved.areas[0]!.enabled).toBe(false);
  });
  it("rechecks readiness before running from the compact setup panel", async () => {
    const f = fixture();
    f.saved.readiness.areas[0]!.canRun = false;
    await f.actions.run("shop", "core");
    f.onChanged.mockImplementation(async () => {
      f.saved.readiness.areas[0]!.canRun = true;
    });
    await walk(f.body)
      .find((item) => item.textContent === "Check again")!
      .fire("click");
    expect(f.api).toHaveBeenCalledWith(
      "/api/jobs",
      {
        type: "pm",
        project: "shop",
        area: "core",
      },
      "POST",
      90000,
    );
    expect(f.body.children[0]!.open).toBe(false);
  });
});
