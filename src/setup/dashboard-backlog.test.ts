import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

type Handler = (event: Record<string, unknown>) => unknown;
class Element {
  children: Element[] = [];
  attributes = new Map<string, string>();
  listeners = new Map<string, Handler>();
  className = "";
  dataset: Record<string, string> = {};
  textContent = "";
  value = "";
  id = "";
  hidden = false;
  disabled = false;
  open = false;
  isConnected = true;
  href = "";
  type = "";
  tabIndex = 0;
  parent: Element | null = null;
  onclick?: Handler;
  onsubmit?: Handler;
  get lastChild() {
    return this.children.at(-1);
  }
  querySelectorAll(selector: string) {
    const tags = selector.split(",").map((tag) => tag.toUpperCase());
    return all(this)
      .slice(1)
      .filter((node) => tags.includes(node.tagName));
  }
  constructor(
    public tagName: string,
    private focusNode: (node: Element) => void,
  ) {}
  append(...children: Element[]) {
    for (const child of children) {
      if (child.parent)
        child.parent.children = child.parent.children.filter(
          (node) => node !== child,
        );
      child.parent = this;
      this.children.push(child);
    }
  }
  replaceChildren(...children: Element[]) {
    this.children = [];
    this.append(...children);
  }
  setAttribute(key: string, value: string) {
    this.attributes.set(key, value);
  }
  getAttribute(key: string) {
    return this.attributes.get(key);
  }
  classList = {
    toggle: (_name: string, _value: boolean) => {},
    remove: (_name: string) => {},
  };
  removeAttribute(key: string) {
    this.attributes.delete(key);
  }
  addEventListener(key: string, handler: Handler) {
    this.listeners.set(key, handler);
  }
  removeEventListener(key: string, handler: Handler) {
    if (this.listeners.get(key) === handler) this.listeners.delete(key);
  }
  fire(key: string, values = {}) {
    return (
      this.listeners.get(key) ||
      (key === "click"
        ? this.onclick
        : key === "submit"
          ? this.onsubmit
          : undefined)
    )?.({
      preventDefault() {},
      target: this,
      ...values,
    });
  }
  focus() {
    this.focusNode(this);
  }
  showModal() {
    this.open = true;
  }
  close() {
    this.open = false;
  }
  scrollIntoView() {}
  remove() {
    if (this.parent)
      this.parent.children = this.parent.children.filter(
        (node) => node !== this,
      );
    this.isConnected = false;
  }
  closest() {
    return ["INPUT", "TEXTAREA", "SELECT"].includes(this.tagName) ||
      this.attributes.get("contenteditable") === "true"
      ? this
      : null;
  }
}
const all = (root: Element): Element[] => [root, ...root.children.flatMap(all)];
const text = (root: Element): string =>
  all(root)
    .map((node) => node.textContent)
    .join(" ");
