// Exercise the pinned native tool host without credentials or a model service.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { prepareCodexInvocation } from "../runner-local/codex.mjs";

const source = fileURLToPath(new URL("..", import.meta.url));
const PIN = JSON.parse(
  readFileSync(join(source, "runner-local/package.json"), "utf8"),
).dependencies["@openai/codex"];
assert(
  /^\d+\.\d+\.\d+$/.test(PIN),
  "The runner must pin an exact native Codex version.",
);
const temporaryRoot = realpathSync(tmpdir());
const scratch = realpathSync(
  mkdtempSync(join(temporaryRoot, "shipgremlins-native-tools-")),
);
const bounded = (value) => String(value).slice(-2500);
const timeoutMs = 60_000;

function nativeCodex() {
  const target = {
    "linux-x64": "x86_64-unknown-linux-musl",
    "linux-arm64": "aarch64-unknown-linux-musl",
    "darwin-x64": "x86_64-apple-darwin",
    "darwin-arm64": "aarch64-apple-darwin",
    "win32-x64": "x86_64-pc-windows-msvc",
    "win32-arm64": "aarch64-pc-windows-msvc",
  }[`${process.platform}-${process.arch}`];
  assert(
    target,
    "This native smoke check requires a supported Codex platform.",
  );
  const candidates = [
    join(source, "runner-local/node_modules/@openai/codex/package.json"),
    join(source, "node_modules/@openai/codex/package.json"),
  ];
  for (const entry of (process.env.PATH || process.env.Path || "")
    .split(delimiter)
    .filter(Boolean)) {
    candidates.push(
      resolve(entry, "../@openai/codex/package.json"),
      join(entry, "node_modules/@openai/codex/package.json"),
    );
    const launcher = join(entry, "codex");
    if (existsSync(launcher)) {
      try {
        candidates.push(
          resolve(dirname(realpathSync(launcher)), "../package.json"),
        );
      } catch {
        /* A broken PATH entry is not an installed CLI. */
      }
    }
  }
  for (const packagePath of [...new Set(candidates)]) {
    try {
      const metadata = JSON.parse(readFileSync(packagePath, "utf8"));
      if (metadata.name !== "@openai/codex" || metadata.version !== PIN)
        continue;
      const require = createRequire(packagePath);
      let vendor;
      try {
        vendor = join(
          dirname(
            require.resolve(
              `@openai/codex-${process.platform}-${process.arch}/package.json`,
            ),
          ),
          "vendor",
        );
      } catch {
        vendor = join(dirname(packagePath), "vendor");
      }
      const binary = join(
        vendor,
        target,
        "bin",
        process.platform === "win32" ? "codex.exe" : "codex",
      );
      if (existsSync(binary)) return binary;
    } catch {
      /* Try the next local or npm-exec installation. */
    }
  }
  throw new Error(
    `Install the pinned CLI or run npm exec --yes --package=@openai/codex@${PIN} -- node bin/verify-codex-tools.mjs.`,
  );
}

function isolatedEnvironment(directory) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) =>
      /^(?:PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|PSMODULEPATH|LANG|LC_ALL|TERM)$/i.test(
        key,
      ),
    ),
  );
  const home = join(directory, "isolated-home");
  mkdirSync(home, { recursive: true });
  for (const key of [
    "HOME",
    "USERPROFILE",
    "XDG_CONFIG_HOME",
    "XDG_CACHE_HOME",
    "APPDATA",
    "LOCALAPPDATA",
  ])
    env[key] = home;
  for (const key of ["TMPDIR", "TEMP", "TMP"]) env[key] = directory;
  return env;
}

function fakeAuth() {
  const token =
    [
      { alg: "RS256", typ: "JWT" },
      {
        sub: "synthetic-user",
        exp: 2_000_000_000,
        "https://api.openai.com/auth": {
          chatgpt_account_id: "synthetic-account",
          chatgpt_user_id: "synthetic-user",
          chatgpt_plan_type: "plus",
        },
      },
    ]
      .map((value) => Buffer.from(JSON.stringify(value)).toString("base64url"))
      .join(".") + ".synthetic-signature";
  return JSON.stringify({
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens: {
      id_token: token,
      access_token: "synthetic-access",
      refresh_token: "",
      account_id: "synthetic-account",
    },
  });
}

