import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  readFileSync,
  mkdirSync,
  openSync,
  closeSync,
  writeFileSync,
  unlinkSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { loadProject, type Project } from "../config.ts";
import {
  effectiveVerification,
  inspectionBranch,
} from "../projectCapabilities.ts";
import { resolveEnvironment, type HostingOptions } from "../hosting/index.ts";
import {
  createDockerRunners,
  type DockerRunners,
} from "../localRunners/docker.ts";
import {
  runPlannerDocker,
  type PlannerDockerRun,
} from "../pmPlanner/docker.ts";
import {
  createSourceControl,
  type SourceControl,
} from "../sourceControl/index.ts";
import { createVercelConnection } from "../vercelConnection/index.ts";
import { resolveRepositoryHead } from "../projectOnboarding/repository.ts";
import { safeOAuthPath } from "../oauthConnection/storage.ts";
import { writePrivate } from "../remoteWorkers/storage.ts";
import { readConnections } from "./connections.ts";
import { assertBrowserSecretSafety } from "./credentialScope.ts";
import { resolveTestAccess, testAccessSecretNames } from "../testAccess.ts";
import { ENVIRONMENT_PROBE } from "./environmentProbe.ts";

export interface EnvironmentVerification {
  status: "untested" | "testing" | "passed" | "failed";
  message: string;
  checkedAt?: string;
  checks?: Array<{ name: string; passed: boolean }>;
  screenshotUrl?: string;
  imageId?: string;
  commitSha?: string;
}
interface Stored extends EnvironmentVerification {
  fingerprint: string;
  pid?: number;
}
export class EnvironmentAccessError extends Error {
  constructor(
    message: string,
    public readonly status = 400,
  ) {
    super(message);
    this.name = "EnvironmentAccessError";
  }
}
function projectKey(project: string) {
  if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(project))
    throw new EnvironmentAccessError("Invalid project.");
  return project;
}
function location(root: string, project: string, name: string) {
  return safeOAuthPath(
    join(root, ".run", "environment-access", projectKey(project), name),
  );
}
function fingerprint(
  project: Project,
  values: Record<string, string | undefined>,
) {
  const verification = effectiveVerification(project.config);
  const names =
    verification.mode === "browser"
      ? [
          ...testAccessSecretNames(verification.target.access),
          ...(verification.target.kind === "docker"
            ? Object.values(verification.target.env ?? {})
            : []),
          ...(verification.target.kind === "vercel" &&
          verification.target.bypassSecret
            ? [verification.target.bypassSecret]
            : []),
        ]
      : [];
  return createHash("sha256")
    .update(
      JSON.stringify({
        repo: project.config.repo,
        provider: project.config.provider,
        server: project.config.serverUrl,
        branch: inspectionBranch(project.config),
        verification,
        inputs: names.sort().map((name) => [name, values[name] ?? null]),
        signIn: project.config.signIn,
      }),
    )
    .digest("hex");
}
function alive(pid?: number) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}
function read(root: string, project: string): Stored | undefined {
  const file = location(root, project, "state.json");
  if (!existsSync(file)) return undefined;
  const bytes = readFileSync(file);
  if (bytes.length > 32768)
    throw new EnvironmentAccessError(
      "Environment test state is too large.",
      503,
    );
  const state = JSON.parse(bytes.toString()) as Stored;
  if (
    !["testing", "passed", "failed"].includes(state.status) ||
    typeof state.message !== "string" ||
    typeof state.fingerprint !== "string"
  )
    throw new EnvironmentAccessError(
      "Environment test state could not be read.",
      503,
    );
  return state;
}
export function environmentVerificationStatus(
  root: string,
  project: Project,
  env: NodeJS.ProcessEnv = process.env,
): EnvironmentVerification {
  const state = read(root, project.config.name);
  if (
    !state ||
    state.fingerprint !==
      fingerprint(project, { ...readConnections(root), ...env })
  )
    return {
      status: "untested",
      message:
        "Test this environment to confirm the app opens in a real browser.",
    };
  if (state.status === "testing" && !alive(state.pid))
    return {
      status: "failed",
      message:
        "The environment test was interrupted. Retry to rebuild and check it.",
    };
  const { fingerprint: _fingerprint, pid: _pid, ...publicState } = state;
  return publicState;
}
export function createEnvironmentAccess(options: {
  root: string;
  packageRoot: string;
  sourceControl?: Pick<SourceControl, "acquireLease" | "releaseLease">;
  vercelConnectionFor?: HostingOptions["vercelConnectionFor"];
  fetch?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  docker?: DockerRunners;
  run?: PlannerDockerRun;
}) {
  const root = resolve(options.root),
    run = options.run ?? runPlannerDocker;
  const docker =
    options.docker ??
    createDockerRunners({
      packageRoot: options.packageRoot,
      environmentNamespace: root,
    });
  const active = new Map<string, Promise<void>>();
  const unsavedFailures = new Map<string, EnvironmentVerification>();
  const status = (name: string) =>
    unsavedFailures.get(projectKey(name)) ??
    environmentVerificationStatus(
      root,
      loadProject(root, projectKey(name)),
      options.env,
    );
  const saved = () => ({
    ...readConnections(root),
    ...(options.env ?? process.env),
  });
  async function probe(
    input: {
      url: string;
      network?: string;
      access?: ReturnType<typeof resolveTestAccess>;
      bypass?: string;
    },
    job: string,
  ) {
    const image = await docker.ensureImage();
    if (!/^shipgremlins-local:[a-f0-9]{16}$/.test(image))
      throw new EnvironmentAccessError(
        "The browser worker image is unavailable.",
      );
    const name = `gremlins-probe-${job}`;
    try {
      const created = await run([
        "create",
        "--name",
        name,
        "--label",
        `io.shipgremlins.probe=${job}`,
        "--interactive",
        "--restart=no",
        "--read-only",
        "--user",
        "1000:1000",
        "--cpus=1",
        "--memory=1g",
        "--pids-limit=256",
        "--cap-drop=ALL",
        "--security-opt=no-new-privileges",
        "--tmpfs",
        "/tmp:rw,nosuid,nodev,mode=1777,size=268435456",
        "--tmpfs",
        "/work:rw,nosuid,nodev,uid=1000,gid=1000,mode=0700,size=67108864",
        ...(input.network
          ? ["--network", input.network]
          : ["--add-host", "host.docker.internal:host-gateway"]),
        "--entrypoint",
        "node",
        image,
        "-e",
        ENVIRONMENT_PROBE,
      ]);
      if (created.code !== 0)
        throw new EnvironmentAccessError(
          "The browser test could not start. Check Docker on the controller.",
        );
      const result = await run(["start", "--attach", "--interactive", name], {
        stdin: JSON.stringify(input),
        timeoutMs: 300000,
        maxBytes: 4 * 1024 * 1024,
      });
      let output;
      try {
        output = JSON.parse(result.stdout);
      } catch {
        throw new EnvironmentAccessError(
          "The browser could not load the application. Check its URL and network access from Docker.",
        );
      }
      if (result.code !== 0 || output.ok !== true)
        throw new EnvironmentAccessError(
          output.stage === "login"
            ? "The app opened, but a test account could not sign in. Check its credentials, login selectors and signed-in success selector. External SSO redirects need a dedicated test login."
            : "The browser could not open this app. Check the test URL, protection bypass and Docker network access.",
        );
      if (
        !Array.isArray(output.checks) ||
        output.checks.length > 16 ||
        output.checks.some(
          (check: { name?: unknown; passed?: unknown }) =>
            typeof check.name !== "string" || check.passed !== true,
        )
      )
        throw new EnvironmentAccessError(
          "The browser test returned invalid evidence.",
        );
      const png = Buffer.from(
        typeof output.screenshot === "string" ? output.screenshot : "",
        "base64",
      );
      if (
        png.length > 2 * 1024 * 1024 ||
        !png
          .subarray(0, 8)
          .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      )
        throw new EnvironmentAccessError(
          "The browser test did not return a valid screenshot.",
        );
      return {
        checks: output.checks as EnvironmentVerification["checks"],
        png,
      };
    } finally {
      const inspected = await run(
        [
          "inspect",
          "--format",
          '{{index .Config.Labels "io.shipgremlins.probe"}}',
          name,
        ],
        { timeoutMs: 5000, maxBytes: 1024 },
      ).catch(() => null);
      if (inspected?.code === 0 && inspected.stdout.trim() === job) {
        const removed = await run(["rm", "--force", name], {
          timeoutMs: 10000,
          maxBytes: 1024,
        });
        if (removed.code !== 0)
          // A cleanup failure must not become a successful readiness result.
          // eslint-disable-next-line no-unsafe-finally
          throw new EnvironmentAccessError(
            "Browser cleanup is pending. Check Docker before retrying.",
          );
      }
    }
  }
  async function verify(name: string) {
    const project = loadProject(root, projectKey(name)),
      verification = effectiveVerification(project.config);
    if (verification.mode !== "browser")
      throw new EnvironmentAccessError(
        "Choose a hosted or Docker test environment first.",
      );
    if (active.has(name))
      throw new EnvironmentAccessError(
        "An environment test is already running.",
        409,
      );
    if (active.size >= 2)
      throw new EnvironmentAccessError(
        "Two environment tests are already running. Retry after one finishes.",
        409,
      );
    assertBrowserSecretSafety(project.config, root);
    const target = verification.target,
      values = saved(),
      access = resolveTestAccess(target.access, values);
    const job = `job-setup-${randomUUID()}`,
      lock = location(root, name, "test.lock");
    mkdirSync(join(root, ".run", "environment-access", name), {
      recursive: true,
      mode: 0o700,
    });
    if (existsSync(lock)) {
      const owner = Number(readFileSync(lock, "utf8"));
      if (!Number.isSafeInteger(owner) || owner < 1 || alive(owner))
        throw new EnvironmentAccessError(
          "An environment test is already running. Retry after it finishes.",
          409,
        );
      unlinkSync(lock);
    }
    unsavedFailures.delete(name);
    let fd;
    try {
      fd = openSync(lock, "wx", 0o600);
      writeFileSync(fd, String(process.pid));
    } catch {
      throw new EnvironmentAccessError(
        "The environment test is locked by another controller.",
        409,
      );
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
    const stamp = fingerprint(project, values);
    const save = (state: EnvironmentVerification) =>
      writePrivate(
        location(root, name, "state.json"),
        JSON.stringify({
          ...state,
          fingerprint: stamp,
          ...(state.status === "testing" ? { pid: process.pid } : {}),
        }),
      );
    try {
      save({
        status: "testing",
        message:
          target.kind === "docker"
            ? "Preparing a disposable application and checking it in Chromium…"
            : "Opening the selected staging app in Chromium…",
      });
    } catch (error) {
      unlinkSync(lock);
      throw error;
    }
    const task = Promise.resolve()
      .then(async () => {
        let result: Awaited<ReturnType<typeof probe>> | undefined;
        let identity: Pick<EnvironmentVerification, "imageId" | "commitSha"> =
          {};
        const source =
          options.sourceControl ??
          createSourceControl({ root, env: values, fetch: options.fetch });
        let leased = false;
        try {
          if (target.kind === "docker") {
            if (!docker.smokeEnvironment)
              throw new EnvironmentAccessError(
                "This controller does not support managed Docker environments.",
              );
            let pinned;
            if (target.recipe.kind === "dockerfile") {
              leased = true;
              const credential = await source.acquireLease({
                jobId: job,
                provider: project.config.provider ?? "github",
                serverUrl: project.config.serverUrl,
                repository: project.config.repo,
                minutes: 30,
                write: false,
              });
              const head = await resolveRepositoryHead({
                project,
                credential,
                fetch: options.fetch,
              });
              pinned = {
                repoUrl: head.repoUrl,
                provider: project.config.provider ?? ("github" as const),
                commitSha: head.sha,
                token: credential.token,
              };
            }
            const env = Object.fromEntries(
              Object.entries(target.env ?? {}).map(([key, ref]) => {
                const value = values[ref];
                if (!value)
                  throw new EnvironmentAccessError(
                    "Save all named test-only application inputs in Connections first.",
                  );
                return [key, value];
              }),
            );
            const environment = await docker.smokeEnvironment(
              {
                jobId: job,
                target,
                ...(pinned ? { source: pinned } : {}),
                env,
              },
              async (environment) => {
                result = await probe(
                  {
                    url: environment.url,
                    network: environment.network,
                    access,
                  },
                  job,
                );
              },
            );
            identity = {
              imageId: environment.imageId,
              ...(environment.commitSha
                ? { commitSha: environment.commitSha }
                : {}),
            };
          } else {
            const environment = await resolveEnvironment(target, {
              env: values,
              branch: inspectionBranch(project.config),
              fetch: options.fetch,
              vercelConnectionFor:
                options.vercelConnectionFor ??
                ((connectionId) =>
                  createVercelConnection({
                    root,
                    env: values,
                    fetch: options.fetch,
                    connectionId,
                  })),
            });
            const bypass =
              target.kind === "vercel" && target.bypassSecret
                ? values[target.bypassSecret]
                : undefined;
            result = await probe({ url: environment.url, access, bypass }, job);
          }
        } finally {
          if (leased) await source.releaseLease(job);
        }
        if (!result)
          throw new EnvironmentAccessError("No browser evidence was produced.");
        if (fingerprint(loadProject(root, name), saved()) !== stamp)
          throw new EnvironmentAccessError(
            "Settings changed during the environment test. Test the new settings before continuing.",
          );
        writePrivate(location(root, name, "screenshot.png"), result.png);
        save({
          status: "passed",
          message: access
            ? `App opened in Chromium and ${access.accounts.length} test account(s) signed in. This checks access, not RBAC or feature correctness.`
            : "App opened in Chromium. No signed-in account was checked.",
          checks: result.checks,
          screenshotUrl: `/api/projects/${name}/onboarding/screenshot`,
          checkedAt: new Date().toISOString(),
          ...identity,
        });
      })
      .catch((error) => {
        const failure: EnvironmentVerification = {
          status: "failed",
          message:
            error instanceof EnvironmentAccessError
              ? error.message
              : "Environment test failed. Check Docker, source access, the test recipe and required Connections. Existing project settings were preserved.",
        };
        try {
          save(failure);
        } catch {
          unsavedFailures.set(name, {
            status: "failed",
            message:
              "The environment test could not save its result. Check configuration directory permissions and retry; no verification was recorded.",
          });
        }
      })
      .finally(() => {
        active.delete(name);
        try {
          if (existsSync(lock)) unlinkSync(lock);
        } catch {
          unsavedFailures.set(name, {
            status: "failed",
            message:
              "The environment test lock could not be released. Check configuration directory permissions before retrying.",
          });
        }
      });
    active.set(name, task);
    return status(name);
  }
  return {
    status,
    verify,
    busy: (name?: string) => (name ? active.has(name) : active.size > 0),
    screenshot(name: string) {
      if (status(name).status !== "passed")
        throw new EnvironmentAccessError(
          "Test this environment before opening its screenshot.",
          404,
        );
      const bytes = readFileSync(location(root, name, "screenshot.png"));
      if (bytes.length > 2 * 1024 * 1024)
        throw new EnvironmentAccessError("Screenshot is too large.", 503);
      return bytes;
    },
    async idle() {
      await Promise.all(active.values());
    },
    async close() {
      await this.idle();
    },
  };
}
