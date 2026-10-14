import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createDashboardServer } from "./dashboard.ts";
import { initializeSetup } from "../setup/files.ts";
import {
  createProjectOnboarding,
  type OnboardingState,
} from "../projectOnboarding/index.ts";
import { createLocalRunners } from "../localRunners/engine.ts";
import type { SourceControl } from "../sourceControl/types.ts";
import { loadProject } from "../config.ts";

const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
const session = "b".repeat(64),
  sha = "a".repeat(40),
  blob = "c".repeat(40);
let root: string, server: Server;
afterEach(async () => {
  if (server)
    await new Promise<void>((resolve) => server.close(() => resolve()));
  vi.restoreAllMocks();
  if (root) rmSync(root, { recursive: true, force: true });
});
async function fixture() {
  root = mkdtempSync(join(realpathSync(tmpdir()), "gremlins-compose-http-"));
  initializeSetup(root, packageRoot, {
    project: "app",
    repo: "owner/app",
    createInitialPm: false,
    settings: {
      workflow: { kind: "pull-request", baseBranch: "main" },
      verification: { mode: "repository" },
    },
  });
  let currentSha = sha;
  const fetcher = vi.fn(
    async (url: string | URL | Request, init?: RequestInit) => {
      expect(init?.method ?? "GET").toBe("GET");
      expect(init?.redirect).toBe("error");
      const path = String(url);
      if (path.includes("/commits/"))
        return new Response(JSON.stringify({ sha: currentSha }));
      if (path.includes("/git/trees/"))
        return new Response(
          JSON.stringify({
            tree: [
              {
                type: "blob",
                mode: "100644",
                path: "deploy/compose.test.yml",
                sha: blob,
              },
              {
                type: "blob",
                mode: "100644",
                path: "Dockerfile",
                sha: "d".repeat(40),
              },
            ],
          }),
        );
      if (path.endsWith(`/git/blobs/${blob}`))
        return new Response(
          JSON.stringify({
            encoding: "base64",
            content: Buffer.from(
              "services:\n  web:\n    build: {context: '..'}\n    ports: [3000]\n    environment:\n      DATABASE_URL: postgresql://test:private-original-password@db:5432/test\n  db:\n    image: postgres:16-alpine\n",
            ).toString("base64"),
          }),
        );
      throw Error("Unexpected source request");
    },
  );
  const source = {
    status: vi.fn(async () => []),
    resolveCredential: vi.fn(async () => ({
      token: "private-source-credential",
      method: "token" as const,
    })),
  } as unknown as SourceControl;
  const execute = vi.fn();
  const onboarding = createProjectOnboarding({
    root,
    packageRoot,
    env: {},
    fetch: fetcher,
    sourceControl: source,
    execute,
  });
  const runners = createLocalRunners({ root, packageRoot });
  const start = vi.spyOn(runners, "start").mockImplementation(() => {});
  const environmentAccess = {
    status: vi.fn(() => ({
      status: "untested" as const,
      message: "Unverified",
    })),
    verify: vi.fn(),
    busy: vi.fn(() => false),
    idle: async () => {},
    close: async () => {},
    screenshot: vi.fn(),
  };
  server = createDashboardServer(root, packageRoot, session, [], {
    sourceControl: source,
    projectOnboarding: onboarding,
    runners,
    environmentAccess,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = (
    path: string,
    input?: unknown,
    authenticated = true,
    method = input === undefined ? "GET" : "POST",
  ) =>
    fetch(origin + path, {
      method,
      headers: {
        "content-type": "application/json",
        ...(authenticated ? { authorization: `Bearer ${session}` } : {}),
      },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }),
    });
  return {
    onboarding,
    runners,
    start,
    environmentAccess,
    execute,
    fetcher,
    call,
    advance: () => {
      currentSha = "e".repeat(40);
    },
  };
}
describe("authenticated source Compose import endpoint", () => {
  it("enforces auth and exact revision input, returns review choices, and changes nothing until configure", async () => {
    const f = await fixture();
    f.start.mockClear(); // Controller startup is independent of the import request.
    const initial = await f.onboarding.status("app");
    const original = readFileSync(
      join(root, "projects/app/project.json"),
      "utf8",
    );
    const path = "/api/projects/app/onboarding/import-compose";
    const input = {
      revision: initial.revision,
      path: "deploy/compose.test.yml",
    };
    expect((await f.call(path, input, false)).status).toBe(401);
    expect((await f.call(path)).status).toBe(405);
    expect((await f.call(path + "?token=no", input)).status).toBe(400);
    expect((await f.call(path, { ...input, token: "untrusted" })).status).toBe(
      400,
    );
    expect(
      (await f.call(path, { ...input, path: "../compose.yml" })).status,
    ).toBe(400);
    expect(
      (await f.call(path, { ...input, revision: "f".repeat(64) })).status,
    ).toBe(409);
    expect(f.fetcher).not.toHaveBeenCalled();
    const response = await f.call(path, input);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: expect.stringMatching(/analyzing|analyzed/),
    });
    await f.onboarding.idle();
    const reviewedResponse = await f.call("/api/projects/app/onboarding");
    const reviewed = (await reviewedResponse.json()) as OnboardingState;
    expect(reviewed).toMatchObject({
      status: "analyzed",
      report: {
        repository: { sha, filesRead: ["deploy/compose.test.yml"] },
        composeImports: [
          {
            path: "deploy/compose.test.yml",
            service: "web",
            status: "ready",
            target: {
              recipe: { context: ".", dockerfile: "Dockerfile" },
              services: [{ kind: "postgres", name: "db", env: "DATABASE_URL" }],
            },
          },
        ],
      },
    });
    expect(JSON.stringify(reviewed)).not.toMatch(
      /private-source-credential|private-original-password/,
    );
    expect(readFileSync(join(root, "projects/app/project.json"), "utf8")).toBe(
      original,
    );
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.start).not.toHaveBeenCalled();
    expect(f.environmentAccess.verify).not.toHaveBeenCalled();
    expect(await f.runners.jobs()).toEqual([]);
    expect((await f.call(path, input)).status).toBe(409);
    const configured = await f.call("/api/projects/app/onboarding/configure", {
      configurationRevision: reviewed.configurationRevision,
      profile: "docker",
      target: reviewed.report!.composeImports![0]!.target,
    });
    expect(configured.status).toBe(200);
    expect(
      loadProject(root, "app").config.environments?.["pm-test"],
    ).toMatchObject({ kind: "docker", port: 3000 });
    expect(f.environmentAccess.verify).not.toHaveBeenCalled();
    expect(await f.runners.jobs()).toEqual([]);
  });
  it("rejects saving an imported recipe when repository source changed", async () => {
    const f = await fixture();
    await f.call("/api/projects/app/onboarding/import-compose", {
      revision: (await f.onboarding.status("app")).revision,
    });
    await f.onboarding.idle();
    const reviewed = await f.onboarding.status("app");
    const original = readFileSync(
      join(root, "projects/app/project.json"),
      "utf8",
    );
    f.advance();
    const response = await f.call("/api/projects/app/onboarding/configure", {
      configurationRevision: reviewed.configurationRevision,
      profile: "docker",
      target: reviewed.report!.composeImports![0]!.target,
    });
    expect(response.status).toBe(409);
    expect(readFileSync(join(root, "projects/app/project.json"), "utf8")).toBe(
      original,
    );
    expect(f.environmentAccess.verify).not.toHaveBeenCalled();
  });
});
