import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

type Handler = (event?: object) => unknown;
class Element {
  children: Element[] = [];
  attributes = new Map<string, string>();
  listeners = new Map<string, Handler>();
  dataset: Record<string, string> = {};
  style: Record<string, string> = {};
  className = "";
  textContent = "";
  value = "";
  id = "";
  href = "";
  hidden = false;
  open = false;
  focus = vi.fn();
  constructor(public tagName: string) {}
  classList = {
    add: (name: string) => {
      this.className += ` ${name}`;
    },
  };
  append(...children: Element[]) {
    this.children.push(...children);
  }
  replaceChildren(...children: Element[]) {
    this.children = children;
  }
  setAttribute(key: string, value: string) {
    this.attributes.set(key, value);
  }
  addEventListener(key: string, handler: Handler) {
    this.listeners.set(key, handler);
  }
  fire(key: string) {
    return this.listeners.get(key)?.();
  }
  contains(value: Element): boolean {
    return all(this).includes(value);
  }
  querySelectorAll(selector: string) {
    return all(this).filter((item) =>
      selector === "[data-flow-focus]"
        ? item.dataset.flowFocus
        : item.tagName === selector.toUpperCase(),
    );
  }
}
const all = (root: Element): Element[] => [root, ...root.children.flatMap(all)];
const text = (root: Element) =>
  all(root)
    .map((item) => item.textContent)
    .join(" ");
