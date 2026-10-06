import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import {
  existsSync,
  linkSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it } from "vitest";
import {
  createUsageCollector,
  MAX_USAGE_BYTES,
  parseClaudeUsage,
  writeUsageArtifact,
  type UsageArtifact,
} from "../../runner-local/usage.mjs";

const now = () => new Date("2026-10-05T12:00:00.000Z");
const serialized = (record: unknown) =>
  JSON.parse(JSON.stringify(record)) as unknown;
const model = (input = 20, output = 7, read = 400, write = 100) => ({
  inputTokens: input,
  outputTokens: output,
  cacheReadInputTokens: read,
  cacheCreationInputTokens: write,
  costUSD: 900,
  contextWindow: 200000,
});
const api = (input = 20, output = 1, read = 400, write = 100) => ({
  input_tokens: input,
  output_tokens: output,
  cache_read_input_tokens: read,
  cache_creation_input_tokens: write,
});
const assistant = (id: string, usage = api()) => ({
  type: "assistant",
  session_id: "session",
  parent_tool_use_id: null,
  message: {
    id,
    model: "claude-sonnet-4-6",
    usage,
    content: [
      {
        type: "thinking",
        thinking: "PRIVATE THINKING",
        signature: "PRIVATE SIGNATURE",
      },
      { type: "tool_use", name: "Bash", input: { command: "echo secret" } },
    ],
  },
});
const result = (modelUsage: object = { "claude-sonnet-4-6": model() }) => ({
  type: "result",
  subtype: "success",
  is_error: false,
  session_id: "session",
  modelUsage,
  usage: api(10, 3, 200, 50),
  result: "PRIVATE RESPONSE",
  total_cost_usd: 999,
});
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe("provider-reported worker token usage", () => {
  it("prefers whole-tree model totals without adding main-loop or message counts", () => {
    const collector = createUsageCollector({ now });
    collector.modelRecord(serialized(assistant("msg_1")));
    collector.modelRecord(serialized(assistant("msg_1")));
    const envelope = serialized(
      result({
        "claude-sonnet-4-6": model(),
        "claude-haiku-4-5": model(5, 3, 40, 10),
      }),
    );
    collector.modelRecord(envelope);
    collector.modelRecord(envelope);
    expect(collector.snapshot()).toEqual({
      schemaVersion: 1,
      source: "claude-code",
      reportedAt: now().toISOString(),
      inputTokens: 25,
      outputTokens: 10,
      cacheReadInputTokens: 440,
      cacheCreationInputTokens: 110,
      totalTokens: 585,
      complete: true,
    });
    expect(JSON.stringify(collector.snapshot())).not.toMatch(
      /PRIVATE|secret|cost|thinking|signature/,
    );
  });

  it("deduplicates assistant snapshots and never counts placeholder output", () => {
    const collector = createUsageCollector({ now });
    collector.modelRecord(serialized(assistant("msg_1")));
    collector.modelRecord(serialized(assistant("msg_1")));
    collector.modelRecord(
      serialized({
        ...assistant("child", api(800, 1, 3000, 0)),
        parent_tool_use_id: "agent-tool",
      }),
    );
    collector.modelRecord(serialized(assistant("msg_2", api(30, 1, 600, 0))));
    expect(collector.snapshot()).toMatchObject({
      inputTokens: 50,
      outputTokens: null,
      cacheReadInputTokens: 1000,
      cacheCreationInputTokens: 100,
      totalTokens: 1150,
      complete: false,
    });
  });

  it("reads real cumulative streaming output once and preserves it on interruption", () => {
    const collector = createUsageCollector({ now });
    const stream = (event: object) =>
      collector.modelRecord(
        serialized({ type: "stream_event", event, parent_tool_use_id: null }),
      );
    stream({ type: "message_start", message: { id: "msg_1", usage: api() } });
    stream({
      type: "content_block_delta",
      delta: { type: "thinking_delta", thinking: "DO NOT RETAIN" },
    });
    stream({ type: "message_delta", usage: { output_tokens: 17 } });
    stream({ type: "message_delta", usage: { output_tokens: 17 } });
    stream({ type: "message_delta", usage: { output_tokens: 20 } });
    stream({ type: "message_stop" });
    collector.modelRecord(serialized(assistant("msg_1")));
    expect(collector.snapshot()).toMatchObject({
      inputTokens: 20,
      outputTokens: 20,
      cacheReadInputTokens: 400,
      cacheCreationInputTokens: 100,
      totalTokens: 540,
      complete: false,
    });
    expect(JSON.stringify(collector.snapshot())).not.toContain("DO NOT RETAIN");
  });

  it("captures error-result model totals and does not erase known usage with a crash's zeroed counters", () => {
    const collector = createUsageCollector({ now });
    collector.modelRecord(
      serialized({ ...result(), subtype: "error_max_turns", is_error: true }),
    );
    expect(collector.snapshot()).toMatchObject({
      totalTokens: 527,
      complete: true,
    });
    collector.modelRecord(
      serialized({
        ...result({ "claude-sonnet-4-6": model(0, 0, 0, 0) }),
        usage: api(0, 0, 0, 0),
        subtype: "error_during_execution",
        is_error: true,
      }),
    );
    expect(collector.snapshot()).toMatchObject({
      totalTokens: 527,
      complete: false,
    });
    const interrupted = createUsageCollector({ now });
    interrupted.modelRecord(serialized(assistant("msg_1")));
    interrupted.modelRecord(
      serialized({
        type: "result",
        subtype: "error_during_execution",
        usage: api(0, 0, 0, 0),
      }),
    );
    expect(interrupted.snapshot()).toMatchObject({
      inputTokens: 20,
      outputTokens: null,
      totalTokens: 520,
      complete: false,
    });
  });

  it("distinguishes provider-reported zero, partial nulls, and absent usage", () => {
    expect(createUsageCollector().snapshot()).toBeUndefined();
    expect(parseClaudeUsage({ type: "result", usage: {} })).toBeUndefined();
    expect(
      parseClaudeUsage(result({ "claude-sonnet-4-6": model(0, 0, 0, 0) })),
    ).toMatchObject({
      totalTokens: 0,
      complete: true,
      inputTokens: 0,
      outputTokens: 0,
    });
    expect(
      parseClaudeUsage({
        type: "result",
        usage: { input_tokens: 4, output_tokens: 0 },
      }),
    ).toEqual({
      inputTokens: 4,
      outputTokens: 0,
      cacheReadInputTokens: null,
      cacheCreationInputTokens: null,
      totalTokens: 4,
      complete: false,
    });
  });

  it("marks main-loop result usage incomplete and accounts for cache buckets only once", () => {
    const value = parseClaudeUsage(
      serialized({
        type: "result",
        usage: {
          ...api(10, 9, 200, 100),
          cache_creation: {
            ephemeral_5m_input_tokens: 80,
            ephemeral_1h_input_tokens: 20,
          },
        },
      }),
    );
    expect(value).toEqual({
      inputTokens: 10,
      outputTokens: 9,
      cacheReadInputTokens: 200,
      cacheCreationInputTokens: 100,
      totalTokens: 319,
      complete: false,
    });
  });

  it.each([-1, 1.25, "3", Number.MAX_SAFE_INTEGER + 1, NaN, Infinity])(
    "rejects malformed token counts: %s",
    (count) => {
      expect(
        parseClaudeUsage({
          type: "result",
          usage: { ...api(), input_tokens: count },
        }),
      ).toBeUndefined();
    },
  );

  it("rejects overflowing totals and excludes untrusted model labels", () => {
    expect(
      parseClaudeUsage({
        type: "result",
        usage: api(Number.MAX_SAFE_INTEGER, 7, 0, 0),
      }),
    ).toBeUndefined();
    expect(
      parseClaudeUsage(result({ "API_KEY=DO_NOT_PERSIST": model() })),
    ).not.toHaveProperty("model");
    expect(parseClaudeUsage(result())).toMatchObject({
      model: "claude-sonnet-4-6",
    });
    expect(
      parseClaudeUsage({
        type: "result",
        modelUsage: { "claude-sonnet-4-6": { inputTokens: 10 } },
      }),
    ).toMatchObject({ inputTokens: 10, outputTokens: null, complete: false });
  });

  it("exports the exact parser for isolated planner programs without dependencies", () => {
    const embedded = runInNewContext(
      `(${parseClaudeUsage.toString()})`,
    ) as typeof parseClaudeUsage;
    expect(embedded(serialized(result()))).toEqual(parseClaudeUsage(result()));
    expect(embedded({ type: "result", usage: api() })).toEqual(
      parseClaudeUsage({ type: "result", usage: api() }),
    );
  });

  it("bounds per-message fallback memory without claiming complete coverage", () => {
    const collector = createUsageCollector({ now });
    for (let index = 0; index < 3000; index++)
      collector.modelRecord(assistant(`msg_${index}`, api(1, 1, 0, 0)));
    expect(collector.snapshot()).toMatchObject({
      inputTokens: 2048,
      outputTokens: null,
      totalTokens: 2048,
      complete: false,
    });
    collector.modelRecord(result());
    expect(collector.snapshot()).toMatchObject({
      totalTokens: 527,
      complete: true,
    });
  });
});

