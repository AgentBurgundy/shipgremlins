#!/usr/bin/env node
// Use the installed runtime, never npx or a network package download.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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
        readFileSync(new URL("../package.json", import.meta.url), "utf8"),
      );
      console.log(`ShipGremlins ${version}`);
      process.exit(0);
    }
    const require = createRequire(import.meta.url);
    let loader;
    try {
      loader = pathToFileURL(require.resolve("tsx")).href;
    } catch {
      throw new Error(
        "ShipGremlins runtime is missing. Reinstall with: npm install -g git+https://github.com/AgentBurgundy/shipgremlins.git (source contributors: run npm ci in the checkout).",
      );
    }
    const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
    const child = spawn(
      process.execPath,
      [...nodeOptions, "--import", loader, cli, ...args],
      { stdio: "inherit", windowsHide: true, env },
    );
    child.on("error", () => {
      console.error(
        "Could not start ShipGremlins. Check that Node.js is available and reinstall the global CLI if needed.",
      );
      process.exitCode = 1;
    });
    child.on("exit", (code, signal) => {
      process.exitCode = code ?? (signal ? 1 : 0);
    });
    for (const signal of ["SIGINT", "SIGTERM"])
      process.on(signal, () => child.kill(signal));
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : "ShipGremlins could not start.",
    );
    process.exitCode = 1;
  }
}
