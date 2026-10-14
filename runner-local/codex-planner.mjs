import { spawn } from "node:child_process";
import { prepareCodexInvocation, codexSecretValues } from "./codex.mjs";
import { createUsageCollector } from "./usage.mjs";

const category = (text) => {
  if (
    /context.{0,30}(limit|window|length)|too many tokens|prompt is too long|\b413\b/i.test(
      text,
    )
  )
    return "context_limit";
  if (/rate.?limit|usage limit|quota|too many requests|\b429\b/i.test(text))
    return "rate_limit";
  if (
    /unauthorized|authentication|invalid.{0,20}token|not logged in|refresh.{0,20}(expired|invalid)|\b40[13]\b/i.test(
      text,
    )
  )
    return "authentication";
  if (
    /unknown (option|argument|field)|unrecognized|unexpected argument|configuration.*invalid/i.test(
      text,
    )
  )
    return "runtime_incompatible";
  if (
    /overloaded|service unavailable|connection error|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|fetch failed|\b50[0234]\b/i.test(
      text,
    )
  )
    return "provider_unavailable";
  return "model_error";
};

/** Tool-free structured planning. Only safe categories and token counters leave this process. */
export async function executeCodexPlanner(input, dependencies = {}) {
  if (
    !input ||
    typeof input.credential !== "string" ||
    !input.credential ||
    typeof input.prompt !== "string" ||
    typeof input.system !== "string" ||
    !input.schema ||
    Buffer.byteLength(JSON.stringify(input)) > 2097152
  )
    return { plannerError: "input_limit" };
  let invocation;
  try {
    invocation = (dependencies.prepare ?? prepareCodexInvocation)({
      selection: input.ai,
      authJson: input.credential,
      cwd: "/work",
      directory: "/work",
      restricted: true,
      schema: input.schema,
      env: {
        PATH: "/usr/local/bin:/usr/bin:/bin",
        HOME: "/work/home",
        TMPDIR: "/tmp",
      },
    });
  } catch {
    return { plannerError: "authentication" };
  }
  const usage = createUsageCollector({
    provider: "codex",
    model: input.ai?.model,
  });
  try {
    return await new Promise((resolve) => {
      let finished = false,
        modelFailed = false,
        pending = "",
        diagnostic = "",
        size = 0;
      let child;
      const finish = (value) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        resolve({ ...value, plannerUsage: usage.snapshot() ?? null });
      };
      const timer = setTimeout(() => {
        finish({ plannerError: "timeout" });
        child?.kill("SIGKILL");
      }, dependencies.timeoutMs ?? 120000);
      const args = [...invocation.args];
      args.splice(
        args.length - 1,
        0,
        "-c",
        `developer_instructions=${JSON.stringify(input.system)}`,
      );
      try {
        child = (dependencies.spawn ?? spawn)(invocation.command, args, {
          cwd: "/work",
          env: invocation.env,
          shell: false,
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch {
        finish({ plannerError: "runtime_unavailable" });
        return;
      }
      const record = (line) => {
        try {
          const event = JSON.parse(line);
          usage.modelRecord(event);
          if (["turn.failed", "error"].includes(event.type)) {
            modelFailed = true;
            diagnostic += JSON.stringify(
              event.error ?? event.message ?? "",
            ).slice(0, Math.max(0, 8192 - diagnostic.length));
          }
        } catch {
          /* A malformed stream never becomes a report or a log. */
        }
      };
      child.stdout.on("data", (chunk) => {
        if (finished) return;
        size += chunk.length;
        if (size > 262144) {
          finish({ plannerError: "output_limit" });
          child.kill("SIGKILL");
          return;
        }
        pending += chunk.toString("utf8");
        let end;
        while ((end = pending.indexOf("\n")) >= 0) {
          record(pending.slice(0, end));
          pending = pending.slice(end + 1);
        }
      });
      child.stderr.on("data", (chunk) => {
        diagnostic += chunk
          .toString("utf8")
          .slice(0, Math.max(0, 8192 - diagnostic.length));
      });
      child.on("error", () => finish({ plannerError: "runtime_unavailable" }));
      child.on("close", (code) => {
        if (finished) return;
        if (pending) record(pending);
        if (code !== 0 || modelFailed) {
          finish({ plannerError: category(diagnostic) });
          return;
        }
        try {
          const text = invocation.readResult();
          const output = JSON.parse(text);
          const encoded = JSON.stringify(output);
          if (Buffer.byteLength(encoded) > 65536) {
            finish({ plannerError: "output_limit" });
            return;
          }
          if (
            codexSecretValues(input.credential).some((token) =>
              [
                token,
                encodeURIComponent(token),
                JSON.stringify(token).slice(1, -1),
              ].some((value) => encoded.includes(value)),
            )
          ) {
            finish({ plannerError: "unsafe_output" });
            return;
          }
          finish({ plannerEnvelope: 1, plannerOutput: output });
        } catch {
          finish({ plannerError: "structured_output" });
        }
      });
      child.stdin.on("error", () => {});
      child.stdin.end(input.prompt);
    });
  } finally {
    invocation.cleanup();
  }
}

export function runCodexPlanner() {
  let text = "",
    finished = false;
  const output = (value) => {
    if (finished) return;
    finished = true;
    process.stdout.write(JSON.stringify(value));
    if (value.plannerError) process.exitCode = 2;
  };
  process.stdin.on("data", (chunk) => {
    text += chunk;
    if (Buffer.byteLength(text) > 2097152) {
      output({ plannerError: "input_limit" });
      process.stdin.destroy();
    }
  });
  process.stdin.on("end", async () => {
    if (finished) return;
    try {
      const input = JSON.parse(text);
      text = "";
      output(await executeCodexPlanner(input));
    } catch {
      output({ plannerError: "model_error" });
    }
  });
}
