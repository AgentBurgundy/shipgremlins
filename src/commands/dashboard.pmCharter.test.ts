import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

class Element {
  children: Element[] = [];
  parentElement: Element | null = null;
  attributes = new Map<string, string>();
  listeners = new Map<
    string,
    (event: { key: string; preventDefault(): void }) => void
  >();
  classes = new Set<string>();
  classList = { add: (name: string) => this.classes.add(name) };
  dataset: Record<string, string> = {};
  className = "";
  id = "";
  value = "";
  textContent = "";
  hidden = false;
  open = false;
  focused = false;
  tabIndex = 0;
  maxLength = 0;
  constructor(public tagName: string) {}
  append(...children: Element[]) {
    for (const child of children) {
      child.parentElement = this;
      this.children.push(child);
    }
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
}
interface Charter {
  ambition?: string;
  goal?: string;
  metricDefinition?: string;
  users?: string[];
  expectedToBuild?: string[];
  nonGoals?: string[];
  guardrails?: string[];
  standingPriorities?: string[];
}
function fixture(initial: Charter = {}, prefix = "test-charter") {
  const root = new Element("DIV");
  const window = {} as {
    createPmCharter: (
      root: Element,
      prefix: string,
      initial: Charter,
    ) => {
      fill(value: Charter): void;
      read(): Charter;
      reset(): void;
      focus(key: string): boolean;
    };
  };
  runInNewContext(
    readFileSync(
      new URL("../../dashboard/pm-charter.js", import.meta.url),
      "utf8",
    ),
    {
      window,
      document: {
        createElement: (tag: string) => new Element(tag.toUpperCase()),
      },
      queueMicrotask,
    },
  );
  const editor = window.createPmCharter(root, prefix, initial);
  const tabs = root
    .all()
    .filter((element) => element.attributes.get("role") === "tab");
  const panels = root
    .all()
    .filter((element) => element.attributes.get("role") === "tabpanel");
  const input = (key: string) =>
    root.all().find((element) => element.dataset.charterKey === key)!;
  return { root, editor, tabs, panels, input };
}

describe("tabbed PM product brief", () => {
  it("shows three accessible tabs with one active panel and every original field", () => {
    const f = fixture();
    expect(f.tabs.map((tab) => tab.textContent)).toEqual([
      "Direction",
      "People & scope",
      "Boundaries",
    ]);
    expect(f.panels.map((panel) => panel.hidden)).toEqual([false, true, true]);
    expect(f.tabs.map((tab) => tab.tabIndex)).toEqual([0, -1, -1]);
    expect(
      f.root.all().filter((element) => element.tagName === "TEXTAREA"),
    ).toHaveLength(8);
    expect(f.root.all().some((element) => element.tagName === "DETAILS")).toBe(
      false,
    );
    f.tabs.forEach((tab, index) => {
      expect(tab.attributes.get("aria-controls")).toBe(f.panels[index]!.id);
      expect(f.panels[index]!.attributes.get("aria-labelledby")).toBe(tab.id);
    });
  });

  it("supports roving keyboard tabs, wraps with arrows, and retains edits", () => {
    const f = fixture();
    f.input("ambition").value = "Saved across tabs";
    f.tabs[0]!.fire("keydown", "ArrowLeft");
    expect(f.panels.map((panel) => panel.hidden)).toEqual([true, true, false]);
    expect(f.tabs[2]!.focused).toBe(true);
    f.tabs[2]!.fire("keydown", "ArrowRight");
    expect(f.tabs[0]!.attributes.get("aria-selected")).toBe("true");
    f.tabs[0]!.fire("keydown", "End");
    expect(f.tabs[2]!.attributes.get("aria-selected")).toBe("true");
    f.tabs[2]!.fire("keydown", "Home");
    expect(f.tabs[0]!.attributes.get("aria-selected")).toBe("true");
    f.tabs[1]!.fire("click");
    expect(f.input("ambition").value).toBe("Saved across tabs");
    expect(f.editor.read()).toEqual({ ambition: "Saved across tabs" });
  });

  it("roundtrips AI-generated content in all tabs and keeps list normalization", () => {
    const values: Charter = {
      ambition: "Build trust",
      goal: "Fewer failures",
      metricDefinition: "Measured success",
      users: ["Developers", "Owners"],
      expectedToBuild: ["Live status"],
      nonGoals: ["New payment system"],
      guardrails: ["No production writes"],
      standingPriorities: ["Accessibility"],
    };
    const f = fixture(values);
    expect(f.editor.read()).toEqual(values);
    f.tabs[2]!.fire("click");
    f.editor.fill({ ...values, goal: "Clear progress" });
    expect(f.editor.read()).toEqual({ ...values, goal: "Clear progress" });
    expect(f.tabs[2]!.attributes.get("aria-selected")).toBe("true");
    f.input("users").value = " Owners \r\n\r\n Developers ";
    expect(f.editor.read().users).toEqual(["Owners", "Developers"]);
    f.editor.reset();
    expect(f.editor.read()).toEqual({});
    expect(f.panels.map((panel) => panel.hidden)).toEqual([false, true, true]);
  });

  it("reveals and focuses the first invalid field without hiding it for later invalid fields", async () => {
    const f = fixture();
    const legacyWrapper = new Element("DETAILS");
    legacyWrapper.append(f.root);
    f.input("users").fire("invalid");
    f.input("guardrails").fire("invalid");
    expect(f.panels.map((panel) => panel.hidden)).toEqual([true, false, true]);
    expect(f.input("users").focused).toBe(true);
    expect(legacyWrapper.open).toBe(true);
    await Promise.resolve();
    f.input("guardrails").fire("invalid");
    expect(f.panels.map((panel) => panel.hidden)).toEqual([true, true, false]);
  });

  it("supports targeted focus with unique IDs and keeps existing input limits", () => {
    const f = fixture({}, "edit-charter");
    expect(f.editor.focus("expectedToBuild")).toBe(true);
    expect(f.panels[1]!.hidden).toBe(false);
    expect(f.input("expectedToBuild").focused).toBe(true);
    expect(f.input("expectedToBuild").id).toBe("edit-charter-expectedToBuild");
    expect(f.input("expectedToBuild").maxLength).toBe(20020);
    expect(f.input("ambition").maxLength).toBe(4000);
    expect(f.input("ambition").attributes.get("aria-describedby")).toBe(
      "edit-charter-ambition-help",
    );
    expect(f.editor.focus("unknown")).toBe(false);
  });
});
