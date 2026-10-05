import { createServer, type RequestListener, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { controllerPreviewFetch } from "./controllerProbe.ts";

const servers: Server[] = [];
async function serve(handler: RequestListener) {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("No listener port.");
  return `http://host.docker.internal:${address.port}`;
}
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

describe("controller preview HTTP probe", () => {
  it("preserves virtual-host routing against a real listener, including path and preview bypass", async () => {
    let host = "",
      path = "",
      bypass = "";
    const origin = await serve((req, res) => {
      host = req.headers.host ?? "";
      path = req.url ?? "";
      bypass = String(req.headers["x-vercel-protection-bypass"] ?? "");
      res.writeHead(host.startsWith("host.docker.internal:") ? 200 : 404);
      res.end("ready");
    });
    const response = await controllerPreviewFetch(
      `${origin}/health?mode=ready`,
      {
        headers: {
          "x-vercel-protection-bypass": "fixture-bypass",
          host: "ignored.example",
        },
      },
    );
    expect(response.status).toBe(200);
    expect(host).toBe(new URL(origin).host);
    expect(path).toBe("/health?mode=ready");
    expect(bypass).toBe("fixture-bypass");
    expect(await response.text()).toBe("");
  });
  it("returns a redirect without following it or transmitting headers to its destination", async () => {
    let calls = 0;
    const origin = await serve((_req, res) => {
      calls++;
      res.writeHead(302, { location: "https://other.example/login" });
      res.end();
    });
    const response = await controllerPreviewFetch(origin);
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      "https://other.example/login",
    );
    expect(calls).toBe(1);
  });
  it("discards a body that never finishes after readiness headers", async () => {
    const origin = await serve((_req, res) => {
      res.writeHead(200);
      res.flushHeaders();
      res.write("stream remains open");
    });
    const response = await controllerPreviewFetch(origin, {
      signal: AbortSignal.timeout(250),
    });
    expect(response.ok).toBe(true);
    expect(response.body).toBeNull();
  });
  it("honors cancellation while waiting for response headers", async () => {
    const origin = await serve(() => {});
    await expect(
      controllerPreviewFetch(origin, { signal: AbortSignal.timeout(20) }),
    ).rejects.toThrow("could not be reached");
  });
  it("leaves HTTPS, ordinary HTTP, and lookalike hosts with normal fetch semantics", async () => {
    const normal = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", normal);
    for (const url of [
      "https://host.docker.internal:4443/health",
      "http://example.com/",
      "http://host.docker.internal.example.com/",
    ]) {
      expect(
        (await controllerPreviewFetch(url, { redirect: "manual" })).status,
      ).toBe(204);
      expect(normal).toHaveBeenLastCalledWith(url, { redirect: "manual" });
    }
  });
  it("rejects credential-bearing URLs and unexpected write requests", async () => {
    await expect(
      controllerPreviewFetch("http://user:password@host.docker.internal/"),
    ).rejects.toThrow("GET or HEAD");
    await expect(
      controllerPreviewFetch("http://host.docker.internal/", {
        method: "POST",
        body: "data",
      }),
    ).rejects.toThrow("GET or HEAD");
  });
});
