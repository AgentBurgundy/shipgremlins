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
  hidden = false;
  open = false;
  scrollTop = 0;
  focus = vi.fn();
  scrollIntoView = vi.fn();
  showModal() {
    this.open = true;
    this.scrollTop = 500;
  }
  close() {
    this.open = false;
  }
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
  querySelectorAll(selector: string) {
    const tags = selector.split(",").map((value) => value.trim().toUpperCase());
    return walk(this).filter((element) => tags.includes(element.tagName));
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
  isBusy(): boolean;
  resumeHosting(project: string): Promise<void>;
};
function fixture(
  api = vi.fn(async (_path: string, _body?: unknown): Promise<object> =>
    state(),
  ),
  getStatus: () => object | null = () => null,
  onConnectHosting = vi.fn(
    async (_project: object, _connectionId: string) => {},
  ),
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
    dashboardPages: { navigate: vi.fn(() => true) },
    addEventListener() {},
    removeEventListener() {},
    onboardingStep: (_data: unknown) => 0,
    readOnboardingTarget: (draft: Draft): Draft => draft,
    createProjectOnboarding: (_options: object): Panel => ({}) as Panel,
    createVercelSetup: undefined as
      | undefined
      | ((options: {
          onConfigured(): Promise<void>;
          onSelect(input: {
            target: Record<string, unknown>;
            label: string;
            url?: string;
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
    onConnectHosting,
  });
  return { window, document, panel, api, saved, created, onConnectHosting };
}
const state = () => ({
  project: "shop",
  revision: "analysis-1",
  configurationRevision: "config-1",
  status: "idle",
  message: "",
});

describe("environment diagnosis and recovery", () => {
  const passwordTarget = {
    access: {
      kind: "password",
      loginPath: "/sign-in/password",
      usernameSelector: 'input[type="email"]',
      passwordSelector: 'input[type="password"]',
      submitSelector: 'button[type="submit"]',
      successSelector: '[data-testid="account-menu"]',
      accounts: [
        {
          name: "Admin",
          usernameSecret: "TEST_USERNAME",
          passwordSecret: "TEST_PASSWORD",
        },
      ],
    },
  };
  const resultPanel = (root: Element) =>
    walk(root).find((item) => item.className === "onboarding-verification")!;
  const primaryActions = (root: Element) =>
    walk(resultPanel(root))
      .filter(
        (item) =>
          item.tagName === "BUTTON" && item.className.includes("button-dark"),
      )
      .map((item) => item.textContent);

  it("uses the newly saved password access and revision after Vercel workflow repair without sending a public target", async () => {
    let current = vercelState({ ...passwordTarget, branch: "staging" });
    const api = vi.fn(async (_path: string, _body?: unknown) => current),
      f = fixture(api),
      root = new Element();
    let configured!: () => Promise<void>;
    f.window.createVercelSetup = (options) => {
      configured = options.onConfigured;
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
      environments: {
        preview: { ...current.environment.target, access: { kind: "public" } },
      },
    });
    await settle();
    await walk(root)
      .find((item) => item.textContent === "Change Vercel preview")!
      .fire("click");
    current = {
      ...vercelState(passwordTarget),
      configurationRevision: "config-after-workflow",
    };
    api.mockClear();
    await configured();
    expect(api.mock.calls).toEqual([
      ["/api/projects/shop/onboarding"],
      [
        "/api/projects/shop/onboarding/prepare-environment",
        { configurationRevision: "config-after-workflow", force: true },
      ],
    ]);
    expect(f.saved).toHaveBeenCalledWith("shop");
    expect(text(resultPanel(root))).toContain(
      "1 test account · /sign-in/password",
    );
    expect(text(resultPanel(root))).not.toContain("Public app");
    expect(current.environment.target.access).toEqual(passwordTarget.access);
    expect(f.panel.isDirty()).toBe(false);
    f.panel.destroy();
  });

  it("explains a missing bypass value separately from a saved reference and offers one repair", async () => {
    const data = {
      ...vercelState({ bypassSecret: "MISSING_VALUE" }),
      previewAccess: { status: "missing" },
    };
    const api = vi.fn(async () => data),
      f = fixture(api),
      root = new Element();
    f.panel.mount(root, { name: "shop", repo: "owner/shop" });
    await settle();
    expect(text(resultPanel(root))).toContain(
      "credential itself is not in Connections",
    );
    expect(text(resultPanel(root))).toContain("Bypass credential missing");
    expect(primaryActions(root)).toEqual(["Connect preview access"]);
    expect(text(resultPanel(root))).toContain("Not yet tested");
    await walk(resultPanel(root))
      .find((item) => item.textContent === "Connect preview access")!
      .fire("click");
    expect(api).toHaveBeenLastCalledWith(
      "/api/projects/shop/onboarding/vercel/access",
      { configurationRevision: "config-1" },
    );
    f.panel.destroy();
  });

  it("keeps passed checks and opens the exact ambiguous selector without losing a draft", async () => {
    const current = vercelState(passwordTarget);
    const data = {
      ...current,
      previewAccess: { status: "saved" },
      environment: {
        ...current.environment,
        verification: {
          status: "failed",
          checkedAt: "2026-10-06T14:00:00.000Z",
          checks: [
            { name: "Browser opens application", passed: true },
            { name: "Test account 1: login page opens", passed: true },
            { name: "Test account 1: username field", passed: true },
            { name: "Test account 1: submit control", passed: false },
          ],
          diagnosis: {
            code: "selector_ambiguous",
            title: "The sign-in button matches 2 elements.",
            detail:
              "Choose a selector that matches only the password form’s submit button.",
            action: "edit_login",
            field: "submitSelector",
            matchCount: 2,
          },
        },
      },
    };
    const f = fixture(vi.fn(async () => data)),
      root = new Element();
    f.panel.mount(root, { name: "shop", repo: "owner/shop" });
    await settle();
    expect(primaryActions(root)).toEqual(["Fix sign-in settings"]);
    expect(text(resultPanel(root))).toContain(
      "The sign-in button matches 2 elements.",
    );
    expect(text(resultPanel(root))).toContain(
      'Submit button: button[type="submit"]. Matched 2 elements; exactly one is required.',
    );
    expect(text(resultPanel(root))).toContain(
      "Tested login path: /sign-in/password.",
    );
    expect(text(resultPanel(root))).toContain(
      "✓ Passed · Browser opens application",
    );
    expect(text(resultPanel(root))).toContain(
      "! Failed · Test account 1: submit control",
    );
    expect(
      walk(resultPanel(root)).find((item) => item.tagName === "TIME")
        ?.textContent,
    ).toContain("Last checked");
    await walk(root)
      .find((item) => item.textContent === "Edit test account setup")!
      .fire("click");
    const login = walk(root).find(
      (item) => item.id === "onboarding-shop-loginPath",
    )!;
    login.value = "/my-password-form";
    login.fire("input");
    await f.panel.refresh("shop");
    await walk(resultPanel(root))
      .find((item) => item.textContent === "Fix sign-in settings")!
      .fire("click");
    const selector = walk(root).find(
      (item) => item.id === "onboarding-shop-submitSelector",
    )!;
    expect(selector.focus).toHaveBeenCalled();
    expect(selector.attributes.get("aria-invalid")).toBe("true");
    expect(
      walk(root).find(
        (item) =>
          item.attributes.get("aria-label") === "Advanced login selectors",
      )?.open,
    ).toBe(true);
    expect(login.value).toBe("/my-password-form");
    expect(f.panel.isDirty()).toBe(true);
    expect(
      walk(resultPanel(root)).find((item) => item.textContent === "Retry test")
        ?.disabled,
    ).toBe(true);
    expect(text(resultPanel(root))).toContain(
      "These results describe the saved environment",
    );
    selector.value = 'form[data-testid="password-login"] button[type="submit"]';
    selector.fire("input");
    expect(selector.attributes.get("aria-invalid")).toBe("false");
    f.panel.destroy();
  });

  it("names the tested login path and preview origin when the app rejects sign-in origin", async () => {
    const current = vercelState(passwordTarget),
      data = {
        ...current,
        environment: {
          ...current.environment,
          verification: {
            status: "failed",
            diagnosis: {
              code: "login_origin_rejected",
              title: "The app does not trust this preview's sign-in origin",
              detail: "Check the authentication provider's trusted domains.",
              action: "edit_login",
              origin: "https://shop-preview.example.test",
            },
          },
        },
      },
      f = fixture(vi.fn(async () => data)),
      root = new Element();
    f.panel.mount(root, { name: "shop", repo: "owner/shop" });
    await settle();
    expect(text(resultPanel(root))).toContain(
      "Preview origin: https://shop-preview.example.test.",
    );
    expect(text(resultPanel(root))).toContain(
      "Tested login path: /sign-in/password.",
    );
    expect(primaryActions(root)).toEqual(["Fix sign-in settings"]);
    f.panel.destroy();
  });

  it("routes missing account credentials to Connections instead of retesting unchanged settings", async () => {
    const current = vercelState(passwordTarget);
    const data = {
      ...current,
      environment: {
        ...current.environment,
        verification: {
          status: "failed",
          diagnosis: {
            code: "credentials_missing",
            title: "Save the test account credentials.",
            detail: "The username or password is missing from Connections.",
            action: "manage_credentials",
          },
        },
      },
    };
    const f = fixture(vi.fn(async () => data)),
      root = new Element();
    f.panel.mount(root, { name: "shop", repo: "owner/shop" });
    await settle();
    expect(primaryActions(root)).toEqual(["Add test credentials"]);
    await walk(resultPanel(root))
      .find((item) => item.textContent === "Add test credentials")!
      .fire("click");
    expect(f.window.dashboardPages.navigate).toHaveBeenCalledWith(
      "/connections#project-access",
    );
    f.panel.destroy();
  });

  it("keeps verified preview access calm and ready after reloading status", async () => {
    const current = vercelState({
      ...passwordTarget,
      bypassSecret: "SAVED_BYPASS",
    });
    const data = {
      ...current,
      previewAccess: { status: "verified" },
      environment: {
        ...current.environment,
        verification: {
          status: "passed",
          checks: [
            { name: "Browser opens application", passed: true },
            { name: "Test account 1 signs in", passed: true },
          ],
        },
      },
    };
    const f = fixture(vi.fn(async () => data)),
      root = new Element();
    f.panel.mount(root, {
      name: "shop",
      repo: "owner/shop",
      areas: [{ key: "product" }],
    });
    await settle();
    await f.panel.refresh("shop");
    expect(text(resultPanel(root))).toContain("Your crew can explore.");
    expect(text(resultPanel(root))).toContain("1 of 1 accounts signed in");
    expect(text(resultPanel(root))).not.toContain("Connect preview access");
    expect(text(resultPanel(root))).not.toContain("Check preview access");
    expect(text(resultPanel(root))).not.toContain("Not yet tested");
    expect(primaryActions(root)).toEqual(["Open project"]);
    f.panel.destroy();
  });

  it("distinguishes a stored credential from browser-verified access", async () => {
    const data = {
      ...vercelState({ bypassSecret: "SAVED_BYPASS" }),
      previewAccess: { status: "saved" },
    };
    const f = fixture(vi.fn(async () => data)),
      root = new Element();
    f.panel.mount(root, { name: "shop", repo: "owner/shop" });
    await settle();
    expect(text(resultPanel(root))).toContain(
      "Credential saved · browser check pending",
    );
    expect(text(resultPanel(root))).not.toContain(
      "Runner can pass deployment protection",
    );
    expect(primaryActions(root)).toEqual(["Test environment"]);
    f.panel.destroy();
  });

  it("refreshes credential status on returning to the environment and preserves unsaved settings", async () => {
    let status = "missing";
    const api = vi.fn(async () => ({
      ...vercelState(passwordTarget),
      previewAccess: { status },
    }));
    const f = fixture(api),
      root = new Element();
    f.panel.mount(root, { name: "shop", repo: "owner/shop" });
    await settle();
    await walk(root)
      .find((item) => item.textContent === "Edit test account setup")!
      .fire("click");
    const input = walk(root).find(
      (item) => item.id === "onboarding-shop-loginPath",
    )!;
    input.value = "/new-login";
    input.fire("input");
    f.panel.mount(new Element(), { name: "another", repo: "owner/another" });
    await settle();
    status = "saved";
    const returned = new Element();
    f.panel.mount(returned, { name: "shop", repo: "owner/shop" });
    await settle();
    expect(api).toHaveBeenCalledTimes(3);
    expect(text(resultPanel(returned))).toContain(
      "Credential saved · browser check pending",
    );
    expect(input.value).toBe("/new-login");
    expect(f.panel.isDirty()).toBe(true);
    f.panel.destroy();
  });

  it("shows active testing, disables repeated work, and does not reuse an old diagnosis", async () => {
    const current = vercelState(passwordTarget);
    const data = {
      ...current,
      environment: {
        ...current.environment,
        verification: {
          status: "testing",
          diagnosis: { title: "Old failure", action: "edit_login" },
        },
      },
    };
    const f = fixture(vi.fn(async () => data)),
      root = new Element();
    f.panel.mount(root, { name: "shop", repo: "owner/shop" });
    await settle();
    expect(text(resultPanel(root))).toContain("Checking the runner’s access");
    expect(text(resultPanel(root))).not.toContain("Old failure");
    expect(resultPanel(root).attributes.get("aria-busy")).toBe("true");
    expect(
      walk(resultPanel(root)).find(
        (item) => item.textContent === "Testing environment…",
      )?.disabled,
    ).toBe(true);
    f.panel.destroy();
  });
});

describe("automatic Vercel environment setup", () => {
  const managed = (setup?: object, verification?: object) => ({
    ...vercelState(),
    environmentSetupSupported: true,
    ...(setup ? { environmentSetup: setup } : {}),
    environment: {
      ...vercelState().environment,
      ...(verification ? { verification } : {}),
    },
  });
  const automatic = (root: Element) =>
    walk(root).find((item) => item.className === "onboarding-automatic")!;
  const preparing = {
    status: "preparing",
    step: "connect_access",
    message: "Connecting private preview access.",
    configurationRevision: "config-1",
  };
  it("offers first-use OAuth without starting setup and keeps another-host setup accessible", async () => {
    const api = vi.fn(async () => ({
      ...state(),
      environmentSetupSupported: true,
    }));
    const f = fixture(api, () => ({ serviceConnections: [] })),
      root = new Element();
    const project = {
      name: "shop",
      repo: "owner/shop",
      instanceId: "project-one",
    };
    f.panel.mount(root, project);
    await settle();
    expect(automatic(root).hidden).toBe(false);
    expect(text(automatic(root))).toContain("Let your gremlins see the app.");
    expect(api).toHaveBeenCalledTimes(1);
    expect(f.onConnectHosting).not.toHaveBeenCalled();
    f.onConnectHosting.mockImplementation(async () => {
      expect(f.panel.isBusy()).toBe(false);
    });
    await walk(root)
      .find((item) => item.textContent === "Connect Vercel")!
      .fire("click");
    expect(f.onConnectHosting).toHaveBeenCalledWith(project, "default");
    expect(api).toHaveBeenCalledTimes(1);
    await walk(root)
      .find(
        (item) => item.textContent === "Use another host or local environment",
      )!
      .fire("click");
    expect(automatic(root).hidden).toBe(true);
    expect(
      walk(root).find((item) => item.className === "onboarding-choice")?.hidden,
    ).toBe(false);
    f.panel.destroy();
  });
  it("reconnects the saved Vercel account and surfaces rejected authorization without losing edits", async () => {
    const f = fixture(
        vi.fn(async () => ({
          ...vercelState({ connectionId: "testing" }),
          environmentSetupSupported: true,
        })),
        () => ({
          serviceConnections: [
            { provider: "vercel", id: "default", connected: true },
            {
              provider: "vercel",
              id: "testing",
              connected: false,
              needsReconnect: true,
            },
          ],
        }),
      ),
      root = new Element();
    f.panel.mount(root, { name: "shop", repo: "owner/shop" });
    await settle();
    expect(f.api).toHaveBeenCalledTimes(1);
    await walk(root)
      .find(
        (item) => item.textContent === "Use another host or local environment",
      )!
      .fire("click");
    const access = walk(root).find(
      (item) => item.id === "onboarding-shop-access-password",
    )!;
    access.fire("click");
    const input = walk(root).find(
      (item) => item.id === "onboarding-shop-successSelector",
    )!;
    input.value = "#signed-in-account";
    input.fire("input");
    f.onConnectHosting.mockRejectedValue(
      new Error(
        "Save or discard your unsaved edits before authorizing Vercel.",
      ),
    );
    await walk(root)
      .find((item) => item.textContent === "Reconnect Vercel")!
      .fire("click");
    expect(f.onConnectHosting).toHaveBeenCalledWith(
      expect.objectContaining({ name: "shop" }),
      "testing",
    );
    expect(text(root)).toContain("Save or discard your unsaved edits");
    expect(
      walk(root).find((item) => item.id === "onboarding-shop-successSelector")
        ?.value,
    ).toBe("#signed-in-account");
    expect(f.panel.isDirty()).toBe(true);
    expect(f.api).toHaveBeenCalledTimes(1);
    f.panel.destroy();
  });
  it("retries Vercel sign-in from its failure card instead of refreshing unrelated environment status", async () => {
    const f = fixture(
        vi.fn(async () => ({ ...state(), environmentSetupSupported: true })),
        () => ({ serviceConnections: [] }),
      ),
      root = new Element();
    const failure = Object.assign(
      new Error(
        "ShipGremlins’ hosted Vercel sign-in service needs configuration. The ShipGremlins operator must finish that setup.",
      ),
      { code: "oauth_unavailable", availabilityReason: "not_configured" },
    );
    f.onConnectHosting.mockRejectedValueOnce(failure);
    f.panel.mount(root, { name: "shop", repo: "owner/shop" });
    await settle();
    await walk(root)
      .find((item) => item.textContent === "Connect Vercel")!
      .fire("click");
    expect(text(automatic(root))).toContain("ShipGremlins operator");
    expect(text(automatic(root))).toContain(
      "prepare private access and verify it from your runner",
    );
    expect(
      walk(root).filter((item) => item.textContent === "Refresh status"),
    ).toHaveLength(0);
    expect(
      walk(automatic(root)).filter(
        (item) => item.textContent === "Connect Vercel",
      ),
    ).toHaveLength(0);
    const retry = walk(automatic(root)).find(
      (item) => item.textContent === "Check Vercel sign-in again",
    )!;
    expect(retry.disabled).toBe(false);
    let finish!: () => void;
    f.onConnectHosting.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const retrying = retry.fire("click");
    expect(
      walk(automatic(root)).find(
        (item) => item.textContent === "Checking Vercel sign-in…",
      )?.disabled,
    ).toBe(true);
    expect(f.panel.isBusy()).toBe(false);
    finish();
    await retrying;
    expect(f.onConnectHosting).toHaveBeenCalledTimes(2);
    expect(f.api).toHaveBeenCalledTimes(1);
    expect(text(automatic(root))).not.toContain("ShipGremlins operator");
    f.panel.destroy();
  });
  it("shows known hosted sign-in configuration failure without asking users to connect first", async () => {
    const f = fixture(
        vi.fn(async () => ({ ...state(), environmentSetupSupported: true })),
        () => ({
          serviceConnections: [
            {
              id: "default",
              provider: "vercel",
              connected: false,
              available: false,
              availabilityReason: "not_configured",
              message:
                "The ShipGremlins operator must configure hosted Vercel sign-in.",
            },
          ],
        }),
      ),
      root = new Element();
    f.panel.mount(root, { name: "shop", repo: "owner/shop" });
    await settle();
    expect(
      walk(automatic(root)).find(
        (item) => item.textContent === "Connect Vercel",
      ),
    ).toBeUndefined();
    expect(text(automatic(root))).toContain("ShipGremlins operator");
    await walk(automatic(root))
      .find((item) => item.textContent === "Check Vercel sign-in again")!
      .fire("click");
    expect(f.onConnectHosting).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ name: "shop" }),
      "default",
    );
    expect(f.api).toHaveBeenCalledTimes(1);
    f.panel.destroy();
  });
  it("clears a prior sign-in failure when the saved Vercel account becomes connected elsewhere", async () => {
    let connected = false;
    const f = fixture(
        vi.fn(async () => ({
          ...vercelState(),
          environmentSetupSupported: true,
        })),
        () => ({
          serviceConnections: [
            { id: "default", provider: "vercel", connected },
          ],
        }),
      ),
      root = new Element();
    f.onConnectHosting.mockRejectedValueOnce(
      new Error("The sign-in service is unavailable."),
    );
    f.panel.mount(root, { name: "shop", repo: "owner/shop" });
    await settle();
    await walk(automatic(root))
      .find((item) => item.textContent === "Connect Vercel")!
      .fire("click");
    expect(text(automatic(root))).toContain(
      "The sign-in service is unavailable.",
    );
    connected = true;
    expect(() => f.panel.syncConnections()).not.toThrow();
    expect(automatic(root).hidden).toBe(true);
    await f.panel.refresh("shop");
    expect(automatic(root).hidden).toBe(true);
    expect(
      walk(root).find((item) => item.className === "onboarding-message")
        ?.children,
    ).toHaveLength(0);
    expect(f.panel.isDirty()).toBe(false);
    f.panel.destroy();
  });
  it("opens manual hosting despite a known Vercel sign-in outage without an environment setup result", async () => {
    const f = fixture(
        vi.fn(async () => ({ ...state(), environmentSetupSupported: true })),
        () => ({
          serviceConnections: [
            {
              id: "default",
              provider: "vercel",
              connected: false,
              available: false,
              availabilityReason: "not_configured",
              message:
                "The ShipGremlins operator must configure hosted Vercel sign-in.",
            },
          ],
        }),
      ),
      root = new Element();
    f.panel.mount(root, { name: "shop", repo: "owner/shop" });
    await settle();
    const manual = walk(automatic(root)).find(
      (item) => item.textContent === "Use another host or local environment",
    )!;
    expect(() => manual.fire("click")).not.toThrow();
    expect(automatic(root).hidden).toBe(true);
    expect(
      walk(root).find((item) => item.className === "onboarding-choice")?.hidden,
    ).toBe(false);
    expect(() => f.panel.syncConnections()).not.toThrow();
    expect(automatic(root).hidden).toBe(true);
    expect(f.onConnectHosting).not.toHaveBeenCalled();
    expect(f.api).toHaveBeenCalledTimes(1);
    f.panel.destroy();
  });
  it("discards an old account failure after the saved Vercel target changes", async () => {
    let account = "old-account";
    const f = fixture(
        vi.fn(async () => ({
          ...vercelState({
            connectionId: account,
            projectId: `project-${account}`,
          }),
          environmentSetupSupported: true,
        })),
        () => ({
          serviceConnections: [
            {
              id: "old-account",
              provider: "vercel",
              connected: false,
              needsReconnect: true,
            },
            {
              id: "new-account",
              provider: "vercel",
              connected: false,
              needsReconnect: true,
            },
          ],
        }),
      ),
      root = new Element();
    f.onConnectHosting.mockRejectedValueOnce(
      new Error("The old account's authorization failed."),
    );
    f.panel.mount(root, { name: "shop", repo: "owner/shop" });
    await settle();
    await walk(automatic(root))
      .find((item) => item.textContent === "Reconnect Vercel")!
      .fire("click");
    expect(text(automatic(root))).toContain(
      "old account's authorization failed",
    );
    account = "new-account";
    await f.panel.refresh("shop");
    expect(text(automatic(root))).not.toContain(
      "old account's authorization failed",
    );
    expect(
      walk(automatic(root)).find(
        (item) => item.textContent === "Retry Vercel sign-in",
      ),
    ).toBeUndefined();
    await walk(automatic(root))
      .find((item) => item.textContent === "Reconnect Vercel")!
      .fire("click");
    expect(f.onConnectHosting.mock.calls.map(([, id]) => id)).toEqual([
      "old-account",
      "new-account",
    ]);
    expect(f.panel.isDirty()).toBe(false);
    f.panel.destroy();
  });
  it("reconnects the account that actually failed, then resumes setup once without reconnecting the healthy default", async () => {
    let expired = true;
    const blocked = () => ({
      ...state(),
      environmentSetupSupported: true,
      environmentSetup: {
        status: "needs_input",
        step: "find_preview",
        action: "connect_vercel",
        connectionId: "team-previews",
        message: "The Vercel account needs to be reconnected.",
      },
    });
    const api = vi.fn(async (path: string, _body?: unknown) =>
      path.endsWith("/prepare-environment")
        ? { ...blocked(), environmentSetup: preparing }
        : blocked(),
    );
    const f = fixture(api, () => ({
        serviceConnections: [
          { provider: "vercel", id: "default", connected: true },
          {
            provider: "vercel",
            id: "team-previews",
            name: "Team previews",
            connected: !expired,
            needsReconnect: expired,
          },
        ],
      })),
      root = new Element();
    const project = { name: "shop", repo: "owner/shop" };
    f.panel.mount(root, project);
    await settle();
    expect(api).toHaveBeenCalledTimes(1);
    expect(text(automatic(root))).toContain("Vercel account: Team previews");
    expect(text(automatic(root))).toContain(
      "The Vercel account needs to be reconnected.",
    );
    await walk(root)
      .find((item) => item.textContent === "Reconnect Vercel")!
      .fire("click");
    expect(f.onConnectHosting).toHaveBeenCalledExactlyOnceWith(
      project,
      "team-previews",
    );
    expired = false;
    f.panel.syncConnections();
    await f.panel.resumeHosting("shop");
    await settle();
    await f.panel.resumeHosting("shop");
    expect(
      api.mock.calls.filter(([path]) => path.endsWith("/prepare-environment")),
    ).toEqual([
      [
        "/api/projects/shop/onboarding/prepare-environment",
        { configurationRevision: "config-1", force: true },
      ],
    ]);
    f.panel.destroy();
  });
  it("does not replace a saved non-Vercel environment with a hosting prompt", async () => {
    const api = vi.fn(async () => ({
      ...state(),
      environmentSetupSupported: true,
      environment: {
        name: "staging",
        profile: "hosted",
        target: {
          kind: "url",
          role: "staging",
          url: "https://staging.example",
        },
      },
    }));
    const f = fixture(api, () => ({ serviceConnections: [] })),
      root = new Element();
    f.panel.mount(root, { name: "shop", repo: "owner/shop" });
    await settle();
    await f.panel.resumeHosting("shop");
    expect(automatic(root).hidden).toBe(true);
    expect(text(root)).not.toContain("Connect Vercel");
    expect(api).toHaveBeenCalledTimes(1);
    f.panel.destroy();
  });
  it("keeps an implicit default account binding instead of using a different connected Vercel account", async () => {
    const f = fixture(
        vi.fn(async () => ({
          ...vercelState(),
          environmentSetupSupported: true,
        })),
        () => ({
          serviceConnections: [
            {
              provider: "vercel",
              id: "default",
              connected: false,
              needsReconnect: true,
            },
            { provider: "vercel", id: "other-account", connected: true },
          ],
        }),
      ),
      root = new Element();
    f.panel.mount(root, { name: "shop", repo: "owner/shop" });
    await settle();
    expect(f.api).toHaveBeenCalledTimes(1);
    await walk(root)
      .find((item) => item.textContent === "Reconnect Vercel")!
      .fire("click");
    expect(f.onConnectHosting).toHaveBeenCalledWith(
      expect.objectContaining({ name: "shop" }),
      "default",
    );
    f.panel.destroy();
  });
  it("resumes a prior OAuth blocker once with freshly loaded configuration after return", async () => {
    let connected = false,
      revision = "config-before-oauth";
    const blocked = () => ({
      ...state(),
      configurationRevision: revision,
      environmentSetupSupported: true,
      environmentSetup: {
        status: "needs_input",
        step: "find_preview",
        action: "connect_vercel",
        message: "Connect Vercel first.",
        configurationRevision: revision,
      },
    });
    const api = vi.fn(async (path: string, _body?: unknown) =>
      path.endsWith("/prepare-environment")
        ? { ...blocked(), environmentSetup: preparing }
        : blocked(),
    );
    const f = fixture(api, () => ({
        serviceConnections: [{ provider: "vercel", id: "default", connected }],
      })),
      root = new Element();
    f.panel.mount(root, { name: "shop", repo: "owner/shop" });
    await settle();
    connected = true;
    revision = "config-after-oauth";
    await f.panel.resumeHosting("shop");
    await settle();
    expect(api).toHaveBeenCalledWith(
      "/api/projects/shop/onboarding/prepare-environment",
      { configurationRevision: "config-after-oauth", force: true },
    );
    await f.panel.resumeHosting("shop");
    await settle();
    expect(
      api.mock.calls.filter(([path]) => path.endsWith("/prepare-environment")),
    ).toHaveLength(1);
    f.panel.destroy();
  });
  it("joins the initial fresh read on OAuth return without duplicating automatic setup", async () => {
    let resolveRead!: (value: object) => void;
    const api = vi.fn(async (path: string, _body?: unknown): Promise<object> =>
      path.endsWith("/prepare-environment")
        ? {
            ...state(),
            environmentSetupSupported: true,
            environmentSetup: preparing,
          }
        : new Promise((resolve) => {
            resolveRead = resolve;
          }),
    );
    const f = fixture(api, () => ({
      serviceConnections: [
        { provider: "vercel", id: "default", connected: true },
      ],
    }));
    f.panel.mount(new Element(), {
      name: "shop",
      repo: "owner/shop",
      instanceId: "one",
    });
    await f.panel.resumeHosting("shop");
    resolveRead({ ...state(), environmentSetupSupported: true });
    await settle();
    expect(
      api.mock.calls.filter(([path]) => path.endsWith("/prepare-environment")),
    ).toHaveLength(1);
    expect(api).toHaveBeenCalledWith(
      "/api/projects/shop/onboarding/prepare-environment",
      { configurationRevision: "config-1" },
    );
    f.panel.destroy();
  });
  it("abandons a pending OAuth resume when its project is removed or the fresh read fails", async () => {
    for (const removed of [true, false]) {
      let failRead!: (error: Error) => void,
        completeRead!: (value: object) => void;
      const api = vi.fn(
        async (_path: string, _body?: unknown): Promise<object> =>
          new Promise((resolve, reject) => {
            completeRead = resolve;
            failRead = reject;
          }),
      );
      const f = fixture(api, () => ({
        serviceConnections: [
          { provider: "vercel", id: "default", connected: true },
        ],
      }));
      f.panel.mount(new Element(), {
        name: "shop",
        repo: "owner/shop",
        instanceId: "one",
      });
      await f.panel.resumeHosting("shop");
      if (removed) {
        f.panel.forget("shop");
        completeRead({ ...state(), environmentSetupSupported: true });
      } else failRead(new Error("Refresh failed"));
      await settle();
      expect(
        api.mock.calls.filter(([path]) =>
          path.endsWith("/prepare-environment"),
        ),
      ).toEqual([]);
      f.panel.destroy();
    }
  });

  it("prepares a saved Vercel environment once and never retries a blocker on polls or return", async () => {
    let data = managed();
    const api = vi.fn(async (path: string, _body?: unknown) => {
      if (path.endsWith("/prepare-environment")) data = managed(preparing);
      return data;
    });
    const f = fixture(api),
      root = new Element();
    f.panel.mount(root, { name: "shop", repo: "owner/shop" });
    await settle();
    await settle();
    expect(api).toHaveBeenCalledWith(
      "/api/projects/shop/onboarding/prepare-environment",
      { configurationRevision: "config-1" },
    );
    expect(automatic(root).hidden).toBe(false);
    expect(text(automatic(root))).toContain("Getting your crew connected.");
    expect(
      walk(root).find((item) => item.className === "onboarding-verification")
        ?.hidden,
    ).toBe(true);
    await f.panel.refresh("shop");
    data = managed({
      status: "needs_input",
      step: "test_access",
      action: "manage_credentials",
      message: "Save the test account password.",
      configurationRevision: "config-1",
    });
    await f.panel.refresh("shop");
    expect(text(automatic(root))).toContain("Save the test account password.");
    f.panel.mount(new Element(), { name: "other", repo: "owner/other" });
    await settle();
    f.panel.mount(new Element(), { name: "shop", repo: "owner/shop" });
    await settle();
    expect(
      api.mock.calls.filter(([path]) => path.endsWith("/prepare-environment")),
    ).toHaveLength(1);
    f.panel.destroy();
  });
  it("guides the one-time protected-preview secret setup and verifies it without reconnecting Vercel", async () => {
    const blocked = {
      ...managed({
        status: "needs_input",
        step: "connect_access",
        action: "manage_credentials",
        message:
          "Your Vercel account is connected. Protected previews need a one-time Protection Bypass for Automation secret saved in Connections → Project access.",
      }),
      environment: vercelState({
        bypassSecret: "VERCEL_BYPASS_EXISTING_REFERENCE",
      }).environment,
    };
    const api = vi.fn(async (path: string, _body?: unknown) =>
      path.endsWith("/prepare-environment")
        ? {
            ...blocked,
            environmentSetup: { status: "ready", step: "test_access" },
            environment: {
              ...blocked.environment,
              verification: { status: "passed" },
            },
          }
        : blocked,
    );
    const f = fixture(api, () => ({
        serviceConnections: [
          { provider: "vercel", id: "default", connected: true },
        ],
      })),
      root = new Element();
    f.panel.mount(root, { name: "shop", repo: "owner/shop" });
    await settle();
    expect(text(automatic(root))).toContain(
      "One-time access for your protected preview",
    );
    expect(text(automatic(root))).toContain("“Vercel preview access” for shop");
    expect(text(automatic(root))).not.toContain("Reconnect Vercel");
    expect(text(automatic(root))).not.toContain("Try setup again");
    expect(text(automatic(root))).not.toContain("Add test credentials");
    await walk(automatic(root))
      .find((item) => item.textContent === "Add preview access secret")!
      .fire("click");
    expect(f.window.dashboardPages.navigate).toHaveBeenCalledWith(
      "/connections#project-access",
    );
    await f.panel.refresh("shop");
    expect(
      api.mock.calls.filter(([path]) => path.endsWith("/prepare-environment")),
    ).toHaveLength(0);
    await walk(automatic(root))
      .find((item) => item.textContent === "Verify preview access")!
      .fire("click");
    expect(
      api.mock.calls.filter(([path]) => path.endsWith("/prepare-environment")),
    ).toEqual([
      [
        "/api/projects/shop/onboarding/prepare-environment",
        { configurationRevision: "config-1", force: true },
      ],
    ]);
    expect(f.onConnectHosting).not.toHaveBeenCalled();
    expect(f.panel.isDirty()).toBe(false);
    expect(automatic(root).hidden).toBe(true);
    f.panel.destroy();
  });

  it("starts discovery when Vercel is connected and no environment has been selected", async () => {
    const api = vi.fn(async (path: string, _body?: unknown) => ({
      ...state(),
      environmentSetupSupported: true,
      ...(path.endsWith("/prepare-environment")
        ? { environmentSetup: preparing }
        : {}),
    }));
    const f = fixture(api, () => ({
        serviceConnections: [
          { provider: "vercel", id: "default", connected: true },
        ],
      })),
      root = new Element();
    f.panel.mount(root, { name: "shop", repo: "owner/shop" });
    await settle();
    await settle();
    expect(
      api.mock.calls.filter(([path]) => path.endsWith("/prepare-environment")),
    ).toHaveLength(1);
    expect(text(automatic(root))).toContain("Getting your crew connected.");
    f.panel.destroy();
  });

  it("does not auto-prepare an already verified environment, a disconnected account, or an unsaved draft", async () => {
    const ready = fixture(
      vi.fn(async () => managed(undefined, { status: "passed" })),
    );
    ready.panel.mount(new Element(), { name: "shop", repo: "owner/shop" });
    await settle();
    expect(ready.api).toHaveBeenCalledTimes(1);
    ready.panel.destroy();
    const disconnected = fixture(
      vi.fn(async () => ({ ...state(), environmentSetupSupported: true })),
      () => ({
        serviceConnections: [
          { provider: "vercel", connected: false, needsReconnect: true },
        ],
      }),
    );
    disconnected.panel.mount(new Element(), {
      name: "shop",
      repo: "owner/shop",
    });
    await settle();
    expect(disconnected.api).toHaveBeenCalledTimes(1);
    disconnected.panel.destroy();
    let enabled = false;
    const api = vi.fn(async (_path: string, _body?: unknown) => ({
        ...vercelState(),
        environmentSetupSupported: enabled,
      })),
      f = fixture(api),
      root = new Element();
    f.panel.mount(root, { name: "shop", repo: "owner/shop" });
    await settle();
    const input = walk(root).find(
      (item) => item.id === "onboarding-shop-vercelBypassSecret",
    )!;
    input.value = "MY_CHANGED_REFERENCE";
    input.fire("input");
    f.panel.mount(new Element(), { name: "other", repo: "owner/other" });
    await settle();
    enabled = true;
    f.panel.mount(new Element(), { name: "shop", repo: "owner/shop" });
    await settle();
    expect(
      api.mock.calls.filter(([path]) => path.endsWith("/prepare-environment")),
    ).toHaveLength(0);
    expect(f.panel.isDirty()).toBe(true);
    f.panel.destroy();
  });

  it("forces the complete orchestration for Test again instead of returning an old ready result", async () => {
    const api = vi.fn(async (_path: string, _body?: unknown) =>
        managed({ status: "ready", step: "test_access" }, { status: "passed" }),
      ),
      f = fixture(api),
      root = new Element();
    f.panel.mount(root, { name: "shop", repo: "owner/shop" });
    await settle();
    await walk(root)
      .find((item) => item.textContent === "Test again")!
      .fire("click");
    expect(api).toHaveBeenLastCalledWith(
      "/api/projects/shop/onboarding/prepare-environment",
      { configurationRevision: "config-1", force: true },
    );
    f.panel.destroy();
  });

  it("leaves an unfinished idea foundation alone even when Vercel is connected", async () => {
    const api = vi.fn(async (_path: string, _body?: unknown) => ({
      ...state(),
      environmentSetupSupported: true,
      foundation: {
        stage: "review-code",
        message: "Review the foundation PR first.",
      },
    }));
    const f = fixture(api, () => ({
      serviceConnections: [{ provider: "vercel", connected: true }],
    }));
    f.panel.mount(new Element(), {
      name: "shop",
      repo: "owner/shop",
      ideaPlanId: "idea-1",
    });
    await settle();
    expect(
      api.mock.calls.filter(([path]) => path.endsWith("/prepare-environment")),
    ).toHaveLength(0);
    f.panel.destroy();
  });

  it("keeps a submitted draft until its exact saved target is observed, then enables the ready result", async () => {
    const access = {
      kind: "password",
      loginPath: "/login",
      usernameSelector: 'input[type="email"]',
      passwordSelector: 'input[type="password"]',
      submitSelector: 'button[type="submit"]',
      successSelector: "#account",
      accounts: [
        {
          name: "Admin",
          usernameSecret: "TEST_USER",
          passwordSecret: "TEST_PASSWORD",
        },
      ],
    };
    let data = {
      ...managed(
        { status: "ready", step: "test_access" },
        { status: "passed" },
      ),
      environment: {
        ...vercelState({ access }).environment,
        verification: { status: "passed" },
      },
    };
    let target: Record<string, unknown> | undefined;
    const api = vi.fn(async (path: string, body?: unknown) => {
      if (path.endsWith("/prepare-environment")) {
        target = (body as { target: Record<string, unknown> }).target;
        data = { ...data, environmentSetup: preparing };
      }
      return data;
    });
    const f = fixture(api),
      root = new Element();
    f.panel.mount(root, { name: "shop", repo: "owner/shop" });
    await settle();
    await walk(root)
      .find((item) => item.textContent === "Edit test account setup")!
      .fire("click");
    const input = walk(root).find(
      (item) => item.id === "onboarding-shop-loginPath",
    )!;
    input.value = "/sign-in/password";
    input.fire("input");
    await walk(root)
      .find((item) => item.textContent === "Save & set up environment")!
      .fire("click");
    expect(f.panel.isDirty()).toBe(true);
    expect(input.disabled).toBe(true);
    expect((target?.access as typeof access).loginPath).toBe(
      "/sign-in/password",
    );
    data = {
      ...data,
      configurationRevision: "config-2",
      environmentSetup: { status: "ready", step: "test_access" },
      environment: {
        ...vercelState({ ...target, bypassSecret: "MANAGED_BYPASS" })
          .environment,
        verification: { status: "passed" },
      },
    };
    await f.panel.refresh("shop");
    expect(f.panel.isDirty()).toBe(false);
    expect(f.saved).toHaveBeenCalledWith("shop");
    expect(text(root)).not.toContain("Project settings changed elsewhere");
    expect(automatic(root).hidden).toBe(true);
    expect(
      walk(root).find((item) => item.textContent === "Create a PM")?.disabled,
    ).toBe(false);
    f.panel.destroy();
  });

  it("turns an exact preview choice into one prepare request without separate save or access calls", async () => {
    const target = {
      kind: "vercel",
      role: "preview",
      projectId: "prj_web",
      connectionId: "default",
      branch: "pm-staging",
    };
    const data = {
      ...state(),
      environmentSetupSupported: true,
      environmentSetup: {
        status: "needs_input",
        step: "find_preview",
        action: "choose_preview",
        message: "Two apps use this repository.",
        choices: [
          {
            name: "Web app",
            rootDirectory: "apps/web",
            branch: "pm-staging",
            connectionId: "default",
            projectId: "prj_web",
            target,
          },
        ],
      },
    };
    const api = vi.fn(async (_path: string, _body?: unknown) => data),
      f = fixture(api),
      root = new Element();
    f.panel.mount(root, { name: "shop", repo: "owner/shop" });
    await settle();
    await walk(root)
      .find((item) => item.id === "onboarding-shop-access-public")!
      .fire("click");
    const choice = walk(automatic(root)).find(
      (item) => item.className === "environment-preview-choice",
    )!;
    expect(text(choice)).toContain("apps/web");
    await choice.fire("click");
    expect(api).toHaveBeenLastCalledWith(
      "/api/projects/shop/onboarding/prepare-environment",
      {
        configurationRevision: "config-1",
        target: { ...target, access: { kind: "public" } },
      },
    );
    expect(api.mock.calls.filter(([, body]) => body)).toHaveLength(1);
    f.panel.destroy();
  });
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
const vercelState = (target: Record<string, unknown> = {}) => ({
  ...state(),
  environment: {
    name: "preview",
    profile: "hosted",
    target: {
      kind: "vercel",
      role: "preview",
      projectId: "prj_test",
      branch: "pm-staging",
      access: { kind: "public" },
      ...target,
    },
  },
});

describe("recommended Docker browser setup", () => {
  const target = {
    kind: "docker",
    role: "staging",
    recipe: {
      kind: "dockerfile",
      dockerfile: "examples/dashboard-test/Dockerfile",
      context: ".",
    },
    port: 3000,
    healthPath: "/fixture/health",
    access: { kind: "public" },
  };
  const recommendation = () => ({
    ...state(),
    status: "analyzed",
    stale: true,
    environmentSetupSupported: true,
    report: { recommendation: "docker", docker: target },
    recommendedDocker: {
      status: "ready",
      message: "Use the inspected dashboard fixture.",
      blockers: [],
      environment: "local-test",
      target,
    },
  });
  const connectedVercel = () => ({
    serviceConnections: [
      { provider: "vercel", id: "default", connected: true },
    ],
  });
  const card = (root: Element) =>
    walk(root).find(
      (item) => item.className === "onboarding-docker-recommendation",
    )!;
  const action = (root: Element, label: string) =>
    walk(root).find(
      (item) => item.tagName === "BUTTON" && item.textContent === label,
    )!;
  const project = {
    name: "shop",
    repo: "owner/shop",
    verification: { mode: "repository" },
  };

  it("offers the source-validated Docker recipe despite unrelated setup staleness and never auto-picks connected Vercel", async () => {
    const api = vi.fn(async (_path: string, _body?: unknown) =>
        recommendation(),
      ),
      f = fixture(api, connectedVercel),
      root = new Element();
    f.panel.mount(root, project);
    await settle();
    expect(api).toHaveBeenCalledExactlyOnceWith(
      "/api/projects/shop/onboarding",
    );
    expect(card(root).hidden).toBe(false);
    expect(text(card(root))).toContain("Currently checking code only");
    expect(text(card(root))).toContain("examples/dashboard-test/Dockerfile");
    expect(
      walk(root).find((item) => item.className === "onboarding-automatic")!
        .hidden,
    ).toBe(true);
    expect(action(root, "Set up Docker & test").disabled).toBe(false);
    await action(root, "Review environment settings").fire("click");
    expect(
      walk(root).find((item) => item.id === "onboarding-shop-dockerfile")
        ?.value,
    ).toBe(target.recipe.dockerfile);
    expect(f.panel.isDirty()).toBe(false);
    expect(f.created).not.toHaveBeenCalled();
    f.panel.destroy();
  });

  it("sends only reviewed revisions on click and shows actual probe progress before a pass", async () => {
    let data: object = recommendation();
    const api = vi.fn(async (path: string, _body?: unknown) => {
      if (path.endsWith("/prepare-docker"))
        data = {
          ...recommendation(),
          configurationRevision: "config-docker",
          environment: {
            name: "local-test",
            profile: "docker",
            target,
            verification: { status: "testing" },
          },
          recommendedDocker: {
            ...recommendation().recommendedDocker,
            status: "configured",
          },
        };
      return data;
    });
    const f = fixture(api, connectedVercel),
      root = new Element();
    f.panel.mount(root, project);
    await settle();
    await action(root, "Set up Docker & test").fire("click");
    expect(api.mock.calls.filter(([, body]) => body)).toEqual([
      [
        "/api/projects/shop/onboarding/prepare-docker",
        { revision: "analysis-1", configurationRevision: "config-1" },
      ],
    ]);
    expect(f.saved).toHaveBeenCalledExactlyOnceWith("shop");
    expect(f.panel.isDirty()).toBe(false);
    expect(card(root).hidden).toBe(true);
    expect(text(root)).toContain("saved recipe is not a passing test");
    expect(
      walk(root).find((item) => item.className === "onboarding-verification")!
        .hidden,
    ).toBe(false);
    expect(f.created).not.toHaveBeenCalled();
    f.panel.destroy();
  });

  it("keeps manual edits and disables the shortcut across status refreshes", async () => {
    const api = vi.fn(async (_path: string, _body?: unknown) =>
        recommendation(),
      ),
      f = fixture(api),
      root = new Element();
    f.panel.mount(root, project);
    await settle();
    await action(root, "Review environment settings").fire("click");
    const dockerfile = walk(root).find(
      (item) => item.id === "onboarding-shop-dockerfile",
    )!;
    dockerfile.value = "custom/Dockerfile";
    dockerfile.fire("input");
    expect(f.panel.isDirty()).toBe(true);
    expect(action(root, "Set up Docker & test").disabled).toBe(true);
    await f.panel.refresh("shop");
    expect(walk(root).find((item) => item.id === dockerfile.id)!.value).toBe(
      "custom/Dockerfile",
    );
    expect(f.panel.isDirty()).toBe(true);
    await action(root, "Set up Docker & test").fire("click");
    expect(api.mock.calls.filter(([, body]) => body)).toEqual([]);
    f.panel.destroy();
  });

  it("shows a source-change refusal without claiming a configured environment or retrying", async () => {
    const api = vi.fn(async (_path: string, body?: unknown) => {
        if (body)
          throw new Error("The inspected source changed. Analyze again.");
        return recommendation();
      }),
      f = fixture(api),
      root = new Element();
    f.panel.mount(root, project);
    await settle();
    await action(root, "Set up Docker & test").fire("click");
    expect(text(root)).toContain("The inspected source changed");
    expect(text(root)).not.toContain("Local Docker setup saved");
    expect(card(root).hidden).toBe(false);
    expect(f.saved).not.toHaveBeenCalled();
    await f.panel.refresh("shop");
    expect(api.mock.calls.filter(([, body]) => body)).toHaveLength(1);
    f.panel.destroy();
  });

  it("shows required local setup blockers and opens review without writing a target", async () => {
    const data = recommendation();
    Object.assign(data.recommendedDocker, {
      status: "blocked",
      target: undefined,
      message: "A database connection is required.",
      blockers: ["A database connection is required."],
    });
    const api = vi.fn(async (_path: string, _body?: unknown) => data),
      f = fixture(api, connectedVercel),
      root = new Element();
    f.panel.mount(root, project);
    await settle();
    expect(action(root, "Set up Docker & test")).toBeUndefined();
    expect(text(card(root))).toContain("A database connection is required.");
    await action(root, "Review local setup").fire("click");
    expect(
      walk(root).find((item) => item.className === "onboarding-choice")!.hidden,
    ).toBe(false);
    expect(api.mock.calls.filter(([, body]) => body)).toEqual([]);
    f.panel.destroy();
  });

  it.each([undefined, { recommendation: "hosted" }])(
    "keeps Vercel onboarding when Docker is unavailable for report %j",
    async (report) => {
      const data = {
        ...state(),
        environmentSetupSupported: true,
        ...(report ? { report } : {}),
        recommendedDocker: {
          status: "blocked",
          message: "The report does not recommend Docker.",
          blockers: [],
        },
      };
      const api = vi.fn(async (_path: string, body?: unknown) => ({
          ...data,
          ...(body
            ? {
                environmentSetup: {
                  status: "preparing",
                  step: "find_preview",
                  message: "Finding preview.",
                },
              }
            : {}),
        })),
        f = fixture(api, connectedVercel),
        root = new Element();
      f.panel.mount(root, project);
      await settle();
      expect(card(root).hidden).toBe(true);
      expect(
        walk(root).find((item) => item.className === "onboarding-automatic")!
          .hidden,
      ).toBe(false);
      expect(api).toHaveBeenCalledWith(
        "/api/projects/shop/onboarding/prepare-environment",
        { configurationRevision: "config-1" },
      );
      f.panel.destroy();
    },
  );

  it("keeps an already selected Vercel environment and hides local preparation", async () => {
    const api = vi.fn(async () => ({
        ...recommendation(),
        ...vercelState(),
        environment: {
          ...vercelState().environment,
          verification: { status: "passed" },
        },
        recommendedDocker: {
          status: "blocked",
          message: "A different browser environment is selected.",
          blockers: [],
        },
      })),
      f = fixture(api, connectedVercel),
      root = new Element();
    f.panel.mount(root, project);
    await settle();
    expect(card(root).hidden).toBe(true);
    expect(api).toHaveBeenCalledTimes(1);
    expect(text(root)).not.toContain("Run this app in Docker");
    f.panel.destroy();
  });
});

describe("explicit app sign-in onboarding", () => {
  const accessPanel = (root: Element) =>
    walk(root).find((item) => item.className === "onboarding-app-access")!;
  const chooseAccess = (root: Element, kind: string) =>
    walk(root)
      .find((item) => item.id === `onboarding-shop-access-${kind}`)!
      .fire("click");

  const detectedRecipe = {
    loginPath: "/sign-in/password",
    usernameSelector: "#email",
    passwordSelector: "#password",
    submitSelector: "#sign-in",
    successSelector: '[data-testid="account-menu"]',
  };
  const detectedState = (kind = "password", stale = false) => ({
    ...vercelState({ access: undefined }),
    stale,
    report: {
      projectSetup: {
        appAccess: {
          kind,
          summary: "Inspected the application's actual login UI.",
          ...(kind === "password" ? { password: detectedRecipe } : {}),
          evidence: [{ path: "src/login.tsx", quote: "password" }],
        },
      },
    },
  });
  function fillLoginControls(root: Element) {
    for (const key of [
      "loginPath",
      "usernameSelector",
      "passwordSelector",
      "submitSelector",
    ] as const) {
      const input = walk(root).find(
        (item) => item.id === `onboarding-shop-${key}`,
      )!;
      input.value = detectedRecipe[key];
      input.fire("input");
    }
  }
  it("does not save guessed login paths or selectors for an account-only draft", async () => {
    const api = vi.fn(async () => vercelState({ access: undefined })),
      f = fixture(api),
      root = new Element();
    f.panel.mount(root, { name: "shop", repo: "owner/shop" });
    await settle();
    await chooseAccess(root, "password");
    for (const key of [
      "loginPath",
      "usernameSelector",
      "passwordSelector",
      "submitSelector",
      "successSelector",
    ])
      expect(
        walk(root).find((item) => item.id === `onboarding-shop-${key}`)!.value,
      ).toBe("");
    for (const [key, value] of [
      ["loginPath", "/my-login"],
      ["successSelector", "#account-menu"],
    ] as const) {
      const input = walk(root).find(
        (item) => item.id === `onboarding-shop-${key}`,
      )!;
      input.value = value;
      input.fire("input");
    }
    await walk(root)
      .find((item) => item.textContent === "Save & add test credentials")!
      .fire("click");
    expect(api.mock.calls.filter((args) => args.length > 1)).toHaveLength(0);
    expect(f.window.dashboardPages.navigate).not.toHaveBeenCalled();
    expect(text(root)).toContain("We do not guess your app’s login form");
    f.panel.destroy();
  });
  it("applies a detected login recipe without manual CSS and preserves the selected Vercel environment", async () => {
    const current = detectedState(),
      api = vi.fn(async (_path: string, _body?: unknown) => current),
      f = fixture(api),
      root = new Element();
    f.panel.mount(root, {
      name: "shop",
      instanceId: "new-instance",
      repo: "owner/shop",
    });
    await settle();
    expect(api.mock.calls.filter(([, body]) => body)).toHaveLength(0);
    await walk(root)
      .find((item) => item.textContent === "Use detected password login")!
      .fire("click");
    expect(text(accessPanel(root))).toContain(
      "source inspection alone does not verify sign-in",
    );
    expect(
      walk(root).find((item) => item.id === "onboarding-shop-successSelector")!
        .value,
    ).toBe(detectedRecipe.successSelector);
    await walk(root)
      .find((item) => item.textContent === "Save & add test credentials")!
      .fire("click");
    expect(api).toHaveBeenLastCalledWith(
      "/api/projects/shop/onboarding/configure",
      {
        configurationRevision: "config-1",
        profile: "hosted",
        environment: "preview",
        target: {
          ...current.environment.target,
          access: {
            kind: "password",
            ...detectedRecipe,
            accounts: [
              {
                name: "Test user",
                usernameSecret: "APP_SHOP_NEWINSTANCE_TEST_USER_USERNAME",
                passwordSecret: "APP_SHOP_NEWINSTANCE_TEST_USER_PASSWORD",
              },
            ],
          },
        },
      },
    );
    expect(f.window.dashboardPages.navigate).toHaveBeenCalledWith(
      "/connections#project-access",
    );
    expect(JSON.stringify(api.mock.calls)).not.toContain('"password":');
    f.panel.destroy();
  });
  it.each(["unknown", "email-code", "sso", "public"])(
    "keeps %s source observations separate from an access selection and live verification",
    async (kind) => {
      const f = fixture(vi.fn(async () => detectedState(kind))),
        root = new Element();
      f.panel.mount(root, { name: "shop", repo: "owner/shop" });
      await settle();
      expect(
        walk(root).find(
          (item) => item.textContent === "Use detected password login",
        ),
      ).toBeUndefined();
      for (const choice of walk(root).filter((item) =>
        /^onboarding-shop-access-/.test(item.id),
      ))
        expect(choice.attributes.get("aria-pressed")).toBe("false");
      expect(f.api.mock.calls.filter(([, body]) => body)).toHaveLength(0);
      if (["email-code", "sso"].includes(kind))
        expect(text(accessPanel(root))).toContain(
          "cannot be checked by the password verifier",
        );
      if (kind === "public")
        expect(text(accessPanel(root))).toContain(
          "not a verified browser result",
        );
      f.panel.destroy();
    },
  );
  it("requires a current source inspection before applying a stale login recipe", async () => {
    const f = fixture(vi.fn(async () => detectedState("password", true))),
      root = new Element();
    f.panel.mount(root, { name: "shop", repo: "owner/shop" });
    await settle();
    expect(
      walk(root).find(
        (item) => item.textContent === "Use detected password login",
      ),
    ).toBeUndefined();
    expect(
      walk(root).find(
        (item) => item.textContent === "Detect sign-in from code",
      ),
    ).toBeDefined();
    expect(f.api.mock.calls.filter(([, body]) => body)).toHaveLength(0);
    f.panel.destroy();
  });

  it("retains a reviewed login suggestion after hosting settings change, with its limitations visible", async () => {
    const f = fixture(
        vi.fn(async () => ({
          ...detectedState("password", true),
          setupConfirmation: {
            confirmed: false,
            confirmedAt: "2026-10-07T12:00:00Z",
          },
        })),
      ),
      root = new Element();
    f.panel.mount(root, { name: "shop", repo: "owner/shop" });
    await settle();
    expect(
      walk(root).find(
        (item) => item.textContent === "Use detected password login",
      ),
    ).toBeDefined();
    expect(text(accessPanel(root))).toContain(
      "previously reviewed source inspection",
    );
    expect(text(accessPanel(root))).toContain(
      "live sign-in test is still required",
    );
    expect(f.api.mock.calls.filter(([, body]) => body)).toHaveLength(0);
    f.panel.destroy();
  });
  it("asks about app sign-in before hosting settings without defaulting to public access", async () => {
    const f = fixture(),
      root = new Element();
    f.panel.mount(root, { name: "shop", repo: "owner/shop" });
    await settle();
    const access = accessPanel(root);
    expect(access.hidden).toBe(false);
    expect(text(access)).toContain("Does your app have a sign-in?");
    expect(text(access)).toContain(
      "Vercel access opens the preview; it does not sign into your app.",
    );
    const choices = walk(access).filter(
      (item) =>
        item.className.startsWith("onboarding-access-choice ") ||
        item.className === "onboarding-access-choice",
    );
    expect(choices).toHaveLength(2);
    expect(
      choices.every((item) => item.attributes.get("aria-pressed") === "false"),
    ).toBe(true);
    expect(walk(root).indexOf(access)).toBeLessThan(
      walk(root).findIndex((item) => item.className === "onboarding-automatic"),
    );
    expect(
      walk(root).find((item) => item.textContent === "Save environment")!
        .disabled,
    ).toBe(true);
    expect(() =>
      f.window.readOnboardingTarget({ ...hosted(), accessKind: undefined }),
    ).toThrow("Choose how your gremlins should access the app");
    f.panel.destroy();
  });

  it("keeps the app sign-in choice visible after a saved Vercel preview passed its public browser check", async () => {
    const data = vercelState({ access: undefined });
    const current = {
      ...data,
      environment: { ...data.environment, verification: { status: "passed" } },
      previewAccess: { status: "verified" },
    };
    const f = fixture(vi.fn(async () => current)),
      root = new Element();
    f.panel.mount(root, {
      name: "shop",
      repo: "owner/shop",
      areas: [{ name: "product" }],
    });
    await settle();
    expect(accessPanel(root).hidden).toBe(false);
    expect(f.window.onboardingStep(current)).toBe(2);
    expect(text(root)).toContain("Your app sign-in is not set up yet.");
    expect(text(root)).not.toContain("Your crew can explore.");
    expect(walk(root).some((item) => item.textContent === "Open project")).toBe(
      false,
    );
    expect(
      walk(root).find((item) => item.textContent === "Test environment")!
        .disabled,
    ).toBe(true);
    await walk(root)
      .find((item) => item.textContent === "Set up app sign-in")!
      .fire("click");
    expect(accessPanel(root).scrollIntoView).toHaveBeenCalled();
    expect(f.api.mock.calls.filter(([, body]) => body)).toHaveLength(0);
    f.panel.destroy();
  });

  it("saves generated credential references before opening the secure Connections form", async () => {
    let current = vercelState({ access: undefined });
    const api = vi.fn(async (path: string, body?: unknown) => {
      if (path.endsWith("/configure")) {
        current = {
          ...current,
          configurationRevision: "config-saved",
          environment: {
            ...current.environment,
            target: (body as { target: typeof current.environment.target })
              .target,
          },
        };
      }
      return current;
    });
    const f = fixture(api),
      root = new Element();
    f.panel.mount(root, {
      name: "shop",
      instanceId: "new-instance",
      repo: "owner/shop",
    });
    await settle();
    await chooseAccess(root, "password");
    expect(text(accessPanel(root))).toContain(
      "Create a dedicated user in your test app",
    );
    expect(
      walk(root).find((item) => item.id === "onboarding-shop-account-0-name")!
        .value,
    ).toBe("Test user");
    await walk(root)
      .find((item) => item.textContent === "Save & add test credentials")!
      .fire("click");
    expect(f.window.dashboardPages.navigate).not.toHaveBeenCalled();
    expect(api.mock.calls.filter(([, body]) => body)).toHaveLength(0);
    const success = walk(root).find(
      (item) => item.id === "onboarding-shop-successSelector",
    )!;
    success.value = '[data-testid="account-menu"]';
    success.fire("input");
    fillLoginControls(root);
    await walk(root)
      .find((item) => item.textContent === "Save & add test credentials")!
      .fire("click");
    expect(api).toHaveBeenLastCalledWith(
      "/api/projects/shop/onboarding/configure",
      expect.objectContaining({
        target: expect.objectContaining({
          access: expect.objectContaining({
            kind: "password",
            accounts: [
              {
                name: "Test user",
                usernameSecret: "APP_SHOP_NEWINSTANCE_TEST_USER_USERNAME",
                passwordSecret: "APP_SHOP_NEWINSTANCE_TEST_USER_PASSWORD",
              },
            ],
          }),
        }),
      }),
    );
    expect(f.window.dashboardPages.navigate).toHaveBeenCalledWith(
      "/connections#project-access",
    );
    expect(JSON.stringify(api.mock.calls)).not.toContain('"password":');
    f.panel.destroy();
  });

  it("keeps credential setup on the page when saving fails", async () => {
    const current = vercelState({ access: undefined }),
      api = vi.fn(async (path: string) => {
        if (path.endsWith("/configure"))
          throw new Error("The project changed. Refresh before saving.");
        return current;
      }),
      f = fixture(api),
      root = new Element();
    f.panel.mount(root, { name: "shop", repo: "owner/shop" });
    await settle();
    await chooseAccess(root, "password");
    const success = walk(root).find(
      (item) => item.id === "onboarding-shop-successSelector",
    )!;
    success.value = "#account-menu";
    success.fire("input");
    fillLoginControls(root);
    await walk(root)
      .find((item) => item.textContent === "Save & add test credentials")!
      .fire("click");
    expect(f.window.dashboardPages.navigate).not.toHaveBeenCalled();
    expect(success.value).toBe("#account-menu");
    expect(f.panel.isDirty()).toBe(true);
    expect(text(root)).toContain("The project changed. Refresh before saving.");
    f.panel.destroy();
  });

  it.each([
    {
      profile: "hosted",
      target: {
        kind: "url",
        role: "preview",
        url: "https://preview.example.test/path",
      },
    },
    {
      profile: "docker",
      target: {
        kind: "docker",
        role: "preview",
        recipe: { kind: "image", image: "example/app:latest" },
        port: 3000,
        start: ["npm", "start"],
        env: { APP_KEY: "TEST_APP_KEY" },
        seed: ["npm", "run", "seed"],
      },
    },
  ])(
    "preserves a saved $profile environment's exact identity and settings when adding app access",
    async ({ profile, target }) => {
      const data = {
          ...state(),
          environment: { name: "customer-preview", profile, target },
        },
        api = vi.fn(async (_path: string, _body?: unknown) => data),
        f = fixture(api),
        root = new Element();
      f.panel.mount(root, { name: "shop", repo: "owner/shop" });
      await settle();
      await chooseAccess(root, "password");
      const success = walk(root).find(
        (item) => item.id === "onboarding-shop-successSelector",
      )!;
      success.value = "#account-menu";
      success.fire("input");
      fillLoginControls(root);
      // Merely opening the environment form does not make this an environment
      // replacement or normalize its optional fields.
      await walk(root)
        .find((item) => item.textContent === "Change environment")!
        .fire("click");
      await walk(root)
        .find((item) => item.textContent === "Save & add test credentials")!
        .fire("click");
      expect(api).toHaveBeenLastCalledWith(
        "/api/projects/shop/onboarding/configure",
        {
          configurationRevision: "config-1",
          profile,
          environment: "customer-preview",
          target: {
            ...target,
            access: expect.objectContaining({
              kind: "password",
              successSelector: "#account-menu",
            }),
          },
        },
      );
      f.panel.destroy();
    },
  );

  it.each([
    {
      profile: "hosted",
      target: {
        kind: "url",
        role: "preview",
        url: "https://preview.example.test/",
      },
      field: "url",
      value: "https://edited.example.test/",
      expected: { url: "https://edited.example.test/" },
    },
    {
      profile: "docker",
      target: {
        kind: "docker",
        role: "preview",
        recipe: { kind: "image", image: "example/app:latest" },
        port: 3000,
        seed: ["npm", "run", "seed"],
      },
      field: "advanced",
      value: "{}",
      expected: {
        recipe: { kind: "image", image: "example/app:latest" },
        port: 3000,
        healthPath: "/",
      },
    },
  ])(
    "applies edited $profile settings to the saved environment when saving account access",
    async ({ profile, target, field, value, expected }) => {
      const data = {
          ...state(),
          environment: { name: "customer-preview", profile, target },
        },
        api = vi.fn(async (_path: string, _body?: unknown) => data),
        f = fixture(api),
        root = new Element();
      f.panel.mount(root, { name: "shop", repo: "owner/shop" });
      await settle();
      await chooseAccess(root, "public");
      await walk(root)
        .find((item) => item.textContent === "Change environment")!
        .fire("click");
      const input = walk(root).find(
        (item) => item.id === `onboarding-shop-${field}`,
      )!;
      input.value = value;
      input.fire("input");
      await walk(root)
        .find((item) => item.textContent === "Save public-pages access")!
        .fire("click");
      expect(api).toHaveBeenLastCalledWith(
        "/api/projects/shop/onboarding/configure",
        {
          configurationRevision: "config-1",
          profile,
          environment: "customer-preview",
          target: {
            kind: target.kind,
            role: "preview",
            ...expected,
            access: { kind: "public" },
          },
        },
      );
      f.panel.destroy();
    },
  );

  it("prompts for actual credentials when only the login recipe has been saved", async () => {
    const target = {
        access: {
          kind: "password",
          loginPath: "/login",
          usernameSelector: 'input[type="email"]',
          passwordSelector: 'input[type="password"]',
          submitSelector: 'button[type="submit"]',
          successSelector: "#account-menu",
          accounts: [
            {
              name: "Test user",
              usernameSecret: "SHOP_TEST_USER",
              passwordSecret: "SHOP_TEST_PASSWORD",
            },
          ],
        },
      },
      f = fixture(vi.fn(async () => vercelState(target))),
      root = new Element(),
      project = {
        name: "shop",
        repo: "owner/shop",
        readiness: { steps: [{ id: "test_access", ready: false }] },
      };
    f.panel.mount(root, project);
    await settle();
    expect(text(accessPanel(root))).toContain(
      "Test account details saved. Add its email and password in Connections before browser patrols.",
    );
    const add = walk(accessPanel(root)).find(
      (item) => item.textContent === "Add test credentials",
    )!;
    expect(add.className).toBe("button button-dark");
    expect((add as Element & { href: string }).href).toBe(
      "/connections#project-access",
    );
    f.panel.mount(root, {
      ...project,
      readiness: { steps: [{ id: "test_access", ready: true }] },
    });
    await settle();
    expect(text(accessPanel(root))).not.toContain("Add its email and password");
    expect(text(accessPanel(root))).toContain("whether sign-in is verified");
    f.panel.destroy();
  });

  it("keeps the chosen login settings when Vercel finishes attaching the test preview", async () => {
    let current: object = state();
    const api = vi.fn(async (_path: string, _body?: unknown) => current),
      f = fixture(api),
      root = new Element();
    let configured!: () => Promise<void>;
    f.window.createVercelSetup = (options) => {
      configured = options.onConfigured;
      return {
        mount() {},
        setActive() {},
        destroy() {},
        syncConnections() {},
        isBusy: () => false,
      };
    };
    f.panel.mount(root, { name: "shop", repo: "owner/shop" });
    await settle();
    await chooseAccess(root, "password");
    const login = walk(root).find(
      (item) => item.id === "onboarding-shop-loginPath",
    )!;
    login.value = "/sign-in/password";
    login.fire("input");
    await walk(root)
      .find((item) => item.textContent === "Choose a test environment")!
      .fire("click");
    await walk(root)
      .find((item) => item.textContent === "Find a preview with Vercel")!
      .fire("click");
    current = {
      ...vercelState({ access: undefined }),
      configurationRevision: "config-preview-ready",
    };
    await configured();
    // onConfigured hides the environment editor; the inline account question
    // and the owner's draft remain available as the next step.
    expect(accessPanel(root).hidden).toBe(false);
    expect(
      walk(root).find((item) => item.id === "onboarding-shop-loginPath")!.value,
    ).toBe("/sign-in/password");
    expect(
      walk(root)
        .find((item) => item.id === "onboarding-shop-access-password")!
        .attributes.get("aria-pressed"),
    ).toBe("true");
    expect(f.panel.isDirty()).toBe(true);
    expect(api.mock.calls.some(([, body]) => Boolean(body))).toBe(false);
    f.panel.destroy();
  });

  it("requires and saves an explicit public-only choice with honest coverage", async () => {
    let current = vercelState({ access: undefined });
    const api = vi.fn(async (path: string, body?: unknown) => {
        if (path.endsWith("/configure"))
          current = {
            ...current,
            environment: {
              ...current.environment,
              target: (body as { target: typeof current.environment.target })
                .target,
            },
          };
        return current;
      }),
      f = fixture(api),
      root = new Element();
    f.panel.mount(root, { name: "shop", repo: "owner/shop" });
    await settle();
    await chooseAccess(root, "public");
    expect(text(accessPanel(root))).toContain(
      "Signed-in journeys will not be verified.",
    );
    await walk(root)
      .find((item) => item.textContent === "Save public-pages access")!
      .fire("click");
    expect(current.environment.target.access).toEqual({ kind: "public" });
    expect(f.window.dashboardPages.navigate).not.toHaveBeenCalled();
    f.panel.destroy();
  });

  it.each(["public", "password"])(
    "restores the legacy recipe when switching from %s access",
    async (kind) => {
      const current = {
        ...vercelState({ access: { kind } }),
        environment: {
          ...vercelState({ access: { kind } }).environment,
          legacySignIn: true,
        },
      };
      const api = vi.fn(async (_path: string, _body?: unknown) => current);
      const f = fixture(api),
        root = new Element();
      f.panel.mount(root, { name: "shop", repo: "owner/shop" });
      await settle();
      await chooseAccess(root, "legacy");
      await walk(root)
        .find((item) => item.textContent === "Save sign-in recipe")!
        .fire("click");
      const saved = api.mock.calls.find(([path]) =>
        path.endsWith("/configure"),
      )?.[1] as { environment: string; target: object };
      expect(saved.environment).toBe(current.environment.name);
      expect(saved.target).not.toHaveProperty("access");
      expect(current.environment.target.access).toEqual({ kind });
      f.panel.destroy();
    },
  );

  it("preserves legacy sign-in recipes without labeling them as public-only", async () => {
    const environment = {
      ...vercelState({ access: undefined }).environment,
      legacySignIn: true,
      legacySignInSummary: "Existing browser login recipe retained.",
      verification: { status: "passed" },
    };
    const f = fixture(vi.fn(async () => ({ ...state(), environment }))),
      root = new Element();
    f.panel.mount(root, { name: "shop", repo: "owner/shop" });
    await settle();
    expect(
      walk(root)
        .find((item) => item.id === "onboarding-shop-access-legacy")!
        .attributes.get("aria-pressed"),
    ).toBe("true");
    expect(text(accessPanel(root))).toContain(
      "Existing browser login recipe retained.",
    );
    expect(f.window.onboardingStep({ environment })).toBe(3);
    expect(
      f.window.readOnboardingTarget({ ...hosted(), accessKind: "legacy" })
        .target,
    ).not.toHaveProperty("access");
    f.panel.destroy();
  });
});

describe("Vercel preview access", () => {
  it.each(["connected", "not_required"])(
    "connects an existing target explicitly and reports %s without claiming browser verification",
    async (status) => {
      const current = vercelState({ bypassSecret: "EXISTING_BYPASS" });
      const api = vi.fn(async (_path: string, body?: unknown) =>
        body
          ? {
              ...current,
              configurationRevision: "config-2",
              previewAccess: { status, message: `Provider result: ${status}` },
            }
          : current,
      );
      const f = fixture(api),
        root = new Element();
      f.panel.mount(root, { name: "shop", repo: "owner/shop" });
      await settle();
      expect(api).toHaveBeenCalledTimes(1);
      expect(walk(root).some((item) => item.id === "onboarding-shop-url")).toBe(
        false,
      );
      const verification = walk(root).find(
        (item) => item.className === "onboarding-verification",
      )!;
      expect(text(verification)).toContain("A bypass reference is saved");
      await walk(verification)
        .find((item) => item.textContent === "Connect preview access")!
        .fire("click");
      expect(api).toHaveBeenLastCalledWith(
        "/api/projects/shop/onboarding/vercel/access",
        { configurationRevision: "config-1" },
      );
      expect(api).toHaveBeenCalledTimes(2);
      expect(f.saved).toHaveBeenCalledWith("shop");
      expect(text(root)).not.toContain("Provider result:");
      expect(text(root)).toContain(
        status === "connected"
          ? "Access connected. Test the environment next."
          : "No deployment protection detected. Test the environment next.",
      );
      expect(
        walk(verification).find(
          (item) => item.textContent === "Check preview access",
        )?.className,
      ).toBe("small-button");
      expect(
        walk(verification)
          .filter(
            (item) =>
              item.tagName === "BUTTON" &&
              item.className.includes("button-dark"),
          )
          .map((item) => item.textContent),
      ).toEqual(["Test environment"]);
      expect(text(root)).toContain(
        "Test the environment to verify browser access",
      );
      expect(text(root)).toContain("Protection stays on");
      expect(text(root)).not.toContain("Your crew can explore");
      expect(f.panel.isDirty()).toBe(false);
      const reference = walk(root).find(
        (item) => item.id === "onboarding-shop-vercelBypassSecret",
      )!;
      reference.value = "CHANGED_REFERENCE";
      reference.fire("input");
      expect(
        walk(root).find(
          (item) => item.textContent === "Save & connect preview access",
        )?.className,
      ).toBe("button button-dark");
      f.panel.destroy();
    },
  );
  it("saves a suggested target and its edited login inputs before connecting with the returned revision", async () => {
    let savedTarget: Record<string, unknown> = vercelState().environment.target;
    const api = vi.fn(async (path: string, body?: unknown) => {
      if (path.endsWith("/configure")) {
        savedTarget = (body as { target: Record<string, unknown> }).target;
        return {
          ...vercelState(savedTarget),
          configurationRevision: "saved-2",
        };
      }
      if (path.endsWith("/vercel/access"))
        return {
          ...vercelState({ ...savedTarget, bypassSecret: "MANAGED_BYPASS" }),
          configurationRevision: "access-3",
          previewAccess: {
            status: "connected",
            message: "Preview access connected.",
          },
        };
      return state();
    });
    const f = fixture(api),
      root = new Element();
    f.panel.mount(root, {
      name: "shop",
      repo: "owner/shop",
      environments: { preview: savedTarget },
    });
    await settle();
    const select = walk(root).find(
      (item) => item.id === "onboarding-shop-access-password",
    )!;
    select.fire("click");
    for (const [id, value] of [
      ["onboarding-shop-loginPath", "/sign-in"],
      ["onboarding-shop-usernameSelector", "#email"],
      ["onboarding-shop-passwordSelector", "#password"],
      ["onboarding-shop-submitSelector", "#submit-login"],
      ["onboarding-shop-successSelector", '[data-testid="account-menu"]'],
      ["onboarding-shop-account-0-name", "Test member"],
    ]) {
      const input = walk(root).find((item) => item.id === id)!;
      input.value = value!;
      input.fire("input");
    }
    await walk(root)
      .find((item) => item.textContent === "Save & connect preview access")!
      .fire("click");
    expect(api.mock.calls.map(([path]) => path)).toEqual([
      "/api/projects/shop/onboarding",
      "/api/projects/shop/onboarding/configure",
      "/api/projects/shop/onboarding/vercel/access",
    ]);
    expect(api.mock.calls[1]![1]).toMatchObject({
      configurationRevision: "config-1",
      target: {
        kind: "vercel",
        access: {
          kind: "password",
          loginPath: "/sign-in",
          successSelector: '[data-testid="account-menu"]',
          accounts: [{ name: "Test member" }],
        },
      },
    });
    expect(api.mock.calls[2]![1]).toEqual({ configurationRevision: "saved-2" });
    expect(f.panel.isDirty()).toBe(false);
    expect(
      walk(root).find((item) => item.id === "onboarding-shop-loginPath")?.value,
    ).toBe("/sign-in");
    expect(walk(root).some((item) => item.id === "onboarding-shop-url")).toBe(
      false,
    );
    f.panel.destroy();
  });
  it("keeps incomplete login edits and does not save or connect them", async () => {
    const f = fixture(vi.fn(async () => vercelState())),
      root = new Element();
    f.panel.mount(root, { name: "shop", repo: "owner/shop" });
    await settle();
    const select = walk(root).find(
      (item) => item.id === "onboarding-shop-access-password",
    )!;
    select.fire("click");
    await walk(root)
      .find((item) => item.textContent === "Save & connect preview access")!
      .fire("click");
    expect(f.api).toHaveBeenCalledTimes(1);
    expect(f.panel.isDirty()).toBe(true);
    expect(text(root)).toContain(
      "Set a login path and a signed-in success selector",
    );
    expect(
      walk(root)
        .find((item) => item.id === "onboarding-shop-access-password")
        ?.attributes.get("aria-pressed"),
    ).toBe("true");
    f.panel.destroy();
  });
  it("keeps a stale draft and stops when saving conflicts", async () => {
    let revision = "config-1";
    const api = vi.fn(async (path: string, _body?: unknown) => {
      if (path.endsWith("/configure"))
        throw new Error("Configuration changed. Review your saved settings.");
      return { ...vercelState(), configurationRevision: revision };
    });
    const f = fixture(api),
      root = new Element();
    f.panel.mount(root, { name: "shop", repo: "owner/shop" });
    await settle();
    const input = walk(root).find(
      (item) => item.id === "onboarding-shop-vercelBypassSecret",
    )!;
    input.value = "MY_MANUAL_REFERENCE";
    input.fire("input");
    revision = "config-2";
    await f.panel.refresh("shop");
    await walk(root)
      .find((item) => item.textContent === "Save & connect preview access")!
      .fire("click");
    expect(api).toHaveBeenLastCalledWith(
      "/api/projects/shop/onboarding/configure",
      expect.objectContaining({ configurationRevision: "config-1" }),
    );
    expect(
      api.mock.calls.some(([path]) => path.endsWith("/vercel/access")),
    ).toBe(false);
    expect(input.value).toBe("MY_MANUAL_REFERENCE");
    expect(f.panel.isDirty()).toBe(true);
    expect(text(root)).toContain(
      "Configuration changed. Review your saved settings.",
    );
    f.panel.destroy();
  });
  it.each(["failure", "malformed", "wrong-target"])(
    "retains the saved environment after an access %s and restores controls",
    async (kind) => {
      const initial = vercelState();
      const api = vi.fn(async (path: string, _body?: unknown) => {
        if (!path.endsWith("/vercel/access")) return initial;
        if (kind === "failure")
          throw new Error("Reconnect Vercel with project write access.");
        return {
          ...vercelState(
            kind === "wrong-target" ? { projectId: "different-project" } : {},
          ),
          previewAccess: {
            status: kind === "malformed" ? "unknown" : "connected",
            message: "unexpected success",
          },
        };
      });
      const f = fixture(api),
        root = new Element();
      f.panel.mount(root, { name: "shop", repo: "owner/shop" });
      await settle();
      await walk(root)
        .find((item) => item.textContent === "Connect preview access")!
        .fire("click");
      expect(text(root)).not.toContain("unexpected success");
      expect(text(root)).toContain(
        kind === "failure"
          ? "Reconnect Vercel with project write access"
          : kind === "malformed"
            ? "did not return a connection result"
            : "returned an unexpected environment",
      );
      expect(
        walk(root).find((item) => item.textContent === "Connect preview access")
          ?.disabled,
      ).toBe(false);
      expect(f.saved).not.toHaveBeenCalled();
      f.panel.destroy();
    },
  );
  it("keeps a successful save after access fails and retries only access", async () => {
    let attempts = 0;
    const initial = vercelState();
    const api = vi.fn(async (path: string, _body?: unknown) => {
      if (path.endsWith("/configure"))
        return { ...initial, configurationRevision: "saved-2" };
      if (path.endsWith("/vercel/access")) {
        if (++attempts === 1)
          throw new Error("Vercel is unavailable. Retry later.");
        return {
          ...initial,
          configurationRevision: "access-3",
          previewAccess: {
            status: "connected",
            message: "Preview access connected.",
          },
        };
      }
      return state();
    });
    const f = fixture(api),
      root = new Element();
    f.panel.mount(root, {
      name: "shop",
      repo: "owner/shop",
      environments: { preview: initial.environment.target },
    });
    await settle();
    await walk(root)
      .find((item) => item.textContent === "Save & connect preview access")!
      .fire("click");
    expect(text(root)).toContain("Vercel is unavailable");
    expect(f.saved).toHaveBeenCalledTimes(1);
    await walk(root)
      .find((item) => item.textContent === "Connect preview access")!
      .fire("click");
    expect(
      api.mock.calls.filter(([path]) => path.endsWith("/configure")),
    ).toHaveLength(1);
    expect(api).toHaveBeenLastCalledWith(
      "/api/projects/shop/onboarding/vercel/access",
      { configurationRevision: "saved-2" },
    );
    f.panel.destroy();
  });
  it.each(["destroy", "forget", "replace"])(
    "ignores late access responses after %s and prevents duplicate clicks while busy",
    async (operation) => {
      let resolve!: (
        value: ReturnType<typeof vercelState> & { previewAccess: object },
      ) => void;
      const api = vi.fn(async (path: string, _body?: unknown) => {
        if (path.endsWith("/vercel/access"))
          return new Promise<
            ReturnType<typeof vercelState> & { previewAccess: object }
          >((done) => {
            resolve = done;
          });
        return vercelState();
      });
      const f = fixture(api),
        root = new Element();
      f.panel.mount(root, {
        name: "shop",
        repo: "owner/shop",
        instanceId: "first",
      });
      await settle();
      const action = walk(root).find(
        (item) => item.textContent === "Connect preview access",
      )!;
      const pending = action.fire("click");
      await settle();
      expect(action.disabled).toBe(true);
      await action.fire("click");
      expect(
        api.mock.calls.filter(([path]) => path.endsWith("/vercel/access")),
      ).toHaveLength(1);
      expect(
        walk(root).find((item) => item.id === "onboarding-shop-access-password")
          ?.disabled,
      ).toBe(true);
      if (operation === "destroy") f.panel.destroy();
      else if (operation === "forget") f.panel.forget("shop");
      else {
        root.replaceChildren();
        f.panel.mount(root, {
          name: "shop",
          repo: "owner/replacement",
          instanceId: "second",
        });
        await settle();
      }
      const before = text(root);
      resolve({
        ...vercelState({ bypassSecret: "LATE_REFERENCE" }),
        previewAccess: {
          status: "connected",
          message: "Late connection result",
        },
      });
      await pending;
      expect(text(root)).toBe(before);
      expect(f.saved).not.toHaveBeenCalled();
      if (operation === "replace")
        expect(
          walk(root).find(
            (item) => item.textContent === "Connect preview access",
          )?.disabled,
        ).toBe(false);
      f.panel.destroy();
    },
  );
  it("does not connect after a late save response for a removed project", async () => {
    let resolve!: (value: ReturnType<typeof vercelState>) => void;
    const initial = vercelState();
    const api = vi.fn(async (path: string, _body?: unknown) => {
      if (path.endsWith("/configure"))
        return new Promise<ReturnType<typeof vercelState>>((done) => {
          resolve = done;
        });
      return state();
    });
    const f = fixture(api),
      root = new Element();
    f.panel.mount(root, {
      name: "shop",
      repo: "owner/shop",
      environments: { preview: initial.environment.target },
    });
    await settle();
    const pending = walk(root)
      .find((item) => item.textContent === "Save & connect preview access")!
      .fire("click");
    f.panel.forget("shop");
    resolve({ ...initial, configurationRevision: "saved-2" });
    await pending;
    expect(
      api.mock.calls.some(([path]) => path.endsWith("/vercel/access")),
    ).toBe(false);
    expect(f.saved).not.toHaveBeenCalled();
    f.panel.destroy();
  });
  it("stops after a malformed save response and keeps the selected target", async () => {
    const initial = vercelState();
    const api = vi.fn(async (_path: string, _body?: unknown) => state());
    const f = fixture(api),
      root = new Element();
    f.panel.mount(root, {
      name: "shop",
      repo: "owner/shop",
      environments: { preview: initial.environment.target },
    });
    await settle();
    await walk(root)
      .find((item) => item.textContent === "Save & connect preview access")!
      .fire("click");
    expect(
      api.mock.calls.some(([path]) => path.endsWith("/vercel/access")),
    ).toBe(false);
    expect(text(root)).toContain("returned an unexpected environment");
    expect(
      walk(root).find((item) => item.id === "onboarding-shop-existing")?.value,
    ).toBe("preview");
    expect(
      walk(root).find(
        (item) => item.textContent === "Save & connect preview access",
      )?.disabled,
    ).toBe(false);
    f.panel.destroy();
  });
  it("keeps manual bypass configuration in a focused sheet and saves only a secret reference", async () => {
    const initial = vercelState();
    const api = vi.fn(async (_path: string, body?: unknown) =>
      body
        ? vercelState((body as { target: Record<string, unknown> }).target)
        : initial,
    );
    const f = fixture(api),
      root = new Element();
    f.panel.mount(root, { name: "shop", repo: "owner/shop" });
    await settle();
    const dialog = walk(root).find(
      (item) =>
        item.tagName === "DIALOG" &&
        item.attributes.get("aria-label") === "Advanced preview access",
    )!;
    expect(dialog.open).toBe(false);
    await walk(root)
      .find(
        (item) =>
          item.tagName === "BUTTON" &&
          item.textContent === "Advanced preview access",
      )!
      .fire("click");
    expect(dialog.open).toBe(true);
    const checkbox = walk(dialog).find(
      (item) => item.tagName === "INPUT" && !item.id,
    )!;
    Object.assign(checkbox, { checked: true });
    checkbox.fire("change");
    const input = walk(dialog).find(
      (item) => item.id === "onboarding-shop-vercelBypassSecret",
    )!;
    input.value = "MY_MANUAL_BYPASS";
    input.fire("input");
    await walk(root)
      .find((item) => item.id === "onboarding-shop-access-public")!
      .fire("click");
    await walk(root)
      .find((item) => item.textContent === "Save environment")!
      .fire("click");
    expect(api).toHaveBeenLastCalledWith(
      "/api/projects/shop/onboarding/configure",
      expect.objectContaining({
        target: expect.objectContaining({ bypassSecret: "MY_MANUAL_BYPASS" }),
      }),
    );
    expect(
      api.mock.calls.some(([path]) => path.endsWith("/vercel/access")),
    ).toBe(false);
    f.panel.destroy();
  });
});

describe("guided environment target review", () => {
  it("shows the chosen Vercel address instead of a duplicate URL input and switches to manual URL only explicitly", async () => {
    const target = {
      kind: "vercel",
      role: "preview",
      projectId: "prj_test",
      connectionId: "test",
      branch: "pm-staging",
    };
    const api = vi.fn(async (_path: string, body?: unknown) => ({
      ...state(),
      ...(body
        ? {
            environment: {
              name: "pm-test",
              profile: "hosted",
              target: (body as { target: object }).target,
            },
          }
        : {}),
    }));
    const f = fixture(api),
      root = new Element();
    let select!: (input: {
      target: Record<string, unknown>;
      label: string;
      url?: string;
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
    f.panel.mount(root, { name: "shop", repo: "owner/shop", environments: {} });
    await settle();
    expect(walk(root).some((item) => item.id === "onboarding-shop-url")).toBe(
      true,
    );
    await walk(root)
      .find((item) => item.textContent === "Find a preview with Vercel")!
      .fire("click");
    expect(walk(root).some((item) => item.id === "onboarding-shop-url")).toBe(
      false,
    );
    expect(text(root)).toContain(
      "Selecting an account or project alone does not attach",
    );
    expect(
      walk(root).find((item) => item.textContent === "Save environment")
        ?.disabled,
    ).toBe(true);
    select({
      target,
      label: "Test app · pm-staging",
      url: "https://test-app.vercel.app",
    });
    expect(walk(root).some((item) => item.id === "onboarding-shop-url")).toBe(
      false,
    );
    expect(text(root)).toContain("https://test-app.vercel.app/");
    expect(text(root)).toContain("don’t need to enter a separate Test URL");
    expect(api).toHaveBeenCalledTimes(1);
    await walk(root)
      .find((item) => item.id === "onboarding-shop-access-public")!
      .fire("click");
    await walk(root)
      .find((item) => item.textContent === "Save environment")!
      .fire("click");
    expect(api).toHaveBeenLastCalledWith(
      "/api/projects/shop/onboarding/configure",
      expect.objectContaining({
        target: { ...target, access: { kind: "public" } },
      }),
    );
    expect(text(root)).toContain("https://test-app.vercel.app/");
    await walk(root)
      .find((item) => item.textContent === "Enter a test URL instead")!
      .fire("click");
    const input = walk(root).find((item) => item.id === "onboarding-shop-url")!;
    input.value = "https://manual.example.test/";
    input.fire("input");
    await walk(root)
      .find((item) => item.id === "onboarding-shop-access-public")!
      .fire("click");
    await walk(root)
      .find((item) => item.textContent === "Save environment")!
      .fire("click");
    expect(api).toHaveBeenLastCalledWith(
      "/api/projects/shop/onboarding/configure",
      expect.objectContaining({
        target: {
          kind: "url",
          role: "staging",
          url: "https://manual.example.test/",
          access: { kind: "public" },
        },
      }),
    );
    f.panel.destroy();
  });

  it("keeps saved Vercel targets automatic without inventing a resolved address", async () => {
    const target = {
      kind: "vercel",
      role: "preview",
      projectId: "prj_test",
      branch: "pm-staging",
    };
    const f = fixture(
        vi.fn(async () => ({
          ...state(),
          environment: { name: "preview", profile: "hosted", target },
        })),
      ),
      root = new Element();
    f.panel.mount(root, {
      name: "shop",
      repo: "owner/shop",
      environments: { preview: target },
    });
    await settle();
    expect(walk(root).some((item) => item.id === "onboarding-shop-url")).toBe(
      false,
    );
    expect(text(root)).toContain("Saved Vercel environment · preview");
    expect(text(root)).toContain(
      "Each test resolves the latest matching deployment",
    );
    expect(text(root)).not.toContain("https://prj_test");
    expect(
      walk(root).some((item) => item.textContent === "Change Vercel preview"),
    ).toBe(true);
    f.panel.destroy();
  });

  it("suggests one saved nonproduction Vercel target without attaching or verifying it, and preserves ambiguity", async () => {
    const target = {
      kind: "vercel",
      role: "preview",
      projectId: "prj_test",
      branch: "pm-staging",
    };
    const f = fixture(),
      root = new Element();
    f.panel.mount(root, {
      name: "shop",
      repo: "owner/shop",
      environments: {
        preview: target,
        production: { ...target, role: "production" },
      },
    });
    await settle();
    expect(text(root)).toContain("Suggested Vercel environment · preview");
    expect(text(root)).toContain(
      "save this choice, then test access. It is not verified yet.",
    );
    expect(walk(root).some((item) => item.id === "onboarding-shop-url")).toBe(
      false,
    );
    expect(f.api).toHaveBeenCalledTimes(1);
    expect(f.api.mock.calls[0]?.[1]).toBeUndefined();
    await walk(root)
      .find((item) => item.id === "onboarding-shop-access-public")!
      .fire("click");
    await walk(root)
      .find((item) => item.textContent === "Save environment")!
      .fire("click");
    expect(f.api).toHaveBeenLastCalledWith(
      "/api/projects/shop/onboarding/configure",
      expect.objectContaining({
        environment: "preview",
        target: { ...target, access: { kind: "public" } },
      }),
    );
    f.panel.destroy();
    const multiple = fixture(),
      other = new Element();
    multiple.panel.mount(other, {
      name: "shop",
      repo: "owner/shop",
      environments: {
        first: target,
        second: { ...target, projectId: "prj_another" },
      },
    });
    await settle();
    expect(text(other)).not.toContain("Suggested Vercel environment");
    expect(
      walk(other).find((item) => item.id === "onboarding-shop-existing")?.value,
    ).toBe("");
    expect(multiple.api).toHaveBeenCalledTimes(1);
    multiple.panel.destroy();
  });

  it("returns an existing crew to its project after environment verification", async () => {
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
      areas: [{ key: "foundation" }],
    });
    await settle();
    expect(text(root)).toContain("Public pages are ready to explore.");
    expect(text(root)).not.toContain("Create a PM");
    await walk(root)
      .find((item) => item.textContent === "Open project")!
      .fire("click");
    expect(f.window.dashboardPages.navigate).toHaveBeenCalledWith(
      "/projects/shop",
    );
    expect(f.created).not.toHaveBeenCalled();
    f.panel.destroy();
  });
  it("offers the reviewed foundation build before environment choices for a fresh idea", async () => {
    const foundation = {
      stage: "review",
      revision: "brief-1",
      title: "Build the booking app",
      milestone: "A student can book a seat",
      assignment: "Build the first complete booking journey.",
      acceptanceCriteria: ["Reject full classes"],
      buildBrief: "Reviewed build scope",
    };
    const api = vi.fn(async (path: string) => ({
      ...state(),
      foundation,
      ...foundation,
      ...(path.endsWith("/build")
        ? {
            stage: "queued",
            job: { id: "job-foundation", runId: 1, status: "queued" },
          }
        : {}),
    }));
    const f = fixture(api),
      root = new Element();
    f.panel.mount(root, {
      name: "shop",
      repo: "owner/shop",
      ideaPlanId: "saved-idea",
    });
    await settle();
    expect(text(root)).toContain("Approve & build foundation");
    await walk(root)
      .find((element) => element.textContent === "Read the full build brief")!
      .fire("click");
    const dialog = walk(root).find((element) => element.tagName === "DIALOG")!,
      heading = walk(dialog).find((element) => element.tagName === "H2")!;
    expect(dialog.open).toBe(true);
    expect(dialog.scrollTop).toBe(0);
    expect(heading.attributes.get("tabindex")).toBe("-1");
    expect(heading.attributes.has("autofocus")).toBe(true);
    expect(heading.focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(dialog.children[0]!.tagName).toBe("HEADER");
    await walk(dialog.children[0]!)
      .find((element) => element.textContent === "Close")!
      .fire("click");
    expect(dialog.open).toBe(false);
    expect(
      walk(root).find((element) => element.className === "onboarding-choice")!
        .hidden,
    ).toBe(true);
    expect(
      walk(root).find((element) => element.className === "onboarding-analysis")!
        .hidden,
    ).toBe(true);
    await walk(root)
      .find((element) => element.textContent === "Approve & build foundation")!
      .fire("click");
    expect(api).toHaveBeenCalledWith(
      "/api/projects/shop/foundation/build",
      { revision: "brief-1" },
      "POST",
      180000,
    );
    expect(text(root)).toContain("Your foundation is in the queue");
    expect(api.mock.calls.some(([path]) => path.includes("/api/jobs"))).toBe(
      false,
    );
    f.panel.destroy();
  });
  it("keeps environment choices out of the way until the user chooses manual setup", async () => {
    const f = fixture(),
      root = new Element();
    f.panel.mount(root, { name: "shop", repo: "owner/shop" });
    await settle();
    expect(
      walk(root).find((element) => element.className === "onboarding-choice")!
        .hidden,
    ).toBe(true);
    await walk(root)
      .find(
        (element) => element.textContent === "I already know where to test",
      )!
      .fire("click");
    expect(
      walk(root).find((element) => element.className === "onboarding-choice")!
        .hidden,
    ).toBe(false);
    expect(
      walk(root).find((element) => element.className === "onboarding-analysis")!
        .hidden,
    ).toBe(true);
    expect(
      walk(root).filter((element) => element.tagName === "DETAILS"),
    ).toHaveLength(0);
    await walk(root)
      .find(
        (element) =>
          element.tagName === "BUTTON" &&
          element.textContent === "Hosting provider settings",
      )!
      .fire("click");
    const dialog = walk(root).find(
      (element) => element.tagName === "DIALOG" && element.open,
    )!;
    const header = dialog.children[0]!;
    expect(header.tagName).toBe("HEADER");
    expect(header.children[0]!.focus).toHaveBeenCalledWith({
      preventScroll: true,
    });
    expect(dialog.scrollTop).toBe(0);
    expect(header.children[1]!.textContent).toBe("Close");
    await header.children[1]!.fire("click");
    expect(dialog.open).toBe(false);
    f.panel.destroy();
  });
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
    await walk(root)
      .find((element) => element.textContent === "Change Vercel preview")!
      .fire("click");
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
      .find((item) => item.id === "onboarding-shop-access-public")!
      .fire("click");
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
    expect(text(root)).toContain("Review source evidence · 1 files");
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
      (item) => item.id === "onboarding-shop-access-password",
    )!;
    access.fire("click");
    expect(
      walk(root).find(
        (item) => item.id === "onboarding-shop-account-0-usernameSecret",
      )?.value,
    ).toBe("APP_SHOP_A1B2C3_TEST_USER_USERNAME");
    expect(
      walk(root).find(
        (item) => item.id === "onboarding-shop-account-0-passwordSecret",
      )?.value,
    ).toBe("APP_SHOP_A1B2C3_TEST_USER_PASSWORD");
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
        environment: {
          target: { access: { kind: "public" } },
          verification: { status: "passed" },
        },
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
      .find((item) => item.id === "onboarding-shop-access-public")!
      .fire("click");
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
