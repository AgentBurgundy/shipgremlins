import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

class Element {
  children: Element[] = [];
  attributes = new Map<string, string>();
  dataset: Record<string, string> = {};
  listeners = new Map<string, (event: { preventDefault(): void }) => unknown>();
  className = "";
  textContent = "";
  value = "";
  id = "";
  type = "";
  href = "";
  checked = false;
  disabled = false;
  hidden = false;
  open = false;
  parentElement: Element | null = null;
  focus = vi.fn();
  classList = { toggle: vi.fn() };
  constructor(public tagName: string) {}
  append(...items: Element[]) {
    for (const item of items) {
      item.parentElement = this;
      this.children.push(item);
    }
  }
  replaceChildren(...items: Element[]) {
    this.children = [];
    this.append(...items);
  }
  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }
  getAttribute(name: string) {
    return this.attributes.get(name) ?? null;
  }
  addEventListener(
    name: string,
    handler: (event: { preventDefault(): void }) => unknown,
  ) {
    this.listeners.set(name, handler);
  }
  fire(name: string) {
    return this.listeners.get(name)?.({ preventDefault() {} });
  }
  contains(value: Element): boolean {
    return all(this).includes(value);
  }
  querySelectorAll(selector: string): Element[] {
    return all(this)
      .slice(1)
      .filter((item) => item.tagName === selector.toUpperCase());
  }
  querySelector(selector: string): Element | null {
    return this.querySelectorAll(selector)[0] || null;
  }
  showModal() {
    this.open = true;
  }
  close() {
    this.open = false;
  }
}
const all = (root: Element): Element[] => [root, ...root.children.flatMap(all)];
const text = (root: Element): string =>
  all(root)
    .map((item) => item.textContent)
    .join(" ");
