import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { samplePlan } from "../ideaCrew/test-support.ts";

class Element {
  children: Element[] = [];
  listeners = new Map<string, () => unknown>();
  attributes = new Map<string, string>();
  classList = { toggle: vi.fn() };
  textContent = "";
  value = "";
  open = false;
  scrollTop = 0;
  focus = vi.fn();
  constructor(public tagName: string) {}
  append(...children: Element[]) {
    this.children.push(...children);
  }
  replaceChildren(...children: Element[]) {
    this.children = children;
  }
  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }
  addEventListener(name: string, callback: () => unknown) {
    this.listeners.set(name, callback);
  }
  fire(name: string) {
    return this.listeners.get(name)?.();
  }
  showModal() {
    this.open = true;
    this.scrollTop = 500;
  }
  close() {
    this.open = false;
  }
}
const walk = (element: Element): Element[] => [
  element,
  ...element.children.flatMap(walk),
];

describe("idea crew review dialogs", () => {
  it("opens both reviews at their heading with a top Close control and retains bottom Done", async () => {
    const container = new Element("DIV");
    const window = {
      createIdeaCrew: (_options: object) => ({ restore: async () => {} }),
    };
    const idea = "Build a booking app for a pottery studio's classes.";
    const plan = samplePlan();
    plan.crew[0]!.name = "Foundation and the complete first customer journey";
    runInNewContext(
      readFileSync(
        new URL("../../dashboard/idea-crew.js", import.meta.url),
        "utf8",
      ),
      {
        window,
        document: {
          createElement: (tag: string) => new Element(tag.toUpperCase()),
        },
        sessionStorage: {
          getItem: () => JSON.stringify({ id: "preview", idea }),
          setItem() {},
          removeItem() {},
        },
      },
    );
    const crew = window.createIdeaCrew({
      container,
      api: async () => ({ id: "preview", idea, plan }),
    });
    await crew.restore();
    for (const [buttonLabel, title] of [
      ["View first assignment", plan.crew[0]!.name],
      ["Review assumptions & scope", "Assumptions and scope"],
    ]) {
      await walk(container)
        .find((element) => element.textContent === buttonLabel)!
        .fire("click");
      const dialog = walk(container).find(
        (element) => element.tagName === "DIALOG" && element.open,
      )!;
      const header = dialog.children[0]!,
        heading = header.children[0]!,
        close = header.children[1]!;
      expect(header.tagName).toBe("HEADER");
      expect(heading.textContent).toBe(title);
      expect(heading.attributes.get("tabindex")).toBe("-1");
      expect(heading.attributes.has("autofocus")).toBe(true);
      expect(heading.focus).toHaveBeenCalledWith({ preventScroll: true });
      expect(dialog.scrollTop).toBe(0);
      expect(dialog.children.at(-1)!.textContent).toBe("Done");
      expect(close.textContent).toBe("Close");
      await close.fire("click");
      expect(dialog.open).toBe(false);
    }
  });
});
