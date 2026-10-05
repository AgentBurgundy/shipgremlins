import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

class Element {
  children: Element[] = [];
  attributes = new Map<string, string>();
  listeners = new Map<string, () => unknown>();
  className = "";
  textContent = "";
  value = "";
  id = "";
  href = "";
  scope = "";
  htmlFor = "";
  disabled = false;
  classList = {
    add: (value: string) => {
      this.className += ` ${value}`;
    },
  };
  constructor(readonly tagName: string) {}
  append(...nodes: Element[]) {
    this.children.push(...nodes);
  }
  replaceChildren(...nodes: Element[]) {
    this.children = nodes;
  }
  setAttribute(key: string, value: string) {
    this.attributes.set(key, value);
  }
  addEventListener(key: string, listener: () => unknown) {
    this.listeners.set(key, listener);
  }
  fire(key: string) {
    return this.listeners.get(key)?.();
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
const css = (root: Element, name: string) =>
  walk(root).find((node) => node.className.split(" ").includes(name))!;
const label = (root: Element, name: string) =>
  walk(root).find((node) => node.textContent === name)!;
const script = readFileSync(
  new URL("../../dashboard/usage.js", import.meta.url),
  "utf8",
);
const pageScript = readFileSync(
  new URL("../../dashboard/pages.js", import.meta.url),
  "utf8",
);
const totals = (total = 100) => ({
  inputTokens: total * 0.4,
  outputTokens: total * 0.1,
  cacheReadInputTokens: total * 0.3,
  cacheCreationInputTokens: total * 0.2,
  totalTokens: total,
});
const coverage = (
  measuredRuns = 1,
  unavailableRuns = 0,
  partialRecords = 0,
) => ({
  measuredRuns,
  unavailableRuns,
  measuredOperations: 0,
  unavailableOperations: 0,
  partialRecords,
  fields: {
    inputTokens: measuredRuns,
    outputTokens: measuredRuns,
    cacheReadInputTokens: measuredRuns,
    cacheCreationInputTokens: measuredRuns,
  },
});
function report(
  total = 100,
  measuredRuns = 1,
  unavailableRuns = 0,
  partialRecords = 0,
) {
  const row = {
    totals: totals(total),
    coverage: coverage(measuredRuns, unavailableRuns, partialRecords),
  };
  return {
    range: "30d",
    from: "2026-10-01",
    to: "2026-10-30",
    ...row,
    projects: [
      { project: "shop", projectInstanceId: null as string | null, ...row },
    ],
    daily: [{ date: "2026-10-01", ...row }],
    kinds: [],
    models: [],
    warnings: [] as string[],
  };
}
type Report = ReturnType<typeof report>;
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
async function settle() {
  for (let i = 0; i < 12; i++) await Promise.resolve();
}
function fixture(
  path = "/usage",
  handler: (path: string) => Promise<Report> = async () => report(),
  canRead = true,
) {
  const root = new Element("SECTION");
  const listeners = new Map<
    string,
    (event: { detail: { page: string; path: string } }) => void
  >();
  const api = vi.fn(handler);
  let url = new URL(path, "http://localhost:4311");
  const pages = {
    current: url.pathname === "/usage" ? "usage" : "overview",
    navigate: vi.fn((path: string) => {
      url = new URL(path, url);
      pages.current = url.pathname === "/usage" ? "usage" : "overview";
      listeners.get("dashboard:pagechange")?.({
        detail: { page: pages.current, path },
      });
      return true;
    }),
  };
  const window = {
    get location() {
      return url;
    },
    addEventListener: (
      key: string,
      handler: (event: { detail: { page: string; path: string } }) => void,
    ) => listeners.set(key, handler),
    removeEventListener: (key: string) => listeners.delete(key),
    createWorkspaceUsage: undefined as unknown as (
      root: Element,
      options: unknown,
    ) => { refresh(): Promise<void>; destroy(): void },
  };
  runInNewContext(script, {
    window,
    document: {
      createElement: (name: string) => new Element(name.toUpperCase()),
      createElementNS: (_ns: string, name: string) =>
        new Element(name.toUpperCase()),
    },
    URL,
    URLSearchParams,
    Intl,
    AbortController,
  });
  const controller = window.createWorkspaceUsage(root, {
    api,
    pages,
    canRead: () => canRead,
  });
  return { root, api, pages, controller, window };
}

describe("workspace token usage", () => {
  it("loads lazily, exposes loading state, and requires the dashboard session", async () => {
    const pending = deferred<Report>();
    const view = fixture("/overview", () => pending.promise);
    expect(view.api).not.toHaveBeenCalled();
    view.pages.navigate("/usage");
    expect(text(view.root)).toContain("Loading token usage");
    expect(css(view.root, "usage-content").attributes.get("aria-busy")).toBe(
      "true",
    );
    pending.resolve(report());
    await settle();
    expect(css(view.root, "usage-content").attributes.get("aria-busy")).toBe(
      "false",
    );
    const locked = fixture("/usage", async () => report(), false);
    expect(locked.api).not.toHaveBeenCalled();
    expect(text(locked.root)).toContain("private dashboard session");
  });

  it("shows all four categories, exact totals, project usage and an accessible UTC trend", async () => {
    const view = fixture();
    await settle();
    expect(css(view.root, "usage-total-value").textContent).toBe("100");
    expect(css(view.root, "usage-exact").textContent).toBe(
      "100 tokens reported",
    );
    expect(text(view.root)).toContain("Not served from cache");
    expect(text(view.root)).toContain("Context written to cache");
    expect(text(view.root)).toContain("not a cost estimate");
    expect(text(view.root)).toContain("Recorded token trend");
    expect(
      walk(view.root).some(
        (node) =>
          node.className === "sr-only" &&
          node.tagName === "DIV" &&
          node.children[0]?.tagName === "TABLE",
      ),
    ).toBe(true);
    expect(text(view.root)).toContain("2026-10-01");
    expect(css(view.root, "usage-project-link").href).toBe(
      "/usage?range=30d&project=shop&instance=legacy",
    );
    expect(
      walk(view.root).some(
        (node) =>
          node.tagName === "SVG" &&
          node.attributes.get("aria-hidden") === "true",
      ),
    ).toBe(true);
  });

  it("does not represent unreported historic work as zero", async () => {
    const view = fixture("/usage", async () => report(0, 0, 4));
    await settle();
    expect(css(view.root, "usage-total-value").textContent).toBe("—");
    expect(css(view.root, "usage-token-card").children[1]!.textContent).toBe(
      "—",
    );
    expect(text(view.root)).toContain("0 of 4 runs reported");
    expect(text(view.root)).toContain("Missing reports are unknown, not zero");
    expect(text(view.root)).toContain("Usage not reported");
  });

  it("retains an explicitly measured zero and marks partial counts as lower bounds", async () => {
    const zero = fixture("/usage", async () => report(0));
    await settle();
    expect(css(zero.root, "usage-total-value").textContent).toBe("0");
    expect(text(zero.root)).toContain("0 tokens reported");
    const partial = fixture("/usage", async () => report(25, 1, 0, 1));
    await settle();
    expect(css(partial.root, "usage-total-value").textContent).toBe("≥ 25");
    expect(text(partial.root)).toContain("1 partial report is included");
    expect(text(partial.root)).toContain("more tokens may have been used");
  });

  it("explains the empty selection without inventing historical totals", async () => {
    const empty = report(0, 0);
    empty.projects = [];
    empty.daily = [];
    const view = fixture("/usage?range=7d", async () => empty);
    await settle();
    expect(css(view.root, "usage-total-value").textContent).toBe("—");
    expect(text(view.root)).toContain("Your first tokens will appear here");
    expect(text(view.root)).toContain(
      "No recorded activity for this selection",
    );
    expect(text(view.root)).toContain("cannot be reconstructed");
  });

  it("shows unknown categories as unavailable while retaining a reported zero in a partial record", async () => {
    const data = report(40, 1, 0, 1);
    data.totals.outputTokens = 0;
    data.totals.cacheReadInputTokens = 0;
    data.coverage.fields.outputTokens = 0;
    const view = fixture("/usage", async () => data);
    await settle();
    const cards = walk(view.root).filter((node) =>
      node.className.includes("usage-token-card"),
    );
    expect(
      cards.find((card) => card.children[0]!.textContent === "Output")!
        .children[1]!.textContent,
    ).toBe("—");
    expect(
      cards.find((card) => card.children[0]!.textContent === "Cache reads")!
        .children[1]!.textContent,
    ).toBe("≥ 0");
    expect(css(view.root, "usage-total-value").textContent).toBe("≥ 40");
    expect(text(view.root)).toContain(
      "Usage updates after runs and AI setup actions finish",
    );
  });

  it("retains project incarnation and period in filters, including all-project reset", async () => {
    const data = report();
    data.projects[0]!.projectInstanceId =
      "12345678-1234-1234-1234-123456789abc";
    const view = fixture("/usage?range=7d", async () => data);
    await settle();
    const select = walk(view.root).find((node) => node.id === "usage-project")!;
    select.value = JSON.stringify([
      "shop",
      data.projects[0]!.projectInstanceId,
    ]);
    select.fire("change");
    await settle();
    expect(view.pages.navigate).toHaveBeenLastCalledWith(
      "/usage?range=7d&project=shop&instance=12345678-1234-1234-1234-123456789abc",
      { focus: false, scroll: false },
    );
    label(view.root, "All time").fire("click");
    await settle();
    expect(view.window.location.search).toBe(
      "?range=all&project=shop&instance=12345678-1234-1234-1234-123456789abc",
    );
    select.value = "";
    select.fire("change");
    await settle();
    expect(view.window.location.search).toBe("?range=all");
  });

  it("keeps project-only deep links distinct from one incarnation and supports workspace planning", async () => {
    const data = report();
    data.projects.push({
      ...data.projects[0]!,
      projectInstanceId: "12345678-1234-1234-1234-123456789abc",
    });
    const view = fixture("/usage?project=shop", async () => data);
    await settle();
    const select = walk(view.root).find((node) => node.id === "usage-project")!;
    expect(select.value).toBe(JSON.stringify(["shop", ""]));
    expect(text(select)).toContain("shop · All history");
    view.pages.navigate("/usage?range=30d&project=_workspace");
    await settle();
    expect(select.value).toBe(JSON.stringify(["_workspace", ""]));
    expect(text(view.root)).toContain("Workspace planning · Last 30 days");
  });

  it("ignores a stale response after filters change and preserves the new totals", async () => {
    const first = deferred<Report>();
    const view = fixture("/usage?range=7d", async (path) =>
      path.includes("range=7d") ? first.promise : report(90),
    );
    view.pages.navigate("/usage?range=30d&project=shop");
    await settle();
    expect(css(view.root, "usage-total-value").textContent).toBe("90");
    first.resolve(report(999));
    await settle();
    expect(css(view.root, "usage-total-value").textContent).toBe("90");
    expect(css(view.root, "usage-total-scope").textContent).toContain("shop");
  });

  it("does not show a late request error after leaving the page", async () => {
    const first = deferred<Report>();
    const view = fixture("/usage", () => first.promise);
    view.pages.navigate("/overview");
    first.reject(new Error("Late error"));
    await settle();
    expect(text(view.root)).not.toContain("Late error");
    expect(text(view.root)).not.toContain("Usage couldn’t load");
  });

  it("shows an actionable error and retries without retaining misleading old totals", async () => {
    let failed = true;
    const view = fixture("/usage", async () => {
      if (failed) throw new Error("Server unavailable");
      return report(50);
    });
    await settle();
    expect(text(view.root)).toContain("Usage couldn’t load");
    expect(text(view.root)).toContain("Server unavailable");
    expect(
      walk(view.root).some((node) => node.className === "usage-total-value"),
    ).toBe(false);
    failed = false;
    await label(view.root, "Try again").fire("click");
    await settle();
    expect(css(view.root, "usage-total-value").textContent).toBe("50");
  });

  it("keeps successful stats when only the project catalog fails and retries that catalog", async () => {
    let failed = true;
    const view = fixture("/usage?range=7d", async (path) => {
      if (failed && path === "/api/usage?range=all") throw new Error("catalog");
      return report(70);
    });
    await settle();
    expect(css(view.root, "usage-total-value").textContent).toBe("70");
    expect(text(view.root)).toContain("project filter options could not load");
    failed = false;
    await view.controller.refresh();
    expect(text(view.root)).not.toContain("could not load");
  });

  it("coalesces a long history without losing recorded totals or unknown coverage", async () => {
    const data = report(1000);
    data.from = "2026-01-01";
    data.to = "2026-04-30";
    data.daily = Array.from({ length: 120 }, (_, index) => ({
      date: new Date(Date.UTC(2026, 0, index + 1)).toISOString().slice(0, 10),
      totals: totals(index ? 10 : 0),
      coverage: index ? coverage() : coverage(0, 1),
    }));
    const view = fixture("/usage?range=all", async () => data);
    await settle();
    const rects = walk(view.root).filter((node) => node.tagName === "RECT");
    expect(rects).toHaveLength(60);
    expect(text(view.root)).toContain("2026-01-01 to 2026-01-02");
    expect(text(view.root)).toContain("1 reported; 1 unavailable");
    expect(text(view.root)).toContain("understate a day’s total");
  });

  it("preserves gaps between sparse all-time records without allocating an unbounded chart", async () => {
    const data = report(200);
    data.from = "2026-01-01";
    data.to = "2026-01-31";
    data.daily = [
      { date: "2026-01-01", totals: totals(100), coverage: coverage() },
      { date: "2026-01-31", totals: totals(100), coverage: coverage() },
    ];
    const view = fixture("/usage?range=all", async () => data);
    await settle();
    const rects = walk(view.root).filter((node) => node.tagName === "RECT");
    expect(rects).toHaveLength(31);
    expect(rects[1]!.children[0]!.textContent).toBe(
      "2026-01-02: No recorded activity",
    );
    expect(rects[30]!.children[0]!.textContent).toContain(
      "100 recorded tokens",
    );
  });

  it("renders untrusted project names and warnings as text, never markup", async () => {
    const data = report();
    data.projects[0]!.project = '<img src=x onerror="alert(1)">';
    data.warnings = ["<script>alert(1)</script>"];
    const view = fixture("/usage", async () => data);
    await settle();
    expect(css(view.root, "usage-project-link").textContent).toBe(
      data.projects[0]!.project,
    );
    expect(
      walk(view.root).some((node) => ["IMG", "SCRIPT"].includes(node.tagName)),
    ).toBe(false);
    expect(css(view.root, "usage-project-link").href).toContain("%3Cimg");
  });
});

describe("usage navigation", () => {
  it("retains filters through direct entry, navigation and browser history", () => {
    const events = new Map<string, () => void>();
    const panel = { dataset: { page: "usage" }, hidden: false };
    const body = { dataset: {} };
    const window = {
      location: new URL(
        "http://localhost:4311/usage?range=7d&project=shop&instance=legacy",
      ),
      dashboardPages: undefined,
      createDashboardPages: undefined as unknown as () => {
        current: string;
        navigate(path: string): boolean;
      },
      addEventListener: (name: string, fn: () => void) => events.set(name, fn),
      removeEventListener: () => {},
      dispatchEvent: () => {},
      requestAnimationFrame: () => {},
    };
    const history = {
      replaceState: (_s: unknown, _t: string, path: string) => {
        window.location = new URL(path, window.location);
      },
      pushState: (_s: unknown, _t: string, path: string) => {
        window.location = new URL(path, window.location);
      },
    };
    const document = {
      body,
      title: "",
      querySelectorAll: (selector: string) =>
        selector === "[data-page]" ? [panel] : [],
      getElementById: () => null,
      addEventListener: () => {},
      removeEventListener: () => {},
    };
    runInNewContext(pageScript, {
      window,
      document,
      history,
      URL,
      URLSearchParams,
      CustomEvent: class {},
    });
    const pages = window.createDashboardPages();
    expect(pages.current).toBe("usage");
    expect(document.title).toBe("Usage · ShipGremlins");
    expect(window.location.search).toBe(
      "?range=7d&project=shop&instance=legacy",
    );
    pages.navigate("/usage?range=all&project=_workspace");
    expect(window.location.search).toBe("?range=all&project=_workspace");
    window.location = new URL("http://localhost:4311/usage?range=30d");
    events.get("popstate")!();
    expect(pages.current).toBe("usage");
    expect(panel.hidden).toBe(false);
    pages.navigate("/usage?range=nonsense&project=../bad&instance=other");
    expect(window.location.search).toBe("");
  });
});
