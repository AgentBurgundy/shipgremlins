import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

class Node {
  id = "";
  value = "";
  textContent = "";
  className = "";
  open = false;
  dataset: Record<string, string> = {};
  parent: Node | null = null;
  children: Node[] = [];
  handlers = new Map<string, () => void>();
  constructor(public tag: string) {}
  append(...nodes: Node[]) {
    for (const node of nodes) {
      node.parent = this;
      this.children.push(node);
    }
  }
  remove() {
    if (this.parent)
      this.parent.children = this.parent.children.filter(
        (child) => child !== this,
      );
    this.parent = null;
  }
  all(): Node[] {
    return [this, ...this.children.flatMap((child) => child.all())];
  }
  addEventListener(event: string, handler: () => void) {
    this.handlers.set(event, handler);
  }
  setAttribute() {}
  showModal() {
    this.open = true;
  }
  close() {
    this.open = false;
    this.handlers.get("close")?.();
  }
  focus() {}
  click() {
    this.handlers.get("click")?.();
  }
  dispatchEvent() {}
}
const source = readFileSync(
  new URL("../../dashboard/app.js", import.meta.url),
  "utf8",
).replaceAll("\r\n", "\n");
const start = source.indexOf("  function openPmCreation("),
  end = source.indexOf("  function closePmCreation()", start);
