import { posix } from "node:path";
import { parseDocument } from "yaml";
import type { Project } from "../config.ts";
import {
  parseDockerTarget,
  publicBuildArgument,
  safeRecipePath,
  type DockerEnvironmentTarget,
} from "../testEnvironments/recipe.ts";
import {
  object,
  sourceApi,
  sourceRequest,
  resolveRepositoryHead,
  SHA,
  safeSourcePath,
} from "./repository.ts";
import { ProjectOnboardingError, type OnboardingReport } from "./types.ts";

export interface ComposeImport {
  path: string;
  service: string;
  status: "ready" | "unsupported";
  diagnostics: Array<{
    feature: string;
    message: string;
    severity: "error" | "warning";
  }>;
  target?: DockerEnvironmentTarget;
  missingInputs: OnboardingReport["missingInputs"];
}
export const composePath = (path: string) =>
  /(?:^|\/)(?:compose|docker-compose)(?:\.[a-z0-9-]+)?\.ya?ml$/i.test(path) &&
  safeSourcePath(path);
const scalar = (value: unknown): value is string | number | boolean =>
  ["string", "number", "boolean"].includes(typeof value);
const serviceKind = (value: unknown) =>
  typeof value === "string" && /^postgres:16(?:[.-][a-z0-9.-]+)?$/.test(value)
    ? "postgres"
    : typeof value === "string" && /^redis:7(?:[.-][a-z0-9.-]+)?$/.test(value)
      ? "redis"
      : undefined;
const reference = (service: string, key: string) =>
  `TEST_COMPOSE_${service}_${key}`
    .toUpperCase()
    .replace(/[^A-Z0-9_]/g, "_")
    .slice(0, 127);

