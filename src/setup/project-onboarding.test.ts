import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

class Element {
  children: Element[] = [];
  listeners = new Map<string, () => unknown>();
  attributes = new Map<string, string>();
  dataset: Record<string, string> = {};
  className = "";
  classList = {
    add: (value: string) => {
      this.className += ` ${value}`;
    },
  };
  textContent = "";
  id = "";
  value = "";
  disabled = false;
  constructor(public tagName = "DIV") {}
  append(...children: Element[]) {
    this.children.push(...children);
  }
  replaceChildren(...children: Element[]) {
    this.children = children;
  }
  setAttribute(key: string, value: string) {
    this.attributes.set(key, value);
  }
  addEventListener(name: string, callback: () => unknown) {
    this.listeners.set(name, callback);
  }
  contains(value: Element) {
    return walk(this).includes(value);
  }
  fire(name: string) {
    if (name === "click" && this.disabled) return;
    return this.listeners.get(name)?.();
  }
}
const walk = (element: Element): Element[] => [
  element,
  ...element.children.flatMap(walk),
];
const text = (element: Element): string =>
  element.textContent + element.children.map(text).join("");
type Draft = Record<string, unknown>;
type Panel = {
  syncConnections(): void;
  mount(root: Element, project: object): void;
  refresh(project: string): Promise<void>;
  forget(project: string): void;
  destroy(): void;
  isDirty(): boolean;
};
function fixture(
  api = vi.fn(async (_path: string, _body?: unknown) => state()),
  getStatus: () => object | null = () => null,
) {
  const document = {
    activeElement: new Element(),
    hidden: false,
    createElement: (tag: string) => new Element(tag.toUpperCase()),
    createTextNode: (value: string) =>
      Object.assign(new Element("#TEXT"), { textContent: value }),
    addEventListener() {},
    removeEventListener() {},
  };
  const window = {
    addEventListener() {},
    removeEventListener() {},
    onboardingStep: (_data: unknown) => 0,
    readOnboardingTarget: (draft: Draft): Draft => draft,
    createProjectOnboarding: (_options: object): Panel => ({}) as Panel,
    createVercelSetup: undefined as
      | undefined
      | ((options: {
          onSelect(input: {
            target: Record<string, unknown>;
            label: string;
          }): void;
        }) => {
          mount(root: Element): void;
          setActive(active: boolean): void;
          destroy(): void;
          isBusy(): boolean;
          syncConnections(): void;
        }),
  };
  class Option extends Element {
    constructor(label: string, value: string) {
      super("OPTION");
      this.textContent = label;
      this.value = value;
    }
  }
  runInNewContext(
    readFileSync(
      new URL("../../dashboard/project-onboarding.js", import.meta.url),
      "utf8",
    ),
    {
      window,
      document,
      Option,
      URL,
      structuredClone,
      setTimeout,
      clearTimeout,
    },
  );
  const saved = vi.fn(),
    created = vi.fn();
  const panel = window.createProjectOnboarding({
    api,
    getStatus,
    onSaved: saved,
    onCreatePm: created,
  });
  return { window, document, panel, api, saved, created };
}
const state = () => ({
  project: "shop",
  revision: "analysis-1",
  configurationRevision: "config-1",
  status: "idle",
  message: "",
});
const settle = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};
const hosted = (): Draft => ({
  profile: "hosted",
  existing: "",
  url: "https://preview.example.test",
  accessKind: "public",
});
const docker = (): Draft => ({
  profile: "docker",
  recipeKind: "dockerfile",
  dockerfile: "Dockerfile",
  context: ".",
  port: "3000",
  healthPath: "/health",
  advanced:
    '{"services":[{"kind":"postgres","name":"db","env":"DATABASE_URL"}],"seed":["npm","run","seed"]}',
  accessKind: "public",
});

