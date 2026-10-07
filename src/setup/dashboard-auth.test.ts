import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

class Element {
  children: Element[] = [];
  className = "";
  textContent = "";
  id = "";
  value = "";
  type = "";
  minLength = 0;
  hidden = false;
  checked = false;
  disabled = false;
  inert = false;
  open = false;
  focused = false;
  dataset: Record<string, string> = {};
  attributes = new Map<string, string>();
  listeners = new Map<string, (() => Promise<void> | void)[]>();
  classList = {
    toggle: (name: string, enabled: boolean) => {
      this.className = this.className
        .split(/\s+/)
        .filter((part) => part !== name)
        .join(" ");
      if (enabled) this.className += ` ${name}`;
    },
  };
  constructor(public tagName: string) {}
  append(...items: Element[]) {
    this.children.push(...items);
  }
  replaceChildren(...items: Element[]) {
    this.children = items;
  }
  all(): Element[] {
    return [this, ...this.children.flatMap((item) => item.all())];
  }
  text(): string {
    return [this.textContent, ...this.children.map((item) => item.text())].join(
      " ",
    );
  }
  querySelectorAll(selector: string) {
    return this.all().filter((item) => {
      if (selector.startsWith("."))
        return item.className.split(/\s+/).includes(selector.slice(1));
      if (selector.startsWith("#")) return item.id === selector.slice(1);
      if (selector === "dialog[open]")
        return item.tagName === "dialog" && item.open;
      if (selector === "[data-auth-account-message]")
        return "authAccountMessage" in item.dataset;
      return item.tagName === selector;
    });
  }
  querySelector(selector: string) {
    return this.querySelectorAll(selector)[0] || null;
  }
  setAttribute(name: string, value: string) {
    this.attributes.set(name, value);
  }
  addEventListener(name: string, callback: () => Promise<void> | void) {
    this.listeners.set(name, [...(this.listeners.get(name) || []), callback]);
  }
  async emit(name: string) {
    const event = { preventDefault() {} };
    for (const callback of this.listeners.get(name) || [])
      await (callback as (event: object) => unknown)(event);
  }
  focus() {
    this.focused = true;
  }
  close() {
    this.open = false;
  }
  showModal() {
    this.open = true;
  }
}
type Session = {
  configured: boolean;
  authenticated: boolean;
  mode: "cookie" | "bootstrap" | null;
  secureTransport: boolean;
  canSetup: boolean;
  canAllowInsecureLan: boolean;
  allowInsecureLan: boolean;
  csrfToken?: string;
  remembered?: boolean;
};
const anonymous: Session = {
  configured: true,
  authenticated: false,
  mode: null,
  secureTransport: true,
  canSetup: false,
  canAllowInsecureLan: false,
  allowInsecureLan: false,
};
const cookie: Session = {
  ...anonymous,
  authenticated: true,
  mode: "cookie",
  csrfToken: "csrf-test",
};
type Auth = {
  start(): Promise<boolean>;
  isAuthenticated(): boolean;
  request(path: string, init?: RequestInit): Promise<Response>;
  prepareRedirect(): void;
};
function fixture(
  { initial = anonymous, bootstrap = "", drafts = false } = {} as {
    initial?: Session;
    bootstrap?: string;
    drafts?: boolean;
  },
) {
  const body = new Element("body"),
    screen = new Element("div"),
    account = new Element("section"),
    workspace = new Element("div"),
    dialog = new Element("dialog"),
    draft = new Element("input");
  screen.id = "dashboard-sign-in";
  account.id = "account-access";
  workspace.className = "workspace";
  draft.value = "Unsaved project description";
  workspace.append(account, draft);
  body.append(screen, workspace, dialog);
  const storage = new Map<string, string>();
  if (bootstrap) storage.set("shipgremlins.dashboard.session", bootstrap);
  const fetch = vi.fn(async (_path: string, _init?: RequestInit) =>
    Response.json(initial),
  );
  const authenticated = vi.fn(async () => {}),
    locked = vi.fn(),
    signedOut = vi.fn();
  const events = new Map<string, () => void | Promise<void>>();
  const window = {
    location: {
      origin: "http://localhost:4311",
      pathname: "/projects/shop",
      search: "?tab=environment",
      hash: "",
      reload: vi.fn(),
    },
    history: { replaceState: vi.fn() },
    addEventListener: (name: string, callback: () => void | Promise<void>) =>
      events.set(name, callback),
    createDashboardAuth: (_options: object): Auth => {
      throw new Error("not loaded");
    },
  };
  runInNewContext(readFileSync("dashboard/auth.js", "utf8"), {
    window,
    document: {
      body,
      getElementById: (id: string) => body.all().find((item) => item.id === id),
      createElement: (tag: string) => new Element(tag),
      querySelector: (selector: string) => body.querySelector(selector),
      querySelectorAll: (selector: string) => body.querySelectorAll(selector),
    },
    fetch,
    Headers,
    URL,
    URLSearchParams,
    AbortSignal,
    sessionStorage: {
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    },
  });
  const auth = window.createDashboardAuth({
    bootstrapToken: bootstrap,
    onAuthenticated: authenticated,
    onLocked: locked,
    hasUnsavedInputs: () => drafts,
    onSignedOut: signedOut,
  });
  const byId = (id: string) => {
    const item = body.all().find((item) => item.id === id);
    if (!item) throw new Error(`Missing ${id}`);
    return item;
  };
  const button = (text: string, host = body) => {
    const item = host
      .all()
      .find((item) => item.tagName === "button" && item.textContent === text);
    if (!item) throw new Error(`Missing button ${text}`);
    return item;
  };
  return {
    auth,
    body,
    screen,
    account,
    workspace,
    dialog,
    draft,
    storage,
    fetch,
    authenticated,
    locked,
    signedOut,
    events,
    byId,
    button,
    window,
  };
}

