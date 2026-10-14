import { randomUUID } from "node:crypto";
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
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadProject } from "../config.ts";
import { saveAiSelection } from "../ai/provider.ts";
import { parseProjectCapabilities } from "../projectCapabilities.ts";
import { parseTestAccess, validTestSecret } from "../testAccess.ts";
import { type DockerRunners, type DockerRun } from "../localRunners/docker.ts";
import { initializeSetup } from "./files.ts";
import { saveConnections } from "./connections.ts";
import { inspectPmReadiness, type ReadinessContext } from "./pmReadiness.ts";
import { inspectSetup } from "./preflight.ts";
import { createEnvironmentAccess } from "./environmentAccess.ts";

const packageRoot = fileURLToPath(new URL("../..", import.meta.url));
const roots: string[] = [];
const tokens = {
  id_token: "synthetic-codex-id-value",
  access_token: "synthetic-codex-access-value",
  refresh_token: "synthetic-codex-refresh-value",
  account_id: "account-123",
};
const auth = JSON.stringify({
  auth_mode: "chatgpt",
  OPENAI_API_KEY: null,
  tokens,
  last_refresh: "2026-10-10T00:00:00.000Z",
});
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function fixture(env: NodeJS.ProcessEnv = {}) {
  const root = mkdtempSync(
    join(realpathSync(tmpdir()), "gremlins-codex-ready-"),
  );
  roots.push(root);
  initializeSetup(root, packageRoot, {
    project: "app",
    repo: "org/app",
    settings: { workflow: { kind: "pull-request", baseBranch: "main" } },
  });
  const file = join(root, "projects/app/project.json"),
    project = JSON.parse(readFileSync(file, "utf8"));
  project.verified = "2026-10-14";
  writeFileSync(file, JSON.stringify(project));
  const areaFile = join(root, "projects/app/areas.json"),
    areas = JSON.parse(readFileSync(areaFile, "utf8"));
  areas.areas.core.linearProjectId = randomUUID();
  areas.areas.core.mandate =
    "Inspect the repository and improve verified product defects.";
  writeFileSync(areaFile, JSON.stringify(areas));
  const context: ReadinessContext = {
    env: {
      GITHUB_TOKEN: "source-credential",
      LINEAR_API_KEY: "linear-credential",
      ...env,
    },
    sourceConnections: [],
    serviceConnections: [],
    localMode: true,
    workers: [
      {
        id: "worker-one",
        name: "Local",
        status: "ready",
        busy: false,
        paused: false,
        createdAt: "2026-10-14",
        verifiedAt: "2026-10-14",
      },
    ],
  };
  const setup = () =>
    inspectSetup(
      root,
      {
        env: context.env,
        nodeVersion: "22.12.0",
        probe: (tool) => ({ available: tool !== "claude", version: "1.2.3" }),
      },
      "app",
    );
  return {
    root,
    file,
    context,
    setup,
    readiness: () => inspectPmReadiness(loadProject(root, "app"), context),
  };
}
const docker = {
  kind: "docker",
  role: "staging",
  recipe: { kind: "dockerfile", dockerfile: "Dockerfile", context: "." },
  port: 3000,
  access: { kind: "public" },
};

