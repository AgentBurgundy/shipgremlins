import { createServer, request } from "node:http";
import { randomBytes } from "node:crypto";
import { mkdtempSync, realpathSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createDashboardServer } from "../../src/commands/dashboard.ts";
import { createFixture } from "./fixture.mjs";

if (process.env.SHIPGREMLINS_DASHBOARD_FIXTURE !== "1")
  throw new Error(
    "Set SHIPGREMLINS_DASHBOARD_FIXTURE=1 explicitly. This is a synthetic test application, never a production controller.",
  );
const port = Number(process.env.PORT ?? 3000);
if (!Number.isInteger(port) || port < 0 || port > 65535)
  throw new Error("Invalid PORT.");
// Never inherit provider credentials, dashboard sessions or a real configuration home.
for (const key of Object.keys(process.env))
  if (
    ![
      "PATH",
      "SystemRoot",
      "COMSPEC",
      "TEMP",
      "TMP",
      "TMPDIR",
      "LANG",
      "TZ",
    ].includes(key)
  )
    delete process.env[key];
globalThis.fetch = async () => {
  throw new Error(
    "Outbound provider requests are disabled in the dashboard fixture.",
  );
};
const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
const root = mkdtempSync(
  join(realpathSync(tmpdir()), "shipgremlins-dashboard-fixture-"),
);
const session = randomBytes(32).toString("hex");
const fixture = createFixture(root, packageRoot);
const backend = createDashboardServer(
  root,
  packageRoot,
  session,
  [],
  fixture.options,
);
await new Promise((done) => backend.listen(0, "127.0.0.1", done));
const internalPort = backend.address().port;
const localOrigin = `http://127.0.0.1:${internalPort}`;
const json = (res, status, value) => {
  res.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(value));
};
const mutation = (path, method) =>
  (path === "/api/updates/check" && method === "POST") ||
  (path === "/api/config" && method === "PUT") ||
  (path === "/api/jobs" && method === "POST") ||
  (/^\/api\/jobs\/job-[a-f0-9-]+\/cancel$/.test(path) && method === "POST") ||
  (/^\/api\/runners(?:\/worker-[a-z0-9-]+\/[^/]+)?$/.test(path) &&
    method === "POST") ||
  (/^\/api\/projects\/[a-z0-9-]+\/pms\/[a-z0-9-]+\/(?:brief|status)$/.test(
    path,
  ) &&
    ["POST", "PUT"].includes(method)) ||
  (/^\/api\/projects\/[a-z0-9-]+\/areas\/[a-z0-9-]+\/status$/.test(path) &&
    method === "POST") ||
  (/^\/api\/projects\/[a-z0-9-]+\/areas$/.test(path) && method === "POST") ||
  (/^\/api\/projects\/[a-z0-9-]+(?:\/pms\/[a-z0-9-]+)?$/.test(path) &&
    method === "DELETE") ||
  (/^\/api\/deleted\/[a-f0-9-]+\/restore$/.test(path) && method === "POST");
