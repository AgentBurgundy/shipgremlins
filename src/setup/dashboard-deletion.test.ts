import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

type Handler = (event: { preventDefault(): void }) => unknown;
class Element {
  children: Element[] = [];
  listeners = new Map<string, Handler>();
  textContent = "";
  className = "";
  id = "";
  value = "";
  hidden = false;
  disabled = false;
  open = false;
  isConnected = true;
  classList = { toggle() {} };
  constructor(public tagName: string) {}
  append(...items: Element[]) {
    this.children.push(...items);
  }
  replaceChildren(...items: Element[]) {
    this.children = items;
  }
  setAttribute() {}
  addEventListener(type: string, fn: Handler) {
    this.listeners.set(type, fn);
  }
  async fire(type: string) {
    await this.listeners.get(type)?.({ preventDefault() {} });
  }
  focus() {}
  showModal() {
    this.open = true;
  }
  close() {
    this.open = false;
  }
}
const all = (root: Element): Element[] => [root, ...root.children.flatMap(all)];
const text = (root: Element) =>
  all(root)
    .map((item) => item.textContent)
    .join(" ");
const button = (root: Element, label: string) =>
  all(root).find(
    (item) => item.tagName === "button" && item.textContent === label,
  )!;
const preview = (project = "shop", area?: string) => ({
  kind: area ? "pm" : "project",
  project,
  ...(area ? { area } : {}),
  name: area ? "Checkout PM" : "Shop",
  revision: "revision-one",
  confirmation: area ? `${project}/${area}` : project,
  blockers: [] as string[],
  effects: ["Local configuration is removed."],
  retained: ["Source repository and run history stay."],
});
const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};
function fixture(
  api: (path: string, body?: unknown, method?: string) => Promise<unknown>,
  onDeleted = vi.fn(async () => {}),
  onRestored = vi.fn(async () => {}),
) {
  const body = new Element("body"),
    window = {} as {
      createWorkspaceDeletion(options: unknown): {
        open(value: unknown): void;
        isBusy(): boolean;
      };
    };
  runInNewContext(
    readFileSync(
      new URL("../../dashboard/deletion.js", import.meta.url),
      "utf8",
    ),
    {
      window,
      document: { body, createElement: (tag: string) => new Element(tag) },
      AbortController,
    },
  );
  const control = window.createWorkspaceDeletion({
    api,
    onDeleted,
    onRestored,
    isLocked: () => false,
  });
  return {
    control,
    body,
    onDeleted,
    onRestored,
    dialog: () => body.children[0]!,
    input: () => all(body).find((item) => item.id === "deletion-confirmation")!,
  };
}
describe("local configuration deletion UI", () => {
  it("restores only the reviewed recovery with its exact confirmation and preserves the backup", async () => {
    const requests: unknown[] = [];
    const f = fixture(async (path, body, method) => {
      requests.push({ path, body, method });
      return method === "POST"
        ? {
            restored: true,
            project: "shop",
            area: "checkout",
            recoveryId: "backup-one",
          }
        : { ...preview("shop", "checkout"), id: "backup-one" };
    });
    f.control.open({
      project: "shop",
      area: "checkout",
      recoveryId: "backup-one",
    });
    await flush();
    expect(requests).toHaveLength(1);
    f.input().value = "shop/checkout";
    await f.input().fire("input");
    await button(f.body, "Restore PM").fire("click");
    expect(requests[1]).toEqual({
      path: "/api/deleted/backup-one/restore",
      body: { revision: "revision-one", confirm: "shop/checkout" },
      method: "POST",
    });
    expect(f.onDeleted).not.toHaveBeenCalled();
    expect(f.onRestored).toHaveBeenCalledWith(
      expect.objectContaining({
        recoveryId: "backup-one",
        project: "shop",
        area: "checkout",
      }),
    );
    expect(text(f.body)).toContain("PMs are paused");
    expect(text(f.body)).toContain("original backup and run history are kept");
  });
  it("requires the complete server-provided PM ID and sends only the reviewed revision", async () => {
    const writes: unknown[] = [];
    const f = fixture(async (path, body, method) => {
      if (method === "DELETE") {
        writes.push({ path, body });
        return { deleted: true, recoveryId: "backup-one" };
      }
      return preview("shop", "checkout");
    });
    f.control.open({ project: "shop", area: "checkout" });
    await flush();
    expect(writes).toEqual([]);
    f.input().value = "checkout";
    await f.input().fire("input");
    await button(f.body, "Delete PM").fire("click");
    expect(writes).toEqual([]);
    f.input().value = "shop/checkout";
    await f.input().fire("input");
    await button(f.body, "Delete PM").fire("click");
    expect(writes).toEqual([
      {
        path: "/api/projects/shop/pms/checkout",
        body: { revision: "revision-one", confirm: "shop/checkout" },
      },
    ]);
    expect(f.onDeleted).toHaveBeenCalledWith(
      expect.objectContaining({
        project: "shop",
        area: "checkout",
        recoveryId: "backup-one",
      }),
    );
    expect(text(f.body)).toContain("run history have not been deleted");
  });
  it("does not delete blocked active work even with correct typed confirmation", async () => {
    const api = vi.fn(async () => ({
      ...preview(),
      blockers: ["One run is active. Cancel it or wait for completion."],
    }));
    const f = fixture(api);
    f.control.open({ project: "shop" });
    await flush();
    f.input().value = "shop";
    await f.input().fire("input");
    await button(f.body, "Delete project").fire("click");
    expect(api).toHaveBeenCalledTimes(1);
    expect(f.onDeleted).not.toHaveBeenCalled();
    expect(text(f.body)).toContain("Nothing has been deleted");
    expect(all(f.body).filter((item) => item.tagName === "a")).toHaveLength(2);
  });
  it("ignores a slow preview for an older project after switching targets", async () => {
    let resolve!: (value: unknown) => void;
    const f = fixture(async (path) =>
      path.includes("/alpha/")
        ? new Promise((done) => {
            resolve = done;
          })
        : preview("beta"),
    );
    f.control.open({ project: "alpha" });
    f.control.open({ project: "beta" });
    await flush();
    resolve(preview("alpha"));
    await flush();
    expect(text(f.body)).toContain("Type beta to confirm");
    expect(text(f.body)).not.toContain("Type alpha to confirm");
  });
  it("keeps failed/conflicting deletion visible and requires a new preview before retry", async () => {
    const f = fixture(async (_path, _body, method) => {
      if (method === "DELETE") throw new Error("Configuration changed.");
      return preview();
    });
    f.control.open({ project: "shop" });
    await flush();
    f.input().value = "shop";
    await button(f.body, "Delete project").fire("click");
    expect(f.onDeleted).not.toHaveBeenCalled();
    expect(text(f.body)).toContain("Configuration changed");
    expect(button(f.body, "Delete project").disabled).toBe(true);
    expect(f.input().value).toBe("");
    expect(f.dialog().open).toBe(true);
  });
  it("cannot dismiss or retarget a deletion while the server is processing it", async () => {
    let resolve!: (value: unknown) => void;
    const f = fixture(async (_path, _body, method) =>
      method === "DELETE"
        ? new Promise((done) => {
            resolve = done;
          })
        : preview(),
    );
    f.control.open({ project: "shop" });
    await flush();
    f.input().value = "shop";
    const pending = button(f.body, "Delete project").fire("click");
    await f.dialog().fire("cancel");
    f.control.open({ project: "other" });
    expect(f.dialog().open).toBe(true);
    expect(f.control.isBusy()).toBe(true);
    resolve({ deleted: true, recoveryId: "backup" });
    await pending;
    expect(f.onDeleted).toHaveBeenCalledWith(
      expect.objectContaining({ project: "shop" }),
    );
    expect(text(f.body)).toContain("Recovery backup: backup");
  });
  it("does not claim a rollback when deletion succeeded but the refresh failed", async () => {
    const onDeleted = vi.fn(async () => {
      throw new Error("Offline");
    });
    const f = fixture(
      async (_path, _body, method) =>
        method === "DELETE"
          ? { deleted: true, recoveryId: "backup" }
          : preview(),
      onDeleted,
    );
    f.control.open({ project: "shop" });
    await flush();
    f.input().value = "shop";
    await button(f.body, "Delete project").fire("click");
    expect(text(f.body)).toContain("Deleted successfully");
    expect(text(f.body)).toContain("Refresh the dashboard");
    expect(button(f.body, "Done")).toBeDefined();
  });
});
