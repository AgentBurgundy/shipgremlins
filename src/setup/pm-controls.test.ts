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
  it("keeps investigation and approved coding states distinct, labeled and scoped", () => {
    const root = render(),
      [investigate, coding] = switches(root);
    expect(investigate!.attributes.get("aria-label")).toBe(
      "Investigations for Pip",
    );
    expect(coding!.attributes.get("aria-label")).toBe(
      "Approved coding for Pip",
    );
    expect(investigate!.attributes.get("aria-checked")).toBe("true");
    expect(coding!.attributes.get("aria-checked")).toBe("false");
    expect(text(investigate!)).toContain("On");
    expect(text(coding!)).toContain("Off");
    expect(investigate!.dataset).toEqual({
      toggleArea: "core",
      areaProject: "alpha",
      enableArea: "false",
    });
    expect(coding!.dataset).toEqual({
      toggleArea: "core",
      areaProject: "alpha",
      automationKind: "coding",
    });
    expect(run(root).dataset).toEqual({
      launchProject: "alpha",
      launchCrew: "pm",
      launchArea: "core",
    });
  });
  it("preserves legacy coding fallback and reports both enabled or paused accurately", () => {
    expect(
      switches(render({}, { codingEnabled: undefined }))[1]!.attributes.get(
        "aria-checked",
      ),
    ).toBe("true");
    expect(text(render({}, { codingEnabled: true }))).toContain("Both enabled");
    expect(text(render({}, { enabled: false }))).toContain("Paused");
  });
  it("announces only the pending setting while preserving both last-saved switch values", () => {
    const root = render({
        operation: { busy: true, mode: "coding-automation" },
      }),
      [investigate, coding] = switches(root);
    expect(root.attributes.get("aria-busy")).toBe("true");
    expect(investigate!.attributes.get("aria-busy")).toBe("false");
    expect(coding!.attributes.get("aria-busy")).toBe("true");
    expect(investigate!.attributes.get("aria-checked")).toBe("true");
    expect(coding!.attributes.get("aria-checked")).toBe("false");
    expect(text(investigate!)).not.toContain("Saving");
    expect(text(coding!)).toContain("Saving…");
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