function shellWrite(path, content) {
  const script =
    "require('node:fs').writeFileSync(process.argv[1], process.argv[2]); console.log(process.argv[2]);";
  const quote =
    process.platform === "win32"
      ? (value) => "'" + value.replaceAll("'", "''") + "'"
      : (value) => "'" + value.replaceAll("'", "'\\''") + "'";
  return `${process.platform === "win32" ? "& " : ""}${quote(process.execPath)} -e ${quote(script)} ${quote(path)} ${quote(content)}`;
}

function outputText(body, callId) {
  const output = body.input?.find(
    (item) => item.call_id === callId && /_output$/.test(item.type),
  );
  assert(output, `Native CLI did not return tool output for ${callId}.`);
  return JSON.stringify(output.output);
}

function catalog(body, restricted, disabled) {
  const programmatic = body.tools?.some(
    (tool) => tool.type === "custom" && tool.name === "exec",
  );
  assert(
    disabled ? !programmatic : programmatic,
    disabled
      ? "Disabled native host unexpectedly advertised programmatic exec."
      : "Generated profile did not advertise programmatic exec.",
  );
  const readonly = body.tools.find(
    (tool) => tool.type === "namespace" && tool.name === "mcp__readonly",
  );
  assert(readonly, "Trusted read-only MCP namespace was not connected.");
  assert.deepEqual(readonly.tools.map((tool) => tool.name).sort(), [
    "list_files",
    "read_file",
    "search_files",
  ]);
  if (restricted) {
    const allowed = new Set([
      "exec",
      "wait",
      "list_mcp_resources",
      "list_mcp_resource_templates",
      "read_mcp_resource",
      "mcp__readonly",
    ]);
    assert(
      body.tools.every((tool) => allowed.has(tool.name)),
      `Restricted profile advertised unexpected tools: ${body.tools
        .map((tool) => tool.name)
        .filter((name) => !allowed.has(name))
        .join(", ")}`,
    );
  } else
    assert(
      body.tools.some((tool) => tool.name === "exec_command"),
      "Standard profile did not advertise shell execution.",
    );
}

function respond(res, output, sequence) {
  const response = {
    id: `response_${sequence}`,
    object: "response",
    status: "completed",
    output: [output],
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
  };
  res.writeHead(200, { "Content-Type": "text/event-stream" });
  for (const event of [
    {
      type: "response.created",
      response: { ...response, status: "in_progress", output: [] },
    },
    { type: "response.output_item.added", output_index: 0, item: output },
    { type: "response.output_item.done", output_index: 0, item: output },
    { type: "response.completed", response },
  ])
    res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  res.end();
}

