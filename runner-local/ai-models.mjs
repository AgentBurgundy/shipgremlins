// Trusted catalog discovery only. Never starts a thread, model turn, tool or repository checkout.
import { spawn } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { codexSecretValues, prepareCodexInvocation } from "./codex.mjs";

const object = (value) =>
  !!value && typeof value === "object" && !Array.isArray(value);
const text = (value, maximum) =>
  typeof value === "string" &&
  !!value.trim() &&
  value.length <= maximum &&
  !/[\x00-\x1f\x7f]/.test(value);
function model(value, provider) {
  const id = provider === "codex" ? value?.model : value?.value;
  if (value?.hidden === true || id === "default") return undefined;
  if (
    typeof id !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/.test(id) ||
    !text(value?.displayName, 100) ||
    (value.description !== undefined &&
      (typeof value.description !== "string" ||
        value.description.length > 400 ||
        /[\x00-\x1f\x7f]/.test(value.description)))
  )
    throw new Error("Invalid model catalog.");
  return {
    id,
    label: value.displayName,
    ...(value.description ? { description: value.description } : {}),
  };
}
export async function readAiModelCatalog(input, dependencies = {}) {
  if (
    !object(input) ||
    !["claude", "codex"].includes(input.provider) ||
    Object.keys(input).some((key) => !["provider", "auth"].includes(key)) ||
    (input.provider === "claude" && input.auth !== undefined)
  )
    throw new Error("Invalid model catalog input.");
  if (
    input.provider === "codex" &&
    (typeof input.auth !== "string" ||
      Buffer.byteLength(input.auth) > 65536 ||
      JSON.parse(input.auth).tokens?.refresh_token !== "")
  )
    throw new Error("Catalog discovery requires access-only auth.");
  const directory = dependencies.directory ?? "/auth",
    provider = input.provider;
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  let invocation;
  const home = join(directory, "claude-home");
  const secrets = [];
  if (provider === "codex") {
    secrets.push(
      ...codexSecretValues(input.auth),
      JSON.parse(input.auth).tokens?.account_id,
    );
    invocation = prepareCodexInvocation({
      authJson: input.auth,
      cwd: directory,
      directory,
      restricted: true,
      env: {
        PATH: "/usr/local/bin:/usr/bin:/bin",
        HOME: directory,
        TMPDIR: "/tmp",
      },
    });
  } else mkdirSync(home, { recursive: true, mode: 0o700 });
  try {
    return await new Promise((resolve, reject) => {
      let child,
        stopped = false,
        done = false,
        bytes = 0,
        sequence = 0,
        cursor,
        pages = 0;
      const models = [],
        ids = new Set();
      const finish = (error) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        const settle = () => {
          if (error) reject(new Error("Model catalog is unavailable."));
          else resolve({ models });
        };
        if (!child || stopped) return settle();
        // SQLite and auth files remain owned by app-server until it exits.
        // Wait before removing its private home, including on Windows.
        const shutdown = setTimeout(() => {
          child.kill("SIGKILL");
          settle();
        }, 1500);
        child.once("close", () => {
          clearTimeout(shutdown);
          settle();
        });
        child.kill("SIGTERM");
      };
      const timer = setTimeout(
        () => finish(true),
        dependencies.timeoutMs ?? 8000,
      );
      const request = (method, params) => {
        const id = ++sequence;
        child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
      };
      const args =
        provider === "codex"
          ? ["app-server", "--strict-config", "--listen", "stdio://"]
          : [
              "--input-format",
              "stream-json",
              "--output-format",
              "stream-json",
              "--verbose",
              "--safe-mode",
              "--restricted",
              "--tools",
              "",
              "--strict-mcp-config",
              "--mcp-config",
              '{"mcpServers":{}}',
              "--no-session-persistence",
              "-p",
            ];
      try {
        child = (dependencies.spawn ?? spawn)(
          provider === "codex"
            ? "/opt/gremlins/node_modules/.bin/codex"
            : "/opt/gremlins/node_modules/.bin/claude",
          args,
          {
            cwd: directory,
            env: invocation?.env ?? {
              PATH: "/usr/local/bin:/usr/bin:/bin",
              HOME: home,
              TMPDIR: "/tmp",
              CLAUDE_CODE_DISABLE_CLAUDE_MDS: "1",
            },
            stdio: ["pipe", "pipe", "ignore"],
            shell: false,
          },
        );
      } catch {
        finish(true);
        return;
      }
      child.on("error", () => finish(true));
      child.on("close", () => {
        stopped = true;
        if (!done) finish(true);
      });
      child.stdin.on("error", () => finish(true));
      createInterface({ input: child.stdout }).on("line", (line) => {
        if (done) return;
        bytes += Buffer.byteLength(line);
        if (bytes > 1024 * 1024 || line.length > 512 * 1024)
          return finish(true);
        try {
          const message = JSON.parse(line);
          if (provider === "claude") {
            if (
              message.type !== "control_response" ||
              message.response?.request_id !== "shipgremlins-model-catalog"
            )
              return;
            if (message.response.subtype !== "success") return finish(true);
            const data = message.response.response?.models;
            if (!Array.isArray(data) || data.length > 64) return finish(true);
            for (const value of data) {
              const entry = model(value, provider);
              if (entry && !ids.has(entry.id)) {
                models.push(entry);
                ids.add(entry.id);
              }
            }
            return finish();
          }
          if (message.id !== sequence) {
            if (message.id !== undefined && message.method)
              child.stdin.write(
                JSON.stringify({
                  id: message.id,
                  error: {
                    code: -32601,
                    message: "Catalog helper does not provide tools",
                  },
                }) + "\n",
              );
            return;
          }
          if (message.error) return finish(true);
          if (sequence === 1) {
            child.stdin.write(JSON.stringify({ method: "initialized" }) + "\n");
            request("model/list", { limit: 20, includeHidden: false });
            return;
          }
          if (
            !object(message.result) ||
            !Array.isArray(message.result.data) ||
            message.result.data.length > 64 ||
            ++pages > 4
          )
            return finish(true);
          for (const value of message.result.data) {
            const entry = model(value, provider);
            if (entry && !ids.has(entry.id)) {
              models.push(entry);
              ids.add(entry.id);
            }
          }
          if (models.length > 64) return finish(true);
          const next = message.result.nextCursor;
          if (next !== undefined && next !== null) {
            if (!text(next, 1024) || next === cursor || pages >= 4)
              return finish(true);
            cursor = next;
            request("model/list", { cursor, limit: 20, includeHidden: false });
          } else {
            const encoded = JSON.stringify(models);
            if (
              secrets
                .filter(Boolean)
                .some((secret) =>
                  [
                    secret,
                    encodeURIComponent(secret),
                    JSON.stringify(secret).slice(1, -1),
                  ].some((value) => encoded.includes(value)),
                )
            )
              return finish(true);
            finish();
          }
        } catch {
          finish(true);
        }
      });
      if (provider === "codex")
        request("initialize", {
          clientInfo: { name: "shipgremlins-model-catalog", version: "1.0.0" },
          capabilities: {},
        });
      else
        child.stdin.write(
          JSON.stringify({
            type: "control_request",
            request_id: "shipgremlins-model-catalog",
            request: { subtype: "initialize" },
          }) + "\n",
        );
    });
  } finally {
    invocation?.cleanup();
    if (provider === "claude") rmSync(home, { recursive: true, force: true });
  }
}
export async function runAiModels() {
  try {
    let raw = "";
    for await (const chunk of process.stdin) {
      raw += chunk;
      if (Buffer.byteLength(raw) > 70000) throw new Error();
    }
    const input = JSON.parse(raw);
    raw = "";
    process.stdout.write(JSON.stringify(await readAiModelCatalog(input)));
  } catch {
    process.stdout.write('{"models":[]}');
    process.exitCode = 2;
  }
}
