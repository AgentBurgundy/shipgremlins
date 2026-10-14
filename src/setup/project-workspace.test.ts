import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

class Element {
  children: Element[] = [];
  attributes = new Map<string, string>();
  className = "";
  classList = { add: () => {} };
  parentElement: Element | null = null;
  textContent = "";
  value = "";
  open = false;
  disabled = false;
  focus = vi.fn();
  listeners = new Map<string, (event?: unknown) => unknown>();
  href = "";
  rel = "";
  target = "";
  dataset: Record<string, string> = {};
  constructor(public tagName: string) {}
  append(...children: Element[]) {
    for (const child of children) child.parentElement = this;
    this.children.push(...children);
  }
  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }
  getAttribute(name: string) {
    return this.attributes.get(name) ?? null;
  }
  contains(element: Element): boolean {
    return (
      element === this || this.children.some((child) => child.contains(element))
    );
  }
  querySelectorAll(selector: string): Element[] {
    const tags = selector.split(",").map((tag) => tag.trim().toUpperCase());
    return this.children.flatMap((child) => [
      ...(tags.includes(child.tagName) ? [child] : []),
      ...child.querySelectorAll(selector),
    ]);
  }
  addEventListener(name: string, callback: (event?: unknown) => unknown) {
    this.listeners.set(name, callback);
  }
  replaceChildren(...children: Element[]) {
    this.children = children;
  }
  fire(name: string, event?: unknown) {
    return this.listeners.get(name)?.(event);
  }
}
function fixture() {
  const window = {} as {
    addEventListener(): void;
    renderKnowledgeDocument: (
      value: string,
      options?: { setupProposal?: object },
    ) => Element;
    createProjectWorkspace: (
      root: Element,
      options: object,
    ) => {
      setStatus(value: object, locked: boolean): void;
      render(): void;
      refresh(): Promise<void>;
    };
    createPmCharter: (
      root: Element,
      prefix: string,
      initial: object,
    ) => { read(): object; reset(): void };
    createProjectWelcome?: (options: object) => object;
    createProjectMissions?: (options: object) => object;
  };
  window.addEventListener = () => {};
  const document = {
    body: new Element("BODY"),
    hidden: true,
    activeElement: null as Element | null,
    getElementById: () => null,
    addEventListener() {},
    createElement: (name: string) => new Element(name.toUpperCase()),
    createTextNode: (value: string) =>
      Object.assign(new Element("#TEXT"), { textContent: value }),
  };
  const context = {
    window,
    document,
    URL,
    URLSearchParams,
    clearTimeout,
    setTimeout,
    queueMicrotask,
    AbortController,
  };
  for (const name of [
    "crew-guidance",
    "first-run",
    "coding-launch",
    "patrol-flow",
    "project-workspace",
    "pm-charter",
  ])
    runInNewContext(
      readFileSync(
        new URL(`../../dashboard/${name}.js`, import.meta.url),
        "utf8",
      ),
      context,
    );
  return Object.assign(window, { document });
}
const all = (root: Element): Element[] => [root, ...root.children.flatMap(all)];
const text = (root: Element): string =>
  root.textContent + root.children.map(text).join("");

