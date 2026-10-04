import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  readActiveRuntime,
  releasePackageRoot,
  resolveRuntime,
  runtimeLocation,
  validateRuntimePackage,
  type ActiveRuntimePointer,
} from "../../bin/runtime.mjs";

const directories: string[] = [];
const source = fileURLToPath(new URL("../..", import.meta.url));
const sha = "a".repeat(40);
const session = "b".repeat(64);
function temporary() {
  const directory = mkdtempSync(
    join(realpathSync(tmpdir()), "sg-runtime-test-"),
  );
  directories.push(directory);
  return directory;
}
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

const cliSource = `
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url));
const version = JSON.parse(readFileSync(join(root,'package.json'),'utf8')).version;
console.log(JSON.stringify({ version, args:process.argv.slice(2), cwd:process.cwd(), home:process.env.SHIPGREMLINS_HOME, bootstrap:process.env.SHIPGREMLINS_BOOTSTRAP_ROOT, managed:process.env.SHIPGREMLINS_MANAGED_LAUNCH, session:process.env.SHIPGREMLINS_DASHBOARD_SESSION, envValue:process.env.SMOKE_ENV_VALUE }));
const scenario = process.env.RUNTIME_SCENARIO;
const message = { type:'shipgremlins:restart-dashboard', port:43219, session:'${session}', configurationRoot:process.env.RUNTIME_CONFIG, lan:true, ...JSON.parse(process.env.RUNTIME_MESSAGE || '{}') };
if (scenario === 'restart' && !process.env.SHIPGREMLINS_DASHBOARD_SESSION) {
  writeFileSync(process.env.RUNTIME_POINTER, JSON.stringify({schema:1,active:{sha:'${sha}',version:'2.0.0'},previous:{bootstrap:true,version:'1.0.0'}}));
  process.send(message, () => process.exit(75));
} else if (scenario === 'request' || scenario === 'loop' || scenario === 'request-success') {
  process.send(message, () => process.exit(scenario === 'request-success' ? 0 : 75));
} else if (scenario === 'exit75') process.exit(75);
else if (scenario === 'wait') {
  process.on('SIGTERM', () => { console.log('STOPPED'); process.exit(0); });
  setInterval(() => {},1000);
  console.log('READY');
}
`;

function packageFixture(root: string, version: string) {
  for (const subdirectory of ["bin", "src", "dashboard", "node_modules/tsx"])
    mkdirSync(join(root, subdirectory), { recursive: true });
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({ name: "shipgremlins", version, type: "module" }),
  );
  for (const file of ["shipgremlins.mjs", "runtime.mjs"])
    copyFileSync(join(source, "bin", file), join(root, "bin", file));
  writeFileSync(join(root, "src", "cli.ts"), cliSource);
  writeFileSync(join(root, "dashboard", "index.html"), "<h1>Gremlins</h1>");
  writeFileSync(
    join(root, "node_modules", "tsx", "package.json"),
    JSON.stringify({ name: "tsx", type: "module", exports: "./index.mjs" }),
  );
  writeFileSync(
    join(root, "node_modules", "tsx", "index.mjs"),
    "import { register } from 'node:module'; register(new URL('./hooks.mjs',import.meta.url));",
  );
  writeFileSync(
    join(root, "node_modules", "tsx", "hooks.mjs"),
    "import {readFile} from 'node:fs/promises'; export async function load(url,context,next){if(url.endsWith('.ts'))return {format:'module',source:await readFile(new URL(url),'utf8'),shortCircuit:true};return next(url,context);}",
  );
}

function fixture() {
  const scratch = temporary();
  const bootstrap = join(scratch, "bootstrap with spaces");
  const home = join(scratch, "home");
  const working = join(scratch, "working directory");
  const configuration = join(scratch, "configuration");
  mkdirSync(home);
  mkdirSync(working);
  mkdirSync(configuration);
  packageFixture(bootstrap, "1.0.0");
  const base = runtimeLocation(bootstrap, home);
  const installed = releasePackageRoot(base, sha);
  packageFixture(installed, "2.0.0");
  const pointerFile = join(base, "active.json");
  const pointer: ActiveRuntimePointer = {
    schema: 1,
    active: { sha, version: "2.0.0" },
    previous: { bootstrap: true, version: "1.0.0" },
  };
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    RUNTIME_CONFIG: configuration,
    RUNTIME_POINTER: pointerFile,
  };
  for (const key of Object.keys(env))
    if (key.startsWith("SHIPGREMLINS_") || key === "NODE_OPTIONS")
      delete (env as NodeJS.ProcessEnv)[key];
  return {
    scratch,
    bootstrap,
    home,
    working,
    configuration,
    base,
    installed,
    pointerFile,
    pointer,
    env,
  };
}

