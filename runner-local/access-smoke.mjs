import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { startAccessHelper } from "./access-helper.mjs";

const username = "fixture-account@example.test",
  password = "fixture-private-password-7654",
  cookie = "fixture-session-cookie-791253";
const nestedToken = "fixture-nested-storage-token-18273645";
const refreshToken = "fixture-json-encoded-token-56473829";
const cache = {
  padding: "",
  session: { token: nestedToken },
  encoded: JSON.stringify({ refreshToken }),
};
cache.padding = "x".repeat(114296 - JSON.stringify(cache).length);
const largeCache = JSON.stringify(cache);
assert.equal(largeCache.length, 114296);
let expired = false,
  submissions = 0,
  externalRequests = 0;
const outside = createServer((_req, res) => {
  externalRequests++;
  res.end("Outside the selected app");
});
await new Promise((resolve) => outside.listen(0, "127.0.0.1", resolve));
const outsideUrl = `http://127.0.0.1:${outside.address().port}`;
const app = createServer(async (req, res) => {
  const url = new URL(req.url, "http://fixture.test");
  if (url.pathname === "/sso") {
    res.writeHead(302, { location: `${outsideUrl}/login` });
    res.end();
    return;
  }
  if (url.pathname === "/submit") {
    submissions++;
    let body = "";
    for await (const chunk of req) body += chunk;
    const data = new URLSearchParams(body);
    if (
      data.get("username") !== username ||
      data.get("password") !== password
    ) {
      res.writeHead(401);
      res.end("Rejected");
      return;
    }
    res.writeHead(200, {
      "set-cookie": `session=${cookie}; HttpOnly; Path=/; SameSite=Lax`,
      "content-type": "text/html",
    });
    res.end(
      `<script>sessionStorage.setItem('private-value','fixture-session-storage-9341');localStorage.setItem('app-cache',${JSON.stringify(largeCache)});location.href='/protected';</script>`,
    );
    return;
  }
  if (url.pathname === "/signout") {
    expired = true;
    res.writeHead(302, { location: "/login" });
    res.end();
    return;
  }
  res.setHeader("content-type", "text/html");
  const authenticated = !expired && req.headers.cookie?.includes(cookie);
  const form = `<form method="POST" action="/submit"><label>Email<input name="username" id="username"></label><label>Password<input type="password" name="password" id="password"></label><button id="submit">Sign in</button></form>`;
  const renamedForm = `<form method="POST" action="/submit"><label>Email<input type="email" autocomplete="username" name="username" id="new-user"></label><label>Password<input type="password" autocomplete="current-password" name="password" id="new-pass"></label><button id="new-submit">Sign in</button></form>`;
  if (url.pathname === "/renamed" || url.pathname === "/ambiguous") {
    res.end(renamedForm + (url.pathname === "/ambiguous" ? renamedForm : ""));
    return;
  }
  if (url.pathname === "/public-marker") {
    res.end(`<div id="account">Always visible</div>${form}`);
    return;
  }
  if (url.pathname === "/delayed-public-marker") {
    res.end(
      `<h1>Public app</h1><script>setTimeout(()=>{document.body.insertAdjacentHTML('beforeend','<div id="account">Public confirmation</div>')},3500)</script>`,
    );
    return;
  }
  if (url.pathname === "/modal") {
    res.end(
      `<button id="open" onclick="document.querySelector('#modal').hidden=false">Log in</button><div id="modal" hidden>${form}</div>`,
    );
    return;
  }
  if (authenticated)
    res.end(
      `<h1>Private workspace</h1><div id="account">${username}</div><div id="tenant">Fixture team</div><p>${nestedToken}</p><p>${refreshToken}</p><p id="session-proof"></p><script>document.querySelector('#session-proof').textContent=sessionStorage.getItem('private-value')?'Session storage survived':'No session storage';</script><a href="/signout">Sign out</a>`,
    );
  else
    res.end(
      `<h1>Welcome</h1>${form}<a href="${outsideUrl}/login">External account</a>`,
    );
});
await new Promise((resolve) => app.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${app.address().port}`;
const base = {
  version: 1,
  url,
  identityId: "fixture-account",
  generation: "generation-1",
  leaseGeneration: 1,
  token: randomBytes(32).toString("hex"),
  controlToken: randomBytes(32).toString("hex"),
  maxRuntimeMs: 180000,
  access: {
    kind: "password",
    loginPath: "/login",
    authenticatedPath: "/protected",
    usernameSelector: "#username",
    passwordSelector: "#password",
    submitSelector: "#submit",
    successSelector: "#account",
    accounts: [
      {
        name: "Test account",
        username,
        password,
        assertions: [
          { kind: "principal", selector: "#account" },
          { kind: "tenant", selector: "#tenant", equals: "Fixture team" },
        ],
      },
    ],
  },
};
let helper;
const start = async (input) => {
  helper = await startAccessHelper(input, { port: 0, host: "127.0.0.1" });
  const endpoint = `http://127.0.0.1:${helper.address.port}`;
  const request = async (path, body, auth = input.token) => {
    const response = await fetch(endpoint + path, {
      method: body ? "POST" : "GET",
      headers: {
        authorization: `Bearer ${auth}`,
        "content-type": "application/json",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, body: await response.json() };
  };
  return { ready: await helper.ready, request, endpoint };
};
let id = 0;
const rpc = (request, method, params) =>
  request("/mcp", { jsonrpc: "2.0", id: ++id, method, params });
try {
  const first = await start(base);
  assert.equal(first.ready.status, "ready", JSON.stringify(first.ready));
  assert.equal(first.ready.receipt.proof.receivingContext, true);
  assert.equal(first.ready.receipt.proof.principal, true);
  assert.equal((await first.request("/ready", undefined, "wrong")).status, 401);
  assert.equal((await first.request("/lease", { ttlMs: 30000 })).status, 401);
  assert.equal((await first.request("/review", {})).status, 401);
  const list = await rpc(first.request, "tools/list", {});
  assert.ok(
    list.body.result.tools.some((tool) => tool.name === "browser_snapshot"),
  );
  assert.ok(
    !list.body.result.tools.some((tool) =>
      /evaluate|run_code|storage|network|console|upload/.test(tool.name),
    ),
  );
  const snapshot = await rpc(first.request, "tools/call", {
    name: "browser_snapshot",
    arguments: {},
  });
  const text = JSON.stringify(snapshot);
  assert.match(text, /Private workspace/);
  assert.match(text, /Session storage survived/);
  for (const secret of [
    username,
    password,
    cookie,
    "fixture-session-storage-9341",
    nestedToken,
    refreshToken,
  ])
    assert.ok(
      !text.includes(secret),
      "Private values must not cross the gateway",
    );
  for (const name of [
    "browser_evaluate",
    "browser_run_code",
    "browser_run_code_unsafe",
    "browser_storage_state",
    "browser_network_requests",
  ])
    assert.equal(
      (await rpc(first.request, "tools/call", { name, arguments: {} })).body
        .result.isError,
      true,
    );
  assert.equal(
    (
      await rpc(first.request, "tools/call", {
        name: "browser_snapshot",
        arguments: { filename: "/work/private.json" },
      })
    ).body.result.isError,
    true,
  );
  assert.equal(
    (
      await rpc(first.request, "tools/call", {
        name: "browser_navigate",
        arguments: { url: "https://outside.example.test" },
      })
    ).body.result.isError,
    true,
  );
  const shot = await first.request("/screenshot");
  assert.equal(
    Buffer.from(shot.body.screenshot, "base64").subarray(1, 4).toString(),
    "PNG",
  );
  const screenshot = await rpc(first.request, "tools/call", {
    name: "browser_take_screenshot",
    arguments: {},
  });
  assert.equal(screenshot.body.result.content[0].mimeType, "image/png");
  const concurrent = await Promise.all([
    rpc(first.request, "tools/call", {
      name: "browser_resize",
      arguments: { width: 390, height: 844 },
    }),
    rpc(first.request, "tools/call", {
      name: "browser_snapshot",
      arguments: {},
    }),
  ]);
  assert.ok(concurrent.every((result) => !result.body.result.isError));
  assert.match(JSON.stringify(concurrent[0]), /Private workspace/);
  assert.ok(!JSON.stringify(concurrent[0]).includes("[Snapshot]("));
  const plan = {
    schema: 1,
    id: "plan-fixture",
    jobId: "job-fixture",
    project: "fixture",
    area: "dashboard",
    deployment: {
      id: "fixture-build",
      sha: "a".repeat(40),
      state: "READY",
      url,
    },
    deliveries: [
      { id: "delivery-fixture", criteria: ["Signed-in workspace opens"] },
    ],
  };
  const review = await first.request(
    "/review",
    {
      plan,
      commitSha: plan.deployment.sha,
      request: {
        schema: 1,
        planId: plan.id,
        deliveries: [
          {
            id: "delivery-fixture",
            session: "model-export-does-not-exist",
            checks: [
              {
                criterion: "Signed-in workspace opens",
                kind: "text-visible",
                text: "Private workspace",
                path: "/protected",
                viewports: ["desktop", "mobile"],
              },
            ],
          },
        ],
      },
    },
    base.controlToken,
  );
  assert.equal(review.body.ok, true, JSON.stringify(review.body));
  const proof = JSON.parse(
    Buffer.from(
      review.body.files.find((file) => file.name === "pm-review-proof.json")
        .base64,
      "base64",
    ).toString(),
  );
  assert.equal(proof.manifest.deliveries[0].status, "passed");
  assert.equal(proof.manifest.deliveries[0].screenshots.length, 2);
  const expiredResult = await rpc(first.request, "tools/call", {
    name: "browser_navigate",
    arguments: { url: `${url}/signout` },
  });
  assert.equal(expiredResult.body.failure.code, "session_expired");
  assert.equal((await first.request("/status")).body.status, "failed");
  await helper.stop();
  expired = false;
  const modal = structuredClone(base);
  modal.access.loginPath = "/modal";
  modal.access.steps = [
    { kind: "click", selector: "#open" },
    { kind: "fill", selector: "#username", credential: "username" },
    { kind: "fill", selector: "#password", credential: "password" },
    { kind: "click", selector: "#submit" },
  ];
  const second = await start(modal);
  assert.equal(second.ready.status, "ready", JSON.stringify(second.ready));
  await helper.stop();
  const mismatch = structuredClone(base);
  mismatch.access.accounts[0].assertions[1].equals = "Wrong team";
  const third = await start(mismatch);
  assert.equal(third.ready.failure.code, "identity_mismatch");
  await helper.stop();
  const publicMarker = structuredClone(base);
  publicMarker.access.authenticatedPath = "/public-marker";
  publicMarker.access.accounts[0].assertions = [];
  delete publicMarker.access.accounts[0].assertions;
  const fourth = await start(publicMarker);
  assert.equal(fourth.ready.failure.code, "public_confirmation");
  await helper.stop();
  publicMarker.access.authenticatedPath = "/delayed-public-marker";
  const delayed = await start(publicMarker);
  assert.equal(delayed.ready.failure.code, "public_confirmation");
  await helper.stop();
  const wrongPassword = structuredClone(base);
  wrongPassword.access.accounts[0].password = "wrong-password";
  const beforeWrongPassword = submissions;
  const rejected = await start(wrongPassword);
  assert.equal(rejected.ready.failure.code, "credentials_rejected");
  assert.equal(
    submissions - beforeWrongPassword,
    1,
    "Bad credentials are never submitted again",
  );
  await helper.stop();
  const renamed = structuredClone(base);
  renamed.access.loginPath = "/renamed";
  const beforeRepair = submissions;
  const repaired = await start(renamed);
  assert.equal(repaired.ready.status, "ready", JSON.stringify(repaired.ready));
  assert.equal(repaired.ready.receipt.repair.kind, "login-controls");
  assert.equal(repaired.ready.receipt.repair.changes.length, 3);
  assert.equal(
    repaired.ready.receipt.repair.recipe.successSelector,
    "#account",
  );
  assert.equal(
    repaired.ready.receipt.repair.recipe.authenticatedPath,
    "/protected",
  );
  assert.equal(
    renamed.access.usernameSelector,
    "#username",
    "The saved recipe is not mutated",
  );
  assert.equal(submissions - beforeRepair, 1);
  assert.ok(!JSON.stringify(repaired.ready.receipt.repair).includes(password));
  await helper.stop();
  const ambiguous = structuredClone(renamed);
  ambiguous.access.loginPath = "/ambiguous";
  const beforeAmbiguous = submissions;
  const unresolved = await start(ambiguous);
  assert.equal(unresolved.ready.failure.code, "selector_unusable");
  assert.equal(
    submissions,
    beforeAmbiguous,
    "Ambiguous login forms receive no credentials",
  );
  await helper.stop();
  const repairedWrong = structuredClone(renamed);
  repairedWrong.access.accounts[0].password = "wrong-password";
  const beforeRepairedWrong = submissions;
  const rejectedRepair = await start(repairedWrong);
  assert.equal(rejectedRepair.ready.failure.code, "credentials_rejected");
  assert.equal(submissions - beforeRepairedWrong, 1);
  assert.equal(rejectedRepair.ready.receipt, undefined);
  await helper.stop();
  const repairedMismatch = structuredClone(renamed);
  repairedMismatch.access.accounts[0].assertions[1].equals = "Wrong team";
  const beforeRepairedMismatch = submissions;
  const mismatchRepair = await start(repairedMismatch);
  assert.equal(mismatchRepair.ready.failure.code, "identity_mismatch");
  assert.equal(submissions - beforeRepairedMismatch, 1);
  assert.equal(mismatchRepair.ready.receipt, undefined);
  await helper.stop();
  const sso = structuredClone(base);
  sso.access.loginPath = "/sso";
  const unsupported = await start(sso);
  assert.equal(unsupported.ready.failure.code, "external_redirect");
  await helper.stop();
  const publicInput = { ...base, access: undefined };
  const fifth = await start(publicInput);
  assert.equal(fifth.ready.status, "ready", JSON.stringify(fifth.ready));
  assert.equal(fifth.ready.receipt.proof.signedIn, false);
  assert.equal(fifth.ready.receipt.proof.public, true);
  const publicSnapshot = await rpc(fifth.request, "tools/call", {
    name: "browser_snapshot",
    arguments: {},
  });
  const externalLink = publicSnapshot.body.result.content
    .map((item) => item.text || "")
    .join("\n")
    .match(/link "External account" \[ref=([^\]]+)\]/);
  assert.ok(
    externalLink,
    "Public fixture exposes the external navigation control",
  );
  await rpc(fifth.request, "tools/call", {
    name: "browser_click",
    arguments: { ref: externalLink[1], element: "External account" },
  });
  assert.equal(
    externalRequests,
    0,
    "Public managed contexts also block external click navigation",
  );
  await helper.stop();
  const leased = await start({ ...base, access: undefined, leaseTtlMs: 10000 });
  assert.equal(leased.ready.status, "ready");
  assert.equal(
    (await leased.request("/lease", { ttlMs: 1000 }, base.controlToken)).body
      .ok,
    true,
  );
  await new Promise((resolve) => setTimeout(resolve, 1300));
  await assert.rejects(leased.request("/ready"));
  await helper.stop();
  helper = await startAccessHelper(base, { port: 0, host: "127.0.0.1" });
  await helper.stop();
  await helper.ready;
  assert.equal(helper.snapshot().status, "failed");
  console.log(
    "Managed access smoke passed: private browser handoff, modal login, one verified selector repair, ambiguous forms rejected, no bad-credential retry, unchanged identity assertions, public negative control, external navigation blocked, gateway restrictions/redaction, inline snapshots, masked screenshots, fresh QA, expiry, lease and cleanup.",
  );
} finally {
  await helper?.stop();
  await new Promise((resolve) => app.close(resolve));
  await new Promise((resolve) => outside.close(resolve));
}
