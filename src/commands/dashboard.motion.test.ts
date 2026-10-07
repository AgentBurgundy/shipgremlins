import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

type Handler = (event: Record<string, unknown>) => void;
type MotionOptions = {
  key?: string;
  kind?: string;
  delay?: number;
  value?: string;
};
interface MotionApi {
  enter(node: object, options?: MotionOptions): boolean;
  reveal(node: object, options?: MotionOptions): boolean;
  transition(node: object, options?: MotionOptions): boolean;
  hide(node: object): void;
  destroy(): void;
  reducedMotion: boolean;
}

function fixture(reduced = false) {
  class Events {
    listeners = new Map<string, Set<Handler>>();
    addEventListener(name: string, handler: Handler) {
      if (!this.listeners.has(name)) this.listeners.set(name, new Set());
      this.listeners.get(name)!.add(handler);
    }
    removeEventListener(name: string, handler: Handler) {
      this.listeners.get(name)?.delete(handler);
    }
    emit(name: string, value: Record<string, unknown> = {}) {
      for (const handler of this.listeners.get(name) || []) handler(value);
    }
  }
  class Element {
    isConnected = true;
    hidden = false;
    inert = false;
    ariaHidden = false;
    open = false;
    role = "";
    page = "";
    parent: Element | null = null;
    children: Element[] = [];
    computed = { visibility: "visible", opacity: "1", transform: "none" };
    value = "unsaved private draft";
    properties = new Map<string, { value: string; priority: string }>();
    style = {
      getPropertyValue: (name: string) =>
        this.properties.get(name)?.value || "",
      getPropertyPriority: (name: string) =>
        this.properties.get(name)?.priority || "",
      setProperty: (name: string, value: string, priority = "") => {
        this.properties.set(name, { value, priority });
      },
      removeProperty: (name: string) => this.properties.delete(name),
    };
    animate: ((...args: unknown[]) => unknown) | undefined = () => undefined;
    constructor(public tagName = "DIV") {}
    append(node: Element) {
      node.parent = this;
      this.children.push(node);
      return node;
    }
    closest(): Element | null {
      if (this.hidden || this.inert || this.ariaHidden) return this;
      return this.parent?.closest() || null;
    }
    getClientRects() {
      return this.closest() || (this.tagName === "DIALOG" && !this.open)
        ? []
        : [{}];
    }
    matches(selector: string) {
      if (selector.includes("contenteditable"))
        return ["INPUT", "TEXTAREA", "SELECT"].includes(this.tagName);
      return this.tagName === "DIALOG" || this.role === "dialog";
    }
    contains(node: Element): boolean {
      return (
        this === node || this.children.some((child) => child.contains(node))
      );
    }
    querySelectorAll(selector: string): Element[] {
      return this.children.flatMap((child) => [
        ...(child.matches(selector) ? [child] : []),
        ...child.querySelectorAll(selector),
      ]);
    }
  }
  const body = new Element("BODY");
  const panels: Element[] = [];
  const document = Object.assign(new Events(), {
    body,
    activeElement: null as Element | null,
    visibilityState: "visible",
    querySelectorAll: () => panels,
  });
  const preference = Object.assign(new Events(), { matches: reduced });
  const scheduled = new Map<number, () => void>();
  let sequence = 0;
  let observerCallback: (records: { target: Element }[]) => void = () =>
    undefined;
  let observed: object | null = null;
  let disconnected = false;
  class Observer {
    constructor(callback: typeof observerCallback) {
      observerCallback = callback;
    }
    observe(_root: object, options: object) {
      observed = options;
    }
    disconnect() {
      disconnected = true;
    }
  }
  const window = Object.assign(new Events(), {
    location: { href: "http://127.0.0.1/projects/app?tab=crew" },
    matchMedia: () => preference,
    getComputedStyle: (node: Element) => node.computed,
    requestAnimationFrame: (callback: () => void) => {
      scheduled.set(++sequence, callback);
      return sequence;
    },
    cancelAnimationFrame: (id: number) => scheduled.delete(id),
    MutationObserver: Observer,
    dashboardMotion: undefined as MotionApi | undefined,
  });
  const calls: {
    node: Element;
    keyframes: Record<string, (string | number)[]>;
    options: { duration: number; delay: number };
    canceled: boolean;
    finish: () => void;
  }[] = [];
  let shouldThrow = false;
  const animate = (
    node: Element,
    keyframes: Record<string, (string | number)[]>,
    options: { duration: number; delay: number },
  ) => {
    if (shouldThrow) throw new Error("WAAPI unavailable");
    let resolve: () => void = () => undefined;
    const finished = new Promise<void>((done) => {
      resolve = () => done();
    });
    const call = {
      node,
      keyframes,
      options,
      canceled: false,
      finish() {
        for (const [key, values] of Object.entries(keyframes))
          node.style.setProperty(key, String(values.at(-1)));
        resolve();
      },
    };
    calls.push(call);
    return { finished, cancel: () => (call.canceled = true) };
  };
  const source = readFileSync("dashboard-src/motion-controller.mjs", "utf8");
  const create = runInNewContext(
    `${source.replace("export function createDashboardMotion", "function createDashboardMotion")}\ncreateDashboardMotion;`,
    { URL, Promise },
  ) as (environment: object) => MotionApi;
  const motion = create({ window, document, animate });
  window.dashboardMotion = motion;
  return {
    motion,
    window,
    document,
    preference,
    calls,
    element: (tag = "DIV") => body.append(new Element(tag)),
    panel: () => {
      const node = body.append(new Element());
      panels.push(node);
      return node;
    },
    flush: () => {
      for (const [id, callback] of scheduled) {
        scheduled.delete(id);
        callback();
      }
    },
    mutation: (...targets: Element[]) =>
      observerCallback(targets.map((target) => ({ target }))),
    get observed() {
      return observed;
    },
    get disconnected() {
      return disconnected;
    },
    failAnimations: () => (shouldThrow = true),
    installBundle: () => {
      document.activeElement = null;
      runInNewContext(readFileSync("dashboard/motion.js", "utf8"), {
        window,
        document,
        EventTarget: Element,
        URL,
        Promise,
        performance,
        requestAnimationFrame: window.requestAnimationFrame,
      });
      return window.dashboardMotion!;
    },
  };
}