function launch(
  context: ReturnType<typeof fixture>,
  args: string[],
  additionalEnv: NodeJS.ProcessEnv = {},
) {
  return spawnSync(
    process.execPath,
    [join(context.bootstrap, "bin", "shipgremlins.mjs"), ...args],
    {
      cwd: context.working,
      encoding: "utf8",
      windowsHide: true,
      timeout: 15_000,
      env: { ...context.env, ...additionalEnv },
    },
  );
}
function records(stdout: string) {
  return stdout
    .split(/\r?\n/)
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("managed runtime pointer", () => {
  it("isolates bootstrap installations by canonical path, including linked installations", () => {
    const context = fixture();
    const key = createHash("sha256")
      .update(realpathSync(context.bootstrap))
      .digest("hex")
      .slice(0, 16);
    expect(context.base).toBe(
      join(context.home, ".shipgremlins", "runtime", key),
    );
    const alias = join(context.scratch, "linked-bootstrap");
    symlinkSync(context.bootstrap, alias, "junction");
    expect(runtimeLocation(alias, context.home)).toBe(context.base);
    expect(runtimeLocation(context.installed, context.home)).not.toBe(
      context.base,
    );
  });

  it("uses a source checkout directly when it has no managed pointer", () => {
    const context = fixture();
    mkdirSync(join(context.bootstrap, ".git"));
    expect(readActiveRuntime(context.bootstrap, context.home)).toBeNull();
    expect(resolveRuntime(context.bootstrap, context.home)).toBe(
      realpathSync(context.bootstrap),
    );
  });

  it("selects a validated release and permits first-update rollback to the untouched bootstrap", () => {
    const context = fixture();
    writeFileSync(context.pointerFile, JSON.stringify(context.pointer));
    expect(readActiveRuntime(context.bootstrap, context.home)).toEqual(
      context.pointer,
    );
    expect(resolveRuntime(context.bootstrap, context.home)).toBe(
      realpathSync(context.installed),
    );
    writeFileSync(
      context.pointerFile,
      JSON.stringify({
        schema: 1,
        active: context.pointer.previous,
        previous: context.pointer.active,
      }),
    );
    expect(resolveRuntime(context.bootstrap, context.home)).toBe(
      realpathSync(context.bootstrap),
    );
  });

  it.each([
    "not-json",
    JSON.stringify({ schema: 2, active: { sha, version: "2.0.0" } }),
    JSON.stringify({
      schema: 1,
      active: { sha: "../escape", version: "2.0.0" },
    }),
    JSON.stringify({ schema: 1, active: { sha, version: "not-a-version" } }),
    JSON.stringify({ schema: 1, active: { sha, version: "2.0.0-01" } }),
    JSON.stringify({
      schema: 1,
      active: { sha, version: "2.0.0", path: "outside" },
    }),
    JSON.stringify({
      schema: 1,
      active: { sha, version: "2.0.0" },
      path: "outside",
    }),
    JSON.stringify({
      schema: 1,
      active: { sha, version: "2.0.0" },
      previous: null,
    }),
    JSON.stringify({
      schema: 1,
      active: { bootstrap: false, version: "1.0.0" },
    }),
    " ".repeat(8193),
  ])(
    "rejects invalid pointer data without accepting arbitrary paths",
    (source) => {
      const context = fixture();
      writeFileSync(context.pointerFile, source);
      expect(() => readActiveRuntime(context.bootstrap, context.home)).toThrow(
        "saved ShipGremlins update is unavailable or invalid",
      );
    },
  );

  it.each(["../outside", "A".repeat(40), "a".repeat(39), "", "a/../b"])(
    "rejects invalid release identity %s",
    (value) => {
      expect(() => releasePackageRoot(temporary(), value)).toThrow();
    },
  );

  it("rejects version mismatch, missing files, and incomplete dependency installs", () => {
    const context = fixture();
    expect(validateRuntimePackage(context.installed, "2.0.0")).toBe("2.0.0");
    expect(() => validateRuntimePackage(context.installed, "3.0.0")).toThrow();
    unlinkSync(join(context.installed, "src", "cli.ts"));
    expect(() => validateRuntimePackage(context.installed)).toThrow();
    writeFileSync(join(context.installed, "src", "cli.ts"), cliSource);
    unlinkSync(join(context.installed, "node_modules", "tsx", "index.mjs"));
    expect(() => validateRuntimePackage(context.installed)).toThrow();
  });

  it("rejects a release directory redirected outside its derived runtime path", () => {
    const context = fixture();
    const outside = join(context.scratch, "outside-package");
    packageFixture(outside, "2.0.0");
    const otherSha = "c".repeat(40);
    const candidate = releasePackageRoot(context.base, otherSha);
    mkdirSync(dirname(candidate), { recursive: true });
    symlinkSync(outside, candidate, "junction");
    writeFileSync(
      context.pointerFile,
      JSON.stringify({
        schema: 1,
        active: { sha: otherSha, version: "2.0.0" },
      }),
    );
    expect(() => resolveRuntime(context.bootstrap, context.home)).toThrow();
  });
});

describe("actual bootstrap child supervision", () => {
  it("reports the active version and retains original cwd, explicit home and dotenv handling", () => {
    const context = fixture();
    writeFileSync(context.pointerFile, JSON.stringify(context.pointer));
    expect(launch(context, ["--version"]).stdout.trim()).toBe(
      "ShipGremlins 2.0.0",
    );
    const dotenv = join(context.working, ".env");
    writeFileSync(dotenv, "SMOKE_ENV_VALUE=loaded-from-file\n");
    const result = launch(context, [
      "--home",
      context.configuration,
      "--env-file",
      dotenv,
      "inspect",
    ]);
    expect(result.status, result.stderr).toBe(0);
    expect(records(result.stdout)).toEqual([
      {
        version: "2.0.0",
        args: ["inspect"],
        cwd: context.working,
        home: context.configuration,
        bootstrap: context.bootstrap,
        managed: "1",
        envValue: "loaded-from-file",
      },
    ]);
  });

  it("warns and safely falls back to the original bootstrap for a corrupt or missing release", () => {
    const context = fixture();
    writeFileSync(context.pointerFile, '{"active":"secret-corrupt-input"}');
    const invalid = launch(context, ["--version"]);
    expect(invalid.status).toBe(0);
    expect(invalid.stdout.trim()).toBe("ShipGremlins 1.0.0");
    expect(invalid.stderr).toContain("Continuing with the original installed");
    expect(invalid.stderr).not.toContain("secret-corrupt-input");
    writeFileSync(
      context.pointerFile,
      JSON.stringify({
        schema: 1,
        active: { sha: "d".repeat(40), version: "2.0.0" },
      }),
    );
    const missing = launch(context, ["inspect"]);
    expect(missing.status, missing.stderr).toBe(0);
    expect(records(missing.stdout)[0]?.version).toBe("1.0.0");
  });

  it("activates a new runtime over IPC and preserves dashboard port, session, configuration and cwd", () => {
    const context = fixture();
    const result = launch(context, ["setup", "--no-open"], {
      RUNTIME_SCENARIO: "restart",
    });
    expect(result.status, result.stderr).toBe(0);
    const output = records(result.stdout);
    expect(output).toHaveLength(2);
    expect(output[0]?.version).toBe("1.0.0");
    expect(output[1]).toMatchObject({
      version: "2.0.0",
      args: ["dashboard", "--no-open", "--port", "43219", "--lan"],
      home: context.configuration,
      session,
      cwd: context.working,
      bootstrap: context.bootstrap,
    });
  });

  it.each([
    { port: 0 },
    { port: 65536 },
    { session: "bad" },
    { configurationRoot: "relative/path" },
    { lan: "true" },
    { extra: "not-allowed" },
  ])("refuses malformed restart messages %j", (message) => {
    const context = fixture();
    const result = launch(context, ["dashboard"], {
      RUNTIME_SCENARIO: "request",
      RUNTIME_MESSAGE: JSON.stringify(message),
    });
    expect(result.status, result.stderr).toBe(75);
    expect(records(result.stdout)).toHaveLength(1);
  });

  it("does not restart other commands or an exit75 without a message", () => {
    const context = fixture();
    for (const [command, scenario] of [
      ["validate", "request"],
      ["dashboard", "exit75"],
    ]) {
      const result = launch(context, [command!], {
        RUNTIME_SCENARIO: scenario,
      });
      expect(result.status, result.stderr).toBe(75);
      expect(records(result.stdout)).toHaveLength(1);
    }
  });

  it("does not restart after an ordinary successful exit even with a valid IPC request", () => {
    const context = fixture();
    const result = launch(context, ["dashboard"], {
      RUNTIME_SCENARIO: "request-success",
    });
    expect(result.status, result.stderr).toBe(0);
    expect(records(result.stdout)).toHaveLength(1);
  });

  it("bounds repeated dashboard restart requests instead of looping forever", () => {
    const context = fixture();
    const result = launch(context, ["dashboard"], { RUNTIME_SCENARIO: "loop" });
    expect(result.status, result.stderr).toBe(1);
    expect(records(result.stdout)).toHaveLength(4);
    expect(result.stderr).toContain("restarted too often");
  });

  it.skipIf(process.platform === "win32")(
    "forwards termination once and does not restart while stopping",
    async () => {
      const context = fixture();
      const child = spawn(
        process.execPath,
        [join(context.bootstrap, "bin", "shipgremlins.mjs"), "dashboard"],
        {
          cwd: context.working,
          env: { ...context.env, RUNTIME_SCENARIO: "wait" },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let output = "";
      child.stdout.on("data", (chunk: Buffer) => {
        output += chunk.toString();
        if (output.includes("READY") && !child.killed) child.kill("SIGTERM");
      });
      const status = await new Promise<number | null>((done, reject) => {
        child.once("error", reject);
        child.once("close", done);
      });
      expect(status).toBe(0);
      expect(output.match(/STOPPED/g)).toHaveLength(1);
    },
  );
});
