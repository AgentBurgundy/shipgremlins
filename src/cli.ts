#!/usr/bin/env -S npx tsx
// `npx tsx src/cli.ts <command>` — the one entry point the workflows call.
// This is the only file under src/ (besides the clients' constructors) that
// reads process.env.

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { exec } from "node:child_process";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ConfigError,
  loadAllProjects,
  loadHub,
  loadProject,
  type Project,
} from "./config.ts";
import type { Ctx, DigestRow } from "./dispatcher/context.ts";
import type { PromoteOpts } from "./dispatcher/promote.ts";
import type { Git } from "./git.ts";
import type { RunReport } from "./report.ts";
import type { Clients } from "./services/index.ts";
import { runAddProject } from "./commands/addProject.ts";
import { parseFlags, runCrons, type Io } from "./commands/crons.ts";
import { runDoctor } from "./commands/doctor.ts";
import { runMetric } from "./commands/metric.ts";
import { runLogs } from "./commands/logs.ts";
import { runTicket } from "./commands/ticket.ts";
import { runSetup } from "./commands/setup.ts";
import { configurationRoot } from "./setup/location.ts";
import { welcome } from "./terminal.ts";
import { promotionVercel } from "./projectCapabilities.ts";

export const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));
export const ROOT = configurationRoot(
  process.cwd(),
  process.env.SHIPGREMLINS_HOME,
);
const DEFAULT_BOT_LOGIN = "pm-hub[bot]";

// ── neighbouring modules (dispatcher, promotion, report, clients, git) are
// imported lazily inside the commands that need them, so `crons`,
// `add-project`, `doctor` and `validate` never load the network clients ─────

// ── helpers ──────────────────────────────────────────────────────────────────

const io: Io = {
  log: (line) => console.log(line),
  error: (line) => console.error(line),
};

function makeCtx(
  project: Project,
  clients: Clients,
  opts: { dryRun: boolean },
): Ctx {
  return {
    ...clients,
    hub: loadHub(ROOT),
    project,
    now: () => new Date(),
    dryRun: opts.dryRun,
    log: (line) => console.log(`  ${line}`),
    botLogin: process.env.BOT_LOGIN || DEFAULT_BOT_LOGIN,
  };
}

function printRows(rows: DigestRow[]): void {
  if (rows.length === 0) console.log("  (nothing to do)");
  for (const r of rows)
    console.log(
      `  ${r.needsYou ? "NEEDS YOU " : ""}[${r.rule}] ${r.text}${r.ref ? ` (${r.ref})` : ""}`,
    );
}

async function promoteOptsFor(
  ctx: Ctx,
  targetDir: string,
  git: Git,
  commands: Project["config"]["commands"],
  area?: string,
): Promise<PromoteOpts | undefined> {
  const checkoutDir = resolve(ROOT, targetDir);
  if (!existsSync(join(checkoutDir, ".git"))) return undefined;
  const check = buildCheck(commands);
  const { createCandidateVerifier } = await import("./evidence/attestation.ts");
  const verifyCandidate = createCandidateVerifier(ctx, {
    file: process.env.SHIPGREMLINS_VERIFICATION_FILE,
    key: process.env.SHIPGREMLINS_ATTESTATION_PUBLIC_KEY,
  });
  return {
    git,
    checkoutDir,
    ...(area ? { area } : {}),
    check,
    verifyCandidate,
  };
}

