import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

type UiEvent = {
  target: Element;
  detail?: { page: string; path: string };
  preventDefault(): void;
};
class Events {
  listeners = new Map<string, ((event: UiEvent) => void)[]>();
  addEventListener(name: string, listener: (event: UiEvent) => void) {
    this.listeners.set(name, [...(this.listeners.get(name) || []), listener]);
  }
  emit(name: string, values: Partial<UiEvent> = {}) {
    const event = { target: this, preventDefault() {}, ...values } as UiEvent;
    return Promise.all(
      (this.listeners.get(name) || []).map((listener) => listener(event)),
    );
  }
}
class Element extends Events {
  children: Element[] = [];
  parentElement: Element | null = null;
  attributes = new Map<string, string>();
  dataset: Record<string, string> = {};
  className = "";
  id = "";
  textContent = "";
  value = "";
  hidden = false;
  open = false;
  invalid = false;
  disabled = false;
  type = "";
  classList = {
    contains: (name: string) => this.className.split(/\s+/).includes(name),
    add: (name: string) => {
      if (!this.classList.contains(name)) this.className += ` ${name}`;
    },
    toggle: (name: string, enabled: boolean) => {
      if (enabled) this.classList.add(name);
      else
        this.className = this.className
          .split(/\s+/)
          .filter((value) => value !== name)
          .join(" ");
    },
  };
  constructor(
    public tagName: string,
    private onFocus: (element: Element) => void,
  ) {
    super();
  }
  append(...children: Element[]) {
    for (const child of children) {
      child.remove();
      child.parentElement = this;
      this.children.push(child);
    }
  }
  prepend(...children: Element[]) {
    for (const child of [...children].reverse()) {
      child.remove();
      child.parentElement = this;
      this.children.unshift(child);
    }
  }
  insertBefore(child: Element, before: Element) {
    child.remove();
    const index = this.children.indexOf(before);
    if (index < 0)
      throw new Error("insertBefore reference must belong to host");
    child.parentElement = this;
    this.children.splice(index, 0, child);
  }
  after(child: Element) {
    const parent = this.parentElement!;
    child.remove();
    child.parentElement = parent;
    parent.children.splice(parent.children.indexOf(this) + 1, 0, child);
  }
  remove() {
    if (this.parentElement)
      this.parentElement.children = this.parentElement.children.filter(
        (child) => child !== this,
      );
    this.parentElement = null;
  }
  replaceChildren(...children: Element[]) {
    for (const child of [...this.children]) child.remove();
    this.append(...children);
  }
  all(): Element[] {
    return [this, ...this.children.flatMap((child) => child.all())];
  }
  contains(target: Element | null) {
    return target !== null && this.all().includes(target);
  }
  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }
  getAttribute(name: string) {
    return this.attributes.get(name);
  }
  matches(selector: string): boolean {
    if (selector.startsWith(":invalid")) return this.invalid;
    if (selector.startsWith("#")) return this.id === selector.slice(1);
    if (selector.startsWith("[data-")) {
      const key = selector
        .slice(6, -1)
        .replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
      return key in this.dataset;
    }
    const [tag, className] = selector.split(".");
    return (
      (!tag || this.tagName === tag.toUpperCase()) &&
      (!className || this.classList.contains(className))
    );
  }
  closest(selector: string): Element | null {
    return this.matches(selector)
      ? this
      : this.parentElement?.closest(selector) || null;
  }
  querySelectorAll(selector: string): Element[] {
    if (selector.startsWith(":scope > "))
      return this.children.filter((item) => item.matches(selector.slice(9)));
    const pieces = selector.split(/\s+/);
    if (pieces.length === 2) {
      const [parent, child] = pieces as [string, string];
      return this.all()
        .slice(1)
        .filter(
          (item) => item.matches(child) && item.parentElement?.closest(parent),
        );
    }
    return this.all()
      .slice(1)
      .filter((item) =>
        selector.split(",").some((value) => item.matches(value.trim())),
      );
  }
  querySelector(selector: string) {
    return this.querySelectorAll(selector)[0] || null;
  }
  focus() {
    this.onFocus(this);
  }
  scrollIntoView() {}
  showModal() {
    this.open = true;
  }
  close() {
    this.open = false;
  }
}

const script = readFileSync(
  new URL("../../dashboard/interface.js", import.meta.url),
  "utf8",
);
const app = readFileSync(
  new URL("../../dashboard/app.js", import.meta.url),
  "utf8",
);