describe("dashboard password sign-in", () => {
  it("restores a remembered cookie on a new tab without requiring a bearer", async () => {
    const f = fixture({ initial: { ...cookie, remembered: true } });
    await f.auth.start();
    expect(f.auth.isAuthenticated()).toBe(true);
    expect(f.screen.hidden).toBe(true);
    expect(f.workspace.inert).toBe(false);
    expect(f.authenticated).toHaveBeenCalledOnce();
    expect(f.fetch.mock.calls[0]![1]).toMatchObject({
      credentials: "same-origin",
    });
    expect(f.fetch.mock.calls[0]![1]?.headers).toBeUndefined();
    expect(f.account.text()).toContain("This device is remembered");
    expect(f.storage.size).toBe(0);
  });

  it("prefers a valid cookie and removes an obsolete launch token", async () => {
    const f = fixture({ initial: cookie, bootstrap: "old-owner-token" });
    await f.auth.start();
    expect(f.fetch).toHaveBeenCalledOnce();
    expect(f.storage.size).toBe(0);
    f.auth.prepareRedirect();
    expect(f.storage.size).toBe(0);
    await f.auth.request("/api/config", {
      method: "PUT",
      body: "{}",
      headers: { Authorization: "must-not-leak" },
    });
    const init = f.fetch.mock.calls.at(-1)![1]!;
    expect(new Headers(init.headers).get("Authorization")).toBeNull();
    expect(new Headers(init.headers).get("X-CSRF-Token")).toBe("csrf-test");
  });

  it("signs in with exact password, unchecked remember default, and no secret persistence", async () => {
    const f = fixture();
    await f.auth.start();
    expect(f.authenticated).not.toHaveBeenCalled();
    expect(f.byId("auth-remember").checked).toBe(false);
    const password = "  synthetic long passphrase  ";
    const field = f.byId("auth-password");
    field.value = password;
    f.byId("auth-remember").checked = true;
    f.fetch.mockResolvedValueOnce(
      Response.json({ ...cookie, remembered: true }),
    );
    await f.screen.querySelector("form")!.emit("submit");
    const [path, init] = f.fetch.mock.calls.at(-1)!;
    expect(path).toBe("/api/auth/login");
    expect(JSON.parse(init!.body as string)).toEqual({
      password,
      remember: true,
    });
    expect(field.value).toBe("");
    expect(f.storage.size).toBe(0);
    expect(f.auth.isAuthenticated()).toBe(true);
  });

  it("keeps invalid-password errors in the form and clears its password", async () => {
    const f = fixture();
    await f.auth.start();
    f.byId("auth-password").value = "wrong synthetic password";
    f.fetch.mockResolvedValueOnce(
      Response.json(
        { error: "Password did not match.", code: "auth_invalid_password" },
        { status: 401 },
      ),
    );
    await f.screen.querySelector("form")!.emit("submit");
    expect(f.screen.text()).toContain("Password did not match.");
    expect(f.byId("auth-password").value).toBe("");
    expect(f.authenticated).not.toHaveBeenCalled();
  });

  it("requires explicit owner LAN consent before sending setup", async () => {
    const setup = { ...anonymous, configured: false, secureTransport: false };
    const f = fixture({ initial: setup, bootstrap: "owner-bootstrap" });
    f.fetch.mockResolvedValueOnce(Response.json(setup)).mockResolvedValueOnce(
      Response.json({
        ...setup,
        authenticated: true,
        mode: "bootstrap",
        canSetup: true,
        canAllowInsecureLan: true,
      }),
    );
    await f.auth.start();
    expect(f.auth.isAuthenticated()).toBe(false);
    const submit = f.button("Set password & open dashboard");
    expect(submit.disabled).toBe(true);
    expect(f.byId("auth-allow-lan").checked).toBe(false);
    expect(f.screen.text()).toContain("not encrypted");
    expect(f.byId("auth-password").minLength).toBe(8);
    expect(f.byId("auth-confirm-password").minLength).toBe(8);
    expect(f.screen.text()).toContain("Use at least 8 characters.");
    f.byId("auth-password").value = "eight888";
    f.byId("auth-confirm-password").value = "eight888";
    await f.screen.querySelector("form")!.emit("submit");
    expect(f.fetch).toHaveBeenCalledTimes(2);
    f.byId("auth-allow-lan").checked = true;
    await f.byId("auth-allow-lan").emit("change");
    f.fetch.mockResolvedValueOnce(
      Response.json({
        ...cookie,
        secureTransport: false,
        allowInsecureLan: true,
      }),
    );
    await f.screen.querySelector("form")!.emit("submit");
    const [path, init] = f.fetch.mock.calls.at(-1)!;
    expect(path).toBe("/api/auth/setup");
    expect(new Headers(init!.headers).get("Authorization")).toBe(
      "Bearer owner-bootstrap",
    );
    expect(JSON.parse(init!.body as string)).toEqual({
      password: "eight888",
      remember: false,
      allowInsecureLan: true,
    });
    expect(f.storage.size).toBe(0);
  });

  it("does not offer anonymous LAN opt-in or submit passwords on an unsupported transport", async () => {
    const f = fixture({ initial: { ...anonymous, secureTransport: false } });
    await f.auth.start();
    expect(f.body.querySelector("#auth-allow-lan")).toBeNull();
    expect(f.button("Sign in").disabled).toBe(true);
    await f.screen.querySelector("form")!.emit("submit");
    expect(f.fetch).toHaveBeenCalledOnce();
  });

  it("locks only expired authentication, keeps drafts, and resumes on password sign-in", async () => {
    const f = fixture({ initial: cookie });
    await f.auth.start();
    f.dialog.open = true;
    f.fetch.mockResolvedValueOnce(
      Response.json(
        { code: "auth_csrf", error: "Retry this action" },
        { status: 403 },
      ),
    );
    await f.auth.request("/api/save", { method: "POST" });
    expect(f.auth.isAuthenticated()).toBe(true);
    f.fetch.mockResolvedValueOnce(
      Response.json({ code: "auth_required" }, { status: 401 }),
    );
    await f.auth.request("/api/status");
    expect(f.auth.isAuthenticated()).toBe(false);
    expect(f.workspace.inert).toBe(true);
    expect(f.dialog.open).toBe(false);
    expect(f.draft.value).toBe("Unsaved project description");
    expect(f.screen.text()).toContain("unsaved work is still here");
    f.byId("auth-password").value = "long synthetic password";
    f.fetch.mockResolvedValueOnce(Response.json(cookie));
    await f.screen.querySelector("form")!.emit("submit");
    expect(f.auth.isAuthenticated()).toBe(true);
    expect(f.draft.value).toBe("Unsaved project description");
    expect(f.dialog.open).toBe(true);
  });

  it("authenticates artifact fetches and refuses off-origin credential forwarding", async () => {
    const f = fixture({ initial: cookie });
    await f.auth.start();
    f.fetch.mockResolvedValueOnce(new Response("synthetic image"));
    const result = await f.auth.request(
      "/api/jobs/one/artifacts/screenshot.png",
    );
    expect(await result.text()).toBe("synthetic image");
    const init = f.fetch.mock.calls.at(-1)![1]!;
    expect(init.credentials).toBe("same-origin");
    expect(new Headers(init.headers).has("Authorization")).toBe(false);
    expect(new Headers(init.headers).has("X-CSRF-Token")).toBe(false);
    await expect(
      f.auth.request("https://other.example/api/status"),
    ).rejects.toThrow("stay on this server");
    expect(f.fetch).toHaveBeenCalledTimes(2);
  });

  it("confirms draft disposal before sign-out and removes recovery token", async () => {
    const f = fixture({
      initial: cookie,
      bootstrap: "old-token",
      drafts: true,
    });
    await f.auth.start();
    await f.button("Sign out").emit("click");
    expect(f.fetch).toHaveBeenCalledOnce();
    expect(f.account.text()).toContain("unsaved drafts will be discarded");
    f.fetch.mockResolvedValueOnce(Response.json(anonymous));
    await f.button("Sign out & discard drafts").emit("click");
    expect(f.fetch.mock.calls.at(-1)![0]).toBe("/api/auth/logout");
    expect(f.signedOut).toHaveBeenCalledOnce();
    expect(f.auth.isAuthenticated()).toBe(false);
    expect(f.storage.size).toBe(0);
  });

  it("revokes all browser sessions only after explicit confirmation", async () => {
    const f = fixture({ initial: cookie });
    await f.auth.start();
    await f.button("Sign out all devices").emit("click");
    expect(f.fetch).toHaveBeenCalledOnce();
    const confirmation = f.account.querySelector(".auth-signout-confirm")!;
    expect(confirmation.hidden).toBe(false);
    f.fetch.mockResolvedValueOnce(Response.json(anonymous));
    await f.button("Sign out all devices", confirmation).emit("click");
    expect(f.fetch.mock.calls.at(-1)![0]).toBe("/api/auth/logout-all");
    expect(f.signedOut).toHaveBeenCalledOnce();
  });

  it("changes password with current credential and uses the rotated CSRF token", async () => {
    const f = fixture({ initial: cookie });
    await f.auth.start();
    await f.button("Change password").emit("click");
    expect(f.byId("auth-password").minLength).toBe(8);
    expect(f.byId("auth-confirm-password").minLength).toBe(8);
    f.byId("auth-current-password").value = "current synthetic password";
    f.byId("auth-password").value = "next synthetic password";
    f.byId("auth-confirm-password").value = "next synthetic password";
    f.fetch.mockResolvedValueOnce(
      Response.json({ ...cookie, csrfToken: "rotated-csrf" }),
    );
    await f.account.querySelector("form")!.emit("submit");
    expect(f.fetch.mock.calls.at(-1)![0]).toBe("/api/auth/password");
    expect(f.account.text()).toContain(
      "Other browser sessions have been signed out",
    );
    await f.auth.request("/api/save", { method: "POST" });
    expect(
      new Headers(f.fetch.mock.calls.at(-1)![1]!.headers).get("X-CSRF-Token"),
    ).toBe("rotated-csrf");
  });

  it("clears password fields when the page is suspended", async () => {
    const f = fixture();
    await f.auth.start();
    f.byId("auth-password").value = "transient synthetic password";
    f.events.get("pagehide")!();
    expect(f.byId("auth-password").value).toBe("");
    expect(f.storage.size).toBe(0);
  });

  it("consumes a same-tab owner link immediately without losing the route or draft", async () => {
    const f = fixture({ initial: { ...anonymous, configured: false } });
    await f.auth.start();
    f.window.location.hash = `#session=${"a".repeat(64)}`;
    f.fetch
      .mockResolvedValueOnce(Response.json({ ...anonymous, configured: false }))
      .mockResolvedValueOnce(
        Response.json({
          ...anonymous,
          configured: false,
          authenticated: true,
          mode: "bootstrap",
          canSetup: true,
        }),
      );
    const handled = f.events.get("hashchange")!();
    expect(f.window.history.replaceState).toHaveBeenCalledWith(
      null,
      "",
      "/projects/shop?tab=environment",
    );
    await handled;
    expect(f.screen.text()).toContain("Make yourself at home");
    expect(f.draft.value).toBe("Unsaved project description");
    expect(
      new Headers(f.fetch.mock.calls.at(-1)![1]!.headers).get("Authorization"),
    ).toBe(`Bearer ${"a".repeat(64)}`);
  });

  it("leaves provider-return and route fragments to their existing handlers", async () => {
    const f = fixture();
    await f.auth.start();
    for (const hash of [
      "#vercel=callback",
      "#account-access",
      "#session=invalid",
      `#session=${"a".repeat(64)}&vercel=callback`,
    ]) {
      f.window.location.hash = hash;
      await f.events.get("hashchange")!();
    }
    expect(f.window.history.replaceState).not.toHaveBeenCalled();
    expect(f.fetch).toHaveBeenCalledOnce();
  });
});