describe("bounded sanitized usage artifact", () => {
  const directory = () => {
    const value = mkdtempSync(join(tmpdir(), "gremlins-usage-test-"));
    roots.push(value);
    return value;
  };
  const snapshot = () => {
    const collector = createUsageCollector({ now });
    collector.modelRecord(result());
    return collector.snapshot()!;
  };

  it("writes only allowed counters and metadata, replacing model-written content", () => {
    const root = directory();
    writeFileSync(join(root, "usage.json"), '{"prompt":"PRIVATE"}');
    const value = {
      ...snapshot(),
      thinking: "PRIVATE",
      apiKey: "SECRET",
      transcript: "x".repeat(MAX_USAGE_BYTES * 2),
    };
    writeUsageArtifact(root, value);
    const bytes = readFileSync(join(root, "usage.json"));
    expect(bytes.length).toBeLessThanOrEqual(MAX_USAGE_BYTES);
    expect(JSON.parse(bytes.toString())).toEqual(snapshot());
    expect(bytes.toString()).not.toMatch(/PRIVATE|SECRET|transcript/);
    expect(readdirSync(root)).toEqual(["usage.json"]);
  });

  it("removes an invented usage artifact when the provider reported nothing", () => {
    const root = directory();
    writeFileSync(join(root, "usage.json"), JSON.stringify(snapshot()));
    writeUsageArtifact(root, undefined);
    expect(existsSync(join(root, "usage.json"))).toBe(false);
  });

  it("replaces hard links without changing the linked file and rejects unsafe metadata", () => {
    const root = directory(),
      sentinel = join(root, "sentinel.txt");
    writeFileSync(sentinel, "unchanged");
    linkSync(sentinel, join(root, "usage.json"));
    writeUsageArtifact(root, snapshot());
    expect(readFileSync(sentinel, "utf8")).toBe("unchanged");
    expect(() =>
      writeUsageArtifact(root, {
        ...snapshot(),
        reportedAt: "x".repeat(MAX_USAGE_BYTES + 1),
      }),
    ).toThrow("timestamp");
    expect(() =>
      writeUsageArtifact(root, { ...snapshot(), inputTokens: -1 }),
    ).toThrow("counters");
    expect(() =>
      writeUsageArtifact(root, {
        ...snapshot(),
        outputTokens: null,
        complete: true,
      } as UsageArtifact),
    ).toThrow("total");
  });
});

