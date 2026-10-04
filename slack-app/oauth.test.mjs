import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createSlackBroker, unseal, validReturnUrl } from "./oauth.mjs";
const now = Date.now();
const env = {
  SLACK_CLIENT_ID: "123.456",
  SLACK_CLIENT_SECRET: "fake-test-secret",
  SLACK_OAUTH_STATE_KEY: randomBytes(32).toString("base64url"),
};
function invoke(handler, action, { method = "GET", body, headers = {} } = {}) {
  const response = {
    statusCode: 200,
    headers: {},
    setHeader(k, v) {
      this.headers[k.toLowerCase()] = v;
    },
    end(value = "") {
      this.body = value;
    },
  };
  return handler(
    { url: `/api/slack/${action}`, method, body, headers },
    response,
  ).then(() => response);
}
test("encrypted channel credentials complete the browser-bound OAuth flow", async () => {
  let exchanged = 0;
  const handler = createSlackBroker({
    env,
    now: () => now,
    fetcher: async (url, init) => {
      exchanged++;
      assert.equal(url, "https://slack.com/api/oauth.v2.access");
      assert.equal(init.redirect, "error");
      assert.equal(
        init.body.get("redirect_uri"),
        "https://shipgremlins.ai/api/slack/callback",
      );
      return Response.json({
        ok: true,
        access_token: "not-retained",
        team: { id: "T1", name: "Crew" },
        incoming_webhook: {
          url: "https://hooks.slack.com/services/T/B/test",
          channel_id: "C1",
          channel: "#gremlins",
        },
      });
    },
  });
  const pair = {
    key: randomBytes(32).toString("base64url"),
    nonce: randomBytes(24).toString("base64url"),
    returnUrl: "http://192.168.1.4:4311/",
  };
  const start = await invoke(handler, "connect", {
    method: "POST",
    body: pair,
    headers: { "content-type": "application/json" },
  });
  assert.equal(start.statusCode, 200);
  assert.ok(!start.body.includes(pair.key));
  const request = new URL(JSON.parse(start.body).url).searchParams.get(
    "request",
  );
  const page = await invoke(handler, `authorize?request=${request}`);
  assert.equal(page.headers["referrer-policy"], "strict-origin");
  assert.match(page.body, /192\.168\.1\.4:4311/);
  assert.ok(!page.body.includes(pair.key));
  const auth = await invoke(handler, "authorize", {
    method: "POST",
    body: { request },
    headers: { origin: "https://shipgremlins.ai" },
  });
  const state = new URL(auth.headers.location).searchParams.get("state");
  const cookie = auth.headers["set-cookie"].split(";")[0];
  const forged = await invoke(handler, `callback?code=code&state=${state}`);
  assert.equal(forged.statusCode, 403);
  assert.equal(exchanged, 0);
  const success = await invoke(handler, `callback?code=code&state=${state}`, {
    headers: { cookie },
  });
  assert.equal(success.statusCode, 303);
  assert.equal(exchanged, 1);
  assert.ok(!success.headers.location.includes("hooks.slack.com"));
  const payload = unseal(
    new URL(success.headers.location).hash.slice(7),
    Buffer.from(pair.key, "base64url"),
  );
  assert.equal(payload.nonce, pair.nonce);
  assert.equal(payload.connection.channelName, "#gremlins");
  assert.ok(!JSON.stringify(payload).includes("not-retained"));
});
test("missing configuration remains honest and errors never include secrets", async () => {
  const off = createSlackBroker({ env: {} });
  assert.deepEqual(JSON.parse((await invoke(off, "status")).body), {
    available: false,
  });
  const res = await invoke(
    createSlackBroker({ env }),
    "callback?state=forged&code=secret-code",
  );
  assert.equal(res.statusCode, 400);
  assert.ok(!res.body.includes("secret-code"));
});
test("return destinations disallow credentials, public HTTP, and non-dashboard paths", () => {
  for (const value of [
    "https://example.com/",
    "http://127.0.0.1:123/",
    "http://192.168.1.3:4311/",
    "http://100.64.1.2/",
  ])
    assert.equal(validReturnUrl(value), true);
  for (const value of [
    "javascript:alert(1)",
    "https://user:pass@example.com/",
    "http://public.example/",
    "http://8.8.8.8/",
    "https://example.com/evil",
    "https://example.com/?token=x",
    "https://example.com/#x",
  ])
    assert.equal(validReturnUrl(value), false);
});
test("browser initiation requires the hosted origin", async () => {
  const res = await invoke(createSlackBroker({ env }), "authorize", {
    method: "POST",
    body: { request: "x" },
    headers: { origin: "https://evil.test" },
  });
  assert.equal(res.statusCode, 403);
});
