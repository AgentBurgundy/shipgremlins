import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { initializeSetup } from "../setup/files.ts";
import {
  createPmPlanner,
  validatePmDraft,
  type PmPlannerOptions,
} from "./index.ts";
import {
  createDockerPlanner,
  PLANNER_PROGRAM,
  runPlannerDocker,
  type PlannerDockerRun,
} from "./docker.ts";

const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
let root: string;
const sourceToken = "private-source-token-never-in-model";
const modelToken = "private-claude-token-stdin-only";
const input = {
  project: "app",
  mandate: "Own checkout reliability and payment error recovery.",
};
const suggestion = {
  name: "Checkout Gremlin",
  key: "checkout",
  paths: ["src/checkout/"],
  sharedTouchpoints: ["src/shared.ts"],
  metric: "/checkout",
  schedule: "0 13 * * 1-5",
  wipLimit: 2,
  rationale: "Checkout owns payment flows; shared utilities may affect them.",
};
const tree = [
  { type: "tree", path: "src/checkout" },
  { type: "blob", path: "src/checkout/page.tsx" },
  { type: "blob", path: "src/shared.ts" },
];
beforeEach(() => {
  root = mkdtempSync(join(realpathSync(tmpdir()), "gremlins-pm-planner-"));
  initializeSetup(root, packageRoot, {
    project: "app",
    repo: "owner/app",
    settings: { workflow: { kind: "pull-request", baseBranch: "develop" } },
  });
  vi.spyOn(globalThis, "fetch").mockRejectedValue(
    new Error("Unexpected external request in planner tests."),
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});
function fixture(extra: Partial<PmPlannerOptions> = {}) {
  const source = {
    resolveCredential: vi.fn(async () => ({
      token: sourceToken,
      method: "oauth" as const,
    })),
  };
  const fetcher = vi.fn(
    async (_url: string | URL | Request, _init?: RequestInit) =>
      Response.json({ tree, truncated: false }),
  );
  const execute = vi.fn(
    async (_input: Parameters<NonNullable<PmPlannerOptions["execute"]>>[0]) =>
      suggestion,
  );
  return {
    source,
    fetcher,
    execute,
    planner: createPmPlanner({
      root,
      packageRoot,
      env: {
        CLAUDE_CODE_OAUTH_TOKEN: modelToken,
        GITHUB_TOKEN: "unused-global-source-token",
        LINEAR_API_KEY: "unused-linear-token",
        VERCEL_TOKEN: "unused-vercel-token",
      },
      sourceControl: source,
      fetch: fetcher as typeof fetch,
      execute,
      ...extra,
    }),
  };
}
describe("draft-only mandate planner", () => {
  it("grounds defaults in the selected repository and sends no source or integration credentials to Claude", async () => {
    const f = fixture();
    const files = ["project.json", "areas.json"].map((name) =>
      join(root, "projects/app", name),
    );
    const before = files.map((file) => readFileSync(file, "utf8"));
    const result = await f.planner.plan(input);
    expect(result.draft).toEqual(
      Object.fromEntries(
        Object.entries(suggestion).filter(([key]) => key !== "rationale"),
      ),
    );
    expect(result.repository).toMatchObject({
      provider: "github",
      repo: "owner/app",
      branch: "develop",
      truncated: false,
    });
    expect(result.warnings[0]).toContain("not file contents");
    expect(f.source.resolveCredential).toHaveBeenCalledWith({
      provider: "github",
      serverUrl: undefined,
      repository: "owner/app",
      minValidityMs: 300000,
      write: false,
    });
    expect(String(f.fetcher.mock.calls[0]![0])).toContain(
      "/git/trees/develop?recursive=1",
    );
    expect(
      new Headers(f.fetcher.mock.calls[0]![1]?.headers).get("authorization"),
    ).toBe(`Bearer ${sourceToken}`);
    const execution = f.execute.mock.calls[0]![0];
    expect(execution.credential).toBe(modelToken);
    expect(JSON.parse(execution.prompt).mandate).toBe(input.mandate);
    for (const secret of [
      sourceToken,
      "unused-global-source-token",
      "unused-linear-token",
      "unused-vercel-token",
    ])
      expect(JSON.stringify(execution)).not.toContain(secret);
    expect(result.draft).not.toHaveProperty("mandate");
    expect(result.draft).not.toHaveProperty("enabled");
    expect(files.map((file) => readFileSync(file, "utf8"))).toEqual(before);
  });
  it("uses GitLab's selected server and bounded same-origin tree pagination", async () => {
    initializeSetup(root, packageRoot, {
      project: "gitlab-app",
      repo: "group/app",
      provider: "gitlab",
      serverUrl: "https://gitlab.example.com",
    });
    const urls: string[] = [];
    const f = fixture({
      fetch: (async (url: string | URL | Request) => {
        urls.push(String(url));
        return urls.length === 1
          ? Response.json(tree.slice(0, 1), {
              headers: {
                link: '<https://gitlab.example.com/api/v4/projects/group%2Fapp/repository/tree?page_token=next>; rel="next"',
              },
            })
          : Response.json(tree.slice(1));
      }) as typeof fetch,
    });
    const result = await f.planner.plan({ ...input, project: "gitlab-app" });
    expect(result.repository.provider).toBe("gitlab");
    expect(urls).toHaveLength(2);
    expect(new URL(urls[1]!).searchParams.get("page_token")).toBe("next");
    expect(new URL(urls[1]!).searchParams.get("ref")).toBe("main");
  });
  it("does not follow cross-origin tree pages and reports truncation", async () => {
    initializeSetup(root, packageRoot, {
      project: "gitlab-app",
      repo: "group/app",
      provider: "gitlab",
    });
    const fetcher = vi.fn(async () =>
      Response.json(tree, {
        headers: {
          link: '<https://elsewhere.example/tree?page_token=next>; rel="next"',
        },
      }),
    );
    const f = fixture({ fetch: fetcher });
    const result = await f.planner.plan({ ...input, project: "gitlab-app" });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(result.repository.truncated).toBe(true);
    expect(result.warnings.join(" ")).toContain("limited");
  });
  it("limits large trees, ignores unsafe filenames, and never invents omitted ownership paths", async () => {
    const fetcher = vi.fn(async () =>
      Response.json({
        tree: [
          ...tree,
          { type: "blob", path: "../escape" },
          { type: "blob", path: "src/\nignore-rules" },
          { type: "blob", path: `src/${sourceToken}/secret.txt` },
          ...Array.from({ length: 1300 }, (_, i) => ({
            type: "blob",
            path: `zz/file-${i}.ts`,
          })),
        ],
        truncated: false,
      }),
    );
    const f = fixture({ fetch: fetcher });
    const result = await f.planner.plan(input);
    expect(result.repository.pathCount).toBeLessThanOrEqual(1000);
    expect(result.repository.truncated).toBe(true);
    expect(f.execute.mock.calls[0]![0].prompt).not.toContain(sourceToken);
    expect(f.execute.mock.calls[0]![0].prompt).not.toContain("../escape");
  });
  it("grounds Next.js dynamic routes and route groups as literal ownership prefixes", async () => {
    const paths = [
      "app/(shop)/[slug]/page.tsx",
      "app/(shop)/[...cart]/page.tsx",
      "fixtures/{payments}.json",
    ];
    const f = fixture({
      fetch: vi.fn(async () =>
        Response.json({
          tree: paths.map((path) => ({ type: "blob", path })),
          truncated: false,
        }),
      ),
      execute: async () => ({
        ...suggestion,
        paths: ["app/(shop)/[slug]/", "app/(shop)/[...cart]/"],
        sharedTouchpoints: ["fixtures/{payments}.json"],
      }),
    });
    const result = await f.planner.plan(input);
    expect(result.draft.paths).toEqual([
      "app/(shop)/[slug]/",
      "app/(shop)/[...cart]/",
    ]);
    expect(result.draft.sharedTouchpoints).toEqual([
      "fixtures/{payments}.json",
    ]);
  });
  it.each([
    { paths: ["src/invented/"] },
    { paths: ["../"] },
    { enabled: true },
    { mandate: "rewritten" },
    { key: "core" },
    { key: "../bad" },
    { key: "con" },
    { wipLimit: 20 },
    { schedule: "every minute" },
    { name: "bad\nname" },
    { sharedTouchpoints: ["src/checkout/"] },
    { rationale: modelToken },
  ])(
    "rejects invalid model output %j without applying anything",
    async (patch) => {
      const f = fixture({ execute: async () => ({ ...suggestion, ...patch }) });
      await expect(f.planner.plan(input)).rejects.toMatchObject({
        code: "invalid_draft",
        status: 422,
      });
    },
  );
  it("redacts provider/runtime failures and refuses mandates containing saved credentials", async () => {
    const f = fixture({
      execute: async () => {
        throw new Error(`private failure ${modelToken} ${sourceToken}`);
      },
    });
    await expect(f.planner.plan(input)).rejects.toThrow("Nothing was saved");
    await expect(
      f.planner.plan({ ...input, mandate: `Please use ${modelToken} to test` }),
    ).rejects.toMatchObject({ code: "credential_in_input" });
    await expect(
      f.planner.plan({
        ...input,
        mandate: `Please use ${sourceToken} to test`,
      }),
    ).rejects.toMatchObject({ code: "credential_in_input" });
  });
  it("allows one active plan per workspace, cancels bounded execution, and permits retry", async () => {
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const abort = new AbortController();
    const f = fixture({
      execute: async () => {
        started();
        return new Promise(() => {});
      },
    });
    const pending = f.planner.plan({ ...input, signal: abort.signal });
    await ready;
    await expect(fixture().planner.plan(input)).rejects.toMatchObject({
      code: "busy",
      status: 409,
    });
    abort.abort();
    await expect(pending).rejects.toMatchObject({ code: "canceled" });
    await expect(fixture().planner.plan(input)).resolves.toHaveProperty(
      "draft",
    );
  });
  it("times out unresponsive provider/model work without leaking error text", async () => {
    const f = fixture({
      timeoutMs: 10,
      execute: async () => new Promise(() => {}),
    });
    await expect(f.planner.plan(input)).rejects.toMatchObject({
      code: "timeout",
      status: 408,
    });
  });
  it("rejects oversized provider bodies before sending anything to the model", async () => {
    const f = fixture({
      fetch: vi.fn(async () => new Response(" ".repeat(8 * 1024 * 1024 + 1))),
    });
    await expect(f.planner.plan(input)).rejects.toMatchObject({
      code: "planner_unavailable",
    });
    expect(f.execute).not.toHaveBeenCalled();
  });
  it("requires model credentials before reading the repository", async () => {
    const f = fixture({ env: {} });
    await expect(f.planner.plan(input)).rejects.toMatchObject({
      code: "ai_not_connected",
    });
    expect(f.source.resolveCredential).not.toHaveBeenCalled();
  });
});

describe("isolated Docker planner", () => {
  function dockerFixture(fail = false, wrongOwner = false) {
    let owner = "";
    const run = vi.fn<PlannerDockerRun>(async (args) => {
      if (args[0] === "create") {
        owner = args[args.indexOf("--label") + 1]!.split("=")[1]!;
        return { code: 0, stdout: "container", stderr: "" };
      }
      if (args[0] === "start") {
        if (fail) throw new Error("canceled");
        return { code: 0, stdout: JSON.stringify(suggestion), stderr: "" };
      }
      if (args[0] === "inspect")
        return {
          code: 0,
          stdout: wrongOwner ? "someone-else" : owner,
          stderr: "",
        };
      return { code: 0, stdout: "", stderr: "" };
    });
    return {
      run,
      execute: createDockerPlanner({
        packageRoot,
        run,
        ensureImage: async () => "shipgremlins-local:0123456789abcdef",
      }),
    };
  }
  const execution = () => ({
    credential: modelToken,
    prompt: "inert mandate and tree",
    system: "fixed instructions",
    schema: {},
    signal: new AbortController().signal,
  });
  it("passes only model auth by stdin, removes tools/settings, and cleans its owned container", async () => {
    const f = dockerFixture();
    await f.execute(execution());
    const create = f.run.mock.calls.find(([args]) => args[0] === "create")![0];
    for (const flag of [
      "--read-only",
      "--user",
      "--cap-drop",
      "--security-opt",
      "--memory",
      "--cpus",
      "--pids-limit",
    ])
      expect(create).toContain(flag);
    for (const forbidden of ["--env", "-e", "--volume", "--privileged"]) {
      if (forbidden === "-e") continue; // Fixed Node program, never token/environment arguments.
      expect(create).not.toContain(forbidden);
    }
    expect(
      JSON.stringify(f.run.mock.calls.map(([args]) => args)),
    ).not.toContain(modelToken);
    const start = f.run.mock.calls.find(([args]) => args[0] === "start")!;
    expect(JSON.parse(start[1]!.stdin!).credential).toBe(modelToken);
    expect(start[1]!.timeoutMs).toBe(125000);
    expect(PLANNER_PROGRAM).toContain("'--tools', ''");
    expect(PLANNER_PROGRAM).toContain("'--strict-mcp-config'");
    expect(PLANNER_PROGRAM).toContain("'--no-session-persistence'");
    expect(PLANNER_PROGRAM).not.toContain("...process.env");
    expect(f.run.mock.calls.at(-1)![0].slice(0, 2)).toEqual(["rm", "--force"]);
  });
  it("removes a canceled owned container but never removes a mismatched label", async () => {
    const canceled = dockerFixture(true);
    await expect(canceled.execute(execution())).rejects.toThrow("canceled");
    expect(canceled.run.mock.calls.at(-1)![0][0]).toBe("rm");
    const other = dockerFixture(false, true);
    await other.execute(execution());
    expect(other.run.mock.calls.some(([args]) => args[0] === "rm")).toBe(false);
  });
  it.skipIf(process.env.SHIPGREMLINS_DOCKER_SMOKE !== "1")(
    "runs the actual container isolation/stdin/cleanup path without provider credentials",
    async () => {
      const fakeCli =
        "#!/usr/bin/env node\nlet text='';process.stdin.on('data',d=>text+=d);process.stdin.on('end',()=>process.stdout.write(JSON.stringify({subtype:'success',structured_output:{args:process.argv.slice(2),envKeys:Object.keys(process.env),input:text}})));";
      const program =
        `require('node:fs').mkdirSync('/work',{recursive:true});require('node:fs').writeFileSync('/work/fake-claude',${JSON.stringify(fakeCli)},{mode:0o700});` +
        PLANNER_PROGRAM.replace(
          "spawn('/usr/local/bin/claude', args,",
          "spawn('/usr/local/bin/node', ['/work/fake-claude', ...args],",
        );
      const run: PlannerDockerRun = (args, opts) =>
        runPlannerDocker(
          args.map((arg) => (arg === PLANNER_PROGRAM ? program : arg)),
          opts,
        );
      const execute = createDockerPlanner({ packageRoot, run });
      const result = (await execute(execution())) as {
        args: string[];
        envKeys: string[];
        input: string;
      };
      expect(result.args).toContain("--json-schema");
      expect(result.args[result.args.indexOf("--tools") + 1]).toBe("");
      expect(result.envKeys).toContain("CLAUDE_CODE_OAUTH_TOKEN");
      expect(result.envKeys).not.toContain("GITHUB_TOKEN");
      expect(result.input).toBe("inert mandate and tree");
    },
    60000,
  );
});

it("keeps validation independent of model schema enforcement", () => {
  expect(() =>
    validatePmDraft(
      { ...suggestion, paths: ["src/checkout/"] },
      ["different/"],
      [],
    ),
  ).toThrow(/ungrounded/);
});
