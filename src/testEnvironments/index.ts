import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve, relative } from "node:path";
import type { DockerRun } from "../localRunners/docker.ts";
import { parseDockerTarget, type DockerEnvironmentTarget } from "./recipe.ts";
export { parseDockerTarget, type DockerEnvironmentTarget } from "./recipe.ts";

export interface TestEnvironmentInput {
  jobId: string;
  target: DockerEnvironmentTarget;
  source?: {
    repoUrl: string;
    provider: "github" | "gitlab";
    commitSha: string;
    token: string;
  };
  /** Resolved dedicated application secrets only. Never model/provider credentials. */
  env?: Record<string, string>;
}
export interface TestEnvironment {
  url: string;
  network: string;
  imageId: string;
  commitSha?: string;
  health: { ready: true; status: number };
}
export class TestEnvironmentError extends Error {
  constructor(
    message: string,
    public readonly code = "environment_failed",
  ) {
    super(message);
    this.name = "TestEnvironmentError";
  }
}
const MANAGED = "io.shipgremlins.managed",
  JOB = "io.shipgremlins.job",
  APP = "io.shipgremlins.test-environment";
const activeSmokeJobs = new Set<string>();
const id = (value: string) => {
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(value))
    throw new TestEnvironmentError("Invalid environment job identifier.");
  return value;
};
const labels = (job: string) => [
  "--label",
  `${MANAGED}=true`,
  "--label",
  `${APP}=true`,
  "--label",
  `${JOB}=${job}`,
];
const prefix = (job: string) => `gremlins-app-${id(job)}`;
const networkName = (job: string) => `${prefix(job)}-net`;
const imageName = (job: string) =>
  `shipgremlins-app:${createHash("sha256").update(id(job)).digest("hex").slice(0, 24)}`;
const bounded = [
  "--init",
  "--cap-drop=ALL",
  "--security-opt=no-new-privileges",
  "--pids-limit=256",
  "--memory=1g",
  "--cpus=1",
  "--restart=no",
];
function privateScratch(): string {
  const directory = mkdtempSync(join(tmpdir(), "gremlins-build-"));
  try {
    if (process.platform !== "win32") chmodSync(directory, 0o700);
    else {
      const system = join(process.env.SystemRoot ?? "C:\\Windows", "System32");
      const who = spawnSync(
        join(system, "whoami.exe"),
        ["/user", "/fo", "csv", "/nh"],
        { encoding: "utf8", windowsHide: true, timeout: 10_000 },
      );
      const sid = who.stdout?.match(/S-1-[0-9-]+/)?.[0];
      if (
        who.status !== 0 ||
        !sid ||
        spawnSync(
          join(system, "icacls.exe"),
          [directory, "/inheritance:r", "/grant:r", `*${sid}:(OI)(CI)F`],
          { windowsHide: true, timeout: 10_000 },
        ).status !== 0
      )
        throw new Error("Could not restrict temporary build context access.");
    }
    return directory;
  } catch {
    rmSync(directory, { recursive: true, force: true });
    throw new TestEnvironmentError(
      "Could not create a private build context directory.",
    );
  }
}
const cloneScript = `import {spawnSync} from 'node:child_process';import{mkdirSync,statSync}from'node:fs';let raw='';for await(const c of process.stdin){raw+=c;if(raw.length>32768)process.exit(1)}const p=JSON.parse(raw);const env={PATH:process.env.PATH,HOME:'/work',GIT_TERMINAL_PROMPT:'0',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_COUNT:'4',GIT_CONFIG_KEY_3:'http.followRedirects',GIT_CONFIG_VALUE_3:'false',GIT_CONFIG_KEY_0:'http.'+new URL(p.repoUrl).origin+'/.extraHeader',GIT_CONFIG_VALUE_0:p.token?'Authorization: Basic '+Buffer.from((p.provider==='gitlab'?'oauth2':'x-access-token')+':'+p.token).toString('base64'):'',GIT_CONFIG_KEY_1:'core.hooksPath',GIT_CONFIG_VALUE_1:'/dev/null',GIT_CONFIG_KEY_2:'credential.helper',GIT_CONFIG_VALUE_2:''};const git=(args)=>{const r=spawnSync('git',args,{cwd:'/work/repo',env,encoding:'utf8',timeout:120000,maxBuffer:1048576});if(r.status!==0)throw Error('Source checkout failed');return r.stdout.trim()};mkdirSync('/work/repo');git(['init']);git(['fetch','--depth','1','--',p.repoUrl,p.commitSha]);if(git(['rev-parse','FETCH_HEAD'])!==p.commitSha)throw Error('Source changed');const mode=git(['ls-tree',p.commitSha,'--',p.dockerfile]);if(!/^100(?:644|755) blob /.test(mode))throw Error('Dockerfile must be a tracked regular file');git(['archive','--format=tar','--output=/work/context.tar',p.context==='.'?p.commitSha:p.commitSha+':'+p.context]);if(statSync('/work/context.tar').size>268435456)throw Error('Build context too large');console.log('Checkout prepared');`;
const probeScript = `const u=process.argv[1];let status=0,errorCode='';const end=Date.now()+60000;while(Date.now()<end){try{const r=await fetch(u,{redirect:'manual',signal:AbortSignal.timeout(3000)});status=r.status;errorCode='';await r.body?.cancel();if(status>=200&&status<400){console.log(JSON.stringify({status}));process.exit(0)}}catch(e){status=0;errorCode=['ENOTFOUND','EAI_AGAIN','ECONNREFUSED','ETIMEDOUT'].includes(e.cause?.code)?e.cause.code:e.name==='TimeoutError'?'ETIMEDOUT':''}await new Promise(r=>setTimeout(r,500))}console.log(JSON.stringify({status,errorCode}));process.exit(1);`;

