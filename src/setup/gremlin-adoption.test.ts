import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

type UiEvent = {
  type: string;
  target?: Element;
  bubbles?: boolean;
  preventDefault(): void;
};
class Element {
  children: Element[] = [];
  parentElement: Element | null = null;
  listeners = new Map<string, ((event: UiEvent) => unknown)[]>();
  attributes = new Map<string, string>();
  dataset: Record<string, string> = {};
  id = "";
  className = "";
  textContent = "";
  value = "";
  hidden = false;
  disabled = false;
  checked = false;
  invalid = false;
  open = true;
  constructor(
    public tagName: string,
    private focusElement: (node: Element) => void,
  ) {}
  append(...nodes: Element[]) {
    for (const node of nodes) {
      node.remove();
      node.parentElement = this;
      this.children.push(node);
    }
  }
  prepend(node: Element) {
    node.remove();
    node.parentElement = this;
    this.children.unshift(node);
  }
  before(node: Element) {
    const parent = this.parentElement!;
    node.remove();
    node.parentElement = parent;
    parent.children.splice(parent.children.indexOf(this), 0, node);
  }
  after(node: Element) {
    const parent = this.parentElement!;
    node.remove();
    node.parentElement = parent;
    parent.children.splice(parent.children.indexOf(this) + 1, 0, node);
  }
  remove() {
    if (this.parentElement)
      this.parentElement.children = this.parentElement.children.filter(
        (node) => node !== this,
      );
    this.parentElement = null;
  }
  replaceChildren(...nodes: Element[]) {
    for (const child of [...this.children]) child.remove();
    this.append(...nodes);
  }
  all(): Element[] {
    return [this, ...this.children.flatMap((node) => node.all())];
  }
  contains(node: Element) {
    return this.all().includes(node);
  }
  matches(selector: string) {
    if (selector.startsWith(":invalid")) return this.invalid;
    if (selector.startsWith("."))
      return this.className.split(/\s+/).includes(selector.slice(1));
    return this.tagName === selector.toUpperCase();
  }
  querySelectorAll(selector: string) {
    return this.all()
      .slice(1)
      .filter((node) =>
        selector.split(",").some((piece) => node.matches(piece.trim())),
      );
  }
  querySelector(selector: string) {
    return this.querySelectorAll(selector)[0] || null;
  }
  closest(selector: string): Element | null {
    return this.matches(selector)
      ? this
      : this.parentElement?.closest(selector) || null;
  }
  setAttribute(key: string, value: string) {
    this.attributes.set(key, value);
  }
  getAttribute(key: string) {
    return this.attributes.get(key);
  }
  addEventListener(name: string, callback: (event: UiEvent) => unknown) {
    this.listeners.set(name, [...(this.listeners.get(name) || []), callback]);
  }
  async dispatchEvent(event: UiEvent) {
    event.target ||= this;
    await Promise.all(
      (this.listeners.get(event.type) || []).map((fn) => fn(event)),
    );
    if (event.bubbles) await this.parentElement?.dispatchEvent(event);
  }
  click() {
    return this.dispatchEvent({ type: "click", preventDefault() {} });
  }
  focus() {
    this.focusElement(this);
  }
  reportValidity() {
    const invalid =
      this.tagName === "FORM"
        ? this.all().filter((node) => node.invalid && !node.disabled)
        : this.invalid && !this.disabled
          ? [this]
          : [];
    for (const target of invalid)
      void target
        .closest("form")
        ?.dispatchEvent({ type: "invalid", target, preventDefault() {} });
    return invalid.length === 0;
  }
}
const script = readFileSync(
  new URL("../../dashboard/gremlin-adoption.js", import.meta.url),
  "utf8",
);
const app = readFileSync(
  new URL("../../dashboard/app.js", import.meta.url),
  "utf8",
);
type Adopted = {
  project: string;
  name: string;
  key: string;
  mandate: string;
  charter?: { goal: string };
};
type Adoption = {
  open(options?: { preselected?: boolean }): void;
  review(): void;
  contextChanged(): void;
  refresh(): void;
  prepareSubmit(): boolean;
  setBusy(value: boolean): void;
  adopted(value: Adopted): void;
  setWelcomeWarning(value: string): void;
  accepted: Adopted | null;
};
function fixture() {
  let focused: Element | null = null;
  const node = (tag: string, id = "", className = "") =>
    Object.assign(
      new Element(tag.toUpperCase(), (value) => {
        focused = value;
      }),
      { id, className },
    );
  const dialog = node("dialog"),
    add = (parent: Element, tag: string, id = "", className = "") => {
      const child = node(tag, id, className);
      parent.append(child);
      return child;
    };
  add(dialog, "h2", "pm-create-title");
  add(dialog, "p", "pm-adoption-subtitle");
  const form = add(dialog, "form", "pm-create-form"),
    fields = add(form, "fieldset", "pm-create-fields");
  const field = (parent: Element, tag: string, id: string, value = "") => {
    const wrap = add(parent, "div", "", "field");
    add(wrap, "label");
    const input = add(wrap, tag, id);
    input.value = value;
    return input;
  };
  field(fields, "select", "pm-project", "shop");
  field(fields, "textarea", "pm-mandate");
  field(fields, "input", "pm-name");
  field(fields, "input", "pm-key");
  field(fields, "select", "pm-linear-project");
  const ai = add(fields, "div", "pm-ai-draft");
  add(ai, "section", "", "pm-ai-draft-preview").hidden = true;
  add(fields, "p", "pm-creation-readiness");
  add(
    add(fields, "section", "", "pm-charter-create"),
    "div",
    "pm-charter-fields",
  );
  const advanced = add(fields, "section", "pm-advanced");
  field(advanced, "input", "pm-schedule", "0 13 * * 1-5");
  const discovery = add(fields, "label");
  add(discovery, "input", "pm-discover-after-create");
  const footer = add(fields, "div", "", "form-bottom");
  add(footer, "p");
  add(footer, "button", "create-pm");
  const get = (id: string) => dialog.all().find((value) => value.id === id)!;
  get("pm-name").addEventListener("input", () => {
    get("pm-key").value = get("pm-name")
      .value.toLowerCase()
      .replaceAll(" ", "-");
  });
  let locked = false;
  const project = {
    name: "shop",
    areas: [] as { key: string }[],
    readiness: {
      areas: [] as { key: string; discovery: { canRun: boolean } }[],
    },
    foundation: { needed: false },
  };
  const window = {} as {
    createGremlinAdoption(options: object): Adoption;
    gremlinIdentity(input: object): { image: string; description: string };
  };
  runInNewContext(script, {
    window,
    document: {
      createElement: (tag: string) => node(tag),
      getElementById: get,
    },
    Event: class {
      constructor(
        public type: string,
        public options: { bubbles: boolean },
      ) {}
      get bubbles() {
        return this.options.bubbles;
      }
    },
  });
  const draft = vi.fn(),
    firstTask = vi.fn(),
    openHome = vi.fn(),
    refresh = vi.fn();
  const input = () => ({
    project: get("pm-project").value,
    name: get("pm-name").value,
    key: get("pm-key").value,
    mandate: get("pm-mandate").value,
    charter: {},
  });
  const helper = window.createGremlinAdoption({
    dialog,
    getInput: input,
    getProject: () => project,
    onDraft: draft,
    onFirstTask: firstTask,
    onOpenHome: openHome,
    onRefreshReadiness: refresh,
    isLocked: () => locked,
  });
  const button = (text: string) =>
    dialog
      .all()
      .find(
        (value) => value.tagName === "BUTTON" && value.textContent === text,
      )!;
  const stage = () =>
    dialog
      .all()
      .filter((value) => value.dataset.adoptionStage && !value.hidden)
      .map((value) => value.dataset.adoptionStage);
  return {
    helper,
    get,
    button,
    stage,
    input,
    dialog,
    form,
    fields,
    project,
    draft,
    firstTask,
    openHome,
    refresh,
    focused: () => focused,
    lock: (value: boolean) => {
      locked = value;
      helper.refresh();
    },
    identity: window.gremlinIdentity,
  };
}
const adopted = {
  project: "shop",
  key: "moss",
  name: "Moss",
  mandate: "Help customers find their orders.",
};

