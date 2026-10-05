import { createHash } from "node:crypto";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import type { Project } from "../config.ts";
import {
  createDockerPlanner,
  type PlannerDockerRun,
} from "../pmPlanner/docker.ts";
import { readRepository } from "./repository.ts";
import {
  SOURCE_LIMITS,
  seedPriority,
  sourceExcerpt,
  sourceReferences,
} from "./investigation.ts";

const SHA = "a".repeat(40);
const project = {
  config: {
    name: "app",
    repo: "owner/app",
    branches: { production: "main", staging: "main", integration: "main" },
  },
} as Project;
function fixture(
  files: Record<string, string>,
  sizes: Record<string, number> = {},
) {
  const blobs = new Map(
    Object.entries(files).map(([path, content]) => [
      createHash("sha1").update(path).digest("hex"),
      { path, content },
    ]),
  );
  const reads: string[] = [];
  const fetcher = vi.fn(
    async (url: string | URL | Request, init?: RequestInit) => {
      expect(init?.headers).toMatchObject({
        authorization: "Bearer source-test-token",
      });
      const path = String(url);
      if (path.endsWith("/commits/main")) return Response.json({ sha: SHA });
      if (path.endsWith(`/git/trees/${SHA}?recursive=1`))
        return Response.json({
          tree: [...blobs].map(([sha, { path, content }]) => ({
            type: "blob",
            mode: "100644",
            path,
            sha,
            size: sizes[path] ?? Buffer.byteLength(content),
          })),
        });
      const entry = blobs.get(path.split("/").at(-1)!);
      if (!entry || !path.includes("/git/blobs/"))
        throw new Error("Unexpected request");
      reads.push(entry.path);
      return Response.json({
        encoding: "base64",
        content: Buffer.from(entry.content).toString("base64"),
      });
    },
  );
  return {
    reads,
    read: () =>
      readRepository(
        project,
        "source-test-token",
        fetcher as typeof fetch,
        AbortSignal.timeout(10000),
        [],
      ),
  };
}
beforeEach(() => {
  vi.spyOn(globalThis, "fetch").mockRejectedValue(
    new Error("No external requests"),
  );
});
afterEach(() => vi.restoreAllMocks());

