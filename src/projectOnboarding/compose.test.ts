import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, realpathSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { importComposeDocument, readComposeRepository } from "./compose.ts";
import { createProjectOnboarding } from "./index.ts";
import { initializeSetup } from "../setup/files.ts";
import { loadProject } from "../config.ts";

const sha = "a".repeat(40),
  blob = "b".repeat(40),
  dockerBlob = "c".repeat(40);
const compose = [
  "services:",
  "  web:",
  "    build:",
  "      context: .",
  "      args:",
  "        NEXT_PUBLIC_API_URL: https://staging.example.test",
  "    ports: ['127.0.0.1:3000:3000']",
  "    command: ['npm', 'start']",
  "    environment:",
  "      DATABASE_URL: postgresql://dev:private-database-value@db:5432/dev",
  "      REDIS_URL: redis://cache:6379",
  "      API_KEY: ${API_KEY}",
  "    depends_on:",
  "      db: {condition: service_healthy}",
  "      cache: {condition: service_started}",
  "  db:",
  "    image: postgres:16-alpine",
  "    environment: {POSTGRES_PASSWORD: private-database-value}",
  "    volumes: ['database:/var/lib/postgresql/data']",
  "  cache:",
  "    image: redis:7-alpine",
  "volumes:",
  "  database:",
].join("\n");
describe("bounded source-grounded Compose translation", () => {
  it("translates a real app and two disposable services without host ports or original credentials", () => {
    const [result] = importComposeDocument(
      "compose.yml",
      compose,
      new Set(["Dockerfile", "compose.yml"]),
    );
    expect(result).toMatchObject({
      status: "ready",
      service: "web",
      target: {
        recipe: { kind: "dockerfile", context: ".", dockerfile: "Dockerfile" },
        port: 3000,
        start: ["npm", "start"],
        buildArgs: { NEXT_PUBLIC_API_URL: "https://staging.example.test" },
        env: { API_KEY: "TEST_COMPOSE_WEB_API_KEY" },
        services: [
          { kind: "postgres", name: "db", env: "DATABASE_URL" },
          { kind: "redis", name: "cache", env: "REDIS_URL" },
        ],
      },
    });
    expect(result!.missingInputs[0]?.description).toContain(
      "TEST_COMPOSE_WEB_API_KEY",
    );
    expect(JSON.stringify(result)).not.toContain("private-database-value");
    expect(JSON.stringify(result!.target)).not.toMatch(
      /volumes|127\.0\.0\.1|published/,
    );
  });
  it.each([
    "privileged: true",
    "network_mode: host",
    "volumes: ['/var/run/docker.sock:/var/run/docker.sock']",
    "env_file: .env",
    "entrypoint: ['sh','-c']",
    "secrets: ['private']",
    "devices: ['/dev/kvm']",
  ])("explicitly rejects unsupported %s", (feature) => {
    const text = `services:\n  web:\n    image: example/web:1\n    ports: [3000]\n    ${feature}\n`;
    const [result] = importComposeDocument("compose.yml", text, new Set());
    expect(result!.status).toBe("unsupported");
    expect(result!.target).toBeUndefined();
    expect(
      result!.diagnostics.some((item) =>
        item.feature.includes(feature.split(":")[0]!),
      ),
    ).toBe(true);
  });
  it.each([
    "services:\n  web: &web {image: 'example/web:1', ports: [3000]}\n  other: *web",
    "services:\n  web: {image: 'example/web:1', image: 'example/other:1', ports: [3000]}",
    "services: !custom {}",
  ])(
    "rejects aliases, duplicate keys and custom YAML tags without interpreting them",
    (text) => {
      expect(
        importComposeDocument("compose.yml", text, new Set())[0],
      ).toMatchObject({
        status: "unsupported",
        diagnostics: [{ feature: "yaml" }],
      });
    },
  );
  it("requires a tracked regular Dockerfile and contained context", () => {
    expect(
      importComposeDocument(
        "deploy/compose.yml",
        "services:\n  web:\n    build: .\n    ports: [3000]",
        new Set(["Dockerfile"]),
      )[0]!.status,
    ).toBe("unsupported");
    expect(
      importComposeDocument(
        "compose.yml",
        "services:\n  web:\n    build: ../outside\n    ports: [3000]",
        new Set(["outside/Dockerfile"]),
      )[0]!.status,
    ).toBe("unsupported");
    const [nested] = importComposeDocument(
      "deploy/compose.yml",
      "services:\n  web:\n    build: ../web\n    ports: [3000]",
      new Set(["web/Dockerfile"]),
    );
    expect(nested!.target?.recipe).toEqual({
      kind: "dockerfile",
      context: "web",
      dockerfile: "web/Dockerfile",
    });
  });
  it("does not silently select one of several application containers or accept credential build arguments", () => {
    const text =
      "services:\n  web:\n    build: {context: '.', args: {NPM_TOKEN: private-value}}\n    ports: [3000]\n  worker:\n    image: example/worker:1\n    expose: [4000]";
    const results = importComposeDocument(
      "compose.yml",
      text,
      new Set(["Dockerfile"]),
    );
    expect(results).toHaveLength(2);
    expect(
      results.every((item) => item.status === "unsupported" && !item.target),
    ).toBe(true);
    expect(
      results[0]!.diagnostics.some((item) => item.feature === "build.args"),
    ).toBe(true);
    expect(JSON.stringify(results)).not.toContain("private-value");
  });
});