describe("gremlin adoption", () => {
  it("shows one question at a time and keeps project choice reachable", async () => {
    const f = fixture();
    const original = f.get("pm-mandate");
    f.helper.open();
    expect(f.stage()).toEqual(["project"]);
    expect(f.helper.prepareSubmit()).toBe(false);
    expect(f.stage()).toEqual(["mission"]);
    expect(f.button("Back").hidden).toBe(false);
    await f.button("Back").click();
    expect(f.stage()).toEqual(["project"]);
    f.helper.open({ preselected: true });
    expect(f.stage()).toEqual(["mission"]);
    expect(f.button("Back").hidden).toBe(true);
    expect(f.get("pm-mandate")).toBe(original);
  });

  it("does not overwrite a custom mission when choosing a specialty", async () => {
    const f = fixture();
    f.helper.open({ preselected: true });
    await f.button("Security & trust").click();
    expect(f.get("pm-mandate").value).toContain("security, privacy");
    f.get("pm-mandate").value = "Protect only the billing permissions.";
    await f.button("Smooth customer journeys").click();
    expect(f.get("pm-mandate").value).toBe(
      "Protect only the billing permissions.",
    );
    expect(f.firstTask).not.toHaveBeenCalled();
  });

  it("drafts through the existing AI action, preserves errors, and allows a manual brief", async () => {
    const f = fixture();
    f.helper.open({ preselected: true });
    f.get("pm-mandate").value = "Find confusing order flows.";
    await f.button("Meet my gremlin").click();
    expect(f.draft).toHaveBeenCalledTimes(1);
    expect(f.stage()).toEqual(["mission"]);
    expect(f.get("pm-mandate").value).toBe("Find confusing order flows.");
    await f.button("Write the brief myself").click();
    expect(f.stage()).toEqual(["meet"]);
    expect(f.get("pm-key").value).toBe("product-gremlin");
    expect(f.get("pm-discover-after-create").disabled).toBe(true);
    expect(f.helper.prepareSubmit()).toBe(true);
    expect(f.firstTask).not.toHaveBeenCalled();
  });

  it("reveals the first invalid hidden field without letting a later one steal focus", () => {
    const f = fixture();
    f.get("pm-name").value = "Moss";
    f.get("pm-key").value = "moss";
    f.helper.review();
    f.get("pm-key").invalid = true;
    f.get("pm-schedule").invalid = true;
    expect(f.helper.prepareSubmit()).toBe(false);
    expect(f.stage()).toEqual(["advanced"]);
    expect(f.focused()).toBe(f.get("pm-key"));
    f.get("pm-key").invalid = false;
    f.helper.review();
    expect(f.helper.prepareSubmit()).toBe(false);
    expect(f.focused()).toBe(f.get("pm-schedule"));
  });

  it("preserves a saved adoption through refresh failures and close/reopen without rerunning or resaving", async () => {
    const f = fixture();
    f.helper.adopted(adopted);
    f.helper.setWelcomeWarning(
      "Moss is adopted. Setup information could not refresh.",
    );
    f.dialog.open = false;
    f.helper.open({ preselected: true });
    expect(f.helper.accepted).toEqual(adopted);
    expect(f.form.hidden).toBe(true);
    expect(f.helper.prepareSubmit()).toBe(false);
    expect(f.firstTask).not.toHaveBeenCalled();
    f.refresh.mockRejectedValueOnce(new Error("Unavailable"));
    await f.button("Refresh readiness").click();
    expect(f.helper.accepted).toEqual(adopted);
    expect(
      f.dialog
        .all()
        .some((node) =>
          node.textContent.includes("Your gremlin is adopted. Unavailable"),
        ),
    ).toBe(true);
    expect(f.firstTask).not.toHaveBeenCalled();
    await f.button("Adopt another gremlin").click();
    expect(f.helper.accepted).toBeNull();
    expect(f.form.hidden).toBe(false);
  });

  it("starts work only by a separate explicit click and reflects foundation and readiness", async () => {
    const f = fixture();
    f.project.areas.push({ key: "moss" });
    f.project.readiness.areas.push({
      key: "moss",
      discovery: { canRun: true },
    });
    f.project.foundation.needed = true;
    f.helper.adopted(adopted);
    expect(f.firstTask).not.toHaveBeenCalled();
    f.helper.setBusy(true);
    await f.button("Build the foundation").click();
    expect(f.firstTask).not.toHaveBeenCalled();
    f.helper.setBusy(false);
    f.project.foundation.needed = false;
    f.helper.refresh();
    await f.button("Explore the codebase").click();
    expect(f.firstTask).toHaveBeenCalledWith(adopted, expect.any(Element));
  });

  it("keeps the manual draft and current step when reopened; context changes return to the mission", async () => {
    const f = fixture();
    f.get("pm-mandate").value = "My goal";
    await f.button("Write the brief myself").click();
    f.helper.open({ preselected: true });
    expect(f.stage()).toEqual(["meet"]);
    f.helper.contextChanged();
    expect(f.stage()).toEqual(["mission"]);
    expect(f.get("pm-mandate").value).toBe("My goal");
  });

  it("uses cosmetic identity from the actual job without inventing backend traits", () => {
    const f = fixture();
    expect(f.identity({ mandate: "Improve permissions" })).toEqual({
      image: "/assets/gremlin-security.webp",
      description: "Security & trust PM",
    });
    expect(f.identity({ name: "Moss", mandate: "Smooth checkout" })).toEqual({
      image: "/assets/gremlin.webp",
      description: "Product PM",
    });
  });
});

