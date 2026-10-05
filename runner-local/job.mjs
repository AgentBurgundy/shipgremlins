import { spawn } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  lstatSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { browserSmoke } from "./runner-smoke.mjs";
import { startLeaseWatchdog } from "./lease.mjs";
import { chromium } from "playwright";
import { createActivityWriter } from "./activity.mjs";
import {
  discoveryArguments,
  discoveryResult,
  sanitizeKnowledge,
} from "./discovery.mjs";
import { runCheckedDelivery, validateDelivery } from "./delivery.mjs";
import { validateReviewPlan } from "./review-receipts.mjs";
import {
  enforceDeadline,
  jobEnvironments,
  preparePublication,
} from "./runtime.mjs";

let current;
let stopping = false;
const stop = () => {
  stopping = true;
  if (current?.pid) {
    try {
      process.kill(-current.pid, "SIGTERM");
    } catch {
      current.kill("SIGTERM");
    }
  }
};
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
let timedOut = false;
let clearLease = () => {};
let clearDeadline = enforceDeadline(() => {
  timedOut = true;
  stop();
});
const allowedCredentials = new Set([
  "GITHUB_TOKEN",
  "GITLAB_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "LINEAR_API_KEY",
  "GREMLINS_PREVIEW_BYPASS",
  "GREMLINS_PREVIEW_DATABASE_URL",
]);
let secrets = [];
let logSize = 0;
function redact(value) {
  let output = String(value);
  for (const secret of secrets)
    if (secret) output = output.split(secret).join("[REDACTED]");
  return output.replace(
    /(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|glpat-[A-Za-z0-9_-]+|glrt-[A-Za-z0-9_-]+|sk-ant-[A-Za-z0-9_-]+)/g,
    "[REDACTED]",
  );
}
function log(value) {
  const line = redact(value).replace(
    /[\u001b\u009b][[\]()#;?]*(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]+)*)?\u0007|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g,
    "",
  );
  if (logSize > 5 * 1024 * 1024) return;
  logSize += Buffer.byteLength(line);
  appendFileSync("/output/job.log", line + "\n");
  console.log(line);
}
const activity = createActivityWriter({
  redact,
  write: (line) => {
    appendFileSync(
      "/output/activity.jsonl",
      line.slice("GREMLINS_ACTIVITY ".length) + "\n",
    );
    log(line);
  },
});
async function run(command, args, options = {}) {
  if (stopping) throw new Error("Job stopped.");
  if (!options.model)
    activity.emit(
      "progress",
      `Running ${command}`,
      command === "/bin/bash" ? args.at(-1) : args.join(" "),
      "running",
    );
  else
    activity.emit(
      "progress",
      "Agent started",
      "The agent is working. Public tool calls and updates appear as they are received.",
      "running",
    );
  return new Promise((done, reject) => {
    current = spawn(command, args, {
      cwd: options.cwd ?? "/work",
      env: options.env ?? process.env,
      stdio: [
        typeof options.input === "string" ? "pipe" : "ignore",
        "pipe",
        "pipe",
      ],
      detached: true,
    });
    let modelError = false;
    let captured = "";
    current.stdout.on("data", (chunk) => {
      captured = (captured + chunk.toString("utf8")).slice(-1024 * 1024);
    });
    const streams = [current.stdout, current.stderr];
    for (const stream of streams) {
      let pending = "";
      let dropping = false;
      stream.on("data", (chunk) => {
        pending += chunk.toString("utf8");
        let end;
        while ((end = pending.indexOf("\n")) >= 0) {
          const line = pending.slice(0, end);
          pending = pending.slice(end + 1);
          if (!dropping) {
            try {
              const parsed = JSON.parse(line);
              if (parsed.type === "result" && parsed.is_error === true)
                modelError = true;
              if (options.model) {
                activity.modelRecord(parsed);
                continue;
              }
            } catch {}
            // Streaming model envelopes can contain private thinking. Only the
            // explicitly allowlisted public records above become logs/history.
            if (!options.model) log(line);
          }
          dropping = false;
        }
        if (pending.length > 128 * 1024) {
          pending = "";
          dropping = true;
          log("[Oversized subprocess output omitted]");
        }
      });
      stream.on("end", () => {
        if (pending && !dropping && !options.model) log(pending);
      });
    }
    current.once("error", () =>
      reject(new Error("A required job tool could not start.")),
    );
    if (typeof options.input === "string") {
      current.stdin.on("error", () =>
        reject(
          new Error("The agent could not receive its bounded task context."),
        ),
      );
      current.stdin.end(options.input);
    }
    current.once("close", (code) => {
      current = undefined;
      if (code === 0 && !modelError && !stopping) done(captured);
      else
        reject(
          new Error("A job command failed. Inspect the redacted job log."),
        );
    });
  });
}
let kind = "unknown";
try {
  mkdirSync("/output", { recursive: true });
  const deadline = Date.now() + 60_000;
  while (!existsSync("/work/job.ready") && !stopping) {
    if (Date.now() > deadline)
      throw new Error("The job payload did not arrive. Queue a new attempt.");
    await new Promise((done) => setTimeout(done, 200));
  }
  if (stopping) process.exit(0);
  const input = JSON.parse(readFileSync("/work/job.json", "utf8"));
  if (input.remoteLease !== undefined && typeof input.remoteLease !== "boolean")
    throw new Error("Invalid remote lease.");
  if (input.remoteLease)
    clearLease = startLeaseWatchdog({
      stop: () => {
        timedOut = true;
        stop();
      },
    });
  unlinkSync("/work/job.json");
  if (!input || !["verify", "pm", "developer"].includes(input.kind))
    throw new Error("Unsupported job kind.");
  kind = input.kind;
  if (
    input.maxRuntimeMinutes !== undefined ||
    input.remainingRuntimeMs !== undefined
  ) {
    const minutes = input.maxRuntimeMinutes ?? 45;
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > 45)
      throw new Error("Invalid job runtime limit.");
    clearDeadline();
    clearDeadline = enforceDeadline(
      () => {
        timedOut = true;
        stop();
      },
      undefined,
      minutes,
      input.remainingRuntimeMs,
    );
  }
  const discovery = input.pmMode === "discovery";
  if (
    input.pmMode !== undefined &&
    (!["discovery", "exploration"].includes(input.pmMode) || kind !== "pm")
  )
    throw new Error("Invalid PM mode.");
  if (input.pmMode === "exploration" && input.delivery)
    throw new Error("Product exploration cannot publish code changes.");
  if (
    input.browserVerification !== undefined &&
    typeof input.browserVerification !== "boolean"
  )
    throw new Error("Invalid browser verification mode.");
  activity.emit("progress", "Job started", `Starting ${kind} work.`, "running");
  if (kind === "developer") validateDelivery(input.delivery);
  if (input.reviewPlan !== undefined) {
    if (kind !== "pm" || input.pmMode || input.browserVerification !== true)
      throw new Error("Delivery review requires a normal browser PM patrol.");
    validateReviewPlan(input.reviewPlan);
    if (input.reviewPlan.jobId !== input.nonce)
      throw new Error("Delivery review belongs to another job.");
  }
  if (kind === "verify") {
    await browserSmoke("/output", input.nonce);
    activity.emit(
      "check",
      "Browser verification",
      "Chromium rendered the page and saved a real PNG screenshot.",
      "succeeded",
    );
    activity.emit(
      "result",
      "Worker verified",
      "The local browser worker is ready.",
      "succeeded",
    );
    log("Real Chromium screenshot created and verified.");
  } else {
    if (
      typeof input.prompt !== "string" ||
      !input.prompt.trim() ||
      Buffer.byteLength(input.prompt, "utf8") > 512 * 1024
    )
      throw new Error("An agent prompt is required.");
    const repo = new URL(input.repoUrl);
    if (
      repo.protocol !== "https:" ||
      repo.username ||
      repo.password ||
      repo.search ||
      repo.hash
    )
      throw new Error("Use a credential-free HTTPS repository URL.");
    if (
      typeof input.branch !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(input.branch) ||
      input.branch.includes("..")
    )
      throw new Error("A valid project branch is required.");
    const credentials = input.credentials ?? {};
    if (
      discovery &&
      (input.browserVerification !== false ||
        input.delivery ||
        Object.values(input.commands ?? {}).some(Boolean) ||
        Object.keys(credentials).some(
          (key) =>
            ![
              "GITHUB_TOKEN",
              "GITLAB_TOKEN",
              "CLAUDE_CODE_OAUTH_TOKEN",
            ].includes(key),
        ))
    )
      throw new Error(
        "Discovery cannot use integration credentials, project commands, or publication.",
      );
    if (
      !credentials ||
      typeof credentials !== "object" ||
      Array.isArray(credentials)
    )
      throw new Error("Invalid job credentials.");
    for (const [key, value] of Object.entries(credentials)) {
      if (
        (!allowedCredentials.has(key) &&
          !/^GREMLINS_TEST_(USERNAME|PASSWORD)_[1-8]$/.test(key)) ||
        typeof value !== "string" ||
        value.length > 16384 ||
        /[\r\n\0]/.test(value)
      )
        throw new Error("Unsupported job credential.");
    }
    secrets = Object.values(credentials)
      .filter(Boolean)
      .flatMap((value) => [
        value,
        JSON.stringify(value).slice(1, -1),
        encodeURIComponent(value),
      ])
      .sort((a, b) => b.length - a.length);
    const { execution: env, publication } = jobEnvironments(
      credentials,
      input.provider,
    );
    publication.GH_HOST = repo.hostname;
    publication.GITLAB_HOST = repo.hostname;
    await run(
      "git",
      [
        "clone",
        "--depth",
        "50",
        "--single-branch",
        "--branch",
        input.branch,
        "--",
        repo.href,
        "/work/repo",
      ],
      { env: publication },
    );
    if (input.expectedCommitSha !== undefined) {
      if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(input.expectedCommitSha))
        throw new Error("Invalid pinned source revision.");
      await run(
        "git",
        ["fetch", "--depth", "1", "origin", input.expectedCommitSha],
        { cwd: "/work/repo", env: publication },
      );
      await run("git", ["checkout", "--detach", input.expectedCommitSha], {
        cwd: "/work/repo",
        env,
      });
    }
    const baseSha = (
      await run("git", ["rev-parse", "HEAD"], { cwd: "/work/repo", env })
    ).trim();
    if (input.expectedCommitSha && baseSha !== input.expectedCommitSha)
      throw new Error(
        "The worker checkout does not match the admitted environment revision.",
      );
    if (input.reviewPlan && baseSha !== input.reviewPlan.deployment.sha)
      throw new Error(
        "Integration moved before checkout. Queue a patrol after its deployment settles.",
      );
    if (kind === "developer")
      await run("git", ["checkout", "-b", input.delivery.branch], {
        cwd: "/work/repo",
        env,
      });
    mkdirSync("/work/memory", { recursive: true });
    for (const [name, content] of Object.entries(input.memory ?? {})) {
      if (
        !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,100}$/.test(name) ||
        typeof content !== "string" ||
        content.length > 200000
      )
        throw new Error("Invalid memory snapshot.");
      writeFileSync(join("/work/memory", name), content, { mode: 0o600 });
    }
    const commands = input.commands ?? {};
    for (const [key, value] of Object.entries(commands))
      if (
        !["install", "test", "lint", "typecheck", "build"].includes(key) ||
        (value !== null && typeof value !== "string") ||
        (typeof value === "string" && value.length > 10000)
      )
        throw new Error("Invalid project command.");
    if (commands.install)
      await run("/bin/bash", ["-o", "pipefail", "-lc", commands.install], {
        cwd: "/work/repo",
        env,
      });
    writeFileSync(
      "/work/mcp.json",
      JSON.stringify({
        mcpServers: discovery
          ? {}
          : {
              playwright: {
                command: "node",
                args: [
                  "/opt/gremlins/node_modules/@playwright/mcp/cli.js",
                  "--headless",
                  "--executable-path",
                  chromium.executablePath(),
                  "--no-sandbox",
                  "--output-dir",
                  "/output/screenshots",
                ],
              },
            },
      }),
      { mode: 0o600 },
    );
    writeFileSync("/work/prompt.md", input.prompt, { mode: 0o600 });
    const modelOutput = await run(
      "claude",
      [
        ...(discovery
          ? discoveryArguments()
          : ["--dangerously-skip-permissions"]),
        "--output-format",
        "stream-json",
        "--verbose",
        "--max-turns",
        "60",
        "--strict-mcp-config",
        "--mcp-config",
        "/work/mcp.json",
        "-p",
      ],
      {
        cwd: "/work/repo",
        env,
        model: true,
        input:
          input.prompt +
          `\n\nTrusted checkout metadata: repository ${repo.href}, branch ${input.branch}, commit SHA ${baseSha}, run UTC time ${new Date().toISOString()}.` +
          (discovery
            ? "\n\nReturn the requested structured JSON documents. You have only read/search tools; the worker writes the four output files. No installs, scripts, browser tools, tickets, remote writes, or repository changes."
            : input.browserVerification === false
              ? "\n\nThis job uses repository verification. Capture reproducible test output and file references; screenshots are optional. Browser tools are available if local app testing is useful, but never claim a browser check you did not perform."
              : "\n\nUse the Playwright MCP browser for visual verification. Save screenshots under /output/screenshots.") +
          (kind === "pm"
            ? " Owner direction and bounded learned context are included above."
            : " Your memory snapshot is in /work/memory.") +
          " Never print credentials.",
      },
    );
    if (discovery) {
      const result = discoveryResult(modelOutput);
      for (const [name, content] of Object.entries(result.documents))
        writeFileSync(join("/output", name), redact(content), { mode: 0o600 });
      activity.emit(
        "summary",
        "Discovery summary",
        result.summary,
        "succeeded",
      );
    }
    if (kind === "pm") sanitizeKnowledge("/output", redact);
    let publicationDirectory = "/work";
    const deliveryResult =
      kind === "developer"
        ? await runCheckedDelivery({
            commands,
            delivery: input.delivery,
            baseSha,
            repoUrl: repo.href,
            provider: input.provider,
            run: (command, args) =>
              run(command, args, { cwd: "/work/repo", env }),
            publish: (command, args) =>
              run(command, args, {
                cwd: command === "git" ? "/work/repo" : publicationDirectory,
                env: publication,
              }),
            writeBody: (body) =>
              writeFileSync("/work/pr-body.md", body, { mode: 0o600 }),
            prepareRepository: () => {
              publicationDirectory = preparePublication(
                "/work/repo",
                repo.href,
                publication,
              );
            },
            onCheck: (name, status) =>
              activity.emit("check", name, undefined, status),
          })
        : { checks: [] };
    writeFileSync(
      "/output/result.json",
      JSON.stringify(
        {
          ok: true,
          kind,
          nonce: input.nonce,
          commitSha: baseSha,
          branch: input.branch,
          ...(input.pmMode ? { pmMode: input.pmMode } : {}),
          ...deliveryResult,
          ...(activity.summary() ? { summary: activity.summary() } : {}),
          completedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
    );
    log("Job completed.");
    activity.emit(
      "result",
      "Job completed",
      deliveryResult.prUrl ??
        (deliveryResult.noChanges
          ? "Checks passed; no code changes were needed."
          : "Worker finished. Review the run summary and evidence for verification results."),
      "succeeded",
    );
  }
} catch (error) {
  const message = redact(
    timedOut
      ? "Job exceeded its configured runtime limit."
      : error instanceof Error
        ? error.message
        : "Job failed.",
  );
  writeFileSync(
    "/output/result.json",
    JSON.stringify(
      {
        ok: false,
        kind,
        error: message,
        completedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
  log(message);
  activity.emit("result", "Job failed", message, "failed");
  process.exitCode = timedOut ? 124 : stopping ? 130 : 1;
} finally {
  clearLease();
  clearDeadline();
  // Text artifacts can contain echoed environment values even when tool logs do not.
  function clean(directory, depth = 0) {
    if (depth > 3) return;
    for (const item of readdirSync(directory, { withFileTypes: true })) {
      const file = join(directory, item.name);
      if (item.isSymbolicLink()) continue;
      if (item.isDirectory()) clean(file, depth + 1);
      else if (
        item.isFile() &&
        /\.(json|jsonl|md|txt|log|csv|html|ya?ml|[cm]?js|ts)$/i.test(
          item.name,
        ) &&
        lstatSync(file).size <= 10 * 1024 * 1024
      )
        writeFileSync(file, redact(readFileSync(file, "utf8")));
    }
  }
  try {
    clean("/output");
    writeFileSync("/output/.sanitized", "complete\n", { mode: 0o600 });
  } catch {
    process.exitCode = 1;
  }
}
