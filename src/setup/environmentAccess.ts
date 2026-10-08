import { LocalRunnerError } from "../localRunners/engine.ts";
import {
  runAccessProbe,
  RunnerProbeError,
  type AccessProbeRunner,
} from "./runnerAccessProbe.ts";
import { TestIdentityBusyError } from "../testAccess/leases.ts";
import type { DockerJobPayload } from "../localRunners/docker.ts";
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
import { projectRuntimeKey } from "../projectIdentity.ts";
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
import {
  environmentChecks,
  environmentDiagnosis,
  type EnvironmentDiagnosis,
  type EnvironmentCheck,
} from "./environmentDiagnosis.ts";

export interface EnvironmentVerification {
  status: "untested" | "testing" | "passed" | "failed";
  message: string;
  checkedAt?: string;
  checks?: Array<{ name: string; passed: boolean }>;
  diagnosis?: EnvironmentDiagnosis;
  screenshotUrl?: string;
  imageId?: string;
  commitSha?: string;
  runnerId?: string;
  runnerName?: string;
}
interface Stored extends EnvironmentVerification {
  fingerprint: string;
  pid?: number;
}
export class EnvironmentAccessError extends Error {
  constructor(
    message: string,
    public readonly status = 400,
    public readonly diagnosis?: EnvironmentDiagnosis,
    public readonly checks?: EnvironmentCheck[],
  ) {
    super(message);
    this.name = "EnvironmentAccessError";
  }
}
function diagnosed(code: string, checks: EnvironmentCheck[] = []) {
  const diagnosis = environmentDiagnosis({ code })!;
  return new EnvironmentAccessError(diagnosis.detail, 400, diagnosis, checks);
}
function projectKey(project: string) {
  if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(project))
    throw new EnvironmentAccessError("Invalid project.");
  return project;
}
function location(root: string, project: string, name: string) {
  return safeOAuthPath(
    join(
      root,
      ".run",
      "environment-access",
      projectRuntimeKey(loadProject(root, projectKey(project)).config),
      name,
    ),
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
        instanceId: project.config.instanceId,
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
  if (state.diagnosis) {
    const diagnosis = environmentDiagnosis(state.diagnosis);
    if (!diagnosis)
      throw new EnvironmentAccessError(
        "Environment test state could not be read.",
        503,
      );
    state.diagnosis = diagnosis;
  }
  if (state.checks) {
    const checks = environmentChecks(state.checks);
    if (!checks)
      throw new EnvironmentAccessError(
        "Environment test state could not be read.",
        503,
      );
    state.checks = checks;
  }
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
  selectRunner?: (
    project: Project,
    jobId: string,
  ) => Promise<AccessProbeRunner>;
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
    unsavedFailures.get(
      projectRuntimeKey(loadProject(root, projectKey(name)).config),
    ) ??
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
      vercel?: boolean;
    },
    job: string,
  ) {
    const image = await docker.ensureImage();
    if (!/^shipgremlins-local:[a-f0-9]{16}$/.test(image))
      throw diagnosed("browser_unavailable");
    const name = `gremlins-probe-${job}`;
    let checks: EnvironmentCheck[] = [];
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
      if (created.code !== 0) throw diagnosed("browser_unavailable");
      const result = await run(["start", "--attach", "--interactive", name], {
        stdin: JSON.stringify(input),
        timeoutMs: 300000,
        maxBytes: 4 * 1024 * 1024,
      });
      let output;
      try {
        output = JSON.parse(result.stdout);
      } catch {
        throw diagnosed("invalid_evidence");
      }
      if (!output || typeof output !== "object")
        throw diagnosed("invalid_evidence");
      const validated = environmentChecks(
        output.checks ??
          (output.ok === false && !output.diagnosis ? [] : undefined),
      );
      if (!validated) throw diagnosed("invalid_evidence");
      checks = validated;
      if (result.code !== 0 || output.ok !== true) {
        let diagnosis =
          output.diagnosis === undefined
            ? environmentDiagnosis({
                code:
                  output.stage === "login"
                    ? "login_unverified"
                    : "environment_unreachable",
              })
            : environmentDiagnosis(output.diagnosis);
        if (!diagnosis) throw diagnosed("invalid_evidence", checks);
        if (diagnosis.code === "vercel_protection" && input.bypass)
          diagnosis = environmentDiagnosis({
            code: "preview_credential_rejected",
          })!;
        throw new EnvironmentAccessError(
          diagnosis.detail,
          400,
          diagnosis,
          checks,
        );
      }
      if (!checks.length || checks.some((check) => !check.passed))
        throw diagnosed("invalid_evidence", checks);
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
        throw diagnosed("invalid_evidence", checks);
      return {
        checks,
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
          throw diagnosed("cleanup_pending", checks);
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
      values = saved();
    const job = `job-setup-${randomUUID()}`,
      lock = location(root, name, "test.lock");
    mkdirSync(
      join(
        root,
        ".run",
        "environment-access",
        projectRuntimeKey(project.config),
      ),
      {
        recursive: true,
        mode: 0o700,
      },
    );
    if (existsSync(lock)) {
      const owner = Number(readFileSync(lock, "utf8"));
      if (!Number.isSafeInteger(owner) || owner < 1 || alive(owner))
        throw new EnvironmentAccessError(
          "An environment test is already running. Retry after it finishes.",
          409,
        );
      unlinkSync(lock);
    }
    unsavedFailures.delete(projectRuntimeKey(project.config));
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
    let completedChecks: EnvironmentCheck[] = [];
    const task = Promise.resolve()
      .then(async () => {
        if (
          target.kind === "vercel" &&
          target.bypassSecret &&
          !values[target.bypassSecret]?.trim()
        )
          throw diagnosed("preview_credential_missing");
        let access: ReturnType<typeof resolveTestAccess>;
        try {
          access = resolveTestAccess(target.access, values);
        } catch {
          throw diagnosed("account_credentials_missing");
        }
        let result: { checks: EnvironmentCheck[]; png: Buffer } | undefined;
        let identity: Pick<
          EnvironmentVerification,
          "imageId" | "commitSha" | "runnerId" | "runnerName"
        > = {};
        const source =
          options.sourceControl ??
          createSourceControl({ root, env: values, fetch: options.fetch });
        let leased = false;
        try {
          if (!options.run) {
            if (!options.selectRunner)
              throw new EnvironmentAccessError(
                "Set up an agent service before checking this app. Access must be tested on the runner that will use it.",
                409,
              );
            const selected = await options.selectRunner(project, job);
            try {
              const payload: Omit<
                DockerJobPayload,
                "kind" | "nonce" | "testAccess"
              > = { browserVerification: true, credentials: {} };
              if (target.kind === "docker") {
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
                  payload.repoUrl = head.repoUrl;
                  payload.provider = project.config.provider ?? "github";
                  payload.branch = inspectionBranch(project.config);
                  payload.expectedCommitSha = head.sha;
                  payload.credentials![
                    payload.provider === "gitlab"
                      ? "GITLAB_TOKEN"
                      : "GITHUB_TOKEN"
                  ] = credential.token;
                  identity.commitSha = head.sha;
                }
                const env = Object.fromEntries(
                  Object.entries(target.env ?? {}).map(([key, ref]) => {
                    const value = values[ref];
                    if (!value)
                      throw new EnvironmentAccessError(
                        "Save the test application's required inputs before checking access.",
                      );
                    return [key, value];
                  }),
                );
                payload.testEnvironment = { target, env };
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
                payload.browserTarget = environment.url;
                if (
                  target.kind === "vercel" &&
                  target.bypassSecret &&
                  values[target.bypassSecret]
                )
                  payload.credentials!.GREMLINS_PREVIEW_BYPASS =
                    values[target.bypassSecret]!;
              }
              result = await runAccessProbe({
                root,
                project,
                runner: selected,
                docker,
                jobId: job,
                access: target.access,
                values,
                payload,
              });
              completedChecks = result.checks;
              identity = {
                ...identity,
                runnerId: selected.id,
                runnerName: selected.name,
              };
            } finally {
              try {
                await selected.release?.();
              } catch {
                // Cleanup failure takes precedence over a successful access result.
                // eslint-disable-next-line no-unsafe-finally
                throw diagnosed("cleanup_pending", completedChecks);
              }
            }
          } else if (target.kind === "docker") {
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
                completedChecks = result.checks;
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
            result = await probe(
              {
                url: environment.url,
                access,
                bypass,
                vercel: target.kind === "vercel",
              },
              job,
            );
            completedChecks = result.checks;
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
        if (error instanceof RunnerProbeError) {
          const mapped: Record<string, string> = {
            credentials_rejected: "login_rejected",
            selector_unusable: "login_controls_changed",
            authentication_unproven: "login_unverified",
            helper_unavailable: "browser_unavailable",
            invalid_access: "login_unverified",
          };
          error = diagnosed(
            mapped[error.code] ??
              (environmentDiagnosis({ code: error.code })
                ? error.code
                : "invalid_evidence"),
            completedChecks,
          );
        }
        if (error instanceof LocalRunnerError)
          error = new EnvironmentAccessError(error.message, error.status);
        if (error instanceof TestIdentityBusyError)
          error = new EnvironmentAccessError(error.message, 409);
        const failure: EnvironmentVerification = {
          status: "failed",
          checkedAt: new Date().toISOString(),
          ...(error instanceof EnvironmentAccessError
            ? {
                checks: error.checks ?? completedChecks,
                ...(error.diagnosis ? { diagnosis: error.diagnosis } : {}),
              }
            : { checks: completedChecks }),
          message:
            error instanceof EnvironmentAccessError
              ? error.message
              : "Environment test failed. Check Docker, source access, the test recipe and required Connections. Existing project settings were preserved.",
        };
        try {
          save(failure);
        } catch {
          unsavedFailures.set(projectRuntimeKey(project.config), {
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
          unsavedFailures.set(projectRuntimeKey(project.config), {
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
