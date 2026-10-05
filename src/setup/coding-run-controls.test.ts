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
function controlsFixture(blockers: { id: string; message: string }[] = []) {
  const $ = elements();
  $("job-project").value = "shop";
  $("job-type").value = "pm";
  $("job-area").value = "core";
  const area = { key: "core", canRun: blockers.length === 0, blockers };
  const project = {
    name: "shop",
    foundation: { needed: false },
    readiness: { canRun: blockers.length === 0, blockers, areas: [area] },
  };
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
    currentStatus: { projects: [project] },
    document: { querySelectorAll: () => [] },
    window: {
      renderCrewSetup: vi.fn(() => new Element()),
      renderFoundationLauncher: vi.fn(() => new Element()),
    },
  };
  const start = app.indexOf("  function updateRunnerControls() {"),
    end = app.indexOf("  function renderJobProjects()", start);
  const update = runInNewContext(
    `(${app.slice(start, end).trim()})`,
    context,
  ) as () => void;
  return { $, area, project, context, update };
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
  it.each([
    ["linear_mapping"],
    ["verification"],
    ["linear_mapping", "verification"],
  ])(
    "lets a deliberate PM run prepare %j without sending the owner to manual setup",
    (...ids) => {
      const f = controlsFixture(ids.map((id) => ({ id, message: id })));
      f.update();
      expect(f.$("run-job").disabled).toBe(false);
      expect(f.$("job-guidance").textContent).toContain("verifies connections");
      expect(f.$("job-setup-guide").children).toHaveLength(0);
      f.$("job-type").value = "developer";
      f.update();
      expect(f.$("run-job").disabled).toBe(true);
    },
  );
  it.each([
    "configuration",
    "source_connection",
    "ai_connection",
    "worker",
    "mandate",
    "linear_connection",
    "browser_connections",
  ])(
    "keeps the %s prerequisite blocked even with repairable PM setup",
    (id) => {
      const f = controlsFixture([
        { id: "linear_mapping", message: "Mapping needed" },
        { id: "verification", message: "Verification needed" },
        { id, message: "Real prerequisite" },
      ]);
      f.update();
      expect(f.$("run-job").disabled).toBe(true);
      expect(f.context.window.renderCrewSetup).toHaveBeenCalledWith(f.project, {
        blockers: f.area.blockers,
        compact: true,
      });
    },
  );
  it("still requires a foundation, selected PM, session, and available worker", () => {
    const f = controlsFixture([
      { id: "verification", message: "Verification needed" },
    ]);
    f.project.foundation.needed = true;
    f.update();
    expect(f.$("run-job").disabled).toBe(true);
    expect(f.context.window.renderFoundationLauncher).toHaveBeenCalledWith(
      f.project,
    );
    f.project.foundation.needed = false;
    f.$("job-area").value = "missing";
    f.update();
    expect(f.$("run-job").disabled).toBe(true);
    f.$("job-area").value = "core";
    f.context.sessionToken = "";
    f.update();
    expect(f.$("run-job").disabled).toBe(true);
    f.context.sessionToken = "test";
    f.context.runnerStatus.runners = [];
    f.update();
    expect(f.$("run-job").disabled).toBe(true);
  });
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
    expect($("run-job").textContent).toContain("Start coding");
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
    expect(f.state.api).toHaveBeenLastCalledWith(
      "/api/jobs",
      {
        type: "pm",
        project: "shop",
        area: "security",
      },
      "POST",
      90000,
    );
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
