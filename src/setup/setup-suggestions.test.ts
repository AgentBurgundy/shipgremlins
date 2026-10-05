import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { expect, it, vi } from "vitest";

class Element {
  children: Element[] = [];
  listeners = new Map<string, () => unknown>();
  dataset: Record<string, string> = {};
  attributes = new Map<string, string>();
  className = "";
  textContent = "";
  disabled = false;
  open = false;
  hidden = false;
  scrollTop = 300;
  focus = vi.fn();
  constructor(public tagName: string) {}
  append(...children: Element[]) {
    this.children.push(...children);
  }
  replaceChildren(...children: Element[]) {
    this.children = children;
  }
  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }
  showModal() {
    this.open = true;
  }
  close() {
    this.open = false;
    this.listeners.get("close")?.();
  }
  addEventListener(name: string, callback: () => unknown) {
    this.listeners.set(name, callback);
  }
  querySelector() {
    return walk(this).find((item) => item.dataset.applySuggestion);
  }
  fire() {
    if (!this.disabled) return this.listeners.get("click")?.();
  }
}
const walk = (element: Element): Element[] => [
  element,
  ...element.children.flatMap(walk),
];
const text = (element: Element): string =>
  element.textContent + element.children.map(text).join("");
const visibleText = (element: Element): string =>
  element.hidden || (element.tagName === "DIALOG" && !element.open)
    ? ""
    : element.textContent + element.children.map(visibleText).join("");
const click = (root: Element, label: string) =>
  walk(root)
    .find((item) => item.tagName === "BUTTON" && item.textContent === label)!
    .fire();
async function settled() {
  for (let index = 0; index < 8; index++) await Promise.resolve();
}

function fixture() {
  const root = new Element("DIV"),
    onSaved = vi.fn(),
    onChanged = vi.fn(),
    data = {
      state: "ready",
      revision: "project-1",
      areaRevision: "area-1",
      knowledgeRevision: "knowledge-1",
      proposal: {
        commands: {
          install: "npm ci",
          test: "npm test",
          lint: null,
          typecheck: null,
          build: null,
        },
        paths: ["src"],
        sharedTouchpoints: ["package.json"],
        evidence: ["test/app.test.js"],
        rationale: "Synthetic fixture source.",
      },
    },
    api = vi.fn(async () => data),
    window = {
      createSetupSuggestions: (_options: object) => ({
        mount: (_root: Element, _project: string, _area: string) => {},
        refresh: async (_project: string, _area: string) => {},
        protectFocus: () => false,
        setActive: (_key: string) => {},
        proposal: (_project: string, _area: string): object | undefined =>
          undefined,
      }),
    };
  runInNewContext(
    readFileSync(
      new URL("../../dashboard/setup-suggestions.js", import.meta.url),
      "utf8",
    ),
    {
      window,
      document: {
        createElement: (tag: string) => new Element(tag.toUpperCase()),
      },
    },
  );
  const view = window.createSetupSuggestions({
    api,
    onSaved,
    onChanged,
    isLocked: () => false,
  });
  view.mount(root, "app", "core");
  return { root, api, onSaved, onChanged, data, view };
}

it("keeps Learning compact and opens the full reviewed setup at its heading with a visible top Close", async () => {
  const { root, api, view } = fixture();
  await settled();
  expect(walk(root).some((item) => item.tagName === "DETAILS")).toBe(false);
  expect(visibleText(root)).toContain("Setup suggestions ready");
  expect(visibleText(root)).not.toContain("npm ci");
  expect(visibleText(root)).not.toContain("test/app.test.js");
  click(root, "Review suggested setup");
  const dialog = walk(root).find((item) => item.tagName === "DIALOG")!;
  expect(dialog.open).toBe(true);
  expect(dialog.scrollTop).toBe(0);
  expect(dialog.children[0]!.className).toBe("foundation-dialog-header");
  expect(dialog.children[0]!.children.map((item) => item.textContent)).toEqual([
    "Review suggested setup",
    "Close",
  ]);
  expect(dialog.children[0]!.children[0]!.focus).toHaveBeenCalledWith({
    preventScroll: true,
  });
  expect(visibleText(root)).toContain("npm ci");
  expect(visibleText(root)).toContain("test/app.test.js");
  expect(view.protectFocus()).toBe(true);
  expect(api).toHaveBeenCalledTimes(1);
  click(root, "Close");
  expect(dialog.open).toBe(false);
  expect(view.protectFocus()).toBe(false);
});

it.each(["commands", "ownership"])(
  "preserves %s confirmation across close/reopen and applies only that reviewed choice",
  async (apply) => {
    const { root, api, onSaved } = fixture();
    await settled();
    click(root, "Review suggested setup");
    click(
      root,
      apply === "commands" ? "Use these commands" : "Use this PM ownership",
    );
    const dialog = walk(root).find((item) => item.tagName === "DIALOG")!;
    const save = walk(root).find((item) => item.dataset.applySuggestion)!;
    expect(save.focus).toHaveBeenCalledOnce();
    expect(dialog.open).toBe(true);
    click(root, "Close");
    click(root, "Review suggested setup");
    expect(api).toHaveBeenCalledTimes(1);
    expect(text(root)).toContain("Existing automation settings stay unchanged");
    await click(root, "Apply reviewed settings");
    expect(api).toHaveBeenLastCalledWith(
      "/api/projects/app/pms/core/setup-suggestions",
      {
        revision: "project-1",
        areaRevision: "area-1",
        knowledgeRevision: "knowledge-1",
        apply,
      },
    );
    expect(onSaved).toHaveBeenCalledOnce();
    expect(text(root)).toContain("Existing automation settings were preserved");
    expect(text(root)).not.toContain("PM remains paused");
    expect(dialog.open).toBe(false);
  },
);

it("defers changed discovery during review, then requires a fresh selection after closing", async () => {
  const { root, api, data, view } = fixture();
  await settled();
  expect(view.proposal("app", "core")).toEqual(data.proposal);
  click(root, "Review suggested setup");
  click(root, "Use these commands");
  api.mockResolvedValueOnce({
    ...data,
    knowledgeRevision: "knowledge-2",
    proposal: {
      ...data.proposal,
      commands: { ...data.proposal.commands, test: "npm run check" },
    },
  });
  await view.refresh("app", "core");
  expect(api).toHaveBeenCalledTimes(1);
  expect(visibleText(root)).not.toContain("npm run check");
  click(root, "Close");
  await settled();
  expect(api).toHaveBeenCalledTimes(2);
  click(root, "Review suggested setup");
  expect(visibleText(root)).toContain("npm run check");
  expect(visibleText(root)).not.toContain("Apply reviewed settings");
  view.setActive("");
  expect(view.protectFocus()).toBe(false);
});

it("keeps a failed apply in the open review and never misreports a successful save when refresh fails", async () => {
  const { root, api, onSaved, view } = fixture();
  await settled();
  click(root, "Review suggested setup");
  click(root, "Use this PM ownership");
  api.mockRejectedValueOnce(
    new Error("Project settings changed; refresh first."),
  );
  await click(root, "Apply reviewed settings");
  expect(visibleText(root)).toContain("Suggested settings were not applied");
  expect(view.protectFocus()).toBe(true);
  expect(onSaved).not.toHaveBeenCalled();
  onSaved.mockRejectedValueOnce(new Error("Refresh unavailable"));
  await click(root, "Apply reviewed settings");
  expect(visibleText(root)).toContain(
    "Suggested settings were saved. Reload the page",
  );
  expect(visibleText(root)).not.toContain("not applied");
});