describe("adoption creation transaction", () => {
  it.each([
    {
      foundation: true,
      ready: true,
      route: "/projects/shop?tab=environment",
      runs: 0,
    },
    {
      foundation: false,
      ready: false,
      route: "/projects/shop?pm=moss&tab=discovery",
      runs: 0,
    },
    {
      foundation: false,
      ready: true,
      route: "/projects/shop?pm=moss&tab=discovery",
      runs: 1,
    },
  ])(
    "uses foundation and Discovery readiness before the first mission: $foundation/$ready",
    async ({ foundation, ready, route, runs }) => {
      const start = app.indexOf(
        "    onFirstTask: async (adopted, trigger) => {",
      );
      const normalized = app.replaceAll("\r\n", "\n");
      const sourceStart = normalized.indexOf(
        "    onFirstTask: async (adopted, trigger) => {",
      );
      const end = normalized.indexOf(
        "\n  });\n  window.gremlinAdoption",
        sourceStart,
      );
      expect(start).toBeGreaterThan(0);
      expect(end).toBeGreaterThan(sourceStart);
      const navigate = vi.fn(),
        discover = vi.fn();
      const options = runInNewContext(
        `({${normalized.slice(sourceStart, end)}})`,
        {
          currentStatus: {
            projects: [
              {
                name: "shop",
                areas: [{ key: "moss" }],
                foundation: { needed: foundation },
                readiness: {
                  areas: [
                    {
                      key: "moss",
                      canRun: false,
                      discovery: { canRun: ready },
                    },
                  ],
                },
              },
            ],
          },
          closePmCreation() {},
          refreshStatus: vi.fn(),
          pages: { navigate },
          projectWorkspace: { discover },
          mergedJobs: () => [],
          selectJob: vi.fn(),
        },
      ) as { onFirstTask(value: Adopted, trigger: object): Promise<void> };
      await options.onFirstTask(adopted, {});
      expect(navigate).toHaveBeenCalledWith(route);
      expect(discover).toHaveBeenCalledTimes(runs);
    },
  );

  it("opens an active task instead of submitting Discovery again", async () => {
    const normalized = app.replaceAll("\r\n", "\n");
    const start = normalized.indexOf(
      "    onFirstTask: async (adopted, trigger) => {",
    );
    const end = normalized.indexOf("\n  });\n  window.gremlinAdoption", start);
    const discover = vi.fn(),
      selectJob = vi.fn();
    const options = runInNewContext(`({${normalized.slice(start, end)}})`, {
      currentStatus: {
        projects: [
          { name: "shop", instanceId: "current", areas: [{ key: "moss" }] },
        ],
      },
      closePmCreation() {},
      refreshStatus: vi.fn(),
      pages: { navigate: vi.fn() },
      projectWorkspace: { discover },
      mergedJobs: () => [
        {
          id: "old-run",
          type: "pm",
          project: "shop",
          projectInstanceId: "old",
          area: "moss",
          status: "running",
        },
        {
          id: "active-run",
          type: "pm",
          project: "shop",
          projectInstanceId: "current",
          area: "moss",
          status: "queued",
        },
      ],
      selectJob,
    }) as { onFirstTask(value: Adopted, trigger: object): Promise<void> };
    await options.onFirstTask(adopted, {});
    expect(selectJob).toHaveBeenCalledWith("active-run");
    expect(discover).not.toHaveBeenCalled();
  });

  it("keeps drafts separate when the project changes and invalidates old AI planning", () => {
    const controls: Record<string, { value: string }> = Object.fromEntries(
      [
        "pm-project",
        "pm-name",
        "pm-key",
        "pm-mandate",
        "pm-mixpanel-report",
        "pm-linear-project",
        "pm-schedule",
        "pm-metric",
        "pm-wip",
        "pm-paths",
        "pm-shared-paths",
        "pm-create-message",
      ].map((id) => [id, { value: "" }]),
    );
    let charter = {};
    const keys = {
      "pm-name": "name",
      "pm-key": "key",
      "pm-paths": "paths",
      "pm-shared-paths": "sharedTouchpoints",
      "pm-metric": "metric",
      "pm-schedule": "schedule",
      "pm-wip": "wipLimit",
    };
    const context = {
      $: (id: string) => controls[id],
      pmInputKeys: keys,
      readPmDraft: () => ({
        ...Object.fromEntries(
          Object.entries(keys).map(([id, key]) => [key, controls[id]!.value]),
        ),
        mandate: controls["pm-mandate"]!.value,
        charter,
        editedFields: ["name"],
      }),
      pmKeyEdited: false,
      pmAdoption: { contextChanged: vi.fn(), accepted: null },
      pmCharter: {
        fill(value: object) {
          charter = value;
        },
      },
      pmDraft: { reset: vi.fn() },
      message() {},
      window: {} as { change(project: string): void },
    };
    const start = app.indexOf("  const pmEditedFields = new Set();");
    const end = app.indexOf("  function openPmCreation(", start);
    runInNewContext(
      `${app.slice(start, end)}\nwindow.change=changePmCreationProject;`,
      context,
    );
    context.window.change("shop");
    controls["pm-name"]!.value = "Moss";
    controls["pm-mandate"]!.value = "Shop-only job";
    controls["pm-paths"]!.value = "shop/checkout/";
    charter = { goal: "Shop customers" };
    context.window.change("calendar");
    expect(controls["pm-name"]!.value).toBe("");
    expect(controls["pm-paths"]!.value).toBe("");
    expect(charter).toEqual({});
    controls["pm-name"]!.value = "Pip";
    controls["pm-mandate"]!.value = "Calendar job";
    context.window.change("shop");
    expect(controls["pm-name"]!.value).toBe("Moss");
    expect(controls["pm-mandate"]!.value).toBe("Shop-only job");
    expect(controls["pm-paths"]!.value).toBe("shop/checkout/");
    expect(charter).toEqual({ goal: "Shop customers" });
    expect(context.pmDraft.reset).toHaveBeenCalledTimes(3);
    expect(context.pmAdoption.contextChanged).toHaveBeenCalledTimes(3);
  });

  it("accepts POST success once, preserves the welcome on refresh failure, and never starts discovery", async () => {
    const f = fixture();
    f.get("pm-project").value = "shop";
    f.get("pm-name").value = "Moss";
    f.get("pm-key").value = "moss";
    f.get("pm-mandate").value = adopted.mandate;
    f.helper.review();
    const controls: Record<string, { value: string; reset?: () => void }> = {
      "pm-wip": { value: "3" },
      "pm-metric": { value: "/" },
      "pm-paths": { value: "" },
      "pm-shared-paths": { value: "" },
      "pm-mixpanel-report": { value: "" },
    };
    Object.assign(f.form, { reset: vi.fn() });
    let submit!: (event: { preventDefault(): void }) => Promise<void>;
    const start = app.indexOf(
      '  $("pm-create-form").addEventListener("submit",',
    );
    const end = app.indexOf(
      '  $("pm-create-form").addEventListener(\n    "invalid",',
      start,
    );
    const normalizedEnd =
      end < 0
        ? app.indexOf(
            '  $("pm-create-form").addEventListener(\r\n    "invalid",',
            start,
          )
        : end;
    expect(normalizedEnd).toBeGreaterThan(start);
    const api = vi.fn(async () => ({ linear: { status: "pending" } }));
    const discover = vi.fn(),
      navigate = vi.fn();
    runInNewContext(app.slice(start, normalizedEnd), {
      $: (id: string) =>
        id === "pm-create-form"
          ? Object.assign(f.form, {
              addEventListener: (_type: string, fn: typeof submit) => {
                submit = fn;
              },
            })
          : controls[id] || f.get(id),
      pmCreating: false,
      pmPlanning: false,
      formsLocked: false,
      pmAdoption: f.helper,
      pmCharter: { read: () => ({}), reset() {} },
      pmDraft: { reset() {} },
      pmKeyEdited: false,
      pmEditedFields: new Set(),
      pmCreationDrafts: new Map(),
      renderLinearSetup() {},
      message() {},
      updatePmCreationReview() {},
      api,
      linearResultMessage: () => "Linear setup pending.",
      refreshStatus: vi.fn(async () => {
        throw new Error("Offline");
      }),
      refreshConfigFiles: vi.fn(async () => {}),
      refreshLinearResources: vi.fn(async () => {}),
      areaActions: new Map(),
      pmCreateDialog: { close() {} },
      pages: { navigate },
      projectWorkspace: { discover },
    });
    await submit({ preventDefault() {} });
    expect(api).toHaveBeenCalledTimes(1);
    expect(f.helper.accepted).toMatchObject(adopted);
    expect(f.form.hidden).toBe(true);
    expect(
      f.dialog
        .all()
        .some((node) =>
          node.textContent.includes("Some setup information could not refresh"),
        ),
    ).toBe(true);
    await submit({ preventDefault() {} });
    expect(api).toHaveBeenCalledTimes(1);
    expect(discover).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
  });
});
