/** Run inside the runner image: node /path/to/browser-access-smoke.mjs.
 * Uses synthetic, disposable credentials and local HTTP fixtures only.
 */
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { prepareBrowserAccess } from "./browser-access.mjs";

const require = createRequire(import.meta.url);
const { chromium } = require("/opt/gremlins/node_modules/playwright");
const cli = "/opt/gremlins/node_modules/@playwright/mcp/cli.js";
const scenario = process.argv[2];
if (!scenario) {
  for (const mode of ["login", "bypass-only", "login-without-bypass"]) {
    const result = spawnSync(
      process.execPath,
      [fileURLToPath(import.meta.url), mode],
      { stdio: "inherit", timeout: 60000 },
    );
    if (result.status !== 0) process.exit(result.status || 1);
  }
  process.exit(0);
}
ensureScenario();
function ensureScenario() {
  if (!["login", "bypass-only", "login-without-bypass"].includes(scenario))
    throw new Error("Unknown browser smoke scenario");
}
const directory = mkdtempSync(join(tmpdir(), "gremlins-browser-smoke-"));
const credentials = Object.fromEntries(
  [
    "GREMLINS_PREVIEW_BYPASS",
    "GREMLINS_TEST_USERNAME_1",
    "GREMLINS_TEST_PASSWORD_1",
  ].map((key) => [
    key,
    `smoke-${randomBytes(20).toString("hex")}${key.includes("USERNAME") ? "@example.test" : ""}`,
  ]),
);
if (scenario === "bypass-only") {
  delete credentials.GREMLINS_TEST_USERNAME_1;
  delete credentials.GREMLINS_TEST_PASSWORD_1;
} else if (scenario === "login-without-bypass")
  delete credentials.GREMLINS_PREVIEW_BYPASS;
const privateValues = Object.values(credentials);
const redact = (value) =>
  privateValues.reduce(
    (text, secret) => text.replaceAll(secret, "[redacted]"),
    String(value),
  );
const ensure = (condition, message) => {
  if (!condition) throw new Error(message);
};
const requests = [];
let acceptedLogin = false;
let acceptedPostRedirects = 0;
let appOrigin;
const foreign = createServer((req, res) => {
  requests.push({
    origin: "foreign",
    path: req.url,
    bypass: req.headers["x-vercel-protection-bypass"],
  });
  if (req.url === "/return") {
    res.writeHead(302, { location: `${appOrigin}/returned` });
    res.end();
    return;
  }
  if (req.url === "/pixel") {
    res.writeHead(200, { "content-type": "image/gif" });
    res.end(Buffer.from("R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=", "base64"));
    return;
  }
  res.writeHead(200, { "content-type": "text/html" });
  res.end("<!doctype html><h1>External destination</h1>");
});
const listen = (server) =>
  new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve(`http://127.0.0.1:${server.address().port}`),
    ),
  );
const foreignOrigin = await listen(foreign);
const app = createServer(async (req, res) => {
  requests.push({
    origin: "app",
    path: req.url,
    bypass: req.headers["x-vercel-protection-bypass"],
  });
  if (
    scenario !== "login-without-bypass" &&
    req.headers["x-vercel-protection-bypass"] !==
      credentials.GREMLINS_PREVIEW_BYPASS
  ) {
    res.writeHead(401);
    res.end("Preview access required");
    return;
  }
  if (req.url === "/redirect" || req.url === "/round-trip") {
    res.writeHead(302, {
      location:
        foreignOrigin + (req.url === "/redirect" ? "/landing" : "/return"),
    });
    res.end();
    return;
  }
  if (req.url === "/same-origin") {
    res.writeHead(302, { location: "/returned" });
    res.end();
    return;
  }
  if (["/post-redirect-one", "/post-redirect-two"].includes(req.url)) {
    let body = "";
    for await (const chunk of req) body += chunk;
    const expected =
      credentials.GREMLINS_TEST_PASSWORD_1 || "synthetic-payload";
    if (new URLSearchParams(body).get("payload") === expected)
      acceptedPostRedirects++;
    res.writeHead(307, {
      location:
        req.url === "/post-redirect-one"
          ? "/post-redirect-two"
          : foreignOrigin + "/post-leak",
    });
    res.end();
    return;
  }
  if (req.url === "/post-redirect-form") {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(
      '<!doctype html><h1>Redirected write</h1><form action="/post-redirect-one" method="post"><label>Payload<input type="password" name="payload"></label><button type="submit">Try redirected write</button></form>',
    );
    return;
  }
  if (req.url === "/login" && req.method === "POST") {
    let body = "";
    for await (const chunk of req) body += chunk;
    const values = new URLSearchParams(body);
    acceptedLogin =
      values.get("email") === credentials.GREMLINS_TEST_USERNAME_1 &&
      values.get("password") === credentials.GREMLINS_TEST_PASSWORD_1;
    res.writeHead(acceptedLogin ? 200 : 403, { "content-type": "text/html" });
    res.end(
      acceptedLogin
        ? "<!doctype html><h1>Account ready</h1><button aria-label='Account settings'>Account</button>"
        : "Sign-in rejected",
    );
    return;
  }
  if (req.url === "/cross-write") {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(
      `<!doctype html><h1>Checking write boundary</h1><script>fetch(${JSON.stringify(foreignOrigin + "/write")},{method:"POST",mode:"no-cors",body:"synthetic-test-body"}).then(()=>document.querySelector("h1").textContent="Write escaped").catch(()=>document.querySelector("h1").textContent="Cross-origin write blocked");</script>`,
    );
    return;
  }
  res.writeHead(200, { "content-type": "text/html" });
  res.end(
    `<!doctype html><html><head><title>Runner access smoke</title></head><body><h1>Protected preview</h1><form action="/login" method="post"><label>Email<input type="email" name="email" autocomplete="off"></label><label>Password<input type="password" name="password" autocomplete="off"></label><button type="submit">Sign in</button></form><img alt="External fixture" src="${foreignOrigin}/pixel"></body></html>`,
  );
});
appOrigin = await listen(app);
const configArguments = prepareBrowserAccess(directory, {
  url: appOrigin,
  credentials,
});
let stderr = "",
  sequence = 0;