let root: string;
const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
beforeEach(() => {
  root = mkdtempSync(join(realpathSync(tmpdir()), "gremlins-compose-import-"));
  initializeSetup(root, packageRoot, {
    project: "app",
    repo: "owner/app",
    createInitialPm: false,
  });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
const sourceFetch = (mode?: "symlink" | "truncated") =>
  vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    expect(init?.redirect).toBe("error");
    const path = String(url);
    if (path.includes("/commits/"))
      return new Response(JSON.stringify({ sha }));
    if (path.includes("/git/trees/"))
      return new Response(
        JSON.stringify({
          truncated: mode === "truncated",
          tree: [
            { type: "blob", path: "compose.yml", mode: "100644", sha: blob },
            {
              type: "blob",
              path: "Dockerfile",
              mode: mode === "symlink" ? "120000" : "100644",
              sha: dockerBlob,
            },
          ],
        }),
      );
    if (path.endsWith(`/git/blobs/${blob}`))
      return new Response(
        JSON.stringify({
          encoding: "base64",
          content: Buffer.from(compose).toString("base64"),
        }),
      );
    throw Error("Unexpected source request");
  });
describe("repository Compose onboarding", () => {
  it("imports the exact source commit without AI or execution and preserves project settings", async () => {
    const execute = vi.fn(),
      fetcher = sourceFetch(),
      sourceControl = {
        resolveCredential: vi.fn(async () => ({
          token: "private-source-token",
          method: "token" as const,
        })),
      };
    const service = createProjectOnboarding({
      root,
      packageRoot,
      env: {},
      fetch: fetcher,
      sourceControl,
      execute,
    });
    const original = readFileSync(
      join(root, "projects/app/project.json"),
      "utf8",
    );
    const state = await service.status("app");
    await service.importCompose("app", { revision: state.revision });
    await service.idle();
    const imported = await service.status("app");
    expect(imported).toMatchObject({
      status: "analyzed",
      report: {
        repository: { sha, filesRead: ["compose.yml"] },
        composeImports: [{ status: "ready" }],
      },
    });
    expect(execute).not.toHaveBeenCalled();
    expect(sourceControl.resolveCredential).toHaveBeenCalledWith(
      expect.objectContaining({ write: false }),
    );
    expect(JSON.stringify(imported)).not.toMatch(
      /private-source-token|private-database-value/,
    );
    expect(readFileSync(join(root, "projects/app/project.json"), "utf8")).toBe(
      original,
    );
    await expect(
      service.importCompose("app", { revision: state.revision }),
    ).rejects.toMatchObject({ status: 409 });
  });
  it("rejects Dockerfile symlinks and incomplete repository trees", async () => {
    const report = await readComposeRepository(
      loadProject(root, "app"),
      "token",
      sourceFetch("symlink"),
      AbortSignal.timeout(1000),
    );
    expect(report.composeImports?.[0]?.status).toBe("unsupported");
    await expect(
      readComposeRepository(
        loadProject(root, "app"),
        "token",
        sourceFetch("truncated"),
        AbortSignal.timeout(1000),
      ),
    ).rejects.toThrow("complete bounded repository tree");
  });
  it("requires a fresh Compose import when source advances before saving its recipe", async () => {
    const fetcher = sourceFetch(),
      applyProfile = vi.fn(async () => {});
    const service = createProjectOnboarding({
      root,
      packageRoot,
      env: {},
      fetch: fetcher,
      sourceControl: {
        resolveCredential: vi.fn(async () => ({
          token: "private-source-token",
          method: "token" as const,
        })),
      },
      applyProfile,
    });
    await service.importCompose("app", {
      revision: (await service.status("app")).revision,
    });
    await service.idle();
    const state = await service.status("app");
    fetcher.mockResolvedValueOnce(
      new Response(JSON.stringify({ sha: "d".repeat(40) })),
    );
    await expect(
      service.apply("app", {
        revision: state.revision,
        configurationRevision: state.configurationRevision,
        profile: "docker",
        target: state.report!.composeImports![0]!.target!,
      }),
    ).rejects.toMatchObject({ status: 409, code: "stale_repository" });
    expect(applyProfile).not.toHaveBeenCalled();
  });
});
