import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
class Element {
  children: Element[] = [];
  dataset: Record<string, string> = {};
  listeners = new Map<string, () => void>();
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
    this.children.push(...items);
  }
  replaceChildren(...items: Element[]) {
    this.children = items;
  }
  setAttribute() {}
  addEventListener(name: string, listener: () => void) {
    this.listeners.set(name, listener);
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
    return !this.required || Boolean(this.value);
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
  const window = {
    createSignalsSettings: () => ({
      isDirty: () => false,
      read: () => ({}),
      setProjectName() {},
      focusProvider() {},
    }),
    createProjectSettings: (
      _container: Element,
      _prefix: string,
      _config: object,
    ): { read(): Record<string, unknown> } => {
      throw new Error("not loaded");
    },
  };
  runInNewContext(
    readFileSync(
      new URL("../../dashboard/project-settings.js", import.meta.url),
      "utf8",
    ),
    { window, document, Option, structuredClone },
  );
  const root = new Element(),
    config = {
      environments: { testing: target },
      verification: { mode: "browser", environment: "testing" },
      workflow: { kind: "pull-request", baseBranch: "main" },
      commands: { install: "npm ci", test: "npm test" },
    };
  const settings = window.createProjectSettings(root, "edit", config);
  return { root, settings };
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
});
