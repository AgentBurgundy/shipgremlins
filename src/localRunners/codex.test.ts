import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  prepareCodexInvocation,
  codexWorkerAuth,
  codexToolHostUnavailable,
  CodexToolHostError,
} from "../../runner-local/codex.mjs";
import {
  createReadonlyTools,
  READONLY_TOOLS,
} from "../../runner-local/codex-readonly.mjs";
import { createActivityWriter } from "../../runner-local/activity.mjs";
import {
  createUsageCollector,
  parseCodexUsage,
  writeUsageArtifact,
} from "../../runner-local/usage.mjs";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function world() {
  const root = mkdtempSync(
    join(realpathSync(tmpdir()), "gremlins-codex-test-"),
  );
  roots.push(root);
  const repository = join(root, "repository"),
    memory = join(root, "memory");
  mkdirSync(repository);
  mkdirSync(memory);
  const authJson = JSON.stringify({
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens: {
      id_token: "private-id",
      access_token: "private-access",
      refresh_token: "private-refresh",
      account_id: "account-1",
    },
  });
  return { root, repository, memory, authJson };
}
const usage = {
  type: "turn.completed",
  usage: {
    input_tokens: 1000,
    cached_input_tokens: 800,
    output_tokens: 90,
    reasoning_output_tokens: 60,
  },
};

