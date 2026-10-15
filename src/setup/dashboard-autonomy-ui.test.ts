import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

interface WorkState {
  state: string;
  label: string;
  detail: string;
  action: string;
  href: string;
}
const guidance: {
  projectWorkState?: (
    project: object,
    jobs?: object[],
    operations?: object,
  ) => WorkState;
} = {};
runInNewContext(
  readFileSync(
    new URL("../../dashboard/first-run.js", import.meta.url),
    "utf8",
  ),
  { window: guidance },
);
const project = (extra = {}) => ({
  name: "alpha",
  instanceId: "current",
  areas: [{ key: "core", enabled: false }],
  readiness: { canRun: true, blockers: [] },
  ...extra,
});
const job = (extra = {}) => ({
  id: "run-1",
  runId: 1,
  type: "pm",
  project: "alpha",
  projectInstanceId: "current",
  status: "running",
  ...extra,
});
const describeWork = (extra = {}, jobs: object[] = [], operations = {}) =>
  guidance.projectWorkState!(project(extra), jobs, operations);

describe("truthful project work summaries", () => {
  it("shows a live run before saved blockers and ignores jobs from deleted project instances", () => {
    const autonomy = {
      enabled: true,
      state: "blocked",
      blockers: [{ message: "Missing Linear" }],
    };
    expect(
      describeWork({ autonomy }, [
        job(),
        job({ id: "old", runId: 20, projectInstanceId: "deleted" }),
      ]),
    ).toMatchObject({
      state: "running",
      href: "/activity?run=run-1",
    });
    expect(
      describeWork({}, [job({ projectInstanceId: "deleted" })]).state,
    ).toBe("paused");
  });
  it("keeps current execution distinct from enabled autonomy", () => {
    expect(
      describeWork({
        autonomy: {
          enabled: true,
          state: "waiting",
          message: "Waiting for the next patrol.",
        },
      }),
    ).toMatchObject({
      state: "autonomous",
      label: "Autonomy on",
      detail: "Waiting for the next patrol.",
    });
    expect(describeWork({}, [job({ status: "queued" })])).toMatchObject({
      state: "queued",
      label: "Queued",
    });
    expect(
      describeWork({}, [job({ status: "queued", runId: 3 }), job()]).state,
    ).toBe("running");
  });
  it("trusts an explicit server running summary while runner details are still loading", () => {
    expect(
      describeWork({
        autonomy: {
          enabled: true,
          state: "running",
          message: "Your crew is working.",
        },
      }),
    ).toMatchObject({
      state: "running",
      label: "Working",
      href: "/projects/alpha",
    });
  });
  it("does not let an unrelated area's blockers hide a ready automatic discovery", () => {
    expect(
      describeWork({
        autonomy: {
          enabled: true,
          state: "waiting",
          message: "Exploring the repository.",
          blockers: [{ message: "Another PM needs Linear" }],
        },
        readiness: { canRun: false, blockers: [{ message: "Missing Linear" }] },
      }),
    ).toMatchObject({
      state: "autonomous",
      detail: "Exploring the repository.",
    });
  });
  it("routes real autonomy blockers directly to the missing prerequisite", () => {
    expect(
      describeWork({
        autonomy: {
          enabled: true,
          state: "blocked",
          blockers: [{ action: "worker", message: "Connect a runner." }],
        },
      }),
    ).toMatchObject({
      state: "blocked",
      detail: "Connect a runner.",
      href: "/runners#workers",
    });
  });
  it("prioritizes adopting a crew before optional Linear setup", () => {
    expect(
      describeWork({
        areas: [],
        readiness: { canRun: false, blockers: [{ message: "Prepare Linear" }] },
      }),
    ).toMatchObject({
      state: "setup",
      label: "Crew needed",
      action: "Meet your first gremlin",
      href: "/projects/alpha",
    });
  });
  it("preserves foundation, review, unknown and failed-run recovery states", () => {
    expect(describeWork({ foundation: { needed: true } }).label).toBe(
      "Foundation needed",
    );
    expect(describeWork({}, [], { inbox: [{}] })).toMatchObject({
      state: "review",
      href: "/projects/alpha?tab=review",
    });
    expect(describeWork({ readiness: undefined }).state).toBe("unknown");
    expect(describeWork({}, [job({ status: "failed" })])).toMatchObject({
      state: "blocked",
      action: "Review last run",
    });
  });
});

class Element {
  children: Element[] = [];
  listeners = new Map<string, () => Promise<void>>();
  attributes = new Map<string, string>();
  textContent = "";
  className = "";
  hidden = false;
  disabled = false;
  type = "";
  href = "";
  classList = { toggle() {} };
  constructor(public tagName: string) {}
  append(...children: Element[]) {
    this.children.push(...children);
  }
  replaceChildren(...children: Element[]) {
    this.children = children;
  }
  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }
  addEventListener(name: string, handler: () => Promise<void>) {
    this.listeners.set(name, handler);
  }
  fire() {
    return this.listeners.get("click")?.();
  }
}
const all = (root: Element): Element[] => [root, ...root.children.flatMap(all)];
const text = (root: Element) =>
  all(root)
    .map((node) => node.textContent)
    .join(" ");
