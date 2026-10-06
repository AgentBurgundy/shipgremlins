import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

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
  listeners = new Map<string, () => void>();
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
  addEventListener(name: string, callback: () => void) {
    this.listeners.set(name, callback);
  }
  replaceChildren(...children: Element[]) {
    this.children = children;
  }
  fire(name: string) {
    this.listeners.get(name)?.();
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
