import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { initializeSetup } from "../setup/files.ts";
import {
  createPmPlanner,
  PM_DRAFT_SCHEMA,
  validatePmDraft,
  type PmPlannerOptions,
} from "./index.ts";
import { loadProject } from "../config.ts";
import { createOnboardingStore } from "../projectOnboarding/store.ts";
import type { OnboardingReport } from "../projectOnboarding/types.ts";
import {
  CHARTER_LIST_FIELDS,
  CHARTER_TEXT_FIELDS,
  parsePmCharter,
} from "../pmCharter.ts";
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
  charter: {
    ambition: "A checkout customers can complete with confidence.",
    goal: "Reduce preventable checkout failures and make recovery clear.",
    metricDefinition:
      "Track the proposed /checkout completion outcome and reproduce payment failures. Confirm instrumentation and establish a baseline before setting a target.",
    users: ["Customers completing checkout, including guest customers."],
    expectedToBuild: [
      "Propose clearer recovery paths for failed payments with reproducible evidence.",
    ],
    nonGoals: ["Redesigning unrelated catalog or fulfillment workflows."],
    guardrails: [
      "Use test payments and avoid collecting payment credentials.",
      "Implementation requires owner approval; Done requires production delivery.",
    ],
    standingPriorities: [
      "Investigate failures that prevent completion before cosmetic improvements.",
      "Check guest and signed-in error recovery.",
    ],
  },
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
  it("reuses source-grounded crew evidence without another source scan and labels its age honestly", async () => {
    const report: OnboardingReport = {
      summary: "Checkout and account controls.",
      recommendation: "hosted",
      rationale: "Existing test preview.",
      stack: ["Node"],
      missingInputs: [],
      hosted: { provider: "url", instructions: [] },
      docker: null,
      proposedFiles: [],
      warnings: [],
      repository: {
        provider: "github",
        repo: "owner/app",
        branch: "develop",
        sha: "a".repeat(40),
        filesRead: ["src/checkout/page.tsx"],
        truncated: false,
      },
      projectSetup: {
        commands: {},
        firstPm: {
          name: "Checkout",
          mandate: input.mandate,
          evidence: [{ path: "src/checkout/page.tsx", quote: "retryPayment" }],
        },
      },
    };
    await createOnboardingStore(root).change("app", () => ({
      state: {
        schema: 1,
        project: "app",
        configurationRevision: "a".repeat(64),
        status: "analyzed",
        stage: "complete",
        message: "Inspected.",
        updatedAt: new Date().toISOString(),
        report,
      },
      result: undefined,
    }));
    const f = fixture(),
      result = await f.planner.plan(input),
      execution = f.execute.mock.calls[0]![0],
      prompt = JSON.parse(execution.prompt);
    expect(prompt.savedSourceInspection).toMatchObject({
      sha: "a".repeat(40),
      suggestedPms: [
        {
          name: "Checkout",
          evidence: [{ path: "src/checkout/page.tsx", quote: "retryPayment" }],
        },
      ],
    });
    expect(prompt.savedSourceInspection.limitations).toContain(
      "not a fresh review",
    );
    expect(result.warnings[0]).toContain("saved source excerpts at aaaaaaaa");
    expect(f.fetcher).toHaveBeenCalledTimes(1);
  });
  it("grounds new managed projects in owner-approved epics without granting approval during adoption", async () => {
    const file = join(root, "projects/app/project.json"),
      project = JSON.parse(readFileSync(file, "utf8"));
    project.workflow = {
      kind: "promotion",
      approvalPolicy: "epic",
      promotionBatchSize: 10,
    };
    writeFileSync(file, JSON.stringify(project));
    const f = fixture();
    await f.planner.plan(input);
    const execution = f.execute.mock.calls[0]![0];
    expect(execution.system).toContain(
      "owner approves an epic before coding begins",
    );
    expect(execution.system).toContain(
      "Do not request owner review of each in-scope child ticket",
    );
    expect(execution.system).toContain(
      "Adopting or activating this PM does not approve an epic",
    );
    expect(execution.system).not.toContain(
      "PM may self-approve finite implementation tickets",
    );
  });
  it.each(["promotion", "pull-request"] as const)(
    "grounds the planner's approval policy in %s without discarding owner limits",
    async (kind) => {
      const file = join(root, "projects/app/project.json");
      const project = JSON.parse(readFileSync(file, "utf8"));
      project.workflow =
        kind === "promotion" ? { kind } : { kind, baseBranch: "develop" };
      writeFileSync(file, JSON.stringify(project));
      const f = fixture();
      await f.planner.plan({
        ...input,
        mandate:
          "Review-only: investigate payment failures; do not implement changes.",
      });
      const execution = f.execute.mock.calls[0]![0];
      expect(JSON.parse(execution.prompt).mandate).toContain("Review-only");
      expect(execution.system).toContain(
        "Preserve explicit owner-authored limits",
      );
      if (kind === "promotion") {
        expect(execution.system).toContain(
          "PM may self-approve finite implementation tickets",
        );
        expect(execution.system).toContain("one combined promotion PR");
        expect(execution.system).not.toContain(
          "Keep per-ticket owner approval",
        );
      } else {
        expect(execution.system).toContain("Keep per-ticket owner approval");
        expect(execution.system).not.toContain("PM may self-approve");
      }
    },
  );
  it("grounds defaults in the selected repository and sends no source or integration credentials to Claude", async () => {
    const f = fixture();
    const files = ["project.json", "areas.json"].map((name) =>
      join(root, "projects/app", name),
    );
    const before = files.map((file) => readFileSync(file, "utf8"));
    const result = await f.planner.plan(input);
    expect(result.draft).toEqual({
      ...Object.fromEntries(
        Object.entries(suggestion).filter(([key]) => key !== "rationale"),
      ),
      label: "pm:checkout",
    });
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
    expect(result.draft).not.toHaveProperty("linearProjectId");
    expect(result.draft).not.toHaveProperty("mixpanelReportId");
    expect(result.draft).not.toHaveProperty("tier");
    expect(files.map((file) => readFileSync(file, "utf8"))).toEqual(before);
  });
  it("fills every charter field and produces a draft compatible with real PM configuration", async () => {
    const result = await fixture().planner.plan(input);
    const charterFields = [...CHARTER_TEXT_FIELDS, ...CHARTER_LIST_FIELDS];
    expect(Object.keys(result.draft.charter).sort()).toEqual(
      [...charterFields].sort(),
    );
    expect(parsePmCharter(result.draft.charter)).toEqual(result.draft.charter);
    for (const field of charterFields)
      expect(result.draft.charter[field].length).toBeGreaterThan(0);
    const areasFile = join(root, "projects/app/areas.json");
    const areas = JSON.parse(readFileSync(areasFile, "utf8"));
    const { key, ...fields } = result.draft;
    areas.areas[key] = {
      ...fields,
      mandate: input.mandate,
      enabled: false,
      linearProjectId: "PASTE_LINEAR_PROJECT_ID",
    };
    writeFileSync(areasFile, JSON.stringify(areas));
    const persisted = loadProject(root, "app").areas.find(
      (area) => area.key === key,
    );
    expect(persisted).toMatchObject({
      ...result.draft,
      mandate: input.mandate,
      enabled: false,
    });
    const properties = PM_DRAFT_SCHEMA.properties as Record<
      string,
      { required?: string[] }
    >;
    expect(PM_DRAFT_SCHEMA.required).toContain("charter");
    expect(properties.charter!.required).toEqual(charterFields);
    expect(properties).not.toHaveProperty("mandate");
    expect(properties).not.toHaveProperty("label");
  });
  it("includes bounded grounded existing ownership without sending PM identities or integration metadata", async () => {
    const areasFile = join(root, "projects/app/areas.json");
    const areas = JSON.parse(readFileSync(areasFile, "utf8"));
    areas.areas.core.paths = ["src/checkout/", "unlisted/private/"];
    areas.areas.core.sharedTouchpoints = ["src/shared.ts"];
    areas.areas.core.name = "Internal team identity";
    areas.areas.core.linearProjectId = "private-linear-resource-id";
    areas.areas.core.mandate =
      "Existing private mandate not needed for this draft";
    writeFileSync(areasFile, JSON.stringify(areas));
    const f = fixture();
    await f.planner.plan(input);
    const execution = f.execute.mock.calls[0]![0];
    const context = JSON.parse(execution.prompt);
    expect(context.existingPmOwnership).toEqual({
      entries: [
        {
          key: "core",
          paths: ["src/checkout/"],
          sharedTouchpoints: ["src/shared.ts"],
        },
      ],
      truncated: true,
    });
    for (const excluded of [
      "unlisted/private/",
      "Internal team identity",
      "private-linear-resource-id",
      "Existing private mandate",
    ])
      expect(execution.prompt).not.toContain(excluded);
    expect(execution.system).toContain("existing PM ownership");
    expect(execution.system).toContain("Do not invent existing baselines");
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
    { key: "checkout-" },
    { key: "checkout--quality" },
    { label: "pm:someone-else" },
    { linearProjectId: "invented-provider-id" },
    { tier: "auto-approve" },
    { charter: undefined },
    { charter: {} },
    { charter: { ...suggestion.charter, goal: " " } },
    { charter: { ...suggestion.charter, users: [] } },
    { charter: { ...suggestion.charter, nonGoals: [" "] } },
    { charter: { ...suggestion.charter, ambition: "x".repeat(1001) } },
    { charter: { ...suggestion.charter, users: ["x".repeat(401)] } },
    {
      charter: {
        ...suggestion.charter,
        users: Array.from({ length: 7 }, (_, i) => `Audience ${i}`),
      },
    },
    { charter: { ...suggestion.charter, scope: "unsupported" } },
    { charter: { ...suggestion.charter, guardrails: [sourceToken] } },
    { charter: { ...suggestion.charter, goal: modelToken } },
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
    await expect(canceled.execute(execution())).rejects.toMatchObject({
      code: "runtime_unavailable",
    });
    expect(canceled.run.mock.calls.at(-1)![0][0]).toBe("rm");
    const other = dockerFixture(false, true);
    await other.execute(execution());
    expect(other.run.mock.calls.some(([args]) => args[0] === "rm")).toBe(false);
  });
  it("bounds the complete expanded draft transport before creating a container", async () => {
    const f = dockerFixture();
    await f.execute({ ...execution(), prompt: "x".repeat(210000) });
    const start = f.run.mock.calls.find(([args]) => args[0] === "start")!;
    expect(JSON.parse(start[1]!.stdin!).prompt).toHaveLength(210000);
    expect(start[1]!.maxBytes).toBe(65536 + 4096);
    f.run.mockClear();
    await expect(
      f.execute({ ...execution(), prompt: "x".repeat(512 * 1024) }),
    ).rejects.toThrow("bounded input limit");
    expect(f.run).not.toHaveBeenCalled();
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
