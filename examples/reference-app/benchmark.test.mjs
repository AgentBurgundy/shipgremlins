import { test } from "node:test";
import assert from "node:assert/strict";
import { referenceApp } from "./server.mjs";
async function fixture(fn, seededBug = false) {
  const server = referenceApp({ seededBug });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn((path, user, init = {}) =>
      fetch(url + path, {
        ...init,
        headers: { "x-demo-user": user, ...init.headers },
      }),
    );
  } finally {
    await new Promise((done) => server.close(done));
  }
}
test("a security PM can reproduce the opt-in tenant leak", () =>
  fixture(async (request) => {
    const data = await (await request("/api/tasks", "bob")).json();
    assert.equal(data.tasks.length, 2);
    assert.ok(data.tasks.some((t) => t.tenant === "mars"));
  }, true));
test("the corrected app separates tenants and rejects viewer uploads", () =>
  fixture(async (request) => {
    assert.equal(
      (
        await request("/api/import", "bob", {
          method: "POST",
          body: "title\nInjected",
        })
      ).status,
      403,
    );
    const data = await (await request("/api/tasks", "alice")).json();
    assert.equal(data.tasks.length, 1);
    assert.equal(data.tasks[0].tenant, "moon");
  }));
test("generated CSV imports stay within the active tenant and persist across reads", () =>
  fixture(async (request) => {
    const csv = "title\nCheck oxygen\nInspect pressure seal";
    assert.equal(
      (await request("/api/import", "alice", { method: "POST", body: csv }))
        .status,
      201,
    );
    assert.equal(
      (await (await request("/api/tasks", "alice")).json()).tasks.length,
      3,
    );
    assert.equal(
      (await (await request("/api/tasks", "nova")).json()).tasks.length,
      1,
    );
    assert.equal(
      (
        await request("/api/import", "alice", {
          method: "POST",
          body: "wrong\nformat",
        })
      ).status,
      400,
    );
  }));
