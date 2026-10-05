import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

type Event = { preventDefault(): void };
class Element {
  children: Element[] = [];
  parent: Element | undefined;
  listeners = new Map<string, ((event: Event) => unknown)[]>();
  attributes = new Map<string, string>();
  classes = new Set<string>();
  classList = {
    toggle: (name: string, on: boolean) =>
      on ? this.classes.add(name) : this.classes.delete(name),
  };
  hidden = false;
  disabled = false;
  required = false;
  checked = false;
  readOnly = false;
  open = false;
  focused = false;
  id = "";
  value = "";
  type = "";
  className = "";
  content = "";
  constructor(public tag: string) {}
  get textContent(): string {
    return (
      this.content + this.children.map((child) => child.textContent).join(" ")
    );
  }
  set textContent(value: string) {
    this.content = value;
    this.children = [];
  }
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
  remove() {
    if (this.parent)
      this.parent.children = this.parent.children.filter(
        (child) => child !== this,
      );
  }
  all(): Element[] {
    return [this, ...this.children.flatMap((child) => child.all())];
  }
  querySelectorAll(tag: string) {
    return this.all().filter((node) => node !== this && node.tag === tag);
  }
  querySelector(tag: string) {
    return this.querySelectorAll(tag)[0];
  }
  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }
  addEventListener(name: string, callback: (event: Event) => unknown) {
    this.listeners.set(name, [...(this.listeners.get(name) || []), callback]);
  }
  async fire(name: string) {
    await Promise.all(
      (this.listeners.get(name) || []).map((callback) =>
        callback({ preventDefault() {} }),
      ),
    );
  }
  click() {
    return this.fire("click");
  }
  reportValidity() {
    return !this.required || Boolean(this.value.trim());
  }
  focus() {
    this.focused = true;
  }
  showModal() {
    this.open = true;
  }
  close() {
    this.open = false;
    void this.fire("close");
  }
}

function fixture() {
  const body = new Element("body"),
    root = new Element("section");
  body.append(root);
  const events = new Map<string, () => void>();
  const window = {
    location: new URL("http://192.168.1.3:4311/runners"),
    addEventListener: (event: string, callback: () => void) =>
      events.set(event, callback),
    createRemoteWorkers: undefined as unknown as (
      root: Element,
      options: {
        api: (...args: unknown[]) => Promise<unknown>;
        pages: { current: string };
        isLocked(): boolean;
      },
    ) => { setProjects(projects: { name: string }[]): void; isBusy(): boolean },
  };
  runInNewContext(
    readFileSync(
      new URL("../../dashboard/remote-workers.js", import.meta.url),
      "utf8",
    ),
    {
      window,
      document: {
        body,
        hidden: false,
        createElement: (tag: string) => new Element(tag),
        createTextNode: (text: string) => {
          const node = new Element("text");
          node.textContent = text;
          return node;
        },
        addEventListener() {},
      },
      URL,
      setTimeout: () => 1,
      clearTimeout() {},
    },
  );
  const api = vi.fn(
    async (path: unknown, _input?: unknown): Promise<unknown> =>
      path === "/api/remote/enrollments"
        ? { code: "disposable-enrollment-code" }
        : { workers: [] },
  );
  const isLocked = vi.fn(() => false);
  const pages = { current: "runners" };
  const instance = window.createRemoteWorkers(root, { api, pages, isLocked });
  instance.setProjects([{ name: "allowed-app" }, { name: "other-app" }]);
  const find = (text: string) =>
    body
      .all()
      .find((node) => node.tag === "button" && node.textContent === text)!;
  const input = (id: string) => body.all().find((node) => node.id === id)!;
  const dialog = body.all().find((node) => node.tag === "dialog")!;
  const form = dialog.all().find((node) => node.tag === "form")!;
  const panel = (name: string) =>
    dialog.all().find((node) => node.className === name)!;
  return {
    body,
    root,
    events,
    api,
    pages,
    isLocked,
    instance,
    find,
    input,
    dialog,
    form,
    panel,
  };
}

