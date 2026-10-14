import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";

type Handler = (event: { preventDefault(): void; key?: string }) => unknown;
class Element {
  children: Element[] = [];
  attributes = new Map<string, string>();
  listeners = new Map<string, Handler>();
  dataset: Record<string, string> = {};
  className = "";
  textContent = "";
  value = "";
  id = "";
  name = "";
  maxLength = 0;
  tagName: string;
  disabled = false;
  hidden = false;
  href = "";
  files: Array<{ size: number; text(): Promise<string> }> = [];
  focus = vi.fn();
  constructor(tag: string) {
    this.tagName = tag.toUpperCase();
  }
  classList = {
    toggle: (value: string, on: boolean) => {
      const values = new Set(this.className.split(" "));
      if (on) values.add(value);
      else values.delete(value);
      this.className = [...values].join(" ");
    },
    remove: (value: string) => this.classList.toggle(value, false),
  };
  append(...children: Element[]) {
    this.children.push(...children);
  }
  setAttribute(key: string, value: string) {
    this.attributes.set(key, value);
  }
  getAttribute(key: string) {
    return this.attributes.get(key);
  }
  addEventListener(key: string, handler: Handler) {
    this.listeners.set(key, handler);
  }
  fire(key: string, event = {}) {
    return this.listeners.get(key)?.({ preventDefault() {}, ...event });
  }
}
const all = (root: Element): Element[] => [root, ...root.children.flatMap(all)];
const text = (root: Element): string =>
  all(root)
    .map((item) => item.textContent)
    .join(" ");
const source = readFileSync(
  new URL("../../dashboard/ai-connections.js", import.meta.url),
  "utf8",
);
const view = (provider = "codex", configured = false, model?: string) => ({
  provider,
  configured,
  ...(model ? { model } : {}),
  providers: [
    { id: "claude", label: "Claude Code", configured: true },
    { id: "codex", label: "Codex", configured },
  ],
});
const authJson = JSON.stringify({
  auth_mode: "chatgpt",
  tokens: {
    access_token: "private-access",
    id_token: "private-id",
    refresh_token: "private-refresh",
    account_id: "private-account",
  },
});
type Api = (path: string, body?: object, method?: string) => Promise<object>;
function fixture(
  api: Api = async (path) => (path === "/api/ai" ? view() : { status: "idle" }),
) {
  const events = new Map<string, () => void>();
  const document = {
    hidden: false,
    createElement: (tag: string) => new Element(tag),
    addEventListener: (name: string, handler: () => void) =>
      events.set(name, handler),
  };
  const root = new Element("div"),
    claudeAccess = new Element("div"),
    onSaved = vi.fn(async () => {});
  const window = {
    addEventListener: (name: string, handler: () => void) =>
      events.set(name, handler),
  } as unknown as {
    addEventListener(name: string, handler: () => void): void;
    aiConnectionState(status: object): {
      provider: string;
      label: string;
      configured: boolean;
    };
    createAiConnections(options: object): {
      render(status: object): void;
      setLocked(value: boolean): void;
      isDirty(): boolean;
      isBusy(): boolean;
      refresh(): Promise<void>;
    };
  };
  runInNewContext(source, {
    window,
    document,
    URL,
    Date,
    TextEncoder,
    setTimeout,
    clearTimeout,
  });
  const control = window.createAiConnections({
    root,
    claudeAccess,
    api,
    onSaved,
  });
  control.render({ ai: view() });
  control.setLocked(false);
  const byText = (value: string) =>
    all(root).find((item) => item.textContent === value)!;
  const byId = (id: string) => all(root).find((item) => item.id === id)!;
  const radio = (name: string) =>
    all(root).find(
      (item) =>
        item.getAttribute("role") === "radio" &&
        item.getAttribute("aria-label") === name,
    )!;
  return {
    window,
    root,
    claudeAccess,
    events,
    document,
    control,
    byText,
    byId,
    radio,
    onSaved,
  };
}
const settle = async () => {
  for (let index = 0; index < 10; index++) await Promise.resolve();
};
afterEach(() => vi.useRealTimers());

