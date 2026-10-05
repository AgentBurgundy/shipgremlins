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
import { createSourceStore } from "../src/sourceControl/store.ts";
import { createOAuthStore } from "../src/oauthConnection/storage.ts";

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
mkdirSync(join(configurationRoot, ".run", "local-runners"), {
  recursive: true,
});
writeFileSync(
  join(configurationRoot, ".run", "local-runners", "preserve-this-queue.json"),
  JSON.stringify({
    job: "in-progress",
    worker: "existing-worker",
    artifact: "retained-evidence",
  }),
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
for (const [directory, filename, content] of [
  [
    "storage",
    "postgres.json",
    {
      mode: "managed",
      id: "preserve-db-volume",
      password: "fixture-private-db-password",
    },
  ],
  [
    "slack",
    "connection.json",
    {
      webhookUrl: "https://hooks.slack.com/services/fixture/fixture/preserve",
      teamName: "fixture",
    },
  ],
]) {
  mkdirSync(join(configurationRoot, ".run", directory), { recursive: true });
  writeFileSync(
    join(configurationRoot, ".run", directory, filename),
    JSON.stringify(content),
  );
}
await createSourceStore(configurationRoot).locked(async (state, save) => {
  await save(state);
});
for (const provider of ["linear", "vercel"]) {
  for (const connectionId of ["default", "client"]) {
    await createOAuthStore(configurationRoot, provider, connectionId).locked(
      async (state, save) => {
        state.label =
          connectionId === "client" ? "Client workspace" : "Default";
        state.connection = {
          accessToken: `fixture-${provider}-${connectionId}-access-preserve`,
          ...(provider === "linear"
            ? { refreshToken: "fixture-linear-refresh-preserve" }
            : {}),
          expiresAt: Date.now() + 24 * 60 * 60_000,
          workspace: {
            id: "c9d8b18e-179c-4d2e-9897-20a38dadfd67",
            name: "Fixture workspace",
          },
          account: { id: "fixture-account", name: "Fixture operator" },
          leases: [
            { jobId: "job-in-progress", expiresAt: Date.now() + 50 * 60_000 },
          ],
        };
        await save(state);
      },
    );
    const encrypted = readFileSync(
      join(
        configurationRoot,
        ".run",
        "oauth",
        provider,
        ...(connectionId === "default" ? [] : ["connections", connectionId]),
        "connection.enc",
      ),
    );
    assert.equal(
      encrypted.includes(
        Buffer.from(`fixture-${provider}-${connectionId}-access-preserve`),
      ),
      false,
    );
  }
}
const provisioningDirectory = join(
  configurationRoot,
  ".run",
  "linear",
  "provisioning",
);
mkdirSync(provisioningDirectory, { recursive: true });
writeFileSync(
  join(provisioningDirectory, "fixture.json"),
  JSON.stringify({
    schema: 1,
    workspaceId: "c9d8b18e-179c-4d2e-9897-20a38dadfd67",
    team: {
      id: "9816d1df-61b3-43ca-9a93-5b2c8eb2c75a",
      name: "Fixture",
      key: "FIXTURE",
      created: true,
      reuse: false,
    },
    areas: {
      core: { id: "5565a8b8-357d-4e97-9f1f-4cdd0f66d091", created: false },
    },
  }),
);
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
for (const provider of ["linear", "vercel"]) {
  for (const connectionId of ["default", "client"]) {
    const preserved = await createOAuthStore(
      configurationRoot,
      provider,
      connectionId,
    ).read();
    assert.equal(
      preserved.connection?.accessToken,
      `fixture-${provider}-${connectionId}-access-preserve`,
    );
    assert.equal(preserved.connection?.leases[0]?.jobId, "job-in-progress");
    assert.equal(
      preserved.label,
      connectionId === "client" ? "Client workspace" : "Default",
    );
  }
}
console.log(
  "PASS real staged update: isolated npm install, candidate startup/config checks, activation, bootstrap rollback, unchanged PM files, encrypted OAuth keys/connections, Linear provisioning journal, credentials and local queue storage.",
);
