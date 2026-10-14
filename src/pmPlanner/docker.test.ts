import { EventEmitter } from "node:events";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUsage } from "../usage/index.ts";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import {
  createDockerPlanner,
  CODEX_PLANNER_PROGRAM,
  PLANNER_PROGRAM,
  type PlannerDockerRun,
} from "./docker.ts";

const credential = 'synthetic-token-private:/with-quotes"';
const input = () => ({
  credential,
  prompt: "Private inert source text",
  system: "Fixed rules",
  schema: {},
  signal: new AbortController().signal,
});

describe("Codex planner Docker boundary", () => {
  const codexAuth = JSON.stringify({
    auth_mode: "chatgpt",
    tokens: {
      id_token: "private-id",
      access_token: "private-access",
      refresh_token: "",
      account_id: "account-1",
    },
  });
  function fixture(
    options: {
      stdout?: string;
      code?: number;
      credentials?: Record<string, string>;
      refreshError?: boolean;
    } = {},
  ) {
    let owner = "";
    const run = vi.fn<PlannerDockerRun>(async (args) => {
      if (args[0] === "create")
        owner = args[args.indexOf("--label") + 1]!.split("=")[1]!;
      return {
        code: args[0] === "start" ? (options.code ?? 0) : 0,
        stdout:
          args[0] === "start"
            ? (options.stdout ??
              '{"plannerEnvelope":1,"plannerOutput":{"answer":"Codex plan"},"plannerUsage":null}')
            : args[0] === "inspect"
              ? owner
              : "",
        stderr: credential,
      };
    });
    const prepareCodexCredentials = vi.fn(async () => {
      if (options.refreshError) throw new Error(credential);
      return options.credentials ?? { CODEX_AUTH_JSON: codexAuth };
    });
    const ensureImage = vi.fn(
      async () => "shipgremlins-local:0123456789abcdef",
    );
    const execute = createDockerPlanner({
      packageRoot: ".",
      run,
      ensureImage,
      prepareCodexCredentials,
    });
    return { execute, run, ensureImage, prepareCodexCredentials };
  }
  const codexInput = () => ({
    ...input(),
    ai: { provider: "codex" as const, model: "chosen-model" },
  });
  it("refreshes only selected Codex auth and transports it with model selection through private stdin", async () => {
    const f = fixture();
    await expect(
      f.execute({
        ...codexInput(),
        usageContext: { kind: "idea-planning", project: "private-metadata" },
      }),
    ).resolves.toEqual({ answer: "Codex plan" });
    expect(f.prepareCodexCredentials).toHaveBeenCalledTimes(1);
    const create = f.run.mock.calls.find(([args]) => args[0] === "create")!;
    expect(create[0].at(-1)).toBe(CODEX_PLANNER_PROGRAM);
    expect(create[0]).not.toContain("--env");
    expect(create[0]).not.toContain("--mount");
    expect(JSON.stringify(create)).not.toContain(codexAuth);
    const start = f.run.mock.calls.find(([args]) => args[0] === "start")!;
    expect(JSON.parse(start[1]!.stdin!)).toEqual({
      ai: { provider: "codex", model: "chosen-model" },
      credential: codexAuth,
      prompt: input().prompt,
      system: input().system,
      schema: input().schema,
    });
    expect(start[1]!.stdin).not.toContain("usageContext");
    expect(start[1]!.stdin).not.toContain("private-metadata");
    expect(f.run.mock.calls.at(-1)![0].slice(0, 2)).toEqual(["rm", "--force"]);
  });
  it("preserves Claude execution and its optional model without touching Codex auth", async () => {
    const f = fixture();
    await f.execute({
      ...input(),
      ai: { provider: "claude", model: "chosen-claude" },
    });
    expect(f.prepareCodexCredentials).not.toHaveBeenCalled();
    expect(
      f.run.mock.calls.find(([args]) => args[0] === "create")![0].at(-1),
    ).toBe(PLANNER_PROGRAM);
    const payload = JSON.parse(
      f.run.mock.calls.find(([args]) => args[0] === "start")![1]!.stdin!,
    );
    expect(payload).toMatchObject({
      credential,
      ai: { provider: "claude", model: "chosen-claude" },
    });
  });
  it.each<{ refreshError?: boolean; credentials?: Record<string, string> }>([
    { refreshError: true },
    { credentials: {} },
    { credentials: { CLAUDE_CODE_OAUTH_TOKEN: "wrong-provider" } },
  ])(
    "normalizes trusted refresh failures without launching a container %j",
    async (options) => {
      const f = fixture(options);
      await expect(f.execute(codexInput())).rejects.toMatchObject({
        code: "authentication",
        message: expect.stringContaining("Codex"),
      });
      try {
        await f.execute(codexInput());
      } catch (error) {
        expect(String(error)).not.toContain(credential);
      }
      expect(f.run).not.toHaveBeenCalled();
      expect(f.ensureImage).not.toHaveBeenCalled();
    },
  );
  it("rejects cancellation, invalid selection and oversized context before refreshing", async () => {
    const f = fixture(),
      aborted = new AbortController();
    aborted.abort();
    await expect(
      f.execute({ ...codexInput(), signal: aborted.signal }),
    ).rejects.toMatchObject({ code: "canceled" });
    await expect(
      f.execute({ ...codexInput(), prompt: "x".repeat(512 * 1024) }),
    ).rejects.toMatchObject({ code: "input_limit" });
    await expect(
      f.execute({
        ...codexInput(),
        ai: { provider: "unsupported" as "codex" },
      }),
    ).rejects.toMatchObject({ code: "input_limit" });
    expect(f.prepareCodexCredentials).not.toHaveBeenCalled();
    expect(f.run).not.toHaveBeenCalled();
  });
  it("keeps safe Codex failure categories and removes the owned container", async () => {
    const f = fixture({
      code: 2,
      stdout:
        '{"plannerError":"rate_limit","plannerUsage":{"source":"codex","complete":false,"inputTokens":200,"outputTokens":90,"cacheReadInputTokens":800,"cacheCreationInputTokens":null}}',
    });
    await expect(f.execute(codexInput())).rejects.toMatchObject({
      code: "rate_limit",
      message: expect.stringContaining("Codex"),
    });
    expect(f.run.mock.calls.at(-1)![0].slice(0, 2)).toEqual(["rm", "--force"]);
  });
  it("records measured Codex failures as partial usage without inventing cache creation", async () => {
    const root = mkdtempSync(
      join(realpathSync(tmpdir()), "codex-planner-usage-"),
    );
    try {
      const f = fixture({
        code: 2,
        stdout:
          '{"plannerError":"rate_limit","plannerUsage":{"source":"codex","complete":false,"inputTokens":200,"outputTokens":90,"cacheReadInputTokens":800,"cacheCreationInputTokens":null,"totalTokens":1090,"model":"chosen-model"}}',
      });
      const execute = createDockerPlanner({
        root,
        packageRoot: root,
        run: f.run,
        ensureImage: f.ensureImage,
        prepareCodexCredentials: f.prepareCodexCredentials,
      });
      await expect(
        execute({
          ...codexInput(),
          usageContext: { kind: "setup-guidance", project: "app" },
        }),
      ).rejects.toMatchObject({ code: "rate_limit" });
      expect(createUsage({ root }).summary()).toMatchObject({
        totals: { totalTokens: 1090 },
        coverage: {
          partialRecords: 1,
          fields: { cacheCreationInputTokens: 0 },
        },
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function wrapper(options: {
  result?: unknown;
  raw?: string;
  stderr?: string;
  code?: number;
  timeout?: boolean;
  spawnError?: boolean;
}) {
  const stdin = new EventEmitter();
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    stdin: EventEmitter & { end: (text: string) => void };
    kill: () => void;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn(() => child.emit("close", 137));
  let timer: (() => void) | undefined;
  child.stdin = Object.assign(new EventEmitter(), {
    end: vi.fn(() => {
      if (options.spawnError) {
        child.emit("error", new Error(credential));
        return;
      }
      if (options.timeout) {
        timer!();
        return;
      }
      if (options.stderr)
        child.stderr.emit("data", Buffer.from(options.stderr));
      child.stdout.emit(
        "data",
        Buffer.from(options.raw ?? JSON.stringify(options.result)),
      );
      child.emit("close", options.code ?? 0);
    }),
  });
  let output = "";
  const spawn = vi.fn(() => child);
  const process = {
    stdin,
    stdout: {
      write: (value: string) => {
        output += value;
      },
    },
    exitCode: 0,
  };
  runInNewContext(PLANNER_PROGRAM, {
    require: (name: string) =>
      name === "node:child_process" ? { spawn } : { mkdirSync: vi.fn() },
    process,
    Buffer,
    setTimeout: (fn: () => void) => {
      timer = fn;
      return 1;
    },
    clearTimeout: vi.fn(),
  });
  stdin.emit("data", JSON.stringify(input()));
  stdin.emit("end");
  expect(output).not.toContain(credential);
  expect(output).not.toContain(input().prompt);
  return { output: JSON.parse(output), code: process.exitCode, spawn, child };
}

describe("isolated planner diagnostic boundary", () => {
  it("keeps whole-tree provider metrics outside the structured draft and records even measured failures", async () => {
    const result = {
      type: "result",
      subtype: "success",
      structured_output: { answer: "Useful setup guidance" },
      usage: { input_tokens: 1, output_tokens: 2 },
      modelUsage: {
        "claude-sonnet-4-5": {
          inputTokens: 10,
          outputTokens: 20,
          cacheReadInputTokens: 30,
          cacheCreationInputTokens: 40,
        },
      },
    };
    const wrapped = wrapper({ result });
    expect(wrapped.output).toMatchObject({
      plannerOutput: { answer: "Useful setup guidance" },
      plannerUsage: { inputTokens: 10, outputTokens: 20, complete: true },
    });
    const failed = wrapper({
      result: { ...result, subtype: "error_max_turns", is_error: true },
      code: 1,
    });
    expect(failed.output).toMatchObject({
      plannerError: "turn_limit",
      plannerUsage: { inputTokens: 10, complete: true },
    });
    const root = mkdtempSync(join(realpathSync(tmpdir()), "planner-usage-"));
    try {
      let current = wrapped,
        owner = "";
      const run: PlannerDockerRun = async (args) => {
        if (args[0] === "create")
          owner = args[args.indexOf("--label") + 1]!.split("=")[1]!;
        return {
          code: args[0] === "start" ? current.code : 0,
          stdout:
            args[0] === "start"
              ? JSON.stringify(current.output)
              : args[0] === "inspect"
                ? owner
                : "",
          stderr: "",
        };
      };
      const execute = createDockerPlanner({
        root,
        packageRoot: root,
        run,
        ensureImage: async () => "shipgremlins-local:0123456789abcdef",
      });
      await expect(
        execute({
          ...input(),
          usageContext: { kind: "setup-guidance", project: "app" },
        }),
      ).resolves.toEqual({ answer: "Useful setup guidance" });
      current = failed;
      await expect(
        execute({ ...input(), usageContext: { kind: "idea-planning" } }),
      ).rejects.toMatchObject({ code: "turn_limit" });
      expect(createUsage({ root }).summary()).toMatchObject({
        totals: { totalTokens: 200 },
        coverage: { measuredOperations: 2, unavailableOperations: 0 },
      });
      expect(
        createUsage({ root }).summary({ project: "app" }).totals.totalTokens,
      ).toBe(100);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it.each([
    [{ subtype: "error_max_turns", errors: [credential] }, "", "turn_limit"],
    [
      { subtype: "error_max_structured_output_retries" },
      "",
      "structured_output",
    ],
    [
      {
        subtype: "error_during_execution",
        errors: ["API Error: 401 invalid token " + credential],
      },
      "",
      "authentication",
    ],
    [
      {
        subtype: "error_during_execution",
        errors: ["Prompt is too long " + credential],
      },
      "",
      "context_limit",
    ],
    [
      { subtype: "error_during_execution" },
      "HTTP429 rate limit " + credential,
      "rate_limit",
    ],
    [
      { subtype: "error_during_execution" },
      "ECONNREFUSED " + credential,
      "provider_unavailable",
    ],
    [
      { subtype: "error_during_execution" },
      "unknown option --made-up " + credential,
      "runtime_incompatible",
    ],
    [
      { subtype: "error_during_execution", errors: [credential] },
      "",
      "model_error",
    ],
  ])(
    "emits only fixed categories for provider failure %j",
    (result, stderr, code) => {
      expect(wrapper({ result, stderr, code: 1 })).toMatchObject({
        output: { plannerError: code },
        code: 2,
      });
    },
  );
  it("allows bounded structured-output repairs without granting tools or inheriting environment", () => {
    const result = wrapper({
      result: {
        subtype: "success",
        structured_output: { summary: "Ready for review" },
      },
    });
    expect(result.output).toEqual({
      plannerEnvelope: 1,
      plannerOutput: { summary: "Ready for review" },
      plannerUsage: null,
    });
    const args = result.spawn.mock.calls[0] as unknown as [
      string,
      string[],
      { env: Record<string, string>; stdio: string[] },
    ];
    expect(args[1][args[1].indexOf("--max-turns") + 1]).toBe("3");
    expect(args[1][args[1].indexOf("--tools") + 1]).toBe("");
    expect(args[2].env.CLAUDE_CODE_OAUTH_TOKEN).toBe(credential);
    expect(Object.keys(args[2].env)).not.toContain("GITHUB_TOKEN");
    expect(result.child.stdin.end).toHaveBeenCalledWith(input().prompt);
  });
  it.each([credential, encodeURIComponent(credential)])(
    "discards output containing the actual job credential",
    (secret) => {
      expect(
        wrapper({
          result: {
            subtype: "success",
            structured_output: { summary: secret },
          },
        }).output,
      ).toEqual({ plannerError: "unsafe_output" });
    },
  );
  it("distinguishes timeout, spawn, size and malformed structured reports", () => {
    expect(wrapper({ timeout: true }).output).toEqual({
      plannerError: "timeout",
    });
    expect(wrapper({ spawnError: true }).output).toEqual({
      plannerError: "runtime_unavailable",
    });
    expect(wrapper({ raw: "x".repeat(262145) }).output).toEqual({
      plannerError: "output_limit",
    });
    expect(
      wrapper({ result: { subtype: "success", result: "not structured JSON" } })
        .output,
    ).toEqual({ plannerError: "structured_output" });
  });
});

describe("planner host error classification", () => {
  function fixture(stdout: string, code = 2, oom = false) {
    let owner = "";
    const run = vi.fn<PlannerDockerRun>(async (args) => {
      if (args[0] === "create")
        owner = args[args.indexOf("--label") + 1]!.split("=")[1]!;
      if (args[0] === "start") return { code, stdout, stderr: credential };
      if (args.includes("{{json .State}}"))
        return {
          code: 0,
          stdout: JSON.stringify({ OOMKilled: oom }),
          stderr: "",
        };
      return {
        code: 0,
        stdout: args[0] === "inspect" ? owner : "",
        stderr: "",
      };
    });
    return {
      run,
      execute: createDockerPlanner({
        packageRoot: ".",
        run,
        ensureImage: async () => "shipgremlins-local:0123456789abcdef",
      }),
    };
  }
  it("preserves a fixed diagnostic code and cleans only the owned container", async () => {
    const f = fixture('{"plannerError":"context_limit"}');
    await expect(f.execute(input())).rejects.toMatchObject({
      code: "context_limit",
    });
    expect(f.run.mock.calls.at(-1)![0].slice(0, 2)).toEqual(["rm", "--force"]);
  });
  it("never promotes raw stderr or an unknown diagnostic into a displayed error", async () => {
    const f = fixture(JSON.stringify({ plannerError: credential }));
    await expect(f.execute(input())).rejects.toMatchObject({
      code: "model_error",
    });
    try {
      await f.execute(input());
    } catch (error) {
      expect(String(error)).not.toContain(credential);
    }
  });
  it("requires daemon-confirmed OOM rather than guessing from exit137", async () => {
    await expect(fixture("", 137, true).execute(input())).rejects.toMatchObject(
      { code: "runtime_memory" },
    );
    await expect(
      fixture("", 137, false).execute(input()),
    ).rejects.toMatchObject({ code: "model_error" });
  });
  it("distinguishes malformed success and image startup failure", async () => {
    await expect(fixture("not json", 0).execute(input())).rejects.toMatchObject(
      { code: "structured_output" },
    );
    const execute = createDockerPlanner({
      packageRoot: ".",
      ensureImage: async () => {
        throw new Error(credential);
      },
    });
    await expect(execute(input())).rejects.toMatchObject({
      code: "runtime_unavailable",
    });
  });
});
