// Manual checkout smoke: node runner-local/runtime-permissions-smoke.mjs
// Requires Docker Linux containers and the checkout's installed dependencies.
// Builds from updater-style 0600 files, then tests the actual Docker accessProbe.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  readFileSync,
  readdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const directory = dirname(fileURLToPath(import.meta.url));
const packageRoot = dirname(directory);
const id = randomBytes(8).toString("hex");
const image = `shipgremlins-local:${id}`;
const fixtureImage = `shipgremlins-permission-fixture:${id}`;
const jobId = `job-setup-permission-${id}`;
const root = realpathSync(
  mkdtempSync(join(tmpdir(), "gremlins-permission-smoke-")),
);
let docker, unregister;

const run = (args, stdin, timeoutMs = 30000) =>
  new Promise((resolve, reject) => {
    const child = spawn("docker", args, {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "",
      stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(Error("Docker permission smoke timed out."));
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout = (stdout + chunk).slice(-32768);
    });
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk).slice(-32768);
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(stdin);
  });
const checked = async (args, stdin, timeoutMs) => {
  const result = await run(args, stdin, timeoutMs);
  assert.equal(
    result.code,
    0,
    `Disposable smoke Docker operation failed: ${args[0]}\n${result.stderr.slice(-4000)}`,
  );
  return result;
};

