import { afterEach, describe, expect, it, vi } from "vitest";
import { ChildProcess, type spawn } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import {
  createDashboardServer,
  runDashboard,
  openDashboardBrowser,
  lanAddresses,
  type DashboardOptions,
} from "./dashboard.ts";
import type { Updater, UpdateStatus } from "../update/index.ts";
import type { LocalRunners } from "../localRunners/engine.ts";
import type { DockerRunners } from "../localRunners/docker.ts";
import type { createJobPreparation } from "../localRunners/jobs.ts";

const session = "a".repeat(64);
const directories: string[] = [];
const servers: Server[] = [];
const auth = { Authorization: `Bearer ${session}` };
function temporary(): string {
  const directory = mkdtempSync(
    join(realpathSync(tmpdir()), "sg-dashboard-test-"),
  );
  directories.push(directory);
  return directory;
}
async function start(
  packageRoot?: string,
  networkHosts: string[] = [],
  options: DashboardOptions = {},
) {
  const root = temporary();
  const installation = packageRoot ?? temporary();
  if (!packageRoot) {
    mkdirSync(join(installation, "dashboard"));
    writeFileSync(
      join(installation, "dashboard", "index.html"),
      "<h1>Gremlin dashboard</h1>",
    );
    writeFileSync(join(installation, "private.html"), "never-public");
    writeFileSync(
      join(installation, "dashboard", "secret.json"),
      '{"token":"never-public"}',
    );
  }
  const server = createDashboardServer(
    root,
    installation,
    session,
    networkHosts,
    options,
  );
  servers.push(server);
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  return {
    root,
    installation,
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
  };
}
afterEach(async () => {
  for (const server of servers.splice(0))
    await new Promise<void>((done) => server.close(() => done()));
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function post(
  url: string,
  body: unknown,
  headers: Record<string, string> = {},
) {
  return fetch(url, {
    method: "POST",
    headers: { ...auth, "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("local dashboard HTTP boundary", () => {
  it("authenticates Slack connection actions and accepts only the OAuth return document across sites", async () => {
    const slack = {
      status: vi.fn(async () => ({
        available: true,
        connected: false,
        message: undefined,
      })),
      connect: vi.fn(async () => ({
        url: "https://shipgremlins.ai/api/slack/authorize?request=opaque",
      })),
      complete: vi.fn(async () => ({
        available: true,
        connected: true,
        message: undefined,
      })),
      webhook: vi.fn(async () => ({
        available: true,
        connected: true,
        message: undefined,
      })),
      disconnect: vi.fn(async () => ({
        available: true,
        connected: false,
        message: undefined,
      })),
    };
    const { url } = await start(undefined, [], { slack });
    expect((await fetch(`${url}/api/slack`)).status).toBe(401);
    expect((await fetch(`${url}/api/slack`, { headers: auth })).status).toBe(
      200,
    );
    expect((await post(`${url}/api/slack/connect`, {})).status).toBe(200);
    expect(slack.connect).toHaveBeenCalledWith(`${url}/`);
    expect(
      (
        await post(`${url}/api/slack/connect`, {
          returnUrl: "https://evil.test",
        })
      ).status,
    ).toBe(400);
    expect(
      (await post(`${url}/api/slack/complete`, { envelope: "encrypted" }))
        .status,
    ).toBe(200);
    expect(slack.complete).toHaveBeenCalledWith("encrypted");
    expect(
      (
        await post(
          `${url}/api/slack/webhook`,
          { url: "test" },
          { Origin: "https://evil.test" },
        )
      ).status,
    ).toBe(403);
    expect(slack.webhook).not.toHaveBeenCalled();
    const navigationStatus = await new Promise<number | undefined>(
      (done, reject) => {
        const navigation = request(
          `${url}/`,
          {
            headers: {
              "Sec-Fetch-Site": "cross-site",
              "Sec-Fetch-Mode": "navigate",
            },
          },
          (response) => {
            response.resume();
            response.once("end", () => done(response.statusCode));
          },
        );
        navigation.on("error", reject);
        navigation.end();
      },
    );
    expect(navigationStatus).toBe(200);
    expect(
      (
        await fetch(`${url}/api/slack`, {
          headers: {
            ...auth,
            "Sec-Fetch-Site": "cross-site",
            "Sec-Fetch-Mode": "navigate",
          },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await fetch(`${url}/api/slack`, {
          method: "DELETE",
          headers: { ...auth, "Content-Type": "application/json" },
          body: "{}",
        })
      ).status,
    ).toBe(200);
  });
  it("authenticates worker mutations, validates job inputs, and serves only authorized artifacts", async () => {
    const create = vi.fn(async () => ({
      id: "worker-demo",
      status: "provisioning",
    }));
    const enqueue = vi.fn(async () => ({ id: "job-demo", status: "queued" }));
    const runners = {
      create,
      enqueue,
      start: vi.fn(),
      stop: vi.fn(async () => {}),
      status: vi.fn(async () => ({
        runners: [],
        jobs: [],
        operation: { phase: "idle", message: "Ready" },
      })),
      logs: vi.fn(async () => ["Browser ready"]),
      artifacts: vi.fn(async () => [{ name: "screenshot.png", size: 8 }]),
      readArtifact: vi.fn(async () =>
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      ),
    } as unknown as LocalRunners;
    const docker = {
      preflight: vi.fn(async () => ({
        available: true,
        message: "Docker ready",
      })),
    } as unknown as DockerRunners;
    const validate = vi.fn(async () => ({ area: { key: "core" } }));
    const jobs = { validate } as unknown as ReturnType<
      typeof createJobPreparation
    >;
    const { url } = await start(undefined, [], { runners, docker, jobs });
    expect(
      (
        await fetch(`${url}/api/runners`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        })
      ).status,
    ).toBe(401);
    expect(create).not.toHaveBeenCalled();
    expect(
      (await post(`${url}/api/runners`, { token: "must-not-be-accepted" }))
        .status,
    ).toBe(400);
    expect((await post(`${url}/api/runners`, {})).status).toBe(202);
    expect(create).toHaveBeenCalledOnce();
    expect(
      (
        await post(`${url}/api/jobs`, {
          type: "developer",
          project: "app",
          ticket: "APP-1",
          prompt: "arbitrary",
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await post(`${url}/api/jobs`, {
          type: "developer",
          project: "app",
          ticket: "APP-1",
        })
      ).status,
    ).toBe(202);
    expect(validate).toHaveBeenCalledOnce();
    expect(enqueue).toHaveBeenCalledOnce();
    expect((await fetch(`${url}/api/jobs/job-demo/logs`)).status).toBe(401);
    expect(
      await (
        await fetch(`${url}/api/jobs/job-demo/logs`, { headers: auth })
      ).json(),
    ).toEqual({ lines: ["Browser ready"] });
    expect(
      await (
        await fetch(`${url}/api/jobs/job-demo/artifacts`, { headers: auth })
      ).json(),
    ).toMatchObject({
      files: [
        {
          name: "screenshot.png",
          url: "/api/jobs/job-demo/artifacts/screenshot.png",
        },
      ],
    });
    expect(
      (
        await fetch(`${url}/api/jobs/job-demo/artifacts/evil.html`, {
          headers: auth,
        })
      ).status,
    ).toBe(400);
    const screenshot = await fetch(
      `${url}/api/jobs/job-demo/artifacts/screenshot.png`,
      { headers: auth },
    );
    expect(screenshot.headers.get("Content-Type")).toBe("image/png");
    expect(screenshot.headers.get("Content-Security-Policy")).toContain(
      "sandbox",
    );
    expect((await screenshot.arrayBuffer()).byteLength).toBe(8);
  });
  it("keeps authentication and exact same-origin checks for explicitly allowed LAN hosts", async () => {
    const { url } = await start(undefined, ["192.168.1.20"]);
    const port = new URL(url).port;
    const host = `192.168.1.20:${port}`;
    const call = (headers: Record<string, string>) =>
      new Promise<number>((done, reject) => {
        const req = request(`${url}/api/status`, { headers }, (res) => {
          res.resume();
          res.once("end", () => done(res.statusCode!));
        });
        req.once("error", reject);
        req.end();
      });
    expect(await call({ Host: host })).toBe(401);
    expect(await call({ ...auth, Host: host, Origin: `http://${host}` })).toBe(
      200,
    );
    expect(await call({ ...auth, Host: host, Origin: url })).toBe(403);
    expect(await call({ ...auth, Host: `192.168.1.99:${port}` })).toBe(403);
    expect(await call({ ...auth, Host: `evil.example:${port}` })).toBe(403);
    expect(await call({ ...auth, Host: "192.168.1.20:1" })).toBe(403);
  });

  it("keeps secrets out of the unauthenticated page and rejects preflight requests", async () => {
    const { root, url } = await start();
    writeFileSync(join(root, ".env"), "GITHUB_TOKEN=private-credential\n");
    const page = await fetch(url);
    const html = await page.text();
    expect(page.status).toBe(200);
    expect(html).not.toContain("private-credential");
    expect(html).not.toContain(session);
    expect(html).not.toContain(root);
    const blocked = await fetch(`${url}/api/connections`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ values: { GITHUB_TOKEN: "overwritten" } }),
    });
    expect(blocked.status).toBe(401);
    expect(readFileSync(join(root, ".env"), "utf8")).toContain(
      "private-credential",
    );
    for (const [path, headers, expected] of [
      ["/", {}, 405],
      ["/api/status", {}, 401],
      ["/api/connections", auth, 405],
      [
        "/api/connections",
        {
          Origin: "https://evil.example",
          "Access-Control-Request-Method": "POST",
        },
        403,
      ],
    ] as const) {
      const response = await fetch(url + path, { method: "OPTIONS", headers });
      expect(response.status).toBe(expected);
      expect(response.headers.get("access-control-allow-origin")).toBeNull();
      expect(await response.text()).not.toContain("private-credential");
    }
  });
  it("saves tokens without returning them and reports only configured booleans", async () => {
    const { root, url } = await start();
    const initial = await (
      await fetch(`${url}/api/status`, { headers: auth })
    ).json();
    expect(initial).toMatchObject({
      configDirectory: root,
      hubRepo: null,
      projects: [],
      runtime: { dashboard: "local", agents: "local-docker" },
    });
    const saved = await post(
      `${url}/api/connections`,
      {
        values: {
          GITHUB_TOKEN: "unique-private-token",
          LINEAR_API_KEY: "linear-private",
        },
      },
      { Origin: url },
    );
    expect(await saved.json()).toEqual({ ok: true });
    const updated = await fetch(`${url}/api/status`, { headers: auth });
    const status = await updated.text();
    expect(status).not.toContain("unique-private-token");
    expect(status).not.toContain("linear-private");
    expect(
      JSON.parse(status).connections.find(
        (item: { name: string }) => item.name === "GITHUB_TOKEN",
      ).configured,
    ).toBe(true);
    expect(updated.headers.get("cache-control")).toBe("private, no-store");
    expect(updated.headers.get("access-control-allow-origin")).toBeNull();
    expect(readFileSync(join(root, ".env"), "utf8")).toContain(
      "unique-private-token",
    );
    expect(
      (await post(`${url}/api/connections`, { values: { GITHUB_TOKEN: "" } }))
        .status,
    ).toBe(200);
    expect(readFileSync(join(root, ".env"), "utf8")).toContain(
      "unique-private-token",
    );
  });

  it("rejects missing or incorrect sessions, foreign origins, and DNS rebinding hosts", async () => {
    const { url } = await start();
    expect((await fetch(`${url}/api/status`)).status).toBe(401);
    expect(
      (
        await fetch(`${url}/api/status`, {
          headers: { Authorization: `Bearer ${"b".repeat(64)}` },
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await fetch(`${url}/api/status`, {
          headers: { ...auth, Origin: "https://evil.example" },
        })
      ).status,
    ).toBe(403);
    expect((await fetch(url, { headers: { Origin: "null" } })).status).toBe(
      403,
    );
    const foreignHost = await new Promise<number>((done, reject) => {
      const req = request(
        `${url}/api/status`,
        { headers: { ...auth, Host: "evil.example" } },
        (res) => {
          res.resume();
          res.on("end", () => done(res.statusCode!));
        },
      );
      req.on("error", reject);
      req.end();
    });
    expect(foreignHost).toBe(403);
    expect(
      (
        await post(
          `${url}/api/connections`,
          { values: { GITHUB_TOKEN: "secret" } },
          { "Sec-Fetch-Site": "cross-site" },
        )
      ).status,
    ).toBe(403);
  });

  it("rejects wrong methods, content types, unknown keys and oversized JSON", async () => {
    const { url } = await start();
    expect((await post(`${url}/api/status`, {})).status).toBe(405);
    expect(
      (await fetch(`${url}/api/connections`, { headers: auth })).status,
    ).toBe(405);
    expect(
      (
        await post(
          `${url}/api/connections`,
          { values: {} },
          { "Content-Type": "text/plain" },
        )
      ).status,
    ).toBe(415);
    const unknown = await post(`${url}/api/connections`, {
      values: { NODE_OPTIONS: "never-show-this-secret" },
    });
    expect(unknown.status).toBe(400);
    expect(await unknown.text()).not.toContain("never-show-this-secret");
    expect(
      (await post(`${url}/api/connections`, { values: {}, extra: true }))
        .status,
    ).toBe(400);
    expect(
      (
        await post(`${url}/api/connections`, {
          values: { GITHUB_TOKEN: "a".repeat(40_000) },
        })
      ).status,
    ).toBe(413);
    const chunked = await new Promise<number>((done, reject) => {
      const req = request(
        `${url}/api/connections`,
        {
          method: "POST",
          headers: {
            ...auth,
            "Content-Type": "application/json",
            "Transfer-Encoding": "chunked",
          },
        },
        (res) => {
          res.resume();
          res.on("end", () => done(res.statusCode!));
        },
      );
      req.on("error", reject);
      req.write('{"values":{"GITHUB_TOKEN":"');
      req.write("a".repeat(40_000));
      req.end('"}}');
    });
    expect(chunked).toBe(413);
  });

  it("serves only dashboard files and refuses traversal, junctions and configuration", async () => {
    const { url, installation } = await start();
    const page = await fetch(url);
    expect(await page.text()).toContain("Gremlin dashboard");
    expect(page.headers.get("content-security-policy")).toContain(
      "script-src 'self'",
    );
    expect(page.headers.get("content-security-policy")).toContain(
      "frame-ancestors 'none'",
    );
    const external = temporary();
    writeFileSync(join(external, "private.html"), "external-secret");
    symlinkSync(
      external,
      join(installation, "dashboard", "external"),
      "junction",
    );
    for (const path of [
      "/.env",
      "/secret.json",
      "/%2e%2e%2fprivate.html",
      "/%2e%2e%5cprivate.html",
      "/%00",
      "/%zz",
      "/external/private.html",
    ])
      expect((await fetch(url + path)).status, path).toBe(404);
    expect(await (await fetch(url, { method: "HEAD" })).text()).toBe("");
  });

  it("initializes a real project and preserves it on repeated requests", async () => {
    const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
    const { root, url } = await start(packageRoot);
    const input = {
      project: "test-app",
      repo: "example/app",
      hubRepo: "example/hub",
    };
    const created = await post(`${url}/api/projects`, input);
    expect(created.status).toBe(200);
    const createdBody = (await created.json()) as {
      result: { created: string[] };
    };
    expect(createdBody.result.created.length).toBeGreaterThan(0);
    const existing = readFileSync(
      join(root, "projects", "test-app", "project.json"),
      "utf8",
    );
    const repeatedBody = (await (
      await post(`${url}/api/projects`, input)
    ).json()) as { result: { created: string[] } };
    expect(repeatedBody.result.created).toEqual([]);
    expect(
      readFileSync(join(root, "projects", "test-app", "project.json"), "utf8"),
    ).toBe(existing);
    const status = await (
      await fetch(`${url}/api/status`, { headers: auth })
    ).json();
    expect(status).toMatchObject({
      hubRepo: "example/hub",
      projects: [{ name: "test-app", repo: "example/app" }],
    });
    expect(
      (await post(`${url}/api/projects`, { ...input, project: "../escape" }))
        .status,
    ).toBe(400);
  });

  it("creates local configuration without an automation repository or fork", async () => {
    const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
    const { url, root } = await start(packageRoot);
    const result = await post(`${url}/api/projects`, {
      project: "my-app",
      repo: "example/app",
    });
    expect(result.status).toBe(200);
    expect(
      JSON.parse(readFileSync(join(root, "hub.json"), "utf8")).runners.mode,
    ).toBe("local");
  });

  it("reports invalid startup arguments without opening a browser", async () => {
    const errors: string[] = [];
    for (const args of [
      ["--host", "0.0.0.0"],
      ["--port", "-1"],
      ["--port"],
      ["--no-open=false"],
      ["--lan=false"],
    ])
      expect(
        await runDashboard("unused", "unused", args, {
          log: () => {},
          error: (message) => errors.push(message),
        }),
      ).toBe(1);
    expect(errors).toHaveLength(5);
  });

  it("edits validated configuration through authenticated requests and rejects stale saves", async () => {
    const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
    const { root, url } = await start(packageRoot);
    await post(`${url}/api/projects`, {
      project: "demo",
      repo: "example/app",
      hubRepo: "example/hub",
    });
    writeFileSync(
      join(root, ".env"),
      "GITHUB_TOKEN=not-config-editor-content\n",
    );
    const listing = await (
      await fetch(`${url}/api/config`, { headers: auth })
    ).json();
    expect(listing).toMatchObject({
      files: expect.arrayContaining([
        { path: "hub.json", label: expect.any(String) },
      ]),
    });
    expect(JSON.stringify(listing)).not.toContain(".env");
    const document = (await (
      await fetch(`${url}/api/config?path=hub.json`, { headers: auth })
    ).json()) as { path: string; content: string; revision: string };
    const settings = JSON.parse(document.content);
    settings.runners.label = "reviewed-runner";
    const update = {
      ...document,
      content: JSON.stringify(settings, null, 2) + "\n",
    };
    const put = (payload: unknown, headers: Record<string, string> = auth) =>
      fetch(`${url}/api/config`, {
        method: "PUT",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    expect((await put(update, {})).status).toBe(401);
    expect((await put({ ...update, content: "{}" })).status).toBe(400);
    expect(readFileSync(join(root, "hub.json"), "utf8")).toBe(document.content);
    const saved = await put(update);
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({
      ok: true,
      revision: expect.any(String),
    });
    expect(
      JSON.parse(readFileSync(join(root, "hub.json"), "utf8")).runners.label,
    ).toBe("reviewed-runner");
    expect((await put(update)).status).toBe(409);
    for (const path of [
      ".env",
      "../package.json",
      "projects/_templates/project.json",
    ])
      expect([400, 404]).toContain(
        (
          await fetch(`${url}/api/config?path=${encodeURIComponent(path)}`, {
            headers: auth,
          })
        ).status,
      );
    expect((await post(`${url}/api/config`, update)).status).toBe(405);
  });

  it("reports broken config without hiding its editor, and never opens folders from LAN requests", async () => {
    const { root, url } = await start(undefined, ["192.168.1.20"]);
    writeFileSync(join(root, "hub.json"), "broken json");
    const response = await fetch(`${url}/api/status`, { headers: auth });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      hubRepo: null,
      configWarnings: [expect.stringContaining("hub.json")],
      runtime: { canOpenFolders: false },
    });
    const document = await fetch(`${url}/api/config?path=hub.json`, {
      headers: auth,
    });
    expect(document.status).toBe(200);
    expect(
      (await post(`${url}/api/open-folder`, { target: "configuration" }))
        .status,
    ).toBe(400);
    expect(
      (await post(`${url}/api/open-folder`, { target: "C:/Windows" })).status,
    ).toBe(400);
    expect(
      (await fetch(`${url}/api/open-folder`, { headers: auth })).status,
    ).toBe(405);
    expect(
      (
        await fetch(`${url}/api/open-folder`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: '{"target":"installation"}',
        })
      ).status,
    ).toBe(401);
  });

  it("stops promptly with an unfinished request and removes signal handlers", async () => {
    const root = temporary();
    const beforeInterrupt = process.listeners("SIGINT");
    const beforeTerminate = process.listeners("SIGTERM");
    let onReady!: (url: string) => void;
    const ready = new Promise<string>((done) => {
      onReady = done;
    });
    const running = runDashboard(root, root, ["--no-open"], {
      log: (line) => {
        const url = /http:\/\/127\.0\.0\.1:\d+\/#session=[a-f0-9]+/.exec(
          line,
        )?.[0];
        if (url) onReady(url);
      },
      error: () => {},
    });
    const url = new URL(await ready);
    const stop = process
      .listeners("SIGINT")
      .find((listener) => !beforeInterrupt.includes(listener))!;
    const req = request(`${url.origin}/api/connections`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${url.hash.slice("#session=".length)}`,
        "Content-Type": "application/json",
        "Content-Length": "1024",
      },
    });
    // A stalled body used to keep graceful shutdown open until requestTimeout.
    req.on("error", () => {});
    const connected = new Promise<void>((done) =>
      req.once("socket", (socket) => socket.once("connect", done)),
    );
    req.write("{");
    try {
      await connected;
      await new Promise<void>((done) => setImmediate(done));
      stop("SIGINT");
      expect(await running).toBe(0);
      expect(process.listeners("SIGINT")).toEqual(beforeInterrupt);
      expect(process.listeners("SIGTERM")).toEqual(beforeTerminate);
    } finally {
      req.destroy();
      if (process.listeners("SIGINT").includes(stop)) stop("SIGINT");
      await running;
    }
  });
});

describe("dashboard browser launch", () => {
  it.each([
    ["win32", "rundll32.exe", ["url.dll,FileProtocolHandler"]],
    ["darwin", "open", []],
    ["linux", "xdg-open", []],
  ] as const)(
    "opens the local capability URL without a shell on %s",
    (platform, command, prefix) => {
      const child = new ChildProcess();
      const launch = vi.fn(() => child);
      const logs: string[] = [];
      const url = `http://127.0.0.1:4311/#session=${session}`;
      openDashboardBrowser(
        url,
        { log: (line) => logs.push(line), error: () => {} },
        platform,
        launch as unknown as typeof spawn,
      );
      expect(launch).toHaveBeenCalledWith(command, [...prefix, url], {
        stdio: "ignore",
        detached: true,
        windowsHide: true,
      });
      child.emit("exit", 0, null);
      expect(logs).toEqual([]);
    },
  );

  it.each(["missing", "headless", "throws"])(
    "keeps a usable link when a browser launcher %s",
    (failure) => {
      const child = new ChildProcess();
      const logs: string[] = [];
      const launch = vi.fn(() => {
        if (failure === "throws") throw new Error("launcher failed");
        return child;
      });
      openDashboardBrowser(
        "http://127.0.0.1:4311/#session=private",
        { log: (line) => logs.push(line), error: () => {} },
        "linux",
        launch as unknown as typeof spawn,
      );
      if (failure === "missing") {
        child.emit("error", new Error("ENOENT"));
        child.emit("exit", 1, null);
      }
      if (failure === "headless") child.emit("exit", 3, null);
      expect(logs).toEqual([
        "No browser opened. On another device, restart with gremlins setup --lan, or use an SSH tunnel to the loopback address above.",
      ]);
    },
  );
});

describe("homelab network discovery", () => {
  it("lists private IPv4 interfaces once, excluding loopback and public addresses", () => {
    const addresses = [
      "192.168.1.20",
      "10.0.0.2",
      "172.16.0.4",
      "100.64.0.5",
      "127.0.0.1",
      "8.8.8.8",
      "172.32.0.1",
      "100.128.0.1",
      "192.168.1.20",
    ];
    expect(
      lanAddresses({
        ethernet: addresses.map((address) => ({
          address,
          family: "IPv4",
          internal: address === "127.0.0.1",
          netmask: "255.255.255.0",
          mac: "00:00:00:00:00:00",
          cidr: null,
        })),
      }),
    ).toEqual(["10.0.0.2", "100.64.0.5", "172.16.0.4", "192.168.1.20"]);
  });

  it("does not start a network listener when no private address exists", async () => {
    const errors: string[] = [];
    expect(
      await runDashboard(
        "unused",
        "unused",
        ["--lan"],
        { log: () => {}, error: (line) => errors.push(line) },
        () => [],
      ),
    ).toBe(1);
    expect(errors.join("\n")).toContain("No private LAN IPv4");
  });

  it("starts explicit LAN mode, prints reachable links, and shuts down", async () => {
    const root = temporary();
    const before = process.listeners("SIGINT");
    const logs: string[] = [];
    let ready!: (url: string) => void;
    const started = new Promise<string>((done) => {
      ready = done;
    });
    const running = runDashboard(
      root,
      root,
      ["--lan", "--port", "0"],
      {
        log: (line) => {
          logs.push(line);
          if (line.includes("/#session=")) ready(line.trim());
        },
        error: () => {},
      },
      () => ["192.168.1.20"],
    );
    const url = new URL(await started);
    const stop = process
      .listeners("SIGINT")
      .find((listener) => !before.includes(listener))!;
    try {
      expect(url.hostname).toBe("192.168.1.20");
      expect(url.port).not.toBe("0");
      const response = await fetch(`http://127.0.0.1:${url.port}/api/status`, {
        headers: {
          Authorization: `Bearer ${url.hash.slice("#session=".length)}`,
        },
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        runtime: { access: "lan", canOpenFolders: false },
      });
      expect(logs.join("\n")).not.toContain("0.0.0.0");
      expect(logs.join("\n")).toContain("LAN mode uses HTTP");
    } finally {
      stop("SIGINT");
      await running;
    }
  });
});

function fakeUpdater(): Updater & { state: UpdateStatus } {
  const updater = {
    state: {
      phase: "idle" as const,
      currentVersion: "0.2.2",
      installedVersion: "0.2.2",
      message: "Ready to check.",
      restartRequired: false,
      canRollback: false,
    } as UpdateStatus,
    status() {
      return { ...this.state };
    },
    check: vi.fn(async () => updater.status()),
    apply: vi.fn(async () => updater.status()),
    rollback: vi.fn(async () => updater.status()),
  };
  return updater;
}

describe("dashboard runtime updates", () => {
  it("requires session authentication, same origin, supported actions, and an empty body", async () => {
    const updater = fakeUpdater();
    const { url } = await start(undefined, [], { updater });
    expect((await fetch(`${url}/api/updates`)).status).toBe(401);
    expect(
      (await post(`${url}/api/updates/apply`, {}, { Authorization: "" }))
        .status,
    ).toBe(401);
    expect(
      (
        await post(
          `${url}/api/updates/apply`,
          {},
          { Origin: "https://evil.example" },
        )
      ).status,
    ).toBe(403);
    expect((await post(`${url}/api/updates`, {})).status).toBe(405);
    expect(
      (await fetch(`${url}/api/updates/apply`, { headers: auth })).status,
    ).toBe(405);
    expect((await post(`${url}/api/updates/delete`, {})).status).toBe(404);
    expect(
      (await post(`${url}/api/updates/apply`, { repository: "someone/else" }))
        .status,
    ).toBe(400);
    expect(updater.apply).not.toHaveBeenCalled();
    expect((await fetch(`${url}/api/updates`, { headers: auth })).status).toBe(
      200,
    );
    expect(updater.check).not.toHaveBeenCalled();
  });

  it("keeps the dashboard responsive during installation and prevents overlapping operations", async () => {
    const updater = fakeUpdater();
    let finish!: () => void;
    const installing = new Promise<void>((done) => {
      finish = done;
    });
    updater.apply = vi.fn(async () => {
      updater.state.phase = "installing";
      await installing;
      updater.state = {
        ...updater.state,
        phase: "ready",
        restartRequired: true,
        canRollback: true,
      };
      return updater.status();
    });
    const { url } = await start(undefined, ["192.168.1.20"], { updater });
    expect((await post(`${url}/api/updates/apply`, {})).status).toBe(202);
    expect(
      await (await fetch(`${url}/api/updates`, { headers: auth })).json(),
    ).toMatchObject({ phase: "installing", canRestart: false });
    expect((await fetch(`${url}/api/status`, { headers: auth })).status).toBe(
      200,
    );
    for (const action of ["apply", "check", "rollback", "restart"])
      expect((await post(`${url}/api/updates/${action}`, {})).status).toBe(409);
    finish();
    await vi.waitFor(async () => {
      expect(
        await (await fetch(`${url}/api/updates`, { headers: auth })).json(),
      ).toMatchObject({ phase: "ready", restartRequired: true });
    });
    expect(updater.apply).toHaveBeenCalledOnce();
  });

  it("returns safe errors and keeps the rest of the dashboard usable after an update fails", async () => {
    const updater = fakeUpdater();
    updater.apply = vi.fn(async () => {
      throw new Error("private-token-sensitive-output");
    });
    const { url } = await start(undefined, [], { updater });
    expect((await post(`${url}/api/updates/apply`, {})).status).toBe(202);
    const response = await fetch(`${url}/api/updates`, { headers: auth });
    const text = await response.text();
    expect(text).not.toContain("private-token");
    expect(JSON.parse(text)).toMatchObject({ phase: "error" });
    expect((await fetch(`${url}/api/status`, { headers: auth })).status).toBe(
      200,
    );
  });

  it("restarts only a supervised dashboard with a different selected runtime", async () => {
    const updater = fakeUpdater();
    const restart = vi.fn();
    const { url } = await start(undefined, [], { updater, restart });
    expect((await post(`${url}/api/updates/restart`, {})).status).toBe(409);
    updater.state.restartRequired = true;
    const response = await post(`${url}/api/updates/restart`, {});
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ ok: true, restarting: true });
    await vi.waitFor(() => expect(restart).toHaveBeenCalledOnce());
    const direct = await start(undefined, [], { updater });
    expect((await post(`${direct.url}/api/updates/restart`, {})).status).toBe(
      400,
    );
  });
});