function fixture(path = "/overview") {
  let focused: Element | null = null;
  const node = (tag: string, id = "", className = "") =>
    Object.assign(
      new Element(tag.toUpperCase(), (value) => {
        focused = value;
      }),
      { id, className },
    );
  const body = node("body");
  const add = (parent: Element, tag: string, id = "", className = "") => {
    const child = node(tag, id, className);
    parent.append(child);
    return child;
  };
  const connections = add(body, "section", "connections");
  add(connections, "div", "", "panel-heading");
  add(connections, "nav", "", "connection-categories");
  const groups = Object.fromEntries(
    ["crew-connections", "hosting-connections", "signals-connections"].map(
      (id) => [id, add(connections, "section", id, "integration-group")],
    ),
  );
  const providerGroups: Record<string, string> = {
    "model-connections": "crew-connections",
    "linear-connection": "crew-connections",
    "slack-connection": "crew-connections",
    "vercel-connection": "hosting-connections",
    "railway-connection": "hosting-connections",
    "cloud-run-connection": "hosting-connections",
    "sentry-connection": "signals-connections",
    "datadog-connection": "signals-connections",
    "mixpanel-connection": "signals-connections",
  };
  const providerNodes = Object.fromEntries(
    Object.entries(providerGroups).map(([id, group]) => [
      id,
      add(groups[group]!, "section", id),
    ]),
  );
  for (const id of ["source-control", "project-access"])
    providerNodes[id] = add(connections, "section", id, "integration-group");
  for (const [id, panel] of Object.entries(providerNodes)) {
    add(panel, "span", `${id}-status`, "signal-state").textContent =
      "Not connected";
    const detail = add(panel, "details", `${id}-advanced`, "service-advanced");
    add(detail, "input", `${id}-draft`).value = `${id} draft`;
    add(panel, "button", `${id}-save`).type = "submit";
  }
  add(providerNodes["source-control"]!, "span", "source-count").textContent =
    "2";
  const settings = add(body, "section", "configuration");
  for (const id of ["updates", "deleted-resources", "advanced-settings"])
    add(settings, "section", id);
  const runners = add(body, "section", "runners");
  add(add(runners, "div", "", "panel-heading"), "a", "worker-shortcut");
  add(runners, "div", "", "jobs-heading");
  const jobForm = add(runners, "form", "job-form");
  add(jobForm, "input", "job-ticket").value = "APP-12";
  add(runners, "section", "workers");
  const pmDialog = add(body, "dialog", "pm-create-drawer");
  const pmForm = add(pmDialog, "form", "pm-create-form");
  const pmFields = add(pmForm, "fieldset", "pm-create-fields");
  add(pmFields, "legend");
  add(pmFields, "select", "pm-project").value = "shop";
  add(pmFields, "textarea", "pm-mandate").value = "Protect checkout";
  add(pmFields, "div", "pm-ai-draft");
  add(pmFields, "p", "pm-creation-readiness", "pm-creation-readiness");
  add(pmFields, "h3", "", "pm-review-heading");
  add(pmFields, "input", "pm-name").value = "Checkout PM";
  add(pmFields, "input", "pm-key").value = "checkout";
  add(pmFields, "div", "pm-charter-fields");
  const execution = add(pmFields, "section", "pm-advanced");
  add(execution, "input", "pm-schedule").value = "0 13 * * 1-5";
  add(pmFields, "label", "", "discovery-after-create");
  add(add(pmFields, "div", "", "form-bottom"), "button", "create-pm");
  const projectDialog = add(body, "dialog", "project-settings-dialog");
  const projectForm = add(projectDialog, "form", "edit-project-form");
  for (const id of [
    "project-settings-title",
    "project-settings-name",
    "project-settings-provider",
    "project-settings-repo",
    "project-settings-message",
    "project-settings-discard",
  ])
    add(projectForm, "div", id);
  const projectNav = add(projectForm, "nav");
  for (const section of ["project", "linear", "signals"])
    add(projectNav, "button").dataset.projectSection = section;
  for (const id of [
    "edit-project-settings",
    "edit-signals-settings",
    "edit-linear-settings",
  ])
    add(projectForm, "div", id);
  add(
    add(projectForm, "div", "", "form-bottom"),
    "button",
    "save-project-settings",
  );
  const document = {
    body,
    createElement: (tag: string) => node(tag),
    getElementById: (id: string) =>
      body.all().find((item) => item.id === id) || null,
    querySelectorAll: (selector: string) => body.querySelectorAll(selector),
  };
  const location = new URL(path, "http://localhost:4311");
  const window = Object.assign(new Events(), {
    dashboardPages: { current: location.pathname.slice(1) },
    dashboardShell: { releaseConnections: vi.fn() },
    revealDashboardSetting: (_target: Element) => {},
    gremlinAdoption: { reveal: vi.fn() },
  });
  const observers: (() => void)[] = [];
  const context = {
    document,
    window,
    location,
    URL,
    MutationObserver: class {
      constructor(callback: () => void) {
        observers.push(callback);
      }
      observe() {}
    },
  };
  const original = body.all();
  runInNewContext(script, context);
  const get = (id: string) => document.getElementById(id)!;
  const nav = (label: string) =>
    body.all().find((item) => item.getAttribute("aria-label") === label)!;
  const button = (root: Element, label: string) =>
    root
      .all()
      .find((item) => item.tagName === "BUTTON" && item.textContent === label)!;
  const navigate = (path: string) => {
    location.href = new URL(path, location).href;
    window.emit("dashboard:pagechange", {
      detail: { page: location.pathname.slice(1), path },
    });
  };
  return {
    body,
    document,
    window,
    context,
    get,
    nav,
    button,
    add,
    original,
    observers,
    navigate,
    focused: () => focused,
  };
}

