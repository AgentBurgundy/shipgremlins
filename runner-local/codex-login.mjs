// Trusted account helper: no repository, model turns, tools or worker artifacts.
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, lstatSync } from "node:fs";
import { createInterface } from "node:readline";

const directory = "/auth";
let child;
const status = (value) =>
  writeFileSync(`${directory}/status.json`, JSON.stringify(value), {
    mode: 0o600,
  });
const object = (value) =>
  !!value && typeof value === "object" && !Array.isArray(value);
const requests = new Map();
let sequence = 0;
let finished = false;
function fail() {
  if (finished) return;
  finished = true;
  for (const request of requests.values()) {
    clearTimeout(request.timer);
    request.reject(new Error("Account helper stopped"));
  }
  requests.clear();
  status({
    status: "failed",
    message:
      "Codex account sign-in or refresh failed. Reconnect your ChatGPT account and try again.",
  });
  child?.kill("SIGTERM");
  process.exitCode = 1;
}
function rpc(method, params) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      requests.delete(id);
      reject(new Error("Account request timed out"));
    }, 60_000);
    requests.set(id, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
  });
}
async function complete() {
  if (finished) return;
  const file = `${directory}/auth.json`,
    stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536)
    throw Error();
  const auth = JSON.parse(readFileSync(file, "utf8"));
  if (
    !object(auth) ||
    auth.auth_mode !== "chatgpt" ||
    !object(auth.tokens) ||
    !auth.tokens.refresh_token
  )
    throw Error();
  finished = true;
  status({
    status: "complete",
    message: "Codex is connected with your ChatGPT account.",
  });
  child.kill("SIGTERM");
}
try {
  let raw = "";
  for await (const chunk of process.stdin) {
    raw += chunk;
    if (Buffer.byteLength(raw) > 70_000) throw Error();
  }
  const input = JSON.parse(raw);
  if (
    !object(input) ||
    !["login", "refresh"].includes(input.mode) ||
    Object.keys(input).some((key) => !["mode", "auth"].includes(key))
  )
    throw Error();
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileSync(
    `${directory}/config.toml`,
    'cli_auth_credentials_store = "file"\nforced_login_method = "chatgpt"\n',
    { mode: 0o600 },
  );
  if (input.mode === "refresh") {
    if (typeof input.auth !== "string" || Buffer.byteLength(input.auth) > 65536)
      throw Error();
    writeFileSync(`${directory}/auth.json`, input.auth, { mode: 0o600 });
  }
  status({
    status: "starting",
    message:
      input.mode === "login"
        ? "Starting ChatGPT account sign-in…"
        : "Checking the Codex account session…",
  });
  child = spawn(
    "/opt/gremlins/node_modules/.bin/codex",
    ["app-server", "--listen", "stdio://"],
    {
      cwd: directory,
      env: { PATH: process.env.PATH, HOME: directory, CODEX_HOME: directory },
      stdio: ["pipe", "pipe", "ignore"],
    },
  );
  child.on("error", fail);
  child.on("close", () => {
    if (!finished) fail();
  });
  let bytes = 0;
  createInterface({ input: child.stdout }).on("line", (line) => {
    bytes += Buffer.byteLength(line);
    if (bytes > 512_000 || line.length > 131072) return fail();
    try {
      const message = JSON.parse(line);
      const pending = requests.get(message.id);
      if (pending) {
        clearTimeout(pending.timer);
        requests.delete(message.id);
        if (message.error) pending.reject(new Error("Account request failed"));
        else pending.resolve(message.result);
      } else if (message.method === "account/login/completed") {
        if (message.params?.success) void complete().catch(fail);
        else fail();
      } else if (message.id !== undefined) {
        // Never approve tools or perform any server-initiated model work.
        child.stdin.write(
          JSON.stringify({
            id: message.id,
            error: {
              code: -32601,
              message: "Account helper does not provide tools",
            },
          }) + "\n",
        );
      }
    } catch {
      fail();
    }
  });
  await rpc("initialize", {
    clientInfo: { name: "shipgremlins-account-helper", version: "1.0.0" },
    capabilities: {},
  });
  child.stdin.write(JSON.stringify({ method: "initialized" }) + "\n");
  if (input.mode === "login") {
    const result = await rpc("account/login/start", {
      type: "chatgptDeviceCode",
    });
    if (
      result?.type !== "chatgptDeviceCode" ||
      result.verificationUrl !== "https://auth.openai.com/codex/device" ||
      !/^[A-Z0-9-]{4,32}$/.test(result.userCode)
    )
      throw Error();
    if (!finished)
      status({
        status: "pending",
        verificationUrl: result.verificationUrl,
        userCode: result.userCode,
        expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
        message:
          "Open the sign-in page and enter the code to connect your ChatGPT account.",
      });
  } else {
    const result = await rpc("account/read", { refreshToken: true });
    if (result?.account?.type !== "chatgpt") throw Error();
    await complete();
  }
} catch {
  fail();
}
const timeout = setTimeout(() => {
  if (!finished) {
    finished = true;
    status({
      status: "expired",
      message: "The sign-in code expired. Start a new Codex sign-in.",
    });
    child?.kill("SIGTERM");
    process.exitCode = 1;
  }
}, 15 * 60_000);
timeout.unref();
