import { EventEmitter } from "node:events";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { executeCodexPlanner } from "../../runner-local/codex-planner.mjs";
import { prepareCodexInvocation } from "../../runner-local/codex.mjs";
import {
  SETUP_SCHEMA,
  setupAnalysisSchema,
} from "../projectOnboarding/analysis.ts";
import { PROJECT_SETUP_SCHEMA } from "../projectOnboarding/projectSetup.ts";
import { PM_DRAFT_SCHEMA } from "./index.ts";
import { CREW_SCHEMA } from "../ideaCrew/plan.ts";
import { GRUMBLINS_SCHEMA } from "../grumblins/schema.ts";

const credential = JSON.stringify({
  auth_mode: "chatgpt",
  tokens: {
    id_token: "synthetic-private-id",
    access_token: "synthetic-private-access",
    refresh_token: "synthetic-private-refresh",
    account_id: "account-1",
  },
});
const input = () => ({
  ai: { provider: "codex" as const, model: "chosen-model" },
  credential,
  prompt: "private source context",
  system: "trusted rules",
  schema: {
    type: "object",
    properties: { answer: { type: "string" } },
    required: ["answer"],
    additionalProperties: false,
  },
});
const usage = {
  type: "turn.completed",
  usage: {
    input_tokens: 1000,
    cached_input_tokens: 800,
    output_tokens: 90,
    reasoning_output_tokens: 60,
  },
};
type Options = {
  raw?: string;
  result?: string;
  code?: number;
  stderr?: string;
  hang?: boolean;
  spawnError?: boolean;
  processError?: boolean;
  readError?: boolean;
};
function fixture(options: Options = {}) {
  const child = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    stdin: Object.assign(new EventEmitter(), { end: vi.fn() }),
    kill: vi.fn(),
  });
  child.kill.mockImplementation(() => {
    child.emit("close", 137);
  });
  child.stdin.end.mockImplementation(() => {
    if (options.hang) return;
    if (options.processError) {
      child.emit("error", new Error(credential));
      return;
    }
    child.stderr.emit("data", Buffer.from(options.stderr ?? ""));
    const raw = options.raw ?? JSON.stringify(usage);
    // Exercise records split across chunks and the final non-newline record.
    child.stdout.emit("data", Buffer.from(raw.slice(0, 13)));
    child.stdout.emit("data", Buffer.from(raw.slice(13)));
    child.emit("close", options.code ?? 0);
  });
  const invocation = {
    command: "codex",
    args: ["exec", "--json", "-"],
    env: { CODEX_HOME: "/isolated" },
    home: "/isolated",
    outputPath: "/isolated/final",
    readResult: vi.fn(() => {
      if (options.readError) throw new Error(credential);
      return options.result ?? '{"answer":"Reviewable plan"}';
    }),
    cleanup: vi.fn(),
  };
  const prepare = vi.fn<typeof prepareCodexInvocation>(() => invocation);
  const spawn = vi.fn<
    NonNullable<NonNullable<Parameters<typeof executeCodexPlanner>[1]>["spawn"]>
  >(() => {
    if (options.spawnError) throw new Error(credential);
    return child as unknown as ChildProcessWithoutNullStreams;
  });
  return {
    child,
    invocation,
    prepare,
    spawn,
    execute: () =>
      executeCodexPlanner(input(), { prepare, spawn, timeoutMs: 10 }),
  };
}
afterEach(() => vi.useRealTimers());