// Explicit POSIX tar metadata reproduces a Linux private updater extraction even
// when this test runs on Windows, where chmod cannot change build-context modes.
const tar = (files) => {
  const entries = [];
  const octal = (value, width) =>
    `${value.toString(8).padStart(width - 1, "0")}\0`;
  for (const [name, bytes] of files) {
    assert.ok(Buffer.byteLength(name) <= 100 && !name.includes("/"));
    const header = Buffer.alloc(512);
    header.write(name, 0, 100);
    header.write(octal(0o600, 8), 100, 8);
    header.write(octal(0, 8), 108, 8);
    header.write(octal(0, 8), 116, 8);
    header.write(octal(bytes.length, 12), 124, 12);
    header.write(octal(0, 12), 136, 12);
    header.fill(32, 148, 156);
    header.write("0", 156);
    header.write("ustar\0", 257);
    header.write("00", 263);
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8);
    assert.equal(parseInt(header.toString("ascii", 100, 107), 8), 0o600);
    entries.push(
      header,
      bytes,
      Buffer.alloc((512 - (bytes.length % 512)) % 512),
    );
  }
  return Buffer.concat([...entries, Buffer.alloc(1024)]);
};
try {
  const files = readdirSync(directory)
    .filter(
      (name) =>
        [
          "Dockerfile",
          ".dockerignore",
          "package.json",
          "package-lock.json",
          "git-askpass.sh",
        ].includes(name) || name.endsWith(".mjs"),
    )
    .sort()
    .map((name) => [name, readFileSync(join(directory, name))]);
  console.log(
    `Building packaged runtime from ${files.length} explicit mode-0600 files (cached layers reused).`,
  );
  await checked(
    ["build", "--quiet", "--tag", image, "-"],
    tar(files),
    30 * 60_000,
  );
  const readable = await checked([
    "run",
    "--rm",
    "--user",
    "1000:1000",
    "--read-only",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    "--entrypoint",
    "node",
    image,
    "--input-type=module",
    "-e",
    `import assert from 'node:assert/strict';import fs from 'node:fs';
     assert.equal(process.getuid(),1000);
     const files=fs.readdirSync('/opt/gremlins').filter(name=>name.endsWith('.mjs'));
     for(const name of files)fs.accessSync('/opt/gremlins/'+name,fs.constants.R_OK);
     fs.accessSync('/opt/gremlins/git-askpass.sh',fs.constants.R_OK|fs.constants.X_OK);
     await import('/opt/gremlins/access-helper.mjs');
     await import('/opt/gremlins/review-receipts.mjs');
     console.log(JSON.stringify({uid:process.getuid(),readableScripts:files.length,privateHelperImports:true}));`,
  ]);
  console.log(readable.stdout.trim());

  const app = `import {createServer} from 'node:http';createServer((req,res)=>{res.setHeader('content-type','text/html');res.end(req.url==='/health'?'ready':'<h1>Packaged runtime fixture</h1><p>No credentials or external integrations.</p>')}).listen(3000,'0.0.0.0');`;
  const fixtureDockerfile = `FROM ${image}\nENTRYPOINT ${JSON.stringify(["node", "--input-type=module", "-e", app])}\n`;
  await checked(
    ["build", "--quiet", "--tag", fixtureImage, "-"],
    tar([["Dockerfile", Buffer.from(fixtureDockerfile)]]),
    60000,
  );

  // Use the same controller entrypoints as onboarding, with a disposable image
  // target and namespace. The only override selects the image just built above.
  const tsx = await import("tsx/esm/api");
  unregister = tsx.register();
  const load = (path) => import(pathToFileURL(join(packageRoot, path)).href);
  const [
    { createDockerRunners },
    { runAccessProbe },
    { initializeSetup },
    { loadProject },
  ] = await Promise.all([
    load("src/localRunners/docker.ts"),
    load("src/setup/runnerAccessProbe.ts"),
    load("src/setup/files.ts"),
    load("src/config.ts"),
  ]);
  const target = {
    kind: "docker",
    role: "staging",
    recipe: { kind: "image", image: fixtureImage },
    port: 3000,
    healthPath: "/health",
    access: { kind: "public" },
  };
  initializeSetup(root, packageRoot, {
    project: "permission-fixture",
    repo: "fixture/permissions",
    createInitialPm: false,
    settings: {
      workflow: { kind: "pull-request", baseBranch: "main" },
      verification: { mode: "browser", environment: "test" },
      environments: { test: target },
    },
  });
  docker = createDockerRunners({ packageRoot, environmentNamespace: root });
  docker.ensureImage = async () => image;
  console.log(
    "Running real Docker fixture → private Chromium helper → accessProbe → evidence → cleanup.",
  );
  const result = await runAccessProbe({
    root,
    project: loadProject(root, "permission-fixture"),
    runner: { id: "worker-permission-smoke", name: "Permission smoke" },
    docker,
    jobId,
    access: target.access,
    values: {},
    payload: {
      browserVerification: true,
      testEnvironment: { target, env: {} },
    },
    pollMs: 100,
    timeoutMs: 120000,
  });
  assert.ok(
    result.checks.length >= 2 && result.checks.every((check) => check.passed),
  );
  assert.equal(result.png.subarray(1, 4).toString(), "PNG");
  assert.equal((await docker.inspectJob(jobId)).exists, false);
  for (const resource of ["container", "network", "volume"]) {
    const remaining = await checked([
      resource,
      "ls",
      ...(resource === "container" ? ["--all"] : []),
      "--filter",
      `label=io.shipgremlins.job=${jobId}`,
      "--format",
      resource === "container" ? "{{.Names}}" : "{{.Name}}",
    ]);
    assert.equal(
      remaining.stdout.trim(),
      "",
      `The disposable ${resource} was not cleaned up.`,
    );
  }
  console.log(
    JSON.stringify({
      ok: true,
      mode0600BuildContext: true,
      nonRootBrowser: true,
      dockerTarget: true,
      checks: result.checks.length,
      screenshotBytes: result.png.length,
      cleanupConfirmed: true,
    }),
  );
} finally {
  await docker?.stopJob(jobId).catch(() => {});
  await docker?.cleanupEnvironment?.(jobId).catch(() => {});
  await docker?.removeJob(jobId).catch(() => {});
  for (const tag of [fixtureImage, image])
    await run(["image", "rm", tag]).catch(() => {});
  unregister?.();
  assert.ok(
    basename(root).startsWith("gremlins-permission-smoke-") &&
      dirname(root) === realpathSync(tmpdir()),
  );
  rmSync(root, { recursive: true, force: true });
}
