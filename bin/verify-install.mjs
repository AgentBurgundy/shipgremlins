// Exercise the actual distributable and npm-generated global shims outside the source checkout.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const source = fileURLToPath(new URL("..", import.meta.url));
const scratch = realpathSync(
  mkdtempSync(join(tmpdir(), "shipgremlins-package-")),
);
const prefix = join(scratch, "global");
const working = join(scratch, "outside checkout");
const config = join(scratch, "operator configuration");
mkdirSync(working);
const npm = process.env.npm_execpath;
assert(npm, "Run this check with npm run test:package.");
const env = { ...process.env };
delete env.SHIPGREMLINS_HOME;
const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout: 180_000,
    windowsHide: true,
    env,
    ...options,
  });
  if (result.error || result.status !== 0)
    throw new Error(
      `Install smoke check failed (${result.status}): ${result.error?.message ?? result.stderr}`,
    );
  return result.stdout;
};
const packed = JSON.parse(
  run(
    process.execPath,
    [npm, "pack", "--json", "--pack-destination", scratch],
    { cwd: source },
  ),
)[0];
for (const { path } of packed.files) {
  assert(
    !/(^|\/)(hub\.json|\.env(?:\..*)?|node_modules|\.git|\.run)(\/|$)/.test(
      path,
    ),
    `Private file packaged: ${path}`,
  );
  assert(
    !path.startsWith("projects/") || path.startsWith("projects/_templates/"),
    `Enrolled project packaged: ${path}`,
  );
  assert(!path.endsWith(".test.ts"), `Test packaged: ${path}`);
}
run(
  process.execPath,
  [
    npm,
    "install",
    "--global",
    "--prefix",
    prefix,
    join(scratch, packed.filename),
    "--no-audit",
    "--no-fund",
  ],
  { cwd: working },
);
const bin = process.platform === "win32" ? prefix : join(prefix, "bin");
env.PATH = `${bin}${delimiter}${env.PATH ?? env.Path ?? ""}`;
// Windows environment keys are case-insensitive; avoid duplicate PATH/Path entries.
if (process.platform === "win32")
  for (const key of Object.keys(env))
    if (key !== "PATH" && key.toLowerCase() === "path") delete env[key];