async function check(binary, mode) {
  const directory = join(scratch, mode);
  const repository = join(directory, "repository");
  const memory = join(directory, "memory");
  mkdirSync(repository, { recursive: true });
  mkdirSync(memory);
  writeFileSync(join(repository, "probe.txt"), "TRUSTED_MCP_READ_OK");
  const marker = join(repository, "shell-marker.txt");
  const directMarker = join(repository, "direct-write-marker.txt");
  const patchMarker = join(repository, "patch-marker.txt");
  const restricted = mode === "restricted";
  const disabled = mode === "disabled-host";
  const task = prepareCodexInvocation({
    cwd: repository,
    directory,
    selection: { provider: "codex", model: "synthetic-model" },
    authJson: fakeAuth(),
    env: isolatedEnvironment(directory),
    restricted,
    ...(restricted
      ? { readonlyRoots: { repository, memory } }
      : {
          mcpServers: {
            readonly: {
              command: process.execPath,
              args: [
                join(source, "runner-local/codex-readonly.mjs"),
                repository,
                memory,
              ],
            },
          },
        }),
  });
  let child;
  let failure;
  let requests = 0;
  let blockedEgress = 0;
  const blockedTargets = new Set();
  let stdout = "";
  let stderr = "";
  const server = createServer(async (req, res) => {
    try {
      if (/^https?:\/\//.test(req.url)) {
        blockedEgress++;
        blockedTargets.add(new URL(req.url).host);
        res.writeHead(403).end();
        return;
      }
      if (req.method !== "POST" || req.url !== "/v1/responses")
        throw new Error("Native CLI requested an unexpected fixture endpoint.");
      let body = "";
      for await (const chunk of req) {
        body += chunk;
        if (Buffer.byteLength(body) > 1024 * 1024)
          throw new Error("Native request exceeded the smoke-test bound.");
      }
      const input = JSON.parse(body);
      catalog(input, restricted, disabled);
      requests++;
      let output;
      if (requests === 1) {
        const nestedRead =
          'text(await tools.mcp__readonly__read_file({root:"repository",path:"probe.txt"}));';
        const code = disabled
          ? `text(await tools.exec_command({cmd:${JSON.stringify(shellWrite(marker, "DISABLED_HOST_EXECUTED"))},max_output_tokens:100}));`
          : restricted
            ? [
                `try { await tools.exec_command({cmd:${JSON.stringify(shellWrite(marker, "SHELL_MUST_NOT_RUN"))},max_output_tokens:100}); text("SHELL_UNEXPECTEDLY_ALLOWED"); } catch { text("SHELL_REFUSED"); }`,
                `try { await tools.apply_patch(${JSON.stringify(`*** Begin Patch\n*** Add File: ${patchMarker}\n+PATCH_MUST_NOT_RUN\n*** End Patch`)}); text("PATCH_UNEXPECTEDLY_ALLOWED"); } catch { text("PATCH_REFUSED"); }`,
                `try { const fs = await import("node:fs/promises"); await fs.writeFile(${JSON.stringify(directMarker)},"WRITE_MUST_NOT_RUN"); text("WRITE_UNEXPECTEDLY_ALLOWED"); } catch { text("WRITE_REFUSED"); }`,
                nestedRead,
              ].join("\n")
            : `text(await tools.exec_command({cmd:${JSON.stringify(shellWrite(marker, "STANDARD_SHELL_OK"))},max_output_tokens:1000}));\n${nestedRead}`;
        output = {
          id: "exec_probe",
          type: "custom_tool_call",
          call_id: "exec_probe",
          name: "exec",
          input: code,
        };
      } else if (requests === 2) {
        const text = outputText(input, "exec_probe");
        if (disabled) {
          assert.match(
            text,
            /unsupported.*exec|unknown.*exec|code.?mode host.*disabled|disabled.*code.?mode host/i,
            "Disabled native host did not refuse programmatic exec.",
          );
        } else {
          assert(
            text.includes("TRUSTED_MCP_READ_OK"),
            "Nested MCP call did not execute through programmatic exec.",
          );
          if (restricted) {
            for (const marker of [
              "SHELL_REFUSED",
              "PATCH_REFUSED",
              "WRITE_REFUSED",
            ])
              assert(
                text.includes(marker),
                `Restricted tool host did not prove ${marker}.`,
              );
            assert(
              !text.includes("UNEXPECTEDLY_ALLOWED"),
              "Restricted profile executed a forbidden capability.",
            );
          } else
            assert(
              text.includes("STANDARD_SHELL_OK"),
              "Standard Code Mode shell tool did not execute.",
            );
        }
        output = disabled
          ? {
              id: "final",
              type: "message",
              role: "assistant",
              status: "completed",
              content: [
                { type: "output_text", text: "NEGATIVE_HOST_DIAGNOSTIC_OK" },
              ],
            }
          : {
              id: "read_probe",
              type: "function_call",
              call_id: "read_probe",
              name: "read_file",
              namespace: "mcp__readonly",
              arguments: JSON.stringify({
                root: "repository",
                path: "probe.txt",
              }),
            };
      } else if (requests === 3 && !disabled) {
        assert(
          outputText(input, "read_probe").includes("TRUSTED_MCP_READ_OK"),
          "Direct namespaced MCP tool did not execute.",
        );
        output = {
          id: "final",
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: "NATIVE_TOOL_SMOKE_OK" }],
        };
      } else
        throw new Error(
          "Native tool smoke exceeded its bounded response sequence.",
        );
      respond(res, output, requests);
    } catch (error) {
      failure ??= error;
      res.writeHead(400, { "Content-Type": "application/json" }).end(
        JSON.stringify({
          error: { message: "Synthetic native tool assertion failed." },
        }),
      );
      child?.kill();
    }
  });
  server.on("connect", (req, socket) => {
    blockedEgress++;
    blockedTargets.add(req.url);
    socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
  });
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const origin = `http://127.0.0.1:${server.address().port}`;
    // Never send synthetic account tokens to telemetry or authentication code.
    unlinkSync(join(task.home, "auth.json"));
    const path = join(task.home, "config.toml");
    let config = readFileSync(path, "utf8");
    assert(
      config.includes("code_mode = true") &&
        config.includes("code_mode_host = true"),
      "Generated Codex profile must enable Code Mode and its stable native host.",
    );
    config = config
      .replace('model_provider = "openai"', 'model_provider = "fixture"')
      .replace("[features]", "[features]\nenable_request_compression = false");
    config = "analytics.enabled = false\n" + config;
    if (disabled)
      config = config.replace(
        "code_mode_host = true",
        "code_mode_host = false",
      );
    config += `\n[model_providers.fixture]\nname = "Synthetic localhost only"\nbase_url = ${JSON.stringify(origin + "/v1")}\nwire_api = "responses"\nrequires_openai_auth = false\nsupports_websockets = false\nrequest_max_retries = 0\nstream_max_retries = 0\n`;
    writeFileSync(path, config);
    for (const key of [
      "HTTP_PROXY",
      "HTTPS_PROXY",
      "ALL_PROXY",
      "http_proxy",
      "https_proxy",
      "all_proxy",
    ])
      task.env[key] = origin;
    task.env.NO_PROXY = task.env.no_proxy = "127.0.0.1,localhost";
    const code = await new Promise((resolve, reject) => {
      child = spawn(binary, task.args, {
        env: task.env,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      let force;
      const stop = () => {
        child.kill();
        force ??= setTimeout(() => child.kill("SIGKILL"), 2000);
      };
      const timer = setTimeout(() => {
        failure ??= new Error(`${mode} native tool smoke timed out.`);
        stop();
      }, timeoutMs);
      const capture = (kind, chunk) => {
        if (kind === "stdout") stdout += chunk;
        else stderr += chunk;
        if (stdout.length + stderr.length > 1024 * 1024) {
          failure ??= new Error(
            "Native CLI output exceeded the smoke-test bound.",
          );
          stop();
        }
      };
      child.stdout.on("data", (chunk) => capture("stdout", chunk));
      child.stderr.on("data", (chunk) => capture("stderr", chunk));
      child.once("error", (error) => {
        clearTimeout(timer);
        clearTimeout(force);
        reject(error);
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        clearTimeout(force);
        resolve(code);
      });
      child.stdin.on("error", () => {
        // A startup rejection may close stdin before the tiny fixture prompt.
        // The native exit status and protocol assertions still fail the check.
      });
      child.stdin.end(
        "Synthetic local protocol check. Execute only the provided fixture tools, then return the fixed response.",
      );
    });
    if (failure)
      throw new Error(
        `${mode}: ${failure.message}\n${bounded(stdout)}\n${bounded(stderr)}`,
      );
    assert.equal(code, 0, `${mode} native CLI failed: ${bounded(stderr)}`);
    assert.equal(
      requests,
      disabled ? 2 : 3,
      `${mode} did not complete all tool turns.`,
    );
    if (disabled)
      assert.match(
        stdout,
        /Code Mode is unavailable because code-mode host is disabled/i,
        "Disabled-host negative fixture did not emit its native startup diagnostic.",
      );
    assert.equal(
      blockedEgress,
      0,
      `Native CLI attempted a non-local network request: ${[...blockedTargets].join(", ")}.`,
    );
    assert.equal(
      task.readResult().trim(),
      disabled ? "NEGATIVE_HOST_DIAGNOSTIC_OK" : "NATIVE_TOOL_SMOKE_OK",
    );
    if (restricted || disabled)
      for (const path of [marker, directMarker, patchMarker])
        assert(
          !existsSync(path),
          "Restricted or disabled profile wrote a forbidden marker.",
        );
    else assert.equal(readFileSync(marker, "utf8"), "STANDARD_SHELL_OK");
    console.log(
      `Codex ${PIN} ${mode}: ${disabled ? "disabled-host diagnostic verified" : restricted ? "read-only MCP works; shell, patch and direct writes refused" : "programmatic shell and nested/direct trusted MCP work"}.`,
    );
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    task.cleanup();
  }
}

try {
  const binary = nativeCodex();
  const version = spawnSync(binary, ["--version"], {
    encoding: "utf8",
    env: isolatedEnvironment(scratch),
    timeout: 30_000,
    windowsHide: true,
  });
  assert.equal(
    version.status,
    0,
    "Pinned native Codex binary could not start.",
  );
  assert.equal(
    version.stdout.trim(),
    `codex-cli ${PIN}`,
    "Native tool smoke must run the pinned Codex CLI.",
  );
  for (const mode of ["standard", "restricted", "disabled-host"])
    await check(binary, mode);
} catch (error) {
  console.error(`Codex native tool smoke failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  const within = relative(temporaryRoot, scratch);
  assert(
    within.startsWith("shipgremlins-native-tools-") && !within.includes(".."),
    "Invalid native-smoke cleanup directory.",
  );
  rmSync(scratch, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  });
}
