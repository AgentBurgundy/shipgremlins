import {
  parseTestAccess,
  validTestSecret,
  type TestAccess,
} from "../testAccess.ts";
export interface DockerEnvironmentTarget {
  kind: "docker";
  role: "preview" | "staging";
  recipe:
    | { kind: "image"; image: string }
    | { kind: "dockerfile"; dockerfile: string; context: string };
  port: number;
  healthPath?: string;
  start?: string[];
  env?: Record<string, string>;
  services?: Array<{ kind: "postgres" | "redis"; name: string; env: string }>;
  migrate?: string[];
  seed?: string[];
  access?: TestAccess;
}
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const only = (v: Record<string, unknown>, keys: string[]) => {
  if (Object.keys(v).some((k) => !keys.includes(k)))
    throw new Error("Docker environment contains an unsupported setting.");
};
export function safeRecipePath(v: unknown): v is string {
  return (
    typeof v === "string" &&
    v.length <= 240 &&
    (v === "." ||
      (/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(v) &&
        !v
          .split("/")
          .some((part) => part === "." || part === ".." || part === ".git")))
  );
}
export function appEnvironmentName(v: unknown): v is string {
  return (
    typeof v === "string" &&
    /^[A-Z][A-Z0-9_]{0,63}$/.test(v) &&
    !/^(?:SHIPGREMLINS_|GREMLINS_|DOCKER_|LD_|DYLD_|NODE_OPTIONS$|SHELLOPTS$|BASH_ENV$|ENV$|PATH$|HOME$)/.test(
      v,
    )
  );
}
export function parseDockerTarget(input: unknown): DockerEnvironmentTarget {
  if (!object(input)) throw new Error("Docker environment must be an object.");
  only(input, [
    "kind",
    "role",
    "recipe",
    "port",
    "healthPath",
    "start",
    "env",
    "services",
    "migrate",
    "seed",
    "access",
  ]);
  parseTestAccess(input.access);
  if (
    input.kind !== "docker" ||
    !["preview", "staging"].includes(String(input.role))
  )
    throw new Error(
      "Managed Docker environments must be preview or staging targets.",
    );
  const recipe = input.recipe;
  if (!object(recipe))
    throw new Error("Choose a Docker image or repository Dockerfile.");
  if (recipe.kind === "image") {
    only(recipe, ["kind", "image"]);
    if (
      typeof recipe.image !== "string" ||
      recipe.image.length > 250 ||
      !/^[a-z0-9][a-z0-9./:_-]*(?:@sha256:[a-f0-9]{64})?$/.test(recipe.image) ||
      recipe.image.includes("..") ||
      recipe.image.includes("//")
    )
      throw new Error(
        "Use a Docker image reference without credentials or command options.",
      );
  } else if (recipe.kind === "dockerfile") {
    only(recipe, ["kind", "dockerfile", "context"]);
    if (
      !safeRecipePath(recipe.dockerfile) ||
      recipe.dockerfile === "." ||
      !safeRecipePath(recipe.context) ||
      (recipe.context !== "." &&
        !recipe.dockerfile.startsWith(recipe.context + "/"))
    )
      throw new Error(
        "Dockerfile and context must be safe repository paths; Dockerfile must be inside its context.",
      );
  } else throw new Error("Choose a Docker image or repository Dockerfile.");
  if (
    !Number.isInteger(input.port) ||
    Number(input.port) < 1 ||
    Number(input.port) > 65535
  )
    throw new Error("Application port must be between 1 and 65535.");
  if (
    input.healthPath !== undefined &&
    (typeof input.healthPath !== "string" ||
      input.healthPath.length > 512 ||
      !/^\/(?!\/)[A-Za-z0-9_./~-]*$/.test(input.healthPath) ||
      input.healthPath.includes(".."))
  )
    throw new Error(
      "Health path must be a relative HTTP path, without credentials, queries or redirects.",
    );
  for (const key of ["start", "migrate", "seed"])
    if (
      input[key] !== undefined &&
      (!Array.isArray(input[key]) ||
        input[key].length < 1 ||
        input[key].length > 32 ||
        input[key].some(
          (v: unknown) =>
            typeof v !== "string" ||
            !v ||
            v.length > 2048 ||
            [...v].some((c) => c.charCodeAt(0) < 32),
        ))
    )
      throw new Error(
        "Docker commands must be bounded argument arrays, not shell strings.",
      );
  if (
    input.env !== undefined &&
    (!object(input.env) ||
      Object.keys(input.env).length > 32 ||
      Object.entries(input.env).some(
        ([k, v]) => !appEnvironmentName(k) || !validTestSecret(v),
      ))
  )
    throw new Error(
      "App environment must map variable names to dedicated test-secret names.",
    );
  if (input.services !== undefined) {
    if (!Array.isArray(input.services) || input.services.length > 2)
      throw new Error("Use at most one Postgres and one Redis service.");
    const names = new Set<string>(),
      kinds = new Set<string>(),
      variables = new Set(Object.keys(input.env ?? {}));
    for (const service of input.services) {
      if (!object(service)) throw new Error("Invalid local service.");
      only(service, ["kind", "name", "env"]);
      if (
        !["postgres", "redis"].includes(String(service.kind)) ||
        typeof service.name !== "string" ||
        !/^[a-z][a-z0-9-]{0,30}$/.test(service.name) ||
        ["app", "localhost"].includes(service.name) ||
        !appEnvironmentName(service.env) ||
        names.has(service.name) ||
        kinds.has(String(service.kind)) ||
        variables.has(service.env)
      )
        throw new Error(
          "Each local service needs a unique kind, network name and app variable.",
        );
      names.add(service.name);
      kinds.add(String(service.kind));
      variables.add(service.env);
    }
  }
  return structuredClone(input) as unknown as DockerEnvironmentTarget;
}
