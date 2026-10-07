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
  it("routes epic-governed mission proposals to the shared epic approval without a build-epic action", async () => {
    const f = fixture(async (path) =>
      path.endsWith("/mission-1")
        ? {
            mission: mission(),
            approvalPolicy: "epic",
            candidates: [candidate()],
            observations: [],
          }
        : {
            workflow: { kind: "promotion", approvalPolicy: "epic" },
            missions: [mission()],
            changes: [],
          },
    );
    await settle();
    expect(text(f.root)).toContain(
      "Approve the product direction once in Epic review",
    );
    expect(byText(f.root, "Review this PM's epics").href).toBe(
      "http://localhost/projects/large-app?tab=review",
    );
    expect(text(f.root)).not.toContain("Approve and build");
    expect(text(f.root)).not.toContain("Choose this change");
  });
  it("shows each PM's promotion and collection target with only final batch review links", async () => {
    const url = "https://github.com/org/app/pull/21";
    const f = fixture(async () => ({
      workflow: { kind: "promotion" },
      promotionBatches: {
        areas: [
          {
            area: "core",
            name: "Core",
            target: 10,
            verifiedTicketCount: 4,
            batch: null,
          },
          {
            area: "billing",
            name: "Billing",
            target: 3,
            verifiedTicketCount: 0,
            batch: {
              number: 21,
              url,
              headSha: "billing-head",
              state: "open",
              ticketCount: 3,
              draft: false,
            },
          },
        ],
        legacy: [
          {
            number: 19,
            url: "https://github.com/org/app/pull/19",
            state: "merged",
            ticketCount: 12,
          },
        ],
      },
      missions: [],
      changes: [
        {
          jobId: "billing-job",
          status: "succeeded",
          delivery: {
            status: "promoted",
            area: "billing",
            ticket: { identifier: "APP-7", title: "Receipt improvement" },
            promotion: { number: 21, url, headSha: "billing-head" },
          },
        },
      ],
    }));
    await settle();
    expect(text(f.root)).toContain("Your PM promotion batches");
    expect(text(f.root)).toContain("4/10");
    expect(byText(f.root, "Review Billing promotion").href).toBe(url);
    expect(byText(f.root, "Open earlier combined batch").href).toContain(
      "/pull/19",
    );
    expect(text(f.root)).not.toContain("could not be matched");
    expect(text(f.root)).not.toContain("Review pull request");
  });
  it.each([
    ["queued", "Integration repair queued"],
    ["running", "Coder repairing integration"],
    ["stopped", "Integration repair stopped"],
  ])(
    "shows %s pre-merge repair with its actual reason and activity",
    async (phase, label) => {
      const f = fixture(async () => ({
        workflow: { kind: "promotion" },
        missions: [],
        changes: [
          {
            jobId: "implementation",
            status: "succeeded",
            delivery: {
              status: "blocked",
              message: "The implementation conflicts with current integration.",
              integrationRepair: {
                phase,
                jobId: "repair-integration",
                message:
                  phase === "stopped"
                    ? "The automatic integration repair failed."
                    : "A coder is repairing the conflict before PM QA.",
              },
            },
          },
        ],
      }));
      await settle();
      expect(text(f.root)).toContain(label);
      expect(text(f.root)).toContain(
        "The implementation conflicts with current integration.",
      );
      expect(text(f.root)).toContain(
        phase === "stopped"
          ? "The automatic integration repair failed."
          : "A coder is repairing the conflict before PM QA.",
      );
      expect(
        walk(f.root).find((item) => item.textContent === "Activity")?.href,
      ).toBe("http://localhost/activity?run=repair-integration");
      expect(text(f.root)).not.toContain("Review pull request");
    },
  );
  it("collects many individually tested tickets under one authoritative batch and leaves earlier attempts in history", async () => {
    const promotionUrl = "https://github.com/org/app/pull/99";
    const passed = Array.from({ length: 12 }, (_, index) => ({
      jobId: `coding-${index + 1}`,
      status: "succeeded",
      pullRequests: [
        {
          state: "merged",
          url: `https://github.com/org/app/pull/${index + 1}`,
        },
      ],
      delivery: {
        status: "promoted",
        ticket: {
          identifier: `APP-${index + 1}`,
          title: `Useful improvement ${index + 1}`,
        },
        message: "Owning PM acceptance checks passed.",
        promotion: { url: promotionUrl, number: 99, headSha: "batch-head" },
      },
      previousAttempts: [
        {
          status: "failed",
          message: "Earlier attempt failed before the successful fix.",
        },
      ],
    }));
    const f = fixture(async () => ({
      workflow: { kind: "promotion" },
      promotionBatch: {
        url: promotionUrl,
        number: 99,
        state: "open",
        headSha: "batch-head",
      },
      missions: [],
      changes: [
        ...passed,
        {
          jobId: "qa-pending",
          status: "succeeded",
          delivery: {
            status: "awaiting-review",
            ticket: { identifier: "APP-13", title: "One more improvement" },
            message: "Owning PM is testing this deployment.",
          },
        },
      ],
    }));
    await settle();
    const batchLinks = walk(f.root).filter(
      (item) => item.textContent === "Review promotion batch",
    );
    expect(batchLinks).toHaveLength(1);
    expect(batchLinks[0]!.href).toBe(promotionUrl);
    expect(
      walk(f.root).filter((item) => item.className === "promotion-ticket"),
    ).toHaveLength(13);
    expect(
      walk(f.root).filter((item) => item.textContent === "APP-2"),
    ).toHaveLength(1);
    expect(text(f.root)).toContain("Still with the crew");
    expect(text(f.root)).toContain("PM QA pending");
    expect(text(f.root)).not.toContain("Earlier attempt failed");
    expect(
      walk(f.root).filter(
        (item) => item.textContent === "Activity · 2 attempts",
      ),
    ).toHaveLength(12);
    expect(text(f.root)).not.toContain("Review pull request");
    expect(
      walk(f.root).filter(
        (item) =>
          item.tagName === "A" && item.href.startsWith("https://github.com/"),
      ),
    ).toHaveLength(1);
  });
  it("does not present a closed recorded batch as ready for human review", async () => {
    const f = fixture(async () => ({
      workflow: { kind: "promotion" },
      promotionBatch: {
        url: "https://github.com/org/app/pull/99",
        number: 99,
        state: "closed",
      },
      missions: [],
      changes: [],
    }));
    await settle();
    expect(text(f.root)).toContain("This recorded batch is closed");
    expect(text(f.root)).not.toContain("Review promotion batch");
    expect(byText(f.root, "Open recorded batch").href).toBe(
      "https://github.com/org/app/pull/99",
    );
  });
  it("shows unavailable batch state without losing known ticket status", async () => {
    const f = fixture(async () => ({
      workflow: { kind: "promotion" },
      promotionBatchError:
        "Source control is unavailable. The current batch state could not be checked.",
      missions: [],
      changes: [
        {
          jobId: "tested",
          status: "succeeded",
          delivery: {
            status: "verified",
            ticket: { identifier: "APP-7", title: "Verified work" },
          },
        },
      ],
    }));
    await settle();
    expect(text(f.root)).toContain(
      "Source control is unavailable. The current batch state could not be checked.",
    );
    expect(text(f.root)).toContain("PM QA passed");
    expect(text(f.root)).not.toContain("Review promotion batch");
  });
  it("separates earlier promotions and stale batch revisions from the current batch", async () => {
    const f = fixture(async () => ({
      workflow: { kind: "promotion" },
      promotionBatch: {
        url: "https://github.com/org/app/pull/99",
        number: 99,
        state: "open",
        headSha: "current-head",
      },
      missions: [],
      changes: [
        {
          jobId: "current",
          status: "succeeded",
          delivery: {
            status: "promoted",
            ticket: { title: "Current ticket" },
            promotion: {
              url: "https://github.com/org/app/pull/99",
              number: 99,
              headSha: "current-head",
            },
          },
        },
        {
          jobId: "stale",
          status: "succeeded",
          delivery: {
            status: "promoted",
            ticket: { title: "Stale inclusion" },
            promotion: {
              url: "https://github.com/org/app/pull/99",
              number: 99,
              headSha: "old-head",
            },
          },
        },
        {
          jobId: "earlier",
          status: "succeeded",
          delivery: {
            status: "promoted",
            ticket: { title: "Earlier ticket" },
            promotion: {
              url: "https://github.com/org/app/pull/80",
              number: 80,
              headSha: "previous-head",
            },
          },
        },
      ],
    }));
    await settle();
    expect(
      walk(f.root).filter(
        (item) => item.textContent === "Included in promotion",
      ),
    ).toHaveLength(1);
    expect(text(f.root)).toContain("Batch inclusion needs refresh");
    expect(text(f.root)).toContain("Earlier promotions");
    expect(text(f.root)).toContain("The promotion PR changed.");
    expect(
      walk(f.root).filter((item) => item.className === "promotion-ticket"),
    ).toHaveLength(3);
  });
  it("surfaces blocked and waiting draft migration reasons before delivery admission", async () => {
    const f = fixture(async () => ({
      workflow: { kind: "promotion" },
      missions: [],
      changes: [
        {
          jobId: "blocked",
          status: "succeeded",
          migration: {
            phase: "blocked",
            message:
              "The approved ticket scope changed. Owner review is required.",
          },
        },
        {
          jobId: "waiting",
          status: "succeeded",
          migration: {
            phase: "waiting",
            message: "The original draft checks are still pending.",
          },
        },
      ],
    }));
    await settle();
    expect(text(f.root)).toContain("Blocked");
    expect(text(f.root)).toContain("Preparing existing draft");
    expect(text(f.root)).toContain(
      "The approved ticket scope changed. Owner review is required.",
    );
    expect(text(f.root)).toContain(
      "The original draft checks are still pending.",
    );
    expect(text(f.root)).not.toContain("PM QA pending");
  });
  it("tracks promotion work through real delivery stages without requesting manual draft review", async () => {
    const changes = [
      ["checks", "awaiting-merge"],
      ["deployment", "awaiting-deployment"],
      ["qa", "awaiting-review"],
      ["verified", "verified"],
      ["promotion", "promoted"],
      ["failed", "failed"],
      ["blocked", "blocked"],
    ].map(([jobId, status], index) => ({
      jobId,
      status: "succeeded",
      pullRequests: [
        {
          number: index + 1,
          url: `https://github.com/org/app/pull/${index + 1}`,
          state: status === "awaiting-merge" ? "open" : "merged",
          currentHeadSha: "new-sha",
        },
      ],
      checks: { headSha: "old-sha", commands: ["npm test"] },
      delivery: {
        status,
        ticket: { title: `${jobId} ticket` },
        message:
          status === "blocked"
            ? "Deployment protection prevents QA."
            : `Actual ${status} status.`,
        ...(status === "promoted"
          ? { promotion: { url: "https://github.com/org/app/pull/20" } }
          : {}),
        ...(status === "failed"
          ? {
              rework: {
                jobId: "repair-1",
                phase: "queued",
                message:
                  "Coding repair is queued for the failed sign-in criterion.",
              },
            }
          : {}),
      },
    }));
    const f = fixture(async () => ({
      missions: [],
      workflow: { kind: "promotion" },
      changes,
    }));
    await settle();
    for (const expected of [
      "Integration checks",
      "Waiting for deployment",
      "PM QA pending",
      "PM QA passed",
      "Batch inclusion unconfirmed",
      "Coding follow-up queued",
      "Blocked",
    ])
      expect(text(f.root)).toContain(expected);
    expect(text(f.root)).toContain("Deployment protection prevents QA.");
    expect(text(f.root)).toContain(
      "Coding repair is queued for the failed sign-in criterion.",
    );
    expect(
      walk(f.root).some(
        (item) =>
          item.textContent === "Activity" &&
          item.href === "http://localhost/activity?run=repair-1",
      ),
    ).toBe(true);
    expect(byText(f.root, "Open recorded batch").href).toBe(
      "https://github.com/org/app/pull/20",
    );
    expect(text(f.root)).toContain(
      "Recorded worker checks cover an earlier revision",
    );
    expect(text(f.root)).not.toContain("Changes ready for review");
    expect(text(f.root)).not.toContain("Inspect the draft");
    expect(text(f.root)).not.toContain("earlier changes are merged or closed");
    expect(
      walk(f.root).some((item) => item.textContent === "Review pull request"),
    ).toBe(false);
  });
  it("does not treat a successful coding job as a PM QA pass without delivery evidence", async () => {
    const f = fixture(async () => ({
      missions: [],
      workflow: { kind: "promotion" },
      changes: [
        {
          jobId: "coding-only",
          status: "succeeded",
          message: "Coding finished.",
          pullRequests: [
            { state: "open", url: "https://github.com/org/app/pull/7" },
          ],
        },
      ],
    }));
    await settle();
    expect(text(f.root)).toContain("Preparing for PM QA");
    expect(
      walk(f.root).filter((item) => item.className === "promotion-ticket"),
    ).toHaveLength(1);
    expect(
      walk(f.root).some(
        (item) =>
          item.className.includes("promotion-ticket-status") &&
          item.textContent === "PM QA passed",
      ),
    ).toBe(false);
    expect(text(f.root)).not.toContain("Included in promotion");
    expect(text(f.root)).not.toContain("Changes ready for review");
  });
  it("distinguishes active coding follow-up from stopped retries without hiding the original QA failure", async () => {
    let phase = "queued";
    const f = fixture(async () => ({
      workflow: { kind: "promotion" },
      missions: [],
      changes: [
        {
          jobId: "original",
          status: "succeeded",
          pullRequests: [],
          delivery: {
            status: "failed",
            message: "The sign-in confirmation never appeared.",
            rework: {
              jobId: "repair",
              phase,
              message:
                phase === "stopped"
                  ? "The automatic coding repair did not satisfy this criterion. Review the evidence."
                  : "Coding repair is queued.",
            },
          },
        },
      ],
    }));
    await settle();
    expect(text(f.root)).toContain("Coding follow-up queued");
    expect(text(f.root)).toContain("The sign-in confirmation never appeared.");
    expect(text(f.root)).not.toContain("PM QA PASSED");
    phase = "stopped";
    f.timers.at(-1)!();
    await settle();
    expect(text(f.root)).toContain("Follow-up stopped");
    expect(text(f.root)).toContain(
      "The automatic coding repair did not satisfy this criterion",
    );
    expect(text(f.root)).not.toContain("Coding follow-up queued");
  });
  it("surfaces the actual promotion hold and staging blocker even after PM QA passed", async () => {
    const f = fixture(async () => ({
      workflow: { kind: "promotion" },
      missions: [],
      deliveryOperation: {
        phase: "idle",
        message:
          "Assembled candidate failed the checkout test. The controller will retry after its backoff.",
        rows: [{ needsYou: true, pending: true }],
      },
      stagingSync: {
        phase: "blocked",
        message: "The staging sync PR has failing branch checks.",
      },
      changes: [
        {
          jobId: "passed",
          status: "succeeded",
          pullRequests: [],
          delivery: {
            status: "verified",
            message: "PM acceptance checks passed.",
          },
        },
      ],
    }));
    await settle();
    expect(text(f.root)).toContain("Your promotion batch");
    expect(text(f.root)).toContain(
      "Assembled candidate failed the checkout test. The controller will retry after its backoff.",
    );
    expect(text(f.root)).toContain(
      "The staging sync PR has failing branch checks.",
    );
    expect(text(f.root)).toContain("PM acceptance checks passed.");
    expect(text(f.root)).not.toContain("Promotion PR published");
  });
  it("keeps mission guidance aligned with automatic QA while retaining actual blockers", async () => {
    let current = mission({
      status: "review-changes",
      message: "Coding finished. Review the actual changes before merging.",
    });
    const f = fixture(async (url) =>
      url.endsWith("/missions")
        ? { workflow: { kind: "promotion" }, missions: [current], changes: [] }
        : { mission: current, candidates: [] },
    );
    await settle();
    expect(text(f.root)).toContain("Follow your change through PM QA");
    expect(text(f.root)).not.toContain(
      "Review the actual changes before merging",
    );
    current = mission({
      status: "blocked",
      message: "Source connection expired. Reconnect GitHub.",
    });
    f.timers.at(-1)!();
    await settle();
    expect(text(f.root)).toContain(
      "Source connection expired. Reconnect GitHub.",
    );
    expect(text(f.root)).toContain("This mission needs your help");
  });
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
