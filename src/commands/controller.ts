import { spawn } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { assertNoSymlinks } from "../setup/files.ts";
import { parseFlags, type Io } from "./crons.ts";
import { openDashboardBrowser } from "./dashboard.ts";

interface ControllerInfo {
  port: number;
  session: string;
  lan: boolean;
  addresses: string[];
}
const usage = `gremlins start [--lan] [--port PORT] [--no-open]  start the background controller
gremlins status                                show its dashboard address
gremlins stop                                  stop scheduling; keep running Docker jobs
Use gremlins setup for a foreground dashboard. Start runs until stopped or the server reboots.
For automatic startup after reboot, run gremlins dashboard under your server's service manager.`;

export async function controllerInfo(
  root: string,
): Promise<ControllerInfo | null> {
  const file = join(root, ".run", "controller.json");
  assertNoSymlinks(file);
  if (!existsSync(file)) return null;
  try {
    if (statSync(file).size > 8192) return null;
    const info = JSON.parse(readFileSync(file, "utf8")) as ControllerInfo;
    if (
      !Number.isInteger(info.port) ||
      info.port < 1 ||
      info.port > 65535 ||
      !/^[a-f0-9]{64}$/.test(info.session) ||
      typeof info.lan !== "boolean" ||
      !Array.isArray(info.addresses) ||
      !info.addresses.every((address) =>
        /^\d{1,3}(\.\d{1,3}){3}$/.test(address),
      )
    )
      return null;
    const res = await fetch(`http://127.0.0.1:${info.port}/api/controller`, {
      headers: { authorization: `Bearer ${info.session}` },
      signal: AbortSignal.timeout(1500),
      redirect: "error",
    });
    if (
      !res.ok ||
      ((await res.json()) as { background?: boolean }).background !== true
    )
      return null;
    return info;
  } catch {
    return null;
  }
}

export async function runController(
  root: string,
  packageRoot: string,
  command: string,
  args: string[],
  io: Io,
): Promise<number> {
  const { values, positionals } = parseFlags(args);
  if (values.help === true || args.includes("-h")) {
    io.log(usage);
    return 0;
  }
  if (
    positionals.length ||
    Object.keys(values).some(
      (key) => !["lan", "port", "no-open"].includes(key),
    ) ||
    ["lan", "no-open"].some(
      (key) => values[key] !== undefined && values[key] !== true,
    ) ||
    (command !== "start" && Object.keys(values).length) ||
    (values.port !== undefined &&
      (values.port === true ||
        !Number.isInteger(Number(values.port)) ||
        Number(values.port) < 0 ||
        Number(values.port) > 65535))
  ) {
    io.error(usage);
    return 1;
  }
  let info = await controllerInfo(root);
  if (command === "stop") {
    if (!info) {
      io.log("The background controller is not running.");
      return 0;
    }
    const res = await fetch(
      `http://127.0.0.1:${info.port}/api/controller/stop`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${info.session}`,
          "Content-Type": "application/json",
        },
        body: "{}",
        signal: AbortSignal.timeout(5000),
        redirect: "error",
      },
    );
    if (!res.ok) {
      io.error("The controller could not stop. Check its local dashboard.");
      return 1;
    }
    io.log(
      "Controller stopped. Running Docker jobs continue; queued jobs and schedules resume with gremlins start.",
    );
    return 0;
  }
  if (command === "start" && !info) {
    const dir = join(resolve(root), ".run");
    assertNoSymlinks(dir);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const lock = join(dir, "controller-start.lock");
    assertNoSymlinks(lock);
    if (existsSync(lock) && Date.now() - statSync(lock).mtimeMs > 30_000)
      unlinkSync(lock);
    let descriptor: number;
    try {
      descriptor = openSync(lock, "wx", 0o600);
    } catch {
      io.error(
        "Another controller is starting. Run gremlins status in a moment.",
      );
      return 1;
    }
    closeSync(descriptor);
    try {
      const log = join(dir, "controller.log");
      assertNoSymlinks(log);
      const output = openSync(log, "a", 0o600);
      try {
        const bootstrap =
          process.env.SHIPGREMLINS_BOOTSTRAP_ROOT ?? packageRoot;
        const child = spawn(
          process.execPath,
          [
            join(bootstrap, "bin", "shipgremlins.mjs"),
            "--home",
            resolve(root),
            "dashboard",
            "--no-open",
            ...(values.lan ? ["--lan"] : []),
            ...(values.port !== undefined
              ? ["--port", String(values.port)]
              : []),
          ],
          {
            detached: true,
            windowsHide: true,
            stdio: ["ignore", output, output],
            cwd: root,
            env: {
              ...process.env,
              SHIPGREMLINS_CONTROLLER_BACKGROUND: "1",
              SHIPGREMLINS_DASHBOARD_SESSION: "",
            },
          },
        );
        let failed = false;
        child.once("error", () => {
          failed = true;
        });
        child.unref();
        for (let attempt = 0; attempt < 60 && !failed; attempt++) {
          info = await controllerInfo(root);
          if (info) break;
          await new Promise((done) => setTimeout(done, 200));
        }
      } finally {
        closeSync(output);
      }
    } finally {
      unlinkSync(lock);
    }
  }
  if (!info) {
    io.error(
      command === "start"
        ? `Controller did not start. Check ${join(root, ".run", "controller.log")}.`
        : "The background controller is stopped. Run gremlins start.",
    );
    return 1;
  }
  if (command === "start" && values.lan === true && !info.lan) {
    io.error(
      "The existing controller is loopback-only. Run gremlins stop, then gremlins start --lan to change access.",
    );
    return 1;
  }
  io.log(
    "Your gremlins are running in the background. Keep this session link private:",
  );
  for (const address of info.lan ? info.addresses : ["127.0.0.1"])
    io.log(`http://${address}:${info.port}/#session=${info.session}`);
  if (command === "start" && !values["no-open"] && !info.lan)
    openDashboardBrowser(
      `http://127.0.0.1:${info.port}/#session=${info.session}`,
      io,
    );
  return 0;
}