describe("source investigation", () => {
  it("follows manifest entrypoints into actual dashboard source and runnable examples before unrelated test/docs", async () => {
    const files: Record<string, string> = {
      "package.json": JSON.stringify({
        bin: { app: "bin/launch.mjs" },
        scripts: { test: "vitest", start: "node bin/launch.mjs" },
      }),
      "bin/launch.mjs":
        "const cli = new URL('../src/cli.ts', import.meta.url);",
      "src/cli.ts":
        "import { createDashboard } from './commands/dashboard.ts';",
      "src/commands/dashboard.ts": Array.from({ length: 3000 }, (_, i) =>
        i === 1100
          ? "export function createDashboard({providers, workers}) { return createServer(providers); }"
          : i === 2100
            ? "const page = 'dashboard/index.html';"
            : `// line ${i} implementing application behavior`,
      ).join("\n"),
      "dashboard/index.html": '<script src="/app.js"></script>',
      "dashboard/app.js":
        "document.addEventListener('DOMContentLoaded', () => render());",
      "examples/browser-fixture/README.md":
        "Real dashboard and HTTP API; synthetic provider and worker adapters.",
      "examples/browser-fixture/Dockerfile":
        'FROM node:22\nWORKDIR /app\nCOPY . .\nEXPOSE 3000\nCMD ["node","examples/browser-fixture/server.mjs"]',
      "examples/browser-fixture/server.mjs":
        "import { createDashboard } from '../../src/commands/dashboard.ts'; import { fixture } from './fixture.mjs';",
      "examples/browser-fixture/fixture.mjs":
        "export const fixture = { providers: 'synthetic', workers: 'synthetic' };",
      "examples/browser-fixture/recipe.json":
        '{"port":3000,"healthPath":"/fixture/health"}',
      ...Object.fromEntries(
        Array.from({ length: 40 }, (_, i) => [
          `fonts/font${i}/README.md`,
          "License terms",
        ]),
      ),
      ...Object.fromEntries(
        Array.from({ length: 40 }, (_, i) => [
          `src/cli-${i}.test.ts`,
          "unrelated CLI tests",
        ]),
      ),
    };
    const f = fixture(files),
      result = await f.read();
    for (const path of [
      "bin/launch.mjs",
      "src/cli.ts",
      "src/commands/dashboard.ts",
      "dashboard/index.html",
      "dashboard/app.js",
      "examples/browser-fixture/server.mjs",
      "examples/browser-fixture/recipe.json",
    ])
      expect(result.repository.filesRead).toContain(path);
    expect(f.reads.some((p) => /fonts|cli-\d/.test(p))).toBe(false);
    const dashboard = result.files.find(
      (f) => f.path === "src/commands/dashboard.ts",
    )!;
    expect(dashboard.content).toContain("createDashboard");
    expect(dashboard.content).toContain("Source excerpt: lines");
    expect(
      result.repository.inspection?.files.find(
        (f) => f.path === dashboard.path,
      ),
    ).toMatchObject({ excerpt: true, ranges: expect.any(Array) });
    expect(result.repository.inspection?.totalFiles).toBe(
      Object.keys(files).length,
    );
  });

  it("reviews beyond 24 files through imports and stops at the explicit request limit", async () => {
    const files: Record<string, string> = {
      "package.json": '{"main":"src/main.ts"}',
      "src/main.ts": Array.from(
        { length: 55 },
        (_, i) => `import './module${i}.ts';`,
      ).join("\n"),
    };
    for (let i = 0; i < 100; i++)
      files[`src/module${i}.ts`] =
        `export { feature } from './module${(i + 50) % 100}.ts';`;
    const f = fixture(files),
      result = await f.read();
    expect(result.files.length).toBe(SOURCE_LIMITS.files);
    expect(new Set(f.reads).size).toBe(f.reads.length);
    expect(result.repository.inspection?.requests).toBe(80);
    expect(result.repository.inspection?.unresolved.length).toBeGreaterThan(0);
    expect(result.repository.truncated).toBe(true);
    expect(result.repository.inspection?.sourceBytes).toBeLessThanOrEqual(
      512 * 1024,
    );
  });

  it("keeps referenced private paths and oversized entrypoints out of model input and reports missing entrypoint coverage", async () => {
    const f = fixture(
      {
        "package.json": '{"main":"src/main.ts"}',
        "src/main.ts":
          "import './credentials.json'; import './huge.ts'; import '../.env';",
        "src/credentials.json": "private",
        ".env": "private",
        "src/huge.ts": "not downloaded",
      },
      { "src/huge.ts": 2 * 1024 * 1024 },
    );
    const result = await f.read();
    expect(f.reads).toEqual(["package.json", "src/main.ts"]);
    expect(result.paths).not.toContain(".env");
    expect(result.paths).not.toContain("src/credentials.json");
    expect(result.repository.inspection?.unresolved).toContain("src/huge.ts");
    const blocked = fixture(
      {
        "package.json": '{"main":"src/server.ts"}',
        "src/server.ts": "oversized",
      },
      { "src/server.ts": 2 * 1024 * 1024 },
    );
    expect(
      (await blocked.read()).repository.inspection?.criticalMissing,
    ).toContain("src/server.ts");
  });

  it("stops dependency chains at the configured depth without losing the unresolved path", async () => {
    const files: Record<string, string> = {
      "package.json": '{"main":"src/entry.ts"}',
    };
    files["src/entry.ts"] = "import './part0.ts';";
    for (let i = 0; i < 12; i++)
      files[`src/part${i}.ts`] = `import './part${i + 1}.ts';`;
    const result = await fixture(files).read();
    expect(result.files).toHaveLength(SOURCE_LIMITS.depth + 1);
    expect(result.repository.inspection?.unresolved).toContain("src/part6.ts");
    expect(result.repository.filesRead).not.toContain("src/part6.ts");
  });

  it("bounds quote-heavy selected source and its twice-serialized planner envelope", async () => {
    const files: Record<string, string> = {
      "package.json": '{"main":"src/main.ts"}',
      "src/main.ts": Array.from(
        { length: 55 },
        (_, i) => `import './part${i}.ts';`,
      ).join("\n"),
    };
    for (let i = 0; i < 55; i++)
      files[`src/part${i}.ts`] = `const value = "${"\\".repeat(90)}";\n`.repeat(
        140,
      );
    const result = await fixture(files).read();
    const payload = JSON.stringify({
      credential: "test",
      system: "test",
      schema: {},
      prompt: JSON.stringify(result),
    });
    expect(result.files.length).toBeGreaterThan(24);
    expect(result.repository.inspection?.sourceBytes).toBeLessThanOrEqual(
      SOURCE_LIMITS.sourceBytes,
    );
    expect(Buffer.byteLength(payload)).toBeLessThan(2 * 1024 * 1024);
    expect(result.repository.inspection?.sourceBytes).toBe(
      result.files.reduce(
        (total, file) => total + Buffer.byteLength(file.content),
        0,
      ),
    );
    expect(
      result.repository.inspection?.files.map((file) => file.path),
    ).toEqual(result.repository.filesRead);
    expect(result.repository.inspection?.unresolved.length).toBeGreaterThan(0);
  });

  it("supports dynamic route filenames and does not interpret shell or remote paths", () => {
    expect(
      sourceReferences(
        "src/main.ts",
        `import './app/[slug]/page.tsx'; import 'https://bad.test/leak'; const x = '../private.key';`,
        new Set(["src/app/[slug]/page.tsx"]),
      ),
    ).toEqual([
      {
        path: "src/app/[slug]/page.tsx",
        reason: "import from src/main.ts",
        priority: 10,
      },
    ]);
    expect(seedPriority("assets/fonts/README.md")).toBeUndefined();
    expect(seedPriority("examples/web/Dockerfile")).toBe(3);
    expect(sourceExcerpt("x".repeat(30000)).content).toBe("");
  });
});

