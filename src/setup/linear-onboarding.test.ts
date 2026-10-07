import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

class Element {
  children: Element[] = [];
  listeners = new Map<
    string,
    (event: { target: Element; preventDefault(): void }) => unknown
  >();
  attributes = new Map<string, string>();
  className = "";
  textContent = "";
  value = "";
  id = "";
  open = false;
  disabled = false;
  isConnected = true;
  focus = vi.fn();
  constructor(public tagName: string) {}
  append(...nodes: Element[]) {
    this.children.push(...nodes);
  }
  replaceChildren(...nodes: Element[]) {
    this.children = nodes;
  }
  setAttribute(key: string, value: string) {
    this.attributes.set(key, value);
  }
  addEventListener(
    key: string,
    callback: (event: { target: Element; preventDefault(): void }) => unknown,
  ) {
    this.listeners.set(key, callback);
  }
  showModal() {
    this.open = true;
  }
  close() {
    this.open = false;
  }
  querySelector(tag: string) {
    return all(this).find((e) => e.tagName === tag.toUpperCase()) || null;
  }
  async fire(type: string) {
    if (type === "click" && this.disabled) return;
    await this.listeners.get(type)?.({ target: this, preventDefault() {} });
  }
}
const all = (e: Element): Element[] => [e, ...e.children.flatMap(all)];
const contents = (e: Element): string =>
  all(e)
    .map((n) => n.textContent)
    .join(" ");
const TEAM = "11111111-1111-4111-8111-111111111111",
  OTHER = "22222222-2222-4222-8222-222222222222";