/** Translate inspected data only. No interpolation, .env loading, shell or Compose execution. */
export function importComposeDocument(
  path: string,
  content: string,
  repositoryPaths: ReadonlySet<string>,
  selectedService?: string,
): ComposeImport[] {
  const base: ComposeImport = {
    path,
    service: selectedService ?? "",
    status: "unsupported",
    diagnostics: [],
    missingInputs: [],
  };
  const reject = (feature: string, message: string) => [
    {
      ...base,
      diagnostics: [{ feature, message, severity: "error" as const }],
    },
  ];
  if (!composePath(path) || Buffer.byteLength(content) > 65536)
    return reject(
      "source",
      "Choose a tracked Compose file no larger than 64 KiB.",
    );
  let raw: Record<string, unknown>;
  try {
    const document = parseDocument(content, {
      schema: "core",
      uniqueKeys: true,
      merge: false,
    });
    if (document.errors.length || document.warnings.length) throw Error();
    const value = document.toJS({ maxAliasCount: 0 });
    if (
      !object(value) ||
      !object(value.services) ||
      Object.keys(value.services).length < 1 ||
      Object.keys(value.services).length > 6
    )
      throw Error();
    raw = value;
  } catch {
    return reject(
      "yaml",
      "Compose must contain one bounded services map, with unique keys, no aliases or custom YAML tags.",
    );
  }
  const entries = Object.entries(raw.services as Record<string, unknown>);
  const apps = entries.filter(
    ([, value]) => !object(value) || !serviceKind(value.image),
  );
  const candidates = selectedService
    ? apps.filter(([name]) => name === selectedService)
    : apps;
  if (!candidates.length)
    return reject(
      "services",
      "No supported application service was found. Select one app plus optional Postgres 16 and Redis 7.",
    );
  return candidates.slice(0, 4).map(([name, value]) => {
    const result: ComposeImport = {
      ...base,
      service: name,
      diagnostics: [],
      missingInputs: [],
    };
    const diagnostic = (
      feature: string,
      message: string,
      severity: "error" | "warning" = "error",
    ) => result.diagnostics.push({ feature, message, severity });
    const unsupported = (
      row: Record<string, unknown>,
      allowed: string[],
      prefix: string,
    ) => {
      for (const key of Object.keys(row))
        if (!allowed.includes(key) && !key.startsWith("x-"))
          diagnostic(
            `${prefix}.${key}`,
            "This Compose feature cannot be reproduced by the isolated test recipe. Remove it from a dedicated test Compose file.",
          );
    };
    unsupported(
      raw,
      ["services", "version", "name", "volumes", "networks"],
      "compose",
    );
    if (apps.length !== 1)
      diagnostic(
        "services",
        "The isolated recipe supports exactly one application service. Split additional application services into a dedicated test stack.",
      );
    if (!object(value)) {
      diagnostic("service", "Application service must be an object.");
      return result;
    }
    unsupported(
      value,
      [
        "image",
        "build",
        "ports",
        "expose",
        "command",
        "environment",
        "depends_on",
        "healthcheck",
        "restart",
        "networks",
      ],
      `services.${name}`,
    );
    if (raw.networks !== undefined) {
      if (
        !object(raw.networks) ||
        Object.values(raw.networks).some(
          (network) =>
            network !== null &&
            (!object(network) ||
              Object.keys(network).some((key) => key !== "driver") ||
              (network.driver !== undefined && network.driver !== "bridge")),
        )
      )
        diagnostic(
          "networks",
          "External, host and customized networks are unsupported. The test recipe creates its own isolated bridge network.",
        );
    }
    const target: Record<string, unknown> = { kind: "docker", role: "staging" };
    const normalizePath = (literal: unknown) => {
      if (typeof literal !== "string" || /[$\\]|^[a-z]+:|^\//i.test(literal))
        return undefined;
      const resolved = posix.normalize(
        posix.join(posix.dirname(path), literal),
      );
      return safeRecipePath(resolved) ? resolved : undefined;
    };
    if (value.build !== undefined) {
      const build =
        typeof value.build === "string"
          ? { context: value.build }
          : value.build;
      if (!object(build))
        diagnostic(
          "build",
          "Use a repository build context and tracked Dockerfile.",
        );
      else {
        unsupported(build, ["context", "dockerfile", "args"], "build");
        const context = normalizePath(build.context ?? ".");
        const dockerfile =
          context && safeRecipePath(build.dockerfile ?? "Dockerfile")
            ? posix.normalize(
                posix.join(context, String(build.dockerfile ?? "Dockerfile")),
              )
            : undefined;
        if (
          !context ||
          !dockerfile ||
          !safeRecipePath(dockerfile) ||
          !repositoryPaths.has(dockerfile)
        )
          diagnostic(
            "build.dockerfile",
            "The build needs a tracked, regular Dockerfile inside its repository context; remote contexts, interpolation and traversal are unsupported.",
          );
        else target.recipe = { kind: "dockerfile", context, dockerfile };
        if (build.args !== undefined) {
          if (
            !object(build.args) ||
            Object.entries(build.args).some(
              ([key, item]) =>
                !scalar(item) || !publicBuildArgument(key, String(item)),
            )
          )
            diagnostic(
              "build.args",
              "Only explicit public build arguments can be imported. Replace credential or interpolated arguments with reviewed BuildKit TEST_* secret references.",
            );
          else
            target.buildArgs = Object.fromEntries(
              Object.entries(build.args).map(([key, item]) => [
                key,
                String(item),
              ]),
            );
        }
      }
    } else target.recipe = { kind: "image", image: value.image };
    const ports = value.ports ?? value.expose;
    const mapped = Array.isArray(ports)
      ? ports.map((port) =>
          object(port)
            ? port.protocol === undefined || port.protocol === "tcp"
              ? Number(port.target)
              : NaN
            : typeof port === "number"
              ? port
              : typeof port === "string" &&
                  /^(?:[0-9.]+:)?(?:[0-9]+:)?[0-9]+(?:\/tcp)?$/.test(port)
                ? Number(
                    port
                      .replace(/\/tcp$/, "")
                      .split(":")
                      .at(-1),
                  )
                : NaN,
        )
      : [];
    if (
      !mapped.length ||
      mapped.some(
        (port) => !Number.isInteger(port) || port < 1 || port > 65535,
      ) ||
      new Set(mapped).size !== 1
    )
      diagnostic(
        "ports",
        "Expose exactly one explicit internal TCP application port. Host publication is replaced by the private test network.",
      );
    else target.port = mapped[0];
    if (value.command !== undefined) {
      if (
        !Array.isArray(value.command) ||
        !value.command.length ||
        !value.command.every(
          (item) => typeof item === "string" && !item.includes("$"),
        )
      )
        diagnostic(
          "command",
          "Use an explicit command argument array; shell strings and environment interpolation are not executed by the importer.",
        );
      else target.start = value.command;
    }
    if (value.healthcheck !== undefined) {
      const health = value.healthcheck;
      const urls =
        object(health) && Array.isArray(health.test)
          ? health.test.filter(
              (item) => typeof item === "string" && /^https?:\/\//.test(item),
            )
          : [];
      try {
        if (urls.length !== 1) throw Error();
        const url = new URL(urls[0]);
        if (
          !["localhost", "127.0.0.1"].includes(url.hostname) ||
          Number(url.port || 80) !== target.port ||
          url.search ||
          url.hash ||
          url.username ||
          url.password
        )
          throw Error();
        target.healthPath = url.pathname;
        diagnostic(
          "healthcheck",
          "Imported the HTTP health path; timing and command execution are replaced by the managed readiness probe.",
          "warning",
        );
      } catch {
        diagnostic(
          "healthcheck",
          "Only an explicit localhost HTTP health URL matching the application port can be imported. Custom health commands are unsupported.",
        );
      }
    }
    const dependencies = entries.filter(
      ([, item]) => object(item) && serviceKind(item.image),
    );
    const services: Array<{
      kind: "postgres" | "redis";
      name: string;
      env: string;
    }> = [];
    const environment: Record<string, unknown> = Object.create(null);
    if (Array.isArray(value.environment)) {
      for (const item of value.environment) {
        if (typeof item !== "string" || !item.includes("="))
          diagnostic(
            "environment",
            "Every environment variable needs an explicit value or named interpolation reference.",
          );
        else {
          const split = item.indexOf("=");
          const key = item.slice(0, split);
          if (Object.hasOwn(environment, key))
            diagnostic(
              "environment",
              "Duplicate environment variable names are unsupported.",
            );
          environment[key] = item.slice(split + 1);
        }
      }
    } else if (value.environment !== undefined) {
      if (!object(value.environment))
        diagnostic(
          "environment",
          "Environment must be a variable map or KEY=value list.",
        );
      else Object.assign(environment, value.environment);
    }
    const env: Record<string, string> = {};
    for (const [variable, item] of Object.entries(environment)) {
      let dependency: (typeof dependencies)[number] | undefined;
      if (typeof item === "string") {
        try {
          const url = new URL(item);
          dependency = dependencies.find(
            ([dependencyName, row]) =>
              object(row) &&
              url.hostname === dependencyName &&
              ((serviceKind(row.image) === "postgres" &&
                ["postgres:", "postgresql:"].includes(url.protocol)) ||
                (serviceKind(row.image) === "redis" &&
                  url.protocol === "redis:")),
          );
        } catch {
          /* Ordinary variable or unresolved reference. */
        }
      }
      if (dependency) {
        const [dependencyName, row] = dependency;
        const kind = serviceKind((row as Record<string, unknown>).image)!;
        if (services.some((service) => service.kind === kind))
          diagnostic(
            "environment",
            "Each disposable database may be injected into one application URL variable.",
          );
        else services.push({ kind, name: dependencyName, env: variable });
      } else {
        if (!scalar(item))
          diagnostic(
            "environment",
            "Runtime variables must have scalar values; inherited host variables are unsupported.",
          );
        env[variable] = reference(name, variable);
        result.missingInputs.push({
          key: `compose-${variable.toLowerCase().replace(/_/g, "-")}`.slice(
            0,
            63,
          ),
          label: variable,
          description: `Save the dedicated test value as ${env[variable]} in Connections. Compose literal values and host environment values are never copied into project settings.`,
          required: true,
        });
      }
    }
    for (const [dependencyName, row] of dependencies) {
      const dependency = row as Record<string, unknown>;
      unsupported(
        dependency,
        [
          "image",
          "environment",
          "healthcheck",
          "volumes",
          "ports",
          "expose",
          "restart",
          "networks",
        ],
        `services.${dependencyName}`,
      );
      if (!services.some((service) => service.name === dependencyName))
        diagnostic(
          `services.${dependencyName}`,
          "This database has no explicit application connection URL pointing to its Compose service name. Set that URL in a dedicated test Compose file.",
        );
      if (dependency.volumes !== undefined) {
        const volumes = dependency.volumes;
        if (
          !Array.isArray(volumes) ||
          volumes.some(
            (volume) =>
              typeof volume !== "string" ||
              !/^[a-zA-Z][a-zA-Z0-9_-]*:\/(?:var\/lib\/postgresql\/data|data)(?::rw)?$/.test(
                volume,
              ),
          )
        )
          diagnostic(
            `services.${dependencyName}.volumes`,
            "Bind mounts and custom volumes are unsupported. Only disposable named database data volumes can be translated.",
          );
        else
          diagnostic(
            `services.${dependencyName}.volumes`,
            "Database storage is disposable; the imported recipe never reuses the Compose volume or existing data.",
            "warning",
          );
      }
    }
    if (
      raw.volumes !== undefined &&
      (!object(raw.volumes) ||
        Object.values(raw.volumes).some(
          (volume) =>
            volume !== null && (!object(volume) || Object.keys(volume).length),
        ))
    )
      diagnostic(
        "volumes",
        "External volumes and volume drivers cannot be imported.",
      );
    if (value.depends_on !== undefined) {
      const names = Array.isArray(value.depends_on)
        ? value.depends_on
        : object(value.depends_on)
          ? Object.keys(value.depends_on)
          : [];
      if (
        !names.length ||
        names.some(
          (dependency) => !dependencies.some(([key]) => key === dependency),
        )
      )
        diagnostic(
          "depends_on",
          "Dependencies must reference only the imported Postgres or Redis service.",
        );
      if (
        object(value.depends_on) &&
        Object.values(value.depends_on).some(
          (condition) =>
            !object(condition) ||
            Object.keys(condition).some((key) => key !== "condition") ||
            !["service_started", "service_healthy"].includes(
              String(condition.condition),
            ),
        )
      )
        diagnostic(
          "depends_on",
          "Only service_started and service_healthy database dependencies are supported.",
        );
    }
    if (Object.keys(env).length) target.env = env;
    if (services.length) target.services = services;
    diagnostic(
      "isolation",
      "Host ports, restart policies and Compose network names are replaced by a disposable private network and managed cleanup. No application commands run on the host.",
      "warning",
    );
    try {
      const parsed = parseDockerTarget(target);
      if (!result.diagnostics.some((item) => item.severity === "error")) {
        result.status = "ready";
        result.target = parsed;
      }
    } catch {
      diagnostic(
        "recipe",
        "The translated service does not meet the bounded Docker recipe requirements. Check image, paths, variable names and service names.",
      );
    }
    return result;
  });
}

/** Fetch raw Compose only into the controller parser; never into AI prompts or persisted reports. */
export async function readComposeRepository(
  project: Project,
  token: string,
  fetcher: typeof fetch,
  signal: AbortSignal,
  input: { path?: string; service?: string } = {},
): Promise<OnboardingReport> {
  const api = sourceApi(project),
    provider = project.config.provider ?? "github";
  let head;
  try {
    head = await resolveRepositoryHead({
      project,
      credential: { token },
      fetch: fetcher,
      signal,
    });
  } catch (error) {
    if (!(error instanceof ProjectOnboardingError) || error.status !== 404)
      throw error;
    const { value } = await sourceRequest(fetcher, api, token, signal);
    if (!object(value) || typeof value.default_branch !== "string") throw error;
    head = await resolveRepositoryHead({
      project,
      branch: value.default_branch,
      credential: { token },
      fetch: fetcher,
      signal,
    });
  }
  const entries = new Map<string, string>();
  for (let page = 1; page <= (provider === "github" ? 1 : 5); page++) {
    const { value, headers } = await sourceRequest(
      fetcher,
      provider === "github"
        ? `${api}/git/trees/${head.sha}?recursive=1`
        : `${api}/repository/tree?ref=${head.sha}&recursive=true&per_page=100&page=${page}`,
      token,
      signal,
    );
    const tree = provider === "github" && object(value) ? value.tree : value;
    if (!Array.isArray(tree) || (object(value) && value.truncated === true))
      throw new ProjectOnboardingError(
        "Compose import requires a complete bounded repository tree. Choose a smaller source repository or use a manual test recipe.",
        422,
      );
    for (const row of tree)
      if (
        object(row) &&
        row.type === "blob" &&
        ["100644", "100755"].includes(String(row.mode)) &&
        safeSourcePath(row.path) &&
        typeof (row.sha ?? row.id) === "string" &&
        SHA.test(String(row.sha ?? row.id))
      )
        entries.set(row.path, String(row.sha ?? row.id));
    if (provider === "gitlab" && !headers.get("x-next-page")) break;
    if (provider === "gitlab" && page === 5 && headers.get("x-next-page"))
      throw new ProjectOnboardingError(
        "Compose import repository tree exceeds 500 entries. Use a smaller repository or a manual recipe.",
        422,
      );
  }
  const paths = [...entries.keys()].filter(composePath).sort();
  const selected = input.path
    ? paths.filter((path) => path === input.path)
    : paths.slice(0, 4);
  if (!selected.length)
    throw new ProjectOnboardingError(
      "No tracked Compose file was found on the inspection branch. Supported names include compose.yml and docker-compose.yaml.",
      422,
    );
  const imports: ComposeImport[] = [];
  for (const path of selected) {
    const { value } = await sourceRequest(
      fetcher,
      provider === "github"
        ? `${api}/git/blobs/${entries.get(path)}`
        : `${api}/repository/files/${encodeURIComponent(path)}?ref=${head.sha}`,
      token,
      signal,
    );
    if (
      !object(value) ||
      value.encoding !== "base64" ||
      typeof value.content !== "string" ||
      value.content.length > 100000
    )
      throw new ProjectOnboardingError(
        "Compose source exceeds the 64 KiB bounded import limit.",
        422,
      );
    imports.push(
      ...importComposeDocument(
        path,
        Buffer.from(value.content, "base64").toString("utf8"),
        new Set(entries.keys()),
        input.service,
      ),
    );
  }
  const ready = imports.filter((item) => item.status === "ready");
  const selectedTarget = ready.length === 1 ? ready[0]!.target : undefined;
  const docker = selectedTarget
    ? (({ kind: _kind, role: _role, access: _access, ...draft }) => draft)(
        selectedTarget,
      )
    : null;
  return {
    summary: selectedTarget
      ? "A repository Compose stack can run as a disposable test application."
      : "Compose import needs a supported test stack or a choice of application.",
    recommendation: docker ? "docker" : "hosted",
    rationale: `Imported tracked Compose files at ${head.sha}. Translation is source analysis; the application has not been built or browser-verified.`,
    stack: ["Docker Compose"],
    missingInputs: ready.length === 1 ? ready[0]!.missingInputs : [],
    hosted: {
      provider: "url",
      instructions: [
        "Alternatively, use an existing nonproduction application URL.",
      ],
    },
    docker,
    proposedFiles: [],
    warnings: [
      ...(paths.length > selected.length && !input.path
        ? [
            "Only the first four Compose files were inspected. Select a specific Compose path to inspect another file.",
          ]
        : []),
      "Imported databases use synthetic disposable storage and new credentials; existing database data is never attached.",
    ],
    repository: {
      provider,
      repo: project.config.repo,
      branch: head.branch,
      sha: head.sha,
      filesRead: selected,
      truncated: paths.length > selected.length,
    },
    composeImports: imports,
  };
}