type Agent = {
  key: string;
  instanceId?: string;
  name: string;
  enabled: boolean;
  areas: string[];
  maxConcurrent: number;
  ai?: { provider: string; model?: string };
  effectiveAi?: {
    provider: string;
    model?: string;
    source: string;
    configured: boolean;
  };
  readiness?: {
    canEnable: boolean;
    blockers: { id: string; message: string; action: string }[];
  };
};
type View = {
  revision: string | null;
  error?: string;
  legacy: boolean;
  agents: Agent[];
  providers: { id: string; configured: boolean }[];
};
type Api = (
  path: string,
  body?: { revision?: string; agents?: Agent[] },
  method?: string,
  timeout?: number,
) => Promise<unknown>;
type Control = {
  mount(root: Element, project: object): void;
  render(project: object): Element;
  isDirty(): boolean;
  isBusy(): boolean;
  protectFocus(root: Element): boolean;
  forget(project: string): void;
};
const agent = (changes: Partial<Agent> = {}): Agent => ({
  key: "builder",
  instanceId: "coder-current",
  name: "Builder",
  enabled: false,
  areas: ["core"],
  maxConcurrent: 2,
  effectiveAi: { provider: "codex", source: "project-role", configured: true },
  readiness: { canEnable: true, blockers: [] },
  ...changes,
});
const view = (agents = [agent()], changes = {}): View => ({
  revision: "r1",
  legacy: false,
  agents,
  providers: [
    { id: "claude", configured: true },
    { id: "codex", configured: true },
  ],
  ...changes,
});
async function settle() {
  for (let count = 0; count < 12; count++) await Promise.resolve();
}
function fixture(initial = view(), handler?: Api) {
  const body = new Element("BODY"),
    document = {
      body,
      activeElement: null as Element | null,
      createElement: (tag: string) => {
        const element = new Element(tag.toUpperCase());
        element.focus.mockImplementation(() => {
          document.activeElement = element;
        });
        return element;
      },
    };
  const window = {} as { createCodingAgents(options: object): Control };
  runInNewContext(
    readFileSync(
      new URL("../../dashboard/ai-models.js", import.meta.url),
      "utf8",
    ) +
      "\n" +
      readFileSync(
        new URL("../../dashboard/coding-agents.js", import.meta.url),
        "utf8",
      ),
    { window, document },
  );
  let saved = initial,
    locked = false;
  const jobs: Record<string, unknown>[] = [],
    api = vi.fn<Api>(async (path, payload, method, timeout) => {
      if (path.startsWith("/api/ai/models?"))
        return {
          provider: path.endsWith("codex") ? "codex" : "claude",
          source: "supported",
          models: [{ id: "fixture-model", label: "Fixture model" }],
        };
      if (handler) return handler(path, payload, method, timeout);
      if (payload?.agents)
        saved = view(
          payload.agents.map((item) => ({
            ...item,
            instanceId: item.instanceId || "generated",
          })),
          { revision: "r2" },
        );
      return saved;
    });
  const onChanged = vi.fn(async () => {}),
    onJob = vi.fn(),
    control = window.createCodingAgents({
      api,
      getJobs: () => jobs,
      isLocked: () => locked,
      onChanged,
      onJob,
    });
  const root = new Element("SECTION"),
    project = {
      name: "shop",
      instanceId: "project-current",
      areas: [
        { key: "core", name: "Core PM" },
        { key: "checkout", name: "Checkout PM" },
      ],
      coders: initial,
      autonomy: { projectPaused: false },
    };
  const mount = () => control.mount(root, project),
    byText = (value: string, within = body) =>
      all(within).find((item) => item.textContent === value)!,
    byId = (id: string) => all(body).find((item) => item.id === id)!;
  const dialog = () => all(body).find((item) => item.tagName === "DIALOG")!;
  const edit = async () => {
    await all(root)
      .find((item) => item.attributes.get("aria-label") === "Edit Builder")!
      .fire("click");
    await settle();
  };
  const submit = async () => {
    await all(body)
      .find((item) => item.tagName === "FORM")!
      .fire("submit");
    await settle();
  };
  mount();
  return {
    body,
    root,
    project,
    api,
    control,
    onChanged,
    onJob,
    jobs,
    mount,
    byText,
    byId,
    dialog,
    edit,
    submit,
    setLocked: (value: boolean) => {
      locked = value;
      mount();
    },
  };
}
describe("first-class coding agent controls", () => {
  it("isolates unreadable coding settings, disables creation and allows a safe refresh", async () => {
    const f = fixture(
      view([], {
        revision: null,
        error:
          "Coding agents could not be read safely. Repair their settings, then refresh.",
      }),
      async () => view(),
    );
    expect(f.byText("Add coding agent", f.root).disabled).toBe(true);
    expect(text(f.root)).not.toContain("No coding agents yet");
    expect(
      all(f.root).find((item) => item.attributes.get("role") === "alert")
        ?.textContent,
    ).toContain("could not be read safely");
    expect(f.api).not.toHaveBeenCalled();
    await f.byText("Refresh coding agents", f.root).fire("click");
    expect(f.byText("Add coding agent", f.root).disabled).toBe(false);
    expect(text(f.root)).toContain("Builder");
  });
  it("shows a named coding role, assigned PM queues, provider and independent paused state", () => {
    const f = fixture();
    expect(text(f.root)).toContain("Coding agents");
    expect(text(f.root)).toContain("Builder");
    expect(text(f.root)).toContain("Queues: Core PM");
    expect(text(f.root)).toContain("Codex · Provider default");
    expect(text(f.root)).toContain("0/2 active");
    expect(text(f.root)).toContain("Paused");
    expect(
      all(f.root).some((item) => item.attributes.get("role") === "switch"),
    ).toBe(false);
  });
  it("runs a paused coder with its exact key and keeps an accepted launch after refresh fails", async () => {
    const returned = { id: "accepted", type: "developer", status: "queued" };
    const f = fixture(view(), async () => ({ job: returned }));
    f.onChanged.mockRejectedValue(new Error("refresh failed"));
    await f.byText("Run once", f.root).fire("click");
    expect(f.api).toHaveBeenCalledExactlyOnceWith(
      "/api/jobs",
      {
        type: "developer",
        project: "shop",
        coderKey: "builder",
        runOnce: true,
      },
      "POST",
      90000,
    );
    expect(f.onJob).toHaveBeenCalledWith(returned);
    expect(text(f.root)).toContain("automatic pickup setting is unchanged");
    await f.byText("View run", f.root).fire("click");
    expect(f.api).toHaveBeenCalledTimes(1);
  });
  it("never attaches a replaced coder or project run to the current card", () => {
    const f = fixture();
    f.jobs.push({
      id: "old",
      type: "developer",
      project: "shop",
      projectInstanceId: "project-current",
      coderKey: "builder",
      coderInstanceId: "deleted-coder",
      status: "running",
    });
    f.mount();
    expect(text(f.root)).not.toContain("View run");
    f.jobs.push({
      id: "current",
      type: "developer",
      project: "shop",
      projectInstanceId: "project-current",
      coderKey: "builder",
      coderInstanceId: "coder-current",
      status: "running",
    });
    f.mount();
    expect(text(f.root)).toContain("View run");
    expect(text(f.root)).toContain("1/2 active");
  });
  it("holds the run button after an ambiguous launch and links to evidence instead of inviting duplicate work", async () => {
    const f = fixture(view(), async () => {
      throw new Error("network failed");
    });
    await f.byText("Run once", f.root).fire("click");
    expect(f.byText("Run once", f.root).disabled).toBe(true);
    expect(f.byText("Review Runs before starting again →", f.root).href).toBe(
      "/activity",
    );
    expect(text(f.root)).toContain("did not confirm whether a run started");
  });
  it("saves exact coder identity and queues while stripping read-only view fields and clearing inherited AI", async () => {
    const f = fixture(
      view([
        agent({ ai: { provider: "codex", model: "fixture-model" } }),
        agent({ key: "other", instanceId: "other-id", name: "Other" }),
      ]),
    );
    await f.edit();
    expect(f.byId("coder-model").tagName).toBe("SELECT");
    f.byId("coder-name").value = "Renamed Builder";
    f.byId("coder-queue-checkout").checked = true;
    f.byId("coder-provider").value = "";
    f.byId("coder-provider").fire("change");
    await f.submit();
    expect(f.api).toHaveBeenCalledWith(
      "/api/projects/shop/coders",
      {
        revision: "r1",
        agents: [
          {
            key: "builder",
            instanceId: "coder-current",
            name: "Renamed Builder",
            enabled: false,
            areas: ["core", "checkout"],
            maxConcurrent: 2,
          },
          {
            key: "other",
            instanceId: "other-id",
            name: "Other",
            enabled: false,
            areas: ["core"],
            maxConcurrent: 2,
          },
        ],
      },
      "PUT",
    );
    expect(f.control.isDirty()).toBe(false);
    expect(text(f.body)).toContain("Coding agent saved");
  });
  it("creates a separately paused coder with a generated key, selected native model and bounded capacity", async () => {
    const f = fixture(view([]));
    await f.byText("Add coding agent", f.root).fire("click");
    await settle();
    f.byId("coder-name").value = "Checkout Builder";
    f.byId("coder-queue-checkout").checked = true;
    f.byId("coder-capacity").value = "3";
    f.byId("coder-provider").value = "codex";
    f.byId("coder-provider").fire("change");
    await settle();
    f.byId("coder-model").value = "fixture-model";
    await f.submit();
    expect(f.api).toHaveBeenCalledWith(
      "/api/projects/shop/coders",
      {
        revision: "r1",
        agents: [
          {
            key: "checkout-builder",
            name: "Checkout Builder",
            enabled: false,
            areas: ["checkout"],
            maxConcurrent: 3,
            ai: { provider: "codex", model: "fixture-model" },
          },
        ],
      },
      "PUT",
    );
  });
  it("preserves unavailable saved models and resets the model when the provider changes", async () => {
    const f = fixture(
      view([agent({ ai: { provider: "codex", model: "previous-model" } })]),
    );
    await f.edit();
    await settle();
    expect(f.byId("coder-model").value).toBe("previous-model");
    expect(
      f
        .byId("coder-model")
        .children.find((item) => item.value === "previous-model")?.disabled,
    ).toBe(true);
    f.byId("coder-name").value = "Keep model";
    await f.submit();
    expect(
      f.api.mock.calls.find(([, body]) => body)?.[1]?.agents?.[0]?.ai,
    ).toEqual({ provider: "codex", model: "previous-model" });
    f.byId("coder-provider").value = "claude";
    f.byId("coder-provider").fire("change");
    await settle();
    expect(f.byId("coder-model").value).toBe("");
  });
  it("rejects missing queues, unsupported models and capacity before a canonical write", async () => {
    const f = fixture();
    await f.edit();
    f.byId("coder-queue-core").checked = false;
    f.byId("coder-enabled").checked = true;
    await f.submit();
    expect(text(f.body)).toContain("choose at least one PM queue");
    f.byId("coder-queue-core").checked = true;
    f.byId("coder-capacity").value = "5";
    await f.submit();
    f.byId("coder-capacity").value = "2";
    f.byId("coder-provider").value = "codex";
    f.byId("coder-provider").fire("change");
    await settle();
    f.byId("coder-model").value = "invented-model";
    await f.submit();
    expect(f.api.mock.calls.some(([, body]) => body)).toBe(false);
  });
  it("keeps a conflicting draft across polls and blocks implicit reload/discard", async () => {
    const f = fixture(view(), async (_path, body) => {
      if (body)
        throw Object.assign(new Error("Revision changed."), { status: 409 });
      return view();
    });
    await f.edit();
    f.byId("coder-name").value = "Unsaved draft";
    await f.submit();
    f.mount();
    expect(f.byId("coder-name").value).toBe("Unsaved draft");
    expect(f.control.isDirty()).toBe(true);
    expect(f.control.protectFocus(f.root)).toBe(true);
    await f.byText("Reload saved agent").fire("click");
    expect(f.byId("coder-name").value).toBe("Unsaved draft");
    expect(text(f.body)).toContain("Save or discard your draft");
    await f.byText("Close ×").fire("click");
    expect(f.dialog().open).toBe(true);
    await f.byText("Keep editing").fire("click");
    expect(f.dialog().open).toBe(true);
    await f.byText("Close ×").fire("click");
    await f.byText("Discard edits").fire("click");
    expect(f.dialog().open).toBe(false);
    expect(f.control.isDirty()).toBe(false);
  });
  it("requires a separate delete confirmation and retains all other agents", async () => {
    const f = fixture(
      view([
        agent(),
        agent({ key: "other", instanceId: "other-id", name: "Other" }),
      ]),
    );
    await f.edit();
    await f.byText("Delete agent").fire("click");
    expect(f.api.mock.calls.some(([, body]) => body)).toBe(false);
    await f.byText("Keep agent").fire("click");
    expect(f.api.mock.calls.some(([, body]) => body)).toBe(false);
    await f.byText("Delete agent").fire("click");
    await f.byText("Delete this agent").fire("click");
    expect(f.api).toHaveBeenCalledWith(
      "/api/projects/shop/coders",
      {
        revision: "r1",
        agents: [
          {
            key: "other",
            instanceId: "other-id",
            name: "Other",
            enabled: false,
            areas: ["core"],
            maxConcurrent: 2,
          },
        ],
      },
      "PUT",
    );
    expect(f.dialog().open).toBe(false);
  });
  it("keeps failed enablement visible without changing saved state or PM automation", async () => {
    const f = fixture(view(), async (_path, body) => {
      if (body)
        throw Object.assign(
          new Error("Connect this agent’s Codex account first."),
          { status: 409 },
        );
      return view();
    });
    await f.byText("Enable pickup", f.root).fire("click");
    expect(text(f.root)).toContain("Connect this agent’s Codex account first");
    expect(text(f.root)).toContain("Paused");
    expect(f.project.coders.agents[0]!.enabled).toBe(false);
    expect(f.api.mock.calls[0]?.[1]?.agents?.[0]?.enabled).toBe(true);
  });
  it("keeps known setup blockers actionable and blocks new runs while existing runs stay readable", () => {
    const f = fixture(
      view([
        agent({
          readiness: {
            canEnable: false,
            blockers: [
              {
                id: "promotion_environment",
                action: "environment",
                message: "Verify the integration environment first.",
              },
            ],
          },
        }),
      ]),
    );
    expect(f.byText("Run once", f.root).disabled).toBe(true);
    expect(f.byText("Enable pickup", f.root).disabled).toBe(true);
    expect(f.byText("Edit agent", f.root).disabled).toBe(false);
    expect(f.byText("Review project setup →", f.root).href).toBe(
      "/projects/shop?tab=settings",
    );
    f.jobs.push({
      id: "running",
      type: "developer",
      status: "running",
      project: "shop",
      projectInstanceId: "project-current",
      coderKey: "builder",
      coderInstanceId: "coder-current",
    });
    f.mount();
    expect(f.byText("View run", f.root).disabled).toBe(false);
    f.project.coders.agents[0]!.enabled = true;
    f.mount();
    expect(f.byText("Pause pickup", f.root).disabled).toBe(false);
  });
  it("preserves each agent’s intent under project pause and keeps manual runs available", () => {
    const f = fixture(view([agent({ enabled: true })]));
    f.project.autonomy.projectPaused = true;
    f.mount();
    expect(text(f.root)).toContain("Project automation is paused");
    expect(text(f.root)).toContain("Automatic pickup on");
    expect(f.byText("Run once", f.root).disabled).toBe(false);
    f.setLocked(true);
    expect(f.byText("Run once", f.root).disabled).toBe(true);
    expect(f.byText("Edit agent", f.root).disabled).toBe(true);
    expect(f.api).not.toHaveBeenCalled();
  });
});
