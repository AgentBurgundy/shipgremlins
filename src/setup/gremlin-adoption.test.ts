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
  projectInstanceId?: string | null;
  areaInstanceId?: string | null;
  returnToCrew?: boolean;
};
const identityWindow = {} as {
  isCurrentGremlinAdoption(adopted: Adopted, project: unknown): boolean;
};
runInNewContext(script, { window: identityWindow });
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
function fixture(linear = false) {
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
  field(fields, "select", "pm-verification-requirement");
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
    instanceId: null as string | null,
    areas: [] as {
      key: string;
      instanceId?: string | null;
      linearProjectId?: string;
    }[],
    readiness: {
      steps: [] as { id: string; ready: boolean }[],
      areas: [] as { key: string; discovery: { canRun: boolean } }[],
    },
    foundation: { needed: false },
    verification: { mode: "repository", environment: "preview" },
    environments: {} as Record<string, object>,
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
    setupHosting = vi.fn(),
    setupLinear = vi.fn(),
    openHome = vi.fn(),
    openSignals = vi.fn(),
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
    onSetupHosting: setupHosting,
    onSetupLinear: linear ? setupLinear : undefined,
    onOpenHome: openHome,
    onOpenSignals: openSignals,
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
    setupHosting,
    setupLinear,
    openHome,
    openSignals,
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
  it("asks for app sign-in after adoption even when Vercel is connected", async () => {
    const f = fixture(true);
    f.project.areas.push({ key: "moss", linearProjectId: "linear-moss" });
    f.project.readiness.areas.push({
      key: "moss",
      discovery: { canRun: true },
    });
    f.project.verification.mode = "browser";
    f.project.environments.preview = { kind: "vercel" };
    f.project.readiness.steps.push({ id: "test_access", ready: false });
    f.helper.adopted(adopted);
    const setup = f.button("Set up app sign-in");
    expect(setup.hidden).toBe(false);
    expect(setup.className).toContain("button-dark");
    expect(f.button("Start with code only").className).not.toContain(
      "button-dark",
    );
    expect(
      f.dialog.all().find((node) => node.className === "adoption-signals")
        ?.hidden,
    ).toBe(true);
    expect(f.firstTask).not.toHaveBeenCalled();
    await setup.click();
    expect(f.setupHosting).toHaveBeenCalledWith("shop", setup);
    expect(f.setupLinear).not.toHaveBeenCalled();
    expect(f.firstTask).not.toHaveBeenCalled();
    f.project.readiness.steps[0]!.ready = true;
    f.helper.refresh();
    expect(setup.hidden).toBe(true);
    expect(
      f.dialog.all().find((node) => node.className === "adoption-signals")
        ?.hidden,
    ).toBe(false);
  });

  it("guides Linear account then PM project then hosting, without launching work during setup", async () => {
    const f = fixture(true);
    f.project.areas.push({
      key: "moss",
      linearProjectId: "PASTE_LINEAR_PROJECT_ID",
    });
    f.project.readiness.areas.push({
      key: "moss",
      discovery: { canRun: true },
    });
    f.project.readiness.steps = [
      { id: "linear_connection", ready: false },
      { id: "linear_mapping", ready: false },
    ];
    f.helper.adopted(adopted);
    const connect = f.button("Connect Linear");
    expect(connect.hidden).toBe(false);
    expect(connect.className).toContain("button-dark");
    expect(f.button("Start with code only").className).not.toContain(
      "button-dark",
    );
    expect(
      f.dialog.all().find((node) => node.className === "adoption-signals")
        ?.hidden,
    ).toBe(true);
    expect(f.setupLinear).not.toHaveBeenCalled();
    expect(f.firstTask).not.toHaveBeenCalled();
    await connect.click();
    expect(f.setupLinear).toHaveBeenCalledWith("shop", connect);
    f.project.readiness.steps[0]!.ready = true;
    f.helper.refresh();
    expect(f.button("Set up Linear").hidden).toBe(false);
    await f.button("Set up Linear").click();
    expect(f.setupLinear).toHaveBeenCalledTimes(2);
    // Mapping some other PM does not resolve this newly adopted PM's placeholder.
    f.project.readiness.steps[1]!.ready = true;
    f.helper.refresh();
    expect(f.button("Set up Linear").hidden).toBe(false);
    f.project.areas[0]!.linearProjectId = "linear-project-moss";
    f.helper.refresh();
    await f.button("Connect a test environment").click();
    expect(f.setupHosting).toHaveBeenCalledOnce();
    expect(f.firstTask).not.toHaveBeenCalled();
    expect(f.helper.accepted).toEqual(adopted);
  });

  it("does not offer Linear ahead of a foundation or act on a replaced adoption", async () => {
    const f = fixture(true);
    f.project.areas.push({ key: "moss" });
    f.helper.adopted(adopted);
    const setup = f.button("Set up Linear");
    f.project.foundation.needed = true;
    f.helper.refresh();
    expect(setup.hidden).toBe(true);
    await setup.click();
    expect(f.setupLinear).not.toHaveBeenCalled();
    f.project.foundation.needed = false;
    f.helper.refresh();
    f.project.instanceId = "replacement";
    await setup.click();
    expect(f.setupLinear).not.toHaveBeenCalled();
    expect(f.setupHosting).not.toHaveBeenCalled();
  });
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
    await f.button("Start with code only").click();
    expect(f.firstTask).toHaveBeenCalledWith(adopted, expect.any(Element));
  });

  it("offers hosting before signals while keeping code-only investigation an explicit choice", async () => {
    const f = fixture();
    f.project.areas.push({ key: "moss" });
    f.project.readiness.areas.push({
      key: "moss",
      discovery: { canRun: true },
    });
    f.helper.adopted(adopted);
    const connect = f.button("Connect a test environment"),
      code = f.button("Start with code only");
    expect(connect.hidden).toBe(false);
    expect(connect.className).toContain("button-dark");
    expect(code.className).not.toContain("button-dark");
    expect(
      f.dialog.all().find((node) => node.className === "adoption-signals")
        ?.hidden,
    ).toBe(true);
    expect(
      f.dialog
        .all()
        .some((node) => node.textContent.includes("without opening the app")),
    ).toBe(true);
    expect(f.setupHosting).not.toHaveBeenCalled();
    expect(f.firstTask).not.toHaveBeenCalled();
    await connect.click();
    expect(f.setupHosting).toHaveBeenCalledWith("shop", connect);
    expect(f.helper.accepted).toEqual(adopted);
    expect(f.firstTask).not.toHaveBeenCalled();
    await code.click();
    expect(f.firstTask).toHaveBeenCalledOnce();
  });

  it("keeps adoption saved if opening hosting fails and respects busy and foundation states", async () => {
    const f = fixture();
    f.project.areas.push({ key: "moss" });
    f.helper.adopted(adopted);
    const connect = f.button("Connect a test environment");
    f.lock(true);
    await connect.click();
    expect(f.setupHosting).not.toHaveBeenCalled();
    f.lock(false);
    f.setupHosting.mockRejectedValueOnce(
      new Error("Save your current edits first."),
    );
    await connect.click();
    expect(
      f.dialog
        .all()
        .some((node) =>
          node.textContent.includes("Save your current edits first"),
        ),
    ).toBe(true);
    expect(f.helper.accepted).toEqual(adopted);
    f.project.foundation.needed = true;
    f.helper.refresh();
    expect(connect.hidden).toBe(true);
    await connect.click();
    expect(f.setupHosting).toHaveBeenCalledOnce();
    expect(f.firstTask).not.toHaveBeenCalled();
  });

  it.each(["vercel", "url", "local"])(
    "keeps configured %s browser targets out of the missing-hosting prompt",
    async (kind) => {
      const f = fixture();
      f.project.areas.push({ key: "moss" });
      f.project.verification.mode = "browser";
      f.project.environments.preview = { kind, role: "preview" };
      f.helper.adopted(adopted);
      expect(f.button("Connect a test environment").hidden).toBe(true);
      await f.button("Connect a test environment").click();
      expect(f.setupHosting).not.toHaveBeenCalled();
      expect(
        f.dialog.all().find((node) => node.className === "adoption-signals")
          ?.hidden,
      ).toBe(false);
      // A saved but unselected target does not enable a browser walkthrough.
      f.project.verification.mode = "repository";
      f.helper.refresh();
      expect(f.button("Connect a test environment").hidden).toBe(false);
    },
  );

  it("offers optional project-scoped signals without starting work or losing the accepted gremlin", async () => {
    const f = fixture();
    f.project.verification.mode = "browser";
    f.project.environments.preview = {
      kind: "url",
      role: "preview",
      url: "https://preview.example.com",
    };
    f.project.areas.push({ key: "moss" });
    f.project.readiness.areas.push({
      key: "moss",
      discovery: { canRun: true },
    });
    f.helper.adopted(adopted);
    const choices = f.dialog
      .all()
      .filter((node) =>
        node.attributes.get("aria-label")?.startsWith("Set up "),
      );
    expect(choices).toHaveLength(3);
    expect(f.openSignals).not.toHaveBeenCalled();
    for (const [index, provider] of [
      "sentry",
      "mixpanel",
      "datadog",
    ].entries()) {
      await choices[index]!.click();
      expect(f.openSignals).toHaveBeenLastCalledWith(
        adopted,
        provider,
        choices[index],
      );
    }
    f.helper.open({ preselected: true });
    expect(f.helper.accepted).toEqual(adopted);
    expect(f.firstTask).not.toHaveBeenCalled();
    expect(f.draft).not.toHaveBeenCalled();
    expect(f.button("Start with code only").disabled).toBe(false);
    f.project.foundation.needed = true;
    f.helper.refresh();
    expect(
      f.dialog.all().find((node) => node.className === "adoption-signals")
        ?.hidden,
    ).toBe(true);
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

  it.each(["project", "PM"])(
    "rejects retained adoption actions after the %s is recreated, even before the next repaint",
    async (kind) => {
      const f = fixture();
      f.project.instanceId = "project-original";
      f.project.areas.push({ key: "moss", instanceId: "pm-original" });
      f.project.readiness.areas.push({
        key: "moss",
        discovery: { canRun: true },
      });
      const original = {
        ...adopted,
        projectInstanceId: "project-original",
        areaInstanceId: "pm-original",
      };
      f.helper.adopted(original);
      const start = f.button("Start with code only");
      const connect = f.button("Connect a test environment");
      const signal = f.dialog
        .all()
        .find(
          (node) =>
            node.attributes.get("aria-label") ===
            "Set up Sentry for this project",
        )!;
      if (kind === "project") f.project.instanceId = "project-replacement";
      else f.project.areas[0]!.instanceId = "pm-replacement";
      await signal.click();
      await connect.click();
      await start.click();
      await f.button("Visit their home").click();
      f.helper.open({ preselected: true });
      expect(f.helper.accepted).toEqual(original);
      expect(f.firstTask).not.toHaveBeenCalled();
      expect(f.openSignals).not.toHaveBeenCalled();
      expect(f.openHome).not.toHaveBeenCalled();
      expect(f.setupHosting).not.toHaveBeenCalled();
      expect(
        f.dialog
          .all()
          .some((node) =>
            node.textContent.includes("was replaced after adoption"),
          ),
      ).toBe(true);
      expect(start.disabled).toBe(true);
      expect(signal.disabled).toBe(true);
    },
  );

  it("treats only absent IDs as the same legacy incarnation", () => {
    const project = { name: "shop", areas: [{ key: "moss" }] };
    expect(identityWindow.isCurrentGremlinAdoption(adopted, project)).toBe(
      true,
    );
    expect(
      identityWindow.isCurrentGremlinAdoption(
        { ...adopted, projectInstanceId: null, areaInstanceId: null },
        project,
      ),
    ).toBe(true);
    expect(
      identityWindow.isCurrentGremlinAdoption(adopted, {
        ...project,
        instanceId: "replacement",
      }),
    ).toBe(false);
    expect(
      identityWindow.isCurrentGremlinAdoption(adopted, {
        ...project,
        areas: [{ key: "moss", instanceId: "replacement" }],
      }),
    ).toBe(false);
    expect(
      identityWindow.isCurrentGremlinAdoption(adopted, {
        ...project,
        areas: [],
      }),
    ).toBe(false);
  });

  it("uses cosmetic identity from the actual job without inventing backend traits", () => {
    const f = fixture();
    expect(f.identity({ mandate: "Improve permissions" })).toEqual({
      image: "/assets/gremlin-security.webp",
      description: "Security & trust PM",
    });
    const moss = f.identity({ name: "Moss", mandate: "Smooth checkout" });
    expect(moss.description).toBe("Product PM");
    expect(moss.image).toMatch(
      /^\/assets\/gremlin(?:-investigating|-reviewing|-building)?\.webp$/,
    );
    expect(
      f.identity({ name: "Moss", mandate: "A changed product job" }).image,
    ).toBe(moss.image);
    expect(f.identity({ name: "Pip" }).image).not.toBe(moss.image);
  });
});