const pending = new Map(),
  responses = [];
const child = spawn(
  process.execPath,
  [
    cli,
    "--headless",
    "--grant-permissions",
    "local-network-access",
    "--no-sandbox",
    "--executable-path",
    chromium.executablePath(),
    "--output-dir",
    directory,
    ...configArguments,
  ],
  { cwd: directory, stdio: ["pipe", "pipe", "pipe"] },
);
child.stderr.on("data", (chunk) => {
  stderr += chunk;
});
const lines = createInterface({ input: child.stdout });
lines.on("line", (line) => {
  let result;
  try {
    result = JSON.parse(line);
  } catch {
    return;
  }
  responses.push(line);
  const request = pending.get(result.id);
  if (request) {
    clearTimeout(request.timer);
    pending.delete(result.id);
    request.resolve(result);
  }
});
const rpc = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`MCP request timed out: ${method}`));
    }, 30000);
    pending.set(id, { resolve, timer });
    child.stdin.write(
      JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n",
    );
  });
const call = async (name, args, allowError = false) => {
  const response = await rpc("tools/call", { name, arguments: args });
  ensure(
    !response.error && (allowError || !response.result?.isError),
    `${name} failed: ${redact(JSON.stringify(response))}`,
  );
  const output = response.result.content
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
  const expanded = output.replace(
    /\[Snapshot\]\(([^)]+)\)/g,
    (_match, path) => {
      const filename = resolve(directory, path);
      ensure(
        filename.startsWith(directory + sep),
        "Snapshot escaped the private test directory",
      );
      return readFileSync(filename, "utf8");
    },
  );
  responses.push(expanded);
  return expanded;
};
const refFor = (snapshot, role, label) => {
  const match = snapshot.match(
    new RegExp(`${role} "${label}"[^\\n]*\\[ref=([^\\]]+)\\]`),
  );
  ensure(match, `Snapshot did not expose the ${label} ${role}`);
  return match[1];
};
try {
  const initialized = await rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "shipgremlins-access-smoke", version: "1" },
  });
  ensure(initialized.result, "MCP initialization failed");
  child.stdin.write(
    JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) +
      "\n",
  );
  const tools = await rpc("tools/list");
  for (const name of [
    "browser_navigate",
    "browser_fill_form",
    "browser_type",
    "browser_click",
    "browser_take_screenshot",
  ])
    ensure(
      tools.result.tools.some((tool) => tool.name === name),
      `MCP does not expose ${name}`,
    );
  const opened = await call("browser_navigate", { url: appOrigin });
  ensure(
    opened.includes("Protected preview"),
    `The configured initPage did not supply preview access: ${redact(opened)}`,
  );
  if (scenario !== "bypass-only") {
    const emailRef = refFor(opened, "textbox", "Email");
    const passwordRef = refFor(opened, "textbox", "Password");
    const buttonRef = refFor(opened, "button", "Sign in");
    await call("browser_fill_form", {
      fields: [
        {
          name: "Email",
          type: "textbox",
          target: emailRef,
          value: "GREMLINS_TEST_USERNAME_1",
        },
      ],
    });
    await call("browser_type", {
      element: "Password",
      target: passwordRef,
      text: "GREMLINS_TEST_PASSWORD_1",
    });
    const signedIn = await call("browser_click", {
      element: "Sign in",
      target: buttonRef,
    });
    ensure(
      acceptedLogin && signedIn.includes("Account ready"),
      "Native MCP secret names did not complete password sign-in",
    );
  }
  await call("browser_take_screenshot", {
    filename: "signed-in.png",
    fullPage: false,
  });
  const screenshot = readFileSync(join(directory, "signed-in.png"));
  ensure(
    screenshot.subarray(1, 4).toString() === "PNG",
    "MCP did not produce a PNG screenshot",
  );
  {
    await call("browser_navigate", { url: `${foreignOrigin}/direct` }, true);
    await new Promise((resolve) => setTimeout(resolve, 250));
    ensure(
      !requests.some(
        (entry) => entry.origin === "foreign" && entry.path === "/direct",
      ),
      "Direct navigation escaped the selected origin",
    );
    await call("browser_navigate", { url: `${appOrigin}/redirect` }, true);
    // Let Chromium finish replacing the blocked navigation with its error page.
    await new Promise((resolve) => setTimeout(resolve, 250));
    ensure(
      !requests.some(
        (entry) => entry.origin === "foreign" && entry.path === "/landing",
      ),
      "A browser with private credentials navigated outside the selected origin",
    );
    const write = await call("browser_navigate", {
      url: `${appOrigin}/cross-write`,
    });
    ensure(
      write.includes("Cross-origin write blocked"),
      "Cross-origin write was not blocked",
    );
    ensure(
      !requests.some(
        (entry) => entry.origin === "foreign" && entry.path === "/write",
      ),
      "A cross-origin write reached the external fixture",
    );
  }
  const redirectForm = await call("browser_navigate", {
    url: `${appOrigin}/post-redirect-form`,
  });
  await call("browser_type", {
    target: refFor(redirectForm, "textbox", "Payload"),
    text: credentials.GREMLINS_TEST_PASSWORD_1
      ? "GREMLINS_TEST_PASSWORD_1"
      : "synthetic-payload",
  });
  await call(
    "browser_click",
    { target: refFor(redirectForm, "button", "Try redirected write") },
    true,
  );
  await new Promise((resolve) => setTimeout(resolve, 250));
  ensure(
    acceptedPostRedirects === 2,
    "Same-origin 307 redirects did not retain the POST body",
  );
  ensure(
    !requests.some(
      (entry) => entry.origin === "foreign" && entry.path === "/post-leak",
    ),
    "A redirected POST left the selected app origin",
  );
  const sameOrigin = await call("browser_navigate", {
    url: `${appOrigin}/same-origin`,
  });
  ensure(
    sameOrigin.includes("Protected preview"),
    "Same-origin redirect lost preview access",
  );
  ensure(
    requests.some(
      (entry) => entry.origin === "foreign" && entry.path === "/pixel",
    ),
    `External subresource was not exercised: ${JSON.stringify(requests.map(({ origin, path }) => ({ origin, path })))}`,
  );
  ensure(
    requests
      .filter((entry) => entry.origin === "foreign")
      .every((entry) => !entry.bypass),
    "Preview bypass leaked to an external origin",
  );
  ensure(
    requests
      .filter((entry) => entry.origin === "app")
      .every((entry) => entry.bypass === credentials.GREMLINS_PREVIEW_BYPASS),
    "A selected-origin request omitted preview access",
  );
  ensure(
    privateValues.every(
      (value) =>
        !responses.join("\n").includes(value) && !stderr.includes(value),
    ),
    "MCP output exposed a synthetic credential",
  );
  for (const file of [
    "playwright.json",
    "browser-access.json",
    "browser-init.mjs",
  ])
    ensure(
      (statSync(join(directory, file)).mode & 0o777) === 0o600,
      "Browser credential files are not private",
    );
  console.log(
    JSON.stringify({
      passed: true,
      scenario,
      mcpVersion:
        require("/opt/gremlins/node_modules/@playwright/mcp/package.json")
          .version,
      checks: [
        "CLI config and initPage",
        scenario === "login-without-bypass"
          ? "public app navigation"
          : "protected preview navigation",
        ...(scenario !== "bypass-only"
          ? [
              "native fill_form secret substitution",
              "native browser_type secret substitution",
              "password sign-in",
            ]
          : []),
        "cross-origin navigation blocked with private credentials",
        "cross-origin write blocked with private credentials",
        "same-origin redirect preserves credential scope",
        "same-origin 307 POST preserved and foreign hop blocked",
        "PNG screenshot",
        "cross-origin image header isolation",
        "no secrets in MCP responses or stderr",
        "private config files",
      ],
    }),
  );
} catch (error) {
  console.error(redact(error.message));
  if (stderr) console.error(redact(stderr));
  process.exitCode = 1;
} finally {
  for (const { timer } of pending.values()) clearTimeout(timer);
  child.kill("SIGTERM");
  lines.close();
  await Promise.all([
    new Promise((resolve) => app.close(resolve)),
    new Promise((resolve) => foreign.close(resolve)),
  ]);
  rmSync(directory, { recursive: true, force: true });
}