describe("PM workspace knowledge", () => {
  it("hides only the matching reviewed setup machine block while preserving the learning and ordinary code", () => {
    const renderer = fixture().renderKnowledgeDocument,
      proposal = {
        commands: { install: "npm ci", test: "npm test" },
        paths: ["src"],
      },
      block =
        "```shipgremlins-setup\n" +
        JSON.stringify({
          paths: proposal.paths,
          commands: { test: "npm test", install: "npm ci" },
        }) +
        "\n```",
      content =
        "# Findings\nUseful learning.\n\n" +
        block +
        "\n\n```js\nconst ordinary = true;\n```\nNext steps.";
    const rendered = renderer(content, { setupProposal: proposal });
    expect(text(rendered)).toContain("Useful learning.");
    expect(text(rendered)).toContain("const ordinary = true;");
    expect(text(rendered)).toContain("Next steps.");
    expect(text(rendered)).not.toContain("npm ci");
    expect(all(rendered).filter((item) => item.tagName === "PRE")).toHaveLength(
      1,
    );
    expect(text(renderer(content))).toContain("npm ci");
    expect(
      text(
        renderer(content, { setupProposal: { ...proposal, paths: ["other"] } }),
      ),
    ).toContain("npm ci");
    expect(
      text(renderer(content + "\n" + block, { setupProposal: proposal })),
    ).toContain("npm ci");
    expect(
      text(
        renderer("```shipgremlins-setup\ninvalid JSON\n```", {
          setupProposal: proposal,
        }),
      ),
    ).toContain("invalid JSON");
  });
  it("renders feature and queue tables as accessible scrollable DOM, including useful evidence links", () => {
    const root = fixture().renderKnowledgeDocument(
      "# Ranked queue\n| Priority | Opportunity | Evidence |\n| --- | --- | --- |\n| **1** | Preserve `deliveryMethod` | [Source](https://github.com/example/app/blob/main/checkout.ts) |\n| 2 | Improve errors | Pending investigation |\n\nOwner approval is still required.",
    );
    expect(all(root).filter((item) => item.tagName === "TABLE")).toHaveLength(
      1,
    );
    expect(all(root).filter((item) => item.tagName === "TH")).toHaveLength(3);
    expect(all(root).filter((item) => item.tagName === "TD")).toHaveLength(6);
    expect(
      all(root)
        .find((item) => item.className === "knowledge-table-wrap")
        ?.attributes.get("role"),
    ).toBe("region");
    expect(
      all(root).find((item) => item.tagName === "STRONG")?.textContent,
    ).toBe("1");
    expect(all(root).find((item) => item.tagName === "CODE")?.textContent).toBe(
      "deliveryMethod",
    );
    expect(all(root).find((item) => item.tagName === "A")?.rel).toBe(
      "noopener noreferrer",
    );
    expect(text(root)).toContain("Owner approval is still required.");
  });
  it("never interprets HTML, private URL credentials, or active schemes as executable content", () => {
    const root = fixture().renderKnowledgeDocument(
      "<script>window.pwned=true</script>\n[Bad](javascript:alert) [Credentials](https://user:secret@example.com) [Token](https://example.com?access_token=private) [Code](https://example.com?code=private)\n![Image](https://example.com/image.png)",
    );
    expect(
      all(root).some((item) => ["SCRIPT", "IMG"].includes(item.tagName)),
    ).toBe(false);
    expect(
      all(root)
        .filter((item) => item.tagName === "A")
        .every(
          (item) => !/javascript:|user:secret|token|code=/.test(item.href),
        ),
    ).toBe(true);
    expect(text(root)).toContain("<script>window.pwned=true</script>");
    expect(text(root)).toContain("Credentials");
  });
  it("preserves code and separates prose, lists, and headings without dropping unrecognized text", () => {
    const root = fixture().renderKnowledgeDocument(
      "## Findings\n1. First\n2. Second\n\n> Check the evidence\n```\n| not | a table |\n<script>literal</script>\n```\nRemaining question.",
    );
    expect(all(root).filter((item) => item.tagName === "OL")).toHaveLength(1);
    expect(all(root).filter((item) => item.tagName === "LI")).toHaveLength(2);
    expect(
      all(root).find((item) => item.tagName === "PRE")?.textContent,
    ).toContain("<script>literal</script>");
    expect(text(root)).toContain("Remaining question.");
  });
});

describe("progressive PM product brief", () => {
  it("round-trips named charter fields and preserves separate creation/edit inputs", () => {
    const api = fixture(),
      first = new Element("DIV"),
      second = new Element("DIV");
    const a = api.createPmCharter(first, "first", {
      ambition: "Useful software",
      users: ["Makers", "Buyers"],
      guardrails: ["Synthetic data only"],
    });
    const b = api.createPmCharter(second, "second", {
      goal: "A different project",
    });
    expect(a.read()).toEqual({
      ambition: "Useful software",
      users: ["Makers", "Buyers"],
      guardrails: ["Synthetic data only"],
    });
    const users = all(first).find(
      (item) => item.dataset.charterKey === "users",
    )!;
    users.value = "  New users  \n\nReturning users\n";
    expect(a.read()).toMatchObject({ users: ["New users", "Returning users"] });
    expect(b.read()).toEqual({ goal: "A different project" });
    a.reset();
    expect(a.read()).toEqual({});
    expect(b.read()).toEqual({ goal: "A different project" });
  });
});