const now = Date.parse("2026-10-15T12:05:00Z");
const projects = [
  {
    name: "shop",
    instanceId: "shop-current",
    areas: [{ key: "checkout", name: "Checkout quality" }],
  },
  { name: "other", areas: [] },
];
const job = (overrides = {}) => ({
  id: "job-one",
  runId: 7,
  type: "developer",
  project: "shop",
  projectInstanceId: "shop-current",
  area: "checkout",
  ticket: "SHOP-42",
  status: "running",
  createdAt: "2026-10-15T12:00:00Z",
  startedAt: "2026-10-15T12:01:00Z",
  ...overrides,
});
const flow = (overrides = {}) => ({
  version: 1,
  kind: "developer",
  phase: "build",
  status: "running",
  strategy: "tdd",
  repairUsed: 1,
  repairLimit: 2,
  updatedAt: "2026-10-15T12:04:00Z",
  phases: [
    {
      id: "understand",
      label: "understand",
      status: "passed",
      summary: "Mapped the checkout entrypoint.",
    },
    { id: "baseline", status: "passed" },
    { id: "tests", status: "passed" },
    {
      id: "build",
      status: "running",
      startedAt: "2026-10-15T12:03:00Z",
      summary: "Implementing the approved checkout fix.",
    },
    { id: "review", status: "pending" },
    { id: "verify", status: "pending" },
    { id: "publish", status: "pending" },
  ],
  events: [
    {
      id: "event-1",
      phase: "tests",
      status: "passed",
      at: "2026-10-15T12:02:00Z",
      summary: "Regression check reproduces the failure.",
    },
  ],
  ...overrides,
});
function fixture() {
  const document = {
    activeElement: null as Element | null,
    createElement: (tag: string) => new Element(tag.toUpperCase()),
  };
  const window = {} as {
    runFlowState(
      job: object,
      options?: object,
    ): {
      live: boolean;
      stale: boolean;
      status: string;
      stage: string;
      elapsed: string | null;
      phases: Array<{ id: string; status: string; interrupted?: boolean }>;
    };
    createRunFlowBoard(
      root: Element,
      options?: object,
    ): { update(data: object): void };
    renderRunFlowDetail(root: Element, job?: object): void;
  };
  const timers = { setTimeout: vi.fn(), setInterval: vi.fn() };
  runInNewContext(
    readFileSync(
      new URL("../../dashboard/run-flow.js", import.meta.url),
      "utf8",
    ),
    { window, document, Date, ...timers },
  );
  const root = new Element("SECTION"),
    board = window.createRunFlowBoard(root, { id: "test" });
  const update = (jobs: object[] = [], extra = {}) =>
    board.update({ jobs, projects, loaded: true, now, ...extra });
  const byId = (id: string) => all(root).find((item) => item.id === id)!;
  const cards = () => all(root).filter((item) => item.dataset.runId);
  return { window, document, root, board, update, byId, cards, timers };
}
describe("live recorded run process", () => {
  it("keeps every recorded stage visible on the board without opening a run or its history", () => {
    const f = fixture();
    f.update([job({ flow: flow() })]);
    const card = f.cards()[0]!,
      details = all(card).find((item) => item.tagName === "DETAILS")!;
    const rail = card.children.find(
      (item) => item.className === "run-flow-rail",
    )!;
    expect(rail).toBeDefined();
    expect(all(details)).not.toContain(rail);
    expect(
      all(card).filter((item) => item.className === "run-flow-rail"),
    ).toHaveLength(1);
    expect(text(rail)).toContain("Implement");
    expect(text(rail)).toContain("Draft PR");
    expect(details.open).toBe(false);
  });
  it("keeps the current blocker and its next action outside optional process details", () => {
    const f = fixture();
    Object.assign(f.window, {
      normalizedRunFailure: () => ({
        detail: "Reconnect the saved account.",
        label: "Review connections",
        href: "/connections",
      }),
    });
    f.update([
      job({
        status: "queued",
        failure: { category: "credential-wait" },
        ai: { provider: "codex", model: "selected-model" },
      }),
    ]);
    const card = f.cards()[0]!,
      details = all(card).find((item) => item.tagName === "DETAILS")!;
    expect(text(card)).toContain("Waiting for a connection");
    const blocker = all(card).find(
      (item) => item.className === "run-flow-blocker",
    )!;
    const remedy = all(card).find((item) =>
      item.className.includes("run-flow-next-action"),
    )!;
    expect(remedy.href).toBe("/connections");
    expect(all(details)).not.toContain(blocker);
    expect(all(details)).not.toContain(remedy);
    expect(text(details)).toContain("Codex · selected-model");
    expect(details.open).toBe(false);
    expect(
      all(card).filter((item) => item.className === "run-flow-rail"),
    ).toHaveLength(0);
  });
  it("shows the real phase inline with readable labels, provider, elapsed time and bounded repair count", () => {
    const f = fixture();
    f.update([
      job({ flow: flow(), ai: { provider: "codex", model: "gpt-5.4" } }),
    ]);
    expect(f.cards()).toHaveLength(1);
    expect(text(f.root)).toContain("Implement");
    expect(text(f.root)).toContain("Draft PR");
    expect(text(f.root)).toContain("Coding · Coding agent · Codex");
    expect(text(f.root)).not.toContain("Coding · Checkout quality");
    expect(text(f.root)).toContain("Codex · gpt-5.4");
    const card = f.cards()[0]!,
      details = all(card).find((item) => item.tagName === "DETAILS")!,
      role = all(card).find((item) => item.className === "run-flow-role")!;
    expect(text(role)).toBe("Coding · Coding agent · Codex");
    expect(all(details)).not.toContain(role);
    expect(text(role)).not.toContain("gpt-5.4");
    expect(details.open).toBe(false);
    expect(text(f.root)).toContain("Elapsed 4m 0s");
    expect(text(f.root)).toContain("Repairs 1/2");
    expect(f.cards()[0]!.className).toContain("is-live");
    expect(text(f.root)).not.toContain("%");
    expect(text(f.root)).not.toContain("ETA");
    expect(f.timers.setTimeout).not.toHaveBeenCalled();
    expect(f.timers.setInterval).not.toHaveBeenCalled();
  });
  it.each(["failed", "canceled", "succeeded"])(
    "treats terminal %s status as authoritative without fabricating a passed phase",
    (status) => {
      const f = fixture(),
        value = job({
          status,
          finishedAt: "2026-10-15T12:04:00Z",
          flow: flow(),
        });
      const state = f.window.runFlowState(value, { now });
      expect(state.live).toBe(false);
      expect(state.phases.find((phase) => phase.id === "build")?.status).toBe(
        "running",
      );
      expect(
        state.phases.find((phase) => phase.id === "build")?.interrupted,
      ).toBe(true);
      f.update([value]);
      f.byId("test-status-filter").value = "finished";
      f.byId("test-status-filter").fire("change");
      expect(f.cards()[0]!.className).not.toContain("is-live");
      expect(text(f.root)).toContain(
        status === "succeeded" ? "Last recorded running" : "Interrupted",
      );
      expect(state.elapsed).toBe("3m 0s");
    },
  );
  it("shows queued and legacy-running jobs without inventing process phases", () => {
    const f = fixture();
    f.update([
      job({ id: "waiting", status: "queued" }),
      job({
        id: "old",
        ai: { provider: "unknown", model: "unverified-model" },
      }),
    ]);
    expect(text(f.root)).toContain("Waiting for a worker");
    expect(text(f.root)).toContain("Working · stage unavailable");
    expect(all(f.root).some((item) => item.className === "run-flow-rail")).toBe(
      false,
    );
    expect(text(f.root)).not.toContain("Repairs");
    expect(text(f.root)).not.toContain("Codex");
    expect(text(f.root)).not.toContain("Claude Code");
    expect(text(f.root)).not.toContain("unverified-model");
  });
  it.each([{ freshness: "stale" }, { stale: true }])(
    "keeps stale flow readable and removes the live animation marker",
    (stale) => {
      const f = fixture();
      f.update([job({ flow: flow(stale) })]);
      expect(text(f.root)).toContain("Last known");
      expect(text(f.root)).toContain("Observed");
      expect(f.cards()[0]!.className).not.toContain("is-live");
      expect(text(f.root)).toContain("Implement");
    },
  );
  it("keeps the last good board on a shared refresh failure and distinguishes initial loading/error", () => {
    const f = fixture();
    f.board.update({ jobs: [], projects, loaded: false });
    expect(text(f.root)).toContain("Finding your crew’s work");
    expect(f.root.attributes.get("aria-busy")).toBe("true");
    f.board.update({ jobs: [], projects, loaded: false, failed: true });
    expect(text(f.root)).toContain("Run status is unavailable");
    expect(f.root.attributes.get("aria-busy")).toBe("false");
    f.update([job({ flow: flow() })], { failed: true });
    expect(text(f.root)).toContain("Showing the last recorded stages");
    expect(f.cards()).toHaveLength(1);
    expect(f.cards()[0]!.className).not.toContain("is-live");
  });
  it("filters project and status independently while keeping filter nodes stable across polls", () => {
    const f = fixture(),
      jobs = [
        job({ flow: flow() }),
        job({
          id: "other",
          project: "other",
          projectInstanceId: null,
          status: "queued",
        }),
        job({
          id: "past",
          status: "succeeded",
          finishedAt: "2026-10-15T12:04:00Z",
        }),
      ];
    f.update(jobs);
    const project = f.byId("test-project-filter"),
      status = f.byId("test-status-filter");
    project.value = "other";
    project.fire("change");
    expect(f.cards().map((item) => item.dataset.runId)).toEqual(["other"]);
    expect(text(f.root)).toContain("0 running · 1 queued");
    f.update(jobs);
    expect(f.byId("test-project-filter")).toBe(project);
    expect(project.value).toBe("other");
    project.value = "";
    status.value = "finished";
    status.fire("change");
    expect(f.cards().map((item) => item.dataset.runId)).toEqual(["past"]);
    expect(text(f.root)).toContain("1 run");
  });
  it("uses native keyboard disclosures and restores their expansion and focus after a poll", () => {
    const f = fixture();
    f.update([job({ flow: flow() })]);
    const details = all(f.root).find((item) => item.tagName === "DETAILS")!,
      summary = details.children[0]!;
    expect(summary.tagName).toBe("SUMMARY");
    expect(summary.attributes.get("aria-label")).toBe(
      "Recorded process for run 7",
    );
    details.open = true;
    details.fire("toggle");
    f.document.activeElement = summary;
    f.update([job({ flow: flow({ updatedAt: "2026-10-15T12:04:30Z" }) })]);
    const replacement = all(f.root).find((item) => item.tagName === "DETAILS")!;
    expect(replacement.open).toBe(true);
    expect(replacement.children[0]!.focus).toHaveBeenCalledWith({
      preventScroll: true,
    });
    expect(text(replacement)).toContain(
      "Regression check reproduces the failure",
    );
  });
  it("expands a selected run and links exact job identity to its evidence", () => {
    const f = fixture();
    f.update([job({ flow: flow() })], { selectedId: "job-one" });
    expect(all(f.root).find((item) => item.tagName === "DETAILS")!.open).toBe(
      true,
    );
    expect(all(f.root).find((item) => item.tagName === "A")!.href).toBe(
      "/activity?run=job-one",
    );
    expect(
      all(f.root)
        .find((item) => item.tagName === "A")!
        .attributes.get("aria-label"),
    ).toBe("Open evidence for run 7");
    const details = all(f.root).find((item) => item.tagName === "DETAILS")!;
    details.open = false;
    details.fire("toggle");
    f.update([job({ flow: flow() })], {
      selectedId: "job-one",
      now: now + 2000,
    });
    expect(all(f.root).find((item) => item.tagName === "DETAILS")!.open).toBe(
      false,
    );
  });
  it("shows a failed recorded phase and inline blocker without reading raw logs", () => {
    const f = fixture();
    f.update([
      job({
        flow: flow({
          status: "running",
          phase: "verify",
          phases: [
            {
              id: "verify",
              status: "failed",
              summary: "The required test command failed.",
            },
          ],
        }),
        logs: "private-debug-secret",
      }),
    ]);
    expect(text(f.root)).toContain("Needs attention");
    expect(text(f.root)).toContain("The required test command failed");
    expect(text(f.root)).not.toContain("private-debug-secret");
    expect(f.cards()[0]!.className).not.toContain("is-live");
  });
  it("uses the recorded PM and verification process shapes instead of the coder pipeline", () => {
    const f = fixture();
    f.update([
      job({
        type: "pm",
        flow: flow({
          kind: "pm",
          phase: "investigate",
          phases: [
            { id: "prepare", status: "passed" },
            { id: "investigate", status: "running" },
            { id: "record", status: "pending" },
          ],
        }),
      }),
      job({
        id: "verify",
        type: "verify",
        project: null,
        flow: flow({
          kind: "verify",
          phase: "browser",
          phases: [{ id: "browser", status: "running" }],
        }),
      }),
    ]);
    expect(text(f.root)).toContain("Record findings");
    expect(text(f.root)).toContain("Browser check");
    expect(text(f.root)).not.toContain("Draft PR");
  });
  it("reuses the recorded process in the run summary and does not associate a replacement PM with old work", () => {
    const f = fixture(),
      root = new Element("DIV");
    f.update([
      job({
        projectInstanceId: "deleted",
        type: "pm",
        flow: flow({ kind: "pm" }),
      }),
    ]);
    expect(text(f.root)).not.toContain("Checkout quality");
    f.update([
      job({
        areaInstanceId: "deleted-pm",
        type: "pm",
        flow: flow({ kind: "pm" }),
      }),
    ]);
    expect(text(f.root)).not.toContain("Checkout quality");
    f.window.renderRunFlowDetail(root, job({ flow: flow() }));
    expect(text(root)).toContain("Recorded process");
    expect(text(root)).toContain("Verify");
    f.window.renderRunFlowDetail(root);
    expect(root.hidden).toBe(true);
  });
});
