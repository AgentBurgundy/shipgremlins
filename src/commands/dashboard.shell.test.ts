import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

function fixture(path = "/connections", narrow = true) {
  type Handler = (event: Record<string, unknown>) => void;
  class Events {
    listeners = new Map<string, Set<Handler>>();
    addEventListener(name: string, handler: Handler) {
      if (!this.listeners.has(name)) this.listeners.set(name, new Set());
      this.listeners.get(name)!.add(handler);
    }
    removeEventListener(name: string, handler: Handler) {
      this.listeners.get(name)?.delete(handler);
    }
    emit(name: string, fields: Record<string, unknown> = {}) {
      const event = {
        button: 0,
        defaultPrevented: false,
        preventDefault() {
          this.defaultPrevented = true;
        },
        ...fields,
      };
      for (const fn of this.listeners.get(name) || []) fn(event);
      return event;
    }
  }
  class Element extends Events {
    hidden = false;
    disabled = false;
    inert = false;
    open = false;
    parentElement: Element | null = null;
    children: Element[] = [];
    attributes = new Map<string, string>();
    dataset: Record<string, string> = {};
    classes = new Set<string>();
    classList = {
      add: (name: string) => this.classes.add(name),
      remove: (name: string) => this.classes.delete(name),
    };
    value = "unsaved private draft";
    constructor(
      public id: string,
      public tagName = "DIV",
    ) {
      super();
    }
    append(child: Element) {
      this.children.push(child);
      child.parentElement = this;
      return child;
    }
    setAttribute(name: string, value: string) {
      this.attributes.set(name, value);
    }
    getAttribute(name: string) {
      return this.attributes.get(name);
    }
    removeAttribute(name: string) {
      this.attributes.delete(name);
    }
    hasAttribute(name: string) {
      return this.attributes.has(name);
    }
    focus() {
      document.activeElement = this;
    }
    contains(target: Element | null): boolean {
      return (
        target === this ||
        Boolean(target?.parentElement && this.contains(target.parentElement))
      );
    }
    closest(selector: string): Element | null {
      const matches =
        selector === "a[href]"
          ? this.tagName === "A" && this.hasAttribute("href")
          : selector === "[hidden], [inert]"
            ? this.hidden || this.inert
            : false;
      return matches ? this : this.parentElement?.closest(selector) || null;
    }
    getClientRects() {
      return this.closest("[hidden], [inert]") ? [] : [{}];
    }
    querySelectorAll(): Element[] {
      return this.children
        .flatMap((child) => [child, ...child.querySelectorAll()])
        .filter((child) => child.tagName === "A" || child.tagName === "BUTTON");
    }
    querySelector(selector: string) {
      const href = /a\[href="([^"]+)"\]/.exec(selector)?.[1];
      return this.children.find((child) => child.getAttribute("href") === href);
    }
  }
  const document = Object.assign(new Events(), {
    readyState: "complete",
    activeElement: null as Element | null,
    body: new Element("body"),
    getElementById: (id: string) => nodes.get(id) || null,
    querySelector: (selector: string) =>
      selector === ".connection-categories" ? categories : null,
  });
  const nodes = new Map<string, Element>();
  const node = (id: string, tag = "DIV") => {
    const element = new Element(id, tag);
    nodes.set(id, element);
    return element;
  };
  const toggle = node("nav-toggle", "BUTTON");
  const nav = node("workspace-navigation", "ASIDE");
  const backdrop = node("nav-backdrop", "BUTTON");
  const navLinks = ["overview", "connections"].map((page) => {
    const link = nav.append(node(`nav-${page}`, "A"));
    link.setAttribute("href", `/${page}`);
    return link;
  });
  const connections = node("connections");
  const categories = node("categories", "NAV");
  const ids = [
    "crew-connections",
    "source-control",
    "hosting-connections",
    "signals-connections",
    "project-access",
  ];
  const groups = ids.map((id) => connections.append(node(id)));
  const tabs = ids.map((id) => {
    const tab = categories.append(node(`tab-${id}`, "A"));
    tab.setAttribute("href", `#${id}`);
    return tab;
  });
  const provider = groups[2]!.append(node("vercel-connection"));
  const details = provider.append(node("vercel-advanced", "DETAILS"));
  const input = details.append(node("vercel-token", "INPUT"));
  const projectDrawer = node("new-project-drawer", "DETAILS");
  const media = Object.assign(new Events(), { matches: narrow });
  const paths: string[] = [];
  const window = Object.assign(new Events(), {
    location: new URL(path, "http://localhost:4311"),
    matchMedia: () => media,
    dashboardShell: null as unknown as {
      category: string;
      closeNavigation(): void;
      releaseConnections(): void;
      destroy(): void;
    },
    dashboardPages: {
      navigate(destination: string) {
        paths.push(destination);
        window.location = new URL(destination, window.location);
        window.emit("dashboard:pagechange", {
          detail: { page: "connections", path: destination },
        });
      },
    },
  });
  runInNewContext(
    readFileSync(new URL("../../dashboard/shell.js", import.meta.url), "utf8"),
    { document, window, URL },
  );
  return {
    window,
    document,
    media,
    toggle,
    nav,
    backdrop,
    navLinks,
    connections,
    tabs,
    groups,
    provider,
    details,
    input,
    projectDrawer,
    paths,
  };
}

