import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

const app = readFileSync(
  new URL("../../dashboard/app.js", import.meta.url),
  "utf8",
);
function extract(startText: string, endText: string) {
  const start = app.indexOf(startText);
  const end = app.indexOf(endText, start);
  if (start < 0 || end < start) throw new Error("Run function not found");
  return app.slice(start, end);
}

describe("run dialog dismissal", () => {
  it("clears running output and closes the overlay route while restoring the project opener", () => {
    const opener = {
      dataset: {},
      isConnected: true,
      matches: () => false,
      focus: vi.fn(),
    };
    const elements = new Map();
    const $ = (id: string) => {
      if (!elements.has(id))
        elements.set(id, {
          hidden: false,
          replaceChildren: vi.fn(),
          querySelectorAll: () => [],
        });
      return elements.get(id);
    };
    const context = {
      $,
      selectedJobId: "job-one",
      grumblinReport: { clear: vi.fn() },
      clearTimeout: vi.fn(),
      jobOutputTimer: 4,
      jobOutput: { close: vi.fn() },
      outputErrors: new Map([["logs", "temporary error"]]),
      outputNotices: new Map([["logs", "notice"]]),
      outputCompleted: new Set(["logs"]),
      clearArtifactBlobs: vi.fn(),
      runViewer: { close: vi.fn() },
      pages: { current: "project", closeRun: vi.fn(), navigate: vi.fn() },
      renderJobs: vi.fn(),
      runnerStatus: { jobs: [] },
      jobDetailTrigger: opener,
    };
    const close = runInNewContext(
      `(${extract("  function closeJobDetail(", '  window.addEventListener("dashboard:pagechange"').trim()})`,
      context,
    ) as () => void;
    close();
    expect(context.selectedJobId).toBe("");
    expect(context.jobOutput.close).toHaveBeenCalledOnce();
    expect(context.clearTimeout).toHaveBeenCalledWith(4);
    expect(context.outputErrors.size).toBe(0);
    expect(context.clearArtifactBlobs).toHaveBeenCalledOnce();
    expect(context.pages.closeRun).toHaveBeenCalledOnce();
    expect(context.pages.navigate).not.toHaveBeenCalled();
    expect(opener.focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(context.jobDetailTrigger).toBeNull();
  });

  it("continues refreshing an open run over a project and stops when dismissed", () => {
    const context = {
      selectedJobId: "job-one",
      auth: { isAuthenticated: () => true },
      restarting: false,
      jobOutputSuspended: false,
      document: { hidden: false },
      pages: { current: "project" },
      runViewer: { isOpen: true },
    };
    const visible = runInNewContext(
      `(${extract("  function jobOutputVisible() {", "  function setOutputMessage(").trim()})`,
      context,
    ) as () => boolean;
    expect(visible()).toBe(true);
    context.runViewer.isOpen = false;
    expect(visible()).toBe(false);
  });
});