const flush = async () => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
};
function fixture(
  options: {
    saveError?: string;
    refreshError?: boolean;
    noCrew?: boolean;
    pending?: Promise<void>;
    projectPaused?: boolean;
    hasAutomaticAgents?: boolean;
  } = {},
) {
  let autonomy = {
    enabled: false,
    state: "paused",
    investigationEnabled: false,
    codingEnabled: false,
    message: "Automatic work is paused.",
    revision: "areas-r1",
    projectRevision: "project-r1",
    blockers: [],
    nextRunAt: null,
    projectPaused: options.projectPaused,
    hasAutomaticAgents: options.hasAutomaticAgents,
  };
  const api = vi.fn(async (path: string, body?: { enabled: boolean }) => {
    if (path.endsWith("/autonomy")) {
      if (options.pending) await options.pending;
      if (options.saveError) throw new Error(options.saveError);
      autonomy = {
        ...autonomy,
        enabled: body!.enabled,
        state: body!.enabled ? "waiting" : "paused",
        investigationEnabled: body!.enabled,
        codingEnabled: body!.enabled,
      };
      return { ok: true, autonomy };
    }
    return { autonomy };
  });
  const window = { addEventListener() {} } as unknown as {
    createProjectOperations: (options: object) => {
      mountAutonomy(root: Element, project: object): void;
    };
  };
  runInNewContext(
    readFileSync(
      new URL("../../dashboard/operations.js", import.meta.url),
      "utf8",
    ),
    {
      window,
      document: {
        getElementById: () => null,
        addEventListener() {},
        createElement: (name: string) => new Element(name.toUpperCase()),
      },
      URL,
      setTimeout: () => 1,
      clearTimeout() {},
    },
  );
  const navigate = vi.fn();
  const controller = window.createProjectOperations({
    api,
    pages: { current: "project", project: "alpha", navigate },
    inbox: null,
    getProject: () =>
      project({ autonomy, ...(options.noCrew ? { areas: [] } : {}) }),
    onChanged: async () => {
      if (options.refreshError) throw new Error("refresh failed");
    },
    isLocked: () => false,
  });
  const root = new Element("SECTION");
  controller.mountAutonomy(root, { name: "alpha" });
  const button = all(root).find((node) => node.tagName === "BUTTON")!;
  return { root, button, api, navigate };
}

describe("project autonomy controls", () => {
  it("enables and pauses all automatic work using both reviewed revisions", async () => {
    const f = fixture();
    await flush();
    expect(f.button.textContent).toBe("Enable autonomous work");
    await f.button.fire();
    expect(f.api).toHaveBeenCalledWith("/api/projects/alpha/autonomy", {
      enabled: true,
      revision: "areas-r1",
      projectRevision: "project-r1",
    });
    expect(f.button.textContent).toBe("Pause project automation");
    expect(text(f.root)).toContain(
      "PM investigations enabled · Coding agents enabled",
    );
    await f.button.fire();
    expect(f.api).toHaveBeenLastCalledWith("/api/projects/alpha/operations");
    expect(text(f.root)).toContain(
      "Future automatic starts are paused. Current runs can finish.",
    );
  });
  it("suppresses duplicate saves while a request is pending", async () => {
    let done!: () => void;
    const pending = new Promise<void>((resolve) => {
      done = resolve;
    });
    const f = fixture({ pending });
    await flush();
    const first = f.button.fire();
    expect(f.button.disabled).toBe(true);
    await f.button.fire();
    expect(
      f.api.mock.calls.filter(([path]) => path.endsWith("/autonomy")),
    ).toHaveLength(1);
    done();
    await first;
    expect(f.button.disabled).toBe(false);
  });
  it("keeps the saved state and shows a useful conflict recovery when saving fails", async () => {
    const f = fixture({ saveError: "The crew changed." });
    await flush();
    await f.button.fire();
    expect(f.button.textContent).toBe("Enable autonomous work");
    expect(text(f.root)).toContain(
      "The crew changed. Refresh this project before trying again.",
    );
  });
  it("reports a saved setting distinctly from a failed workspace refresh", async () => {
    const f = fixture({ refreshError: true });
    await flush();
    await f.button.fire();
    expect(f.button.textContent).toBe("Pause project automation");
    expect(text(f.root)).toContain("your setting was saved");
  });
  it("routes an empty crew to agent setup instead of sending an ineffective master toggle", async () => {
    const f = fixture({ noCrew: true });
    await flush();
    expect(f.button.disabled).toBe(false);
    expect(f.button.textContent).toBe("Choose automatic agents");
    await f.button.fire();
    expect(f.navigate).toHaveBeenCalledWith("/projects/alpha?tab=crew");
    expect(f.api.mock.calls.some(([path]) => path.endsWith("/autonomy"))).toBe(
      false,
    );
  });
  it.each([true, false])(
    "uses project pause intent %s independently of individual agent flags",
    async (projectPaused) => {
      const f = fixture({ projectPaused, hasAutomaticAgents: true });
      await flush();
      await f.button.fire();
      expect(f.api).toHaveBeenCalledWith("/api/projects/alpha/autonomy", {
        enabled: projectPaused,
        revision: "areas-r1",
        projectRevision: "project-r1",
      });
    },
  );
});
