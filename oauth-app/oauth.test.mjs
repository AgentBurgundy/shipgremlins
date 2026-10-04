import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createOAuthBroker, unseal, validReturnUrl } from "./oauth.mjs";
const now = Date.now();
const env = {
  LINEAR_CLIENT_ID: "linear-client",
  LINEAR_OAUTH_STATE_KEY: randomBytes(32).toString("base64url"),
  VERCEL_CLIENT_ID: "vercel-client",
  VERCEL_CLIENT_SECRET: "test-secret",
  VERCEL_OAUTH_STATE_KEY: randomBytes(32).toString("base64url"),
};
async function invoke(
  handler,
  provider,
  action,
  { method = "GET", body, headers = {} } = {},
) {
  const res = {
    statusCode: 200,
    headers: {},
    setHeader(k, v) {
      this.headers[k.toLowerCase()] = v;
    },
    end(value = "") {
      this.body = value;
    },
  };
  await handler(
    { url: `/api/${provider}/${action}`, method, body, headers },
    res,
  );
  return res;
}
async function start(provider, fetcher, target = "http://192.168.1.3:4311/") {
  const handler = createOAuthBroker(provider, { env, fetcher, now: () => now });
  const pair = {
    key: randomBytes(32).toString("base64url"),
    nonce: randomBytes(24).toString("base64url"),
    returnUrl: target,
    codeChallenge: randomBytes(32).toString("base64url"),
  };
  const connect = await invoke(handler, provider, "connect", {
    method: "POST",
    body: pair,
    headers: { "content-type": "application/json" },
  });
  assert.equal(connect.statusCode, 200);
  assert.ok(!connect.body.includes(pair.key));
  const request = new URL(JSON.parse(connect.body).url).searchParams.get(
    "request",
  );
  const page = await invoke(handler, provider, `authorize?request=${request}`);
  assert.equal(page.headers["referrer-policy"], "strict-origin");
  assert.ok(page.body.includes(new URL(target).origin));
  const auth = await invoke(handler, provider, "authorize", {
    method: "POST",
    body: { request },
    headers: { origin: "https://shipgremlins.ai" },
  });
  assert.equal(auth.statusCode, 303);
  return {
    handler,
    pair,
    request,
    auth,
    state: new URL(auth.headers.location).searchParams.get("state"),
    cookie: auth.headers["set-cookie"].split(";")[0],
  };
}
test("Linear PKCE relay never exchanges or persists the token and binds browser + provider", async () => {
  const p = await start("linear", () => {
    throw Error("Linear broker must not exchange");
  });
  const auth = new URL(p.auth.headers.location);
  assert.equal(auth.origin, "https://linear.app");
  assert.equal(auth.searchParams.get("scope"), "read,write");
  assert.equal(auth.searchParams.get("code_challenge"), p.pair.codeChallenge);
  assert.equal(auth.searchParams.get("actor"), "user");
  const forged = await invoke(
    p.handler,
    "linear",
    `callback?code=secret-code&state=${p.state}`,
  );
  assert.equal(forged.statusCode, 403);
  const good = await invoke(
    p.handler,
    "linear",
    `callback?code=secret-code&state=${p.state}`,
    { headers: { cookie: p.cookie } },
  );
  assert.equal(good.statusCode, 303);
  assert.ok(!good.headers.location.includes("secret-code"));
  const envelope = new URL(good.headers.location).hash.slice("#linear=".length);
  const value = unseal(
    "linear",
    envelope,
    Buffer.from(p.pair.key, "base64url"),
  );
  assert.deepEqual(value, {
    nonce: p.pair.nonce,
    expires: now + 600000,
    code: "secret-code",
  });
  assert.throws(() =>
    unseal("vercel", envelope, Buffer.from(p.pair.key, "base64url")),
  );
});
test("Vercel exchanges only a verified callback then encrypts the scoped installation token", async () => {
  let exchanges = 0;
  const p = await start("vercel", async (url, init) => {
    exchanges++;
    assert.equal(url, "https://api.vercel.com/v2/oauth/access_token");
    assert.equal(init.redirect, "error");
    assert.equal(init.body.get("client_secret"), "test-secret");
    assert.equal(
      init.body.get("redirect_uri"),
      "https://shipgremlins.ai/api/vercel/callback",
    );
    return Response.json({
      access_token: "access-test-token",
      team_id: "team_1",
      user_id: "user_1",
      installation_id: "icfg_1",
    });
  });
  assert.equal(
    new URL(p.auth.headers.location).pathname,
    "/integrations/shipgremlins/new",
  );
  await invoke(p.handler, "vercel", `callback?code=code&state=${p.state}`);
  assert.equal(exchanges, 0);
  const good = await invoke(
    p.handler,
    "vercel",
    `callback?code=code&state=${p.state}`,
    { headers: { cookie: p.cookie } },
  );
  assert.equal(exchanges, 1);
  assert.ok(!good.headers.location.includes("access-test-token"));
  const value = unseal(
    "vercel",
    new URL(good.headers.location).hash.slice("#vercel=".length),
    Buffer.from(p.pair.key, "base64url"),
  );
  assert.deepEqual(value.connection, {
    accessToken: "access-test-token",
    teamId: "team_1",
    userId: "user_1",
    configurationId: "icfg_1",
  });
});
test("provider denial and exchange failure return only an encrypted generic error", async () => {
  for (const provider of ["linear", "vercel"]) {
    const p = await start(provider, async () =>
      Response.json({ error: "sensitive-upstream" }, { status: 403 }),
    );
    const response = await invoke(
      p.handler,
      provider,
      `callback?${provider === "linear" ? "error=denied" : "code=private-code"}&state=${p.state}`,
      { headers: { cookie: p.cookie } },
    );
    const result = unseal(
      provider,
      new URL(response.headers.location).hash.slice(provider.length + 2),
      Buffer.from(p.pair.key, "base64url"),
    );
    assert.equal(result.error, true);
    assert.ok(!JSON.stringify(result).includes("sensitive-upstream"));
  }
});
test("rejects cross-site confirmation, expired state and invalid destinations", async () => {
  const p = await start("linear", fetch);
  const cross = await invoke(p.handler, "linear", "authorize", {
    method: "POST",
    body: { request: p.request },
    headers: { origin: "https://evil.test" },
  });
  assert.equal(cross.statusCode, 403);
  const expired = createOAuthBroker("linear", { env, now: () => now + 600001 });
  assert.equal(
    (await invoke(expired, "linear", `authorize?request=${p.request}`))
      .statusCode,
    400,
  );
  for (const url of [
    "javascript:alert(1)",
    "http://8.8.8.8/",
    "https://user:pass@example.com/",
    "https://example.com/?token=x",
    "https://example.com/#x",
    "https://example.com/evil",
  ])
    assert.equal(validReturnUrl(url), false);
  assert.equal(validReturnUrl("http://100.64.1.2:4311/"), true);
  assert.equal(
    JSON.parse(
      (
        await invoke(
          createOAuthBroker("vercel", { env: {} }),
          "vercel",
          "status",
        )
      ).body,
    ).available,
    false,
  );
});
