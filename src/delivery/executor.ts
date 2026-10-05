import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve, relative, isAbsolute } from "node:path";
import type { Project } from "../config.ts";
import type { Git, GitResult } from "../git.ts";
import type { DockerRunners } from "../localRunners/docker.ts";
import { assertNoSymlinks } from "../setup/files.ts";

export type PromotionRun = (
  command: string,
  args: string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    input?: string;
    timeoutMs: number;
  },
) => Promise<GitResult>;
const spawnRun: PromotionRun = (command, args, options) =>
  new Promise((done) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      windowsHide: true,
      shell: false,
      stdio: [options.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    let out = "",
      err = "",
      timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, options.timeoutMs);
    child.stdout?.on("data", (c: Buffer) => {
      out = (out + c.toString()).slice(-1024 * 1024);
    });
    child.stderr?.on("data", (c: Buffer) => {
      err = (err + c.toString()).slice(-1024 * 1024);
    });
    child.once("error", () => {
      clearTimeout(timer);
      done({
        code: 127,
        out: "",
        err: "A required promotion tool could not start.",
      });
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      done({
        code: timedOut ? 124 : (code ?? 1),
        out,
        err: timedOut ? "Promotion operation timed out." : err,
      });
    });
    child.stdin?.on("error", () => {});
    if (options.input !== undefined) child.stdin?.end(options.input);
  });