describe("focused project crew workspace", () => {
  function workspace() {
    const root = new Element("MAIN"),
      pages = {
        current: "project",
        project: "shipgremlins",
        pm: "",
        tab: "crew",
      };
    const project = {
      name: "shipgremlins",
      repo: "AgentBurgundy/shipgremlins",
      readiness: { canRun: true, blockers: [] },
      areas: [
        {
          key: "security-gremlin-v2",
          name: "Security gremlin v2",
          mandate: "Find reproducible RBAC gaps using synthetic users.",
          enabled: false,
          charter: { goal: "Protect each workspace's data." },
        },
      ],
    };
    const state = { projects: [project] },
      jobs: object[] = [];
    const view = fixture().createProjectWorkspace(root, {
      pages,
      api: async () => ({}),
      getJobs: () => jobs,
    });
    view.setStatus(state, false);
    return { root, pages, project, state, view, jobs };
  }
  it("keeps PM controls and both independent automations on the crew page, with settings separate", () => {
    const { root, pages, view } = workspace();
    const row = all(root).find((item) => item.className === "project-pm-row")!;
    expect(row.children.map((item) => item.className)).toEqual([
      "",
      "project-pm-copy",
      "pm-simple-controls",
    ]);
    expect(all(row).find((item) => item.tagName === "A")?.href).toBe(
      "/projects/shipgremlins?pm=security-gremlin-v2",
    );
    expect(
      all(row).find((item) => item.dataset.launchArea)?.dataset,
    ).toMatchObject({
      launchProject: "shipgremlins",
      launchArea: "security-gremlin-v2",
      launchCrew: "pm",
    });
    expect(
      all(row).filter((item) => item.attributes.get("role") === "switch"),
    ).toHaveLength(2);
    expect(text(row)).not.toContain("Open workspace");
    expect(text(root)).not.toContain("Run discovery");
    const header = all(root).find(
      (item) => item.className === "workspace-project-header",
    )!;
    expect(text(header)).not.toContain("Run coding");
    expect(text(header)).toContain("shipgremlins");
    expect(text(root)).toContain("Look for new improvements");
    expect(text(root)).toContain("Automatically build approved work");
    expect(text(root)).not.toContain("Project details");
    const coding = all(root).find(
      (item) => item.className === "coding-launch",
    )!;
    expect(text(coding)).toContain("next approved ticket");
    expect(text(coding)).toContain("Start coding");
    expect(
      all(coding).find((item) => item.dataset.launchCrew === "developer")
        ?.dataset.launchProject,
    ).toBe("shipgremlins");
    pages.tab = "settings";
    view.render();
    const details = all(root).find((item) =>
      item.className.includes("project-details project-reference"),
    )!;
    expect(details.tagName).toBe("SECTION");
    expect(text(details)).toContain("AgentBurgundy/shipgremlins");
  });
  it("keeps project reference visible across polling and labels an active PM action View run", () => {
    const { root, state, view, jobs, pages } = workspace();
    jobs.push({
      id: "run-1",
      runId: 1,
      project: "shipgremlins",
      area: "security-gremlin-v2",
      type: "pm",
      status: "running",
    });
    view.setStatus(state, false);
    expect(all(root).find((item) => item.dataset.launchArea)?.textContent).toBe(
      "View run",
    );
    pages.tab = "settings";
    view.render();
    view.setStatus(state, false);
    const details = all(root).find((item) =>
      item.className.includes("project-details project-reference"),
    )!;
    expect(details.tagName).toBe("SECTION");
    expect(text(details)).toContain("AgentBurgundy/shipgremlins");
  });
  it("does not attach old project runs to a replacement with the same visible name", () => {
    const { root, state, view, jobs, project, pages } = workspace();
    jobs.push({
      id: "old",
      runId: 1,
      project: project.name,
      area: project.areas[0]!.key,
      type: "pm",
      status: "running",
    });
    Object.assign(project, { instanceId: "fresh-project" });
    view.setStatus(state, false);
    expect(all(root).find((item) => item.dataset.launchArea)?.textContent).toBe(
      "Run now",
    );
    expect(text(root)).not.toContain("Run 1");
    jobs.push({
      id: "new",
      runId: 2,
      project: project.name,
      projectInstanceId: "fresh-project",
      area: project.areas[0]!.key,
      type: "pm",
      status: "running",
    });
    view.setStatus(state, false);
    expect(all(root).find((item) => item.dataset.launchArea)?.textContent).toBe(
      "View run",
    );
    pages.tab = "overview";
    view.render();
    expect(text(root)).toContain("Run 2");
  });
  it("keeps direct PM switching when the project has more than one PM", () => {
    const { root, pages, project, view } = workspace();
    project.areas.push({
      ...project.areas[0]!,
      key: "imports",
      name: "Import quality",
    });
    pages.pm = "security-gremlin-v2";
    pages.tab = "brief";
    view.render();
    const navigation = all(root).find(
      (item) => item.className === "pm-workspace-nav",
    )!;
    expect(all(navigation).filter((item) => item.tagName === "A")).toHaveLength(
      2,
    );
    expect(
      all(navigation).find((item) => item.textContent === "Import quality")
        ?.href,
    ).toBe("/projects/shipgremlins?pm=imports");
  });
  it("keeps discovery in Learning while brief, deletion and project settings remain accessible", () => {
    const { root, pages, view } = workspace();
    pages.pm = "security-gremlin-v2";
    pages.tab = "brief";
    view.render();
    expect(text(root)).not.toContain("Run discovery");
    expect(text(root)).toContain("Find reproducible RBAC gaps");
    expect(
      all(root).find((item) => item.className === "pm-workspace-nav"),
    ).toBeUndefined();
    expect(
      all(root).filter((item) => item.className === "pm-project-link"),
    ).toHaveLength(1);
    expect(
      all(root).find((item) => item.className === "pm-project-link")?.href,
    ).toBe("/projects/shipgremlins");
    expect(text(root)).not.toContain("All projects");
    expect(text(root)).not.toContain("Project overview");
    expect(
      text(
        all(root).find((item) => item.className === "pm-workspace-heading")!,
      ),
    ).not.toContain("Edit brief");
    expect(
      text(all(root).find((item) => item.className === "pm-brief-heading")!),
    ).toBe("MandateEdit brief");
    expect(
      all(root).find((item) => item.className.includes("pm-brief-details"))
        ?.tagName,
    ).toBe("SECTION");
    expect(text(root)).toContain("Protect each workspace's data.");
    expect(
      all(root).find((item) => item.className.includes("pm-delete-action"))
        ?.tagName,
    ).toBe("DETAILS");
    expect(text(root)).toContain("Delete PM");
    expect(
      all(root).find((item) => item.textContent === "Learning")?.href,
    ).toBe("/projects/shipgremlins?pm=security-gremlin-v2&tab=discovery");
    pages.tab = "discovery";
    view.render();
    expect(
      all(root).filter((item) => item.textContent === "Run discovery"),
    ).toHaveLength(0);
    expect(text(root)).toContain("Loading the latest saved knowledge");
  });
});

