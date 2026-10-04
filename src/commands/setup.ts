import { resolve } from "node:path";
import { initializeSetup, setupDirectory } from "../setup/files.ts";
import { inspectSetup, type PreflightDeps } from "../setup/preflight.ts";
import { parseFlags, type Io } from "./crons.ts";

export interface SetupDeps extends PreflightDeps {
  templatesRoot?: string;
}

const USAGE = `ShipGremlins setup

  npm run hub -- setup [--check] [--json] [--dir PATH] [--project my-app]
  npm run hub -- setup init --project my-app --repo owner/app [--hub-repo owner/hub]
                 [--dir PATH] [--area core] [--runner self-hosted|gce]
                 [--runner-label pm] [--json]

Status is read-only. --check exits 1 when local preflight fails.
Init creates missing files, preserves valid existing settings, and starts PMs disabled.
Run from your clone; no global hub command or npm link is required.
--project is a lowercase local ID (my-app), --repo is the app, and --hub-repo runs workflows.
No secret values are accepted, printed, or copied. Provider checks use npm run hub -- doctor my-app.
Local .env files require: node --env-file=.env bin/shipgremlins.mjs setup --check
GitLab/Railway integration and dashboard connection management are planned.`;

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
    for (const key of ["check", "json"])
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
    const directory = setupDirectory(root, string("dir") ?? ".");
    if (mode === "init") {
      if (values.check)
        throw new Error(
          "init and --check are separate operations; run --check after initialization",
        );
      const project = string("project");
      const repo = string("repo");
      if (!project || !repo)
        throw new Error(
          "Run npm run hub -- setup init --project my-app --repo owner/app --hub-repo owner/your-hub. --project is a lowercase local ID, not a domain.",
        );
      const runner = string("runner");
      if (runner !== undefined && runner !== "self-hosted" && runner !== "gce")
        throw new Error("--runner must be self-hosted or gce");
      const result = initializeSetup(directory, deps.templatesRoot ?? root, {
        project,
        repo,
        hubRepo: string("hub-repo"),
        area: string("area"),
        runner,
        runnerLabel: string("runner-label"),
      });
      if (values.json) io.log(JSON.stringify(result, null, 2));
      else {
        io.log(`ShipGremlins configuration: ${result.directory}`);
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
    else {
      io.log(
        `ShipGremlins local preflight: ${report.ready ? "ready for live checks" : "needs setup"}`,
      );
      for (const check of report.checks)
        io.log(
          `${check.status.toUpperCase().padEnd(4)} ${check.id}: ${check.detail}`,
        );
      io.log(
        "GitHub/Actions/Vercel integration is implemented. GitLab/Railway and dashboard connection management are planned.",
      );
      io.log(
        `This checks local prerequisites only. Run npm run hub -- doctor ${string("project") ?? "my-app"} for live provider validation after loading credentials.`,
      );
    }
    return values.check && !report.ready ? 1 : 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Setup failed.";
    if (values.json) io.error(JSON.stringify({ error: message }));
    else {
      io.error(message);
      io.error("Run npm run hub -- setup --help from your clone for usage.");
    }
    return 1;
  }
}