const checkScript = `import {cpSync,mkdirSync} from 'node:fs';import {spawnSync} from 'node:child_process';let raw='';for await(const c of process.stdin)raw+=c;const commands=JSON.parse(raw);mkdirSync('/work/candidate',{recursive:true});mkdirSync('/work/home',{recursive:true});try{cpSync('/source','/work/candidate',{recursive:true,dereference:false});}catch{console.error('The non-root worker cannot read the isolated checkout. Check its directory permissions; application commands have not run.');process.exit(1);}for(const name of ['install','lint','typecheck','test','build']){const command=commands[name];if(!command)continue;console.log('Checking '+name);const r=spawnSync('/bin/bash',['-lc',command],{cwd:'/work/candidate',env:{...process.env,HOME:'/work/home'},stdio:'inherit',timeout:12*60*1000});if(r.status!==0)process.exit(1);}console.log('Configured candidate checks passed.');`;
export function candidateIdentity(uid?: number, gid?: number) {
  return {
    uid: Number.isSafeInteger(uid) && uid! > 0 ? uid! : 1000,
    gid: Number.isSafeInteger(gid) && gid! > 0 ? gid! : 1000,
  };
}
/** Git credentials stay on the controller; application commands execute only in a fresh unprivileged container. */
export async function createPromotionExecutor(options: {
  root: string;
  project: Project;
  token: string;
  docker: Pick<DockerRunners, "ensureImage">;
  run?: PromotionRun;
}) {
  const run = options.run ?? spawnRun;
  const nonce = randomBytes(12).toString("hex"),
    base = resolve(
      options.root,
      ".run",
      "delivery",
      options.project.config.name,
      "candidates",
    ),
    checkoutDir = join(base, nonce);
  assertNoSymlinks(checkoutDir);
  mkdirSync(base, { recursive: true, mode: 0o700 });
  const origin =
    options.project.config.serverUrl ??
    (options.project.config.provider === "gitlab"
      ? "https://gitlab.com"
      : "https://github.com");
  const remote = new URL(
    `${origin.replace(/\/$/, "")}/${options.project.config.repo}.git`,
  );
  if (
    remote.protocol !== "https:" ||
    remote.username ||
    remote.password ||
    remote.search ||
    remote.hash ||
    /[\r\n\0]/.test(options.token) ||
    !options.token
  )
    throw new Error(
      "Use a saved source credential and credential-free HTTPS repository.",
    );
  const gitEnv: NodeJS.ProcessEnv = {};
  for (const key of [
    "PATH",
    "Path",
    "SystemRoot",
    "WINDIR",
    "TEMP",
    "TMP",
    "TMPDIR",
    "COMSPEC",
    "PATHEXT",
  ])
    if (process.env[key]) gitEnv[key] = process.env[key];
  const authorization = `Basic ${Buffer.from(`${options.project.config.provider === "gitlab" ? "oauth2" : "x-access-token"}:${options.token}`).toString("base64")}`;
  Object.assign(gitEnv, {
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_CONFIG_COUNT: "5",
    GIT_CONFIG_KEY_0: `http.${remote.origin}/.extraHeader`,
    GIT_CONFIG_VALUE_0: `Authorization: ${authorization}`,
    GIT_CONFIG_KEY_1: "core.hooksPath",
    GIT_CONFIG_VALUE_1: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_CONFIG_KEY_2: "credential.helper",
    GIT_CONFIG_VALUE_2: "",
    GIT_CONFIG_KEY_3: "user.name",
    GIT_CONFIG_VALUE_3: "ShipGremlins",
    GIT_CONFIG_KEY_4: "user.email",
    GIT_CONFIG_VALUE_4: "gremlins@shipgremlins.ai",
  });
  const redact = (value: string) =>
    value
      .split(options.token)
      .join("[REDACTED]")
      .split(authorization)
      .join("[REDACTED]");
  const git: Git = {
    run: async (args, cwd) => {
      const rel = relative(base, resolve(cwd));
      if (
        isAbsolute(rel) ||
        rel === ".." ||
        rel.startsWith("../") ||
        rel.startsWith("..\\")
      )
        throw new Error("Promotion Git operation escaped its owned checkout.");
      assertNoSymlinks(cwd);
      const r = await run("git", args, {
        cwd,
        env: gitEnv,
        timeoutMs: 120_000,
      });
      return { ...r, out: redact(r.out), err: redact(r.err) };
    },
  };
  const cloned = await git.run(
    ["clone", "--no-checkout", "--", remote.href, checkoutDir],
    base,
  );
  if (cloned.code !== 0)
    throw new Error(
      "Could not create an isolated promotion checkout. Check source access; no project scripts ran on the controller.",
    );
  const image = await options.docker.ensureImage();
  if (!/^shipgremlins-local:[a-f0-9]{16}$/.test(image))
    throw new Error("Promotion requires the managed local worker image.");
  if (!options.project.config.commands.test.trim())
    throw new Error("Configure a test command before preparing a promotion.");
  const started = Date.now();
  let sequence = 0;
  return {
    git,
    checkoutDir,
    check: async (cwd: string) => {
      if (resolve(cwd) !== resolve(checkoutDir))
        throw new Error("Candidate checks require their isolated checkout.");
      if (Date.now() - started > 45 * 60 * 1000)
        return {
          ok: false,
          output:
            "Promotion exceeded its 45-minute check budget. No staging PR was authorized.",
        };
      assertNoSymlinks(cwd);
      const name = `gremlins-candidate-${nonce}-${++sequence}`;
      const { uid, gid } = candidateIdentity(
        process.getuid?.(),
        process.getgid?.(),
      );
      const args = [
        "run",
        "--name",
        name,
        "--rm",
        "--label",
        "io.shipgremlins.promotion=true",
        "--cap-drop=ALL",
        "--security-opt=no-new-privileges",
        "--read-only",
        "--pids-limit=256",
        "--memory=4g",
        "--cpus=2",
        "--user",
        `${uid}:${gid}`,
        "--tmpfs",
        `/work:rw,exec,uid=${uid},gid=${gid}`,
        "--tmpfs",
        `/tmp:rw,exec,uid=${uid},gid=${gid}`,
        "--mount",
        `type=bind,source=${cwd},target=/source,readonly`,
        "--entrypoint",
        "timeout",
        "-i",
        image,
        "--kill-after=10s",
        "15m",
        "node",
        "--input-type=module",
        "-e",
        checkScript,
      ];
      const result = await run("docker", args, {
        input: JSON.stringify(options.project.config.commands),
        timeoutMs: 15 * 60 * 1000,
      });
      if (result.code === 124) {
        const inspection = await run(
          "docker",
          [
            "inspect",
            "--format",
            '{{index .Config.Labels "io.shipgremlins.promotion"}}',
            name,
          ],
          { timeoutMs: 15_000 },
        );
        if (inspection.code === 0 && inspection.out.trim() === "true")
          await run("docker", ["rm", "--force", name], { timeoutMs: 30_000 });
      }
      const output = redact(`${result.out}\n${result.err}`).slice(-64 * 1024);
      writeFileSync(join(base, `${nonce}-check-${sequence}.log`), output, {
        mode: 0o600,
      });
      return { ok: result.code === 0, output };
    },
  };
}
