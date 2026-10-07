import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

type Provider = "linear" | "vercel";
type Project = {
  name: string;
  instanceId: string;
  repo: string;
  provider: string;
  linear?: { connectionId: string };
};
type ReturnState = {
  remember(project: Project, id: string, provider: Provider): void;
  pending(provider: Provider, id: string): boolean;
  clear(): void;
};
type Flow = {
  initializeService(provider: Provider): Promise<void>;
  refreshService(
    provider: Provider,
    refreshAvailability?: boolean,
  ): Promise<void>;
  connectService(
    provider: Provider,
    input?: { project?: Project; connectionId?: string },
  ): Promise<void>;
};
const app = readFileSync("dashboard/app.js", "utf8");
const start = app.indexOf("  async function refreshService(");
const end = app.indexOf(
  "  for (const [provider, config] of Object.entries(serviceProviders))",
  start,
);
if (start < 0 || end < 0)
  throw new Error("Connection functions could not be loaded from app.js.");
const functions = app.slice(start, end);
const hintKey = "shipgremlins.project-connection-return";
function fixture(provider: Provider, values = new Map<string, string>()) {
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  };
  const project: Project = {
    name: "forevermods",
    instanceId: "original-project",
    provider: "github",
    repo: "owner/forevermods",
    linear: { connectionId: "work" },
  };
  const status = {
    projects: [project],
    serviceConnections: [
      { provider, id: "work", connected: true, needsReconnect: false },
    ],
  };
  const api = vi.fn(async (path: string, _input?: object): Promise<unknown> => {
    if (path === "/api/status") return status;
    if (path.includes("/connect?"))
      return {
        url: `https://shipgremlins.ai/api/${provider}/authorize?state=synthetic`,
      };
    if (path.includes("/complete?")) return { ok: true };
    return { available: true, connected: true, needsReconnect: false };
  });
  const navigate = vi.fn(() => true),
    assign = vi.fn(),
    resumeHosting = vi.fn(async (_name: string) => {}),
    resumeLinear = vi.fn(async (_name: string) => {});
  const nodes = new Map<string, { textContent: string }>();
  const node = (id: string) => {
    if (!nodes.has(id)) nodes.set(id, { textContent: "" });
    return nodes.get(id)!;
  };
  const messages: { text: string; error: boolean }[] = [];
  const serviceSelection = { linear: "work", vercel: "work" },
    serviceStatuses = new Map(),
    serviceBusy = new Set();
  const window = { sessionStorage: storage, location: { assign } } as {
    sessionStorage: typeof storage;
    location: { assign: typeof assign };
    createProjectConnectionReturn(options: object): ReturnState;
  };
  runInNewContext(readFileSync("dashboard/connection-return.js", "utf8"), {
    window,
  });
  const connectionReturn = window.createProjectConnectionReturn({
    storage: () => storage,
    now: () => 1000,
  });
  let unsaved = false;
  const context: Record<string, unknown> = {
    window,
    sessionStorage: storage,
    URL,
    auth: {
      isAuthenticated: () => true,
      prepareRedirect: () =>
        storage.setItem("synthetic-session-key", "synthetic-session"),
    },
    sessionKey: "synthetic-session-key",
    serviceEnvelopes: { linear: "", vercel: "" },
    serviceSelection,
    serviceStatuses,
    serviceBusy,
    connectionReturn,
    serviceProviders: {
      linear: { name: "Linear" },
      vercel: { name: "Vercel" },
    },
    formsLocked: false,
    restarting: false,
    hasUnsavedInputs: () => unsaved,
    validProfileId: (id: string) => /^[a-z][a-z0-9-]{0,62}$/.test(id),
    serviceUrl: (
      p: string,
      action = "",
      id = serviceSelection[p as Provider],
    ) => `/api/${p}${action ? `/${action}` : ""}?connection=${id}`,
    rememberService: (p: Provider, id: string) => {
      serviceSelection[p] = id;
    },
    rememberServiceStatus: (p: Provider, value: unknown) => {
      serviceStatuses.set(p, value);
    },
    api,
    renderServiceControls: vi.fn(),
    $: node,
    message: (_node: object, text: string, error = false) => {
      messages.push({ text, error });
    },
    refreshLinearResources: vi.fn(async () => {}),
    pages: { navigate },
    projectOnboarding: { resumeHosting },
    linearOnboarding: { resume: resumeLinear },
    currentStatus: null,
    refreshStatus: async () => {
      const result = await api("/api/status");
      context.currentStatus = result;
      return result;
    },
  };
  runInNewContext(
    `${functions}\nthis.flow = { initializeService, refreshService, connectService };`,
    context,
  );
  return {
    flow: context.flow as Flow,
    api,
    project,
    status,
    values,
    storage,
    connectionReturn,
    navigate,
    assign,
    resumeHosting,
    resumeLinear,
    serviceBusy,
    serviceStatuses,
    messages,
    envelope: () => {
      (context.serviceEnvelopes as Record<Provider, string>)[provider] =
        "synthetic-encrypted-envelope";
    },
    edit: () => {
      unsaved = true;
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

describe("project OAuth connection flow", () => {
  it("distinguishes an unconfigured hosted service and retries against fresh availability before opening Vercel", async () => {
    const f = fixture("vercel");
    f.api.mockResolvedValueOnce({
      available: false,
      availabilityReason: "not_configured",
      message: "A manually configured API token still works.",
    });
    await expect(
      f.flow.connectService("vercel", {
        project: f.project,
        connectionId: "work",
      }),
    ).rejects.toMatchObject({
      code: "oauth_unavailable",
      availabilityReason: "not_configured",
      message: expect.stringContaining("ShipGremlins operator"),
    });
    expect(f.assign).not.toHaveBeenCalled();
    expect(f.values.has(hintKey)).toBe(false);
    expect(f.serviceBusy.size).toBe(0);
    await f.flow.connectService("vercel", {
      project: f.project,
      connectionId: "work",
    });
    expect(f.api.mock.calls.slice(0, 2).map(([path]) => path)).toEqual([
      "/api/vercel?connection=work&refresh=1",
      "/api/vercel?connection=work&refresh=1",
    ]);
    expect(f.assign).toHaveBeenCalledOnce();
  });

  it("keeps transient Vercel availability failure distinct from operator configuration", async () => {
    const f = fixture("vercel");
    f.api.mockResolvedValueOnce({
      available: false,
      availabilityReason: "provider_unavailable",
    });
    await expect(f.flow.connectService("vercel")).rejects.toMatchObject({
      code: "oauth_unavailable",
      availabilityReason: "provider_unavailable",
      message: expect.stringContaining("Retry to check it again"),
    });
    expect(f.assign).not.toHaveBeenCalled();
  });

  it("requests fresh availability only for explicit Vercel status refresh", async () => {
    const f = fixture("vercel");
    await f.flow.refreshService("vercel");
    await f.flow.refreshService("vercel", true);
    expect(f.api.mock.calls.map(([path]) => path)).toEqual([
      "/api/vercel?connection=work",
      "/api/vercel?connection=work&refresh=1",
    ]);
  });

  it.each(["linear", "vercel"] as const)(
    "retains confirmed %s completion through provider-status failure and reload, then resumes the exact project once",
    async (provider) => {
      const f = fixture(provider);
      f.connectionReturn.remember(f.project, "work", provider);
      f.envelope();
      f.api
        .mockResolvedValueOnce({ ok: true })
        .mockRejectedValueOnce(new Error("Temporary status outage"));
      await f.flow.initializeService(provider);
      expect(f.navigate).not.toHaveBeenCalled();
      expect(f.connectionReturn.pending(provider, "work")).toBe(true);
      expect(
        f.messages.some(
          (m) => m.error && m.text.includes("Temporary status outage"),
        ),
      ).toBe(true);
      const retry = fixture(provider, f.values);
      await retry.flow.refreshService(provider);
      expect(retry.navigate).toHaveBeenCalledExactlyOnceWith(
        `/projects/forevermods${provider === "vercel" ? "?tab=environment" : ""}`,
      );
      expect(
        provider === "vercel" ? retry.resumeHosting : retry.resumeLinear,
      ).toHaveBeenCalledExactlyOnceWith("forevermods");
      expect(retry.values.has(hintKey)).toBe(false);
      expect(
        retry.api.mock.calls.some(([path]) => path.includes("/complete?")),
      ).toBe(false);
      await retry.flow.refreshService(provider);
      expect(retry.navigate).toHaveBeenCalledOnce();
      expect(retry.serviceBusy.size).toBe(0);
    },
  );

  it("keeps a confirmed callback retryable when refreshing the project catalog fails", async () => {
    const f = fixture("vercel");
    f.connectionReturn.remember(f.project, "work", "vercel");
    f.envelope();
    f.api
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ available: true, connected: true })
      .mockRejectedValueOnce(new Error("Projects temporarily unavailable"));
    await f.flow.initializeService("vercel");
    expect(f.navigate).not.toHaveBeenCalled();
    expect(f.connectionReturn.pending("vercel", "work")).toBe(true);
    expect(f.messages.at(-1)).toMatchObject({
      error: true,
      text: expect.stringContaining("project setup could not resume"),
    });
    await f.flow.refreshService("vercel");
    expect(f.resumeHosting).toHaveBeenCalledExactlyOnceWith("forevermods");
  });

  it("does not resume an unready account from stale connected provider status", async () => {
    const f = fixture("vercel");
    f.connectionReturn.remember(f.project, "work", "vercel");
    f.envelope();
    f.status.serviceConnections[0]!.needsReconnect = true;
    await f.flow.initializeService("vercel");
    expect(f.navigate).not.toHaveBeenCalled();
    expect(f.connectionReturn.pending("vercel", "work")).toBe(true);
    f.status.serviceConnections[0]!.needsReconnect = false;
    await f.flow.refreshService("vercel");
    expect(f.resumeHosting).toHaveBeenCalledOnce();
  });

  it.each(["instanceId", "repo"] as const)(
    "does not resume a stale project when %s changed during authorization",
    async (field) => {
      const f = fixture("vercel");
      f.connectionReturn.remember(f.project, "work", "vercel");
      f.envelope();
      f.project[field] = "replacement";
      await f.flow.initializeService("vercel");
      expect(f.navigate).not.toHaveBeenCalled();
      expect(f.resumeHosting).not.toHaveBeenCalled();
      expect(f.values.has(hintKey)).toBe(false);
    },
  );

  it("blocks navigation and clears the return hint when forms change during the connect request", async () => {
    const f = fixture("linear"),
      pending = deferred<unknown>();
    f.api
      .mockResolvedValueOnce({ available: true, connected: false })
      .mockReturnValueOnce(pending.promise);
    const connecting = f.flow.connectService("linear", {
      project: f.project,
      connectionId: "work",
    });
    await vi.waitFor(() => expect(f.api).toHaveBeenCalledTimes(2));
    expect(f.values.has(hintKey)).toBe(true);
    f.edit();
    pending.resolve({
      url: "https://shipgremlins.ai/api/linear/authorize?state=synthetic",
    });
    await expect(connecting).rejects.toThrow("form changed while connecting");
    expect(f.assign).not.toHaveBeenCalled();
    expect(f.values.has(hintKey)).toBe(false);
    expect(f.serviceBusy.size).toBe(0);
  });

  it("never authorizes a return from failed completion even when an old account is connected", async () => {
    const f = fixture("vercel");
    f.connectionReturn.remember(f.project, "work", "vercel");
    f.envelope();
    f.serviceStatuses.set("vercel", { connected: true });
    f.api.mockRejectedValueOnce(new Error("Authorization canceled"));
    await f.flow.initializeService("vercel");
    await f.flow.refreshService("vercel");
    expect(f.connectionReturn.pending("vercel", "work")).toBe(false);
    expect(f.navigate).not.toHaveBeenCalled();
    expect(f.resumeHosting).not.toHaveBeenCalled();
    expect(
      f.messages.some(
        (m) => m.error && m.text.includes("Authorization canceled"),
      ),
    ).toBe(true);
  });

  it.each([
    "https://other.example/api/vercel/authorize",
    "https://shipgremlins.ai/api/linear/authorize",
    "https://someone:password@shipgremlins.ai/api/vercel/authorize",
    "https://shipgremlins.ai/api/vercel/authorize#unexpected",
  ])(
    "rejects an unsafe authorization URL without redirecting: %s",
    async (url) => {
      const f = fixture("vercel");
      f.api
        .mockResolvedValueOnce({ available: true })
        .mockResolvedValueOnce({ url });
      await expect(
        f.flow.connectService("vercel", {
          project: f.project,
          connectionId: "work",
        }),
      ).rejects.toThrow("unexpected Vercel authorization address");
      expect(f.assign).not.toHaveBeenCalled();
      expect(f.values.has(hintKey)).toBe(false);
      expect(f.serviceBusy.size).toBe(0);
    },
  );

  it("opens only the validated provider authorization URL while preserving the project return identity", async () => {
    const f = fixture("vercel");
    await f.flow.connectService("vercel", {
      project: f.project,
      connectionId: "work",
    });
    expect(f.assign).toHaveBeenCalledExactlyOnceWith(
      "https://shipgremlins.ai/api/vercel/authorize?state=synthetic",
    );
    expect(f.connectionReturn.pending("vercel", "work")).toBe(false);
    expect(f.storage.getItem("gremlins-pending-vercel")).toBe("work");
    expect(JSON.parse(f.storage.getItem(hintKey)!)).toMatchObject({
      project: {
        name: f.project.name,
        instanceId: f.project.instanceId,
        repo: f.project.repo,
      },
      connectionId: "work",
    });
  });
});
