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
import { codexWorkerAuth, saveAiSelection } from "../ai/provider.ts";
import { loadProject } from "../config.ts";
import { knowledgeRevision } from "../pmKnowledge/index.ts";
import { initializeSetup } from "../setup/files.ts";
import type { LinearTicket } from "../services/types.ts";
import { createJobPreparation } from "./jobs.ts";
import { LocalJobDeferredError } from "./engine.ts";
import type { LocalJob, LocalJobInput } from "./types.ts";
import { validatePayload } from "./docker.ts";

const packageRoot = fileURLToPath(new URL("../..", import.meta.url)),
  roots: string[] = [];
const auth = (label = "saved") =>
  JSON.stringify({
    auth_mode: "chatgpt",
    OPENAI_API_KEY: null,
    tokens: {
      id_token: `synthetic-id-${label}`,
      access_token: `synthetic-access-${label}`,
      refresh_token: `synthetic-refresh-${label}`,
      account_id: "account-123",
    },
    last_refresh: "2026-10-10T00:00:00.000Z",
  });
const ticket: LinearTicket = {
  id: "ticket-id",
  identifier: "APP-12",
  title: "Fix form",
  description:
    "Fix the observed submission defect.\n\n## Acceptance criteria\n- A valid submission persists after reload.",
  labels: ["pm:core", "pm-approved"],
  projectId: "linear-project",
  stateType: "unstarted",
  priority: 1,
  createdAt: "2026-10-01T00:00:00Z",
  updatedAt: "2026-10-01T00:00:00Z",
  url: "https://linear.app/example/APP-12",
};
const queued = (input: LocalJobInput): LocalJob => ({
  id: "job-codex",
  runId: 1,
  status: "queued",
  createdAt: "2026-10-14T09:00:00.000Z",
  ...input,
});
const discovery: LocalJobInput = {
  type: "pm",
  project: "app",
  area: "core",
  runOnce: true,
  pmMode: "discovery",
};
const coding: LocalJobInput = {
  type: "developer",
  project: "app",
  area: "core",
  ticket: "APP-12",
  runOnce: true,
};
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function fixture(
  env: NodeJS.ProcessEnv = {
    CODEX_AUTH_JSON: auth(),
    CLAUDE_CODE_OAUTH_TOKEN: "available-claude",
  },
) {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "gremlins-codex-jobs-")),
  );
  roots.push(root);
  initializeSetup(root, packageRoot, {
    project: "app",
    repo: "owner/app",
    settings: { workflow: { kind: "pull-request", baseBranch: "main" } },
  });
  const projectFile = join(root, "projects/app/project.json"),
    project = JSON.parse(readFileSync(projectFile, "utf8"));
  project.verified = "2026-10-14";
  writeFileSync(projectFile, JSON.stringify(project));
  const areasFile = join(root, "projects/app/areas.json"),
    areas = JSON.parse(readFileSync(areasFile, "utf8"));
  areas.areas.core.linearProjectId = "linear-project";
  areas.areas.core.mandate =
    "Inspect the repository and fix verified submission defects.";
  writeFileSync(areasFile, JSON.stringify(areas));
  saveAiSelection(root, { provider: "codex", model: "gpt-6.1-sol" });
  const sourceControl = {
    acquireLease: vi.fn(async () => ({
      token: "source-job-token",
      method: "token" as const,
      commitIdentity: {
        name: "Builder",
        email: "42+builder@users.noreply.github.com",
      },
    })),
    resolveCredential: vi.fn(async () => ({
      token: "source-read-token",
      method: "token" as const,
    })),
    releaseLease: vi.fn(async () => {}),
  };
  const linearCredential = {
    token: "linear-job-token",
    authorization: "linear-job-token",
    method: "token" as const,
  };
  const linearConnection = {
    acquireLease: vi.fn(async () => linearCredential),
    resolveCredential: vi.fn(async () => linearCredential),
    releaseLease: vi.fn(async () => {}),
  };
  const prepareCodexCredentials = vi.fn(
    async (): Promise<Record<string, string>> => ({
      CODEX_AUTH_JSON: codexWorkerAuth(auth("refreshed")),
    }),
  );
  const preparation = createJobPreparation({
    root,
    env,
    sourceControl,
    linearConnection,
    linear: () => ({
      getTicket: async () => ticket,
      listTickets: async () => [ticket],
    }),
    prepareCodexCredentials,
  });
  return {
    root,
    sourceControl,
    linearConnection,
    prepareCodexCredentials,
    preparation,
  };
}

