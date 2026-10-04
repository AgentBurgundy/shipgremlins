// Run by verify-install after packing and installing the real distributable.
// Only release discovery and the source tarball are substituted; npm installation,
// candidate startup/configuration checks, activation, and rollback are real.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createUpdater } from "../src/update/index.ts";
import { resolveRuntime } from "./runtime.mjs";

const [bootstrap, configurationRoot, scratch, tarball] = process.argv.slice(2);
assert(bootstrap && configurationRoot && scratch && tarball);
const home = join(scratch, "update user home");
mkdirSync(home);
const packageFile = join(bootstrap, "package.json");
const packaged = JSON.parse(readFileSync(packageFile, "utf8"));
const previousVersion = "0.0.0";
writeFileSync(
  packageFile,
  JSON.stringify({ ...packaged, version: previousVersion }),
);
writeFileSync(
  join(configurationRoot, ".env"),
  "GITHUB_TOKEN=do-not-overwrite-this-fixture-token\n",
);

function snapshot(directory) {
  return readdirSync(directory, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry) => {
      const file = join(directory, entry.name);
      return entry.isDirectory()
        ? snapshot(file)
        : [
            [
              file,
              createHash("sha256").update(readFileSync(file)).digest("hex"),
            ],
          ];
    });
}
const originalConfiguration = snapshot(configurationRoot);
const sha = "d".repeat(40);
const env = { ...process.env, HOME: home, USERPROFILE: home };
delete env.SHIPGREMLINS_BOOTSTRAP_ROOT;
delete env.SHIPGREMLINS_MANAGED_LAUNCH;
delete env.SHIPGREMLINS_HOME;

const updater = createUpdater({
  packageRoot: bootstrap,
  configurationRoot,
  home,
  env,
  fetch: async (url) => {
    const value = String(url).includes("/git/ref/")
      ? { object: { sha } }
      : String(url).includes("/actions/workflows/")
        ? {
            workflow_runs: [
              {
                head_sha: sha,
                head_branch: "main",
                event: "push",
                status: "completed",
                conclusion: "success",
              },
            ],
          }
        : packaged;
    return new Response(JSON.stringify(value), { status: 200 });
  },
  run: async (command, args, options) => {
    const expected = `git+https://github.com/AgentBurgundy/shipgremlins.git#${sha}`;
    const actualArgs = args.map((arg) => (arg === expected ? tarball : arg));
    const result = spawnSync(command, actualArgs, {
      cwd: options.cwd,
      env: options.env,
      encoding: "utf8",
      windowsHide: true,
      timeout: options.timeoutMs,
    });
    if (result.error || result.status !== 0)
      throw new Error(
        `Real staged runtime check failed: ${result.error?.message ?? result.stderr}`,
      );
    return { code: result.status, stdout: result.stdout };
  },
});

const selectedVersion = () => {
  const result = spawnSync(
    process.execPath,
    [join(bootstrap, "bin", "shipgremlins.mjs"), "--version"],
    { cwd: scratch, env, encoding: "utf8", windowsHide: true, timeout: 30_000 },
  );
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
};
assert.equal(selectedVersion(), `ShipGremlins ${previousVersion}`);
const installed = await updater.apply();
assert.equal(installed.phase, "ready", installed.message);
assert.equal(installed.restartRequired, true);
assert.equal(installed.canRollback, true);
assert.equal(selectedVersion(), `ShipGremlins ${packaged.version}`);
assert.notEqual(resolveRuntime(bootstrap, home), bootstrap);
assert.equal(
  JSON.parse(readFileSync(packageFile, "utf8")).version,
  previousVersion,
);
assert.deepEqual(snapshot(configurationRoot), originalConfiguration);
const rolledBack = await updater.rollback();
assert.equal(rolledBack.phase, "ready", rolledBack.message);
assert.equal(resolveRuntime(bootstrap, home), bootstrap);
assert.equal(selectedVersion(), `ShipGremlins ${previousVersion}`);
assert.deepEqual(snapshot(configurationRoot), originalConfiguration);
console.log(
  "PASS real staged update: isolated npm install, candidate startup/config checks, activation, bootstrap rollback, unchanged PM files and credentials.",
);