describe("worker artifact transfer", () => {
  async function readArtifacts(
    files: Record<string, Buffer>,
    args: string[] = [],
  ) {
    const source = readFileSync(
      new URL("../../runner-local/artifacts.mjs", import.meta.url),
      "utf8",
    ).replace(/^import .+;\r?\n/gm, "");
    let output = "";
    const process = {
      argv: ["node", "artifacts.mjs", ...args],
      env: {},
      exitCode: 0,
      stdout: {
        write: (value: string) => {
          output += value;
        },
      },
    };
    await runInNewContext(`(async () => {${source}})()`, {
      process,
      Buffer,
      createHash,
      ...posix,
      console: {
        log: (value: string) => {
          output += value;
        },
        error() {},
      },
      lstat: async (file: string) => {
        const data =
          file === "/output/.sanitized"
            ? Buffer.from("complete")
            : files[posix.basename(file)];
        if (!data) throw new Error("Missing");
        return {
          isSymbolicLink: () => false,
          isFile: () => true,
          size: data.length,
        };
      },
      realpath: async (file: string) => file,
      readFile: async (file: string) => files[posix.basename(file)],
      readdir: async () =>
        Object.keys(files).map((name) => ({
          name,
          isSymbolicLink: () => false,
          isDirectory: () => false,
          isFile: () => true,
        })),
    });
    return { output, exitCode: process.exitCode };
  }

  it("prioritizes usage when ordinary artifacts fill the transfer limit", async () => {
    const files = Object.fromEntries(
      Array.from({ length: 110 }, (_, index) => [
        `file-${index}.txt`,
        Buffer.from("artifact"),
      ]),
    );
    files["usage.json"] = Buffer.from("{}");
    const { output } = await readArtifacts(files);
    const parsed = JSON.parse(output) as { files: { name: string }[] };
    expect(parsed.files).toHaveLength(100);
    expect(parsed.files[0]!.name).toBe("usage.json");
  });

  it("enforces the dedicated usage bound for reads and listings", async () => {
    const files = { "usage.json": Buffer.alloc(MAX_USAGE_BYTES + 1) };
    const listing = await readArtifacts(files);
    expect(JSON.parse(listing.output).files).toEqual([]);
    expect((await readArtifacts(files, ["read", "usage.json"])).exitCode).toBe(
      1,
    );
    const valid = await readArtifacts({ "usage.json": Buffer.from("{}") }, [
      "read",
      "usage.json",
    ]);
    expect(Buffer.from(valid.output, "base64").toString()).toBe("{}");
  });
});

