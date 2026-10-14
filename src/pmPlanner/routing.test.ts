import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDockerPlanner, type PlannerDockerRun } from "./docker.ts";
import {
  readAiRouting,
  saveAiRouting,
  type AiRoutingTarget,
} from "../ai/routing.ts";
import { saveAiSelection } from "../ai/provider.ts";
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
const target: AiRoutingTarget = {
  project: { name: "app" },
  area: { key: "checkout" },
  role: "pm",
};
const auth = JSON.stringify({
  auth_mode: "chatgpt",
  tokens: {
    id_token: "synthetic-id",
    access_token: "synthetic-access",
    refresh_token: "synthetic-refresh",
    account_id: "account-1",
  },
});
function fixture(
  options: {
    onRefresh?: (root: string) => void;
    onImage?: (root: string) => void;
    env?: NodeJS.ProcessEnv;
    legacyExplicit?: boolean;
  } = {},
) {
  const root = mkdtempSync(
    join(realpathSync(tmpdir()), "gremlins-planner-route-"),
  );
  roots.push(root);
  let owner = "";
  const run = vi.fn<PlannerDockerRun>(async (args) => {
    if (args[0] === "create")
      owner = args[args.indexOf("--label") + 1]!.split("=")[1]!;
    return {
      code: 0,
      stdout:
        args[0] === "start"
          ? '{"plannerEnvelope":1,"plannerOutput":{"answer":"safe"}}'
          : args[0] === "inspect"
            ? owner
            : "",
      stderr: "",
    };
  });
  const refresh = vi.fn(async () => {
      options.onRefresh?.(root);
      return { CODEX_AUTH_JSON: auth };
    }),
    image = vi.fn(async () => {
      options.onImage?.(root);
      return "shipgremlins-local:0123456789abcdef";
    });
  const execute = createDockerPlanner({
    root,
    packageRoot: ".",
    run,
    ensureImage: image,
    prepareCodexCredentials: refresh,
    ...(options.legacyExplicit
      ? {}
      : { env: () => options.env ?? { CODEX_AUTH_JSON: auth } }),
  });
  return { root, run, refresh, image, execute };
}
const input = () => ({
  ai: { provider: "codex" as const },
  aiTarget: target,
  credential: auth,
  prompt: "private context",
  system: "fixed rules",
  schema: { type: "object" },
  signal: new AbortController().signal,
});
const route = (root: string, provider: "claude" | "codex") =>
  saveAiRouting(
    root,
    target,
    { revision: readAiRouting(root, target, {}).revision, pm: { provider } },
    {},
  );
describe("planner scoped AI handoff", () => {
  it("rejects a route changed before executor entry, before any refresh or image work", async () => {
    const f = fixture();
    route(f.root, "claude");
    await expect(f.execute(input())).rejects.toMatchObject({
      code: "canceled",
    });
    expect(f.refresh).not.toHaveBeenCalled();
    expect(f.image).not.toHaveBeenCalled();
    expect(f.run).not.toHaveBeenCalled();
  });
  it.each(["onRefresh", "onImage"] as const)(
    "rechecks scoped policy after %s without launching a stale planner",
    async (hook) => {
      const f = fixture({ [hook]: (root: string) => route(root, "claude") });
      await expect(f.execute(input())).rejects.toMatchObject({
        code: "canceled",
      });
      expect(f.run).not.toHaveBeenCalled();
    },
  );
  it("uses controller environment selection and catches an implicit workspace provider change", async () => {
    const env: NodeJS.ProcessEnv = { CODEX_AUTH_JSON: auth },
      f = fixture({
        env,
        onRefresh: () => {
          env.CLAUDE_CODE_OAUTH_TOKEN = "connected-claude";
        },
      });
    const { aiTarget: _target, ...workspaceInput } = input();
    await expect(f.execute(workspaceInput)).rejects.toMatchObject({
      code: "canceled",
    });
    expect(f.run).not.toHaveBeenCalled();
  });
  it("keeps explicit legacy planner selections while never forwarding controller routing or environment", async () => {
    const f = fixture({ legacyExplicit: true }),
      { aiTarget: _target, ...explicit } = input();
    await expect(f.execute(explicit)).resolves.toEqual({ answer: "safe" });
    const payload = JSON.parse(
      f.run.mock.calls.find(([args]) => args[0] === "start")![1]!.stdin!,
    );
    expect(payload.ai).toEqual({ provider: "codex" });
    expect(payload.aiTarget).toBeUndefined();
    expect(payload.env).toBeUndefined();
  });
  it("honors a scoped Codex choice even when workspace Claude is connected", async () => {
    const f = fixture({
      env: {
        CLAUDE_CODE_OAUTH_TOKEN: "connected-claude",
        CODEX_AUTH_JSON: auth,
      },
    });
    saveAiSelection(f.root, { provider: "claude" });
    route(f.root, "codex");
    await expect(f.execute(input())).resolves.toEqual({ answer: "safe" });
    expect(f.refresh).toHaveBeenCalledWith({ provider: "codex" });
    expect(JSON.stringify(f.run.mock.calls)).not.toContain("connected-claude");
  });
});
