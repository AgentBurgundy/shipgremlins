import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { webcrypto } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

class Element {
  children: Element[] = [];
  parent: Element | null = null;
  tagName: string;
  className = "";
  textContent = "";
  value = "";
  href = "";
  disabled = false;
  focused = false;
  dataset: Record<string, string> = {};
  attributes = new Map<string, string>();
  listeners = new Map<string, (event: { preventDefault(): void }) => unknown>();
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
  addEventListener(
    name: string,
    listener: (event: { preventDefault(): void }) => unknown,
  ) {
    this.listeners.set(name, listener);
  }
  fire(name: string) {
    return this.listeners.get(name)?.({ preventDefault() {} });
  }
  focus() {
    this.focused = true;
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
const byText = (root: Element, value: string) =>
  walk(root).find((item) => item.textContent === value)!;
const settle = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};
const mission = (overrides = {}) => ({
  id: "mission-1",
  project: "large-app",
  area: "core",
  outcome: "Help new users publish their first working workflow.",
  revision: "mission-r1",
  status: "needs-review",
  investigation: { jobId: "investigation-1", status: "succeeded" },
  ...overrides,
});
const candidate = (overrides = {}) => ({
  id: "ticket-uuid",
  identifier: "APP-7",
  title: "Guide the first workflow",
  description: "Observed users have no next step. <script>unsafe</script>",
  acceptanceCriteria: ["Show a next step after saving."],
  revision: "ticket-r1",
  priority: 2,
  related: true,
  ...overrides,
});
type Api = (path: string, body?: unknown, method?: string) => Promise<unknown>;
function fixture(api: Api, onSaved = vi.fn(async () => {})) {
  const root = new Element("main"),
    document = {
      hidden: false,
      activeElement: null as Element | null,
      createElement: (tag: string) => new Element(tag),
      addEventListener() {},
    };
  const timers: (() => void)[] = [];
  const pages = {
    current: "project",
    project: "large-app",
    pm: "",
    tab: "overview",
  };
  const project = { name: "large-app", instanceId: "current" };
  let locked = false;
  const window = {
    crypto: webcrypto,
    location: { origin: "http://localhost" },
    addEventListener() {},
  } as unknown as {
    createProjectMissions(options: object): {
      mount(root: Element, project: object, view?: string): void;
      forget(project: string): void;
      isBusy(): boolean;
    };
  };
  runInNewContext(
    readFileSync(
      new URL("../../dashboard/project-mission.js", import.meta.url),
      "utf8",
    ),
    {
      window,
      document,
      URL,
      Date,
      setTimeout: (fn: () => void) => {
        timers.push(fn);
        return timers.length;
      },
      clearTimeout() {},
    },
  );
  const view = window.createProjectMissions({
    api,
    pages,
    onSaved,
    isLocked: () => locked,
  });
  view.mount(root, project);
  return {
    root,
    document,
    view,
    project,
    pages,
    timers,
    setLocked(value: boolean) {
      locked = value;
    },
  };
}
describe("outcome-led project missions", () => {
  it("does not imply an empty project or offer creation when initial state could not load", async () => {
    const api = vi
      .fn()
      .mockRejectedValueOnce(new Error("State unavailable"))
      .mockResolvedValue({ missions: [], areas: [], changes: [] });
    const f = fixture(api);
    await settle();
    expect(text(f.root)).toContain("State unavailable");
    expect(walk(f.root).some((item) => item.tagName === "FORM")).toBe(false);
    byText(f.root, "Refresh mission").fire("click");
    await settle();
    expect(text(f.root)).toContain("What should get better?");
  });
  it("does not let a pre-action poll erase a newly accepted mission", async () => {
    let release!: (value: unknown) => void;
    let lists = 0,
      created = false;
    const next = mission({ status: "investigating" });
    const api = vi.fn(async (url: string, body?: unknown) => {
      if (body) {
        created = true;
        return { mission: next };
      }
      if (!url.endsWith("/missions")) return { mission: next, candidates: [] };
      lists++;
      if (lists === 2)
        return await new Promise((resolve) => {
          release = resolve;
        });
      return { missions: created ? [next] : [], areas: [], changes: [] };
    });
    const f = fixture(api);
    await settle();
    f.timers.at(-1)!();
    await settle();
    const input = walk(f.root).find((item) => item.tagName === "TEXTAREA")!;
    input.value = "Help users publish a working first workflow.";
    input.fire("input");
    walk(f.root)
      .find((item) => item.tagName === "FORM")!
      .fire("submit");
    await settle();
    release({ missions: [], areas: [], changes: [] });
    await settle();
    expect(text(f.root)).toContain("Investigating your outcome");
    expect(text(f.root)).not.toContain("What should get better?");
  });
  it("does not present merged, unknown, or no-change outputs as open reviews", async () => {
    const f = fixture(async () => ({
      missions: [],
      changes: [
        {
          jobId: "merged",
          status: "succeeded",
          pullRequests: [
            { url: "https://github.com/org/app/pull/1", state: "merged" },
          ],
        },
        {
          jobId: "unknown",
          status: "succeeded",
          pullRequests: [
            { url: "https://github.com/org/app/pull/2", state: "unknown" },
          ],
        },
        {
          jobId: "none",
          status: "succeeded",
          noChanges: true,
          pullRequests: [],
        },
      ],
    }));
    await settle();
    expect(text(f.root)).not.toContain("Changes ready for review");
    expect(text(f.root)).toContain("Recorded draft · status unavailable");
    expect(text(f.root)).toContain("reported no code changes");
    expect(text(f.root)).toContain("1 earlier change is merged or closed");
  });
  it("renders the full acceptance criteria once and retains the request ID after an ambiguous create", async () => {
    const detail = {
      mission: mission(),
      candidates: [
        candidate({
          description:
            "## Acceptance criteria\n- Show a next step after saving.",
        }),
      ],
    };
    const f = fixture(async (url) =>
      url.endsWith("/missions")
        ? { missions: [mission()], changes: [] }
        : detail,
    );
    await settle();
    byText(f.root, "Review proposed change").fire("click");
    expect(text(f.root).match(/Show a next step after saving\./g)).toHaveLength(
      1,
    );
    expect(text(f.root)).not.toContain("What this change must do");
    const bodies: unknown[] = [];
    const api = vi.fn(async (_url: string, body?: unknown) => {
      if (body) {
        bodies.push(body);
        throw new Error("Response lost");
      }
      return { missions: [], areas: [], changes: [] };
    });
    const pending = fixture(api);
    await settle();
    const input = walk(pending.root).find(
      (item) => item.tagName === "TEXTAREA",
    )!;
    input.value = "Make the existing first user journey clearer.";
    input.fire("input");
    walk(pending.root)
      .find((item) => item.tagName === "FORM")!
      .fire("submit");
    await settle();
    walk(pending.root)
      .find((item) => item.tagName === "FORM")!
      .fire("submit");
    await settle();
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toEqual(bodies[0]);
  });
  it("waits for actual state and leads an empty project with one deliberate outcome action", async () => {
    let resolve!: (value: unknown) => void;
    const api = vi.fn(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const f = fixture(api);
    expect(text(f.root)).toContain("Loading your next useful change");
    expect(text(f.root)).not.toContain("Building");
    resolve({ missions: [], areas: [], changes: [] });
    await settle();
    expect(text(f.root)).toContain("What should get better?");
    expect(text(f.root)).toContain("prepare a focused PM");
    expect(byText(f.root, "Investigate this improvement").disabled).toBe(true);
    expect(api).toHaveBeenCalledTimes(1);
  });
  it("starts only the supplied outcome and prevents duplicate clicks while the request is pending", async () => {
    let accept!: (value: unknown) => void;
    const api = vi.fn(async (_path: string, body?: unknown) =>
      body
        ? await new Promise((resolve) => {
            accept = resolve;
          })
        : { missions: [], areas: [], changes: [] },
    );
    const f = fixture(api);
    await settle();
    const input = walk(f.root).find((item) => item.tagName === "TEXTAREA")!;
    input.value = "  Help users publish their first working workflow.  ";
    input.fire("input");
    const form = walk(f.root).find((item) => item.tagName === "FORM")!;
    form.fire("submit");
    form.fire("submit");
    await settle();
    expect(api.mock.calls.filter((call) => call[1])).toHaveLength(1);
    expect(api.mock.calls.find((call) => call[1])?.[1]).toEqual({
      outcome: "Help users publish their first working workflow.",
      clientRequestId: expect.any(String),
    });
    expect(f.view.isBusy()).toBe(true);
    accept({ mission: mission({ status: "investigating" }) });
    await settle();
    expect(f.view.isBusy()).toBe(false);
  });
  it("requires scope review and submits only one exact revision-bound ticket", async () => {
    const result = {
      mission: mission(),
      candidates: [
        candidate(),
        candidate({ id: "other", title: "Unrelated backlog", related: false }),
      ],
    };
    const api = vi.fn(async (url: string, body?: unknown) =>
      body
        ? { mission: mission({ status: "building", plan: { steps: [] } }) }
        : url.endsWith("/missions")
          ? { missions: [mission()], areas: [], changes: [] }
          : result,
    );
    const f = fixture(api);
    await settle();
    expect(text(f.root)).not.toContain("Approve & build this change");
    expect(text(f.root)).toContain("OTHER BACKLOG WORK");
    byText(f.root, "Review proposed change").fire("click");
    expect(byText(f.root, "Guide the first workflow").focused).toBe(true);
    expect(text(f.root)).toContain("Show a next step after saving.");
    expect(walk(f.root).some((item) => item.tagName === "SCRIPT")).toBe(false);
    byText(f.root, "Approve & build this change").fire("click");
    await settle();
    expect(api).toHaveBeenCalledWith(
      "/api/projects/large-app/missions/mission-1/plan",
      {
        revision: "mission-r1",
        steps: [
          { ticketId: "ticket-uuid", revision: "ticket-r1", dependsOn: [] },
        ],
      },
      "POST",
      90000,
    );
  });
  it("invalidates approval when a refreshed ticket scope changes", async () => {
    let revision = "ticket-r1";
    const api = vi.fn(async (url: string) =>
      url.endsWith("/missions")
        ? { missions: [mission()], changes: [] }
        : { mission: mission(), candidates: [candidate({ revision })] },
    );
    const f = fixture(api);
    await settle();
    byText(f.root, "Review proposed change").fire("click");
    revision = "ticket-r2";
    f.timers.at(-1)!();
    await settle();
    expect(text(f.root)).toContain("This mission changed");
    expect(text(f.root)).not.toContain("Approve & build this change");
    expect(text(f.root)).toContain("Review proposed change");
  });
  it("preserves the focused review control when an unchanged polling response arrives", async () => {
    const api = vi.fn(async (url: string) =>
      url.endsWith("/missions")
        ? { missions: [mission()], changes: [] }
        : { mission: mission(), candidates: [candidate()] },
    );
    const f = fixture(api);
    await settle();
    const review = byText(f.root, "Review proposed change");
    f.document.activeElement = review;
    f.timers.at(-1)!();
    await settle();
    expect(byText(f.root, "Review proposed change")).toBe(review);
  });
  it("leads with real review links and separates missing evidence, failures, and running work", async () => {
    const changes = [
      {
        jobId: "done",
        ticket: "APP-7",
        status: "succeeded",
        pullRequests: [
          {
            number: 7,
            url: "https://github.com/org/app/pull/7",
            title: "Useful workflow",
            state: "open",
            currentHeadSha: "newer-commit",
          },
        ],
        checks: { headSha: "recorded-commit", commands: ["npm test"] },
      },
      {
        jobId: "unknown",
        ticket: "APP-8",
        status: "succeeded",
        pullRequests: [],
      },
      {
        jobId: "running",
        ticket: "APP-9",
        status: "running",
        pullRequests: [],
      },
      { jobId: "failed", ticket: "APP-10", status: "failed", pullRequests: [] },
      {
        jobId: "malicious",
        status: "succeeded",
        pullRequests: [
          { url: "javascript:alert(1)" },
          { url: "https://user:password@example.com" },
        ],
      },
    ];
    const f = fixture(async () => ({ missions: [], areas: [], changes }));
    await settle();
    f.pages.tab = "changes";
    f.view.mount(f.root, f.project, "changes");
    expect(text(f.root)).toContain("Changes ready for review");
    expect(text(f.root)).not.toContain("What should get better?");
    expect(byText(f.root, "Review pull request").href).toBe(
      "https://github.com/org/app/pull/7",
    );
    expect(text(f.root)).toContain("No pull request link has been confirmed");
    expect(text(f.root)).toContain("Unblock your work");
    expect(text(f.root)).toContain("Your crew is working");
    expect(text(f.root)).toContain("Recorded check: npm test");
    expect(text(f.root)).toContain("recorded checks cover an older revision");
    expect(
      walk(f.root)
        .filter((item) => item.href)
        .every((item) => !/javascript:|password|undefined/.test(item.href)),
    ).toBe(true);
  });
  it("preserves an accepted mission when the follow-up status refresh fails", async () => {
    const api = vi.fn(async (_url: string, body?: unknown) =>
      body
        ? { mission: mission({ status: "investigating" }) }
        : { missions: [], areas: [], changes: [] },
    );
    const onSaved = vi.fn(async () => {
      throw new Error("Offline");
    });
    const f = fixture(api, onSaved);
    await settle();
    const input = walk(f.root).find((item) => item.tagName === "TEXTAREA")!;
    input.value = "Help users get their first useful result.";
    input.fire("input");
    walk(f.root)
      .find((item) => item.tagName === "FORM")!
      .fire("submit");
    await settle();
    expect(text(f.root)).toContain("Your action was saved");
    expect(text(f.root)).toContain("Investigating your outcome");
    expect(text(f.root)).not.toContain("Investigate this improvement");
  });
  it("ignores an old project's late response after replacement and preserves in-progress typing", async () => {
    let old!: (value: unknown) => void;
    const api = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            old = resolve;
          }),
      )
      .mockResolvedValue({ missions: [], areas: [], changes: [] });
    const f = fixture(api);
    f.view.forget("large-app");
    f.view.mount(f.root, { ...f.project, instanceId: "replacement" });
    await settle();
    old({
      missions: [mission({ outcome: "Old project secret" })],
      changes: [],
    });
    await settle();
    expect(text(f.root)).not.toContain("Old project secret");
    const input = walk(f.root).find((item) => item.tagName === "TEXTAREA")!;
    input.value = "My unsaved user outcome";
    input.fire("input");
    f.document.activeElement = input;
    f.timers.at(-1)!();
    await settle();
    expect(walk(f.root)).toContain(input);
    expect(input.value).toBe("My unsaved user outcome");
  });
});