describe("guided remote runner enrollment", () => {
  it("opens a focused dialog, validates its address, and leaves project selection explicit", async () => {
    const f = fixture();
    await f.find("Connect a runner").click();
    expect(f.dialog.open).toBe(true);
    expect(f.dialog.attributes.get("aria-labelledby")).toBe(
      "remote-enrollment-title",
    );
    expect(f.panel("remote-enrollment-machine").hidden).toBe(false);
    expect(f.panel("remote-enrollment-projects").hidden).toBe(true);
    f.input("remote-worker-name").value = "Home runner";
    await f.find("Continue").click();
    expect(f.dialog.textContent).toContain(
      "Use HTTPS or explicitly allow your private LAN",
    );
    expect(f.panel("remote-enrollment-projects").hidden).toBe(true);
    f.input("remote-private-lan").checked = true;
    await f.find("Continue").click();
    expect(f.panel("remote-enrollment-machine").hidden).toBe(true);
    expect(f.panel("remote-enrollment-projects").hidden).toBe(false);
    expect(
      f
        .panel("remote-project-options")
        .querySelectorAll("input")
        .every((node) => !node.checked),
    ).toBe(true);
    expect(
      f.api.mock.calls.some(([path]) => path === "/api/remote/enrollments"),
    ).toBe(false);
    await f.form.fire("submit");
    expect(f.dialog.textContent).toContain(
      "Choose at least one allowed project",
    );
  });

  it("keeps edits between steps and enrolls only explicitly selected projects", async () => {
    const f = fixture();
    await f.find("Connect a runner").click();
    f.input("remote-worker-name").value = "Home runner";
    f.input("remote-private-lan").checked = true;
    await f.find("Continue").click();
    f.panel("remote-project-options").querySelectorAll("input")[0]!.checked =
      true;
    await f.find("Back").click();
    expect(f.input("remote-worker-name").value).toBe("Home runner");
    await f.find("Continue").click();
    await f.form.fire("submit");
    expect(f.api).toHaveBeenCalledWith("/api/remote/enrollments", {
      name: "Home runner",
      projects: ["allowed-app"],
    });
    expect(f.form.hidden).toBe(true);
    expect(f.dialog.textContent).toContain("STEP 3 OF 3");
    const command = f.dialog.all().find((node) => node.tag === "textarea")!;
    expect(command.value).toContain(
      "--enrollment-code disposable-enrollment-code --allow-insecure-lan",
    );
    expect(command.readOnly).toBe(true);
    await f.find("Done").click();
    expect(f.dialog.open).toBe(false);
    expect(f.dialog.all().some((node) => node.tag === "textarea")).toBe(false);
    expect(f.find("Connect a runner").focused).toBe(true);
  });

  it("discards late enrollment responses when the dialog closes mid-request", async () => {
    const f = fixture();
    let finish!: (value: unknown) => void;
    f.api.mockImplementation(async (path) =>
      path === "/api/remote/enrollments"
        ? new Promise((resolve) => {
            finish = resolve;
          })
        : { workers: [] },
    );
    await f.find("Connect a runner").click();
    f.input("remote-worker-name").value = "Home runner";
    f.input("remote-private-lan").checked = true;
    await f.find("Continue").click();
    f.panel("remote-project-options").querySelectorAll("input")[0]!.checked =
      true;
    const pending = f.form.fire("submit");
    expect(f.instance.isBusy()).toBe(true);
    await f.find("Close ×").click();
    finish({ code: "late-private-code" });
    await pending;
    expect(f.instance.isBusy()).toBe(false);
    expect(f.dialog.open).toBe(false);
    expect(f.dialog.all().some((node) => node.tag === "textarea")).toBe(false);
  });

  it("closes enrollment on Escape and navigation without losing the machine draft", async () => {
    const f = fixture();
    await f.find("Connect a runner").click();
    f.input("remote-worker-name").value = "Kept draft";
    await f.dialog.fire("cancel");
    expect(f.dialog.open).toBe(false);
    await f.find("Connect a runner").click();
    expect(f.input("remote-worker-name").value).toBe("Kept draft");
    f.pages.current = "overview";
    f.events.get("dashboard:pagechange")!();
    expect(f.dialog.open).toBe(false);
  });

  it("rejects public plaintext addresses even when the private LAN option is selected", async () => {
    const f = fixture();
    await f.find("Connect a runner").click();
    f.input("remote-worker-name").value = "Cloud runner";
    f.input("remote-controller-url").value = "http://example.com";
    f.input("remote-private-lan").checked = true;
    await f.find("Continue").click();
    expect(f.panel("remote-enrollment-projects").hidden).toBe(true);
    expect(f.dialog.textContent).toContain("Use HTTPS for a public host");
    expect(
      f.api.mock.calls.some(([path]) => path === "/api/remote/enrollments"),
    ).toBe(false);
  });
});
