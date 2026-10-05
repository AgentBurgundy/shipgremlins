import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

class Element {
  children: Element[] = [];
  parentElement: Element | null = null;
  listeners = new Map<
    string,
    (event: { key: string; preventDefault(): void }) => void
  >();
  attributes = new Map<string, string>();
  dataset: Record<string, string> = {};
  className = "";
  textContent = "";
  id = "";
  value = "";
  pattern = "";
  required = false;
  disabled = false;
  checked = false;
  focused = false;
  hidden = false;
  open = false;
  tabIndex = 0;
  constructor(public tagName: string) {}
  append(...children: Element[]) {
    for (const child of children) {
      child.parentElement = this;
      this.children.push(child);
    }
  }
  replaceChildren(...children: Element[]) {
    this.children = [];
    this.append(...children);
  }
  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }
  addEventListener(
    name: string,
    callback: (event: { key: string; preventDefault(): void }) => void,
  ) {
    this.listeners.set(name, callback);
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
  contains(item: Element) {
    return this.all().includes(item);
  }
  scrollIntoView() {}
  get form(): Element | null {
    let parent = this.parentElement;
    while (parent && parent.tagName !== "FORM") parent = parent.parentElement;
    return parent;
  }
  get invalid() {
    if (!["INPUT", "SELECT"].includes(this.tagName)) return false;
    if (this.disabled) return false;
    for (let item = this.parentElement; item; item = item.parentElement)
      if (item.disabled) return false;
    return (
      (this.required && !this.value) ||
      Boolean(
        this.value &&
        this.pattern &&
        !new RegExp(`^(?:${this.pattern})$`).test(this.value),
      )
    );
  }
  querySelector() {
    return this.all().find((item) => item.invalid);
  }
  reportValidity() {
    if (this.invalid) this.fire("invalid");
    return !this.invalid;
  }
}

function fixture() {
  const form = new Element("FORM"),
    surface = new Element("SECTION"),
    wrapper = new Element("DETAILS");
  surface.hidden = true;
  surface.append(wrapper);
  form.append(surface);
  const onReveal = vi.fn(() => {
    surface.hidden = false;
  });
  const window = {} as {
    createSignalsSettings(
      root: Element,
      prefix: string,
      value: object,
      options: object,
    ): {
      read(): object;
      isDirty(): boolean;
      selectProvider(provider: string): boolean;
      focusProvider(provider: string): void;
    };
  };
  class Option extends Element {
    constructor(value: string) {
      super("OPTION");
      this.value = this.textContent = value;
    }
  }
  runInNewContext(
    readFileSync(
      new URL("../../dashboard/signals-settings.js", import.meta.url),
      "utf8",
    ),
    {
      window,
      document: {
        createElement: (tag: string) => new Element(tag.toUpperCase()),
        createTextNode: (text: string) =>
          Object.assign(new Element("#TEXT"), { textContent: text }),
      },
      Option,
      structuredClone,
      queueMicrotask,
    },
  );
  const settings = window.createSignalsSettings(
    wrapper,
    "edit-signals",
    {
      sentry: {
        host: "sentry.io",
        organization: "team",
        project: "app",
        environment: "preview",
        tokenSecret: "SENTRY_AUTH_TOKEN_APP",
      },
    },
    { onReveal },
  );
  const input = (key: string) =>
    form.all().find((item) => item.dataset.setting === key)!;
  const provider = form
    .all()
    .find((item) => item.dataset.signalProvider === "sentry")!;
  const advanced = provider
    .all()
    .find((item) => item.className === "signal-secret-references")!;
  return {
    form,
    surface,
    wrapper,
    provider,
    advanced,
    settings,
    input,
    onReveal,
  };
}

