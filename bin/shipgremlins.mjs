#!/usr/bin/env node
// Use the installed runtime, never npx or a network package download.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 12)) {
  console.error("ShipGremlins requires Node.js 22.12 or newer.");
  process.exitCode = 1;
} else {
  try {
    const require = createRequire(import.meta.url);
    const loader = pathToFileURL(require.resolve("tsx")).href;
    const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
    const child = spawn(
      process.execPath,
      ["--import", loader, cli, ...process.argv.slice(2)],
      { stdio: "inherit", windowsHide: true },
    );
    child.on("error", () => {
      console.error("Could not start ShipGremlins. Run npm ci and try again.");
      process.exitCode = 1;
    });
    child.on("exit", (code, signal) => {
      process.exitCode = code ?? (signal ? 1 : 0);
    });
    for (const signal of ["SIGINT", "SIGTERM"])
      process.on(signal, () => child.kill(signal));
  } catch {
    console.error(
      "ShipGremlins runtime is missing. Run npm ci in the installation directory.",
    );
    process.exitCode = 1;
  }
}