describe("polished PM workspace interaction states", () => {
  async function workspace(firstLoadFailure = false) {
    const ui = fixture(),
      root = new Element("MAIN");
    const pages = {
      current: "project",
      project: "app",
      pm: "core",
      tab: "discovery",
    };
    const project = {
      name: "app",
      repo: "owner/app",
      instanceId: "current",
      areas: [
        {
          key: "core",
          name: "Core Gremlin",
          enabled: true,
          discoveryRevision: "revision",
          mandate: "Make useful improvements.",
        },
      ],
    };
    let data: object = { state: "empty", documents: [] };
    let failure = firstLoadFailure;
    const jobs: Record<string, unknown>[] = [];
    const api = vi.fn(async () => {
      if (failure) throw new Error("Connection unavailable");
      return data;
    });
    ui.document.hidden = false;
    const view = ui.createProjectWorkspace(root, {
      pages,
      api,
      getJobs: () => jobs,
    });
    view.setStatus({ projects: [project] }, false);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    return {
      ui,
      root,
      pages,
      project,
      view,
      api,
      jobs,
      data: (value: object) => {
        data = value;
      },
      fail: (value: boolean) => {
        failure = value;
      },
    };
  }
  it("uses one contextual return link and one PM heading, without the empty sidebar or unrelated adoption action", async () => {
    const f = await workspace();
    expect(
      all(f.root).filter((item) => item.className === "pm-project-link"),
    ).toHaveLength(1);
    expect(
      all(f.root)
        .filter((item) => item.tagName === "H1")
        .map((item) => item.textContent),
    ).toEqual(["Core Gremlin"]);
    expect(
      all(f.root).find((item) => item.className === "workspace-project-header"),
    ).toBeUndefined();
    expect(
      all(f.root).find((item) => item.className === "pm-workspace-nav"),
    ).toBeUndefined();
    expect(text(f.root)).not.toContain("Adopt a gremlin");
    expect(
      all(f.root).find((item) => item.dataset.editProject)?.dataset.editProject,
    ).toBe("app");
  });
  it("shows one discovery action in a compact genuine empty state, without the nested illustration/callout", async () => {
    const f = await workspace();
    expect(
      all(f.root).filter((item) => item.textContent === "Run discovery"),
    ).toHaveLength(1);
    const empty = all(f.root).find((item) =>
      item.className.includes("pm-knowledge-empty"),
    )!;
    expect(all(empty).filter((item) => item.tagName === "IMG")).toHaveLength(0);
    expect(text(empty)).toContain("No hosting or ticket tracker needed");
    expect(
      all(f.root).find((item) => item.className === "pm-learning-actions"),
    ).toBeUndefined();
  });
  it("keeps cached knowledge during a refresh failure and gives a distinct recoverable first-load error", async () => {
    const f = await workspace();
    f.data({
      state: "ready",
      documents: [
        { name: "discovery.md", content: "# Findings\nSaved evidence." },
      ],
    });
    await f.view.refresh();
    f.fail(true);
    await f.view.refresh();
    expect(text(f.root)).toContain("Saved evidence");
    expect(
      all(f.root).find((item) => item.attributes.get("role") === "alert"),
    ).toBeDefined();
    expect(
      all(f.root).find((item) => item.className.includes("pm-knowledge-empty")),
    ).toBeUndefined();
    const blank = await workspace();
    blank.view.refresh();
    blank.fail(true);
    await blank.view.refresh();
    blank.ui.document.hidden = true;
    // A fresh PM identity has no cached notes; failure must not advertise a blank product.
    blank.pages.pm = "new";
    const fresh = {
      ...blank.project,
      areas: [{ ...blank.project.areas[0]!, key: "new" }],
    };
    blank.view.setStatus({ projects: [fresh] }, false);
    blank.ui.document.hidden = false;
    await blank.view.refresh();
    expect(text(blank.root)).toContain("Couldn’t load this knowledge");
    expect(
      all(blank.root).find((item) =>
        item.className.includes("pm-knowledge-empty"),
      ),
    ).toBeUndefined();
    blank.fail(false);
    await blank.view.refresh();
    expect(
      all(blank.root).find((item) =>
        item.className.includes("pm-knowledge-empty"),
      ),
    ).toBeDefined();
  });
  it("distinguishes queued from running discovery and ignores stale project/PM scope", async () => {
    const f = await workspace();
    const job = {
      id: "one",
      runId: 1,
      type: "pm",
      pmMode: "discovery",
      project: "app",
      projectInstanceId: "current",
      area: "core",
      discoveryRevision: "revision",
      status: "queued",
    };
    f.jobs.push(job);
    f.view.render();
    expect(
      all(f.root).find((item) => item.dataset.focusKey === "run-discovery"),
    ).toMatchObject({ textContent: "Discovery queued", disabled: true });
    job.status = "running";
    f.view.render();
    expect(
      all(f.root).find((item) => item.dataset.focusKey === "run-discovery")
        ?.textContent,
    ).toBe("Discovery running…");
    job.projectInstanceId = "old";
    f.view.render();
    expect(
      all(f.root).find((item) => item.dataset.focusKey === "run-discovery")
        ?.textContent,
    ).toBe("Run discovery");
  });
  it("keeps native section links and moves keyboard focus without changing routes", async () => {
    const f = await workspace();
    const nav = all(f.root).find(
      (item) => item.className === "pm-workspace-tabs",
    )!;
    f.ui.document.activeElement = nav.children[1]!;
    const preventDefault = vi.fn();
    nav.fire("keydown", { key: "ArrowRight", preventDefault });
    expect(nav.children[2]!.focus).toHaveBeenCalled();
    nav.fire("keydown", { key: "End", preventDefault });
    expect(nav.children[5]!.focus).toHaveBeenCalled();
    expect(f.pages.tab).toBe("discovery");
    expect(nav.children[1]!.attributes.get("aria-current")).toBe("page");
  });
  it("restores the focused section after a status poll replaces the PM DOM", async () => {
    const f = await workspace();
    const original = all(f.root).find((item) =>
      item.href.endsWith("tab=memory"),
    )!;
    f.ui.document.activeElement = original;
    f.jobs.push({
      id: "one",
      runId: 1,
      project: "app",
      projectInstanceId: "current",
      type: "pm",
      area: "core",
      status: "queued",
    });
    f.view.render();
    const replacement = all(f.root).find((item) =>
      item.href.endsWith("tab=memory"),
    )!;
    expect(replacement).not.toBe(original);
    expect(replacement.focus).toHaveBeenCalledWith({ preventScroll: true });
  });
  it("restores product exploration to its own action instead of the patrol launcher", async () => {
    const f = await workspace();
    f.pages.tab = "brief";
    f.view.render();
    const explore = all(f.root).find(
      (item) => item.dataset.pmMode === "exploration",
    )!;
    f.ui.document.activeElement = explore;
    f.jobs.push({
      id: "one",
      runId: 1,
      project: "app",
      projectInstanceId: "current",
      type: "pm",
      area: "core",
      status: "queued",
    });
    f.view.render();
    const replacement = all(f.root).find(
      (item) => item.dataset.pmMode === "exploration",
    )!;
    expect(replacement.focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(
      all(f.root).find(
        (item) => item.dataset.launchCrew === "pm" && !item.dataset.pmMode,
      )?.focus,
    ).not.toHaveBeenCalled();
  });
  it("clears an uncached first-load error when a replacement project starts loading", async () => {
    const f = await workspace(true);
    expect(text(f.root)).toContain("Couldn’t load this knowledge");
    let finish!: (value: object) => void;
    f.api.mockImplementationOnce(
      () =>
        new Promise<object>((resolve) => {
          finish = resolve;
        }),
    );
    f.view.setStatus(
      { projects: [{ ...f.project, instanceId: "replacement" }] },
      false,
    );
    expect(text(f.root)).toContain("Loading the latest saved knowledge");
    expect(text(f.root)).not.toContain("Connection unavailable");
    expect(text(f.root)).not.toContain("Couldn’t load this knowledge");
    finish({ state: "empty", documents: [] });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(
      all(f.root).find((item) => item.className.includes("pm-knowledge-empty")),
    ).toBeDefined();
  });
});

describe("project-first investigation", () => {
  function onboarding() {
    const ui = fixture(),
      root = new Element("MAIN"),
      jobs: Record<string, unknown>[] = [];
    const welcome = {
      mount: vi.fn(),
      resume: vi.fn(),
      forget: vi.fn(),
      protectFocus: () => false,
      isBusy: () => false,
    };
    const missions = {
      mount: vi.fn(),
      forget: vi.fn(),
      protectFocus: () => false,
      isBusy: () => false,
    };
    ui.createProjectWelcome = () => welcome;
    ui.createProjectMissions = () => missions;
    const project = {
      name: "shop",
      instanceId: "current",
      repo: "org/shop",
      areas: [] as { key: string; name: string }[],
      onboardingProgress: { investigated: false, hasMissions: false },
      readiness: {
        areas: [] as {
          key: string;
          discovery: { canRun: boolean; blockers?: object[] };
        }[],
      },
    };
    const api = vi.fn(async () => ({
      job: {
        id: "new",
        runId: 2,
        project: "shop",
        projectInstanceId: "current",
        area: "core",
        type: "pm",
        pmMode: "discovery",
        status: "queued",
      },
    }));
    const activity = vi.fn();
    const view = ui.createProjectWorkspace(root, {
      pages: { current: "project", project: "shop", pm: "", tab: "overview" },
      api,
      getJobs: () => jobs,
      onJob: (job: Record<string, unknown>) => jobs.push(job),
      onActivity: activity,
    });
    const refresh = () => view.setStatus({ projects: [project] }, false);
    const adopt = () => {
      project.areas.push({ key: "core", name: "Moss" });
      project.readiness.areas.push({
        key: "core",
        discovery: { canRun: true },
      });
      refresh();
    };
    refresh();
    return {
      root,
      jobs,
      project,
      api,
      activity,
      refresh,
      adopt,
      welcome,
      missions,
    };
  }
  it("shows reviewed repository welcome before adoption, then explicitly starts Discovery rather than an outcome mission", async () => {
    const f = onboarding();
    expect(f.welcome.mount).toHaveBeenCalledTimes(1);
    expect(f.missions.mount).not.toHaveBeenCalled();
    expect(f.api).not.toHaveBeenCalled();
    f.adopt();
    expect(text(f.root)).toContain("Give Moss a first look");
    expect(f.missions.mount).not.toHaveBeenCalled();
    await all(f.root)
      .find((node) => node.textContent === "Explore the codebase")!
      .fire("click");
    expect(f.api).toHaveBeenCalledWith("/api/jobs", {
      type: "pm",
      project: "shop",
      area: "core",
      pmMode: "discovery",
    });
    expect(text(f.root)).toContain("Queued for your runner");
    await all(f.root)
      .find((node) => node.textContent === "Follow the investigation")!
      .fire("click");
    expect(f.activity).toHaveBeenCalledWith("new");
    expect(f.api).toHaveBeenCalledTimes(1);
  });
  it("uses actual readiness and failures, ignoring runs from a replaced project", async () => {
    const f = onboarding();
    f.adopt();
    f.jobs.push({
      id: "old",
      runId: 20,
      project: "shop",
      projectInstanceId: "replaced",
      type: "pm",
      area: "core",
      status: "running",
      pmMode: "discovery",
    });
    f.project.readiness.areas[0]!.discovery = {
      canRun: false,
      blockers: [
        {
          action: "worker",
          id: "worker",
          message: "A verified runner is needed.",
        },
      ],
    };
    f.refresh();
    expect(text(f.root)).toContain("A verified runner is needed");
    expect(
      all(f.root).find((node) => node.dataset.setupAction === "worker")
        ?.textContent,
    ).toBe("Prepare first mission");
    expect(text(f.root)).not.toContain("Follow the investigation");
    f.project.readiness.areas[0]!.discovery = { canRun: true };
    Object.assign(f.project.areas[0]!, { discoveryRevision: "current-brief" });
    f.jobs.push({
      id: "old-pm",
      runId: 21,
      project: "shop",
      projectInstanceId: "current",
      type: "pm",
      area: "core",
      status: "running",
      pmMode: "discovery",
      discoveryRevision: "replaced-pm",
    });
    f.jobs.push({
      id: "failed",
      runId: 1,
      project: "shop",
      projectInstanceId: "current",
      type: "pm",
      area: "core",
      status: "failed",
      pmMode: "discovery",
      discoveryRevision: "current-brief",
      message: "Runner disconnected.",
    });
    f.refresh();
    expect(text(f.root)).toContain("Runner disconnected");
    expect(text(f.root)).toContain("Retry the investigation");
    expect(f.api).not.toHaveBeenCalled();
  });
  it("uses retained identity-scoped investigation evidence and preserves established missions or coding history", () => {
    const f = onboarding();
    f.adopt();
    f.jobs.push({
      type: "pm",
      project: "shop",
      projectInstanceId: "current",
      status: "succeeded",
      area: "core",
    });
    f.refresh();
    expect(f.missions.mount).not.toHaveBeenCalled();
    f.project.onboardingProgress.investigated = true;
    f.refresh();
    expect(f.missions.mount).toHaveBeenCalledTimes(1);
    f.project.onboardingProgress.investigated = false;
    f.project.onboardingProgress.hasMissions = true;
    f.project.areas = [];
    f.refresh();
    expect(f.missions.mount).toHaveBeenCalledTimes(2);
    f.project.onboardingProgress.hasMissions = false;
    f.jobs.push({
      type: "developer",
      project: "shop",
      projectInstanceId: "current",
      status: "succeeded",
    });
    f.refresh();
    expect(f.missions.mount).toHaveBeenCalledTimes(3);
    expect(f.welcome.mount).toHaveBeenCalledTimes(1);
  });
});
