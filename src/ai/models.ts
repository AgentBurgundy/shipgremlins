import { createHash, randomUUID } from "node:crypto";
import type { CatalogModel } from "../../runner-local/ai-models.mjs";
import { createDockerRunners } from "../localRunners/docker.ts";
import {
  runPlannerDocker,
  type PlannerDockerRun,
} from "../pmPlanner/docker.ts";
import { createCodexLogin } from "../setup/codexLogin.ts";
import { readConnections } from "../setup/connections.ts";
import {
  AiProviderError,
  aiSecretValues,
  codexAccountAuth,
  hasAiCredentials,
  normalizeCodexAuth,
  type AiProvider,
  type AiSelection,
} from "./provider.ts";

export interface AiModelCatalog {
  provider: AiProvider;
  models: CatalogModel[];
  source: "provider" | "supported";
  /** A CLI catalog can be bundled; only an actual run establishes model access. */
  availability: "not-verified";
  message: string;
}
type PendingCatalog = {
  key: string;
  controller: AbortController;
  promise: Promise<AiModelCatalog>;
  dependencies: Promise<unknown>[];
  work?: Promise<AiModelCatalog>;
};
const aliases: CatalogModel[] = [
  { id: "sonnet", label: "Sonnet" },
  { id: "opus", label: "Opus" },
  { id: "haiku", label: "Haiku" },
];
const fallback = (provider: AiProvider): AiModelCatalog => ({
  provider,
  models: provider === "claude" ? structuredClone(aliases) : [],
  source: "supported",
  availability: "not-verified",
  message:
    provider === "claude"
      ? "Supported Claude Code aliases. Availability depends on your account; Provider default remains available."
      : "The Codex model catalog is unavailable. Use Provider default, or start Docker and reconnect Codex to load its catalog.",
});
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const controls = (value: string) =>
  [...value].some(
    (character) =>
      character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
  );
