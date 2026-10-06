import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  new URL("../../dashboard/first-run.js", import.meta.url),
  "utf8",
);
interface Step {
  active: boolean;
  index?: number;
  title: string;
  description: string;
  label: string;
  href: string;
  adoptProject?: string;
}
const window: {
  firstRunNextStep?: (status: unknown, runners: unknown) => Step | null;
} = {};
runInNewContext(source, { window });
const next = (status: unknown, jobs: unknown[] = []) =>
  window.firstRunNextStep!(status, { jobs })!;
const connected = () => ({
  sourceConnections: [{ provider: "github", method: "oauth", connected: true }],
  connections: [{ name: "CLAUDE_CODE_OAUTH_TOKEN", configured: true }],
  projects: [] as object[],
});
const project = (overrides = {}) => ({
  name: "my-app",
  instanceId: "current",
  areas: [] as object[],
  readiness: {
    steps: [{ id: "source_connection", ready: true }],
    areas: [] as object[],
  },
  ...overrides,
});
const withPm = (blockers: object[] = []) =>
  project({
    areas: [{ key: "core", name: "Pip" }],
    readiness: {
      steps: [{ id: "source_connection", ready: true }],
      areas: [
        { key: "core", discovery: { canRun: !blockers.length, blockers } },
      ],
    },
  });