describe("Signals provider tabs and validation", () => {
  it("shows one provider at a time with accessible keyboard tabs and retained drafts", () => {
    const f = fixture();
    const tabs = f.form
      .all()
      .filter((item) => item.attributes.get("role") === "tab");
    const panels = f.form
      .all()
      .filter((item) => item.attributes.get("role") === "tabpanel");
    expect(tabs.map((item) => item.textContent)).toEqual([
      "Sentry",
      "Datadog",
      "Mixpanel",
    ]);
    expect(panels.map((item) => item.hidden)).toEqual([false, true, true]);
    expect(panels.every((item) => item.tagName === "SECTION")).toBe(true);
    tabs.forEach((tab, index) => {
      expect(tab.attributes.get("aria-controls")).toBe(panels[index]!.id);
      expect(panels[index]!.attributes.get("aria-labelledby")).toBe(tab.id);
    });
    expect(f.settings.isDirty()).toBe(false);
    tabs[0]!.fire("keydown", "ArrowLeft");
    expect(panels.map((item) => item.hidden)).toEqual([true, true, false]);
    expect(tabs[2]!.focused).toBe(true);
    tabs[2]!.fire("keydown", "ArrowRight");
    expect(tabs.map((item) => item.tabIndex)).toEqual([0, -1, -1]);
    tabs[0]!.fire("keydown", "End");
    tabs[2]!.fire("keydown", "Home");
    expect(panels[0]!.hidden).toBe(false);
    const scope = f.input("sentry-project");
    scope.value = "draft-scope";
    scope.fire("input");
    tabs[1]!.fire("click");
    tabs[0]!.fire("click");
    expect(scope.value).toBe("draft-scope");
    expect(f.settings.read()).toMatchObject({
      sentry: { project: "draft-scope" },
    });
    expect(f.settings.selectProvider("unknown")).toBe(false);
  });

  it("reveals provider, credential references, and containing surface before focusing a required field", () => {
    const f = fixture(),
      input = f.input("sentry-tokenSecret");
    f.settings.selectProvider("mixpanel");
    input.value = "";
    input.fire("input");
    expect(input.reportValidity()).toBe(false);
    expect([f.wrapper.open, !f.provider.hidden, !f.advanced.hidden]).toEqual([
      true,
      true,
      true,
    ]);
    expect(f.surface.hidden).toBe(false);
    expect(f.onReveal).toHaveBeenCalledWith(input);
    expect(input.focused).toBe(true);
    expect(() => f.settings.read()).toThrow("credential variable name");
  });

  it("keeps focus on the first invalid field and allows a later validation attempt to reveal the next", async () => {
    const f = fixture(),
      scope = f.input("sentry-organization"),
      secret = f.input("sentry-tokenSecret");
    scope.value = secret.value = "";
    scope.reportValidity();
    secret.reportValidity();
    expect(scope.focused).toBe(true);
    expect(secret.focused).toBe(false);
    expect(f.advanced.hidden).toBe(true);
    await Promise.resolve();
    scope.value = "team";
    secret.reportValidity();
    expect(secret.focused).toBe(true);
    expect(f.advanced.hidden).toBe(false);
  });

  it("does not steal focus from an invalid field elsewhere in the parent form", () => {
    const f = fixture(),
      other = new Element("INPUT"),
      secret = f.input("sentry-tokenSecret");
    other.required = true;
    other.parentElement = f.form;
    f.form.children.unshift(other);
    secret.value = "invalid-token-value";
    secret.reportValidity();
    expect(secret.focused).toBe(false);
    expect(f.advanced.hidden).toBe(true);
    expect(f.onReveal).not.toHaveBeenCalled();
  });

  it("ignores disabled provider fields without discarding their draft values", () => {
    const f = fixture(),
      toggle = f.input("sentry-enabled"),
      secret = f.input("sentry-tokenSecret");
    secret.value = "SENTRY_AUTH_TOKEN_CUSTOM";
    secret.fire("input");
    toggle.checked = false;
    toggle.fire("change");
    const fields = f.provider
      .all()
      .find((item) => item.tagName === "FIELDSET")!;
    expect(fields.hidden).toBe(true);
    expect(secret.reportValidity()).toBe(true);
    expect(f.settings.read()).toEqual({});
    toggle.checked = true;
    toggle.fire("change");
    expect(fields.hidden).toBe(false);
    expect(f.settings.read()).toMatchObject({
      sentry: { tokenSecret: "SENTRY_AUTH_TOKEN_CUSTOM" },
    });
    expect(f.onReveal).not.toHaveBeenCalled();
  });

  it("offers an explicit credential-reference toggle and targeted provider focus", () => {
    const f = fixture();
    const toggle = f.provider
      .all()
      .find((item) => item.attributes.get("aria-controls") === f.advanced.id)!;
    expect(toggle.attributes.get("aria-expanded")).toBe("false");
    toggle.fire("click");
    expect(f.advanced.hidden).toBe(false);
    expect(toggle.attributes.get("aria-expanded")).toBe("true");
    toggle.fire("click");
    expect(f.advanced.hidden).toBe(true);
    f.settings.focusProvider("datadog");
    expect(f.input("datadog-enabled").focused).toBe(true);
    expect(f.onReveal).toHaveBeenCalledWith(f.input("datadog-enabled"));
    expect(
      f.form.all().find((item) => item.dataset.signalProvider === "datadog")
        ?.hidden,
    ).toBe(false);
    expect(f.settings.isDirty()).toBe(false);
  });
});