/** Run every configured gate in order; the first failure blocks promotion. */
export function buildCheck(
  commands: Project["config"]["commands"],
): NonNullable<PromoteOpts["check"]> {
  const steps = [
    commands.install,
    commands.lint,
    commands.typecheck,
    commands.test,
    commands.build,
  ].filter((c): c is string => typeof c === "string" && c.length > 0);
  return async (cwd) => {
    // Candidate code must never inherit the controller's evidence-signing authority.
    const checkEnv = { ...process.env };
    delete checkEnv.SHIPGREMLINS_ATTESTATION_KEY;
    delete checkEnv.SHIPGREMLINS_ATTESTATION_PUBLIC_KEY;
    delete checkEnv.SHIPGREMLINS_VERIFICATION_FILE;
    for (const step of steps) {
      const r = await new Promise<{ ok: boolean; output: string }>((done) =>
        exec(
          step,
          {
            cwd,
            env: checkEnv,
            maxBuffer: 64 * 1024 * 1024,
            timeout: 15 * 60_000,
          },
          (error, stdout, stderr) =>
            done({ ok: !error, output: [stdout, stderr].join("\n") }),
        ),
      );
      if (!r.ok) {
        console.log(`  promote check: "${step}" failed`);
        console.log(r.output.split("\n").slice(-25).join("\n"));
        return r;
      }
    }
    return { ok: true, output: "" };
  };
}

// ── commands ─────────────────────────────────────────────────────────────────

async function dispatch(args: string[]): Promise<number> {
  if (loadHub(ROOT).runners.mode === "local") {
    io.error(
      "This workspace uses local Docker workers. Run gremlins start to schedule PMs and approved tickets, or queue a job in the dashboard.",
    );
    return 1;
  }
  const { values } = parseFlags(args);
  const dryRun = values["dry-run"] === true;
  const targetDir =
    typeof values.target === "string" ? values.target : "target";
  const projects =
    typeof values.project === "string"
      ? [loadProject(ROOT, values.project)]
      : loadAllProjects(ROOT);
  const [{ runDispatcher }, { withProjectClients }, { realGit }] =
    await Promise.all([
      import("./dispatcher/index.ts"),
      import("./services/projectClients.ts"),
      import("./git.ts"),
    ]);
  const out: { project: string; rows: DigestRow[] }[] = [];
  for (const project of projects) {
    console.log(
      `${project.config.name} (${project.config.repo})${dryRun ? " [dry-run]" : ""}`,
    );
    const rows = await withProjectClients(
      { root: ROOT, env: process.env },
      project.config,
      async (clients) => {
        const ctx = makeCtx(project, clients, { dryRun });
        return runDispatcher(
          ctx,
          await promoteOptsFor(
            ctx,
            targetDir,
            realGit,
            project.config.commands,
          ),
        );
      },
    );
    printRows(rows);
    out.push({ project: project.config.name, rows });
  }
  // A row marked `pending` means the dispatcher was early, not blocked: the
  // workflow reads this output and comes back in a few minutes.
  const pending = out.some((p) => p.rows.some((r) => r.pending === true));
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `pending=${pending}\n`);
  }
  mkdirSync(join(ROOT, ".run"), { recursive: true });
  writeFileSync(
    join(ROOT, ".run", "dispatch.json"),
    JSON.stringify(
      { ranAt: new Date().toISOString(), dryRun, projects: out },
      null,
      2,
    ),
  );
  return 0;
}

async function promote(args: string[]): Promise<number> {
  const { values } = parseFlags(args);
  if (typeof values.project !== "string" || typeof values.area !== "string") {
    io.error(
      "usage: gremlins promote --project <name> --area <key> [--target target]",
    );
    return 1;
  }
  const project = loadProject(ROOT, values.project);
  if (!promotionVercel(project.config)) {
    io.error(
      "This project uses local draft PR review. Automatic promotion requires a Vercel promotion target with revision-bound verification.",
    );
    return 1;
  }
  if (!project.areas.some((a) => a.key === values.area)) {
    io.error(`project ${values.project} has no area "${values.area}"`);
    return 1;
  }
  const targetDir =
    typeof values.target === "string" ? values.target : "target";
  const [{ runPromote }, { withProjectClients }, { realGit }] =
    await Promise.all([
      import("./dispatcher/promote.ts"),
      import("./services/projectClients.ts"),
      import("./git.ts"),
    ]);
  return withProjectClients(
    { root: ROOT, env: process.env },
    project.config,
    async (clients) => {
      const ctx = makeCtx(project, clients, { dryRun: false });
      const opts = await promoteOptsFor(
        ctx,
        targetDir,
        realGit,
        project.config.commands,
        String(values.area),
      );
      if (!opts) {
        io.error(
          `${targetDir}/ is not a git checkout of ${project.config.repo}`,
        );
        return 1;
      }
      printRows(await runPromote(ctx, opts));
      return 0;
    },
  );
}

