import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { createDashboardServer, runDashboard } from "./dashboard.ts";
import type { DashboardAuthStatus } from "../dashboardAuth/index.ts";

const roots: string[] = [],
  servers: Server[] = [];
const bootstrap = "a".repeat(64),
  password = "a fifteen character passphrase";
const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
async function start(publicUrl?: string) {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "sg-dashboard-auth-"));
  roots.push(root);
  const server = createDashboardServer(
    root,
    packageRoot,
    bootstrap,
    ["192.168.1.3"],
    { publicUrl },
  );
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port,
    url = `http://127.0.0.1:${port}`;
  const post = (
    path: string,
    value: unknown = {},
    headers: Record<string, string> = {},
  ) =>
    headers.Host
      ? new Promise<Response>((resolve, reject) => {
          const req = request(
            `${url}${path}`,
            {
              method: "POST",
              headers: {
                Origin: url,
                "Content-Type": "application/json",
                ...headers,
              },
            },
            (res) => {
              let bytes = "";
              res.setEncoding("utf8");
              res.on("data", (chunk: string) => {
                bytes += chunk;
              });
              res.on("end", () => {
                const responseHeaders = new Headers();
                for (const [name, value] of Object.entries(res.headers))
                  if (value !== undefined)
                    responseHeaders.set(
                      name,
                      Array.isArray(value) ? value.join(", ") : value,
                    );
                resolve(
                  new Response(bytes, {
                    status: res.statusCode,
                    headers: responseHeaders,
                  }),
                );
              });
            },
          );
          req.on("error", reject);
          req.end(JSON.stringify(value));
        })
      : fetch(`${url}${path}`, {
          method: "POST",
          headers: {
            Origin: url,
            "Content-Type": "application/json",
            ...headers,
          },
          body: JSON.stringify(value),
        });
  return { root, server, url, port, post };
}
afterEach(async () => {
  for (const server of servers.splice(0))
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
it("authenticates browser cookies without broadening bearer APIs or remote-worker authentication", async () => {
  const f = await start();
  expect(await (await fetch(`${f.url}/api/auth/session`)).json()).toMatchObject(
    { configured: false, authenticated: false },
  );
  expect(
    (await f.post("/api/auth/setup", { password, remember: true })).status,
  ).toBe(401);
  const response = await f.post(
    "/api/auth/setup",
    { password, remember: true },
    { Authorization: `Bearer ${bootstrap}` },
  );
  expect(response.status).toBe(200);
  const state = (await response.json()) as DashboardAuthStatus;
  const cookie = response.headers.get("set-cookie")!.split(";")[0]!;
  expect(state).toMatchObject({ authenticated: true, mode: "cookie" });
  expect(
    (await fetch(`${f.url}/api/controller`, { headers: { Cookie: cookie } }))
      .status,
  ).toBe(200);
  expect(
    (
      await fetch(`${f.url}/api/controller`, {
        headers: { Authorization: `Bearer ${bootstrap}` },
      })
    ).status,
  ).toBe(200);
  expect(
    (
      await fetch(`${f.url}/api/controller`, {
        headers: { Cookie: cookie, Authorization: "Bearer invalid" },
      })
    ).status,
  ).toBe(401);
  expect(
    (
      await f.post(
        "/api/remote/worker/poll",
        {},
        { Cookie: cookie, "X-CSRF-Token": state.csrfToken! },
      )
    ).status,
  ).toBe(401);
  expect(
    (await f.post("/api/auth/logout", {}, { Cookie: cookie })).status,
  ).toBe(403);
  expect(
    (
      await f.post(
        "/api/auth/logout",
        {},
        {
          Cookie: cookie,
          "X-CSRF-Token": state.csrfToken!,
          Origin: "https://evil.example",
        },
      )
    ).status,
  ).toBe(403);
  const signedOut = await f.post(
    "/api/auth/logout",
    {},
    { Cookie: cookie, "X-CSRF-Token": state.csrfToken! },
  );
  expect(signedOut.status).toBe(200);
  expect(signedOut.headers.get("set-cookie")).toContain("Max-Age=0");
  expect(
    (await fetch(`${f.url}/api/controller`, { headers: { Cookie: cookie } }))
      .status,
  ).toBe(401);
});
it("requires JSON and exact Origin even for login and first-password setup", async () => {
  const f = await start();
  const missingOrigin = await fetch(`${f.url}/api/auth/setup`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${bootstrap}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ password, remember: true }),
  });
  expect(missingOrigin.status).toBe(403);
  expect(await missingOrigin.json()).toMatchObject({ code: "auth_csrf" });
  const form = await fetch(`${f.url}/api/auth/setup`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${bootstrap}`,
      Origin: f.url,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "password=should-not-be-read",
  });
  expect(form.status).toBe(415);
  const setup = await f.post(
    "/api/auth/setup",
    { password, remember: false },
    { Authorization: `Bearer ${bootstrap}` },
  );
  expect(setup.status).toBe(200);
  const wrong = await f.post("/api/auth/login", {
    password: "incorrect",
    remember: false,
  });
  expect(wrong.status).toBe(401);
  expect(await wrong.json()).toMatchObject({ code: "auth_invalid_password" });
  const crossSite = await f.post(
    "/api/auth/login",
    { password, remember: false },
    { "Sec-Fetch-Site": "cross-site" },
  );
  expect(crossSite.status).toBe(403);
});
it("offers private LAN password setup only after owner confirmation, and uses Secure cookies for configured HTTPS", async () => {
  const f = await start(),
    host = `192.168.1.3:${f.port}`,
    origin = `http://${host}`;
  const headers = {
    Host: host,
    Origin: origin,
    Authorization: `Bearer ${bootstrap}`,
  };
  expect(
    (await f.post("/api/auth/setup", { password, remember: true }, headers))
      .status,
  ).toBe(403);
  const allowed = await f.post(
    "/api/auth/setup",
    { password, remember: true, allowInsecureLan: true },
    headers,
  );
  expect(allowed.status, await allowed.clone().text()).toBe(200);
  expect(await allowed.json()).toMatchObject({
    secureTransport: false,
    allowInsecureLan: true,
  });
  expect(allowed.headers.get("set-cookie")).not.toContain("; Secure");
  const proxy = await start("https://gremlins.example");
  const secure = await proxy.post(
    "/api/auth/setup",
    { password, remember: true },
    {
      Host: "gremlins.example",
      Origin: "https://gremlins.example",
      Authorization: `Bearer ${bootstrap}`,
    },
  );
  expect(secure.status).toBe(200);
  expect(secure.headers.get("set-cookie")).toMatch(
    /^__Host-shipgremlins-session=/,
  );
  expect(secure.headers.get("set-cookie")).toContain("; Secure");
  expect(secure.headers.get("set-cookie")).not.toContain("Domain=");
});
it("resets forgotten passwords only from the local CLI and revokes remembered devices without touching connections", async () => {
  const f = await start();
  writeFileSync(join(f.root, ".env"), "TEST_RETAINED=synthetic\n");
  const setup = await f.post(
    "/api/auth/setup",
    { password, remember: true },
    { Authorization: `Bearer ${bootstrap}` },
  );
  const cookie = setup.headers.get("set-cookie")!.split(";")[0]!;
  const io = { log: vi.fn(), error: vi.fn() };
  expect(
    await runDashboard(f.root, packageRoot, ["--reset-password"], io),
  ).toBe(0);
  expect(readFileSync(join(f.root, ".env"), "utf8")).toBe(
    "TEST_RETAINED=synthetic\n",
  );
  expect(
    (await fetch(`${f.url}/api/controller`, { headers: { Cookie: cookie } }))
      .status,
  ).toBe(401);
  const status = await (
    await fetch(`${f.url}/api/auth/session`, {
      headers: { Authorization: `Bearer ${bootstrap}` },
    })
  ).json();
  expect(status).toMatchObject({ configured: false, canSetup: true });
  expect(
    (await f.post("/api/auth/reset-password", {}, { Cookie: cookie })).status,
  ).toBe(405);
  expect(
    (await f.post("/api/auth/setup", { password, remember: false })).status,
  ).toBe(401);
  expect(
    (
      await f.post(
        "/api/auth/setup",
        { password, remember: false },
        { Authorization: `Bearer ${bootstrap}` },
      )
    ).status,
  ).toBe(200);
});