describe("first useful mission guidance", () => {
  it("keeps first-value guidance until a confirmed reviewable change exists", () => {
    class Node {
      hidden = false;
      disabled = false;
      textContent = "";
      href = "";
      className = "";
      dataset: Record<string, string> = {};
      attributes: Record<string, string> = {};
      children: Node[] = [];
      classes = new Set<string>();
      classList = {
        toggle: (name: string, on: boolean) => {
          if (on) this.classes.add(name);
          else this.classes.delete(name);
        },
      };
      setAttribute(key: string, value: string) {
        this.attributes[key] = value;
      }
      append(...nodes: Node[]) {
        this.children.push(...nodes);
      }
      replaceChildren(...nodes: Node[]) {
        this.children = nodes;
      }
    }
    const nodes = Object.fromEntries(
      [
        "welcome-title",
        "welcome-description",
        "overview-eyebrow",
        "overview-primary-action",
        "overview-adopt-action",
        "first-run-note",
        "first-run-progress",
      ].map((id) => [id, new Node()]),
    );
    const document = {
      body: new Node(),
      createElement: () => new Node(),
      getElementById: (id: string) => nodes[id],
    };
    const ui: {
      renderFirstRunOverview?: (
        status: unknown,
        runners: unknown,
        options?: unknown,
      ) => void;
    } = {};
    runInNewContext(source, { window: ui, document });
    const status = { ...connected(), projects: [project()] };
    ui.renderFirstRunOverview!(status, { jobs: [] }, { locked: true });
    expect(document.body.classes.has("is-first-run")).toBe(true);
    expect(nodes["overview-primary-action"]!.hidden).toBe(false);
    expect(nodes["overview-adopt-action"]!.hidden).toBe(true);
    expect(nodes["overview-adopt-action"]!.disabled).toBe(true);
    expect(nodes["overview-adopt-action"]!.dataset.createPmProject).toBe("");
    expect(
      nodes["first-run-progress"]!.children.filter(
        (node) => node.attributes["aria-current"] === "step",
      ),
    ).toHaveLength(1);
    ui.renderFirstRunOverview!(status, {
      jobs: [
        {
          type: "pm",
          project: "my-app",
          projectInstanceId: "current",
          status: "succeeded",
        },
      ],
    });
    expect(document.body.classes.has("is-first-run")).toBe(true);
    ui.renderFirstRunOverview!(
      {
        ...status,
        projects: [
          project({
            firstReviewableChange: {
              jobId: "coding-1",
              url: "https://github.com/org/app/pull/1",
            },
          }),
        ],
      },
      { jobs: [] },
    );
    expect(document.body.classes.has("is-first-run")).toBe(false);
    expect(nodes["overview-primary-action"]!.hidden).toBe(false);
    expect(nodes["overview-adopt-action"]!.hidden).toBe(true);
    expect(nodes["overview-adopt-action"]!.dataset.createPmProject).toBe("");
    expect(nodes["first-run-note"]!.hidden).toBe(true);
  });
  it("uses actual source and Claude state and advances instead of looping back to an already satisfied connection", () => {
    expect(next(null)).toBeNull();
    expect(next({ projects: [], connections: [] })).toMatchObject({
      index: 0,
      href: "/connections#source-control",
    });
    const status = connected();
    status.connections = [];
    expect(next(status)).toMatchObject({
      index: 1,
      href: "/connections#model-connections",
    });
    expect(next(connected())).toMatchObject({
      index: 2,
      href: "/projects#project-form",
    });
  });
  it("supports saved tokens but does not let one mask a broken OAuth connection", () => {
    const status = {
      ...connected(),
      sourceConnections: [],
      connections: [
        ...connected().connections,
        { name: "GITHUB_TOKEN", configured: true },
      ],
    };
    expect(next(status).index).toBe(2);
    expect(
      next({
        ...status,
        sourceConnections: [
          {
            provider: "github",
            method: "oauth",
            connected: true,
            needsReconnect: true,
          },
        ],
      }).index,
    ).toBe(0);
  });
  it("uses the chosen project's source readiness instead of another connected provider", () => {
    const status = {
      ...connected(),
      projects: [
        project({
          provider: "gitlab",
          readiness: { steps: [{ id: "source_connection", ready: false }] },
        }),
      ],
    };
    expect(next(status)).toMatchObject({
      index: 0,
      href: "/connections#source-control",
    });
  });
  it("reviews repository setup before adoption and learns the app before asking for an outcome", () => {
    const status = { ...connected(), projects: [project()] };
    expect(next(status)).toMatchObject({
      index: 3,
      href: "/projects/my-app",
      label: "Review your app setup",
    });
    const adopted = next({ ...status, projects: [withPm()] });
    expect(adopted).toMatchObject({
      index: 4,
      label: "Start the first investigation",
      href: "/projects/my-app",
    });
    expect(adopted.adoptProject).toBeUndefined();
    expect(adopted.description).toContain("does not create tickets");
    expect(
      next({
        ...status,
        projects: [{ ...withPm(), onboardingProgress: { investigated: true } }],
      }),
    ).toMatchObject({
      active: true,
      label: "Open your next change",
    });
  });
  it("prioritizes the reviewed foundation before adoption or empty-repository PM discovery", () => {
    for (const areas of [[], [{ key: "foundation", name: "Foundation" }]]) {
      const state = next({
        ...connected(),
        projects: [project({ areas, foundation: { needed: true } })],
      });
      expect(state).toMatchObject({
        index: 4,
        href: "/projects/my-app?tab=environment",
        label: "Review foundation plan",
      });
      expect(state.adoptProject).toBeUndefined();
    }
    const state = next(
      {
        ...connected(),
        projects: [
          project({ foundation: { needed: true, stage: "review-code" } }),
        ],
      },
      [
        {
          type: "developer",
          project: "my-app",
          projectInstanceId: "current",
          status: "succeeded",
        },
      ],
    );
    expect(state).toMatchObject({ active: true, label: "Review foundation" });
  });
  it.each([
    ["worker", "/runners#workers", "Set up a runner"],
    ["mandate", "/projects/my-app?pm=core", "Finish its purpose"],
    ["config", "/settings#advanced-settings", "Review settings"],
  ])(
    "routes the actual %s first-mission blocker to its remedy",
    (action, href, label) => {
      expect(
        next({
          ...connected(),
          projects: [withPm([{ action, message: "Needs attention" }])],
        }),
      ).toMatchObject({ index: 4, href, label });
    },
  );
  it("does not claim readiness before checks load or mistake corrupted config for no PMs", () => {
    expect(
      next({
        ...connected(),
        projects: [project({ areas: [{ key: "core" }] })],
      }).title,
    ).not.toContain("is ready");
    expect(
      next({
        ...connected(),
        projects: [{ name: "broken", repo: "Configuration needs repair" }],
      }),
    ).toMatchObject({
      label: "Review settings",
      href: "/settings#advanced-settings",
    });
  });
  it("follows accepted jobs and reviews failures without restarting work", () => {
    const status = { ...connected(), projects: [withPm()] };
    const job = {
      id: "job-first",
      type: "pm",
      project: "my-app",
      projectInstanceId: "current",
      runId: 1,
    };
    expect(next(status, [{ ...job, status: "queued" }])).toMatchObject({
      label: "Follow the mission",
      href: "/activity?run=job-first",
    });
    expect(next(status, [{ ...job, status: "running" }]).description).toContain(
      "Watch the actions",
    );
    expect(next(status, [{ ...job, status: "failed" }])).toMatchObject({
      label: "Review the last run",
      href: "/activity?run=job-first",
    });
    expect(next(status, [{ ...job, status: "succeeded" }])).toMatchObject({
      active: true,
      label: "Start the first investigation",
    });
  });
  it("follows the actual first mission across projects rather than always choosing the alphabetically first app", () => {
    const status = {
      ...connected(),
      projects: [project({ name: "alpha" }), withPm()],
    };
    expect(next(status)).toMatchObject({
      label: "Start the first investigation",
      href: "/projects/my-app",
    });
    expect(
      next(status, [
        {
          id: "job-first",
          type: "pm",
          status: "running",
          project: "my-app",
          projectInstanceId: "current",
          runId: 2,
        },
      ]),
    ).toMatchObject({
      label: "Follow the mission",
      href: "/activity?run=job-first",
    });
  });
  it("does not treat browser verification or another project incarnation as the first useful mission", () => {
    const status = { ...connected(), projects: [withPm()] };
    const job = {
      type: "pm",
      status: "succeeded",
      project: "my-app",
      projectInstanceId: "current",
    };
    expect(next(status, [{ ...job, type: "verify" }]).active).toBe(true);
    expect(
      next(status, [{ ...job, projectInstanceId: "deleted" }]).active,
    ).toBe(true);
    expect(next(status, [{ ...job, project: "other" }]).active).toBe(true);
  });
});
