import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

const app = readFileSync(
  new URL("../../dashboard/app.js", import.meta.url),
  "utf8",
);
class Element {
  textContent = "";
  value = "";
  disabled = false;
  required = false;
  hidden = false;
  open = false;
  href = "";
  children: Element[] = [];
  append(...items: Element[]) {
    this.children.push(...items);
  }
  replaceChildren(...items: Element[]) {
    this.children = items;
  }
}
function elements() {
  const items = new Map<string, Element>();
  return (id: string) => {
    if (!items.has(id)) items.set(id, new Element());
    return items.get(id)!;
  };
}
function queueFixture(
  api = vi.fn(async (_path: string, _body: unknown) => ({
    job: {
      id: "coding-1",
      type: "developer",
      project: "shop",
      ticket: "APP-12",
    },
  })),
) {
  const $ = elements();
  const state = {
    $,
    api,
    formsLocked: false,
    runnerRequestBusy: false,
    sessionToken: "test-session",
    updateRunnerControls: vi.fn(),
    scheduleRunnerPoll: vi.fn(),
    refreshRunners: vi.fn(async () => {}),
    selectJob: vi.fn(),
    jobHistory: [] as object[],
    element: (_tag: string, _className: string, text: string) =>
      Object.assign(new Element(), { textContent: text }),
    message: (target: Element, text: string) => {
      target.textContent = text;
      target.children = [];
    },
  };
  const start = app.indexOf("  async function queueManualJob(input) {"),
    end = app.indexOf('  $("job-form").addEventListener', start);
  const queue = runInNewContext(
    `(${app.slice(start, end).trim()})`,
    state,
  ) as (input: {
    type: string;
    project: string;
    ticket?: string;
    area?: string;
  }) => Promise<void>;
  return { $, state, queue };
}
describe("manual coding queue controls", () => {
  it("allows a ready coding run without a ticket identifier and explains automatic selection", () => {
    const $ = elements();
    $("job-project").value = "shop";
    $("job-type").value = "developer";
    const context = {
      $,
      formsLocked: false,
      sessionToken: "test",
      restarting: false,
      runnerLoading: false,
      runnerRequestBusy: false,
      removeRunnerId: "",
      runnerStatus: {
        runners: [{ id: "worker", status: "ready" }],
        machine: { docker: { available: true } },
      },
      runnerOperationBusy: () => false,
      currentStatus: {
        projects: [
          {
            name: "shop",
            readiness: { canRun: true, blockers: [], areas: [] },
          },
        ],
      },
      document: { querySelectorAll: () => [] },
      window: { renderCrewSetup: () => new Element() },
    };
    const start = app.indexOf("  function updateRunnerControls() {"),
      end = app.indexOf("  function renderJobProjects()", start);
    const update = runInNewContext(
      `(${app.slice(start, end).trim()})`,
      context,
    ) as () => void;
    update();
    expect($("run-job").disabled).toBe(false);
    expect($("job-ticket").required).toBe(false);
    expect($("run-job").textContent).toContain("Run next approved ticket");
    expect($("job-guidance").textContent).toContain("does not approve tickets");
    $("job-ticket").value = "APP-12";
    update();
    expect($("run-job").textContent).toContain("Run this ticket");
    context.currentStatus.projects[0]!.readiness.canRun = false;
    update();
    expect($("run-job").disabled).toBe(true);
  });
  it("omits ticket for automatic selection and opens the actual selected job", async () => {
    const f = queueFixture();
    await f.queue({ type: "developer", project: "shop", ticket: "  " });
    expect(f.state.api).toHaveBeenCalledWith(
      "/api/jobs",
      {
        type: "developer",
        project: "shop",
      },
      "POST",
      90000,
    );
    expect(f.state.selectJob).toHaveBeenCalledWith("coding-1");
    expect(f.$("job-message").textContent).toContain(
      "APP-12 queued for coding",
    );
    expect(f.$("job-ticket-field").open).toBe(false);
  });
  it("keeps an explicit ticket optional and preserves the PM request shape", async () => {
    const f = queueFixture();
    await f.queue({ type: "developer", project: "shop", ticket: " APP-8 " });
    expect(f.state.api).toHaveBeenLastCalledWith("/api/jobs", {
      type: "developer",
      project: "shop",
      ticket: "APP-8",
    });
    await f.queue({
      type: "pm",
      project: "shop",
      area: "security",
      ticket: "APP-8",
    });
    expect(f.state.api).toHaveBeenLastCalledWith("/api/jobs", {
      type: "pm",
      project: "shop",
      area: "security",
    });
  });
  it("gives useful review and PM links when nothing approved is ready, without pretending a job started", async () => {
    const api = vi.fn(async () => {
      throw new Error(
        "No approved tickets are ready. Review a PM proposal or run a PM patrol first.",
      );
    });
    const f = queueFixture(api);
    await f.queue({ type: "developer", project: "shop" });
    expect(f.state.selectJob).not.toHaveBeenCalled();
    expect(f.$("job-message").textContent).toContain("No approved tickets");
    const links = f.$("job-message").children[0]!.children;
    expect(links.map((link) => link.href)).toEqual([
      "/projects/shop?tab=review",
      "/projects/shop",
    ]);
    expect(f.state.runnerRequestBusy).toBe(false);
  });
  it("does not enqueue another job while the previous request is unresolved", async () => {
    let done!: (value: {
      job: { id: string; type: string; project: string; ticket: string };
    }) => void;
    const api = vi.fn(
      () =>
        new Promise<{
          job: { id: string; type: string; project: string; ticket: string };
        }>((resolve) => {
          done = resolve;
        }),
    );
    const f = queueFixture(api);
    const first = f.queue({ type: "developer", project: "shop" });
    await f.queue({ type: "developer", project: "shop" });
    expect(api).toHaveBeenCalledTimes(1);
    done({
      job: {
        id: "coding-1",
        type: "developer",
        project: "shop",
        ticket: "APP-12",
      },
    });
    await first;
    expect(f.state.runnerRequestBusy).toBe(false);
  });
});
