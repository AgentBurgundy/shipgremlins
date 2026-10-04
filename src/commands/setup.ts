import { join, resolve } from "node:path";
import { existsSync } from "node:fs";
import {
  initializeSetup,
  isExampleHub,
  setupDirectory,
} from "../setup/files.ts";
import { detectHubRepository } from "../setup/location.ts";
import { loadHub } from "../config.ts";
import { preflightSummary } from "../terminal.ts";
import { inspectSetup, type PreflightDeps } from "../setup/preflight.ts";
import { parseFlags, type Io } from "./crons.ts";

export interface SetupDeps extends PreflightDeps {
  templatesRoot?: string;
  detectHubRepo?: (directory: string) => string | undefined;
}

const USAGE = `ShipGremlins setup

  shipgremlins setup                                      open the local setup dashboard
  shipgremlins setup status [--check] [--json] [--verbose] [--dir PATH] [--project my-app]
  shipgremlins setup init --project my-app --repo owner/app [--hub-repo owner/hub]
                 [--dir PATH] [--area core] [--runner self-hosted|gce]
                 [--runner-label pm] [--json]

Status is read-only. --check exits 1 when local preflight fails.
Init creates missing files, preserves valid existing settings, and starts PMs disabled.
Works from any directory after the global install. Use --home PATH to select a configuration.
--project is a lowercase local ID; --repo is the app. The automation repository is reused
from hub.json or detected from Git origin. --hub-repo is an optional explicit selection.
No secret values are accepted, printed, or copied. Provider checks use shipgremlins doctor my-app.
Load local credentials with: shipgremlins --env-file .env setup --check
Dashboard connections are stored locally and loaded by subsequent CLI commands.
GitLab/Railway integration is planned.`;

export async function runSetup(
  root: string,
  args: string[],
  io: Io,
  deps: SetupDeps = { env: {} },
): Promise<number> {
  const { values, positionals } = parseFlags(args);
  const mode = positionals[0] ?? "status";
  if (values.help === true || args.includes("-h")) {
    io.log(USAGE);
    return 0;
  }
  try {
    const allowed = new Set([
      "check",
      "json",
      "verbose",
      "dir",
      "project",
      "repo",
      "hub-repo",
      "area",
      "runner",
      "runner-label",
    ]);
    if (Object.keys(values).some((name) => !allowed.has(name)))
      throw new Error(
        "Unknown setup option. Secret values do not belong in CLI arguments.",
      );
    if (positionals.length > 1 || !["init", "status"].includes(mode))
      throw new Error("Expected setup init or setup status.");
    for (const key of ["check", "json", "verbose"])
      if (values[key] !== undefined && values[key] !== true)
        throw new Error(`--${key} does not accept a value`);
    for (const key of [
      "dir",
      "project",
      "repo",
      "hub-repo",
      "area",
      "runner",
      "runner-label",
    ])
      if (
        values[key] !== undefined &&
        (typeof values[key] !== "string" || !values[key])
      )
        throw new Error(`--${key} requires a value`);
    const string = (key: string): string | undefined =>
      typeof values[key] === "string" ? (values[key] as string) : undefined;
    const directory = string("dir")
      ? setupDirectory(process.cwd(), string("dir")!)
      : setupDirectory(root, ".");
    if (mode === "init") {
      if (values.check)
        throw new Error(
          "init and --check are separate operations; run --check after initialization",
        );
      const project = string("project");
      const repo = string("repo");
      if (!project || !repo)
        throw new Error(
          "Run shipgremlins setup init --project my-app --repo owner/app --hub-repo owner/your-hub. --project is a lowercase local ID, not a domain.",
        );
      const runner = string("runner");
      if (runner !== undefined && runner !== "self-hosted" && runner !== "gce")
        throw new Error("--runner must be self-hosted or gce");
      let hubRepo = string("hub-repo");
      if (!hubRepo) {
        if (existsSync(join(directory, "hub.json"))) {
          const saved = loadHub(directory).hubRepo;
          const detected = isExampleHub(directory)
            ? (deps.detectHubRepo ?? detectHubRepository)(directory)
            : undefined;
          if (detected && detected !== saved)
            throw new Error(
              "The sample hub.json names a different repository than this checkout. Set hubRepo in hub.json to your fork's owner/name, then rerun setup. Existing files were preserved.",
            );
          hubRepo = saved;
        } else {
          hubRepo = (deps.detectHubRepo ?? detectHubRepository)(directory);
        }
      }
      const result = initializeSetup(directory, deps.templatesRoot ?? root, {
        project,
        repo,
        hubRepo,
        area: string("area"),
        runner,
        runnerLabel: string("runner-label"),
      });
      if (values.json) io.log(JSON.stringify(result, null, 2));
      else {
        io.log(`ShipGremlins configuration: ${result.directory}`);
        io.log(`Automation repository: ${loadHub(directory).hubRepo}`);
        io.log(
          `${result.created.length} file(s) created; ${result.preserved.length} existing path(s) preserved.`,
        );
        io.log(`Connection variable names: ${result.secretNames.join(", ")}`);
        if (resolve(directory) !== resolve(root))
          io.log(
            process.platform === "win32"
              ? `For the following commands in this PowerShell session, run: $env:SHIPGREMLINS_HOME = '${result.directory.replace(/'/g, "''")}'`
              : `For the following commands in this shell, run: export SHIPGREMLINS_HOME='${result.directory.replace(/'/g, "'\\''")}'`,
          );
        for (const [index, next] of result.next.entries())
          io.log(`${index + 1}. ${next}`);
      }
      return 0;
    }
    if (
      ["repo", "hub-repo", "area", "runner", "runner-label"].some(
        (key) => values[key] !== undefined,
      )
    )
      throw new Error(
        "Configuration options require setup init; status does not change files",
      );
    const report = inspectSetup(directory, deps, string("project"));
    if (values.json) io.log(JSON.stringify(report, null, 2));
    else
      io.log(
        preflightSummary(
          report,
          values.verbose === true,
          Boolean(process.stdout.isTTY && !process.env.NO_COLOR),
          process.stdout.columns,
        ),
      );
    return values.check && !report.ready ? 1 : 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Setup failed.";
    if (values.json) io.error(JSON.stringify({ error: message }));
    else {
      io.error(message);
      io.error("Run shipgremlins setup --help for usage.");
    }
    return 1;
  }
}