describe("compact dashboard shell", () => {
  it("contains mobile Tab focus, supports Escape, and restores regular desktop navigation", () => {
    const view = fixture();
    expect(view.nav.inert).toBe(true);
    expect(view.backdrop.hidden).toBe(true);
    view.toggle.emit("click");
    expect(view.document.body.dataset.navigationOpen).toBe("true");
    expect(view.toggle.getAttribute("aria-expanded")).toBe("true");
    expect(view.document.activeElement).toBe(view.navLinks[0]);
    view.document.emit("keydown", { key: "Tab", shiftKey: true });
    expect(view.document.activeElement).toBe(view.toggle);
    view.document.emit("keydown", { key: "Tab", shiftKey: true });
    expect(view.document.activeElement).toBe(view.navLinks[1]);
    view.document.emit("keydown", { key: "Escape" });
    expect(view.document.activeElement).toBe(view.toggle);
    expect(view.nav.inert).toBe(true);
    view.media.matches = false;
    view.media.emit("change");
    expect(view.nav.inert).toBe(false);
    expect(view.nav.hasAttribute("aria-hidden")).toBe(false);
    expect(view.toggle.hidden).toBe(true);
  });
  it("closes the drawer for backdrop, outside click, selected links, and page changes", () => {
    const view = fixture();
    for (const close of [
      () => view.backdrop.emit("click"),
      () => view.document.emit("click", { target: view.input }),
      () => view.document.emit("click", { target: view.navLinks[0] }),
      () =>
        view.window.emit("dashboard:pagechange", {
          detail: { page: "activity" },
        }),
    ]) {
      view.toggle.emit("click");
      close();
      expect(view.toggle.getAttribute("aria-expanded")).toBe("false");
      expect(view.backdrop.hidden).toBe(true);
    }
  });
  it("enhances categories into keyboard-operated tabs while preserving form drafts", () => {
    const view = fixture();
    expect(view.connections.classes.has("connections-tabs-ready")).toBe(true);
    expect(
      view.groups.filter((group) => !group.hidden).map((group) => group.id),
    ).toEqual(["crew-connections"]);
    expect(view.tabs[0]!.getAttribute("role")).toBe("tab");
    expect(view.groups[0]!.getAttribute("role")).toBe("tabpanel");
    view.tabs[0]!.emit("keydown", { key: "End" });
    expect(view.window.dashboardShell.category).toBe("project-access");
    expect(view.document.activeElement).toBe(view.tabs[4]);
    view.tabs[4]!.emit("keydown", { key: "Home" });
    view.tabs[0]!.emit("keydown", { key: "ArrowRight" });
    expect(view.paths.at(-1)).toBe("/connections#source-control");
    expect(view.tabs[1]!.getAttribute("aria-selected")).toBe("true");
    expect(view.tabs[0]!.getAttribute("tabindex")).toBe("-1");
    expect(view.input.value).toBe("unsaved private draft");
  });
  it("reveals provider deep links and disclosure ancestors, preserving the last category on revisit", () => {
    const view = fixture("/connections#vercel-token");
    expect(view.window.dashboardShell.category).toBe("hosting-connections");
    expect(view.details.open).toBe(true);
    view.window.location = new URL("http://localhost:4311/projects");
    view.window.emit("dashboard:pagechange", { detail: { page: "projects" } });
    view.window.location = new URL("http://localhost:4311/connections");
    view.window.emit("dashboard:pagechange", {
      detail: { page: "connections" },
    });
    expect(view.window.dashboardShell.category).toBe("hosting-connections");
    view.window.location = new URL(
      "http://localhost:4311/projects#new-project-drawer",
    );
    view.window.emit("dashboard:pagechange", { detail: { page: "projects" } });
    expect(view.projectDrawer.open).toBe(true);
  });
  it("releases category visibility and ARIA ownership when provider dialogs adopt the panels", () => {
    const view = fixture("/connections#source-control");
    view.window.dashboardShell.releaseConnections();
    expect(view.connections.classes.has("connections-tabs-ready")).toBe(false);
    for (const group of view.groups) {
      expect(group.getAttribute("role")).toBeUndefined();
      expect(group.getAttribute("aria-labelledby")).toBeUndefined();
      expect(group.getAttribute("tabindex")).toBeUndefined();
      group.hidden = group.id !== "project-access";
    }
    view.window.location = new URL(
      "http://localhost:4311/connections#source-control",
    );
    view.window.emit("dashboard:pagechange", {
      detail: { page: "connections" },
    });
    view.tabs[0]!.emit("keydown", { key: "End" });
    view.tabs[0]!.emit("click");
    expect(view.paths).toEqual([]);
    expect(
      view.groups.filter((group) => !group.hidden).map((group) => group.id),
    ).toEqual(["project-access"]);
    expect(view.input.value).toBe("unsaved private draft");
    view.window.dashboardShell.releaseConnections();
    view.window.dashboardShell.destroy();
  });
});
