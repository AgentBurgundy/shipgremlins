import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

type EventHandler = (event: { preventDefault(): void }) => unknown;
class Element {
  children: Element[] = [];
  parent: Element | null = null;
  listeners = new Map<string, EventHandler>();
  tagName: string;
  className = "";
  textContent = "";
  value = "";
  id = "";
  hidden = false;
  disabled = false;
  checked = false;
  open = false;
  type = "";
  dataset: Record<string, string> = {};
  href = "";
  attributes = new Map<string, string>();
  classList = { toggle: () => {} };
  constructor(tag: string) {
    this.tagName = tag.toUpperCase();
  }
  append(...items: Element[]) {
    for (const item of items) {
      if (item.parent)
        item.parent.children = item.parent.children.filter(
          (child) => child !== item,
        );
      item.parent = this;
      this.children.push(item);
    }
  }
  replaceChildren(...items: Element[]) {
    for (const item of this.children) item.parent = null;
    this.children = [];
    this.append(...items);
  }
  get firstElementChild() {
    return this.children[0];
  }
  get lastElementChild() {
    return this.children.at(-1);
  }
  setAttribute(key: string, value: string) {
    this.attributes.set(key, value);
  }
  addEventListener(key: string, fn: EventHandler) {
    this.listeners.set(key, fn);
  }
  async fire(key: string) {
    await this.listeners.get(key)?.({ preventDefault() {} });
  }
  focus() {}
  remove() {
    if (this.parent)
      this.parent.children = this.parent.children.filter(
        (child) => child !== this,
      );
    this.parent = null;
  }
  reportValidity() {
    return true;
  }
  querySelector(selector: string): Element | undefined {
    return this.querySelectorAll(selector)[0];
  }
  querySelectorAll(selector: string): Element[] {
    return walk(this).filter((item) =>
      selector.split(",").some((raw) => {
        const value = raw.trim();
        return value === "input:checked"
          ? item.tagName === "INPUT" && item.checked
          : value.startsWith(".")
            ? item.className.split(" ").includes(value.slice(1))
            : value.startsWith("[")
              ? Object.keys(item.dataset).some(
                  (key) =>
                    value ===
                    `[data-${key.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`)}]`,
                )
              : item.tagName.toLowerCase() === value;
      }),
    );
  }
}
const walk = (root: Element): Element[] => [
  root,
  ...root.children.flatMap(walk),
];
const text = (root: Element): string =>
  walk(root)
    .map((item) => item.textContent)
    .join(" ");
const find = (root: Element, label: string) =>
  walk(root).find(
    (item) => item.tagName === "BUTTON" && item.textContent === label,
  )!;
const field = (root: Element, id: string) =>
  walk(root).find((item) => item.id === id)!;
const data = (project = "alpha", revision = "project-old") => ({
  project,
  inbox: [],
  knowledge: {
    revision: "knowledge-old",
    decisions: [],
    areas: [],
    overlaps: [],
  },
  delivery: { mode: "pull-request", branches: { base: "main" }, items: [] },
  budgets: {
    revision,
    limits: { maxDailyRuns: 4 },
    usage: { runsToday: 0, runtimeMinutesToday: 0, activeJobs: 0 },
    cost: { state: "unavailable", reason: "No currency estimate." },
  },
});
async function flush() {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}
function fixture(api: (path: string, body?: unknown) => Promise<unknown>) {
  const elements: Element[] = [];
  const events = new Map<string, () => void>();
  const window = {
    location: new URL("http://127.0.0.1:4311"),
    addEventListener(name: string, callback: () => void) {
      events.set(name, callback);
    },
    renderKnowledgeDocument: (value: string) =>
      Object.assign(new Element("p"), { textContent: value }),
  } as unknown as {
    createProjectOperations: (options: unknown) => {
      mount(root: Element, project: { name: string }, tab: string): void;
      refresh(name: string, force?: boolean): Promise<void>;
      isDirty(): boolean;
    };
    createSetupSuggestions: (options: unknown) => {
      mount(root: Element, project: string, area: string): void;
    };
    createDeliveryWorkflow: (options: unknown) => {
      mount(root: Element, project: unknown): void;
      refresh(name: string): Promise<void>;
      resume(): void;
      isDirty(): boolean;
    };
    createRemoteWorkers: (
      root: Element,
      options: unknown,
    ) => {
      setProjects(projects: { name: string }[]): void;
    };
    [key: string]: unknown;
  };
  const document = {
    hidden: false,
    createElement: (tag: string) => {
      const el = new Element(tag);
      elements.push(el);
      return el;
    },
    getElementById: (id: string) => elements.find((item) => item.id === id),
    addEventListener() {},
    createTextNode: (text: string) =>
      Object.assign(new Element("text"), { textContent: text }),
  };
  const context = {
    window,
    document,
    URL,
    URLSearchParams,
    setTimeout: () => 1,
    clearTimeout() {},
  };
  for (const file of [
    "operations",
    "setup-suggestions",
    "delivery-workflow",
    "remote-workers",
  ])
    runInNewContext(
      readFileSync(
        new URL(`../../dashboard/${file}.js`, import.meta.url),
        "utf8",
      ),
      context,
    );
  const control = window.createProjectOperations({
    api,
    pages: { current: "project", project: "alpha" },
    inbox: null,
    onChanged: async () => {},
    onDiscover() {},
    onCreatePm() {},
    getProject: (name: string) => ({ name, areas: [] }),
    isLocked: () => false,
  });
  return { control, window, events };
}

describe("project operations edit safety", () => {
  it("allows deleting a newly saved decision without reloading the page", async () => {
    const current = {
      ...data(),
      knowledge: {
        ...data().knowledge,
        decisions: [] as { id: string; text: string; createdAt: string }[],
      },
    };
    const api = vi.fn(async (_path: string, body?: unknown) => {
      if (body)
        current.knowledge.decisions.push({
          id: "new-decision",
          text: "Synthetic data only",
          createdAt: "2026-10-05T10:00:00Z",
        });
      return structuredClone(current);
    });
    const { control } = fixture(api),
      root = new Element("section");
    control.mount(root, { name: "alpha" }, "knowledge");
    await flush();
    const input = field(root, "decision-alpha");
    input.value = "Synthetic data only";
    await input.fire("input");
    await root.querySelector("form")!.fire("submit");
    expect(find(root, "Delete decision").disabled).toBe(false);
    await find(root, "Delete decision").fire("click");
    expect(find(root, "Delete this decision").disabled).toBe(false);
  });
  it("deletes a reviewed owner decision with its original revision while preserving an unrelated draft", async () => {
    let current = {
      ...data(),
      knowledge: {
        ...data().knowledge,
        decisions: [
          {
            id: "decision-one",
            text: "Keep checkout simple.",
            createdAt: "2026-10-05T10:00:00Z",
          },
        ],
      },
    };
    const writes: unknown[] = [];
    const api = vi.fn(
      async (_path: string, body?: unknown, method?: string) => {
        if (method === "DELETE") {
          writes.push(body);
          throw new Error("The shared decisions changed.");
        }
        return structuredClone(current);
      },
    );
    const { control } = fixture(api),
      root = new Element("section");
    control.mount(root, { name: "alpha" }, "knowledge");
    await flush();
    field(root, "decision-alpha").value = "Unrelated owner draft";
    await field(root, "decision-alpha").fire("input");
    await find(root, "Delete decision").fire("click");
    expect(writes).toEqual([]);
    current = {
      ...current,
      knowledge: { ...current.knowledge, revision: "newer-knowledge" },
    };
    await control.refresh("alpha", true);
    await find(root, "Delete this decision").fire("click");
    expect(writes).toEqual([{ revision: "knowledge-old" }]);
    expect(text(root)).toContain("The shared decisions changed");
    expect(field(root, "decision-alpha").value).toBe("Unrelated owner draft");
  });
  it("keeps the original revision and dirty limits while background data changes", async () => {
    let current = data();
    const writes: unknown[] = [];
    const api = vi.fn(async (path: string, body?: unknown) => {
      if (body) {
        writes.push(body);
        throw new Error("Configuration changed; reload before saving.");
      }
      return structuredClone(current);
    });
    const { control } = fixture(api),
      root = new Element("section");
    control.mount(root, { name: "alpha" }, "limits");
    await flush();
    const input = field(root, "limit-alpha-maxDailyRuns");
    expect(input.value).toBe(4);
    input.value = "7";
    await input.fire("input");
    current = data("alpha", "project-new");
    current.budgets.limits.maxDailyRuns = 9;
    await control.refresh("alpha", true);
    expect(input.value).toBe("7");
    await root.querySelector("form")!.fire("submit");
    expect(writes).toEqual([
      { limits: { maxDailyRuns: 7 }, revision: "project-old" },
    ]);
    expect(input.value).toBe("7");
    expect(text(root)).toContain("Your edits are kept");
    expect(control.isDirty()).toBe(true);
    await find(root, "Reset edits").fire("click");
    expect(input.value).toBe(9);
    expect(control.isDirty()).toBe(false);
  });
  it("keeps project decision drafts and controls in place on refresh and project switching", async () => {
    const api = vi.fn(async (path: string, body?: unknown) => {
      if (body) throw new Error("Conflict");
      return data(path.includes("beta") ? "beta" : "alpha");
    });
    const { control } = fixture(api),
      root = new Element("section"),
      other = new Element("section");
    control.mount(root, { name: "alpha" }, "knowledge");
    await flush();
    const input = field(root, "decision-alpha");
    input.value = "Owner decision draft";
    await input.fire("input");
    await control.refresh("alpha", true);
    expect(field(root, "decision-alpha")).toBe(input);
    expect(input.value).toBe("Owner decision draft");
    control.mount(other, { name: "beta" }, "knowledge");
    await flush();
    expect(field(other, "decision-beta").value).toBe("");
    expect(input.value).toBe("Owner decision draft");
    await root.querySelector("form")!.fire("submit");
    expect(text(root)).toContain("Your decision draft is kept");
    expect(input.value).toBe("Owner decision draft");
  });
  it("coalesces pending reads and follows an explicit refresh with a fresh request", async () => {
    let resolve!: (value: unknown) => void;
    let calls = 0;
    const api = vi.fn(async () => {
      calls++;
      return calls === 1
        ? new Promise((done) => {
            resolve = done;
          })
        : data();
    });
    const { control } = fixture(api),
      root = new Element("section");
    control.mount(root, { name: "alpha" }, "limits");
    const background = control.refresh("alpha"),
      afterSave = control.refresh("alpha", true);
    expect(calls).toBe(1);
    resolve(data());
    await Promise.all([background, afterSave]);
    expect(calls).toBe(2);
  });
});

describe("explicit review controls", () => {
  it("approves only after confirmation with the exact reviewed proposal revision", async () => {
    const writes: unknown[] = [];
    let approved = false;
    const api = vi.fn(async (path: string, body?: unknown) => {
      if (path.endsWith("/approve")) {
        writes.push({ path, body });
        approved = true;
        return { message: "Approved for coding." };
      }
      if (path.endsWith("/review"))
        return {
          items: approved
            ? []
            : [
                {
                  id: "ticket-one",
                  identifier: "APP-1",
                  title: "Fix checkout",
                  description: "Evidence",
                  revision: "reviewed-sha",
                  canApprove: true,
                },
              ],
        };
      return data();
    });
    const { control } = fixture(api),
      root = new Element("section");
    control.mount(root, { name: "alpha" }, "review");
    await flush();
    expect(writes).toEqual([]);
    await find(root, "Approve coding").fire("click");
    expect(writes).toEqual([]);
    await find(root, "Approve APP-1").fire("click");
    expect(writes).toEqual([
      {
        path: "/api/projects/alpha/review/ticket-one/approve",
        body: { revision: "reviewed-sha" },
      },
    ]);
    expect(text(root)).toContain("Approved for coding");
  });
  it("requires a reviewed setup choice and forwards all three revision guards", async () => {
    const writes: unknown[] = [];
    const api = vi.fn(async (_path: string, body?: unknown) => {
      if (body) {
        writes.push(body);
        return { ok: true };
      }
      return {
        state: "ready",
        revision: "project-revision",
        areaRevision: "area-revision",
        knowledgeRevision: "knowledge-revision",
        proposal: {
          commands: { install: "npm ci", test: "npm test" },
          paths: ["src/"],
          sharedTouchpoints: [],
          rationale: "From package scripts",
          evidence: ["package.json"],
        },
      };
    });
    const { window } = fixture(api),
      root = new Element("section");
    const setup = window.createSetupSuggestions({
      api,
      onSaved: async () => {},
      isLocked: () => false,
    });
    setup.mount(root, "alpha", "core");
    await flush();
    expect(writes).toEqual([]);
    await find(root, "Use these commands").fire("click");
    expect(writes).toEqual([]);
    await find(root, "Apply reviewed settings").fire("click");
    expect(writes).toEqual([
      {
        revision: "project-revision",
        areaRevision: "area-revision",
        knowledgeRevision: "knowledge-revision",
        apply: "commands",
      },
    ]);
    expect(text(root)).toContain("PM remains paused");
  });
});

describe("remote and delivery controls", () => {
  it("renders nested production audit outcomes without treating an unmerged or unapplied ticket as Done", async () => {
    const api = vi.fn(async () => ({
      enabled: false,
      productionReports: [
        {
          id: "scope-one",
          report: {
            checkedAt: "2026-10-05T06:00:00Z",
            tickets: [
              {
                identifier: "APP-1",
                classification: "not-production",
                reason: "Production PR is still open.",
                currentState: "In progress",
                applied: false,
                evidence: [],
              },
              {
                identifier: "APP-2",
                classification: "production-confirmed",
                reason: "All deliverables are present.",
                currentState: "In review",
                applied: false,
                evidence: [
                  {
                    productionPr: 18,
                    productionUrl: "https://github.com/owner/alpha/pull/18",
                  },
                ],
              },
              {
                identifier: "APP-3",
                classification: "production-confirmed",
                reason: "Transition saved.",
                currentState: "In review",
                applied: true,
                evidence: [
                  { productionPr: 19, productionUrl: "javascript:alert(1)" },
                ],
              },
            ],
          },
        },
      ],
    }));
    const { window } = fixture(api),
      root = new Element("section");
    const helper = window.createDeliveryWorkflow({
      api,
      pages: { current: "project", project: "alpha", tab: "delivery" },
      isLocked: () => false,
    });
    helper.mount(root, { name: "alpha", areas: [] });
    await flush();
    expect(text(root)).toContain("APP-1 · Awaiting production");
    expect(text(root)).toContain("APP-2 · Production merge verified");
    expect(text(root)).toContain("APP-3 · Linear marked Done");
    expect(text(root)).not.toContain("APP-2 · Linear marked Done");
    expect(text(root)).toContain("Production PR is still open.");
    expect(
      root
        .querySelector(".production-audit")!
        .querySelectorAll("a")
        .map((link) => link.href),
    ).toEqual(["https://github.com/owner/alpha/pull/18"]);
  });
  it("loads a directly opened Delivery page after authentication unlocks", async () => {
    let locked = true;
    const api = vi.fn(async () => ({
      enabled: false,
      message: "Repository-only project.",
    }));
    const { window } = fixture(api),
      root = new Element("section");
    const helper = window.createDeliveryWorkflow({
      api,
      pages: { current: "project", project: "alpha", tab: "delivery" },
      isLocked: () => locked,
    });
    helper.mount(root, { name: "alpha", areas: [] });
    expect(api).not.toHaveBeenCalled();
    locked = false;
    helper.resume();
    await flush();
    expect(api).toHaveBeenCalledOnce();
    expect(text(root)).toContain("Repository-only project");
    expect(root.querySelector(".delivery-controller-actions")!.hidden).toBe(
      true,
    );
  });
  it("exports only safe unsigned candidate coordinates without rebuilding unchanged handoffs", async () => {
    const api = vi.fn(async () => ({
      enabled: false,
      candidates: [
        {
          project: "alpha",
          repo: "owner/alpha",
          area: "core",
          branch: "candidate",
          candidateSha: "a".repeat(40),
          changes: [12],
          token: "must-not-render",
          filesystem: "/private/location",
        },
      ],
    }));
    const { window } = fixture(api),
      root = new Element("section");
    const helper = window.createDeliveryWorkflow({
      api,
      pages: { current: "project", project: "alpha", tab: "delivery" },
      isLocked: () => false,
    });
    helper.mount(root, { name: "alpha", areas: [] });
    await flush();
    const input = root
      .querySelector(".candidate-handoffs")!
      .querySelector("textarea")!;
    const coordinates = JSON.parse(input.value);
    expect(coordinates).toMatchObject({
      project: "alpha",
      candidateSha: "a".repeat(40),
      changes: [12],
    });
    expect(coordinates).not.toHaveProperty("token");
    expect(coordinates).not.toHaveProperty("filesystem");
    expect(text(root)).toContain("Unsigned preparation only");
    await helper.refresh("alpha");
    expect(
      root.querySelector(".candidate-handoffs")!.querySelector("textarea"),
    ).toBe(input);
  });
  it("does not reveal a one-time enrollment that finishes after leaving Workers", async () => {
    let finish!: (value: unknown) => void;
    const writes: unknown[] = [];
    const api = vi.fn(async (path: string, body?: unknown) => {
      if (path === "/api/remote/enrollments") {
        writes.push(body);
        return new Promise((resolve) => {
          finish = resolve;
        });
      }
      return { workers: [] };
    });
    const { window, events } = fixture(api),
      root = new Element("section"),
      pages = { current: "runners" };
    const remote = window.createRemoteWorkers(root, {
      api,
      pages,
      isLocked: () => false,
    });
    remote.setProjects([{ name: "alpha" }, { name: "beta" }]);
    field(root, "remote-worker-name").value = "QA worker";
    field(root, "remote-controller-url").value = "http://192.168.1.20:4311";
    field(root, "remote-private-lan").checked = true;
    const project = root
      .querySelector(".remote-project-options")!
      .querySelector("input")!;
    project.checked = true;
    const submission = root.querySelector("form")!.fire("submit");
    expect(writes).toEqual([{ name: "QA worker", projects: ["alpha"] }]);
    pages.current = "overview";
    events.get("dashboard:pagechange")?.();
    finish({ code: "f".repeat(64), expiresAt: new Date().toISOString() });
    await submission;
    expect(root.querySelector("textarea")).toBeUndefined();
    expect(root.querySelector(".remote-enrollment-result")!.hidden).toBe(true);
  });
  it("rejects public HTTP and clears a shown enrollment command on Done", async () => {
    const api = vi.fn(async (path: string) =>
      path === "/api/remote/enrollments"
        ? { code: "f".repeat(64) }
        : { workers: [] },
    );
    const { window } = fixture(api),
      root = new Element("section");
    const remote = window.createRemoteWorkers(root, {
      api,
      pages: { current: "runners" },
      isLocked: () => false,
    });
    remote.setProjects([{ name: "alpha" }]);
    field(root, "remote-worker-name").value = "QA worker";
    field(root, "remote-controller-url").value = "http://203.0.113.1:4311";
    field(root, "remote-private-lan").checked = true;
    root
      .querySelector(".remote-project-options")!
      .querySelector("input")!.checked = true;
    await root.querySelector("form")!.fire("submit");
    expect(
      api.mock.calls.filter(([path]) => path.endsWith("enrollments")),
    ).toHaveLength(0);
    expect(text(root)).toContain("Use HTTPS for a public host");
    field(root, "remote-controller-url").value =
      "https://gremlins.example.test";
    await root.querySelector("form")!.fire("submit");
    expect(root.querySelector("textarea")!.value).toContain(
      "--enrollment-code " + "f".repeat(64),
    );
    await find(root, "Done — hide command").fire("click");
    expect(root.querySelector("textarea")).toBeUndefined();
  });
  it("pins production scope to its reviewed revision and resets after success", async () => {
    const initial = {
      enabled: true,
      revision: "delivery-one",
      deliveries: [
        {
          id: "one",
          status: "promoted",
          ticket: { identifier: "APP-1", title: "Checkout" },
          review: {},
          promotion: {},
        },
      ],
      declarations: [],
      operation: { phase: "idle", message: "" },
    };
    let latest = structuredClone(initial);
    let fail = true;
    const writes: unknown[] = [];
    const api = vi.fn(async (path: string, body?: unknown) => {
      if (path.endsWith("/states"))
        return { states: [{ id: "done", name: "Done" }] };
      if (body) {
        writes.push(body);
        if (fail) throw new Error("Delivery scope changed");
        return {
          ...latest,
          revision: "delivery-three",
          declarations: [
            {
              deliveryIds: ["one"],
              createdAt: new Date().toISOString(),
              manifest: { tickets: [] },
            },
          ],
        };
      }
      return structuredClone(latest);
    });
    const { window } = fixture(api),
      root = new Element("section");
    const helper = window.createDeliveryWorkflow({
      api,
      pages: { current: "project", project: "alpha", tab: "delivery" },
      isLocked: () => false,
    });
    helper.mount(root, {
      name: "alpha",
      provider: "github",
      repo: "owner/alpha",
      areas: [{ key: "core", name: "Core" }],
    });
    await flush();
    root
      .querySelector(".production-scope-options")!
      .querySelector("input")!.checked = true;
    field(root, "production-pr-alpha").value = "18";
    field(root, "production-state-alpha").value = "done";
    root
      .querySelector(".production-scope-confirm")!
      .querySelector("input")!.checked = true;
    latest = { ...initial, revision: "delivery-two" };
    await helper.refresh("alpha");
    await root.querySelector("form")!.fire("submit");
    expect(writes[0]).toEqual({
      revision: "delivery-one",
      deliveryIds: ["one"],
      productionPr: 18,
      completedStateId: "done",
      scopeComplete: true,
    });
    expect(helper.isDirty()).toBe(true);
    expect(field(root, "production-pr-alpha").value).toBe("18");
    expect(text(root)).toContain("Your selected scope is kept");
    await find(root, "Reset scope").fire("click");
    root
      .querySelector(".production-scope-options")!
      .querySelector("input")!.checked = true;
    field(root, "production-pr-alpha").value = "19";
    field(root, "production-state-alpha").value = "done";
    fail = false;
    await root.querySelector("form")!.fire("submit");
    expect(writes[1]).toMatchObject({
      revision: "delivery-two",
      productionPr: 19,
    });
    expect(helper.isDirty()).toBe(false);
    expect(
      root.querySelector(".production-scope-options")!.querySelector("input"),
    ).toBeUndefined();
    expect(text(root)).toContain(
      "Done waits for the verified production merge",
    );
  });
  it("keeps an edited candidate selection on background refresh and guards its config revision", async () => {
    let candidate = {
      revision: "config-one",
      selected: "",
      needsSelection: true,
      environments: [
        { name: "candidate", provider: "railway", role: "preview" },
      ],
    };
    const writes: unknown[] = [];
    const api = vi.fn(async (path: string, body?: unknown) => {
      if (body) {
        writes.push(body);
        throw new Error("Config changed");
      }
      if (path.endsWith("/states")) return { states: [] };
      return {
        enabled: true,
        revision: "delivery",
        deliveries: [],
        candidateSetup: structuredClone(candidate),
      };
    });
    const { window } = fixture(api),
      root = new Element("section");
    const helper = window.createDeliveryWorkflow({
      api,
      pages: { current: "project", project: "alpha", tab: "delivery" },
      isLocked: () => false,
    });
    helper.mount(root, { name: "alpha", repo: "owner/alpha", areas: [] });
    await flush();
    field(root, "delivery-candidate-alpha").value = "candidate";
    await field(root, "delivery-candidate-alpha").fire("change");
    candidate = { ...candidate, revision: "config-two" };
    await helper.refresh("alpha");
    await find(root, "Save candidate environment").fire("click");
    expect(writes).toEqual([
      { revision: "config-one", environment: "candidate" },
    ]);
    expect(field(root, "delivery-candidate-alpha").value).toBe("candidate");
    expect(text(root)).toContain("Your selection is kept");
  });
});