describe("guided environment target review", () => {
  it("keeps a discovered Vercel target and its account binding when applying app access", () => {
    const f = fixture();
    const target = {
      kind: "vercel",
      role: "staging",
      projectId: "prj_testing",
      connectionId: "testing-account",
      teamId: "team_testing",
      branch: "pm-staging",
      customEnvironmentId: "env_testing",
    };
    expect(
      f.window.readOnboardingTarget({ ...hosted(), providerTarget: target }),
    ).toEqual({
      profile: "hosted",
      target: { ...target, access: { kind: "public" } },
    });
    expect(target).not.toHaveProperty("access");
    f.panel.destroy();
  });
  it("keeps a saved bypass secret when selecting a new preview in the same Vercel project", async () => {
    const target = {
      kind: "vercel",
      role: "preview",
      projectId: "prj_testing",
      connectionId: "test",
      teamId: "team_test",
      branch: "pm-staging",
      bypassSecret: "SAVED_TEST_BYPASS",
      access: { kind: "public" },
    };
    const api = vi.fn(async () => ({
      ...state(),
      environment: { name: "pm-test", profile: "hosted", target },
    }));
    const f = fixture(api),
      root = new Element();
    let select!: (input: {
      target: Record<string, unknown>;
      label: string;
    }) => void;
    f.window.createVercelSetup = (options) => {
      select = options.onSelect;
      return {
        mount() {},
        setActive() {},
        destroy() {},
        syncConnections() {},
        isBusy: () => false,
      };
    };
    f.panel.mount(root, {
      name: "shop",
      repo: "owner/shop",
      environments: { "pm-test": target },
    });
    await settle();
    select({
      target: {
        kind: "vercel",
        role: "preview",
        projectId: "prj_testing",
        connectionId: "test",
        teamId: "team_test",
        branch: "pm-next",
        customEnvironmentId: "env_test",
      },
      label: "New preview",
    });
    await walk(root)
      .find((item) => item.textContent === "Save environment")!
      .fire("click");
    expect(api).toHaveBeenLastCalledWith(
      "/api/projects/shop/onboarding/configure",
      expect.objectContaining({
        target: expect.objectContaining({
          branch: "pm-next",
          bypassSecret: "SAVED_TEST_BYPASS",
          customEnvironmentId: "env_test",
        }),
      }),
    );
    f.panel.destroy();
  });
  it("stores only a secret reference for Vercel protection and supports removing it", () => {
    const f = fixture(),
      target = {
        kind: "vercel",
        role: "preview",
        projectId: "prj_test",
        bypassSecret: "OLD_BYPASS",
      };
    expect(
      f.window.readOnboardingTarget({
        ...hosted(),
        providerTarget: target,
        vercelBypassEnabled: true,
        vercelBypassSecret: "VERCEL_BYPASS_SHOP",
      }),
    ).toEqual({
      profile: "hosted",
      target: {
        ...target,
        bypassSecret: "VERCEL_BYPASS_SHOP",
        access: { kind: "public" },
      },
    });
    expect(
      (
        f.window.readOnboardingTarget({
          ...hosted(),
          providerTarget: target,
          vercelBypassEnabled: false,
        }).target as Record<string, unknown>
      ).bypassSecret,
    ).toBeUndefined();
    expect(() =>
      f.window.readOnboardingTarget({
        ...hosted(),
        providerTarget: target,
        vercelBypassEnabled: true,
        vercelBypassSecret: "the-actual-token-not-a-reference",
      }),
    ).toThrow("Add the token itself in Connections");
    f.panel.destroy();
  });
  it("shows configured services and updates missing connection links without resetting environment edits", async () => {
    let status = {
      sourceConnections: [
        {
          provider: "github",
          serverUrl: "https://github.com",
          connected: true,
          method: "oauth",
          needsReconnect: false,
        },
      ],
      connections: [{ name: "CLAUDE_CODE_OAUTH_TOKEN", configured: true }],
    };
    const f = fixture(undefined, () => status),
      root = new Element();
    f.panel.mount(root, { name: "shop", repo: "owner/shop" });
    await settle();
    expect(text(root)).toContain("✓ GitHub connected");
    expect(text(root)).toContain("✓ Claude configured");
    expect(text(root)).toContain("Manage connections");
    expect(text(root)).not.toContain("Connect Claude");
    expect(text(root)).not.toContain("Connect GitHub");
    const form = walk(root).find(
      (item) => item.className === "onboarding-choice",
    );
    const field = walk(form!).find((item) => item.tagName === "INPUT")!;
    field.value = "https://my-unsaved-preview.example.test";
    status = {
      sourceConnections: [
        {
          provider: "github",
          serverUrl: "https://github.com",
          connected: false,
          method: "oauth",
          needsReconnect: true,
        },
      ],
      connections: [{ name: "CLAUDE_CODE_OAUTH_TOKEN", configured: false }],
    };
    f.panel.syncConnections();
    expect(text(root)).toContain("Reconnect GitHub");
    expect(text(root)).toContain("Connect Claude");
    expect(text(root)).not.toContain("✓ GitHub connected");
    expect(field.value).toBe("https://my-unsaved-preview.example.test");
    expect(walk(root)).toContain(field);
    f.panel.destroy();
  });
  it("does not use a different source provider or GitLab host as proof of this project's connection", async () => {
    const f = fixture(undefined, () => ({
        sourceConnections: [
          {
            provider: "github",
            serverUrl: "https://github.com",
            connected: true,
            method: "oauth",
          },
          {
            provider: "gitlab",
            serverUrl: "https://gitlab.com",
            connected: true,
            method: "oauth",
          },
          {
            provider: "gitlab",
            serverUrl: "https://gitlab.example.test",
            connected: false,
            method: "none",
          },
        ],
        connections: [{ name: "CLAUDE_CODE_OAUTH_TOKEN", configured: true }],
      })),
      root = new Element();
    f.panel.mount(root, {
      name: "shop",
      repo: "owner/shop",
      provider: "gitlab",
      serverUrl: "https://gitlab.example.test",
    });
    await settle();
    expect(text(root)).toContain("Connect GitLab");
    expect(text(root)).not.toContain("GitLab connected");
    expect(text(root)).not.toContain("GitHub connected");
    expect(text(root)).toContain("✓ Claude configured");
    f.panel.destroy();
  });
  it("keeps unknown connection status neutral instead of claiming a missing connection", async () => {
    const f = fixture(),
      root = new Element();
    f.panel.mount(root, { name: "shop", repo: "owner/shop" });
    await settle();
    expect(text(root)).toContain("Manage GitHub");
    expect(text(root)).toContain("Manage Claude");
    expect(text(root)).not.toContain("Connect Claude");
    expect(text(root)).not.toContain("connected");
    f.panel.destroy();
  });
  it("shows source selection reasons, excerpt ranges and unresolved coverage without claiming a whole-repository review", async () => {
    const api = vi.fn(async () => ({
      ...state(),
      report: {
        recommendation: "docker",
        summary: "A real dashboard",
        rationale: "Use its fixture.",
        repository: {
          repo: "owner/shop",
          branch: "main",
          sha: "a".repeat(40),
          filesRead: ["src/server.ts"],
          inspection: {
            totalFiles: 300,
            treeTruncated: true,
            sourceBytes: 4096,
            limits: { files: 80, sourceBytes: 524288 },
            files: [
              {
                path: "src/server.ts",
                reason: "manifest entrypoint",
                excerpt: true,
                ranges: [{ start: 1, end: 45 }],
              },
            ],
            criticalMissing: ["src/private-loader.ts"],
            unresolved: ["Dynamic import could not be followed"],
          },
        },
      },
    }));
    const f = fixture(api),
      root = new Element();
    f.panel.mount(root, { name: "shop", repo: "owner/shop" });
    await settle();
    expect(text(root)).toContain(
      "Reviewed 1 files · Entrypoints & dependencies",
    );
    expect(text(root)).toContain(
      "300 files listed (repository listing incomplete)",
    );
    expect(text(root)).toContain("manifest entrypoint · excerpt, lines 1–45");
    expect(text(root)).toContain("Important source is still missing");
    expect(text(root)).toContain("not a complete repository audit");
    expect(text(root)).toContain("Dynamic import could not be followed");
    f.panel.destroy();
  });
  it("uses a fresh test-credential namespace for a recreated project", async () => {
    const f = fixture(),
      root = new Element();
    f.panel.mount(root, {
      name: "shop",
      instanceId: "a1b2c3",
      repo: "owner/shop",
    });
    await settle();
    const access = walk(root).find(
      (item) =>
        item.tagName === "SELECT" &&
        item.children.some((option) => option.value === "password"),
    )!;
    access.value = "password";
    access.fire("change");
    expect(
      walk(root).find(
        (item) => item.id === "onboarding-shop-account-0-usernameSecret",
      )?.value,
    ).toBe("APP_SHOP_A1B2C3_TEST_ADMIN_USERNAME");
    expect(
      walk(root).find(
        (item) => item.id === "onboarding-shop-account-0-passwordSecret",
      )?.value,
    ).toBe("APP_SHOP_A1B2C3_TEST_ADMIN_PASSWORD");
    f.panel.destroy();
  });
  it("never treats repository analysis or saved settings as verified browser access", () => {
    const { window } = fixture();
    expect(window.onboardingStep(state())).toBe(0);
    expect(
      window.onboardingStep({
        ...state(),
        report: { recommendation: "docker" },
      }),
    ).toBe(1);
    expect(
      window.onboardingStep({
        ...state(),
        environment: { verification: { status: "untested" } },
      }),
    ).toBe(2);
    expect(
      window.onboardingStep({
        ...state(),
        environment: { verification: { status: "failed" } },
      }),
    ).toBe(2);
    expect(
      window.onboardingStep({
        ...state(),
        environment: { verification: { status: "passed" } },
      }),
    ).toBe(3);
  });
  it("supports a known hosted URL without an AI report and rejects credential-bearing URLs", () => {
    const { window } = fixture();
    expect(window.readOnboardingTarget(hosted())).toEqual({
      profile: "hosted",
      target: {
        kind: "url",
        role: "staging",
        url: "https://preview.example.test/",
        access: { kind: "public" },
      },
    });
    for (const url of [
      "https://user:password@example.test",
      "https://example.test?token=secret",
      "javascript:alert(1)",
    ])
      expect(() => window.readOnboardingTarget({ ...hosted(), url })).toThrow();
  });
  it("keeps reviewed local runtime commands structured and disallows advanced fields overriding the target", () => {
    const { window } = fixture();
    expect(window.readOnboardingTarget(docker())).toMatchObject({
      profile: "docker",
      target: {
        recipe: { kind: "dockerfile", dockerfile: "Dockerfile", context: "." },
        port: 3000,
        services: [{ kind: "postgres", name: "db", env: "DATABASE_URL" }],
        seed: ["npm", "run", "seed"],
      },
    });
    expect(() =>
      window.readOnboardingTarget({
        ...docker(),
        advanced: '{"role":"production"}',
      }),
    ).toThrow("Advanced settings");
    expect(() =>
      window.readOnboardingTarget({ ...docker(), port: "0" }),
    ).toThrow("port");
  });
  it("preserves saved provider resource identities when configuring password access", () => {
    const { window } = fixture();
    const target = {
      kind: "vercel",
      role: "staging",
      projectId: "prj_shop",
      connectionId: "team-two",
      branch: "pm-staging",
    };
    const input = {
      ...hosted(),
      existing: "preview",
      existingTarget: target,
      accessKind: "password",
      loginPath: "/login",
      usernameSelector: "#email",
      passwordSelector: "#password",
      submitSelector: "#sign-in",
      successSelector: "#dashboard",
      accounts: [
        {
          name: "Viewer",
          usernameSecret: "SHOP_VIEWER_USERNAME",
          passwordSecret: "SHOP_VIEWER_PASSWORD",
        },
      ],
    };
    expect(window.readOnboardingTarget(input)).toMatchObject({
      environment: "preview",
      target: {
        ...target,
        access: { kind: "password", accounts: input.accounts },
      },
    });
    expect(() =>
      window.readOnboardingTarget({ ...input, successSelector: "" }),
    ).toThrow("success selector");
    expect(() =>
      window.readOnboardingTarget({
        ...input,
        accounts: [
          {
            name: "Viewer",
            usernameSecret: "user@example.test",
            passwordSecret: "secret",
          },
        ],
      }),
    ).toThrow("secret references");
    expect(
      window.readOnboardingTarget({ ...input, accessKind: "legacy" }),
    ).toEqual({ profile: "hosted", environment: "preview", target });
  });
});

