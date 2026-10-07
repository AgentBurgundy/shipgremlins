import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

class Element {
  children: Element[] = [];
  parent: Element | null = null;
  textContent = "";
  className = "";
  disabled = false;
  hidden = false;
  attributes = new Map<string, string>();
  listeners = new Map<string, () => unknown>();
  constructor(public tagName: string) {}
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
    for (const child of this.children) child.parent = null;
    this.children = [];
    this.append(...items);
  }
  contains(item: Element) {
    return walk(this).includes(item);
  }
  setAttribute(key: string, value: string) {
    this.attributes.set(key, value);
  }
  addEventListener(name: string, handler: () => unknown) {
    this.listeners.set(name, handler);
  }
  click() {
    if (!this.disabled) return this.listeners.get("click")?.();
  }
}
const walk = (root: Element): Element[] => [
  root,
  ...root.children.flatMap(walk),
];
const text = (root: Element) =>
  walk(root)
    .map((node) => node.textContent)
    .join(" ");
const button = (root: Element, label: string) =>
  walk(root).find(
    (node) =>
      node.tagName === "button" &&
      (node.textContent === label ||
        node.attributes.get("aria-label") === label),
  )!;
const settle = async () => {
  for (let index = 0; index < 30; index++) await Promise.resolve();
};
const recommendation = (name: string, key: string) => ({
  name,
  mandate: `Investigate ${key} and propose evidence-based improvements.`,
  rationale: `The app has a distinct ${key} customer journey.`,
  evidence: [{ path: `src/${key}.ts`, quote: `handle${name}` }],
  draft: {
    name,
    key,
    label: `pm:${key}`,
    paths: [`src/${key}.ts`],
    sharedTouchpoints: [],
    schedule: "0 13 * * *",
    wipLimit: 3,
    metric: "/",
    charter: {
      ambition: "Improve the app",
      goal: `Improve ${key}`,
      metricDefinition: "Completed journeys",
      users: ["Customers"],
      expectedToBuild: [
        "Investigate the journey",
        "Propose bounded improvements",
      ],
      nonGoals: ["Do not change unrelated areas"],
      guardrails: ["Use test data"],
      standingPriorities: ["Validate evidence"],
    },
  },
});
const report = () => ({
  status: "analyzed",
  revision: "r1",
  stale: false,
  recommendationsReviewable: true,
  setupConfirmation: { confirmed: false },
  report: {
    repository: {
      sha: "a".repeat(40),
      branch: "pm-staging",
      filesRead: ["src/checkout.ts", "src/billing.ts", "src/search.ts"],
    },
    projectSetup: {
      suggestedPms: [
        recommendation("Pip", "checkout"),
        recommendation("Nib", "billing"),
        recommendation("Moss", "search"),
      ],
    },
  },
});
type Project = {
  name: string;
  instanceId: string;
  provider: string;
  repo: string;
  serverUrl?: string;
  workflow?: { kind: string; baseBranch?: string };
  verification?: { mode: string; environment?: string };
  branches?: { production: string; staging: string; integration: string };
  environments?: Record<string, { kind: string; branch?: string }>;
  commands?: Record<string, string>;
  linear?: { status: string };
  areas: { key: string; name?: string; mandate?: string }[];
};
type Api = (url: string, body?: unknown) => Promise<unknown>;
function fixture(api: Api, overrides: Partial<Project> = {}) {
  const root = new Element("main");
  let project: Project = {
    name: "shop",
    instanceId: "first",
    provider: "github",
    repo: "owner/shop",
    areas: [],
    ...overrides,
  };
  let locked = false,
    timerId = 0;
  const events = new Map<string, () => void>(),
    timers = new Map<number, () => void>();
  const document = {
    hidden: false,
    activeElement: null as Element | null,
    createElement: (tag: string) => new Element(tag),
    addEventListener: (name: string, fn: () => void) => events.set(name, fn),
    removeEventListener: (name: string) => events.delete(name),
  };
  const window = {
    addEventListener: (name: string, fn: () => void) => events.set(name, fn),
    removeEventListener: (name: string) => events.delete(name),
  } as unknown as {
    createCrewRecommendations(options: object): {
      mount(
        root: Element,
        project: Project,
        options?: { hideWhenEmpty: boolean },
      ): void;
      refresh(name: string): Promise<void>;
      resume(projects: Project[]): void;
      hasSuggestions(project: Project): boolean;
      isBusy(): boolean;
      deactivate(): void;
      destroy(): void;
    };
  };
  runInNewContext(
    readFileSync(
      new URL("../../dashboard/crew-recommendations.js", import.meta.url),
      "utf8",
    ),
    {
      window,
      document,
      setTimeout: (fn: () => void) => {
        timers.set(++timerId, fn);
        return timerId;
      },
      clearTimeout: (id: number) => timers.delete(id),
    },
  );
  const onAdopt = vi.fn();
  const view = window.createCrewRecommendations({
    api,
    getProject: () => project,
    onAdopt,
    isLocked: () => locked,
  });
  view.mount(root, project);
  return {
    root,
    view,
    document,
    events,
    timers,
    onAdopt,
    get project() {
      return project;
    },
    setProject(value: Project) {
      project = value;
    },
    setLocked(value: boolean) {
      locked = value;
    },
  };
}