describe("isolated subscription Codex runtime", () => {
  it("recognizes unavailable native tool hosts without treating model or MCP prose as startup proof", () => {
    for (const message of [
      "Code Mode is unavailable because code-mode host is disabled. Falling back to direct tools.",
      "Code Mode is unavailable because host executable was not found.",
      "code-mode host is disabled",
    ]) {
      expect(
        codexToolHostUnavailable({
          type: "item.completed",
          item: { type: "error", message },
        }),
      ).toBe(true);
      expect(
        codexToolHostUnavailable({
          type: "item.completed",
          item: { type: "agent_message", text: message },
        }),
      ).toBe(false);
      expect(
        codexToolHostUnavailable({
          type: "item.completed",
          item: { type: "mcp_tool_call", error: { message } },
        }),
      ).toBe(false);
    }
    expect(
      codexToolHostUnavailable({
        type: "item.completed",
        item: { type: "error", message: "A feature is deprecated." },
      }),
    ).toBe(false);
    expect(codexToolHostUnavailable(null)).toBe(false);
    expect(new CodexToolHostError().message).toContain(
      "verify the runner again",
    );
  });
  it("runs a fake executable with exact CLI schema, selected model and access-only private auth", () => {
    const w = world();
    const task = prepareCodexInvocation({
      selection: { provider: "codex", model: "chosen-model" },
      authJson: w.authJson,
      cwd: w.repository,
      directory: w.root,
      restricted: true,
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["answer"],
        properties: { answer: { type: "string" } },
      },
      env: {
        ...process.env,
        OPENAI_API_KEY: "never-bill",
        CODEX_API_KEY: "never-bill",
        CODEX_AUTH_JSON: w.authJson,
        CLAUDE_CODE_OAUTH_TOKEN: "other-provider",
      },
    });
    const executable = join(w.root, "fake-codex.mjs");
    writeFileSync(
      executable,
      `import {readFileSync,writeFileSync} from 'node:fs';
      import {join} from 'node:path';
      const args=process.argv.slice(2);
      const auth=JSON.parse(readFileSync(join(process.env.CODEX_HOME,'auth.json'),'utf8'));
      if(auth.auth_mode!=='chatgpt'||auth.tokens.refresh_token!==''||process.env.OPENAI_API_KEY||process.env.CODEX_API_KEY||process.env.CODEX_AUTH_JSON||process.env.CLAUDE_CODE_OAUTH_TOKEN) process.exit(9);
      if(!args.includes('--json')||!args.includes('--output-schema')||args.at(-1)!=='-')process.exit(10);
      const final={answer:'Verified fake response'};
      writeFileSync(args[args.indexOf('--output-last-message')+1],JSON.stringify(final));
      console.log(JSON.stringify({type:'item.completed',item:{type:'reasoning',text:'PRIVATE REASONING'}}));
      console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'Verified fake response'}}));
      console.log(${JSON.stringify(JSON.stringify(usage))});
    `,
    );
    const run = spawnSync(process.execPath, [executable, ...task.args], {
      env: task.env,
      input: "Bounded task",
      encoding: "utf8",
    });
    expect(run.status, run.stderr).toBe(0);
    expect(JSON.parse(task.readResult())).toEqual({
      answer: "Verified fake response",
    });
    expect(
      task.args.slice(
        task.args.indexOf("--model"),
        task.args.indexOf("--model") + 2,
      ),
    ).toEqual(["--model", "chosen-model"]);
    const activity: string[] = [];
    const writer = createActivityWriter({
      provider: "codex",
      write: (line) => activity.push(line),
    });
    const collector = createUsageCollector({
      provider: "codex",
      model: "chosen-model",
    });
    for (const line of run.stdout.trim().split("\n")) {
      const event = JSON.parse(line);
      writer.modelRecord(event);
      collector.modelRecord(event);
    }
    expect(activity.join("\n")).not.toMatch(
      /PRIVATE|private-access|private-refresh/,
    );
    expect(writer.summary()).toBe("Verified fake response");
    expect(collector.snapshot()).toMatchObject({
      source: "codex",
      model: "chosen-model",
      inputTokens: 200,
      cacheReadInputTokens: 800,
      outputTokens: 90,
      cacheCreationInputTokens: null,
      totalTokens: 1090,
      complete: false,
    });
    writeUsageArtifact(w.root, collector.snapshot());
    expect(
      JSON.parse(readFileSync(join(w.root, "usage.json"), "utf8")),
    ).toMatchObject({
      source: "codex",
      cacheCreationInputTokens: null,
      totalTokens: 1090,
    });
    const home = task.home;
    task.cleanup();
    expect(existsSync(home)).toBe(false);
  });

  it("keeps discovery outside repository config and exposes only constrained reads and search", () => {
    const w = world();
    mkdirSync(join(w.repository, ".codex"));
    writeFileSync(
      join(w.repository, ".codex/config.toml"),
      "[features]\nshell_tool=true\n",
    );
    const task = prepareCodexInvocation({
      authJson: w.authJson,
      cwd: w.repository,
      directory: w.root,
      restricted: true,
      readonlyRoots: { repository: w.repository, memory: w.memory },
    });
    const config = readFileSync(join(task.home, "config.toml"), "utf8");
    expect(task.args[task.args.indexOf("--cd") + 1]).not.toBe(w.repository);
    for (const feature of [
      "shell_tool",
      "unified_exec",
      "js_repl",
      "apply_patch_freeform",
      "multi_agent",
      "plugins",
      "hooks",
    ])
      expect(config).toContain(`${feature} = false`);
    expect(config).toContain("code_mode = true");
    expect(config).toContain("code_mode_host = true");
    expect(config).toContain(
      'enabled_tools = ["read_file", "list_files", "search_files"]',
    );
    expect(config).toContain("required = true");
    expect(config).not.toContain("private-access");
    expect(task.args).not.toContain("--model");
    task.cleanup();
    expect(() =>
      prepareCodexInvocation({
        authJson: w.authJson,
        cwd: w.repository,
        directory: w.root,
        restricted: true,
        mcpServers: { injected: { command: "sh", args: ["-c", "untrusted"] } },
      }),
    ).toThrow("cannot add tools");
  });

  it("rejects API credentials, malformed selected models and model-written linked results", () => {
    const w = world();
    expect(() =>
      codexWorkerAuth(
        JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: "key" }),
      ),
    ).toThrow("API billing");
    expect(() =>
      prepareCodexInvocation({
        authJson: w.authJson,
        cwd: w.repository,
        directory: w.root,
        selection: { provider: "codex", model: "model\nshell_tool=true" },
      }),
    ).toThrow();
    const task = prepareCodexInvocation({
      authJson: w.authJson,
      cwd: w.repository,
      directory: w.root,
    });
    const external = join(w.root, "external.txt");
    writeFileSync(external, "Must not accept another inode's result.");
    linkSync(external, task.outputPath);
    expect(() => task.readResult()).toThrow("bounded final response");
    task.cleanup();
  });
});