async function slack(args: string[]): Promise<number> {
  const file = args[0];
  if (!file || file.startsWith("-")) {
    io.error("usage: shipgremlins slack <report.json>");
    return 1;
  }
  const report = JSON.parse(
    readFileSync(resolve(ROOT, file), "utf8"),
  ) as RunReport;
  const project = loadProject(ROOT, report.project);
  const webhookUrl = process.env[project.config.slackWebhookSecret];
  const [{ buildReport, postReport }, { SlackWebhook }] = await Promise.all([
    import("./report.ts"),
    import("./services/slack.ts"),
  ]);
  if (!webhookUrl) {
    io.error(
      `${project.config.slackWebhookSecret} is not set — the report follows so it is not lost:\n${buildReport(report).text}`,
    );
    return 1;
  }
  await postReport(new SlackWebhook(), webhookUrl, report);
  console.log(`posted the ${report.project}/${report.area} report to Slack`);
  return 0;
}

async function ticket(args: string[]): Promise<number> {
  const { LinearApi } = await import("./services/linear.ts");
  return withSelectedLinear(args, (apiKey) =>
    runTicket(new LinearApi({ apiKey }), parseFlags(args).positionals, io),
  );
}

async function withSelectedLinear<T>(
  args: string[],
  action: (authorization: string) => Promise<T>,
  positionalProject?: string,
): Promise<T> {
  const { values } = parseFlags(args);
  const name =
    positionalProject ??
    (typeof values.project === "string" ? values.project : undefined);
  const config = name ? loadProject(ROOT, name).config : undefined;
  const { withLinearCredential } = await import("./services/projectClients.ts");
  return withLinearCredential({ root: ROOT, env: process.env }, config, action);
}

async function tickets(args: string[]): Promise<number> {
  const { values } = parseFlags(args);
  if (typeof values.project !== "string") {
    io.error(
      "usage: gremlins tickets audit|reconcile --project NAME [--manifest reviewed.json] [--json] [--apply]",
    );
    return 1;
  }
  const [{ runTickets }, { withProjectClients }] = await Promise.all([
    import("./commands/tickets.ts"),
    import("./services/projectClients.ts"),
  ]);
  const project = loadProject(ROOT, values.project);
  return withProjectClients(
    { root: ROOT, env: process.env },
    project.config,
    async (clients) => {
      const ctx = makeCtx(project, clients, {
        dryRun: values.apply !== true,
      });
      return runTickets(ctx, args, io);
    },
  );
}

async function linearProjects(args: string[]): Promise<number> {
  const { LinearApi } = await import("./services/linear.ts");
  return withSelectedLinear(args, async (apiKey) => {
    const projects = await new LinearApi({ apiKey }).listProjects();
    if (projects.length === 0) {
      console.log("no projects visible to this key");
      return 0;
    }
    for (const p of projects)
      console.log(`${p.id}  ${p.name}  [${p.teams.join(", ")}]  ${p.url}`);
    return 0;
  });
}

async function linearProject(args: string[]): Promise<number> {
  const { LinearApi } = await import("./services/linear.ts");
  const { runLinearProject } = await import("./commands/linearProject.ts");
  return withSelectedLinear(
    args,
    (apiKey) => runLinearProject(ROOT, new LinearApi({ apiKey }), args, io),
    parseFlags(args).positionals[0],
  );
}