describe("dashboard Motion lifecycle", () => {
  it("does not replay card entrances when polling replaces the DOM", () => {
    const f = fixture();
    expect(f.motion.enter(f.element(), { key: "project:app" })).toBe(true);
    expect(f.motion.enter(f.element(), { key: "project:app" })).toBe(false);
    expect(f.motion.enter(f.element(), { key: "project:other" })).toBe(true);
    expect(f.calls).toHaveLength(2);
  });

  it("animates real state changes once, without making an idle status look busy", () => {
    const f = fixture();
    const status = f.element();
    expect(f.motion.transition(status, { key: "run:1", value: "queued" })).toBe(
      false,
    );
    expect(
      f.motion.transition(status, { key: "run:1", value: "running" }),
    ).toBe(true);
    expect(
      f.motion.transition(f.element(), { key: "run:1", value: "running" }),
    ).toBe(false);
    expect(f.calls[0]!.options.duration).toBe(0.14);
    expect(f.calls[0]!.keyframes.transform).toBeUndefined();
  });

  it("keeps large polled lists static after the entrance-key cap", () => {
    const f = fixture();
    for (let pass = 0; pass < 2; pass++)
      for (let index = 0; index < 550; index++)
        f.motion.enter(f.element(), { key: `project:${index}` });
    expect(f.calls).toHaveLength(500);
  });

  it("honors reduced motion on load and does not replay skipped cards later", () => {
    const f = fixture(true);
    expect(f.motion.reducedMotion).toBe(true);
    expect(f.motion.enter(f.element(), { key: "project:app" })).toBe(false);
    f.preference.matches = false;
    f.preference.emit("change");
    expect(f.motion.enter(f.element(), { key: "project:app" })).toBe(false);
    expect(f.calls).toHaveLength(0);
  });

  it("cancels active motion immediately when the system preference changes", () => {
    const f = fixture();
    const node = f.element();
    f.motion.enter(node);
    f.preference.matches = true;
    f.preference.emit("change");
    expect(f.calls[0]!.canceled).toBe(true);
    expect(node.properties.size).toBe(0);
    expect(f.motion.enter(f.element())).toBe(false);
  });

  it("never reveals hidden, inert, detached or visually hidden content", () => {
    const f = fixture();
    const parent = f.element();
    const child = parent.append(f.element());
    parent.hidden = true;
    expect(f.motion.enter(child)).toBe(false);
    parent.hidden = false;
    parent.inert = true;
    expect(f.motion.enter(child)).toBe(false);
    parent.inert = false;
    child.computed.visibility = "hidden";
    expect(f.motion.enter(child)).toBe(false);
    child.computed.visibility = "visible";
    child.isConnected = false;
    expect(f.motion.enter(child)).toBe(false);
    const transparent = f.element();
    transparent.computed.opacity = "0";
    expect(f.motion.enter(transparent)).toBe(false);
    const dialog = f.element("DIALOG");
    expect(f.motion.reveal(dialog)).toBe(false);
    expect(f.calls).toHaveLength(0);
    expect(parent.inert).toBe(false);
    expect(dialog.open).toBe(false);
  });

  it("does not animate a form while its draft is being edited", () => {
    const f = fixture();
    const card = f.element();
    const input = card.append(f.element("INPUT"));
    f.document.activeElement = input;
    expect(f.motion.enter(card, { key: "form" })).toBe(false);
    expect(input.value).toBe("unsaved private draft");
    expect(f.document.activeElement).toBe(input);
    expect(f.calls).toHaveLength(0);
  });

  it("allows one dialog entrance even when its search input takes initial focus", () => {
    const f = fixture();
    const dialog = f.element("DIALOG");
    dialog.open = true;
    const input = dialog.append(f.element("INPUT"));
    f.document.activeElement = input;
    f.mutation(dialog);
    f.mutation(dialog);
    expect(f.calls).toHaveLength(1);
    expect(f.document.activeElement).toBe(input);
    expect(input.value).toBe("unsaved private draft");
  });

  it("ships the actual Motion engine and releases its native animations cleanly", async () => {
    const f = fixture();
    const card = f.element();
    const native: {
      frames: unknown;
      timing: unknown;
      onfinish: (() => void) | null;
      currentTime: number;
      playbackRate: number;
      playState: string;
      canceled: boolean;
      cancel: () => void;
    }[] = [];
    card.animate = (frames, timing) => {
      const control = {
        frames,
        timing,
        onfinish: null as (() => void) | null,
        currentTime: 180,
        playbackRate: 1,
        playState: "running",
        canceled: false,
        cancel() {
          this.canceled = true;
          this.playState = "idle";
        },
      };
      native.push(control);
      return control;
    };
    for (const name of ["opacity", "transform"])
      Object.defineProperty(card.style, name, {
        get: () => card.style.getPropertyValue(name),
        set: (value: string | number) =>
          card.style.setProperty(name, String(value)),
      });
    const bundled = f.installBundle();
    expect(bundled.enter(card)).toBe(true);
    expect(native).toHaveLength(2);
    expect(native[0]!.frames).toEqual({ opacity: [0.65, 1] });
    expect(native[0]!.timing).toMatchObject({ duration: 180, iterations: 1 });
    for (const animation of native) animation.onfinish?.();
    for (let index = 0; index < 6; index++) await Promise.resolve();
    expect(native.every((animation) => animation.canceled)).toBe(true);
    expect(card.style.getPropertyValue("opacity")).toBe("");
    expect(card.style.getPropertyValue("transform")).toBe("");
    bundled.destroy();
  });

  it("cleans up on navigation but keeps the background steady for a run dialog", () => {
    const f = fixture();
    const page = f.panel();
    f.window.emit("dashboard:pagechange", {
      detail: { path: "/projects/app?tab=crew" },
    });
    f.flush();
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.node).toBe(page);
    expect(f.calls[0]!.keyframes.transform).toBeUndefined();
    f.window.emit("dashboard:pagechange", {
      detail: { path: "/projects/app?tab=crew&run=1" },
    });
    f.flush();
    expect(f.calls).toHaveLength(1);
    f.window.emit("dashboard:pagechange", {
      detail: { path: "/projects/other?tab=crew" },
    });
    expect(f.calls[0]!.canceled).toBe(true);
    f.flush();
    expect(f.calls).toHaveLength(2);
  });

  it("animates each actual dialog opening once and does not observe polled children", () => {
    const f = fixture();
    const dialog = f.element("DIALOG");
    expect(f.observed).toEqual({
      subtree: true,
      attributes: true,
      attributeFilter: ["open", "hidden", "aria-hidden", "inert"],
    });
    f.mutation(dialog);
    expect(f.calls).toHaveLength(0);
    dialog.open = true;
    f.mutation(dialog, dialog);
    expect(f.calls).toHaveLength(1);
    f.mutation(dialog);
    expect(f.calls).toHaveLength(1);
    dialog.open = false;
    f.mutation(dialog);
    expect(f.calls[0]!.canceled).toBe(true);
    dialog.open = true;
    f.mutation(dialog);
    expect(f.calls).toHaveLength(2);
  });

  it("restores original inline styles after completion, including priority", async () => {
    const f = fixture();
    const card = f.element();
    card.style.setProperty("transform", "scale(0.9)", "important");
    card.computed.transform = "matrix(0.9, 0, 0, 0.9, 0, 0)";
    f.motion.enter(card);
    f.calls[0]!.finish();
    await Promise.resolve();
    expect(card.style.getPropertyValue("opacity")).toBe("");
    expect(card.style.getPropertyValue("transform")).toBe("scale(0.9)");
    expect(card.style.getPropertyPriority("transform")).toBe("important");
  });

  it("does not overwrite styles changed by application rendering", async () => {
    const f = fixture();
    const card = f.element();
    f.motion.enter(card);
    f.calls[0]!.finish();
    card.style.setProperty("opacity", "0.5");
    await Promise.resolve();
    expect(card.style.getPropertyValue("opacity")).toBe("0.5");
  });

  it("remains usable without browser animation support or after a Motion error", () => {
    const f = fixture();
    const card = f.element();
    card.animate = undefined;
    expect(f.motion.enter(card)).toBe(false);
    f.failAnimations();
    const another = f.element();
    expect(f.motion.enter(another)).toBe(false);
    expect(another.properties.size).toBe(0);
    expect(another.hidden).toBe(false);
  });

  it("drops scheduled frames and active animations when hidden or destroyed", () => {
    const f = fixture();
    f.motion.enter(f.element());
    f.document.visibilityState = "hidden";
    f.document.emit("visibilitychange");
    expect(f.calls[0]!.canceled).toBe(true);
    f.document.visibilityState = "visible";
    f.panel();
    f.window.emit("dashboard:pagechange", {
      detail: { path: "/projects/app" },
    });
    f.motion.destroy();
    f.flush();
    expect(f.disconnected).toBe(true);
    expect(f.window.dashboardMotion).toBeUndefined();
    expect(f.window.listeners.get("dashboard:pagechange")?.size).toBe(0);
    expect(f.preference.listeners.get("change")?.size).toBe(0);
    expect(f.calls).toHaveLength(1);
    expect(f.motion.enter(f.element())).toBe(false);
  });
});
