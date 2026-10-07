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
  listeners = new Map<string, () => unknown>();
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
  addEventListener(name: string, callback: () => unknown) {
    this.listeners.set(name, callback);
  }
  replaceChildren(...children: Element[]) {
    this.children = children;
  }
  fire(name: string) {
    return this.listeners.get(name)?.();
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
    ) => { setStatus(value: object, locked: boolean): void; render(): void };
    createPmCharter: (
      root: Element,
      prefix: string,
      initial: object,
    ) => { read(): object; reset(): void };
    createProjectWelcome?: (options: object) => object;
    createProjectMissions?: (options: object) => object;
    renderCodingLauncher(project: object, options: object): Element;
    renderProjectCrew(project: object): Element;
    renderPmControls(): Element;
  };
  window.addEventListener = () => {};
  const document = {
    body: new Element("BODY"),
    hidden: true,
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
  return window;
}
const all = (root: Element): Element[] => [root, ...root.children.flatMap(all)];
const text = (root: Element): string =>
  root.textContent + root.children.map(text).join("");

describe("PM workspace knowledge", () => {
  it("shows the missing test-login choice beside PM launch controls", () => {
    const window = fixture();
    window.renderPmControls = () => new Element("BUTTON");
    const rendered = window.renderProjectCrew({
      name: "shop",
      verification: { mode: "browser", environment: "preview" },
      environments: {
        preview: { kind: "vercel", url: "https://preview.example.com" },
      },
      areas: [{ key: "core", name: "Moss", mandate: "Explore checkout" }],
    });
    expect(text(rendered)).toContain("Set up app sign-in");
    expect(
      all(rendered).find((node) => node.textContent === "Set up app sign-in")
        ?.href,
    ).toBe("/projects/shop?tab=environment");
    expect(text(rendered)).toContain("PM Gremlins");
  });

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
  it("does not block approved coding on a browser-only test-login setup step", () => {
    const rendered = fixture().renderCodingLauncher(
      {
        name: "app",
        readiness: {
          canRun: false,
          blockers: [
            {
              id: "test_access",
              action: "environment",
              message: "Choose app sign-in.",
            },
          ],
        },
      },
      {},
    );
    expect(text(rendered)).toContain("Start coding");
    expect(text(rendered)).not.toContain("Choose app sign-in.");
  });
  it("keeps active promotion coding hands-off while ordinary PR projects retain draft review", () => {
    const api = fixture(),
      job = {
        id: "coding-active",
        type: "developer",
        project: "app",
        ticket: "APP-1",
        status: "running",
      };
    const staged = api.renderCodingLauncher(
      { name: "app", workflow: { kind: "promotion" } },
      { jobs: [job] },
    );
    expect(text(staged)).toContain(
      "Your PM tests the change. You review the promotion batch.",
    );
    expect(text(staged)).not.toContain("draft pull request to review");
    const ordinary = api.renderCodingLauncher(
      { name: "app", workflow: { kind: "pull-request" } },
      { jobs: [job] },
    );
    expect(text(ordinary)).toContain(
      "You’ll get a draft pull request to review.",
    );
  });
  it("routes completed promotion coding to delivery while preserving explicit draft review", () => {
    const api = fixture(),
      job = { id: "coding-1", ticket: "APP-1", status: "succeeded" };
    const staged = api.renderCodingLauncher(
      { name: "app", workflow: { kind: "promotion" } },
      { operation: { kind: "existing", job } },
    );
    expect(text(staged)).toContain("a successful coding run is not a QA pass");
    expect(text(staged)).not.toContain(
      "Review its changes and any draft pull request",
    );
    expect(
      all(staged).find((item) => item.textContent === "Follow delivery")?.href,
    ).toBe("/projects/app?tab=changes");
    const ordinary = api.renderCodingLauncher(
      { name: "app", workflow: { kind: "pull-request" } },
      { operation: { kind: "existing", job } },
    );
    expect(text(ordinary)).toContain(
      "Review its changes and any draft pull request",
    );
    expect(
      all(ordinary).find((item) => item.textContent === "Review existing run")
        ?.href,
    ).toBe("/activity?run=coding-1");
  });
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
  it("keeps app sign-in setup visible on the crew page and individual PM page", () => {
    const f = workspace();
    Object.assign(f.project, {
      verification: { mode: "browser", environment: "preview" },
      environments: {
        preview: { kind: "vercel", role: "preview", projectId: "fixture" },
      },
    });
    f.view.setStatus(f.state, false);
    expect(text(f.root)).toContain("Choose how your gremlin signs in");
    expect(
      all(f.root).find((node) => node.textContent === "Set up app sign-in")
        ?.href,
    ).toBe("/projects/shipgremlins?tab=environment");
    f.pages.pm = f.project.areas[0]!.key;
    f.pages.tab = "brief";
    f.view.render();
    expect(text(f.root)).toContain("Choose how your gremlin signs in");
  });
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
      3,
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
    const navigation = all(root).find(
      (item) => item.className === "pm-workspace-nav",
    )!;
    expect(all(navigation).filter((item) => item.tagName === "A")).toHaveLength(
      1,
    );
    expect(text(navigation)).toContain("Project overview");
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
    ).toHaveLength(1);
  });
});

