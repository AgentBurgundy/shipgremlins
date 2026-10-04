#!/usr/bin/env node
// Use the installed runtime, never npx or a network package download.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveRuntime, runtimeLocation } from "./runtime.mjs";

const bootstrapRoot = realpathSync(
  fileURLToPath(new URL("..", import.meta.url)),
);

function selectedRuntime() {
  try {
    return resolveRuntime(bootstrapRoot);
  } catch (error) {
    console.error(
      error instanceof Error
        ? error.message
        : "The saved ShipGremlins update could not be loaded.",
    );
    console.error(
      "Continuing with the original installed ShipGremlins runtime.",
    );
    console.error(
      `To reset the saved update, rename: ${join(runtimeLocation(bootstrapRoot), "active.json")}`,
    );
    return bootstrapRoot;
  }
}

function dashboardCommand(args) {
  return (
    args[0] === "dashboard" ||
    (args[0] === "setup" &&
      (args.length === 1 ||
        args.includes("--no-open") ||
        args.some(
          (arg) =>
            arg === "--lan" ||
            arg.startsWith("--lan=") ||
            arg === "--port" ||
            arg.startsWith("--port="),
        )))
  );
}

function restartMessage(message) {
  return (
    message !== null &&
    typeof message === "object" &&
    !Array.isArray(message) &&
    Object.keys(message).length === 5 &&
    message.type === "shipgremlins:restart-dashboard" &&
    Number.isInteger(message.port) &&
    message.port > 0 &&
    message.port <= 65535 &&
    typeof message.session === "string" &&
    /^[a-f0-9]{64}$/.test(message.session) &&
    typeof message.configurationRoot === "string" &&
    message.configurationRoot.length <= 4096 &&
    isAbsolute(message.configurationRoot) &&
    ![...message.configurationRoot].some(
      (character) =>
        character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    ) &&
    typeof message.lan === "boolean"
  );
}

async function supervise(args, env, nodeOptions) {
  let child;
  let stopping = false;
  const restarts = [];
  const stop = (signal) => {
    if (stopping) return;
    stopping = true;
    if (child && !child.killed) child.kill(signal);
  };
  const interrupt = () => stop("SIGINT");
  const terminate = () => stop("SIGTERM");
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  try {
    for (;;) {
      const runtime = selectedRuntime();
      let loader;
      try {
        loader = pathToFileURL(
          createRequire(join(runtime, "package.json")).resolve("tsx"),
        ).href;
      } catch {
        throw new Error(
          "ShipGremlins runtime is missing. Reinstall with: npm install -g git+https://github.com/AgentBurgundy/shipgremlins.git (source contributors: run npm ci in the checkout).",
        );
      }
      let requested;
      const result = await new Promise((done) => {
        child = spawn(
          process.execPath,
          [
            ...nodeOptions,
            "--import",
            loader,
            join(runtime, "src", "cli.ts"),
            ...args,
          ],
          {
            stdio: ["inherit", "inherit", "inherit", "ipc"],
            windowsHide: true,
            env: {
              ...env,
              SHIPGREMLINS_BOOTSTRAP_ROOT: bootstrapRoot,
              SHIPGREMLINS_MANAGED_LAUNCH: "1",
            },
          },
        );
        let spawnFailed = false;
        child.on("message", (message) => {
          if (!stopping && dashboardCommand(args) && restartMessage(message))
            requested = message;
        });
        child.once("error", () => {
          spawnFailed = true;
          console.error(
            "Could not start ShipGremlins. Check that Node.js is available and reinstall the global CLI if needed.",
          );
        });
        child.once("close", (code, signal) =>
          done({ code: spawnFailed ? 1 : code, signal }),
        );
      });
      child = undefined;
      if (stopping || result.code !== 75 || !requested)
        return result.code ?? (result.signal ? 1 : 0);
      const now = Date.now();
      while (restarts.length && restarts[0] < now - 60_000) restarts.shift();
      if (restarts.length >= 3) {
        console.error(
          "The dashboard restarted too often. Run gremlins dashboard again after checking the update.",
        );
        return 1;
      }
      restarts.push(now);
      env.SHIPGREMLINS_HOME = requested.configurationRoot;
      env.SHIPGREMLINS_DASHBOARD_SESSION = requested.session;
      args = [
        "dashboard",
        "--no-open",
        "--port",
        String(requested.port),
        ...(requested.lan ? ["--lan"] : []),
      ];
      console.log("Restarting your gremlins with the updated runtime…");
    }
  } finally {
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", terminate);
  }
}

const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 12)) {
  console.error("ShipGremlins requires Node.js 22.12 or newer.");
  process.exitCode = 1;
} else {
  try {
    const args = [];
    const env = { ...process.env };
    const nodeOptions = [];
    const input = process.argv.slice(2);
    const seen = new Set();
    for (let i = 0; i < input.length; i++) {
      const arg = input[i];
      const key = arg.split("=", 1)[0];
      if (key !== "--home" && key !== "--env-file") {
        args.push(arg);
        continue;
      }
      const value = arg.includes("=")
        ? arg.slice(arg.indexOf("=") + 1)
        : input[++i];
      if (!value || value.startsWith("-") || seen.has(key))
        throw new Error(
          `${key} requires one path and may only be specified once.`,
        );
      seen.add(key);
      if (key === "--home") env.SHIPGREMLINS_HOME = resolve(value);
      else nodeOptions.push(`--env-file=${resolve(value)}`);
    }
    if (args.length === 1 && ["--version", "-v"].includes(args[0])) {
      const { version } = JSON.parse(
        readFileSync(join(selectedRuntime(), "package.json"), "utf8"),
      );
      console.log(`ShipGremlins ${version}`);
      process.exit(0);
    }
    process.exitCode = await supervise(args, env, nodeOptions);
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : "ShipGremlins could not start.",
    );
    process.exitCode = 1;
  }
}
