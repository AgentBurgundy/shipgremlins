import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

const app = readFileSync(
  new URL("../../dashboard/app.js", import.meta.url),
  "utf8",
);
const start = app.indexOf('    const list = $("project-list");'),
  end = app.indexOf("    const exampleProject = projects.find", start);
interface Project {
  name: string;
  repo: string;
  provider?: string;
  areas: object[];
  foundation?: { needed: boolean };
  readiness: { canRun: boolean; blockers: { action: string }[] };
}
function fixture(projects: Project[]) {
  const document = {
    activeElement: null as Element | null,
    createElement: (tag: string) => new Element(tag),
  };
  class Element {
    dataset: Record<string, string> = {};
    children: Element[] = [];
    parent: Element | null = null;
    textContent = "";
    className = "";
    href = "";
    constructor(public tag: string) {}
    append(...children: Element[]) {
      for (const child of children) {
        child.parent = this;
        this.children.push(child);
      }
    }
    replaceChildren(...children: Element[]) {
      this.children = [];
      this.append(...children);
    }
    all(): Element[] {
      return [this, ...this.children.flatMap((child) => child.all())];
    }
    contains(element: Element) {
      return this.all().includes(element);
    }
    querySelectorAll(selector: string) {
      const key = selector
        .match(/^\[data-([a-z-]+)\]$/)?.[1]
        ?.replace(/-([a-z])/g, (_all, letter: string) => letter.toUpperCase());
      return key
        ? this.all()
            .slice(1)
            .filter((element) => element.dataset[key] !== undefined)
        : [];
    }
    querySelector(selector: string) {
      return this.querySelectorAll(selector)[0] ?? null;
    }
    closest(selector: string): Element | null {
      if (selector === "[data-project-name]" && this.dataset.projectName)
        return this;
      return this.parent?.closest(selector) ?? null;
    }
    focus() {
      document.activeElement = this;
    }
  }
  const list = new Element("div");
  const render = runInNewContext(`() => { ${app.slice(start, end)} }`, {
    $: () => list,
    projects,
    document,
    projectDetailsState: new Map(),
    mappingTeamSelections: new Map(),
    element: (tag: string, className: string, textContent = "") =>
      Object.assign(new Element(tag), { className, textContent }),
  }) as () => void;
  return { list, document, render };
}
const project = (name = "my-app"): Project => ({
  name,
  repo: "owner/my-app",
  areas: [{}],
  readiness: { canRun: true, blockers: [] },
});

describe("project list navigation", () => {
  it("offers one workspace entry and settings, keeping execution controls inside the project", () => {
    const f = fixture([project()]);
    f.render();
    const controls = f.list.querySelectorAll("[data-project-control]");
    expect(
      controls.map((element) => [element.tag, element.textContent]),
    ).toEqual([
      ["a", "Open project"],
      ["button", "Settings"],
    ]);
    expect(controls[0]!.href).toBe("/projects/my-app");
    expect(controls[1]!.dataset.editProject).toBe("my-app");
    expect(f.list.all().some((element) => element.textContent === "1 PM")).toBe(
      true,
    );
    expect(
      f.list
        .all()
        .some(
          (element) =>
            element.dataset.launchCrew || element.dataset.verifyProject,
        ),
    ).toBe(false);
  });
  it("routes a fresh idea to its foundation even if ordinary readiness claims the project is ready", () => {
    const saved = project("new-idea");
    saved.foundation = { needed: true };
    saved.areas.push({});
    const f = fixture([saved]);
    f.render();
    const primary = f.list.querySelectorAll("[data-project-control]")[0]!;
    expect(primary.textContent).toBe("Build foundation");
    expect(primary.href).toBe("/projects/new-idea?tab=environment");
    expect(
      f.list.all().find((element) => element.className === "project-row-badge")
        ?.textContent,
    ).toBe("Build foundation");
    expect(
      f.list.all().some((element) => element.textContent === "2 PMs"),
    ).toBe(true);
    expect(f.list.all().some((element) => element.dataset.launchCrew)).toBe(
      false,
    );
  });
  it("preserves the focused project action when status refresh rebuilds the list", () => {
    const f = fixture([project("first"), project("second")]);
    f.render();
    const old = f.list
      .querySelectorAll("[data-project-control]")
      .find((element) => element.dataset.editProject === "second")!;
    old.focus();
    f.render();
    expect(f.document.activeElement).not.toBe(old);
    expect(f.document.activeElement?.dataset.editProject).toBe("second");
  });
});
