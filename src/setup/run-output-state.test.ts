import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

const app = readFileSync(
  new URL("../../dashboard/app.js", import.meta.url),
  "utf8",
);
class Element {
  textContent = "";
  hidden = false;
  className = "";
  dataset: Record<string, string> = {};
  children: Element[] = [];
  replaceChildren(...children: Element[]) {
    this.children = children;
  }
}
function extract(startText: string, endText: string) {
  const start = app.indexOf(startText),
    end = app.indexOf(endText, start);
  if (start < 0 || end < start)
    throw new Error("Run renderer could not be found");
  return app.slice(start, end);
}
function fixture() {
  const elements = new Map<string, Element>();
  const $ = (id: string) => {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id)!;
  };
  const context = {
    $,
    grumblinReport: undefined,
    outputErrors: new Map<string, string>(),
    outputNotices: new Map<string, string>(),
    outputCompleted: new Set<string>(),
    patrolOutput: {
      activity: {} as { events?: object[]; summary?: string },
      artifacts: [] as object[],
      activityState: "loading",
      artifactState: "loading",
    },
    renderPatrolOutput: vi.fn(),
    renderActivity: vi.fn(),
    renderArtifacts: vi.fn(async (_id: string, files: object[]) =>
      $("job-artifacts").replaceChildren(...files.map(() => new Element())),
    ),
    setOutputMessage: (id: string, text: string, error = false) => {
      Object.assign($(id), {
        textContent: text,
        hidden: !text,
        className: error ? "error" : "",
      });
    },
    renderOutputMessages: undefined as unknown as () => void,
    window: { createJobOutput: (options: unknown) => options },
  };
  context.renderOutputMessages = runInNewContext(
    `(${extract("  function renderOutputMessages() {", "  function renderPatrolOutput() {").trim()})`,
    context,
  );
  const controller = runInNewContext(
    `${extract("  const jobOutput = window.createJobOutput({", "  function pauseJobOutput() {")}\njobOutput`,
    context,
  ) as {
    render: (
      resource: string,
      value: object,
      renderContext: { id: string },
    ) => Promise<void>;
    onError: (resource: string, error: Error | null) => void;
  };
  return { $, context, controller };
}
describe("run output presentation state", () => {
  it("shows one waiting message for pending empty evidence", async () => {
    const f = fixture();
    await f.controller.render(
      "artifacts",
      { files: [], pending: true },
      { id: "job-1" },
    );
    f.controller.onError("artifacts", null);
    expect(f.$("run-artifact-empty").hidden).toBe(false);
    expect(f.$("job-artifact-message").hidden).toBe(true);
  });
  it("prioritizes real partial/error messages and restores empty state when access recovers", async () => {
    const f = fixture();
    await f.controller.render(
      "artifacts",
      { files: [], partial: true, message: "Artifact storage is unavailable." },
      { id: "job-1" },
    );
    f.controller.onError("artifacts", null);
    expect(f.$("run-artifact-empty").hidden).toBe(true);
    expect(f.$("job-artifact-message").textContent).toBe(
      "Artifact storage is unavailable.",
    );
    f.controller.onError("artifacts", new Error("Access denied"));
    expect(f.$("job-artifact-message").textContent).toBe("Access denied");
    expect(f.$("job-artifact-message").className).toBe("error");
    await f.controller.render("artifacts", { files: [] }, { id: "job-1" });
    f.controller.onError("artifacts", null);
    expect(f.$("run-artifact-empty").hidden).toBe(false);
    expect(f.$("job-artifact-message").hidden).toBe(true);
  });
  it("keeps already loaded evidence and activity through an empty partial refresh", async () => {
    const f = fixture(),
      activity = {
        events: [{ id: "event-1", title: "Investigated a workflow" }],
        summary: "Observed a useful outcome",
      };
    await f.controller.render("activity", activity, { id: "job-1" });
    await f.controller.render(
      "activity",
      { events: [], partial: true },
      { id: "job-1" },
    );
    expect(f.context.renderActivity).toHaveBeenLastCalledWith(activity);
    await f.controller.render(
      "artifacts",
      { files: [{ name: "evidence.png" }] },
      { id: "job-1" },
    );
    const previous = f.$("job-artifacts").children[0];
    await f.controller.render(
      "artifacts",
      { files: [], partial: true, message: "Storage is reconnecting." },
      { id: "job-1" },
    );
    f.controller.onError("artifacts", null);
    expect(f.$("job-artifacts").children).toEqual([previous]);
    expect(f.$("run-artifact-empty").hidden).toBe(true);
    expect(f.$("job-artifact-message").textContent).toContain("reconnecting");
  });
  it("names product exploration accurately in the run header", () => {
    const f = fixture();
    const render = runInNewContext(
      `(${extract("  function renderRunIdentity() {", "  function renderJobControls() {").trim()})`,
      {
        $: f.$,
        selectedJobId: "job-1",
        currentStatus: { projects: [] },
        renderPatrolOutput() {},
        grumblinReport: undefined,
        timestamp: (value: string) => value,
        mergedJobs: () => [
          {
            id: "job-1",
            type: "pm",
            pmMode: "exploration",
            runId: 8,
            status: "queued",
          },
        ],
        element: (_tag: string, _className: string, textContent: string) =>
          Object.assign(new Element(), { textContent }),
      },
    ) as () => void;
    render();
    expect(f.$("job-detail-title").textContent).toBe(
      "Product exploration · Run 8",
    );
  });
});