describe("Codex job admission and private handoff", () => {
  it("prepares repository discovery with selected Codex and source credentials only", async () => {
    const f = fixture(),
      admission = await f.preparation.validate(discovery);
    const payload = await f.preparation.prepareJob(
      queued({ ...discovery, discoveryRevision: admission.discoveryRevision }),
    );
    expect(payload.ai).toEqual({ provider: "codex", model: "gpt-6.1-sol" });
    expect(Object.keys(payload.credentials!).sort()).toEqual([
      "CODEX_AUTH_JSON",
      "GITHUB_TOKEN",
    ]);
    expect(
      JSON.parse(payload.credentials!.CODEX_AUTH_JSON!).tokens,
    ).toMatchObject({
      access_token: "synthetic-access-refreshed",
      refresh_token: "",
    });
    expect(payload.prompt).not.toMatch(
      /available-claude|synthetic-access-|synthetic-refresh-/,
    );
    expect(payload.commands).toBeUndefined();
    expect(payload.delivery).toBeUndefined();
    expect(f.sourceControl.acquireLease).toHaveBeenCalledWith(
      expect.objectContaining({ write: false }),
    );
    expect(f.linearConnection.acquireLease).not.toHaveBeenCalled();
    expect(f.prepareCodexCredentials).toHaveBeenCalledOnce();
    expect(() => validatePayload(payload)).not.toThrow();
    await f.preparation.releaseJobResources("job-codex");
  });
  it("prepares coding with a fresh Codex snapshot, scoped source and Linear leases, and no Claude credential", async () => {
    const f = fixture(),
      payload = await f.preparation.prepareJob(queued(coding));
    expect(payload.ai).toEqual({ provider: "codex", model: "gpt-6.1-sol" });
    expect(Object.keys(payload.credentials!).sort()).toEqual([
      "CODEX_AUTH_JSON",
      "GITHUB_TOKEN",
      "LINEAR_API_KEY",
    ]);
    expect(
      JSON.parse(payload.credentials!.CODEX_AUTH_JSON!).tokens.refresh_token,
    ).toBe("");
    expect(f.sourceControl.acquireLease).toHaveBeenCalledWith(
      expect.objectContaining({ write: true }),
    );
    expect(f.prepareCodexCredentials).toHaveBeenCalledOnce();
    expect(() => validatePayload(payload)).not.toThrow();
    await f.preparation.releaseJobResources("job-codex");
  });
  it.each([
    { provider: "claude" as const, env: { CODEX_AUTH_JSON: auth() } },
    {
      provider: "codex" as const,
      env: { CLAUDE_CODE_OAUTH_TOKEN: "available-claude" },
    },
  ])(
    "blocks selected missing $provider before acquiring any job lease",
    async ({ provider, env }) => {
      const f = fixture(env);
      saveAiSelection(f.root, { provider });
      await expect(f.preparation.validate(discovery)).rejects.toThrow(
        /selected AI provider/,
      );
      const project = loadProject(f.root, "app"),
        revision = knowledgeRevision(project, project.areas[0]!);
      await expect(
        f.preparation.prepareJob(
          queued({ ...discovery, discoveryRevision: revision }),
        ),
      ).rejects.toThrow(/selected AI provider/);
      expect(f.sourceControl.acquireLease).not.toHaveBeenCalled();
      expect(f.prepareCodexCredentials).not.toHaveBeenCalled();
    },
  );
  it("does not fall back to cached auth or Claude if trusted Codex refresh cannot return credentials", async () => {
    const f = fixture();
    f.prepareCodexCredentials.mockResolvedValue({});
    const admission = await f.preparation.validate(discovery);
    await expect(
      f.preparation.prepareJob(
        queued({
          ...discovery,
          discoveryRevision: admission.discoveryRevision,
        }),
      ),
    ).rejects.toThrow(/Reconnect Codex/);
    expect(f.sourceControl.releaseLease).toHaveBeenCalledWith("job-codex");
  });
  it("defers when the selected provider changes during trusted refresh and releases acquired leases", async () => {
    const f = fixture();
    f.prepareCodexCredentials.mockImplementation(async () => {
      saveAiSelection(f.root, { provider: "claude" });
      return { CODEX_AUTH_JSON: codexWorkerAuth(auth("refreshed")) };
    });
    await expect(
      f.preparation.prepareJob(queued(coding)),
    ).rejects.toBeInstanceOf(LocalJobDeferredError);
    expect(f.sourceControl.releaseLease).toHaveBeenCalledWith("job-codex");
    expect(f.linearConnection.releaseLease).toHaveBeenCalledWith("job-codex");
  });
});
