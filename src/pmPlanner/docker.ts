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

const FAILURE_MESSAGES = {
  authentication:
    "Claude Code rejected its saved credential. Refresh the Claude Code token in Connections and retry analysis.",
  rate_limit:
    "Claude Code reached an account or rate limit. Wait for the limit to reset, then retry analysis.",
  context_limit:
    "Claude rejected the source context because it exceeds the model's input limit. No configuration changed; a smaller source review is needed.",
  input_limit:
    "The analysis context exceeds the planner's bounded input limit. No configuration changed; reduce the source context before retrying.",
  output_limit:
    "Claude's response exceeded the bounded analysis output limit. Retry for a more compact report; no configuration changed.",
  turn_limit:
    "Claude reached the bounded analysis turn limit before completing its structured report. Retry analysis; no configuration changed.",
  structured_output:
    "Claude did not return a complete structured analysis report. Retry analysis; no configuration changed.",
  provider_unavailable:
    "Claude's model service could not complete the request. Check service availability and the worker's network connection, then retry.",
  runtime_unavailable:
    "The isolated analysis runtime could not start. Check Docker availability and the local worker image, then retry.",
  runtime_incompatible:
    "The bundled Claude runtime rejected the analysis options. Update ShipGremlins and rebuild the worker image before retrying.",
  runtime_memory:
    "Docker stopped the analysis container after it exhausted its memory limit. Free resources or use a smaller source review before retrying.",
  timeout:
    "Claude analysis exceeded its time limit. Retry when the model service is responsive; no configuration changed.",
  canceled:
    "Analysis was canceled. Existing output and project configuration were preserved.",
  unsafe_output:
    "The analysis response contained sensitive material and was discarded. No configuration changed; retry analysis.",
  model_error:
    "Claude exited before producing an analysis report. Its diagnostic category was unavailable. Retry analysis; source access and project configuration were not changed.",
} as const;
export type PlannerFailureCode = keyof typeof FAILURE_MESSAGES;
export class PlannerExecutionError extends Error {
  constructor(public readonly code: PlannerFailureCode) {
    super(FAILURE_MESSAGES[code]);
    this.name = "PlannerExecutionError";
  }
}
function failureCode(value: unknown): PlannerFailureCode | undefined {
  return typeof value === "string" && Object.hasOwn(FAILURE_MESSAGES, value)
    ? (value as PlannerFailureCode)
    : undefined;
}

/** The container receives only model auth and inert text. No source token, mount, or repository checkout. */
export const PLANNER_PROGRAM = String.raw`
const { spawn } = require('node:child_process');
const { mkdirSync } = require('node:fs');
let finished = false;
const fail = code => { if (finished) return; finished = true; process.stdout.write(JSON.stringify({plannerError:code})); process.exitCode = 2; };
const category = (result, diagnostic) => {
  if (result?.subtype === 'error_max_turns') return 'turn_limit';
  if (result?.subtype === 'error_max_structured_output_retries') return 'structured_output';
  const text = [diagnostic, ...(Array.isArray(result?.errors) ? result.errors.filter(x => typeof x === 'string') : []), typeof result?.result === 'string' ? result.result : ''].join('\n').slice(0, 32768);
  if (/context.{0,30}(?:limit|window|length)|prompt is too long|too many tokens|request.{0,20}too large|maximum.{0,20}tokens|\b413\b/i.test(text)) return 'context_limit';
  if (/rate.?limit|too many requests|usage limit|quota|\b429\b/i.test(text)) return 'rate_limit';
  if (/authentication|unauthorized|invalid.{0,20}(?:token|api.?key)|token.{0,20}(?:expired|invalid)|not logged in|please.{0,10}log.?in|\b401\b|\b403\b/i.test(text)) return 'authentication';
  if (/unknown option|unrecognized option|invalid option/i.test(text)) return 'runtime_incompatible';
  if (/overloaded|service unavailable|model.{0,30}(?:not found|unavailable)|connection error|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|fetch failed|\b50[0234]\b/i.test(text)) return 'provider_unavailable';
  if (/structured.output|json.schema|invalid json/i.test(text)) return 'structured_output';
  return 'model_error';
};
let text = '';
process.stdin.on('data', data => { text += data; if (Buffer.byteLength(text) > 2097152) { fail('input_limit'); process.stdin.destroy(); } });
process.stdin.on('end', () => {
  if (finished) return;
  let input;
  try { input = JSON.parse(text); } catch { fail('input_limit'); return; }
  text = '';
  if (typeof input.credential !== 'string' || !input.credential || typeof input.prompt !== 'string' || typeof input.system !== 'string' || !input.schema) { fail('input_limit'); return; }
  mkdirSync('/work/home', { recursive: true, mode: 0o700 });
  const env = { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: '/work/home', TMPDIR: '/tmp',
    CLAUDE_CODE_OAUTH_TOKEN: input.credential, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_AUTOUPDATER: '1', DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1' };
  const args = ['--print', '--model', 'sonnet', '--tools', '', '--disable-slash-commands',
    '--safe-mode', '--restricted', '--setting-sources', '', '--strict-mcp-config',
    '--mcp-config', '{"mcpServers":{}}', '--no-chrome', '--permission-mode', 'dontAsk',
    '--permission-prompts', 'none', '--no-session-persistence', '--max-turns', '3',
    '--output-format', 'json', '--json-schema', JSON.stringify(input.schema), '--system-prompt', input.system];
  const child = spawn('/usr/local/bin/claude', args, { cwd: '/work', env, shell: false, stdio: ['pipe','pipe','pipe'] });
  let output = '', diagnostic = '', size = 0;
  const timer = setTimeout(() => { fail('timeout'); child.kill('SIGKILL'); }, 120000);
  child.stdout.on('data', data => { size += data.length; if (size > 262144) { fail('output_limit'); child.kill('SIGKILL'); return; } output += data; });
  // Inspect only in memory. Never emit raw provider errors, auth data or model prose.
  child.stderr.on('data', data => { if (diagnostic.length < 8192) diagnostic += data.toString('utf8').slice(0, 8192 - diagnostic.length); });
  child.on('error', () => { clearTimeout(timer); fail('runtime_unavailable'); });
  child.on('close', code => {
    clearTimeout(timer);
    if (finished) return;
    let result;
    try { result = JSON.parse(output); } catch { fail(category(undefined, diagnostic)); return; }
    if (code !== 0 || result.is_error || result.subtype !== 'success') { fail(category(result, diagnostic)); return; }
    try {
      const draft = result.structured_output ?? JSON.parse(result.result);
      const encoded = JSON.stringify(draft);
      if (typeof encoded !== 'string') throw new Error();
      if ([input.credential, encodeURIComponent(input.credential), JSON.stringify(input.credential).slice(1,-1)].some(token => encoded.includes(token))) { fail('unsafe_output'); return; }
      if (Buffer.byteLength(encoded) > 65536) { fail('output_limit'); return; }
      finished = true;
      process.stdout.write(encoded);
    } catch { fail('structured_output'); }
  });
  child.stdin.on('error', () => {});
  child.stdin.end(input.prompt);
});`;

