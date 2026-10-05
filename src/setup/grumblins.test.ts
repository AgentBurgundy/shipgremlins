import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

type Event = { preventDefault(): void };
class Element {
  children: Element[] = [];
  parentElement: Element | null = null;
  attributes = new Map<string, string>();
  dataset: Record<string, string> = {};
  listeners = new Map<string, (event: Event) => unknown>();
  className = "";
  textContent = "";
  value = "";
  id = "";
  href = "";
  type = "";
  hidden = false;
  disabled = false;
  open = false;
  valid = true;
  classList = {
    toggle: (name: string, on: boolean) => {
      this.className = this.className
        .split(" ")
        .filter((item) => item !== name)
        .concat(on ? [name] : [])
        .join(" ");
    },
  };
  constructor(
    public tagName: string,
    private onFocus: (node: Element) => void,
  ) {}
  append(...nodes: Element[]) {
    for (const node of nodes) {
      node.remove();
      node.parentElement = this;
      this.children.push(node);
    }
  }
  replaceChildren(...nodes: Element[]) {
    for (const node of [...this.children]) node.remove();
    this.append(...nodes);
  }
  remove() {
    if (this.parentElement)
      this.parentElement.children = this.parentElement.children.filter(
        (node) => node !== this,
      );
    this.parentElement = null;
  }
  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }
  addEventListener(name: string, listener: (event: Event) => unknown) {
    this.listeners.set(name, listener);
  }
  fire(name: string) {
    return this.listeners.get(name)?.({ preventDefault() {} });
  }
  contains(node: Element) {
    return walk(this).includes(node);
  }
  focus() {
    this.onFocus(this);
  }
  showModal() {
    this.open = true;
  }
  close() {
    this.open = false;
  }
  reportValidity() {
    return this.valid;
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
const byText = (root: Element, label: string) =>
  walk(root).find((node) => node.textContent === label)!;
const buttons = (root: Element) =>
  walk(root).filter((node) => node.tagName === "BUTTON");
const profile = (id = "one") => ({
  id,
  key: id,
  name: `Customer ${id}`,
  role: "Small studio owner",
  personality: "Careful with time, impatient with unclear prices.",
  goal: "Book the next available appointment without making a phone call.",
  context: "Planning a visit between client meetings.",
  patience: "low",
  clickBudget: 8,
  familiarity: "first-time",
  device: "mobile",
  successCriteria: ["Find a suitable appointment and understand the price."],
  relevanceRationale: "The project helps independent studios accept bookings.",
  assumptions: [
    "These behavioral preferences are simulated, not measured research.",
  ],
  suggestedArea: "bookings",
});
const ready = () => ({
  project: "studio",
  projectInstanceId: "new",
  revision: "reviewed-one",
  contextRevision: "context-one",
  simulation: true,
  stale: false,
  profiles: [profile(), profile("two"), profile("three")],
  contextSummary: "Based on the studio booking brief.",
  jobs: [] as Record<string, unknown>[],
  readiness: {
    canRun: true,
    blockers: [] as { id: string; message: string; action: string }[],
    areas: [
      { key: "core", name: "Core" },
      { key: "bookings", name: "Bookings" },
    ],
  },
});
const job = (status = "queued", instance = "new") => ({
  id: "run-one",
  runId: 1,
  type: "pm",
  pmMode: "grumblin",
  project: "studio",
  projectInstanceId: instance,
  area: "bookings",
  status,
  createdAt: "2026-10-05T20:00:00Z",
  grumblin: profile(),
});
async function settle() {
  for (let index = 0; index < 15; index++) await Promise.resolve();
}
function fixture(
  api: (
    path: string,
    body?: unknown,
    method?: string,
    timeout?: number,
  ) => Promise<unknown>,
  foundation = false,
) {
  let activeElement: Element | null = null,
    locked = false,
    currentJobs: Record<string, unknown>[] = [];
  const node = (tag: string) =>
    new Element(tag.toUpperCase(), (value) => {
      activeElement = value;
    });
  const body = node("body"),
    root = node("main");
  body.append(root);
  const events = new Map<string, () => void>();
  const pages = {
    current: "project",
    project: "studio",
    pm: "",
    tab: "grumblins",
  };
  const project = {
    name: "studio",
    instanceId: "new",
    foundation: { needed: foundation },
  };
  const document = {
    body,
    hidden: false,
    createElement: node,
    addEventListener() {},
    get activeElement() {
      return activeElement;
    },
  };
  const window = {
    addEventListener: (name: string, fn: () => void) => events.set(name, fn),
  } as unknown as {
    createGrumblins(options: object): {
      mount(root: Element, project: object): void;
      refresh(name: string): Promise<void>;
      resume(projects?: object[]): void;
      forget(name: string): void;
      isBusy(): boolean;
      protectFocus(): boolean;
    };
  };
  runInNewContext(
    readFileSync(
      new URL("../../dashboard/grumblins.js", import.meta.url),
      "utf8",
    ),
    { window, document, setTimeout: () => 1, clearTimeout() {} },
  );
  const onJob = vi.fn();
  const control = window.createGrumblins({
    api,
    pages,
    onJob,
    isLocked: () => locked,
    getJobs: () => currentJobs,
  });
  control.mount(root, project);
  return {
    root,
    body,
    control,
    pages,
    project,
    onJob,
    events,
    focused: () => activeElement,
    lock: (value: boolean) => {
      locked = value;
      control.resume();
    },
    setJobs: (jobs: Record<string, unknown>[]) => {
      currentJobs = jobs;
      control.resume();
    },
  };
}

describe("project Grumblins", () => {
  it("uses the returned run status when a simulation finishes before acknowledgment", async () => {
    const f = fixture(async (path: string) =>
      path.endsWith("/run")
        ? { job: job("succeeded"), reused: false }
        : ready(),
    );
    await settle();
    buttons(f.root)
      .find((node) => node.textContent === "Simulate")!
      .fire("click");
    await settle();
    expect(text(f.root)).toContain(
      "Customer one finished. The report is ready below.",
    );
    expect(text(f.root)).not.toContain("Customer one is queued.");
  });
  it("routes failed simulations back to their saved roster instead of generic PM retry", () => {
    const app = readFileSync(
      new URL("../../dashboard/app.js", import.meta.url),
      "utf8",
    );
    const start = app.indexOf("  function renderJobControls() {"),
      end = app.indexOf('  $("job-list").addEventListener', start);
    expect(start).toBeGreaterThan(0);
    const root = new Element("DIV", () => {});
    const api = vi.fn();
    const render = runInNewContext(`(${app.slice(start, end).trim()})`, {
      $: () => root,
      mergedJobs: () => [job("failed")],
      selectedJobId: "run-one",
      jobActionBusy: false,
      formsLocked: false,
      currentStatus: { projects: [{ name: "studio", instanceId: "new" }] },
      api,
      element: (tag: string, className: string, textContent: string) =>
        Object.assign(new Element(tag.toUpperCase(), () => {}), {
          className,
          textContent,
        }),
    }) as () => void;
    render();
    expect(root.children).toHaveLength(1);
    expect(root.children[0]!.tagName).toBe("A");
    expect(root.children[0]!.href).toBe("/projects/studio?tab=grumblins");
    expect(text(root)).toContain("Review Grumblin & simulate again");
    expect(api).not.toHaveBeenCalled();
  });
  it("preserves the previous capable PM on rerun and keeps roster context in the optional refinement", async () => {
    const data = ready();
    data.jobs = [{ ...job("succeeded"), area: "core" }];
    const api = vi.fn(async (path: string) =>
      path.endsWith("/run") ? { job: { ...job(), area: "core" } } : data,
    );
    const f = fixture(api);
    await settle();
    expect(css(f.root, "grumblins-context").parentElement).toBe(
      css(f.root, "grumblins-focus"),
    );
    expect(css(f.root, "grumblins-focus").hidden).toBe(true);
    byText(f.root, "Simulate again").fire("click");
    await settle();
    expect(api).toHaveBeenCalledWith("/api/projects/studio/grumblins/run", {
      profileId: "one",
      revision: "reviewed-one",
      area: "core",
    });
    expect(text(f.root)).toContain("Customer one is queued.");
  });
  it("asks one optional question and creates relevant profiles without automatically running them", async () => {
    let data = { ...ready(), profiles: [] as ReturnType<typeof profile>[] };
    const api = vi.fn(async (path: string, body?: unknown) => {
      if (path.endsWith("/generate")) {
        data = ready();
        return data;
      }
      expect(body).toBeUndefined();
      return data;
    });
    const f = fixture(api);
    await settle();
    const input = walk(f.root).find((node) => node.tagName === "INPUT")!;
    expect(text(f.root)).toContain("Anything you want them to try?");
    expect(
      walk(f.root).filter((node) => node.tagName === "INPUT"),
    ).toHaveLength(1);
    input.value = "  First appointment on mobile  ";
    css(f.root, "grumblins-focus").fire("submit");
    await settle();
    expect(api).toHaveBeenCalledWith(
      "/api/projects/studio/grumblins/generate",
      { focus: "First appointment on mobile" },
      "POST",
      190000,
    );
    expect(
      walk(f.root).filter((node) => node.className.includes("grumblin-card")),
    ).toHaveLength(3);
    expect(css(f.root, "grumblins-focus").hidden).toBe(true);
    expect(api.mock.calls.some(([path]) => path.endsWith("/run"))).toBe(false);
    expect(text(f.root)).toContain("not real customer research");
  });
  it("shows profiles for an unbuilt idea while refusing simulation and guiding the foundation", async () => {
    const api = vi.fn(async () => ready()),
      f = fixture(api, true);
    await settle();
    expect(text(f.root)).toContain(
      "Meet them now. Let them try it after the foundation.",
    );
    expect(byText(f.root, "Build the foundation →").href).toBe(
      "/projects/studio?tab=environment",
    );
    const run = buttons(f.root).find(
      (node) => node.attributes.get("aria-label") === "Simulate Customer one",
    )!;
    expect(run.disabled).toBe(true);
    run.fire("click");
    await settle();
    expect(api).toHaveBeenCalledOnce();
    f.control.resume([{ ...f.project, foundation: { needed: false } }]);
    expect(run.disabled).toBe(false);
  });
  it("preserves explicit environment blockers and does not enable a stale profile", async () => {
    const data = ready();
    data.readiness.canRun = false;
    data.readiness.blockers = [
      {
        id: "environment",
        action: "environment",
        message: "Test your staging app first.",
      },
    ];
    const f = fixture(async () => data);
    await settle();
    expect(text(f.root)).toContain("Test your staging app first.");
    expect(byText(f.root, "Review setup →").href).toBe(
      "/projects/studio?tab=environment",
    );
    data.readiness.canRun = true;
    data.stale = true;
    await f.control.refresh("studio");
    expect(text(f.root)).toContain("Your project has changed");
    expect(
      buttons(f.root)
        .filter((node) => node.textContent === "Simulate")
        .every((node) => node.disabled),
    ).toBe(true);
    byText(f.root, "Refresh my Grumblins").fire("click");
    expect(css(f.root, "grumblins-focus").hidden).toBe(false);
  });
  it("runs exactly the reviewed profile on its suggested PM and blocks duplicate starts", async () => {
    let finish!: (value: unknown) => void;
    const data = ready();
    const api = vi.fn(async (path: string) =>
      path.endsWith("/run")
        ? new Promise((resolve) => {
            finish = resolve;
          })
        : data,
    );
    const f = fixture(api);
    await settle();
    const run = buttons(f.root).find(
      (node) => node.attributes.get("aria-label") === "Simulate Customer one",
    )!;
    run.fire("click");
    run.fire("click");
    await settle();
    expect(api).toHaveBeenCalledWith("/api/projects/studio/grumblins/run", {
      profileId: "one",
      revision: "reviewed-one",
      area: "bookings",
    });
    expect(
      api.mock.calls.filter(([path]) => path.endsWith("/run")),
    ).toHaveLength(1);
    expect(f.control.isBusy()).toBe(true);
    finish({ job: job(), reused: false });
    await settle();
    expect(f.onJob).toHaveBeenCalledOnce();
    expect(run.disabled).toBe(true);
    expect(text(f.root)).toContain("Waiting for an available runner");
    f.setJobs([job("succeeded")]);
    expect(run.disabled).toBe(false);
    expect(byText(f.root, "Read report").href).toBe("/activity?run=run-one");
    expect(byText(f.root, "PM Learning →").href).toBe(
      "/projects/studio?pm=bookings&tab=discovery",
    );
  });
  it("keeps the exact server rejection and generated profiles after a run fails", async () => {
    const api = vi.fn(async (path: string) => {
      if (path.endsWith("/run"))
        throw new Error(
          "The browser test expired. Test this environment again.",
        );
      return ready();
    });
    const f = fixture(api);
    await settle();
    buttons(f.root)
      .find((node) => node.textContent === "Simulate")!
      .fire("click");
    await settle();
    expect(text(f.root)).toContain(
      "The browser test expired. Test this environment again.",
    );
    expect(
      walk(f.root).filter((node) => node.className.includes("grumblin-card")),
    ).toHaveLength(3);
    expect(byText(f.root, "Refresh status").hidden).toBe(false);
    expect(f.onJob).not.toHaveBeenCalled();
  });
  it("retains optional focus and the existing profiles after a generation error", async () => {
    const api = vi.fn(async (path: string) => {
      if (path.endsWith("/generate"))
        throw new Error("Claude needs to reconnect.");
      return ready();
    });
    const f = fixture(api);
    await settle();
    byText(f.root, "Refine your Grumblins").fire("click");
    const input = walk(f.root).find((node) => node.tagName === "INPUT")!;
    input.value = "My saved goal";
    css(f.root, "grumblins-focus").fire("submit");
    await settle();
    expect(input.value).toBe("My saved goal");
    expect(text(f.root)).toContain("Claude needs to reconnect.");
    byText(f.root, "Keep these Grumblins").fire("click");
    expect(css(f.root, "grumblins-grid").hidden).toBe(false);
  });
  it("preserves original profile controls during refresh and returns focus from the detailed assumptions", async () => {
    const data = ready();
    data.profiles[0]!.assumptions = ["<script>inert profile text</script>"];
    const f = fixture(async () => structuredClone(data));
    await settle();
    const trigger = byText(f.root, "Meet Customer one");
    trigger.fire("click");
    const dialog = css(f.body, "grumblins-dialog");
    expect(dialog.open).toBe(true);
    expect(text(dialog)).toContain("<script>inert profile text</script>");
    expect(walk(dialog).some((node) => node.tagName === "SCRIPT")).toBe(false);
    expect(f.control.protectFocus()).toBe(true);
    await f.control.refresh("studio");
    expect(byText(f.root, "Meet Customer one")).toBe(trigger);
    expect(dialog.open).toBe(true);
    dialog.fire("cancel");
    expect(f.focused()).toBe(trigger);
    trigger.fire("click");
    f.pages.current = "activity";
    f.events.get("dashboard:pagechange")?.();
    expect(dialog.open).toBe(false);
  });
  it("ignores late generation for a forgotten project and makes no run", async () => {
    let finish!: (value: unknown) => void;
    const api = vi.fn(async (path: string) =>
      path.endsWith("/generate")
        ? new Promise((resolve) => {
            finish = resolve;
          })
        : { ...ready(), profiles: [] },
    );
    const f = fixture(api);
    await settle();
    css(f.root, "grumblins-focus").fire("submit");
    await settle();
    f.control.forget("studio");
    finish(ready());
    await settle();
    expect(f.root.children).toHaveLength(0);
    expect(walk(f.body).some((node) => node.tagName === "DIALOG")).toBe(false);
    expect(f.onJob).not.toHaveBeenCalled();
  });
  it("excludes simulations from an earlier project incarnation and disables controls when locked", async () => {
    const data = ready();
    data.jobs = [job("succeeded", "old")];
    const f = fixture(async () => data);
    await settle();
    expect(css(f.root, "grumblins-history").hidden).toBe(true);
    f.lock(true);
    expect(
      buttons(f.root)
        .filter((node) => node.textContent === "Simulate")
        .every((node) => node.disabled),
    ).toBe(true);
    expect(byText(f.root, "Find my Grumblins").disabled).toBe(true);
  });
});

function reportFixture(
  fetchArtifact: (
    id: string,
    file: object,
    signal?: AbortSignal,
  ) => Promise<Blob>,
) {
  const node = (tag: string) => new Element(tag.toUpperCase(), () => {}),
    root = node("section");
  const window = {} as {
    renderKnowledgeDocument(value: string): Element;
    createGrumblinReport(options: object): {
      select(id: string, job: object | null): Promise<void> | undefined;
      render(
        id: string,
        files: object[],
        context: { isCurrent(): boolean; signal?: AbortSignal },
      ): Promise<void>;
      clear(): void;
    };
  };
  const document = {
    createElement: node,
    createTextNode: (textContent: string) =>
      Object.assign(node("#text"), { textContent }),
  };
  const context = { window, document, URL };
  for (const file of ["project-workspace", "grumblins"])
    runInNewContext(
      readFileSync(
        new URL(`../../dashboard/${file}.js`, import.meta.url),
        "utf8",
      ),
      context,
    );
  const report = window.createGrumblinReport({
    root,
    fetchArtifact,
    renderMarkdown: window.renderKnowledgeDocument,
  });
  report.select("run-one", job("succeeded"));
  return { root, report };
}
const reportFile = (sha256 = "a".repeat(64), size = 100) => ({
  name: "summary.md",
  size,
  sha256,
  url: "/api/jobs/run-one/artifacts/summary.md",
});
describe("inline Grumblin reports", () => {
  it("uses safe Markdown rendering and fetches an unchanged digest once", async () => {
    const fetchArtifact = vi.fn(
      async () =>
        new Blob([
          "# A useful finding\n<script>unsafe()</script>\n[Unsafe](javascript:alert)\n\n- A concrete observation",
        ]),
    );
    const f = reportFixture(fetchArtifact),
      context = { isCurrent: () => true };
    await f.report.render("run-one", [reportFile()], context);
    await f.report.render("run-one", [reportFile()], context);
    await f.report.select("run-one", job("succeeded"));
    expect(fetchArtifact).toHaveBeenCalledOnce();
    expect(text(f.root)).toContain("A useful finding");
    expect(text(f.root)).toContain("<script>unsafe()</script>");
    expect(walk(f.root).some((node) => node.tagName === "SCRIPT")).toBe(false);
    expect(
      walk(f.root).some((node) => node.href.startsWith("javascript:")),
    ).toBe(false);
    expect(text(f.root)).toContain("hypotheses to check with real customers");
  });
  it("rejects missing, invalid, and oversized metadata before fetching and checks the actual blob too", async () => {
    const fetchArtifact = vi.fn(async () => new Blob(["x".repeat(65537)]));
    const f = reportFixture(fetchArtifact),
      context = { isCurrent: () => true };
    for (const size of [undefined, -1, 65537, 1.5])
      await f.report.render("run-one", [{ ...reportFile(), size }], context);
    expect(fetchArtifact).not.toHaveBeenCalled();
    await f.report.render("run-one", [reportFile()], context);
    expect(fetchArtifact).toHaveBeenCalledOnce();
    expect(css(f.root, "grumblins-report-content").children).toHaveLength(0);
    expect(text(f.root)).toContain("64 KiB");
  });
  it("does not insert a late report after the viewer switches runs", async () => {
    let finish!: (value: Blob) => void;
    const f = reportFixture(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    let current = true;
    const pending = f.report.render("run-one", [reportFile()], {
      isCurrent: () => current,
    });
    current = false;
    f.report.select("another-run", { ...job(), id: "another-run" });
    finish(new Blob(["Prior run private report"]));
    await pending;
    expect(text(f.root)).not.toContain("Prior run private report");
    expect(css(f.root, "grumblins-report-content").children).toHaveLength(0);
  });
  it("keeps the loaded report through refresh failure and hides it for ordinary runs", async () => {
    let fail = false;
    const fetchArtifact = vi.fn(async () => {
      if (fail) throw new Error("Artifact storage is reconnecting.");
      return new Blob(["# Retained finding"]);
    });
    const f = reportFixture(fetchArtifact),
      context = { isCurrent: () => true };
    await f.report.render("run-one", [reportFile()], context);
    fail = true;
    await f.report.render("run-one", [reportFile("b".repeat(64))], context);
    expect(text(f.root)).toContain("Retained finding");
    expect(text(f.root)).toContain("The previously loaded report is kept.");
    f.report.select("ordinary", { type: "pm", status: "succeeded" });
    expect(f.root.hidden).toBe(true);
    expect(text(f.root)).not.toContain("Retained finding");
  });
});
