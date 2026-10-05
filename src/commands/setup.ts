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
import { createSourceControl } from "../sourceControl/index.ts";
import { createLinearConnection } from "../linearConnection/index.ts";
import { createVercelConnection } from "../vercelConnection/index.ts";
import { listConnectionIds } from "../oauthConnection/profiles.ts";

export interface SetupDeps extends PreflightDeps {
  projectSettings?: Record<string, unknown>;
  templatesRoot?: string;
  detectHubRepo?: (directory: string) => string | undefined;
}

const USAGE = `ShipGremlins setup

  gremlins setup                                      open the local setup dashboard
  gremlins setup --lan                                open it to other devices on your private network
  gremlins setup status [--check] [--json] [--verbose] [--dir PATH] [--project my-app]
  gremlins setup init --project my-app --repo owner/app [--provider github|gitlab]
                 [--server-url https://gitlab.example.com]
                 [--dir PATH] [--area core] [--base-branch main] [--runner local|self-hosted|gce]
                 [--runner-label pm] [--json]

Status is read-only. --check exits 1 when local preflight fails.
Init creates missing files, preserves valid existing settings, and starts PMs disabled.
Works from any directory after the global install. Use --home PATH to select a configuration.
--project is a lowercase local ID; --repo is the app. Local Docker workers are the default.
No fork or automation repository is required. --hub-repo is only for optional CI runners.
No secret values are accepted, printed, or copied. Provider checks use gremlins doctor my-app.
Load local credentials with: gremlins --env-file .env setup --check
Dashboard connections are stored locally and loaded by subsequent CLI commands.
GitHub and GitLab repositories can run locally. Repository review needs no hosting credentials.
Choose optional browser environments and promotion workflows in the dashboard.`;

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
      "provider",
      "server-url",
      "base-branch",
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
      "provider",
      "server-url",
      "base-branch",
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
          "Run gremlins setup init --project my-app --repo owner/app. --project is a lowercase local ID, not a domain.",
        );
      const runner = string("runner");
      if (
        runner !== undefined &&
        runner !== "local" &&
        runner !== "self-hosted" &&
        runner !== "gce"
      )
        throw new Error("--runner must be local, self-hosted or gce");
      const provider = string("provider");
      if (
        provider !== undefined &&
        provider !== "github" &&
        provider !== "gitlab"
      )
        throw new Error("--provider must be github or gitlab");
      let hubRepo = string("hub-repo");
      if (!hubRepo) {
        if (existsSync(join(directory, "hub.json"))) {
          const configured = loadHub(directory);
          const saved = configured.hubRepo;
          const detected =
            configured.runners.mode !== "local" && isExampleHub(directory)
              ? (deps.detectHubRepo ?? detectHubRepository)(directory)
              : undefined;
          if (detected && detected !== saved)
            throw new Error(
              "The sample hub.json names a different repository than this checkout. Set hubRepo in hub.json to your fork's owner/name, then rerun setup. Existing files were preserved.",
            );
          hubRepo = saved;
        } else if (runner && runner !== "local") {
          hubRepo = (deps.detectHubRepo ?? detectHubRepository)(directory);
        }
      }
      const result = initializeSetup(directory, deps.templatesRoot ?? root, {
        project,
        repo,
        provider,
        serverUrl: string("server-url"),
        hubRepo,
        area: string("area"),
        runner,
        runnerLabel: string("runner-label"),
        settings: string("base-branch")
          ? {
              ...deps.projectSettings,
              workflow: {
                kind: "pull-request",
                baseBranch: string("base-branch"),
              },
            }
          : deps.projectSettings,
      });
      if (values.json) io.log(JSON.stringify(result, null, 2));
      else {
        io.log(`ShipGremlins configuration: ${result.directory}`);
        io.log(
          loadHub(directory).runners.mode === "local"
            ? "Workers: local Docker (no automation repository required)"
            : `Automation repository: ${loadHub(directory).hubRepo}`,
        );
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
      [
        "repo",
        "hub-repo",
        "area",
        "runner",
        "runner-label",
        "provider",
        "server-url",
        "base-branch",
      ].some((key) => values[key] !== undefined)
    )
      throw new Error(
        "Configuration options require setup init; status does not change files",
      );
    const sourceConnections =
      deps.sourceConnections ??
      (await createSourceControl({ root: directory, env: deps.env }).status());
    const oauthConnections =
      deps.oauthConnections ??
      (
        await Promise.all(
          (["linear", "vercel"] as const).map(async (provider) => {
            const ids = await listConnectionIds(directory, provider);
            return Promise.all(
              ids.map(async (id) => ({
                ...(await (
                  provider === "linear"
                    ? createLinearConnection
                    : createVercelConnection
                )({ root: directory, env: deps.env, connectionId: id }).status({
                  checkAvailability: false,
                })),
                connectionId: id,
              })),
            );
          }),
        )
      ).flat();
    const report = inspectSetup(
      directory,
      { ...deps, sourceConnections, oauthConnections },
      string("project"),
    );
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
      io.error("Run gremlins setup --help for usage.");
    }
    return 1;
  }
}
