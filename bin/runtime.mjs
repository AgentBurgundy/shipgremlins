import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const SHA = /^[a-f0-9]{40}$/;
const VERSION =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const INVALID =
  "The saved ShipGremlins update is unavailable or invalid. Reset this installation's active.json pointer before retrying gremlins update.";

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function validVersion(version) {
  if (
    typeof version !== "string" ||
    version.length > 128 ||
    !VERSION.test(version)
  )
    return false;
  const withoutBuild = version.split("+", 1)[0];
  const separator = withoutBuild.indexOf("-");
  if (separator < 0) return true;
  return withoutBuild
    .slice(separator + 1)
    .split(".")
    .every((part) => !/^\d+$/.test(part) || /^(?:0|[1-9]\d*)$/.test(part));
}
function release(value) {
  return (
    record(value) &&
    Object.keys(value).length === 2 &&
    ((typeof value.sha === "string" && SHA.test(value.sha)) ||
      value.bootstrap === true) &&
    validVersion(value.version)
  );
}
function within(root, path) {
  const part = relative(root, path);
  return !isAbsolute(part) && part !== ".." && !part.startsWith(`..${sep}`);
}

/** Each installed bootstrap has its own per-user update history. */
export function runtimeLocation(bootstrapRoot, home = homedir()) {
  const root = realpathSync(resolve(bootstrapRoot));
  const key = createHash("sha256").update(root).digest("hex").slice(0, 16);
  return join(resolve(home), ".shipgremlins", "runtime", key);
}

export function releasePackageRoot(base, sha) {
  if (typeof sha !== "string" || !SHA.test(sha)) throw new Error(INVALID);
  return join(resolve(base), "releases", sha, "node_modules", "shipgremlins");
}

/** Read only a small, strictly typed pointer; no paths are accepted from JSON. */
export function readActiveRuntime(bootstrapRoot, home = homedir()) {
  const file = join(runtimeLocation(bootstrapRoot, home), "active.json");
  try {
    const entry = lstatSync(file, { throwIfNoEntry: false });
    if (!entry) return null;
    if (entry.isSymbolicLink() || !entry.isFile() || entry.size > 8192)
      throw new Error();
    const value = JSON.parse(readFileSync(file, "utf8"));
    if (
      !record(value) ||
      value.schema !== 1 ||
      !release(value.active) ||
      Object.keys(value).some(
        (key) => !["schema", "active", "previous"].includes(key),
      ) ||
      (Object.hasOwn(value, "previous") && !release(value.previous))
    )
      throw new Error();
    return value;
  } catch {
    throw new Error(INVALID);
  }
}

/** Validate a staged npm installation before activation or rollback. */
export function validateRuntimePackage(packageRoot, expectedVersion) {
  try {
    const root = realpathSync(resolve(packageRoot));
    if (!statSync(root).isDirectory()) throw new Error();
    const manifestFile = realpathSync(join(root, "package.json"));
    if (!within(root, manifestFile) || statSync(manifestFile).size > 256 * 1024)
      throw new Error();
    const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
    if (
      !record(manifest) ||
      manifest.name !== "shipgremlins" ||
      !validVersion(manifest.version) ||
      (expectedVersion !== undefined &&
        (!validVersion(expectedVersion) ||
          manifest.version !== expectedVersion))
    )
      throw new Error();
    for (const path of [
      "bin/shipgremlins.mjs",
      "bin/runtime.mjs",
      "src/cli.ts",
      "dashboard/index.html",
    ]) {
      const file = realpathSync(join(root, path));
      if (!within(root, file) || !statSync(file).isFile()) throw new Error();
    }
    const loader = realpathSync(
      createRequire(join(root, "package.json")).resolve("tsx"),
    );
    const dependencies = realpathSync(dirname(root));
    if (!within(dependencies, loader) || !statSync(loader).isFile())
      throw new Error();
    return manifest.version;
  } catch {
    throw new Error(
      "The ShipGremlins release is incomplete or invalid. Install a fresh release before activating it.",
    );
  }
}

export function resolveRuntime(bootstrapRoot, home = homedir()) {
  const bootstrap = realpathSync(resolve(bootstrapRoot));
  const pointer = readActiveRuntime(bootstrap, home);
  if (!pointer) return bootstrap;
  try {
    if (pointer.active.bootstrap === true) {
      validateRuntimePackage(bootstrap, pointer.active.version);
      return bootstrap;
    }
    const base = runtimeLocation(bootstrap, home);
    const candidate = releasePackageRoot(base, pointer.active.sha);
    const canonicalBase = realpathSync(base);
    const canonicalPackage = realpathSync(candidate);
    if (
      canonicalPackage !== releasePackageRoot(canonicalBase, pointer.active.sha)
    )
      throw new Error();
    validateRuntimePackage(canonicalPackage, pointer.active.version);
    return canonicalPackage;
  } catch {
    throw new Error(INVALID);
  }
}
