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
  href = "";
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
      mount(
        root: Element,
        project: object,
        options?: { suggestionsOnly?: boolean; setupOnly?: boolean },
      ): void;
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
    onSetupLinear = vi.fn(),
    view = window.createProjectWelcome({
      api,
      pages,
      isLocked: () => locked,
      onSaved,
      onCreatePm,
      onSetupLinear,
    });
  view.mount(root, project);
  return {
    root,
    project,
    view,
    onCreatePm,
    onSetupLinear,
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
  const readyProject = () => ({
    name: "app",
    instanceId: "current",
    workflow: { kind: "promotion", approvalPolicy: "epic" },
    areas: [{ key: "journey", enabled: false, codingEnabled: false }],
    readiness: {
      steps: [
        "source_connection",
        "ai_connection",
        "worker",
        "linear_connection",
        "test_access",
        "browser_verification",
      ].map((id) => ({ id, ready: true })),
      areas: [
        {
          key: "journey",
          canRun: true,
          canEnable: true,
          coding: { canEnable: true },
          blockers: [],
          enableBlockers: [],
        },
      ],
    },
  });
  it("routes reviewed recommendations into the same crew picker without creating or regenerating a PM", async () => {
    const source = setup(true),
      second = {
        name: "Lock",
        mandate: "Investigate authorization boundaries in checkout.",
        evidence: [{ path: "src/auth.ts", quote: "authorize" }],
        draft: {
          key: "trust",
          charter: {
            goal: "Improve account recovery and authorization",
            expectedToBuild: ["Clear recovery flows"],
          },
        },
      },
      response = {
        ...source,
        report: {
          ...source.report,
          projectSetup: {
            ...source.report.projectSetup,
            suggestedPms: [source.report.projectSetup.firstPm, second],
          },
        },
      },
      api = vi.fn(async () => response),
      f = fixture(api);
    await settle();
    expect(byText(f.root, "Review your crew").href).toBe(
      "/projects/app?tab=crew",
    );
    expect(byText(f.root, "Meet Pip")).toBeUndefined();
    expect(byText(f.root, "Meet Lock")).toBeUndefined();
    f.view.mount(
      f.root,
      {
        ...f.project,
        areas: [
          {
            key: "journey",
            mandate: source.report.projectSetup.firstPm.mandate,
          },
        ],
      },
      { suggestionsOnly: true },
    );
    await settle();
    expect(byText(f.root, "Meet Pip")).toBeUndefined();
    expect(byText(f.root, "Review your crew").href).toBe(
      "/projects/app?tab=crew",
    );
    expect(f.onCreatePm).not.toHaveBeenCalled();
    expect(api).toHaveBeenCalledExactlyOnceWith("/api/projects/app/onboarding");
    expect(text(f.root)).toContain("does not start daily patrols");
    f.view.destroy();
  });
  it("shows complete source recommendations before command confirmation as read-only context", async () => {
    const source = setup();
    const suggestion = {
      name: "Checkout Pip",
      mandate: "Own checkout",
      evidence: [{ path: "src/checkout.ts", quote: "completeCheckout" }],
      draft: {
        key: "checkout",
        charter: {
          goal: "Improve checkout completion",
          expectedToBuild: ["Checkout recovery"],
        },
      },
    };
    const api = vi.fn(async () => ({
      ...source,
      report: {
        ...source.report,
        projectSetup: {
          ...source.report.projectSetup,
          suggestedPms: [suggestion],
        },
      },
    }));
    const f = fixture(api);
    await settle();
    expect(text(f.root)).toContain("Improve checkout completion");
    expect(text(f.root)).toContain("src/checkout.ts");
    expect(byText(f.root, "Review your crew").href).toBe(
      "/projects/app?tab=crew",
    );
    expect(byText(f.root, "Confirm setup")).toBeDefined();
    expect(byText(f.root, "Meet Checkout Pip")).toBeUndefined();
    expect(f.onCreatePm).not.toHaveBeenCalled();
    expect(api).toHaveBeenCalledOnce();
    f.view.destroy();
  });
  it.each(["firstPm", "partial"])(
    "routes a legacy %s report to a fresh crew investigation without offering generic adoption",
    async (kind) => {
      const source = setup(true);
      const api = vi.fn(async () => ({
        ...source,
        report: {
          ...source.report,
          projectSetup: {
            ...source.report.projectSetup,
            ...(kind === "partial"
              ? { suggestedPms: [source.report.projectSetup.firstPm] }
              : {}),
          },
        },
      }));
      const f = fixture(api);
      await settle();
      expect(text(f.root)).toContain("no complete PM briefs");
      expect(byText(f.root, "Find my gremlins").href).toBe(
        "/projects/app?tab=crew",
      );
      expect(byText(f.root, "Meet Pip")).toBeUndefined();
      expect(text(f.root)).not.toContain(
        source.report.projectSetup.firstPm.mandate,
      );
      expect(f.onCreatePm).not.toHaveBeenCalled();
      expect(api).toHaveBeenCalledOnce();
      byText(f.root, "Choose a different gremlin").fire("click");
      expect(f.onCreatePm).toHaveBeenCalledExactlyOnceWith("app");
      f.view.destroy();
    },
  );
  it("respects an explicit empty crew recommendation instead of falling back to firstPm", async () => {
    const source = setup(true);
    const f = fixture(async () => ({
      ...source,
      report: {
        ...source.report,
        projectSetup: { ...source.report.projectSetup, suggestedPms: [] },
      },
    }));
    await settle();
    f.view.mount(f.root, { ...f.project, areas: [{ key: "journey" }] });
    expect(text(f.root)).toContain("No additional PMs were recommended.");
    expect(byText(f.root, "Your crew").href).toBe("/projects/app?tab=crew");
    expect(byText(f.root, "Meet Pip")).toBeUndefined();
    expect(text(f.root)).not.toContain(
      source.report.projectSetup.firstPm.mandate,
    );
    expect(f.onCreatePm).not.toHaveBeenCalled();
    f.view.destroy();
  });
  it("activates only a ready crew using fresh configuration revisions and refreshes the saved status", async () => {
    const api = vi.fn(async (url: string) =>
        url.endsWith("/readiness")
          ? { projectRevision: "fresh-project", areasRevision: "fresh-areas" }
          : url.endsWith("/crew/activate")
            ? { message: "Crew enabled." }
            : setup(true),
      ),
      f = fixture(api);
    await settle();
    f.view.mount(f.root, readyProject(), { suggestionsOnly: true });
    const completion = walk(f.root).find(
      (item) => item.attributes.get("role") === "progressbar",
    )!;
    expect(completion.attributes.get("aria-valuenow")).toBe("6");
    expect(completion.attributes.get("aria-valuemax")).toBe("7");
    const current = walk(f.root).filter(
      (item) => item.attributes.get("aria-current") === "step",
    );
    expect(current).toHaveLength(1);
    expect(text(current[0]!)).toContain("Activate daily patrols");
    await byText(f.root, "Activate ready crew").fire("click");
    expect(api).toHaveBeenLastCalledWith("/api/projects/app/crew/activate", {
      projectRevision: "fresh-project",
      areasRevision: "fresh-areas",
    });
    expect(f.onSaved).toHaveBeenCalledExactlyOnceWith("app");
    expect(text(f.root)).toContain("Crew enabled.");
    expect(text(f.root)).toContain("Activation does not approve any epic.");
    expect(f.onCreatePm).not.toHaveBeenCalled();
    f.view.destroy();
  });
  it("can show only readiness while a dedicated crew picker owns the remaining suggestions", async () => {
    const f = fixture(vi.fn(async () => setup(true)));
    await settle();
    f.view.mount(f.root, readyProject(), {
      suggestionsOnly: true,
      setupOnly: true,
    });
    expect(text(f.root)).toContain("Your crew is ready.");
    expect(text(f.root)).toContain("Activate ready crew");
    expect(text(f.root)).not.toContain("Grow your crew");
    expect(text(f.root)).not.toContain("Meet Pip");
    f.view.destroy();
  });
  it("surfaces a failed activation without a retry or a claimed active crew", async () => {
    const api = vi.fn(async (url: string) => {
        if (url.endsWith("/crew/activate"))
          throw new Error("Test app access again before activation.");
        return url.endsWith("/readiness")
          ? { projectRevision: "fresh-project", areasRevision: "fresh-areas" }
          : setup(true);
      }),
      f = fixture(api);
    await settle();
    f.view.mount(f.root, readyProject(), { suggestionsOnly: true });
    await byText(f.root, "Activate ready crew").fire("click");
    expect(
      api.mock.calls.filter(([url]) => url.endsWith("/crew/activate")),
    ).toHaveLength(1);
    expect(f.onSaved).not.toHaveBeenCalled();
    expect(text(f.root)).toContain("Test app access again before activation.");
    expect(text(f.root)).not.toContain("Your ready crew is active.");
    f.view.destroy();
  });
  it("verifies connections before activating with the new configuration revisions", async () => {
    const api = vi.fn(async (url: string) =>
        url.endsWith("/verify")
          ? { ok: true, checks: [] }
          : url.endsWith("/readiness")
            ? {
                projectRevision: "verified-project",
                areasRevision: "fresh-areas",
              }
            : url.endsWith("/crew/activate")
              ? { message: "Crew enabled." }
              : setup(true),
      ),
      f = fixture(api),
      project = readyProject();
    Object.assign(project.readiness.areas[0]!, {
      canRun: false,
      canEnable: false,
      blockers: [{ id: "verification" }],
      enableBlockers: [{ id: "verification" }],
      coding: { canEnable: false, enableBlockers: [{ id: "verification" }] },
    });
    await settle();
    f.view.mount(f.root, project, { suggestionsOnly: true });
    await byText(f.root, "Verify & activate crew").fire("click");
    expect(api.mock.calls.slice(-3).map(([url]) => url)).toEqual([
      "/api/projects/app/verify",
      "/api/projects/app/readiness",
      "/api/projects/app/crew/activate",
    ]);
    expect(api).toHaveBeenCalledWith(
      "/api/projects/app/verify",
      {},
      "POST",
      90000,
    );
    expect(api).toHaveBeenLastCalledWith("/api/projects/app/crew/activate", {
      projectRevision: "verified-project",
      areasRevision: "fresh-areas",
    });
    expect(f.onSaved).toHaveBeenCalledExactlyOnceWith("app");
    f.view.destroy();
  });
  it("keeps the crew paused and explains a connection verification failure", async () => {
    const api = vi.fn(async (url: string) =>
        url.endsWith("/verify")
          ? {
              ok: false,
              checks: [
                { name: "Linear", ok: false, detail: "Workspace unavailable" },
              ],
            }
          : setup(true),
      ),
      f = fixture(api),
      project = readyProject();
    Object.assign(project.readiness.areas[0]!, {
      canRun: false,
      canEnable: false,
      blockers: [{ id: "verification" }],
      enableBlockers: [{ id: "verification" }],
      coding: { canEnable: false, enableBlockers: [{ id: "verification" }] },
    });
    await settle();
    f.view.mount(f.root, project, { suggestionsOnly: true });
    await byText(f.root, "Verify & activate crew").fire("click");
    expect(api.mock.calls.some(([url]) => url.endsWith("/crew/activate"))).toBe(
      false,
    );
    expect(api.mock.calls.some(([url]) => url.endsWith("/readiness"))).toBe(
      false,
    );
    expect(f.onSaved).not.toHaveBeenCalled();
    expect(text(f.root)).toContain("Linear: Workspace unavailable");
    expect(text(f.root)).not.toContain("Your ready crew is active.");
    f.view.destroy();
  });
  it("routes incomplete environment setup to app access and never offers activation for an invalid schedule", async () => {
    const f = fixture(async () => setup(true)),
      project = readyProject();
    await settle();
    project.readiness.steps.find(
      (step) => step.id === "browser_verification",
    )!.ready = false;
    project.readiness.areas[0]!.canRun = false;
    f.view.mount(f.root, project, { suggestionsOnly: true });
    expect(byText(f.root, "Activate ready crew")).toBeUndefined();
    const environment = walk(f.root).find(
      (item) => item.tagName === "A" && item.textContent === "Test app access",
    )!;
    expect((environment as Element & { href: string }).href).toBe(
      "/projects/app?tab=environment",
    );
    const badSchedule = readyProject();
    badSchedule.readiness.areas[0]!.canEnable = false;
    f.view.mount(f.root, badSchedule, { suggestionsOnly: true });
    expect(byText(f.root, "Activate ready crew")).toBeUndefined();
    f.view.destroy();
  });
  it("does not ask repository-only projects to connect browser hosting or sign-in", async () => {
    const f = fixture(async () => setup(true)),
      project = readyProject();
    await settle();
    project.readiness.steps = project.readiness.steps.filter(
      (step) => !["test_access", "browser_verification"].includes(step.id),
    );
    project.readiness.steps.push({ id: "verification", ready: true });
    f.view.mount(
      f.root,
      { ...project, verification: { mode: "repository" } },
      { suggestionsOnly: true },
    );
    expect(text(f.root)).toContain("Confirm repository checks");
    expect(text(f.root)).not.toContain("Test app access");
    expect(byText(f.root, "Activate ready crew")).toBeDefined();
    f.view.destroy();
  });
  it("keeps an active ready crew focused without repeating the completed setup checklist", async () => {
    const f = fixture(async () => setup(true)),
      project = readyProject();
    await settle();
    project.areas[0]!.enabled = project.areas[0]!.codingEnabled = true;
    f.view.mount(f.root, project, { suggestionsOnly: true });
    expect(
      walk(f.root).find(
        (item) =>
          item.attributes.get("aria-label") === "Project setup progress",
      ),
    ).toBeUndefined();
    expect(byText(f.root, "Activate ready crew")).toBeUndefined();
    expect(text(f.root)).toContain("Grow your crew");
    f.view.destroy();
  });
  it("points repository-first promotion setup to a deployment before activating coders", async () => {
    const f = fixture(async () => setup(true)),
      project = readyProject();
    await settle();
    Object.assign(project.readiness.areas[0]!.coding, {
      canEnable: false,
      enableBlockers: [
        {
          id: "promotion_environment",
          action: "environment",
          message: "Prepare integration deployment.",
        },
      ],
    });
    f.view.mount(
      f.root,
      { ...project, verification: { mode: "repository" } },
      { suggestionsOnly: true },
    );
    expect(byText(f.root, "Activate ready crew")).toBeUndefined();
    const action = walk(f.root).find(
      (item) =>
        item.tagName === "A" &&
        item.textContent === "Prepare integration deployment",
    )!;
    expect((action as Element & { href: string }).href).toBe(
      "/projects/app?tab=environment",
    );
    f.view.destroy();
  });
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
    expect(text(f.root)).toContain("Your setup is saved.");
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
    expect(byText(f.root, "Find my gremlins").href).toBe(
      "/projects/app?tab=crew",
    );
    expect(byText(f.root, "Meet Pip")).toBeUndefined();
    expect(f.onCreatePm).not.toHaveBeenCalled();
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
    expect(text(f.root)).toContain("Your setup is saved.");
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
    expect(text(replacement)).not.toContain("Your setup is saved.");
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