describe("onboarding draft and request safety", () => {
  it("requires saving a changed test account before using a previous browser result to create a PM", async () => {
    const target = {
      kind: "url",
      role: "staging",
      url: "https://preview.example.test/",
      access: { kind: "public" },
    };
    const f = fixture(
        vi.fn(async () => ({
          ...state(),
          environment: {
            name: "preview",
            profile: "hosted",
            target,
            verification: { status: "passed" },
          },
        })),
      ),
      root = new Element();
    f.panel.mount(root, {
      name: "shop",
      repo: "owner/shop",
      environments: { preview: target },
    });
    await settle();
    const create = walk(root).find(
      (item) => item.textContent === "Create a PM",
    )!;
    expect(create.disabled).toBe(false);
    const input = walk(root).find((item) => item.id === "onboarding-shop-url")!;
    input.value = "https://another-preview.example.test";
    input.fire("input");
    expect(create.disabled).toBe(true);
    await create.fire("click");
    expect(f.created).not.toHaveBeenCalled();
    f.panel.destroy();
  });
  it("keeps a typed URL and its original configuration revision when a refresh reports external edits", async () => {
    let revision = "config-1";
    const api = vi.fn(async (_path: string, _body?: unknown) => ({
      ...state(),
      configurationRevision: revision,
    }));
    const f = fixture(api),
      root = new Element();
    f.panel.mount(root, { name: "shop", repo: "owner/shop", environments: {} });
    await settle();
    const input = walk(root).find((item) => item.id === "onboarding-shop-url")!;
    input.value = "https://my-preview.example.test";
    input.fire("input");
    revision = "config-2";
    await f.panel.refresh("shop");
    expect(input.value).toBe("https://my-preview.example.test");
    expect(f.panel.isDirty()).toBe(true);
    expect(text(root)).toContain("changed elsewhere");
    await walk(root)
      .find((item) => item.textContent === "Save environment")!
      .fire("click");
    expect(api).toHaveBeenCalledWith(
      "/api/projects/shop/onboarding/configure",
      expect.objectContaining({
        configurationRevision: "config-1",
        profile: "hosted",
      }),
    );
    f.panel.destroy();
  });
  it("ignores an obsolete project response after that project was removed", async () => {
    let resolve!: (value: ReturnType<typeof state>) => void;
    const api = vi.fn(
      () =>
        new Promise<ReturnType<typeof state>>((done) => {
          resolve = done;
        }),
    );
    const f = fixture(api),
      first = new Element();
    f.panel.mount(first, { name: "shop", repo: "owner/old" });
    f.panel.forget("shop");
    resolve(state());
    await settle();
    expect(walk(first).some((item) => item.id === "onboarding-shop-url")).toBe(
      false,
    );
    expect(f.saved).not.toHaveBeenCalled();
    f.panel.destroy();
  });
  it("analysis is explicit and cannot create a PM or save an environment", async () => {
    const f = fixture(),
      root = new Element();
    f.panel.mount(root, { name: "shop", repo: "owner/shop" });
    await settle();
    expect(f.api).toHaveBeenCalledTimes(1);
    await walk(root)
      .find((item) => item.textContent === "Analyze repository")!
      .fire("click");
    expect(f.api).toHaveBeenLastCalledWith(
      "/api/projects/shop/onboarding/discover",
      { revision: "analysis-1" },
    );
    expect(f.saved).not.toHaveBeenCalled();
    expect(f.created).not.toHaveBeenCalled();
    f.panel.destroy();
  });
});
