import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

class Element {
  children: Element[] = [];
  attributes = new Map<string, string>();
  dataset: Record<string, string> = {};
  className = "";
  textContent = "";
  type = "";
  href = "";
  disabled = false;
  constructor(public tagName: string) {}
  append(...children: Element[]) {
    this.children.push(...children);
  }
  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }
}
const all = (root: Element): Element[] => [root, ...root.children.flatMap(all)];
const text = (root: Element) =>
  all(root)
    .map((item) => item.textContent)
    .join(" ");
const window = {} as {
  renderCrewSetup: (project: object, options?: object) => Element;
  renderFoundationLauncher: (project: object) => Element;
  renderPmControls: (
    project: object,
    area: object,
    options?: object,
  ) => Element;
};
runInNewContext(
  readFileSync(
    new URL("../../dashboard/crew-guidance.js", import.meta.url),
    "utf8",
  ),
  {
    window,
    document: {
      createElement: (tag: string) => new Element(tag.toUpperCase()),
    },
  },
);
const project = { name: "alpha", instanceId: "current" };
const area = { key: "core", name: "Pip", enabled: true, codingEnabled: false };
const render = (options = {}, changes = {}) =>
  window.renderPmControls(project, { ...area, ...changes }, options);
const switches = (root: Element) =>
  all(root).filter((item) => item.attributes.get("role") === "switch");
const run = (root: Element) =>
  all(root).find((item) => item.dataset.launchCrew === "pm")!;

describe("compact PM work controls", () => {
  it("routes an unassigned foundation to coding agents and preserves active or paused assigned builds", () => {
    const initial = {
      ...project,
      foundation: { stage: "review" },
      coders: { agents: [] as object[] },
    };
    let root = window.renderFoundationLauncher(initial);
    expect(all(root).find((item) => item.tagName === "A")?.href).toBe(
      "/projects/alpha?tab=crew",
    );
    expect(text(root)).toContain("Add coding agent");
    initial.coders.agents.push({
      key: "builder",
      enabled: false,
      areas: ["foundation"],
    });
    root = window.renderFoundationLauncher(initial);
    expect(text(root)).toContain("Build foundation");
    expect(all(root).find((item) => item.tagName === "A")?.href).toBe(
      "/projects/alpha?tab=environment",
    );
    initial.coders.agents = [];
    initial.foundation.stage = "building";
    expect(text(window.renderFoundationLauncher(initial))).toContain(
      "View build",
    );
  });
  it("keeps one immediate setup action while retaining every scoped check in the expandable checklist", () => {
    const root = window.renderCrewSetup({
      ...project,
      readiness: {
        blockers: [
          {
            id: "worker",
            action: "worker",
            message: "A verified runner is needed.",
          },
          {
            id: "linear_connection",
            action: "linear",
            message: "Connect Linear.",
          },
        ],
        steps: [
          { id: "worker", action: "worker", label: "Runner", ready: false },
          {
            id: "linear_connection",
            action: "linear",
            label: "Linear",
            ready: false,
          },
        ],
      },
    });
    const checklist = all(root).find((node) => node.tagName === "DETAILS")!;
    expect(text(checklist)).toContain("View setup checks");
    const immediate = all(root).filter(
      (node) => node.tagName === "BUTTON" && !all(checklist).includes(node),
    );
    expect(immediate).toHaveLength(1);
    expect(immediate[0]!.textContent).toBe("Set up a runner");
    expect(immediate[0]!.dataset).toEqual({
      setupAction: "worker",
      setupProject: "alpha",
      setupStep: "worker",
    });
    expect(
      all(checklist)
        .filter((node) => node.tagName === "BUTTON")
        .map((node) => node.dataset.setupStep),
    ).toEqual(["worker", "linear_connection"]);
  });
  it("shows only the PM investigation switch with its scoped accessible label", () => {
    const root = render(),
      [investigate] = switches(root);
    expect(switches(root)).toHaveLength(1);
    expect(text(root)).not.toContain("Approved coding");
    expect(investigate!.attributes.get("aria-label")).toBe(
      "Investigations for Pip",
    );
    expect(investigate!.attributes.get("aria-checked")).toBe("true");
    expect(text(investigate!)).toContain("On");
    expect(investigate!.dataset).toEqual({
      toggleArea: "core",
      areaProject: "alpha",
      enableArea: "false",
    });
    expect(run(root).dataset).toEqual({
      launchProject: "alpha",
      launchCrew: "pm",
      launchArea: "core",
    });
  });
  it("does not expose old coding settings as PM controls and describes only investigation intent", () => {
    expect(switches(render({}, { codingEnabled: true }))).toHaveLength(1);
    expect(text(render({}, { codingEnabled: true }))).toContain(
      "Investigations enabled",
    );
    expect(text(render({}, { enabled: false, codingEnabled: true }))).toContain(
      "Investigations paused",
    );
  });
  it("announces pending investigations while preserving the saved switch value", () => {
    const root = render({
        operation: { busy: true, mode: "automation" },
      }),
      [investigate] = switches(root);
    expect(root.attributes.get("aria-busy")).toBe("true");
    expect(investigate!.attributes.get("aria-busy")).toBe("true");
    expect(investigate!.attributes.get("aria-checked")).toBe("true");
    expect(text(investigate!)).toContain("Saving…");
    expect(switches(root).every((item) => item.disabled)).toBe(true);
    expect(run(root).disabled).toBe(true);
  });
  it("distinguishes a locked workspace and starting a run from saving settings", () => {
    const locked = render({ locked: true });
    expect(text(locked)).toContain("Temporarily unavailable");
    expect(text(locked)).not.toContain("Saving");
    expect(switches(locked).every((item) => item.disabled)).toBe(true);
    const busy = render({ operation: { busy: true, mode: "run" } });
    expect(text(busy)).toContain("Starting a run…");
    expect(run(busy).textContent).toBe("Starting…");
    expect(text(busy)).not.toContain("Saving");
  });
  it("opens an active current-instance run without attaching a deleted instance's job", () => {
    const job = {
      type: "pm",
      project: "alpha",
      projectInstanceId: "current",
      area: "core",
      status: "running",
    };
    expect(run(render({ jobs: [job] })).textContent).toBe("View run");
    expect(
      run(render({ jobs: [{ ...job, projectInstanceId: "deleted" }] }))
        .textContent,
    ).toBe("Run now");
  });
  it("keeps confirmed saves visible and errors announced without using HTML", () => {
    const success = render({
      operation: { message: "Investigations saved. Current runs keep going." },
    });
    expect(
      all(success)
        .find((item) => item.className.includes("pm-controls-feedback"))!
        .attributes.get("role"),
    ).toBe("status");
    expect(text(success)).toContain(
      "Investigations saved. Current runs keep going.",
    );
    const failure = render({
      operation: { error: true, message: "Refresh before trying again." },
    });
    expect(
      all(failure)
        .find((item) => item.className.includes("pm-controls-feedback"))!
        .attributes.get("role"),
    ).toBe("alert");
    expect(text(failure)).toContain("Refresh before trying again.");
  });
  it("keeps automation hidden behind the foundation prerequisite", () => {
    const root = window.renderPmControls(
      { ...project, foundation: { needed: true } },
      area,
    );
    expect(switches(root)).toHaveLength(0);
    expect(root.children[0]!.href).toBe("/projects/alpha?tab=environment");
  });
});
