import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

const script = readFileSync(
  new URL("../../dashboard/pages.js", import.meta.url),
  "utf8",
);

function browser(path = "/") {
  const documentEvents = new Map<string, (event: unknown) => void>();
  const windowEvents = new Map<string, () => void>();
  const pushes: string[] = [];
  const ids = new Map<string, ReturnType<typeof element>>();
  function element(id: string, page?: string) {
    const attributes = new Map<string, string>();
    const item = {
      id,
      dataset: page ? { page } : {},
      hidden: false,
      focused: false,
      scrolled: false,
      target: "",
      draft: "kept while changing pages",
      hasAttribute: (name: string) => attributes.has(name),
      setAttribute: (name: string, value: string) =>
        attributes.set(name, value),
      getAttribute: (name: string) => attributes.get(name),
      removeAttribute: (name: string) => attributes.delete(name),
      focus: () => {
        item.focused = true;
      },
      scrollIntoView: () => {
        item.scrolled = true;
      },
      closest: (selector: string): unknown =>
        selector === "[data-page]" && page ? item : null,
      querySelector: (): unknown => item,
      href: "",
    };
    ids.set(id, item);
    return item;
  }
  const pages = [
    "overview",
    "connections",
    "projects",
    "runners",
    "activity",
    "settings",
  ];
  const panels = pages.map((page) => element(page, page));
  const source = element("source-control", "connections");
  const configuration = element("configuration", "settings");
  panels.push(source, configuration);
  const updates = element("updates");
  updates.closest = () => configuration;
  const job = element("job-detail");
  job.closest = () => panels.find((panel) => panel.id === "activity");
  const main = element("main");
  const banner = element("global-update-banner");
  const links = pages.map((page) => {
    const link = element(`nav-${page}`);
    link.href = `http://localhost:4311/${page}`;
    link.closest = () => link;
    return link;
  });
  const title = element("page-title");
  interface Navigation {
    navigate(path: string): boolean;
    current: string;
    destroy(): void;
  }
  const window = {
    location: new URL(path, "http://localhost:4311"),
    dashboardPages: undefined as Navigation | undefined,
    createDashboardPages: undefined as unknown as (options?: {
      initialPage?: string;
    }) => Navigation,
    requestAnimationFrame: (fn: () => void) => fn(),
    scrollTo: () => {},
    dispatchEvent: () => {},
    addEventListener: (name: string, fn: () => void) =>
      windowEvents.set(name, fn),
    removeEventListener: (name: string) => windowEvents.delete(name),
  };
  const history = {
    pushState: (_state: unknown, _title: string, url: string) => {
      pushes.push(url);
      window.location = new URL(url, window.location);
    },
    replaceState: (_state: unknown, _title: string, url: string) => {
      window.location = new URL(url, window.location);
    },
  };
  const document = {
    body: { dataset: {} },
    title: "",
    getElementById: (id: string) => ids.get(id),
    querySelectorAll: (selector: string) =>
      selector === "[data-page]"
        ? panels
        : selector === ".navigation a"
          ? links
          : selector === "[data-page-title]"
            ? [title]
            : [],
    addEventListener: (name: string, fn: (event: unknown) => void) =>
      documentEvents.set(name, fn),
    removeEventListener: (name: string) => documentEvents.delete(name),
  };
  runInNewContext(script, {
    window,
    document,
    history,
    URL,
    URLSearchParams,
    CustomEvent: class {
      constructor(
        readonly type: string,
        readonly options: unknown,
      ) {}
    },
  });
  return {
    window,
    document,
    panels,
    links,
    title,
    banner,
    main,
    source,
    configuration,
    updates,
    job,
    pushes,
    documentEvents,
    windowEvents,
    initialize: window.createDashboardPages,
  };
}

describe("dashboard page navigation", () => {
  it("shows only the deep-linked page while keeping the shared banner and drafts", () => {
    const view = browser("/settings");
    const pages = view.initialize();
    expect(pages.current).toBe("settings");
    expect(
      view.panels.filter((panel) => !panel.hidden).map((panel) => panel.id),
    ).toEqual(["settings", "configuration"]);
    expect(view.banner.hidden).toBe(false);
    expect(view.document.title).toBe("Settings · ShipGremlins");
    expect(
      view.links
        .find((link) => link.id === "nav-settings")
        ?.getAttribute("aria-current"),
    ).toBe("page");
    pages.navigate("/projects");
    pages.navigate("/settings");
    expect(view.configuration.draft).toBe("kept while changing pages");
  });
  it("maps old section links and reveals programmatic targets before focusing them", () => {
    const view = browser("/#source-control");
    const pages = view.initialize();
    expect(view.window.location.pathname + view.window.location.hash).toBe(
      "/connections#source-control",
    );
    expect(view.source.hidden).toBe(false);
    expect(pages.navigate("/settings#updates")).toBe(true);
    expect(view.configuration.hidden).toBe(false);
    expect(view.updates.focused).toBe(true);
    expect(pages.navigate("#job-detail")).toBe(true);
    expect(pages.current).toBe("activity");
    expect(view.job.scrolled).toBe(true);
  });
  it("handles browser back and modified links without adding navigation entries", () => {
    const view = browser();
    const pages = view.initialize();
    pages.navigate("/runners");
    pages.navigate("/activity");
    view.window.location = new URL("http://localhost:4311/runners");
    view.windowEvents.get("popstate")!();
    expect(pages.current).toBe("runners");
    expect(view.pushes).toEqual(["/runners", "/activity"]);
    view.documentEvents.get("click")!({
      button: 0,
      ctrlKey: true,
      target: view.links[1],
      preventDefault: () => {
        throw new Error("modified links must remain native");
      },
    });
    expect(pages.current).toBe("runners");
  });
  it("leaves session and OAuth fragments to app.js and rejects external or unknown routes", () => {
    const view = browser("/#session=private-session");
    const pages = view.initialize();
    expect(view.window.location.hash).toBe("#session=private-session");
    expect(view.pushes).toEqual([]);
    for (const path of [
      "https://evil.example/settings",
      "https://secret@localhost:4311/settings",
      "/unrelated",
      "/connections#slack=private-envelope",
    ])
      expect(pages.navigate(path), path).toBe(false);
    expect(view.window.location.hash).toBe("#session=private-session");
  });
  it("opens the connections page for a consumed OAuth callback and cleans up listeners", () => {
    const view = browser();
    const pages = view.initialize({ initialPage: "connections" });
    expect(pages.current).toBe("connections");
    expect(view.window.location.pathname).toBe("/connections");
    pages.destroy();
    expect(view.documentEvents.size).toBe(0);
    expect(view.windowEvents.size).toBe(0);
  });
});