describe("Codex isolated planner", () => {
  it("passes only inert input to a tool-free invocation and records cache without double counting reasoning", async () => {
    const f = fixture();
    const output = await f.execute();
    expect(output).toMatchObject({
      plannerEnvelope: 1,
      plannerOutput: { answer: "Reviewable plan" },
      plannerUsage: {
        source: "codex",
        model: "chosen-model",
        inputTokens: 200,
        cacheReadInputTokens: 800,
        outputTokens: 90,
        cacheCreationInputTokens: null,
        totalTokens: 1090,
        complete: false,
      },
    });
    expect(f.prepare).toHaveBeenCalledWith(
      expect.objectContaining({
        selection: input().ai,
        authJson: credential,
        restricted: true,
        schema: input().schema,
      }),
    );
    const call = f.spawn.mock.calls[0]!;
    expect(call[1]).toEqual([
      "exec",
      "--json",
      "-c",
      'developer_instructions="trusted rules"',
      "-",
    ]);
    expect(JSON.stringify(call)).not.toContain(credential);
    expect(JSON.stringify(call)).not.toContain(input().prompt);
    expect(call[2]).toMatchObject({
      shell: false,
      env: { CODEX_HOME: "/isolated" },
    });
    expect(f.child.stdin.end).toHaveBeenCalledWith(input().prompt);
    expect(f.invocation.cleanup).toHaveBeenCalledTimes(1);
  });
  it.each(["turn.failed", "error"])(
    "rejects %s even with exit zero and never displays provider diagnostics",
    async (type) => {
      const f = fixture({
        raw: JSON.stringify({
          type,
          error: { message: "429 rate limit " + credential },
        }),
        result: '{"answer":"stale"}',
      });
      expect(await f.execute()).toEqual({
        plannerError: "rate_limit",
        plannerUsage: null,
      });
      expect(f.invocation.readResult).not.toHaveBeenCalled();
      expect(f.invocation.cleanup).toHaveBeenCalledTimes(1);
    },
  );
  it.each([
    "synthetic-private-access",
    encodeURIComponent("synthetic-private-access"),
    credential,
    encodeURIComponent(credential),
  ])("discards echoed auth material %s", async (secret) => {
    const f = fixture({ result: JSON.stringify({ answer: secret }) });
    const output = await f.execute();
    expect(output.plannerError).toBe("unsafe_output");
    expect(JSON.stringify(output)).not.toContain(secret);
    expect(f.invocation.cleanup).toHaveBeenCalledTimes(1);
  });
  it.each([
    [{ result: "not JSON" }, "structured_output"],
    [{ readError: true }, "structured_output"],
    [{ result: JSON.stringify({ answer: "x".repeat(65536) }) }, "output_limit"],
    [{ spawnError: true }, "runtime_unavailable"],
    [{ processError: true }, "runtime_unavailable"],
    [{ stderr: "401 unauthorized " + credential, code: 1 }, "authentication"],
  ] as const)(
    "normalizes isolated failures and always cleans up %j",
    async (options, expected) => {
      const f = fixture(options);
      expect((await f.execute()).plannerError).toBe(expected);
      expect(f.invocation.cleanup).toHaveBeenCalledTimes(1);
    },
  );
  it("settles timeout before kill can synchronously emit close", async () => {
    vi.useFakeTimers();
    const f = fixture({ hang: true });
    const pending = f.execute();
    await vi.advanceTimersByTimeAsync(11);
    expect(await pending).toEqual({
      plannerError: "timeout",
      plannerUsage: null,
    });
    expect(f.child.kill).toHaveBeenCalledWith("SIGKILL");
    expect(f.invocation.cleanup).toHaveBeenCalledTimes(1);
  });
  it("settles oversized stream before kill can synchronously emit close", async () => {
    const f = fixture({ raw: "x".repeat(262145) });
    expect(await f.execute()).toEqual({
      plannerError: "output_limit",
      plannerUsage: null,
    });
    expect(f.child.kill).toHaveBeenCalledTimes(1);
    expect(f.invocation.cleanup).toHaveBeenCalledTimes(1);
  });
  it("rejects oversized input and failed credential preparation before spawn", async () => {
    const f = fixture();
    expect(
      await executeCodexPlanner({ ...input(), prompt: "x".repeat(2097152) }, f),
    ).toEqual({ plannerError: "input_limit" });
    f.prepare.mockImplementation(() => {
      throw new Error(credential);
    });
    expect(await f.execute()).toEqual({ plannerError: "authentication" });
    expect(f.spawn).not.toHaveBeenCalled();
  });
});

