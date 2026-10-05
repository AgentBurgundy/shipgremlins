import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
let child, base, session, root;
const directory = fileURLToPath(new URL("../..", import.meta.url));
const call = (path, value, method = value === undefined ? "GET" : "POST") =>
  fetch(base + path, {
    method,
    headers: {
      authorization: `Bearer ${session}`,
      "content-type": "application/json",
    },
    ...(value === undefined ? {} : { body: JSON.stringify(value) }),
  });
before(async () => {
  child = spawn(
    process.execPath,
    ["--import", "tsx", "examples/dashboard-test/server.mjs"],
    {
      cwd: directory,
      env: {
        ...process.env,
        SHIPGREMLINS_DASHBOARD_FIXTURE: "1",
        PORT: "0",
        GITHUB_TOKEN: "must-not-inherit-a-real-shaped-token",
      },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "",
    errors = "";
  child.stderr.on("data", (data) => {
    errors += data.toString();
  });
  const result = await new Promise((done, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("Fixture did not start: " + errors)),
      20000,
    );
    child.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`Fixture exited ${code}: ${errors}`));
    });
    child.stdout.on("data", (data) => {
      output += data;
      const line = output
        .split("\n")
        .find((line) => line.includes('"fixture":true'));
      if (line) {
        clearTimeout(timeout);
        done(JSON.parse(line));
      }
    });
  });
  base = `http://127.0.0.1:${result.port}`;
  const entry = await fetch(base + "/", { redirect: "manual" });
  session = new URL(entry.headers.get("location"), base).hash.slice(
    "#session=".length,
  );
  assert.match(session, /^[a-f0-9]{64}$/);
  root = (await (await call("/api/status")).json()).configDirectory;
});
after(async () => {
  if (child && child.exitCode === null) {
    const ended = once(child, "exit");
    child.kill();
    await ended;
  }
  if (root) {
    const rel = relative(realpathSync(tmpdir()), resolve(root));
    assert.match(rel, /^shipgremlins-dashboard-fixture-[^\\/]+$/);
    rmSync(root, { recursive: true, force: true });
  }
});
test("serves the real dashboard with clear boundaries and protected APIs", async () => {
  assert.equal((await fetch(base + "/api/status")).status, 401);
  const html = await (await fetch(base + "/projects/dashboard-demo")).text();
  assert.match(html, /DISPOSABLE DASHBOARD FIXTURE/);
  assert.match(html, /app\.js/);
  const status = await (await call("/api/status")).json();
  assert.equal(status.projects.length, 2);
  assert.equal(
    status.projects.find((p) => p.name === "dashboard-demo").areas.length,
    2,
  );
  assert.doesNotMatch(JSON.stringify(status), /must-not-inherit/);
  assert.equal(
    (
      await fetch(base + "/api/status", {
        headers: {
          authorization: `Bearer ${session}`,
          origin: "https://outside.invalid",
        },
      })
    ).status,
    403,
  );
  assert.equal(
    (await call("/api/source-control/github/connect", {})).status,
    409,
  );
  assert.equal((await call("/api/updates/apply", {})).status, 409);
});
test("uses real PM automation controls and queues a synthetic run without executing an agent", async () => {
  const project = "checkout-demo";
  const config = await (
    await call(
      "/api/config?path=" +
        encodeURIComponent(`projects/${project}/project.json`),
    )
  ).json();
  const areas = await (
    await call(
      "/api/config?path=" +
        encodeURIComponent(`projects/${project}/areas.json`),
    )
  ).json();
  const pause = await call(`/api/projects/${project}/areas/checkout/status`, {
    enabled: false,
    revision: areas.revision,
    projectRevision: config.revision,
  });
  assert.equal(pause.status, 200, await pause.clone().text());
  const paused = await pause.json();
  assert.equal(paused.enabled, false);
  const queued = await call("/api/jobs", {
    type: "pm",
    project,
    area: "checkout",
  });
  assert.equal(queued.status, 202, await queued.clone().text());
  const { job } = await queued.json();
  assert.equal(job.status, "queued");
  assert.match(job.message, /Simulated/);
  assert.equal((await call(`/api/jobs/${job.id}/cancel`, {})).status, 202);
  const resume = await call(`/api/projects/${project}/areas/checkout/status`, {
    enabled: true,
    revision: paused.revision,
    projectRevision: paused.projectRevision,
  });
  assert.equal(resume.status, 200, await resume.clone().text());
});
test("persists real revision-guarded edits only in the disposable workspace", async () => {
  const path = "projects/checkout-demo/project.json";
  const current = await (
    await call("/api/config?path=" + encodeURIComponent(path))
  ).json();
  const raw = JSON.parse(current.content);
  raw.description = "Saved by the disposable fixture integration test";
  const input = {
    path,
    revision: current.revision,
    content: JSON.stringify(raw),
  };
  assert.equal((await call("/api/config", input, "PUT")).status, 200);
  assert.equal((await call("/api/config", input, "PUT")).status, 409);
  const saved = await (
    await call("/api/config?path=" + encodeURIComponent(path))
  ).json();
  assert.equal(JSON.parse(saved.content).description, raw.description);
});
test("exposes independently labeled scenarios and persists simulated cancel actions", async () => {
  const history = await (await call("/api/jobs")).json();
  assert.equal(history.jobs.length, 7);
  const browser = history.jobs.find((job) => job.runId === 2);
  const events = await (await call(`/api/jobs/${browser.id}/activity`)).json();
  assert.ok(
    events.events.some(
      (event) => event.title === "mcp__playwright__browser_navigate",
    ),
  );
  assert.match(events.summary, /No real OAuth/);
  const artifacts = await (
    await call(`/api/jobs/${browser.id}/artifacts`)
  ).json();
  assert.ok(JSON.stringify(artifacts).includes("fixture-screenshot.png"));
  const queued = history.jobs.find((job) => job.status === "queued");
  assert.equal((await call(`/api/jobs/${queued.id}/cancel`, {})).status, 202);
  assert.equal(
    JSON.parse(
      readFileSync(resolve(root, "fixture-state.json"), "utf8"),
    ).jobs.find((job) => job.id === queued.id).status,
    "canceled",
  );
});
test("optional fake login rejects wrong input and accepts only the public synthetic account", async () => {
  assert.equal((await fetch(base + "/fixture/signed-in")).status, 401);
  const response = await fetch(base + "/fixture/login", {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "username=fixture-member&password=fixture-password",
  });
  assert.equal(response.status, 303);
  const signedIn = await fetch(base + "/fixture/signed-in", {
    headers: { cookie: response.headers.get("set-cookie").split(";")[0] },
  });
  assert.match(await signedIn.text(), /id="fixture-signed-in"/);
});
test("Run coding selects an approved synthetic ticket without an identifier and preserves previous attempts", async () => {
  const response = await call("/api/jobs", {
    type: "developer",
    project: "checkout-demo",
  });
  assert.equal(response.status, 202, await response.clone().text());
  const { job } = await response.json();
  assert.equal(job.ticket, "FIX-103");
  assert.equal(job.area, "checkout");
  assert.equal(job.status, "queued");
  assert.match(job.message, /Simulated.*does not start a real agent/);
  assert.equal(
    job.linearBinding.ticketId,
    "66666666-6666-4666-8666-000000000003",
  );
  const repeat = await call("/api/jobs", {
    type: "developer",
    project: "checkout-demo",
  });
  assert.equal(repeat.status, 400);
  assert.match(
    (await repeat.json()).error,
    /No approved tickets are ready.*synthetic/,
  );
  const unapproved = await call("/api/jobs", {
    type: "developer",
    project: "checkout-demo",
    ticket: "FIX-199",
  });
  assert.equal(unapproved.status, 400);
  assert.match((await unapproved.json()).error, /approved synthetic ticket/);
  assert.equal((await call(`/api/jobs/${job.id}/cancel`, {})).status, 202);
  const afterCancel = await call("/api/jobs", {
    type: "developer",
    project: "checkout-demo",
  });
  assert.equal(afterCancel.status, 400);
  const history = await (await call("/api/jobs")).json();
  assert.equal(
    history.jobs.filter(
      (item) => item.type === "developer" && item.ticket === "FIX-103",
    ).length,
    1,
  );
});