interface TestProject {
  name: string;
  instanceId?: string;
  preferenceId?: string;
}
interface TestPreferences {
  sync(status: object): void;
  toggle(project: TestProject | undefined): boolean;
  isFavorite(project: TestProject | undefined): boolean;
  move(project: TestProject | undefined, direction: number): boolean;
  position(project: TestProject | undefined): number;
  canPersist(project: TestProject): boolean;
  compare(a: TestProject, b: TestProject): number;
}
interface TestFreshness {
  start(path: string): void;
  success(path: string, value: unknown): void;
  fail(path: string): void;
  cancel(path: string): void;
  resetRun(): void;
  lastGood(path: string): unknown;
  snapshot(): Array<{
    key: string;
    lastSuccess?: number;
    degraded?: boolean;
    pending?: boolean;
    stale?: boolean;
  }>;
}
interface TestWindow {
  addEventListener: Handler;
  createCrewConsole(options: object): object;
  renderAutonomousApprovalPolicy(
    root: Element,
    project: object,
    options: { api(path: string, body?: object): Promise<unknown> },
  ): { isDirty(): boolean };
  createProjectPreferences(storage?: {
    getItem(key: string): string | null | undefined;
    setItem(key: string, value: string): void;
  }): TestPreferences;
  compareWorkspaceProjects(
    preferences: TestPreferences,
    a: object,
    b: object,
  ): number;
  createDashboardFreshness(options?: { now?: () => number }): TestFreshness;
  dashboardFreshness?: TestFreshness;
  dashboardCommandItems(
    status: object,
    jobs?: object[],
  ): Array<{ href: string; label: string; detail: string }>;
  createDashboardCommands(options: {
    getStatus(): object;
    getJobs?(): object[];
    navigate(href: string): void;
  }): { open(): void; close(): void };
  normalizedRunFailure(job: object): unknown;
  renderRunFailure(
    root: Element,
    job: object,
    onTab: (name: string) => void,
  ): void;
  createOperatorRecovery(options: {
    api(path: string, body?: object): Promise<unknown>;
    project: string;
    isLocked(): boolean;
  }): {
    node: Element;
    refresh(): Promise<void>;
    resume(): void;
    isDirty(): boolean;
  };
}
function fixture(options: { now?: () => number } = {}) {
  const events = new Map<string, Handler>();
  const document = {
    activeElement: null as Element | null,
    body: null as unknown as Element,
    createElement: (name: string): Element =>
      new Element(name.toUpperCase(), (node) => {
        document.activeElement = node;
      }),
    getElementById: (id: string) =>
      all(document.body).find((node) => node.id === id) || null,
    addEventListener: vi.fn((name: string, handler: Handler) =>
      events.set(name, handler),
    ),
    removeEventListener: (name: string) => events.delete(name),
    querySelector: (selector: string) =>
      selector === ".topbar"
        ? topbar
        : selector === "dialog[open]"
          ? all(document.body).find(
              (node) => node.tagName === "DIALOG" && node.open,
            ) || null
          : null,
  };
  document.body = document.createElement("body");
  const topbar = document.createElement("header");
  document.body.append(topbar);
  const window = { addEventListener: vi.fn() } as unknown as TestWindow;
  const context = {
    Date: class extends Date {
      static override now() {
        return options.now?.() ?? Date.now();
      }
    },
    window,
    document,
    location: { origin: "http://localhost:4331" },
    URL,
    AbortController,
    setTimeout,
    clearTimeout,
  };
  for (const file of [
    "workspace-tools",
    "command-menu",
    "run-recovery",
    "crew-console",
  ])
    runInNewContext(
      readFileSync(
        new URL(`../../dashboard/${file}.js`, import.meta.url),
        "utf8",
      ),
      context,
    );
  return { window, document, events, context, topbar };
}
const projects = [
  { name: "alpha", instanceId: "a1" },
  { name: "beta", instanceId: "b1" },
  { name: "charlie", instanceId: "c1" },
];
const storage = () => {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key),
    setItem: (key: string, value: string) => values.set(key, value),
    values,
  };
};
const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