function validate(): number {
  try {
    const hub = loadHub(ROOT);
    const projects = loadAllProjects(ROOT);
    console.log(
      `ok — ${hub.runners.mode === "local" ? "local Docker workspace" : `hub ${hub.hubRepo} (${hub.runners.mode})`}, ${projects.length} project(s): ${projects.map((p) => `${p.config.name}${p.config.verified ? "" : " (unverified)"}`).join(", ") || "none"}`,
    );
    return 0;
  } catch (err) {
    if (err instanceof ConfigError) {
      io.error(err.message);
      return 1;
    }
    throw err;
  }
}

const USAGE = `usage: gremlins <command>

  gremlins setup                                       open your private setup dashboard

Global options: --home PATH selects configuration; --env-file PATH loads credentials.
Configuration: SHIPGREMLINS_HOME, nearest hub.json from this directory, or ~/.shipgremlins.
Saved dashboard connections are loaded automatically; exported variables take precedence.

  setup status [--check] [--json] [--dir PATH]              inspect local prerequisites without changing files
  setup init --project NAME --repo owner/app [--dir PATH] initialize configuration; use --help for all options
  dashboard [--lan] [--no-open] [--port PORT]              open setup here or on your private network
  start [--lan] [--port PORT] [--no-open]                  run the controller in the background
  status                                                show the background dashboard link
  stop                                                  stop scheduling; keep running Docker jobs
  worker --controller URL [--enrollment-code CODE]        connect this machine's Docker worker to your instance
  update [--check | --rollback] [--json]                   safely update the runtime; keep your gremlins
  serve [--host 127.0.0.1] [--port 4310]                    serve the local ShipGremlins site
  dispatch [--project <name>] [--dry-run] [--target target]   sync → line → heal → repair → merge → dispatch → promote
  promote --project <name> --area <key> [--target target]     cherry-pick verified merges into ONE PR to staging
  slack <report.json>                                         post a PM run's report to the project's webhook
  ticket <identifier> [--project NAME]                         print a Linear ticket using the project's account
  tickets audit|reconcile --project NAME [--manifest FILE] [--json] [--apply]  production completion audit; writes need --apply
  evidence <command>                                        inspect and attest trusted verification evidence
  fixture csv|png --output PATH                             create deterministic upload-test files; see --help
  logs --project <name> [--provider all|sentry|datadog]        read bounded project logs and Sentry errors; see --help
  metric --project <name> --area <key>                        Mixpanel saved report or 7/28-day Vercel Analytics counts
  crons [--json | --check | write]                            the pm-agent.yml schedule block
  add-project <name> --repo owner/name [--area core]          seed projects/<name>/ from the templates
  doctor <name>                                               check the checklist live; stamps "verified"
  signin-code --project <name> [--bootstrap --preview-url U]  seed a one-time sign-in code for the project's test account on the preview; prints {email, code}
  upload <file> [--alt "text"] [--project NAME]                 upload a screenshot to the selected Linear account
  linear-projects [--project NAME]                             list Linear projects in the selected account
  linear-project <project> <area> [--id <uuid|url>] [--team K] create (or --id: update) the area's Linear project from its linear-project.md; writes the id to areas.json
  validate                                                    load hub.json + every projects/*`;