type Project = {
  name: string;
  instanceId: string;
  repo: string;
  linear?: { connectionId?: string; teamId?: string; teamName?: string };
};
type Dialog = {
  open(name: string, opener?: Element): Promise<void>;
  close(): void;
  isBusy(): boolean;
  refresh(): Promise<void>;
  resume(name: string): Promise<void>;
};
function fixture({
  connected = true,
  reconnect = false,
  teams = [{ id: TEAM, name: "Galactic Basic", key: "GAL" }],
  linear,
}: {
  connected?: boolean;
  reconnect?: boolean;
  teams?: { id: string; name: string; key?: string }[];
  linear?: Project["linear"];
} = {}) {
  const p: Project = {
    name: "forevermods",
    instanceId: "incarnation-1",
    repo: "owner/forevermods",
    linear,
  };
  const status = {
    projects: [p],
    serviceConnections: [
      {
        provider: "linear",
        id: linear?.connectionId || "default",
        label: "My workspace",
        connected,
        needsReconnect: reconnect,
        workspace: { id: "workspace-1", name: "Galactic Basic LLC" },
        account: { id: "account-1" },
      },
    ],
  };
  const body = new Element("BODY"),
    opener = new Element("BUTTON");
  const document = {
    body,
    activeElement: opener,
    createElement: (tag: string) => new Element(tag.toUpperCase()),
  };
  const api = vi.fn(
    async (
      _path: string,
      _body?: unknown,
      _method?: string,
      _timeout?: number,
    ): Promise<Record<string, unknown>> =>
      _path.includes("resources") ? { teams } : { linear: { status: "ready" } },
  );
  const onConnect = vi.fn(async (_project: Project, _id: string) => {}),
    onSaved = vi.fn(async (_project: string) => {}),
    onReady = vi.fn();
  const window = {} as { createLinearOnboarding(options: object): Dialog };
  runInNewContext(readFileSync("dashboard/linear-onboarding.js", "utf8"), {
    window,
    document,
  });
  let locked = false;
  const ui = window.createLinearOnboarding({
    api,
    getStatus: () => status,
    isLocked: () => locked,
    onConnect,
    onSaved,
    onReady,
  });
  const dialog = body.children[0]!;
  const button = (text: string) => {
    const result = all(dialog).find(
      (n) => n.tagName === "BUTTON" && n.textContent === text,
    );
    if (!result) throw new Error(`Missing button ${text}: ${contents(dialog)}`);
    return result;
  };
  return {
    ui,
    status,
    project: p,
    api,
    onConnect,
    onSaved,
    onReady,
    body,
    dialog,
    opener,
    button,
    text: () => contents(dialog),
    lock: () => {
      locked = true;
    },
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("focused Linear onboarding", () => {
  it("starts disconnected users with Connect Linear and does not create resources", async () => {
    const f = fixture({ connected: false });
    await f.ui.open("forevermods", f.opener);
    expect(f.text()).toContain("Where should your gremlins keep their work?");
    expect(f.api).not.toHaveBeenCalled();
    await f.button("Connect Linear").fire("click");
    expect(f.onConnect).toHaveBeenCalledExactlyOnceWith(f.project, "default");
    expect(f.api).not.toHaveBeenCalled();
  });
  it("reconnects the project's saved account instead of switching accounts", async () => {
    const f = fixture({ reconnect: true, linear: { connectionId: "work" } });
    await f.ui.open("forevermods");
    await f.button("Reconnect Linear").fire("click");
    expect(f.onConnect).toHaveBeenCalledExactlyOnceWith(f.project, "work");
  });
  it("does not count OAuth redirect preparation as unsaved/busy work", async () => {
    const f = fixture({ connected: false }),
      pending = deferred<void>();
    f.onConnect.mockImplementation(async () => {
      expect(f.ui.isBusy()).toBe(false);
      await pending.promise;
    });
    await f.ui.open("forevermods");
    const running = f.button("Connect Linear").fire("click");
    expect(f.button("Opening Linear…").disabled).toBe(true);
    pending.resolve();
    await running;
  });
  it("auto-selects the only existing team but waits for explicit setup", async () => {
    const f = fixture();
    await f.ui.open("forevermods");
    expect(f.text()).toContain("Galactic Basic");
    expect(f.api).toHaveBeenCalledOnce();
    await f.button("Set up Linear").fire("click");
    expect(f.api).toHaveBeenLastCalledWith(
      "/api/projects/forevermods/linear",
      {
        projectInstanceId: "incarnation-1",
        repository: "owner/forevermods",
        teamId: TEAM,
      },
      "POST",
      90000,
    );
    expect(f.onSaved).toHaveBeenCalledExactlyOnceWith("forevermods");
    expect(f.text()).toContain("Your crew has a place to work.");
    await f.button("Continue to test environment").fire("click");
    expect(f.dialog.open).toBe(false);
    expect(f.onReady).toHaveBeenCalledExactlyOnceWith("forevermods");
  });
  it("asks the user to choose between several teams", async () => {
    const f = fixture({
      teams: [
        { id: TEAM, name: "A" },
        { id: OTHER, name: "B" },
      ],
    });
    await f.ui.open("forevermods");
    expect(f.button("Set up Linear").disabled).toBe(true);
    const select = f.dialog.querySelector("select")!;
    select.value = OTHER;
    await select.fire("change");
    await f.button("Set up Linear").fire("click");
    expect(f.api).toHaveBeenLastCalledWith(
      "/api/projects/forevermods/linear",
      {
        projectInstanceId: "incarnation-1",
        repository: "owner/forevermods",
        teamId: OTHER,
      },
      "POST",
      90000,
    );
  });
  it("clearly asks before creating a team when none exists", async () => {
    const f = fixture({ teams: [] });
    await f.ui.open("forevermods");
    expect(f.text()).toContain("No teams are available");
    expect(f.api).toHaveBeenCalledOnce();
    await f.button("Create team & set up Linear").fire("click");
    expect(f.api).toHaveBeenLastCalledWith(
      "/api/projects/forevermods/linear",
      { projectInstanceId: "incarnation-1", repository: "owner/forevermods" },
      "POST",
      90000,
    );
  });
  it("preserves a configured team and uses its saved account without asking for UUIDs", async () => {
    const f = fixture({
      linear: {
        connectionId: "work",
        teamId: TEAM,
        teamName: "My existing team",
      },
    });
    await f.ui.open("forevermods");
    expect(f.api).not.toHaveBeenCalled();
    expect(f.text()).toContain("My existing team");
    expect(f.text()).not.toContain(TEAM);
    await f.button("Set up Linear").fire("click");
    expect(f.api).toHaveBeenCalledExactlyOnceWith(
      "/api/projects/forevermods/linear",
      {
        projectInstanceId: "incarnation-1",
        repository: "owner/forevermods",
        teamId: TEAM,
      },
      "POST",
      90000,
    );
  });
  it("shows resource errors inline and retries without losing the project", async () => {
    const f = fixture();
    f.api.mockRejectedValueOnce(new Error("Linear is temporarily unavailable"));
    await f.ui.open("forevermods");
    expect(f.text()).toContain("Linear is temporarily unavailable");
    await f.button("Try again").fire("click");
    expect(f.text()).toContain("Galactic Basic");
    expect(f.api.mock.calls.every((c) => !c[2])).toBe(true);
  });
  it("shows provisioning failure and safely retries the same chosen team", async () => {
    const f = fixture();
    await f.ui.open("forevermods");
    f.api.mockResolvedValueOnce({
      linear: { status: "error", message: "Projects could not be created yet" },
    });
    await f.button("Set up Linear").fire("click");
    expect(f.text()).toContain("Projects could not be created yet");
    await f.button("Set up Linear").fire("click");
    expect(f.text()).toContain("Your crew has a place to work.");
    expect(
      f.api.mock.calls.filter((c) => c[2] === "POST").map((c) => c[1]),
    ).toEqual([
      {
        projectInstanceId: "incarnation-1",
        repository: "owner/forevermods",
        teamId: TEAM,
      },
      {
        projectInstanceId: "incarnation-1",
        repository: "owner/forevermods",
        teamId: TEAM,
      },
    ]);
  });
  it("refreshes after a partial failure and keeps its newly saved team", async () => {
    const f = fixture({ teams: [] });
    await f.ui.open("forevermods");
    f.api.mockResolvedValueOnce({
      linear: { status: "error", message: "Team saved, project step failed" },
    });
    f.onSaved.mockImplementation(async () => {
      f.project.linear = { teamId: TEAM, teamName: "Saved team" };
    });
    await f.button("Create team & set up Linear").fire("click");
    expect(f.text()).toContain("Saved team");
    await f.button("Set up Linear").fire("click");
    expect(f.api).toHaveBeenLastCalledWith(
      "/api/projects/forevermods/linear",
      {
        projectInstanceId: "incarnation-1",
        repository: "owner/forevermods",
        teamId: TEAM,
      },
      "POST",
      90000,
    );
  });
  it("retries status refresh after a successful write without creating resources again", async () => {
    const f = fixture();
    await f.ui.open("forevermods");
    f.onSaved.mockRejectedValueOnce(new Error("status unavailable"));
    await f.button("Set up Linear").fire("click");
    expect(f.text()).toContain("status unavailable");
    await f.button("Refresh project").fire("click");
    expect(f.text()).toContain("Your crew has a place to work.");
    expect(f.api.mock.calls.filter((c) => c[2] === "POST")).toHaveLength(1);
  });
  it.each(["incarnation", "repo", "account"])(
    "discards a late resources response after %s changes",
    async (field) => {
      const f = fixture(),
        pending = deferred<Record<string, unknown>>();
      f.api.mockReturnValueOnce(pending.promise);
      const opening = f.ui.open("forevermods");
      if (field === "incarnation") f.project.instanceId = "replacement";
      if (field === "repo") f.project.repo = "owner/different";
      if (field === "account")
        f.status.serviceConnections[0]!.account.id = "replacement";
      pending.resolve({ teams: [{ id: TEAM, name: "Wrong context" }] });
      await opening;
      expect(f.text()).toContain("changed. Reload setup");
      expect(f.text()).not.toContain("Wrong context");
      expect(f.api.mock.calls.filter((c) => c[2] === "POST")).toEqual([]);
    },
  );
  it("does not report success or continue when the project changes during provisioning", async () => {
    const f = fixture();
    await f.ui.open("forevermods");
    const pending = deferred<Record<string, unknown>>();
    f.api.mockReturnValueOnce(pending.promise);
    const saving = f.button("Set up Linear").fire("click");
    f.project.instanceId = "replacement";
    pending.resolve({ linear: { status: "ready" } });
    await saving;
    expect(f.text()).toContain("changed. Reload setup");
    expect(f.onSaved).not.toHaveBeenCalled();
    expect(f.onReady).not.toHaveBeenCalled();
  });
  it("is closable during loading and suppresses late responses", async () => {
    const f = fixture(),
      pending = deferred<Record<string, unknown>>();
    f.api.mockReturnValueOnce(pending.promise);
    const opening = f.ui.open("forevermods", f.opener);
    await f.button("Close ×").fire("click");
    pending.resolve({ teams: [] });
    await opening;
    expect(f.dialog.open).toBe(false);
    expect(f.opener.focus).toHaveBeenCalled();
    expect(f.ui.isBusy()).toBe(false);
  });
  it("resumes after OAuth by showing the next step without creating remote resources", async () => {
    const f = fixture({ connected: false });
    await f.ui.open("forevermods");
    f.ui.close();
    f.status.serviceConnections[0]!.connected = true;
    await f.ui.resume("forevermods");
    expect(f.text()).toContain("Give your PMs their own projects.");
    expect(f.api.mock.calls.filter((c) => c[2] === "POST")).toEqual([]);
  });
  it("blocks double submission and keeps the dialog closable during a write", async () => {
    const f = fixture();
    await f.ui.open("forevermods");
    const pending = deferred<Record<string, unknown>>();
    f.api.mockReturnValueOnce(pending.promise);
    const saving = f.button("Set up Linear").fire("click");
    expect(f.ui.isBusy()).toBe(true);
    expect(f.button("Setting up Linear…").disabled).toBe(true);
    await f.button("Close ×").fire("click");
    pending.resolve({ linear: { status: "ready" } });
    await saving;
    expect(f.dialog.open).toBe(false);
    expect(f.ui.isBusy()).toBe(false);
  });
  it("reloads a reopened dialog after an earlier write finishes instead of leaving disabled controls", async () => {
    const f = fixture();
    await f.ui.open("forevermods");
    const pending = deferred<Record<string, unknown>>();
    f.api.mockReturnValueOnce(pending.promise);
    const saving = f.button("Set up Linear").fire("click");
    f.ui.close();
    await f.ui.open("forevermods");
    expect(f.ui.isBusy()).toBe(true);
    pending.resolve({ linear: { status: "ready" } });
    await saving;
    expect(f.ui.isBusy()).toBe(false);
    expect(f.text()).toContain("Galactic Basic");
    expect(f.button("Set up Linear").disabled).toBe(false);
    expect(f.api.mock.calls.filter((c) => c[2] === "POST")).toHaveLength(1);
  });
  it("rechecks account identity after refreshing the saved project", async () => {
    const f = fixture();
    await f.ui.open("forevermods");
    f.onSaved.mockImplementation(async () => {
      f.status.serviceConnections[0]!.account.id = "different-user";
    });
    await f.button("Set up Linear").fire("click");
    expect(f.text()).toContain("changed. Reload setup");
    expect(f.onReady).not.toHaveBeenCalled();
  });
});
