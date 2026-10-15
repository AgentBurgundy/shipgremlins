import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

class Element {
  children: Element[] = [];
  listeners = new Map<string, (event: { preventDefault(): void }) => unknown>();
  attributes = new Map<string, string>();
  className = "";
  textContent = "";
  value = "";
  id = "";
  disabled = false;
  hidden = false;
  constructor(public tagName: string) {}
  classList = { toggle: () => {} };
  append(...children: Element[]) {
    for (const child of children)
      if (!this.children.includes(child)) this.children.push(child);
  }
  replaceChildren(...children: Element[]) {
    this.children = children;
  }
  setAttribute(key: string, value: string) {
    this.attributes.set(key, value);
  }
  addEventListener(
    key: string,
    handler: (event: { preventDefault(): void }) => unknown,
  ) {
    this.listeners.set(key, handler);
  }
  fire(key: string) {
    return this.listeners.get(key)?.({ preventDefault() {} });
  }
  contains(value: Element): boolean {
    return all(this).includes(value);
  }
}
const all = (root: Element): Element[] => [root, ...root.children.flatMap(all)];
const text = (root: Element) =>
  all(root)
    .map((item) => item.textContent)
    .join(" ");
type Api = (path: string, body?: object, method?: string) => Promise<object>;
const view = (overrides = {}) => ({
  revision: "revision-one",
  overrides,
  effective: {
    setup: { provider: "codex", source: "project-default", configured: false },
    pm: { provider: "claude", source: "project-role", configured: true },
    coder: { provider: "codex", source: "project-default", configured: false },
  },
  providers: [
    { id: "claude", label: "Claude Code", configured: true },
    { id: "codex", label: "Codex", configured: false },
  ],
});
const settle = async () => {
  for (let index = 0; index < 10; index++) await Promise.resolve();
};
function fixture(api: Api = async () => view(), nativeSelectValues = false) {
  let locked = false;
  const document = {
    activeElement: null as Element | null,
    createElement: (tag: string) => {
      const element = new Element(tag.toUpperCase());
      if (nativeSelectValues && tag === "select") {
        let selected = "";
        Object.defineProperty(element, "value", {
          get: () => selected,
          set: (value: string) => {
            selected = element.children.some((option) => option.value === value)
              ? value
              : "";
          },
        });
      }
      return element;
    },
  };
  const window = {} as {
    createAiRouting(options: object): {
      mount(root: Element, project: object, area?: object): void;
      isDirty(): boolean;
      isBusy(): boolean;
      protectFocus(root: Element): boolean;
      forget(project: string, area?: string): void;
    };
  };
  runInNewContext(
    readFileSync(
      new URL("../../dashboard/ai-models.js", import.meta.url),
      "utf8",
    ) +
      "\n" +
      readFileSync(
        new URL("../../dashboard/ai-routing.js", import.meta.url),
        "utf8",
      ),
    { window, document },
  );
  const root = new Element("SECTION"),
    onSaved = vi.fn(async () => {}),
    control = window.createAiRouting({
      api: (...args: Parameters<Api>) =>
        args[0].startsWith("/api/ai/models?")
          ? Promise.resolve({
              provider: args[0].endsWith("codex") ? "codex" : "claude",
              source: "provider",
              models: [
                { id: "gpt-5.4", label: "Fixture Codex model" },
                { id: "sonnet", label: "Fixture Claude model" },
              ],
            })
          : api(...args),
      isLocked: () => locked,
      onSaved,
    });
  const project = { name: "shop", instanceId: "shop-one" },
    area = { key: "checkout", instanceId: "pm-one" };
  const mount = (pm = false) =>
    control.mount(root, project, pm ? area : undefined);
  const byId = (id: string) => all(root).find((item) => item.id === id)!;
  const byText = (value: string) =>
    all(root).find((item) => item.textContent === value)!;
  const submit = () =>
    all(root)
      .find((item) => item.tagName === "FORM")!
      .fire("submit");
  return {
    root,
    control,
    mount,
    byId,
    byText,
    submit,
    onSaved,
    project,
    area,
    setLocked(value: boolean) {
      locked = value;
      mount();
    },
  };
}
describe("project and PM AI routing controls", () => {
  it("shows actual supported providers, effective choices, connection needs and inheritance", async () => {
    const f = fixture();
    f.mount();
    await settle();
    expect(text(f.root)).toContain("AI for this project");
    expect(text(f.root)).toContain("PM work");
    expect(text(f.root)).toContain("Coding work");
    expect(text(f.root)).toContain("Codex · Not connected");
    expect(text(f.root)).toContain("Project default · Connection needed");
    expect(f.byId("ai-routing-shop-project-coder-model").disabled).toBe(true);
    expect(f.byText("Save AI choices").disabled).toBe(true);
  });
  it("saves project routing independently with exact revision, explicit override and inherited null", async () => {
    const api = vi.fn<Api>(async (_path, body) =>
      view(
        body
          ? {
              default: { provider: "codex" },
              pm: { provider: "claude", model: "sonnet" },
            }
          : {},
      ),
    );
    const f = fixture(api);
    f.mount();
    await settle();
    const defaultChoice = f.byId("ai-routing-shop-project-default"),
      pm = f.byId("ai-routing-shop-project-pm"),
      model = f.byId("ai-routing-shop-project-pm-model");
    defaultChoice.value = "codex";
    defaultChoice.fire("change");
    pm.value = "claude";
    pm.fire("change");
    model.value = "sonnet";
    await settle();
    model.fire("change");
    expect(f.control.isDirty()).toBe(true);
    await f.submit();
    expect(api).toHaveBeenCalledWith(
      "/api/projects/shop/ai",
      {
        revision: "revision-one",
        default: { provider: "codex" },
        pm: { provider: "claude", model: "sonnet" },
        coder: null,
      },
      "PUT",
    );
    expect(f.control.isDirty()).toBe(false);
    expect(f.onSaved).toHaveBeenCalledOnce();
  });
  it("keeps PM scope to investigations only and clears its override with inherit", async () => {
    const api = vi.fn<Api>(async () =>
      view({ pm: { provider: "codex", model: "gpt-5.4" } }),
    );
    const f = fixture(api);
    f.mount(true);
    await settle();
    expect(text(f.root)).toContain("This PM");
    expect(text(f.root)).not.toContain("Coding for this PM");
    expect(
      all(f.root).some((item) => item.id === "ai-routing-shop-checkout-coder"),
    ).toBe(false);
    expect(
      all(f.root).some(
        (item) => item.id === "ai-routing-shop-checkout-default",
      ),
    ).toBe(false);
    const pm = f.byId("ai-routing-shop-checkout-pm"),
      model = f.byId("ai-routing-shop-checkout-pm-model");
    pm.value = "";
    pm.fire("change");
    expect(model.value).toBe("");
    await f.submit();
    expect(api).toHaveBeenCalledWith(
      "/api/projects/shop/pms/checkout/ai",
      { revision: "revision-one", pm: null },
      "PUT",
    );
  });
  it("preserves routing drafts on stale writes and across repeated workspace mounts until explicit reload", async () => {
    const api = vi.fn<Api>(async (_path, body) => {
      if (body) throw Object.assign(new Error("stale"), { status: 409 });
      return view();
    });
    const f = fixture(api);
    f.mount();
    await settle();
    const choice = f.byId("ai-routing-shop-project-coder");
    choice.value = "codex";
    choice.fire("change");
    await f.submit();
    f.mount();
    expect(f.byId(choice.id)).toBe(choice);
    expect(choice.value).toBe("codex");
    expect(f.control.isDirty()).toBe(true);
    expect(f.control.protectFocus(f.root)).toBe(true);
    expect(text(f.root)).toContain("Your draft is kept");
    await f.byText("Reload saved choices").fire("click");
    expect(choice.value).toBe("");
    expect(f.control.isDirty()).toBe(false);
  });
  it("clears a model override explicitly and rejects unsupported model input before writing", async () => {
    const api = vi.fn<Api>(async () =>
      view({ coder: { provider: "codex", model: "gpt-5.4" } }),
    );
    const f = fixture(api);
    f.mount();
    await settle();
    const model = f.byId("ai-routing-shop-project-coder-model");
    model.value = "invalid model";
    model.fire("change");
    await f.submit();
    expect(api.mock.calls.some(([, body]) => body)).toBe(false);
    model.value = "";
    model.fire("change");
    await f.submit();
    expect(api).toHaveBeenCalledWith(
      "/api/projects/shop/ai",
      {
        revision: "revision-one",
        default: null,
        pm: null,
        coder: { provider: "codex" },
      },
      "PUT",
    );
  });
  it("resets the role's model to provider default when changing provider", async () => {
    const api = vi.fn<Api>(async () =>
      view({ coder: { provider: "codex", model: "gpt-5.4" } }),
    );
    const f = fixture(api);
    f.mount();
    await settle();
    const provider = f.byId("ai-routing-shop-project-coder"),
      model = f.byId("ai-routing-shop-project-coder-model");
    expect(model.tagName).toBe("SELECT");
    expect(model.value).toBe("gpt-5.4");
    provider.value = "claude";
    provider.fire("change");
    await settle();
    expect(model.value).toBe("");
    await f.submit();
    expect(api).toHaveBeenCalledWith(
      "/api/projects/shop/ai",
      {
        revision: "revision-one",
        default: null,
        pm: null,
        coder: { provider: "claude" },
      },
      "PUT",
    );
  });
  it("retains an unavailable saved model with native select behavior when another role is saved", async () => {
    const api = vi.fn<Api>(async () =>
      view({ coder: { provider: "codex", model: "previous-model" } }),
    );
    const f = fixture(api, true);
    f.mount();
    await settle();
    const model = f.byId("ai-routing-shop-project-coder-model");
    expect(model.value).toBe("previous-model");
    expect(
      model.children.find((option) => option.value === "previous-model")
        ?.disabled,
    ).toBe(true);
    const pm = f.byId("ai-routing-shop-project-pm");
    pm.value = "claude";
    pm.fire("change");
    await f.submit();
    expect(api).toHaveBeenCalledWith(
      "/api/projects/shop/ai",
      {
        revision: "revision-one",
        default: null,
        pm: { provider: "claude" },
        coder: { provider: "codex", model: "previous-model" },
      },
      "PUT",
    );
  });
  it("keeps locked scopes read-only and avoids automatic repeated reads after a load failure", async () => {
    const api = vi.fn<Api>(async () => {
      throw new Error("offline-private-token");
    });
    const f = fixture(api);
    f.setLocked(true);
    await settle();
    expect(api).not.toHaveBeenCalled();
    f.setLocked(false);
    await settle();
    f.mount();
    await settle();
    expect(api).toHaveBeenCalledOnce();
    expect(text(f.root)).toContain("AI choices could not load");
    expect(text(f.root)).not.toContain("offline-private-token");
    expect(f.control.isBusy()).toBe(false);
  });
  it("does not reuse a deleted PM's draft for its replacement identity", async () => {
    const f = fixture();
    f.mount(true);
    await settle();
    const first = f.root.children[0]!;
    const choice = f.byId("ai-routing-shop-checkout-pm");
    choice.value = "codex";
    choice.fire("change");
    f.control.forget("shop", "checkout");
    f.control.mount(f.root, f.project, {
      ...f.area,
      instanceId: "replacement",
    });
    await settle();
    expect(f.root.children.at(-1)).not.toBe(first);
    expect(f.control.isDirty()).toBe(false);
  });
});
