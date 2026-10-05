import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
class Element {
  children: Element[] = [];
  dataset: Record<string, string> = {};
  listeners = new Map<
    string,
    (event?: { key: string; preventDefault(): void }) => void
  >();
  attributes = new Map<string, string>();
  parentElement: Element | null = null;
  hidden = false;
  focused = false;
  open = false;
  className = "";
  tabIndex = 0;
  disabled = false;
  required = false;
  id = "";
  textContent = "";
  private storedValue = "";
  constructor(public tagName = "DIV") {}
  get value() {
    return this.storedValue;
  }
  set value(value: string) {
    this.storedValue =
      this.tagName === "SELECT" &&
      !this.children.some((child) => child.value === value)
        ? ""
        : value;
  }
  append(...items: Element[]) {
    for (const item of items) {
      if (item.parentElement)
        item.parentElement.children = item.parentElement.children.filter(
          (child) => child !== item,
        );
      item.parentElement = this;
      this.children.push(item);
    }
  }
  replaceChildren(...items: Element[]) {
    this.children = [];
    this.append(...items);
  }
  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }
  addEventListener(
    name: string,
    listener: (event?: { key: string; preventDefault(): void }) => void,
  ) {
    this.listeners.set(name, listener);
  }
  fire(name: string, key = "") {
    this.listeners.get(name)?.({ key, preventDefault() {} });
  }
  focus() {
    this.focused = true;
  }
  all(): Element[] {
    return [this, ...this.children.flatMap((child) => child.all())];
  }
  contains(input: Element) {
    return this.all().includes(input);
  }
  querySelectorAll(selector: string): Element[] {
    return this.children.flatMap((child) => [
      ...(selector.split(",").includes(child.tagName.toLowerCase())
        ? [child]
        : []),
      ...child.querySelectorAll(selector),
    ]);
  }
  reportValidity() {
    const valid = !this.required || Boolean(this.value);
    if (!valid) this.fire("invalid");
    return valid;
  }
}
const access = {
  kind: "password",
  loginPath: "/login",
  usernameSelector: "#email",
  passwordSelector: "#password",
  submitSelector: "#submit",
  successSelector: "#account",
  accounts: [
    {
      name: "Viewer",
      usernameSecret: "TEST_VIEWER_USERNAME",
      passwordSecret: "TEST_VIEWER_PASSWORD",
    },
  ],
};
function form(target: object) {
  const document = {
    createElement: (tag: string) => new Element(tag.toUpperCase()),
    createTextNode: (text: string) =>
      Object.assign(new Element("#text"), { textContent: text }),
  };
  class Option extends Element {
    constructor(text: string, value: string) {
      super("OPTION");
      this.textContent = text;
      this.value = value;
    }
  }
  const onReveal = vi.fn();
  const signalInput = new Element("INPUT");
  signalInput.value = "signal-draft";
  const window = {
    createSignalsSettings: (container: Element) => {
      container.append(signalInput);
      return {
        isDirty: () => false,
        read: () => ({}),
        setProjectName() {},
        focusProvider() {},
      };
    },
    createProjectSettings: (
      _container: Element,
      _prefix: string,
      _config: object,
      _options: object,
    ): {
      read(): Record<string, unknown>;
      isDirty(): boolean;
      selectSection(key: string): boolean;
      focus(key: string): boolean;
    } => {
      throw new Error("not loaded");
    },
  };
  runInNewContext(
    readFileSync(
      new URL("../../dashboard/project-settings.js", import.meta.url),
      "utf8",
    ),
    { window, document, Option, structuredClone, queueMicrotask },
  );
  const root = new Element(),
    config = {
      environments: { testing: target },
      verification: { mode: "browser", environment: "testing" },
      workflow: { kind: "pull-request", baseBranch: "main" },
      commands: { install: "npm ci", test: "npm test" },
    };
  const settings = window.createProjectSettings(root, "edit", config, {
    onReveal,
  });
  return { root, settings, onReveal, signalInput };
}
describe("project editor environment preservation", () => {
  it.each([
    {
      kind: "docker",
      role: "staging",
      recipe: {
        kind: "dockerfile",
        dockerfile: ".gremlins/Dockerfile",
        context: ".",
      },
      port: 3000,
      healthPath: "/health",
      services: [{ kind: "postgres", name: "db", env: "DATABASE_URL" }],
      env: { APP_KEY: "TEST_APP_KEY" },
      seed: ["npm", "run", "seed"],
      access,
    },
    {
      kind: "vercel",
      role: "preview",
      connectionId: "team-two",
      projectId: "prj_test",
      branch: "pm-staging",
      customEnvironmentId: "env_staging",
      access,
    },
  ])(
    "retains the complete saved $kind target on a commands-only edit",
    (target) => {
      const { root, settings } = form(target);
      const field = root
        .querySelectorAll("input")
        .find((item) => item.dataset.setting === "command-test")!;
      field.value = "node --test";
      expect(settings.read()).toMatchObject({
        commands: { test: "node --test" },
        verification: { mode: "browser", environment: "testing" },
        environments: { testing: target },
      });
    },
  );

  it("shows Environment, Delivery and Checks as accessible tabs without disclosures", () => {
    const { root, settings } = form({
      kind: "url",
      role: "staging",
      url: "https://example.test",
    });
    const tabs = root
      .all()
      .filter((item) => item.attributes.get("role") === "tab");
    const panels = root
      .all()
      .filter((item) => item.attributes.get("role") === "tabpanel");
    expect(tabs.map((item) => item.textContent)).toEqual([
      "Environment",
      "Delivery",
      "Checks",
    ]);
    expect(panels.map((item) => item.hidden)).toEqual([false, true, true]);
    expect(root.all().some((item) => item.tagName === "DETAILS")).toBe(false);
    tabs[0]!.fire("keydown", "ArrowLeft");
    expect(panels.map((item) => item.hidden)).toEqual([true, true, false]);
    expect(tabs[2]!.focused).toBe(true);
    tabs[2]!.fire("keydown", "Home");
    expect(tabs.map((item) => item.tabIndex)).toEqual([0, -1, -1]);
    expect(settings.isDirty()).toBe(false);
    expect(settings.selectSection("unknown")).toBe(false);
  });

  it("reveals hidden required checks before native validation and asks the parent to reveal its surface", () => {
    const { root, settings, onReveal } = form({
      kind: "url",
      role: "staging",
      url: "https://example.test",
    });
    const field = root
      .querySelectorAll("input")
      .find((item) => item.dataset.setting === "command-test")!;
    field.value = "";
    expect(field.disabled).toBe(false);
    expect(() => settings.read()).toThrow(
      "Complete the highlighted project setting",
    );
    expect(
      root.all().find((item) => item.dataset.settingsTab === "checks")?.hidden,
    ).toBe(false);
    expect(field.focused).toBe(true);
    expect(onReveal).toHaveBeenCalledWith(field);
  });

  it("preserves branch and command edits while changing sections and focuses provider requirements", () => {
    const { root, settings } = form({
      kind: "vercel",
      role: "preview",
      projectId: "prj_saved",
    });
    const field = (key: string) =>
      root
        .querySelectorAll("input,select")
        .find((item) => item.dataset.setting === key)!;
    settings.selectSection("delivery");
    field("baseBranch").value = "development";
    settings.selectSection("checks");
    field("command-install").value = "pnpm install --frozen-lockfile";
    settings.selectSection("environment");
    expect(settings.read()).toMatchObject({
      workflow: { kind: "pull-request", baseBranch: "development" },
      commands: { install: "pnpm install --frozen-lockfile" },
    });
    expect(settings.isDirty()).toBe(true);
    expect(settings.focus("projectId")).toBe(true);
    expect(field("projectId").focused).toBe(true);
    expect(settings.focus("unknown")).toBe(false);
  });

  it("keeps signals as a direct child and does not mark relocation as a config edit", () => {
    const { root, settings, signalInput } = form({
      kind: "url",
      role: "staging",
      url: "https://example.test",
    });
    const settingsRoot = root.children[0]!;
    const signals = settingsRoot.children.find(
      (item) => item.className === "project-signals-settings",
    )!;
    expect(signals.contains(signalInput)).toBe(true);
    const parentSignalsTab = new Element();
    parentSignalsTab.append(signals);
    expect(settings.isDirty()).toBe(false);
    expect(settings.read()).toMatchObject({
      verification: { mode: "browser", environment: "testing" },
    });
  });
});