export const runPlannerDocker: PlannerDockerRun = (args, options = {}) =>
  new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(new PlannerExecutionError("canceled"));
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
      failure: PlannerFailureCode | undefined;
    const stop = (code: PlannerFailureCode) => {
      failure ??= code;
      child.kill();
    };
    const abort = () => stop("canceled");
    const timer = setTimeout(
      () => stop("timeout"),
      options.timeoutMs ?? 30_000,
    );
    options.signal?.addEventListener("abort", abort, { once: true });
    const clean = () => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
    };
    const capture = (chunk: Buffer, error: boolean) => {
      size += chunk.length;
      if (size > (options.maxBytes ?? 262144)) {
        stop("output_limit");
        return;
      }
      if (error) stderr += chunk.toString("utf8");
      else stdout += chunk.toString("utf8");
    };
    child.stdout?.on("data", (chunk: Buffer) => capture(chunk, false));
    child.stderr?.on("data", (chunk: Buffer) => capture(chunk, true));
    child.once("error", () => {
      clean();
      reject(new PlannerExecutionError("runtime_unavailable"));
    });
    child.once("close", (code) => {
      clean();
      if (failure) reject(new PlannerExecutionError(failure));
      else resolve({ code: code ?? 1, stdout, stderr });
    });
    child.stdin?.on("error", () => {});
    if (options.stdin !== undefined) child.stdin?.end(options.stdin);
  });

export function createDockerPlanner(options: {
  packageRoot: string;
  run?: PlannerDockerRun;
  ensureImage?: () => Promise<string>;
  /** Setup investigation can opt into larger bounded source context; PM drafts retain 512 KiB. */
  maxInputBytes?: number;
}): PlannerExecutor {
  const run = options.run ?? runPlannerDocker;
  return async (input) => {
    const payload = JSON.stringify({
      credential: input.credential,
      prompt: input.prompt,
      system: input.system,
      schema: input.schema,
    });
    const maximum = Math.max(
      512 * 1024,
      Math.min(options.maxInputBytes ?? 512 * 1024, 2 * 1024 * 1024),
    );
    if (!Number.isFinite(maximum) || Buffer.byteLength(payload) > maximum)
      throw new PlannerExecutionError("input_limit");
    const id = randomUUID();
    const name = `gremlins-plan-${id}`;
    let image: string;
    try {
      image = await (options.ensureImage?.() ??
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
    } catch (error) {
      throw error instanceof PlannerExecutionError
        ? error
        : new PlannerExecutionError(
            input.signal.aborted ? "canceled" : "runtime_unavailable",
          );
    }
    if (input.signal.aborted) throw new PlannerExecutionError("canceled");
    if (!/^shipgremlins-local:[a-f0-9]{16}$/.test(image))
      throw new PlannerExecutionError("runtime_unavailable");
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
        throw new PlannerExecutionError("runtime_unavailable");
      const result = await run(["start", "--attach", "--interactive", name], {
        stdin: payload,
        timeoutMs: 125000,
        signal: input.signal,
        maxBytes: 65536,
      });
      if (result.code !== 0) {
        let reported: PlannerFailureCode | undefined;
        try {
          reported = failureCode(JSON.parse(result.stdout).plannerError);
        } catch {
          /* Untrusted output is never an error message. */
        }
        if (reported) throw new PlannerExecutionError(reported);
        // Exit 137 alone does not prove OOM; the daemon's state is authoritative.
        const state = await run(
          ["inspect", "--format", "{{json .State}}", name],
          { timeoutMs: 5000, maxBytes: 4096 },
        ).catch(() => null);
        try {
          if (state?.code === 0 && JSON.parse(state.stdout)?.OOMKilled === true)
            throw new PlannerExecutionError("runtime_memory");
        } catch (error) {
          if (error instanceof PlannerExecutionError) throw error;
        }
        throw new PlannerExecutionError("model_error");
      }
      try {
        return JSON.parse(result.stdout);
      } catch {
        throw new PlannerExecutionError("structured_output");
      }
    } catch (error) {
      throw error instanceof PlannerExecutionError
        ? error
        : new PlannerExecutionError(
            input.signal.aborted ? "canceled" : "runtime_unavailable",
          );
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