function fixture() {
  const fields = new Map<string, Node>(),
    body = new Node("body");
  const get = (id: string) => {
    if (!fields.has(id)) fields.set(id, new Node("input"));
    return fields.get(id)!;
  };
  get("pm-project").value = "shop";
  const keys = {
    "pm-name": "name",
    "pm-key": "key",
    "pm-paths": "paths",
    "pm-shared-paths": "sharedTouchpoints",
    "pm-schedule": "schedule",
    "pm-metric": "metric",
    "pm-wip": "wipLimit",
    "pm-verification-requirement": "verificationRequirement",
  };
  let charter: object = {};
  const fill = vi.fn((value: object) => {
    charter = value;
  });
  const context = {
    $: get,
    document: {
      body,
      activeElement: get("pm-name"),
      createElement: (tag: string) => new Node(tag),
      getElementById: (id: string) => body.all().find((node) => node.id === id),
    },
    currentStatus: { projects: [{ name: "shop" }] },
    formsLocked: false,
    pmCreating: false,
    pmKeyEdited: false,
    pmEditedFields: new Set<string>(),
    pmGeneratedValues: null,
    pmCreateTrigger: null,
    pendingPmCreate: false,
    pmInputKeys: keys,
    pmCreateDialog: new Node("dialog"),
    pmAdoption: { contextChanged: vi.fn(), open: vi.fn(), review: vi.fn() },
    pmDraft: { reset: vi.fn() },
    pmCharter: { fill },
    changePmCreationProject: vi.fn(),
    renderLinearSetup: vi.fn(),
    updatePmCreationReview: vi.fn(),
    refreshLinearResources: vi.fn(),
    message: vi.fn(),
    readPmDraft: () => ({
      ...Object.fromEntries(
        Object.entries(keys).map(([id, key]) => [key, get(id).value]),
      ),
      name: get("pm-name").value,
      key: get("pm-key").value,
      mandate: get("pm-mandate").value,
      editedFields: [...context.pmEditedFields],
      charter,
    }),
    Event: class {},
    window: {} as {
      openGremlinAdoption(
        project: string,
        trigger?: object,
        suggestion?: object,
      ): void;
    },
  };
  get("pm-name").dispatchEvent = () => {
    if (!context.pmKeyEdited)
      get("pm-key").value = get("pm-name")
        .value.toLowerCase()
        .replaceAll(" ", "-");
  };
  runInNewContext(source.slice(start, end), context);
  return {
    get,
    body,
    context,
    open: (suggestion?: object) =>
      context.window.openGremlinAdoption("shop", {}, suggestion),
    button: (label: string) =>
      body.all().find((node) => node.textContent === label)!,
  };
}
const suggested = () => ({
  name: "Pip",
  mandate: "Improve checkout completion with measurable evidence.",
  review: true,
  draft: {
    name: "Pip",
    key: "checkout",
    label: "pm:checkout",
    paths: ["src/checkout.ts", "src/cart.ts"],
    sharedTouchpoints: ["src/auth.ts"],
    schedule: "0 12 * * 1-5",
    wipLimit: 2,
    metric: "/checkout",
    verificationRequirement: "browser",
    charter: {
      goal: "Raise checkout completion",
      ambition: "Trustworthy purchase flow",
      users: ["New customers"],
    },
  },
});
describe("recommendation adoption handoff", () => {
  it("can dismiss the draft choice without changing or opening the saved draft", () => {
    const f = fixture();
    f.get("pm-name").value = "My PM";
    f.open(suggested());
    f.button("×").click();
    expect(f.get("pm-name").value).toBe("My PM");
    expect(f.body.children).toHaveLength(0);
    expect(f.context.pmCreateDialog.open).toBe(false);
    expect(f.context.pmCharter.fill).not.toHaveBeenCalled();
  });
  it("prefills the complete brief and opens review without a second generation or a save", () => {
    const f = fixture(),
      suggestion = suggested();
    f.open(suggestion);
    expect(f.get("pm-name").value).toBe("Pip");
    expect(f.get("pm-key").value).toBe("checkout");
    expect(f.get("pm-paths").value).toBe("src/checkout.ts\nsrc/cart.ts");
    expect(f.get("pm-shared-paths").value).toBe("src/auth.ts");
    expect(f.get("pm-schedule").value).toBe("0 12 * * 1-5");
    expect(f.get("pm-wip").value).toBe("2");
    expect(f.get("pm-verification-requirement").value).toBe("browser");
    expect(f.context.pmCharter.fill).toHaveBeenCalledWith(
      suggestion.draft.charter,
    );
    expect(f.context.pmAdoption.review).toHaveBeenCalledOnce();
    expect(f.context.pmCreateDialog.open).toBe(true);
    expect(f.context.pmCreateDialog.dataset.recommendationAdoption).toBe(
      "true",
    );
    expect(f.body.children).toHaveLength(0);
  });
  it("requires an explicit choice before replacing a saved human draft", () => {
    const f = fixture();
    f.get("pm-name").value = "My PM";
    f.get("pm-mandate").value = "My carefully edited responsibility.";
    f.open(suggested());
    expect(f.get("pm-name").value).toBe("My PM");
    expect(f.context.pmCreateDialog.open).toBe(false);
    expect(f.body.children[0]!.open).toBe(true);
    f.button("Keep my draft").click();
    expect(f.get("pm-mandate").value).toBe(
      "My carefully edited responsibility.",
    );
    expect(f.context.pmCharter.fill).not.toHaveBeenCalled();
    expect(f.context.pmAdoption.review).not.toHaveBeenCalled();
    expect(f.context.pmCreateDialog.dataset.recommendationAdoption).toBe(
      "false",
    );
    f.open(suggested());
    f.button("Use suggested brief").click();
    expect(f.get("pm-name").value).toBe("Pip");
    expect(f.context.pmAdoption.review).toHaveBeenCalledOnce();
    expect(f.body.children).toHaveLength(0);
  });
  it("keeps edits when reopening the same recommendation", () => {
    const f = fixture();
    f.open(suggested());
    f.get("pm-name").value = "My renamed Pip";
    f.get("pm-mandate").value = "My narrowed scope";
    f.context.pmCharter.fill.mockClear();
    f.open(suggested());
    expect(f.get("pm-name").value).toBe("My renamed Pip");
    expect(f.get("pm-mandate").value).toBe("My narrowed scope");
    expect(f.context.pmCharter.fill).not.toHaveBeenCalled();
    expect(f.body.children).toHaveLength(0);
  });
  it("keeps the manual adoption path and refuses replacement while locked", () => {
    const f = fixture();
    f.open();
    expect(f.context.pmAdoption.open).toHaveBeenCalledWith({
      preselected: true,
    });
    expect(f.context.pmAdoption.review).not.toHaveBeenCalled();
    f.get("pm-name").value = "My PM";
    f.open(suggested());
    f.context.formsLocked = true;
    f.button("Use suggested brief").click();
    expect(f.get("pm-name").value).toBe("My PM");
    expect(f.context.pmAdoption.review).not.toHaveBeenCalled();
  });
});