describe("project-first investigation", () => {
  function onboarding(linear = false) {
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
      areas: [] as { key: string; name: string; linearProjectId?: string }[],
      onboardingProgress: { investigated: false, hasMissions: false },
      verification: { mode: "repository", environment: "preview" },
      environments: {} as Record<string, object>,
      readiness: {
        steps: [] as { id: string; ready: boolean }[],
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
    const activity = vi.fn(),
      setupHosting = vi.fn(),
      setupLinear = vi.fn();
    const view = ui.createProjectWorkspace(root, {
      pages: { current: "project", project: "shop", pm: "", tab: "overview" },
      api,
      getJobs: () => jobs,
      onJob: (job: Record<string, unknown>) => jobs.push(job),
      onActivity: activity,
      onSetupHosting: setupHosting,
      onSetupLinear: linear ? setupLinear : undefined,
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
      setupHosting,
      setupLinear,
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
      .find((node) => node.textContent === "Start with code only")!
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
  it("offers Linear before hosting for unmapped PMs, retaining that next step after discovery", async () => {
    const f = onboarding(true);
    expect(text(f.root)).not.toContain("Set up Linear");
    f.adopt();
    expect(text(f.root)).toContain("Set up Linear");
    expect(text(f.root)).not.toContain("Connect a test environment");
    const setup = all(f.root).find(
      (node) => node.textContent === "Set up Linear",
    )!;
    await setup.fire("click");
    expect(f.setupLinear).toHaveBeenCalledWith("shop", setup);
    expect(f.api).not.toHaveBeenCalled();
    f.project.onboardingProgress.investigated = true;
    f.project.readiness.steps = [{ id: "linear_connection", ready: false }];
    f.refresh();
    expect(f.missions.mount).toHaveBeenCalledOnce();
    expect(text(f.root)).toContain("Connect Linear");
    expect(text(f.root)).not.toContain("Connect a test environment");
    f.project.readiness.steps[0]!.ready = true;
    f.project.areas[0]!.linearProjectId = "CHANGE_LINEAR_PROJECT";
    f.refresh();
    expect(text(f.root)).toContain("Set up Linear");
    f.project.areas[0]!.linearProjectId = "linear-project-core";
    f.refresh();
    expect(text(f.root)).not.toContain("Set up Linear");
    expect(text(f.root)).toContain("Connect a test environment");
    await setup.fire("click");
    expect(f.setupLinear).toHaveBeenCalledOnce();
    expect(f.setupHosting).not.toHaveBeenCalled();
    expect(f.api).not.toHaveBeenCalled();
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
  it("offers an already adopted gremlin a browser environment before code-only discovery without starting either on render", async () => {
    const f = onboarding();
    f.adopt();
    const connect = all(f.root).find(
        (node) => node.textContent === "Connect a test environment",
      )!,
      code = all(f.root).find(
        (node) => node.textContent === "Start with code only",
      )!;
    expect(connect.className).toContain("button-dark");
    expect(code.className).not.toContain("button-dark");
    expect(text(f.root)).toContain("without opening the app");
    expect(f.api).not.toHaveBeenCalled();
    expect(f.setupHosting).not.toHaveBeenCalled();
    await connect.fire("click");
    expect(f.setupHosting).toHaveBeenCalledWith("shop", connect);
    expect(f.api).not.toHaveBeenCalled();
    f.project.instanceId = "replacement";
    await connect.fire("click");
    expect(f.setupHosting).toHaveBeenCalledOnce();
  });
  it("keeps hosting visible after discovery without replacing missions, and removes it for a selected browser target", async () => {
    const f = onboarding();
    f.adopt();
    f.project.onboardingProgress.investigated = true;
    f.refresh();
    expect(f.missions.mount).toHaveBeenCalledOnce();
    expect(text(f.root)).toContain("Let your crew see the app, too.");
    const connect = all(f.root).find(
      (node) => node.textContent === "Connect a test environment",
    )!;
    await connect.fire("click");
    expect(f.setupHosting).toHaveBeenCalledWith("shop", connect);
    expect(f.api).not.toHaveBeenCalled();
    f.project.verification.mode = "browser";
    f.project.environments.preview = {
      kind: "url",
      role: "preview",
      url: "https://preview.example.com",
    };
    f.refresh();
    expect(f.missions.mount).toHaveBeenCalledTimes(2);
    expect(text(f.root)).not.toContain("Connect a test environment");
    await connect.fire("click");
    expect(f.setupHosting).toHaveBeenCalledOnce();
  });
  it("keeps configured browser projects on their existing discovery action", () => {
    const f = onboarding();
    f.project.verification.mode = "browser";
    f.project.environments.preview = {
      kind: "vercel",
      role: "preview",
      projectId: "app",
    };
    f.adopt();
    expect(text(f.root)).not.toContain("Connect a test environment");
    expect(
      all(f.root).find((node) => node.textContent === "Explore the codebase")
        ?.className,
    ).toContain("button-dark");
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
