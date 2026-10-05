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
  areas: [{ key: "core", name: "Core", enabled: false }],
  readiness: {
    areas: [
      {
        key: "core",
        canRun: true,
        canEnable: true,
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
        toggle: (project: string, area: string) => Promise<void>;
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
    expect(api).toHaveBeenCalledWith("/api/jobs", {
      type: "pm",
      project: "shop",
      area: "core",
    });
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
      { enabled: true, revision: "areas-v1", projectRevision: "project-v1" },
    );
    f.saved.areas[0]!.enabled = true;
    f.saved.readiness.areas[0]!.canEnable = false;
    await f.actions.toggle("shop", "core");
    expect(f.api).toHaveBeenLastCalledWith(
      "/api/projects/shop/areas/core/status",
      { enabled: false, revision: "areas-v1", projectRevision: "project-v1" },
    );
  });
  it("does not disable automation setup merely because an on-demand worker is unavailable", async () => {
    const f = fixture();
    f.saved.readiness.areas[0]!.canRun = false;
    await f.actions.toggle("shop", "core");
    expect(f.api).toHaveBeenCalledTimes(1);
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
    expect(f.api).toHaveBeenCalledWith("/api/jobs", {
      type: "pm",
      project: "shop",
      area: "core",
    });
    expect(f.body.children[0]!.open).toBe(false);
  });
});