/** All commands below are fixed Docker operations; application code never executes on the host. */
export function createTestEnvironments(options: {
  run: DockerRun;
  ensureImage(): Promise<string>;
  namespace?: string;
}) {
  const run = options.run;
  const owner = options.namespace
    ? createHash("sha256").update(resolve(options.namespace)).digest("hex")
    : undefined;
  const resourceLabels = (job: string) => [
    ...labels(job),
    "--label",
    `io.shipgremlins.environment-created=${Date.now()}`,
    "--label",
    `io.shipgremlins.environment-pid=${process.pid}`,
    ...(owner ? ["--label", `io.shipgremlins.environment-owner=${owner}`] : []),
  ];
  async function checked(
    args: string[],
    runOptions?: Parameters<DockerRun>[1],
  ) {
    const r = await run(args, runOptions);
    if (r.code !== 0)
      throw new TestEnvironmentError(
        "The Docker test environment could not start. Check the image, Dockerfile, test-only inputs and service health.",
      );
    return r;
  }
  async function inspect(
    kind: "container" | "network" | "image",
    name: string,
    job: string,
  ) {
    const r = await run([
      kind === "container" ? "inspect" : kind,
      ...(kind === "container" ? [] : ["inspect"]),
      "--format",
      "{{json .}}",
      name,
    ]);
    if (r.code !== 0) {
      if (
        /no such (object|container|network|image)|network [a-z0-9-]+ not found/i.test(
          r.stderr,
        )
      )
        return null;
      throw new TestEnvironmentError(
        "Docker ownership could not be verified. No resources were removed.",
      );
    }
    let data;
    try {
      data = JSON.parse(r.stdout);
    } catch {
      throw new TestEnvironmentError("Invalid Docker ownership information.");
    }
    const found = kind === "network" ? data.Labels : data.Config?.Labels;
    if (
      found?.[MANAGED] !== "true" ||
      found?.[APP] !== "true" ||
      found?.[JOB] !== job ||
      (owner && found?.["io.shipgremlins.environment-owner"] !== owner)
    )
      throw new TestEnvironmentError(
        "Refusing to access a Docker resource owned by another application.",
      );
    return data;
  }
  async function cleanup(jobId: string) {
    const job = id(jobId);
    const network = await inspect("network", networkName(job), job);
    const found = await checked([
      "ps",
      "--all",
      "--filter",
      `label=${APP}=true`,
      "--filter",
      `label=${JOB}=${job}`,
      "--format",
      "{{.Names}}",
    ]);
    const tag = imageName(job);
    const builtImage = await inspect("image", tag, job);
    if (!network && !found.stdout.trim() && !builtImage) return;
    if (network) {
      // Finished model containers intentionally remain for retained evidence.
      // Detach their stopped endpoint without deleting their output or container.
      const workerName = `gremlins-job-${job}`;
      const worker = await run([
        "inspect",
        "--format",
        "{{json .}}",
        workerName,
      ]);
      if (worker.code === 0) {
        let data;
        try {
          data = JSON.parse(worker.stdout);
        } catch {
          throw new TestEnvironmentError(
            "Could not inspect the retained worker before network cleanup.",
          );
        }
        if (
          data.Config?.Labels?.[MANAGED] !== "true" ||
          data.Config?.Labels?.[JOB] !== job
        )
          throw new TestEnvironmentError(
            "Refusing to detach another application's worker.",
          );
        if (data.State?.Running === true)
          throw new TestEnvironmentError(
            "Wait for the running worker to finish before cleaning its app environment.",
          );
        if (data.NetworkSettings?.Networks?.[networkName(job)])
          await checked([
            "network",
            "disconnect",
            networkName(job),
            workerName,
          ]);
      } else if (!/no such (object|container)/i.test(worker.stderr)) {
        throw new TestEnvironmentError(
          "Could not inspect the retained worker before network cleanup.",
        );
      }
    }
    for (const name of found.stdout.trim().split(/\r?\n/).filter(Boolean)) {
      if (!name.startsWith(prefix(job) + "-"))
        throw new TestEnvironmentError(
          "Unexpected environment resource name; cleanup stopped.",
        );
      if (await inspect("container", name, job))
        await checked(["rm", "--force", "--volumes", name]);
    }
    if (network) await checked(["network", "rm", networkName(job)]);
    if (builtImage) await checked(["image", "rm", tag]);
  }
  async function start(input: TestEnvironmentInput): Promise<TestEnvironment> {
    const job = id(input.jobId),
      target = parseDockerTarget(input.target);
    const declared = Object.keys(target.env ?? {}).sort(),
      supplied = Object.keys(input.env ?? {}).sort();
    if (
      JSON.stringify(declared) !== JSON.stringify(supplied) ||
      Object.values(input.env ?? {}).some(
        (v) =>
          typeof v !== "string" || !v || v.length > 16384 || /[\r\n\0]/.test(v),
      )
    )
      throw new TestEnvironmentError(
        "Supply every named test-only application input before starting Docker.",
        "missing_inputs",
      );
    if (target.recipe.kind === "dockerfile") {
      const source = input.source;
      let url: URL;
      try {
        url = new URL(source?.repoUrl ?? "");
      } catch {
        throw new TestEnvironmentError(
          "A pinned source revision is required for Docker builds.",
        );
      }
      if (
        !source ||
        !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(source.commitSha) ||
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        !["github", "gitlab"].includes(source.provider) ||
        typeof source.token !== "string" ||
        source.token.length > 16384 ||
        /[\r\n\0]/.test(source.token)
      )
        throw new TestEnvironmentError(
          "Use a pinned source revision and a saved source credential for Docker builds.",
        );
    }
    await cleanup(job);
    const network = networkName(job),
      runtime = await options.ensureImage();
    if (!/^shipgremlins-local:[a-f0-9]{16}$/.test(runtime))
      throw new TestEnvironmentError(
        "A managed local worker image is required.",
      );
    let scratch: string | undefined;
    try {
      await checked([
        "network",
        "create",
        "--driver",
        "bridge",
        ...resourceLabels(job),
        network,
      ]);
      let image: string;
      if (target.recipe.kind === "image") {
        image = target.recipe.image;
        const present = await run(["image", "inspect", image]);
        if (present.code !== 0)
          await checked(["pull", image], {
            timeoutMs: 5 * 60_000,
            maxBytes: 4096,
          });
      } else {
        const checkout = `${prefix(job)}-source`;
        await checked([
          "create",
          "--name",
          checkout,
          ...resourceLabels(job),
          ...bounded,
          "--user",
          "1000:1000",
          "--entrypoint",
          "node",
          "-i",
          runtime,
          "--input-type=module",
          "-e",
          cloneScript,
        ]);
        await checked(["start", "--attach", "--interactive", checkout], {
          stdin: JSON.stringify({
            ...input.source,
            dockerfile: target.recipe.dockerfile,
            context: target.recipe.context,
          }),
          timeoutMs: 5 * 60_000,
          maxBytes: 4096,
        });
        scratch = privateScratch();
        const archive = join(scratch, "context.tar");
        await checked(["cp", `${checkout}:/work/context.tar`, archive], {
          timeoutMs: 60_000,
          maxBytes: 4096,
        });
        if (statSync(archive).size > 256 * 1024 * 1024)
          throw new TestEnvironmentError(
            "Docker build context exceeds 256 MiB.",
          );
        const tar = readFileSync(archive);
        image = imageName(job);
        if (await inspect("image", image, job))
          await checked(["image", "rm", image]);
        const dockerfile =
          target.recipe.context === "."
            ? target.recipe.dockerfile
            : target.recipe.dockerfile.slice(target.recipe.context.length + 1);
        await checked(
          [
            "build",
            "--tag",
            image,
            "--file",
            dockerfile,
            ...resourceLabels(job),
            "-",
          ],
          { stdinBuffer: tar, timeoutMs: 10 * 60_000, maxBytes: 8192 },
        );
        await checked(["rm", "--force", checkout]);
      }
      const imageInfo = await checked([
        "image",
        "inspect",
        "--format",
        "{{.Id}}",
        image,
      ]);
      const imageId = imageInfo.stdout.trim();
      if (!/^sha256:[a-f0-9]{64}$/.test(imageId))
        throw new TestEnvironmentError(
          "Docker did not return an immutable application image identity.",
        );
      const appEnv = { ...input.env };
      for (const service of target.services ?? []) {
        const serviceName = `${prefix(job)}-${service.name}`,
          password = randomBytes(24).toString("hex");
        const postgres = service.kind === "postgres";
        const serviceEnv: Record<string, string> = postgres
          ? {
              POSTGRES_USER: "gremlins",
              POSTGRES_DB: "gremlins",
              POSTGRES_PASSWORD: password,
            }
          : {};
        await checked(
          [
            "run",
            "--detach",
            "--name",
            serviceName,
            ...resourceLabels(job),
            ...bounded,
            "--user",
            postgres ? "postgres" : "redis",
            "--network",
            network,
            "--network-alias",
            service.name,
            ...Object.keys(serviceEnv).flatMap((k) => ["--env", k]),
            postgres ? "postgres:16-alpine" : "redis:7-alpine",
            ...(postgres
              ? []
              : ["redis-server", "--save", "", "--appendonly", "no"]),
          ],
          { env: serviceEnv, timeoutMs: 5 * 60_000, maxBytes: 4096 },
        );
        const health = postgres
          ? ["pg_isready", "-U", "gremlins", "-d", "gremlins"]
          : ["redis-cli", "ping"];
        let healthy = false;
        for (let attempt = 0; attempt < 30; attempt++) {
          if (
            (
              await run(["exec", serviceName, ...health], {
                timeoutMs: 3000,
                maxBytes: 4096,
              })
            ).code === 0
          ) {
            healthy = true;
            break;
          }
          await new Promise((done) => setTimeout(done, 500));
        }
        if (!healthy)
          throw new TestEnvironmentError(
            "A disposable database did not become ready.",
          );
        appEnv[service.env] = postgres
          ? `postgresql://gremlins:${password}@${service.name}:5432/gremlins`
          : `redis://${service.name}:6379`;
      }
      const envArgs = Object.keys(appEnv).flatMap((k) => ["--env", k]);
      for (const phase of ["migrate", "seed"] as const) {
        const command = target[phase];
        if (!command) continue;
        const step = `${prefix(job)}-${phase}`;
        try {
          await checked(
            [
              "run",
              "--name",
              step,
              ...resourceLabels(job),
              ...bounded,
              "--network",
              network,
              ...envArgs,
              "--entrypoint",
              command[0]!,
              imageId,
              ...command.slice(1),
            ],
            { env: appEnv, timeoutMs: 120_000, maxBytes: 4096 },
          );
        } finally {
          if (await inspect("container", step, job))
            await checked(["rm", "--force", "--volumes", step]);
        }
      }
      await checked(
        [
          "run",
          "--detach",
          "--name",
          `${prefix(job)}-app`,
          ...resourceLabels(job),
          ...bounded,
          "--network",
          network,
          "--network-alias",
          "app.test",
          ...envArgs,
          imageId,
          ...(target.start ?? []),
        ],
        { env: appEnv, timeoutMs: 30_000, maxBytes: 4096 },
      );
      const url = `http://app.test:${target.port}`;
      const health = await run(
        [
          "run",
          "--rm",
          "--name",
          `${prefix(job)}-health`,
          ...resourceLabels(job),
          ...bounded,
          "--read-only",
          "--user",
          "1000:1000",
          "--network",
          network,
          "--entrypoint",
          "node",
          runtime,
          "--input-type=module",
          "-e",
          probeScript,
          url + (target.healthPath ?? "/"),
        ],
        { timeoutMs: 70_000, maxBytes: 4096 },
      );
      if (health.code !== 0) {
        // Read only owned container state and fixed probe fields. App logs,
        // response bodies and Docker stderr can contain private application data.
        const app = await inspect("container", `${prefix(job)}-app`, job).catch(
          () => null,
        );
        if (app?.State?.OOMKilled === true)
          throw new TestEnvironmentError(
            "The test app exceeded its Docker memory limit before its health check passed. Reduce startup memory or adjust its test recipe, then test the environment again. No agent was started.",
            "app_memory_limit",
          );
        if (app?.State?.Running === false && app.State.Status !== "created")
          throw new TestEnvironmentError(
            `The test app stopped before its health check passed${Number.isSafeInteger(app.State.ExitCode) ? ` (exit ${app.State.ExitCode})` : ""}. Check the app's startup command and required test inputs, then test the environment again. No agent was started.`,
            "app_exited",
          );
        let status = 0,
          errorCode = "";
        try {
          const detail = JSON.parse(health.stdout.trim());
          if (
            Number.isInteger(detail.status) &&
            detail.status >= 100 &&
            detail.status <= 599
          )
            status = detail.status;
          if (
            ["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ETIMEDOUT"].includes(
              detail.errorCode,
            )
          )
            errorCode = detail.errorCode;
        } catch {
          // Malformed or non-probe output is deliberately omitted.
        }
        throw new TestEnvironmentError(
          status
            ? `The test app's health check returned HTTP ${status} instead of a successful response. Check the configured health path and app startup, then test the environment again. No agent was started.`
            : errorCode === "ENOTFOUND" || errorCode === "EAI_AGAIN"
              ? "The test runner could not resolve app.test on its private Docker network. Check Docker DNS and bridge networking, then test the environment again. No agent was started."
              : `The test runner could not reach the app on port ${target.port} within 60 seconds. Check that the app listens on 0.0.0.0 and that Docker bridge networking and the host firewall allow containers to communicate. Then test the environment again. No agent was started.`,
          status ? "app_health_response" : "app_health_unreachable",
        );
      }
      let status: number;
      try {
        status = JSON.parse(health.stdout.trim()).status;
      } catch {
        throw new TestEnvironmentError(
          "Application readiness could not be verified.",
        );
      }
      if (!(status >= 200 && status < 400))
        throw new TestEnvironmentError(
          "Application health endpoint did not become ready.",
        );
      return {
        url,
        network,
        imageId,
        ...(target.recipe.kind === "dockerfile"
          ? { commitSha: input.source!.commitSha }
          : {}),
        health: { ready: true, status },
      };
    } catch (error) {
      await cleanup(job).catch(() => {});
      if (error instanceof TestEnvironmentError) throw error;
      throw new TestEnvironmentError(
        "Docker environment preparation failed. Check its recipe and dedicated test inputs; no app scripts ran on the host.",
      );
    } finally {
      if (
        scratch &&
        relative(resolve(tmpdir()), resolve(scratch)).startsWith(
          "gremlins-build-",
        )
      )
        rmSync(scratch, { recursive: true, force: true });
    }
  }
  return {
    start,
    cleanup,
    async smoke(
      input: TestEnvironmentInput,
      verify?: (environment: TestEnvironment) => Promise<void>,
    ) {
      activeSmokeJobs.add(id(input.jobId));
      try {
        const environment = await start(input);
        await verify?.(environment);
        return environment;
      } finally {
        try {
          await cleanup(input.jobId);
        } finally {
          activeSmokeJobs.delete(input.jobId);
        }
      }
    },
    async reconcile(activeJobIds: string[]) {
      if (!owner) return;
      const active = new Set(activeJobIds.map(id));
      const found = await checked([
        "network",
        "ls",
        "--filter",
        `label=${APP}=true`,
        "--filter",
        `label=io.shipgremlins.environment-owner=${owner}`,
        "--format",
        `{{.Label "${JOB}"}}`,
      ]);
      for (const job of new Set(
        found.stdout.trim().split(/\r?\n/).filter(Boolean),
      ))
        if (!active.has(id(job)) && !activeSmokeJobs.has(job)) {
          if (job.startsWith("job-setup-")) {
            const network = await inspect("network", networkName(job), job);
            const created = Number(
              network?.Labels?.["io.shipgremlins.environment-created"],
            );
            if (
              !Number.isSafeInteger(created) ||
              created <= 0 ||
              Date.now() - created < 90 * 60_000
            )
              continue;
          }
          await cleanup(job);
        }
      // A crash can happen after network removal but before its build image is
      // removed. Discover these independently, then validate namespace, job and
      // deterministic tag before deleting anything.
      const images = await checked([
        "image",
        "ls",
        "--filter",
        `label=${APP}=true`,
        "--filter",
        `label=io.shipgremlins.environment-owner=${owner}`,
        "--format",
        "{{.Repository}}:{{.Tag}}",
      ]);
      for (const tag of new Set(
        images.stdout.trim().split(/\r?\n/).filter(Boolean),
      )) {
        if (!/^shipgremlins-app:[a-f0-9]{24}$/.test(tag))
          throw new TestEnvironmentError(
            "Unexpected managed build image; cleanup stopped.",
          );
        const inspected = await checked([
          "image",
          "inspect",
          "--format",
          "{{json .Config.Labels}}",
          tag,
        ]);
        let imageLabels: Record<string, string>;
        try {
          imageLabels = JSON.parse(inspected.stdout);
        } catch {
          throw new TestEnvironmentError(
            "Invalid Docker image ownership information.",
          );
        }
        const job = id(imageLabels?.[JOB] ?? "");
        if (tag !== imageName(job))
          throw new TestEnvironmentError(
            "Build image does not match its managed job.",
          );
        await inspect("image", tag, job);
        if (active.has(job) || activeSmokeJobs.has(job)) continue;
        if (job.startsWith("job-setup-")) {
          const created = Number(
            imageLabels["io.shipgremlins.environment-created"],
          );
          if (
            !Number.isSafeInteger(created) ||
            created <= 0 ||
            Date.now() - created < 90 * 60_000
          )
            continue;
        }
        await cleanup(job);
      }
    },
  };
}
