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
  charter: {} as Record<string, string | string[]>,
  editedFields: [] as string[],
  project: "storefront",
  mandate: "Explore imports using synthetic contacts only.",
  name: "",
  key: "",
  paths: "",
  sharedTouchpoints: "",
  metric: "",
  schedule: "0 13 * * 1-5",
  wipLimit: "3",
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
    charter: {
      ambition: "Make imports predictable.",
      goal: "Reduce failed imports.",
      metricDefinition: "Successful synthetic imports with recoverable errors.",
      users: ["Workspace admins"],
      expectedToBuild: ["Clear import validation"],
      nonGoals: ["Production data migration"],
      guardrails: ["Synthetic contacts only"],
      standingPriorities: ["Actionable error messages"],
    },
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
    mergePmDraft: (
      input: unknown,
      draft: unknown,
      previousGenerated?: unknown,
    ) => {
      values: ReturnType<typeof plan>["draft"];
      kept: string[];
      filled: string[];
    };
    createPmDraft: (
      root: Element,
      options: object,
    ) => {
      refresh: () => void;
      generate: () => Promise<void>;
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
    merge: window.mergePmDraft,
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
  it("refreshes untouched AI suggestions for a changed mission while retaining human edits", () => {
    const f = fixture();
    const previous = {
      ...input(),
      ...plan().draft,
      paths: "src/import/",
      sharedTouchpoints: "src/shared/",
      wipLimit: "1",
    };
    const current = {
      ...previous,
      mandate: "Focus on export recovery instead.",
      name: "Moss",
      editedFields: ["name"],
      charter: {
        ...previous.charter,
        guardrails: ["Keep my synthetic-only rule"],
      },
    };
    const next = {
      ...plan().draft,
      name: "Export quality",
      key: "exports",
      paths: ["src/export/"],
      charter: { ...plan().draft.charter, goal: "Reduce failed exports." },
    };
    const result = f.merge(current, next, previous);
    expect(result.values.name).toBe("Moss");
    expect(result.values.key).toBe("exports");
    expect(result.values.paths).toEqual(["src/export/"]);
    expect(result.values.charter.goal).toBe("Reduce failed exports.");
    expect(result.values.charter.guardrails).toEqual([
      "Keep my synthetic-only rule",
    ]);
    expect(current.mandate).toBe("Focus on export recovery instead.");
  });

  it("does not discard fields authored before the first AI plan when regenerating", () => {
    const f = fixture();
    const current = {
      ...input(),
      name: "Moss",
      charter: { goal: "My own product direction" },
    };
    const generated = {
      key: "imports",
      charter: { ambition: "An AI-generated ambition" },
    };
    const result = f.merge(current, plan().draft, generated);
    expect(result.values.name).toBe("Moss");
    expect(result.values.charter.goal).toBe("My own product direction");
  });
  it("lets adoption invoke the same guarded draft action without a duplicate request", async () => {
    const request = deferred();
    const f = fixture(() => request.promise);
    const first = f.helper.generate();
    await f.helper.generate();
    expect(f.requests).toHaveBeenCalledTimes(1);
    request.resolve(plan());
    await first;
    expect(f.apply).toHaveBeenCalledWith(plan().draft, input());
  });
  it("fills the complete setup from one action and never creates the PM", async () => {
    const f = fixture();
    expect(f.requests).not.toHaveBeenCalled();
    await f.button("Fill with AI").emit("click");
    expect(f.requests).toHaveBeenCalledWith(
      "/api/projects/storefront/pm-plan",
      { mandate: input().mandate },
      "POST",
      200000,
    );
    expect(f.apply).toHaveBeenCalledWith(plan().draft, input());
    expect(f.helper.hasDraft()).toBe(false);
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
      "Make imports predictable.",
      "Workspace admins",
      "pm:imports",
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
  it("only fills allowed draft fields, preserving original mandate and mapping controls", async () => {
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
    expect(f.apply).toHaveBeenCalledWith(plan().draft, input());
    expect(f.get().mandate).toBe(input().mandate);
    expect(f.helper.hasDraft()).toBe(false);
    expect(f.requests).toHaveBeenCalledTimes(1);
    expect(f.status().textContent).toContain(
      "Draft filled. Review below, then Create PM.",
    );
  });
  it("blocks stale suggestions when fields change during the request", async () => {
    const pending = deferred(),
      f = fixture(() => pending.promise);
    const request = f.button("Fill with AI").emit("click");
    f.set({ name: "My own PM name" });
    pending.resolve(plan());
    await request;
    expect(f.apply).not.toHaveBeenCalled();
    expect(f.get().name).toBe("My own PM name");
    expect(f.status().textContent).toContain("form changed");
  });
  it("checks the full snapshot including project changes before filling", async () => {
    const pending = deferred(),
      f = fixture(() => pending.promise);
    const request = f.button("Fill with AI").emit("click");
    f.set({ project: "other-app" });
    pending.resolve(plan());
    await request;
    expect(f.apply).not.toHaveBeenCalled();
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
  it("hides the AI summary without clearing filled fields or calling another endpoint", async () => {
    const f = fixture();
    await f.button("Fill with AI").emit("click");
    await f.button("Hide AI summary").emit("click");
    expect(f.helper.hasDraft()).toBe(false);
    expect(f.get()).toEqual(input());
    expect(f.requests).toHaveBeenCalledTimes(1);
    expect(f.apply).toHaveBeenCalledTimes(1);
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
  it("fills blanks/defaults while keeping typed values and product brief entries", () => {
    const f = fixture();
    const original = {
      ...input(),
      name: "My import PM",
      paths: "src/owned/",
      metric: "/",
      editedFields: ["metric"],
      charter: { goal: "Keep my goal", users: ["My audience"] },
    };
    const result = f.merge(original, plan().draft);
    expect(result.values).toMatchObject({
      name: "My import PM",
      paths: ["src/owned/"],
      metric: "/",
      wipLimit: 1,
      charter: {
        goal: "Keep my goal",
        users: ["My audience"],
        ambition: "Make imports predictable.",
      },
    });
    expect(original.charter).toEqual({
      goal: "Keep my goal",
      users: ["My audience"],
    });
    expect(result.kept).toContain("metric");
    expect(result.filled).toContain("wipLimit");
  });
  it("rejects missing charter fields and strips injected charter properties", async () => {
    const invalid = fixture(async () => ({
      ...plan(),
      draft: { ...plan().draft, charter: { goal: "Partial" } },
    }));
    await invalid.button("Fill with AI").emit("click");
    expect(invalid.apply).not.toHaveBeenCalled();
    const safe = fixture(async () => ({
      ...plan(),
      draft: {
        ...plan().draft,
        charter: {
          ...plan().draft.charter,
          enabled: true,
          mandate: "Injected",
        },
      },
    }));
    await safe.button("Fill with AI").emit("click");
    expect(safe.apply).toHaveBeenCalledWith(plan().draft, input());
  });
});
