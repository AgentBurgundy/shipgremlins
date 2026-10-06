import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

class Element {
  children: Element[] = [];
  parent: Element | null = null;
  tagName: string;
  className = "";
  textContent = "";
  disabled = false;
  checked = false;
  attributes = new Map<string, string>();
  listeners = new Map<string, () => unknown>();
  constructor(tag: string) {
    this.tagName = tag.toUpperCase();
  }
  append(...items: Element[]) {
    for (const item of items) {
      if (item.parent)
        item.parent.children = item.parent.children.filter(
          (child) => child !== item,
        );
      item.parent = this;
      this.children.push(item);
    }
  }
  replaceChildren(...items: Element[]) {
    this.children.forEach((item) => {
      item.parent = null;
    });
    this.children = [];
    this.append(...items);
  }
  contains(item: Element) {
    return walk(this).includes(item);
  }
  setAttribute(key: string, value: string) {
    this.attributes.set(key, value);
  }
  addEventListener(event: string, fn: () => unknown) {
    this.listeners.set(event, fn);
  }
  fire(event: string) {
    if (event === "click" && this.disabled) return;
    return this.listeners.get(event)?.();
  }
}
const walk = (root: Element): Element[] => [
  root,
  ...root.children.flatMap(walk),
];
const text = (root: Element) =>
  walk(root)
    .map((item) => item.textContent)
    .join(" ");
const byText = (root: Element, label: string) =>
  walk(root).find((item) => item.textContent === label)!;