function models(raw: string, secrets: string[]): CatalogModel[] {
  if (
    Buffer.byteLength(raw) > 65536 ||
    secrets.some(
      (secret) =>
        secret &&
        [
          secret,
          encodeURIComponent(secret),
          JSON.stringify(secret).slice(1, -1),
        ].some((value) => raw.includes(value)),
    )
  )
    throw Error();
  const value: unknown = JSON.parse(raw);
  if (
    !object(value) ||
    Object.keys(value).some((key) => key !== "models") ||
    !Array.isArray(value.models) ||
    value.models.length > 64
  )
    throw Error();
  const ids = new Set<string>();
  return value.models.flatMap((entry) => {
    if (
      !object(entry) ||
      Object.keys(entry).some(
        (key) => !["id", "label", "description"].includes(key),
      ) ||
      typeof entry.id !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/.test(entry.id) ||
      typeof entry.label !== "string" ||
      !entry.label.trim() ||
      entry.label.length > 100 ||
      controls(entry.label) ||
      (entry.description !== undefined &&
        (typeof entry.description !== "string" ||
          entry.description.length > 400 ||
          controls(entry.description)))
    )
      throw Error();
    if (entry.id === "default" || ids.has(entry.id)) return [];
    ids.add(entry.id);
    return [
      {
        id: entry.id,
        label: entry.label,
        ...(typeof entry.description === "string" && entry.description
          ? { description: entry.description }
          : {}),
      },
    ];
  });
}
function cancellable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error("Catalog canceled."));
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new Error("Catalog canceled."));
    signal.addEventListener("abort", abort, { once: true });
    promise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort))
      .catch(() => {});
  });
}
export function createAiModels(options: {
  root: string;
  packageRoot: string;
  env?: () => NodeJS.ProcessEnv;
  prepareCodexCredentials?: (
    ai: AiSelection,
  ) => Promise<Record<string, string>>;
  run?: PlannerDockerRun;
  ensureImage?: () => Promise<string>;
  now?: () => number;
  timeoutMs?: number;
}) {
  const run = options.run ?? runPlannerDocker,
    now = options.now ?? Date.now,
    cache = new Map<
      string,
      { at: number; ttl: number; value: AiModelCatalog }
    >(),
    pending = new Map<AiProvider, PendingCatalog>();
  let closed = false,
    login: ReturnType<typeof createCodexLogin> | undefined,
    runners: ReturnType<typeof createDockerRunners> | undefined;
  const environment = () => options.env?.() ?? process.env;
  const fingerprint = () => hash(codexAccountAuth(options.root, environment()));
  const ensureImage =
    options.ensureImage ??
    (() =>
      (runners ??= createDockerRunners({
        packageRoot: options.packageRoot,
      })).ensureImage());
  const prepare = (ai: AiSelection) =>
    options.prepareCodexCredentials?.(ai) ??
    (login ??= createCodexLogin({
      root: options.root,
      packageRoot: options.packageRoot,
      env: environment,
    })).prepare(ai);
  async function cleanup(name: string, owner: string) {
    const inspected = await run(
      [
        "inspect",
        "--format",
        '{{index .Config.Labels "io.shipgremlins.model-catalog"}}',
        name,
      ],
      { timeoutMs: 2000, maxBytes: 1024 },
    );
    if (inspected.code !== 0 || inspected.stdout.trim() !== owner)
      throw Error();
    if (
      (await run(["rm", "--force", name], { timeoutMs: 2000, maxBytes: 1024 }))
        .code !== 0
    )
      throw Error();
  }
  async function query(
    provider: AiProvider,
    state: PendingCatalog,
  ): Promise<AiModelCatalog> {
    const signal = state.controller.signal,
      name = `gremlins-models-${randomUUID()}`,
      owner = randomUUID();
    let attempted = false,
      auth: string | undefined;
    try {
      const privateValues = [
        ...aiSecretValues(environment()),
        ...aiSecretValues(readConnections(options.root)),
      ];
      if (provider === "codex") {
        const account = JSON.parse(
          codexAccountAuth(options.root, environment()),
        ).tokens.account_id;
        const preparing = prepare({ provider: "codex" });
        state.dependencies.push(preparing);
        const prepared = await cancellable(preparing, signal);
        const value = JSON.parse(
          normalizeCodexAuth(prepared.CODEX_AUTH_JSON ?? "", {
            requireRefresh: false,
          }),
        );
        if (
          value.tokens.account_id !== account ||
          JSON.parse(codexAccountAuth(options.root, environment())).tokens
            .account_id !== account
        )
          throw Error();
        value.tokens.refresh_token = "";
        value.last_refresh = new Date(now()).toISOString();
        auth = JSON.stringify(value);
        privateValues.push(
          ...aiSecretValues(prepared),
          ...aiSecretValues(readConnections(options.root)),
          account,
        );
        state.key = `codex:${fingerprint()}`;
      }
      if (signal.aborted) throw Error();
      const building = ensureImage();
      state.dependencies.push(building);
      const image = await cancellable(building, signal);
      if (signal.aborted || !/^shipgremlins-local:[a-f0-9]{16}$/.test(image))
        throw Error();
      attempted = true;
      const created = await run(
        [
          "create",
          "--name",
          name,
          "--label",
          `io.shipgremlins.model-catalog=${owner}`,
          "--interactive",
          "--restart",
          "no",
          "--read-only",
          "--user",
          "1000:1000",
          "--cpus",
          "0.5",
          "--memory",
          "256m",
          "--pids-limit",
          "64",
          "--cap-drop",
          "ALL",
          "--security-opt",
          "no-new-privileges",
          "--tmpfs",
          "/auth:rw,nosuid,nodev,uid=1000,gid=1000,mode=0700,size=33554432",
          "--tmpfs",
          "/tmp:rw,nosuid,nodev,mode=1777,size=33554432",
          "--workdir",
          "/auth",
          "--entrypoint",
          "node",
          image,
          "--input-type=module",
          "-e",
          'import("/opt/gremlins/ai-models.mjs").then(module=>module.runAiModels());',
        ],
        { signal, timeoutMs: 5000, maxBytes: 4096 },
      );
      if (created.code !== 0 || signal.aborted) throw Error();
      const result = await run(["start", "--attach", "--interactive", name], {
        stdin: JSON.stringify({ provider, ...(auth ? { auth } : {}) }),
        signal,
        timeoutMs: 9000,
        maxBytes: 65536,
      });
      if (
        result.code !== 0 ||
        signal.aborted ||
        (provider === "codex" && `codex:${fingerprint()}` !== state.key)
      )
        throw Error();
      const catalog = models(result.stdout, privateValues);
      if (!catalog.length) throw Error();
      return {
        provider,
        models: catalog,
        source: provider === "codex" ? "provider" : "supported",
        availability: "not-verified",
        message:
          "Models reported by the pinned provider CLI. This catalog does not verify account access; availability is checked when a run starts.",
      };
    } finally {
      if (attempted) await cleanup(name, owner);
    }
  }
  async function list(provider: AiProvider): Promise<AiModelCatalog> {
    if (!["claude", "codex"].includes(provider))
      throw new AiProviderError(
        "Choose Claude Code or Codex for the model catalog.",
      );
    if (closed) return fallback(provider);
    let key = "claude:supported";
    if (provider === "codex") {
      if (!hasAiCredentials(options.root, environment(), { provider }))
        return fallback(provider);
      key = `codex:${fingerprint()}`;
    }
    const cached = cache.get(key);
    if (cached && now() - cached.at < cached.ttl)
      return structuredClone(cached.value);
    const previous = pending.get(provider);
    if (previous?.key === key) return structuredClone(await previous.promise);
    previous?.controller.abort();
    const state: PendingCatalog = {
      key,
      controller: new AbortController(),
      promise: Promise.resolve(fallback(provider)),
      dependencies: [],
    };
    let timer: ReturnType<typeof setTimeout>;
    const work = query(provider, state).catch(() => fallback(provider));
    state.work = work;
    // The request may time out before a shared refresh/build ends. Keep its
    // admission reserved until those dependencies settle; never cancel them.
    void work
      .finally(async () => {
        await Promise.allSettled(state.dependencies);
        if (pending.get(provider) === state) pending.delete(provider);
      })
      .catch(() => {});
    state.promise = Promise.race([
      work,
      new Promise<AiModelCatalog>((resolve) => {
        timer = setTimeout(
          () => {
            state.controller.abort();
            resolve(fallback(provider));
          },
          Math.max(1, Math.min(options.timeoutMs ?? 9000, 10000)),
        );
      }),
    ])
      .then((value) => {
        let current = provider !== "codex";
        try {
          current ||= `codex:${fingerprint()}` === state.key;
        } catch {
          /* Account clear/replacement invalidates this result. */
        }
        if (!current) return fallback(provider);
        if (!closed && current) {
          cache.set(state.key, {
            at: now(),
            ttl: value.source === "provider" ? 300000 : 15000,
            value,
          });
          if (cache.size > 8) cache.delete(cache.keys().next().value!);
        }
        return value;
      })
      .finally(() => {
        clearTimeout(timer);
      });
    pending.set(provider, state);
    return structuredClone(await state.promise);
  }
  async function close() {
    closed = true;
    const active = [...pending.values()];
    for (const value of active) value.controller.abort();
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.allSettled(active.map((value) => value.work)),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, 5000);
      }),
    ]);
    clearTimeout(timer);
    await login?.close();
  }
  return { list, close };
}
