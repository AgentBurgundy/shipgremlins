import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createDockerRunners, type DockerRun } from "../localRunners/docker.ts";

export interface PlannerExecution {
  credential: string;
  prompt: string;
  system: string;
  schema: Record<string, unknown>;
  signal: AbortSignal;
}
export type PlannerExecutor = (input: PlannerExecution) => Promise<unknown>;
export type PlannerDockerRun = (
  args: string[],
  options?: Parameters<DockerRun>[1] & { signal?: AbortSignal },
) => ReturnType<DockerRun>;

/** The container receives only model auth and inert text. No source token, mount, or repository checkout. */
export const PLANNER_PROGRAM = String.raw`
const { spawn } = require('node:child_process');
const { mkdirSync } = require('node:fs');
let text = '';
process.stdin.on('data', data => { text += data; if (Buffer.byteLength(text) > 524288) process.exit(2); });
process.stdin.on('end', () => {
  let input;
  try { input = JSON.parse(text); } catch { process.exit(2); }
  text = '';
  if (typeof input.credential !== 'string' || !input.credential || typeof input.prompt !== 'string' || typeof input.system !== 'string' || !input.schema) process.exit(2);
  mkdirSync('/work/home', { recursive: true, mode: 0o700 });
  const env = { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/work/home', TMPDIR: '/tmp',
    CLAUDE_CODE_OAUTH_TOKEN: input.credential, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_AUTOUPDATER: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1' };
  const args = ['--print', '--model', 'sonnet', '--tools', '', '--disable-slash-commands',
    '--safe-mode', '--restricted', '--setting-sources', '', '--strict-mcp-config',
    '--mcp-config', '{"mcpServers":{}}', '--no-chrome', '--permission-mode', 'dontAsk',
    '--permission-prompts', 'none', '--no-session-persistence', '--max-turns', '1',
    '--output-format', 'json', '--json-schema', JSON.stringify(input.schema), '--system-prompt', input.system];
  const child = spawn('/usr/local/bin/claude', args, { cwd: '/work', env, shell: false, stdio: ['pipe','pipe','ignore'] });
  let output = '', size = 0;
  const timer = setTimeout(() => { child.kill('SIGKILL'); process.exit(124); }, 120000);
  child.stdout.on('data', data => { size += data.length; if (size > 262144) { child.kill('SIGKILL'); process.exit(2); } output += data; });
  child.on('error', () => { clearTimeout(timer); process.exit(2); });
  child.on('close', code => {
    clearTimeout(timer);
    try {
      if (code !== 0) throw new Error();
      const result = JSON.parse(output);
      if (result.is_error || result.subtype !== 'success') throw new Error();
      const draft = result.structured_output ?? JSON.parse(result.result);
      const encoded = JSON.stringify(draft);
      if (encoded.includes(input.credential) || Buffer.byteLength(encoded) > 65536) throw new Error();
      process.stdout.write(encoded);
    } catch { process.exitCode = 2; }
  });
  child.stdin.on('error', () => {});
  child.stdin.end(input.prompt);
});`;

export const runPlannerDocker: PlannerDockerRun = (args, options = {}) =>
  new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new Error("Planner canceled."));
      return;
    }
    const child = spawn("docker", args, {
      shell: false,
      windowsHide: true,
      stdio: [options.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    let stdout = "",
      stderr = "",
      size = 0,
      failed = false;
    const stop = () => {
      failed = true;
      child.kill();
    };
    const timer = setTimeout(stop, options.timeoutMs ?? 30_000);
    options.signal?.addEventListener("abort", stop, { once: true });
    const clean = () => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", stop);
    };
    const capture = (chunk: Buffer, error: boolean) => {
      size += chunk.length;
      if (size > (options.maxBytes ?? 262144)) {
        stop();
        return;
      }
      if (error) stderr += chunk.toString("utf8");
      else stdout += chunk.toString("utf8");
    };
    child.stdout?.on("data", (chunk: Buffer) => capture(chunk, false));
    child.stderr?.on("data", (chunk: Buffer) => capture(chunk, true));
    child.once("error", () => {
      clean();
      reject(new Error("Docker could not start."));
    });
    child.once("close", (code) => {
      clean();
      if (failed)
        reject(
          new Error(
            "Planner canceled, timed out, or exceeded its output limit.",
          ),
        );
      else resolve({ code: code ?? 1, stdout, stderr });
    });
    child.stdin?.on("error", () => {});
    if (options.stdin !== undefined) child.stdin?.end(options.stdin);
  });

export function createDockerPlanner(options: {
  packageRoot: string;
  run?: PlannerDockerRun;
  ensureImage?: () => Promise<string>;
}): PlannerExecutor {
  const run = options.run ?? runPlannerDocker;
  return async (input) => {
    const payload = JSON.stringify({
      credential: input.credential,
      prompt: input.prompt,
      system: input.system,
      schema: input.schema,
    });
    if (Buffer.byteLength(payload) > 512 * 1024)
      throw new Error("Planner context exceeds its bounded input limit.");
    const id = randomUUID();
    const name = `gremlins-plan-${id}`;
    const image = await (options.ensureImage?.() ??
      createDockerRunners({
        packageRoot: options.packageRoot,
        run: (args, opts) =>
          run(args, {
            ...opts,
            maxBytes: 4 * 1024 * 1024,
            timeoutMs: Math.min(opts?.timeoutMs ?? 30000, 180000),
            signal: input.signal,
          }),
      }).ensureImage());
    if (
      !/^shipgremlins-local:[a-f0-9]{16}$/.test(image) ||
      input.signal.aborted
    )
      throw new Error("Planner runtime is unavailable.");
    try {
      const created = await run(
        [
          "create",
          "--name",
          name,
          "--label",
          `io.shipgremlins.planner=${id}`,
          "--interactive",
          "--restart",
          "no",
          "--read-only",
          "--user",
          "1000:1000",
          "--cpus",
          "1",
          "--memory",
          "1g",
          "--pids-limit",
          "128",
          "--cap-drop",
          "ALL",
          "--security-opt",
          "no-new-privileges",
          "--tmpfs",
          "/work:rw,nosuid,nodev,uid=1000,gid=1000,mode=0700,size=67108864",
          "--tmpfs",
          "/tmp:rw,nosuid,nodev,mode=1777,size=67108864",
          "--entrypoint",
          "node",
          image,
          "-e",
          PLANNER_PROGRAM,
        ],
        { signal: input.signal },
      );
      if (created.code !== 0)
        throw new Error("Planner container could not start.");
      const result = await run(["start", "--attach", "--interactive", name], {
        stdin: payload,
        timeoutMs: 125000,
        signal: input.signal,
        maxBytes: 65536,
      });
      if (result.code !== 0)
        throw new Error("Claude could not produce a draft.");
      return JSON.parse(result.stdout);
    } finally {
      // Cancellation may occur after the daemon creates a container but before the CLI returns.
      // Check our unique label before removing it; never touch another process's containers.
      const inspected = await run(
        [
          "inspect",
          "--format",
          '{{index .Config.Labels "io.shipgremlins.planner"}}',
          name,
        ],
        { timeoutMs: 5000, maxBytes: 1024 },
      ).catch(() => null);
      if (inspected?.code === 0 && inspected.stdout.trim() === id)
        await run(["rm", "--force", name], {
          timeoutMs: 5000,
          maxBytes: 1024,
        }).catch(() => undefined);
    }
  };
}
