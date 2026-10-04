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
} from "./dashboard.ts";

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
async function start(packageRoot?: string) {
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
  const server = createDashboardServer(root, installation, session);
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
      runtime: { dashboard: "local", agents: "github-actions" },
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

  it("explains the one-time automation repository choice outside a configured checkout", async () => {
    const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
    const { url } = await start(packageRoot);
    const result = await post(`${url}/api/projects`, {
      project: "my-app",
      repo: "example/app",
    });
    expect(result.status).toBe(400);
    expect(await result.json()).toEqual({
      error:
        "Choose the repository that will store PM configuration and run GitHub Actions, or launch the dashboard from your configured hub checkout.",
    });
  });

  it("reports invalid startup arguments without opening a browser", async () => {
    const errors: string[] = [];
    for (const args of [
      ["--host", "0.0.0.0"],
      ["--port", "-1"],
      ["--port"],
      ["--no-open=false"],
    ])
      expect(
        await runDashboard("unused", "unused", args, {
          log: () => {},
          error: (message) => errors.push(message),
        }),
      ).toBe(1);
    expect(errors).toHaveLength(4);
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
        "The browser could not open automatically. Open the dashboard link above in a browser on this computer.",
      ]);
    },
  );
});