function cli(args, alias = "gremlins") {
  if (process.platform === "win32") {
    assert(
      args.every((arg) => !/["%\r\n]/.test(arg)),
      "Unexpected Windows test path",
    );
    return run(
      process.env.ComSpec ?? "cmd.exe",
      [
        "/d",
        "/s",
        "/c",
        `${alias}.cmd ${args.map((arg) => `"${arg}"`).join(" ")}`,
      ],
      { cwd: working, windowsVerbatimArguments: true },
    );
  }
  return run(join(bin, alias), args, { cwd: working });
}
assert.match(cli(["--help"]), /SHIPGREMLINS/);
assert.match(cli(["dashboard", "--help"]), /--lan/);
assert.match(cli(["update", "--help"]), /--rollback/);
assert.match(cli(["worker", "--help"]), /--enrollment-code/);
assert.match(cli(["--version"]), /ShipGremlins \d/);
assert.match(cli(["--version"], "hub"), /ShipGremlins \d/);
assert.match(cli(["--version"], "shipgremlins"), /ShipGremlins \d/);
if (process.platform === "win32") {
  const shellVersion = run(
    "pwsh",
    [
      "-NoProfile",
      "-NonInteractive",
      "-File",
      join(bin, "gremlins.ps1"),
      "--version",
    ],
    { cwd: working },
  );
  assert.match(shellVersion, /ShipGremlins \d/);
}
const args = [
  "--home",
  config,
  "setup",
  "init",
  "--project",
  "smoke-app",
  "--repo",
  "example/app",
  "--json",
];
const created = JSON.parse(cli(args));
assert.equal(
  JSON.parse(readFileSync(join(config, "hub.json"), "utf8")).runners.mode,
  "local",
);
assert.equal(resolve(created.directory), resolve(config));
assert.equal(created.created.length, 11);
writeFileSync(
  join(config, "projects", "smoke-app", "core", "mandate.md"),
  "Keep this custom mandate.\n",
);
const again = JSON.parse(cli(args));
assert.equal(again.created.length, 0);
assert.equal(
  readFileSync(
    join(config, "projects", "smoke-app", "core", "mandate.md"),
    "utf8",
  ),
  "Keep this custom mandate.\n",
);
const credentials = join(working, "local credentials.env");
writeFileSync(credentials, "GITHUB_TOKEN=package-smoke-value\n");
const statusText = cli([
  "--home",
  config,
  "--env-file",
  credentials,
  "setup",
  "status",
  "--json",
]);
const status = JSON.parse(statusText);
assert.equal(
  status.secrets.find((secret) => secret.name === "GITHUB_TOKEN").present,
  true,
);
assert(!statusText.includes("package-smoke-value"));
assert(!statusText.includes("\u001b"));
if (process.platform === "win32") {
  const shellStatus = run(
    "pwsh",
    [
      "-NoProfile",
      "-NonInteractive",
      "-File",
      join(bin, "gremlins.ps1"),
      "--home",
      config,
      "setup",
      "status",
      "--json",
    ],
    { cwd: working },
  );
  assert.equal(JSON.parse(shellStatus).directory, config);
}
cli([
  "--home",
  config,
  "add-project",
  "second-app",
  "--repo",
  "example/second",
]);
assert(existsSync(join(config, "projects", "second-app", "project.json")));
assert(!existsSync(join(prefix, "node_modules", "shipgremlins", "hub.json")));
const installedPackage =
  process.platform === "win32"
    ? join(prefix, "node_modules", "shipgremlins")
    : join(prefix, "lib", "node_modules", "shipgremlins");
assert(
  existsSync(join(installedPackage, "runner-local", "Dockerfile")),
  "Local worker image source is packaged",
);
for (const module of ["review-job.mjs", "review-receipts.mjs", "lease.mjs"])
  assert(
    existsSync(join(installedPackage, "runner-local", module)),
    `Trusted worker module is packaged: ${module}`,
  );
// Exercise detached startup/reattach/authenticated stop through the real OS shim.
try {
  const started = cli(["--home", config, "start", "--no-open"]);
  assert.match(started, /running in the background/);
  const info = JSON.parse(
    readFileSync(join(config, ".run", "controller.json"), "utf8"),
  );
  assert.match(info.session, /^[a-f0-9]{64}$/);
  const attached = cli(["--home", config, "start", "--no-open"]);
  assert(
    attached.includes(`:${info.port}/`),
    "Start reuses the same controller",
  );
  const response = await fetch(`http://127.0.0.1:${info.port}/api/status`, {
    headers: { authorization: `Bearer ${info.session}` },
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).runtime.agents, "local-docker");
  const origin = `http://127.0.0.1:${info.port}`;
  const projectsPage = await fetch(`${origin}/projects`);
  assert.equal(projectsPage.status, 200);
  assert.match(await projectsPage.text(), /I have an idea/);
  const ideaScript = await fetch(`${origin}/idea-crew.js`);
  assert.equal(ideaScript.status, 200);
  assert.match(await ideaScript.text(), /createIdeaCrew/);
  const invalidIdea = await fetch(`${origin}/api/idea-plans`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${info.session}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ idea: "too short" }),
  });
  assert.equal(invalidIdea.status, 400);
  assert.match((await invalidIdea.json()).error, /Describe your app/);
  assert.match(cli(["--home", config, "status"]), /running in the background/);
} finally {
  assert.match(
    cli(["--home", config, "stop"]),
    /Controller stopped|not running/,
  );
}
const updateProof = run(
  process.execPath,
  [
    "--import",
    pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href,
    join(source, "bin", "verify-update.mjs"),
    installedPackage,
    config,
    scratch,
    join(scratch, packed.filename),
  ],
  { cwd: working },
);
console.log(updateProof.trim());
console.log(
  "PASS packaged global CLI: real shims, help/version, isolated setup, repeat setup, credentials, bundled templates, clean JSON.",
);
console.log(`Installation fixture: ${scratch}`);