describe("Codex read-only capability", () => {
  it("offers no write/exec tools and rejects escapes, linked files, auth and source CLI config", () => {
    const w = world();
    writeFileSync(
      join(w.repository, "app.ts"),
      "export const title = 'ShipGremlins';\n",
    );
    writeFileSync(join(w.memory, "mandate.md"), "Owner mandate");
    const tools = createReadonlyTools(w);
    expect(READONLY_TOOLS.map((tool) => tool.name)).toEqual([
      "read_file",
      "list_files",
      "search_files",
    ]);
    expect(
      tools("read_file", { root: "repository", path: "app.ts" }),
    ).toContain("ShipGremlins");
    expect(
      JSON.parse(
        tools("search_files", { root: "repository", query: "ShipGremlins" }),
      ).matches[0],
    ).toMatchObject({ path: "app.ts", line: 1 });
    for (const path of [
      "../auth.json",
      ".codex/config.toml",
      ".env",
      "auth.json",
    ])
      expect(() => tools("read_file", { root: "repository", path })).toThrow();
    const external = join(w.root, "outside.txt");
    writeFileSync(external, "private");
    linkSync(external, join(w.repository, "linked.txt"));
    expect(() =>
      tools("read_file", { root: "repository", path: "linked.txt" }),
    ).toThrow();
    expect(() =>
      tools("exec", { root: "repository", command: "node repo-script" }),
    ).toThrow();
    expect(() =>
      tools("list_files", { root: "repository", command: "untrusted" }),
    ).toThrow();
  });

  it("speaks the constrained stdio MCP contract without executing requested commands", () => {
    const w = world();
    const server = new URL(
      "../../runner-local/codex-readonly.mjs",
      import.meta.url,
    );
    const messages = [
      { id: 1, method: "initialize" },
      { id: 2, method: "tools/list" },
      {
        id: 3,
        method: "tools/call",
        params: { name: "exec", arguments: { command: "touch proof.txt" } },
      },
    ];
    const result = spawnSync(
      process.execPath,
      [server.pathname.replace(/^\/([A-Za-z]:)/, "$1"), w.repository, w.memory],
      {
        input: messages.map((value) => JSON.stringify(value)).join("\n") + "\n",
        encoding: "utf8",
      },
    );
    expect(result.status, result.stderr).toBe(0);
    const replies = result.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(replies[1].result.tools).toHaveLength(3);
    expect(replies[2].result.isError).toBe(true);
    expect(readdirSync(w.repository)).toEqual([]);
  });
});

describe("Codex usage and public activity", () => {
  it("deduplicates completed-turn counters without adding cached input or reasoning twice", () => {
    const collector = createUsageCollector({ provider: "codex" });
    collector.modelRecord(usage);
    collector.modelRecord(usage);
    collector.modelRecord({
      type: "item.completed",
      item: { type: "reasoning", text: "private" },
    });
    expect(collector.snapshot()).toMatchObject({
      totalTokens: 1090,
      inputTokens: 200,
      outputTokens: 90,
      cacheReadInputTokens: 800,
      cacheCreationInputTokens: null,
      complete: false,
    });
    expect(
      parseCodexUsage({
        type: "turn.completed",
        usage: { input_tokens: 10, cached_input_tokens: 11, output_tokens: 1 },
      }),
    ).toBeUndefined();
    expect(
      parseCodexUsage({
        type: "turn.completed",
        usage: { input_tokens: 10, output_tokens: 1 },
      }),
    ).toMatchObject({
      inputTokens: null,
      cacheReadInputTokens: null,
      cacheCreationInputTokens: null,
      complete: false,
    });
  });

  it("publishes allowlisted tool actions and final messages, omitting raw results and reasoning", () => {
    const events: string[] = [];
    const activity = createActivityWriter({
      provider: "codex",
      write: (value) => events.push(value),
    });
    for (const record of [
      {
        type: "item.completed",
        item: { type: "reasoning", text: "PRIVATE REASONING" },
      },
      {
        type: "item.started",
        item: {
          type: "mcp_tool_call",
          server: "playwright",
          tool: "browser_snapshot",
          arguments: { token: "PRIVATE TOKEN" },
        },
      },
      {
        type: "item.completed",
        item: {
          type: "mcp_tool_call",
          status: "completed",
          result: { thinking: "PRIVATE RESULT" },
        },
      },
      {
        type: "item.completed",
        item: { type: "agent_message", text: "Checked the page." },
      },
      usage,
    ])
      activity.modelRecord(record);
    expect(events.join("\n")).not.toContain("PRIVATE");
    expect(events.join("\n")).toContain("browser_snapshot");
    expect(activity.summary()).toBe("Checked the page.");
  });
});