describe("Codex strict output wire schema", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0))
      rmSync(root, { recursive: true, force: true });
  });
  function task(schema: Record<string, unknown>) {
    const root = mkdtempSync(join(realpathSync(tmpdir()), "codex-schema-"));
    roots.push(root);
    return prepareCodexInvocation({
      authJson: credential,
      cwd: root,
      directory: root,
      restricted: true,
      schema,
    });
  }
  function wire(invocation: ReturnType<typeof task>) {
    return JSON.parse(
      readFileSync(
        invocation.args[invocation.args.indexOf("--output-schema") + 1]!,
        "utf8",
      ),
    );
  }
  it("makes optional fields required nullable then restores omission, preserving original nullable fields", () => {
    const schema = {
      type: "object",
      additionalProperties: false,
      required: ["answer", "suggestedArea"],
      properties: {
        answer: { type: "string" },
        nextStep: { type: "string" },
        suggestedArea: { anyOf: [{ type: "string" }, { type: "null" }] },
        nullableOption: { type: ["string", "null"] },
        commands: { type: "object", properties: { test: { type: "string" } } },
      },
    };
    const before = JSON.stringify(schema),
      invocation = task(schema);
    expect(wire(invocation)).toMatchObject({
      required: [
        "answer",
        "nextStep",
        "suggestedArea",
        "nullableOption",
        "commands",
      ],
      properties: {
        nextStep: { anyOf: [{ type: "string" }, { type: "null" }] },
      },
    });
    writeFileSync(
      invocation.outputPath,
      JSON.stringify({
        answer: "Plan",
        nextStep: null,
        suggestedArea: null,
        nullableOption: null,
        commands: { test: null },
      }),
    );
    expect(JSON.parse(invocation.readResult())).toEqual({
      answer: "Plan",
      suggestedArea: null,
      nullableOption: null,
      commands: {},
    });
    expect(JSON.stringify(schema)).toBe(before);
  });
  const mapSchema = {
    type: "object",
    required: ["env"],
    properties: {
      env: {
        type: "object",
        maxProperties: 2,
        propertyNames: { pattern: "^[A-Z][A-Z0-9_]*$" },
        additionalProperties: { type: "string" },
      },
    },
  };
  it("preserves explicitly nullable referenced optionals and refuses unsupported mixed object shapes", () => {
    const invocation = task({
      type: "object",
      properties: { choice: { $ref: "#/$defs/choice" } },
      $defs: { choice: { anyOf: [{ type: "string" }, { type: "null" }] } },
    });
    writeFileSync(invocation.outputPath, '{"choice":null}');
    expect(JSON.parse(invocation.readResult())).toEqual({ choice: null });
    expect(() => task({ type: "object", additionalProperties: true })).toThrow(
      /cannot preserve/,
    );
    expect(() =>
      task({
        type: "object",
        properties: { known: { type: "string" } },
        additionalProperties: { type: "string" },
      }),
    ).toThrow(/cannot preserve/);
  });
  it("encodes bounded dictionaries as key/value entries and restores the original domain object", () => {
    const invocation = task(mapSchema);
    expect(wire(invocation).properties.env).toMatchObject({
      type: "array",
      maxItems: 2,
      items: { additionalProperties: false, required: ["key", "value"] },
    });
    writeFileSync(
      invocation.outputPath,
      JSON.stringify({ env: [{ key: "LOGIN", value: "TEST_LOGIN" }] }),
    );
    expect(JSON.parse(invocation.readResult())).toEqual({
      env: { LOGIN: "TEST_LOGIN" },
    });
  });
  it.each(
    [
      [
        { key: "LOGIN", value: "one" },
        { key: "LOGIN", value: "two" },
      ],
      [{ key: "__proto__", value: "one" }],
      [{ key: "constructor", value: "one" }],
      [{ key: "prototype", value: "one" }],
      [{ key: "invalid-key", value: "one" }],
      [
        { key: "A", value: "a" },
        { key: "B", value: "b" },
        { key: "C", value: "c" },
      ],
      [{ key: "LOGIN" }],
      [{ key: "LOGIN", value: "x", extra: true }],
    ].map((entries) => [entries]),
  )(
    "rejects malformed, repeated, unsafe or excessive dictionary keys %j",
    (entries) => {
      const invocation = task(mapSchema);
      writeFileSync(invocation.outputPath, JSON.stringify({ env: entries }));
      expect(() => invocation.readResult()).toThrow(/dictionary/);
    },
  );
  it("only converts oneOf with disjoint required discriminators and checks the original discriminator", () => {
    const branches = ["click", "fill"].map((kind) => ({
      type: "object",
      required: ["kind", "selector"],
      properties: {
        kind: { const: kind, type: "string" },
        selector: { type: "string" },
        ...(kind === "fill" ? { text: { type: "string" } } : {}),
      },
    }));
    const invocation = task({
      type: "object",
      required: ["step"],
      properties: { step: { oneOf: branches } },
    });
    expect(wire(invocation).properties.step.anyOf).toHaveLength(2);
    writeFileSync(
      invocation.outputPath,
      JSON.stringify({ step: { kind: "fill", selector: "#name", text: null } }),
    );
    expect(JSON.parse(invocation.readResult())).toEqual({
      step: { kind: "fill", selector: "#name" },
    });
    writeFileSync(
      invocation.outputPath,
      JSON.stringify({ step: { kind: "forged", selector: "#name" } }),
    );
    expect(() => invocation.readResult()).toThrow(/union/);
    expect(() =>
      task({ oneOf: [{ type: "string" }, { type: "string" }] }),
    ).toThrow(/disjoint/);
  });
  it("omits wire uniqueness constraints while rejecting duplicate domain items including reordered object keys", () => {
    const invocation = task({
      type: "object",
      required: ["items"],
      properties: {
        items: {
          type: "array",
          uniqueItems: true,
          minItems: 1,
          maxItems: 2,
          items: {
            type: "object",
            required: ["name", "count"],
            properties: {
              name: { type: "string" },
              count: { type: "number" },
            },
          },
        },
      },
    });
    expect(wire(invocation).properties.items.uniqueItems).toBeUndefined();
    writeFileSync(
      invocation.outputPath,
      '{"items":[{"name":"one","count":1},{"count":1,"name":"one"}]}',
    );
    expect(() => invocation.readResult()).toThrow(/unique items/);
    writeFileSync(
      invocation.outputPath,
      '{"items":[{"name":"one","count":1},{"name":"two","count":1}]}',
    );
    expect(JSON.parse(invocation.readResult()).items).toHaveLength(2);
    for (const items of [
      [],
      Array.from({ length: 3 }, () => ({ name: "one", count: 1 })),
    ]) {
      writeFileSync(invocation.outputPath, JSON.stringify({ items }));
      expect(() => invocation.readResult()).toThrow(/array exceeds its bounds/);
    }
  });
  it("preserves nested PM charter and path uniqueness after stripping unsupported wire keywords", () => {
    const invocation = task(PM_DRAFT_SCHEMA);
    writeFileSync(invocation.outputPath, '{"paths":["src/","src/"]}');
    expect(() => invocation.readResult()).toThrow(/unique items/);
    writeFileSync(
      invocation.outputPath,
      '{"charter":{"guardrails":["Keep data private","Keep data private"]}}',
    );
    expect(() => invocation.readResult()).toThrow(/unique items/);
  });
  it.each([
    ["SETUP_SCHEMA", SETUP_SCHEMA],
    ["existing-crew SETUP_SCHEMA", setupAnalysisSchema(true)],
    ["PROJECT_SETUP_SCHEMA", PROJECT_SETUP_SCHEMA],
    ["PM_DRAFT_SCHEMA", PM_DRAFT_SCHEMA],
    ["CREW_SCHEMA", CREW_SCHEMA],
    ["GRUMBLINS_SCHEMA", GRUMBLINS_SCHEMA],
  ])(
    "normalizes the real %s without changing its domain definition",
    (_name, schema) => {
      const before = JSON.stringify(schema),
        invocation = task(schema);
      const inspect = (value: unknown) => {
        if (!value || typeof value !== "object") return;
        const node = value as Record<string, unknown>;
        expect(node.oneOf).toBeUndefined();
        expect(node.const).toBeUndefined();
        expect(node.uniqueItems).toBeUndefined();
        expect(node.maxProperties).toBeUndefined();
        expect(node.propertyNames).toBeUndefined();
        if (Array.isArray(node.enum)) expect(node.type).toBe("string");
        if (node.type === "object") {
          expect(node.additionalProperties).toBe(false);
          expect(node.required).toEqual(Object.keys(node.properties as object));
        }
        for (const child of Object.values(node))
          if (Array.isArray(child)) child.forEach(inspect);
          else inspect(child);
      };
      inspect(wire(invocation));
      expect(JSON.stringify(schema)).toBe(before);
    },
  );
});