describe("AI crew recommendations", () => {
  it("does not substitute a legacy first PM when the latest investigation found no additional roles", async () => {
    const data = report();
    const f = fixture(async () => ({
      ...data,
      report: {
        ...data.report,
        projectSetup: {
          firstPm: recommendation("Old PM", "old"),
          suggestedPms: [],
        },
      },
    }));
    await settle();
    expect(text(f.root)).not.toContain("Old PM");
    expect(text(f.root)).not.toContain(
      "predates complete crew recommendations",
    );
    expect(f.view.hasSuggestions(f.project)).toBe(false);
    f.view.destroy();
  });
  it("asks for a fresh crew investigation instead of presenting legacy understanding-only PMs", async () => {
    const data = report();
    const old = {
      name: "Product Understanding PM",
      mandate: "Read the whole codebase before suggesting work.",
      evidence: [],
    };
    const f = fixture(async () => ({
      ...data,
      report: {
        ...data.report,
        projectSetup: { firstPm: old, suggestedPms: [old] },
      },
    }));
    await settle();
    expect(button(f.root, "Find my gremlins")).toBeDefined();
    expect(text(f.root)).toContain("predates complete crew recommendations");
    expect(text(f.root)).not.toContain("Product Understanding PM");
    expect(
      walk(f.root).filter((node) => node.className === "crew-recommendation"),
    ).toHaveLength(0);
    f.view.destroy();
  });
  it("loads remaining saved recommendations on a fresh Crew page without showing an empty extra panel", async () => {
    const f = fixture(async () => report());
    f.setProject({ ...f.project, areas: [{ key: "checkout" }] });
    f.view.mount(f.root, f.project, { hideWhenEmpty: true });
    expect(f.root.children[0]!.hidden).toBe(true);
    await settle();
    expect(f.root.children[0]!.hidden).toBe(false);
    expect(button(f.root, "Adopt Nib")).toBeDefined();
    f.setProject({
      ...f.project,
      areas: ["checkout", "billing", "search"].map((key) => ({ key })),
    });
    f.view.resume([f.project]);
    expect(f.root.children[0]!.hidden).toBe(true);
    f.view.destroy();
  });
  it("loads saved status without starting a paid investigation or creating a PM", async () => {
    const api = vi.fn(async () => ({ status: "idle" })),
      f = fixture(api);
    await settle();
    expect(api).toHaveBeenCalledExactlyOnceWith(
      "/api/projects/shop/onboarding",
    );
    expect(button(f.root, "Find my gremlins").disabled).toBe(false);
    expect(text(f.root)).toContain("does not browse the app");
    expect(f.onAdopt).not.toHaveBeenCalled();
    expect(f.timers.size).toBe(0);
    f.view.destroy();
  });
  it("starts only on click, suppresses duplicate starts, and shows real controller progress", async () => {
    let finish!: (value: unknown) => void;
    const api = vi.fn((url: string) =>
      url.endsWith("/discover")
        ? new Promise((resolve) => {
            finish = resolve;
          })
        : Promise.resolve({ status: "idle" }),
    );
    const f = fixture(api);
    await settle();
    const find = button(f.root, "Find my gremlins");
    find.click();
    find.click();
    expect(f.view.isBusy()).toBe(true);
    expect(api).toHaveBeenCalledTimes(2);
    finish({
      status: "analyzing",
      stage: "analyzing-files",
      message: "Claude is analyzing 42 safe source files.",
      revision: "r2",
    });
    await settle();
    expect(text(f.root)).toContain("Claude is analyzing 42 safe source files.");
    expect(text(f.root)).toContain("analyzing files");
    expect(f.timers.size).toBe(1);
    expect(button(f.root, "Adopt Pip")).toBeUndefined();
    f.view.destroy();
  });
  it("cancels the current analysis revision and stops polling", async () => {
    const api = vi.fn(async (url: string) =>
      url.endsWith("/cancel")
        ? { status: "interrupted", message: "Stopped by owner." }
        : {
            status: "analyzing",
            revision: "active-r3",
            message: "Reading source.",
          },
    );
    const f = fixture(api);
    await settle();
    await button(f.root, "Stop investigation").click();
    expect(api).toHaveBeenLastCalledWith(
      "/api/projects/shop/onboarding/cancel",
      { revision: "active-r3" },
    );
    expect(text(f.root)).toContain("Stopped by owner.");
    expect(f.timers.size).toBe(0);
    f.view.destroy();
  });
  it("reviews all grounded PM drafts without command confirmation or another AI call", async () => {
    const data = report(),
      api = vi.fn(async () => data),
      f = fixture(api);
    await settle();
    expect(
      walk(f.root).filter((node) => node.className === "crew-recommendation"),
    ).toHaveLength(3);
    expect(text(f.root)).toContain("src/checkout.ts");
    expect(
      walk(f.root).find(
        (node) => node.className === "crew-recommendation-purpose",
      )?.textContent,
    ).toBe("Improve checkout");
    expect(
      walk(f.root).find(
        (node) =>
          node.className === "eyebrow muted" && node.textContent === "checkout",
      ),
    ).toBeDefined();
    expect(text(f.root)).toContain("pm-staging · aaaaaaaa · 3 files read");
    await button(f.root, "Adopt Pip").click();
    expect(f.onAdopt).toHaveBeenCalledExactlyOnceWith("shop", {
      ...data.report.projectSetup.suggestedPms[0],
      review: true,
    });
    expect(api).toHaveBeenCalledOnce();
    expect(f.view.hasSuggestions(f.project)).toBe(true);
    f.view.destroy();
  });
  it("keeps unadopted suggestions after adoption and matches a renamed PM by its stable key", async () => {
    const api = vi.fn(async () => report()),
      f = fixture(api);
    await settle();
    f.setProject({
      ...f.project,
      areas: [
        { key: "checkout", name: "My custom PM", mandate: "My adjusted brief" },
      ],
    });
    f.view.resume([f.project]);
    f.view.mount(f.root, f.project);
    expect(button(f.root, "Adopt Pip")).toBeUndefined();
    expect(text(f.root)).toContain("✓ In your crew");
    await button(f.root, "Adopt Nib").click();
    expect(f.onAdopt).toHaveBeenCalledWith(
      "shop",
      expect.objectContaining({ name: "Nib" }),
    );
    expect(api).toHaveBeenCalledOnce();
    f.view.destroy();
  });
  it("permits stale source-matching recommendations but blocks changed repository suggestions", async () => {
    let data = { ...report(), stale: true };
    const f = fixture(async () => data);
    await settle();
    expect(text(f.root)).toContain("saved source inspection");
    expect(button(f.root, "Adopt Pip").disabled).toBe(false);
    data = { ...data, recommendationsReviewable: false };
    await f.view.refresh("shop");
    expect(button(f.root, "Adopt Pip").disabled).toBe(true);
    expect(text(f.root)).toContain(
      "repository or inspection branch has changed",
    );
    await button(f.root, "Adopt Pip").click();
    expect(f.onAdopt).not.toHaveBeenCalled();
    f.view.destroy();
  });
  it.each([
    {
      name: "pull-request inspection branch",
      initial: { workflow: { kind: "pull-request", baseBranch: "main" } },
      changed: { workflow: { kind: "pull-request", baseBranch: "develop" } },
    },
    {
      name: "selected Vercel preview branch",
      initial: {
        verification: { mode: "browser", environment: "preview" },
        environments: { preview: { kind: "vercel", branch: "pm-staging" } },
      },
      changed: {
        environments: { preview: { kind: "vercel", branch: "next-preview" } },
      },
    },
    {
      name: "production branch for repository discovery in promotion mode",
      initial: {
        workflow: { kind: "promotion" },
        verification: { mode: "repository" },
        branches: {
          production: "main",
          staging: "staging",
          integration: "pm-staging",
        },
      },
      changed: {
        branches: {
          production: "trunk",
          staging: "staging",
          integration: "pm-staging",
        },
      },
    },
    {
      name: "integration branch for URL testing in promotion mode",
      initial: {
        workflow: { kind: "promotion" },
        verification: { mode: "browser", environment: "preview" },
        environments: { preview: { kind: "url" } },
        branches: {
          production: "main",
          staging: "staging",
          integration: "pm-staging",
        },
      },
      changed: {
        branches: {
          production: "main",
          staging: "staging",
          integration: "integration-next",
        },
      },
    },
    {
      name: "source server",
      initial: { provider: "gitlab", serverUrl: "https://gitlab.example.test" },
      changed: { serverUrl: "https://gitlab.other.test" },
    },
  ])(
    "reloads authority and blocks cached adoption after changing $name",
    async ({ initial, changed }) => {
      let finish!: (value: unknown) => void;
      const api = vi
        .fn<Api>()
        .mockResolvedValueOnce(report())
        .mockImplementation(
          () =>
            new Promise((resolve) => {
              finish = resolve;
            }),
        );
      const f = fixture(api, initial);
      await settle();
      const oldAdopt = button(f.root, "Adopt Pip");
      f.setProject({ ...f.project, ...changed });
      f.view.resume([f.project]);
      f.view.mount(f.root, f.project);
      expect(api).toHaveBeenCalledTimes(2);
      expect(f.view.hasSuggestions(f.project)).toBe(false);
      expect(button(f.root, "Adopt Pip")).toBeUndefined();
      oldAdopt.click();
      expect(f.onAdopt).not.toHaveBeenCalled();
      finish({ ...report(), recommendationsReviewable: false });
      await settle();
      expect(button(f.root, "Adopt Pip").disabled).toBe(true);
      expect(text(f.root)).toContain(
        "repository or inspection branch has changed",
      );
      f.view.destroy();
    },
  );
  it("ignores late status and action responses for an older inspection source", async () => {
    let firstLoad!: (value: unknown) => void;
    let oldAction!: (value: unknown) => void;
    const api = vi
      .fn<Api>()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            firstLoad = resolve;
          }),
      )
      .mockResolvedValueOnce(report())
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            oldAction = resolve;
          }),
      )
      .mockResolvedValueOnce({ ...report(), recommendationsReviewable: false });
    const f = fixture(api, {
      workflow: { kind: "pull-request", baseBranch: "main" },
    });
    f.setProject({
      ...f.project,
      workflow: { kind: "pull-request", baseBranch: "develop" },
    });
    f.view.resume([f.project]);
    await settle();
    firstLoad({ status: "analyzing", message: "Old branch analysis" });
    await settle();
    expect(text(f.root)).not.toContain("Old branch analysis");
    button(f.root, "Refresh recommendations").click();
    f.setProject({
      ...f.project,
      workflow: { kind: "pull-request", baseBranch: "trunk" },
    });
    f.view.resume([f.project]);
    await settle();
    oldAction({ status: "analyzing", message: "Old branch operation" });
    await settle();
    expect(text(f.root)).not.toContain("Old branch operation");
    expect(button(f.root, "Adopt Pip").disabled).toBe(true);
    expect(f.timers.size).toBe(0);
    expect(f.view.isBusy()).toBe(false);
    f.view.destroy();
  });
  it("retains remaining recommendations through adoption, Linear, commands and unrelated branch edits", async () => {
    const api = vi.fn(async () => report());
    const f = fixture(api, {
      workflow: { kind: "promotion" },
      verification: { mode: "browser", environment: "preview" },
      branches: {
        production: "main",
        staging: "staging",
        integration: "pm-staging",
      },
      environments: { preview: { kind: "vercel", branch: "pm-staging" } },
    });
    await settle();
    f.setProject({
      ...f.project,
      areas: [{ key: "checkout" }],
      commands: { test: "npm test" },
      linear: { status: "ready" },
      branches: {
        production: "trunk",
        staging: "release",
        integration: "unused-by-preview",
      },
      environments: {
        preview: { kind: "vercel", branch: "pm-staging" },
        other: { kind: "railway", branch: "different" },
      },
    });
    f.view.resume([f.project]);
    f.view.mount(f.root, f.project);
    expect(api).toHaveBeenCalledOnce();
    expect(button(f.root, "Adopt Pip")).toBeUndefined();
    expect(button(f.root, "Adopt Nib").disabled).toBe(false);
    f.view.destroy();
  });
  it("shows actionable errors and can recover without hiding the failure", async () => {
    let fail = true;
    const f = fixture(async () => {
      if (fail) throw new Error("Connect Claude before investigating.");
      return { status: "idle" };
    });
    await settle();
    expect(text(f.root)).toContain("Connect Claude before investigating.");
    fail = false;
    await button(f.root, "Refresh status").click();
    expect(text(f.root)).not.toContain("Connect Claude before investigating.");
    expect(button(f.root, "Find my gremlins").disabled).toBe(false);
    f.view.destroy();
  });
  it("rejects late results and adoption after a project is replaced", async () => {
    let finish!: (value: unknown) => void;
    const f = fixture(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    f.setProject({ ...f.project, instanceId: "replacement" });
    finish(report());
    await settle();
    expect(button(f.root, "Adopt Pip")).toBeUndefined();
    expect(f.view.hasSuggestions(f.project)).toBe(false);
    f.view.destroy();
  });
  it("pauses polling when hidden or inactive and resumes from actual saved status", async () => {
    const api = vi.fn(async () => ({
        status: "analyzing",
        message: "Reading source.",
      })),
      f = fixture(api);
    await settle();
    expect(f.timers.size).toBe(1);
    f.document.hidden = true;
    f.events.get("visibilitychange")?.();
    expect(f.timers.size).toBe(0);
    f.document.hidden = false;
    f.events.get("visibilitychange")?.();
    await settle();
    expect(api).toHaveBeenCalledTimes(2);
    expect(f.timers.size).toBe(1);
    f.view.deactivate();
    expect(f.timers.size).toBe(0);
    f.view.destroy();
    expect(f.events.size).toBe(0);
  });
});
