import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

const script = readFileSync(
  new URL("../../dashboard/linear-settings.js", import.meta.url),
  "utf8",
);
const teamA = "11111111-1111-4111-8111-111111111111";
const teamB = "22222222-2222-4222-8222-222222222222";
const projectA = "33333333-3333-4333-8333-333333333333";
const projectB = "44444444-4444-4444-8444-444444444444";
const resources = {
  teams: [
    { id: teamA, key: "A", name: "Team Alpha" },
    { id: teamB, key: "B", name: "Team Beta" },
  ],
  projects: [
    {
      id: projectA,
      name: "Checkout",
      teamIds: [teamA],
      url: "https://linear.app/alpha/project/checkout",
    },
    {
      id: projectB,
      name: "Search",
      teamIds: [teamB],
      url: "https://linear.app/beta/project/search",
    },
  ],
};
const project = {
  name: "shop",
  linear: { teamId: teamA, teamName: "Team Alpha" },
  commands: { test: "python test.py" },
};
const areas = {
  areas: {
    core: {
      name: "Quality",
      linearProjectId: projectA,
      enabled: true,
      mandate: "Keep checkout sound",
    },
    search: {
      name: "Search",
      linearProjectId: "PASTE_LINEAR_PROJECT_ID",
      enabled: false,
    },
  },
};
interface Model {
  teamId: string;
  connectionId: string;
  setConnection(id: string): void;
  setTeam(id: string): void;
  setProject(key: string, id: string): void;
  setResources(resources: object): void;
  availableProjects(): Array<{ id: string }>;
  rows(): Array<{ key: string; warning: string }>;
  isDirty(): boolean;
  read(): { teamId: string; areaProjects: Record<string, string | null> };
}
class Element {
  children: Element[] = [];
  attributes = new Map<string, string>();
  listeners = new Map<string, () => unknown>();
  dataset: Record<string, string> = {};
  className = "";
  id = "";
  value = "";
  textContent = "";
  hidden = false;
  disabled = false;
  href = "";
  type = "";
  open = false;
  focused = false;
  classList = {
    toggle: (name: string, enabled: boolean) => {
      const items = new Set(this.className.split(" "));
      if (enabled) items.add(name);
      else items.delete(name);
      this.className = [...items].join(" ");
    },
  };
  append(...nodes: Element[]) {
    this.children.push(...nodes);
  }
  replaceChildren(...nodes: Element[]) {
    this.children = nodes;
  }
  setAttribute(key: string, value: string) {
    this.attributes.set(key, value);
  }
  removeAttribute(key: string) {
    this.attributes.delete(key);
  }
  addEventListener(name: string, listener: () => unknown) {
    this.listeners.set(name, listener);
  }
  focus() {
    this.focused = true;
  }
  async emit(name: string) {
    await this.listeners.get(name)?.();
  }
}
interface Panel {
  load(name: string): Promise<boolean>;
  reset(): void;
  isDirty(): boolean;
  isBusy(): boolean;
  setLocked(value: boolean): void;
  rebaseProject(document: {
    path: string;
    content: string;
    revision: string;
  }): boolean;
}
const documentFile = (name: string, file: string) => ({
  path: `projects/${name}/${file}.json`,
  revision: `${name}-${file}-revision`,
  content: JSON.stringify(file === "project" ? { ...project, name } : areas),
});
function apiDefault(path: string) {
  if (path === "/api/service-connections")
    return {
      connections: [
        {
          provider: "linear",
          id: "default",
          label: "Default Linear",
          connected: true,
        },
      ],
    };
  if (path === "/api/linear/resources") return resources;
  const pathValue =
    new URL(`http://local${path}`).searchParams.get("path") || "";
  const [, name, filename] = pathValue.split("/");
  return documentFile(name!, filename!.replace(".json", ""));
}
function environment(
  api: (path: string, body?: unknown, method?: string) => unknown = apiDefault,
) {
  const window = {} as {
    createLinearMappingsModel(
      project: object,
      areas: object,
      resources: object,
    ): Model;
    createProjectLinearSettings(container: Element, options: object): Panel;
  };
  runInNewContext(script, {
    window,
    document: { createElement: () => new Element() },
    URL,
    Promise,
  });
  const container = new Element();
  const saved = vi.fn();
  const errors = vi.fn();
  const busy = vi.fn();
  const requests = vi.fn(
    async (path: string, body?: unknown, method?: string) =>
      api(path, body, method),
  );
  const panel = window.createProjectLinearSettings(container, {
    api: requests,
    onSaved: saved,
    onError: errors,
    onBusy: busy,
  });
  const all = (): Element[] => {
    const visit = (el: Element): Element[] => [
      el,
      ...el.children.flatMap(visit),
    ];
    return visit(container);
  };
  const byId = (id: string) => all().find((el) => el.id === id)!;
  const byClass = (name: string) =>
    all().find((el) => el.className.split(" ").includes(name))!;
  const button = (label: string) =>
    all().find((el) => el.type === "button" && el.textContent === label)!;
  return {
    window,
    panel,
    container,
    saved,
    errors,
    busy,
    requests,
    byId,
    byClass,
    button,
    all,
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe("Linear mapping repair model", () => {
  it("filters choices by team, diagnoses wrong-team mappings, and never silently replaces a saved choice", () => {
    const f = environment();
    const model = f.window.createLinearMappingsModel(project, areas, resources);
    expect(model.availableProjects().map((row) => row.id)).toEqual([projectA]);
    model.setTeam(teamB);
    expect(model.availableProjects().map((row) => row.id)).toEqual([projectB]);
    expect(model.rows()[0]!.warning).toContain("different team");
    expect(() => model.read()).toThrow("Choose a Linear project in this team");
  });
  it("allows explicit unmapped PMs and rejects duplicate projects", () => {
    const f = environment();
    const model = f.window.createLinearMappingsModel(project, areas, resources);
    expect(model.read()).toEqual({
      connectionId: "default",
      teamId: teamA,
      areaProjects: { core: projectA, search: null },
    });
    model.setProject("search", projectA);
    expect(() => model.read()).toThrow("own Linear project");
    model.setProject("core", "");
    expect(model.rows()[0]!.warning).toContain("will pause");
    expect(model.read().areaProjects).toEqual({ core: null, search: projectA });
    expect(areas.areas.core.enabled).toBe(true);
  });
  it("preserves drafts across refreshed resources and handles revoked access", () => {
    const f = environment();
    const model = f.window.createLinearMappingsModel(project, areas, resources);
    model.setTeam(teamB);
    model.setProject("core", projectB);
    model.setResources({ teams: [], projects: [] });
    expect(model.isDirty()).toBe(true);
    expect(() => model.read()).toThrow("accessible Linear team");
    model.setResources(resources);
    expect(model.read()).toEqual({
      connectionId: "default",
      teamId: teamB,
      areaProjects: { core: projectB, search: null },
    });
  });
});

describe("Linear repair panel request safety", () => {
  it("ignores a slow previous project's response when another project is opened", async () => {
    const pending = deferred<unknown>();
    const f = environment((path) =>
      path.includes("alpha%2Fproject") ? pending.promise : apiDefault(path),
    );
    const old = f.panel.load("alpha");
    await f.panel.load("beta");
    pending.resolve(documentFile("alpha", "project"));
    await old;
    expect(f.byClass("linear-repair-title").textContent).toBe(
      "Linear mappings · beta",
    );
    expect(f.panel.isBusy()).toBe(false);
  });
  it("does not resurrect a closed editor when pending requests finish", async () => {
    const pending = deferred<unknown>();
    const f = environment(() => pending.promise);
    const opening = f.panel.load("alpha");
    f.panel.reset();
    pending.resolve(resources);
    await opening;
    expect(f.panel.isDirty()).toBe(false);
    expect(f.byClass("linear-repair-fields").hidden).toBe(true);
    expect(f.byClass("linear-repair-title").textContent).toBe(
      "Linear mappings",
    );
  });
  it("refreshes choices without discarding the selected team and PM draft", async () => {
    const f = environment();
    await f.panel.load("shop");
    f.byId("edit-linear-team").value = teamB;
    await f.byId("edit-linear-team").emit("change");
    f.byId("linear-pm-core").value = projectB;
    await f.byId("linear-pm-core").emit("change");
    await f.button("Refresh Linear teams & projects").emit("click");
    expect(f.panel.isDirty()).toBe(true);
    expect(f.byId("edit-linear-team").value).toBe(teamB);
    expect(f.byId("linear-pm-core").value).toBe(projectB);
  });
  it("saves both revisions and every mapping in one request, and keeps choices on conflict", async () => {
    const conflict = Object.assign(new Error("changed"), { status: 409 });
    const f = environment((path) =>
      path.endsWith("/linear/mappings")
        ? Promise.reject(conflict)
        : apiDefault(path),
    );
    await f.panel.load("shop");
    f.byId("linear-pm-core").value = "";
    await f.byId("linear-pm-core").emit("change");
    await f.button("Save Linear mappings").emit("click");
    expect(f.requests).toHaveBeenCalledWith(
      "/api/projects/shop/linear/mappings",
      {
        projectRevision: "shop-project-revision",
        areasRevision: "shop-areas-revision",
        connectionId: "default",
        teamId: teamA,
        areaProjects: { core: null, search: null },
      },
    );
    expect(f.panel.isDirty()).toBe(true);
    expect(f.byClass("linear-repair-status").textContent).toContain(
      "Your choices are kept",
    );
    expect(f.saved).not.toHaveBeenCalled();
  });
  it("keeps resource failures local and makes an explicit retry available", async () => {
    const f = environment((path) =>
      path === "/api/linear/resources"
        ? Promise.reject(new Error("offline"))
        : apiDefault(path),
    );
    expect(await f.panel.load("shop")).toBe(true);
    expect(f.byClass("linear-repair-fields").hidden).toBe(false);
    expect(f.byClass("linear-repair-fields").disabled).toBe(true);
    expect(f.button("Refresh Linear teams & projects").disabled).toBe(false);
    expect(f.byClass("linear-repair-status").textContent).toContain(
      "saved mappings are shown",
    );
  });
  it("only clears dirty state after successful coherent save and tells the outer editor what changed", async () => {
    const f = environment((path, body) => {
      if (!path.endsWith("/linear/mappings")) return apiDefault(path);
      const values = body as {
        teamId: string;
        areaProjects: Record<string, string | null>;
      };
      return {
        project: {
          ...documentFile("shop", "project"),
          content: JSON.stringify({
            ...project,
            linear: { teamId: values.teamId },
          }),
        },
        areas: {
          ...documentFile("shop", "areas"),
          content: JSON.stringify({
            areas: {
              ...areas.areas,
              core: {
                ...areas.areas.core,
                linearProjectId: "PASTE_LINEAR_PROJECT_ID",
                enabled: false,
              },
            },
          }),
        },
      };
    });
    await f.panel.load("shop");
    f.byId("linear-pm-core").value = "";
    await f.byId("linear-pm-core").emit("change");
    await f.button("Save Linear mappings").emit("click");
    expect(f.panel.isDirty()).toBe(false);
    expect(f.saved).toHaveBeenCalledWith(
      expect.objectContaining({
        projectName: "shop",
        projectChanged: true,
        areasChanged: true,
        project: expect.objectContaining({
          path: "projects/shop/project.json",
          revision: "shop-project-revision",
        }),
      }),
    );
    expect(f.byClass("linear-mapping-name").textContent).toContain("Paused PM");
  });
  it("rebases unrelated project changes while preserving dirty mapping choices", async () => {
    const f = environment((path) =>
      path.endsWith("/linear/mappings")
        ? Promise.reject(
            Object.assign(new Error("test conflict"), { status: 409 }),
          )
        : apiDefault(path),
    );
    await f.panel.load("shop");
    f.byId("linear-pm-core").value = "";
    await f.byId("linear-pm-core").emit("change");
    const next = {
      ...documentFile("shop", "project"),
      revision: "changed-commands",
      content: JSON.stringify({ ...project, commands: { test: "make test" } }),
    };
    expect(f.panel.rebaseProject(next)).toBe(true);
    expect(f.panel.isDirty()).toBe(true);
    await f.button("Save Linear mappings").emit("click");
    expect(f.requests.mock.calls.at(-1)?.[1]).toMatchObject({
      projectRevision: "changed-commands",
    });
    expect(
      f.panel.rebaseProject({
        ...next,
        content: JSON.stringify({ ...project, linear: { teamId: teamB } }),
      }),
    ).toBe(false);
  });
  it("ignores an old save response after a different project opens", async () => {
    const pending = deferred<unknown>();
    const f = environment((path) =>
      path.endsWith("/linear/mappings") ? pending.promise : apiDefault(path),
    );
    await f.panel.load("shop");
    f.byId("linear-pm-core").value = "";
    await f.byId("linear-pm-core").emit("change");
    const saving = f.button("Save Linear mappings").emit("click");
    await f.panel.load("another-app");
    pending.resolve({
      project: documentFile("shop", "project"),
      areas: documentFile("shop", "areas"),
    });
    await saving;
    expect(f.byClass("linear-repair-title").textContent).toBe(
      "Linear mappings · another-app",
    );
    expect(f.saved).not.toHaveBeenCalled();
    expect(f.panel.isBusy()).toBe(false);
  });
  it("requires explicit confirmation before discarding a mapping draft", async () => {
    const f = environment();
    await f.panel.load("shop");
    f.byId("edit-linear-team").value = teamB;
    await f.byId("edit-linear-team").emit("change");
    const calls = f.requests.mock.calls.length;
    await f.button("Reload saved mappings").emit("click");
    expect(f.requests).toHaveBeenCalledTimes(calls);
    expect(f.byClass("linear-repair-discard").hidden).toBe(false);
    await f.button("Keep editing").emit("click");
    expect(f.panel.isDirty()).toBe(true);
  });
  it("does not render a provider-supplied unsafe link or execute names as markup", async () => {
    const f = environment((path) =>
      path === "/api/linear/resources"
        ? {
            ...resources,
            projects: [
              {
                ...resources.projects[0],
                name: "<img onerror=alert(1)>",
                url: "javascript:alert(1)",
              },
            ],
          }
        : apiDefault(path),
    );
    await f.panel.load("shop");
    expect(f.byClass("linear-project-link").hidden).toBe(true);
    expect(
      f
        .byId("linear-pm-core")
        .children.some(
          (child) => child.textContent === "<img onerror=alert(1)>",
        ),
    ).toBe(true);
  });
});

describe("Linear connection selection", () => {
  const catalog = {
    connections: [
      {
        provider: "linear",
        id: "default",
        label: "Default Linear",
        connected: true,
      },
      {
        provider: "linear",
        id: "client",
        label: "Client workspace",
        connected: true,
      },
      {
        provider: "linear",
        id: "other",
        label: "Other workspace",
        connected: true,
      },
    ],
  };
  it("loads the project's saved named account without requesting default resources", async () => {
    const f = environment((path) => {
      if (path === "/api/service-connections") return catalog;
      if (path === "/api/linear/resources?connection=client") return resources;
      const result = apiDefault(path);
      if (path.includes("shop%2Fproject"))
        return {
          ...result,
          content: JSON.stringify({
            ...project,
            linear: { ...project.linear, connectionId: "client" },
          }),
        };
      return result;
    });
    await f.panel.load("shop");
    expect(f.byId("edit-linear-connection").value).toBe("client");
    expect(
      f.requests.mock.calls.some(([path]) => path === "/api/linear/resources"),
    ).toBe(false);
    expect(f.panel.isDirty()).toBe(false);
  });
  it("keeps missing saved profiles visible instead of substituting the default account", async () => {
    const f = environment((path) => {
      if (path === "/api/service-connections") return catalog;
      const result = apiDefault(path);
      if (path.includes("shop%2Fproject"))
        return {
          ...result,
          content: JSON.stringify({
            ...project,
            linear: { ...project.linear, connectionId: "missing" },
          }),
        };
      return result;
    });
    await f.panel.load("shop");
    expect(f.byId("edit-linear-connection").value).toBe("missing");
    expect(f.byId("edit-linear-connection-note").textContent).toContain(
      "no default account will be substituted",
    );
    expect(
      f.requests.mock.calls.some(([path]) =>
        path.startsWith("/api/linear/resources"),
      ),
    ).toBe(false);
    expect(f.byId("edit-linear-connection").disabled).toBe(false);
    expect(f.button("Save Linear mappings").disabled).toBe(true);
  });
  it("clears cross-account draft selections, ignores stale resource results, and sends explicit account in the coherent save", async () => {
    const pending = deferred<unknown>();
    const f = environment((path) => {
      if (path === "/api/service-connections") return catalog;
      if (path === "/api/linear/resources?connection=client")
        return pending.promise;
      if (path === "/api/linear/resources?connection=other")
        return {
          teams: [resources.teams[1]],
          projects: [resources.projects[1]],
        };
      if (path.endsWith("/linear/mappings"))
        throw Object.assign(new Error("fixture conflict"), { status: 409 });
      return apiDefault(path);
    });
    await f.panel.load("shop");
    const selection = f.byId("edit-linear-connection");
    selection.value = "client";
    const old = selection.emit("change");
    await Promise.resolve();
    await Promise.resolve();
    selection.value = "other";
    await selection.emit("change");
    expect(f.byId("edit-linear-team").value).toBe("");
    expect(f.byId("linear-pm-core").value).toBe("");
    expect(f.panel.isDirty()).toBe(true);
    expect(f.byClass("linear-repair-status").textContent).toContain(
      "Nothing has been saved yet",
    );
    pending.resolve(resources);
    await old;
    expect(f.byId("edit-linear-connection").value).toBe("other");
    expect(
      f.byId("edit-linear-team").children.map((item) => item.value),
    ).toEqual(["", teamB]);
    f.byId("edit-linear-team").value = teamB;
    await f.byId("edit-linear-team").emit("change");
    f.byId("linear-pm-core").value = projectB;
    await f.byId("linear-pm-core").emit("change");
    await f.button("Save Linear mappings").emit("click");
    expect(f.requests.mock.calls.at(-1)?.[1]).toMatchObject({
      connectionId: "other",
      teamId: teamB,
      areaProjects: { core: projectB, search: null },
    });
    expect(f.panel.isDirty()).toBe(true);
    expect(
      f.panel.rebaseProject({
        ...documentFile("shop", "project"),
        content: JSON.stringify({
          ...project,
          linear: { ...project.linear, connectionId: "client" },
        }),
      }),
    ).toBe(false);
  });
});
