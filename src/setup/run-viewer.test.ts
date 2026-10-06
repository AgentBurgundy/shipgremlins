import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

const script = readFileSync(
  new URL("../../dashboard/run-viewer.js", import.meta.url),
  "utf8",
);
type Event = {
  key?: string;
  target?: unknown;
  clientX?: number;
  clientY?: number;
  preventDefault: () => void;
};
interface Viewer {
  open(options?: { reset?: boolean }): void;
  close(options?: { restoreFocus?: boolean }): void;
  selectTab(name: string, options?: { focus?: boolean }): boolean;
  isOpen: boolean;
  selectedTab: string;
}
function fixture() {
  const document = {
    activeElement: null as Node | null,
    body: { append: vi.fn() },
  };
  class Node {
    dataset: Record<string, string> = {};
    attributes = new Map<string, string>();
    events = new Map<string, (event: Event) => void>();
    hidden = false;
    tabIndex = -1;
    scrollTop = 0;
    isConnected = true;
    focus = vi.fn((_options?: { preventScroll?: boolean }) => {
      document.activeElement = this;
    });
    setAttribute(name: string, value: string) {
      this.attributes.set(name, value);
    }
    addEventListener(name: string, handler: (event: Event) => void) {
      this.events.set(name, handler);
    }
    dispatch(name: string, keyOrEvent?: string | Partial<Event>) {
      const event = {
        ...(typeof keyOrEvent === "string" ? { key: keyOrEvent } : keyOrEvent),
        preventDefault: vi.fn(),
      };
      this.events.get(name)?.(event);
      return event;
    }
  }
  const tabs = ["summary", "activity", "output", "artifacts"].map((name) => {
    const tab = new Node();
    tab.dataset.runTab = name;
    return tab;
  });
  const panels = tabs.map((tab) => {
    const panel = new Node();
    panel.dataset.runPanel = tab.dataset.runTab!;
    return panel;
  });
  const body = new Node();
  const dialog = Object.assign(new Node(), {
    open: false,
    showModal: vi.fn(() => {
      dialog.open = true;
    }),
    close: vi.fn(() => {
      dialog.open = false;
    }),
    querySelectorAll: (selector: string) =>
      selector === "[data-run-tab]" ? tabs : panels,
    querySelector: () => body,
    getBoundingClientRect: () => ({
      left: 100,
      top: 50,
      right: 900,
      bottom: 650,
    }),
  });
  const trigger = new Node();
  trigger.focus();
  const onClose = vi.fn();
  const window = {} as {
    createRunViewer: (
      element: typeof dialog,
      options: { onClose: () => void },
    ) => Viewer;
  };
  runInNewContext(script, { window, document });
  const viewer = window.createRunViewer(dialog, { onClose });
  return { document, tabs, panels, body, dialog, trigger, onClose, viewer };
}

describe("dedicated run viewer", () => {
  it("opens one modal outside page panels with a single visible tab panel", () => {
    const f = fixture();
    f.viewer.open({ reset: true });
    expect(f.document.body.append).toHaveBeenCalledWith(f.dialog);
    expect(f.dialog.showModal).toHaveBeenCalledOnce();
    expect(f.viewer.isOpen).toBe(true);
    expect(f.panels.filter((panel) => !panel.hidden)).toEqual([f.panels[0]]);
    expect(f.document.activeElement).toBe(f.tabs[0]);
    expect(f.tabs.map((tab) => tab.tabIndex)).toEqual([0, -1, -1, -1]);
    expect(f.tabs.map((tab) => tab.attributes.get("aria-selected"))).toEqual([
      "true",
      "false",
      "false",
      "false",
    ]);
  });

  it("supports arrow wrapping, Home and End while keeping focus on the selected tab", () => {
    const f = fixture();
    f.viewer.open();
    expect(
      f.tabs[0]!.dispatch("keydown", "ArrowLeft").preventDefault,
    ).toHaveBeenCalledOnce();
    expect(f.viewer.selectedTab).toBe("artifacts");
    expect(f.document.activeElement).toBe(f.tabs[3]);
    f.tabs[3]!.dispatch("keydown", "ArrowRight");
    expect(f.viewer.selectedTab).toBe("summary");
    f.tabs[0]!.dispatch("keydown", "End");
    expect(f.viewer.selectedTab).toBe("artifacts");
    f.tabs[3]!.dispatch("keydown", "Home");
    expect(f.viewer.selectedTab).toBe("summary");
    expect(
      f.tabs[0]!.dispatch("keydown", "Tab").preventDefault,
    ).not.toHaveBeenCalled();
    f.tabs[2]!.dispatch("click");
    expect(f.panels.filter((panel) => !panel.hidden)).toEqual([f.panels[2]]);
    expect(f.viewer.selectTab("unknown")).toBe(false);
    expect(f.viewer.selectedTab).toBe("output");
  });

  it("keeps the selected tab and scroll during refresh, restores tab scroll, and resets for a new run", () => {
    const f = fixture();
    f.viewer.open();
    f.viewer.selectTab("activity");
    f.body.scrollTop = 530;
    f.viewer.open();
    expect(f.viewer.selectedTab).toBe("activity");
    expect(f.body.scrollTop).toBe(530);
    expect(f.dialog.showModal).toHaveBeenCalledOnce();
    f.viewer.selectTab("output");
    expect(f.body.scrollTop).toBe(0);
    f.body.scrollTop = 230;
    f.viewer.selectTab("activity");
    expect(f.body.scrollTop).toBe(530);
    f.viewer.open({ reset: true });
    expect(f.viewer.selectedTab).toBe("summary");
    expect(f.body.scrollTop).toBe(0);
    f.viewer.selectTab("output");
    expect(f.body.scrollTop).toBe(0);
  });

  it("delegates Escape to the owner so polling and the route close together", () => {
    const f = fixture();
    f.viewer.open();
    expect(f.dialog.dispatch("cancel").preventDefault).toHaveBeenCalledOnce();
    expect(f.onClose).toHaveBeenCalledOnce();
    expect(f.viewer.isOpen).toBe(true);
    f.viewer.close();
    expect(f.dialog.close).toHaveBeenCalledOnce();
    expect(f.dialog.hidden).toBe(true);
    expect(f.document.activeElement).toBe(f.trigger);
    expect(f.trigger.focus).toHaveBeenLastCalledWith({ preventScroll: true });
  });

  it("does not steal focus when leaving the page or returning to a removed trigger", () => {
    const f = fixture();
    f.viewer.open();
    f.viewer.close({ restoreFocus: false });
    expect(f.trigger.focus).toHaveBeenCalledOnce();
    f.trigger.focus();
    f.viewer.open();
    f.trigger.isConnected = false;
    f.viewer.close();
    expect(f.trigger.focus).toHaveBeenCalledTimes(2);
  });

  it("dismisses on a backdrop click, without dismissing inside clicks or a drag from the dialog", () => {
    const f = fixture();
    f.viewer.open();
    const inside = { target: f.dialog, clientX: 200, clientY: 100 };
    const outside = { target: f.dialog, clientX: 20, clientY: 20 };
    f.dialog.dispatch("pointerdown", inside);
    f.dialog.dispatch("click", inside);
    expect(f.onClose).not.toHaveBeenCalled();
    f.dialog.dispatch("pointerdown", inside);
    f.dialog.dispatch("click", outside);
    expect(f.onClose).not.toHaveBeenCalled();
    f.dialog.dispatch("pointerdown", outside);
    f.dialog.dispatch("click", outside);
    expect(f.onClose).toHaveBeenCalledOnce();
  });
});
