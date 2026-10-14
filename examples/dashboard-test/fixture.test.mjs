import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, readFileSync, rmSync, realpathSync } from "node:fs";
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

const newProject = (project = "onboarding-app") => ({
  project,
  repo: "fixture/onboarding-app",
  provider: "github",
  onboarding: true,
  linearMode: "later",
  linear: { connectionId: "default" },
});
async function reviewedSetup(project = "onboarding-app") {
  for (let attempt = 0; attempt < 40; attempt++) {
    const response = await call(`/api/projects/${project}/onboarding`);
    assert.equal(response.status, 200, await response.clone().text());
    const data = await response.json();
    if (data.status !== "analyzing") return data;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(
    "Synthetic source review did not finish within its bounded fixture poll.",
  );
}
test("completes the real existing-repository wizard and reviews simulated source/AI without executing a worker", async () => {
  const repositories = await (
    await call("/api/source-control/github/repositories")
  ).json();
  assert.ok(
    repositories.repositories.some(
      (repo) => repo.fullName === "fixture/onboarding-app",
    ),
  );
  const before = JSON.parse(
    readFileSync(resolve(root, "fixture-state.json"), "utf8"),
  );
  const created = await call("/api/projects", newProject());
  assert.equal(created.status, 200, await created.clone().text());
  const result = await created.json();
  assert.equal(result.linear.status, "skipped");
  const projectPath = resolve(root, "projects/onboarding-app/project.json");
  const initialConfig = JSON.parse(readFileSync(projectPath, "utf8"));
  assert.equal(initialConfig.repo, "fixture/onboarding-app");
  const areas = JSON.parse(
    readFileSync(resolve(root, "projects/onboarding-app/areas.json"), "utf8"),
  ).areas;
  assert.deepEqual(areas, {});
  const setup = await reviewedSetup();
  assert.equal(setup.status, "analyzed", setup.message);
  assert.match(setup.message, /SIMULATED SETUP/);
  assert.deepEqual(setup.fixture, {
    source: "simulated",
    ai: "simulated",
    providerVerified: false,
    commandsExecuted: false,
    workerExecuted: false,
  });
  assert.match(setup.report.summary, /synthetic/);
  assert.ok(
    setup.report.warnings.some((warning) =>
      warning.includes("not a checked-out Git commit"),
    ),
  );
  assert.equal(
    setup.report.projectSetup.commands.test.command,
    "node --test server.test.mjs",
  );
  assert.equal(
    setup.report.projectSetup.suggestedPms[0].draft.key,
    "welcome-api",
  );
  assert.match(
    setup.report.projectSetup.suggestedPms[0].rationale,
    /SIMULATED SETUP/,
  );
  assert.equal(setup.setupConfirmation.confirmed, false);
  assert.doesNotMatch(
    JSON.stringify(setup),
    /fixture-never-sent|synthetic-onboarding-source|fixture-not-a-real-credential/,
  );
  const confirmation = {
    revision: setup.revision,
    configurationRevision: setup.configurationRevision,
    repositorySha: setup.report.repository.sha,
    commandKeys: ["test"],
  };
  const unreviewed = await call(
    "/api/projects/onboarding-app/onboarding/confirm",
    { ...confirmation, commandKeys: ["build"] },
  );
  assert.equal(unreviewed.status, 400, await unreviewed.clone().text());
  assert.equal(
    JSON.parse(readFileSync(projectPath, "utf8")).commands.test,
    initialConfig.commands.test,
  );
  const confirmed = await call(
    "/api/projects/onboarding-app/onboarding/confirm",
    confirmation,
  );
  assert.equal(confirmed.status, 200, await confirmed.clone().text());
  assert.equal((await confirmed.json()).setupConfirmation.confirmed, true);
  const saved = JSON.parse(readFileSync(projectPath, "utf8"));
  assert.equal(saved.commands.test, "node --test server.test.mjs");
  assert.equal(saved.verified, null);
  const resumed = await reviewedSetup();
  assert.equal(resumed.setupConfirmation.confirmed, true);
  assert.equal(resumed.fixture.providerVerified, false);
  const repeat = await call("/api/projects", newProject());
  assert.equal(repeat.status, 200, await repeat.clone().text());
  assert.equal(
    JSON.parse(readFileSync(projectPath, "utf8")).commands.test,
    saved.commands.test,
  );
  const after = JSON.parse(
    readFileSync(resolve(root, "fixture-state.json"), "utf8"),
  );
  assert.deepEqual(after.jobs, before.jobs);
  assert.deepEqual(after.workers, before.workers);
  assert.deepEqual(after.providerTickets, before.providerTickets);
  assert.equal(
    existsSync(resolve(root, ".run/local-runners/state.json")),
    false,
  );
  const recovery = await call("/api/recovery/reservations");
  assert.equal(recovery.status, 200, await recovery.clone().text());
  assert.deepEqual(await recovery.json(), {
    reservations: [],
    unavailableProjects: [],
  });
});

test("keeps new-project mutations authenticated, bounded, revision guarded and confined to synthetic source", async () => {
  const malformed = await fetch(base + "/api/projects", {
    method: "POST",
    headers: { authorization: `Bearer ${session}` },
    body: "{not-json",
  });
  assert.equal(malformed.status, 400);
  const oversized = await call("/api/projects", {
    ...newProject("too-large"),
    project: "a".repeat(34 * 1024),
  });
  assert.equal(oversized.status, 413);
  const unauthorized = await fetch(base + "/api/projects", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(newProject("unauthorized")),
  });
  assert.equal(unauthorized.status, 401);
  const foreign = await call("/api/projects", {
    ...newProject("foreign"),
    repo: "real-owner/real-repository",
  });
  assert.equal(foreign.status, 409);
  assert.match(
    (await foreign.json()).error,
    /Only disposable project creation/,
  );
  assert.equal(
    (
      await call("/api/projects", {
        ...newProject("gitlab"),
        provider: "gitlab",
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await call("/api/projects", {
        ...newProject("not-onboarding"),
        onboarding: false,
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await call("/api/projects", {
        ...newProject("unsafe-home"),
        hubRepo: "real-owner/controller",
      })
    ).status,
    409,
  );
  assert.equal(
    (await call("/api/projects", newProject("../escape"))).status,
    400,
  );
  const crossOrigin = await fetch(base + "/api/projects", {
    method: "POST",
    headers: {
      authorization: `Bearer ${session}`,
      "content-type": "application/json",
      origin: "https://outside.invalid",
    },
    body: JSON.stringify(newProject("cross-origin")),
  });
  assert.equal(crossOrigin.status, 403);
  for (const name of [
    "unauthorized",
    "foreign",
    "gitlab",
    "not-onboarding",
    "unsafe-home",
    "cross-origin",
  ])
    assert.equal(existsSync(resolve(root, `projects/${name}`)), false);
  const setup = await reviewedSetup();
  const config = await (
    await call("/api/config?path=projects%2Fonboarding-app%2Fproject.json")
  ).json();
  const value = JSON.parse(config.content);
  value.description = "A newer disposable owner edit";
  assert.equal(
    (
      await call(
        "/api/config",
        {
          path: config.path,
          revision: config.revision,
          content: JSON.stringify(value),
        },
        "PUT",
      )
    ).status,
    200,
  );
  const stale = await call("/api/projects/onboarding-app/onboarding/confirm", {
    revision: setup.revision,
    configurationRevision: setup.configurationRevision,
    repositorySha: setup.report.repository.sha,
    commandKeys: ["test"],
  });
  assert.equal(stale.status, 409, await stale.clone().text());
  assert.equal(
    JSON.parse(
      readFileSync(
        resolve(root, "projects/onboarding-app/project.json"),
        "utf8",
      ),
    ).description,
    value.description,
  );
  for (const path of [
    "/api/connections",
    "/api/source-control/github/connect",
    "/api/ai/codex/login",
    "/api/recovery/bind",
    "/api/projects/onboarding-app/onboarding/prepare-docker",
    "/api/projects/onboarding-app/onboarding/connect-test-account",
    "/api/projects/onboarding-app/onboarding/setup-pr",
    "/api/projects/onboarding-app/onboarding/verify",
  ])
    assert.equal((await call(path, {})).status, 409, path);
  for (const project of ["fixture-second", "fixture-third"])
    assert.equal(
      (await call("/api/projects", newProject(project))).status,
      200,
    );
  const concurrent = await Promise.all(
    ["fixture-fourth", "fixture-fifth", "fixture-sixth"].map((project) =>
      call("/api/projects", newProject(project)),
    ),
  );
  assert.deepEqual(
    concurrent.map((response) => response.status).sort(),
    [200, 409, 409],
  );
  assert.equal(
    ["fixture-fourth", "fixture-fifth", "fixture-sixth"].filter((project) =>
      existsSync(resolve(root, `projects/${project}`)),
    ).length,
    1,
  );
  const capped = await call("/api/projects", newProject("fixture-seventh"));
  assert.equal(capped.status, 409);
  assert.match((await capped.json()).error, /four added projects/);
  assert.equal(existsSync(resolve(root, "projects/fixture-seventh")), false);
});
