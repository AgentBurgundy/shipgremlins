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
  click() {
    return this.fire("click");
  }
  showModal() {
    this.open = true;
  }
  close() {
    this.open = false;
    void this.fire("close");
  }
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
    body: new Element("body"),
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
  return { control, window, events, document };
}

describe("project operations edit safety", () => {
  it("keeps ordinary PR delivery focused and does not load promotion controls", async () => {
    const api = vi.fn(async () => data());
    const { control } = fixture(api),
      root = new Element("section");
    control.mount(root, { name: "alpha" }, "delivery");
    await flush();
    expect(root.querySelector(".delivery-navigation")!.hidden).toBe(true);
    expect(field(root, "delivery-controls-alpha").hidden).toBe(true);
    expect(field(root, "delivery-work-alpha").hidden).toBe(false);
    expect(text(root)).toContain("From ticket to pull request");
    expect(api.mock.calls).toHaveLength(1);
  });
  it("keeps promotion tabs and drafts stable while delivery data refreshes and mode changes", async () => {
    let current = {
      ...data(),
      delivery: { ...data().delivery, mode: "promotion" },
    };
    const api = vi.fn(async (path: string) => {
      if (path.endsWith("/operations")) return structuredClone(current);
      if (path.endsWith("/states")) return { states: [] };
      return { enabled: true, revision: "delivery-one", deliveries: [] };
    });
    const { control } = fixture(api),
      root = new Element("section");
    control.mount(root, { name: "alpha" }, "delivery");
    await flush();
    const nav = root.querySelector(".delivery-navigation")!;
    const summary = field(root, "delivery-work-alpha");
    const controls = field(root, "delivery-controls-alpha");
    expect(nav.hidden).toBe(false);
    expect(summary.hidden).toBe(false);
    expect(controls.hidden).toBe(true);
    await find(nav, "Promotion controls").fire("click");
    const input = field(controls, "production-pr-alpha");
    input.value = "42";
    expect(summary.hidden).toBe(true);
    expect(controls.hidden).toBe(false);
    expect(find(nav, "Promotion controls").attributes.get("aria-current")).toBe(
      "page",
    );
    current.budgets.revision = "project-new";
    await control.refresh("alpha", true);
    expect(field(controls, "production-pr-alpha")).toBe(input);
    expect(input.value).toBe("42");
    expect(controls.hidden).toBe(false);
    await find(nav, "Work & evidence").fire("click");
    await find(nav, "Promotion controls").fire("click");
    expect(input.value).toBe("42");
    current = {
      ...current,
      delivery: { ...current.delivery, mode: "pull-request" },
    };
    await control.refresh("alpha", true);
    expect(nav.hidden).toBe(true);
    expect(controls.hidden).toBe(true);
    expect(summary.hidden).toBe(false);
    current = {
      ...current,
      delivery: { ...current.delivery, mode: "promotion" },
    };
    await control.refresh("alpha", true);
    expect(nav.hidden).toBe(false);
    expect(summary.hidden).toBe(false);
    await find(nav, "Promotion controls").fire("click");
    expect(field(controls, "production-pr-alpha")).toBe(input);
    expect(input.value).toBe("42");
  });
  it("turns knowledge Markdown into a readable text excerpt and links to the full discovery", async () => {
    const current = {
      ...data(),
      knowledge: {
        ...data().knowledge,
        areas: [
          {
            key: "core",
            name: "Core",
            state: "ready",
            summary:
              "# User journey\n\n- **People** can `start` safely using [guided setup](https://example.test).\n> _Keep context_ and ~~retired language~~.",
          },
        ],
      },
    };
    const { control } = fixture(async () => current),
      root = new Element("section");
    control.mount(root, { name: "alpha" }, "knowledge");
    await flush();
    const card = root.querySelector(".shared-knowledge-card")!;
    expect(card.querySelector("p")!.textContent).toBe(
      "User journey People can start safely using guided setup. Keep context and retired language.",
    );
    expect(card.querySelector("a")!.href).toBe(
      "/projects/alpha?pm=core&tab=discovery",
    );
    expect(card.querySelectorAll("script, img, strong, code")).toHaveLength(0);
  });
  it("keeps long knowledge cards bounded at a word boundary and treats embedded markup as text", async () => {
    const summary =
      "<img src=x onerror=alert(1)>\n" +
      "Thoughtful workflows reduce manual work. ".repeat(30);
    const current = {
      ...data(),
      knowledge: {
        ...data().knowledge,
        areas: [{ key: "core", state: "ready", summary }],
      },
    };
    const { control } = fixture(async () => current),
      root = new Element("section");
    control.mount(root, { name: "alpha" }, "knowledge");
    await flush();
    const card = root.querySelector(".shared-knowledge-card")!,
      excerpt = card.querySelector("p")!.textContent;
    expect(excerpt.length).toBeLessThanOrEqual(220);
    expect(excerpt).toMatch(/(?:Thoughtful|workflows|reduce|manual|work\.)…$/);
    expect(card.querySelectorAll("img, script")).toHaveLength(0);
    expect(current.knowledge.areas[0]!.summary).toBe(summary);
    expect(card.querySelector("a")!.textContent).toBe("Open discovery →");
  });
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
  it("keeps the selected proposal and its evidence visible during confirmation, cancellation, and refresh", async () => {
    const items = [
      {
        id: "first",
        identifier: "APP-1",
        title: "First proposal",
        description: "First proposal evidence",
        revision: "first-revision",
        canApprove: true,
      },
      {
        id: "second",
        identifier: "APP-2",
        title: "Second proposal",
        description: "Second proposal evidence\nExact scope stays readable",
        revision: "second-revision",
        canApprove: true,
      },
    ];
    const api = vi.fn(async (path: string) =>
      path.endsWith("/review") ? { items } : data(),
    );
    const { control } = fixture(api),
      root = new Element("section");
    control.mount(root, { name: "alpha" }, "review");
    await flush();
    expect(root.querySelectorAll(".proposal-card")).toHaveLength(2);
    const second = root.querySelectorAll(".proposal-card")[1]!;
    await find(second, "Read & review").fire("click");
    const expectSelection = () => {
      expect(root.querySelectorAll(".proposal-card")).toHaveLength(1);
      expect(text(root)).not.toContain("First proposal");
      expect(text(root.querySelector(".proposal-reading")!)).toContain(
        "Exact scope stays readable",
      );
      expect(root.querySelector(".proposal-reading")!.tagName).toBe("SECTION");
    };
    expectSelection();
    await find(root, "Approve coding").fire("click");
    expectSelection();
    expect(find(root, "Approve APP-2")).toBeDefined();
    await find(root, "Keep in review").fire("click");
    expectSelection();
    await find(root, "Refresh proposals").fire("click");
    expectSelection();
    await find(root, "← All proposals").fire("click");
    expect(root.querySelectorAll(".proposal-card")).toHaveLength(2);
    expect(find(root, "Approve coding")).toBeUndefined();
    expect(api.mock.calls.every(([path]) => !path.endsWith("/approve"))).toBe(
      true,
    );
  });

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
    expect(find(root, "Approve coding")).toBeUndefined();
    await find(root, "Read & review").fire("click");
    await find(root, "Approve coding").fire("click");
    expect(writes).toEqual([]);
    expect(text(root)).toContain("Evidence");
    expect(root.querySelector(".proposal-reading")?.tagName).toBe("SECTION");
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
    expect(text(root)).toContain("Existing automation settings were preserved");
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
    const dialog = root.querySelector(".delivery-detail-dialog")!;
    expect(dialog.open).toBe(false);
    const trigger = find(root, "View candidate coordinates");
    await trigger.fire("click");
    expect(dialog.open).toBe(true);
    const input = dialog.querySelector("textarea")!;
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
    expect(dialog.querySelector("textarea")).toBe(input);
    expect(find(root, "View candidate coordinates")).toBe(trigger);
    await dialog.fire("cancel");
    expect(dialog.open).toBe(false);
  });
  it("preserves opened candidate coordinates during refresh and closes the handoff when leaving Delivery", async () => {
    let sha = "a".repeat(40);
    const api = vi.fn(async () => ({
      enabled: false,
      candidates: [{ project: "alpha", area: "core", candidateSha: sha }],
    }));
    const { window, events } = fixture(api),
      root = new Element("section"),
      pages = { current: "project", project: "alpha", tab: "delivery" };
    const helper = window.createDeliveryWorkflow({
      api,
      pages,
      isLocked: () => false,
    });
    helper.mount(root, { name: "alpha", areas: [] });
    await flush();
    await find(root, "View candidate coordinates").fire("click");
    const dialog = root.querySelector(".delivery-detail-dialog")!;
    const content = dialog.querySelector("textarea")!;
    sha = "b".repeat(40);
    await helper.refresh("alpha");
    expect(JSON.parse(content.value).candidateSha).toBe("a".repeat(40));
    expect(text(dialog)).toContain("Candidate information changed");
    const currentTrigger = find(root, "View candidate coordinates");
    const restoreFocus = vi.spyOn(currentTrigger, "focus");
    await dialog.fire("cancel");
    expect(restoreFocus).toHaveBeenCalledOnce();
    await currentTrigger.fire("click");
    expect(JSON.parse(content.value).candidateSha).toBe(sha);
    pages.current = "overview";
    events.get("dashboard:pagechange")?.();
    expect(dialog.open).toBe(false);
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
    const { window, events, document } = fixture(api),
      root = new Element("section"),
      pages = { current: "runners" };
    const remote = window.createRemoteWorkers(root, {
      api,
      pages,
      isLocked: () => false,
    });
    remote.setProjects([{ name: "alpha" }, { name: "beta" }]);
    await find(root, "Connect a runner").fire("click");
    const dialog = document.body.querySelector(".remote-enrollment-dialog")!;
    field(dialog, "remote-worker-name").value = "QA worker";
    field(dialog, "remote-controller-url").value = "http://192.168.1.20:4311";
    field(dialog, "remote-private-lan").checked = true;
    await find(dialog, "Continue").fire("click");
    const project = dialog
      .querySelector(".remote-project-options")!
      .querySelector("input")!;
    project.checked = true;
    const submission = dialog.querySelector("form")!.fire("submit");
    expect(writes).toEqual([{ name: "QA worker", projects: ["alpha"] }]);
    pages.current = "overview";
    events.get("dashboard:pagechange")?.();
    finish({ code: "f".repeat(64), expiresAt: new Date().toISOString() });
    await submission;
    expect(dialog.querySelector("textarea")).toBeUndefined();
    expect(dialog.querySelector(".remote-enrollment-result")!.hidden).toBe(
      true,
    );
    expect(dialog.open).toBe(false);
  });
  it("rejects public HTTP and clears a shown enrollment command on Done", async () => {
    const api = vi.fn(async (path: string) =>
      path === "/api/remote/enrollments"
        ? { code: "f".repeat(64) }
        : { workers: [] },
    );
    const { window, document } = fixture(api),
      root = new Element("section");
    const remote = window.createRemoteWorkers(root, {
      api,
      pages: { current: "runners" },
      isLocked: () => false,
    });
    remote.setProjects([{ name: "alpha" }]);
    await find(root, "Connect a runner").fire("click");
    const dialog = document.body.querySelector(".remote-enrollment-dialog")!;
    field(dialog, "remote-worker-name").value = "QA worker";
    field(dialog, "remote-controller-url").value = "http://203.0.113.1:4311";
    field(dialog, "remote-private-lan").checked = true;
    dialog
      .querySelector(".remote-project-options")!
      .querySelector("input")!.checked = true;
    await find(dialog, "Continue").fire("click");
    expect(
      api.mock.calls.filter(([path]) => path.endsWith("enrollments")),
    ).toHaveLength(0);
    expect(text(dialog)).toContain("Use HTTPS for a public host");
    field(dialog, "remote-controller-url").value =
      "https://gremlins.example.test";
    await find(dialog, "Continue").fire("click");
    await dialog.querySelector("form")!.fire("submit");
    expect(dialog.querySelector("textarea")!.value).toContain(
      "--enrollment-code " + "f".repeat(64),
    );
    await find(dialog, "Done").fire("click");
    expect(dialog.querySelector("textarea")).toBeUndefined();
    expect(dialog.open).toBe(false);
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
    const editor = root.querySelector(".production-tracking-editor")!;
    expect(editor.hidden).toBe(true);
    await find(root, "Track a production release").fire("click");
    expect(editor.hidden).toBe(false);
    expect(root.querySelector(".delivery-controller-actions")!.hidden).toBe(
      true,
    );
    root
      .querySelector(".production-scope-options")!
      .querySelector("input")!.checked = true;
    field(root, "production-pr-alpha").value = "18";
    field(root, "production-state-alpha").value = "done";
    root
      .querySelector(".production-scope-confirm")!
      .querySelector("input")!.checked = true;
    await find(root, "← Promotion controls").fire("click");
    expect(editor.hidden).toBe(true);
    await find(root, "Track a production release").fire("click");
    expect(field(root, "production-pr-alpha").value).toBe("18");
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
