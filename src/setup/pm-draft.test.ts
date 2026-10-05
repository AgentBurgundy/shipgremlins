import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
const script = readFileSync(
  new URL("../../dashboard/pm-draft.js", import.meta.url),
  "utf8",
);
class Element {
  children: Element[] = [];
  listeners = new Map<string, () => unknown>();
  attributes = new Map<string, string>();
  className = "";
  textContent = "";
  hidden = false;
  disabled = false;
  type = "";
  classList = { toggle: () => {} };
  append(...items: Element[]) {
    this.children.push(...items);
  }
  replaceChildren(...items: Element[]) {
    this.children = items;
  }
  setAttribute(key: string, value: string) {
    this.attributes.set(key, value);
  }
  addEventListener(name: string, fn: () => unknown) {
    this.listeners.set(name, fn);
  }
  async emit(name: string) {
    await this.listeners.get(name)?.();
  }
}
const input = () => ({
  project: "storefront",
  mandate: "Explore imports using synthetic contacts only.",
  name: "",
  key: "",
  paths: "",
  sharedTouchpoints: "",
  metric: "",
  schedule: "0 13 * * 1-5",
  wipLimit: "1",
});
const plan = () => ({
  draft: {
    name: "Import quality",
    key: "imports",
    paths: ["src/import/"],
    sharedTouchpoints: ["src/shared/"],
    metric: "import-completed",
    schedule: "0 13 * * 1-5",
    wipLimit: 1,
  },
  rationale: "Focus on import validation and recovery.",
  repository: {
    provider: "github",
    repo: "example/storefront",
    branch: "main",
    pathCount: 143,
    truncated: false,
  },
  warnings: ["Review owned paths before creating this PM."],
});
function fixture(api: (...args: unknown[]) => unknown = async () => plan()) {
  let current = input();
  const window = {} as {
    createPmDraft: (
      root: Element,
      options: object,
    ) => {
      refresh: () => void;
      reset: () => void;
      isBusy: () => boolean;
      hasDraft: () => boolean;
      setLocked: (value: boolean) => void;
    };
  };
  runInNewContext(script, {
    window,
    document: { createElement: () => new Element() },
  });
  const root = new Element(),
    requests = vi.fn(api),
    apply = vi.fn(),
    busy = vi.fn(),
    error = vi.fn();
  const helper = window.createPmDraft(root, {
    api: requests,
    getInput: () => current,
    onApply: apply,
    onBusy: busy,
    onError: error,
  });
  const all = () => {
    const visit = (element: Element): Element[] => [
      element,
      ...element.children.flatMap(visit),
    ];
    return visit(root);
  };
  const button = (name: string) =>
    all().find(
      (element) => element.type === "button" && element.textContent === name,
    )!;
  const status = () =>
    all().find((element) => element.className.includes("pm-ai-draft-status"))!;
  return {
    helper,
    requests,
    apply,
    busy,
    error,
    button,
    status,
    all,
    get: () => current,
    set: (value: Partial<ReturnType<typeof input>>) => {
      current = { ...current, ...value };
      helper.refresh();
    },
  };
}
function deferred() {
  let resolve!: (value: unknown) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe("PM draft suggestions", () => {
  it("requests only the mandate, previews every suggestion, and never creates or applies automatically", async () => {
    const f = fixture();
    expect(f.requests).not.toHaveBeenCalled();
    await f.button("Fill with AI").emit("click");
    expect(f.requests).toHaveBeenCalledWith(
      "/api/projects/storefront/pm-plan",
      { mandate: input().mandate },
      "POST",
      200000,
    );
    expect(f.apply).not.toHaveBeenCalled();
    expect(f.helper.hasDraft()).toBe(true);
    expect(f.get()).toEqual(input());
    for (const value of [
      "Import quality",
      "imports",
      "src/import/",
      "src/shared/",
      "import-completed",
      "0 13 * * 1-5",
      "1",
      "Focus on import validation and recovery.",
    ])
      expect(f.all().some((element) => element.textContent === value)).toBe(
        true,
      );
    expect(
      f
        .all()
        .some((element) =>
          element.textContent.includes("143 repository paths"),
        ),
    ).toBe(true);
  });
  it("only applies allowed draft fields after explicit action, preserving original mandate and mapping controls", async () => {
    const response = {
      ...plan(),
      draft: {
        ...plan().draft,
        mandate: "Replace your mandate",
        enabled: true,
        linearProjectId: "foreign",
      },
    };
    const f = fixture(async () => response);
    await f.button("Fill with AI").emit("click");
    await f.button("Apply suggestions").emit("click");
    expect(f.apply).toHaveBeenCalledWith(plan().draft, input());
    expect(f.get().mandate).toBe(input().mandate);
    expect(f.helper.hasDraft()).toBe(false);
    expect(f.requests).toHaveBeenCalledTimes(1);
    expect(f.status().textContent).toContain(
      "Nothing has been created or enabled",
    );
  });
  it("blocks stale suggestions when fields change during the request", async () => {
    const pending = deferred(),
      f = fixture(() => pending.promise);
    const request = f.button("Fill with AI").emit("click");
    f.set({ name: "My own PM name" });
    pending.resolve(plan());
    await request;
    expect(f.button("Apply suggestions").disabled).toBe(true);
    await f.button("Apply suggestions").emit("click");
    expect(f.apply).not.toHaveBeenCalled();
    expect(f.get().name).toBe("My own PM name");
    expect(f.status().textContent).toContain("form changed");
  });
  it("checks the full snapshot again immediately before Apply, including project changes", async () => {
    const f = fixture();
    await f.button("Fill with AI").emit("click");
    f.set({ project: "other-app" });
    await f.button("Apply suggestions").emit("click");
    expect(f.apply).not.toHaveBeenCalled();
    expect(f.button("Apply suggestions").disabled).toBe(true);
  });
  it("ignores an old response after reset and a new project request", async () => {
    const pending = deferred();
    let count = 0;
    const f = fixture(() =>
      ++count === 1
        ? pending.promise
        : { ...plan(), draft: { ...plan().draft, name: "Second project PM" } },
    );
    const old = f.button("Fill with AI").emit("click");
    f.helper.reset();
    f.set({ project: "other-app" });
    await f.button("Fill with AI").emit("click");
    pending.resolve(plan());
    await old;
    expect(
      f.all().some((element) => element.textContent === "Second project PM"),
    ).toBe(true);
    expect(
      f.all().some((element) => element.textContent === "Import quality"),
    ).toBe(false);
    expect(f.helper.isBusy()).toBe(false);
  });
  it("discards the suggestion without changing the form or calling another endpoint", async () => {
    const f = fixture();
    await f.button("Fill with AI").emit("click");
    await f.button("Discard").emit("click");
    expect(f.helper.hasDraft()).toBe(false);
    expect(f.get()).toEqual(input());
    expect(f.requests).toHaveBeenCalledTimes(1);
    expect(f.apply).not.toHaveBeenCalled();
  });
  it("contains planner failures and invalid responses without altering form values", async () => {
    const f = fixture(async () => {
      throw new Error("Connect Claude Code first.");
    });
    await f.button("Fill with AI").emit("click");
    expect(f.status().textContent).toBe("Connect Claude Code first.");
    expect(f.helper.isBusy()).toBe(false);
    expect(f.get()).toEqual(input());
    const invalid = fixture(async () => ({
      ...plan(),
      draft: { ...plan().draft, wipLimit: 0 },
    }));
    await invalid.button("Fill with AI").emit("click");
    expect(invalid.helper.hasDraft()).toBe(false);
    expect(invalid.apply).not.toHaveBeenCalled();
  });
  it("does not request a draft before a project and mandate are entered or while locked", async () => {
    const f = fixture();
    f.set({ mandate: "" });
    await f.button("Fill with AI").emit("click");
    expect(f.requests).not.toHaveBeenCalled();
    f.set({ mandate: input().mandate });
    f.helper.setLocked(true);
    await f.button("Fill with AI").emit("click");
    expect(f.requests).not.toHaveBeenCalled();
  });
  it("renders untrusted response text as text nodes and exposes partial-tree warnings", async () => {
    const f = fixture(async () => ({
      ...plan(),
      rationale: "<img src=x onerror=alert(1)>",
      repository: { ...plan().repository, truncated: true },
    }));
    await f.button("Fill with AI").emit("click");
    expect(
      f
        .all()
        .some(
          (element) => element.textContent === "<img src=x onerror=alert(1)>",
        ),
    ).toBe(true);
    expect(
      f.all().some((element) => element.textContent.includes("partial tree")),
    ).toBe(true);
  });
});
