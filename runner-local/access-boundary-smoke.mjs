// Run on the Docker host: node runner-local/access-boundary-smoke.mjs <runner-image>.
// Only disposable, labelled local containers and an in-memory fixture are used.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const image = process.argv[2];
if (!/^shipgremlins-local:[a-f0-9]{16}$/.test(image || ""))
  throw Error("Pass an existing pinned local runner image.");
const run = (args, stdin = "", timeout = 30000) =>
  new Promise((resolve, reject) => {
    const child = spawn("docker", args, {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "",
      stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(Error("Docker smoke timed out."));
    }, timeout);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(stdin);
  });
const id = randomBytes(6).toString("hex"),
  network = `gremlins-access-smoke-${id}`,
  helper = `gremlins-auth-smoke-${id}`;
const username = `fixture-${id}@example.test`,
  password = randomBytes(24).toString("hex"),
  session = randomBytes(24).toString("hex");
const token = randomBytes(32).toString("hex"),
  controlToken = randomBytes(32).toString("hex");
const app = createServer(async (req, res) => {
  if (req.url === "/submit") {
    let body = "";
    for await (const chunk of req) body += chunk;
    const value = new URLSearchParams(body);
    if (
      value.get("username") === username &&
      value.get("password") === password
    ) {
      res.writeHead(302, {
        location: "/protected",
        "set-cookie": `session=${session}; HttpOnly; Path=/`,
      });
      res.end();
      return;
    }
  }
  res.setHeader("content-type", "text/html");
  res.end(
    req.headers.cookie?.includes(session)
      ? `<h1>Verified private workspace</h1><div id="account">${username}</div>`
      : `<form action="/submit" method="POST"><input id="username" name="username"><input id="password" name="password" type="password"><button id="submit">Sign in</button></form>`,
  );
});
await new Promise((resolve) => app.listen(0, "0.0.0.0", resolve));
const url = `http://host.docker.internal:${app.address().port}`;
const directory = dirname(fileURLToPath(import.meta.url));
const scripts = [
  "access-helper.mjs",
  "access-executor.mjs",
  "access-schema.mjs",
  "access-gateway.mjs",
  "access-status.mjs",
  "browser-access.mjs",
  "review-receipts.mjs",
];
let attached;
try {
  assert.equal(
    (
      await run([
        "network",
        "create",
        "--label",
        "io.shipgremlins.smoke=managed-access",
        network,
      ])
    ).code,
    0,
  );
  const mounts = scripts.flatMap((file) => [
    "--mount",
    `type=bind,source=${join(directory, file)},target=/opt/gremlins/${file},readonly`,
  ]);
  const created = await run([
    "create",
    "--interactive",
    "--name",
    helper,
    "--label",
    "io.shipgremlins.smoke=managed-access",
    "--network",
    network,
    "--add-host",
    "host.docker.internal:host-gateway",
    "--restart=no",
    "--init",
    "--read-only",
    "--user",
    "1000:1000",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    "--memory=1g",
    "--cpus=1",
    "--pids-limit=256",
    "--shm-size=256m",
    "--tmpfs",
    "/tmp:rw,nosuid,nodev,mode=1777,size=268435456",
    "--tmpfs",
    "/work:rw,nosuid,nodev,uid=1000,gid=1000,mode=0700,size=67108864",
    ...mounts,
    "--entrypoint",
    "node",
    image,
    "/opt/gremlins/access-helper.mjs",
  ]);
  assert.equal(created.code, 0, created.stderr);
  attached = run(
    ["start", "--attach", "--interactive", helper],
    JSON.stringify({
      version: 1,
      url,
      token,
      controlToken,
      maxRuntimeMs: 120000,
      access: {
        kind: "password",
        loginPath: "/login",
        authenticatedPath: "/protected",
        usernameSelector: "#username",
        passwordSelector: "#password",
        submitSelector: "#submit",
        successSelector: "#account",
        accounts: [{ name: "Fixture identity", username, password }],
      },
    }),
    140000,
  );
  let ready;
  for (let attempt = 0; attempt < 40; attempt++) {
    const result = await run(
      [
        "exec",
        "--interactive",
        helper,
        "node",
        "/opt/gremlins/access-status.mjs",
      ],
      JSON.stringify({ endpoint: "http://127.0.0.1:4719", token }),
    );
    if (result.code === 0) {
      ready = JSON.parse(result.stdout);
      if (ready.status === "ready" || ready.status === "failed") break;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.equal(ready?.status, "ready", JSON.stringify(ready));
  const agentCode = `import fs from 'node:fs';
const endpoint=${JSON.stringify(`http://${helper}:4719`)}, token=${JSON.stringify(token)};
const rpc=async(name,args={})=>(await fetch(endpoint+'/mcp',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}})})).json();
const snapshot=await rpc('browser_snapshot');
const denied=await rpc('browser_run_code_unsafe',{code:'return process.env'});
const review=await fetch(endpoint+'/review',{method:'POST',headers:{authorization:'Bearer '+token},body:'{}'});
console.log(JSON.stringify({snapshot,denied,reviewStatus:review.status,environment:process.env,workFiles:fs.readdirSync('/work'),helperProcVisible:fs.existsSync('/proc/'+${JSON.stringify(process.pid)}+'/root/opt/gremlins/access-helper.mjs')}));`;
  const agent = await run(
    [
      "run",
      "--rm",
      "--interactive",
      "--network",
      network,
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges",
      "--entrypoint",
      "node",
      image,
      "--input-type=module",
    ],
    agentCode,
  );
  assert.equal(agent.code, 0, agent.stderr);
  const observed = JSON.parse(agent.stdout);
  assert.match(JSON.stringify(observed.snapshot), /Verified private workspace/);
  assert.equal(observed.denied.result.isError, true);
  assert.equal(observed.reviewStatus, 401);
  for (const secret of [username, password, session, controlToken])
    assert.ok(
      !agent.stdout.includes(secret),
      "Private helper values reached the agent container",
    );
  assert.ok(
    !observed.workFiles.includes("job.json") &&
      !observed.workFiles.includes("browser-access.json"),
  );
  assert.equal(
    (
      await run(
        [
          "exec",
          "--interactive",
          helper,
          "node",
          "/opt/gremlins/access-status.mjs",
        ],
        JSON.stringify({
          endpoint: "http://127.0.0.1:4719",
          token,
          path: "/close",
        }),
      )
    ).code,
    0,
  );
  const exit = await attached;
  attached = undefined;
  assert.equal(exit.code, 0, exit.stderr);
  assert.equal(exit.stdout, "");
  assert.equal(exit.stderr, "");
  console.log(
    "Managed access boundary smoke passed: Docker stdin bootstrap, read-only sibling helper, restricted cross-container browser, no credentials/session/control token in agent filesystem/env/output, and clean shutdown.",
  );
} finally {
  await run(["rm", "--force", helper]);
  if (attached) await attached.catch(() => {});
  await run(["network", "rm", network]);
  await new Promise((resolve) => app.close(resolve));
}