describe("dashboard interface surfaces", () => {
  it("takes ownership from legacy category tabs before adopting provider controls", () => {
    const f = fixture();
    expect(f.window.dashboardShell.releaseConnections).toHaveBeenCalledTimes(1);
    expect(f.body.querySelector(".connection-categories")).toBeNull();
    expect(f.get("source-control").parentElement?.className).toBe(
      "surface-dialog-body",
    );
    expect(f.get("project-access").parentElement?.className).toBe(
      "surface-dialog-body",
    );
  });
  it("moves existing controls without cloning nodes or losing their drafts and listeners", () => {
    const f = fixture();
    for (const original of f.original.filter((item) =>
      ["INPUT", "SELECT", "TEXTAREA", "BUTTON"].includes(item.tagName),
    ))
      expect(f.body.all().filter((item) => item === original)).toHaveLength(1);
    expect(f.get("job-form").parentElement?.id).toBe("runner-workbench");
    expect(f.get("job-ticket").value).toBe("APP-12");
    expect(f.get("pm-mandate").parentElement?.id).toBe("pm-create-fields");
    expect(f.get("pm-name").parentElement?.id).toBe("pm-create-fields");
    expect(f.get("pm-schedule").parentElement?.id).toBe("pm-advanced");
    expect(
      f.body.querySelector(".discovery-after-create")?.parentElement?.id,
    ).toBe("pm-create-fields");
    const draft = f.get("vercel-connection-draft");
    draft.value = "unsaved provider draft";
    const save = vi.fn();
    f.get("vercel-connection-save").addEventListener("click", save);
    f.navigate("/connections#vercel-connection");
    f.body.querySelector(".icon-close")!.emit("click");
    f.navigate("/connections#vercel-connection");
    expect(f.get("vercel-connection-draft")).toBe(draft);
    expect(draft.value).toBe("unsaved provider draft");
    f.get("vercel-connection-save").emit("click");
    expect(save).toHaveBeenCalledOnce();
  });

  it.each([
    ["/settings#deleted-resources", "deleted-resources"],
    ["/settings#configuration", "advanced-settings"],
    ["/settings#advanced-settings", "advanced-settings"],
    ["/settings#updates", "updates"],
  ])(
    "reveals the correct settings surface on direct load %s",
    (path, selected) => {
      const f = fixture(path);
      expect(
        ["updates", "deleted-resources", "advanced-settings"].filter(
          (id) => !f.get(id).hidden,
        ),
      ).toEqual([selected]);
    },
  );

  it("reveals Runners and workbench deep links without rebuilding the launch form", () => {
    const f = fixture("/runners#workers"),
      form = f.get("job-form");
    expect(f.get("workers").hidden).toBe(false);
    expect(f.get("runner-workbench").hidden).toBe(true);
    f.navigate("/runners#job-form");
    expect(f.get("runner-workbench").hidden).toBe(false);
    expect(f.get("workers").hidden).toBe(true);
    expect(f.get("job-form")).toBe(form);
    expect(f.get("job-ticket").value).toBe("APP-12");
    f.button(f.nav("Runner workspace"), "Runners").emit("click");
    expect(f.get("workers").hidden).toBe(false);
  });

  it("leaves PM control ownership to adoption and delegates hidden field reveal", () => {
    const f = fixture();
    expect(f.nav("New PM settings")).toBeUndefined();
    expect(f.get("pm-mandate").parentElement).toBe(f.get("pm-create-fields"));
    f.window.revealDashboardSetting(f.get("pm-name"));
    expect(f.window.gremlinAdoption.reveal).toHaveBeenCalledWith(
      f.get("pm-name"),
    );
    expect(f.get("pm-name").value).toBe("Checkout PM");
    expect(f.get("pm-mandate").value).toBe("Protect checkout");
  });

  it("opens provider deep links in one native modal and restores focus after Escape", () => {
    const f = fixture("/connections#vercel-connection-draft");
    const dialog = f.body.querySelector(".connection-detail-dialog")!;
    expect(dialog.open).toBe(true);
    expect(f.get("vercel-connection").hidden).toBe(false);
    expect(f.get("linear-connection").hidden).toBe(true);
    expect(
      f.get("vercel-connection").closest(".surface-dialog-body"),
    ).not.toBeNull();
    expect(f.focused()).toBe(dialog.querySelector(".icon-close"));
    dialog.emit("cancel");
    expect(dialog.open).toBe(false);
    expect(f.focused()?.getAttribute("aria-label")).toBe("Manage Vercel");
  });

  it.each(["/connections", "/connections#hosting-connections", "/overview"])(
    "closes provider modal on navigation to %s and preserves its draft",
    (path) => {
      const f = fixture("/connections#sentry-connection");
      const dialog = f.body.querySelector(".connection-detail-dialog")!;
      const draft = f.get("sentry-connection-draft");
      draft.value = "kept";
      f.navigate(path);
      expect(dialog.open).toBe(false);
      expect(draft.value).toBe("kept");
      f.navigate("/connections#datadog-connection");
      expect(dialog.open).toBe(true);
      const panels = dialog.querySelectorAll(".connection-detail-panel");
      expect(
        panels.filter((item) => !item.hidden).map((item) => item.id),
      ).toEqual(["datadog-connection"]);
    },
  );

  it("updates provider status without replacing a focused tile or dialog form", () => {
    const f = fixture();
    const manage = f.body
      .all()
      .find((item) => item.getAttribute("aria-label") === "Manage Linear")!;
    manage.focus();
    f.get("linear-connection-status").textContent = "Connected";
    f.observers.forEach((notify) => notify());
    expect(f.focused()).toBe(manage);
    expect(
      manage
        .closest(".connection-tile")
        ?.querySelector(".connection-tile-state")?.textContent,
    ).toBe("Connected");
    expect(f.get("linear-connection-draft").value).toBe(
      "linear-connection draft",
    );
  });
});