const banner = `<aside id="fixture-notice" role="note">DISPOSABLE DASHBOARD FIXTURE · Synthetic accounts, projects, runs and evidence. No real OAuth, AI worker, deployment or ticket delivery is verified. Changes affect this container only. <a href="/fixture/about">Fixture boundaries</a></aside>`;
const server = createServer(async (req, res) => {
  const host = req.headers.host ?? "";
  if (!/^[a-zA-Z0-9.\[\]:-]+$/.test(host))
    return json(res, 400, { error: "Invalid fixture host." });
  if (
    (req.headers.origin && req.headers.origin !== `http://${host}`) ||
    req.headers["sec-fetch-site"] === "cross-site"
  )
    return json(res, 403, {
      error: "Fixture requests must stay on the same origin.",
    });
  const url = new URL(req.url ?? "/", `http://${host}`);
  if (url.pathname === "/fixture/health")
    return json(res, 200, { ok: true, fixture: true, externalServices: false });
  if (url.pathname === "/fixture/login") {
    if (req.method === "POST") {
      let value = "";
      for await (const chunk of req) {
        value += chunk;
        if (value.length > 2048)
          return json(res, 400, { error: "Fixture form too large." });
      }
      const form = new URLSearchParams(value);
      if (
        form.get("username") !== "fixture-member" ||
        form.get("password") !== "fixture-password"
      )
        return json(res, 401, {
          error: "Use only the documented public synthetic account.",
        });
      res.writeHead(303, {
        location: "/fixture/signed-in",
        "set-cookie":
          "fixture-login=synthetic; HttpOnly; SameSite=Strict; Path=/fixture; Max-Age=600",
      });
      return res.end();
    }
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    });
    return res.end(
      '<!doctype html><html><head><title>Synthetic login fixture</title></head><body><h1>Synthetic test account</h1><p>No real authentication provider is connected. Never enter real credentials.</p><form method="post" action="/fixture/login"><label>Username <input id="fixture-username" name="username" autocomplete="off"></label><label>Password <input id="fixture-password" name="password" type="password" autocomplete="off"></label><button id="fixture-submit">Sign in to fixture</button></form></body></html>',
    );
  }
  if (url.pathname === "/fixture/signed-in") {
    if (
      !String(req.headers.cookie ?? "")
        .split(";")
        .some((value) => value.trim() === "fixture-login=synthetic")
    )
      return json(res, 401, { error: "Use the synthetic login form first." });
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    });
    return res.end(
      '<!doctype html><html><head><title>Fixture signed in</title></head><body><h1 id="fixture-signed-in">Synthetic member signed in</h1><p>This verifies only the disposable login form. It does not verify real OAuth or RBAC.</p><a href="/">Open fixture dashboard</a></body></html>',
    );
  }
  if (url.pathname === "/fixture/about") {
    res.writeHead(200, {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
    });
    return res.end(
      readFileSync(join(packageRoot, "examples/dashboard-test/README.md")),
    );
  }
  if (url.pathname === "/fixture.css") {
    res.writeHead(200, { "content-type": "text/css" });
    return res.end(
      "#fixture-notice{position:fixed;z-index:10000;bottom:0;left:0;right:0;padding:10px 20px;background:#382e00;color:#fff4b1;border-top:2px solid #f7cf43;font:12px/1.4 system-ui;box-shadow:0 -2px 12px #0008}#fixture-notice a{color:#fff;text-decoration:underline}body{padding-bottom:68px!important}@media(max-width:600px){#fixture-notice{font-size:11px;padding:8px}body{padding-bottom:84px!important}}",
    );
  }
  if (url.pathname === "/") {
    res.writeHead(302, {
      location: `/overview#session=${session}`,
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
    });
    return res.end();
  }
  if (url.pathname.startsWith("/api/")) {
    if (
      url.pathname.startsWith("/api/remote/worker/") ||
      (!["GET", "HEAD"].includes(req.method) &&
        !mutation(url.pathname, req.method))
    )
      return json(res, 409, {
        error:
          "This provider, account or machine operation is disabled in the disposable fixture. Configuration, PM controls and simulated runs remain testable.",
      });
  }
  const proxied = request(
    `${localOrigin}${url.pathname}${url.search}`,
    {
      method: req.method,
      headers: {
        ...req.headers,
        host: `127.0.0.1:${internalPort}`,
        ...(req.headers.origin ? { origin: localOrigin } : {}),
        "accept-encoding": "identity",
      },
    },
    (response) => {
      const type = String(response.headers["content-type"] ?? "");
      if (type.startsWith("text/html")) {
        const parts = [];
        response.on("data", (part) => parts.push(part));
        response.on("end", () => {
          const html = Buffer.concat(parts)
            .toString()
            .replace(
              "</head>",
              '<link rel="stylesheet" href="/fixture.css"></head>',
            )
            .replace("</body>", banner + "</body>");
          const headers = { ...response.headers };
          delete headers["content-length"];
          res.writeHead(response.statusCode, headers);
          res.end(html);
        });
      } else {
        res.writeHead(response.statusCode, response.headers);
        response.pipe(res);
      }
    },
  );
  proxied.on("error", () =>
    json(res, 502, { error: "Disposable fixture backend unavailable." }),
  );
  req.pipe(proxied);
});
server.requestTimeout = 15000;
await new Promise((done) => server.listen(port, "0.0.0.0", done));
console.log(
  JSON.stringify({
    fixture: true,
    port: server.address().port,
    message:
      "Synthetic dashboard ready. No provider credentials or Docker socket are used.",
  }),
);
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  server.closeAllConnections();
  backend.closeAllConnections();
  await Promise.all([
    new Promise((done) => server.close(done)),
    new Promise((done) => backend.close(done)),
  ]);
  if (
    resolve(root).startsWith(resolve(realpathSync(tmpdir())) + "/") ||
    resolve(root).startsWith(resolve(realpathSync(tmpdir())) + "\\")
  )
    rmSync(root, { recursive: true, force: true });
  process.exit(0);
}
process.on("SIGTERM", () => void close());
process.on("SIGINT", () => void close());