export async function main(argv: string[]): Promise<number> {
  const [command, ...args] = argv;
  const dashboard =
    command === "dashboard" ||
    (command === "setup" &&
      (args.length === 0 ||
        args.includes("--no-open") ||
        args.some((arg) => arg === "--lan" || arg.startsWith("--lan=")) ||
        args.some((arg) => arg === "--port" || arg.startsWith("--port="))));
  if (
    !args.includes("--json") &&
    [
      undefined,
      "help",
      "--help",
      "-h",
      "setup",
      "dashboard",
      "update",
      "worker",
    ].includes(command)
  )
    io.log(
      welcome(
        Boolean(process.stdout.isTTY && !process.env.NO_COLOR),
        process.stdout.columns,
      ),
    );
  if (dashboard) {
    const { runDashboard } = await import("./commands/dashboard.ts");
    return runDashboard(ROOT, PACKAGE_ROOT, args, io);
  }
  if (
    command &&
    ![
      "help",
      "--help",
      "-h",
      "serve",
      "fixture",
      "validate",
      "crons",
      "add-project",
      "update",
      "worker",
    ].includes(command) &&
    !args.includes("--help") &&
    !args.includes("-h")
  ) {
    const { readConnections } = await import("./setup/connections.ts");
    for (const [name, value] of Object.entries(readConnections(ROOT)))
      if (process.env[name] === undefined) process.env[name] = value;
  }
  switch (command) {
    case "worker": {
      if (args.includes("--help") || args.includes("-h")) {
        io.log(
          "gremlins worker --controller HTTPS_ORIGIN [--enrollment-code ONE_TIME_CODE] [--worker-home DIRECTORY] [--allow-insecure-lan]\nEnroll once from Your gremlins, then omit the code when restarting. Keep this command running. Docker uses Linux containers; native iOS simulation is not supported.",
        );
        return 0;
      }
      const { runWorker } = await import("./commands/worker.ts");
      return runWorker(PACKAGE_ROOT, args, { out: io.log, err: io.error });
    }
    case "start":
    case "stop":
    case "status": {
      const { runController } = await import("./commands/controller.ts");
      return runController(ROOT, PACKAGE_ROOT, command, args, io);
    }
    case "update": {
      const { runUpdate } = await import("./commands/update.ts");
      return runUpdate(ROOT, PACKAGE_ROOT, args, io);
    }
    case "setup":
      return runSetup(ROOT, args, io, {
        templatesRoot: PACKAGE_ROOT,
        env: process.env,
      });
    case "serve": {
      const { runServe } = await import("./commands/serve.ts");
      return runServe(PACKAGE_ROOT, args, io);
    }
    case "evidence": {
      const { runEvidence } = await import("./commands/evidence.ts");
      return runEvidence(ROOT, args, io);
    }
    case "fixture": {
      const { runFixture } = await import("./commands/fixture.ts");
      return runFixture(ROOT, args, io);
    }
    case "dispatch":
      return dispatch(args);
    case "promote":
      return promote(args);
    case "slack":
      return slack(args);
    case "ticket":
      return ticket(args);
    case "tickets":
      return tickets(args);
    case "metric":
      return runMetric(ROOT, args, io);
    case "logs":
      return runLogs(ROOT, args, io);
    case "crons":
      return runCrons(ROOT, args, io);
    case "add-project":
      return runAddProject(ROOT, args, io, PACKAGE_ROOT);
    case "doctor":
      return runDoctor(ROOT, args, io);
    case "linear-projects":
      return linearProjects(args);
    case "linear-project":
      return linearProject(args);
    case "signin-code": {
      const { runSigninCode } = await import("./commands/signinCode.ts");
      const { neon } = await import("@neondatabase/serverless");
      return runSigninCode(ROOT, args, process.env, io, {
        connect: (url) => {
          const q = neon(url);
          return (text, params) =>
            q.query(text, params as unknown[]) as Promise<unknown[]>;
        },
      });
    }
    case "upload": {
      const { runUpload } = await import("./commands/upload.ts");
      return withSelectedLinear(args, (authorization) =>
        runUpload(args, { ...process.env, LINEAR_API_KEY: authorization }, io),
      );
    }
    case "validate":
      return validate();
    case undefined:
    case "help":
    case "--help":
    case "-h":
      console.log(USAGE);
      return 0;
    default:
      io.error(`unknown command "${command}"\n\n${USAGE}`);
      return 1;
  }
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err: unknown) => {
      if (err instanceof ConfigError) console.error(err.message);
      else
        console.error(
          err instanceof Error ? (err.stack ?? err.message) : String(err),
        );
      process.exitCode = 1;
    },
  );
}