const settle = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};
const setup = (confirmed = false) => ({
  revision: confirmed ? "saved-report-revision" : "reviewed-report-revision",
  configurationRevision: confirmed
    ? "saved-config-revision"
    : "reviewed-config-revision",
  status: "analyzed",
  stale: false,
  setupConfirmation: { confirmed },
  report: {
    summary: "Existing real app.",
    stack: ["Node"],
    warnings: [],
    repository: {
      sha: "a".repeat(40),
      branch: "main",
      filesRead: ["package.json"],
    },
    projectSetup: {
      commands: {
        test: {
          command: "npm test",
          rationale: "Existing script.",
          evidence: [{ path: "package.json", quote: "test" }],
        },
        build: {
          command: "npm run build",
          rationale: "Existing build.",
          evidence: [{ path: "package.json", quote: "build" }],
        },
      },
      firstPm: {
        name: "Pip",
        mandate: "Understand this actual app before suggesting changes.",
        evidence: [{ path: "package.json", quote: "test" }],
      },
    },
  },
});
type Api = (url: string, body?: unknown) => Promise<unknown>;
function fixture(api: Api, onSaved = vi.fn(async () => {})) {
  const root = new Element("main"),
    project = { name: "app", instanceId: "current" },
    pages = { current: "project", project: "app", pm: "", tab: "overview" };
  const events = new Map<string, () => void>(),
    timers = new Map<number, () => void>();
  let timerId = 0,
    locked = false;
  const document = {
    hidden: false,
    activeElement: null as Element | null,
    createElement: (tag: string) => new Element(tag),
    addEventListener: (name: string, handler: () => void) =>
      events.set(name, handler),
    removeEventListener: (name: string) => events.delete(name),
  };
  const window = {
    addEventListener: (name: string, handler: () => void) =>
      events.set(name, handler),
    removeEventListener: (name: string) => events.delete(name),
  } as unknown as {
    createProjectWelcome(options: object): {
      mount(root: Element, project: object): void;
      refresh(name: string): Promise<void>;
      resume(projects: object[]): void;
      destroy(): void;
      isBusy(): boolean;
    };
  };
  runInNewContext(
    readFileSync(
      new URL("../../dashboard/project-welcome.js", import.meta.url),
      "utf8",
    ),
    {
      window,
      document,
      setTimeout: (handler: () => void) => {
        timers.set(++timerId, handler);
        return timerId;
      },
      clearTimeout: (id: number) => timers.delete(id),
    },
  );
  const onCreatePm = vi.fn(),
    view = window.createProjectWelcome({
      api,
      pages,
      isLocked: () => locked,
      onSaved,
      onCreatePm,
    });
  view.mount(root, project);
  return {
    root,
    project,
    view,
    onCreatePm,
    onSaved,
    document,
    events,
    timers,
    setLocked: (value: boolean) => {
      locked = value;
    },
  };
}
describe("repository-first project welcome", () => {
  it("only reads on mount and requires exact selected commands plus reviewed revisions to confirm", async () => {
    const api = vi.fn(async (_url: string, body?: unknown) =>
      body ? setup(true) : setup(),
    );
    const f = fixture(api);
    await settle();
    expect(api).toHaveBeenCalledExactlyOnceWith("/api/projects/app/onboarding");
    expect(f.onCreatePm).not.toHaveBeenCalled();
    const build = walk(f.root).find(
      (item) =>
        item.attributes.get("aria-label") === "Save build the app command",
    )!;
    build.checked = false;
    build.fire("change");
    await byText(f.root, "Confirm setup").fire("click");
    await settle();
    expect(api).toHaveBeenLastCalledWith(
      "/api/projects/app/onboarding/confirm",
      {
        revision: "reviewed-report-revision",
        configurationRevision: "reviewed-config-revision",
        repositorySha: "a".repeat(40),
        commandKeys: ["test"],
      },
    );
    expect(f.onCreatePm).not.toHaveBeenCalled();
    expect(text(f.root)).toContain("Meet your first investigator.");
    f.view.destroy();
  });
  it("keeps accepted confirmation and adoption available if only dashboard refresh fails", async () => {
    const api = vi.fn(async (_url: string, body?: unknown) =>
        body ? setup(true) : setup(),
      ),
      onSaved = vi.fn(async () => {
        throw new Error("Refresh failed");
      });
    const f = fixture(api, onSaved);
    await settle();
    await byText(f.root, "Confirm setup").fire("click");
    await settle();
    expect(text(f.root)).toContain(
      "Setup saved. The dashboard could not refresh",
    );
    expect(byText(f.root, "Meet Pip").disabled).toBe(false);
    byText(f.root, "Meet Pip").fire("click");
    expect(f.onCreatePm).toHaveBeenCalledWith("app", {
      name: "Pip",
      mandate: setup().report.projectSetup.firstPm.mandate,
    });
    expect(
      api.mock.calls.filter(([, body]) => body !== undefined),
    ).toHaveLength(1);
    f.view.destroy();
  });
  it("does not allow a late read to replace a successful confirmation", async () => {
    let reads = 0,
      release!: (value: unknown) => void;
    const api = vi.fn(async (_url: string, body?: unknown) => {
      if (body) return setup(true);
      if (++reads === 2)
        return new Promise((resolve) => {
          release = resolve;
        });
      return setup();
    });
    const f = fixture(api);
    await settle();
    const refresh = f.view.refresh("app");
    await settle();
    await byText(f.root, "Confirm setup").fire("click");
    await settle();
    release({ ...setup(), stale: true });
    await refresh;
    await settle();
    expect(text(f.root)).toContain("Meet your first investigator.");
    expect(text(f.root)).not.toContain("project has changed since");
    expect(
      api.mock.calls.filter(([, body]) => body !== undefined),
    ).toHaveLength(1);
    f.view.destroy();
  });
  it("ignores previous-incarnation responses after a project is recreated", async () => {
    let release!: (value: unknown) => void,
      reads = 0;
    const api = vi.fn(async () =>
      ++reads === 1
        ? new Promise((resolve) => {
            release = resolve;
          })
        : {
            ...setup(),
            report: { ...setup().report, summary: "Replacement application" },
          },
    );
    const f = fixture(api),
      replacement = new Element("main");
    await settle();
    f.view.mount(replacement, { name: "app", instanceId: "replacement" });
    await settle();
    release(setup(true));
    await settle();
    expect(text(replacement)).toContain("Replacement application");
    expect(text(replacement)).not.toContain("Meet your first investigator.");
    expect(byText(replacement, "Confirm setup")).toBeDefined();
    expect(f.onCreatePm).not.toHaveBeenCalled();
    f.view.destroy();
  });
  it("requires a read-only refresh after rejected confirmation and never silently retries a mutation", async () => {
    let attempts = 0;
    const api = vi.fn(async (_url: string, body?: unknown) => {
      if (body) {
        attempts++;
        throw new Error("The repository branch changed after analysis.");
      }
      return setup();
    });
    const f = fixture(api);
    await settle();
    await byText(f.root, "Confirm setup").fire("click");
    await settle();
    expect(byText(f.root, "Confirm setup").disabled).toBe(true);
    expect(text(f.root)).toContain("repository branch changed");
    await byText(f.root, "Refresh inspection").fire("click");
    await settle();
    expect(attempts).toBe(1);
    expect(byText(f.root, "Confirm setup").disabled).toBe(false);
    f.view.destroy();
  });
  it("does not treat a stale confirmed report as permission to adopt its recommendation", async () => {
    const f = fixture(async () => ({ ...setup(true), stale: true }));
    await settle();
    expect(byText(f.root, "Meet Pip")).toBeUndefined();
    expect(byText(f.root, "Confirm setup")).toBeUndefined();
    expect(byText(f.root, "Inspect again")).toBeDefined();
    expect(f.onCreatePm).not.toHaveBeenCalled();
    f.view.destroy();
  });

  it.each(["failed", "interrupted"])(
    "does not offer confirmation of a retained previous report after a %s inspection",
    async (status) => {
      const api = vi.fn(async () => ({
        ...setup(),
        status,
        message: "Latest inspection did not finish.",
      }));
      const f = fixture(api);
      await settle();
      expect(text(f.root)).toContain("Latest inspection did not finish.");
      expect(byText(f.root, "Confirm setup")).toBeUndefined();
      expect(byText(f.root, "Meet Pip")).toBeUndefined();
      expect(byText(f.root, "Inspect again")).toBeDefined();
      expect(api).toHaveBeenCalledTimes(1);
      expect(f.onCreatePm).not.toHaveBeenCalled();
      f.view.destroy();
    },
  );

  it("binds Stop inspection to the displayed operation revision so it cannot cancel a newer inspection", async () => {
    const api = vi.fn(async (_url: string, body?: unknown) => {
      if (body) throw new Error("Setup changed. Reload before canceling.");
      return {
        ...setup(),
        status: "analyzing",
        revision: "displayed-operation",
      };
    });
    const f = fixture(api);
    await settle();
    await byText(f.root, "Stop inspection").fire("click");
    await settle();
    expect(api).toHaveBeenLastCalledWith(
      "/api/projects/app/onboarding/cancel",
      {
        revision: "displayed-operation",
      },
    );
    expect(text(f.root)).toContain("Setup changed. Reload before canceling.");
    expect(
      api.mock.calls.filter(([, body]) => body !== undefined),
    ).toHaveLength(1);
    f.view.destroy();
  });
});