describe("project editor outer-surface integration", () => {
  it("clears the previous project's settings and Signals before a new load and on failure", async () => {
    const f = fixture();
    const oldSignal = f.add(
      f.get("edit-signals-settings"),
      "input",
      "old-signal",
    );
    f.add(f.get("edit-project-settings"), "input", "old-project-field");
    let reject!: (reason: Error) => void;
    const api = vi.fn(
      () =>
        new Promise((_resolve, no) => {
          reject = no;
        }),
    );
    const projectEditor = {
      name: "old",
      config: {},
      form: {},
      busy: false,
      section: "signals",
    };
    const context = {
      ...f.context,
      $: f.get,
      api,
      projectEditor,
      projectLinearSettings: { isBusy: () => false, reset() {} },
      updateProjectEditorControls() {},
      message: (target: Element, value: string) => {
        target.textContent = value;
      },
    };
    const begin = app.indexOf("  function prepareProjectSections("),
      middle = app.indexOf(
        '  for (const button of document.querySelectorAll("[data-project-section]"))',
        app.indexOf("    target.scrollIntoView", begin),
      ),
      start = app.indexOf("  async function openProjectSettings("),
      end = app.indexOf("  function isProjectEditorDirty()", start);
    const open = runInNewContext(
      `${app.slice(begin, middle)}\n${app.slice(start, end)}\nopenProjectSettings`,
      context,
    ) as (name: string) => Promise<void>;
    const pending = open("unavailable-project");
    expect(f.get("edit-signals-settings").contains(oldSignal)).toBe(false);
    expect(f.get("edit-project-settings").children).toHaveLength(0);
    expect(f.get("edit-signals-settings").hidden).toBe(true);
    expect(projectEditor.section).toBe("project");
    expect(projectEditor.form).toBeNull();
    reject(new Error("Configuration unavailable"));
    await pending;
    expect(f.get("edit-signals-settings").children).toHaveLength(0);
    expect(f.get("edit-project-settings").children).toHaveLength(0);
    expect(projectEditor.busy).toBe(false);
    expect(f.get("project-settings-message").textContent).toContain(
      "Configuration unavailable",
    );
  });

  it.each(["project", "signals"])(
    "preserves the selected %s outer tab after saving and remounting fields",
    async (section) => {
      const f = fixture();
      const projectEditor = {
        name: "shop",
        path: "projects/shop/project.json",
        revision: "reviewed-revision",
        config: { repo: "owner/shop" },
        form: { read: () => ({ telemetry: { sentry: { project: "shop" } } }) },
        section,
        busy: false,
      };
      const api = vi.fn(async () => ({ revision: "saved-revision" }));
      const context = {
        ...f.context,
        $: f.get,
        projectEditor,
        formsLocked: false,
        serviceProfiles: [],
        api,
        window: {
          createProjectSettings: (root: Element) => {
            root.replaceChildren();
            const signals = f.add(
              root,
              "section",
              "",
              "project-signals-settings",
            );
            f.add(signals, "input", "saved-signal-input").value = "saved";
            return { read: () => ({}) };
          },
        },
        projectLinearSettings: {
          isBusy: () => false,
          isDirty: () => false,
          load: vi.fn(async () => {}),
        },
        projectChecks: new Map(),
        refreshStatus: vi.fn(async () => {}),
        updateProjectEditorControls() {},
        message: (target: Element, value: string) => {
          target.textContent = value;
        },
      };
      const begin = app.indexOf("  function prepareProjectSections("),
        middle = app.indexOf(
          '  for (const button of document.querySelectorAll("[data-project-section]"))',
          app.indexOf("    target.scrollIntoView", begin),
        ),
        start = app.indexOf(
          '  $("edit-project-form").addEventListener("submit"',
        ),
        end = app.indexOf(
          '  $("reveal-gcp-credentials").addEventListener',
          start,
        );
      runInNewContext(
        `${app.slice(begin, middle)}\n${app.slice(start, end)}`,
        context,
      );
      await f.get("edit-project-form").emit("submit");
      expect(projectEditor.revision).toBe("saved-revision");
      expect(projectEditor.section).toBe(section);
      expect(f.get("edit-signals-settings").hidden).toBe(section !== "signals");
      expect(f.get("edit-project-settings").hidden).toBe(section !== "project");
      expect(
        f.get("edit-signals-settings").contains(f.get("saved-signal-input")),
      ).toBe(true);
      expect(api).toHaveBeenCalledWith(
        "/api/config",
        expect.objectContaining({ revision: "reviewed-revision" }),
        "PUT",
      );
      expect(projectEditor.busy).toBe(false);
    },
  );

  it.each([0, 1])(
    "reveals moved Signals and project inputs through constructor %i, including after save",
    (index) => {
      const f = fixture();
      const projectRoot = f.get("edit-project-settings");
      const fields = f.add(projectRoot, "input", "project-setting-input");
      const signals = f.add(projectRoot, "div", "", "project-signals-settings");
      const signal = f.add(signals, "input", "signal-setting-input");
      let onReveal: (input: Element) => void = () => {
        throw new Error("onReveal missing");
      };
      const context = {
        ...f.context,
        $: f.get,
        projectEditor: { name: "shop", config: {}, form: null },
        serviceProfiles: [],
        window: {
          createProjectSettings: (
            _root: Element,
            _prefix: string,
            _config: object,
            options: { onReveal(input: Element): void },
          ) => {
            onReveal = options.onReveal;
            return {};
          },
        },
      };
      const begin = app.indexOf("  function prepareProjectSections("),
        end = app.indexOf(
          '  for (const button of document.querySelectorAll("[data-project-section]"))',
          app.indexOf("    target.scrollIntoView", begin),
        );
      const constructors = [
        ...app.matchAll(
          /projectEditor\.form = window\.createProjectSettings\([\s\S]*?\n {6}\);/g,
        ),
      ];
      expect(constructors).toHaveLength(2);
      runInNewContext(
        `${app.slice(begin, end)}\n${constructors[index]![0]}\nprepareProjectSections();`,
        context,
      );
      expect(f.get("edit-signals-settings").contains(signal)).toBe(true);
      expect(f.get("edit-signals-settings").hidden).toBe(true);
      onReveal(signal);
      expect(f.get("edit-signals-settings").hidden).toBe(false);
      expect(projectRoot.hidden).toBe(true);
      expect(f.get("edit-linear-settings").hidden).toBe(true);
      onReveal(fields);
      expect(projectRoot.hidden).toBe(false);
      expect(f.get("edit-signals-settings").hidden).toBe(true);
      expect(
        f.get("save-project-settings").closest(".form-bottom")?.hidden,
      ).toBe(false);
    },
  );
});