describe("persistent identity-scoped project preferences", () => {
  it("supports durable sidecar preference IDs for legacy projects without changing job identity", () => {
    const { window } = fixture(),
      prefs = window.createProjectPreferences(storage()),
      legacy = { name: "legacy", preferenceId: "sidecar-1" };
    prefs.sync({ configDirectory: "a", projects: [legacy] });
    expect(prefs.canPersist(legacy)).toBe(true);
    prefs.toggle(legacy);
    expect(prefs.isFavorite(legacy)).toBe(true);
    const replacement = { name: "legacy", preferenceId: "sidecar-2" };
    prefs.sync({ configDirectory: "a", projects: [replacement] });
    expect(prefs.isFavorite(replacement)).toBe(false);
    expect(
      window
        .dashboardCommandItems({ projects: [legacy] }, [
          { id: "live", project: "legacy", status: "running" },
        ])
        .some((item) => item.href === "/activity?run=live"),
    ).toBe(true);
  });
  it("keeps critical blockers before favorites while preserving explicit order within groups", () => {
    const { window } = fixture(),
      prefs = window.createProjectPreferences!(storage());
    prefs.sync({ configDirectory: "a", projects });
    prefs.toggle(projects[0]);
    const rows = [
      { status: projects[0], work: { state: "paused" } },
      { status: projects[1], work: { state: "blocked" } },
      { status: projects[2], work: { state: "paused" } },
    ];
    rows.sort((a, b) => window.compareWorkspaceProjects!(prefs, a, b));
    expect(rows.map((row) => row.status!.name)).toEqual([
      "beta",
      "alpha",
      "charlie",
    ]);
  });
  it("restores favorites and explicit order across sessions without storing credentials", () => {
    const { window } = fixture(),
      saved = storage(),
      first = window.createProjectPreferences!(saved);
    first.sync({ configDirectory: "controller-a", projects });
    first.toggle(projects[1]);
    first.move(projects[2], -1);
    const second = window.createProjectPreferences!(saved);
    second.sync({ configDirectory: "controller-a", projects });
    expect(second.isFavorite(projects[1])).toBe(true);
    expect(second.position(projects[2])).toBe(0);
    expect([...projects].sort(second.compare).map((item) => item.name)).toEqual(
      ["beta", "charlie", "alpha"],
    );
    expect([...saved.values.values()][0]).not.toMatch(
      /token|credential|secret/,
    );
  });
  it("separates controllers and never transfers a deleted project's favorite to its replacement", () => {
    const { window } = fixture(),
      prefs = window.createProjectPreferences!(storage());
    prefs.sync({ configDirectory: "a", projects });
    prefs.toggle(projects[0]);
    prefs.sync({ configDirectory: "b", projects });
    expect(prefs.isFavorite(projects[0])).toBe(false);
    prefs.sync({
      configDirectory: "a",
      projects: [{ name: "alpha", instanceId: "replacement" }],
    });
    expect(prefs.isFavorite({ name: "alpha", instanceId: "replacement" })).toBe(
      false,
    );
    expect(prefs.move({ name: "alpha", instanceId: "a1" }, 1)).toBe(false);
    expect(prefs.canPersist({ name: "legacy" })).toBe(false);
  });
  it("keeps memory preferences usable when storage is unavailable or corrupt", () => {
    const { window } = fixture(),
      prefs = window.createProjectPreferences!({
        getItem() {
          return "broken-json";
        },
        setItem() {
          throw new Error("denied");
        },
      });
    prefs.sync({ configDirectory: "a", projects });
    expect(prefs.toggle(projects[0])).toBe(true);
    expect(prefs.isFavorite(projects[0])).toBe(true);
  });
});
describe("approval audit manual-review action", () => {
  const view = () => ({
    revision: "policy-r1",
    policy: {
      enabled: true,
      allowedPaths: ["docs"],
      requiredLabel: "pm-auto-docs",
      maxDailyApprovals: 2,
      maxOpenTickets: 1,
      maxFiles: 3,
      maxChangedLines: 50,
    },
    audit: [
      {
        id: "audit-1",
        identifier: "APP-1",
        status: "approved",
        files: ["docs/guide.md"],
      },
    ],
  });
  const render = (api: (path: string, body?: object) => Promise<unknown>) => {
    const f = fixture();
    runInNewContext(
      readFileSync(
        new URL("../../dashboard/autonomy-policy.js", import.meta.url),
        "utf8",
      ),
      f.context,
    );
    const root = f.document.createElement("section"),
      control = f.window.renderAutonomousApprovalPolicy(
        root,
        { name: "alpha" },
        { api },
      );
    return { root, control };
  };
  const reviewButton = (root: Element) =>
    all(root).find((node) => node.textContent === "Send to manual review")!;
  it("posts exact audit identity and revision, locks duplicate actions, and refreshes audit with a Proposals link", async () => {
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const api = vi.fn(async (path: string) => {
      if (path.endsWith("/review")) {
        await pending;
        const result = view();
        result.audit[0]!.status = "manual";
        return result;
      }
      return view();
    });
    const { root, control } = render(api);
    await flush();
    const action = reviewButton(root),
      request = action.fire("click");
    expect(action.disabled).toBe(true);
    expect(control.isDirty()).toBe(true);
    await action.fire("click");
    expect(api).toHaveBeenCalledWith(
      "/api/projects/alpha/approval-policy/review",
      { revision: "policy-r1", auditId: "audit-1" },
    );
    expect(
      api.mock.calls.filter(([path]) => path.endsWith("/review")),
    ).toHaveLength(1);
    finish();
    await request;
    expect(reviewButton(root)).toBeUndefined();
    expect(text(root)).toContain("APP-1 · manual");
    expect(text(root)).toContain("Sent to manual review");
    expect(
      all(root).find((node) => node.textContent === "Open Proposals →")!.href,
    ).toBe("/projects/alpha?tab=review");
    expect(control.isDirty()).toBe(false);
  });
  it("preserves policy drafts and requires save or reload before changing an approval", async () => {
    let current = view();
    const api = vi.fn(async (path: string, body?: object) => {
      if (body && !path.endsWith("/review")) {
        current = { ...current, revision: "policy-r2" };
        return current;
      }
      return current;
    });
    const { root, control } = render(api);
    await flush();
    const form = all(root).find((node) => node.tagName === "FORM")!,
      paths = all(form).find((node) => node.tagName === "TEXTAREA")!,
      action = reviewButton(root);
    paths.value = "docs/changed";
    await form.fire("input", { target: paths });
    expect(action.disabled).toBe(true);
    await action.fire("click");
    expect(api).toHaveBeenCalledTimes(1);
    expect(paths.value).toBe("docs/changed");
    expect(control.isDirty()).toBe(true);
    await form.fire("submit");
    expect(action.disabled).toBe(false);
    await action.fire("click");
    expect(api).toHaveBeenCalledWith(
      "/api/projects/alpha/approval-policy/review",
      { revision: "policy-r2", auditId: "audit-1" },
    );
  });
  it("keeps the saved audit and form intact when manual-review return fails", async () => {
    const api = vi.fn(async (path: string) => {
      if (path.endsWith("/review"))
        throw new Error("The ticket changed; refresh its exact scope.");
      return view();
    });
    const { root } = render(api);
    await flush();
    const paths = all(root).find((node) => node.tagName === "TEXTAREA")!;
    await reviewButton(root).fire("click");
    expect(text(root)).toContain("APP-1 · approved");
    expect(text(root)).toContain("The ticket changed");
    expect(all(root).find((node) => node.tagName === "TEXTAREA")).toBe(paths);
    expect(paths.disabled).toBe(false);
    expect(
      all(root)
        .find((node) => node.textContent.startsWith("The ticket changed"))!
        .attributes.get("role"),
    ).toBe("alert");
  });
});
describe("per-source data freshness", () => {
  it("retains last-good values and success time through a failed refresh, then recovers", () => {
    const { window } = fixture();
    let time = 100;
    const health = window.createDashboardFreshness!({ now: () => time });
    const value = { projects: ["alpha"] };
    health.success("/api/status", value);
    time = 200;
    health.start("/api/status");
    health.fail("/api/status");
    expect(health.lastGood("/api/status")).toBe(value);
    expect(health.snapshot()[0]).toMatchObject({
      lastSuccess: 100,
      degraded: true,
      pending: false,
    });
    expect(health.snapshot()[0]).not.toHaveProperty("value");
    health.success("/api/status", { projects: ["beta"] });
    expect(health.snapshot()[0]!.degraded).toBe(false);
    time = 90201;
    expect(health.snapshot()[0]!.stale).toBe(true);
  });
  it("tracks operations and output independently and forgets run data after a selection closes", () => {
    const { window } = fixture(),
      health = window.createDashboardFreshness!();
    health.success("/api/operations", {});
    health.success("/api/runners", {});
    health.success("/api/jobs/job1/activity", {});
    health.fail("/api/jobs/job1/logs");
    expect(health.snapshot().filter((entry) => entry.degraded)).toHaveLength(1);
    health.start("/api/jobs/job1/artifacts");
    health.cancel("/api/jobs/job1/artifacts");
    expect(
      health.snapshot().find((entry) => entry.key === "run:artifacts")
        ?.degraded,
    ).toBeUndefined();
    health.resetRun();
    expect(
      health.snapshot().map((entry: { key: string }) => entry.key),
    ).toEqual(["reviews", "runners"]);
    health.success("/api/connections/secret", { secret: true });
    expect(health.snapshot()).toHaveLength(2);
  });
  it("instruments the actual dashboard GET wrapper and preserves request failures", async () => {
    const f = fixture(),
      health = f.window.createDashboardFreshness!();
    f.window.dashboardFreshness = health;
    let fail = false;
    const app = readFileSync(
        new URL("../../dashboard/app.js", import.meta.url),
        "utf8",
      ),
      start = app.indexOf("  async function api("),
      end = app.indexOf("  function renderConnectionSummary()", start);
    const api = runInNewContext(`${app.slice(start, end)}; api`, {
      ...f.context,
      auth: {
        request: async () => {
          if (fail) throw new Error("offline");
          return { ok: true, json: async () => ({ projects: ["alpha"] }) };
        },
      },
    });
    await api("/api/status");
    fail = true;
    await expect(api("/api/status")).rejects.toThrow("offline");
    expect(health.lastGood("/api/status")).toEqual({ projects: ["alpha"] });
    expect(health.snapshot()[0]!.degraded).toBe(true);
  });
});
describe("searchable keyboard command menu", () => {
  it("shows projects, current-incarnation recent runs, and useful setup actions", () => {
    const { window } = fixture();
    const items = window.dashboardCommandItems!({ projects }, [
      { id: "old", project: "alpha", projectInstanceId: "deleted", runId: 99 },
      {
        id: "new",
        project: "alpha",
        projectInstanceId: "a1",
        runId: 4,
        status: "running",
      },
    ]);
    expect(
      items.find((item: { href: string }) => item.href === "/activity?run=old"),
    ).toBeUndefined();
    expect(
      items.find((item: { href: string }) => item.href === "/activity?run=new"),
    ).toBeTruthy();
    expect(
      items.some((item: { label: string }) => item.label === "Set up runners"),
    ).toBe(true);
  });
  it("reuses the header search button and registers one shared shortcut while preserving crew destinations", async () => {
    const f = fixture(),
      trigger = f.document.createElement("button");
    trigger.id = "quick-jump-trigger";
    trigger.textContent = "Find anything";
    f.topbar.append(trigger);
    f.window.createCrewConsole({ pages: { current: "overview" } });
    f.window.createDashboardCommands({
      getStatus: () => ({
        projects: [
          {
            ...projects[0],
            areas: [{ key: "checkout", name: "Checkout quality" }],
          },
        ],
      }),
      navigate() {},
    });
    expect(f.topbar.children).toEqual([trigger]);
    expect(
      all(f.document.body).filter((node) => node.tagName === "DIALOG"),
    ).toHaveLength(1);
    expect(
      f.document.addEventListener.mock.calls.filter(
        ([name]) => name === "keydown",
      ),
    ).toHaveLength(1);
    expect(trigger.getAttribute("aria-controls")).toBe(
      "workspace-command-menu",
    );
    trigger.focus();
    await trigger.fire("click");
    const dialog = all(f.document.body).find(
      (node) => node.tagName === "DIALOG",
    )!;
    expect(dialog.open).toBe(true);
    expect(text(dialog)).toContain("Checkout quality");
    expect(text(dialog)).toContain("Usage");
  });
  it("searches, supports arrow/Enter navigation, and restores opener focus on close", async () => {
    const f = fixture(),
      navigate = vi.fn(),
      control = f.window.createDashboardCommands!({
        getStatus: () => ({ projects }),
        getJobs: () => [],
        navigate,
      });
    const opener = f.topbar.children[0]!;
    opener.focus();
    control.open();
    const dialog = all(f.document.body).find(
        (node) => node.tagName === "DIALOG",
      )!,
      input = all(dialog).find((node) => node.tagName === "INPUT")!;
    input.value = "beta";
    await input.fire("input");
    expect(text(dialog)).toContain("beta");
    expect(text(dialog)).not.toContain("alpha");
    await input.fire("keydown", { key: "Enter" });
    expect(navigate).toHaveBeenCalledWith("/projects/beta");
    expect(dialog.open).toBe(false);
    expect(f.document.activeElement).toBe(opener);
    control.open();
    await input.fire("keydown", { key: "ArrowDown" });
    expect(input.attributes.get("aria-activedescendant")).toBe(
      "command-menu-option-1",
    );
    await dialog.fire("cancel");
    expect(f.document.activeElement).toBe(opener);
    control.open();
    await input.fire("keydown", { key: "Escape" });
    expect(dialog.open).toBe(false);
    expect(f.document.activeElement).toBe(opener);
  });
  it("does not steal editing shortcuts or open over another modal", () => {
    const f = fixture();
    f.window.createDashboardCommands!({
      getStatus: () => ({ projects }),
      navigate() {},
    });
    const shortcut = f.events.get("keydown")!,
      input = f.document.createElement("input"),
      preventDefault = vi.fn();
    shortcut({ key: "k", ctrlKey: true, target: input, preventDefault });
    expect(preventDefault).not.toHaveBeenCalled();
    const other = f.document.createElement("dialog");
    other.open = true;
    f.document.body.append(other);
    shortcut({
      key: "k",
      metaKey: true,
      target: f.document.body,
      preventDefault,
    });
    expect(preventDefault).not.toHaveBeenCalled();
    other.open = false;
    shortcut({
      key: "k",
      ctrlKey: true,
      target: f.document.body,
      preventDefault,
    });
    expect(preventDefault).toHaveBeenCalledOnce();
  });
});
describe("structured run failure and operator recovery", () => {
  it("keeps approval-policy controls stable and includes their drafts in restart protection", async () => {
    const f = fixture();
    let dirty = true;
    const policy = vi.fn(() => ({ isDirty: () => dirty }));
    const enriched = f.window as TestWindow & {
      addEventListener(): void;
      renderAutonomousApprovalPolicy: typeof policy;
      createProjectOperations(options: object): {
        mountAutonomy(root: Element, project: object): void;
        isDirty(): boolean;
      };
    };
    enriched.addEventListener = () => {};
    enriched.renderAutonomousApprovalPolicy = policy;
    runInNewContext(
      readFileSync(
        new URL("../../dashboard/operations.js", import.meta.url),
        "utf8",
      ),
      f.context,
    );
    const control = enriched.createProjectOperations({
      api: async () => ({}),
      pages: { current: "project" },
      inbox: null,
      getProject: () => ({ name: "alpha", areas: [] }),
      isLocked: () => false,
    });
    const root = f.document.createElement("section");
    control.mountAutonomy(root, { name: "alpha" });
    await flush();
    control.mountAutonomy(root, { name: "alpha" });
    expect(policy).toHaveBeenCalledOnce();
    expect(control.isDirty()).toBe(true);
    dirty = false;
    expect(control.isDirty()).toBe(false);
  });
  it("discovers new reservations after an empty result without overwriting an active draft", async () => {
    let now = 100000,
      calls = 0;
    const f = fixture({ now: () => now }),
      api = vi.fn(async () => ({
        reservations:
          ++calls > 1 ? [{ id: "r1", project: "alpha", supported: true }] : [],
      }));
    const recovery = f.window.createOperatorRecovery({
      api,
      project: "alpha",
      isLocked: () => false,
    });
    await flush();
    expect(recovery.node.hidden).toBe(true);
    now += 16000;
    recovery.resume();
    await flush();
    expect(recovery.node.hidden).toBe(false);
    const input = all(recovery.node).find((node) => node.tagName === "INPUT")!;
    input.value = "42";
    await input.fire("input");
    now += 16000;
    recovery.resume();
    await flush();
    expect(api).toHaveBeenCalledTimes(2);
    expect(all(recovery.node).find((node) => node.tagName === "INPUT")).toBe(
      input,
    );
  });
  it("loads recovery after initial workspace unlock and protects a pending run-ID draft", async () => {
    const f = fixture();
    let locked = true;
    const api = vi.fn(async () => ({
      reservations: [{ id: "r1", project: "alpha", supported: true }],
    }));
    const recovery = f.window.createOperatorRecovery({
      api,
      project: "alpha",
      isLocked: () => locked,
    });
    expect(api).not.toHaveBeenCalled();
    locked = false;
    recovery.resume();
    await flush();
    expect(api).toHaveBeenCalledOnce();
    const input = all(recovery.node).find((node) => node.tagName === "INPUT")!;
    input.value = "42";
    await input.fire("input");
    expect(recovery.isDirty()).toBe(true);
    recovery.resume();
    expect(all(recovery.node).find((node) => node.tagName === "INPUT")).toBe(
      input,
    );
  });
  it("keeps unavailable recovery checks distinct from an empty queue and filters other projects", async () => {
    const f = fixture(),
      recovery = f.window.createOperatorRecovery!({
        api: async () => ({
          reservations: [{ id: "other", project: "beta", supported: true }],
          unavailableProjects: ["alpha"],
        }),
        project: "alpha",
        isLocked: () => false,
      });
    await flush();
    expect(recovery.node.hidden).toBe(false);
    expect(text(recovery.node)).toContain("could not be checked");
    expect(all(recovery.node).some((node) => node.tagName === "FORM")).toBe(
      false,
    );
  });
  it("retains the last successful recovery list while that project's next check is unavailable", async () => {
    const f = fixture();
    let unavailable = false;
    const recovery = f.window.createOperatorRecovery!({
      api: async () => ({
        reservations: unavailable
          ? []
          : [{ id: "r1", project: "alpha", supported: true }],
        unavailableProjects: unavailable ? ["alpha"] : [],
      }),
      project: "alpha",
      isLocked: () => false,
    });
    await flush();
    unavailable = true;
    await recovery.refresh();
    expect(all(recovery.node).some((node) => node.tagName === "FORM")).toBe(
      true,
    );
    expect(text(recovery.node)).toContain("could not be checked");
  });
  it("uses only normalized categories, preserves evidence routes, and never scans raw messages", () => {
    const { window } = fixture();
    expect(
      window.normalizedRunFailure!({
        status: "failed",
        project: "alpha",
        failure: { category: "credential-wait" },
        message: "secret-token",
      }),
    ).toMatchObject({ href: "/connections" });
    expect(
      window.normalizedRunFailure!({
        status: "failed",
        project: "alpha",
        failure: { category: "environment-wait", retryable: true },
        nextAttemptAt: "2026-10-15T10:00:00.000Z",
      }),
    ).toMatchObject({
      title: "The test environment is not ready",
      href: "/projects/alpha?tab=environment",
      nextAttemptAt: "2026-10-15T10:00:00.000Z",
    });
    expect(
      JSON.stringify(
        window.normalizedRunFailure!({
          status: "failed",
          failure: { category: "unknown" },
          message: "secret-token",
        }),
      ),
    ).not.toContain("secret-token");
    expect(
      window.normalizedRunFailure!({
        status: "succeeded",
        failure: { category: "completion" },
      }),
    ).toBeNull();
    const f = fixture(),
      root = f.document.createElement("section"),
      onTab = vi.fn();
    f.window.renderRunFailure!(
      root,
      { status: "failed", failure: { category: "completion" } },
      onTab,
    );
    all(root)
      .find((node) => node.tagName === "BUTTON")!
      .fire("click");
    expect(onTab).toHaveBeenCalledWith("artifacts");
  });
  it("links only an existing numeric provider run and never dispatches new work", async () => {
    const f = fixture();
    let recovered = false;
    const api = vi.fn(async (_path: string, body?: object) =>
      body
        ? ((recovered = true), { runId: 42 })
        : {
            reservations: recovered
              ? []
              : [
                  {
                    id: "r1",
                    project: "alpha",
                    ticket: "APP-1",
                    supported: true,
                    repository: "org/app",
                    attempt: 1,
                  },
                ],
          },
    );
    const recovery = f.window.createOperatorRecovery!({
      api,
      project: "alpha",
      isLocked: () => false,
    });
    await flush();
    const form = all(recovery.node).find((node) => node.tagName === "FORM")!,
      input = all(form).find((node) => node.tagName === "INPUT")!;
    input.value = "42";
    await input.fire("input");
    await form.fire("submit");
    expect(api).toHaveBeenCalledWith("/api/recovery/bind", {
      reservationId: "r1",
      runId: 42,
    });
    expect(api.mock.calls.every(([path]) => path.includes("/recovery"))).toBe(
      true,
    );
  });
  it("retains a failed recovery draft and rejects unsafe/non-numeric run IDs", async () => {
    const f = fixture(),
      api = vi.fn(async (_path: string, body?: object) => {
        if (body) throw new Error("Scope mismatch");
        return {
          reservations: [{ id: "r1", project: "alpha", supported: true }],
        };
      });
    const recovery = f.window.createOperatorRecovery!({
      api,
      project: "alpha",
      isLocked: () => false,
    });
    await flush();
    const form = all(recovery.node).find((node) => node.tagName === "FORM")!,
      input = all(form).find((node) => node.tagName === "INPUT")!;
    input.value = "9007199254740992";
    await form.fire("submit");
    expect(api).toHaveBeenCalledTimes(1);
    input.value = "123";
    await input.fire("input");
    await form.fire("submit");
    expect(text(recovery.node)).toContain("Scope mismatch");
    expect(
      all(recovery.node).find((node) => node.tagName === "INPUT")!.value,
    ).toBe("123");
  });
});
describe("private multiline build inputs", () => {
  it("uses a masked bounded textarea without JSON validation and saves exact multiline text", async () => {
    const f = fixture(),
      source = readFileSync(
        new URL("../../dashboard/connections-view.js", import.meta.url),
        "utf8",
      ),
      start = source.indexOf("    function createRow("),
      end = source.indexOf("    function render(", start),
      api = vi.fn(async () => ({}));
    const createRow = runInNewContext(`(${source.slice(start, end).trim()})`, {
      document: f.document,
      node: (tag: string, cls: string, content?: string) =>
        Object.assign(f.document.createElement(tag), {
          className: cls || "",
          textContent: content || "",
          dataset: {},
        }),
      api,
      locked: false,
      message: (host: Element, content: string) => {
        host.textContent = content;
      },
      onSaved: async () => {},
    });
    const row = createRow({
      name: "TEST_BUILD_KEY",
      purpose: "build-secret",
      format: "text",
    });
    expect(row.input.tagName).toBe("TEXTAREA");
    expect(row.input.className).toBe("secret-json");
    expect(row.input.dataset.secretJson).toBeUndefined();
    expect(row.input.dataset.secretText).toBe("true");
    expect(row.input.maxLength).toBe(65536);
    expect(
      createRow({
        name: "BUILD_JSON_HINT",
        purpose: "build-secret",
        format: "json",
      }).input.dataset.secretJson,
    ).toBeUndefined();
    row.input.value = "first line\nsecond line";
    await all(row.details)
      .find((node) => node.tagName === "FORM")!
      .fire("submit");
    expect(api).toHaveBeenCalledWith("/api/connections", {
      values: { TEST_BUILD_KEY: "first line\nsecond line" },
    });
    expect(row.input.value).toBe("");
    const runtime = createRow({
      name: "TEST_RUNTIME_KEY",
      purpose: "app-environment",
      format: "text",
    });
    expect(runtime.input.tagName).toBe("INPUT");
    expect(runtime.input.type).toBe("password");
  });
});
