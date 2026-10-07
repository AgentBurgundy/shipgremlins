import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runReviewReceipts,
  validateReviewPlan,
} from "../../runner-local/review-receipts.mjs";
import type { PmReviewPlan } from "./types.ts";
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
const SHA = "a".repeat(40),
  png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
type PausedRequest = {
  requestId: string;
  resourceType: string;
  frameId: string;
  request: { url: string; method: string; headers: Record<string, string> };
};
function world() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "gremlins-review-")));
  roots.push(root);
  const plan: PmReviewPlan = {
    schema: 1,
    id: "plan",
    jobId: "job-review",
    project: "app",
    area: "core",
    configuration: "config",
    createdAt: "2026-10-05",
    deployment: {
      id: "dep",
      url: "https://preview.example",
      sha: SHA,
      branch: "pm-staging",
      provider: "railway",
      state: "READY",
    },
    deliveries: [
      {
        id: "job-code",
        ticket: {
          id: "ticket",
          identifier: "T-1",
          title: "Fix name",
          description: "scope",
        },
        implementationPr: 1,
        mergeSha: SHA,
        scopeHash: "scope",
        criteria: ["The saved name is visible."],
      },
    ],
  };
  const request = {
    schema: 1,
    planId: plan.id,
    deliveries: [
      {
        id: "job-code",
        checks: [
          {
            criterion: plan.deliveries[0]!.criteria[0],
            path: "/settings",
            kind: "text-visible",
            text: "Ronald",
          },
        ],
      },
    ],
  };
  const locator = {
    count: async () => 1,
    isVisible: async () => true,
    fill: vi.fn(async () => {}),
    click: vi.fn(async () => {}),
    selectOption: vi.fn(async () => {}),
    check: vi.fn(async () => {}),
    uncheck: vi.fn(async () => {}),
  };
  let paused: ((event: PausedRequest) => Promise<void>) | undefined;
  const session = {
    send: vi.fn(async (method: string, _params?: Record<string, unknown>) => {
      if (method === "Page.getFrameTree")
        return { frameTree: { frame: { id: "main" } } };
      return {};
    }),
    on: vi.fn((event: string, listener: typeof paused) => {
      if (event === "Fetch.requestPaused") paused = listener;
    }),
    detach: vi.fn(async () => {}),
  };
  const newCDPSession = vi.fn(async () => session);
  const intercept = async (
    url: string,
    {
      id = "request",
      method = "GET",
      resourceType = "Document",
      headers = {},
    }: {
      id?: string;
      method?: string;
      resourceType?: string;
      headers?: Record<string, string>;
    } = {},
  ) => {
    if (!paused)
      throw new Error("Browser access was not installed before navigation.");
    await paused({
      requestId: id,
      resourceType,
      frameId: "main",
      request: { url, method, headers },
    });
    return [...session.send.mock.calls]
      .reverse()
      .find(([, params]) => params?.requestId === id);
  };
  const page = {
    context: () => ({ newCDPSession }),
    setDefaultTimeout: () => {},
    goto: vi.fn(async (): Promise<{ status: () => number }> => ({
      status: () => 200,
    })),
    url: () => "https://preview.example/settings",
    getByText: () => locator,
    locator: () => locator,
    screenshot: vi.fn(async () => png),
  };
  const context = {
    newCDPSession,
    newPage: async () => page,
    close: vi.fn(async () => {}),
  };
  const browser = {
    newContext: vi.fn(async (_options?: unknown) => context),
    close: vi.fn(async () => {}),
  };
  const chromium = { launch: async () => browser };
  const run = (bypass?: string) => {
    writeFileSync(
      join(root, "pm-review-request.json"),
      JSON.stringify(request),
    );
    return runReviewReceipts({
      plan,
      commitSha: SHA,
      outputDirectory: root,
      sessionDirectory: join(root, "private"),
      chromium,
      bypass,
    });
  };
  return {
    root,
    plan,
    request,
    locator,
    page,
    browser,
    context,
    session,
    intercept,
    run,
  };
}
describe("trusted worker browser receipts", () => {
  it("records fixed mobile and desktop evidence for every requested layout view", async () => {
    const w = world();
    Object.assign(w.request.deliveries[0]!.checks[0]!, {
      viewports: ["mobile", "desktop"],
    });
    const result = await w.run();
    const proof = JSON.parse(
      readFileSync(join(w.root, result.reviewProof.file), "utf8"),
    );
    expect(w.browser.newContext.mock.calls.map(([options]) => options)).toEqual(
      [
        { serviceWorkers: "block", viewport: { width: 390, height: 844 } },
        { serviceWorkers: "block", viewport: { width: 1280, height: 800 } },
      ],
    );
    expect(
      proof.receipts.receipts[0].views.map(
        (view: { viewport: unknown }) => view.viewport,
      ),
    ).toEqual([
      { name: "mobile", width: 390, height: 844 },
      { name: "desktop", width: 1280, height: 800 },
    ]);
    expect(proof.manifest.deliveries[0].screenshots).toHaveLength(2);
    expect(proof.manifest.deliveries[0].assertions).toHaveLength(1);
    expect(proof.manifest.deliveries[0].status).toBe("passed");
    expect(w.context.close).toHaveBeenCalledTimes(2);
  });

  it("selects the failed mobile receipt even when the desktop check passes", async () => {
    const w = world();
    Object.assign(w.request.deliveries[0]!.checks[0]!, {
      viewports: ["mobile", "desktop"],
    });
    w.locator.isVisible = vi
      .fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    const result = await w.run();
    const proof = JSON.parse(
      readFileSync(join(w.root, result.reviewProof.file), "utf8"),
    );
    const receipt = proof.receipts.receipts[0];
    expect(receipt.status).toBe("failed");
    expect(receipt.viewport.name).toBe("mobile");
    expect(receipt.screenshot.name).toContain("-mobile.png");
    expect(receipt.views.map((v: { status: string }) => v.status)).toEqual([
      "failed",
      "passed",
    ]);
  });

  it("blocks an incomplete layout replay even if another viewport reports a failure", async () => {
    const w = world();
    Object.assign(w.request.deliveries[0]!.checks[0]!, {
      viewports: ["mobile", "desktop"],
    });
    w.locator.isVisible = async () => false;
    w.page.goto
      .mockResolvedValueOnce({ status: () => 200 })
      .mockResolvedValueOnce({ status: () => 503 });
    const result = await w.run();
    const proof = JSON.parse(
      readFileSync(join(w.root, result.reviewProof.file), "utf8"),
    );
    expect(proof.receipts.receipts[0].status).toBe("blocked");
    expect(proof.manifest.deliveries[0].status).toBe("blocked");
  });

  it.each([
    [],
    ["tablet"],
    ["mobile", "mobile"],
    [{ width: 999999, height: 1 }],
    "mobile",
  ])(
    "rejects viewport recipes outside the fixed contract: %j",
    async (viewports) => {
      const w = world();
      Object.assign(w.request.deliveries[0]!.checks[0]!, { viewports });
      const result = await w.run();
      const proof = JSON.parse(
        readFileSync(join(w.root, result.reviewProof.file), "utf8"),
      );
      expect(proof.manifest.deliveries[0].status).toBe("blocked");
      expect(w.browser.newContext).not.toHaveBeenCalled();
    },
  );

  it("omits URL query tokens and fragments from retained browser receipts", async () => {
    const w = world();
    w.page.url = () =>
      "https://preview.example/settings?token=private-secret#private-fragment";
    const result = await w.run();
    const bytes = readFileSync(join(w.root, result.reviewProof.file), "utf8");
    expect(bytes).not.toContain("private-secret");
    expect(bytes).not.toContain("private-fragment");
    expect(JSON.parse(bytes).receipts.receipts[0].url).toBe(
      "https://preview.example/settings",
    );
  });

  it.each(["/login", "/sign-in/password", "/_vercel/sso"])(
    "keeps unexpected %s redirects blocked instead of sending a false product failure to coding",
    async (path) => {
      const w = world();
      w.page.url = () => `https://preview.example${path}`;
      w.locator.count = async () => 0;
      const result = await w.run();
      const proof = JSON.parse(
        readFileSync(join(w.root, result.reviewProof.file), "utf8"),
      );
      expect(proof.manifest.deliveries[0].status).toBe("blocked");
      expect(proof.receipts.receipts[0].status).toBe("blocked");
      expect(w.page.screenshot).not.toHaveBeenCalled();
    },
  );
  it("can still test an explicitly requested login page", async () => {
    const w = world();
    w.request.deliveries[0]!.checks[0]!.path = "/login";
    w.page.url = () => "https://preview.example/login";
    const result = await w.run();
    expect(
      JSON.parse(readFileSync(join(w.root, result.reviewProof.file), "utf8"))
        .manifest.deliveries[0].status,
    ).toBe("passed");
  });
  it("executes real browser API checks and binds screenshots to trusted proof digest", async () => {
    const w = world();
    const result = await w.run();
    const bytes = readFileSync(join(w.root, result.reviewProof.file));
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(
      result.reviewProof.sha256,
    );
    const proof = JSON.parse(bytes.toString());
    expect(proof.manifest.deliveries[0].status).toBe("passed");
    expect(proof.receipts.receipts[0].viewport).toEqual({
      name: "desktop",
      width: 1280,
      height: 800,
    });
    expect(w.page.goto).toHaveBeenCalledWith(
      "https://preview.example/settings",
      expect.anything(),
    );
    expect(w.page.screenshot).toHaveBeenCalledOnce();
    expect(w.browser.newContext).toHaveBeenCalledWith({
      serviceWorkers: "block",
      viewport: { width: 1280, height: 800 },
    });
    expect(w.session.send).toHaveBeenCalledWith("Fetch.enable", {
      patterns: [{ urlPattern: "*", requestStage: "Request" }],
    });
    expect(existsSync(join(w.root, "pm-review-request.json"))).toBe(false);
  });
  it.each([undefined, "private-preview-bypass"])(
    "blocks a foreign redirect after multiple same-origin hops (bypass=%s)",
    async (bypass) => {
      const w = world();
      w.page.goto.mockImplementation(async () => {
        for (const [id, url] of [
          ["first", "https://preview.example/settings"],
          ["second", "https://preview.example/intermediate"],
          ["foreign", "https://foreign.example/collect"],
        ]) {
          const decision = await w.intercept(url!, { id });
          if (decision?.[0] === "Fetch.failRequest")
            throw new Error("Blocked navigation.");
        }
        return { status: () => 200 };
      });
      const result = await w.run(bypass);
      const proof = readFileSync(join(w.root, result.reviewProof.file), "utf8");
      expect(JSON.parse(proof).manifest.deliveries[0].status).toBe("blocked");
      expect(w.session.send).toHaveBeenCalledWith("Fetch.failRequest", {
        requestId: "foreign",
        errorReason: "BlockedByClient",
      });
      expect(
        w.session.send.mock.calls.some(
          ([method, params]) =>
            method === "Fetch.continueRequest" &&
            params?.requestId === "foreign",
        ),
      ).toBe(false);
      expect(w.page.screenshot).not.toHaveBeenCalled();
      expect(w.context.close).toHaveBeenCalledOnce();
      expect(proof).not.toContain("private-preview-bypass");
      expect(proof).not.toContain("foreign.example");
    },
  );
  it("keeps bypass headers on same-origin hops while removing them from external assets", async () => {
    const w = world();
    w.page.goto.mockImplementation(async () => {
      for (const id of ["start", "redirected"])
        expect(
          await w.intercept(`https://preview.example/${id}`, {
            id,
            headers: {
              "X-Vercel-Protection-Bypass": "untrusted-value",
              accept: "text/html",
            },
          }),
        ).toEqual([
          "Fetch.continueRequest",
          {
            requestId: id,
            headers: [
              { name: "accept", value: "text/html" },
              {
                name: "x-vercel-protection-bypass",
                value: "private-preview-bypass",
              },
            ],
          },
        ]);
      expect(
        await w.intercept("https://cdn.example/app.js", {
          id: "asset",
          resourceType: "Script",
          headers: {
            "X-Vercel-Protection-Bypass": "private-preview-bypass",
            accept: "*/*",
          },
        }),
      ).toEqual([
        "Fetch.continueRequest",
        {
          requestId: "asset",
          headers: [{ name: "accept", value: "*/*" }],
        },
      ]);
      return { status: () => 200 };
    });
    const result = await w.run("private-preview-bypass");
    const proof = readFileSync(join(w.root, result.reviewProof.file), "utf8");
    expect(JSON.parse(proof).manifest.deliveries[0].status).toBe("passed");
    expect(proof).not.toContain("private-preview-bypass");
  });
  it("blocks foreign writes from public review interactions", async () => {
    const w = world();
    Object.assign(w.request.deliveries[0]!.checks[0]!, {
      steps: [{ action: "click", selector: "button.save" }],
    });
    w.locator.click.mockImplementation(async () => {
      const decision = await w.intercept("https://foreign.example/submit", {
        method: "POST",
        resourceType: "Fetch",
        id: "write",
      });
      if (decision?.[0] === "Fetch.failRequest")
        throw new Error("Blocked write.");
    });
    const result = await w.run();
    expect(
      JSON.parse(readFileSync(join(w.root, result.reviewProof.file), "utf8"))
        .manifest.deliveries[0].status,
    ).toBe("blocked");
    expect(w.session.send).toHaveBeenCalledWith("Fetch.failRequest", {
      requestId: "write",
      errorReason: "BlockedByClient",
    });
  });
  it("fails closed before navigation if the browser guard cannot initialize", async () => {
    const w = world();
    w.session.send.mockRejectedValueOnce(new Error("private-browser-error"));
    const result = await w.run();
    const proof = readFileSync(join(w.root, result.reviewProof.file), "utf8");
    expect(JSON.parse(proof).manifest.deliveries[0].status).toBe("blocked");
    expect(proof).not.toContain("private-browser-error");
    expect(w.page.goto).not.toHaveBeenCalled();
    expect(w.context.close).toHaveBeenCalledOnce();
  });
  it("ignores invented pass flags when the browser assertion fails", async () => {
    const w = world();
    w.locator.isVisible = async () => false;
    const result = await w.run();
    const proof = JSON.parse(
      readFileSync(join(w.root, result.reviewProof.file), "utf8"),
    );
    expect(proof.manifest.deliveries[0].status).toBe("failed");
  });
  it("blocks cross-origin paths before opening a page", async () => {
    const w = world();
    w.request.deliveries[0]!.checks[0]!.path = "//evil.example";
    const result = await w.run();
    expect(w.page.goto).not.toHaveBeenCalled();
    expect(
      JSON.parse(readFileSync(join(w.root, result.reviewProof.file), "utf8"))
        .manifest.deliveries[0].status,
    ).toBe("blocked");
  });
  it("replays bounded interactions with a private same-origin role session, then removes secrets", async () => {
    const w = world();
    mkdirSync(join(w.root, "private"));
    writeFileSync(
      join(w.root, "private", "member.json"),
      JSON.stringify({
        cookies: [
          {
            domain: "preview.example",
            name: "session",
            value: "private-cookie",
            path: "/",
          },
        ],
        origins: [],
      }),
    );
    Object.assign(w.request.deliveries[0]!.checks[0]!, {
      session: "member",
      steps: [
        { action: "fill", selector: "#name", value: "private-input" },
        { action: "click", selector: "button.save" },
      ],
    });
    const result = await w.run();
    expect(w.locator.fill).toHaveBeenCalledWith("private-input");
    expect(w.browser.newContext).toHaveBeenCalledWith(
      expect.objectContaining({ storageState: expect.anything() }),
    );
    expect(existsSync(join(w.root, "private", "member.json"))).toBe(false);
    const proof = readFileSync(join(w.root, result.reviewProof.file), "utf8");
    expect(proof).not.toContain("private-cookie");
    expect(proof).not.toContain("private-input");
  });
  it("rejects another origin's session instead of replaying it", async () => {
    const w = world();
    mkdirSync(join(w.root, "private"));
    writeFileSync(
      join(w.root, "private", "member.json"),
      JSON.stringify({
        cookies: [{ domain: "evil.example", name: "session", value: "secret" }],
        origins: [],
      }),
    );
    Object.assign(w.request.deliveries[0]!.checks[0]!, { session: "member" });
    const result = await w.run();
    expect(w.page.goto).not.toHaveBeenCalled();
    expect(
      JSON.parse(readFileSync(join(w.root, result.reviewProof.file), "utf8"))
        .manifest.deliveries[0].status,
    ).toBe("blocked");
  });
  it("rejects moved checkouts and empty acceptance plans", async () => {
    const w = world();
    await expect(
      runReviewReceipts({
        plan: w.plan,
        commitSha: "b".repeat(40),
        outputDirectory: w.root,
        chromium: {},
      }),
    ).rejects.toThrow("differs");
    w.plan.deliveries[0]!.criteria = [];
    expect(() => validateReviewPlan(w.plan)).toThrow(
      "finite approved criteria",
    );
  });
});
