import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchJson, fetchText, HttpError } from "./http.ts";

function json(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchJson", () => {
  it("returns the parsed body on 2xx", async () => {
    const fetch = vi.fn(async () => json({ ok: 1 }));
    vi.stubGlobal("fetch", fetch);
    await expect(fetchJson("https://x.test/a")).resolves.toEqual({ ok: 1 });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("returns null for 204 / empty bodies", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 204 })),
    );
    await expect(
      fetchJson("https://x.test/a", { method: "POST" }),
    ).resolves.toBeNull();
  });

  it("retries 429 and 5xx with backoff, then succeeds", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(json({ message: "slow down" }, 429))
      .mockResolvedValueOnce(new Response("boom", { status: 502 }))
      .mockResolvedValueOnce(json({ ok: true }));
    vi.stubGlobal("fetch", fetch);
    await expect(
      fetchJson("https://x.test/a", {}, { retries: 3, backoffMs: 0 }),
    ).resolves.toEqual({ ok: true });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("honours Retry-After on 429", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(json({}, 429, { "retry-after": "0" }))
      .mockResolvedValueOnce(json({ ok: true }));
    vi.stubGlobal("fetch", fetch);
    await expect(
      fetchJson("https://x.test/a", {}, { backoffMs: 0 }),
    ).resolves.toEqual({
      ok: true,
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("throws a typed HttpError after the retries are spent", async () => {
    const fetch = vi.fn(async () => new Response("down", { status: 503 }));
    vi.stubGlobal("fetch", fetch);
    const err = await fetchJson(
      "https://x.test/a",
      {},
      { retries: 2, backoffMs: 0 },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(503);
    expect((err as HttpError).body).toBe("down");
    expect((err as HttpError).message).toContain("GET https://x.test/a");
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("does not retry 4xx other than 429", async () => {
    const fetch = vi.fn(async () => json({ message: "Not Found" }, 404));
    vi.stubGlobal("fetch", fetch);
    const err = await fetchJson("https://x.test/a", {}, { backoffMs: 0 }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).status).toBe(404);
    expect((err as HttpError).json()).toEqual({ message: "Not Found" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("retries a network failure and rethrows the last one", async () => {
    const fetch = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    vi.stubGlobal("fetch", fetch);
    await expect(
      fetchJson("https://x.test/a", {}, { retries: 1, backoffMs: 0 }),
    ).rejects.toThrow("fetch failed");
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("passes method, headers and body through", async () => {
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) => json({}));
    vi.stubGlobal("fetch", fetch);
    await fetchJson("https://x.test/a", {
      method: "PUT",
      headers: { authorization: "Bearer t" },
      body: "{}",
    });
    const [url, init = {}] = fetch.mock.calls[0]!;
    expect(url).toBe("https://x.test/a");
    expect(init.method).toBe("PUT");
    expect(init.body).toBe("{}");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer t");
  });
});

describe("fetchText", () => {
  it("returns the raw body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("line1\nline2", { status: 200 })),
    );
    await expect(fetchText("https://x.test/log")).resolves.toBe("line1\nline2");
  });
});
