import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  installBrowserAccess,
  prepareBrowserAccess,
} from "../../runner-local/browser-access.mjs";
import { validatePayload } from "./docker.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
type Page = Parameters<typeof installBrowserAccess>[0];
type Session = Awaited<
  ReturnType<ReturnType<Page["context"]>["newCDPSession"]>
>;
type Handler = Parameters<Session["on"]>[1];
async function fixture(
  options: { bypass?: string; restrictLogin?: boolean } = {},
) {
  let handler: Handler;
  const session = {
    send: vi.fn(
      async (
        name: string,
        _parameters?: Record<string, unknown>,
      ): Promise<unknown> =>
        name === "Page.getFrameTree"
          ? { frameTree: { frame: { id: "main" } } }
          : {},
    ),
    on: vi.fn((_name: string, callback: Handler) => {
      handler = callback;
    }),
    detach: vi.fn(async () => {}),
  };
  const context = { newCDPSession: vi.fn(async () => session) };
  const page = { context: () => context };
  const onBlocked = vi.fn();
  await installBrowserAccess(page, {
    url: "https://preview.example.test/path",
    bypass: options.bypass ?? "private-bypass",
    restrictLogin: options.restrictLogin ?? false,
    onBlocked,
  });
  let requestNumber = 0;
  const request = (
    url: string,
    { method = "GET", navigation = true, frameId = "main" } = {},
  ) => ({
    requestId: `request-${++requestNumber}`,
    resourceType: navigation ? "Document" : "Fetch",
    frameId,
    request: {
      url,
      method,
      headers: {
        "X-Vercel-Protection-Bypass": "stale-secret",
        accept: "text/html",
      },
    },
  });
  return {
    context,
    session,
    page,
    onBlocked,
    request,
    handle: (event: ReturnType<typeof request>) => handler(event),
  };
}
describe("private Playwright preview access", () => {
  it("intercepts every redirect request and injects bypass only at the admitted origin", async () => {
    const f = await fixture();
    expect(f.session.send).toHaveBeenCalledWith("Fetch.enable", {
      patterns: [{ urlPattern: "*", requestStage: "Request" }],
    });
    for (const path of ["/first-hop", "/second-hop"]) {
      const same = f.request(`https://preview.example.test${path}`);
      await f.handle(same);
      expect(f.session.send).toHaveBeenLastCalledWith("Fetch.continueRequest", {
        requestId: same.requestId,
        headers: [
          { name: "accept", value: "text/html" },
          { name: "x-vercel-protection-bypass", value: "private-bypass" },
        ],
      });
    }
    for (const url of [
      "https://vercel.com/login",
      "https://preview.example.test.evil.test/",
      "http://preview.example.test/",
      "https://preview.example.test:444/",
    ]) {
      const foreign = f.request(url);
      await f.handle(foreign);
      expect(f.session.send).toHaveBeenLastCalledWith("Fetch.failRequest", {
        requestId: foreign.requestId,
        errorReason: "BlockedByClient",
      });
    }
    await installBrowserAccess(f.page, {
      url: "https://preview.example.test",
      bypass: "private-bypass",
    });
    expect(f.context.newCDPSession).toHaveBeenCalledTimes(1);
    await installBrowserAccess(
      { context: () => f.context },
      { url: "https://preview.example.test", bypass: "private-bypass" },
    );
    expect(f.context.newCDPSession).toHaveBeenCalledTimes(2);
  });
  it.each([
    { bypass: "private-bypass", restrictLogin: false },
    { bypass: "private-bypass", restrictLogin: true },
    { bypass: "", restrictLogin: true },
  ])("keeps private navigation and writes scoped for %j", async (options) => {
    const f = await fixture(options);
    for (const requestOptions of [
      { method: "GET", navigation: true },
      { method: "POST", navigation: true },
      { method: "POST", navigation: false },
      { method: "PUT", navigation: false },
      { method: "DELETE", navigation: false },
    ]) {
      const foreign = f.request(
        "https://foreign.example.test/login",
        requestOptions,
      );
      await f.handle(foreign);
      expect(f.session.send).toHaveBeenLastCalledWith("Fetch.failRequest", {
        requestId: foreign.requestId,
        errorReason: "BlockedByClient",
      });
    }
    const login = f.request("https://preview.example.test/login", {
      method: "POST",
    });
    await f.handle(login);
    expect(f.session.send).toHaveBeenLastCalledWith("Fetch.continueRequest", {
      requestId: login.requestId,
      headers: [
        { name: "accept", value: "text/html" },
        ...(options.bypass
          ? [{ name: "x-vercel-protection-bypass", value: options.bypass }]
          : []),
      ],
    });
    for (const method of ["GET", "HEAD", "OPTIONS"]) {
      const asset = f.request("https://cdn.example.test/asset", {
        method,
        navigation: false,
      });
      await f.handle(asset);
      expect(f.session.send).toHaveBeenLastCalledWith("Fetch.continueRequest", {
        requestId: asset.requestId,
        headers: [{ name: "accept", value: "text/html" }],
      });
    }
  });
  it("identifies blocked top-level navigation separately from telemetry and frames", async () => {
    const f = await fixture();
    const url = "https://foreign.example.test/path";
    await f.handle(f.request(url));
    expect(f.onBlocked).toHaveBeenLastCalledWith(url, true, true);
    await f.handle(f.request(url, { frameId: "child" }));
    expect(f.onBlocked).toHaveBeenLastCalledWith(url, true, false);
    await f.handle(f.request(url, { method: "POST", navigation: false }));
    expect(f.onBlocked).toHaveBeenLastCalledWith(url, false, true);
  });
  it("aborts protocol errors without exposing private headers to the model", async () => {
    const f = await fixture();
    const request = f.request("https://preview.example.test");
    f.session.send.mockRejectedValueOnce(new Error("Headers: private-bypass"));
    await expect(f.handle(request)).resolves.toBeUndefined();
    expect(f.session.send).toHaveBeenLastCalledWith("Fetch.failRequest", {
      requestId: request.requestId,
      errorReason: "BlockedByClient",
    });
  });
  it("stores bypass and named login values privately while CLI arguments and initialization code contain only paths", () => {
    const directory = mkdtempSync(join(tmpdir(), "gremlins-browser-access-"));
    roots.push(directory);
    const args = prepareBrowserAccess(directory, {
      url: "https://preview.example.test/login",
      credentials: {
        GREMLINS_PREVIEW_BYPASS: "private-bypass",
        GREMLINS_TEST_USERNAME_1: "private-user",
        GREMLINS_TEST_PASSWORD_1: "private-password",
        LINEAR_API_KEY: "unrelated-secret",
      },
    });
    expect(args).toEqual(["--config", join(directory, "playwright.json")]);
    const config = JSON.parse(readFileSync(args[1]!, "utf8"));
    expect(config.browser.contextOptions.serviceWorkers).toBe("block");
    expect(config.browser.isolated).toBe(true);
    expect(config.secrets.GREMLINS_TEST_PASSWORD_1).toBe("private-password");
    expect(JSON.stringify(config)).not.toContain("unrelated-secret");
    const init = readFileSync(config.browser.initPage[0], "utf8");
    expect(init).not.toContain("private-bypass");
    const access = JSON.parse(
      readFileSync(join(directory, "browser-access.json"), "utf8"),
    );
    expect(access).toEqual({
      url: "https://preview.example.test",
      bypass: "private-bypass",
      restrictLogin: true,
    });
  });
  it("installs the account guard for a password app that has no preview bypass", () => {
    const directory = mkdtempSync(join(tmpdir(), "gremlins-browser-access-"));
    roots.push(directory);
    const args = prepareBrowserAccess(directory, {
      url: "https://app.example.test/login",
      credentials: { GREMLINS_TEST_PASSWORD_1: "private-password" },
    });
    const config = JSON.parse(readFileSync(args[1]!, "utf8"));
    expect(config.browser.initPage).toEqual([
      join(directory, "browser-init.mjs"),
    ]);
    expect(
      JSON.parse(readFileSync(join(directory, "browser-access.json"), "utf8")),
    ).toEqual({
      url: "https://app.example.test",
      bypass: "",
      restrictLogin: true,
    });
  });
  it("refuses an unscoped bypass or unsafe selected URL", () => {
    expect(() =>
      prepareBrowserAccess("unused", {
        credentials: { GREMLINS_PREVIEW_BYPASS: "private" },
      }),
    ).toThrow("no selected browser environment");
    expect(() =>
      prepareBrowserAccess("unused", {
        credentials: { GREMLINS_TEST_USERNAME_1: "private-user" },
      }),
    ).toThrow("no selected browser environment");
    for (const browserTarget of [
      "file:///secret",
      "https://user:password@app.test",
      "javascript:alert(1)",
    ]) {
      expect(() =>
        validatePayload({
          kind: "pm",
          browserVerification: true,
          browserTarget,
        }),
      ).toThrow("valid selected browser environment");
    }
    expect(() =>
      validatePayload({
        kind: "pm",
        browserVerification: false,
        browserTarget: "https://app.test",
      }),
    ).toThrow("Invalid selected browser environment");
  });
});