describe("Setup-only planner transport", () => {
  it("retains normal PM draft limits and allows a bounded larger Setup payload over stdin", async () => {
    const run = vi.fn<PlannerDockerRun>(async (args) => ({
      code: 0,
      stdout: args[0] === "start" ? "{}" : "",
      stderr: "",
    }));
    const ensureImage = vi.fn(
      async () => "shipgremlins-local:aaaaaaaaaaaaaaaa",
    );
    const input = {
      credential: "synthetic-model-token",
      prompt: "x".repeat(600 * 1024),
      system: "test",
      schema: {},
      signal: AbortSignal.timeout(10000),
    };
    await expect(
      createDockerPlanner({ packageRoot: "unused", run, ensureImage })(input),
    ).rejects.toThrow("bounded input");
    expect(ensureImage).not.toHaveBeenCalled();
    await expect(
      createDockerPlanner({
        packageRoot: "unused",
        run,
        ensureImage,
        maxInputBytes: 2 * 1024 * 1024,
      })(input),
    ).resolves.toEqual({});
    expect(
      run.mock.calls.find(([args]) => args[0] === "start")?.[1]?.stdin,
    ).toContain(input.prompt);
    expect(run.mock.calls.every(([args]) => !args.includes(input.prompt))).toBe(
      true,
    );
    await expect(
      createDockerPlanner({
        packageRoot: "unused",
        run,
        ensureImage,
        maxInputBytes: 3 * 1024 * 1024,
      })({ ...input, prompt: "x".repeat(2 * 1024 * 1024) }),
    ).rejects.toThrow("bounded input");
  });
});
