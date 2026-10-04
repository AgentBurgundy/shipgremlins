import { afterEach, describe, expect, it, vi } from "vitest";
import { SlackWebhook } from "./slack.ts";
import { clientsFromEnv } from "./index.ts";
import { GitHubForge } from "../forge/github.ts";
import { LinearApi } from "./linear.ts";
import { VercelApi } from "./vercel.ts";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("SlackWebhook", () => {
  it("POSTs { text, blocks } as JSON to the webhook", async () => {
    const fetch = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response("ok", { status: 200 }),
    );
    vi.stubGlobal("fetch", fetch);
    const blocks = [
      { type: "header", text: { type: "plain_text", text: "hi" } },
    ];
    await new SlackWebhook().post(
      "https://hooks.slack.com/services/T/B/x",
      blocks,
      "hi",
    );
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init = {}] = fetch.mock.calls[0]!;
    expect(url).toBe("https://hooks.slack.com/services/T/B/x");
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("content-type")).toBe(
      "application/json",
    );
    expect(JSON.parse(init.body as string)).toEqual({
      text: "hi",
      blocks,
      unfurl_links: false,
      unfurl_media: false,
    });
    expect(init.redirect).toBe("error");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("hides Slack response text and the private webhook path", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("invalid_blocks", { status: 400 })),
    );
    const err: unknown = await new SlackWebhook()
      .post("https://hooks.slack.com/services/T/B/secret", [], "x")
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(err).toBeInstanceOf(Error);
    const message = (err as Error).message;
    expect(message).toContain("could not be delivered");
    expect(message).not.toContain("invalid_blocks");
    expect(message).not.toContain("secret");
  });

  it("does not retry — a webhook post is not idempotent", async () => {
    const fetch = vi.fn(
      async () => new Response("service unavailable", { status: 503 }),
    );
    vi.stubGlobal("fetch", fetch);
    await expect(
      new SlackWebhook().post(
        "https://hooks.slack.com/services/T/B/x",
        [],
        "x",
      ),
    ).rejects.toThrow("could not be delivered");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    "https://attacker.example/services/a/b/c",
    "http://hooks.slack.com/services/a/b/c",
    "https://user:token@hooks.slack.com/services/a/b/c",
  ])("refuses unsafe webhook %s without making a request", async (url) => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(
      new SlackWebhook({ fetch: fetcher }).post(url, [], "Report"),
    ).rejects.toThrow("valid Slack incoming webhook");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("bounds a hung fetch even when its adapter ignores abort", async () => {
    const fetcher = vi.fn<typeof fetch>(() => new Promise(() => {}));
    await expect(
      new SlackWebhook({ fetch: fetcher, timeoutMs: 5 }).post(
        "https://hooks.slack.com/services/T/B/x",
        [],
        "Report",
      ),
    ).rejects.toThrow("could not be delivered");
    expect(fetcher.mock.calls[0]![1]!.signal?.aborted).toBe(true);
  });
});

describe("clientsFromEnv", () => {
  const env = {
    GITHUB_TOKEN: "ghs_x",
    LINEAR_API_KEY: "lin_x",
    VERCEL_TOKEN: "vc_x",
  };

  it("builds the four real clients from the three variables", () => {
    const clients = clientsFromEnv(env);
    expect(clients.forge).toBeInstanceOf(GitHubForge);
    expect(clients.linear).toBeInstanceOf(LinearApi);
    expect(clients.vercel).toBeInstanceOf(VercelApi);
    expect(clients.slack).toBeInstanceOf(SlackWebhook);
  });

  it.each(["GITHUB_TOKEN", "LINEAR_API_KEY", "VERCEL_TOKEN"] as const)(
    "names %s when it is missing or empty",
    (name) => {
      expect(() => clientsFromEnv({ ...env, [name]: undefined })).toThrow(
        `Missing environment variable ${name}`,
      );
      expect(() => clientsFromEnv({ ...env, [name]: "" })).toThrow(name);
    },
  );
});