describe("adoption creation transaction", () => {
  it("returns recommendation adoptions to the crew while manual adoptions keep their PM home", async () => {
    const f = fixture();
    const accepted = {
      project: "shop",
      key: "pip",
      name: "Pip",
      mandate: "Own checkout",
      returnToCrew: true,
    };
    f.project.areas.push({ key: "pip" });
    f.helper.adopted(accepted);
    await f.button("Back to your crew").click();
    expect(f.openHome).toHaveBeenLastCalledWith(accepted);
    f.helper.adopted({ ...accepted, returnToCrew: false });
    expect(f.button("Visit their home")).toBeDefined();
    const normalized = app.replaceAll("\r\n", "\n");
    const start = normalized.indexOf("    onOpenHome: (adopted) => {");
    const end = normalized.indexOf("    onOpenSignals:", start);
    const navigate = vi.fn(),
      close = vi.fn();
    const callbacks = runInNewContext(`({${normalized.slice(start, end)}})`, {
      closePmCreation: close,
      pages: { navigate },
    });
    callbacks.onOpenHome(accepted);
    expect(navigate).toHaveBeenLastCalledWith("/projects/shop?tab=crew");
    callbacks.onOpenHome({ ...accepted, returnToCrew: false });
    expect(navigate).toHaveBeenLastCalledWith("/projects/shop?pm=pip");
    expect(close).toHaveBeenCalledTimes(2);
  });
  it("prefills the reviewed setup suggestion without drafting, adopting, or starting work", () => {
    const f = fixture();
    const normalized = app.replaceAll("\r\n", "\n");
    const start = normalized.indexOf("  function openPmCreation(");
    const end = normalized.indexOf("  function closePmCreation()", start);
    const showModal = vi.fn(),
      reset = vi.fn();
    const context = {
      $: (id: string) => f.get(id) || { value: "" },
      document: { activeElement: f.get("pm-name") },
      formsLocked: false,
      pmCreating: false,
      currentStatus: { projects: [f.project] },
      changePmCreationProject: vi.fn(),
      pmAdoption: f.helper,
      pmDraft: { reset },
      pmGeneratedValues: {},
      readPmDraft: () => ({ ...f.input(), editedFields: [] }),
      pmCharter: { fill: vi.fn() },
      pmInputKeys: { "pm-name": "name", "pm-key": "key" },
      message: vi.fn(),
      pmEditedFields: new Set(),
      pmKeyEdited: true,
      pmCreateTrigger: null,
      pendingPmCreate: false,
      pmCreateDialog: { open: false, showModal, dataset: {} },
      renderLinearSetup: vi.fn(),
      updatePmCreationReview: vi.fn(),
      refreshLinearResources: vi.fn(),
      Event: class {
        constructor(
          public type: string,
          public options: { bubbles: boolean },
        ) {}
        get bubbles() {
          return this.options.bubbles;
        }
      },
      window: {} as {
        openGremlinAdoption(
          project: string,
          trigger: object,
          suggestion: object,
        ): void;
      },
    };
    runInNewContext(normalized.slice(start, end), context);
    context.window.openGremlinAdoption(
      "shop",
      {},
      {
        name: "Checkout Scout",
        mandate: "Map order completion and the checkout boundary.",
      },
    );
    expect(f.get("pm-name").value).toBe("Checkout Scout");
    expect(f.get("pm-mandate").value).toBe(
      "Map order completion and the checkout boundary.",
    );
    expect(f.stage()).toEqual(["mission"]);
    expect(showModal).toHaveBeenCalledOnce();
    expect(reset).toHaveBeenCalledOnce();
    expect(f.helper.accepted).toBeNull();
    expect(f.draft).not.toHaveBeenCalled();
    expect(f.firstTask).not.toHaveBeenCalled();
  });

  it("opens the selected signal provider for the adopted project and retains its incarnation for return", async () => {
    const normalized = app.replaceAll("\r\n", "\n");
    const start = normalized.indexOf(
      "    onOpenSignals: async (adopted, provider, trigger) => {",
    );
    const end = normalized.indexOf("    onFirstTask:", start);
    const settings = vi.fn(),
      close = vi.fn();
    const context = {
      currentStatus: {
        projects: [
          {
            name: "shop",
            instanceId: "project-v2",
            areas: [{ key: "moss", instanceId: "pm-v2" }],
          },
        ],
      },
      adoptionSignalReturn: null,
      window: identityWindow,
      closePmCreation: close,
      openProjectSettings: settings,
    };
    const options = runInNewContext(
      `({${normalized.slice(start, end)}})`,
      context,
    ) as {
      onOpenSignals(
        adopted: Adopted,
        provider: string,
        trigger: object,
      ): Promise<void>;
    };
    const trigger = {};
    const bound = {
      ...adopted,
      projectInstanceId: "project-v2",
      areaInstanceId: "pm-v2",
    };
    await options.onOpenSignals(bound, "mixpanel", trigger);
    expect(settings).toHaveBeenCalledWith("shop", trigger, {
      section: "signals",
      provider: "mixpanel",
    });
    expect(context.adoptionSignalReturn).toEqual({
      project: "shop",
      key: "moss",
      instanceId: "project-v2",
      areaInstanceId: "pm-v2",
    });
    expect(close).toHaveBeenCalledOnce();
    context.currentStatus.projects[0]!.areas = [];
    await expect(
      options.onOpenSignals(bound, "sentry", trigger),
    ).rejects.toThrow("Refresh the project");
    expect(settings).toHaveBeenCalledOnce();
    context.currentStatus.projects[0]!.areas = [
      { key: "moss", instanceId: "pm-v3" },
    ];
    await expect(
      options.onOpenSignals(bound, "sentry", trigger),
    ).rejects.toThrow("Refresh the project");
    expect(settings).toHaveBeenCalledOnce();
  });

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
          window: identityWindow,
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
      window: identityWindow,
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
    await options.onFirstTask({ ...adopted, projectInstanceId: "current" }, {});
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

  it.each([undefined, "browser", "repository"])(
    "accepts POST success with testing requirement %s once, preserves the welcome on refresh failure, and never starts discovery",
    async (verificationRequirement) => {
      const f = fixture();
      f.get("pm-project").value = "shop";
      f.get("pm-name").value = "Moss";
      f.get("pm-key").value = "moss";
      f.get("pm-mandate").value = adopted.mandate;
      f.get("pm-verification-requirement").value =
        verificationRequirement || "";
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
      const api = vi.fn(async () => ({
        projectInstanceId: "created-project",
        areaInstanceId: "created-pm",
        linear: { status: "pending" },
      }));
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
        pmCreateDialog: { close() {}, dataset: {} },
        pages: { navigate },
        projectWorkspace: { discover },
      });
      await submit({ preventDefault() {} });
      expect(api).toHaveBeenCalledTimes(1);
      expect(api).toHaveBeenCalledWith(
        expect.any(String),
        verificationRequirement
          ? expect.objectContaining({ verificationRequirement })
          : expect.not.objectContaining({
              verificationRequirement: expect.anything(),
            }),
        "POST",
        90000,
      );
      expect(f.helper.accepted).toMatchObject({
        ...adopted,
        projectInstanceId: "created-project",
        areaInstanceId: "created-pm",
      });
      expect(f.form.hidden).toBe(true);
      expect(
        f.dialog
          .all()
          .some((node) =>
            node.textContent.includes(
              "Some setup information could not refresh",
            ),
          ),
      ).toBe(true);
      await submit({ preventDefault() {} });
      expect(api).toHaveBeenCalledTimes(1);
      expect(discover).not.toHaveBeenCalled();
      expect(navigate).not.toHaveBeenCalled();
    },
  );
});
