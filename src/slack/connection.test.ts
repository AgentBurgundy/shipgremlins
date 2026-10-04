import { realpathSync } from "node:fs";
import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createSlackConnect,
  getSlackConnection,
  sealSlackEnvelope,
  validSlackWebhook,
} from "./connection.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
const hook = "https://hooks.slack.com/services/T123/B456/fake-only-test";
const connection = {
  webhookUrl: hook,
  teamId: "T123",
  teamName: "Test crew",
  channelId: "C456",
  channelName: "gremlins",
  connectedAt: "2026-10-04T12:00:00.000Z",
};
async function fixture() {
  const root = await mkdtemp(
    join(realpathSync(tmpdir()), "gremlins-slack-test-"),
  );
  roots.push(root);
  let pair: { key: string; nonce: string; returnUrl: string } | undefined;
  const fetcher = vi.fn(
    async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith("/status"))
        return Response.json({ available: true });
      pair = JSON.parse(String(init?.body));
      return Response.json({
        url: "https://shipgremlins.ai/api/slack/authorize?request=test",
      });
    },
  );
  const api = createSlackConnect({
    root,
    session: "session-one",
    fetch: fetcher,
  });
  const envelope = (overrides = {}) =>
    sealSlackEnvelope(
      {
        nonce: pair!.nonce,
        expires: Date.now() + 60_000,
        connection,
        ...overrides,
      },
      Buffer.from(pair!.key, "base64url"),
    );
  return { root, api, fetcher, envelope };
}
describe("Slack pairing", () => {
  it("saves an authenticated, encrypted connection and consumes the one-time pending key", async () => {
    const f = await fixture();
    await f.api.connect("http://192.168.1.4:4311/");
    const envelope = f.envelope();
    const status = await f.api.complete(envelope);
    expect(status.connected).toBe(true);
    expect(status.channel?.name).toBe("gremlins");
    expect(JSON.stringify(status)).not.toContain(hook);
    expect(await getSlackConnection(f.root)).toEqual(connection);
    await expect(f.api.complete(envelope)).rejects.toThrow("expired");
    await expect(
      readFile(join(f.root, ".run/slack/pending.json")),
    ).rejects.toThrow();
    await f.api.disconnect();
    expect(await getSlackConnection(f.root)).toBeNull();
  });
  it("rejects changed ciphertext, wrong nonce, expired payload, and another dashboard session", async () => {
    const f = await fixture();
    await f.api.connect("http://127.0.0.1:4311/");
    const envelope = f.envelope();
    await expect(f.api.complete(`X${envelope.slice(1)}`)).rejects.toThrow(
      "verified",
    );
    await expect(
      f.api.complete(f.envelope({ nonce: "other" })),
    ).rejects.toThrow("verified");
    await expect(
      f.api.complete(f.envelope({ expires: Date.now() - 1000 })),
    ).rejects.toThrow("verified");
    await expect(
      createSlackConnect({
        root: f.root,
        session: "other",
        fetch: f.fetcher,
      }).complete(envelope),
    ).rejects.toThrow("expired");
    expect(await getSlackConnection(f.root)).toBeNull();
  });
  it("keeps the previous connection when authorization is canceled", async () => {
    const f = await fixture();
    await f.api.webhook(hook);
    await f.api.connect("http://127.0.0.1:4311/");
    await expect(
      f.api.complete(f.envelope({ error: "access_denied" })),
    ).rejects.toThrow("canceled");
    expect((await getSlackConnection(f.root))?.webhookUrl).toBe(hook);
  });
  it("does not fetch manual webhook URLs or expose them in status", async () => {
    const f = await fixture();
    expect((await f.api.webhook(hook)).connected).toBe(true);
    expect(
      f.fetcher.mock.calls.every(([url]) =>
        String(url).startsWith("https://shipgremlins.ai/"),
      ),
    ).toBe(true);
    await expect(f.api.webhook("http://127.0.0.1/internal")).rejects.toThrow(
      "hooks.slack.com",
    );
  });
  it("rejects hostile broker destinations before persisting a pairing key", async () => {
    const f = await fixture();
    f.fetcher.mockImplementation(async () =>
      Response.json({
        url: "https://shipgremlins.ai.evil.test/api/slack/authorize",
      }),
    );
    await expect(f.api.connect("http://127.0.0.1:4311/")).rejects.toThrow(
      "Invalid Slack",
    );
    await expect(
      readFile(join(f.root, ".run/slack/pending.json")),
    ).rejects.toThrow();
  });
  it.each([
    "http://hooks.slack.com/services/A/B/C",
    "https://evil.test/services/A/B/C",
    "https://hooks.slack.com@evil.test/services/A/B/C",
    "https://hooks.slack.com/services/A/B/C?redirect=x",
    "https://hooks.slack.com/services/A/B/C#token",
    "https://hooks.slack.com/services/A/B/C/extra",
  ])("rejects unsafe webhook %s", (value) =>
    expect(validSlackWebhook(value)).toBe(false),
  );
});