describe("AI provider connection UI", () => {
  it("uses only the selected provider's safe readiness, with legacy Claude compatibility", () => {
    const f = fixture();
    expect(
      f.window.aiConnectionState({
        ai: view("codex", false),
        connections: [{ name: "CLAUDE_CODE_OAUTH_TOKEN", configured: true }],
      }),
    ).toMatchObject({ provider: "codex", configured: false });
    expect(
      f.window.aiConnectionState({ ai: view("codex", true), connections: [] }),
    ).toMatchObject({ label: "Codex", configured: true });
    expect(
      f.window.aiConnectionState({
        connections: [{ name: "CLAUDE_CODE_OAUTH_TOKEN", configured: true }],
      }).configured,
    ).toBe(true);
  });
  it("shows selected and connected independently and posts only explicit provider selection", async () => {
    const api = vi.fn<Api>(async (path, body) =>
      path === "/api/ai"
        ? body
          ? view((body as { provider: string }).provider, true)
          : view()
        : { status: "idle" },
    );
    const f = fixture(api);
    await settle();
    expect(text(f.root)).toContain("Not connected · Codex selected");
    expect(f.claudeAccess.hidden).toBe(true);
    await f.radio("Claude Code").fire("click");
    expect(api).toHaveBeenCalledWith("/api/ai", { provider: "claude" });
    expect(f.radio("Claude Code").getAttribute("aria-checked")).toBe("true");
    expect(f.claudeAccess.hidden).toBe(false);
    expect(f.onSaved).toHaveBeenCalledOnce();
  });
  it("keeps the selected provider on request failure and never exposes raw provider errors", async () => {
    const api = vi.fn<Api>(async (path, body) => {
      if (body) throw new Error("private-access");
      return path === "/api/ai" ? view() : { status: "idle" };
    });
    const f = fixture(api);
    await settle();
    await f.radio("Claude Code").fire("click");
    expect(text(f.root)).not.toContain("private-access");
    expect(f.radio("Codex").getAttribute("aria-checked")).toBe("true");
    expect(text(f.root)).toContain("selection could not be confirmed");
  });
  it("reports a saved provider truthfully when only the following workspace refresh fails", async () => {
    const api = vi.fn<Api>(async (path, body) =>
      path === "/api/ai"
        ? body
          ? view("claude", true)
          : view()
        : { status: "idle" },
    );
    const f = fixture(api);
    await settle();
    f.onSaved.mockRejectedValueOnce(new Error("offline"));
    await f.radio("Claude Code").fire("click");
    expect(f.radio("Claude Code").getAttribute("aria-checked")).toBe("true");
    expect(text(f.root)).toContain("your choice was saved");
    expect(text(f.root)).not.toContain("could not be confirmed");
  });
  it("starts device sign-in, locks duplicate starts, and completes without credential payloads", async () => {
    vi.useFakeTimers();
    let started = false,
      complete = false;
    const api = vi.fn<Api>(async (path, body) => {
      if (path === "/api/ai") return view("codex", complete);
      if (body) started = true;
      return !started
        ? { status: "idle" }
        : complete
          ? { status: "complete" }
          : {
              status: "pending",
              verificationUrl: "https://auth.openai.com/codex/device",
              userCode: "ABCD-1234",
              expiresAt: "2030-01-01T00:00:00Z",
            };
    });
    const f = fixture(api);
    await settle();
    await f.byText("Sign in to Codex").fire("click");
    expect(api).toHaveBeenCalledWith("/api/ai/codex/login", {});
    expect(f.byText("Waiting for sign-in…").disabled).toBe(true);
    expect(f.byText("Continue with ChatGPT ↗").href).toBe(
      "https://auth.openai.com/codex/device",
    );
    expect(text(f.root)).toContain("ABCD-1234");
    complete = true;
    await vi.advanceTimersByTimeAsync(2500);
    expect(text(f.root)).toContain("Codex connected");
    expect(text(f.root)).not.toContain("ABCD-1234");
    expect(f.onSaved).toHaveBeenCalledOnce();
  });
  it("resumes a pending sign-in after reload and only links the official HTTPS sign-in host", async () => {
    vi.useFakeTimers();
    const f = fixture(async (path) =>
      path === "/api/ai"
        ? view()
        : {
            status: "pending",
            verificationUrl: "https://auth.openai.com.evil.test/device",
            userCode: "ABCD-1234",
          },
    );
    await settle();
    expect(f.byText("Waiting for sign-in…").disabled).toBe(true);
    expect(
      all(f.root).find((item) => item.className === "codex-device")!.hidden,
    ).toBe(true);
    expect(f.byText("Continue with ChatGPT ↗").href).toBe("#");
  });
  it("cancels only the current login and ignores a late pending poll", async () => {
    vi.useFakeTimers();
    let finish: ((value: object) => void) | undefined,
      reads = 0;
    const api = vi.fn<Api>(async (path, _body, method) => {
      if (path === "/api/ai") return view();
      if (method === "DELETE") return { status: "canceled" };
      if (++reads === 1)
        return {
          status: "pending",
          verificationUrl: "https://auth.openai.com/codex/device",
          userCode: "ABCD-1234",
        };
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    const f = fixture(api);
    await settle();
    vi.advanceTimersByTime(2500);
    await settle();
    await f.byText("Cancel sign-in").fire("click");
    finish?.({
      status: "pending",
      verificationUrl: "https://auth.openai.com/codex/device",
      userCode: "LATE-CODE",
    });
    await settle();
    expect(api).toHaveBeenCalledWith(
      "/api/ai/codex/login",
      undefined,
      "DELETE",
    );
    expect(text(f.root)).not.toContain("LATE-CODE");
    expect(f.byText("Sign in to Codex").disabled).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("imports ChatGPT auth privately, clears the draft, and never renders credential text", async () => {
    const api = vi.fn<Api>(async (path) =>
      path === "/api/ai" ? view() : { status: "idle" },
    );
    const f = fixture(api);
    await settle();
    const input = f.byId("codex-auth-json");
    input.value = authJson;
    expect(f.control.isDirty()).toBe(true);
    const form = all(f.root).find(
      (item) => item.tagName === "FORM" && all(item).includes(input),
    )!;
    await form.fire("submit");
    expect(api).toHaveBeenCalledWith("/api/connections", {
      values: { CODEX_AUTH_JSON: authJson },
    });
    expect(input.value).toBe("");
    expect(f.control.isDirty()).toBe(false);
    expect(text(f.root)).not.toContain("private-access");
  });
  it("rejects API-key, malformed and oversized imports without sending or echoing them", async () => {
    const api = vi.fn<Api>(async (path) =>
      path === "/api/ai" ? view() : { status: "idle" },
    );
    const f = fixture(api);
    await settle();
    const input = f.byId("codex-auth-json"),
      form = all(f.root).find(
        (item) => item.tagName === "FORM" && all(item).includes(input),
      )!;
    for (const value of [
      '{"OPENAI_API_KEY":"private-key"}',
      JSON.stringify({
        ...JSON.parse(authJson),
        OPENAI_API_KEY: "private-key",
      }),
      "not JSON",
      "x".repeat(65537),
    ]) {
      input.value = value;
      await form.fire("submit");
    }
    expect(api.mock.calls.some(([path]) => path === "/api/connections")).toBe(
      false,
    );
    expect(text(f.root)).not.toContain("private-key");
    expect(text(f.root)).toContain("valid Codex ChatGPT auth.json");
  });
  it("loads a bounded file into a masked draft for explicit saving and clears it on pagehide", async () => {
    const f = fixture();
    await settle();
    const file = f.byId("codex-auth-file"),
      input = f.byId("codex-auth-json");
    file.files = [{ size: authJson.length, text: async () => authJson }];
    await file.fire("change");
    expect(input.value).toBe(authJson);
    expect(input.className).not.toContain("revealed");
    expect(f.control.isDirty()).toBe(true);
    f.events.get("pagehide")?.();
    expect(input.value).toBe("");
    expect(f.control.isDirty()).toBe(false);
  });
  it("does not repopulate a private credential when a file finishes reading after pagehide", async () => {
    const f = fixture();
    await settle();
    let finish: ((value: string) => void) | undefined;
    const file = f.byId("codex-auth-file");
    file.files = [
      {
        size: authJson.length,
        text: () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      },
    ];
    const reading = file.fire("change");
    f.events.get("pagehide")?.();
    finish?.(authJson);
    await reading;
    expect(f.byId("codex-auth-json").value).toBe("");
    expect(f.control.isDirty()).toBe(false);
  });
  it("clears an expired device code and permits a new explicit sign-in", async () => {
    vi.useFakeTimers();
    let expired = false;
    const f = fixture(async (path) =>
      path === "/api/ai"
        ? view()
        : expired
          ? { status: "expired" }
          : {
              status: "pending",
              verificationUrl: "https://auth.openai.com/codex/device",
              userCode: "ABCD-1234",
            },
    );
    await settle();
    expired = true;
    await vi.advanceTimersByTimeAsync(2500);
    expect(text(f.root)).toContain("sign-in code expired");
    expect(text(f.root)).not.toContain("ABCD-1234");
    expect(f.byText("Sign in to Codex").disabled).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("preserves an advanced model draft across status polls and requires saving before a provider switch", async () => {
    const api = vi.fn<Api>(async (path, body) =>
      path === "/api/ai"
        ? view("codex", false, (body as { model?: string } | undefined)?.model)
        : { status: "idle" },
    );
    const f = fixture(api);
    await settle();
    const input = f.byId("ai-model");
    expect(input.maxLength).toBe(100);
    input.value = "gpt-5.4";
    input.fire("input");
    f.control.render({ ai: view() });
    expect(input.value).toBe("gpt-5.4");
    await f.radio("Claude Code").fire("click");
    expect(text(f.root)).toContain("Save your model edit");
    expect(api.mock.calls.some(([, body]) => Boolean(body))).toBe(false);
    const form = all(f.root).find(
      (item) => item.tagName === "FORM" && all(item).includes(input),
    )!;
    await form.fire("submit");
    expect(api).toHaveBeenCalledWith("/api/ai", {
      provider: "codex",
      model: "gpt-5.4",
    });
    expect(f.control.isDirty()).toBe(false);
  });
  it("requires confirmation to clear saved Codex, allows canceling, and keeps Codex selected after success", async () => {
    let configured = true;
    const api = vi.fn<Api>(async (path) => {
      if (path === "/api/connections/clear") {
        configured = false;
        return { ok: true };
      }
      return path === "/api/ai"
        ? view("codex", configured)
        : { status: "idle" };
    });
    const f = fixture(api);
    await settle();
    const clear = f.byText("Clear saved Codex"),
      confirmation = all(f.root).find(
        (item) =>
          item.getAttribute("aria-label") === "Clear saved Codex confirmation",
      )!;
    expect(clear.hidden).toBe(false);
    expect(confirmation.hidden).toBe(true);
    await f.byText("Clear saved value").fire("click");
    expect(
      api.mock.calls.some(([path]) => path === "/api/connections/clear"),
    ).toBe(false);
    await clear.fire("click");
    expect(confirmation.hidden).toBe(false);
    expect(
      api.mock.calls.some(([path]) => path === "/api/connections/clear"),
    ).toBe(false);
    await f.byText("Keep connected").fire("click");
    expect(confirmation.hidden).toBe(true);
    expect(
      api.mock.calls.some(([path]) => path === "/api/connections/clear"),
    ).toBe(false);
    await clear.fire("click");
    await f.byText("Clear saved value").fire("click");
    expect(api).toHaveBeenCalledWith("/api/connections/clear", {
      names: ["CODEX_AUTH_JSON"],
    });
    expect(
      api.mock.calls.filter(([path]) => path === "/api/connections/clear"),
    ).toHaveLength(1);
    expect(
      api.mock.calls.some(([path, body]) => path === "/api/ai" && body),
    ).toBe(false);
    expect(f.radio("Codex").getAttribute("aria-checked")).toBe("true");
    expect(text(f.root)).toContain("Codex stays selected; reconnect");
    expect(clear.hidden).toBe(true);
    expect(f.onSaved).toHaveBeenCalledOnce();
  });
  it("keeps the saved model when clicking the selected provider and resets it only through an explicit blank model save", async () => {
    const api = vi.fn<Api>(async (path, body) =>
      path === "/api/ai"
        ? body === undefined
          ? view("codex", true, "gpt-5.4")
          : view("codex", true, (body as { model?: string }).model)
        : { status: "idle" },
    );
    const f = fixture(api);
    await settle();
    const model = f.byId("ai-model");
    expect(model.value).toBe("gpt-5.4");
    await f.radio("Codex").fire("click");
    expect(
      api.mock.calls.some(([path, body]) => path === "/api/ai" && body),
    ).toBe(false);
    expect(model.value).toBe("gpt-5.4");
    model.value = "";
    model.fire("input");
    const form = all(f.root).find(
      (item) => item.tagName === "FORM" && all(item).includes(model),
    )!;
    await form.fire("submit");
    expect(api).toHaveBeenCalledWith("/api/ai", { provider: "codex" });
    expect(model.value).toBe("");
    expect(f.control.isDirty()).toBe(false);
  });
  it("shows safe clear-conflict guidance and keeps generic copy for other errors", async () => {
    let conflict = true;
    const api = vi.fn<Api>(async (path) => {
      if (path === "/api/connections/clear")
        throw Object.assign(
          new Error(
            conflict
              ? "Cancel queued jobs and wait for active work to finish before clearing credentials."
              : "private-access",
          ),
          { status: conflict ? 409 : 500 },
        );
      return path === "/api/ai" ? view("codex", true) : { status: "idle" };
    });
    const f = fixture(api);
    await settle();
    await f.byText("Clear saved Codex").fire("click");
    await f.byText("Clear saved value").fire("click");
    expect(text(f.root)).toContain(
      "Cancel queued jobs and wait for active work",
    );
    expect(f.radio("Codex").getAttribute("aria-checked")).toBe("true");
    conflict = false;
    await f.byText("Clear saved value").fire("click");
    expect(text(f.root)).toContain("saved Codex sign-in could not be cleared");
    expect(text(f.root)).not.toContain("private-access");
  });
  it("hides clear for an unconnected account and disables it during sign-in or other locked work", async () => {
    vi.useFakeTimers();
    const api = vi.fn<Api>(async (path, body) =>
      path === "/api/ai"
        ? view("codex", true)
        : body
          ? {
              status: "pending",
              verificationUrl: "https://auth.openai.com/codex/device",
              userCode: "ABCD-1234",
            }
          : { status: "idle" },
    );
    const f = fixture(api);
    expect(f.byText("Clear saved Codex").hidden).toBe(true);
    await settle();
    f.control.setLocked(true);
    await f.byText("Clear saved value").fire("click");
    expect(
      api.mock.calls.some(([path]) => path === "/api/connections/clear"),
    ).toBe(false);
    f.control.setLocked(false);
    await settle();
    await f.byText("Reconnect Codex").fire("click");
    expect(f.byText("Clear saved Codex").disabled).toBe(true);
    await f.byText("Clear saved value").fire("click");
    expect(
      api.mock.calls.some(([path]) => path === "/api/connections/clear"),
    ).toBe(false);
  });
  it("explains when exported credentials still configure Codex after saved access is cleared", async () => {
    const api = vi.fn<Api>(async (path) =>
      path === "/api/ai" ? view("codex", true) : { status: "idle" },
    );
    const f = fixture(api);
    await settle();
    await f.byText("Clear saved Codex").fire("click");
    await f.byText("Clear saved value").fire("click");
    expect(text(f.root)).toContain(
      "Exported account credentials still configure Codex",
    );
    expect(f.radio("Codex").getAttribute("aria-checked")).toBe("true");
    expect(f.byText("Clear saved Codex").hidden).toBe(false);
  });
});