describe("Codex-only setup and readiness boundaries", () => {
  it("admits a selected Codex account without Claude credentials or a host Claude installation", () => {
    const f = fixture({ CODEX_AUTH_JSON: auth });
    saveAiSelection(f.root, { provider: "codex" });
    expect(f.readiness()).toMatchObject({
      canRun: true,
      canEnable: true,
      areas: [{ canRun: true, canEnable: true }],
    });
    expect(
      f.readiness().steps.find((step) => step.id === "ai_connection"),
    ).toMatchObject({ ready: true, message: "Codex connection is saved." });
    const report = f.setup();
    expect(report.ready).toBe(true);
    expect(
      report.checks.find((check) => check.id === "ai-runtime"),
    ).toMatchObject({
      status: "pass",
      detail: "Codex runner credentials are present; validity is not checked.",
    });
    expect(report.secrets.map((secret) => secret.name)).not.toContain(
      "CLAUDE_CODE_OAUTH_TOKEN",
    );
    expect(JSON.stringify(report)).not.toMatch(/synthetic-codex-|account-123/);
  });
  it.each([
    {
      provider: "claude" as const,
      env: { CODEX_AUTH_JSON: auth },
      label: "Claude Code",
    },
    {
      provider: "codex" as const,
      env: { CLAUDE_CODE_OAUTH_TOKEN: "saved-claude" },
      label: "Codex",
    },
  ])(
    "keeps missing selected $provider blocked even when the other account is available",
    ({ provider, env, label }) => {
      const f = fixture(env);
      saveAiSelection(f.root, { provider });
      expect(f.readiness().canRun).toBe(false);
      expect(f.readiness().areas[0]!.blockers).toContainEqual(
        expect.objectContaining({ id: "ai_connection", action: "ai" }),
      );
      expect(
        f.setup().checks.find((check) => check.id === "ai-runtime"),
      ).toMatchObject({
        status: "warn",
        detail: `Connect ${label} in dashboard Connections before running AI jobs.`,
      });
    },
  );
  it.each([
    "CODEX_AUTH_JSON",
    "CODEX_ACCESS_TOKEN",
    "CODEX_API_KEY",
    "OPENAI_API_KEY",
  ])("rejects %s as browser, runtime or build-secret aliases", (name) => {
    expect(validTestSecret(name)).toBe(false);
    expect(() =>
      parseTestAccess({
        kind: "password",
        loginPath: "/login",
        usernameSelector: "#email",
        passwordSelector: "#password",
        submitSelector: "button",
        successSelector: "#home",
        accounts: [
          {
            name: "Member",
            usernameSecret: "TEST_EMAIL",
            passwordSecret: name,
          },
        ],
      }),
    ).toThrow();
    for (const target of [
      { ...docker, env: { APP_KEY: name } },
      { ...docker, buildSecrets: { npmrc: name } },
      {
        kind: "vercel",
        role: "preview",
        projectId: "prj_app",
        bypassSecret: name,
      },
    ])
      expect(() =>
        parseProjectCapabilities({
          verification: { mode: "browser", environment: "test" },
          environments: { test: target },
        }),
      ).toThrow();
  });
  it.each([tokens.id_token, tokens.access_token, tokens.refresh_token])(
    "rejects a bare Codex credential component in public build args before runner handoff",
    async (secret) => {
      const f = fixture();
      saveConnections(f.root, { CODEX_AUTH_JSON: auth });
      const project = JSON.parse(readFileSync(f.file, "utf8"));
      project.environments = {
        test: { ...docker, buildArgs: { VERSION: secret } },
      };
      project.verification = { mode: "browser", environment: "test" };
      delete project.vercel;
      writeFileSync(f.file, JSON.stringify(project));
      const run = vi.fn<DockerRun>(async () => ({
        code: 0,
        stdout: "",
        stderr: "",
      }));
      const worker = {
        ensureImage: vi.fn(),
        smokeEnvironment: vi.fn(),
      } as unknown as DockerRunners;
      const selected = vi.fn();
      const access = createEnvironmentAccess({
        root: f.root,
        packageRoot,
        env: {},
        run,
        docker: worker,
        selectRunner: selected,
      });
      await access.verify("app");
      await access.idle();
      expect(access.status("app")).toMatchObject({
        status: "failed",
        message: expect.stringMatching(
          /public build argument contains a saved credential/,
        ),
      });
      expect(JSON.stringify(access.status("app"))).not.toContain(secret);
      expect(run).not.toHaveBeenCalled();
      expect(selected).not.toHaveBeenCalled();
      expect(worker.smokeEnvironment).not.toHaveBeenCalled();
      await access.close();
    },
  );
  it("rejects refreshed canonical token components even when an unchanged exported auth seed has precedence", async () => {
    const f = fixture(),
      refreshed = {
        ...tokens,
        refresh_token: "synthetic-new-canonical-refresh",
      };
    saveConnections(f.root, {
      CODEX_AUTH_JSON: JSON.stringify({
        auth_mode: "chatgpt",
        OPENAI_API_KEY: null,
        tokens: refreshed,
      }),
    });
    const project = JSON.parse(readFileSync(f.file, "utf8"));
    project.environments = {
      test: { ...docker, buildArgs: { VERSION: refreshed.refresh_token } },
    };
    project.verification = { mode: "browser", environment: "test" };
    delete project.vercel;
    writeFileSync(f.file, JSON.stringify(project));
    const sourceControl = {
      acquireLease: vi.fn(async () => {
        throw new Error(
          "Source handoff must not occur for a leaked public build argument",
        );
      }),
      releaseLease: vi.fn(async () => {}),
    };
    const run = vi.fn<DockerRun>(async () => ({
      code: 0,
      stdout: "",
      stderr: "",
    }));
    const worker = {
      ensureImage: vi.fn(),
      smokeEnvironment: vi.fn(),
    } as unknown as DockerRunners;
    const access = createEnvironmentAccess({
      root: f.root,
      packageRoot,
      env: { CODEX_AUTH_JSON: auth },
      run,
      docker: worker,
      sourceControl,
    });
    await access.verify("app");
    await access.idle();
    expect(access.status("app")).toMatchObject({
      status: "failed",
      message: expect.stringMatching(
        /public build argument contains a saved credential/,
      ),
    });
    expect(sourceControl.acquireLease).not.toHaveBeenCalled();
    expect(worker.smokeEnvironment).not.toHaveBeenCalled();
    await access.close();
  });
});