describe("Claude subprocess integration", () => {
  it("still sanitizes successful output when token reporting cannot be saved", () => {
    const source = readFileSync(
      new URL("../../runner-local/job.mjs", import.meta.url),
      "utf8",
    );
    const output = new Map([["/output/result.json", '{"detail":"PRIVATE"}']]);
    const processState = { exitCode: 0 };
    runInNewContext(source.slice(source.lastIndexOf("} finally {") + 10), {
      process: processState,
      clearLease() {},
      clearDeadline() {},
      usage: { snapshot: () => undefined },
      writeUsageArtifact() {
        throw new Error("Usage storage unavailable");
      },
      join: posix.join,
      readdirSync: () => [
        {
          name: "result.json",
          isSymbolicLink: () => false,
          isDirectory: () => false,
          isFile: () => true,
        },
      ],
      lstatSync: () => ({ size: 20 }),
      readFileSync: (file: string) => output.get(file),
      writeFileSync: (file: string, text: string) => output.set(file, text),
      redact: (text: string) => text.replaceAll("PRIVATE", "[redacted]"),
    });
    expect(processState.exitCode).toBe(0);
    expect(output.get("/output/result.json")).toContain("[redacted]");
    expect(output.get("/output/.sanitized")).toBe("complete\n");
  });

  function runtime() {
    const source = readFileSync(
      new URL("../../runner-local/job.mjs", import.meta.url),
      "utf8",
    );
    const start = source.indexOf(
      "async function run(command, args, options = {}) {",
    );
    const end = source.indexOf('let kind = "unknown";', start);
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
    });
    const collector = createUsageCollector({ now });
    const records: unknown[] = [],
      logs: string[] = [];
    const run = runInNewContext(source.slice(start, end) + "\nrun", {
      stopping: false,
      current: undefined,
      spawn: () => child,
      process: { env: {} },
      usage: collector,
      activity: {
        emit() {},
        modelRecord: (value: unknown) => records.push(value),
      },
      log: (line: string) => logs.push(line),
    }) as (
      command: string,
      args: string[],
      options: { model?: boolean },
    ) => Promise<string>;
    return { child, collector, records, logs, run };
  }

  it("captures a final JSON envelope without a newline and ignores stderr usage", async () => {
    const f = runtime();
    const promise = f.run("claude", [], { model: true });
    f.child.stderr.emit(
      "data",
      Buffer.from(
        JSON.stringify(result({ "claude-sonnet-4-6": model(9999) })) + "\n",
      ),
    );
    f.child.stderr.emit("end");
    const output = JSON.stringify(result());
    f.child.stdout.emit("data", Buffer.from(output.slice(0, 40)));
    f.child.stdout.emit("data", Buffer.from(output.slice(40)));
    f.child.stdout.emit("end");
    f.child.emit("close", 0);
    await expect(promise).resolves.toBe(output);
    expect(f.collector.snapshot()).toMatchObject({
      totalTokens: 527,
      complete: true,
    });
    expect(f.logs).toEqual([]);
  });

  it("retains usage when Claude exits unsuccessfully and ignores non-model command output", async () => {
    const f = runtime();
    const failed = f.run("claude", [], { model: true });
    const check = expect(failed).rejects.toThrow("A job command failed");
    f.child.stdout.emit(
      "data",
      Buffer.from(JSON.stringify({ ...result(), is_error: true }) + "\n"),
    );
    f.child.stdout.emit("end");
    f.child.emit("close", 1);
    await check;
    expect(f.collector.snapshot()).toMatchObject({ totalTokens: 527 });
    const ordinary = runtime();
    const finished = ordinary.run("test-command", [], {});
    ordinary.child.stdout.emit(
      "data",
      Buffer.from(JSON.stringify(result()) + "\n"),
    );
    ordinary.child.stdout.emit("end");
    ordinary.child.emit("close", 0);
    await finished;
    expect(ordinary.collector.snapshot()).toBeUndefined();
  });
});
